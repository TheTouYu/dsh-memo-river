/**
 * src/recall.ts — 召回管线：查询场 → 门控 → 原生观测 → 读出 → 低基数门限 → 预算截断。
 *
 * 对应 DESIGN.md §4「请求前」的 ①–④ 与 §6.3 的门控/预算表。
 * 这里是**纯计算层**：不碰 DSH 上下文、不注入、不落库，全部输入显式传入，
 * 因此可以被验收脚本直接驱动（§10 #3 #4 #5 #8 #9）。
 */
import type { ReadoutMode } from './config.js'
import { cosine, type EmbedClient } from './embed.js'
import { estimateTokens, firstSentence } from './runtime.js'
import type { MemoEngine } from './native.js'
import type { KnowledgeStore } from './store.js'

export interface RecallCandidate {
  /** chunk id（VCP 里就是日记的 D<id>）。 */
  id: number
  fileId: number
  /** 写入时间戳（files.updated_at，毫秒；老数据可能为 null → 退回标题日期）。 */
  writtenAt: number | null
  /** 标题（文件名去扩展名）。 */
  title: string
  diaryName: string
  /** 纯 KNN 余弦基线（决定低基数门限）。 */
  knnScore: number
  /** 读出后的有效分数（已应用低基数门限）。 */
  score: number
  /** 原生读出原始分数（未应用低基数门限，取证用）。 */
  rawScore: number
  role: string
  anchorBonus: number
  topologyBonus: number
  omega: number | null
  riverRegime: string | null
  matchedTags: string[]
  /** §2.2 规则 4：KNN 低于门限 → 不发放结构奖励。 */
  rewardSuppressed: boolean
  body: string
}

export interface RecallOutcome {
  injected: boolean
  /** 未注入原因（§6.3：门控不过 → 清空 + fallbackReason）。 */
  fallbackReason: string | null
  gate: {
    passed: boolean
    /** 门控实际比对的 maxKnn（gateVector=current 时来自当前消息，否则来自检索向量）。 */
    maxKnn: number
    threshold: number
    enabled: boolean
    /** 门控向量来源：current=当前消息 / window=检索窗口 / none=未算（门控关闭或未传 gateText）。 */
    gateVector: 'current' | 'window' | 'none'
    /** 检索向量的 maxKnn（取证用；不参与门控判定）。 */
    retrievalMaxKnn: number
  }
  mode: ReadoutMode
  omega: number | null
  regime: string | null
  dynamicK: number
  candidateCount: number
  /** 全部候选（读出后，未截断）。 */
  candidates: RecallCandidate[]
  /** 最终进入注入的候选。 */
  selected: RecallCandidate[]
  /** 被截断/丢弃的候选（§6.2「未注入说明」的素材）。 */
  dropped: Array<{ id: number; title: string; reason: string }>
  diagnostics: Record<string, unknown>
  elapsedMs: number
}

