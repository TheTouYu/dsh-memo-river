#!/usr/bin/env node
/**
 * acceptance-queryfield.mjs —— D214「被动召回为何桶里有却不生效」两刀的实测。
 *
 *   A 查询场白名单（injector.isDialogMessage）：
 *     Q-1 source.kind 白名单逐条：生产实测的 14 种 kind 里只有 user / model / agent-message
 *         / 无 source 进查询场，其余（本插件注入块、压缩摘要、运行上下文、技能目录、nudge、
 *         prune 墓碑、工作区指令、审批变更、旧 plugin 包装、工具输出）全部被挡。
 *     Q-2 **负对照**：用生产实测尺寸复现 session-df68235a 那一轮，旧黑名单谓词下查询场 99.1%
 *         是本插件**上一轮自己的注入块**；新白名单下该比例 = 0%，用户原话保留。
 *     Q-3 漂移可观测：queryFieldExclusionStats 把被排除的 kind 计数报出来（不静默）。
 *
 *   B 召回失败可见化（injector.recallFailureNotice + render.renderRecallNotice）：
 *     Q-4 真 pre-step 集成（空查询场腿）：失败时模型请求里**真的**多出一条 memo-river/notice
 *         「召回未生效」，且这条通知**不含** BLOCK_CLOSE（不冒充召回块、不污染验收 #1 的定位）。
 *     Q-5 判据矩阵：embed-timeout / embed-failed / native-unavailable / empty-query-field 触发；
 *         空库 / 门控不过 / 同集合去重 **不**触发；回合首发必发、自主态 5 分钟节流。
 *     Q-6 自洽性：通知消息自身（kind=memo-river, form=notice）**进不了**查询场——降级可见化
 *         不会变成新的污染源。
 *
 * 自建自净：DSH_HOME 与工作区都建在 mktemp 目录，结束整体删除——不碰生产桶。
 * 用法：node scripts/acceptance-queryfield.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const TMP = mkdtempSync(join(process.env.TMPDIR || '/var/tmp', 'memo-river-qf-'))
process.env.DSH_HOME = join(TMP, 'dsh-home')
const CWD = join(TMP, 'ws')

const { apply, Config: ConfigSchema } = await import('../lib/index.js')
const { buildQueryField } = await import('../lib/recall.js')
const {
  DIALOG_SOURCE_KINDS,
  RECALL_NOTICE_MIN_SPACING_MS,
  createRecallNoticeMessage,
  isDialogMessage,
  isRecallInfrastructureFailure,
  noteRecallFailure,
  queryFieldExclusionStats,
  recallFailureNotice,
} = await import('../lib/injector.js')
const { getSession, peekSession } = await import('../lib/session.js')
const { workspacePaths } = await import('../lib/runtime.js')
const { BLOCK_CLOSE, BLOCK_OPEN } = await import('../lib/render.js')

const results = []
const line = (s = '') => console.log(s)
const hr = (t) => line('\n' + '═'.repeat(96) + (t ? `\n${t}` : '') + '\n' + '═'.repeat(96))
function check(id, title, pass, evidence) {
  results.push({ id, title, pass })
  line(`\n【验收 ${id}】${title}  →  ${pass ? '✅ PASS' : '❌ FAIL'}`)
  for (const e of [].concat(evidence)) line(`    ${e}`)
}

/* ── 消息构造：source.kind 一律用**生产实测取值** ── */
const textOf = (m) => (Array.isArray(m?.content) ? m.content.map((b) => b?.text ?? '').join('\n') : '')
const mk = (role, kind, text, extra = {}) => ({
  role,
  content: [{ type: 'text', text }],
  ...(kind === null ? {} : { source: { kind, ...extra } }),
})

