/**
 * src/config.ts — 插件配置（schemastery）与解析后的运行期配置。
 *
 * 字段与 DESIGN.md §5.1 的 agent.cordis.yml 片段逐项对应：
 *   workspaceScoped / intervalMs / embed / inject / native
 */
import z from 'schemastery'

/** 召回读出模式（DESIGN.md §6.3「模式」）：两者共用同一次 runMemoPipeline 观测。 */
export type ReadoutMode = 'dtsc' | 'topology_v3' | 'tagmemo' | 'rivermemo'

export interface EmbedConfig {
  /** 不带 /v1（EmbeddingUtils 的调用形状：`${apiUrl}/v1/embeddings`）。 */
  apiUrl: string
  apiKey: string
  model: string
  dimension: number
}

export interface InjectConfig {
  /** 门控开关（DESIGN.md §6.3；《《》》 语义）。 */
  gate: boolean
  /** 条数上限。 */
  k: number
  /** 硬预算（token）。 */
  tokenBudget: number
  /** 读出模式。 */
  mode: ReadoutMode
  /** 动态 K 倍率（`[[本:1.5]]` 语义，是倍率不是条数）。 */
  dynamicK: number
  /** 低基数门限（§2.2 规则 4）：KNN 低于此值的候选不发放结构奖励。 */
  minKnnForReward: number
  /** 门控阈值：本会话查询场对日记本的最大 KNN 余弦低于此值 → 清空不注入。 */
  gateThreshold: number
  /** 构造查询场时回看的最近消息条数。 */
  queryLookback: number
  /**
   * 门控拿当前消息的向量比阈值，而不是拿窗口拼接的检索向量。
   * true（默认）= 门控有判别力；false = 退回旧行为（w≥2 时无关查询也通过，见 schema 注释实测）。
   */
  gateOnCurrentMessage: boolean
  /** 入选集合与上次相同则不重复注入（键是 chunk id 集合，不是块文本）。 */
  dedupeSelection: boolean
  /** 即使集合没变，隔了这么多 turn 也强制重注一次（0 = 不限制）。 */
  dedupeRefreshTurns: number
  /** 自主态注入节律：回合不停时每 N 步重评一次召回（0 = 关闭）。 */
  autonomousInjectEverySteps: number
  /** 近因保底：最近 N 天内的最新日记被 k-limit/预算挤出入选集时，给它保留一席（0 = 关闭）。 */
  recencyFloorDays: number
  /** 写入节律提醒：距上次 memo_write 超过 N 分钟且有未入河的回合进展时，注入一条写日记提醒（0 = 关闭）。 */
  writeNudgeEveryMinutes: number
  /**
   * 汇报轮锚：N 个「小轮」（以实质性汇报收尾的回合）未写日记 → 提醒（0 = 关闭）。
   * 小轮 = 用户一条消息 → 内部多步工具/思考 → 阶段性汇报 → 回合停（turn-stopping）。
   * 与时间锚互补：时间锚兜长任务，轮锚兜快节奏（7 分钟内连出两轮汇报也该提醒）。
   */
  writeNudgeEveryTurns: number
  /**
   * 自主态步锚：距上次写入/提醒 ≥N 步 → 提醒（0 = 关闭，2026-09-13 用户拍板 oneshot 适配）。
   * 不依赖 draft（oneshot 单回合 turn-stopping 永不触发、lastDraftSummary 恒空）——
   * 步数本身就是进展信号。交互态长回合同样适用（内部 40 步足可结晶一篇）。
   */
  writeNudgeEverySteps: number
  /**
   * 自主态增量锚：会话上下文自上次锚点累计增长 ≥N 字符 → 提醒（0 = 关闭）。
   * 口径为字符（5 万字符 ≈ 2–3 万 token）；与步锚互补——密集工具输出先到增量，稀疏思考先到步数。
   */
  writeNudgeGrowthChars: number
}

export interface NativeConfig {
  /** VCPToolBox 根目录（rust-vexus-lite 与 rag_params.json 所在处）。 */
  vcpRoot: string
  /** 显式指定 config.env（取 API_URL / API_Key / VECTORDB_DIMENSION）。 */
  configEnv: string
  /** 原生 artifact 的 modelSig 后缀（VCP 约定 `${model}@relayrouter`）。 */
  modelSigSuffix: string
}

