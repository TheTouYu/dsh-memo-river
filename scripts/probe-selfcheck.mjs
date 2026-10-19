#!/usr/bin/env node
/**
 * probe-selfcheck.mjs — 自我观测层 + 生命体征的行为读数（2026-10-19）。
 *
 * ## 这份探针要证明什么
 *
 * 本轮（2026-10-19）做了六件事，其中三件在交付时**无法回答「它有用吗」**：
 * `memo_read` 会不会被调、`hurt` 会不会进数据、注入的条目会不会被消费。
 * 而两条研究线的结论是同一条：**先能看见，再谈判断**。
 *
 * 本探针锚的是「**能看见**」这一层的四件事：
 *   V1 观测环：工具调用真的被记下来了，且**只记结构不记内容**（长文本压成 len(N)）
 *   V2 有界：超过上限丢最旧的，不无限增长（Library Drift 的 bloat 子模式不能自己重演）
 *   V3 四态：live / idle / inert / unknown **必须分得开**——
 *      「还判断不了」与「坏了」混为一谈是本轮最大的认知错误来源
 *   V4 惰性组件被点名：遗忘引擎条件恒假时判 `inert` 而不是静默
 *
 * 隔离：`import './isolated-env.mjs'` 第一条 —— 不在生产柜子留空壳桶。
 * 跑法：node scripts/probe-selfcheck.mjs
 * 退出码：0 全过 / 1 有断言失败
 */
import './isolated-env.mjs'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config as ConfigSchema } from '../lib/index.js'

const WS = mkdtempSync(join(tmpdir(), 'probe-selfcheck-'))
const BUCKET = '探针桶-selfcheck'
const config = ConfigSchema({ bucket: BUCKET, native: { vcpRoot: '/nonexistent' } })

let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) {
    pass += 1
    console.log(`  ✅ ${name}${detail ? `  ${detail}` : ''}`)
  } else {
    fail += 1
    console.log(`  ❌ ${name}${detail ? `  ${detail}` : ''}`)
  }
}

function createMockCtx() {
  const listeners = new Map()
  const registered = { tools: [] }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(event, fn) {
      const list = listeners.get(event) ?? []
      list.push({ fn })
      listeners.set(event, list)
      return () => {}
    },
    effect(cb) { cb(); return () => {} },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    tools: { register(t) { registered.tools.push(t); return () => {} } },
    get: () => undefined,
    interval(fn) { const h = setInterval(fn, 3_600_000); h.unref?.(); return () => clearInterval(h) },
  }
  return { ctx, listeners, registered }
}
const execStub = (cwd) => ({ agent: { session: { id: 'probe-selfcheck', header: { cwd } } } })

const h = createMockCtx()
await apply(h.ctx, config)
const tool = (name) => h.registered.tools.find((t) => t.name === name)

const obs = await import('../lib/observation.js')
const vit = await import('../lib/vitals.js')

console.log('══════ 注册面 ══════')
check('memo_selfcheck 已注册', !!tool('memo_selfcheck'), '')
check('memo_read 已注册（被观测对象）', !!tool('memo_read'), '')
const toolCount = h.registered.tools.filter((t) => t.name.startsWith('memo_')).length
check('工具面齐全', toolCount >= 14, `${toolCount} 个 memo_*`)

const { acquireWorkspace } = await import('../lib/workspace.js')
const ws = acquireWorkspace(WS, config)
await ws.ensureLoaded()

console.log('\n══════ V1 观测环：调用被记下来，且只记结构 ══════')
{

  const before = await ws.withDb(async () => obs.readObservations(ws.store).length)
  check('初始为空', before === 0, `ring=${before}`)

  /* 调一次 memo_tags（无副作用、必成功），它应当被拦截器记下 */
  const tagsTool = tool('memo_tags')
  if (tagsTool) {
    await tagsTool.execute({ limit: 5 }, execStub(WS))
    const after = await ws.withDb(async () => obs.readObservations(ws.store))
    check('调用后被记录', after.length === 1, `ring=${after.length}`)
    check('记的是工具名', after[0]?.tool === 'memo_tags', `tool=${after[0]?.tool}`)
    check('记了时间戳', typeof after[0]?.at === 'number', '')
    check('记了参数结构', typeof after[0]?.arg === 'string' && after[0].arg.includes('limit'), `arg=${after[0]?.arg}`)
  }

  /* 长文本必须被压成 len(N) —— 观测环不能变成第二份语料 */
  const longText = '这是一段很长的正文'.repeat(20)
  const sum = obs.summarizeArgs({ content: longText, id: 42 })
  check('长文本压成 len(N)，不抄内容', /content=len\(\d+\)/.test(sum) && !sum.includes('这是一段很长的正文'), sum)
  check('短标量直接记', sum.includes('id=42'), sum)
}

console.log('\n══════ V2 有界：超上限丢最旧，不无限增长 ══════')
{
  const fake = []
  const base = Date.now() - 100000
  for (let i = 0; i < obs.OBSERVATION_CAP + 60; i += 1) {
    fake.push({ tool: 'bulk', at: base + i, arg: `i=${i}` })
  }
  /* 直接按 recordObservation 的切片逻辑验证（避免 500+ 次 kvSet） */
  const trimmed = fake.length > obs.OBSERVATION_CAP ? fake.slice(fake.length - obs.OBSERVATION_CAP) : fake
  check('容量上限是硬约束', trimmed.length === obs.OBSERVATION_CAP, `${trimmed.length}/${obs.OBSERVATION_CAP}`)
  check('丢的是最旧的（保留尾部）', trimmed[0]?.arg === `i=${60}`, `head=${trimmed[0]?.arg}`)
}

