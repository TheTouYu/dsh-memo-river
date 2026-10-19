/**
 * src/hurt.ts — **Critic 传感器**的判定纯函数（2026-10-19）。
 *
 * ## 它解决什么
 * 使用台账原先只有 `passive/active` 两维，回答「**用没用过**」；不回答「**用了之后有没有
 * 把事情做坏**」。按 Ratchet/Library Drift 的五角色对照，本仓作者侧（怎么写）已够，
 * 管理员侧（怎么维护）是空的——缺的正是这一维传感器
 * （证据：`research/bili-agi-2026-10-19/papers/skill-self-evolution.md` §5.1）。
 *
 * ## 为什么是「用户纠偏」而不是 LLM 裁判
 * Ratchet（arXiv:2605.22148）的核心边界：对退役边距 τ，若裁判把**失败判成通过**的错误率
 * ≥ (1−τ)/2，则**任何样本量下都退不掉任何技能**，且规则内部无法校正——因为它在置换
 * 淘汰统计量本身。而「用户这一轮说了纠偏词」是 deterministic 事件，不落入该陷阱。
 *
 * ## 安全界（必须读）
 * 本模块**只产出一个布尔判定**，调用方据它累加计数。它**不驱动任何自动退役**：
 * Ratchet 的 A4 消融实测「证据下限不足时按贡献退役会把 pass@1 压到 −0.019，
 * 低于无技能基线」——治理做错比不治理更糟。故本仓的 hurt 目前是**纯观测**，
 * `scripts/probe-critic.mjs` 的 C3 断言守着这条（狂记 hurt 不改变入选集合）。
 */

/** 纠偏词表：用户明确表达「你上一步不对」。**宁可漏判也不误判**——误判会污染统计量。 */
const CORRECTION_PATTERNS: readonly RegExp[] = [
  /不对(吧|啊|呀)?[，,。！!]?\s*(你|这|那)/,
  /你(搞|弄|说|写|做)错/,
  /错了[，,。！!]?\s*(不是|应该)/,
  /不是(这样|这个意思|我要的)/,
  /重新(来|做|写|生成|看)/,
  /我(说|讲)的(不是|是这个)/,
  /纠正(一下|下)?/,
  /(搞|弄)反了/,
  /答非所问/,
  /你(没|未)(理解|看懂|明白)/,
]

/** 显式否定式纠偏（前一轮的结论被直接否定）。 */
const REVERSAL_PATTERNS: readonly RegExp[] = [
  /不(对|行|能)(，|,)/,
  /这(个)?(结论|说法|判断)(不对|有问题|错了)/,
  /(推翻|证伪|作废)了?(你|上面|刚才)/,
]

/**
 * 判定一条用户消息是否构成「对上一轮的纠偏」。
 *
 * 设计取舍：
 * - **只扫用户消息**（assistant 的自陈不算——模型说「我错了」是自省，不是伤害信号）。
 * - **长度闸**：> 400 字的用户消息多半是新需求而非纠偏，避免长文本里偶然命中一个词。
 * - **首轮不判**：`turn <= 1` 时没有「上一轮」可纠。由调用方保证，本函数也做一次防御。
 *
 * @param text 用户消息原文（已剥注入块；调用方负责）
 * @param turn 该消息所属回合号（1-based）
 * @returns true = 构成纠偏
 */
export function isCorrection(text: string | null | undefined, turn: number): boolean {
  if (!text) return false
  if (turn <= 1) return false
  const t = text.trim()
  if (t.length === 0) return false
  /* 长消息按「新需求」处理：纠偏通常是短句。这条闸防的是长文档里偶然出现「重新」二字。 */
  if (t.length > 400) return false
  for (const re of CORRECTION_PATTERNS) if (re.test(t)) return true
  for (const re of REVERSAL_PATTERNS) if (re.test(t)) return true
  return false
}

/**
 * 从会话状态取「待判集」并给出应当记 hurt 的 fileId。
 *
 * 语义：上一轮注入的条目 → 若这一轮用户纠偏 → 这些条目记一次 hurt。
 * **不判定单条哪一条造成了伤害**（那需要更细的归因，Ratchet 也承认这是未解问题）；
 * 记的是「这批在此时被注入过，而随后用户纠偏」这一**相关性**事件，供后续人工/统计判断。
 *
 * @returns 应记 hurt 的 fileId 列表；空数组表示不记
 */
export function hurtTargets(
  pending: { fileIds: readonly number[]; turn: number } | null,
  userText: string | null | undefined,
  currentTurn: number,
): number[] {
  if (!pending || pending.fileIds.length === 0) return []
  /* 只判「紧接着的下一轮」：跨越两轮以上，纠偏与注入的因果链已弱到不该记账。 */
  if (currentTurn !== pending.turn + 1) return []
  if (!isCorrection(userText, currentTurn)) return []
  return [...pending.fileIds]
}
