/**
 * decision.ts — P0b 判别式决策重排的 8122 客户端与纯函数（2026-10-16）。
 *
 * 服务契约（与离线 ⑥ 口径**逐字一致**，生产一致性 |ΔP@3 macro|=0.0000，见
 * research/recall-effect/gate2-service-parity.md 与 /home/h/cd-exp/run_gate2.py:87）：
 *   POST /v1/choice
 *   {
 *     "state_zh": "当前任务上下文：\n{state}\n\n候选记忆（{d}｜{title}）：\n{body}",
 *     "options": [{"key":"false","desc":"否"},{"key":"true","desc":"是"}],
 *     "append_none": false,                     ← 必带！缺省 true 追加逃生位 ⇒ K+1 路 softmax ≠ 验证过的 2 路
 *     "instructions": "读了这条候选记忆之后，会改变当前任务接下来的做法吗？"
 *   }
 *   响应 { probs:{"false":…,"true":…}, ranked:[…], instructions_used:"…" }，读数 = probs["true"]。
 *
 * ⚠️ 任何一件不同（模板换行、body 截断口径、options 文案、append_none）就是不同的
 * prompt、不同的数——改这里必须重过 gate2 一致性，不许「看着差不多」。
 *
 * 延迟预算（父会话 2026-10-16 实测指令）：单条 p50=94/p95=211/p99=243ms；k=3 串行最坏
 * ≈730ms 逼近 800ms 客户端预算 ⇒ **并发 ≤2**（DECISION_MAX_CONCURRENCY）、**超时不重试**
 * （重试把预算吃两遍）、整批 deadline 到点后**不再发新请求**（降 topN/并发，不硬撑）。
 *
 * 降级铁律：本模块任何失败（超时/拒连/非 2xx/坏 JSON/坏形状）→ 返回 null / 空结果并
 * `decision-error` 记因，**绝不抛出**——调用方（injector 接缝）保原序注入。
 */

/** ⑥ 主问法（run_gate2.py QUESTIONS['q_changes']，与 gate-results.jsonl 同文案保证可比）。 */
export const DECISION_INSTRUCTION = '读了这条候选记忆之后，会改变当前任务接下来的做法吗？'
/** 候选正文截断口径：build_tests.py BODY_CHARS 缺省 600（非空行 join(' ') 后取前 600 字）。 */
export const DECISION_BODY_CHARS = 600
/** 空上下文判据：61/185 state 空时 AUC 掉 0.43-0.66 ⇒ 短于此长度跳过打分。 */
export const DECISION_MIN_STATE_CHARS = 16
/** 并发上限（延迟预算：k=3 串行最坏 ≈3×p99≈730ms；≤2 并发把最坏压到 ≈2×p99）。 */
export const DECISION_MAX_CONCURRENCY = 2

