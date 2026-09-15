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
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Config } from './config.js'
import { cosine, WRITE_EMBED_OPTIONS } from './embed.js'
import { memoRiverRoot, readJsonSafe } from './runtime.js'
import { acquireWorkspace, type WorkspaceRuntime } from './workspace.js'

/* ── Tag 行解析与规范化（原 tools.ts；票06 下沉 drafts.ts——预审与写路径共用一份口径，
 *    且 drafts.ts 不得反向 import tools.ts：tools 单向依赖 drafts，反向即成环） ── */

const TAG_LINE = /^Tag\s*[:：]\s*(.+)$/im

/** §7.1 单篇 Tag 下限（memo_approve 跳过线与票06 预审「需人工」线共用）。 */
export const TAG_MIN = 3

export function parseTagLine(content: string): string[] {
  const m = content.match(TAG_LINE)
  if (!m) return []
  return m[1]!
    .split(/[,，、]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

/** 去掉正文里已有的 Tag 行（写盘时统一重排到末尾）。 */
export function stripTagLine(content: string): string {
  return content.replace(TAG_LINE, '').replace(/\n{3,}/g, '\n\n').trimEnd()
}

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
  /** 票06：守护预审三态分布（读伴随 .status.json；守护还没跑到的算 unchecked）。 */
  precheck: { ok: number; manual: number; discard: number; unchecked: number }
}

/** 数一个 pending 目录（只读、永不抛：读不到 = 空队列，不拖垮调用方）。 */
export function pendingQueueStats(pendingDir: string, now = Date.now()): PendingQueueStats {
  const precheck = { ok: 0, manual: 0, discard: 0, unchecked: 0 }
  let names: string[]
  try {
    names = readdirSync(pendingDir)
  } catch {
    return { pending: 0, oldestAgeHours: null, precheck }
  }
  let count = 0
  let oldest: number | null = null
  for (const f of names) {
    if (!f.endsWith('.md')) continue
    count++
    const st = readDraftStatus(join(pendingDir, f))
    if (st) precheck[st.state] += 1
    else precheck.unchecked += 1
    try {
      const mtimeMs = statSync(join(pendingDir, f)).mtimeMs
      if (oldest === null || mtimeMs < oldest) oldest = mtimeMs
    } catch {
      /* 文件竞态消失：计数仍算它，年龄取不到就跳过 */
    }
  }
  return { pending: count, oldestAgeHours: oldest === null ? null : Math.max(0, (now - oldest) / 3_600_000), precheck }
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
    /* 票06 修正：标题行尾只吃行内空白（[^\S\n]，不吃换行）——原 \s* 贪婪越过标题换行后，
     * 空节（两个连续换行）会把**下一节的标题行**吞进捕获组（实测：空「本轮用户」解析成
     * '## 本轮助手'），让预审把垃圾草稿误判「内容非空」。flushDrafts 写 '(空)' 不触发，
     * 但手写/外部草稿可以；解析器必须对空节稳健。 */
    const re = new RegExp(`^## ${name}[^\\S\\n]*\\n([\\s\\S]*?)(?=\\n^## |\\n^> |$)`, 'm')
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
    // 票06：伴随预审状态文件随草稿出队一起走（留档可追溯；失败静默——下轮预审的孤儿清扫兜底）
    try {
      renameSync(draftStatusPath(record.path), join(dir, basename(draftStatusPath(record.path))))
    } catch {
      /* 状态文件缺失/竞态：不影响出队本身 */
    }
    return true
  } catch {
    return false
  }
}

/* ── 票06：守护循环草稿预审（只读三态标记，绝不代批）──────────────────────────
 * 红线背景（D10 教训）：机械批准曾把「空用户+空助手」的草稿灌进库污染召回——
 * memo_approve 的 composeDiary 对这种草稿仍会产出非空 content（自动批准头 +
 * 两个「(空)」节），只要建议 Tag ∩ 词汇表 ≥3 就能过 writeDiaryCore 全部闸门。
 * 因此预审判定顺序固定：**垃圾判定必须先于 Tag 判定**。
 *   discard（建议丢弃）：空用户+空助手——无可入库内容（与 Tag 数无关）
 *   manual（需人工）  ：可复用 Tag <3（边界样本恰 2 个）；或近重复命中（建议
 *                       memo_update 合并/人工改写，丢不丢由人定）；或嵌入失败无法判近重复
 *   ok（可一键批）   ：内容非空 + ≥3 可复用 Tag + 非近重复
 * 标记落伴随状态文件 `<草稿>.md.status.json`（不写库、不改草稿正文、不动体检
 * 资产），随守护周期自动刷新；最终拍板永远是人在环的 memo_approve / memo_discard。 */

/** 预审三态。 */
export type DraftPrecheckState = 'ok' | 'manual' | 'discard'

