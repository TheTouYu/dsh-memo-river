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
  /** OpenRouter provider 优先序（逗号分隔 slug，如 'Parasail'）；空 = 不干预路由。 */
  providerOrder: string
  /** 保底端点（2026-10-15）：主端点失败时改打它；空 = 不启用回退。 */
  fallbackApiUrl: string
  /** 保底端点 key；空 = 沿用主端点 key。 */
  fallbackApiKey: string
  /** 保底端点模型名；空 = 沿用主端点模型名。 */
  fallbackModel: string
  /** 保底端点 provider 优先序。 */
  fallbackProviderOrder: string
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
  /**
   * 票 03：自适应 K 比例——被动注入的候选池 ≥ ADAPTIVE_K_POOL_FLOOR(5，见 recall.ts) 时，
   * 条数上限从固定 k 抬到 clamp(ceil(候选数×本值), k, adaptiveKMax)（只升不降）；
   * 池 <5 的稀疏桶逐位保持旧行为（固定 k）。0 = 关闭（回滚到固定 k）。
   *
   * 定标（2026-09-16，genshin-ts 桶 c9f838ba 深评 docs/EVAL-单会话深评-genshin-ts-c9f838ba.md）：
   * 一夜 26 子代理写 25 篇（桶 2→27），被动注入固定 k=3 → 后期注入 dropped 24/26≈92%
   * （dropped 率 = dropped.length/候选数，inject 日志口径）。dropped 率 <50% 需 k≥14：
   * ratio=0.5 → ceil(26×0.5)=13 → 恰 50% 不过线；取 0.6 → ceil(15.6)=16 → dropped
   * 10/26≈38.5% ✅。预算不让步：自适应只抬条数上限，chars/token 总预算仍由读出侧
   * 逐条 cost 校验（超预算先截首句、再丢 token-budget）兜底，k 再大也装不超 tokenBudget。
   */
  adaptiveKRatio: number
  /** 票 03：自适应 K 条数硬顶——病理大池封顶渲染成本：c9f838ba 27 篇场景 k=16 时 dropped 11/27≈41%，仍 <50%。 */
  adaptiveKMax: number
  /**
   * 票 04：选择循环有界权重（被动注入路径；机制与证据见 recall.ts「选择循环有界权重」注释）。
   * 三项上界独立可配、缺省保守（合计 0.17 ≈ 锚奖励 0.18，只能翻近似并列，不推翻 topology
   * 主排序）；各 0 = 对应权重关闭。主动 memo_recall 不接这些参数（显式 k 语义不受影响）。
   */
  selectionTagCap: number
  /** 票 04：跨注入曝光抑制上界——台账 passive 信号 tanh 饱和 × 指数衰减，防 D1×36 搭车。 */
  selectionExposureCap: number
  /** 票 04：曝光惩罚半衰期（小时）。 */
  selectionExposureHalfLifeHours: number
  /** 票 04：近因加成上界——窗口期内新写的进展不再被旧条目搭车挤光。 */
  selectionRecencyCap: number
  /** 票 04：近因窗口（小时，线性衰减到 0）。 */
  selectionRecencyWindowHours: number
  /** 低基数门限（§2.2 规则 4）：KNN 低于此值的候选不发放结构奖励。 */
  minKnnForReward: number
  /** 门控阈值：本会话查询场对日记本的最大 KNN 余弦低于此值 → 清空不注入。 */
  gateThreshold: number
  /** 构造查询场时回看的最近消息条数。 */
  queryLookback: number
  /**
   * 票 01：注入路径嵌入短超时（ms，0 = 用 EmbedClient 宽松默认 60s；缺省 8000）。
   * 只罩被动注入的合批 embed 调用（查询向量 + 门控锚，一次请求）；超时/失败 →
   * inject-skip（reason 可区分 embed-timeout）+ 一条模型可见的「召回未生效」短通知
   * （D214 降级可见化：失败不再沉默）。写侧（memo_write/approve）与主动 memo_recall
   * 不经此配置，仍走宽松默认 60s。
   */
  embedTimeoutMs: number
  /**
   * 门控拿当前消息的向量比阈值，而不是拿窗口拼接的检索向量。
   * true（默认）= 门控有判别力；false = 退回旧行为（w≥2 时无关查询也通过，见 schema 注释实测）。
   */
  gateOnCurrentMessage: boolean
  /**
   * 票⑧ 锚拼接（2026-09-14 校准，composer 桶 73 事件）：门控判定从「只比用户锚」改为
   * max(gU, gA)。助手锚 = 最近一条 >150 字助手消息前 1200 字（skip 集 gA 0.709-0.881，
   * 短指令误杀 17/17 → 0/17，误放 0/8）。false = 回退旧行为（用户锚单选）。
   */
  gateAssistantAnchor: boolean
  /** 票 05：有界 tie-breaker 开关（0=关默认；memo_tuning 可会话级开，回读只认主动使用信号）。 */
  tieBreakerEnabled: number
  /** 票 05：强化上界（默认 0.05 ≪ 锚 0.18）。 */
  tieBreakerCap: number
  /** 票 05：tanh 饱和常数（默认 2）。 */
  tieBreakerTau: number
  /** 票 05：最近主动召回半衰期（天，默认 30）。 */
  tieBreakerRecencyHalfLifeDays: number
  /** 入选集合与上次相同则不重复注入（键是 chunk id 集合，不是块文本）。 */
  dedupeSelection: boolean
  /** 即使集合没变，隔了这么多 turn 也强制重注一次（0 = 不限制）。 */
  dedupeRefreshTurns: number
  /**
   * 条目级去重：仍在上下文里的条目不再占席位（键 = `recall.candidateKey`）。
   *
   * 与 `dedupeSelection`（集合级，集合完全不变才跳过整块）互补——集合一变它即失效，
   * 交集部分会被白付一遍。关掉此开关 → 逐位退回旧行为（回退手段）。
   */
  dedupeLiveEntries: boolean
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
  /** 票11 内核切换：'vcp' = 上游 rust-vexus-lite（缺省）；'reimpl' = 本仓 kernel/ 复刻（行为等价，差分判据 PLAN §4）。 */
  kernel: string
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
  /**
   * 票06（recall-quality-0916）：hub Tag 写入闸门场景化——autonomous/delegation 会话
   * （delegationDepth>0 / 委托闩锁 / 最近一步 injectMode=autonomous）写已枢纽化 Tag
   * （桶内频次 ≥1/3）时的处理档位；交互会话永远保持软警告（现状）。
   * 由头：c9f838ba 一夜 26 子代理 25 篇把「千星官方课程」推到 21/26=80.8%，写侧枢纽
   * 警告全触发放行——软警告对无人类在场的会话没有约束力。
   *   0 = off：回旧行为（场景内也只软警告）；
   *   1 = suggest（缺省）：先观察后收紧——写入放行，但报告带观察段+词汇表内替代建议，
   *       并落 hub-gate-observe 日志行（收集误伤率，攒证据再收紧）；
   *   2 = enforce：场景内硬拒（hub-tag-scoped）+ 词汇表内替代 Tag 建议。
   * preset 级可调（memo_tuning hubGateMode / tuning.json，无需重启）。
   */
  hubGateMode: number
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
      // 缺省留空：让 resolveEmbed 回落到 config.env 的 WhitelistEmbeddingModel（原先非空默认值
      // 会让 config.env 成为死配置——2026-10-15 实测：改 config.env 后 resolveEmbed 仍返回默认值）。
      model: z.string().default(''),
      // 缺省 0 = 未指定：回落 config.env 的 VECTORDB_DIMENSION，再兜底 3072（同 resolveEmbed）。
      dimension: z.number().min(0).default(0),
      // OpenRouter 专属：逗号分隔的 provider slug 优先序（如 'Parasail'）→ 请求体带
      // provider:{order:[...]}。动机（2026-10-15 实测，见 docs/ 与河中当日篇）：不指定时
      // OpenRouter 按价格负载均衡，同一文本连打 6 次被路由到 DeepInfra/Parasail 两家，
      // 逐元素最大差 3.8e-4~7.3e-4（cos ≥0.99997——方向不变但**逐位不可复现**），会让
      // 「并发 == 串行」这类名次恒等断言随机变红；指定 order 后负载均衡被关掉，同一
      // provider 连打 3 次逐元素差 0.00e+0。留空 = 不发送 provider 字段：非 OpenRouter
      // 端点与旧行为完全不变。
      providerOrder: z.string().default(''),
      // ── 保底端点（2026-10-15 用户令）────────────────────────────────────────
      // 主端点失败（超时/连接拒绝/5xx）时改打它，成功后向量入同一缓存（两端点 cos≈0.99997，
      // 实测见 docs/local-embed-2026-10-15.md）。典型配置：主=本地 http://127.0.0.1:8099，
      // 保底=https://openrouter.ai/api。留空 = 不启用回退（行为与旧版逐字相同）。
      fallbackApiUrl: z.string().default(''),
      // 缺省沿用主端点的 key（同provider族换端点时免配）；跨 provider 必须显式给。
      fallbackApiKey: z.string().default(''),
      // 缺省沿用主端点模型名。
      fallbackModel: z.string().default(''),
      fallbackProviderOrder: z.string().default(''),
    })
    .default({} as EmbedConfig),

  inject: z
    .object({
      gate: z.boolean().default(true),
      k: z.number().min(1).default(3),
      tokenBudget: z.number().min(1).default(600),
      mode: z.union(MODES.map((m) => z.const(m)) as [z<ReadoutMode>, ...z<ReadoutMode>[]]).default('topology_v3'),
      dynamicK: z.number().min(0).default(1),
      /** 票 03：自适应 K 比例（0=关）。定标：26 候选 dropped 24/26 场景，ratio=0.5 → 恰 50% 不过线 → 取 0.6（16 条，dropped≈38.5%）；完整依据见 InjectConfig.adaptiveKRatio 注释。 */
      adaptiveKRatio: z.number().min(0).max(1).default(0.6),
      /** 票 03：自适应 K 条数硬顶（27 篇病理大池定标 16：dropped≈41%<50%，渲染成本有界）。 */
      adaptiveKMax: z.number().min(1).max(64).default(16),
      /** 票 04：批内同 Tag 去重上界（0=关；同轴克隆在近似并列处让位异轴条目，防 hub 垄断）。 */
      selectionTagCap: z.number().min(0).max(0.2).default(0.04),
      /** 票 04：跨注入曝光抑制上界（0=关；被动台账 tanh×指数衰减，治 D1×36 搭车）。 */
      selectionExposureCap: z.number().min(0).max(0.2).default(0.08),
      /** 票 04：曝光惩罚半衰期（小时；上次被动注入越久罚越轻，不永久流放）。 */
      selectionExposureHalfLifeHours: z.number().min(1).max(24 * 30).default(24),
      /** 票 04：近因加成上界（0=关；窗口期内新写的进展在排序内就有竞争力）。 */
      selectionRecencyCap: z.number().min(0).max(0.2).default(0.05),
      /** 票 04：近因窗口（小时；窗口内线性衰减到 0）。 */
      selectionRecencyWindowHours: z.number().min(1).max(24 * 30).default(24),
      minKnnForReward: z.number().default(0.6),
      gateThreshold: z.number().default(0.55),
      queryLookback: z.number().min(1).default(6),
      /**
       * 票 01：注入路径嵌入短超时（ms，0 = 用客户端默认 60s）。**2026-10-14 定标：3000 → 8000**。
       *
       * 原定标（3000）基于当时实测单条 RTT 1.19-1.45s；但端点随后劣化，10-13/10-14 稳定在
       * RTT ≈3s+（docs/embed-latency-2026-10-14.md：单文本 p50 983→1593→2045→2144ms，超 3s
       * 概率 13.5%、劣化窗口 23%），**预算线与端点点位重合** → 全库 skip 率 45.3%（超时类 30.5%），
       * 且成功注入的 elapsedMs p50=3154ms 本身就超预算。8s 覆盖实测 p90（3.5-4.3s）与 p95（≈4.5s）；
       * 代价是闸持有更久（只在端点真慢时付）。根治仍是双端点/本地嵌入兜底，尚未落地。
       */
      embedTimeoutMs: z.number().min(0).default(8000),
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
      /** 票⑧ 锚拼接：门控取 max(用户锚, 助手锚)；助手锚口径与 probe-gate-calibration.mjs 一致。 */
      gateAssistantAnchor: z.boolean().default(true),
      /** 票 05：有界 tie-breaker 开关（0=关，默认关；memo_tuning 可会话级开——回读只认主动使用信号）。 */
      tieBreakerEnabled: z.number().min(0).max(1).default(0),
      /** 票 05：强化上界（默认 0.05 ≪ 锚奖励 0.18，只够在近似并列处翻序）。 */
      tieBreakerCap: z.number().min(0).max(0.2).default(0.05),
      /** 票 05：tanh 饱和常数（约 3 次主动召回近饱和，防曝光积累）。 */
      tieBreakerTau: z.number().min(0.1).max(10).default(2),
      /** 票 05：最近主动召回半衰期（天；长期不用向基线收缩）。 */
      tieBreakerRecencyHalfLifeDays: z.number().min(1).max(365).default(30),
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
       * 条目级去重（2026-10-15）：仍在上下文里的条目不再占席位（键 = recall.candidateKey）。
       *
       * 为什么需要：`dedupeSelection` 的键是**整个入选集合**——集合一变
       * （{A,B,C}→{A,B,D}）它就失效，A、B 被整块重注一遍。HANDOFF 实测的
       * 「同 3 条记忆一场会话被注 9 次」正是这个形状（每条重复都有成本、零收益）。
       * 可见性判据用**真消息在场**（blockHash 反查 injector.liveInjectedKeys），
       * 不用轮数近似——块被压缩折走后自动允许重注，不静默丢记忆。
       * 缺省开；关掉 = 逐位退回旧行为（回退手段）。
       */
      dedupeLiveEntries: z.boolean().default(true),
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
      /* 票11 切换开关（2026-09-29 落地）：'vcp'（上游二进制，缺省）| 'reimpl'（kernel/ 复刻）。
       * env MEMO_NATIVE_KERNEL 只作缺省种子——验收/运维一键换轨；组合里的显式配置永远优先。 */
      kernel: z.string().default(process.env.MEMO_NATIVE_KERNEL ?? 'vcp'),
      configEnv: z.string().default(''),
      modelSigSuffix: z.string().default('@relayrouter'),
    })
    .default({} as NativeConfig),

  write: z
    .object({
      dedupCosine: z.number().min(0).max(1).default(0.95),
      /** 票06 hub 闸门档位：0=off / 1=suggest（缺省，观察+建议）/ 2=enforce（场景内硬拒）。语义见 WriteConfig.hubGateMode。 */
      hubGateMode: z.number().min(0).max(2).default(1),
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