/** 从日记标题（文件名含 YYYY-MM-DD 前缀）解析当日 0 点时间戳；解析不出返回 0。 */
function diaryDateMs(title: string): number {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(title)
  if (!m) return 0
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`)
  return Number.isFinite(ms) ? ms : 0
}

export interface RecallOptions {
  mode: ReadoutMode
  k: number
  tokenBudget: number
  dynamicK: number
  gate: boolean
  gateThreshold: number
  minKnnForReward: number
  /** 近因保底天数：最近 N 天内的最新日记被 k-limit/预算挤出入选集时保留一席（0/缺省 = 关闭）。 */
  recencyFloorDays?: number
  /** 查询 id（诊断/日志用；必须按会话/轮次唯一）。 */
  queryId: string
  /**
   * 门控专用文本（**当前这条用户消息**）。
   *
   * 与 queryText 解耦：queryText 是窗口拼接（回答"这段对话在讲什么"），
   * gateText 是当前消息本身（回答"这句话本身相不相关"）。
   * 不传则退回旧行为：门控拿检索向量比对（在 w≥2 时无判别力，见 config.ts 的实测注释）。
   */
  gateText?: string
  coreTags?: string[]
  ghostTags?: string[]
}

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)

/** 单篇日记的标题：文件名去扩展名（native.cjs 用 path.basename）。 */
function titleOf(p: string): string {
  const base = p.replace(/\\/g, '/').split('/').pop() ?? p
  return base.replace(/\.[^.]+$/, '')
}

/**
 * 构造查询场文本（DESIGN §4 ①「取本会话最近 N 条消息 → 构造查询场」）。
 * 从最近往回收，累计到 lookback 条；空消息跳过。
 */
export function buildQueryField(recentTexts: readonly string[], lookback: number): string {
  const picked: string[] = []
  for (let i = recentTexts.length - 1; i >= 0 && picked.length < lookback; i--) {
    const text = (recentTexts[i] ?? '').trim()
    if (text) picked.unshift(text)
  }
  return picked.join('\n').slice(-4000)
}

/**
 * 跑一次召回。**只在拿得到向量与原生观测时才返回 candidates**；
 * 任何一步失败都返回 `injected=false` + `fallbackReason`，绝不抛（§6.5 降级纪律）。
 */
export async function recall(
  deps: { store: KnowledgeStore; embed: EmbedClient; engine: MemoEngine; dimension: number },
  queryText: string,
  options: RecallOptions,
): Promise<RecallOutcome> {
  const started = Date.now()
  const { store, embed, engine, dimension } = deps
  const empty = (fallbackReason: string, extra?: Partial<RecallOutcome>): RecallOutcome => ({
    injected: false,
    fallbackReason,
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
    elapsedMs: Date.now() - started,
    ...extra,
  })

  if (!queryText.trim()) return empty('empty-query')

  /* ① 查询场向量 */
  let queryVector: Float32Array
  try {
    const [vec] = await embed.embed([queryText])
    if (!vec) return empty('embed-empty')
    queryVector = vec
  } catch (e) {
    // 验收 #9：拔掉嵌入 API → 跳过注入 + 记日志，主流程不受影响。
    return empty(`embed-failed: ${str((e as Error)?.message, 'unknown')}`)
  }

  /* KNN 基线（决定门控与低基数门限） */
  const chunks = store.chunks().filter((c) => c.vector !== null)
  if (chunks.length === 0) return empty('empty-corpus')
  const owners = store.chunkOwners()
  const knn = chunks
    .map((c) => ({ id: c.id, score: cosine(queryVector, c.vector!.subarray(0, dimension)) }))
    .sort((a, b) => b.score - a.score)
  const knnById = new Map(knn.map((c) => [c.id, c.score]))
  const retrievalMaxKnn = knn[0]?.score ?? 0

  /* ①b 门控向量（与检索窗口解耦）
   *
   * 为什么必须解耦：检索向量是窗口拼接，拼接越长越靠近语料质心，任何查询的 maxKnn 都被抬高。
   * 实测（config.ts inject.gateOnCurrentMessage 注释里有完整数据）：
   *   无关末轮 w1=0.45~0.51 全不过，w2 起 0.57~0.78 全部误通过；
   *   相关末轮 w1=0.6525 已过。
   * 所以门控只拿当前这条用户消息的向量；拿不到就退回检索向量并记录（不阻塞主流程）。 */
  const diagnostics: Record<string, unknown> = {}
  let gateMaxKnn = retrievalMaxKnn
  let gateVector: 'current' | 'window' = 'window'
  const gateText = (options.gateText ?? '').trim()
  if (options.gate && gateText && gateText !== queryText.trim()) {
    try {
      const [gvec] = await embed.embed([gateText])
      if (gvec) {
        let m = 0
        for (const c of chunks) {
          const s = cosine(gvec, c.vector!.subarray(0, dimension))
          if (s > m) m = s
        }
        gateMaxKnn = m
        gateVector = 'current'
      }
    } catch (e) {
      // 降级：门控退回检索向量判定（§6.5 失败降级为"不阻塞 + 记日志"）
      diagnostics.gateEmbedFailed = str((e as Error)?.message, 'unknown')
    }
  }

  /* ② 门控（§6.3：不达标 → 清空不注入） */
  if (options.gate && gateMaxKnn < options.gateThreshold) {
    return empty('gate-below-threshold', {
      gate: { passed: false, maxKnn: gateMaxKnn, threshold: options.gateThreshold, enabled: true, gateVector, retrievalMaxKnn },
      candidateCount: knn.length,
      diagnostics: { ...diagnostics, maxKnn: gateMaxKnn, retrievalMaxKnn, gateVector, gateThreshold: options.gateThreshold },
    })
  }

  /* ③ 原生观测（runMemoPipeline）+ ④ 读出（topology_v3 / rivermemo / dtsc）
   *
   * 整段**必须**待在 `engine.runExclusive` 临界区里：Rust 侧 memo runtime 只认一个活动代际，
   * 两个会话并发召回时若把 `ensureArtifact` 与 `runPipeline` 交错，先建好的 sig 会被
   * 后一次重建顶掉，流水线报 `memo runtime artifact <sig> is not the active generation`。
   * 实测症状：串行两会话都注入、并发只注入一个。
   * 临界区只覆盖碰原生的部分；其后的打分/门控/截断/渲染是纯 JS，留在队列外以缩短持锁时间。 */
  let meta: Record<string, unknown> = {}
  let readout: Record<string, unknown> = {}
  let pipelineElapsedMs = 0
  try {
    const observed = await engine.runExclusive(async () => {
      if (!engine.isLoaded) await engine.load()
      await engine.ensureArtifactLocked()
      const pipe = await engine.runPipeline(
        options.queryId,
        queryText,
        queryVector,
        options.coreTags ?? [],
        options.ghostTags ?? [],
      )
      const handle = pipe.metadata.observationHandle
      if (typeof handle !== 'string' || !handle) {
        return { meta: pipe.metadata, readout: {}, elapsedMs: pipe.elapsedMs, missingHandle: true }
      }

      const cands = knn.map((c) => ({ id: c.id, score: c.score }))
      let out: Record<string, unknown> = {}
      if (options.mode === 'dtsc' || options.mode === 'topology_v3' || options.mode === 'rivermemo') {
        out =
          options.mode === 'dtsc'
            ? await engine.rerankDtsc(handle, { epa: pipe.metadata.epa ?? {}, pyramid: pipe.metadata.pyramid ?? {} }, cands)
            : await engine.rerankTopologyV3(options.queryId, queryText, handle, pipe.metadata, cands)
      }
      return { meta: pipe.metadata, readout: out, elapsedMs: pipe.elapsedMs }
    })
    if (observed.missingHandle) {
      return empty('no-observation-handle', { diagnostics: { keys: Object.keys(observed.meta) } })
    }
    meta = observed.meta
    readout = observed.readout
    pipelineElapsedMs = observed.elapsedMs

    const candidates = knn.map((c) => ({ id: c.id, score: c.score }))
    const results: Array<Record<string, unknown>> = Array.isArray(readout.results)
      ? (readout.results as Array<Record<string, unknown>>)
      : []
    // 读出无结果时退回 KNN 基线（tagmemo 模式就是这条）
    const rows: RecallCandidate[] = (results.length > 0
      ? results
      : candidates.map((c): Record<string, unknown> => ({ chunkId: c.id, score: c.score }))
    )
      .map((r) => {
        const id = num(r.chunkId ?? r.id, -1)
        const owner = owners.get(id)
        const chunk = chunks.find((c) => c.id === id)
        const knnScore = knnById.get(id) ?? 0
        const rawScore = num(r.score, knnScore)
        const rewardSuppressed = knnScore < options.minKnnForReward
        const matched = Array.isArray(r.matchedTags) ? (r.matchedTags as unknown[]).map((t) => String(t)) : []
        return {
          id,
          fileId: owner?.fileId ?? -1,
          writtenAt: owner?.writtenAt ?? null,
          title: owner ? titleOf(owner.path) : `D${id}`,
          diaryName: owner?.diaryName ?? '',
          knnScore,
          // §2.2 规则 4：低基数候选不发放结构奖励（把分数还原为 KNN，消除封顶偏置）
          score: rewardSuppressed ? knnScore : rawScore,
          rawScore,
          role: str(r.role, 'unranked'),
          anchorBonus: num(r.anchorBonus),
          topologyBonus: num(r.topologyBonus),
          omega: typeof r.omega === 'number' ? r.omega : null,
          riverRegime: typeof r.riverRegime === 'string' ? r.riverRegime : null,
          matchedTags: matched,
          rewardSuppressed,
          body: chunk?.content ?? '',
        }
      })
      .filter((r) => r.id >= 0)
      .sort((a, b) => b.score - a.score)

    if (rows.length === 0) return empty('no-candidates', { candidateCount: knn.length })

    /* ⑤ 动态 K（倍率）+ 预算截断（::Truncate：保 role 与首句） */
    const kEff = Math.max(1, Math.round(options.k * Math.max(0, options.dynamicK)))
    const dropped: Array<{ id: number; title: string; reason: string }> = []
    const selected: RecallCandidate[] = []
    let used = 0
    for (const row of rows) {
      if (selected.length >= kEff) {
        dropped.push({ id: row.id, title: row.title, reason: 'k-limit' })
        continue
      }
      const cost = estimateTokens(row.body) + estimateTokens(row.title) + 24
      if (used + cost > options.tokenBudget) {
        // `::Truncate` 语义：保 role 与首句
        const trimmed = firstSentence(row.body)
        const trimCost = estimateTokens(trimmed) + estimateTokens(row.title) + 24
        if (used + trimCost <= options.tokenBudget) {
          selected.push({ ...row, body: trimmed })
          used += trimCost
          dropped.push({ id: row.id, title: row.title, reason: 'truncated-to-first-sentence' })
          continue
        }
        dropped.push({ id: row.id, title: row.title, reason: 'token-budget' })
        continue
      }
      selected.push(row)
      used += cost
    }

    /* ⑥ 近因保底（recency floor）：k-limit/预算把最近 N 天内的最新日记挤出入选集时，
       给它保留一席——挤掉分数最低席，绝不挤 top1；入选集不足 2 席（唯一位）时不启动。
       新鲜度判据 = 写入时间戳（files.updated_at，毫秒）——标题日期只有天粒度，
       同日平局会按分数序取「最新那天里分数最高的」，把真正最新写的挤掉（2026-09-14 生产实锤：
       3 分钟前刚写的 D19 落选）。时间戳缺失（老数据）退回标题日期。 */
    if ((options.recencyFloorDays ?? 0) > 0 && selected.length >= 2) {
      const stampOf = (r: RecallCandidate): number => r.writtenAt ?? diaryDateMs(r.title)
      const dated = rows.filter((r) => stampOf(r) > 0)
      if (dated.length > 0) {
        const freshest = dated.reduce((a, b) => (stampOf(a) >= stampOf(b) ? a : b))
        const ageMs = Date.now() - stampOf(freshest)
        const floorMs = (options.recencyFloorDays ?? 0) * 86_400_000
        if (ageMs >= 0 && ageMs <= floorMs && !selected.some((s) => s.fileId === freshest.fileId)) {
          const evicted = selected[selected.length - 1]!
          selected.pop()
          used -= estimateTokens(evicted.body) + estimateTokens(evicted.title) + 24
          dropped.push({ id: evicted.id, title: evicted.title, reason: 'recency-floor-evicted' })
          const fullCost = estimateTokens(freshest.body) + estimateTokens(freshest.title) + 24
          if (used + fullCost <= options.tokenBudget) {
            selected.push(freshest)
            used += fullCost
          } else {
            const trimmed = firstSentence(freshest.body)
            selected.push({ ...freshest, body: trimmed })
            used += estimateTokens(trimmed) + estimateTokens(freshest.title) + 24
            dropped.push({ id: freshest.id, title: freshest.title, reason: 'truncated-to-first-sentence' })
          }
        }
      }
    }

    // 读出的 Ω 有两种形状：数字，或 {omega, omegaEdge, omegaEmerge, omegaFlow, regime, ...} 观测包
    // （§2.3 的 Ω 公式在 riverObservability 上）。两种都要吃得下。
    let omegaValue: number | null = null
    let regimeValue = ''
    const rawOmega = readout.omega
    if (typeof rawOmega === 'number' && Number.isFinite(rawOmega)) {
      omegaValue = rawOmega
    } else if (rawOmega && typeof rawOmega === 'object') {
      const o = rawOmega as Record<string, unknown>
      if (typeof o.omega === 'number' && Number.isFinite(o.omega)) omegaValue = o.omega
      regimeValue = str(o.regime, '')
    }
    if (!regimeValue) {
      const omegaStats = readout.omegaStats
      if (omegaStats && typeof omegaStats === 'object') regimeValue = str((omegaStats as Record<string, unknown>).regime, '')
    }
    regimeValue = regimeValue || str(readout.regime, '') || rows[0]?.riverRegime || ''

    return {
      injected: selected.length > 0,
      fallbackReason: selected.length === 0 ? 'budget-exhausted' : null,
      gate: {
        passed: true,
        maxKnn: gateMaxKnn,
        threshold: options.gateThreshold,
        enabled: options.gate,
        gateVector: options.gate ? gateVector : 'none',
        retrievalMaxKnn,
      },
      mode: options.mode,
      omega: omegaValue,
      regime: regimeValue || null,
      dynamicK: options.dynamicK,
      candidateCount: rows.length,
      candidates: rows,
      selected,
      dropped,
      diagnostics: {
        ...diagnostics,
        gateVector: options.gate ? gateVector : 'none',
        gateMaxKnn,
        retrievalMaxKnn,
        pipelineElapsedMs,
        readoutDiagnostics: readout.diagnostics ?? null,
        fieldTrusted: (meta.diagnostics as Record<string, unknown> | undefined)?.fieldTrusted ?? null,
        fieldEntropy: (meta.diagnostics as Record<string, unknown> | undefined)?.fieldEntropy ?? null,
        enhancedVectorCos: 0,
        artifactSig: engine.artifactState?.artifactSig ?? null,
      },
      elapsedMs: Date.now() - started,
    }
  } catch (e) {
    return empty(`native-failed: ${str((e as Error)?.message, 'unknown')}`)
  }
}
