#!/usr/bin/env node
/**
 * acceptance-selection-weights.mjs — 票 04（recall-quality-0916）：选择循环有界权重。
 *
 * 病灶（genshin-ts 桶 c9f838ba 深评 docs/EVAL-单会话深评-genshin-ts-c9f838ba.md）：
 *   · D1×36 —— 09-11 旧日记一夜被被动注入 36/37 次（同域旧条目泛化搭车，固定排序永远在席）；
 *   · 桶一夜 2→27，新写 25 篇全程陪跑（新鲜进展不占席）；
 *   · hub「千星官方课程」21/26=80.8%（同 Tag 克隆分数挤成近似并列）。
 *
 * 验收线（票 04）：
 *   ① 权重上界可配（config.ts）、缺省保守、cap=0 可关（回滚开关）；
 *   ② 模拟膨胀桶连续注入：同一旧条目占比显著下降 + 新鲜条目至少占一席；
 *   ③ 批内多样性：同 Tag 去重让异轴条目在近似并列处进席；
 *   ④ 近因窗口有界：窗口内加成、窗口外无、远题新条目不进（不推翻主排序）；
 *   ⑤ 零权重/池<5 逐位旧行为（对照旧单趟循环参考实现）；
 *   ⑥ 接线：ws.recall 全链路（台账曝光惩罚真实生效）+ 主动路径不受影响 + 零新增嵌入调用。
 *
 * 用法：node scripts/acceptance-selection-weights.mjs（自建自净 /tmp 桶；嵌入桩与 #36/#51 同款）。
 * 编号承接 acceptance-adaptivek.mjs（#51-54），本套件 #55-60。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, Config as ConfigSchema } from '../lib/index.js'
import { acquireWorkspace } from '../lib/workspace.js'
import { estimateTokens, workspacePaths } from '../lib/runtime.js'
import { ADAPTIVE_K_POOL_FLOOR, selectCandidates } from '../lib/recall.js'
import { recordUsage } from '../lib/health.js'

const VCP = '/home/h/app/VCPToolBox'
const results = []
const line = (s = '') => console.log(s)
const hr = (t) => line('\n' + '═'.repeat(88) + `\n${t}\n` + '═'.repeat(88))
function check(id, title, pass, evidence) {
  results.push({ id, title, pass })
  line(`\n【票04-验收 #${id}】${title}  →  ${pass ? '✅ PASS' : '❌ FAIL'}`)
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

/* ── 合成候选行（直驱 selectCandidates：分数/Tag/时间全可控，确定性断言）── */
const T0 = Date.now()
const DAY = 86_400_000
const HOUR = 3_600_000
const row = (i, score, opts = {}) => ({
  id: i,
  fileId: i * 100,
  writtenAt: opts.at ?? T0 - 10 * DAY,
  title: `D${i} 样本${i}`,
  diaryName: '权重测试',
  knnScore: 0.8,
  score,
  rawScore: score,
  role: 'thematic_neighbor',
  anchorBonus: 0,
  topologyBonus: 0,
  omega: null,
  riverRegime: null,
  matchedTags: opts.tags ?? [`轴${i}`],
  rewardSuppressed: false,
  body: `样本${i}正文：主题句一句，展开两句，保持 token 成本可见。`,
})

/** 缺省权重（与 config.ts inject schema 缺省一致——#55 另行断言）。 */
const W = (o = {}) => ({
  tagCap: 0.04,
  exposureCap: 0.08,
  exposureHalfLifeHours: 24,
  recencyCap: 0.05,
  recencyWindowHours: 24,
  ...o,
})
const W_OFF = W({ tagCap: 0, exposureCap: 0, recencyCap: 0 })

/* ── 旧单趟选择循环参考实现（票03 时代 recall() ⑤ 的逐位复刻，等价性对照用）── */
function oldLoop(ranked, k, dynamicK, tokenBudget) {
  const kEff = Math.max(1, Math.round(k * Math.max(0, dynamicK)))
  const dropped = []
  const selected = []
  let used = 0
  for (const r of ranked) {
    if (selected.length >= kEff) {
      dropped.push({ id: r.id, title: r.title, reason: 'k-limit' })
      continue
    }
    const cost = estimateTokens(r.body) + estimateTokens(r.title) + 24
    if (used + cost > tokenBudget) {
      const trimmed = r.body.split(/(?<=[。！？!?\n])/)[0] ?? r.body
      const trimCost = estimateTokens(trimmed) + estimateTokens(r.title) + 24
      if (used + trimCost <= tokenBudget) {
        selected.push({ ...r, body: trimmed })
        used += trimCost
        dropped.push({ id: r.id, title: r.title, reason: 'truncated-to-first-sentence' })
        continue
      }
      dropped.push({ id: r.id, title: r.title, reason: 'token-budget' })
      continue
    }
    selected.push(r)
    used += cost
  }
  return { selected, dropped, kEff, used }
}

