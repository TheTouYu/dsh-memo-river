/**
 * src/health.ts — 四项语料体检（DESIGN.md §7.3）+ 使用台账视图。
 *
 * | 指标 | 判据 | 依据 |
 * |---|---|---|
 * | 连通分量数 | **必须 = 1** | 孤岛语料下多跳通路不存在（§2.2 规则 1） |
 * | 最大 Tag 频次 / 总篇数 | **< 1/3** | 枢纽 Tag 会让直接锚泛化（§2.2 规则 2） |
 * | Ω 分布（近 N 次查询） | 报告分布，不只报均值 | Ω 不度量连通性（§2.2 规则 3） |
 * | 未覆盖率（入库但从未被召回） | 报告，>50% 需警告 | 冷启动体检 |
 *
 * Ω 与召回足迹写在 `kv_store`（VCP schema 子集内），不新增表。
 *
 * ## 使用台账（DESIGN.md §7.3 ⑤，票 01）
 * 每次被动注入 / `memo_recall` 主动补证命中，都按 fileId 记账：
 * 次数（主动/被动分开）+ 最近使用时间。**三条红线**：
 *   1. 只写 `kv_store`（`memo_river.usage_ledger`），内容表与图资产零变更
 *      ——kv_store 不参与 artifactSig 内容寻址，记账不得触发资产重建；
 *   2. 不进打分：台账是观测素材，召回排序至今不读它（先跑数据，再谈转向）；
 *   3. 旧键 `memo_river.recalled_file_ids`（布尔集合）冻结为历史种子，只读：
 *      「曾被召回」= 台账 ∪ 遗留集，保证既有生产库的未覆盖率不断崖。
 */
import type { KnowledgeStore } from './store.js'
import { readJsonSafe } from './runtime.js'

/** 枢纽门限：最大 Tag 频次 / 总篇数 < 1/3（§7.3）。 */
export const HUB_RATIO_LIMIT = 1 / 3
/** 未覆盖率告警线。 */
export const UNCOVERED_RATIO_WARN = 0.5
/** Ω 分布取样窗口。 */
export const OMEGA_WINDOW = 50

const KV_OMEGA = 'memo_river.omega_samples'
/** 遗留布尔集（2026-09-13 前的唯一召回足迹）。冻结只读：不再写入，读时与台账并集。 */
/** 遗留布尔集键（票 01 冻结为只读种子；consolidation.ts 判定②读它，勿改名）。 */
export const KV_RECALLED = 'memo_river.recalled_file_ids'
/** 使用台账（票 01）：fileId → { p, a, lastP, lastA } 的 JSON 映射。 */
/** 使用台账 kv 键（票 01；tools.ts 归档清扫复用，勿改名——线上库已有此键数据）。 */
export const KV_USAGE = 'memo_river.usage_ledger'
/** 陈旧线（天）：有使用足迹但最近 N 天未被动/主动的篇数，视图性指标，不告警。 */
export const USAGE_STALE_DAYS = 14

export interface OmegaSample {
  omega: number | null
  regime: string
  at: number
}

/** 单篇日记的使用台账条目。p/a = 被动注入 / 主动补证次数；lastP/lastA = 最近一次毫秒时间戳。 */
export interface UsageEntry {
  passive: number
  active: number
  lastPassiveAt: number | null
  lastActiveAt: number | null
}

export type UsageKind = 'passive' | 'active'

/** memo_stats / health.log 的使用视图（票 01）。 */
export interface UsageView {
  files: number
  /** 台账 ∪ 遗留集里有任何足迹的篇数。 */
  everUsed: number
  neverUsed: number
  neverRatio: number
  /** 按总次数降序的头部（≤5）。 */
  top: Array<{ fileId: number; total: number; passive: number; active: number; lastAt: number | null }>
  /** 有足迹但最近 staleDays 天内没有任何使用的篇数。 */
  staleDays: number
  staleThreshold: number
  /** 只存在于遗留布尔集、台账里没有的篇数（迁移可见性，>0 说明老足迹在种子集里）。 */
  legacyOnly: number
}