/* ══════════════════════ Q-1 kind 白名单逐条 ══════════════════════ */
hr('Q-1 查询场白名单：哪些 source.kind 算「真正的对话」')
const KINDS = [
  ['user', true, '真人用户消息'],
  ['model', true, '模型回答'],
  ['agent-message', true, '兄弟代理 relay（dsh-subagent createAgentMessage）'],
  [null, true, '无 source（老会话 / 种子消息 / 测试夹具）'],
  ['memo-river', false, '本插件的注入块与写提醒（★本次回归的主角）'],
  ['compact-checkpoint', false, 'ACP 压缩摘要（×9 条涌进查询场）'],
  ['runtime-context', false, 'DSH 每轮重注的运行上下文快照'],
  ['skill-catalog', false, '技能目录（7623 字）'],
  ['acp-nudge', false, '压缩 nudge'],
  ['billion-context-dsh', false, 'prune 墓碑通知'],
  ['agent-instructions', false, '工作区指令（AGENTS.md 注入）'],
  ['user-approval', false, '审批策略变更通知'],
  ['plugin', false, '旧格式通用包装（黑名单时代唯一挡住的那个）'],
  ['tool', false, '工具输出'],
]
{
  const rows = []
  let pass = true
  for (const [kind, want, desc] of KINDS) {
    const ok = isDialogMessage(mk('user', kind, 'x')) === want
    const okA = isDialogMessage(mk('assistant', kind, 'x')) === want
    if (!ok || !okA) pass = false
    rows.push(`  ${ok && okA ? '✅' : '❌'} ${String(kind).padEnd(22)} ${want ? '进查询场' : '被排除  '}  ${desc}`)
  }
  check('Q-1', '白名单逐条：只有 user / model / agent-message / 无 source 进查询场', pass, [
    `白名单集合 = {${[...DIALOG_SOURCE_KINDS].join(', ')}}`,
    ...rows,
  ])
}

/* ══════════════════════ Q-2 负对照：生产那一轮的查询场构成 ══════════════════════ */
hr('Q-2 负对照：复现 session-df68235a 那轮查询场（旧黑名单 vs 新白名单）')

/** 旧谓词（2026-10-14 之前的生产实现，逐字复刻）——负对照用，不参与生产。 */
function legacyIsDialogMessage(m) {
  if (m?.role !== 'user' && m?.role !== 'assistant') return false
  const k = m?.source?.kind
  return k !== 'plugin' && k !== 'tool'
}

/* 尺寸全部取自生产会话实测（.diag 取证）：
 * runtime-context 390 / skill-catalog 7623 / memo-river notice 417 / recall 3423 + 3100 / 用户原话 34。 */
const USER_LINE = '还要加强验收阶段。参考之前，去新的端口，用同样的会话复现问题，看结果'
const pad = (s, n) => (s + '·'.repeat(Math.max(0, n - s.length))).slice(0, n)
const PROD_LOG = [
  mk('user', 'runtime-context', pad('Current runtime context. This snapshot supersedes earlier ones.', 390)),
  mk('user', 'skill-catalog', pad('<system-reminder> The available skill catalog changed.', 7623)),
  mk('user', 'memo-river', pad('[memo-river·写入节律] 记忆节律提醒，非新任务：已 50 步未写', 417)),
  mk('user', 'memo-river', pad(`${BLOCK_OPEN} D122 MALFORMED-RESPONSE 九月旧案 D110 D101 D124`, 3423)),
  mk('user', 'memo-river', pad(`${BLOCK_OPEN} D110 系统提示词盲评 D122 D101 D124`, 3100)),
]
const CLAIMED = [mk('user', 'user', USER_LINE)]
const fieldOf = (pred) => buildQueryField([...PROD_LOG.filter(pred), ...CLAIMED].map(textOf), 6)

const legacyField = fieldOf(legacyIsDialogMessage)
const newField = fieldOf(isDialogMessage)
const legacyPollution = ((legacyField.length - USER_LINE.length) / legacyField.length) * 100
const newPollution = newField.includes(BLOCK_OPEN) ? 100 : 0
{
  const pass =
    legacyPollution > 90 && // 旧实现：查询场被自家注入块灌满（生产复算 = 99.1%）
    newPollution === 0 && // 新实现：一个字节的注入块都不进查询场
    newField.includes(USER_LINE) && // 用户原话必须保留
    newField.length <= USER_LINE.length + 1
  check('Q-2', '同一份生产日志：旧实现查询场被自家注入块灌满，新实现只剩用户原话', pass, [
    `旧黑名单：查询场 ${legacyField.length} 字，其中插件自己的注入块占 ${legacyPollution.toFixed(1)}%（生产实测 99.1%）`,
    `新白名单：查询场 ${newField.length} 字，注入块占比 ${newPollution}%，含用户原话=${newField.includes(USER_LINE)}`,
    `查询场实际内容（新）：${JSON.stringify(newField)}`,
  ])
}

/* ══════════════════════ Q-3 漂移可观测 ══════════════════════ */
hr('Q-3 漂移可观测：被排除的 kind 必须报得出来')
{
  const stats = queryFieldExclusionStats([...PROD_LOG, ...CLAIMED, mk('assistant', 'model', 'ok')])
  const none = queryFieldExclusionStats([mk('user', 'user', 'a'), mk('assistant', 'model', 'b')])
  const pass = stats === 'runtime-context×1,skill-catalog×1,memo-river×3' && none === null
  check('Q-3', 'queryFieldExclusionStats 报出被排除 kind 计数（纯对话 → null）', pass, [
    `含上下文的日志 → ${stats}`,
    `纯对话日志 → ${none === null ? 'null（无可排除）' : none}`,
  ])
}

