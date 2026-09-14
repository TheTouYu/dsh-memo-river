/**
 * src/embed.ts — 嵌入客户端，**复用 `/home/h/app/VCPToolBox/EmbeddingUtils.js` 的调用形状**。
 *
 * 该形状（逐条照抄，见 VCPToolBox/EmbeddingUtils.js）：
 *   · requestUrl = `${config.apiUrl}/v1/embeddings`（**apiUrl 不带 /v1**）
 *   · POST body  = { model, input: batchTexts }
 *   · headers    = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }
 *   · response.data 按 index 排序后取 `item.embedding`
 *   · 每批 32 条，并发 TAG_VECTORIZE_CONCURRENCY || 5
 *
 * 命中缓存不重复消耗额度（DESIGN.md §9「嵌入缓存：emb-cache.json」）。
 */
import { estimateTokens, readJsonSafe, writeJsonSafe } from './runtime.js'

export interface EmbedClientOptions {
  apiUrl: string
  apiKey: string
  model: string
  dimension: number
  cachePath: string
  /** 单次请求超时（ms）。 */
  timeoutMs?: number
  logger?: { warn(msg: string): void; info(msg: string): void }
}

const BATCH_SIZE = 32
const CONCURRENCY = Number(process.env.TAG_VECTORIZE_CONCURRENCY) || 5

type Cache = Record<string, number[]>

export class EmbedClient {
  private cache: Cache
  private dirty = false
  private readonly timeoutMs: number

  /** 上一次失败原因（体检 / fallbackReason 取证用）。 */
  lastError: string | null = null

  constructor(private readonly options: EmbedClientOptions) {
    this.cache = readJsonSafe<Cache>(options.cachePath, {})
    this.timeoutMs = options.timeoutMs ?? 60_000
  }

  get cacheSize(): number {
    return Object.keys(this.cache).length
  }

  /** 配置是否足以调用远端。 */
  get configured(): boolean {
    return Boolean(this.options.apiUrl && this.options.apiKey)
  }

  /** 文本 → 向量（含缓存）。任何失败都抛出，由调用方降级为「不注入 + 记日志」。 */
  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (!this.configured) throw new Error('embed-not-configured (apiUrl/apiKey 为空)')
    const out: Array<Float32Array | undefined> = new Array(texts.length)
    const missing: string[] = []
    const missingIndex = new Map<string, number[]>()

    texts.forEach((text, i) => {
      const hit = this.cache[text]
      if (hit && hit.length === this.options.dimension) {
        out[i] = Float32Array.from(hit)
        return
      }
      const list = missingIndex.get(text)
      if (list) list.push(i)
      else {
        missingIndex.set(text, [i])
        missing.push(text)
      }
    })

    if (missing.length > 0) {
      const batches: string[][] = []
      for (let i = 0; i < missing.length; i += BATCH_SIZE) batches.push(missing.slice(i, i + BATCH_SIZE))

      const results: Float32Array[][] = new Array(batches.length)
      let cursor = 0
      const workers = Array.from({ length: Math.min(CONCURRENCY, batches.length) }, async () => {
        while (cursor < batches.length) {
          const myIndex = cursor++
          results[myIndex] = await this.requestBatch(batches[myIndex]!)
        }
      })
      await Promise.all(workers)

      results.forEach((vectors, b) => {
        const batch = batches[b]!
        vectors.forEach((vec, j) => {
          const text = batch[j]!
          for (const i of missingIndex.get(text) ?? []) out[i] = vec
          this.cache[text] = Array.from(vec)
          this.dirty = true
        })
      })
      this.flush()
    }

    return out.map((vec, i) => {
      if (!vec) throw new Error(`embed-missing-result at index ${i}`)
      return vec
    })
  }

  private async requestBatch(batch: string[]): Promise<Float32Array[]> {
    const url = `${this.options.apiUrl}/v1/embeddings`
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({ model: this.options.model, input: batch }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (e) {
      this.lastError = `embed-request-failed: ${String((e as Error)?.message ?? e)}`
      throw new Error(this.lastError)
    }
    if (!response.ok) {
      this.lastError = `embed-http-${response.status}`
      throw new Error(`${this.lastError}: ${(await response.text().catch(() => '')).slice(0, 200)}`)
    }
    const payload = (await response.json()) as { data?: Array<{ index?: number; embedding?: number[] }> }
    const rows = [...(payload.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    if (rows.length !== batch.length) {
      this.lastError = `embed-count-mismatch ${rows.length}!=${batch.length}`
      throw new Error(this.lastError)
    }
    this.lastError = null
    return rows.map((row, i) => {
      const embedding = row.embedding
      if (!Array.isArray(embedding)) throw new Error(`embed-empty-slot at ${i}`)
      if (embedding.length !== this.options.dimension) {
        throw new Error(`embed-dim-mismatch got ${embedding.length} want ${this.options.dimension}`)
      }
      return Float32Array.from(embedding)
    })
  }

  private flush(): void {
    if (!this.dirty) return
    this.dirty = false
    writeJsonSafe(this.options.cachePath, this.cache)
  }

  /** 估算一次调用的输入体量（日志用）。 */
  estimateInput(texts: readonly string[]): number {
    return texts.reduce((sum, t) => sum + estimateTokens(t), 0)
  }
}

/** 余弦相似度（与 native.cjs 同一实现，用于门控与 KNN 基线）。 */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i]!
    const y = b[i]!
    dot += x * y
    na += x * x
    nb += y * y
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0
}
