/**
 * 票 04 · 合并候选检测（压缩式遗忘的主引擎，守护循环调用）。
 *
 * 冗余三判定，全部满足才进候选（按**冗余**退役，不按时间无差别衰减——
 * 老而独特的篇不进候选，天然绕开「永久设定不该被衰减」的分类难题）：
 *   ① 年龄：`updated_at` 距今 ≥ minAgeDays（默认 14，对齐 §7.3 ⑤ USAGE_STALE_DAYS 陈旧口径）
 *   ② 低使用：台账召回计数（被动+主动，含冻结遗留集 ≥1）≤ maxRecalls（默认 1）
 *   ③ 语义覆盖：与某**更新**日记的最大余弦 ≥ overlapCosine（默认 0.90——
 *      低于写侧拦截线 dedupCosine=0.95、高于一般同话题续写，专抓「没到拦截线
 *      但语义已被新篇覆盖」的合并带；定标依据见 DESIGN §7.1.3）
 *
 * 报告覆写式落 `<workspace>/candidates/merge-candidates.md`（每轮重生成——
 * memo_merge 执行后下一轮自动收敛，不留陈旧报告）。不落 pending/：
 * drafts 通道是 Tag 闸门日记专属，报告混入会被 memo_approve 误消费。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { KnowledgeStore } from './store.js'
import { KV_RECALLED, readUsageLedger } from './health.js'

export interface ConsolidationParams {
  enabled: boolean
  /** 判定①：最小年龄（天）。 */
  minAgeDays: number
  /** 判定②：最大累计召回次数（被动+主动）。 */
  maxRecalls: number
  /** 判定③：与更新篇的最小余弦。 */
  overlapCosine: number
}

export interface MergeCandidate {
  fileId: number
  title: string
  ageDays: number
  recalls: number
  overlapFileId: number
  overlapTitle: string
  overlapScore: number
  /** 理由串：三项判定值一目了然（验收断言面）。 */
  reason: string
}

export interface ConsolidationOutcome {
  /** ok = 正常检测（可能零候选）；empty = 空库无从判定。 */
  status: 'ok' | 'empty'
  candidates: MergeCandidate[]
  checked: number
}

const DAY_MS = 86_400_000

export function consolidationCandidates(
  store: KnowledgeStore,
  bucket: string,
  params: ConsolidationParams,
  now = Date.now(),
): ConsolidationOutcome {
  const files = store.files(bucket)
  if (files.length === 0) return { status: 'empty', candidates: [], checked: 0 }
  const chunks = store.chunks(bucket)
  const vecOf = new Map<number, Float32Array | null>()
  const titleOf = new Map<number, string>()
  const updatedOf = new Map<number, number>()
  for (const f of files) {
    const ch = chunks.find((c) => c.file_id === f.id)
    vecOf.set(f.id, ch?.vector ?? null)
    const m = /^#\s+(.+)$/m.exec(String(ch?.content ?? ''))
    titleOf.set(f.id, m?.[1] ?? basename(f.path))
    updatedOf.set(f.id, Number(f.updated_at) || Number(f.mtime) || now)
  }
  const ledger = readUsageLedger(store)
  const legacy = new Set<string>(JSON.parse(store.kvGet(KV_RECALLED) ?? '[]') as string[])

  const candidates: MergeCandidate[] = []
  for (const f of files) {
    const ageDays = (now - (updatedOf.get(f.id) ?? now)) / DAY_MS
    const entry = ledger.get(f.id)
    const recalls = (entry?.passive ?? 0) + (entry?.active ?? 0) + (legacy.has(String(f.id)) ? 1 : 0)
    if (ageDays < params.minAgeDays || recalls > params.maxRecalls) continue
    const myVec = vecOf.get(f.id)
    if (!myVec) continue
    /* 判定③：与「更新」篇的最大余弦（updated_at 严格大于本篇） */
    let best: { fileId: number; score: number } | null = null
    for (const g of files) {
      if (g.id === f.id || (updatedOf.get(g.id) ?? 0) <= (updatedOf.get(f.id) ?? 0)) continue
      const gv = vecOf.get(g.id)
      if (!gv) continue
      const score = cosine(myVec, gv)
      if (!best || score > best.score) best = { fileId: g.id, score }
    }
    if (!best || best.score < params.overlapCosine) continue
    candidates.push({
      fileId: f.id,
      title: titleOf.get(f.id) ?? basename(f.path),
      ageDays: Math.floor(ageDays),
      recalls,
      overlapFileId: best.fileId,
      overlapTitle: titleOf.get(best.fileId) ?? '',
      overlapScore: best.score,
      reason: `D${f.id}《${titleOf.get(f.id)}》：age=${Math.floor(ageDays)}d ≥ ${params.minAgeDays}d；recalls=${recalls} ≤ ${params.maxRecalls}；overlap=${best.score.toFixed(4)} vs 更新篇 D${best.fileId} ≥ ${params.overlapCosine}`,
    })
  }
  candidates.sort((a, b) => b.overlapScore - a.overlapScore)
  return { status: 'ok', candidates, checked: files.length }
}

export function candidateReportPath(workspaceRoot: string): string {
  return join(workspaceRoot, 'candidates', 'merge-candidates.md')
}

/** 报告覆写（每轮重生成；执行 memo_merge 后下一轮自动收敛）。返回写的行数。 */
export function writeCandidateReport(
  store: KnowledgeStore,
  bucket: string,
  params: ConsolidationParams,
  workspaceRoot: string,
  now = Date.now(),
): ConsolidationOutcome {
  const outcome = consolidationCandidates(store, bucket, params, now)
  const path = candidateReportPath(workspaceRoot)
  mkdirSync(join(workspaceRoot, 'candidates'), { recursive: true })
  if (outcome.status === 'empty') {
    writeFileSync(path, `# 合并候选报告（${new Date(now).toISOString()}）\n\n无从判定（空库）：先入语料再谈合并候选。\n`)
    return outcome
  }
  const lines = [
    `# 合并候选报告（${new Date(now).toISOString()}）`,
    '',
    `桶=${bucket}；判定参数：minAgeDays=${params.minAgeDays} · maxRecalls=${params.maxRecalls} · overlapCosine=${params.overlapCosine}；本轮检查 ${outcome.checked} 篇，候选 ${outcome.candidates.length} 篇。`,
    '',
  ]
  if (outcome.candidates.length === 0) {
    lines.push('无候选：没有「老 + 少被召回 + 被新篇语义覆盖」三判同时满足的篇。')
  } else {
    lines.push('以下篇满足冗余三判定（年龄/台账计数/与更新篇重叠），建议用 `memo_merge` 执行合并（keep=覆盖它的更新篇）：', '')
    for (const c of outcome.candidates) {
      lines.push(`- ${c.reason}`)
    }
    lines.push('', '> 本报告是候选**建议**，不是日记草稿：请勿 memo_approve。执行 `memo_merge(sources=[旧篇, 新篇], keep=新篇D-id, content=合并后全文)` 后，下一轮报告自动收敛。')
  }
  writeFileSync(path, lines.join('\n') + '\n')
  return outcome
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}