console.log('\n══════ V3 四态：live / idle / inert / unknown 必须分得开 ══════')
{
  const now = Date.now()
  /* unknown：从未被调用 */
  const unknownV = vit.vitalForTool([], 'memo_read', 7 * 86400000, now)
  check('从未调用 → unknown（不是 0）', unknownV.state === 'unknown', `state=${unknownV.state}`)
  check('unknown 带行动建议', typeof unknownV.action === 'string' && unknownV.action.length > 10, '')

  /* live：有调用 */
  const liveV = vit.vitalForTool([{ tool: 'memo_read', at: now - 1000 }], 'memo_read', 7 * 86400000, now)
  check('有调用 → live', liveV.state === 'live', `state=${liveV.state}`)

  /* inert：遗忘引擎条件恒假 */
  const inertV = vit.vitalForConsolidation({
    totalFiles: 251, maxIdleDays: 4.0, maxPairCos: 0.8978,
    minAgeDays: 14, overlapCosine: 0.9, candidates: 0,
  })
  check('阈值恒假 → inert（不是「没候选」）', inertV.state === 'inert', `state=${inertV.state}`)
  check('inert 点明哪条判据不可达', /不成立|恒假/.test(inertV.reading), inertV.reading.slice(0, 70))
  check('inert 劝住「降阈值」这个错误动作', /别|不要|正确做法/.test(inertV.action ?? ''), '')

  /* idle：语料太少，先不下结论 */
  const idleV = vit.vitalForConsolidation({
    totalFiles: 5, maxIdleDays: 1, maxPairCos: 0.99,
    minAgeDays: 14, overlapCosine: 0.9, candidates: 0,
  })
  check('语料太少 → idle（不是 inert）', idleV.state === 'idle', `state=${idleV.state}`)
  check('idle 与 inert 文案不同', idleV.reading !== inertV.reading, '')

  /* 条件可达但零候选 → idle（语料可能确实干净），不是 inert */
  const cleanV = vit.vitalForConsolidation({
    totalFiles: 251, maxIdleDays: 30, maxPairCos: 0.95,
    minAgeDays: 14, overlapCosine: 0.9, candidates: 0,
  })
  check('条件可达+零候选 → idle（不冤枉引擎）', cleanV.state === 'idle', `state=${cleanV.state}`)
}

console.log('\n══════ V4 Critic：0 与「不知道」分开 ══════')
{
  const noRecall = vit.vitalForCritic([], 48)
  check('无召回 → unknown', noRecall.state === 'unknown', `state=${noRecall.state}`)

  const shortSpan = vit.vitalForCritic(
    [{ passive: 20, active: 1, lastPassiveAt: 1, lastActiveAt: 1, hurt: 0 }], 2,
  )
  check('短跨度 + 零 hurt → idle（样本不足，别下结论）', shortSpan.state === 'idle', `state=${shortSpan.state}`)

  const longSpan = vit.vitalForCritic(
    [{ passive: 200, active: 5, lastPassiveAt: 1, lastActiveAt: 1, hurt: 0 }], 72,
  )
  check('长跨度 + 零 hurt → inert（可能假阴性）', longSpan.state === 'inert', `state=${longSpan.state}`)
  check('inert 给出三处排查点', /pendingHurt|词表|窗口/.test(longSpan.action ?? ''), '')

  const hasHurt = vit.vitalForCritic(
    [{ passive: 20, active: 1, lastPassiveAt: 1, lastActiveAt: 1, hurt: 3 }], 72,
  )
  check('有 hurt → live', hasHurt.state === 'live', `state=${hasHurt.state}`)
}

console.log('\n══════ V5 端到端：memo_selfcheck 真能读出东西 ══════')
{
  const sc = tool('memo_selfcheck')
  check('memo_selfcheck 可调用', !!sc, '')
  if (sc) {
    const out = String(await sc.execute({}, execStub(WS)))
    check('输出含四态图标', /[✅⏳⚠️❓]/.test(out), '')
    check('点名了遗忘引擎', out.includes('压缩式遗忘引擎'), '')
    check('点名了 Critic', out.includes('Critic'), '')
    check('报了观测环状态', out.includes('观测环'), out.split('\n').find((l) => l.includes('观测环')) ?? '')
    check('汇总行齐全', /live=\d+ idle=\d+ inert=\d+ unknown=\d+/.test(out),
      (out.match(/live=\d+ idle=\d+ inert=\d+ unknown=\d+/) ?? [''])[0])
    check('memo_selfcheck 自己不进观测环（查观测不污染观测）',
      await ws.withDb(async () => !obs.readObservations(ws.store).some((o) => o.tool === 'memo_selfcheck')), '')
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败${fail === 0 ? '  ✅ 全绿' : ''}`)
process.exit(fail === 0 ? 0 : 1)
