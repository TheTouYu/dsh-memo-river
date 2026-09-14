/**
 * @dsh-external/dsh-memo-river — 把 VCPToolBox 的 TagMemo / RiverMemo 记忆算法接进 DSH。
 *
 * 三通道（DESIGN.md §4）：
 *   · 请求前：`agent/pre-step` 做消息尾注入（含门控 / role / Ω / 未注入说明），
 *             `llm/stream` 按 §6.5 注册并永远 `next()` 委托（只读审计 + 降级边界）
 *   · 回合中：`memo_recall` / `memo_write` / `memo_stats` / `memo_tags`
 *             + `systemPrompt` 的**固定契约文本**（零动态 → 保前缀缓存）
 *   · 回合边界：`agent/turn-stopping` 只产候选草稿；timer 守护循环重建资产 + 四项体检
 */
import type { Context } from 'cordis'
import { Config, type Config as MemoRiverConfig } from './config.js'
import { WorkspaceDaemon } from './daemon.js'
import { healthReport } from './health.js'
import { installInjection, messageText, type AgentLike } from './injector.js'
import { FIXED_CONTRACT_SHA256, FIXED_CONTRACT_TEXT } from './prompt.js'
import { Logger, dshHome } from './runtime.js'
import { getSession, takeDrafts, dropSession, listSessions, SUBSTANTIVE_REPORT_CHARS, type PendingDraft } from './session.js'
import { applyPresetTuning, handleActiveProbe, handleTuningApi, serveTuningPanel, dropSessionTuning, tuningDefaults as tuningDefaultsOf } from './tuning.js'
import { installTools } from './tools.js'
import { acquireWorkspace, type WorkspaceRuntime } from './workspace.js'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

export const name = '@dsh-external/dsh-memo-river'
export const inject = ['llm', 'systemPrompt', 'tools', 'webServer']
export { Config }

/** systemPrompt 段的注册名（固定契约；零动态 → 逐轮 hash 相等）。 */
const CONTRACT_NAME = 'memo-river:contract'
/** 与 engram-relay 同区间，避免与既有段/上下文抢占序位。 */
const CONTRACT_ORDER = 9997

type AppContext = Context & {
  llm: unknown
  systemPrompt: {
    section(section: { name: string; order: number; text: string }): () => void
    context(context: { name: string; order: number; text: string }): () => void
  }
  tools: { register(tool: unknown): () => void }
  effect(callback: () => unknown, label?: string): () => void
  interval?(callback: () => void, delay: number): () => void
  get?(name: string): unknown
  logger?: { info?(msg: string): void; warn?(msg: string): void; error?(msg: string): void }
}

/**
 * 守护循环的定时器来源：优先 timer mixin（`ctx.interval`，fiber 作用域，随插件释放），
 * 否则退回**裸 setInterval + unref**（同样包在插件生命周期里）。
 *
 * ⚠ 实测教训（宿主进程注入时暴露的真故障）：
 * 早先这里还探测过 `ctx.get('timer')`，在真实 Cordis 上直接抛
 *   `Error: cannot get property "timer" without inject`
 * ——未 `inject` 的服务，其属性访问是**抛错**而非返回 undefined。后果是
 * `daemonFor()` 整个炸掉、守护循环永远起不来，而启动自检的 try/catch 只留下一行
 * `plugin-startup-failed`，表现为「工具能用、体检日志再也不长」的半死状态。
 * Cordis 的 `inject` 只有硬依赖（没有 optional 列表），把 timer 变成硬依赖会让本插件
 * 在没装 cordis-plugin-timer 的部署上永远不激活——用一个可选加速项换可用性，不划算。
 * 故：**只做只读探测，且探测本身也必须容错**。
 */