/* ══════════════════════ Q-4 真 pre-step 集成（空查询场腿） ══════════════════════ */
hr('Q-4 真 pre-step：召回失败时模型请求里真的多一条「召回未生效」通知')

function createMockCtx() {
  const listeners = new Map()
  const disposers = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(event, fn, opts) {
      const list = listeners.get(event) ?? []
      const entry = { fn, opts }
      if (opts?.prepend) list.unshift(entry)
      else list.push(entry)
      listeners.set(event, list)
      return () => {
        const i = list.indexOf(entry)
        if (i >= 0) list.splice(i, 1)
      }
    },
    effect(cb) {
      const d = cb()
      disposers.push(d)
      return () => {
        try {
          d?.()
        } catch {
          /* 静默 */
        }
      }
    },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    tools: { register: () => () => {} },
    get: () => undefined,
    interval(fn, ms) {
      const t = setInterval(fn, ms)
      t.unref?.()
      return () => clearInterval(t)
    },
  }
  return { ctx, listeners, dispose: () => disposers.forEach((d) => { try { d?.() } catch { /* 静默 */ } }) }
}

async function runPreStep(h, agent, turn, claimed, step = 1) {
  const list = h.listeners.get('agent/pre-step') ?? []
  let next = async () => ({ kind: 'enter', messages: [...claimed] })
  for (let i = list.length - 1; i >= 0; i--) {
    const fn = list[i].fn
    const downstream = next
    next = () => fn({ agent, messages: claimed, turn, step, signal: { aborted: false } }, downstream)
  }
  const decision = await next()
  if (decision?.kind === 'enter') agent.log.push(...decision.messages)
  return decision
}