/* ═══════════ 验收 #55：权重上界可配、缺省保守、0 可关 ═══════════ */
hr('票04-① 配置缺省：tag 0.04 / exposure 0.08 / 近因 0.05（合计 0.17 < 锚 0.18）；显式 0 可关')
{
  const defaults = ConfigSchema({ native: { vcpRoot: VCP } }).inject
  const off = ConfigSchema({ native: { vcpRoot: VCP }, inject: { selectionTagCap: 0, selectionExposureCap: 0, selectionRecencyCap: 0 } }).inject
  const sum = defaults.selectionTagCap + defaults.selectionExposureCap + defaults.selectionRecencyCap
  check(
    55,
    '缺省保守（三上界合计 <0.18 锚奖励）+ 三个 cap 显式 0 可关',
    defaults.selectionTagCap === 0.04 &&
      defaults.selectionExposureCap === 0.08 &&
      defaults.selectionExposureHalfLifeHours === 24 &&
      defaults.selectionRecencyCap === 0.05 &&
      defaults.selectionRecencyWindowHours === 24 &&
      sum < 0.18 &&
      off.selectionTagCap === 0 &&
      off.selectionExposureCap === 0 &&
      off.selectionRecencyCap === 0,
    [
      `tag=${defaults.selectionTagCap} exposure=${defaults.selectionExposureCap}(半衰${defaults.selectionExposureHalfLifeHours}h) recency=${defaults.selectionRecencyCap}(窗口${defaults.selectionRecencyWindowHours}h)`,
      `三上界合计=${sum.toFixed(2)} < 0.18（锚奖励）→ 只翻近似并列，不推翻 topology 主排序`,
      `回滚：三 cap=0 → ${off.selectionTagCap}/${off.selectionExposureCap}/${off.selectionRecencyCap}（权重全关）`,
    ],
  )
}

