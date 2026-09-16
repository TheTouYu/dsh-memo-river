#!/usr/bin/env node
/**
 * acceptance-merge.mjs —— 票 03「memo_merge 多篇归一与归档退役」的实测（issues/03）。
 *
 * 六条判据，全部走插件真实路径（mock 的只有 Cordis 壳）：
 *   M-1 2 合 1（新篇模式缺省）：总篇数 -1，archive/ 留 2 个源文件，源篇召回不再命中
 *   M-2 合并后体检连通分量仍 = 1（Tag 语义延续不断裂）
 *   M-3 去重豁免只对声明源生效：与未声明篇近乎相同的合并内容仍被拒
 *   M-4 合并篇正文含「合并自 D…, D…」溯源行
 *   M-5 archive 源文件保留完整原文与 Tag 行
 *   M-6 DESIGN.md 更新（归档语义、溯源规范）
 *
 * 用法：node scripts/setup-selftest.mjs && node scripts/acceptance-merge.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { apply, Config as ConfigSchema } from '../lib/index.js'
import { acquireWorkspace } from '../lib/workspace.js'
import { workspacePaths } from '../lib/runtime.js'
import { startEmbedStub } from './embed-stub.mjs'
import { KV_USAGE } from '../lib/health.js'

const ROOT = '/home/h/app/dsh-memo-river'
const VCP = '/home/h/app/VCPToolBox'
const WS = join(ROOT, '.selftest', '教室建模写入测试')
const BUCKET = '教室建模写入测试'

const results = []
const line = (s = '') => console.log(s)
const hr = (t) => line('\n' + '═'.repeat(96) + (t ? `\n${t}` : '') + '\n' + '═'.repeat(96))
function check(id, title, pass, evidence) {
  results.push({ id, title, pass })
  line(`\n【验收 ${id}】${title}  →  ${pass ? '✅ PASS' : '❌ FAIL'}`)
  for (const e of [].concat(evidence)) line(`    ${e}`)
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
const execStub = (cwd) => ({ agent: { session: { id: 'merge-acceptance', header: { cwd } } } })

const dbPath = workspacePaths(WS, BUCKET).dbPath
if (!existsSync(dbPath)) {
  console.error(`❌ 缺少写入测试工作区：${dbPath}\n   先跑 node scripts/setup-selftest.mjs`)
  process.exit(2)
}

hr('票 03 memo_merge · acceptance-merge')
/* 提速资产（0916）：缺省本地嵌入桩（秒级零网络）；REAL_EMBED=1 回落真端点。
 * 桩余弦尺度低于真嵌入 → gate 阈值同步调低（本套件测 merge/update 机制，不测语义门限）。 */
const REAL_EMBED = process.env.REAL_EMBED === '1'
const stub = REAL_EMBED ? null : await startEmbedStub('hash')
const config = ConfigSchema({ bucket: BUCKET, native: { vcpRoot: VCP }, ...(stub ? { embed: { apiUrl: stub.url, apiKey: 'stub' }, inject: { gateThreshold: 0.2 } } : {}) })
const h = createMockCtx()
await apply(h.ctx, config)
const tool = (name) => h.registered.tools.find((t) => t.name === name)
const mergeTool = tool('memo_merge')
const recallTool = tool('memo_recall')
const statsTool = tool('memo_stats')
if (!mergeTool || !recallTool || !statsTool) {
  console.error('❌ 工具未注册：memo_merge / memo_recall / memo_stats')
  process.exit(2)
}

const ws = acquireWorkspace(WS, config)
await ws.ensureLoaded()

const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

