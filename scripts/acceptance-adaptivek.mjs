#!/usr/bin/env node
/**
 * acceptance-adaptivek.mjs — 票 03（recall-quality-0916）：注入 k 自适应。
 *
 * 病灶（genshin-ts 桶 c9f838ba 深评）：一夜 26 子代理写 25 篇（桶 2→27），被动注入固定
 * k=3 → 26 候选 dropped 24/26≈92%——「河流越肥、注入越瞎」。
 *
 * 验收线（票内 5 条）：
 *   ① 膨胀桶模拟（≥20 候选）：dropped 率 <50%；
 *   ② 稀疏桶（<5 候选）与现状逐位一致；
 *   ③ 总预算不突破（重算 cost ≤ tokenBudget）+ 选择阶段时延劣化可忽略（纯内存）；
 *   ④ 回归主套件（本套件之外，另跑 scripts/acceptance.mjs ≥36 全绿）；
 *   ⑤ 定标依据写在 config.ts adaptiveKRatio/adaptiveKMax 注释（本套件只验数值落地）。
 *
 * 用法：node scripts/acceptance-adaptivek.mjs（自建自净 /tmp 桶；嵌入桩 = sha256 伪正交向量，
 * 与 #36 同款——写侧与召回共用同一 embed 实例，直调 ws.recall 免真实端点）。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, Config as ConfigSchema } from '../lib/index.js'
import { acquireWorkspace } from '../lib/workspace.js'
import { estimateTokens, workspacePaths } from '../lib/runtime.js'
import { ADAPTIVE_K_POOL_FLOOR } from '../lib/recall.js'

const VCP = '/home/h/app/VCPToolBox'
const results = []
const line = (s = '') => console.log(s)
const hr = (t) => line('\n' + '═'.repeat(88) + `\n${t}\n` + '═'.repeat(88))
function check(id, title, pass, evidence) {
  results.push({ id, title, pass })
  line(`\n【票03-验收 #${id}】${title}  →  ${pass ? '✅ PASS' : '❌ FAIL'}`)
  for (const e of [].concat(evidence)) line(`    ${e}`)
}

/* ── 最小 Cordis / Agent 替身（与 acceptance.mjs 同款，只 mock 宿主不 mock 被测逻辑）── */
function createMockCtx() {
  const listeners = new Map()
  const registered = { sections: [], contexts: [], tools: [] }
  const disposers = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(event, fn, opts) {
      const list = listeners.get(event) ?? []
      const entry = { fn, opts }
      if (opts?.prepend) list.unshift(entry)
      else list.push(entry)
      listeners.set(event, list)
      return () => {
        const i = list.indexOf(entry)
        if (i >= 0) list.splice(i, 1)
      }
    },
    effect(cb) {
      disposers.push(cb())
      return () => {
        try {
          disposers.forEach((d) => d?.())
        } catch {
          /* 静默 */
        }
      }
    },
    systemPrompt: {
      section(s) {
        registered.sections.push(s)
        return () => {}
      },
      context(c) {
        registered.contexts.push(c)
        return () => {}
      },
    },
    tools: {
      register(t) {
        registered.tools.push(t)
        return () => {}
      },
    },
    get() {
      return undefined
    },
    interval() {
      return () => {}
    },
  }
  return { ctx, listeners, registered, dispose: () => disposers.forEach((d) => { try { d?.() } catch { /* 静默 */ } }) }
}
const textMsg = (role, text) => ({ role, content: [{ type: 'text', text }], source: { kind: role === 'user' ? 'user' : 'model' } })
function createAgent(sessionId, cwd, priorLog = []) {
  const log = [...priorLog]
  return { session: { id: sessionId, header: { cwd }, deriveMessages: () => log }, log }
}
const makeConfig = (overrides = {}) => ConfigSchema({ bucket: '', native: { vcpRoot: VCP }, ...overrides })