export interface MaintenanceConfig {
  enabled: boolean
  /** 连续失败指数退避上限倍率。 */
  maxBackoff: number
  /** turn-stopping 时产出候选草稿（不落库）。 */
  drafts: boolean
  /** 合并候选检测（票 04，守护循环每轮跑；参数定标见 DESIGN §7.1.3）。 */
  consolidation: {
    enabled: boolean
    /** 判定①：最小年龄（天，对齐 §7.3 陈旧口径 14）。 */
    minAgeDays: number
    /** 判定②：最大累计召回次数（被动+主动）。 */
    maxRecalls: number
    /** 判定③：与更新篇的最小余弦（合并带：dedupCosine=0.95 之下、一般续写之上）。 */
    overlapCosine: number
  }
}

export interface WriteConfig {
  /**
   * 写入内容去重：新日记全文与本桶既有 chunk 的最大余弦超过此值 → 拒绝（0 = 关闭）。
   *
   * 写侧对称物 of inject.dedupeSelection：读侧防「重复注入」，写侧防「重复入库」。
   * 由头：2026-09-13 三个真实失效样本（机械批准垃圾入库 / 13 分钟三连重写同题日记 /
   * 催一条写一条的复读）——被催出来的写入总在写「当下最显著的东西」，而那常常是同一件事。
   *
   * 阈值定标（gemini-embedding，2026-09-13 实测，scripts/probe-dedup.mjs）：
   *   合法同话题续写（两篇短渲染卡顿修复记，共享 Tag 行）= 0.9325 → 必须放行
   *   逐句重排复读 = 0.9793；近重写 = 0.9675 → 必须拦截
   *   → 0.95 居中，两端各留 ~0.02。短文+同 Tag 行是合法侧的最坏情形（boilerplate 占比最大）。
   */
  dedupCosine: number
}

export interface Config {
  enabled: boolean
  workspaceScoped: boolean
  intervalMs: number
  bucket: string
  logFile: string
  /**
   * 固定契约文本的注册通道。DESIGN.md 的语义是「system 段」（§4 分层职责 / §6.1 标题
   * 「system 段固定文本」/ §6.4 的判据「取 system 段 hash」），而 §6.4 正文点名的 API 是
   * `systemPrompt.context`。二者在本 DSH 上落点不同：
   *   · `section()` → 真正进入 system prompt（稳定前缀）；
   *   · `context()` → 进入请求尾部的 runtime-context 快照消息（动态区）。
   * 默认 'section'，因为「保前缀缓存 / 逐轮 hash 相等」只有在 section 上才成立。
   */
  promptChannel: 'section' | 'context' | 'both'
  embed: EmbedConfig
  inject: InjectConfig
  write: WriteConfig
  native: NativeConfig
  maintenance: MaintenanceConfig
}