export interface DecisionLoggerLike {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface DecisionClientOptions {
  /** 服务基址（如 http://127.0.0.1:8122），请求打到 `${endpoint}/v1/choice`。 */
  endpoint: string
  /** 单请求超时；批模式下兼作整批 deadline（到点不再发新请求）。 */
  timeoutMs: number
  logger?: DecisionLoggerLike
  /** 测试注入口；缺省全局 fetch。 */
  fetchImpl?: typeof fetch
  /**
   * **保底泳道**（2026-10-16 用户令，游戏模式停 8122 期间 shadow/on 不断流）：
   * 主端点任何失败（超时/拒连/5xx/坏 JSON/坏形状）后，走 System One 原生决策接口
   * `${apiUrl}/v1/systemone`（openrouter 代理 TypeSafe Jev；model 填 System One
   * 模型名如 jev-latest，**不是** chat 模型 slug）——⑥ 问法以 noul 类型发出，
   * 响应 `answers.changes.noul` = P(yes) ∈ [0,1] 连续概率。
   * undefined = 不启用（行为与旧版逐字相同）。⚠️ 云端模型与本地 0.8b 分布**不等价**：
   * 保底分只做可用性兜底，H1/H4/H8 金标实验**不得**混入（batch 返回 fallbackAnswered
   * 计数 + `decision-fallback` 日志行供口径分离）。
   */
  fallback?: DecisionFallbackOptions
}

/** 保底泳道配置（apiUrl 约定同 embed：不带 /v1，请求打到 `${apiUrl}/v1/systemone`）。 */
export interface DecisionFallbackOptions {
  apiUrl: string
  apiKey: string
  /** System One 模型名（jev-latest / jev-1.13.0；openrouter 上填 typesafe/jev-* 也被接受并解析）。 */
  model: string
  /** 云端往返独立超时（本地 800ms 预算装不下；批 deadline 在保底在场时取两超时较大值）。 */
  timeoutMs: number
}

/** 空上下文轮跳过判据（PLAN §P0b：先判空——空 state 上打分是噪声）。 */
export function shouldSkipDecision(stateText: string): boolean {
  return (stateText ?? '').trim().length < DECISION_MIN_STATE_CHARS
}

/**
 * run_gate2.py:87 的逐字模板——state_zh 把 state 与候选正文都装进去，
 * options 只是「否/是」两个字母位。{d} 用注入块同款标识（`D12` / `D12@桶`）。
 */
export function buildDecisionStateZh(state: string, d: string, title: string, body: string): string {
  return `当前任务上下文：\n${state}\n\n候选记忆（${d}｜${title}）：\n${body}`
}

/** build_tests.py:62-70 的 body 口径：非空行 strip 后 join(' ')，再取前 maxChars 字。 */
export function clipDecisionBody(body: string | null | undefined, maxChars = DECISION_BODY_CHARS): string {
  const joined = (body ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join(' ')
  return joined.slice(0, maxChars)
}

/**
 * 纯重排：按 p(⑥) 降序排有分候选；**无分候选沉尾、保持原相对序**。
 * topN 只打头部 ⇒ 该语义 = 「头部置换 + 尾部不动」。并列按提交序（Array#sort 稳定）。
 * 不改输入数组（off/降级路径与它共享同一引用）。probs 里的 none/未知键一概忽略。
 */
export function rerankByDecision<T>(
  candidates: readonly T[],
  probs: Readonly<Record<string, number>>,
  keyOf: (c: T) => string = (c) => String((c as { id?: unknown }).id),
): T[] {
  const scored: Array<{ c: T; p: number }> = []
  const unscored: T[] = []
  for (const c of candidates) {
    const p = probs[keyOf(c)]
    if (typeof p === 'number' && Number.isFinite(p)) scored.push({ c, p })
    else unscored.push(c)
  }
  scored.sort((a, b) => b.p - a.p)
  return [...scored.map((x) => x.c), ...unscored]
}

/* ── instructions_used 校验（进程内警告一次）─────────────────────────────
 * 服务已参数化（决策模型仓 955b1d2）：响应回显 instructions_used。
 * 若回显缺失（旧服务）或与我们发送的不一致 ⇒ 打分是别的问法的脏信号 ⇒
 * 显著警告一次，但仍返回 p（transport 没坏，语义脏由运维裁决）。 */
let warnedInstructions = false
export function resetDecisionWarningsForTests(): void {
  warnedInstructions = false
}

function noteInstructionsUsed(used: unknown, opts: DecisionClientOptions): void {
  if (warnedInstructions) return
  if (used === DECISION_INSTRUCTION) return
  warnedInstructions = true
  opts.logger?.warn(
    `decision-not-parameterized endpoint=${opts.endpoint} instructions_used=${JSON.stringify(used ?? null)}` +
      ` —— 服务没用我们的⑥指令（旧版硬编码 CHOICE_INSTR？），on/shadow 的 p 是技能语义不是记忆语义；` +
      `修服务端（POST 体读 instructions）后此警告自动消失`,
  )
}

/* ── 单候选打分 ────────────────────────────────────────────────────────── */
export interface DecisionChoiceResponse {
  probs: Record<string, number>
  ranked: string[]
}

const CHOICE_OPTIONS = [
  { key: 'false', desc: '否' },
  { key: 'true', desc: '是' },
] as const

/**
 * 单候选 ⑥ 打分 → p(true)。任何失败返回 null 并记 `decision-error kind=…`（绝不抛）。
 * kind ∈ timeout | network | http-N | bad-json | bad-shape。
 */
export async function scoreCandidateDecision(stateZh: string, opts: DecisionClientOptions): Promise<number | null> {
  if (!stateZh || !stateZh.trim()) return null
  const fetchImpl = opts.fetchImpl ?? fetch
  const url = `${opts.endpoint.replace(/\/+$/, '')}/v1/choice`
  const body = JSON.stringify({
    state_zh: stateZh,
    options: CHOICE_OPTIONS,
    append_none: false,
    instructions: DECISION_INSTRUCTION,
  })
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs)
  try {
    let res: Response
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: ac.signal,
      })
    } catch (e) {
      const kind = (e as Error)?.name === 'AbortError' ? 'timeout' : 'network'
      opts.logger?.error(`decision-error kind=${kind} endpoint=${opts.endpoint} timeoutMs=${opts.timeoutMs} msg=${String((e as Error)?.message ?? e)}`)
      return null
    }
    if (!res.ok) {
      opts.logger?.error(`decision-error kind=http-${res.status} endpoint=${opts.endpoint}`)
      return null
    }
    let data: unknown
    try {
      data = await res.json()
    } catch (e) {
      opts.logger?.error(`decision-error kind=bad-json endpoint=${opts.endpoint} msg=${String((e as Error)?.message ?? e)}`)
      return null
    }
    const probs = (data as { probs?: unknown } | null)?.probs
    if (!probs || typeof probs !== 'object' || Array.isArray(probs)) {
      opts.logger?.error(`decision-error kind=bad-shape endpoint=${opts.endpoint} detail=no-probs`)
      return null
    }
    const pTrue = (probs as Record<string, unknown>).true
    if (typeof pTrue !== 'number' || !Number.isFinite(pTrue)) {
      opts.logger?.error(`decision-error kind=bad-shape endpoint=${opts.endpoint} detail=no-true`)
      return null
    }
    noteInstructionsUsed((data as { instructions_used?: unknown }).instructions_used, opts)
    return pTrue
  } finally {
    clearTimeout(timer)
  }
}

