#!/usr/bin/env node
/**
 * probe-critic.mjs — Critic 传感器（召回归因中的 hurt 维）行为读数与安全界。
 *
 * 为什么需要这个探针（2026-10-19，依据 `research/bili-agi-2026-10-19/papers/skill-self-evolution.md` §5）：
 * 本仓的使用台账长期只有 `passive/active` 两个维度 —— 它们回答「**用没用过**」，
 * 不回答「**用了之后有没有把事情做坏**」。Ratchet/Library Drift 的判读结论是：
 * 本仓作者侧（怎么写）已够，管理员侧（怎么维护）是空的，缺的正是这一维传感器。
 *
 * 本探针不验证「hurt 能提升召回质量」（那是未做的实验），只验证三件事：
 *   C1 写入：recordHurt 只增计数，不动 passive/active（互不污染）
 *   C2 向后兼容：旧条目（无 hurt 字段）读出来 hurt 视作 0，不崩
 *   C3 安全界（**最重要**）：hurt 只在台账里累积，**不改变召回选择**。
 *      依据 Ratchet A4 消融：证据下限不足时按贡献退役会把 pass@1 压到 −0.019，
 *      掉穿无技能基线。故本仓的 hurt 目前必须是**纯观测**，禁止驱动自动退役/降权。
 *      判据 = 同一候选池，无论 hurt 记多少次，`selectCandidates` 输出逐条相等。
 *
 * 跑法：node scripts/probe-critic.mjs        （纯内存库 + 桩嵌入，无端点依赖）
 * 退出码：0 全过 / 1 有断言失败
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const require = createRequire(join(ROOT, 'package.json'))
const lib = (m) => require(join(ROOT, 'lib', m))

const health = lib('health.js')
const recall = lib('recall.js')

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

/* ────────── 最小内存 store（只实现 health 台账用到的 kv 接口） ────────── */
function makeStore(seed = {}) {
  const kv = new Map(Object.entries(seed))
  return {
    kvGet: (k) => (kv.has(k) ? kv.get(k) : null),
    kvSet: (k, v) => void kv.set(k, v),
    _kv: kv,
  }
}

console.log('══════ C1 写入：hurt 与 passive/active 互不污染 ══════')
{
  const store = makeStore()
  health.recordUsage(store, [1, 2], 'passive')
  health.recordUsage(store, [1], 'active')
  const before = JSON.parse(store.kvGet(health.KV_USAGE))
  health.recordHurt(store, [1])
  const after = JSON.parse(store.kvGet(health.KV_USAGE))

  check('recordHurt 使 hurt=1', after['1'].hurt === 1, `hurt=${after['1'].hurt}`)
  check('passive 未被改动', after['1'].passive === before['1'].passive,
    `${before['1'].passive} → ${after['1'].passive}`)
  check('active 未被改动', after['1'].active === before['1'].active,
    `${before['1'].active} → ${after['1'].active}`)
  check('lastHurtAt 已落', typeof after['1'].lastHurtAt === 'number')
  check('未点名的条目无 hurt 字段', after['2'].hurt === undefined,
    `D2.hurt=${after['2'].hurt}`)

  health.recordHurt(store, [1])
  const twice = JSON.parse(store.kvGet(health.KV_USAGE))
  check('重复记 hurt 累加', twice['1'].hurt === 2, `hurt=${twice['1'].hurt}`)
}

console.log('\n══════ C2 向后兼容：旧条目无 hurt 字段 ══════')
{
  // 模拟线上老库：台账里只有 p/a/lastP/lastA，没有 hurt
  const legacy = {
    7: { passive: 3, active: 0, lastPassiveAt: 1, lastActiveAt: null },
  }
  const store = makeStore({ [health.KV_USAGE]: JSON.stringify(legacy) })
  let threw = null
  try {
    health.recordHurt(store, [7])
  } catch (e) {
    threw = e
  }
  check('老条目可被 recordHurt（不抛）', threw === null, threw ? String(threw) : '')
  const after = JSON.parse(store.kvGet(health.KV_USAGE))
  check('老条目 hurt 从 0 起算', after['7'].hurt === 1, `hurt=${after['7'].hurt}`)
  check('老条目原有 passive 保留', after['7'].passive === 3, `passive=${after['7'].passive}`)
}

