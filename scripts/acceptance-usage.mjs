#!/usr/bin/env node
/**
 * acceptance-usage.mjs —— 票 01「使用台账」的实测（.scratch/memory-lifecycle/issues/01）。
 *
 * 六条判据，全部走插件真实路径（mock 的只有 Cordis 壳，被测逻辑不 mock）：
 *   U-1 同一篇经两次被动注入后：台账 计数=2、被动=2、最近时间已更新
 *   U-2 memo_recall 命中后：主动计数=1，与被动分开累计
 *   U-3 记账前后 artifactSig 不变（kv 不漏进内容寻址）
 *   U-4 空桶：使用视图报「无从判定（空库）」，不显示全零假通过
 *   U-5 台账只落 kv_store：内容表行数零变更 + 遗留布尔集冻结
 *   U-6 memo_stats 渲染 ⑤ 使用台账（top/从未/陈旧）+ 遗留集并集生效
 *
 * 用法：node scripts/acceptance-usage.mjs
 * 前置：node scripts/setup-selftest.mjs（写入测试桶 = 河流语料副本）；嵌入走真实 API。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { apply, Config as ConfigSchema } from '../lib/index.js'
import { acquireWorkspace } from '../lib/workspace.js'
import { workspacePaths } from '../lib/runtime.js'
import { healthReport, formatHealth, readUsageLedger } from '../lib/health.js'

const ROOT = '/home/h/app/dsh-memo-river'
const VCP = '/home/h/app/VCPToolBox'
/** 写入测试桶（河流语料副本）：kv 足迹可写，不污染「教室建模归档」对照基准。 */
const WS = join(ROOT, '.selftest', '教室建模写入测试')
const WS_EMPTY = join(ROOT, '.selftest', '使用台账空桶')
const BUCKET = '教室建模写入测试'
/** 已知在河流语料上门控必过的查询（acceptance #9/#15 同款）。 */
const Q = '我这边现在渲染又卡了，上次教室那个是怎么解决的？'

const results = []
const line = (s = '') => console.log(s)
const hr = (t) => line('\n' + '═'.repeat(96) + (t ? `\n${t}` : '') + '\n' + '═'.repeat(96))
function check(id, title, pass, evidence) {
  results.push({ id, title, pass })
  line(`\n【验收 ${id}】${title}  →  ${pass ? '✅ PASS' : '❌ FAIL'}`)
  for (const e of [].concat(evidence)) line(`    ${e}`)
}

/* ── 最小 Cordis 替身（与 acceptance.mjs 同款思路，独立一份） ── */
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

const textMsg = (role, text) => ({ role, content: [{ type: 'text', text }], source: { kind: role === 'user' ? 'user' : 'model' } })
const pluginMsg = (text, plugin = 'runtime-context') => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin, form: 'snapshot' } })

function createAgent(sessionId, cwd) {
  return { session: { id: sessionId, header: { cwd }, deriveMessages: () => [] } }
}

async function runPreStep(h, agent, turn, claimed) {
  const list = h.listeners.get('agent/pre-step') ?? []
  const runtimeContext = pluginMsg('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.')
  let next = async () => ({ kind: 'enter', messages: [...claimed, runtimeContext] })
  for (let i = list.length - 1; i >= 0; i--) {
    const downstream = next
    next = () => list[i].fn({ agent, messages: claimed, turn, step: 1, signal: { aborted: false } }, downstream)
  }
  return next()
}

const execStub = (cwd) => ({ agent: { session: { id: 'usage-acceptance', header: { cwd } } } })

/* ── 前置 ── */
const dbPath = workspacePaths(WS, BUCKET).dbPath
if (!existsSync(dbPath)) {
  console.error(`❌ 缺少写入测试工作区：${dbPath}\n   先跑 node scripts/setup-selftest.mjs`)
  process.exit(2)
}

hr('票 01 使用台账 · acceptance-usage')
const config = ConfigSchema({ bucket: BUCKET, native: { vcpRoot: VCP } })
const h = createMockCtx()
await apply(h.ctx, config)
const tool = (name) => h.registered.tools.find((t) => t.name === name)
const recallTool = tool('memo_recall')
const statsTool = tool('memo_stats')
if (!recallTool || !statsTool) {
  console.error('❌ 工具未注册：memo_recall / memo_stats')
  process.exit(2)
}

const ws = acquireWorkspace(WS, config)
await ws.ensureLoaded()

