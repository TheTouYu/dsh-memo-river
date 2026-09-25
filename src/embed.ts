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

/**
 * 单次调用可覆盖项（票 01：注入路径短超时；票 03：写路径短超时 + 重试）。
 * 同一客户端上按调用收紧预算——被动注入把查询向量 + 门控锚合批后用 ~3s 硬顶；
 * 写路径（memo_write 族）传 WRITE_EMBED_OPTIONS（15s + 重试 1 次）。
 */
export interface EmbedCallOptions {
  /** 覆盖构造时的 timeoutMs（缺省 = 用客户端默认）。 */
  timeoutMs?: number
  /** 失败重试次数（票 03；缺省 0 = 不重试）。立即重试、无退避——保住「超时×(1+retries)」的墙钟硬顶。 */
  retries?: number
}

/**
 * 票 03 写路径嵌入预算：单次尝试 15s + 失败重试 1 次 → 尾部硬顶 ~30s。
 * 由头：09-15 实测 memo_write 离群 120s×2（60s 默认超时 × 串行两调用）——收紧到 15s
 * 后最坏 15+15=30s 封顶，且仍失败时调用方（writeDiaryCore）明确报错返回、不悬挂。
 */
export const WRITE_EMBED_TIMEOUT_MS = 15_000
export const WRITE_EMBED_RETRIES = 1
export const WRITE_EMBED_OPTIONS: EmbedCallOptions = {
  timeoutMs: WRITE_EMBED_TIMEOUT_MS,
  retries: WRITE_EMBED_RETRIES,
}

const BATCH_SIZE = 32
const CONCURRENCY = Number(process.env.TAG_VECTORIZE_CONCURRENCY) || 5

/* ────────────── 传输层（票 02）：undici Agent 连接保活 ──────────────
 *
 * 默认 fetch（Node 内置 undici 全局 dispatcher）keepAliveTimeout 只有 4s——
 * 「轮与轮之间」TLS 连接早已拆掉，每次注入重付 connect ~0.4s + TLS 握手 ~0.8s
 * （09-15 实测：单条 RTT 1.19–1.45s 里的大头）。这里换成**进程级共享**的 undici
 * Agent：keepAliveTimeout 提到 ~4 分钟（TAG_EMBED_KEEPALIVE_MS 可配），同端点
 * 连续调用复用已建连接，第二次起省下整套握手。
 *
 * · 有效复用窗口 = min(客户端 keepAliveTimeout, 服务端 Keep-Alive hint − 1s)：
 *   上游（relay/CDN）hint ~90s 时实际窗口 ~89s——仍远大于 4s 基线。
 * · 空闲超窗后 undici 自行拆除连接，下一次请求自动重建、不报错（探针已验证）。
 * · undici 不可解析的环境（依赖被裁/未装）→ 回退全局 fetch（现状 4s keepalive），
 *   只 warn 一次，插件不崩。
 * · TAG_EMBED_CONN_LOG=1 时输出 embed-transport connect/disconnect 调试日志
 *   （票 02 验收取证通道：证明连续两次调用只建一次连接）。 */

export const DEFAULT_KEEPALIVE_MS = 240_000
export const DEFAULT_TRANSPORT_CONNECTIONS = 16

const keepAliveMs = Number(process.env.TAG_EMBED_KEEPALIVE_MS) || DEFAULT_KEEPALIVE_MS
const transportConnections = Number(process.env.TAG_EMBED_CONNECTIONS) || DEFAULT_TRANSPORT_CONNECTIONS

/** undici 包的静态形状（仅类型；运行期动态导入，失败可回退全局 fetch）。 */
type UndiciModule = typeof import('undici')

interface TransportResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
}

interface Transport {
  fetch: (url: string, init: Record<string, unknown>) => Promise<TransportResponse>
  /** undici Agent（回退路径为 null，init 不带 dispatcher）。 */
  agent: unknown
  /** 取证/日志用描述。 */
  summary: string
}

let sharedAgent: import('undici').Dispatcher | null = null
let transportReady: Promise<Transport> | null = null

type TransportLogger = { warn(msg: string): void; info(msg: string): void } | undefined

/**
 * 要用的 HTTP 代理，未配置时 `undefined`（直连）。
 *
 * 这里必须显式包装 `ProxyAgent`，**光 export `https_proxy` 没用**：Node 的
 * `NODE_USE_ENV_PROXY` 在 undici 的**全局 dispatcher** 那一层生效，而本模块为了
 * keep-alive 给每个请求都传自己的 `dispatcher`，那一层就被整个盖掉了。死代理判据
 * 实测（同进程、`https_proxy=http://127.0.0.1:9`）：不带 dispatcher 的 `fetch` 抛
 * ECONNREFUSED（走了代理），带 `dispatcher: new Agent(...)` 的却成功 200（绕过了）。
 *
 * 只认 http/https：undici 的 `ProxyAgent` 不实现 SOCKS，把 `all_proxy=socks5://…`
 * 传进去只会让每次请求都失败——那种情况宁可直连，也不要静默全灭。
 */
function resolveProxyUrl(): string | undefined {
  const raw =
    // 专用开关优先：它只影响嵌入这一条链路，不动 LLM 那条。国内模型端点
    // （api.deepseek.com）塞进境外代理只会更慢甚至失败，所以默认不认全局
    // `https_proxy`，要全进程生效得显式打开 TAG_EMBED_PROXY_FROM_ENV=1。
    process.env.TAG_EMBED_PROXY ??
    (process.env.TAG_EMBED_PROXY_FROM_ENV === '1'
      ? process.env.https_proxy ??
        process.env.HTTPS_PROXY ??
        process.env.http_proxy ??
        process.env.HTTP_PROXY ??
        process.env.all_proxy ??
        process.env.ALL_PROXY
      : undefined)
  if (raw === undefined) return undefined
  const url = raw.trim()
  if (url === '') return undefined
  return /^https?:\/\//i.test(url) ? url : undefined
}