function pickInterval(ctx: AppContext): (fn: () => void, ms: number) => () => void {
  try {
    const fromMixin = (ctx as { interval?: unknown }).interval
    if (typeof fromMixin === 'function') {
      return (fromMixin as (fn: () => void, ms: number) => () => void).bind(ctx)
    }
  } catch {
    /* 未注入 timer：落到下面的裸 setInterval，不影响守护循环启动 */
  }
  return (fn, ms) => {
    const handle = setInterval(fn, ms)
    // 守护定时器**不得阻止进程退出**（插件是常驻背景维护，不是前台任务）。
    ;(handle as { unref?: () => void }).unref?.()
    return () => clearInterval(handle)
  }
}

export function apply(ctx: AppContext, config: MemoRiverConfig): void {
  /* 插件级兜底日志（拿不到工作区时用；工作区日志在 WorkspaceRuntime 内，按 cwd 分桶） */
  const pluginLogPath = config.logFile || join(dshHome(), 'memo-river', 'plugin.log')
  const pluginLogger = new Logger(pluginLogPath, (level, message) => {
    if (level === 'error') ctx.logger?.error?.(`[memo-river] ${message}`)
    else if (level === 'warn') ctx.logger?.warn?.(`[memo-river] ${message}`)
    else ctx.logger?.info?.(`[memo-river] ${message}`)
  })
  const log = (level: 'info' | 'warn' | 'error', message: string): void => pluginLogger[level](message)

  const getWorkspace = (cwd: string): WorkspaceRuntime => acquireWorkspace(cwd, config)

  /* ── 调参面板（§6.6）：tuning.json 预设级覆盖重放进活 config（进程级即时生效） ── */
  applyPresetTuning(config)
  let tuningDefaults: Record<string, number> = {}
  try {
    tuningDefaults = tuningDefaultsOf()
  } catch {
    /* 默认值解析失败 → 面板显示 0；不阻塞主流程 */
  }
  const ws = (ctx as unknown as { webServer?: { register?: (route: unknown) => () => void } }).webServer
  if (ws && typeof ws.register === 'function') {
    const d1 = ws.register({
      kind: 'exact',
      path: '/memo-river/tuning',
      handler: (req: never, res: never) => handleTuningApi(req, res, config, tuningDefaults, listSessions),
    })
    const d2 = ws.register({ kind: 'exact', path: '/memo-river/tuning/panel', handler: (_req: never, res: never) => serveTuningPanel(res) })
    // GUI 卫星包（dsh-memo-tuner）显隐探针：当前会话是否挂载 memo-river
    const d3 = ws.register({ kind: 'exact', path: '/memo-river/tuning/active', handler: (req: never, res: never) => handleActiveProbe(req, res, listSessions) })
    // 注意：ctx.effect 把「返回值」当清理函数——必须返回一个函数，
    // 而不是当场调用 d1/d2（首版就在这里把路由注册完立刻拆了，症状 404）。
    ctx.effect(() => () => {
      d1()
      d2()
      d3()
    })
    log('info', 'tuning-panel routes=/memo-river/tuning[,/panel,/active]')
  }

  try {
    mkdirSync(join(dshHome(), 'memo-river'), { recursive: true })
  } catch {
    /* 建目录失败静默，后续写盘各自兜底 */
  }

  /* ────────── ① 主干的另一半：systemPrompt 固定契约（零动态 / byte 级一致） ────────── */

  ctx.effect(() => {
    const disposers: Array<() => void> = []
    if (config.promptChannel === 'section' || config.promptChannel === 'both') {
      disposers.push(ctx.systemPrompt.section({ name: CONTRACT_NAME, order: CONTRACT_ORDER, text: FIXED_CONTRACT_TEXT }))
    }
    if (config.promptChannel === 'context' || config.promptChannel === 'both') {
      disposers.push(ctx.systemPrompt.context({ name: CONTRACT_NAME, order: CONTRACT_ORDER, text: FIXED_CONTRACT_TEXT }))
    }
    log(
      'info',
      `contract-registered channel=${config.promptChannel} sha256=${FIXED_CONTRACT_SHA256} bytes=${Buffer.byteLength(FIXED_CONTRACT_TEXT, 'utf8')}`,
    )
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          /* 静默 */
        }
      }
    }
  }, 'memo-river: fixed contract')

  /* ────────── ② 注入 seam：agent/pre-step（尾注入）+ llm/stream（委托 + 审计） ────────── */

  installInjection(ctx as unknown as Parameters<typeof installInjection>[0], { config, getWorkspace, log })

  /* ────────── ③ 工具面 ────────── */

  ctx.effect(() => {
    installTools(ctx as unknown as Parameters<typeof installTools>[0], { config, getWorkspace, log })
    return () => {
      /* ctx.tools.register 的 disposer 由 cordis 随 fiber 释放 */
    }
  }, 'memo-river: tools')

  /* ────────── ④ 守护循环 + 草稿收集 ────────── */

  const daemons = new Map<string, WorkspaceDaemon>()

  /**
   * 守护定时器必须随 fiber 收口。
   *
   * 实测事故：本插件的预设每次换 `?v=N` 都会新挂一代 standing 实例，而旧代的
   * `setInterval` 从未被清 —— 同一工作区于是有多个守护循环并发跑。可见症状是
   * `health.log` 每轮被写两遍（genshin 工作区 03:48/04:03/04:18 三轮各两行，
   * 两行毫秒差 1ms，对应用户启动会话时并存的两个实例），更严重的是每个实例都
   * 监听 `agent/pre-step` —— 注入块会被追加两次，每个实例还各持一份 native 索引
   * 在同一张库上做重建。
   *
   * §1 不变量 6「静默即不可接受」：泄漏的循环是**重复且难察觉**的写，必须收口。
   */
  ctx.effect(
    () => () => {
      for (const daemon of daemons.values()) {
        try {
          daemon.stop()
        } catch {
          /* 单个收口失败不阻塞其余资源释放 */
        }
      }
      daemons.clear()
    },
    'memo-river: guardian timers',
  )

  const daemonFor = (workspace: WorkspaceRuntime): WorkspaceDaemon => {
    const key = workspace.paths.hash
    const existing = daemons.get(key)
    if (existing) return existing
    const daemon = new WorkspaceDaemon({
      config,
      workspace,
      log,
      setInterval: pickInterval(ctx),
      takeDrafts: () =>
        takeDrafts((state) => {
          if (!state.cwd) return false
          try {
            return acquireWorkspace(state.cwd, config).paths.hash === key
          } catch {
            return false
          }
        }),
    })
    daemons.set(key, daemon)
    try {
      daemon.start()
    } catch (e) {
      // 定时器起不来不等于插件不可用（注入/工具仍然生效）——但要**单独**报出来，
      // 否则会伪装成 plugin-startup-failed，让「体检日志不再增长」失去线索（§1 不变量 6）。
      log('error', `guardian-start-failed bucket=${workspace.paths.bucket}: ${String((e as Error)?.message ?? e)}`)
    }
    return daemon
  }

  ctx.on('agent/session-start', (payload: { agent: AgentLike }) => {
    try {
      const cwd = payload.agent?.session?.header?.cwd ?? process.cwd()
      const state = getSession(payload.agent.session.id, cwd)
      const workspace = getWorkspace(cwd)
      daemonFor(workspace)
      log(
        'info',
        `session-start id=${state.sessionId} cwd=${cwd} bucket=${workspace.paths.bucket} counts=${JSON.stringify(workspace.corpusCounts)}`,
      )
    } catch (e) {
      log('warn', `session-start-failed: ${String((e as Error)?.message ?? e)}`)
    }
  })

  /**
   * 回合边界：**只产出候选草稿，不落库**（DESIGN §4 回合边界 / §8.3）。
   * 落盘由守护循环负责（`pending/<date>-<slug>.md`，等确认，不自动入库）。
   */
  ctx.on('agent/turn-stopping', (payload: { agent: AgentLike; turn: number }) => {
    try {
      if (!config.maintenance.drafts) return
      const agent = payload.agent
      const state = getSession(agent.session.id, agent.session?.header?.cwd ?? null)
      const messages = agent.session.deriveMessages() ?? []
      // 从后往前找**最后一条有正文的**该角色消息：
      //  · 工具结果也走 user 角色（正文为空）——停在它上面会产出「本轮用户：(空)」的草稿
      //    （实测 genshin 桶 17 个草稿里多个名为 turn-tN.md 的就是这种）；
      //  · 本插件的被动召回块（⟨memo-river·…⟩）同样是 user 角色且带正文——必须跳过，
      //    否则「本轮用户」会录成召回块自己。
      const textOf = (role: string): string => {
        let sawEmpty = false
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i] as { role?: string }
          if (m.role !== role) {
            // 已见过本角色空正文、又越过对面角色（如 user 扫描遇到 assistant）
            // → 本轮该角色确实没写文本（如纯图片消息），返回空，防止越界取上一轮旧文本
            if (sawEmpty) return ''
            continue
          }
          const t = messageText(m).trim()
          if (!t) {
            sawEmpty = true
            continue
          }
          if (t.startsWith('⟨memo-river')) continue
          return t
        }
        return ''
      }
      const firstNonEmptyLine = (text: string): string => {
        for (const line of text.split('\n')) {
          const t = line.trim()
          if (t) return t
        }
        return ''
      }
      const suggested = new Set<string>()
      for (const candidate of state.lastCandidates) {
        for (const tag of candidate.matchedTags) suggested.add(tag)
      }
      const draft: PendingDraft = {
        turn: payload.turn,
        userText: textOf('user'),
        assistantText: textOf('assistant'),
        suggestedTags: [...suggested].slice(0, 8),
        relatedIds: state.lastCandidates.slice(0, 3).map((c) => c.id),
        at: Date.now(),
      }
      state.pendingDraft = draft
      // 写入节律提醒的弹药：回合进展摘要（不被消费，保留到被下回合覆盖）
      state.lastDraftSummary = {
        turn: payload.turn,
        at: draft.at,
        suggestedTags: draft.suggestedTags.slice(0, 5),
        digest: firstNonEmptyLine(draft.assistantText || draft.userText).slice(0, 80),
        // 小轮判别：回合以实质汇报收尾（≥ SUBSTANTIVE_REPORT_CHARS 字）才计入汇报轮锚。
        substantive: (draft.assistantText ?? '').length >= SUBSTANTIVE_REPORT_CHARS,
      }
      log('info', `draft-collected session=${state.sessionId} turn=${payload.turn} tags=${draft.suggestedTags.join(',') || '-'}`)
    } catch (e) {
      log('warn', `draft-collect-failed: ${String((e as Error)?.message ?? e)}`)
    }
  })

  ctx.on('agent/disposed', (payload: { agent: AgentLike }) => {
    try {
      const id = payload.agent?.session?.id
      if (!id) return
      const state = getSession(id, null)
      state.pendingDraft = null
      dropSession(id)
      dropSessionTuning(id)
      log('info', `session-disposed id=${id}`)
    } catch {
      /* 静默 */
    }
  })

  /* ────────── ⑤ 启动自检（静默即不可接受：§1 不变量 6） ────────── */

  try {
    const workspace = getWorkspace(process.cwd())
    const report = healthReport(workspace.store, workspace.paths.bucket)
    log(
      'info',
      `plugin-ready workspace=${workspace.paths.cwd} bucket=${workspace.paths.bucket} db=${workspace.paths.dbPath} ` +
        `embedUrl=${workspace.resolved.apiUrl ? 'set' : 'MISSING'} embedKey=${workspace.resolved.apiKey ? 'set' : 'MISSING'} ` +
        `embedSource=${workspace.resolved.source} dim=${workspace.resolved.dimension} ` +
        `corpus=${JSON.stringify(report.counts)} components=${report.components} warnings=${report.warnings.length}`,
    )
    daemonFor(workspace)
  } catch (e) {
    log('error', `plugin-startup-failed: ${String((e as Error)?.stack ?? e)}`)
  }
}

/** 供验收脚本读取：固定契约文本与其 hash（不经过任何运行时拼接）。 */
export { FIXED_CONTRACT_TEXT, FIXED_CONTRACT_SHA256, messageText }