/* ── 源选取：最相似的一对（合并的典型用例：近重复对） + 未声明的第三者（M-3 用） ── */
const files0 = ws.store.files(BUCKET)
const chunks0 = ws.store.chunks(BUCKET)
const vecOf = new Map(chunks0.map((c) => [c.file_id, c.vector]))
let pair = null, bestSim = -1
for (const a of files0) for (const b of files0) {
  if (a.id >= b.id || !vecOf.get(a.id) || !vecOf.get(b.id)) continue
  const s = cosine(vecOf.get(a.id), vecOf.get(b.id))
  if (s > bestSim) { bestSim = s; pair = [a, b] }
}
const outsider = files0.find((f) => f.id !== pair[0].id && f.id !== pair[1].id)
const titleOf = (f) => (/^#\s+(.+)$/m.exec(String(chunks0.find((c) => c.file_id === f.id)?.content ?? '')) ?? [])[1] ?? basename(f.path)
line(`源对：D${pair[0].id}《${titleOf(pair[0])}》+ D${pair[1].id}《${titleOf(pair[1])}》 相似度=${bestSim.toFixed(3)}；未声明第三者 D${outsider.id}`)

const tagLineOf = (f) => (/Tag:\s*(.+)$/m.exec(String(chunks0.find((c) => c.file_id === f.id)?.content ?? ''))?.[1] ?? '').split(',').map(s => s.trim()).filter(Boolean)
const unionTags = [...new Set([...tagLineOf(pair[0]), ...tagLineOf(pair[1])])].slice(0, 5)
const originals = new Map(pair.map((f) => [f.id, String(chunks0.find((c) => c.file_id === f.id)?.content ?? '')]))

const MARK = '青灰合并标记五关二'
const mergedContent =
  `# ${titleOf(pair[0]).slice(0, 18)}与${titleOf(pair[1]).slice(0, 12)}的合并篇\n\n` +
  `两篇近重复日记已合并：这一篇承载两源的存留事实，源篇归档退役。\n` +
  `${MARK}——合并后的记忆应当是压缩而非堆叠：删冗余、保转折、留结论。\n` +
  `保留要点：源一的主要结论 + 源二的增量转折，均以本句概括。\n\n` +
  `Tag: ${unionTags.join(', ')}`
const today = new Date().toISOString().slice(0, 10)

/* ── M-1 缺省新篇模式：2 → 1 ── */
const r1 = String(await mergeTool.execute({ sources: [pair[0].id, pair[1].id], content: mergedContent, date: today }, execStub(WS)))
const files1 = ws.store.files(BUCKET)
const archiveDir = join(ws.paths.root, 'archive')
const archived = existsSync(archiveDir) ? readdirSync(archiveDir) : []
const srcGone = pair.every((f) => !files1.find((x) => x.id === f.id))
const archiveHas2 = pair.every((f) => archived.includes(basename(f.path)))
const mergedRow = files1.find((f) => f.id > 11) /* 新篇 = 新 file id */
const chunks1 = ws.store.chunks(BUCKET)
const mergedChunk = mergedRow ? chunks1.find((c) => c.file_id === mergedRow.id) : null
const noSourceChunks = pair.every((f) => !chunks1.find((c) => c.file_id === f.id))
check('M-1', '2 合 1：总篇数 -1，archive/ 留 2 个源文件，源篇 chunk 清除', Boolean(
  files1.length === files0.length - 1 && srcGone && archiveHas2 && mergedChunk && noSourceChunks,
), [
  `篇数 ${files0.length} → ${files1.length}；源篇行删除：${srcGone}；archive=${archived.join(', ')}`,
  `合并篇 chunk（file D${mergedRow?.id}）：${mergedChunk ? '✅ 入库' : '⚠️ 缺失'}`,
])

/* ── M-4 溯源行 ── */
const provOk = mergedChunk ? (String(mergedChunk.content).includes(`合并自 D${pair[0].id}, D${pair[1].id}`) || /合并自 D\d+,?\s*D?\d*/.test(String(mergedChunk.content))) : false
check('M-4', '合并篇正文含「合并自 D…, D…」溯源行', provOk, [
  mergedChunk ? String(mergedChunk.content).split('\n').find((l) => l.includes('合并自')) ?? '(未找到)' : '(无 chunk)',
])

/* ── M-5 archive 保全原文与 Tag 行 ── */
const m5detail = pair.map((f) => {
  const disk = readFileSync(join(archiveDir, basename(f.path)), 'utf8')
  const ok = disk === originals.get(f.id) && /^Tag:/m.test(disk)
  return `D${f.id}: ${ok ? '✅ 原文+Tag 行保全' : `⚠️ 差异（${disk.length} vs ${(originals.get(f.id) || '').length} 字）`}`
})
check('M-5', 'archive 源文件保留完整原文与 Tag 行', m5detail.every((d) => d.includes('✅')), m5detail)

/* ── M-2 连通分量仍 = 1 + 合并篇可召回 ── */
let recallHit = null
for (let i = 0; i < 6 && !recallHit; i++) {
  await new Promise((r) => setTimeout(r, i === 0 ? 300 : 1500))
  const rr = String(await recallTool.execute({ query: `合并验收 ${MARK} 是什么`, k: 5 }, execStub(WS)))
  const blk = rr.split('\n').find((l) => l.includes(MARK))
  if (blk) recallHit = blk
}
const statsText = String(await statsTool.execute({}, execStub(WS)))
const compLine = statsText.split('\n').find((l) => l.includes('连通分量')) ?? ''
const ledger = JSON.parse(ws.store.kvGet(KV_USAGE) ?? '{}')
const ledgerClean = pair.every((f) => !(String(f.id) in ledger))
check('M-2', '合并后连通分量 = 1；合并篇可召回；台账已清扫源篇', compLine.includes('1') && Boolean(recallHit) && ledgerClean, [
  `体检：${compLine.slice(0, 60) || '(未找到连通分量行)'}`,
  recallHit ? `召回命中：${recallHit.slice(0, 80)}` : '⚠️ 六轮未召回合并篇',
  `台账无源篇残留：${ledgerClean}`,
])

/* ── M-3 豁免只对声明源：声明另两篇现存篇，但内容 ≈ 未声明第三者 → 拒 ── */
const outsiderContent = String(chunks0.find((c) => c.file_id === outsider.id)?.content ?? '')
const remain = files1.filter((f) => mergedRow && f.id !== mergedRow.id && f.id !== outsider.id)
const decl = [remain[0], remain[1]]
const r3 = String(await mergeTool.execute(
  { sources: [decl[0].id, decl[1].id], content: outsiderContent, date: today },
  execStub(WS),
))
check('M-3', '与未声明篇近乎相同的合并内容仍被拒（豁免只对声明源）', r3.includes('near-duplicate-diary'), [
  `声明源 D${decl[0].id}+D${decl[1].id}，内容=未声明 D${outsider.id} 逐字：`,
  r3.split('\n').find((l) => l.includes('被拒绝')) ?? r3.slice(0, 80),
])

/* ── M-6 DESIGN 契约更新 ── */
const design = readFileSync(join(ROOT, 'DESIGN.md'), 'utf8')
check('M-6', 'DESIGN.md 更新归档语义与溯源规范', design.includes('memo_merge') && design.includes('archive'), [
  `memo_merge×${design.split('memo_merge').length - 1}，archive×${design.split('archive').length - 1}`,
])

hr('结果')
const failed = results.filter((r) => !r.pass)
line(`${results.length - failed.length}/${results.length} PASS${failed.length ? `；FAIL：${failed.map((f) => f.id).join(', ')}` : ''}`)
try { await stub?.stop() } catch { /* 已关 */ }
process.exit(failed.length ? 1 : 0)
