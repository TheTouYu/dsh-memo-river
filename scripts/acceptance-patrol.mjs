#!/usr/bin/env node
/**
 * acceptance-patrol.mjs —— 票 10（recall-quality-0916）「语料质量巡检与自愈」的实测
 * （.scratch/recall-quality-0916/issues/10-quality-patrol.md）。
 *
 * 判据（票面三病例 + 红线）：
 *   P-1 hub 检出：枢纽 Tag 4/9（44% ≥ 1/3）→ 报告列出该 Tag 与全部 4 个 D-id，建议含 memo_merge/memo_update
 *   P-2 未命名存量：正文无 `# ` 行的存量篇 → 报告 ② 段列出，建议 memo_update 补标题
 *   P-3 近重复簇：3 篇同向量 + 1 篇正交孤立篇 → 簇恰好 = 3 篇，孤立篇不入簇
 *   P-4 只读红线：巡检前后文件 mtime/库内计数/磁盘清单零变化（不代批、不静默手术）
 *   P-5 空桶/干净桶：scanned=0 → 「三项全净」，不误报
 *   P-6 folder 真路由负例：不存在的桶名 → 返回 resolveBucket 的错误（列可用桶），不崩
 *
 * 用法：node scripts/acceptance-patrol.mjs（自建自净 /tmp 工作区；向量直接种进 store，嵌入离线）
 */
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, Config as ConfigSchema } from '../lib/index.js'
import { acquireWorkspace } from '../lib/workspace.js'
import { workspacePaths } from '../lib/runtime.js'
import { patrolBucket } from '../lib/patrol.js'

const CWD = join(tmpdir(), `memo-river-patrol-${process.pid}`)
const BUCKET = '巡检测试'
const SEED_DIR = join(CWD, 'seed')

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
const execStub = (cwd) => ({ agent: { session: { id: 'patrol-acceptance', header: { cwd } } } })

/* ── 前置：自建自净 /tmp 工作区（嵌入离线） ── */
const paths = workspacePaths(CWD, BUCKET)
rmSync(CWD, { recursive: true, force: true })
rmSync(paths.root, { recursive: true, force: true })
mkdirSync(SEED_DIR, { recursive: true })

hr(`票 10 质量巡检 · acceptance-patrol（工作区 ${CWD}）`)
const config = ConfigSchema({ bucket: BUCKET, native: { vcpRoot: join(CWD, 'no-vcp') } })
const h = createMockCtx()
await apply(h.ctx, config)
const patrolTool = h.registered.tools.find((t) => t.name === 'memo_patrol')
if (!patrolTool) {
  console.error('❌ 工具未注册：memo_patrol')
  process.exit(2)
}
const ws = acquireWorkspace(CWD, config)
const exec = (args) => patrolTool.execute(args, execStub(CWD))

/* ── 播种：9 篇 = 4 hub 犯 + 1 未命名存量 + 3 同向量簇 + 1 正交孤立 ── */
const dim = 8
const famVec = (base) => { const v = new Float32Array(dim); v[base] = 1; return v }
const seed = (slug, body, tagNames, vector) => {
  const path = join(SEED_DIR, `${slug}.md`)
  writeFileSync(path, body, 'utf8')
  const tagIds = tagNames.map((n) => ws.store.upsertTag(n))
  const st = statSync(path)
  return ws.store.writeDiary({
    path, diaryName: BUCKET, checksum: `ck-${slug}`, mtime: st.mtimeMs, size: st.size,
    content: body, chunkVector: vector, tagIds,
  })
}
const ids = {}
for (let i = 1; i <= 4; i++) ids[`H${i}`] = seed(`hub-${i}`, `# 枢纽犯${i}号\n\n正文 ${i}。\n\nTag: 枢纽犯, 独有垫${i}`, ['枢纽犯', `独有垫${i}`], famVec(2 + i - 1)).fileId
ids.U1 = seed('legacy-untitled', '这是没有标题行的存量残次品正文。\n\nTag: 未命名存量', ['未命名存量'], famVec(6)).fileId
for (let i = 1; i <= 3; i++) ids[`C${i}`] = seed(`dup-${i}`, `# 批次稿${i}号\n\n同一批次的复读文本 ${i}。`, [], famVec(0)).fileId
ids.O1 = seed('outlier', '# 孤立篇\n\n向量正交，不应入簇。\n\nTag: 孤立向量', ['孤立向量'], famVec(1)).fileId