/* ═══════════ 验收 #56：膨胀桶连续注入模拟（核心线：D1×36 → 占比显著下降 + 新鲜占席）═══════════ */
hr('票04-② 膨胀桶连续 12 次注入（k=3 复刻 D1×36 时代）：同一旧条目占比 100% → 显著下降；新鲜条目占席；垄断打破')
{
  /* 复刻 c9f838ba 病理形态：8 条同域 hub 旧条目分数挤成近似并列（0.500..0.493，D1 最高）、
     18 条异轴旧条目 0.485..0.417、1 条新鲜条目 0.488（2h 前写，分数在 hub 簇之下）。
     固定 k=3（ratio=0 关自适应，隔离票03）——正是「dropped 24/26」证据形态：每轮只记 3 条
     passive，坐席者的曝光惩罚与坐观者拉开强区分；票03 开启时 kEff 随池抬升，单条占比进一步
     摊薄（#60 另证读出链路）。每注入一轮记账 passive、时钟 +30min。 */
  const mkRows = () => {
    const rows = []
    for (let i = 1; i <= 8; i++) rows.push(row(i, 0.501 - i * 0.001, { tags: ['hub', `轴${i}`] }))
    for (let i = 9; i <= 26; i++) rows.push(row(i, 0.489 - (i - 8) * 0.004))
    rows.push(row(27, 0.488, { at: T0 - 2 * HOUR, tags: ['新鲜轴'] }))
    return rows
  }
  const run = (weights) => {
    const ledger = new Map()
    const perRound = []
    let maxPen = 0
    for (let r = 0; r < 12; r++) {
      const now = T0 + r * 30 * 60_000
      const out = selectCandidates(mkRows(), {
        k: 3, dynamicK: 1, adaptiveKRatio: 0, adaptiveKMax: 16, tokenBudget: 1e9,
        selectionWeights: weights, ledger, now,
      })
      if (out.selected.length !== 3) throw new Error(`round ${r}: selected=${out.selected.length} ≠ 3`)
      maxPen = Math.max(maxPen, out.weights.maxPenalty)
      perRound.push(out.selected.map((c) => c.id))
      for (const c of out.selected) {
        const e = ledger.get(c.fileId) ?? { passive: 0, lastPassiveAt: null }
        e.passive += 1
        e.lastPassiveAt = now
        ledger.set(c.fileId, e)
      }
    }
    const d1Share = perRound.filter((ids) => ids.includes(1)).length / perRound.length
    const hubSeats = perRound.reduce((s, ids) => s + ids.filter((i) => i <= 8).length, 0)
    return { d1Share, perRound, distinct: new Set(perRound.flat()).size, freshIn: perRound.some((ids) => ids.includes(27)), maxPen, hubSeats }
  }
  const base = run(undefined) // 权重不传 = 旧行为
  const on = run(W())
  check(
    56,
    `旧条目 D1 占比 ${(base.d1Share * 100).toFixed(0)}% → ${(on.d1Share * 100).toFixed(0)}%（≤50%）；新鲜条目${on.freshIn ? '占席' : '未占席 ❌'}；hub 垄断 ${base.hubSeats}/36 席 → ${on.hubSeats}/36 席`,
    base.d1Share === 1 && base.hubSeats === 36 && on.d1Share <= 0.5 && on.freshIn && on.distinct - base.distinct >= 4 && on.hubSeats < base.hubSeats && on.maxPen <= 0.08 + 1e-9,
    [
      `基线（权重关）：D1 12/12=${(base.d1Share * 100).toFixed(0)}%（复刻 D1×36：hub 簇包揽 ${base.hubSeats}/36 席），12 轮 distinct=${base.distinct}（静态）`,
      `开权重：D1 ${Math.round(on.d1Share * 12)}/12=${(on.d1Share * 100).toFixed(0)}%（要求 ≤50%：曝光抑制 tanh(被动/2)×半衰24h 起效——反复坐席者让位，随时间衰减不永久流放）`,
      `hub 簇占席：${base.hubSeats}/36 → ${on.hubSeats}/36（同 Tag 去重 + 曝光抑制双重反垄断）`,
      `新鲜条目（id27，2h 前写）：${on.freshIn ? '至少 1 轮在席 ✅' : '❌ 从未在席'}（近因 +0.046 → 首轮即最高 eff）`,
      `轮换：12 轮累计 distinct ${base.distinct} → ${on.distinct}（要求 +≥4：垄断打破、旧条目轮换曝光）`,
      `有界性：全程 maxPenalty=${on.maxPen.toFixed(4)} ≤ exposureCap=0.08`,
    ],
  )
}

/* ═══════════ 验收 #57：近因窗口——窗口内加成、窗口外无、远题不进 ═══════════ */
hr('票04-③ 近因加成：窗口内(2h)翻转近似并列；窗口外(30h)无加成；远题新条目(0.30)不进')
{
  const mkRows = (freshAt) => {
    const rows = []
    for (let i = 1; i <= 6; i++) rows.push(row(i, 0.501 - i * 0.001))
    rows.push(row(7, 0.494, { at: freshAt, tags: ['新鲜轴'] }))
    return rows
  }
  const call = (freshAt, weights) =>
    selectCandidates(mkRows(freshAt), { k: 3, dynamicK: 1, adaptiveKRatio: 0, adaptiveKMax: 16, tokenBudget: 1e9, selectionWeights: weights, ledger: null, now: T0 })
  const off = call(T0 - 2 * HOUR, undefined)
  const inWin = call(T0 - 2 * HOUR, W({ tagCap: 0, exposureCap: 0 }))
  const outWin = call(T0 - 30 * HOUR, W({ tagCap: 0, exposureCap: 0 }))
  const farOff = selectCandidates([...mkRows(T0 - 2 * HOUR).slice(0, 6), row(8, 0.3, { at: T0 - 2 * HOUR, tags: ['无关轴'] })], {
    k: 3, dynamicK: 1, adaptiveKRatio: 0, adaptiveKMax: 16, tokenBudget: 1e9,
    selectionWeights: W({ tagCap: 0, exposureCap: 0 }), ledger: null, now: T0,
  })
  check(
    57,
    '近因窗口有界：2h 内新条目进席 / 30h 外无加成 / 分数差 0.2 的远题新条目仍不进',
    !off.selected.some((c) => c.id === 7) &&
      inWin.selected.some((c) => c.id === 7) &&
      inWin.selected.some((c) => c.id === 1) &&
      !outWin.selected.some((c) => c.id === 7) &&
      outWin.weights.recencyBoosted === 0 &&
      !farOff.selected.some((c) => c.id === 8) &&
      inWin.weights.recencyBoosted === 1,
    [
      `权重关：selected=[${off.selected.map((c) => c.id).join(',')}]（id7 分数第 7，k=3 不在席）`,
      `2h 前写：selected=[${inWin.selected.map((c) => c.id).join(',')}]（id7 +0.05×(1-2/24)=+0.046 → 在席 ✅；top1 未被挤）`,
      `30h 前写：selected=[${outWin.selected.map((c) => c.id).join(',')}]（窗口 24h 外零加成，recencyBoosted=${outWin.weights.recencyBoosted}）`,
      `远题对照：score=0.30 的新条目 +0.046 仍 ≪ 0.495 → 不在席（不推翻主排序 ✅）`,
    ],
  )
}

