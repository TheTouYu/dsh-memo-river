#!/usr/bin/env node
/**
 * acceptance-consolidation.mjs —— 票 04「守护循环合并候选检测」的实测（issues/04）。
 *
 * 五条判据，全部走插件真实路径（mock 的只有 Cordis 壳；嵌入走真实 API）：
 *   C-1 冗余正例：旧+少召回+被新篇覆盖 → 进候选，理由串含年龄/计数/重叠三项值
 *   C-2 收敛：memo_merge 执行后下一轮报告不再列它
 *   C-3 老而独特负例：零误报（无高重叠的老篇不进候选）
 *   C-4 守护集成：runOnce 走完一轮，health.log 出候选计数行；报告文件落 candidates/
 *   C-5 参数可配置 + 空库报「无从判定」+ DESIGN 定标依据
 *
 * 用法：node scripts/setup-selftest.mjs && node scripts/acceptance-consolidation.mjs
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply, Config as ConfigSchema } from '../lib/index.js'
import { acquireWorkspace } from '../lib/workspace.js'
import { workspacePaths } from '../lib/runtime.js'
import { WorkspaceDaemon } from '../lib/daemon.js'
import { candidateReportPath, consolidationCandidates, writeCandidateReport } from '../lib/consolidation.js'

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
const execStub = (cwd) => ({ agent: { session: { id: 'consolidation-acceptance', header: { cwd } } } })

const dbPath = workspacePaths(WS, BUCKET).dbPath
if (!existsSync(dbPath)) {
  console.error(`❌ 缺少写入测试工作区：${dbPath}\n   先跑 node scripts/setup-selftest.mjs`)
  process.exit(2)
}

hr('票 04 合并候选检测 · acceptance-consolidation')
const config = ConfigSchema({ bucket: BUCKET, native: { vcpRoot: VCP } })
const h = createMockCtx()
await apply(h.ctx, config)
const tool = (name) => h.registered.tools.find((t) => t.name === name)
const writeTool = tool('memo_write')
const mergeTool = tool('memo_merge')
if (!writeTool || !mergeTool) {
  console.error('❌ 工具未注册：memo_write / memo_merge')
  process.exit(2)
}
const ws = acquireWorkspace(WS, config)
await ws.ensureLoaded()
const CONS = config.maintenance.consolidation
line(`判定参数：minAgeDays=${CONS.minAgeDays} maxRecalls=${CONS.maxRecalls} overlapCosine=${CONS.overlapCosine}`)

/* ── 构造正例：A（旧、零召回）被 B（新、同主题重写+扩展）覆盖 ── */
const TAGS_A = '帧率达标, 视频编码, 网页实时播放'
const contentA =
  '# 网页播放卡顿排查·甲\n\n' +
  '现象：网页实时播放教室渲染时偶发卡顿，帧率从一百多掉到个位数。\n' +
  '排查：采集侧像素困在浏览器标签页里，标签没关导致内存占用持续增长。\n' +
  '处置：关掉多余标签后帧率恢复；后续把采集挪到专用进程，问题未复现。\n\n' +
  `Tag: ${TAGS_A}`
const contentB =
  '# 网页播放卡顿排查·乙（覆盖甲并扩展）\n\n' +
  '现象同甲：实时播放偶发卡顿、帧率骤降。本轮补充完整因果链。\n' +
  '根因确认：浏览器多标签并存时采集进程内存膨胀，挤占渲染预算。\n' +
  '处置升级：关闭冗余标签 + 采集独立进程化，帧率稳定在目标线以上。\n' +
  '新增结论：网页实时播放的帧率达标要与资源占用一起盯，环境问题是放大器。\n\n' +
  `Tag: ${TAGS_A}`
