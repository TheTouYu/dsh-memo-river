/**
 * src/drafts.ts — 草稿队列（`pending/*.md`）的读取、解析与消费（DESIGN §8.3）。
 *
 * 背景：守护循环把回合摘要落成 pending 草稿「等确认」，但此前**没有任何消费通道**，
 * 只进不出（实测 genshin 桶堆积 17 个）。2026-09-12 用户拍板消费方案：
 *  · memo_drafts  列队（默认本工作区；all=true 扫全部工作区）
 *  · memo_approve 一键批准入库——走 memo_write **同一套** Tag 校验与闸门（§7.1），
 *                  Tag 只复用既有词汇（∩ 词汇表，3–5 个），不够 3 个的草稿跳过待人工写
 *  · memo_discard 丢弃（移入 rejected/，不删文件，可追溯）
 * 批准/丢弃后文件分别移入 `approved/`、`rejected/`——队列即文件系统，天然可审计。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Config } from './config.js'
import { memoRiverRoot, readJsonSafe } from './runtime.js'
import { acquireWorkspace, type WorkspaceRuntime } from './workspace.js'

/* ── 票05：草稿队列可见性（write-nudge 文案 + 调参面板共用的只读读数）──────────
 * 「草稿漏斗断裂」（09-15 实测 preset-composer 33 篇 / memo-river 6 篇、批准 0）
 * 的第一刀是把队列数字暴露到每天都看的地方。计数口径 = pending/ 目录实际 .md
 * 文件数（解析成败不影响——坏文件躺在队列里同样是负担）；最老年龄按文件 mtime。 */

/** 单桶待批队列的可见性数字。 */
export interface PendingQueueStats {
  /** pending/*.md 实际文件数。 */
  pending: number
  /** 最老草稿年龄（小时，按 mtime）；空队列为 null（消费方各自决定显示形态）。 */
  oldestAgeHours: number | null
}

/** 数一个 pending 目录（只读、永不抛：读不到 = 空队列，不拖垮调用方）。 */
export function pendingQueueStats(pendingDir: string, now = Date.now()): PendingQueueStats {
  let names: string[]
  try {
    names = readdirSync(pendingDir)
  } catch {
    return { pending: 0, oldestAgeHours: null }
  }
  let count = 0
  let oldest: number | null = null
  for (const f of names) {
    if (!f.endsWith('.md')) continue
    count++
    try {
      const mtimeMs = statSync(join(pendingDir, f)).mtimeMs
      if (oldest === null || mtimeMs < oldest) oldest = mtimeMs
    } catch {
      /* 文件竞态消失：计数仍算它，年龄取不到就跳过 */
    }
  }
  return { pending: count, oldestAgeHours: oldest === null ? null : Math.max(0, (now - oldest) / 3_600_000) }
}

/**
 * 面板行：一个桶的队列可见性。
 * **票06 扩展形状**：守护预审三态标记（ok/warn/blocked 之类）将作为本对象的
 * 额外字段挂在同一条目上，面板行按字段渲染新列——计数展示不写死形状。
 */
export interface BucketQueueEntry extends PendingQueueStats {
  /** 工作区哈希（目录名）。 */
  hash: string
  /** 桶名（workspace.json 优先，缺省目录名）。 */
  bucket: string
  /** 工作区 cwd（manifest 缺失为 null）。 */
  cwd: string | null
}

/** 全部桶的队列快照（面板顶部常显；含 pending=0 的桶；排序 pending 降序 → 桶名）。 */
export function bucketQueueStats(now = Date.now()): BucketQueueEntry[] {
  const out: BucketQueueEntry[] = []
  let roots: string[]
  try {
    roots = readdirSync(memoRiverRoot(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(memoRiverRoot(), d.name))
  } catch {
    return out
  }
  for (const root of roots) {
    // 工作区桶的判定：有 manifest / pending 目录 / 库文件任一即算（不漏空队列桶）。
    if (!existsSync(join(root, 'workspace.json')) && !existsSync(join(root, 'pending')) && !existsSync(join(root, 'knowledge_base.sqlite'))) continue
    const manifest = readJsonSafe<{ cwd?: string; bucket?: string }>(join(root, 'workspace.json'), {})
    const stats = pendingQueueStats(join(root, 'pending'), now)
    out.push({
      hash: basename(root),
      bucket: (typeof manifest.bucket === 'string' && manifest.bucket) || basename(root),
      cwd: typeof manifest.cwd === 'string' ? manifest.cwd : null,
      ...stats,
    })
  }
  return out.sort((a, b) => b.pending - a.pending || a.bucket.localeCompare(b.bucket))
}

export interface DraftRecord {
  /** pending/*.md 绝对路径——批准/丢弃的句柄。 */
  path: string
  /** 工作区根（= dirname(pendingDir)）。 */
  root: string
  /** workspace.json 里的 cwd（打开运行时用）；无 manifest 时为 null。 */
  cwd: string | null
  /** 草稿头「桶：」行的桶名（写入 diaryName）。 */
  bucket: string
  session: string
  turn: number
  at: string
  userText: string
  assistantText: string
  suggestedTags: string[]
  relatedIds: number[]
}

/** 解析一篇草稿 .md（守护循环 flushDrafts 的固定格式）。坏文件返回 null。 */
export function parseDraftFile(path: string): DraftRecord | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const section = (name: string): string => {
    const re = new RegExp(`^## ${name}\\s*\\n([\\s\\S]*?)(?=\\n^## |\\n^> |$)`, 'm')
    const m = raw.match(re)
    return m ? m[1]!.trim() : ''
  }
  const header = (name: string): string => {
    const m = raw.match(new RegExp(`^- ${name}：(.+)$`, 'm'))
    return m ? m[1]!.trim() : ''
  }
  const turnRaw = header('回合')
  const turn = Number.parseInt((turnRaw.match(/^(\d+)/) ?? [])[0] ?? '', 10)
  const suggestedRaw = section('建议 Tag（来自本轮被动召回的 matchedTags，须经 memo_tags 复核后复用）')
  const suggestedTags = suggestedRaw
    .split(/[,，、]/)
    .map((t) => t.trim())
    .filter((t) => t && t !== '(无)')
  const relatedRaw = section('相关旧日记')
  const root = dirname(dirname(path))
  const manifest = readJsonSafe<{ cwd?: string; bucket?: string }>(join(root, 'workspace.json'), {})
  return {
    path,
    root,
    cwd: typeof manifest.cwd === 'string' ? manifest.cwd : null,
    bucket: header('桶') || manifest.bucket || basename(root),
    session: header('会话'),
    turn: Number.isFinite(turn) ? turn : -1,
    at: (turnRaw.match(/@\s*(.+)$/)?.[1] ?? '').trim(),
    userText: section('本轮用户').replace(/^\(空\)$/, ''),
    assistantText: section('本轮助手').replace(/^\(空\)$/, ''),
    suggestedTags,
    relatedIds: relatedRaw
      .replace(/^\(无\)$/, '')
      .split(/\s+/)
      .map((t) => t.replace(/^D/, ''))
      .map((t) => Number.parseInt(t, 10))
      .filter((n) => Number.isFinite(n) && n >= 0),
  }
}

