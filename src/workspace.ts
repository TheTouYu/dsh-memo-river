/**
 * src/workspace.ts — 工作区级运行期：库 + 嵌入 + 原生引擎 + 召回。
 *
 * **工作区级（不是会话级）**：同一工作区的多个会话共享一份库与一份原生索引；
 * 会话级状态一律放 src/session.ts 的 Map（DESIGN.md §5.2 / §6.5）。
 */
import { existsSync } from 'node:fs'
import type { Config } from './config.js'
import { EmbedClient } from './embed.js'
import { MemoEngine, loadKnowledgeBaseManager } from './native.js'
import { Logger, ensureWorkspaceDirs, loadEnvFile, workspaceHash, workspacePaths, type WorkspacePaths } from './runtime.js'
import { KnowledgeStore } from './store.js'
import { recall, type RecallOptions, type RecallOutcome } from './recall.js'

export interface ResolvedEmbed {
  apiUrl: string
  apiKey: string
  model: string
  dimension: number
  /** 来源标注（取证用）：config / config.env / none。 */
  source: 'config' | 'config.env' | 'none'
}

export class WorkspaceRuntime {
  readonly logger: Logger
  readonly embed: EmbedClient
  readonly engine: MemoEngine
  private loaded = false
  private loadError: string | null = null
  /** 单飞：并发首次载入共享同一次 `engine.load()`（否则第二个调用者会把索引重建一遍，
   *  把第一个正在用的 `tagIndex`/`runtime` 换掉——与 memo 代际竞态同族）。 */
  private loading: Promise<boolean> | null = null

  private constructor(
    readonly paths: WorkspacePaths,
    readonly store: KnowledgeStore,
    readonly resolved: ResolvedEmbed,
    readonly config: Config,
  ) {
    this.logger = new Logger(paths.logPath)
    this.embed = new EmbedClient({
      apiUrl: resolved.apiUrl,
      apiKey: resolved.apiKey,
      model: resolved.model,
      dimension: resolved.dimension,
      cachePath: paths.embCachePath,
    })
    this.engine = new MemoEngine({
      vcpRoot: config.native.vcpRoot,
      dimension: resolved.dimension,
      modelSig: `${resolved.model}${config.native.modelSigSuffix}`,
      diaryName: paths.bucket,
      store: this.store,
    })
  }

  static open(cwd: string, config: Config): WorkspaceRuntime {
    const paths = workspacePaths(cwd, config.bucket, config.logFile || undefined)
    ensureWorkspaceDirs(paths)

    const resolved = resolveEmbed(config, paths)
    const store = new KnowledgeStore(paths.dbPath)
    const runtime = new WorkspaceRuntime(paths, store, resolved, config)
    runtime.logger.info(
      `workspace-open cwd=${cwd} hash=${paths.hash} bucket=${paths.bucket} db=${paths.dbPath} embed=${resolved.source}`,
    )
    return runtime
  }

  get corpusCounts(): { tags: number; files: number; chunks: number; fileTags: number } {
    return this.store.counts()
  }

  get isLoaded(): boolean {
    return this.loaded
  }

  /** 载入原生索引（幂等 + 单飞；失败只记一次错误并降级为不可召回）。 */
  async ensureLoaded(): Promise<boolean> {
    if (this.loaded) return true
    if (this.loadError !== null) return false
    if (this.loading) return this.loading
    const run = (async (): Promise<boolean> => {
      try {
        await this.engine.load()
        this.loaded = true
        this.logger.info(`native-loaded chunkIds=${this.engine.chunkIds.length} runtime=${this.engine.runtimeAvailable}`)
        return true
      } catch (e) {
        this.loadError = String((e as Error)?.message ?? e)
        this.logger.error(`native-load-failed: ${this.loadError}`)
        return false
      }
    })()
    this.loading = run
    try {
      return await run
    } finally {
      if (this.loading === run) this.loading = null
    }
  }

  /** 跑一次召回；永不抛（失败即 injected=false + fallbackReason）。 */
  async recall(queryText: string, options: RecallOptions): Promise<RecallOutcome> {
    const ok = await this.ensureLoaded()
    if (!ok) {
      return {
        injected: false,
        fallbackReason: `native-unavailable: ${this.loadError ?? 'unknown'}`,
        gate: {
          passed: false,
          maxKnn: 0,
          threshold: options.gateThreshold,
          enabled: options.gate,
          gateVector: 'none',
          retrievalMaxKnn: 0,
        },
        mode: options.mode,
        omega: null,
        regime: null,
        dynamicK: options.dynamicK,
        candidateCount: 0,
        candidates: [],
        selected: [],
        dropped: [],
        diagnostics: {},
        elapsedMs: 0,
      }
    }
    return recall(
      { store: this.store, embed: this.embed, engine: this.engine, dimension: this.resolved.dimension },
      queryText,
      options,
    )
  }

  close(): void {
    try {
      this.engine.dispose()
    } catch {
      /* 静默 */
    }
    this.store.close()
  }
}

/** 嵌入配置解析：插件 config 优先 → VCP config.env → 空（不可调用）。 */
export function resolveEmbed(config: Config, paths: WorkspacePaths): ResolvedEmbed {
  const envPath = config.native.configEnv || `${config.native.vcpRoot}/config.env`
  const env: Record<string, string> = existsSync(envPath) ? loadEnvFile(envPath) : {}
  const pick = (fromConfig: string, envKey: string): { value: string; from: 'config' | 'config.env' | 'none' } => {
    if (fromConfig && fromConfig.trim()) return { value: fromConfig.trim(), from: 'config' }
    const e = env[envKey]
    if (e && e.trim()) return { value: e.trim(), from: 'config.env' }
    return { value: '', from: 'none' }
  }
  const apiUrl = pick(config.embed.apiUrl, 'API_URL')
  const apiKey = pick(config.embed.apiKey, 'API_Key')
  const model = pick(config.embed.model, 'WhitelistEmbeddingModel')
  const envDim = Number(env.VECTORDB_DIMENSION)
  const dimension = config.embed.dimension || (Number.isFinite(envDim) && envDim > 0 ? envDim : 3072)
  const source: ResolvedEmbed['source'] =
    apiUrl.from === 'none' || apiKey.from === 'none' ? 'none' : apiKey.from === 'config' ? 'config' : 'config.env'
  return { apiUrl: apiUrl.value, apiKey: apiKey.value, model: model.value || 'gemini-embedding-2-preview', dimension, source }
}

/* ────────────── 工作区注册表（按 cwd 哈希键；会话状态不在此） ────────────── */

const registry = new Map<string, WorkspaceRuntime>()

export function acquireWorkspace(cwd: string, config: Config): WorkspaceRuntime {
  const key = workspaceHash(cwd)
  const existing = registry.get(key)
  if (existing) return existing
  const runtime = WorkspaceRuntime.open(cwd, config)
  registry.set(key, runtime)
  return runtime
}

export function releaseAllWorkspaces(): void {
  for (const runtime of registry.values()) runtime.close()
  registry.clear()
}

/** 读 VCP 的 KnowledgeBaseManager（体检报告里带上算法版本，便于溯源）。 */
export function algorithmVersion(vcpRoot: string): string {
  const kbm = loadKnowledgeBaseManager(vcpRoot)
  const v9 = kbm.v9
  if (v9 && typeof v9 === 'object' && typeof (v9 as Record<string, unknown>).algorithmVersion === 'string') {
    return String((v9 as Record<string, unknown>).algorithmVersion)
  }
  return 'unknown'
}