const today = new Date().toISOString().slice(0, 10)
const rA = String(await writeTool.execute({ content: contentA, date: today }, execStub(WS)))
if (rA.includes('被拒绝')) { console.error('A 写入被拒：', rA.slice(0, 200)); process.exit(2) }
const filesAfterA = ws.store.files(BUCKET)
const A = filesAfterA[filesAfterA.length - 1]
/* 回退 A 的年龄：updated_at/mtime 拨回 20 天前（年龄判定的构造面） */
ws.store.db.prepare('UPDATE files SET updated_at = ?, mtime = ? WHERE id = ?').run(Date.now() - 20 * DAY, Date.now() - 20 * DAY, A.id)
const rB = String(await writeTool.execute({ content: contentB, date: today }, execStub(WS)))
if (rB.includes('被拒绝')) { console.error('B 写入被拒（与 A 过近？）：', rB.split('\n').find((l) => l.includes('被拒绝')) ?? rB.slice(0, 160)); process.exit(2) }
const filesAfterB = ws.store.files(BUCKET)
const B = filesAfterB[filesAfterB.length - 1]
line(`构造：A=D${A.id}（已回退 20 天） B=D${B.id}（新写覆盖篇）`)

/* ── C-1 正例：A 进候选，理由串三项值齐 ── */
const out1 = consolidationCandidates(ws.store, BUCKET, CONS)
const candA = out1.candidates.find((c) => c.fileId === A.id)
const reasonOk = candA ? /age=\d+d ≥ \d+d/.test(candA.reason) && /recalls=0 ≤ \d/.test(candA.reason) && /overlap=0\.\d{4} vs 更新篇 D\d+/.test(candA.reason) : false
check('C-1', '冗余正例进候选，理由串含年龄/计数/重叠三项值', Boolean(candA) && reasonOk, [
  candA ? candA.reason : `⚠️ 未列 A（候选=${out1.candidates.map((c) => 'D' + c.fileId).join(',') || '无'}）`,
  `overlap=${candA?.overlapScore.toFixed(4)}（须 ≥ ${CONS.overlapCosine}）vs D${candA?.overlapFileId}`,
])

/* ── C-4 守护集成：一轮 runOnce + health.log 行 + 报告文件 ── */
const daemon = new WorkspaceDaemon({ config, workspace: ws, log: () => {}, setInterval: (fn) => () => {}, takeDrafts: () => [] })
const round1 = await daemon.runOnce()
const health1 = readFileSync(ws.paths.healthLogPath, 'utf8').split('\n').filter(Boolean).pop() ?? ''
const repPath = candidateReportPath(ws.paths.root)
const rep1 = existsSync(repPath) ? readFileSync(repPath, 'utf8') : ''
check('C-4', 'runOnce 出候选计数行；报告落 candidates/ 且含 A', round1.mergeCandidates === out1.candidates.length && health1.includes(`mergeCandidates=${out1.candidates.length}/`) && rep1.includes(`D${A.id}`), [
  `round.mergeCandidates=${round1.mergeCandidates}（检测=${out1.candidates.length}/${out1.checked}）`,
  `health.log 尾行 mergeCandidates 片段：${(health1.match(/mergeCandidates=[^ ]*/) ?? ['(无)'])[0]}`,
  `报告 ${repPath}：${rep1 ? `含 D${A.id}=${rep1.includes(`D${A.id}`)}` : '⚠️ 未生成'}`,
])

/* ── C-2 收敛：memo_merge(A,B keep=B) 后，下一轮不再列 A ── */
const mergedContent =
  '# 网页播放卡顿排查·合并定稿\n\n' +
  '覆盖甲乙两篇：偶发卡顿的根因是浏览器多标签采集内存膨胀；处置为关冗余标签+采集独立进程化。\n' +
  '定稿结论：网页实时播放的帧率达标要与资源占用一起盯，环境问题是放大器。\n\n' +
  `Tag: ${TAGS_A}`
