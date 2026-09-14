#!/usr/bin/env node
/**
 * acceptance-update.mjs —— 票 02「memo_update 单篇原地改写」的实测（issues/02）。
 *
 * 六条判据，全部走插件真实路径（mock 的只有 Cordis 壳）：
 *   A-1 改写后总篇数不变、fileId/路径不变、chunk 内容=新全文
 *   A-2 与原文近乎相同的自我改写不被 near-duplicate 拒绝（自排除）；逐字复读**别的篇**仍被拒（闸门仍活）
 *   A-3 违规 Tag（新 Tag 无理由）被拒，错误信息与 memo_write 同一套
 *   A-4 改写后立即召回返回新内容（标记句出现、旧句消失），Ω 不塌缩
 *   A-5 日志留 memo_update 审计行
 *   A-6 DESIGN.md 写入契约章节已含 memo_update
 *
 * 用法：node scripts/setup-selftest.mjs && node scripts/acceptance-update.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply, Config as ConfigSchema } from '../lib/index.js'
import { acquireWorkspace } from '../lib/workspace.js'
import { workspacePaths } from '../lib/runtime.js'

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
const execStub = (cwd) => ({ agent: { session: { id: 'update-acceptance', header: { cwd } } } })

/* ── 前置 ── */
const dbPath = workspacePaths(WS, BUCKET).dbPath
if (!existsSync(dbPath)) {
  console.error(`❌ 缺少写入测试工作区：${dbPath}\n   先跑 node scripts/setup-selftest.mjs`)
  process.exit(2)
}

hr('票 02 memo_update · acceptance-update')
const config = ConfigSchema({ bucket: BUCKET, native: { vcpRoot: VCP } })
const h = createMockCtx()
await apply(h.ctx, config)
const tool = (name) => h.registered.tools.find((t) => t.name === name)
const updateTool = tool('memo_update')
const writeTool = tool('memo_write')
const recallTool = tool('memo_recall')
const statsTool = tool('memo_stats')
if (!updateTool || !writeTool || !recallTool || !statsTool) {
  console.error('❌ 工具未注册：memo_update / memo_write / memo_recall / memo_stats')
  process.exit(2)
}

const ws = acquireWorkspace(WS, config)
await ws.ensureLoaded()

const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

/* ── 目标选取：最孤立篇（对其他篇最大余弦最低）——改写后最不可能误触兄弟篇的近重复闸门 ── */
const files0 = ws.store.files(BUCKET)
const chunks0 = ws.store.chunks(BUCKET)
const vecOf = new Map(chunks0.map((c) => [c.file_id, c.vector]))
const titleOf = new Map()
for (const c of chunks0) {
  const m = /^#\s+(.+)$/m.exec(String(c.content ?? ''))
  if (m && !titleOf.has(c.file_id)) titleOf.set(c.file_id, m[1])
}
let target = null, sibling = null, bestIso = 2
for (const a of files0) {
  let max = -1, maxOther = null
  for (const b of files0) {
    if (a.id === b.id || !vecOf.get(a.id) || !vecOf.get(b.id)) continue
    const s = cosine(vecOf.get(a.id), vecOf.get(b.id))
    if (s > max) { max = s; maxOther = b }
  }
  if (max < bestIso) { bestIso = max; target = a; sibling = maxOther }
}
line(`目标：D${target.id}《${titleOf.get(target.id)}》 最孤立相似度=${bestIso.toFixed(3)}（兄弟=D${sibling?.id}）`)

const origContent = String(chunks0.find((c) => c.file_id === target.id)?.content ?? '')
const origTagLine = /Tag:\s*(.+)$/m.exec(origContent)?.[1] ?? ''
const oldSentence = origContent.split('\n').find((l) => l.trim().length > 20 && !l.startsWith('#') && !l.startsWith('Tag:')) ?? ''
const MARK = '琥珀改写标记七浮三'
const newContent =
  `# ${titleOf.get(target.id)}（票②改写验收版）\n\n` +
  `这条日记被 acceptance-update 原地重写：只改内容与措辞，身份（路径与 D 编号）不变。\n` +
  `${MARK}——改写后的句子必须立即可被召回检索到，而原句必须从库中消失。\n` +
  `改写的意义：修正、精简、把新进展合并进旧篇，兑现去重闸门「或合并进旧篇」的承诺。\n\n` +
  `Tag: ${origTagLine}`
const today = new Date().toISOString().slice(0, 10)

/* ── A-1 原地改写 ── */
const r1 = String(await updateTool.execute({ id: target.id, content: newContent, date: today }, execStub(WS)))
const files1 = ws.store.files(BUCKET)
const t1 = files1.find((f) => f.id === target.id)
const chunk1 = ws.store.chunks(BUCKET).find((c) => c.file_id === target.id)
const a1 = Boolean(
  files1.length === files0.length && t1 && t1.path === target.path && chunk1 &&
  String(chunk1.content).includes(MARK) && !String(chunk1.content).includes(oldSentence),
)
check('A-1', '改写后总篇数不变、路径不变、chunk=新全文（旧句已消失）', a1, [
  `篇数 ${files0.length} → ${files1.length}；D${target.id} 路径 ${t1?.path === target.path ? '不变' : '⚠️变了'}`,
  `新标记在库：${chunk1 ? String(chunk1.content).includes(MARK) : false}；旧长句已移除：${chunk1 ? !String(chunk1.content).includes(oldSentence) : false}`,
  `工具返回：${r1.split('\n').slice(0, 2).join(' ⏎ ')}`,
])

