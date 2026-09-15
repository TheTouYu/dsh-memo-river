/**
 * src/tools.ts — 工具面（DESIGN.md §7）。
 *
 *  · `memo_recall` 主动补证（§7.2）
 *  · `memo_write`  写作闭环硬契约（§7.1）
 *  · `memo_tags`   Tag 词汇表（§7.4）
 *  · `memo_stats`  四项体检（§7.3）
 *
 * `memo_write` 的执行顺序**不可省略**：回注 → 校验 → 新 Tag 闸门 → 写入 → 返回体检增量。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import type { Config } from './config.js'
import {
  composeDiary,
  curateTags,
  listPending,
  matchDrafts,
  parseTagLine,
  PRECHECK_LABELS,
  readDraftStatus,
  resolveDraft,
  stripTagLine,
  TAG_MIN,
  workspaceFor,
  type DraftRecord,
} from './drafts.js'
import { cosine, WRITE_EMBED_OPTIONS, WRITE_EMBED_RETRIES, WRITE_EMBED_TIMEOUT_MS } from './embed.js'
import { formatHealth, healthReport, HUB_RATIO_LIMIT, KV_USAGE, readUsageLedger, recordUsage } from './health.js'
import { excerpt } from './render.js'
import { setTuning, tuningSnapshot, tuningDefaults, tuningValues } from './tuning.js'
import { tieBreakerParamsFrom } from './tiebreaker.js'
import { listSessions } from './session.js'
import type { RecallOptions } from './recall.js'
import type { Logger } from './runtime.js'
import type { WorkspaceRuntime } from './workspace.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }],
}

/** §7.1 校验常量（TAG_MIN 已下沉 drafts.ts：票06 预审与写路径共用一份口径）。 */
const TAG_MAX = 5
const TAG_NAME_MAX = 20
/** 与既有 Tag 余弦 > 0.92 视为同义漂移（§7.1 第 2 步）。 */
export const SYNONYM_COSINE = 0.92

/** 票 04：memo_approve 批量批准的有界并行度（模式同 embed.ts 的 TAG_VECTORIZE_CONCURRENCY）。
 * 09-15 实测：批准 33 篇草稿 ~25s/篇量级的串行等待，瓶颈是每篇一次写侧嵌入 RTT（1.2–1.45s）
 * ——逐篇串行改 worker-pool 并行后，N 篇 ≈ ⌈N/并行度⌉ × 单篇。 */
const APPROVE_CONCURRENCY = Number(process.env.MEMO_APPROVE_CONCURRENCY) || 5

export interface ToolDeps {
  config: Config
  getWorkspace(cwd: string): WorkspaceRuntime
  log(level: 'info' | 'warn' | 'error', message: string): void
}

/** 查看者视角：从工具执行上下文解析 sessionId + cwd。 */
export function viewerOf(exec: unknown): { sessionId: string | null; cwd: string } {
  const agent = (exec as { agent?: { session?: { id?: string; header?: { cwd?: string } } } })?.agent
  return {
    sessionId: agent?.session?.id ?? null,
    cwd: agent?.session?.header?.cwd ?? process.cwd(),
  }
}