/* ── 测试桶：自建自净 ── */
const AK_CWD = join(tmpdir(), `memo-river-ak-${process.pid}`)
const akPaths = workspacePaths(AK_CWD, '自适应K测试')
rmSync(AK_CWD, { recursive: true, force: true })
rmSync(akPaths.root, { recursive: true, force: true })
mkdirSync(AK_CWD, { recursive: true })

const config = makeConfig({ bucket: '自适应K测试' })
const h = createMockCtx()
apply(h.ctx, config)
const ws = acquireWorkspace(AK_CWD, config)

/* 嵌入桩（#36 同款）：sha256 → 伪正交向量；写侧与召回共用同一实例 */
const dim = ws.resolved.dimension
const hashVec = (text) => {
  const dg = createHash('sha256').update(text).digest()
  const v = new Float32Array(dim)
  for (let i = 0; i < dg.length; i++) v[i] = dg[i] / 127.5 - 1
  return v
}
ws.embed.embed = async (texts) => texts.map(hashVec)
Object.defineProperty(ws.embed, 'configured', { get: () => true, configurable: true })

const writeTool = h.registered.tools.find((t) => (t.name ?? t.definition?.name) === 'memo_write')
const wExec = writeTool.execute.bind(writeTool)
const wCtx = { agent: createAgent('sess-ak-w', AK_CWD, []) }

/** 写一篇短日记（每篇 3 个全新 Tag + 理由：Tag 频次全 1/27，不触发 hub 闸门；正文两句，截断路径有首句可保）。 */
let seq = 0
let firstWriteOut = ''
const writeDiary = async () => {
  seq += 1
  const n = String(seq).padStart(2, '0')
  const out = await wExec(
    {
      content:
        `# 膨胀样本${n}：渲染批次${n}\n\n` +
        `结论：第 ${n} 批的卡顿来自阴影贴图档位过高，降到 1024 后帧率恢复。` +
        `后续要盯顶点数指标与合批策略。\n\nTag: 膨胀${n}, 批次${n}, 样本${n}`,
      newTagReason: `膨胀桶样本 ${n}，三个 Tag 均为本篇专属主题词`,
    },
    wCtx,
  )
  if (seq === 1) firstWriteOut = String(out).replace(/\n/g, ' ⏎ ').slice(0, 200)
  return String(out).includes('已写入')
}

/** 直调召回（镜像 injector.recallOptions 的传参形状；gate 关——桩向量无门控判别力，#36 同口径）。 */
const recallWith = async (qid, extra = {}) =>
  ws.recall('渲染又卡了，上一批是怎么解决的', {
    mode: 'topology_v3',
    k: 3,
    tokenBudget: 1e9,
    dynamicK: 1,
    gate: false,
    gateThreshold: 0.55,
    minKnnForReward: 0.6,
    queryId: qid,
    adaptiveKRatio: 0.6,
    adaptiveKMax: 16,
    ...extra,
  })

/* ═══════════ 验收 ⑤：配置缺省值与定标落地 ═══════════ */
hr('票03-⑤ 配置缺省：ratio=0.6 / kMax=16（c9f838ba 定标），0 可关')
{
  const defaults = ConfigSchema({ native: { vcpRoot: VCP } }).inject
  const off = ConfigSchema({ native: { vcpRoot: VCP }, inject: { adaptiveKRatio: 0 } }).inject
  check(
    51,
    '配置缺省 adaptiveKRatio=0.6 / adaptiveKMax=16；显式 0 可关（回滚开关）',
    defaults.adaptiveKRatio === 0.6 && defaults.adaptiveKMax === 16 && off.adaptiveKRatio === 0,
    [
      `defaults：adaptiveKRatio=${defaults.adaptiveKRatio}（要求 0.6） adaptiveKMax=${defaults.adaptiveKMax}（要求 16）`,
      `回滚：inject.adaptiveKRatio=0 → ${off.adaptiveKRatio}（要求 0）`,
      `定标注释位置：src/config.ts InjectConfig.adaptiveKRatio（26 候选 dropped 24/26 → ratio=0.5 恰 50% 不过线 → 0.6）`,
    ],
  )
}

