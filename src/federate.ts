/**
 * src/federate.ts — 桶继承联邦召回（inherit-0928）。
 *
 * 语义：主桶照常跑完整管线（gate / topology / selection 全在主桶口径下）；父桶用**同一份
 * options** 各自跑一遍——父桶条目要过**自己桶**的门控（继承放行的是「父桶认为相关」的
 * 条目，不是无条件搬运河）。合并规则：
 *   · selected = 主桶 selected 原样在前 + 父桶按「桶间轮转、桶内有效分数序」补位；
 *   · 每父桶贡献 ≤ INHERIT_PER_PARENT_CAP 条（轮转轮数即每桶上限）；
 *   · candidateCount / dropped / Ω / regime / diagnostics 只反映主桶——未注入统计与
 *     体检口径不被父桶稀释（父桶的 Ω 足迹记在父桶自己的 kv_store，见 parts）；
 *   · injected = 主桶或任一父桶注入成功；全失败时 fallbackReason 取主桶的（最诚实）。
 *
 * 台账与 Ω 记录由调用方按 parts 逐桶做：Ω 无论是否注入都记（§7.3 ③），usage 只记
 * 该桶**真正入选**的 fileId（part.injectedFileIds）。
 */
import type { RecallCandidate, RecallOptions, RecallOutcome } from './recall.js'
import type { WorkspaceRuntime } from './workspace.js'

/** 桶继承：单个父桶最多补入的条数（注入块 k=3~6，2 条/父桶 × ≤4 父桶仍在 tokenBudget 内）。 */
export const INHERIT_PER_PARENT_CAP = 2

/** 联邦结果里的一个桶（主桶在前）。 */
export interface FederatedPart {
  bucket: string
  workspace: WorkspaceRuntime
  outcome: RecallOutcome
  /** 该桶真正进入合并 selected 的 fileId（台账 'passive' 只记这些）。 */
  injectedFileIds: number[]
}

export interface FederatedRecallResult {
  /** 合并后的主口径 outcome（selected 含父桶条目，带 srcBucket 标注）。 */
  outcome: RecallOutcome
  /** 各桶原始 outcome（主桶在前）；台账 / Ω / 日志逐桶用。 */
  parts: FederatedPart[]
}

/**
 * 联邦召回：主桶 + 父桶并行各跑一遍 recall，按轮转合并。
 * 各桶 recall 永不抛（失败 → injected=false + fallbackReason），本函数同样永不抛。
 */
export async function federatedRecall(
  primary: WorkspaceRuntime,
  parents: WorkspaceRuntime[],
  queryText: string,
  options: RecallOptions,
): Promise<FederatedRecallResult> {
  const runs = await Promise.all([
    primary.recall(queryText, options),
    ...parents.map((p) => p.recall(queryText, options)),
  ])
  const primaryOutcome = runs[0]!

  /* 父桶补位队列：只收该桶自己门控放行的 selected，桶内按有效分数序。 */
  const queues = parents.map((workspace, i) => {
    const outcome = runs[i + 1]!
    return {
      bucket: workspace.paths.bucket,
      workspace,
      outcome,
      pending: outcome.injected ? [...outcome.selected].sort((a, b) => b.score - a.score) : [],
    }
  })

  /* 桶间轮转：第 n 轮每个还有余量的桶出 1 条 → 每桶恰好 ≤ INHERIT_PER_PARENT_CAP 条，
   * 且多桶时各桶交替而非一家独占前排。 */
  const inherited: RecallCandidate[] = []
  const injectedFileIds = queues.map(() => [] as number[])
  for (let round = 0; round < INHERIT_PER_PARENT_CAP; round++) {
    let progressed = false
    queues.forEach((q, qi) => {
      const next = q.pending.shift()
      if (next === undefined) return
      inherited.push({ ...next, srcBucket: q.bucket })
      injectedFileIds[qi]!.push(next.fileId)
      progressed = true
    })
    if (!progressed) break
  }

  const parts: FederatedPart[] = [
    {
      bucket: primary.paths.bucket,
      workspace: primary,
      outcome: primaryOutcome,
      injectedFileIds: primaryOutcome.injected ? primaryOutcome.selected.map((c) => c.fileId) : [],
    },
    ...queues.map((q, qi) => ({
      bucket: q.bucket,
      workspace: q.workspace,
      outcome: q.outcome,
      injectedFileIds: injectedFileIds[qi]!,
    })),
  ]

  const anyInjected = runs.some((r) => r.injected)
  const merged: RecallOutcome = {
    ...primaryOutcome,
    injected: anyInjected,
    fallbackReason: anyInjected ? null : primaryOutcome.fallbackReason,
    selected: [...primaryOutcome.selected, ...inherited],
    elapsedMs: Math.max(...runs.map((r) => r.elapsedMs)),
  }
  return { outcome: merged, parts }
}
