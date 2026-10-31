/**
 * src/openrouter-ledger.ts — OpenRouter 调用台账（2026-10-21 用户令：没有调用日志就没法算账）。
 *
 * 目标：把每一次真正打到 OpenRouter 的请求（嵌入保底 / System One 保底）落成**机器可算**的 JSONL，
 * 同时在 memo-river.log 里留一条**人能看**的摘要行。以后要统计「本地服务停机期间的远端花费/占比」，
 * 直接扫这份台账即可，不用再从 systemd 日志和 OpenRouter 账单里反推。
 *
 * 设计约束：
 *   1. 绝不影响主流程——台账写失败只静默（与 Logger 同款降级纪律）。
 *   2. 只记 OpenRouter 请求；本地端点（8099/8122）不进这份账。
 *   3. 记 OpenRouter 响应里**真实返回**的 usage/cost/model/provider/id，不用本地估算。
 *   4. 一行一事件，JSONL 追加写；并发安全靠 O_APPEND 的原子小包写。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { memoRiverRoot } from './runtime.js'

/** 台账里的一次 OpenRouter 调用。 */
export interface OpenRouterUsageRecord {
  /** ISO 时间戳（毫秒精度）。 */
  ts: string
  /** 调用面：embedding 保底 / System One 决策保底。 */
  api: 'embeddings' | 'systemone'
  /** 泳道：primary=主端点就是 OpenRouter；fallback=本地失败后回退到 OpenRouter。 */
  lane: 'primary' | 'fallback'
  /** 发生调用的工作区桶名（dsh-plugins / genshin-ts / …）。 */
  bucket?: string
  /** 发生调用的会话 id（可选，decision 保底带，embed 目前不带）。 */
  session?: string
  /** OpenRouter 响应里的实际模型（可能与请求别名不同，如 baai/bge-m3 → BAAI/bge-m3）。 */
  model: string
  /** OpenRouter 响应里的 provider（DeepInfra / TypeSafe / …）。 */
  provider?: string
  /** OpenRouter generation id（gen-emb-* / gen-dec-*）。 */
  id?: string
  /** 输入 token 数（embeddings 的 prompt_tokens / systemone 的 input_tokens）。 */
  inputTokens?: number
  /** 输出 token 数（embeddings 通常 0；systemone 的 output_tokens）。 */
  outputTokens?: number
  /** 总 token 数（embeddings 的 total_tokens；systemone 可能缺省，由 input+output 推得）。 */
  totalTokens?: number
  /** OpenRouter 回报的本次花费（美元）。 */
  costUsd?: number
  /** 请求耗时（毫秒）。 */
  durationMs: number
  /** 成功 / 失败（失败通常无 usage，只做观测，不进花费合计）。 */
  status: 'ok' | 'error'
  /** 失败原因（status=error 时给到）。 */
  error?: string
}

/** 判断一个端点是不是 OpenRouter（按 URL，不看 key）；坏 URL 一律当不是，绝不抛。 */
export function isOpenRouterUrl(url: string): boolean {
  try {
    return /(^|\.)openrouter\.ai$/i.test(new URL(url).hostname)
  } catch {
    return false
  }
}

/** 台账文件路径：~/.dsh/memo-river/openrouter-usage.jsonl（全局一份，跨桶汇总用）。 */
export function openRouterLedgerPath(): string {
  return join(memoRiverRoot(), 'openrouter-usage.jsonl')
}

/** 追加一条调用记录；任何失败都静默（台账不影响主流程）。 */
export function appendOpenRouterUsage(record: OpenRouterUsageRecord): void {
  try {
    mkdirSync(memoRiverRoot(), { recursive: true })
    appendFileSync(openRouterLedgerPath(), JSON.stringify(record) + '\n', { flag: 'a' })
  } catch {
    /* 静默降级：台账失败不阻塞业务 */
  }
}

/** 把一条记录压成人可读的一行摘要，落在 memo-river.log 里。 */
export function formatOpenRouterUsageLine(record: OpenRouterUsageRecord): string {
  const tokens = [
    typeof record.inputTokens === 'number' ? `in=${record.inputTokens}` : null,
    typeof record.outputTokens === 'number' ? `out=${record.outputTokens}` : null,
    typeof record.totalTokens === 'number' ? `total=${record.totalTokens}` : null,
  ]
    .filter(Boolean)
    .join('/')
  const cost = typeof record.costUsd === 'number' ? `cost=$${record.costUsd.toExponential(3)}` : 'cost=n/a'
  const bucket = record.bucket ? `bucket=${record.bucket}` : 'bucket=-'
  const session = record.session ? ` session=${record.session}` : ''
  return (
    `openrouter-usage api=${record.api} lane=${record.lane} ${bucket} model=${record.model}` +
    `${record.provider ? ` provider=${record.provider}` : ''}${record.id ? ` id=${record.id}` : ''}${session}` +
    ` ${tokens} ${cost} elapsed=${record.durationMs}ms status=${record.status}` +
    `${record.error ? ` error=${JSON.stringify(record.error).slice(0, 120)}` : ''}`
  )
}
