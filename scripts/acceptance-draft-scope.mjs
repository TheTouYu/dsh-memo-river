#!/usr/bin/env node
/**
 * acceptance-draft-scope.mjs —— 票 13「草稿队列破坏性操作的作用域收紧」实测。
 *
 * 事故样本（2026-09-16）：memo_discard {all:true} 未带 bucket，旧语义「缺省全部桶」
 * 一次扫 66 篇（含 48 篇未复核的其他工作区草稿）。
 *
 * 四条判据（DSH_HOME 隔离双桶，伪造 pending 草稿，走真实 memo_discard 入口）：
 *   T-1 all=true 无 bucket → 只作用本桶；他桶原封不动
 *   T-2 ids 指向他桶文件名 → 未命中报错 + 跨桶提示；不误伤
 *   T-3 bucket=不存在 → 明确报错并列出有待处理草稿的桶
 *   T-4 all=true + 显式 bucket=他桶 → 跨桶生效且输出带 ⚠️ 跨桶警告行
 *
 * 用法：node scripts/acceptance-draft-scope.mjs（自建自净 /tmp 工作区）
 */
process.env.DSH_HOME = `/tmp/dsh-draft-scope-${process.pid}`
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, Config as ConfigSchema } from '../lib/index.js'
import { workspacePaths } from '../lib/runtime.js'

const A_CWD = join(tmpdir(), `mr-ds-A-${process.pid}`)
const B_CWD = join(tmpdir(), `mr-ds-B-${process.pid}`)
const BUCKET_A = '桶甲测试'
const BUCKET_B = '桶乙测试'
const results = []
const line = (s = '') => console.log(s)
const hr = (t) => line('\n' + '═'.repeat(96) + (t ? `\n${t}` : '') + '\n' + '═'.repeat(96))
function check(id, title, pass, evidence) {
  results.push({ id, title, pass })
  line(`\n【验收 ${id}】${title}  →  ${pass ? '✅ PASS' : '❌ FAIL'}`)
  for (const e of [].concat(evidence)) line(`    ${e}`)
}

function createMockCtx() {
  const registered = { tools: [] }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on: () => () => {},
    effect: (cb) => { cb(); return () => {} },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    tools: { register(t) { registered.tools.push(t); return () => {} } },
    get: () => undefined,
    interval(fn) { const h = setInterval(fn, 3_600_000); h.unref?.(); return () => clearInterval(h) },
  }
  return { ctx, registered }
}

function draft(name, bucket) {
  return `# 候选草稿（等确认，未入库）

- 会话：session-draft-scope-test
- 回合：3 @ 2026-09-16T10:00:00.000Z
- 桶：${bucket}

## 本轮用户
作用域测试用户文本

## 本轮助手
作用域测试助手文本

## 建议 Tag（来自本轮被动召回的 matchedTags，须经 memo_tags 复核后复用）
测试Tag甲, 测试Tag乙, 测试Tag丙

## 相关旧日记
(无)
`
}

/* ── 前置：双桶自净 ── */
for (const c of [A_CWD, B_CWD]) {
  rmSync(workspacePaths(c).root, { recursive: true, force: true })
  rmSync(c, { recursive: true, force: true })
  mkdirSync(c, { recursive: true })
}
const rootA = workspacePaths(A_CWD).root
const rootB = workspacePaths(B_CWD).root
mkdirSync(join(rootA, 'pending'), { recursive: true })
mkdirSync(join(rootB, 'pending'), { recursive: true })
writeFileSync(join(rootA, 'pending', '2026-09-16T10-01-候选甲一.md'), draft('甲一', BUCKET_A))
writeFileSync(join(rootA, 'pending', '2026-09-16T10-02-候选甲二.md'), draft('甲二', BUCKET_A))
writeFileSync(join(rootB, 'pending', '2026-09-16T10-03-候选乙一.md'), draft('乙一', BUCKET_B))
writeFileSync(join(rootB, 'pending', '2026-09-16T10-04-候选乙二.md'), draft('乙二', BUCKET_B))
const pendingCount = (root) => readdirSync(join(root, 'pending')).filter((f) => f.endsWith('.md')).length

hr(`票 13 草稿作用域 · acceptance-draft-scope（A=${BUCKET_A} B=${BUCKET_B}）`)
const h = createMockCtx()
await apply(h.ctx, ConfigSchema({ bucket: BUCKET_A, native: { vcpRoot: join(A_CWD, 'no-vcp') } }))
const discard = h.registered.tools.find((t) => t.name === 'memo_discard')
if (!discard) { console.error('❌ memo_discard 未注册'); process.exit(2) }
const exec = (args) => discard.execute(args, { agent: { session: { id: 'draft-scope-acc', header: { cwd: A_CWD } } } })

{
  /* T-1 顺序前置：ids 跨桶未命中（此时 A/B 都有货） */
  const r2 = String(await exec({ ids: ['候选乙一'] }))
  const t2 = r2.includes('❌') && r2.includes('跨桶操作须显式传 bucket') && pendingCount(rootB) === 2
  check('T-2', 'ids 指向他桶文件名 → 未命中报错+跨桶提示，不误伤', t2, [
    `错误行：${(r2.match(/❌[^\n]*/) ?? ['(无)'])[0].slice(0, 90)}`,
    `桶乙 pending：${pendingCount(rootB)}（应 2）`,
  ])

  /* T-3 不存在的桶 → 报错+列出有待处理草稿的桶 */
  const r4 = String(await exec({ all: true, bucket: '不存在的桶' }))
  const t4 = r4.includes('❌') && r4.includes('没有待处理草稿') && r4.includes(BUCKET_B)
  check('T-3', 'bucket=不存在 → 明确报错并列出有待处理草稿的桶', t4, [
    `错误行：${(r4.match(/❌[^\n]*/) ?? ['(无)'])[0].slice(0, 90)}`,
  ])

  /* T-1 all=true 无 bucket → 只清本桶 */
  const r1 = String(await exec({ all: true }))
  const t1 = r1.includes('待处理 2 篇') && !r1.includes('跨桶') && pendingCount(rootA) === 0 && pendingCount(rootB) === 2
  check('T-1', 'all=true 无 bucket → 只作用本桶；他桶原封不动', t1, [
    `首行：${r1.split('\n')[0]}`,
    `桶甲 pending：${pendingCount(rootA)}（应 0）；桶乙 pending：${pendingCount(rootB)}（应 2）`,
    `rejected 追溯：${readdirSync(join(rootA, 'rejected')).length} 篇（应 2）`,
  ])

  /* T-4 显式跨桶 → 生效 + ⚠️ 警告行 */
  const r3 = String(await exec({ all: true, bucket: BUCKET_B }))
  const t3 = r3.includes('待处理 2 篇') && r3.includes('⚠️ 跨桶操作') && pendingCount(rootB) === 0
  check('T-4', 'all=true + 显式 bucket=他桶 → 跨桶生效且带警告行', t3, [
    `首行：${r3.split('\n')[0]}`,
    `桶乙 pending：${pendingCount(rootB)}（应 0）`,
  ])
}

rmSync(rootA, { recursive: true, force: true })
rmSync(rootB, { recursive: true, force: true })
rmSync(A_CWD, { recursive: true, force: true })
rmSync(B_CWD, { recursive: true, force: true })

hr('结果')
const pass = results.filter((r) => r.pass).length
line(`${pass}/${results.length} PASS`)
process.exit(pass === results.length ? 0 : 1)