export interface HealthReport {
  bucket: string
  counts: { tags: number; files: number; chunks: number; fileTags: number }
  /** ① 连通分量数（必须 = 1）。 */
  components: number
  componentSizes: number[]
  /** ② 枢纽度。 */
  hub: { name: string; count: number; ratio: number; limit: number } | null
  /** ③ Ω 分布。 */
  omega: {
    samples: number
    mean: number | null
    min: number | null
    max: number | null
    histogram: Record<string, number>
    sparse: number
    dense: number
  }
  /** ④ 未覆盖率。 */
  uncovered: { files: number; neverRecalled: number; ratio: number; warn: boolean }
  /** ⑤ 使用台账视图；空库为 null（「无从判定」，不显示全零假通过）。 */
  usage: UsageView | null
  warnings: string[]
  ok: boolean
}

/* ────────────── ① 连通分量（Tag 共现图的并查集） ────────────── */

export function connectedComponents(store: KnowledgeStore): { count: number; sizes: number[] } {
  const tags = store.tags().map((t) => t.id)
  if (tags.length === 0) return { count: 0, sizes: [] }
  const parent = new Map<number, number>()
  const find = (x: number): number => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root)!
    let cur = x
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!
      parent.set(cur, root)
      cur = next
    }
    return root
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (const id of tags) parent.set(id, id)

  // 同一篇日记里的 Tag 两两连边（共现即连通）
  const byFile = new Map<number, number[]>()
  for (const file of store.files()) {
    const ids = store.fileTags(file.id).map((t) => t.tag_id)
    byFile.set(file.id, ids)
    for (let i = 1; i < ids.length; i++) union(ids[0]!, ids[i]!)
  }

  const sizes = new Map<number, number>()
  for (const id of tags) {
    const root = find(id)
    sizes.set(root, (sizes.get(root) ?? 0) + 1)
  }
  return { count: sizes.size, sizes: [...sizes.values()].sort((a, b) => b - a) }
}

/* ────────────── ③ Ω 采样 ────────────── */

export function readOmegaSamples(store: KnowledgeStore): OmegaSample[] {
  return readJsonSafe<OmegaSample[]>(store.dbPath.replace(/knowledge_base\.sqlite$/, 'omega-cache.json'), [])
}

export function recordOmega(store: KnowledgeStore, omega: number | null, regime: string): void {
  const prev = parseKv<OmegaSample[]>(store.kvGet(KV_OMEGA), [])
  prev.push({ omega, regime, at: Date.now() })
  store.kvSet(KV_OMEGA, JSON.stringify(prev.slice(-OMEGA_WINDOW)))
}

/** 读使用台账（fileId → 条目）。坏 JSON / 无记录 → 空表。 */
export function readUsageLedger(store: KnowledgeStore): Map<number, UsageEntry> {
  const out = new Map<number, UsageEntry>()
  const raw = parseKv<Record<string, UsageEntry>>(store.kvGet(KV_USAGE), {})
  for (const [k, v] of Object.entries(raw)) {
    const id = Number(k)
    if (!Number.isSafeInteger(id) || id <= 0 || !v || typeof v !== 'object') continue
    out.set(id, {
      passive: Number.isFinite(v.passive) ? v.passive : 0,
      active: Number.isFinite(v.active) ? v.active : 0,
      lastPassiveAt: typeof v.lastPassiveAt === 'number' ? v.lastPassiveAt : null,
      lastActiveAt: typeof v.lastActiveAt === 'number' ? v.lastActiveAt : null,
    })
  }
  return out
}

/**
 * 记一次使用（被动注入 / 主动补证）。**纯同步**（kvGet+kvSet，无 await），
 * 单线程内读改写原子；同一事件里同一篇只计一次（Set 去重）。
 * 失败向上抛（调用方 injector/tools 各自 try/catch，绝不阻塞主流程）。
 */
export function recordUsage(
  store: KnowledgeStore,
  fileIds: readonly number[],
  kind: UsageKind,
  at: number = Date.now(),
): void {
  const ledger = readUsageLedger(store)
  for (const id of new Set(fileIds)) {
    if (!Number.isSafeInteger(id) || id <= 0) continue
    const e = ledger.get(id) ?? { passive: 0, active: 0, lastPassiveAt: null, lastActiveAt: null }
    if (kind === 'passive') {
      e.passive += 1
      e.lastPassiveAt = at
    } else {
      e.active += 1
      e.lastActiveAt = at
    }
    ledger.set(id, e)
  }
  const obj: Record<string, UsageEntry> = {}
  for (const [id, e] of ledger) obj[String(id)] = e
  store.kvSet(KV_USAGE, JSON.stringify(obj))
}

