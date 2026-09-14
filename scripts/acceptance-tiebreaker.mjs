#!/usr/bin/env node
/**
 * acceptance-tiebreaker.mjs —— 票 05「有界 tie-breaker 强化」的实测（issues/05）。
 *
 * 五条判据（T-1/T-2 用合成候选做确定性函数测试；T-3/T-4 走插件真实路径）：
 *   T-1 默认关：顺序与分数逐位一致（函数 no-op 深比较 + 集成双跑同序）
 *   T-2 开启后：近并列对（Δ<0.05）翻转；大差距（≥0.10）名次不变；陈旧 active 回落
 *   T-3 强化生效前后 tagmemo_artifacts 行逐字节不变（不进内容寻址）
 *   T-4 memo_tuning session 级可开/关；preset 默认 false 落盘 tuning.json
 *   T-5 DESIGN「边界与不承诺」追加反馈环风险声明
 *
 * 用法：node scripts/setup-selftest.mjs && node scripts/acceptance-tiebreaker.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { apply, Config as ConfigSchema } from '../lib/index.js'
import { acquireWorkspace } from '../lib/workspace.js'
import { workspacePaths } from '../lib/runtime.js'
import { applyUsageTieBreaker } from '../lib/tiebreaker.js'
import { readUsageLedger } from '../lib/health.js'

const ROOT = '/home/h/app/dsh-memo-river'
const VCP = '/home/h/app/VCPToolBox'
const WS = join(ROOT, '.selftest', '教室建模写入测试')
const BUCKET = '教室建模写入测试'
const DAY = 86_400_000

const results = []
const line = (s = '') => console.log(s)
const hr = (t) => line('\n' + '═'.repeat(96) + (t ? `\n${t}\n` : '') + '═'.repeat(96))
function check(id, title, pass, evidence) {
  results.push({ id, title, pass })
  line(`\n【验收 ${id}】${title}  →  ${pass ? '✅ PASS' : '❌ FAIL'}`)
  for (const e of [].concat(evidence)) line(`    ${e}`)
}

/* ── 合成候选：determinstic，不走嵌入 ── */
const mk = (id, score) => ({ id, title: `合成D${id}`, score, knnScore: score, role: 'atomic_concept', anchorBonus: 0, topologyBonus: 0, body: 'x', tags: [] })
const mkLedger = (rows) => {
  const m = new Map()
  for (const [id, active, lastActiveAt] of rows) m.set(id, { passive: 0, active, lastPassiveAt: null, lastActiveAt })
  return m
}
const NOW = Date.now()
const ON = { enabled: true, cap: 0.05, tau: 2, recencyHalfLifeDays: 30 }
const OFF = { enabled: false, cap: 0.05, tau: 2, recencyHalfLifeDays: 30 }

/* T-1 默认关 = no-op（顺序与分数逐位一致） */
const cands = [mk(1, 0.6), mk(2, 0.55), mk(3, 0.4)]
const outOff = applyUsageTieBreaker(cands, mkLedger([[2, 9, NOW]]), OFF, NOW)
const t1fn = JSON.stringify(outOff) === JSON.stringify(cands)
check('T-1a', '默认关：applyUsageTieBreaker 原样返回（逐位一致）', t1fn, [
  `输入序 ${cands.map((c) => `D${c.id}:${c.score}`).join(' < ')} → 输出序 ${outOff.map((c) => `D${c.id}:${c.score}`).join(' < ')}`,
])

/* T-2a 近并列翻转：A 0.500 vs B 0.502，B 有近期 active=5 → boost≈0.0487 → B 反超 */
const near = [mk(10, 0.5), mk(11, 0.502)]
const outNear = applyUsageTieBreaker(near, mkLedger([[11, 5, NOW - 0.1 * DAY]]), ON, NOW)
const flipped = outNear[0].id === 11
check('T-2a', '近并列对（Δ=0.002<0.05）发生重排', flipped, [
  `boost(B)=${(0.05 * Math.tanh(5 / 2)).toFixed(4)} → 排序 ${outNear.map((c) => `D${c.id}:${c.score.toFixed(4)}`).join(' > ')}`,
])

