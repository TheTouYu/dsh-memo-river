/**
 * src/render.ts — 尾注入块的渲染（DESIGN.md §6.2）。
 *
 * 硬性要求（逐条落地）：
 *   · 给**片段原文**，不是标题列表；
 *   · 必须带 `role` + 奖励 + `Ω/regime`；
 *   · 必须带**未注入说明**（不静默）；
 *   · 注入块与用户消息之间用**固定分隔符**，便于回归测试定位。
 *
 * 本文件里出现的所有字面量都是**编译期常量**；动态值只从 RecallOutcome 来。
 */
import type { PendingQueueStats } from './drafts.js'
import type { RecallCandidate, RecallOutcome } from './recall.js'
import { proseText } from './runtime.js'

/** 固定分隔符（回归测试定位用；§6.2 最后一条要求）。 */
export const BLOCK_OPEN = '⟨memo-river·被动召回⟩'
export const BLOCK_CLOSE = '⟨/memo-river⟩'

/** 单条候选的正文片段上限（字符）。 */
const EXCERPT_CHARS = 240

const f3 = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : 'n/a')

/** 奖励串：只呈现原生真正发放的那一项（anchor 与 topology 分离，§2.3）。 */
function rewardText(c: RecallCandidate): string {
  if (c.rewardSuppressed) {
    return `reward=suppressed(knn ${f3(c.knnScore)} < minKnnForReward)`
  }
  const parts: string[] = []
  if (c.anchorBonus > 0) parts.push(`anchor=+${f3(c.anchorBonus)}`)
  if (c.topologyBonus > 0) parts.push(`topology=+${f3(c.topologyBonus)}`)
  if (parts.length === 0) parts.push('reward=none')
  return parts.join('  ')
}

/** 正文片段：跳过 `# 标题` 行与 `Tag:` 行，取正文首段（§6.2「给片段原文」）。 */
export function excerpt(body: string, maxChars = EXCERPT_CHARS): string {
  // 与 runtime.firstSentence 共用 proseText —— 两处过滤必须一致，否则被预算截断的
  // 行会在这里变成空串，正文行静默消失（详见 proseText 的注释）。
  const text = proseText(body)
  return text.length > maxChars ? text.slice(0, maxChars) + '…' : text
}

function tagsText(c: RecallCandidate): string {
  return c.matchedTags.length > 0 ? c.matchedTags.slice(0, 6).join(',') : '-'
}

/**
 * 渲染尾注入块。
 *
 * 返回 `null` 表示**不注入**（门控不过 / 无候选 / 原生失败）——
 * 调用方据此完全不追加消息（§6.3「清空，不注入」）。
 */
export function renderInjection(outcome: RecallOutcome, bucket: string): string | null {
  if (!outcome.injected || outcome.selected.length === 0) return null

  const omega = outcome.omega === null ? 'Ω=n/a' : `Ω=${outcome.omega.toFixed(3)}`
  const regime = outcome.regime ? ` ${outcome.regime}` : ''
  const header =
    `${BLOCK_OPEN}\n` +
    `[记忆河流·被动召回 | 本桶=${bucket} | ${omega}${regime} | mode=${outcome.mode} | 动态K×${outcome.dynamicK}]`

  const lines: string[] = [header]
  for (const c of outcome.selected) {
    lines.push(`D${c.id}「${c.title}」 role=${c.role}  ${rewardText(c)}  tags=${tagsText(c)}`)
    const body = excerpt(c.body)
    if (body) lines.push(`  ${body}`)
  }

  // §6.2「必须带未注入说明（不静默）」：只要候选数 > 实际注入数就要有一行。
  const truncated = outcome.dropped.filter((d) => d.reason !== 'truncated-to-first-sentence')
  if (outcome.candidateCount > outcome.selected.length) {
    const detail = truncated
      .slice(0, 8)
      .map((d) => `D${d.id}(${d.reason})`)
      .join(' ')
    const fallback = outcome.fallbackReason ? `；fallbackReason=${outcome.fallbackReason}` : ''
    lines.push(
      `[本次未注入 ${outcome.candidateCount - outcome.selected.length} 条${fallback}；候选 ${outcome.candidateCount} 条，截断 ${truncated.length} 条]`,
    )
    if (detail) lines.push(`[未注入明细] ${detail}`)
  }

  lines.push(BLOCK_CLOSE)
  return lines.join('\n')
}