try {
  /* ── 单次真入口巡检：三段全出 ── */
  const report = String(await exec({}))
  const direct = patrolBucket(ws.store, BUCKET, {})

  const t1 =
    report.includes('「枢纽犯」4/9（44.4%）') &&
    ['H1', 'H2', 'H3', 'H4'].every((k) => report.includes(`D${ids[k]}《`)) &&
    report.includes('memo_merge') && direct.findings.some((f) => f.kind === 'hub' && f.fileIds.length === 4)
  check('P-1', 'hub 检出：4/9 枢纽 Tag + 全部 D-id + 归一/换 Tag 建议', t1, [
    `报告行：${report.split('\n').find((l) => l.includes('枢纽犯')) ?? '(未找到)'}`,
    `结构化 findings：hub×${direct.findings.filter((f) => f.kind === 'hub').length}（fileIds=${direct.findings.find((f) => f.kind === 'hub')?.fileIds.join(',')}）`,
  ])

  const section2 = report.split('②')[1]?.split('③')[0] ?? ''
  const uLine = section2.split('\n').find((l) => l.includes(`D${ids.U1}`))
  const t2 = Boolean(uLine) && section2.includes('memo_update') && section2.includes('# 标题')
  check('P-2', '未命名存量检出：无 `# ` 行的篇列入 ② 段，建议 memo_update 补标题', t2, [
    `报告行：${uLine ?? '(未找到)'}`,
    `结构化：untitled×${direct.findings.filter((f) => f.kind === 'untitled').length}`,
  ])

  const dupSection = report.split('③')[1] ?? ''
  const inCluster = ['C1', 'C2', 'C3'].every((k) => dupSection.includes(`D${ids[k]}《`))
  const t3 = inCluster && !dupSection.includes(`D${ids.O1}`) && /3 篇/.test(dupSection) && report.includes('人在场判断')
  check('P-3', '近重复簇：3 篇同向量成簇，正交孤立篇不入簇，报告明示「需人在场判断」', t3, [
    `簇段：${dupSection.split('\n').find((l) => l.includes('3 篇')) ?? '(未找到)'}`,
    `孤立篇 D${ids.O1} 入簇：${dupSection.includes(`D${ids.O1}`) ? '❌ 误入' : '✅ 未入'}`,
  ])

  /* ── P-4 只读红线：再跑一次工具，前后零变化 ── */
  const before = {
    files: ws.store.counts(),
    mtimes: readdirSync(SEED_DIR).map((f) => `${f}:${statSync(join(SEED_DIR, f)).mtimeMs}`),
    rootEntries: readdirSync(paths.root).sort().join(','),
  }
  await exec({})
  const after = {
    files: ws.store.counts(),
    mtimes: readdirSync(SEED_DIR).map((f) => `${f}:${statSync(join(SEED_DIR, f)).mtimeMs}`),
    rootEntries: readdirSync(paths.root).sort().join(','),
  }
  const t4 = JSON.stringify(before) === JSON.stringify(after) && before.files.files === 9
  check('P-4', '只读红线：巡检前后库计数/文件 mtime/桶目录零变化', t4, [
    `counts：${JSON.stringify(before.files)} → ${JSON.stringify(after.files)}`,
    `seed mtime 变化：${before.mtimes.join(' | ') === after.mtimes.join(' | ') ? '无 ✅' : '有 ❌'}`,
    `桶根目录新增条目：${before.rootEntries === after.rootEntries ? '无 ✅' : `${before.rootEntries} → ${after.rootEntries}`}`,
  ])

  const clean = patrolBucket(ws.store, '空桶名', {})
  const t5 = clean.scanned === 0 && clean.text.includes('三项全净') && clean.findings.length === 0
  check('P-5', '空桶不误报：scanned=0 → 三项全净', t5, [`text 首两行：${clean.text.split('\n').slice(0, 2).join(' ⏎ ')}`])

  const r6 = String(await exec({ folder: '巡检不存在桶-xyz-123' }))
  const t6 = /不存在|可用/.test(r6) && !r6.includes('扫描')
  check('P-6', 'folder 真路由负例：不存在的桶 → 报错列可用桶，不崩', t6, [r6.split('\n')[0]])
} finally {
  rmSync(CWD, { recursive: true, force: true })
  rmSync(paths.root, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.pass)
hr(`结果：${results.length - failed.length}/${results.length} PASS`)
if (failed.length) {
  line('失败项：' + failed.map((f) => f.id).join(', '))
  process.exit(1)
}
process.exit(0)