/** 曾被召回（任意主动/被动足迹）的 fileId 集合：使用台账 ∪ 遗留布尔集（老库兼容）。 */
export function recalledFileIds(store: KnowledgeStore): Set<number> {
  const ids = new Set<number>(parseKv<number[]>(store.kvGet(KV_RECALLED), []))
  for (const id of readUsageLedger(store).keys()) ids.add(id)
  return ids
}

function parseKv<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/* ────────────── ⑤ 使用台账视图 ────────────── */

/** 空库返回 null（无从判定）；有语料才有视图。纯 kv 读，无副作用。 */
function buildUsageView(store: KnowledgeStore, allFileIds: readonly number[], now: number = Date.now()): UsageView | null {
  if (allFileIds.length === 0) return null
  const ledger = readUsageLedger(store)
  const legacy = new Set(parseKv<number[]>(store.kvGet(KV_RECALLED), []))

  const rows: UsageView['top'][number][] = []
  let everUsed = 0
  let legacyOnly = 0
  let stale = 0
  const staleMs = USAGE_STALE_DAYS * 86_400_000
  for (const id of allFileIds) {
    const e = ledger.get(id)
    const hasLedger = e !== undefined
    const hasLegacy = legacy.has(id)
    if (!hasLedger && !hasLegacy) continue // never used
    everUsed += 1
    if (!hasLedger && hasLegacy) legacyOnly += 1
    const lastAt = e ? Math.max(e.lastPassiveAt ?? 0, e.lastActiveAt ?? 0) || null : null
    if (e && lastAt !== null && now - lastAt > staleMs) stale += 1
    if (e) {
      rows.push({
        fileId: id,
        total: e.passive + e.active,
        passive: e.passive,
        active: e.active,
        lastAt,
      })
    }
  }
  rows.sort((a, b) => b.total - a.total || a.fileId - b.fileId)
  const neverUsed = allFileIds.length - everUsed
  return {
    files: allFileIds.length,
    everUsed,
    neverUsed,
    neverRatio: neverUsed / allFileIds.length,
    top: rows.slice(0, 5),
    staleDays: stale,
    staleThreshold: USAGE_STALE_DAYS,
    legacyOnly,
  }
}

/* ────────────── 汇总报告 ────────────── */

export function healthReport(store: KnowledgeStore, bucket: string): HealthReport {
  const counts = store.counts()
  const { count: components, sizes } = connectedComponents(store)

  const freq = store.tagFrequency()
  const top = freq[0]
  const hub =
    top && counts.files > 0
      ? { name: top.name, count: top.count, ratio: top.count / counts.files, limit: HUB_RATIO_LIMIT }
      : null

  const samples = parseKv<OmegaSample[]>(store.kvGet(KV_OMEGA), [])
  const values = samples.map((s) => s.omega).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  const histogram: Record<string, number> = { '0.0-0.2': 0, '0.2-0.4': 0, '0.4-0.6': 0, '0.6-0.8': 0, '0.8-1.0': 0 }
  for (const v of values) {
    const idx = Math.min(4, Math.max(0, Math.floor(v / 0.2)))
    const key = Object.keys(histogram)[idx]!
    histogram[key] = (histogram[key] ?? 0) + 1
  }
  const regimeOf = (r: string): 'sparse' | 'dense' | 'other' =>
    r === 'sparse' ? 'sparse' : r === 'dense' ? 'dense' : 'other'
  const omega = {
    samples: values.length,
    mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    histogram,
    sparse: samples.filter((s) => regimeOf(s.regime) === 'sparse').length,
    dense: samples.filter((s) => regimeOf(s.regime) === 'dense').length,
  }

  const allFileIds = store.files().map((f) => f.id)
  const recalled = recalledFileIds(store)
  const neverRecalled = allFileIds.filter((id) => !recalled.has(id)).length
  const uncovered = {
    files: allFileIds.length,
    neverRecalled,
    ratio: allFileIds.length ? neverRecalled / allFileIds.length : 0,
    warn: allFileIds.length > 0 && neverRecalled / allFileIds.length > UNCOVERED_RATIO_WARN,
  }
  const usage = buildUsageView(store, allFileIds)

  const warnings: string[] = []
  if (allFileIds.length === 0) {
    // 空库不是「四项全过」，而是「四项无从判定」。§1 不变量 6：静默即不可接受——
    // 把一个还没入料的桶报成 ✅，会让「体检通过」这句话失去信息量。
    warnings.push('空库：本桶尚无日记，四项体检无从判定（先 memo_write 或导入语料）')
  }
  if (allFileIds.length > 0 && components > 1) {
    warnings.push(
      `连通分量 ${components}（必须 = 1）：孤岛语料下「现象→真因」的多跳通路在数学上不存在，任何参数都救不回来`,
    )
  }
  if (hub && hub.ratio >= HUB_RATIO_LIMIT) {
    warnings.push(`枢纽 Tag「${hub.name}」出现 ${hub.count}/${counts.files} 篇（≥1/3）：直接锚会被泛化，唯一锚的锐度消失`)
  }
  if (uncovered.warn) {
    warnings.push(`未覆盖率 ${(uncovered.ratio * 100).toFixed(1)}%（>50%）：${uncovered.neverRecalled}/${uncovered.files} 篇入库后从未被召回`)
  }
  if (counts.tags > 0 && counts.tags < components) {
    warnings.push(`Tag 数与连通分量不自洽（tags=${counts.tags} components=${components}）`)
  }

  return {
    bucket,
    counts,
    components,
    componentSizes: sizes,
    hub,
    omega,
    uncovered,
    usage,
    warnings,
    ok: warnings.length === 0,
  }
}

