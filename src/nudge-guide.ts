/**
 * 票 11（recall-quality-0916）：委托场景写入引导——冷门 Tag 建议 + 同轴合并提示。
 *
 * 背景（用户拍板「堵改疏」）：recall-quality 工作流里「禁止写生产桶」红线零抵抗力
 * （18 次 memo_write、6 篇落河），而 c9f838ba 里子代理写日记是知识总线的最佳实证。
 * 要治的是质量与重复，不是「写」这个动作。
 *
 * 实现约束（票 12 教训）：**纯路径直读磁盘**——不经 deps.getWorkspace（其副作用会
 * 扰动注入用的工作区/嵌入实例，#11/#25/#26/#31 五连红先例）。只扫 dailynote/*.md 的
 * 标题行与末尾 Tag 行，文件小、nudge 低频，成本可忽略。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface DiaryBrief {
  /** 文件名（含 .md）。 */
  name: string
  /** 标题（首行 `# ` 剥离；无则退化文件名去后缀）。 */
  title: string
  /** Tag 行解析结果（去空白、剔空串）。 */
  tags: string[]
  mtime: number
}

export interface TagScan {
  files: number
  /** Tag → 出现篇数。 */
  freq: Map<string, number>
  /** 按 mtime 新→旧。 */
  recent: DiaryBrief[]
}

const TAG_LINE_RE = /^[ \t]*Tag[：:][ \t]*(.+)$/gm

/** 解析单篇：标题（首个 `# ` 行）+ Tag 行（取**最后**一个匹配，容许多次出现）。 */
export function parseDiaryBrief(content: string, name: string): { title: string; tags: string[] } {
  const titleMatch = content.match(/^#\s+(.+)$/m)
  let rawTagLine = ''
  for (const m of content.matchAll(TAG_LINE_RE)) rawTagLine = m[1] ?? ''
  const rawTags = rawTagLine
    .split(/[,，、]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  return {
    title: titleMatch?.[1]?.trim() || name.replace(/\.md$/, ''),
    tags: rawTags,
  }
}

/** 扫一个日记目录（不存在/不可读 → null，调用方回落现状文案）。 */
export function scanTagAxis(dir: string, window = 12): TagScan | null {
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md'))
  } catch {
    return null
  }
  const freq = new Map<string, number>()
  const briefs: DiaryBrief[] = []
  for (const name of names) {
    try {
      const full = join(dir, name)
      const { title, tags } = parseDiaryBrief(readFileSync(full, 'utf8'), name)
      briefs.push({ name, title, tags, mtime: statSync(full).mtimeMs })
      for (const t of tags) freq.set(t, (freq.get(t) ?? 0) + 1)
    } catch {
      /* 单篇损坏不拖垮整扫 */
    }
  }
  briefs.sort((a, b) => b.mtime - a.mtime)
  return { files: briefs.length, freq, recent: briefs.slice(0, window) }
}

export interface ColdTagResult {
  tags: string[]
  /** 被剔除的枢纽 Tag（诊断用）。 */
  droppedHub: string[]
}

/**
 * 冷门 Tag 建议：从 suggestedTags 里剔除枢纽（f≥3 且 f≥files/3——绝对下限防小桶误判：
 * 1-2 篇的桶里 freq=1 就占 100%，那是「年轻桶」不是枢纽污染）；不足 limit 个时从词汇表
 * 补齐——只补**已存在**（freq≥1）且非枢纽的 Tag，按频次降序（冷门里偏常用的连通性
 * 最好），避免推荐从未出现的 Tag（会触发 newTagReason 闸门）。
 */
export function coldTagSuggest(
  suggested: string[],
  scan: TagScan,
  limit = 4,
): ColdTagResult {
  const isHub = (f: number): boolean => f >= 3 && scan.files > 0 && f >= scan.files / 3
  const kept: string[] = []
  const droppedHub: string[] = []
  for (const t of suggested) {
    const f = scan.freq.get(t) ?? 0
    if (f > 0 && isHub(f)) droppedHub.push(t)
    else kept.push(t)
  }
  if (kept.length < limit) {
    const candidates = [...scan.freq.entries()]
      .filter(([name, f]) => f >= 1 && !isHub(f) && !kept.includes(name))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name]) => name)
    for (const c of candidates) {
      if (kept.length >= limit) break
      kept.push(c)
    }
  }
  return { tags: kept.slice(0, limit), droppedHub }
}

export interface SameAxisHit {
  title: string
  overlap: number
  shared: string[]
}

/**
 * 同轴检测：近期（recent 窗口）是否有与本篇建议 Tag 高重叠的既有条目（共享 ≥ minOverlap）。
 * 命中 → 提示「优先 memo_update 并入 / memo_merge 归一，而非新开篇」。取重叠最大者。
 */
export function sameAxisHit(scan: TagScan, suggested: string[], minOverlap = 2): SameAxisHit | null {
  if (suggested.length === 0) return null
  let best: SameAxisHit | null = null
  for (const b of scan.recent) {
    const shared = suggested.filter((t) => b.tags.includes(t))
    if (shared.length >= minOverlap && (!best || shared.length > best.overlap)) {
      best = { title: b.title, overlap: shared.length, shared }
    }
  }
  return best
}