/* ═══════════ 验收 ②：稀疏桶（<5 候选）与现状逐位一致 ═══════════ */
hr(`票03-② 稀疏桶：池 < ${ADAPTIVE_K_POOL_FLOOR} 时自适应参数不改变选集`)
{
  let ok3 = true
  for (let i = 0; i < 3; i++) ok3 = (await writeDiary()) && ok3
  const sparseOn = await recallWith('ak-sparse-on')
  const sparseOff = await recallWith('ak-sparse-off', { adaptiveKRatio: 0 })
  const idsOn = sparseOn.selected.map((c) => c.id)
  const idsOff = sparseOff.selected.map((c) => c.id)
  const sameIds = JSON.stringify(idsOn) === JSON.stringify(idsOff)
  const capped = sparseOn.selected.length <= 3 && sparseOn.diagnostics.kEff === 3
  /* #31 口径：显式 k=1、池=3 → 恰 1 条（旧行为；若无池地板会被抬到 ceil(3×0.6)=2） */
  const one = await recallWith('ak-sparse-k1', { k: 1 })
  const oneOk = one.selected.length === 1 && one.diagnostics.kEff === 1
  check(
    52,
    `稀疏桶（池=${sparseOn.candidateCount}<${ADAPTIVE_K_POOL_FLOOR}）：自适应开/关选集逐位一致；k=1 仍恰 1 条`,
    ok3 && sameIds && capped && oneOk,
    [
      `首写回报：${firstWriteOut}`,
      `开/关选集：[${idsOn.join(',')}] vs [${idsOff.join(',')}] → ${sameIds ? '一致' : '❌ 不一致'}`,
      `k=3：selected=${sparseOn.selected.length} kEff=${sparseOn.diagnostics.kEff}（要求 ≤3 / =3）`,
      `k=1（#31 口径）：selected=${one.selected.length} kEff=${one.diagnostics.kEff}（要求 1/1——池地板护住显式小 k）`,
    ],
  )
}