/* ═══════════ 验收 #58：批内同 Tag 去重——hub 克隆让位异轴条目 ═══════════ */
hr('票04-④ 同 Tag 去重：5 条 hub 克隆近似并列 → 第 2/3 席让位异轴条目')
{
  const mkRows = () => {
    const rows = []
    for (let i = 1; i <= 5; i++) rows.push(row(i, 0.501 - i * 0.002, { tags: ['hub'] }))
    rows.push(row(6, 0.48, { tags: ['B轴'] }))
    rows.push(row(7, 0.47, { tags: ['C轴'] }))
    return rows
  }
  const call = (weights) =>
    selectCandidates(mkRows(), { k: 3, dynamicK: 1, adaptiveKRatio: 0, adaptiveKMax: 16, tokenBudget: 1e9, selectionWeights: weights, ledger: null, now: T0 })
  const off = call(undefined)
  const on = call(W({ exposureCap: 0, recencyCap: 0 }))
  check(
    58,
    '同 Tag 去重：[hub,hub,hub] → [hub,异轴,异轴]；tagDemotions 留痕',
    JSON.stringify(off.selected.map((c) => c.id)) === JSON.stringify([1, 2, 3]) &&
      JSON.stringify(on.selected.map((c) => c.id)) === JSON.stringify([1, 6, 7]) &&
      on.weights.tagDemotions === 2,
    [
      `权重关：selected=[${off.selected.map((c) => c.id).join(',')}]（hub 簇 0.500/0.498/0.496 垄断 k=3）`,
      `tagCap=0.04：selected=[${on.selected.map((c) => c.id).join(',')}]（第2席 0.498-0.04×1/1=0.458 < 0.48 → id6；第3席同理 id7）`,
      `tagDemotions=${on.weights.tagDemotions}（静态序队首被翻下席 2 次，诊断留痕 ✅）`,
    ],
  )
}