/* ── A-4 改写后立即召回：标记可检索（原生日记索引先于/伴随资产重建生效）+ Ω 不塌缩 ── */
let recallHit = null
for (let i = 0; i < 6 && !recallHit; i++) {
  await new Promise((r) => setTimeout(r, i === 0 ? 300 : 1500))
  const rr = String(await recallTool.execute({ query: `改写验收 ${MARK} 是什么`, k: 5 }, execStub(WS)))
  if (rr.includes(MARK)) recallHit = rr
}
const statsText = String(await statsTool.execute({}, execStub(WS)))
const omegaLine = statsText.split('\n').find((l) => l.includes('Ω')) ?? ''
const omegaOk = !omegaLine.includes('collapsed')
check('A-4', '改写后立即召回返回新内容；Ω 不塌缩', Boolean(recallHit) && omegaOk, [
  recallHit ? `召回命中（含标记句）：${recallHit.split('\n').find((l) => l.includes('D') && l.includes(target.id.toString())) ?? recallHook(recallHit, target.id)}` : '⚠️ 六轮轮询均未召回新内容',
  `Ω 行：${omegaLine.slice(0, 80) || '(未找到)'} ${omegaOk ? '' : '⚠️ 塌缩'}`,
])
function recallHook(text, id) { return text.split('\n').find((l) => l.includes("D" + id)) ?? '(行定位失败，全文已含标记)' }

/* ── A-2 自排除：与刚写入内容近乎相同的再次改写不被拒；逐字复读兄弟篇仍被拒 ── */
const r2 = String(await updateTool.execute(
  { id: target.id, content: newContent.replace('改写的意义：', '改写的意义（自查重放行）：'), date: today },
  execStub(WS),
))
const selfOk = !r2.includes('near-duplicate-diary') && !r2.includes('被拒绝')
const sibContent = String(chunks0.find((c) => c.file_id === sibling.id)?.content ?? '')
const sibTag = /Tag:\s*(.+)$/m.exec(sibContent)?.[1] ?? ''
const r3 = String(await writeTool.execute(
  { content: sibContent.replace(/Tag:\s*.+$/m, `Tag: ${sibTag}`), date: today },
  execStub(WS),
))
const gateAlive = r3.includes('near-duplicate-diary')
check('A-2', '自我改写自排除放行；复读他人仍被拒（闸门仍活）', selfOk && gateAlive, [
  `自我近似改写：${selfOk ? '✅ 放行' : `⚠️ ${r1line(r2)}`}`,
  `逐字复读 D${sibling?.id}：${gateAlive ? '✅ 被拒 near-duplicate-diary' : '⚠️ 竟放行（闸门失效？）'}`,
])
function r1line(s) { return s.split('\n').find((l) => l.includes('被拒绝')) ?? s.slice(0, 60) }

/* ── A-3 违规 Tag：新 Tag 无理由 → 同一套拒绝 ── */
const r4 = String(await updateTool.execute(
  { id: target.id, content: newContent.replace(/Tag:\s*.+$/m, `Tag: ${origTagLine}, 票②虚构新词汇`) },
  execStub(WS),
))
check('A-3', '新 Tag 无 newTagReason 被拒（与 memo_write 同一套闸门）', r4.includes('unconfirmed-new-tags') && r4.includes('memo_update'), [
  `拒绝行：${r4.split('\n').find((l) => l.includes('unconfirmed')) ?? '(未找到)'}`,
])

/* ── A-5 审计行 ── */
const logPath = join(ws.paths.root, 'memo-river.log')
const logText = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
const auditLines = logText.split('\n').filter((l) => l.includes('memo_update'))
check('A-5', '日志留 memo_update 审计行（哪篇、checksum 新旧、标题）', auditLines.length >= 2, [
  `审计行数=${auditLines.length}（改写两次）`,
  auditLines[auditLines.length - 1]?.slice(0, 140) ?? '(无)',
])

/* ── A-6 DESIGN 契约更新 ── */
const design = readFileSync(join(ROOT, 'DESIGN.md'), 'utf8')
check('A-6', 'DESIGN.md 写入契约章节含 memo_update', design.includes('memo_update'), [
  `DESIGN.md 中 memo_update 出现 ${design.split('memo_update').length - 1} 次`,
])

hr('结果')
const failed = results.filter((r) => !r.pass)
line(`${results.length - failed.length}/${results.length} PASS${failed.length ? `；FAIL：${failed.map((f) => f.id).join(', ')}` : ''}`)
process.exit(failed.length ? 1 : 0)