/* 台账是累积的（跨次运行留在 kv 里）：断言一律用**增量**，结束时还原现场。 */
const kvUsageRaw0 = ws.store.kvGet('memo_river.usage_ledger')
const legacyRaw0 = ws.store.kvGet('memo_river.recalled_file_ids')
const restoreKv = () => {
  if (kvUsageRaw0 === null) ws.store.db.exec("DELETE FROM kv_store WHERE key = 'memo_river.usage_ledger'")
  else ws.store.kvSet('memo_river.usage_ledger', kvUsageRaw0)
  if (legacyRaw0 === null) ws.store.db.exec("DELETE FROM kv_store WHERE key = 'memo_river.recalled_file_ids'")
  else ws.store.kvSet('memo_river.recalled_file_ids', legacyRaw0)
}

const ledger0 = readUsageLedger(ws.store)
const p0 = (id) => ledger0.get(id)?.passive ?? 0
const a0 = (id) => ledger0.get(id)?.active ?? 0

/* 库存资产行（票①红线最硬的证据面）：原生内容摘要只吃 tags 向量（lib.rs:3138
   `SELECT id, vector FROM tags`）+ model_sig + 算法版本 + config_hash——kv_store 不是输入。
   记账前后 tagmemo_artifacts 行应逐字节不变。引擎级 composite sig 因 EPA 每轮全量重算
   而逐次漂移（既有行为，与记账无关，U-3 附对照实验）。 */
const assetRows = () =>
  ws.store.db
    .prepare("SELECT asset_type || '|' || artifact_sig FROM tagmemo_artifacts ORDER BY asset_type")
    .all()
    .map((r) => Object.values(r)[0])
const assets0 = assetRows()
const sigOf = async () => (await ws.engine.ensureArtifact(false)).artifactSig

/* 基线 */
const report0 = healthReport(ws.store, BUCKET)
const counts0 = report0.counts
const sigCtlA = await sigOf()
const sigCtlB = await sigOf() // 对照：无任何记账介入，连续两次
line(`\n基线：files=${counts0.files} chunks=${counts0.chunks} fileTags=${counts0.fileTags}`)
line(`      对照实验：无介入连续两次引擎 sig ${sigCtlA.slice(0, 8)}… → ${sigCtlB.slice(0, 8)}… ${sigCtlA === sigCtlB ? '稳定' : '漂移（EPA 每轮重算的既有行为，非记账所致）'}`)

/* ── U-1 两次被动注入 → Δpassive=2 ── */
const agent = createAgent('usage-passive', WS)
let injected0 = 0
for (let turn = 1; turn <= 2; turn++) {
  const d = await runPreStep(h, agent, turn, [textMsg('user', Q)])
  const texts = (d?.messages ?? []).map((m) => (m.content ?? []).map((b) => b.text ?? '')).join('') 
}
const ledger1 = readUsageLedger(ws.store)
const deltaRows1 = [...ledger1.entries()].map(([id, e]) => ({ id, dp: e.passive - p0(id), da: e.active - a0(id), e }))
const doubled = deltaRows1.find((r) => r.dp === 2 && r.da === 0 && r.e.lastPassiveAt !== null)
check('U-1', '两次被动注入 → 同篇 Δpassive=2、Δactive=0、lastPassiveAt 已记', Boolean(doubled), [
  `本轮有被动增量的篇数=${deltaRows1.filter((r) => r.dp > 0).length}`,
  ...deltaRows1.filter((r) => r.dp > 0).slice(0, 3).map((r) => `D${r.id}: Δpassive=${r.dp} Δactive=${r.da} lastP=${new Date(r.e.lastPassiveAt).toISOString()}`),
])

/* ── U-2 memo_recall → Δactive=1 且与被动分开 ── */
await recallTool.execute({ query: Q }, execStub(WS))
const ledger2 = readUsageLedger(ws.store)
const activeRow = doubled ? ledger2.get(doubled.id) : null
const u2ok = Boolean(doubled && activeRow && activeRow.active - a0(doubled.id) === 1 && activeRow.passive - p0(doubled.id) === 2)
check('U-2', 'memo_recall 命中 → Δactive=1（selected 口径），被动增量不动', u2ok, [
  activeRow && doubled ? `D${doubled.id}: Δpassive=${activeRow.passive - p0(doubled.id)} Δactive=${activeRow.active - a0(doubled.id)} lastA=${activeRow.lastActiveAt ? new Date(activeRow.lastActiveAt).toISOString() : 'null'}` : '未找到 U-1 的篇',
  `本轮主动增量篇数=${[...ledger2].filter(([id, e]) => e.active - a0(id) > 0).length}（=selected 的 k 条，不是 candidates 全库扫）`,
])