const MODES: readonly ReadoutMode[] = ['dtsc', 'topology_v3', 'tagmemo', 'rivermemo']

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  workspaceScoped: z.boolean().default(true),
  // 守护循环 15 分钟（DESIGN.md §5.1 / §8.4）
  intervalMs: z.number().min(10_000).default(900_000),
  bucket: z.string().default(''),
  logFile: z.string().default(''),
  promptChannel: z.union([z.const('section'), z.const('context'), z.const('both')]).default('section'),

  embed: z
    .object({
      apiUrl: z.string().default(''),
      apiKey: z.string().default(''),
      model: z.string().default('gemini-embedding-2-preview'),
      dimension: z.number().min(1).default(3072),
    })
    .default({} as EmbedConfig),

  inject: z
    .object({
      gate: z.boolean().default(true),
      k: z.number().min(1).default(3),
      tokenBudget: z.number().min(1).default(600),
      mode: z.union(MODES.map((m) => z.const(m)) as [z<ReadoutMode>, ...z<ReadoutMode>[]]).default('topology_v3'),
      dynamicK: z.number().min(0).default(1),
      minKnnForReward: z.number().default(0.6),
      gateThreshold: z.number().default(0.55),
      queryLookback: z.number().min(1).default(6),
      /**
       * 门控拿哪个向量比阈值。
       *
       * 检索向量是**窗口拼接**出来的（queryLookback 条消息）；拼接越长越靠近语料质心，
       * 对**任何**查询的 maxKnn 都被抬高。实测（5 轮教室话题历史 + 无关末轮，阈值 0.55）：
       *   负例「今天天气怎么样？」 w1=0.4536 不过 | w2=0.5709 w4=0.6523 w6=0.7473 全过
       *   负例「晚饭吃什么好呢？」 w1=0.4830 不过 | w2=0.5967 w4=0.6991 w6=0.7754 全过
       *   负例「帮我订张高铁票」   w1=0.5124 不过 | w2=0.5994 w4=0.6705 w6=0.7363 全过
       *   正例「那这个桌子后来…」   w1=0.6525 过   | w2=0.7146 w4=0.7655 w6=0.8063 全过
       * → 阈值 0.55 只在 w1 有判别力（负例上界 0.5124 < 0.55 < 正例 0.6525，间隔 0.14）；
       *   w≥2 起负例全部误通过，门控退化为摆设——而真实会话必然有历史。
       * 所以门控只拿**当前这条用户消息**的向量，检索仍用窗口向量：
       * 门控回答"这句话本身相不相关"，检索回答"这段对话在讲什么"。
       */
      gateOnCurrentMessage: z.boolean().default(true),
      /**
       * 入选集合与上次相同时不重复注入。
       *
       * 键是 chunk id 集合，不是块文本 —— 实测 `ids=D1,D2,D4` 连注 6 次、文本各不相同
       * （只差 Ω 小数位），按文本去重一次都省不下来。
       */
      dedupeSelection: z.boolean().default(true),
      /**
       * 即使集合没变，隔了这么多 turn 也强制重注一次（0 = 不限制）。
       *
       * 为什么需要：跳过的前提是"旧块还在上下文里"，而压缩会把老块折进摘要 ——
       * 那时再跳过就等于静默丢记忆。
       */
      dedupeRefreshTurns: z.number().min(0).default(8),
      /**
       * 自主态注入节律：回合不停（oneshot 长任务）、无新用户消息时，每 N 步重评一次召回（0=关闭）。
       *
       * 为什么需要：旧逻辑只在每 turn 第 1 步注入，oneshot 全程 turn=1 → 开场一次后
       * 零召回（实测 session-712451cc：330 步/2h45m 盲干，日记躺在河里不被捞）。
       * 压缩事件不受此节流：出现新 compactionId → 立即重评并绕过同集合去重
       * （压缩把旧注入块折进摘要，正是记忆最脆弱的时刻）。
       */
      autonomousInjectEverySteps: z.number().min(0).default(15),
      /** 近因保底：最近 N 天内的最新日记被 k-limit/预算挤出入选集时，给它保留一席（0 = 关闭）。 */
      recencyFloorDays: z.number().min(0).max(365).default(7),
      /** 写入节律提醒：距上次 memo_write 超过 N 分钟且有未入河的回合进展时，注入一条写日记提醒（0 = 关闭）。 */
      /** 写入节律提醒·时间锚：距上次 memo_write 超 N 分钟且有未入河的回合进展时提醒（0 = 关闭）。默认 7——提醒只有两行、成本极低，收益（进展不丢）远大于扰动（2026-09-13 用户拍板：15 → 7）。 */
      writeNudgeEveryMinutes: z.number().min(0).max(1440).default(7),
      /** 写入节律提醒·汇报轮锚：N 个实质汇报轮未写 → 提醒（0=关；小轮判别见 session.ts SUBSTANTIVE_REPORT_CHARS）。 */
      writeNudgeEveryTurns: z.number().min(0).max(100).default(2),
      /** 写入节律提醒·自主态步锚：距上次写入/提醒 ≥N 步 → 提醒（0=关；oneshot 适配，不依赖 draft）。 */
      writeNudgeEverySteps: z.number().min(0).max(10_000).default(40),
      /** 写入节律提醒·自主态增量锚：上下文自锚点累计增长 ≥N 字符 → 提醒（0=关；5 万字符≈2–3 万 token）。 */
      writeNudgeGrowthChars: z.number().min(0).max(10_000_000).default(50_000),
    })
    .default({} as InjectConfig),

  native: z
    .object({
      vcpRoot: z.string().default('/home/h/app/VCPToolBox'),
      configEnv: z.string().default(''),
      modelSigSuffix: z.string().default('@relayrouter'),
    })
    .default({} as NativeConfig),

  write: z
    .object({
      dedupCosine: z.number().min(0).max(1).default(0.95),
    })
    .default({} as WriteConfig),

  maintenance: z
    .object({
      enabled: z.boolean().default(true),
      maxBackoff: z.number().min(1).default(8),
      drafts: z.boolean().default(true),
      consolidation: z
        .object({
          enabled: z.boolean().default(true),
          minAgeDays: z.number().min(1).default(14),
          maxRecalls: z.number().min(0).default(1),
          overlapCosine: z.number().min(0).max(1).default(0.9),
        })
        .default({ enabled: true, minAgeDays: 14, maxRecalls: 1, overlapCosine: 0.9 }),
    })
    .default({} as MaintenanceConfig),
})