/* ═══════════ 验收 ①：膨胀桶（≥20 候选）dropped 率 <50% + kMax 钳位 ═══════════ */
hr('票03-① 膨胀桶：27 篇（复刻 c9f838ba 2→27）→ k 自适应，dropped 率 <50%')
{
  let okW = true
  while (seq < 27) okW = (await writeDiary()) && okW
  const on = await recallWith('ak-bloat-on')
  const pool = on.candidateCount
  const expectedK = Math.max(3, Math.min(Math.ceil((pool * 0.6)), 16))
  const droppedRate = on.dropped.length / pool
  const kLimit = on.dropped.filter((d) => d.reason === 'k-limit').length
  const ratioOk = pool >= 20
  const kEffOk = on.diagnostics.kEff === expectedK && on.selected.length === Math.min(expectedK, pool)
  const rateOk = droppedRate < 0.5
  const clampOk = pool >= 27 ? expectedK === 16 && on.selected.length === 16 : true

  /* 回滚开关：ratio=0 → 固定 k=3（旧行为），dropped 率回到 88.9% 量级 */
  const off = await recallWith('ak-bloat-off', { adaptiveKRatio: 0 })
  const rollbackOk = off.selected.length === 3 && off.diagnostics.kEff === 3
  /* kMax 机械钳位：池 23 → ceil(23×0.6)=14，kMax=8 → kEff=8（不靠大池也能证明钳位生效） */
  const clampProbe = await recallWith('ak-clamp', { adaptiveKMax: 8 })
  const clampMech =
    clampProbe.diagnostics.kEff === Math.min(Math.ceil(pool * 0.6), 8) && clampProbe.selected.length === Math.min(Math.ceil(pool * 0.6), 8)

  check(
    53,
    `膨胀桶（池=${pool}）：kEff=${expectedK}（=clamp(ceil(池×0.6),3,16)）；dropped 率 ${(droppedRate * 100).toFixed(1)}% <50%；kMax 钳位生效`,
    okW && ratioOk && kEffOk && rateOk && clampOk && clampMech && rollbackOk,
    [
      `池=${pool}（要求 ≥20，复刻 27 篇场景）；kEff=${on.diagnostics.kEff} selected=${on.selected.length}（要求 =${expectedK}）`,
      `dropped=${on.dropped.length}/${pool} = ${(droppedRate * 100).toFixed(1)}%（要求 <50%；固定 k=3 时为 ${(((pool - 3) / pool) * 100).toFixed(1)}%）`,
      `k-limit 明细=${kLimit} 条；pool≥27 → kEff=16（vacuous=${pool < 27}）`,
      `钳位探针：adaptiveKMax=8 → kEff=${clampProbe.diagnostics.kEff} selected=${clampProbe.selected.length}（${clampMech ? '✅' : '❌'}）`,
      `回滚对照：adaptiveKRatio=0 → selected=${off.selected.length} kEff=${off.diagnostics.kEff} dropped=${((off.dropped.length / pool) * 100).toFixed(1)}%（${rollbackOk ? '✅ 旧行为' : '❌'}）`,
    ],
  )

  /* ═══════════ 验收 ③a：预算绝不突破 + ③b：时延劣化可忽略 ═══════════ */
  const budget = 600
  const budged = await recallWith('ak-budget', { tokenBudget: budget })
  const recomputed = budged.selected.reduce((sum, c) => sum + estimateTokens(c.body) + estimateTokens(c.title) + 24, 0)
  const budgetOk = recomputed <= budget && budged.selected.length >= 4
  const truncEvidence = budged.dropped.filter((d) => d.reason === 'truncated-to-first-sentence').length
  /* 时延：同一桶同一查询，自适应开 vs 关（选择阶段差异 = O(1) 纯内存算术；150ms = 噪声地板） */
  const t1 = Date.now()
  await recallWith('ak-lat-on')
  const tOn = Date.now() - t1
  const t2 = Date.now()
  await recallWith('ak-lat-off', { adaptiveKRatio: 0 })
  const tOff = Date.now() - t2
  const latencyOk = Math.abs(tOn - tOff) < 150
  check(
    54,
    `预算不突破：tokenBudget=${budget} 下重算 cost=${recomputed} ≤ ${budget}；时延劣化 |${tOn}-${tOff}|=${Math.abs(tOn - tOff)}ms 可忽略`,
    budgetOk && latencyOk,
    [
      `selected=${budged.selected.length} 条（要求 ≥4：自适应扩条 + 截断共存）；截断保首句=${truncEvidence} 条`,
      `重算 cost（estimateTokens(body)+title+24 求和）=${recomputed} ≤ ${budget}=${budgetOk ? '✅' : '❌'}`,
      `时延：自适应开 ${tOn}ms vs 关 ${tOff}ms（差 ${Math.abs(tOn - tOff)}ms，阈值 150ms）`,
    ],
  )
}

/* ═══════════ 汇总 ═══════════ */
ws.store.close?.()
h.dispose()
rmSync(AK_CWD, { recursive: true, force: true })
rmSync(akPaths.root, { recursive: true, force: true })
hr('验收汇总')
const pass = results.filter((r) => r.pass).length
for (const r of results.sort((a, b) => a.id - b.id)) line(`  #${String(r.id).padStart(2)} ${r.pass ? '✅' : '❌'}  ${r.title}`)
line(`\n  通过 ${pass}/${results.length}`)
line(`  ④ 回归（主套件 ≥36 全绿）另跑：node scripts/acceptance.mjs`)
process.exit(pass === results.length ? 0 : 1)