/* ── U-3/U-5 记账零外溢 ── */
const assets1 = assetRows()
const assetsSame = assets0.length === assets1.length && assets0.every((v, i) => v === assets1[i])
const report1 = healthReport(ws.store, BUCKET)
const countsSame = ['files', 'chunks', 'fileTags'].every((k) => report1.counts[k] === counts0[k])
const legacy1 = ws.store.kvGet('memo_river.recalled_file_ids')
const legacyFrozen = legacy1 === legacyRaw0
const kvRaw = ws.store.kvGet('memo_river.usage_ledger')
check('U-3', '记账不是任何资产签名的输入：tagmemo_artifacts 行逐字节不变', assetsSame, [
  `库存资产行数 ${assets0.length} → ${assets1.length}，${assetsSame ? '全部逐字节一致' : '⚠️ 出现差异'}`,
  `对照：引擎级 sig 无介入也漂移（${sigCtlA.slice(0, 8)}→${sigCtlB.slice(0, 8)}）——漂移=EPA 既有行为，非记账所致`,
])
check('U-5', '台账只落 kv_store；内容表零变更；遗留布尔集冻结', countsSame && legacyFrozen && kvRaw !== null, [
  `内容表 files/chunks/fileTags：${countsSame ? '全部不变' : `变了 files=${counts0.files}→${report1.counts.files} chunks=${counts0.chunks}→${report1.counts.chunks}`}`,
  `memo_river.usage_ledger 键：${kvRaw ? `${Object.keys(JSON.parse(kvRaw)).length} 条` : '缺失'}`,
  `memo_river.recalled_file_ids：${legacyFrozen ? '冻结未动' : '⚠️ 被写入'}（${legacyRaw0 === null ? 'null' : `${legacyRaw0.length} 字`}）`,
])

/* ── U-4 空桶诚实 ── */
const wsEmpty = acquireWorkspace(WS_EMPTY, config)
const reportE = healthReport(wsEmpty.store, '使用台账空桶')
const textE = formatHealth(reportE)
check('U-4', '空桶 → usage=null + 渲染「无从判定（空库）」', reportE.usage === null && textE.includes('无从判定（空库'), [
  `usage=${reportE.usage === null ? 'null' : JSON.stringify(reportE.usage).slice(0, 80)}`,
  `渲染行：${textE.split('\n').find((l) => l.includes('⑤')) ?? '（无 ⑤ 行）'}`,
])

/* ── U-6 memo_stats 视图 + 遗留并集 ── */
const statsText = String(await statsTool.execute({}, execStub(WS)))
const usageLine = statsText.split('\n').find((l) => l.includes('⑤')) ?? ''
const topRow = report1.usage?.top[0]
const statsOk = usageLine.includes('使用台账') && Boolean(topRow) && usageLine.includes(`D${topRow.fileId}×${topRow.total}`)

// 遗留并集：合成一篇「无台账足迹」的篇（从台账临时摘除）→ 塞进遗留集 → legacyOnly≥1，随后全部还原
let unionOk = false
let unionEvi = []
const probeId = ws.store.files().map((f) => f.id)[0]
if (probeId !== undefined) {
  const strip = { ...Object.fromEntries([...readUsageLedger(ws.store)]) }
  delete strip[probeId]
  ws.store.kvSet('memo_river.usage_ledger', JSON.stringify(strip))
  ws.store.kvSet('memo_river.recalled_file_ids', JSON.stringify([probeId]))
  const rU = healthReport(ws.store, BUCKET)
  unionOk = rU.usage.legacyOnly >= 1 && rU.usage.everUsed === report1.usage.everUsed
  unionEvi = [
    `摘除 D${probeId} 台账再塞进遗留集 → legacyOnly=${rU.usage.legacyOnly}，everUsed 保持 ${rU.usage.everUsed}（台账∪遗留 不重不漏）`,
    `⑤ 行渲染：${formatHealth(rU).split('\n').find((l) => l.includes('仅遗留集足迹')) ?? '（未渲染 legacyOnly，可忽略：probeId 本就有足迹时 everUsed 语义不变）'}`,
  ]
}
check('U-6', 'memo_stats 渲染 ⑤ 视图 + 遗留集并集生效', statsOk && unionOk, [
  `memo_stats ⑤ 行：${usageLine || '（缺失）'}`,
  ...unionEvi,
])

restoreKv()
hr('结果')
const failed = results.filter((r) => !r.pass)
line(`${results.length - failed.length}/${results.length} PASS${failed.length ? `；FAIL：${failed.map((f) => f.id).join(', ')}` : ''}`)
process.exit(failed.length ? 1 : 0)