const rM = String(await mergeTool.execute({ sources: [A.id, B.id], keep: B.id, content: mergedContent, date: today }, execStub(WS)))
const out2 = consolidationCandidates(ws.store, BUCKET, CONS)
const goneA = !out2.candidates.some((c) => c.fileId === A.id) && !ws.store.files(BUCKET).some((f) => f.id === A.id)
const rep2 = writeCandidateReport(ws.store, BUCKET, CONS, ws.paths.root)
check('C-2', 'memo_merge 后下一轮不再列它（报告自动收敛）', goneA && !rM.includes('被拒绝') && !readFileSync(repPath, 'utf8').includes(`D${A.id}`), [
  `merge 返回：${rM.includes('被拒绝') ? '⚠️ 被拒' : '✅ 执行'}`,
  `检测轮2：候选=${out2.candidates.length}（原 ${out1.candidates.length}），A 已从库退役=${!ws.store.files(BUCKET).some((f) => f.id === A.id)}`,
])

/* ── C-3 老而独特负例：最孤立篇回退 20 天，零误报 ── */
const chunksNow = ws.store.chunks(BUCKET)
const filesNow = ws.store.files(BUCKET)
const vecOf = new Map(chunksNow.map((c) => [c.file_id, c.vector]))
let uniq = null, bestIso = 2
for (const a of filesNow) {
  let max = -1
  for (const b of filesNow) {
    if (a.id === b.id || !vecOf.get(a.id) || !vecOf.get(b.id)) continue
    let dot = 0, na = 0, nb = 0
    const va = vecOf.get(a.id), vb = vecOf.get(b.id)
    for (let i = 0; i < Math.min(va.length, vb.length); i++) { dot += va[i] * vb[i]; na += va[i] * va[i]; nb += vb[i] * vb[i] }
    const s = dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
    if (s > max) max = s
  }
  if (max < bestIso) { bestIso = max; uniq = a }
}
ws.store.db.prepare('UPDATE files SET updated_at = ?, mtime = ? WHERE id = ?').run(Date.now() - 20 * DAY, Date.now() - 20 * DAY, uniq.id)
const out3 = consolidationCandidates(ws.store, BUCKET, CONS)
check('C-3', '老而独特零误报（最孤立篇 D' + uniq.id + ' 回退后不进候选）', !out3.candidates.some((c) => c.fileId === uniq.id), [
  `D${uniq.id} 对其余篇最大相似度=${bestIso.toFixed(4)}（< ${CONS.overlapCosine}），回退后候选=${out3.candidates.map((c) => 'D' + c.fileId).join(',') || '无'}`,
])

/* ── C-5 参数可配置 + 空库「无从判定」 + DESIGN 定标 ── */
const cfgCustom = ConfigSchema({ bucket: BUCKET, native: { vcpRoot: VCP }, maintenance: { consolidation: { minAgeDays: 3, maxRecalls: 0, overlapCosine: 0.85 } } })
const cfgOk = cfgCustom.maintenance.consolidation.minAgeDays === 3 && cfgCustom.maintenance.consolidation.maxRecalls === 0 && cfgCustom.maintenance.consolidation.overlapCosine === 0.85
const emptyRoot = join(ROOT, '.selftest', '合并候选空桶')
mkdirSync(emptyRoot, { recursive: true })
const wsEmpty = acquireWorkspace(emptyRoot, ConfigSchema({ bucket: '合并候选空桶', native: { vcpRoot: VCP } }))
const outEmpty = writeCandidateReport(wsEmpty.store, '合并候选空桶', CONS, wsEmpty.paths.root)
const emptyOk = outEmpty.status === 'empty' && readFileSync(candidateReportPath(wsEmpty.paths.root), 'utf8').includes('无从判定（空库）')
const design = readFileSync(join(ROOT, 'DESIGN.md'), 'utf8')
const designOk = design.includes('7.1.3') && design.includes('overlapCosine') && design.includes('dedupCosine')
check('C-5', '参数可配置；空库报无从判定；DESIGN 有定标依据', cfgOk && emptyOk && designOk, [
  `自定义参数解析：${cfgOk}；空库报告：${emptyOk}`,
  `DESIGN 定标：${designOk}`,
])
hr('结果')
const failed = results.filter((r) => !r.pass)
line(`${results.length - failed.length}/${results.length} PASS${failed.length ? `；FAIL：${failed.map((f) => f.id).join(', ')}` : ''}`)
process.exit(failed.length ? 1 : 0)