/** 列待确认草稿。all=false 只列 currentRoot 工作区；按文件名排序（含日期+回合）。 */
export function listPending(currentRoot: string | null, all: boolean): DraftRecord[] {
  const out: DraftRecord[] = []
  let roots: string[]
  try {
    roots = readdirSync(memoRiverRoot(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(memoRiverRoot(), d.name))
  } catch {
    return out
  }
  for (const root of roots) {
    if (!all && root !== currentRoot) continue
    const pendingDir = join(root, 'pending')
    if (!existsSync(pendingDir)) continue
    for (const f of readdirSync(pendingDir)) {
      if (!f.endsWith('.md')) continue
      const rec = parseDraftFile(join(pendingDir, f))
      if (rec) out.push(rec)
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/** 按用户给的 id（文件名子串或全路径）匹配草稿；歧义/未命中报错文本。 */
export function matchDrafts(
  listing: DraftRecord[],
  ids: string[],
): { ok: DraftRecord[]; errors: string[] } {
  const ok: DraftRecord[] = []
  const errors: string[] = []
  for (const id of ids) {
    const needle = id.trim()
    if (!needle) continue
    const hits = listing.filter((r) => r.path.includes(needle) || basename(r.path) === needle)
    if (hits.length === 0) errors.push(`未命中：${needle}`)
    else if (hits.length > 1) errors.push(`歧义（${hits.length} 篇）：${needle} → ${hits.map((h) => basename(h.path)).join(', ')}`)
    else ok.push(hits[0]!)
  }
  return { ok, errors }
}

/** 打开草稿所属工作区的运行时（按 workspace.json 的 cwd）。失败返回 null。 */
export function workspaceFor(record: DraftRecord, config: Config): WorkspaceRuntime | null {
  if (!record.cwd) return null
  try {
    return acquireWorkspace(record.cwd, config)
  } catch {
    return null
  }
}

/** Tag 策展：建议 Tag ∩ 既有词汇表，去重后截 5 个（§7.1 上限）。 */
export function curateTags(record: DraftRecord, workspace: WorkspaceRuntime): string[] {
  const vocab = new Set(workspace.store.tags().map((t) => t.name))
  const out: string[] = []
  for (const t of record.suggestedTags) {
    if (vocab.has(t) && !out.includes(t)) out.push(t)
    if (out.length >= 5) break
  }
  return out
}

/** 由草稿合成日记正文与标题（自动批准的机械合成；Tag 仍走闸门）。 */
export function composeDiary(record: DraftRecord): { title: string; content: string } {
  const head = (record.userText || record.assistantText || '')
    .replace(/^<[^>]+>\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
  const title = head.slice(0, 24) || `回合${record.turn}草稿`
  const content = [
    `- 自动批准自草稿 \`${basename(record.path)}\`（回合 ${record.turn} @ ${record.at || '未知时间'}，会话 ${record.session || '未知'}）`,
    '',
    '## 本轮用户',
    record.userText || '(空)',
    '',
    '## 本轮助手',
    record.assistantText || '(空)',
    record.relatedIds.length > 0 ? `\n相关旧日记：${record.relatedIds.map((id) => `D${id}`).join(' ')}` : '',
  ]
    .join('\n')
    .trimEnd()
  return { title, content }
}

/** 草稿出队：移入 approved/ 或 rejected/（不删文件，可追溯）。 */
export function resolveDraft(record: DraftRecord, dest: 'approved' | 'rejected'): boolean {
  try {
    const dir = join(record.root, dest)
    mkdirSync(dir, { recursive: true })
    renameSync(record.path, join(dir, basename(record.path)))
    return true
  } catch {
    return false
  }
}