/** memo_stats / 守护日志用的紧凑可读文本。 */
export function formatHealth(report: HealthReport): string {
  const omin = report.omega.min
  const omax = report.omega.max
  const omegaRange = omin === null || omax === null ? 'n/a' : `${omin.toFixed(3)}–${omax.toFixed(3)}`
  const lines = [
    `【记忆河流·语料体检】桶=${report.bucket}`,
    `· 规模：${report.counts.files} 篇 / ${report.counts.tags} Tag / ${report.counts.chunks} chunk / ${report.counts.fileTags} 共现`,
    `· ① 连通分量 = ${report.components}（判据 =1；分量规模 ${report.componentSizes.join(',') || '-'}）`,
    report.hub
      ? `· ② 最大 Tag 频次「${report.hub.name}」= ${report.hub.count}/${report.counts.files}（${(report.hub.ratio * 100).toFixed(1)}%，判据 <33.3%）`
      : '· ② 最大 Tag 频次 = n/a（空库）',
    `· ③ Ω 分布（近 ${report.omega.samples} 次）：均值 ${report.omega.mean === null ? 'n/a' : report.omega.mean.toFixed(3)}，范围 ${omegaRange}，sparse=${report.omega.sparse} dense=${report.omega.dense}，直方图 ${Object.entries(report.omega.histogram)
      .map(([k, v]) => `${k}:${v}`)
      .join(' ')}`,
    `· ④ 未覆盖率 = ${report.uncovered.neverRecalled}/${report.uncovered.files}（${(report.uncovered.ratio * 100).toFixed(1)}%${
      report.uncovered.warn ? '，>50% 警告' : ''
    }）`,
    report.usage
      ? `· ⑤ 使用台账（kv 观测，不进打分）：常用 top=${report.usage.top
          .map((t) => `D${t.fileId}×${t.total}(被${t.passive}/主${t.active})`)
          .join(' ') || '-'}；从未使用 ${report.usage.neverUsed}/${report.usage.files}（${(report.usage.neverRatio * 100).toFixed(1)}%）；` +
        `${report.usage.staleDays} 篇 >${report.usage.staleThreshold} 天未动${report.usage.legacyOnly > 0 ? `；${report.usage.legacyOnly} 篇仅遗留集足迹` : ''}`
      : '· ⑤ 使用台账 = 无从判定（空库：先入语料再谈使用分布）',
  ]
  if (report.warnings.length > 0) {
    lines.push('· ⚠️ 告警：')
    for (const w of report.warnings) lines.push(`  - ${w}`)
  } else {
    lines.push('· ✅ 四项体检全部通过')
  }
  return lines.join('\n')
}