/* ═══════════ 验收 #59：零权重/池<5 逐位旧行为（对照参考实现）═══════════ */
hr('票04-⑤ 回滚等价：权重不传 ≡ 三 cap=0 ≡ 旧单趟循环（逐位）；池<5 权重不生效')
{
  const mkRows = () => {
    const rows = []
    for (let i = 1; i <= 8; i++) rows.push(row(i, 0.501 - i * 0.001, { tags: ['hub', `轴${i}`] }))
    for (let i = 9; i <= 26; i++) rows.push(row(i, 0.489 - (i - 8) * 0.004))
    return rows
  }
  const rows = mkRows()
  const ref = oldLoop(rows, 16, 1, 1e9)
  const noW = selectCandidates(rows, { k: 16, dynamicK: 1, adaptiveKRatio: 0, adaptiveKMax: 16, tokenBudget: 1e9, selectionWeights: undefined, ledger: new Map(), now: T0 })
  const zeroW = selectCandidates(rows, { k: 16, dynamicK: 1, adaptiveKRatio: 0, adaptiveKMax: 16, tokenBudget: 1e9, selectionWeights: W_OFF, ledger: new Map(), now: T0 })
  const sig = (o) => JSON.stringify({ ids: o.selected.map((c) => c.id), dropped: o.dropped, kEff: o.kEff })
  const eqRef = sig(noW) === sig(ref)
  const eqZero = sig(noW) === sig(zeroW)

  /* 池<5：权重开（含台账曝光）也不改变选集——稀疏桶护住（与票03 池地板同界） */
  const sparse = mkRows().slice(0, 4)
  const ledger = new Map([[100, { passive: 9, lastPassiveAt: T0 }]])
  const spOn = selectCandidates(sparse, { k: 3, dynamicK: 1, adaptiveKRatio: 0, adaptiveKMax: 16, tokenBudget: 1e9, selectionWeights: W(), ledger, now: T0 })
  const spOff = selectCandidates(sparse, { k: 3, dynamicK: 1, adaptiveKRatio: 0, adaptiveKMax: 16, tokenBudget: 1e9, selectionWeights: undefined, ledger, now: T0 })
  const spOk = sig(spOn) === sig(spOff) && spOn.weights.on === false

  check(
    59,
    '零权重逐位等价（不传 ≡ 三cap=0 ≡ 旧循环参考）；池<5 权重不生效',
    eqRef && eqZero && spOk,
    [
      `27 行合成池：不传权重 selected=[${noW.selected.map((c) => c.id).slice(0, 6).join(',')}…] dropped=${noW.dropped.length}（k-limit=${noW.dropped.filter((d) => d.reason === 'k-limit').length}）`,
      `≡ 三cap=0：${eqZero ? '逐位一致 ✅' : '❌'}；≡ 旧单趟参考实现：${eqRef ? '逐位一致 ✅' : '❌'}（selected+dropped+kEff 全等）`,
      `池=4(<${ADAPTIVE_K_POOL_FLOOR})：台账 passive=9 曝光在册，开/关权重选集${spOk ? '逐位一致 ✅（weights.on=false，稀疏桶护住）' : '❌ 不一致'}`,
    ],
  )
}