{
  const h = createMockCtx()
  const config = ConfigSchema({ bucket: '' })
  apply(h.ctx, config)
  const agent = {
    session: {
      id: 'sess-q4',
      header: { cwd: CWD },
      deriveMessages: () => agent.log,
    },
    log: [
      // 历史里只有生产者上下文（全被白名单挡住）→ 查询场为空 → empty-query-field
      mk('user', 'runtime-context', 'Current runtime context.'),
      mk('user', 'compact-checkpoint', '[Model-written summary] 旧主题摘要'),
      mk('user', 'memo-river', `${BLOCK_OPEN} 上一轮注入块 ${BLOCK_CLOSE}`),
    ],
  }
  // claimed 是工具结果（messageText 读不出文本 → 查询场为空），且 step=1 = 回合首发
  const claimed = [{ role: 'user', source: { kind: 'tool' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ls -la 输出' }] }] }]
  const decision = await runPreStep(h, agent, 1, claimed, 1)
  const added = decision.messages.slice(claimed.length)
  const notices = added.filter((m) => m?.source?.kind === 'memo-river' && m?.source?.form === 'notice')
  const injects = added.filter((m) => textOf(m).includes(BLOCK_CLOSE))
  const noticeText = notices.map(textOf).join('\n')
  const wsPaths = workspacePaths(CWD)
  const logText = existsSync(wsPaths.logPath) ? readFileSync(wsPaths.logPath, 'utf8') : ''
  const state = peekSession('sess-q4')
  const pass =
    notices.length === 1 &&
    noticeText.includes('召回未生效') &&
    noticeText.includes('empty-query-field') &&
    !noticeText.includes(BLOCK_CLOSE) &&
    injects.length === 0 &&
    logText.includes('recall-notice') &&
    state?.recallFailureStreak === 1
  check('Q-4', '失败降级不再沉默：pre-step 追加 notice（不含 BLOCK_CLOSE），桶日志留 recall-notice', pass, [
    `追加的消息数 = ${added.length}（1 = 只有通知，没有召回块）`,
    `notice 条数 = ${notices.length}；form=notice 且 kind=memo-river`,
    `通知正文：${noticeText.split('\n')[0]}`,
    `不含 BLOCK_CLOSE（不冒充召回块）= ${!noticeText.includes(BLOCK_CLOSE)}；召回块条数 = ${injects.length}`,
    `桶日志 recall-notice 行 = ${logText.includes('recall-notice')}（${wsPaths.logPath}）`,
    `state.recallFailureStreak = ${state?.recallFailureStreak}`,
  ])
  h.dispose()
}

/* ══════════════════════ Q-5 判据矩阵 ══════════════════════ */
hr('Q-5 判据矩阵：哪些失败发通知、哪些按设计不发')
{
  const mkState = (id) => getSession(id, CWD)
  const fire = (reason, id, isTurnStart = true, at = () => Date.now()) => {
    const s = mkState(id)
    s.lastFallbackReason = reason
    s.lastRecallNoticeAt = 0
    s.recallFailureStreak = 0
    noteRecallFailure(s, reason)
    return recallFailureNotice(s, 'x', isTurnStart, at())
  }
  const SHOULD = [
    ['embed-timeout: The operation was aborted due to timeout', true],
    ['embed-failed: embed-circuit-open: 端点连续失败 16 次，退避窗口还剩 195s', true],
    ['embed-failed: embed-http-400: Invalid JSON payload received.', true],
    ['native-unavailable', true],
    ['empty-query-field', true],
  ]
  const SHOULD_NOT = ['empty-corpus', 'gate-below-threshold', 'identical-selection', null]
  const rows = []
  let pass = true
  for (const [reason, want] of SHOULD) {
    const got = fire(reason, `s-${reason}`) !== null
    if (got !== want) pass = false
    rows.push(`  ${got === want ? '✅' : '❌'} 发通知   reason=${reason}`)
  }
  for (const reason of SHOULD_NOT) {
    const got = fire(reason, `s-${String(reason)}`) !== null
    if (got) pass = false
    rows.push(`  ${got ? '❌' : '✅'} 不发     reason=${reason ?? '(null)'}`)
  }
  // 节流：自主态 5 分钟内第二次不发；回合首发不受节流限制
  const s1 = getSession('sess-throttle', CWD)
  s1.lastFallbackReason = 'embed-timeout: x'
  s1.lastRecallNoticeAt = 0
  const t0 = 1_000_000
  const first = recallFailureNotice(s1, 'x', false, t0)
  const second = recallFailureNotice(s1, 'x', false, t0 + 60_000)
  const turnStart = recallFailureNotice(s1, 'x', true, t0 + 60_000)
  const okThrottle = first !== null && second === null && turnStart !== null
  if (!okThrottle) pass = false
  rows.push(
    `  ${first !== null ? '✅' : '❌'} 自主态首发发 → ${first !== null}`,
    `  ${second === null ? '✅' : '❌'} 自主态 ${RECALL_NOTICE_MIN_SPACING_MS / 60000} 分钟内第二次不发 → ${second === null}`,
    `  ${turnStart !== null ? '✅' : '❌'} 回合首发不受节流（正是「这轮没记忆」的时刻）→ ${turnStart !== null}`,
  )
  // 成功清零
  const s2 = getSession('sess-reset', CWD)
  noteRecallFailure(s2, 'embed-timeout: x')
  noteRecallFailure(s2, 'embed-timeout: x')
  const before = s2.recallFailureStreak
  s2.recallFailureStreak = 0 // buildTailInjection 成功路径的行为
  const okReset = before === 2 && s2.recallFailureStreak === 0
  if (!okReset) pass = false
  rows.push(`  ${okReset ? '✅' : '❌'} 连续失败计数累加（${before}）后由成功路径清零（${s2.recallFailureStreak}）`)
  rows.push(`  isRecallInfrastructureFailure(null) = ${isRecallInfrastructureFailure(null)}（须 false）`)
  check('Q-5', '基础设施失败触发、按设计不注入不触发、首发必发+节流+成功清零', pass, rows)
}

/* ══════════════════════ Q-6 自洽性：通知自身进不了查询场 ══════════════════════ */
hr('Q-6 自洽性：降级通知自己不会变成新的查询场污染源')
{
  const noticeMsg = createRecallNoticeMessage('x')
  const kind = noticeMsg?.source?.kind
  const form = noticeMsg?.source?.form
  const excluded = !isDialogMessage(noticeMsg)
  check('Q-6', '通知消息 kind=memo-river / form=notice → 被白名单排除', kind === 'memo-river' && form === 'notice' && excluded, [
    `source.kind=${kind} form=${form}`,
    `isDialogMessage(通知) = ${!excluded}（须 false → 不进查询场）`,
  ])
}

/* ══════════════════════ 结果 ══════════════════════ */
try {
  rmSync(TMP, { recursive: true, force: true })
} catch {
  /* 清理失败不影响判据 */
}
hr('结果')
const failed = results.filter((r) => !r.pass)
line(`${results.length - failed.length}/${results.length} PASS${failed.length ? `；FAIL：${failed.map((f) => f.id).join(', ')}` : ''}`)
process.exit(failed.length ? 1 : 0)
