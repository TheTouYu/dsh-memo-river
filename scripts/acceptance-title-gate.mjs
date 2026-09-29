#!/usr/bin/env node
/**
 * acceptance-title-gate.mjs —— 票 02（recall-quality-0916）「memo_write/update 标题闸门
 * （消灭「未命名」日记）」的实测（.scratch/recall-quality-0916/issues/02-title-gate.md）。
 *
 * 五条判据，全部走插件真实入口（mock 的只有 Cordis 壳；嵌入离线配置——标题闸门不依赖向量）：
 *   T-1 memo_write 无 title 且正文无 `# ` 行 → missing-title 拒绝 + 指引文案；库不落篇
 *   T-2 单 `# ` 标题行：标题正确，写盘/库内全文标题行只出现一次（重复拼接缺陷已修）
 *   T-3 memo_write 显式 title（正文无 `# ` 行）→ 按显式标题写入，正文原样保留
 *   T-4 memo_update 新正文无 `# ` 行 → 保留目标原标题（fileId/路径不变，不降级「未命名」）
 *   T-5 memo_update 改写「未命名」存量条目（残次原标题）→ missing-title 拒绝；
 *       新正文首行补 `# 新标题` → 放行（docs/GUIDE-未命名存量修复.md 的活体复现）
 *   收尾全库扫描：本桶没有任何 chunk 的 `#` 标题行含「未命名」。
 *
 * 用法：node scripts/acceptance-title-gate.mjs（自建自净 /tmp 工作区，无需 setup-selftest）
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, Config as ConfigSchema } from '../lib/index.js'
import { acquireWorkspace } from '../lib/workspace.js'
import { workspacePaths } from '../lib/runtime.js'

const ROOT = new URL('..', import.meta.url).pathname
const CWD = join(tmpdir(), `memo-river-title-${process.pid}`)
const BUCKET = '标题闸门测试'
const TAGS = '标题闸门, 写入测试, 种子语料'
const REASON = '新测试桶首建：三个语料治理 Tag 均为首次引入'

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
const execStub = (cwd) => ({ agent: { session: { id: 'title-gate-acceptance', header: { cwd } } } })

/* ── 前置：自建自净 /tmp 工作区（嵌入离线：vcpRoot 指向不存在路径 → config.env 不存在 → 不可调用） ── */
const paths = workspacePaths(CWD, BUCKET)
rmSync(CWD, { recursive: true, force: true })
rmSync(paths.root, { recursive: true, force: true })
mkdirSync(CWD, { recursive: true })

hr(`票 02 标题闸门 · acceptance-title-gate（工作区 ${CWD}）`)
const config = ConfigSchema({ bucket: BUCKET, native: { vcpRoot: join(CWD, 'no-vcp') } })
const h = createMockCtx()
await apply(h.ctx, config)
const tool = (name) => h.registered.tools.find((t) => t.name === name)
const writeTool = tool('memo_write')
const updateTool = tool('memo_update')
if (!writeTool || !updateTool) {
  console.error('❌ 工具未注册：memo_write / memo_update')
  process.exit(2)
}
const ws = acquireWorkspace(CWD, config)
/* SIGBUS 闸适配（2026-09-29）：execute 返回≠native 收干——exec 内置 withDb 收干，后续裸 store 读安全。 */
const exec = async (t, args) => { const r = await t.execute(args, execStub(CWD)); await ws.withDb(async () => {}); return r }
const fileCount = () => ws.store.files(BUCKET).length
const chunkOf = (fileId) => ws.store.chunks(BUCKET).find((c) => c.file_id === fileId)
const headOf = (c) => (String(c?.content ?? '').split('\n')[0] ?? '')