/* ═══════════ 验收 #60：接线——ws.recall 全链路 + 主动路径不受影响 + 零新增嵌入调用 ═══════════ */
hr('票04-⑥ 集成：config→recallOptions→recall 全链路（台账曝光真实生效）；主动路径不接权重；零新增 embed')
{
  const SW_CWD = join(tmpdir(), `memo-river-sw-${process.pid}`)
  const swPaths = workspacePaths(SW_CWD, '选择权重测试')
  rmSync(SW_CWD, { recursive: true, force: true })
  rmSync(swPaths.root, { recursive: true, force: true })
  mkdirSync(SW_CWD, { recursive: true })
  const config = makeConfig({ bucket: '选择权重测试' })
  const h = createMockCtx()
  apply(h.ctx, config)
  const ws = acquireWorkspace(SW_CWD, config)
  const dim = ws.resolved.dimension
  let embedCalls = 0
  const hashVec = (text) => {
    const dg = createHash('sha256').update(text).digest()
    const v = new Float32Array(dim)
    for (let i = 0; i < dg.length; i++) v[i] = dg[i] / 127.5 - 1
    return v
  }
  ws.embed.embed = async (texts) => {
    embedCalls += 1
    return texts.map(hashVec)
  }
  Object.defineProperty(ws.embed, 'configured', { get: () => true, configurable: true })

  const writeTool = h.registered.tools.find((t) => (t.name ?? t.definition?.name) === 'memo_write')
  const wExec = writeTool.execute.bind(writeTool)
  const wCtx = { agent: createAgent('sess-sw-w', SW_CWD, []) }
  let seq = 0
  const writeDiary = async () => {
    seq += 1
    const n = String(seq).padStart(2, '0')
    const out = await wExec(
      {
        content:
          `# 权重集成样本${n}：渲染批次${n}\n\n` +
          `结论：第 ${n} 批的卡顿来自阴影贴图档位过高，降到 1024 后帧率恢复。` +
          `后续要盯顶点数指标与合批策略。\n\nTag: 集成轴${n}, 批次${n}, 样本${n}`,
        newTagReason: `权重集成样本 ${n}，三个 Tag 均为本篇专属主题词`,
      },
      wCtx,
    )
    return String(out).includes('已写入')
  }
  let okW = true
  while (seq < 8) okW = (await writeDiary()) && okW

  const QUERY = '渲染又卡了，上一批是怎么解决的'
  const recallWith = async (qid, extra = {}) =>
    ws.recall(QUERY, { mode: 'topology_v3', k: 3, tokenBudget: 1e9, dynamicK: 1, gate: false, gateThreshold: 0.55, minKnnForReward: 0.6, queryId: qid, adaptiveKRatio: 0, adaptiveKMax: 16, ...extra })

  /* 被动路径（injector.recallOptions 同形：带缺省权重）——首轮台账空 */
  const e0 = embedCalls
  const r1 = await recallWith('sw-1', { selectionWeights: W() })
  const embedsOn = embedCalls - e0
  const on1 = r1.diagnostics.selectionWeights?.on === true && r1.selected.length > 0

  /* 记账 passive 后再注：曝光惩罚在真实读出链路生效（轮换本身由 #56 确定性证明——
     7 篇桶分差大，惩罚 0.037 翻不动宽差距是「有界、不推翻主排序」的设计语义） */
  recordUsage(ws.store, r1.selected.map((c) => c.fileId), 'passive')
  const r2 = await recallWith('sw-2', { selectionWeights: W() })
  const penalized = r2.diagnostics.selectionWeights?.exposurePenalized ?? 0
  const rotated = JSON.stringify(r2.selected.map((c) => c.id)) !== JSON.stringify(r1.selected.map((c) => c.id))
  const bounded = (r2.diagnostics.selectionWeights?.maxPenalty ?? 0) <= 0.08 + 1e-9

  /* 主动路径（memo_recall / tools.ts 形状：不传 selectionWeights）——权重不生效（on=false）。
     诊断对象恒存在（执行留痕），判别在 on 字段：主动路径永远逐位旧行为。 */
  const eA = embedCalls
  const r3 = await recallWith('sw-3')
  const embedsOff = embedCalls - eA
  const activeClean = r3.diagnostics.selectionWeights?.on === false
  const recallTool = h.registered.tools.find((t) => (t.name ?? t.definition?.name) === 'memo_recall')
  const rTool = await recallTool.execute.bind(recallTool)({ query: QUERY, k: 3 }, { agent: createAgent('sess-sw-r', SW_CWD, []) })
  const toolOk = String(rTool).length > 0

  /* 静态接线证据：injector.recallOptions 从 config.inject 组装 selectionWeights（车道外只读） */
  const injectorSrc = readFileSync(new URL('../src/injector.ts', import.meta.url), 'utf8')
  const wired = /selectionTagCap/.test(injectorSrc) && /selectionWeights:\s*\{/.test(injectorSrc)

  check(
    60,
    '全链路：台账曝光惩罚在真实读出链路生效；主动路径 on=false（显式 k 语义不变）；embed 调用数与权重无关',
    okW && on1 && r2.selected.length > 0 && penalized > 0 && bounded && activeClean && toolOk && wired && embedsOn === embedsOff,
    [
      `8 篇写入 ✅（池=${r1.candidateCount}≥5）→ r1 选中 [${r1.selected.map((c) => c.id).join(',')}]，diag.on=${r1.diagnostics.selectionWeights?.on}`,
      `recordUsage(passive) 后 r2：exposurePenalized=${penalized} maxPenalty=${(r2.diagnostics.selectionWeights?.maxPenalty ?? 0).toFixed(4)}≤0.08（惩罚读到台账并生效 ✅）；选集${rotated ? '轮换' : '未轮换（宽分差桶，有界设计的语义边界）'}`,
      `主动路径（不传权重，memo_recall 同形）：selectionWeights.on=${r3.diagnostics.selectionWeights?.on}（false=逐位旧行为 ✅）；memo_recall 工具直调 ${toolOk ? '✅' : '❌'}`,
      `嵌入调用：权重开 ${embedsOn} 次 vs 关 ${embedsOff} 次/召回（相等 → 选择阶段零新增 embed ✅）`,
      `injector.recallOptions 接线：${wired ? 'config.inject.selectionTagCap → selectionWeights ✅' : '❌'}`,
    ],
  )

  ws.store.close?.()
  h.dispose()
  rmSync(SW_CWD, { recursive: true, force: true })
  rmSync(swPaths.root, { recursive: true, force: true })
}

/* ═══════════ 汇总 ═══════════ */
hr('验收汇总')
const pass = results.filter((r) => r.pass).length
for (const r of results.sort((a, b) => a.id - b.id)) line(`  #${String(r.id).padStart(2)} ${r.pass ? '✅' : '❌'}  ${r.title}`)
line(`\n  通过 ${pass}/${results.length}`)
line(`  回归（主套件 ≥36 + adaptivek 4 项）另跑：node scripts/acceptance.mjs && node scripts/acceptance-adaptivek.mjs`)
process.exit(pass === results.length ? 0 : 1)
