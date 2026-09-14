/**
 * 票 05 · 有界 tie-breaker 强化（默认关；DESIGN「边界与不承诺」的反馈环风险受控版）。
 *
 * 公式：boost = cap · tanh(activeCount / τ) · exp(-ageDays·ln2 / recencyHalfLifeDays)
 *   - cap 默认 0.05（≪ 锚奖励 0.18）：只够在**近似并列**处翻序，绝不制造常胜将军；
 *   - tanh 天然饱和：多用不再多涨，防曝光积累；
 *   - recency 半衰因子：长期不被主动召回 → 向基线收缩（不使用即遗忘的读侧镜像）；
 *   - **只认主动使用**（memo_recall 命中）：被动注入是曝光不是检索，计入即曝光偏差。
 *
 * 红线：纯 JS 后排序层，不碰 Rust、不进任何资产 hash（tagmemo_artifacts 不变）；
 * params.enabled=false → 原样返回同一引用（分数与顺序逐位一致，票⑤判据 1）。
 */
import type { KnowledgeStore } from './store.js'
import { readUsageLedger } from './health.js'

export interface TieBreakerParams {
  enabled: boolean
  /** 强化上界（>0；默认 0.05）。 */
  cap: number
  /** tanh 饱和常数（>0；默认 2：约 3 次主动召回即近饱和）。 */
  tau: number
  /** 最近主动召回的半衰期（天；默认 30）。 */
  recencyHalfLifeDays: number
}

/** tuning 值（数字面）→ 参数；tieBreakerEnabled ≤ 0.5 视为关。 */
export function tieBreakerParamsFrom(v: Record<string, number>): TieBreakerParams {
  return {
    enabled: (v.tieBreakerEnabled ?? 0) > 0.5,
    cap: v.tieBreakerCap ?? 0.05,
    tau: v.tieBreakerTau ?? 2,
    recencyHalfLifeDays: v.tieBreakerRecencyHalfLifeDays ?? 30,
  }
}

const DAY_MS = 86_400_000

/**
 * 对 Rust 读出后的候选行施加有界强化并按新分数排序。
 * - 关闭 → 返回原数组引用（零开销零漂移）。
 * - 行的台账键：`fileId` 优先（真实读出行），回退 `id`（合成候选/直测）。
 */
export function applyUsageTieBreaker<
  T extends { score: number; fileId?: number | null; id?: number },
>(
  rows: T[],
  ledger: Map<number, { passive: number; active: number; lastActiveAt: number | null }> | null,
  params: TieBreakerParams | undefined,
  now = Date.now(),
): T[] {
  if (!params?.enabled || params.cap <= 0 || !ledger || ledger.size === 0 || rows.length < 2) return rows
  const boosted: Array<{ row: T; adj: number }> = rows.map((row) => {
    const key = row.fileId ?? row.id
    const entry = key !== undefined ? ledger.get(key) : undefined
    let boost = 0
    if (entry && entry.active > 0 && entry.lastActiveAt !== null) {
      const ageDays = Math.max(0, (now - entry.lastActiveAt) / DAY_MS)
      const recency = Math.exp((-ageDays * Math.LN2) / Math.max(1, params.recencyHalfLifeDays))
      boost = params.cap * Math.tanh(entry.active / Math.max(0.1, params.tau)) * recency
    }
    return { row, adj: row.score + boost }
  })
  boosted.sort((a, b) => b.adj - a.adj)
  return boosted.map((b) => ({ ...b.row, score: b.adj }))
}