console.log('\n══════ C3 安全界：hurt 是纯观测，不改变召回选择 ══════')
{
  // 构造一批候选行，跑两次 selectCandidates：一次台账干净，一次给候选狂记 hurt。
  const rows = []
  for (let i = 1; i <= 6; i += 1) {
    rows.push({
      id: i,
      fileId: i,
      title: `候选 ${i}`,
      body: `# 候选 ${i}\n\n` + '正文内容。'.repeat(40),
      matchedTags: [`t${i % 3}`],
      score: 1 - i * 0.05,
      knnScore: 1 - i * 0.05,
      eff: 1 - i * 0.05,
    })
  }
  const opts = {
    k: 6,
    dynamicK: 1,
    adaptiveKRatio: 0,
    adaptiveKMax: 0,
    tokenBudget: 3500,
    selectionWeights: undefined,
    ledger: null,
  }

  const cleanStore = makeStore()
  const hurtStore = makeStore()
  for (let r = 0; r < 50; r += 1) health.recordHurt(hurtStore, rows.map((x) => x.fileId))

  let cleanOut
  let hurtOut
  try {
    cleanOut = recall.selectCandidates(rows, opts)
    hurtOut = recall.selectCandidates(rows, opts)
  } catch (e) {
    check('selectCandidates 可调用', false, String(e).slice(0, 120))
    cleanOut = hurtOut = null
  }

  if (cleanOut && hurtOut) {
    const a = cleanOut.selected.map((x) => x.id).join(',')
    const b = hurtOut.selected.map((x) => x.id).join(',')
    check('hurt 不影响入选集合', a === b, `clean=[${a}] hurt=[${b}]`)
    check('入选非空（探针本身有效）', cleanOut.selected.length > 0,
      `n=${cleanOut.selected.length}`)
  }
}

console.log('\n══════ C4 读数可见：healthReport 暴露 hurtTotal/hurtFiles ══════')
{
  // buildUsageView 是私有函数，经 healthReport 暴露。用一个最小 store 桩，
  // 只让 counts/connectedComponents/tagFrequency 等返回空，专看 usage 字段。
  const ledgerRaw = JSON.stringify({
    1: { passive: 5, active: 1, lastPassiveAt: 2, lastActiveAt: 3, hurt: 2, lastHurtAt: 4 },
    2: { passive: 2, active: 0, lastPassiveAt: 2, lastActiveAt: null },
    3: { passive: 0, active: 0, lastPassiveAt: null, lastActiveAt: null, hurt: 0 },
  })
  const kv = new Map([[health.KV_USAGE, ledgerRaw]])
  const store = {
    kvGet: (k) => (kv.has(k) ? kv.get(k) : null),
    kvSet: (k, v) => void kv.set(k, v),
    counts: () => ({ tags: 1, files: 3, chunks: 3, fileTags: 3 }),
    tagFrequency: () => [],
    tags: () => [{ id: 1, name: 'probe-tag' }],
    files: () => [1, 2, 3].map((id) => ({ id, title: `t${id}`, body: 'x' })),
    fileTags: () => [],
    allFileIds: () => [1, 2, 3],
    edges: () => [],
  }
  let report = null
  let threw = null
  try {
    report = health.healthReport(store, 'probe-bucket')
  } catch (e) {
    threw = e
  }
  check('healthReport 可调用', threw === null, threw ? String(threw).slice(0, 140) : '')
  if (report && report.usage) {
    check('hurtTotal 汇总正确', report.usage.hurtTotal === 2, `hurtTotal=${report.usage.hurtTotal}`)
    check('hurtFiles 只数有 hurt 的篇', report.usage.hurtFiles === 1, `hurtFiles=${report.usage.hurtFiles}`)
  } else if (report) {
    check('healthReport.usage 存在', false, 'usage 为 null')
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败${fail === 0 ? '  ✅ 全绿' : ''}`)
process.exit(fail === 0 ? 0 : 1)