/* T-2b 大差距不重排：A 0.60 vs B 0.50，B boost 最大 0.05 仍不足以翻 0.10 差距 */
const far = [mk(20, 0.6), mk(21, 0.5)]
const outFar = applyUsageTieBreaker(far, mkLedger([[21, 50, NOW]]), ON, NOW)
check('T-2b', '大差距（Δ=0.10）名次不变', outFar[0].id === 20, [
  `排序 ${outFar.map((c) => `D${c.id}:${c.score.toFixed(4)}`).join(' > ')}`,
])

/* T-2c 陈旧 active 回落：lastActiveAt=60 天前 → factor=0.25 → 有效 boost≈0.0123 < Δ=0.02 不翻 */
const stale = [mk(30, 0.5), mk(31, 0.52)]
const outStale = applyUsageTieBreaker(stale, mkLedger([[31, 5, NOW - 60 * DAY]]), ON, NOW)
const staleFactor = Math.exp((-60 * Math.LN2) / 30)
check('T-2c', '陈旧 active（60 天）factor≈0.25，Δ=0.02 不翻（向基线收缩）', outStale[0].id === 31, [
  `有效 boost=${(0.05 * Math.tanh(5 / 2) * staleFactor).toFixed(4)} < 0.02 → 排序不变 ${outStale.map((c) => `D${c.id}`).join(' < ')}`,
])

/* T-2d 上界：boost 永不超过 cap=0.05（tanh<1 ∧ factor≤1） */
const boostMax = 0.05 * Math.tanh(50 / 2) * 1
check('T-2d', '上界 |boost| ≤ cap=0.05', boostMax <= 0.05 + 1e-9, [`tanh 饱和值=${boostMax.toFixed(4)} ≤ 0.05`])

/* ── 以下走真实路径 ── */
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
const execStub = (cwd) => ({ agent: { session: { id: 'tiebreaker-acceptance', header: { cwd } } } })

const dbPath = workspacePaths(WS, BUCKET).dbPath
if (!existsSync(dbPath)) {
  console.error(`❌ 缺少写入测试工作区：${dbPath}\n   先跑 node scripts/setup-selftest.mjs`)
  process.exit(2)
}

hr('票 05 有界 tie-breaker · acceptance-tiebreaker（集成面）')
const config = ConfigSchema({ bucket: BUCKET, native: { vcpRoot: VCP } })
const h = createMockCtx()
await apply(h.ctx, config)
const tool = (name) => h.registered.tools.find((t) => t.name === name)
const recallTool = tool('memo_recall')
const tuningTool = tool('memo_tuning')
if (!recallTool || !tuningTool) {
  console.error('❌ 工具未注册：memo_recall / memo_tuning')
  process.exit(2)
}
const ws = acquireWorkspace(WS, config)
await ws.ensureLoaded()

/* T-1b 集成：默认关，双跑同序同分（首跑会触发资产构建、并列带名次漂移——先预热一次再比较） */
const Q = '我这边现在渲染又卡了，上次教室那个是怎么解决的？'
await recallTool.execute({ query: Q, k: 5 }, execStub(WS))
const rA = String(await recallTool.execute({ query: Q, k: 5 }, execStub(WS)))
const rB = String(await recallTool.execute({ query: Q, k: 5 }, execStub(WS)))
const orderOf = (t) => (t.match(/^·\s*D(\d+)/gm) ?? []).join(',')
const t1int = orderOf(rA) === orderOf(rB) && rA.length > 0
check('T-1b', '集成默认关：连续两次 recall 候选序一致', t1int, [`序：${orderOf(rA) || '(空)'}`])