/** memo_tuning（§6.6 调参面板的工具面：面板走 HTTP，模型/用户走工具）。 */
function registerMemoTuning(ctx: { tools: { register(tool: unknown): () => void } }, config: Config): void {
  ctx.tools.register(
    defineTool({
      name: 'memo_tuning',
      description:
        '读取/修改调参（写侧四锚：时间分钟/汇报轮/步数/上下文增量字符；读侧 tie-breaker 四参：开关/上界/饱和/半衰期）。' +
        'action=get 看当前值与来源；action=set 修改：scope=preset 预设级（落盘 tuning.json，全工作区持久生效）| ' +
        'scope=session 仅当前会话（进程内，实验用——票⑤ tie-breaker 实验通道）。改完即时生效，无需重启。面板：GET /memo-river/tuning/panel',
      parameters: {
        action: { type: 'string', description: 'get=读取当前值与来源；set=修改' },
        scope: { type: 'string', description: "set 的生效范围：preset=预设级（落盘 tuning.json，全工作区持久）；session=仅当前会话（进程内实验）。缺省 preset" },
        writeNudgeEveryMinutes: { type: 'number', description: '时间锚（分钟），0=关' },
        writeNudgeEveryTurns: { type: 'number', description: '汇报轮锚（小轮数），0=关' },
        writeNudgeEverySteps: { type: 'number', description: '步锚（步数），0=关' },
        writeNudgeGrowthChars: { type: 'number', description: '增量锚（字符），0=关' },
        tieBreakerEnabled: { type: 'number', description: '票⑤ 有界 tie-breaker 开关：1=开 0=关（默认 0=关）' },
        tieBreakerCap: { type: 'number', description: '强化上界（默认 0.05）' },
        tieBreakerTau: { type: 'number', description: 'tanh 饱和常数（默认 2）' },
        tieBreakerRecencyHalfLifeDays: { type: 'number', description: '主动召回半衰期天数（默认 30）' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args: Record<string, unknown>, exec: unknown) {
        const viewer = viewerOf(exec)
        const SPEC_KEYS = ['writeNudgeEveryMinutes', 'writeNudgeEveryTurns', 'writeNudgeEverySteps', 'writeNudgeGrowthChars', 'tieBreakerEnabled', 'tieBreakerCap', 'tieBreakerTau', 'tieBreakerRecencyHalfLifeDays']
        if (args.action === 'get') {
          const snap = tuningSnapshot(config, tuningDefaults(), listSessions)
          const mine = viewer.sessionId ? (snap.session[viewer.sessionId] ?? {}) : {}
          const lines = [
            `当前会话：${viewer.sessionId ?? '（无）'}`,
            ...snap.spec.map((s) => {
              const v = (mine as Record<string, number>)[s.key] ?? snap.preset[s.key] ?? snap.defaults[s.key] ?? 0
              const src = (mine as Record<string, number>)[s.key] !== undefined ? '会话覆盖' : snap.preset[s.key] !== undefined ? '预设覆盖' : '默认'
              return `· ${s.key} = ${v}（${src}）—— ${s.label}：${s.hint}`
            }),
            `会话级覆盖：${Object.keys(mine).length > 0 ? JSON.stringify(mine) : '无'}；预设级 tuning.json：${JSON.stringify(snap.preset)}`,
          ]
          return lines.join('\n')
        }
        const scope = args.scope === 'session' ? 'session' : 'preset'
        const values: Record<string, number> = {}
        for (const k of SPEC_KEYS) {
          const v = args[k]
          if (typeof v === 'number' && Number.isFinite(v)) values[k] = v
        }        const result = setTuning(config, scope, values, viewer.sessionId)
        const parts = [
          result.rejected.length > 0 ? `被拒：${result.rejected.map((r) => `${r.key}（${r.reason}）`).join('；')}` : null,
          Object.keys(result.applied).length > 0
            ? `已应用（${scope === 'preset' ? '预设级，落盘 ' + result.file : '会话级 ' + viewer.sessionId}）：${JSON.stringify(result.applied)}，即时生效`
            : null,
        ].filter(Boolean)
        if (parts.length === 0) return '没有任何变更（未给任何数值参数）'
        return parts.join('\n')
      },
    }),
  )
}

/* ────────────── Tag 行解析与规范化 ──────────────
 * 票06：定义已下沉 src/drafts.ts（预审与写路径共用一份口径；此处转口导出保持 API 路径不变）。 */
export { parseTagLine, stripTagLine } from './drafts.js'

function titleFromContent(content: string, fallback: string): string {
  const first = content.split(/\r?\n/).find((l) => l.trim().length > 0)
  if (first && first.trim().startsWith('# ')) return first.trim().slice(2).trim()
  return fallback
}

function slugify(text: string): string {
  const s = text
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return s || 'diary'
}

/* ────────────── 语义相关旧日记（回注用） ────────────── */

async function relatedDiaries(workspace: WorkspaceRuntime, content: string, limit = 3): Promise<string[]> {
  try {
    // 票 03：写路径嵌入预算（15s + 重试 1 次）——回注查询不再共用注入路径的 60s 宽松超时。
    const [vec] = await workspace.embed.embed([content.slice(0, 2000)], WRITE_EMBED_OPTIONS)
    if (!vec) return []
    const chunks = workspace.store.chunks().filter((c) => c.vector !== null)
    const owners = workspace.store.chunkOwners()
    return chunks
      .map((c) => ({ id: c.id, score: cosine(vec, c.vector!.subarray(0, workspace.resolved.dimension)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((c) => {
        const owner = owners.get(c.id)
        const title = owner ? (owner.path.replace(/\\/g, '/').split('/').pop() ?? '').replace(/\.[^.]+$/, '') : `D${c.id}`
        return `D${c.id}「${title}」 knn=${c.score.toFixed(3)}`
      })
  } catch {
    return []
  }
}

/** ① 写前回注（票 03 抽公共）：旧 Tag 词汇表 + 语义相关旧日记 + 枢纽警告。
 * write/update/merge 三入口此前各持一份复制拼装——口径漂移风险同 firstSentence/excerpt 同族教训，收敛为一份。
 * 返回 Promise：调用方**不要 await**，直接作为 writeDiaryCore 的 preamble 传入——
 * 回注嵌入（本函数内的 relatedDiaries）与 writeDiaryCore 启动的合批嵌入并行在飞。 */
async function composeReinjection(
  workspace: WorkspaceRuntime,
  content: string,
  lead: string[],
  bucket: string,
): Promise<string> {
  const freq = workspace.store.tagFrequency()
  const total = workspace.store.files().length
  const reinjectTop = freq.slice(0, 30).map((t) => `${t.name}×${t.count}`).join(', ') || '(空库)'
  const related = await relatedDiaries(workspace, content)
  const pre = healthReport(workspace.store, bucket)
  const hubWarn =
    pre.hub && pre.hub.ratio >= HUB_RATIO_LIMIT
      ? `⚠️ 枢纽警告：「${pre.hub.name}」已出现 ${pre.hub.count}/${total} 篇（≥1/3），再堆它会让直接锚泛化`
      : `枢纽检查：当前最大 Tag 频次 ${pre.hub ? `${pre.hub.name}×${pre.hub.count}` : 'n/a'}（<1/3 ✅）`
  return [
    ...lead,
    `【写前回注】旧 Tag 词汇表（top ${Math.min(30, freq.length)}）：${reinjectTop}`,
    `【写前回注】语义相关旧日记：${related.length > 0 ? related.join(' / ') : '(无)'}`,
    `【写前回注】${hubWarn}；当前连通分量 = ${pre.components}（判据 =1）`,
  ].join('\n')
}

/* ────────────── memo_recall ────────────── */

function parseTimeRange(raw: string | undefined): { from: string; to: string } | null {
  if (!raw) return null
  const m = raw.match(/^\s*(\d{4}-\d{2}-\d{2})\s*[~～-]\s*(\d{4}-\d{2}-\d{2})\s*$/)
  if (!m) return null
  return { from: m[1]!, to: m[2]! }
}

/** 从文件名前缀取日期（语料形如 `2026-09-10-20_10_00 开工：…`）。 */
function dateOf(path: string): string | null {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const m = base.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1]! : null
}

export function formatRecallResult(
  workspace: WorkspaceRuntime,
  outcome: Awaited<ReturnType<WorkspaceRuntime['recall']>>,
  query: string,
): string {
  const lines: string[] = [`【记忆河流·memo_recall】「${query}」`]
  if (!outcome.injected && outcome.candidates.length === 0) {
    lines.push(`· 无结果：fallbackReason=${outcome.fallbackReason}`)
    lines.push(`· gate=${JSON.stringify(outcome.gate)}`)
    return lines.join('\n')
  }
  lines.push(
    `· Ω=${outcome.omega === null ? 'n/a' : outcome.omega.toFixed(3)} regime=${outcome.regime ?? '-'} mode=${outcome.mode} ` +
      `候选=${outcome.candidateCount} 注入=${outcome.selected.length}`,
  )
  for (const c of outcome.candidates.slice(0, 12)) {
    lines.push(
      `· D${c.id}「${c.title}」 score=${c.score.toFixed(4)} knn=${c.knnScore.toFixed(4)} role=${c.role} ` +
        `anchor=${c.anchorBonus.toFixed(3)} topology=${c.topologyBonus.toFixed(3)} ` +
        `omega=${c.omega === null ? 'n/a' : c.omega.toFixed(3)} regime=${c.riverRegime ?? '-'} ` +
        `tags=${c.matchedTags.join(',') || '-'}${c.rewardSuppressed ? ' [reward-suppressed]' : ''}`,
    )
    const body = excerpt(c.body, 120)
    if (body) lines.push(`    ${body}`)
  }
  if (outcome.dropped.length > 0) {
    lines.push(`· 未注入：${outcome.dropped.map((d) => `D${d.id}(${d.reason})`).join(' ')}`)
  }
  lines.push(`· diagnostics=${JSON.stringify(outcome.diagnostics)} fallbackReason=${outcome.fallbackReason ?? 'none'}`)
  return lines.join('\n')
}

/* ────────────── 写入核心（§7.1 硬契约 ②–⑤；memo_write 与 memo_approve 共用） ──────────────
 *
 * ⚠ 两个入口（手写 memo_write / 草稿一键批准 memo_approve）**必须共用这一份**校验与写入
 *   ——闸门逻辑一旦复制两份，口径迟早漂移（同族教训：firstSentence/excerpt 曾因两套
 *   过滤不一致导致注入块正文整行消失）。
 */
export interface WriteDiaryInput {
  /** 已定稿正文（含可选 Tag 行；tags 参数优先）。 */
  content: string
  /** 已定稿 Tag 列表（调用方负责来源：memo_write 从参数/Tag 行解析；approve 从词汇表策展）。 */
  tags: string[]
  /** 显式标题（可空串 → 取正文 `#` 首行 → `${date} 未命名`）。 */
  title: string
  /** YYYY-MM-DD。 */
  date: string
  /** 桶名（diaryName）。 */
  bucket: string
  newTagReason: string
  /** 写入内容去重阈值（0=关；调用方从 config.write.dedupCosine 传入，核心默认 0.88）。 */
  dedupCosine?: number
  /** 拒绝/成功报告的前置段（memo_write 传写前回注；memo_approve 传草稿出处；memo_update 传改写目标+回注）。
   * 票 03：允许传 Promise——write/update/merge 传 composeReinjection(...) 的**在飞** Promise，
   * 让回注嵌入与 writeDiaryCore 的合批嵌入并行；memo_approve 仍传 string。 */
  preamble: string | Promise<string>
  /** 改写模式（票 02）：按 D-id 定位目标，原路径重写、库内同路径 upsert（fileId 不变，
   *  使用台账足迹随之保留——同一篇记忆的刷新而非新记忆）。去重闸门自动豁免目标自身 chunk。 */
  updateOf?: { fileId: number; path: string }
  /** 去重闸门豁免集（票 03）：合并声明源的旧 chunk 不算孪生（豁免仅对声明源生效）。
   *  缺省 = updateOf 自身；未声明的第三篇近重复仍会被拒。 */
  exemptFileIds?: number[]
  /** 报告里的工具名（拒绝文案归属）。 */
  toolName: string
}

export interface WriteDiaryResult {
  status: 'written' | 'rejected'
  report: string
  chunkId?: number
  filePath?: string
  title?: string
  tags?: string[]
}

export async function writeDiaryCore(
  workspace: WorkspaceRuntime,
  input: WriteDiaryInput,
): Promise<WriteDiaryResult> {
  const logger: Logger = workspace.logger
  const { content, toolName, date, bucket } = input
  const tags = input.tags
  const healthLines: string[] = []

  /* 票 03：前置纯计算提前（newTags / full 的归一化不依赖任何 I/O）——让写侧合批嵌入
   * 立即启动，与调用方 preamble Promise 里的回注嵌入并行在飞。 */
  const existing = workspace.store.tags()
  const existingNames = new Set(existing.map((t) => t.name))
  const newTags = tags.filter((t) => !existingNames.has(t))
  const title = input.title || titleFromContent(content, `${date} 未命名`)
  const body = stripTagLine(content)
  const full = `# ${title}\n\n${body}\n\nTag: ${tags.join(', ')}\n`
  const dedupCosine = input.dedupCosine ?? 0.95 // 定标见 config.ts WriteConfig 注释

  /* 票 03 合批：原 newTags（同义漂移）/ full（去重+chunk 向量）/ tagVectors 三处串行单条 embed
   * → 一次批量请求 [...newTags, full]，写路径预算 15s + 失败重试 1 次（尾部硬顶 ~30s）。
   * 向量三用：③ 同义漂移检查 / ④.5 内容去重与 chunk 向量 / 新 Tag 向量（原 :396 调用点整个消掉）。 */
  const writeEmbed = workspace.embed.configured
    ? workspace.embed
        .embed([...newTags, full], WRITE_EMBED_OPTIONS)
        .then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }))
    : null

  const preamble = await input.preamble // 回注嵌入此刻在飞；这里只是等前置段拼好
  const reject = (reason: string, extra = ''): WriteDiaryResult => ({
    status: 'rejected',
    report: `${preamble}\n\n❌ ${toolName} 被拒绝：${reason}${extra ? `\n${extra}` : ''}\n（拒绝即不落库；请修正后重试。）`,
  })

  /* ② 校验 */
  if (!content) return reject('content 为空')
  if (tags.length === 0) {
    return reject(
      'missing-tag-line：必须有 Tag 行',
      '请在正文末尾加一行 `Tag: a, b, c`，或用 tags 参数给出 3–5 个 Tag。',
    )
  }
  if (tags.length > TAG_MAX) {
    return reject(`too-many-tags：${tags.length} 个 Tag 超过单篇上限 ${TAG_MAX}`, `Tags: ${tags.join(', ')}`)
  }
  if (tags.length < TAG_MIN) {
    return reject(`too-few-tags：${tags.length} 个 Tag 少于单篇下限 ${TAG_MIN}`, `Tags: ${tags.join(', ')}`)
  }
  const longTag = tags.find((t) => [...t].length > TAG_NAME_MAX)
  if (longTag) return reject(`tag-too-long：Tag 名 ≤${TAG_NAME_MAX} 字`, `「${longTag}」为 ${[...longTag].length} 字`)

  /* 票 03 嵌入预算裁决：配置了嵌入但 15s×(1+重试) 后仍失败 → 整个写入以明确错误返回、不悬挂。
   * 不落无向量日记：chunk 向量为空的篇永不可 KNN 召回，旧文案许诺的「守护循环补算」并无对应代码
   * （grep daemon 无补算路径），且去重/同义闸门一旦空转就是复读机语料的污染入口（D10 教训）。
   * 未配置嵌入的环境不受影响——仍走原「跳过检查、向量留空」的离线路径。 */
  let writeVectors: Float32Array[] | null = null
  if (writeEmbed) {
    const r = await writeEmbed
    if (r.ok) {
      writeVectors = r.v
    } else {
      const err = String((r.e as Error)?.message ?? r.e)
      logger.warn(`${toolName} bucket=${bucket} rejected=embed-unavailable err=${err}`)
      return reject(
        `embed-unavailable：写路径嵌入在 ${WRITE_EMBED_TIMEOUT_MS / 1000}s 预算内重试 ${WRITE_EMBED_RETRIES} 次后仍失败`,
        `${err}\n本次写入已中止（未落库）；嵌入服务恢复后重试即可。`,
      )
    }
  }
  const fullVector: Float32Array | null = writeVectors ? (writeVectors[newTags.length] ?? null) : null
  const tagVectors: Float32Array[] = writeVectors ? newTags.map((_, i) => writeVectors![i]!) : []

  /* ③ 新 Tag 闸门 + 同义漂移检查（向量来自合批结果——同文本同端点，判定与串行版一致） */
  if (newTags.length > 0) {
    if (!input.newTagReason) {
      return reject(
        `unconfirmed-new-tags：引入库中不存在的 Tag 必须给 newTagReason`,
        `新 Tag：${newTags.join(', ')}\n若其中某个只是想表达已有概念，请复用：${[...existingNames].slice(0, 30).join(', ')}`,
      )
    }
    // 同义漂移：新 Tag 与既有 Tag 向量余弦 > 0.92 → 要求复用
    if (workspace.embed.configured) {
      for (let i = 0; i < newTags.length; i++) {
        const vec = tagVectors[i]!
        let best: { name: string; score: number } | null = null
        for (const tag of existing) {
          if (!tag.vector) continue
          const score = cosine(vec, tag.vector.subarray(0, workspace.resolved.dimension))
          if (!best || score > best.score) best = { name: tag.name, score }
        }
        if (best && best.score > SYNONYM_COSINE) {
          return reject(
            `synonym-of-existing-tag：新 Tag「${newTags[i]}」与既有 Tag「${best.name}」余弦 ${best.score.toFixed(4)} > ${SYNONYM_COSINE}`,
            '同义堆砌会造成 Tag 漂移——请复用既有 Tag（§1 语料治理）。',
          )
        }
      }
    } else {
      healthLines.push('· 同义漂移检查跳过（嵌入未配置）')
    }
  }

  /* ④ 写入（pre 必须在写入前取——⑤ 的「体检增量」是前后对比） */
  const pre = healthReport(workspace.store, bucket)
  const slug = slugify(title)

  /* ④.5 内容去重闸门（DESIGN §7.1 步 3.5）：新日记 vs 本桶既有 chunk 的最大余弦。
   * 写侧对称物 of inject.dedupeSelection——读侧防重复注入，写侧防重复入库。
   * 票 03：嵌入已在合批里算好（fullVector），此处不再二次 embed full。 */
  if (dedupCosine > 0 && fullVector) {
    const bucketChunks = workspace.store.chunks(bucket)
    const fileById = new Map(workspace.store.files(bucket).map((f) => [f.id, f.path]))
    /* 去重豁免（票 02/03）：改写目标与合并声明源自己的旧 chunk 不算孪生——
     * 「自我改写/合并文与原文相近」是合法用例；未声明的第三篇近重复仍受闸门约束。 */
    const exempt = new Set(input.exemptFileIds ?? (input.updateOf ? [input.updateOf.fileId] : []))
    let twin: { path: string; score: number } | null = null
    for (const c of bucketChunks) {
      if (exempt.has(c.file_id)) continue
      if (!c.vector) continue
      const score = cosine(fullVector, c.vector.subarray(0, workspace.resolved.dimension))
      if (!twin || score > twin.score) twin = { path: fileById.get(c.file_id) ?? `chunk#${c.id}`, score }
    }
    if (twin && twin.score > dedupCosine) {
      logger.info(
        `memo_write bucket=${bucket} rejected=near-duplicate-diary cosine=${twin.score.toFixed(4)}>${dedupCosine} twin=${twin.path}`,
      )
      return reject(
        `near-duplicate-diary：与既有日记余弦 ${twin.score.toFixed(4)} > ${dedupCosine}`,
        `最像的一篇：${twin.path}\n被催出来的复读会把语料堆成回声室——写增量/转折，或合并进旧篇。`,
      )
    }
  }

  /* 改写模式：原路径重写（文件名保留首次写入时的日期-slug，路径即身份）；新建模式：新路径。
   * 护栏：目标路径在**工作区根之外**（导入语料常带源库绝对路径，如 VCP dailynote）→ 只更新库，
   * 不写磁盘——参照语料文件绝不能被工作区写路径触碰（票②实测教训）。 */
  const dir = join(workspace.paths.root, 'dailynote', slugify(bucket))
  mkdirSync(dir, { recursive: true })
  let filePath = input.updateOf ? input.updateOf.path : join(dir, `${date}-${Date.now().toString(36)}-${slug}.md`)
  const prevRow = input.updateOf
    ? (workspace.store.files().find((f) => f.id === input.updateOf!.fileId) ?? null)
    : null
  if (input.updateOf && !filePath.startsWith(workspace.paths.root)) {
    healthLines.push(`· 改写目标路径在工作区根之外，只更新库不落盘：${filePath}`)
    logger.warn(`memo_update path-outside-workspace bucket=${bucket} file=D${input.updateOf.fileId} path=${filePath}（库内已更新，磁盘未动）`)
  } else {
    writeFileSync(filePath, full)
  }

  const chunkVector: Float32Array | null = fullVector
  /* 票 03：tagVectors 已在合批结果里（writeVectors 前段）——原 :396 二次 embed 调用点删除。 */

  const tagIds: number[] = []
  tags.forEach((name, i) => {
    const isNew = !existingNames.has(name)
    tagIds.push(workspace.store.upsertTag(name, isNew ? (tagVectors[newTags.indexOf(name)] ?? null) : null))
    void i
  })
  const written = workspace.store.writeDiary({
    path: filePath,
    diaryName: bucket,
    checksum: createHash('sha256').update(full).digest('hex'),
    mtime: Date.now(),
    size: Buffer.byteLength(full, 'utf8'),
    content: full,
    chunkVector,
    tagIds,
  })
  logger.info(
    `memo_write bucket=${bucket} file=${filePath} chunk=D${written.chunkId} tags=${tags.join(',')} newTags=${newTags.join(',') || '-'}`,
  )
  /* 改写审计行（票 02）：哪篇、旧→新 checksum、改写后标题。 */
  if (input.updateOf) {
    logger.info(
      `memo_update bucket=${bucket} file=D${written.fileId} path=${filePath} ` +
        `checksum ${prevRow ? String(prevRow.checksum).slice(0, 12) : '?'}→${createHash('sha256').update(full).digest('hex').slice(0, 12)} ` +
        `title=${title} tags=${tags.join(',')}（原路径重写，fileId/台账足迹保留）`,
    )
  }

  /* ⑤ 返回体检增量（异步重建资产，不阻塞本次返回） */
  void (async () => {
    try {
      if (await workspace.ensureLoaded()) {
        // ⚠ 顺序要紧：**先刷新原生日记索引，再重建资产**。
        // 只重建资产（旧写法）会让写入之后的召回全部跑在空索引上 ——
        // 实测 Ω 被压成 0.010 collapsed，直到进程重启才恢复 0.269 sparse。
        await workspace.engine.reloadDiaryIndex()
        await workspace.engine.ensureArtifact(true)
        logger.info(
          `memo_write artifact-rebuilt chunkIds=${workspace.engine.chunkIds.length}`,
        )
      }
    } catch (e) {
      logger.warn(`memo_write artifact-rebuild-failed: ${String((e as Error)?.message ?? e)}`)
    }
  })()

  const post = healthReport(workspace.store, bucket)
  const inRiver = workspace.store
    .files()
    .filter((f) => f.id !== written.fileId)
    .map((f) => ({ id: f.id, tags: new Set(workspace.store.fileTags(f.id).map((t) => t.name)) }))
    .filter((f) => tags.some((t) => f.tags.has(t)))
    .map((f) => `D${f.id}`)

  return {
    status: 'written',
    chunkId: written.chunkId,
    filePath,
    title,
    tags,
    report: [
      preamble,
      '',
      `✅ 已写入 D${written.chunkId}「${title}」 → ${filePath}`,
      `· 新 Tag：${newTags.length > 0 ? `${newTags.join(', ')}（理由：${input.newTagReason}）` : '无（全部复用既有 Tag）'}`,
      `· 该篇在河中的位置：与 ${inRiver.length} 篇既有日记共享 Tag${inRiver.length > 0 ? `（${inRiver.slice(0, 10).join(' ')}）` : ''}`,
      `· 新 Tag 频次：${tags.map((t) => `${t}×${post.counts.tags > 0 ? (workspace.store.tagFrequency().find((x) => x.name === t)?.count ?? 0) : 0}`).join(', ')}`,
      ...healthLines,
      '',
      formatHealth(post),
      post.components === 1 && pre.components === 1
        ? '· 体检增量：连通分量仍为 1 ✅'
        : `· 体检增量：连通分量 ${pre.components} → ${post.components}`,
    ].join('\n'),
  }
}

/* ────────────── 注册 ────────────── */

export function installTools(
  ctx: { tools: { register(tool: unknown): () => void } },
  deps: ToolDeps,
): void {
  const { config } = deps

  /* ── memo_tuning（§6.6） ── */
  registerMemoTuning(ctx, config)

  /* ── memo_recall（§7.2） ── */
  ctx.tools.register(
    defineTool({
      name: 'memo_recall',
      description:
        '主动补证：在记忆河流（VCPToolBox TagMemo/RiverMemo）里定向检索历史日记。被动注入给线索，本工具给细节。' +
        '返回候选列表，每条带 id/title/score/role/anchorBonus/topologyBonus/omega/riverRegime/matchedTags 与 diagnostics（含 fallbackUsed/fallbackReason）。',
      parameters: {
        query: { type: 'string', required: true, description: '检索意图（自然语言）。' },
        k: { type: 'number', description: '返回条数上限（缺省用注入配置的 k）。' },
        mode: {
          type: 'string',
          enum: ['tagmemo', 'rivermemo', 'dtsc', 'topology_v3'],
          description: '读出模式：topology_v3（默认，Ω/role 在这条上）/ dtsc / rivermemo / tagmemo（纯向量）。',
        },
        rerank: { type: 'boolean', description: '是否做原生重排（false = 只回 KNN 基线）。' },
        truncate: { type: 'boolean', description: '正文是否截断为首句。' },
        timeRange: { type: 'string', description: '::Time 语义，如 2026-09-10~2026-09-11。' },
        folder: { type: 'string', description: '日记本桶名（缺省 = 当前工作区桶）。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args: Record<string, unknown>, exec: unknown) {
        const { cwd } = viewerOf(exec)
        const workspace = deps.getWorkspace(cwd)
        const query = String(args.query ?? '')
        const mode = (typeof args.mode === 'string' ? args.mode : config.inject.mode) as RecallOptions['mode']
        const rerank = args.rerank === undefined ? true : Boolean(args.rerank)
        const k = typeof args.k === 'number' && args.k > 0 ? args.k : config.inject.k
        const options: RecallOptions = {
          mode: rerank ? mode : 'tagmemo',
          k,
          tokenBudget: config.inject.tokenBudget,
          dynamicK: 1,
          gate: false, // 主动工具：不套被动门控（§1 不变量 2「主动工具负责定向核查」）
          gateThreshold: config.inject.gateThreshold,
          minKnnForReward: config.inject.minKnnForReward,
          queryId: `tool-recall-${Date.now()}`,
          // 票 05：会话级 tuning 注入（默认关——memo_tuning scope=session tieBreakerEnabled=1 可实验）。
          tieBreaker: tieBreakerParamsFrom(tuningValues(config, viewerOf(exec).sessionId)),
        }
        const outcome = await workspace.recall(query, options)
        // timeRange / folder 过滤（在结果集上做，避免改原生载荷）
        const range = parseTimeRange(typeof args.timeRange === 'string' ? args.timeRange : undefined)
        const folder = typeof args.folder === 'string' && args.folder ? args.folder : null
        if (range || folder) {
          const owners = workspace.store.chunkOwners()
          const keep = (id: number): boolean => {
            const owner = owners.get(id)
            if (!owner) return false
            if (folder && owner.diaryName !== folder) return false
            if (range) {
              const d = dateOf(owner.path)
              if (!d || d < range.from || d > range.to) return false
            }
            return true
          }
          outcome.candidates = outcome.candidates.filter((c) => keep(c.id))
          outcome.selected = outcome.selected.filter((c) => keep(c.id))
          outcome.candidateCount = outcome.candidates.length
        }
        if (args.truncate === true) {
          for (const c of outcome.candidates) c.body = excerpt(c.body, 120)
        }
        // 使用台账（票 01）：主动补证也是「使用」——只记工具**刻意呈现**的 selected（与被动注入同
        // 口径、同为预算内 k 条）。不记 candidates 列表：那是诊断溢出，11 篇语料下会把全库扫成
        // 「用过」，主动信号就失去「努力提取」的语义（testing effect 只认刻意检索）。
        try {
          if (outcome.selected.length > 0) recordUsage(workspace.store, outcome.selected.map((c) => c.fileId), 'active')
        } catch {
          /* 台账失败静默：观测不能伤害补证 */
        }
        return formatRecallResult(workspace, outcome, query)
      },
    }),
  )

  /* ── memo_tags（§7.4） ── */
  ctx.tools.register(
    defineTool({
      name: 'memo_tags',
      description: 'Tag 词汇表：按频次排序的既有 Tag 清单，供续写日记时复用（写前先看，避免同义 Tag 漂移）。',
      parameters: { limit: { type: 'number', description: '返回条数（缺省 30）。' } },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      execute(args: Record<string, unknown>, exec: unknown) {
        const { cwd } = viewerOf(exec)
        const workspace = deps.getWorkspace(cwd)
        const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : 30
        const freq = workspace.store.tagFrequency()
        const total = workspace.store.files().length
        const lines = [`【记忆河流·memo_tags】桶=${workspace.paths.bucket} 共 ${freq.length} 个 Tag / ${total} 篇日记`]
        for (const t of freq.slice(0, limit)) {
          const ratio = total > 0 ? t.count / total : 0
          const flag = ratio >= HUB_RATIO_LIMIT ? '  ⚠️枢纽(≥1/3)' : ''
          lines.push(`· ${t.name}  ×${t.count}${flag}`)
        }
        if (freq.length > limit) lines.push(`· …还有 ${freq.length - limit} 个（提高 limit 查看）`)
        lines.push('· 写新日记时优先复用以上 Tag；只有概念真正变化时才创建新 Tag（需在 memo_write 里给出 newTagReason）。')
        return Promise.resolve(lines.join('\n'))
      },
    }),
  )

  /* ── memo_stats（§7.3 四项体检） ── */
  ctx.tools.register(
    defineTool({
      name: 'memo_stats',
      description:
        '语料体检（四项判据）+ ⑤ 使用台账视图（最常被召回/从未使用/陈旧度，主动与被动分开；kv 观测，不进打分）。' +
        '①连通分量数（必须=1）②最大 Tag 频次/总篇数（<1/3）③Ω 分布（近 N 次，报分布不只报均值）④未覆盖率。',
      parameters: { rebuild: { type: 'boolean', description: '是否顺带强制重建原生资产（缺省 false，按 artifactSig 比对）。' } },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args: Record<string, unknown>, exec: unknown) {
        const { cwd } = viewerOf(exec)
        const workspace = deps.getWorkspace(cwd)
        const report = healthReport(workspace.store, workspace.paths.bucket)
        const lines = [formatHealth(report)]
        const loaded = await workspace.ensureLoaded()
        if (loaded) {
          const state = await workspace.engine.ensureArtifact(args.rebuild === true)
          lines.push(
            `· 原生资产：artifactSig=${state.artifactSig.slice(0, 24)}… 节点=${state.nodeCount} 边=${state.edgeCount} ` +
              `persisted=${state.persisted} resident=${state.resident} 本次重建耗时=${state.elapsedMs}ms`,
          )
        } else {
          lines.push('· 原生资产：未载入（native-unavailable）')
        }
        return lines.join('\n')
      },
    }),
  )

  /* ── memo_write（§7.1 硬契约） ── */
  ctx.tools.register(
    defineTool({
      name: 'memo_write',
      description:
        '写一篇日记进记忆河流。执行顺序固定：①回注旧 Tag 词汇表 + 语义相关旧日记 + 枢纽警告 ②校验（必须有 Tag 行、3–5 个 Tag、Tag ≤20 字、不得与既有 Tag 同义）' +
        '③新 Tag 闸门（引入库中不存在的 Tag 必须给 newTagReason）④写入 files/file_tags/tags/chunks + 嵌入 + 索引追加 + 资产重建 ⑤返回体检增量。' +
        '拒绝条件会明确报错，不静默。',
      parameters: {
        content: { type: 'string', required: true, description: '正文（末尾可含 Tag 行）。' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tag 列表（建议；缺省从正文 Tag 行解析）。' },
        title: { type: 'string', description: '标题（缺省取正文首行 # 标题）。' },
        date: { type: 'string', description: '日期 YYYY-MM-DD（缺省今天）。' },
        folder: { type: 'string', description: '工作区桶名（缺省 = 当前工作区桶）。' },
        newTagReason: {
          type: 'string',
          description: '引入库中不存在的新 Tag 时，必须给出「概念确实变了」的理由，否则拒绝。',
        },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      async execute(args: Record<string, unknown>, exec: unknown) {
        const { cwd } = viewerOf(exec)
        const workspace = deps.getWorkspace(cwd)
        const content = String(args.content ?? '').trim()
        const bucket = typeof args.folder === 'string' && args.folder ? args.folder : workspace.paths.bucket
        const date = typeof args.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : new Date().toISOString().slice(0, 10)
        const newTagReason = typeof args.newTagReason === 'string' ? args.newTagReason.trim() : ''

        /* ① 回注：旧 Tag 词汇表 + 相关旧日记 + 枢纽警告（票 03：传 Promise 不 await——
         *    回注嵌入与 writeDiaryCore 的合批嵌入并行在飞，墙钟 ≈ 一次 RTT）。 */
        const reinjection = composeReinjection(workspace, content, [], bucket)

        /* ②–⑤ 校验 + 闸门 + 写入 + 体检：与 memo_approve 共用同一份核心（writeDiaryCore），
         *    闸门口径只此一份——两个入口漂移 = 静默 bug（firstSentence/excerpt 同族教训）。 */
        const fromArg = Array.isArray(args.tags) ? (args.tags as unknown[]).map((t) => String(t).trim()).filter(Boolean) : []
        const tags = fromArg.length > 0 ? fromArg : parseTagLine(content)
        const title = typeof args.title === 'string' ? args.title.trim() : ''
        const result = await writeDiaryCore(workspace, {
          content,
          tags,
          title,
          date,
          bucket,
          dedupCosine: config.write.dedupCosine,
          newTagReason,
          preamble: reinjection,
          toolName: 'memo_write',
        })
        return result.report
      },
    }),
  )

  /* ── memo_update（票 02：单篇原地改写，兑去重闸门「或合并进旧篇」的承诺） ── */
  ctx.tools.register(
    defineTool({
      name: 'memo_update',
      description:
        '改写一篇既有日记（原地更新，不是新建）：按 D-id 或标题子串定位目标，提交新全文，' +
        '走与 memo_write 完全一致的 Tag 闸门（同义漂移/新 Tag 理由/枢纽警告）与体检增量；' +
        '磁盘原路径重写、库内同路径 upsert（fileId 不变，使用台账足迹保留）；' +
        '改写目标自身豁免内容去重（自我改写与原文相近是合法用例），但与其他篇近重复仍会被拒。' +
        '适用：修正错误、精简冗长、把新进展合并进旧篇（压缩式遗忘的单篇手动路径）。',
      parameters: {
        id: { type: 'number', description: '目标 D-id（memo_recall/memo_stats 输出里的 D 编号）。与 title 二选一。' },
        title: { type: 'string', description: '目标标题子串（匹配多篇时列出候选让你用 id 重试）。与 id 二选一。' },
        content: { type: 'string', required: true, description: '新全文（整篇替换；末尾可含 Tag 行）。' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tag 列表（建议；缺省从正文 Tag 行解析）。' },
        date: { type: 'string', description: '日期 YYYY-MM-DD（缺省保持今天；只影响正文，不改文件名）。' },
        folder: { type: 'string', description: '工作区桶名（缺省 = 当前工作区桶）。' },
        newTagReason: { type: 'string', description: '新 Tag 必须给「概念确实变了」的理由（同 memo_write）。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      async execute(args: Record<string, unknown>, exec: unknown) {
        const { cwd } = viewerOf(exec)
        const workspace = deps.getWorkspace(cwd)
        const content = String(args.content ?? '').trim()
        const bucket = typeof args.folder === 'string' && args.folder ? args.folder : workspace.paths.bucket
        const date = typeof args.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : new Date().toISOString().slice(0, 10)
        const newTagReason = typeof args.newTagReason === 'string' ? args.newTagReason.trim() : ''

        /* ⓪ 目标解析：id / title 恰好给一个；标题匹配 chunk 首行（# 标题），歧义列出候选 */
        const hasId = typeof args.id === 'number' && Number.isFinite(args.id)
        const titleQuery = typeof args.title === 'string' ? args.title.trim() : ''
        if (hasId === Boolean(titleQuery)) {
          return '❌ memo_update：给 id（D 编号）或 title（标题子串）二者之一，恰好一个。'
        }
        const bucketFiles = workspace.store.files(bucket)
        const chunkTitle = new Map<number, string>()
        for (const c of workspace.store.chunks(bucket)) {
          const m = /^#\s+(.+)$/m.exec(String(c.content ?? ''))
          if (m && !chunkTitle.has(c.file_id)) chunkTitle.set(c.file_id, m[1]!)
        }
        let target: (typeof bucketFiles)[number] | null = null
        if (hasId) {
          target = bucketFiles.find((f) => f.id === args.id) ?? null
          if (!target) {
            // memo_recall 输出的 D 编号是 **chunk id**（改写会换 chunk），memo_stats/台账是 file id：
            // 按_chunk→file 兜底解析，两个口径都能定位。
            const ch = workspace.store.chunks(bucket).find((c) => Number(c.id) === args.id)
            if (ch) target = bucketFiles.find((f) => f.id === ch.file_id) ?? null
          }
          if (!target) return `❌ memo_update：桶 ${bucket} 里没有 D${args.id}（已按 file id 和 chunk id 两种口径解析；用 memo_stats 查看清单）。`
        } else {
          const hits = bucketFiles.filter(
            (f) => (chunkTitle.get(f.id) ?? '').includes(titleQuery) || f.path.includes(titleQuery),
          )
          if (hits.length === 0) {
            return `❌ memo_update：桶 ${bucket} 里没有标题/路径含「${titleQuery}」的日记（用 memo_stats 看清单）。`
          }
          if (hits.length > 1) {
            const list = hits.slice(0, 8).map((f) => `D${f.id}《${chunkTitle.get(f.id) ?? f.path}》`).join('\n')
            return `❌ memo_update：「${titleQuery}」匹配 ${hits.length} 篇，请用 id 精确指定：\n${list}`
          }
          target = hits[0]!
        }

        /* ① 回注（与 memo_write 同构）+ 改写目标明示（票 03：Promise 传入，嵌入并行） */
        const reinjection = composeReinjection(
          workspace,
          content,
          [`【改写目标】D${target.id}《${chunkTitle.get(target.id) ?? target.path}》——原路径重写，台账足迹保留`],
          bucket,
        )

        /* ②–⑤ 与 memo_write/memo_approve 同一份核心（writeDiaryCore），闸门口径只此一份 */
        const fromArg = Array.isArray(args.tags) ? (args.tags as unknown[]).map((t) => String(t).trim()).filter(Boolean) : []
        const tags = fromArg.length > 0 ? fromArg : parseTagLine(content)
        const result = await writeDiaryCore(workspace, {
          content,
          tags,
          title: '', // title 参数是查找串不是新标题；新标题取新正文 `#` 首行（titleFromContent）
          date,
          bucket,
          dedupCosine: config.write.dedupCosine,
          newTagReason,
          preamble: reinjection,
          toolName: 'memo_update',
          updateOf: { fileId: target.id, path: target.path },
        })
        return result.report
      },
    }),
  )

  /* ── memo_merge（票 03：多篇归一与归档退役——压缩式遗忘的执行通道） ── */
  ctx.tools.register(
    defineTool({
      name: 'memo_merge',
      description:
        '把多篇旧日记合并成一篇：给 sources（D-id 列表）与合并后新全文；保留篇（keep，缺省第一篇）' +
        '原路径 upsert 承载新全文（身份/路径/使用台账足迹保留），其余源篇归档退役——.md/.txt 移入 archive/ ' +
        '（人可读、保留原 Tag 行），库内行级清除（chunks/file_tags/files）；正文自动落「合并自 D…」溯源行。' +
        '去重豁免只对声明源生效；合并后召回只命中合并篇。600 token 注入预算下：语料变瘦、变响亮。',
      parameters: {
        sources: { type: 'array', items: { type: 'number' }, required: true, description: '源篇 D-id 列表（file 或 chunk 口径均可，≥2 篇）。' },
        keep: { type: 'number', description: '并入哪一篇（D-id，缺省 = sources[0]）——该篇身份保留。' },
        content: { type: 'string', required: true, description: '合并后新全文（整篇；末尾可含 Tag 行；自动追加溯源行）。' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tag 列表（建议；缺省从正文 Tag 行解析）。' },
        date: { type: 'string', description: '日期 YYYY-MM-DD（缺省今天）。' },
        folder: { type: 'string', description: '工作区桶名（缺省 = 当前工作区桶）。' },
        newTagReason: { type: 'string', description: '新 Tag 必须给理由（同 memo_write）。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      async execute(args: Record<string, unknown>, exec: unknown) {
        const { cwd } = viewerOf(exec)
        const workspace = deps.getWorkspace(cwd)
        const content = String(args.content ?? '').trim()
        const bucket = typeof args.folder === 'string' && args.folder ? args.folder : workspace.paths.bucket
        const date = typeof args.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : new Date().toISOString().slice(0, 10)
        const newTagReason = typeof args.newTagReason === 'string' ? args.newTagReason.trim() : ''

        /* ⓪ 源解析：file-id 优先、chunk-id 兜底（与 memo_update 同口径）；去重为集合 */
        const rawIds = (Array.isArray(args.sources) ? args.sources : []).map(Number).filter(Number.isFinite)
        if (rawIds.length < 2) return '❌ memo_merge：sources 至少 2 篇（改写单篇用 memo_update）。'
        const bucketFiles = workspace.store.files(bucket)
        const bucketChunks = workspace.store.chunks(bucket)
        const resolveFile = (id: number) => {
          const byFile = bucketFiles.find((f) => f.id === id)
          if (byFile) return byFile
          const ch = bucketChunks.find((c) => Number(c.id) === id)
          return ch ? (bucketFiles.find((f) => f.id === ch.file_id) ?? null) : null
        }
        const srcMap = new Map<number, (typeof bucketFiles)[number]>()
        for (const id of rawIds) {
          const f = resolveFile(id)
          if (!f) return `❌ memo_merge：D${id} 不在桶 ${bucket}（已按 file/chunk 两种口径解析；用 memo_stats 查看清单）。`
          srcMap.set(f.id, f)
        }
        const srcs = [...srcMap.values()]
        if (srcs.length < 2) return '❌ memo_merge：解析后去重只剩 1 篇源，用 memo_update 即可。'
        /* 两种模式（票 03 契约）：缺省 = 新篇模式（全部源归档，合并篇走新文件路径——archive 留全部源文件）；
         * keep=D-id = 并入模式（保留篇 upsert 承载新全文，身份/台账足迹延续，其余源归档）。 */
        const keepId = Number(args.keep)
        const keepMode = Number.isFinite(keepId)
        if (keepMode && !srcMap.has(keepId)) return `❌ memo_merge：keep=D${keepId} 不在 sources 声明集里。`
        const keepRow = keepMode ? srcMap.get(keepId)! : null
        const retired = keepRow ? srcs.filter((f) => f.id !== keepRow.id) : srcs
        const titleOf = (f: (typeof bucketFiles)[number]) => {
          const ch = bucketChunks.find((c) => c.file_id === f.id)
          return (/^#\s+(.+)$/m.exec(String(ch?.content ?? '')) ?? [])[1] ?? basename(f.path)
        }

        /* 溯源行：正文已有「合并自」则尊重原文，否则插在 Tag 行前（无 Tag 行则追加） */
        const prov = `> 合并自 ${srcs.map((f) => `D${f.id}`).join(', ')}（${date} 退役归档，原文见 archive/）`
        let full2 = content
        if (!content.includes('合并自')) {
          full2 = /^Tag:/m.test(content) ? content.replace(/^(Tag:.*)$/m, `${prov}\n$1`) : `${content}\n\n${prov}`
        }

        /* ① 回注（与 memo_write 同构）+ 合并源明示（票 03：Promise 传入，嵌入并行） */
        const reinjection = composeReinjection(
          workspace,
          full2,
          [
            keepRow
              ? `【合并源】${srcs.map((f) => `D${f.id}《${titleOf(f)}》`).join(' + ')} → 并入 D${keepRow.id}《${titleOf(keepRow)}》（保留篇身份/台账足迹）`
              : `【合并源】${srcs.map((f) => `D${f.id}《${titleOf(f)}》`).join(' + ')} → 新篇（全部源归档退役）`,
          ],
          bucket,
        )

        /* ②–⑤ 同一份核心；豁免集 = 全部声明源（未声明的第三篇近重复仍会被拒） */
        const fromArg = Array.isArray(args.tags) ? (args.tags as unknown[]).map((t) => String(t).trim()).filter(Boolean) : []
        const tags = fromArg.length > 0 ? fromArg : parseTagLine(full2)
        const result = await writeDiaryCore(workspace, {
          content: full2,
          tags,
          title: '',
          date,
          bucket,
          dedupCosine: config.write.dedupCosine,
          newTagReason,
          preamble: reinjection,
          toolName: 'memo_merge',
          updateOf: keepRow ? { fileId: keepRow.id, path: keepRow.path } : undefined,
          exemptFileIds: srcs.map((f) => f.id),
        })
        if (result.status === 'rejected') return result.report

        /* ⑥ 归档退役：先取原文（chunk 将被清），再磁盘归档（根内 move / 根外 copy），最后库内行级清除 + 台账清扫 */
        const archiveDir = join(workspace.paths.root, 'archive')
        mkdirSync(archiveDir, { recursive: true })
        const archived: string[] = []
        for (const f of retired) {
          const ch = workspace.store.chunks(bucket).find((c) => c.file_id === f.id)
          const origText = String(ch?.content ?? '')
          const dest = join(archiveDir, basename(f.path))
          if (f.path.startsWith(workspace.paths.root)) {
            try { renameSync(f.path, dest); archived.push(`${basename(f.path)}（移入）`) } catch { writeFileSync(dest, origText); archived.push(`${basename(f.path)}（复制兜底）`) }
          } else {
            writeFileSync(dest, origText || `(原文已不可得；源路径 ${f.path})`)
            archived.push(`${basename(f.path)}（源在工作区根外，原文复制归档、源文件未动）`)
          }
          workspace.store.db.prepare('DELETE FROM chunks WHERE file_id = ?').run(f.id)
          workspace.store.db.prepare('DELETE FROM file_tags WHERE file_id = ?').run(f.id)
          workspace.store.db.prepare('DELETE FROM files WHERE id = ?').run(f.id)
        }
        if (retired.length > 0) {
          const ledger = readUsageLedger(workspace.store)
          for (const f of retired) ledger.delete(f.id)
          workspace.store.kvSet(KV_USAGE, JSON.stringify(Object.fromEntries([...ledger.entries()].map(([k, v]) => [String(k), v]))))
        }
        workspace.logger.info(
          `memo_merge bucket=${bucket} ${keepRow ? `keep=D${keepRow.id}` : 'keep=new-file'} retired=${retired.map((f) => `D${f.id}`).join(',')} archive=${archived.length} 篇`,
        )
        return `${result.report}\n\n【归档】${archived.join('；')}\n（源篇已退役：召回不再命中，原文 archive/ 可溯。）`
      },
    }),
  )

  /* ── memo_drafts / memo_approve / memo_discard（§8.3 草稿消费通道，2026-09-12 用户拍板） ── */

  const selectDraftTargets = (
    args: Record<string, unknown>,
    exec: unknown,
  ): { targets: DraftRecord[]; error: string | null } => {
    const { cwd } = viewerOf(exec)
    const current = deps.getWorkspace(cwd)
    const listing = listPending(current.paths.root, true)
    if (args.all === true) {
      const bucket = typeof args.bucket === 'string' && args.bucket ? args.bucket : null
      return { targets: listing.filter((r) => !bucket || r.bucket === bucket), error: null }
    }
    const ids = Array.isArray(args.ids) ? (args.ids as unknown[]).map(String) : []
    if (ids.length === 0) return { targets: [], error: '给 ids（memo_drafts 列出的文件名子串）或 all: true。' }
    const { ok, errors } = matchDrafts(listing, ids)
    if (errors.length > 0) return { targets: [], error: errors.join('；') }
    return { targets: ok, error: null }
  }

  ctx.tools.register(
    defineTool({
      name: 'memo_drafts',
      description:
        '草稿队列：列出待确认草稿（守护循环落的回合摘要，pending/*.md）。缺省只看本工作区，all=true 扫全部工作区。' +
        '每篇带守护预审三态标记（可一键批/需人工/建议丢弃——只读预审，绝不代批；空用户+空助手的垃圾样本稳定标「建议丢弃」）。' +
        '批准入库用 memo_approve（一键、走 Tag 闸门）；丢弃用 memo_discard。',
      parameters: {
        all: { type: 'boolean', description: '扫全部工作区的 pending/（缺省只看本工作区）。' },
        limit: { type: 'number', description: '最多列出条数（缺省 30）。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      execute(args: Record<string, unknown>, exec: unknown) {
        const { cwd } = viewerOf(exec)
        const workspace = deps.getWorkspace(cwd)
        const all = args.all === true
        const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : 30
        const list = listPending(workspace.paths.root, all)
        /* 票06：预审三态分布（读伴随 .status.json；守护轮自动刷新）。 */
        const dist = { ok: 0, manual: 0, discard: 0, unchecked: 0 }
        const statusOf = new Map(list.map((r) => [r.path, readDraftStatus(r.path)]))
        for (const st of statusOf.values()) {
          if (st) dist[st.state] += 1
          else dist.unchecked += 1
        }
        const lines = [
          `【记忆河流·memo_drafts】待确认草稿 ${list.length} 篇（${all ? '全部工作区' : `桶=${workspace.paths.bucket}`}）`,
          `· 预审分布：可一键批 ${dist.ok} / 需人工 ${dist.manual} / 建议丢弃 ${dist.discard}` +
            (dist.unchecked > 0 ? ` / 未审 ${dist.unchecked}` : '') +
            '（守护循环只读预审，绝不代批）',
        ]
        if (list.length === 0) lines.push('· 队列为空（守护循环每 intervalMs 落一批新草稿）')
        for (const r of list.slice(0, limit)) {
          const head = (r.userText || r.assistantText || '(空)').replace(/\s+/g, ' ').slice(0, 60)
          const st = statusOf.get(r.path) ?? null
          lines.push(`· ${basename(r.path)}  桶=${r.bucket}  回合${r.turn}  [${st ? PRECHECK_LABELS[st.state] : '未审'}]`)
          if (st) lines.push(`    预审：${PRECHECK_LABELS[st.state]}——${st.reason}`)
          lines.push(`    用户/助手：${head}`)
          lines.push(`    建议 Tag：${r.suggestedTags.join(', ') || '(无)'}`)
        }
        if (list.length > limit) lines.push(`· …还有 ${list.length - limit} 篇（提高 limit 查看）`)
        lines.push('· 批准：memo_approve { ids: ["文件名子串"] } 或 { all: true }；丢弃：memo_discard（同参数）。')
        return Promise.resolve(lines.join('\n'))
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'memo_approve',
      description:
        '一键批准草稿入库：每篇草稿走 memo_write 同一套 Tag 校验闸门（writeDiaryCore），Tag 只复用既有词汇' +
        '（建议 Tag ∩ 词汇表，3–5 个）——可复用 Tag 不足 3 个的草稿自动跳过（待人工 memo_write 撰写）。' +
        '批准后草稿移入 approved/（可追溯）。批量按有界并行执行（缺省 5 并发，MEMO_APPROVE_CONCURRENCY 可调，' +
        '=1 即串行）：N 篇耗时 ≈ ⌈N/并发⌉ × 单篇；单篇失败/跳过不影响其余，结果逐篇回报。',
      parameters: {
        ids: { type: 'array', items: { type: 'string' }, description: '草稿文件名子串列表（memo_drafts 列出的文件名）。' },
        all: { type: 'boolean', description: '批准队列全部草稿（与 ids 二选一）。' },
        bucket: { type: 'string', description: 'all=true 时限定桶名（缺省全部桶）。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      async execute(args: Record<string, unknown>, exec: unknown) {
        const { targets, error } = selectDraftTargets(args, exec)
        if (error) return `❌ memo_approve：${error}`
        if (targets.length === 0) return '【记忆河流·memo_approve】队列为空，无可批准草稿。'
        const startedAt = Date.now()
        const lines = [`【记忆河流·memo_approve】待处理 ${targets.length} 篇`]

        /* 票 04：逐篇串行 → 有界并行（worker-pool，模式同 embed.ts 的 TAG_VECTORIZE_CONCURRENCY）。
         * 每篇仍走与串行版**同一份**闸门链：workspaceFor → curateTags（∩ 词汇表）→ TAG_MIN 跳过 →
         * writeDiaryCore（Tag 闸门/去重/写入）→ resolveDraft——代码零复制，闸门语义不变。
         * 单篇被拒不外溢（部分成功语义）；意外异常也只折算成该篇的失败行，绝不半途崩溃整批。
         * outcomes 按原下标落位：完成顺序乱，汇报顺序不乱（与逐篇串行的输出序一致）。
         * 并发安全性：同桶共享同一 WorkspaceRuntime（acquireWorkspace 按 cwd 缓存）——
         * better-sqlite3 全同步调用天然串行、ensureLoaded 单飞、engine.runExclusive 串行化
         * 资产重建；approve 路 newTags 恒空（curateTags 只复用既有词），无新 Tag 向量竞态。 */
        const approveOne = async (record: DraftRecord): Promise<string> => {
          const workspace = workspaceFor(record, config)
          if (!workspace) {
            return `· ⏭ ${basename(record.path)}：工作区缺 workspace.json（cwd 未知），跳过`
          }
          const tags = curateTags(record, workspace)
          if (tags.length < TAG_MIN) {
            return `· ⏭ ${basename(record.path)}：可复用 Tag 仅 ${tags.length} 个（${tags.join(', ') || '无'}）< ${TAG_MIN}，待人工 memo_write 撰写后 memo_discard 本草稿`
          }
          const { title, content } = composeDiary(record)
          const date = /^\d{4}-\d{2}-\d{2}/.test(record.at) ? record.at.slice(0, 10) : new Date().toISOString().slice(0, 10)
          const result = await writeDiaryCore(workspace, {
            content,
            tags,
            title,
            date,
            bucket: record.bucket,
            dedupCosine: config.write.dedupCosine,
            newTagReason: '',
            preamble: `【草稿批准】${basename(record.path)}（桶=${record.bucket}，回合${record.turn}；Tag 只复用既有词汇）`,
            toolName: 'memo_approve',
          })
          if (result.status === 'written') {
            if (resolveDraft(record, 'approved')) {
              workspace.logger.info(
                `draft-approved file=${basename(record.path)} chunk=D${result.chunkId} tags=${tags.join(',')}`,
              )
              return `· ✅ ${basename(record.path)} → D${result.chunkId}「${result.title}」（Tag：${tags.join(', ')}）→ approved/`
            }
            return `· ✅ ${basename(record.path)} → D${result.chunkId}「${result.title}」（⚠️ 已入库但移入 approved/ 失败，请手动清理 pending）`
          }
          const reason = result.report.split('\n').find((l) => l.includes('被拒绝')) ?? '写入被拒'
          return `· ❌ ${basename(record.path)}：${reason}`
        }

        const outcomes: Array<string | undefined> = new Array(targets.length)
        let approved = 0
        let skipped = 0
        let done = 0
        let cursor = 0
        const workers = Array.from({ length: Math.min(APPROVE_CONCURRENCY, targets.length) }, async () => {
          while (cursor < targets.length) {
            const index = cursor++
            const record = targets[index]!
            try {
              outcomes[index] = await approveOne(record)
              if (outcomes[index]!.startsWith('· ✅')) approved += 1
              else skipped += 1
            } catch (e) {
              /* 意外异常兜底：只折算该篇失败（留 pending/ 可重试），整批继续——部分成功语义 */
              outcomes[index] = `· ❌ ${basename(record.path)}：处理异常 ${String((e as Error)?.message ?? e)}（留在 pending/，可重试）`
              skipped += 1
            }
            done += 1
            deps.log('info', `memo_approve progress=${done}/${targets.length} file=${basename(record.path)}`)
          }
        })
        await Promise.all(workers)

        lines.push(...(outcomes.filter((l) => l !== undefined) as string[]))
        lines.push(`· 小计：批准 ${approved} / 跳过 ${skipped}（跳过项留在 pending/）`)
        lines.push(
          `· 耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s（并行度 ${Math.min(APPROVE_CONCURRENCY, targets.length)}，` +
            `${APPROVE_CONCURRENCY > 1 ? '有界并行' : '串行模式（MEMO_APPROVE_CONCURRENCY=1）'}）`,
        )
        return lines.join('\n')
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'memo_discard',
      description:
        '丢弃待确认草稿：移入 rejected/（不删文件、不入库，可追溯）。用于不值得入库的回合摘要，或人工 memo_write 撰写后清理原草稿。',
      parameters: {
        ids: { type: 'array', items: { type: 'string' }, description: '草稿文件名子串列表。' },
        all: { type: 'boolean', description: '丢弃队列全部草稿（与 ids 二选一）。' },
        bucket: { type: 'string', description: 'all=true 时限定桶名（缺省全部桶）。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      async execute(args: Record<string, unknown>, exec: unknown) {
        const { targets, error } = selectDraftTargets(args, exec)
        if (error) return `❌ memo_discard：${error}`
        if (targets.length === 0) return '【记忆河流·memo_discard】队列为空，无可丢弃草稿。'
        const lines = [`【记忆河流·memo_discard】待处理 ${targets.length} 篇`]
        let done = 0
        for (const record of targets) {
          if (resolveDraft(record, 'rejected')) {
            done += 1
            lines.push(`· 🗑 ${basename(record.path)} → rejected/`)
          } else {
            lines.push(`· ⚠️ ${basename(record.path)}：移动失败（检查文件权限）`)
          }
        }
        lines.push(`· 小计：丢弃 ${done}/${targets.length}`)
        return lines.join('\n')
      },
    }),
  )

  if (existsSync(config.native.vcpRoot)) {
    deps.log('info', `tools-installed vcpRoot=${config.native.vcpRoot}`)
  }
}