function ensureTransport(logger: TransportLogger): Promise<Transport> {
  if (!transportReady) {
    transportReady = import('undici').then(
      (m: UndiciModule) => {
        const proxyUrl = resolveProxyUrl()
        const agentOptions = {
          keepAliveTimeout: keepAliveMs,
          keepAliveMaxTimeout: Math.max(600_000, keepAliveMs + 1_000),
          connections: transportConnections,
        }
        sharedAgent = proxyUrl === undefined ? new m.Agent(agentOptions) : new m.ProxyAgent({ uri: proxyUrl, ...agentOptions })
        if (process.env.TAG_EMBED_CONN_LOG === '1') {
          // debug 级连接日志：本地无计数 server 时的取证通道。
          // ProxyAgent 不保证发这两个事件，拿不到就跳过，不影响主流程。
          const emitter = sharedAgent as unknown as { on?: (e: string, h: (o: unknown) => void) => void }
          emitter.on?.('connect', (origin: unknown) => logger?.info(`embed-transport connect origin=${String(origin)}`))
          emitter.on?.('disconnect', (origin: unknown) =>
            logger?.info(`embed-transport disconnect origin=${String(origin)}`),
          )
        }
        return {
          fetch: m.fetch as unknown as Transport['fetch'],
          agent: sharedAgent,
          summary:
            proxyUrl === undefined
              ? `undici(keepAlive=${keepAliveMs}ms,connections=${transportConnections})`
              : `undici+proxy(uri=${proxyUrl},keepAlive=${keepAliveMs}ms,connections=${transportConnections})`,
        }
      },
      (e: unknown) => {
        logger?.warn(`undici 不可用，嵌入传输回退默认 fetch（keepAlive 4s）: ${String((e as Error)?.message ?? e)}`)
        const fallback: Transport['fetch'] = (url, init) => {
          const { dispatcher: _unused, ...rest } = init
          return globalThis.fetch(url, rest as RequestInit) as Promise<TransportResponse>
        }
        return { fetch: fallback, agent: null, summary: 'default-fetch(keepAlive=4s)' }
      },
    )
  }
  return transportReady
}

/** 纯描述（不触发懒加载）：workspace-open 日志打点用。 */
export function embedTransportIntent(): string {
  const proxyUrl = resolveProxyUrl()
  return proxyUrl === undefined
    ? `undici(keepAlive=${keepAliveMs}ms,connections=${transportConnections})`
    : `undici+proxy(uri=${proxyUrl},keepAlive=${keepAliveMs}ms,connections=${transportConnections})`
}

/** 释放共享 Agent（插件卸载/进程收尾用；fire-and-forget，不阻塞调用方）。 */
export function closeEmbedTransport(): void {
  const agent = sharedAgent
  sharedAgent = null
  transportReady = null
  if (agent) void agent.close().catch(() => {})
}

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

  /** 文本 → 向量（含缓存）。任何失败都抛出，由调用方降级为「不注入 + 记日志」。
   * callOpts：票 01 注入路径短超时 / 票 03 写路径短超时+重试；缺省保持原行为（60s、不重试）。 */
  async embed(texts: readonly string[], callOpts?: EmbedCallOptions): Promise<Float32Array[]> {
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
          results[myIndex] = await this.requestWithRetry(batches[myIndex]!, callOpts)
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

  /** 票 03：按 callOpts.retries 立即重试（无退避，保住墙钟硬顶）；重试耗尽抛最后一次错误。 */
  private async requestWithRetry(batch: string[], callOpts?: EmbedCallOptions): Promise<Float32Array[]> {
    const retries = callOpts?.retries ?? 0
    let lastErr: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.requestBatch(batch, callOpts?.timeoutMs)
      } catch (e) {
        lastErr = e
      }
    }
    throw lastErr
  }

  private async requestBatch(batch: string[], timeoutMs?: number): Promise<Float32Array[]> {
    const url = `${this.options.apiUrl}/v1/embeddings`
    const transport = await ensureTransport(this.options.logger)
    const init: Record<string, unknown> = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify({ model: this.options.model, input: batch }),
      signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
    }
    if (transport.agent) init.dispatcher = transport.agent
    let response: TransportResponse
    try {
      response = await transport.fetch(url, init)
    } catch (e) {
      // 票 01：AbortSignal.timeout 触发的是 DOMException(name='TimeoutError')，一旦被包成
      // 普通 Error，name 就丢了——必须就地分类打标，调用方（recall）才能把 embed-timeout
      // 与普通网络失败区分开落日志（inject-skip reason=embed-timeout）。
      // 票 02：undici fetch 把网络层错误包成 TypeError('fetch failed')，真因在 cause——
      // 展开进日志，否则死端点/断网只看到一句 fetch failed。
      const err = e as Error & { cause?: unknown }
      const causeMsg = err?.cause ? ` (cause: ${String((err.cause as Error)?.message ?? err.cause)})` : ''
      const msg = `${String(err?.message ?? e)}${causeMsg}`
      const timedOut = err?.name === 'TimeoutError' || /aborted due to timeout/i.test(msg)
      this.lastError = `${timedOut ? 'embed-timeout' : 'embed-request-failed'}: ${msg}`
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