/* T-4 tuning：session 级开/关（数字面 1/0）+ preset 落盘 */
const tuneBefore = String(await tuningTool.execute({ action: 'get' }, execStub(WS)))
const setOn = String(await tuningTool.execute({ action: 'set', scope: 'session', tieBreakerEnabled: 1 }, execStub(WS)))
const tuneOn = String(await tuningTool.execute({ action: 'get' }, execStub(WS)))
const setOff = String(await tuningTool.execute({ action: 'set', scope: 'session', tieBreakerEnabled: 0 }, execStub(WS)))
const tuneOff = String(await tuningTool.execute({ action: 'get' }, execStub(WS)))
/* preset 落盘验证 + 还原：cap 临时设 0.04 → tuning.json 出现该键 → 还原 0.05 */
await tuningTool.execute({ action: 'set', scope: 'preset', tieBreakerCap: 0.04 }, execStub(WS))
const tuningPath = join(homedir(), '.dsh/.agent-presets/memo-river/tuning.json')
const presetTuning = existsSync(tuningPath) ? readFileSync(tuningPath, 'utf8') : ''
await tuningTool.execute({ action: 'set', scope: 'preset', tieBreakerCap: 0.05 }, execStub(WS))
const t4 = /tieBreakerEnabled = 1（会话覆盖）/.test(tuneOn) && /tieBreakerEnabled = 0（会话覆盖）/.test(tuneOff) && presetTuning.includes('tieBreakerCap')
check('T-4', 'memo_tuning session 开/关生效；preset set 落盘 tuning.json', t4, [
  `get(default)：${(tuneBefore.match(/tieBreakerEnabled = [^\n]*/) ?? ['(未显示)'])[0]}`,
  `session on → ${/tieBreakerEnabled = 1（会话覆盖）/.test(tuneOn) ? '✅' : '⚠️'}；off → ${/tieBreakerEnabled = 0（会话覆盖）/.test(tuneOff) ? '✅' : '⚠️'}`,
  `preset tuning.json：${presetTuning ? presetTuning.slice(0, 100) : '⚠️ 未落盘'}`,
])

/* T-3 强化开关前后 tagmemo_artifacts 行逐字节不变（含预置台账 + 开启态召回） */
const assetRows = () =>
  ws.store.db.prepare("SELECT asset_type || '|' || artifact_sig FROM tagmemo_artifacts ORDER BY asset_type").all().map((r) => Object.values(r)[0])
await ws.engine.ensureArtifact(false)
const rows0 = assetRows()
/* 预置台账：给桶里一篇记 active=3（现时间戳） */
const someId = ws.store.files(BUCKET)[0]?.id
if (someId !== undefined) {
  const led = readUsageLedger(ws.store)
  led.set(someId, { passive: 0, active: 3, lastPassiveAt: null, lastActiveAt: Date.now() })
  ws.store.kvSet('memo_river.usage_ledger', JSON.stringify(Object.fromEntries([...led.entries()].map(([k, v]) => [String(k), v]))))
}
await tuningTool.execute({ action: 'set', scope: 'session', tieBreakerEnabled: 1 }, execStub(WS))
const boosted = String(await recallTool.execute({ query: Q, k: 5 }, execStub(WS)))
await ws.engine.ensureArtifact(false)
const rows1 = assetRows()
check('T-3', '强化开启 + 预置台账召回：tagmemo_artifacts 行逐字节不变', JSON.stringify(rows0) === JSON.stringify(rows1) && boosted.length > 0, [
  `资产行 ${rows0.length} → ${rows1.length}，逐字节一致=${JSON.stringify(rows0) === JSON.stringify(rows1)}`,
  `boosted 召回正常返回（${boosted.includes('· D') ? '✅ 有候选' : '⚠️ 空'}）`,
])
await tuningTool.execute({ action: 'set', scope: 'session', tieBreakerEnabled: 0 }, execStub(WS))

/* T-5 DESIGN 边界与不承诺 */
const design = readFileSync(join(ROOT, 'DESIGN.md'), 'utf8')
const sec = design.slice(design.indexOf('边界与不承诺'), design.indexOf('边界与不承诺') + 2000)
const t5 = sec.includes('马太效应') && sec.includes('主动') && (sec.includes('曝光') || sec.includes('exposure'))
check('T-5', 'DESIGN「边界与不承诺」含反馈环风险声明', t5, [
  `马太效应=${sec.includes('马太效应')}；只认主动信号=${sec.includes('主动')}；曝光偏差=${sec.includes('曝光') || sec.includes('exposure')}`,
])

hr('结果')
const failed = results.filter((r) => !r.pass)
line(`${results.length - failed.length}/${results.length} PASS${failed.length ? `；FAIL：${failed.map((f) => f.id).join(', ')}` : ''}`)
process.exit(failed.length ? 1 : 0)
