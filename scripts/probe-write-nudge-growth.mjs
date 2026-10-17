/**
 * scripts/probe-write-nudge-growth.mjs — 催写增量锚量尺**只计 assistant 产出**专项（2026-10-17 §3）。
 *
 * 生产实证（PLAN「两真会话注入通道工程优化」）：7ebcf56f 会话开局 41s，54K 系统注入
 * （AGENTS/skill-catalog/召回/通知）被旧口径（全量消息字符）当成「模型增长」，误报催写。
 *
 * 判据：
 *  A 量尺：50K memo-river 注入 + 50K 工具输出 + 0 assistant → assistantGrowthChars = 0
 *  B 量尺：+25K assistant 文本 → 25,000（工具/注入仍不计）
 *  C 量尺：assistant 多块 content 全计
 *  D 求值：同一消息流两轮 pre-step，旧口径（全量）在纯注入场景开火催写 → 新口径静默
 *  E 求值：真产出 25K（门槛 20K）→ 开火
 *  F 求值：纯注入一轮后真产出再一轮 → 开火且引用的是产出增量
 *  G lastDiaryTail guard：fresh session（无 memo_write）不出「上篇止于」（编译产物读数）
 *
 * 用法：node scripts/probe-write-nudge-growth.mjs
 */
import { readFileSync } from 'node:fs'

const { assistantGrowthChars } = await import('../lib/injector.js')
const { evaluateWriteNudge } = await import('../lib/injector.js')
const { setTuningFileForTest, setTuning } = await import('../lib/tuning.js')
const { getSession, peekSession } = await import('../lib/session.js')
const { Config } = await import('../lib/config.js')

let pass = 0, fail = 0
const ok = (n, c, extra = '') => { c ? pass++ : fail++; console.log(`  ${c ? '✅' : '❌'} ${n} ${extra}`) }

/* ── 模拟消息流（deriveMessages 形状：blocks 数组 + source.kind） ── */
const KB = 1000
const injectMsg = (chars, kind) => ({
  role: 'user',
  content: [{ type: 'text', text: 'x'.repeat(chars) }],
  source: { kind }, // memo-river / runtime-context / skill-catalog / tool …
})
const assistantMsg = (chars) => ({ role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(chars) }] })

const FRESH_LOG = [
  injectMsg(30 * KB, 'memo-river'),        // 被动召回注入
  injectMsg(12 * KB, 'runtime-context'),   // 运行时快照
  injectMsg(12 * KB, 'skill-catalog'),     // 技能目录
  injectMsg(50 * KB, 'tool'),              // 工具输出
]
const PRODUCED_LOG = [...FRESH_LOG, assistantMsg(25 * KB)]

/** 旧量尺（2026-10-17 前）：全量消息文本求和——注入与工具输出全算「增长」。 */
function legacyGrowthChars(log) {
  let chars = 0
  for (const m of log) chars += (m.content ?? []).map((b) => b.text ?? '').join('\n').length
  return chars
}

console.log('[A] 量尺：104K 系统注入+工具输出、0 assistant → 0')
ok('assistantGrowthChars = 0', assistantGrowthChars(FRESH_LOG) === 0,
  `（实测 ${assistantGrowthChars(FRESH_LOG)}；旧口径同流=${legacyGrowthChars(FRESH_LOG)}）`)

console.log('[B] 量尺：+25K assistant → 只计 25K')
ok('= 25000', assistantGrowthChars(PRODUCED_LOG) === 25_000,
  `（实测 ${assistantGrowthChars(PRODUCED_LOG)}；旧口径=${legacyGrowthChars(PRODUCED_LOG)}）`)

console.log('[C] 量尺：assistant 多块 content 全计')
const multiBlock = { role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(3 * KB) }, { type: 'text', text: 'b'.repeat(4 * KB) }] }
ok('= 7000（含 join 换行 1）', assistantGrowthChars([multiBlock]) === 7 * KB + 1,
  `（实测 ${assistantGrowthChars([multiBlock])}）`)

/* ── 求值集成：门槛钉 20K，同一消息流新旧口径对照 ── */
console.log('[D/E/F] 求值：evaluateWriteNudge 吃新量尺（门槛 setTuning=20K）')
setTuningFileForTest(`/tmp/memo-river-nudge-probe-${Date.now()}.json`)
const cfg = Config({ bucket: '', native: { vcpRoot: '/home/h/app/VCPToolBox' } })
setTuning(cfg, 'preset', { writeNudgeGrowthChars: 20 * KB, writeNudgeEverySteps: 0, writeNudgeEveryTurns: 0, writeNudgeEveryMinutes: 0 }, null)

const mkState = (id) => { getSession(id, '/tmp/memo-river-nudge-probe-ws'); return peekSession(id) }

// D 旧口径：纯注入两轮（模拟开局 54K 注入后又来 50K 注入/工具）→ 开火（=生产误报形态）
{
  const st = mkState('probe-nudge-legacy')
  const fire1 = evaluateWriteNudge(cfg, st, 1, Date.now(), 1, legacyGrowthChars(FRESH_LOG)) // 打底 104K
  const fire2 = evaluateWriteNudge(cfg, st, 1, Date.now(), 2, legacyGrowthChars([...FRESH_LOG, injectMsg(50 * KB, 'memo-river')]))
  ok('旧口径纯注入即开火（生产误报形态复现）', fire1 === null && fire2 !== null,
    `（fire2=${fire2 ? 'nudge@' + fire2.reason : 'null'}，增长 ${(50 * KB)} ≥ 20K）`)
}
// E 新口径：同一消息流两轮 → 静默
{
  const st = mkState('probe-nudge-new')
  const fire1 = evaluateWriteNudge(cfg, st, 1, Date.now(), 1, assistantGrowthChars(FRESH_LOG))
  const fire2 = evaluateWriteNudge(cfg, st, 1, Date.now(), 2, assistantGrowthChars([...FRESH_LOG, injectMsg(50 * KB, 'memo-river')]))
  ok('新口径纯注入静默', fire1 === null && fire2 === null, `（fire1=${!!fire1} fire2=${!!fire2}）`)
}
// F 新口径：注入打底 → 首个非零产出定锚（5K）→ 累计真产出 30K（增长 25K）→ 开火
{
  const st = mkState('probe-nudge-produce')
  const fire1 = evaluateWriteNudge(cfg, st, 1, Date.now(), 1, assistantGrowthChars(FRESH_LOG)) // 0：锚未定
  const fire2 = evaluateWriteNudge(cfg, st, 1, Date.now(), 2, assistantGrowthChars([...FRESH_LOG, assistantMsg(5 * KB)])) // 定锚 5K
  const fire3 = evaluateWriteNudge(cfg, st, 1, Date.now(), 3, assistantGrowthChars([...FRESH_LOG, assistantMsg(30 * KB)])) // 增长 25K
  ok('真产出累计 25K 开火', fire1 === null && fire2 === null && fire3 !== null,
    `（fire3=${fire3 ? 'nudge' : 'null'}）`)
}

console.log('[G] lastDiaryTail guard：fresh session 不出「上篇止于」（编译产物读数）')
const libSrc = readFileSync(new URL('../lib/injector.js', import.meta.url), 'utf8')
ok('lib/injector.js 含 lastDiaryWriteTurn <= 0 guard', libSrc.includes('lastDiaryWriteTurn <= 0'))

console.log(`\n=== ${pass} pass / ${fail} fail ===`)
process.exit(fail === 0 ? 0 : 1)