/** 三态的展示名（memo_drafts 输出与日志共用）。 */
export const PRECHECK_LABELS: Record<DraftPrecheckState, string> = {
  ok: '可一键批',
  manual: '需人工',
  discard: '建议丢弃',
}

/** 单篇草稿的预审结论（伴随状态文件的形状）。 */
export interface DraftPrecheck {
  state: DraftPrecheckState
  reason: string
  /** 可复用 Tag（suggestedTags ∩ 词汇表，截 5——与 curateTags 同口径）。 */
  reusableTags: string[]
  /** 近重复孪生（state=manual 且因近重复被拦时非空）。 */
  nearDup: { path: string; score: number } | null
  /** 本结论的产生时刻（ISO；随守护周期刷新）。 */
  checkedAt: string
}

/** 伴随状态文件路径：`<草稿>.md.status.json`（与草稿同目录；结尾是 .json，不会被 *.md 计数扫到）。 */
export function draftStatusPath(draftPath: string): string {
  return `${draftPath}.status.json`
}

/** 读一篇草稿的预审状态（无文件或形状坏 = null，算 unchecked）。 */
export function readDraftStatus(draftPath: string): DraftPrecheck | null {
  const raw = readJsonSafe<Partial<DraftPrecheck> | null>(draftStatusPath(draftPath), null)
  if (!raw || typeof raw !== 'object' || !PRECHECK_LABELS[(raw.state as DraftPrecheckState) ?? '']) return null
  return {
    state: raw.state as DraftPrecheckState,
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    reusableTags: Array.isArray(raw.reusableTags) ? raw.reusableTags.filter((t): t is string => typeof t === 'string') : [],
    nearDup:
      raw.nearDup && typeof raw.nearDup === 'object' && typeof (raw.nearDup as { path?: unknown }).path === 'string'
        ? { path: (raw.nearDup as { path: string }).path, score: Number((raw.nearDup as { score?: unknown }).score) || 0 }
        : null,
    checkedAt: typeof raw.checkedAt === 'string' ? raw.checkedAt : '',
  }
}

/** 预审一轮的汇总（守护轮日志 / GuardianRound 用）。 */
export interface PrecheckSummary {
  ok: number
  manual: number
  discard: number
  /** 预审本身失败的篇数（解析/IO 异常——不产生状态文件，队列里算 unchecked）。 */
  failures: number
}

/**
 * 票06：对一个工作区的 pending/ 做只读预审并落伴随状态文件。
 * 两遍结构：①无嵌入判定（垃圾 / Tag 闸门）②近重复裁决（仅 ok 候选，与
 * writeDiaryCore ④.5 同口径：合批 embed 合成全文 → 对桶内带向量 chunk 取最大余弦，
 * > dedupCosine 即拦）。嵌入未配置或 dedupCosine=0 时跳过近重复（ok），与批准
 * 路径的离线行为同口径；嵌入配置了但失败 → 降级 manual（嵌入恢复后下轮自动复判）。
 * 永不抛、绝不写库/不动体检资产；顺手清扫孤儿状态文件（草稿已出队但残留）。
 */