/** 不注入时的诊断行（只进日志，不进模型请求）。 */
export function renderSkipNotice(outcome: RecallOutcome, bucket: string): string {
  return `inject-skip bucket=${bucket} reason=${outcome.fallbackReason ?? 'unknown'} gate=${JSON.stringify(outcome.gate)} elapsedMs=${outcome.elapsedMs}`
}

/** 草稿队列年龄的人类可读形态（<1h / 小时 / ≥72h 折天；nudge 与面板口径一致）。 */
export function ageText(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return '未知'
  if (hours < 1) return '不足 1 小时'
  if (hours < 72) return `${Math.round(hours)} 小时`
  return `${Math.round(hours / 24)} 天`
}

/**
 * 写入节律提醒文案（B6 瘦身原则：只带「该写了 + 写什么 + 怎么写」，
 * 写日记规范不复读——它住在固定契约段里）。
 *
 * ⚠️ 契约段的**落点随底座而变**（2026-09-15 实测）：标准底座下它经
 * `systemPrompt.section` 进系统提示；极简底座（persona `complete:true`）会把它
 * **整段丢弃**，同一段文本改由 preset-composer 的「首条消息之后」披露器补进对话流。
 * 故此处只指**段名**，不断言"在系统提示里"——旧文案「规范见系统提示『写日记规范』」
 * 在极简底座下是悬空引用（指向一个不存在的段落）。
 * 票05：队列非空时追加一行「草稿队列 N 篇待批（最老 X 小时）」——把漏斗断裂
 * 暴露到每次提醒；队列为空不追加（不显示误导数字，也不挤占原提醒信息）。
 * 票05（recall-quality-0916）：两种形态——
 *   · 普通：质量锚折进第 2 行，基底仍 2 行（+队列行 ≤3 行不变，2026-09-13 用户拍板
 *     15→7 的前提是提醒成本极低，行数不加）；
 *   · 委托（delegation）：c9f838ba 取证——父 22:25 派 26 子代理前落的 D3/D4 成为
 *     它们的检索基底，扇出前写入价值最大。追加一行「先落盘当前进展：子代理/兄弟代理
 *     可立即召回」+ 点明读者是兄弟代理而非未来的自己（引导写可共享知识）；锚在第 2 行。
 */
export function renderWriteNudge(
  reason: string,
  turn: number,
  digest: string,
  suggestedTags: string[],
  queue?: PendingQueueStats | null,
  delegation?: boolean,
): string {
  const tags = suggestedTags.length > 0 ? suggestedTags.join('、') : '（用 memo_tags 看词汇表后选）'
  const lines = [
    `[memo-river·写入节律] 记忆节律提醒，非新任务：${reason}，turn ${turn} 的进展尚未入河——「${digest}」`,
  ]
  if (delegation) {
    lines.push(
      '委托进行中——先落盘当前进展：子代理/兄弟代理可立即召回。这篇日记的读者是兄弟代理而非未来的自己：写它们接手所需的可共享知识（结论/路径/教训），写增量（延续/转折/因果），不复述已入河内容。',
    )
  }
  lines.push(
    delegation
      ? `现在正是写日记的时机：用 memo_write 落一篇，Tag 优先复用词汇表：${tags}。规范见「写日记规范」段。`
      : `现在正是写日记的时机：用 memo_write 落一篇，写增量（延续/转折/因果），不复述已入河内容；Tag 优先复用词汇表：${tags}。规范见「写日记规范」段。`,
  )
  if (queue && queue.pending > 0) {
    const age = queue.oldestAgeHours !== null ? `（最老 ${ageText(queue.oldestAgeHours)}）` : ''
    lines.push(`草稿队列 ${queue.pending} 篇待批${age}——可提示用户处理（看草稿 / 批准 / 丢弃）。`)
  }
  return lines.join('\n')
}