try {
  /* ── T-1 拒绝：无 title 且正文无 `# ` 行 ── */
  const r1 = String(await exec(writeTool, {
    content: '正文第一行不是标题行，也没有显式 title 参数。\n\nTag: ' + TAGS,
    newTagReason: REASON,
  }))
  const t1 = r1.includes('❌ memo_write 被拒绝：missing-title') && r1.includes('未命名') && r1.includes('# ') && fileCount() === 0
  check('T-1', 'memo_write 无 title 且正文无 `# ` 行 → missing-title 拒绝 + 指引；不落库', t1, [
    `拒绝行：${r1.split('\n').find((l) => l.includes('missing-title')) ?? '(未找到)'}`,
    `指引含补标题路径：${r1.includes('`# 标题`') ? '✅' : '❌'}`,
    `库内篇数：${fileCount()}（应为 0）`,
  ])

  /* ── T-2 单 `# ` 标题行：标题正确且只拼一次 ── */
  const TITLE2 = '单标题行只拼一次'
  const r2 = String(await exec(writeTool, {
    content: `# ${TITLE2}\n\n标题行本身充当标题源，写盘全文不应再重复拼一次这一行。\n\nTag: ${TAGS}`,
    newTagReason: REASON,
  }))
  const f2 = ws.store.files(BUCKET).find((f) => f.path.includes('单标题行只拼一次'))
  const chunk2 = f2 ? chunkOf(f2.id) : null
  const occurrences = chunk2 ? String(chunk2.content).split('\n').filter((l) => l === `# ${TITLE2}`).length : 0
  const disk2 = f2 && existsSync(f2.path) ? readFileSync(f2.path, 'utf8') : ''
  const t2 = r2.includes('✅ 已写入') && r2.includes(`「${TITLE2}」`) && occurrences === 1 && disk2 === String(chunk2?.content ?? '')
  check('T-2', '单 `# ` 标题行：标题正确，库内与写盘全文标题行恰好一次', t2, [
    `写入报告：${(r2.match(/✅ 已写入[^\n]*/) ?? ['(无)'])[0]}`,
    `标题行出现次数：${occurrences}（旧缺陷=2，应为 1）`,
    `库内=写盘：${disk2 === String(chunk2?.content ?? '') ? '✅' : '❌'}（${f2?.path ?? '无路径'}）`,
  ])

  /* ── T-3 显式 title 参数（正文无 `# ` 行）→ 按显式标题写入，正文原样保留 ── */
  const TITLE3 = '显式标题参数直落'
  const BODY3 = '正文首行不是标题，但显式给了 title 参数，应当按显式标题写入。'
  const r3 = String(await exec(writeTool, { title: TITLE3, content: `${BODY3}\n\nTag: ${TAGS}` }))
  const f3 = ws.store.files(BUCKET).find((f) => f.path.includes('显式标题参数直落'))
  const chunk3 = f3 ? chunkOf(f3.id) : null
  const t3 = r3.includes('✅ 已写入') && headOf(chunk3) === `# ${TITLE3}` && String(chunk3?.content ?? '').includes(BODY3)
  check('T-3', '显式 title（正文无 `# ` 行）→ 按显式标题写入', t3, [
    `chunk 首行：${headOf(chunk3)}`,
    `正文保留：${String(chunk3?.content ?? '').includes(BODY3) ? '✅' : '❌'}`,
  ])

  /* ── T-4 memo_update 新正文无 `# ` 行 → 保留目标原标题 ── */
  const BODY4 = '改写后的正文没有标题行，应当保留改写目标的原标题，而不是降级成未命名。'
  const pathBefore = f2.path
  const r4 = String(await exec(updateTool, { id: f2.id, content: `${BODY4}\n\nTag: ${TAGS}` }))
  const chunk4 = chunkOf(f2.id)
  const f4 = ws.store.files(BUCKET).find((f) => f.id === f2.id)
  const t4 =
    r4.includes('✅ 已写入') && headOf(chunk4) === `# ${TITLE2}` &&
    String(chunk4?.content ?? '').includes(BODY4) && f4?.path === pathBefore
  check('T-4', 'memo_update 无标题派生源 → 保留目标原标题（fileId/路径不变）', t4, [
    `改写后 chunk 首行：${headOf(chunk4)}（应仍为 # ${TITLE2}）`,
    `新正文在库：${String(chunk4?.content ?? '').includes(BODY4) ? '✅' : '❌'}；路径不变：${f4?.path === pathBefore ? '✅' : `❌ ${f4?.path}`}`,
  ])

  /* ── T-5 改写「未命名」存量条目：先拒（残次原标题不算保底），补 `# 新标题` 后放行 ── */
  /* 存量残次品用库内直写铺底（闸门上线前它们就是这么落进来的——writeDiary 是真实写路径本身） */
  const legacyDir = join(ws.paths.root, 'dailynote', BUCKET)
  mkdirSync(legacyDir, { recursive: true })
  const legacyPath = join(legacyDir, '2026-09-15-legacy-未命名.md')
  const legacyText = `# 2026-09-15 未命名\n\n存量残次标题正文：内容合格，标题是旧兜底落下的占位符。\n\nTag: ${TAGS}`
  writeFileSync(legacyPath, legacyText + '\n', 'utf8')
  const tagId = ws.store.upsertTag('标题闸门', null)
  const legacy = ws.store.writeDiary({
    path: legacyPath, diaryName: BUCKET, checksum: 'legacy', mtime: Date.now(),
    size: Buffer.byteLength(legacyText, 'utf8'), content: legacyText, chunkVector: null, tagIds: [tagId],
  })
  const r5a = String(await exec(updateTool, {
    id: legacy.fileId,
    content: `修复尝试一：新正文仍然没有标题行，残次原标题不算保底，应当被拒。\n\nTag: ${TAGS}`,
  }))
  const rejected = r5a.includes('❌ memo_update 被拒绝：missing-title') && headOf(chunkOf(legacy.fileId)) === '# 2026-09-15 未命名'
  const TITLE5 = '存量条目修复后的新标题'
  const r5b = String(await exec(updateTool, {
    id: legacy.fileId,
    content: `# ${TITLE5}\n\n修复尝试二：新正文首行给了 # 新标题，应当放行并落新标题。\n\nTag: ${TAGS}`,
  }))
  const fixed = r5b.includes('✅ 已写入') && headOf(chunkOf(legacy.fileId)) === `# ${TITLE5}`
  check('T-5', '改写「未命名」存量：无标题源被拒（不续命）；补 `# 新标题` 放行', rejected && fixed, [
    `① 无标题行改写：${rejected ? '✅ missing-title 拒绝，原标题未被续写' : `❌ ${(r5a.match(/被拒绝：[^\n]*/) ?? [r5a.slice(0, 60)])[0]}`}`,
    `② 补「# 新标题」改写：${fixed ? '✅ 放行，新标题落库' : `❌ ${r5b.split('\n')[0]?.slice(0, 60)}`}`,
  ])

  /* ── 收尾：全库扫描无「未命名」占位标题（按残次品精确模式匹配——正文中合法出现「未命名」
        一词不算，见 docs/GUIDE-未命名存量修复.md） ── */
  const heads = ws.store.chunks(BUCKET).map((c) => String(c.content ?? '').split('\n')[0] ?? '')
  const untitled = heads.filter((h2) => /^# (\d{4}-\d{2}-\d{2} )?未命名$/.test(h2))
  check('T-6', '收尾扫描：本桶没有任何 chunk 标题行是「未命名」占位符', untitled.length === 0, [
    `chunk 数=${heads.length}；含「未命名」=${untitled.length}${untitled.length ? `（${untitled.join(' | ')}）` : ''}`,
  ])
} finally {
  ws.store.close?.()
  rmSync(CWD, { recursive: true, force: true })
  rmSync(paths.root, { recursive: true, force: true })
}

hr('结果')
const failed = results.filter((r) => !r.pass)
line(`${results.length - failed.length}/${results.length} PASS${failed.length ? `；FAIL：${failed.map((f) => f.id).join(', ')}` : ''}`)
process.exit(failed.length ? 1 : 0)