/* ── 保底泳道：System One / Jev noul 形态（2026-10-16 二稿，用户纠偏）─────────
 * 第一稿用 chat completions+logprobs 是错误形态（jev-router 把是非题当 chat 路由给
 * 下游、deepseek-chat 二值化+限流）。正确形态=System One 原生决策接口：
 *   POST ${apiUrl}/v1/systemone  {model:"jev-latest", state, questions:{id:{type:"noul",instructions}}}
 *   → answers.<id>.noul = P(yes) ∈ [0,1] 连续概率（TypeSafe Jev，中文判断题第三方
 *   实测 94.7%；实测往返 ~1.6s、$0.000015/请求）。openrouter 以 /v1/systemone
 *   代理该 API（TAG_EMBED_KEY 通用认证）。
 * 与本地 8122 的 probs["true"] 同为 ⑥ 的 P(是)，但模型不同 ⇒ 分布不等价——保底分
 * 只保可用性（重排不断流），不当实验金标。 */
async function systemOneFallbackScore(stateZh: string, opts: DecisionClientOptions): Promise<number | null> {
  const fb = opts.fallback!
  const fetchImpl = opts.fetchImpl ?? fetch
  const url = `${fb.apiUrl.replace(/\/+$/, '')}/v1/systemone`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), fb.timeoutMs)
  try {
    let res: Response
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${fb.apiKey}` },
        body: JSON.stringify({
          model: fb.model,
          state: stateZh,
          questions: { changes: { type: 'noul', instructions: DECISION_INSTRUCTION } },
        }),
        signal: ac.signal,
      })
    } catch (e) {
      const kind = (e as Error)?.name === 'AbortError' ? 'timeout' : 'network'
      opts.logger?.warn(`decision-fallback-error kind=${kind} model=${fb.model} msg=${String((e as Error)?.message ?? e)}`)
      return null
    }
    if (!res.ok) {
      opts.logger?.warn(`decision-fallback-error kind=http-${res.status} model=${fb.model}`)
      return null
    }
    let data: unknown
    try {
      data = await res.json()
    } catch (e) {
      opts.logger?.warn(`decision-fallback-error kind=bad-json model=${fb.model} msg=${String((e as Error)?.message ?? e)}`)
      return null
    }
    const answer = (data as { answers?: Record<string, { noul?: unknown }> } | null)?.answers?.changes
    const noul = answer?.noul
    if (typeof noul !== 'number' || !Number.isFinite(noul)) {
      opts.logger?.warn(`decision-fallback-error kind=no-noul model=${fb.model} detail=${JSON.stringify(answer ?? null).slice(0, 120)}`)
      return null
    }
    return noul
  } finally {
    clearTimeout(timer)
  }
}

/** lane 区分打分结果：primary=8122 / fallback=云端（口径分离的数据面）。 */
export interface DecisionScoreOutcome {
  p: number
  lane: 'primary' | 'fallback'
}

/**
 * 带 lane 的单候选打分：主端点失败且配置了保底 → 走 chat 适配。任何失败返回 null（绝不抛）。
 */
export async function scoreCandidateWithLane(stateZh: string, opts: DecisionClientOptions): Promise<DecisionScoreOutcome | null> {
  const p = await scoreCandidateDecision(stateZh, opts)
  if (p !== null) return { p, lane: 'primary' }
  if (!opts.fallback?.apiUrl || !opts.fallback.model) return null
  const fp = await systemOneFallbackScore(stateZh, opts)
  if (fp === null) return null
  opts.logger?.info(`decision-fallback model=${opts.fallback.model} p=${fp.toFixed(4)} timeoutMs=${opts.fallback.timeoutMs}`)
  return { p: fp, lane: 'fallback' }
}
/* ── 批量：并发 ≤2 + 整批 deadline + 不重试 ─────────────────────────────── */
export interface DecisionBatchCandidate {
  /** probs 反查键（调用方口径，如跨桶 candidateKey）。 */
  key: string
  /** 注入块同款标识（D12 / D12@桶）。 */
  d: string
  title: string
  body: string | null | undefined
}

export interface DecisionBatchResult {
  /** key → p(true)。失败/未发出的候选**无键**（rerankByDecision 会把它们沉尾保序）。 */
  probs: Record<string, number>
  /** 实际发出的请求数（≤ candidates.length；deadline 到点后剩余的不发）。 */
  asked: number
  /** 拿到有效 p 的候选数。 */
  answered: number
  /** 其中走保底泳道（云端）拿到的个数——口径分离：>0 说明本轮分不是本地 8122 的。 */
  fallbackAnswered: number
}

/**
 * 逐候选并发打分：≤DECISION_MAX_CONCURRENCY 个 worker 各自串行取队；
 * 单请求超时 = opts.timeoutMs；**整批 deadline 同值**——worker 每次取任务前检查，
 * 到点即停（不发新请求）。绝不重试（重试把延迟预算吃两遍）。
 * 保底泳道在场时整批 deadline 取 max(timeoutMs, fallback.timeoutMs)：主端点 fail-fast
 * （拒连毫秒级）后保底请求需要云端往返时间，沿用 800ms 会把保底全部饿死。
 */
export async function scoreDecisionBatch(
  state: string,
  candidates: readonly DecisionBatchCandidate[],
  opts: DecisionClientOptions,
): Promise<DecisionBatchResult> {
  const t0 = Date.now()
  const deadlineMs = opts.fallback?.apiUrl ? Math.max(opts.timeoutMs, opts.fallback.timeoutMs) : opts.timeoutMs
  const probs: Record<string, number> = {}
  let asked = 0
  let answered = 0
  let fallbackAnswered = 0
  const queue = [...candidates]
  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      if (Date.now() - t0 >= deadlineMs) return // 整批 deadline：不再发新请求
      const c = queue.shift()!
      asked += 1
      const stateZh = buildDecisionStateZh(state, c.d, c.title, clipDecisionBody(c.body))
      const outcome = await scoreCandidateWithLane(stateZh, opts)
      if (outcome !== null) {
        probs[c.key] = outcome.p
        answered += 1
        if (outcome.lane === 'fallback') fallbackAnswered += 1
      }
    }
  }
  const n = Math.max(1, Math.min(DECISION_MAX_CONCURRENCY, candidates.length))
  await Promise.all(Array.from({ length: n }, () => worker()))
  return { probs, asked, answered, fallbackAnswered }
}
