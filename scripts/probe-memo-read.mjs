#!/usr/bin/env node
/**
 * probe-memo-read.mjs — `memo_read`（按 D 号读全文）的行为读数。
 *
 * 为什么需要这个探针（2026-10-19，`research/bili-agi-2026-10-19/notes/UPGRADE-PLAN.md` P1）：
 * 注入块与 `memo_recall` 只给「D 号 + 标题 + 摘要」，而 13 个 `memo_*` 工具里唯一接收 `id`
 * 参数的是 `memo_update` —— **写路径**。模型拿到 D 号后唯一能按号寻址的动作是「改写它」，
 * 想读全文只能重写 query 再赌一次召回（Headroom 的 CCR 第三段 retrieve 在我们实现里缺失）。
 *
 * 本探针**直接调真实工具**（createMockCtx + apply 注册，与 acceptance 同法），验四条底线：
 *   R1 按 chunk id（展示口径）取回**完整正文**，不是摘要、不是截断
 *   R2 按 fileId（历史兜底口径）同样能定位
 *   R3 不存在的 D 号**明确报错**，不静默返回空（静默空 = 模型误以为桶里没有）
 *   R4 只读：调用前后语料字节数、篇数不变
 *
 * 隔离：`import './isolated-env.mjs'` 是第一条 import —— 绝不在生产柜子里留空壳桶。
 * 嵌入：直接用 store 写最小行，**不触发嵌入**，故无端点依赖。
 *
 * 跑法：node scripts/probe-memo-read.mjs
 * 退出码：0 全过 / 1 有断言失败
 */
import './isolated-env.mjs'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config as ConfigSchema } from '../lib/index.js'

const WS = mkdtempSync(join(tmpdir(), 'probe-memo-read-'))
const BUCKET = '探针桶-memo-read'
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
const execStub = (cwd) => ({ agent: { session: { id: 'probe-memo-read', header: { cwd } } } })

const h = createMockCtx()
await apply(h.ctx, config)
const tool = (name) => h.registered.tools.find((t) => t.name === name)
const readTool = tool('memo_read')
check('memo_read 已注册', !!readTool, readTool ? '' : '未找到')
if (!readTool) {
  
console.log('\n══════ R5 记账：按号回读记一次 active（最强使用信号） ══════')
{
  const { readUsageLedger } = await import('../lib/health.js')
  const before = await ws.withDb(async () => readUsageLedger(ws.store).get(fileA)?.active ?? 0)
  await readTool.execute({ id: idA }, execStub(WS))
  const after = await ws.withDb(async () => readUsageLedger(ws.store).get(fileA)?.active ?? 0)
  check('read 一次 → active +1', after === before + 1, `${before} → ${after}`)
  await readTool.execute({ id: idA }, execStub(WS))
  const after2 = await ws.withDb(async () => readUsageLedger(ws.store).get(fileA)?.active ?? 0)
  check('再读一次 → 再 +1（累加）', after2 === after + 1, `${after} → ${after2}`)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(1)
}

const BODY_A = [
  '# 探针甲：记账口径必须等于渲染口径',
  '',
  '结论先行：全文记账 224,437 tok vs 实际渲染 119,841 tok = 1.87 倍。',
  '',
  '因果链：两条路径各写了一遍长度语义，各自独立演化。',
  '',
  'Tag: 证据分级, 归因纠偏',
].join('\n')

const BODY_B = [
  '# 探针乙：另一篇无关日记',
  '',
  '正文乙，用来验证按 id 取到的是正确的那一篇。',
  '',
  'Tag: 召回实效',
].join('\n')

/* ── 准备：直接用 workspace store 写两篇最小语料（不经嵌入，无端点依赖） ── */
const { acquireWorkspace } = await import('../lib/workspace.js')
const ws = acquireWorkspace(WS, config)
await ws.ensureLoaded()

let idA = 0
let idB = 0
let fileA = 0
await ws.withDb(async () => {
  const store = ws.store
  for (const [body, slot] of [[BODY_A, 'a'], [BODY_B, 'b']]) {
    /* writeDiary 是 store 唯一的整篇写入入口；chunkVector=null 表示不落向量
       （本探针只验读路径，不需要嵌入，也就没有端点依赖）。 */
    const { fileId, chunkId } = store.writeDiary({
      path: join(WS, `probe-${slot}.md`),
      diaryName: BUCKET,
      checksum: `sum-${slot}`,
      mtime: Date.now(),
      size: body.length,
      content: body,
      chunkVector: null,
      tagIds: [],
    })
    if (slot === 'a') {
      idA = chunkId
      fileA = fileId
    } else {
      idB = chunkId
    }
  }
})
check('两篇已写入', idA > 0 && idB > 0, `D${idA} / D${idB}`)

const before = await ws.withDb(async () => ({ files: ws.store.files().length, chunks: ws.store.chunks().length }))

console.log('\n══════ R1 展示口径：按 chunk id 取回完整正文 ══════')
{
  const out = String(await readTool.execute({ id: idA }, execStub(WS)))
  check('命中并回报 D 号', out.includes(`D${idA}`), `D${idA}`)
  check('取回的是甲篇不是乙篇', out.includes('记账口径') && !out.includes('正文乙'), '')
  check('正文完整（含 Tag 行）', out.includes('Tag: 证据分级'), '')
  check('正文未被截断', out.includes('1.87 倍') && out.includes('各自独立演化'), '')
  check('带字数元信息', /字数=\d+/.test(out), (out.match(/字数=\d+/) ?? [''])[0])
}

console.log('\n══════ R2 兜底口径：fileId 也能定位 ══════')
{
  const out = String(await readTool.execute({ id: fileA }, execStub(WS)))
  check('按 fileId 也能取到同一篇', out.includes('记账口径'), `fileId=${fileA}`)
}

console.log('\n══════ R3 不存在的 D 号：明确报错，不静默空 ══════')
{
  const out = String(await readTool.execute({ id: 999999 }, execStub(WS)))
  check('明确报「没有 D999999」', out.includes('没有 D999999'), '')
  check('不是空串', out.trim().length > 0, `len=${out.length}`)
  check('给出下一步指引', out.includes('memo_recall') || out.includes('memo_stats'), '')
}

console.log('\n══════ R4 只读：调用前后语料不变 ══════')
{
  const after = await ws.withDb(async () => ({ files: ws.store.files().length, chunks: ws.store.chunks().length }))
  check('篇数不变', before.files === after.files, `${before.files} → ${after.files}`)
  check('chunk 数不变', before.chunks === after.chunks, `${before.chunks} → ${after.chunks}`)
}

console.log('\n══════ R5 记账：按号回读记一次 active（最强使用信号） ══════')
{
  const { readUsageLedger } = await import('../lib/health.js')
  const beforeActive = await ws.withDb(async () => readUsageLedger(ws.store).get(fileA)?.active ?? 0)
  await readTool.execute({ id: idA }, execStub(WS))
  const afterActive = await ws.withDb(async () => readUsageLedger(ws.store).get(fileA)?.active ?? 0)
  check('read 一次 → active +1', afterActive === beforeActive + 1, `${beforeActive} → ${afterActive}`)
  await readTool.execute({ id: idA }, execStub(WS))
  const after2 = await ws.withDb(async () => readUsageLedger(ws.store).get(fileA)?.active ?? 0)
  check('再读一次 → 再 +1（累加）', after2 === afterActive + 1, `${afterActive} → ${after2}`)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败${fail === 0 ? '  ✅ 全绿' : ''}`)
process.exit(fail === 0 ? 0 : 1)