export async function precheckDrafts(workspace: WorkspaceRuntime, dedupCosine: number): Promise<PrecheckSummary> {
  const summary: PrecheckSummary = { ok: 0, manual: 0, discard: 0, failures: 0 }
  let names: string[]
  try {
    names = readdirSync(workspace.paths.pendingDir)
  } catch {
    return summary /* 无 pending 目录 = 空队列 */
  }
  sweepOrphanStatuses(workspace.paths.pendingDir, names)
  const mdNames = names.filter((f) => f.endsWith('.md')).sort()
  if (mdNames.length === 0) return summary

  /* ① 无嵌入判定：垃圾（必须先于 Tag）→ 丢弃；可复用 Tag <TAG_MIN → 需人工。 */
  type Judged = {
    path: string
    /** 草稿头「桶：」行的目标桶（近重复比对与批准路径同口径）。 */
    bucket: string
    state: DraftPrecheckState
    reason: string
    tags: string[]
    nearDup: { path: string; score: number } | null
    /** 非空 = ok 候选的合成全文（与 writeDiaryCore 的 full 同构），待近重复裁决。 */
    full?: string
  }
  const judged: Judged[] = []
  for (const f of mdNames) {
    const path = join(workspace.paths.pendingDir, f)
    const record = parseDraftFile(path)
    if (!record) {
      summary.failures += 1
      continue
    }
    if (!record.userText.trim() && !record.assistantText.trim()) {
      judged.push({
        path,
        bucket: record.bucket,
        state: 'discard',
        reason: '空用户+空助手（D10 机械批准污染样本形态）——无可入库内容，建议 memo_discard',
        tags: [],
        nearDup: null,
      })
      continue
    }
    const tags = curateTags(record, workspace)
    if (tags.length < TAG_MIN) {
      judged.push({
        path,
        bucket: record.bucket,
        state: 'manual',
        reason: `可复用 Tag 仅 ${tags.length} 个（<${TAG_MIN}）：${tags.join(', ') || '无'}——一键批会跳过，待人工 memo_write 撰写`,
        tags,
        nearDup: null,
      })
      continue
    }
    /* ok 候选：合成与批准入库时逐字节同构的全文（composeDiary + Tag 行重排）。 */
    const { title, content } = composeDiary(record)
    judged.push({
      path,
      bucket: record.bucket,
      state: 'ok',
      reason: '',
      tags,
      nearDup: null,
      full: `# ${title}\n\n${stripTagLine(content)}\n\nTag: ${tags.join(', ')}\n`,
    })
  }

  /* ② 近重复裁决（仅 ok 候选；与 writeDiaryCore ④.5 同口径）。 */
  const pending = judged.filter((j) => j.full !== undefined)
  if (pending.length > 0) {
    const chunksByBucket = new Map<string, ReturnType<WorkspaceRuntime['store']['chunks']>>()
    const pathByBucketFile = new Map<string, Map<number, string>>()
    const chunksFor = (bucket: string) => {
      if (!chunksByBucket.has(bucket)) {
        chunksByBucket.set(bucket, workspace.store.chunks(bucket))
        pathByBucketFile.set(bucket, new Map(workspace.store.files(bucket).map((f) => [f.id, f.path])))
      }
      return chunksByBucket.get(bucket)!
    }
    let vectors: Array<Float32Array | Buffer> | null = null
    let embedErr: string | null = null
    if (dedupCosine > 0 && workspace.embed?.configured) {
      try {
        vectors = await workspace.embed.embed(
          pending.map((j) => j.full!),
          WRITE_EMBED_OPTIONS,
        )
      } catch (e) {
        embedErr = String((e as Error)?.message ?? e)
      }
    }
    if (vectors) {
      for (let i = 0; i < pending.length; i++) {
        const j = pending[i]!
        const bucket = j.bucket
        const chunks = chunksFor(bucket)
        const fileById = pathByBucketFile.get(bucket)!
        const vec = vectors[i]!
        let twin: { path: string; score: number } | null = null
        for (const c of chunks) {
          if (!c.vector) continue
          const score = cosine(vec as Float32Array, c.vector.subarray(0, workspace.resolved.dimension) as Float32Array)
          if (!twin || score > twin.score) twin = { path: fileById.get(c.file_id) ?? `chunk#${c.id}`, score }
        }
        if (twin && twin.score > dedupCosine) {
          j.state = 'manual'
          j.nearDup = twin
          j.reason = `与既有日记近重复（余弦 ${twin.score.toFixed(4)} > ${dedupCosine}）：${twin.path}——建议 memo_update 并入旧篇或 memo_discard`
        } else {
          j.reason = `内容非空 + ${j.tags.length} 个可复用 Tag + 非近重复${twin ? `（最近余弦 ${twin.score.toFixed(4)} ≤ ${dedupCosine}）` : '（库内无可比对向量）'}`
        }
      }
    } else if (embedErr) {
      for (const j of pending) {
        j.state = 'manual'
        j.reason = `近重复未能判定（嵌入失败：${embedErr}）——嵌入恢复后守护轮自动复判`
      }
    } else {
      for (const j of pending) {
        j.reason = `内容非空 + ${j.tags.length} 个可复用 Tag；近重复检查跳过（嵌入未配置或去重关闭）——与批准路径离线行为同口径`
      }
    }
  }

  /* ③ 落伴随状态文件 + 计数（写失败只计 failures，不抛）。 */
  const checkedAt = new Date().toISOString()
  for (const j of judged) {
    const status: DraftPrecheck = { state: j.state, reason: j.reason, reusableTags: j.tags, nearDup: j.nearDup, checkedAt }
    try {
      writeFileSync(draftStatusPath(j.path), JSON.stringify(status, null, 2) + '\n', 'utf8')
      summary[j.state] += 1
    } catch {
      summary.failures += 1
    }
  }
  return summary
}

/** 清扫孤儿状态文件：`*.md.status.json` 对应的 `*.md` 已不在队列（出队时带走失败/外部移动）。 */
function sweepOrphanStatuses(pendingDir: string, names: string[]): number {
  const mdSet = new Set(names.filter((f) => f.endsWith('.md')))
  let removed = 0
  for (const f of names) {
    if (f.endsWith('.md.status.json') && !mdSet.has(f.slice(0, -'.status.json'.length))) {
      try {
        rmSync(join(pendingDir, f))
        removed += 1
      } catch {
        /* 删不掉下轮再试 */
      }
    }
  }
  return removed
}
