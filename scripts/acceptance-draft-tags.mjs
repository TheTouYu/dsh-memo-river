#!/usr/bin/env node
/**
 * acceptance-draft-tags.mjs —— 票 02（corpus-governance-0926）「草稿三处修」实测。
 *
 * 票面（.scratch/corpus-governance-0926/issues/02-draft-tag-loop.md）四条腿：
 *   ① 枢纽词占优的场景 ⇒ 预审判「需人工」（内容 kNN 剔枢纽后命中 <3）
 *   ② 内容词占优 ⇒ 可一键批（命中 ≥3，且命中的是**内容词**，不是草稿 md 里那行召回转写）
 *   ③ 本回合已 memo_write 的回合**不产生**草稿文件（对照：未写的回合产生）
 *   ④ 缓存腿：同一草稿预审两次只 embed 一次（计数桩 + 状态文件的 mtime 缓存键）
 *
 * 环境：自建自净（TMPDIR 下 mkdtemp → DSH_HOME / 工作区 / 桶都在里面，结束整体删除）；
 * 嵌入走 `scripts/embed-stub.mjs` 的 **hash** 模式（零猴子补丁，真实 HTTP 传输）。
 * 四条腿全走插件真实入口：①②`precheckDrafts`（守护轮调的就是它）、③ 真实
 * `agent/pre-step` + `agent/turn-stopping` 监听器 + `WorkspaceDaemon.flushDrafts`、
 * ④ 同一 `precheckDrafts` + 实例级计数桩。
 *
 * 用法：TMPDIR=$PWD/.scratch/tmp DSH_HOME=$PWD/.selftest/dsh-home node scripts/acceptance-draft-tags.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startEmbedStub } from './embed-stub.mjs'

/* ── 自净环境：DSH_HOME 必须在 import lib 之前指好（动态 import） ── */
const TMP = mkdtempSync(join(process.env.TMPDIR || '/var/tmp', 'memo-river-draft-tags-'))
process.env.DSH_HOME = join(TMP, 'dsh-home')

const { apply, Config: ConfigSchema } = await import('../lib/index.js')
const { acquireWorkspace } = await import('../lib/workspace.js')
const { workspacePaths } = await import('../lib/runtime.js')
const { peekSession, takeDrafts } = await import('../lib/session.js')
const { setTuningFileForTest } = await import('../lib/tuning.js')
const { precheckDrafts, readDraftStatus } = await import('../lib/drafts.js')
const { WorkspaceDaemon } = await import('../lib/daemon.js')

const CWD_A = join(TMP, 'ws-a') // ①②内容判定
const CWD_B = join(TMP, 'ws-b') // ③回合写入守卫
const CWD_C = join(TMP, 'ws-c') // ④缓存
const BUCKET_A = '草稿内容判定测试'
const BUCKET_B = '回合写入守卫测试'
const BUCKET_C = '内容Tag缓存测试'
const HUB_TAGS = ['枢纽甲', '枢纽乙', '枢纽丙']
const CONTENT_TAGS = ['旁甲一', '旁乙二', '旁丙三']

const results = []
const line = (s = '') => console.log(s)
const hr = (t) => line('\n' + '═'.repeat(96) + (t ? `\n${t}` : '') + '\n' + '═'.repeat(96))
function check(id, title, pass, evidence) {
  results.push({ id, title, pass })
  line(`\n【验收 ${id}】${title}  →  ${pass ? '✅ PASS' : '❌ FAIL'}`)
  for (const e of [].concat(evidence)) line(`    ${e}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── mock Cordis 壳（监听器真注册，pre-step 走真实 waterfall；日志进 logs[] 供取证） ── */
function createMockCtx() {
  const listeners = new Map()
  const registered = { tools: [] }
  const logs = []
  const ctx = {
    logger: {
      info: (m) => logs.push(`info ${String(m)}`),
      warn: (m) => logs.push(`warn ${String(m)}`),
      error: (m) => logs.push(`error ${String(m)}`),
    },
    on(event, fn) {
      const list = listeners.get(event) ?? []
      list.push({ fn })
      listeners.set(event, list)
      return () => {}
    },
    effect(cb) { cb(); return () => {} },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    tools: { register(t) { registered.tools.push(t); return () => {} } },
    get: () => undefined,
    interval(fn) { const h = setInterval(fn, 3_600_000); h.unref?.(); return () => clearInterval(h) },
  }
  return { ctx, listeners, registered, logs }
}
const textMsg = (role, text) => ({ role, content: text, source: { kind: role === 'user' ? 'user' : 'model' } })
/** memo_write 工具调用块（injector.hasMemoWriteCall 认的形状）。 */
const memoWriteCall = () => ({
  role: 'assistant',
  content: [
    { type: 'tool-call', name: 'memo_write', input: { content: '# 本轮进展\n\n已落盘。\n\nTag: a, b, c' } },
    { type: 'text', text: '已用 memo_write 落盘本轮进展。' },
  ],
  source: { kind: 'model' },
})
function createAgent(sessionId, cwd, priorLog = []) {
  const log = [...priorLog]
  return { session: { id: sessionId, header: { cwd }, deriveMessages: () => log }, log }
}
async function runPreStep(h, agent, turn, claimed = [], step = 1) {
  const list = h.listeners.get('agent/pre-step') ?? []
  /* 不往会话日志里塞 runtime-context 之类的插件消息：否则「本轮用户」会录成那行，
   * 草稿文件名（slug 取自 userText）也会跟着错——本套件要看的是真实用户文本。 */
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
/** 生命周期握手（真机：agent/created 先于任何 pre-step）——本插件的会话状态在这里建。 */
function fireAgentCreated(h, agent) {
  const list = h.listeners.get('agent/created') ?? []
  for (const { fn } of list) fn({ agent })
  return list.length
}
function fireTurnStopping(h, agent, turn) {
  const list = h.listeners.get('agent/turn-stopping') ?? []
  for (const { fn } of list) fn({ agent, turn })
  return list.length
}

/** 票02 草稿 md（与 daemon.ts flushDrafts 同格式：召回命中 / 建议 Tag 内容判定 分两节）。 */
function draftMd({ turn, session, bucket, user, assistant, recalled }) {
  return [
    '# 候选草稿（等确认，未入库）',
    '',
    `- 会话：${session}`,
    `- 回合：${turn} @ 2026-09-26T10:0${turn % 10}:00.000Z`,
    `- 桶：${bucket}`,
    '',
    '## 本轮用户',
    user,
    '',
    '## 本轮助手',
    assistant,
    '',
    '## 被动召回命中（**非**建议 Tag）',
    recalled.length > 0 ? recalled.join(', ') : '(无)',
    '',
    '## 建议 Tag（内容判定）',
    '(待守护预审按内容 kNN 判定；结果见本篇旁的 .status.json 的 reusableTags)',
    '',
    '## 相关旧日记',
    '(无)',
    '',
    '> 本文件是**草稿**：确认后用 memo_write 显式入库（会走 Tag 校验与枢纽闸门）。',
    '',
  ].join('\n')
}

const countMd = (dir) => {
  try { return readdirSync(dir).filter((f) => f.endsWith('.md')).length } catch { return 0 }
}
const logTail = (root) => {
  try { return readFileSync(join(root, 'memo-river.log'), 'utf8') } catch { return '' }
}

const stub = await startEmbedStub('hash')
let wsA, wsB, wsC
let exitCode = 1
try {
  setTuningFileForTest(join(TMP, 'tuning.json'))
  for (const c of [CWD_A, CWD_B, CWD_C]) mkdirSync(c, { recursive: true })

  hr(`票 02 草稿三处修 · acceptance-draft-tags（TMP=${TMP}）`)
  const config = ConfigSchema({
    bucket: BUCKET_A,
    embed: { apiUrl: stub.url, apiKey: 'stub' },
    native: { vcpRoot: join(TMP, 'no-vcp') },
  })
  const h = createMockCtx()
  await apply(h.ctx, config)
  const byName = (n) => h.registered.tools.find((t) => t.name === n)
  const writeTool = byName('memo_write')
  if (!writeTool) { console.error('❌ memo_write 未注册'); process.exit(2) }
  const execAt = (cwd, sid) => ({ agent: { session: { id: sid, header: { cwd } } } })
  const execA = (sid) => execAt(CWD_A, sid)

  wsA = acquireWorkspace(CWD_A, config)
  wsB = acquireWorkspace(CWD_B, config)
  wsC = acquireWorkspace(CWD_C, config)
  const pathsB = workspacePaths(CWD_B, BUCKET_B)
  const pathsC = workspacePaths(CWD_C, BUCKET_C)
  mkdirSync(pathsB.pendingDir, { recursive: true })
  mkdirSync(pathsC.pendingDir, { recursive: true })

  /* ── 铺底（只给 ①② 的桶）：6 篇。枢纽甲/乙/丙 各挂 3/6 篇（f=3 ≥3 且 3 ≥ 6/3 ⇒ 枢纽）；
   *    9 个旁* 词各挂 1 篇（f=1 ⇒ 非枢纽）。枢纽谓词 = lib/nudge-guide.js 的 isHubTag。 ── */
  const SEEDS = [
    { t: '# 种子一：枢纽三连甲', tags: HUB_TAGS, body: '铺底样本一：这一篇只用来把三个枢纽词的跨篇频次推过绝对下限。' },
    { t: '# 种子二：枢纽三连乙', tags: HUB_TAGS, body: '铺底样本二：正文与别的种子故意不重样，免得撞上内容去重闸门。' },
    { t: '# 种子三：枢纽三连丙', tags: HUB_TAGS, body: '铺底样本三：语料很薄，但枢纽判定要的是跨篇数不是语料规模。' },
    { t: '# 种子四：旁支一', tags: ['旁甲一', '旁乙一', '旁丙一'], body: '铺底样本四：三个冷门词各挂一篇，内容是无关的一段叙述。' },
    { t: '# 种子五：旁支二', tags: ['旁甲二', '旁乙二', '旁丙二'], body: '铺底样本五：依旧是无关叙述，只是换了几个字的说法。' },
    { t: '# 种子六：旁支三', tags: ['旁甲三', '旁乙三', '旁丙三'], body: '铺底样本六：最后一次铺底，六个样本到此为止。' },
  ]
  let seeded = 0
  for (let i = 0; i < SEEDS.length; i++) {
    const s = SEEDS[i]
    const r = String(await writeTool.execute(
      { content: `${s.t}\n\n${s.body}\n\nTag: ${s.tags.join(', ')}`, newTagReason: '票02 套件空库首建：种子 Tag 均为首次引入' },
      execA(`seed-${i}`),
    ))
    if (r.includes('✅ 已写入')) seeded += 1
  }
  /* SIGBUS 闸适配（2026-09-29）：种子写入的 native 异步可能仍在飞——裸 store 读前先经 withDb 收干。 */
  await wsA.withDb(async () => {})
  const filesA = wsA.store.files(BUCKET_A).length
  const tagRows = wsA.store.tags()
  line(`铺底：${seeded}/${SEEDS.length} 篇入库，库内 ${filesA} 篇 / ${tagRows.length} Tag（带向量 ${tagRows.filter((t) => t.vector).length} 个）`)

  /* ── 两条判别样本草稿（recalled 节故意放**与内容相反**的词，用来证明判定只看内容） ── */
  const hubDraftPath = join(wsA.paths.pendingDir, '2026-09-26-枢纽占优-t7.md')
  const contentDraftPath = join(wsA.paths.pendingDir, '2026-09-26-内容占优-t8.md')
  writeFileSync(hubDraftPath, draftMd({
    turn: 7, session: 'sess-hub-dominant', bucket: BUCKET_A,
    user: '这一轮聊聊枢纽那三个词',
    assistant: '结论：枢纽甲与枢纽乙与枢纽丙三者互为同轴，枢纽甲、枢纽乙、枢纽丙这轮都在讲同一件事；枢纽甲枢纽乙枢纽丙。',
    recalled: CONTENT_TAGS, // 老口径下这行就是建议 Tag（3 个都在词汇表里）⇒ 旧代码会判 ok
  }))
  writeFileSync(contentDraftPath, draftMd({
    turn: 8, session: 'sess-content-dominant', bucket: BUCKET_A,
    user: '旁甲一这条线现在走到哪了',
    assistant: '结论：旁甲一这条线走到头了，旁乙二与旁丙三还得再验一遍；旁甲一、旁乙二、旁丙三的关系是本次的看点。',
    recalled: HUB_TAGS, // 召回命中全是枢纽词 ⇒ 若判定还吃召回，结果会变成枢纽
  }))

  /* ── 腿① / 腿②：两轮预审（真实入口 precheckDrafts；库内裸 store 读——脚本侧须经 withDb 闸，
     守护轮路径本就在 runOnceLocked 闸内，只有脚本这条路会踩 store-busy） ── */
  const round12 = await wsA.withDb(async () => precheckDrafts(wsA, config.write.dedupCosine))
  const st1 = readDraftStatus(hubDraftPath)
  const st2 = readDraftStatus(contentDraftPath)
  line(`\n预审汇总：ok=${round12.ok} manual=${round12.manual} discard=${round12.discard} failures=${round12.failures}`)

  /* memo_drafts 列表（票02 改动点：建议 Tag 取内容判定、召回命中单列且标注「非建议 Tag」）。 */
  const draftsTool = byName('memo_drafts')
  const draftsOut = String(await draftsTool.execute({ all: true, limit: 50 }, execA('sess-lister')))
  const listShowsContentTags = draftsOut.includes('建议 Tag（内容判定）') && draftsOut.includes('被动召回命中（非建议 Tag）') &&
    draftsOut.includes('旁甲一') && !draftsOut.includes('建议 Tag（内容判定）：枢纽')

  check('T-1', '枢纽词占优 ⇒ 预审判「需人工」（剔枢纽后内容命中 <3）',
    st1?.state === 'manual' && st1.reusableTags.length < 3 && HUB_TAGS.every((t) => st1.tagKnn?.droppedHub.includes(t)) && listShowsContentTags,
    [
      `草稿 md 召回命中节（**非**建议 Tag，故意放 3 个词表内的内容词）：${CONTENT_TAGS.join(', ')}`,
      `判定：state=${st1?.state}（应 manual）／kNN 命中后**返回** ${st1?.reusableTags.length} 个（<3 ⇒ 票02 置空）：${st1?.reusableTags.join(', ') || '（空）'}`,
      `kNN top5 = ${(st1?.tagKnn?.hits ?? []).join(', ') || '（空）'}；余弦 = ${(st1?.tagKnn?.scores ?? []).join(', ')}`,
      `剔枢纽 = ${(st1?.tagKnn?.droppedHub ?? []).join(', ') || '（无）'}（应含 ${HUB_TAGS.join('/')}）`,
      `reason：${st1?.reason}`,
      `memo_drafts 列表：${listShowsContentTags ? '✅ 两节分列（建议 Tag（内容判定）／被动召回命中（非建议 Tag））' : '❌ 展示未更新'}`,
      `列表行：${(draftsOut.split('\n').filter((l) => l.includes('建议 Tag（内容判定）'))[0] ?? '(未找到)').trim().slice(0, 100)}`,
    ])

  check('T-2', '内容词占优 ⇒ 可一键批（命中 ≥3，且命中的是内容词而非召回词）',
    st2?.state === 'ok' && CONTENT_TAGS.every((t) => st2.reusableTags.includes(t)) &&
      !HUB_TAGS.some((t) => st2.reusableTags.includes(t)) && st2.nearDup === null,
    [
      `草稿 md 召回命中节（故意放 3 个枢纽词）：${HUB_TAGS.join(', ')}`,
      `判定：state=${st2?.state}（应 ok）／内容命中：${st2?.reusableTags.join(', ') || '（空）'}`,
      `命中是内容词（${CONTENT_TAGS.join('/')}）且无枢纽词混入：${CONTENT_TAGS.every((t) => st2.reusableTags.includes(t)) && !HUB_TAGS.some((t) => st2.reusableTags.includes(t)) ? '✅' : '❌'}`,
      `近重复孪生：${st2.nearDup ? `${st2.nearDup.path}（${st2.nearDup.score.toFixed(4)}）` : '无'}；reason：${st2?.reason}`,
      `tagKnn.source=${st2?.tagKnn?.source} chars=${st2?.tagKnn?.chars}（assistantText 全文）`,
    ])
  const approveTool = byName('memo_approve')
  const approveOut = String(await approveTool.execute({ ids: ['内容占优'] }, execA('sess-approver')))
  const approvedLine = approveOut.split('\n').find((l) => l.includes('✅')) ?? ''
  const approveOk = approvedLine.includes('旁甲一') && !approvedLine.includes('枢纽') && approveOut.includes('approved/')
  check('T-2b', '一键批真的可用：memo_approve 用内容判定 Tag 入库（而非召回命中的枢纽词）', approveOk, [
    `回执：${approvedLine.trim().slice(0, 130)}`,
    `入库 Tag 全为内容词、无枢纽词：${approveOk ? '✅' : '❌'}；出队：${approveOut.includes('approved/') ? '✅ approved/' : '❌'}`,
    `库内篇数 = ${await wsA.withDb(async () => wsA.store.files(BUCKET_A).length)}（种子 6 + 批准 1 = 7）`,
  ])

  /* ── 腿③：本回合已 memo_write ⇒ 不收草稿；对照回合照收 + 落盘 ── */
  const memoWriteTurn = 9
  const agWrote = createAgent('sess-wrote-t9', CWD_B, [
    textMsg('user', '先写下这轮的进展'),
    textMsg('assistant', '好，用 memo_write 落盘。'),
    memoWriteCall(),
  ])
  const agPlain = createAgent('sess-plain-t9', CWD_B, [
    textMsg('user', '这轮不用写日记，只聊聊'),
    textMsg('assistant', '收到，本轮没有写入动作，只有讨论。'),
  ])
  await fireAgentCreated(h, agWrote)
  await fireAgentCreated(h, agPlain)
  await runPreStep(h, agWrote, memoWriteTurn, [], 2)
  await runPreStep(h, agPlain, memoWriteTurn, [], 2)
  const wroteTurnSeen = peekSession('sess-wrote-t9')?.lastDiaryWriteTurn
  const filesBefore = countMd(pathsB.pendingDir)
  fireTurnStopping(h, agWrote, memoWriteTurn)
  fireTurnStopping(h, agPlain, memoWriteTurn)
  const draftWrote = peekSession('sess-wrote-t9')?.pendingDraft ?? null
  const draftPlain = peekSession('sess-plain-t9')?.pendingDraft ?? null
  /* 守卫的留痕走插件 logger（与 draft-collected 同一通道）→ 用 logger 桩取证。 */
  const skipLine = h.logs.find((l) => l.includes('draft-skip reason=wrote-this-turn')) ?? ''
  const skipLogged = skipLine !== ''
  const daemonB = new WorkspaceDaemon({
    config,
    workspace: wsB,
    log: () => {},
    setInterval: () => () => {},
    takeDrafts: () => takeDrafts(() => true),
  })
  const written = daemonB.flushDrafts()
  const mdFiles = readdirSync(pathsB.pendingDir).filter((f) => f.endsWith('.md'))
  const bodyOf = (f) => readFileSync(join(pathsB.pendingDir, f), 'utf8')
  const wroteHasFile = mdFiles.some((f) => bodyOf(f).includes('sess-wrote-t9'))
  const plainHasFile = mdFiles.some((f) => bodyOf(f).includes('sess-plain-t9'))
  const traceLine = skipLine.trim() || '(未找到)'

  check('T-3', '本回合已 memo_write ⇒ 不收草稿（无草稿文件）；对照回合照收并落盘',
    wroteTurnSeen === memoWriteTurn && draftWrote === null && skipLogged && !wroteHasFile &&
      draftPlain !== null && written === 1 && mdFiles.length === 1 && plainHasFile,
    [
      `写侧时钟：lastDiaryWriteTurn=${wroteTurnSeen}（应 ${memoWriteTurn}；由 pre-step 观测 memo_write 工具调用回填）`,
      `已写回合 pendingDraft：${draftWrote === null ? 'null ✅（守卫拦住）' : '❌ 收到草稿'}；对照回合 pendingDraft：${draftPlain ? '✅ 收到' : '❌ null'}`,
      `插件日志（logger 桩）：${traceLine.slice(0, 110)}`,
      `flushDrafts written=${written}（应 1）；pending/*.md = ${mdFiles.length} 篇 [${mdFiles.join(', ')}]`,
      `文件归属：已写会话 ${wroteHasFile ? '❌ 出现草稿文件' : '✅ 无文件'}；对照会话 ${plainHasFile ? '✅ 有文件' : '❌ 无文件'}（落盘前 pending 已有 ${filesBefore} 篇）`,
    ])

  /* ── 腿④：缓存（同一草稿预审两次只 embed 一次；mtime 变则重算） ── */
  const cacheDraftPath = join(pathsC.pendingDir, '2026-09-26-缓存腿-t5.md')
  const writeCacheDraft = (assistantText) => {
    writeFileSync(cacheDraftPath, draftMd({
      turn: 5, session: 'sess-cache', bucket: BUCKET_C,
      user: '缓存腿：同一篇草稿连跑两轮预审', assistant: assistantText, recalled: ['甲词', '乙词'],
    }))
  }
  writeCacheDraft('结论：空词汇表的桶里，内容判定命中 0 个 Tag，应当落「需人工」。')
  const origEmbed = wsC.embed.embed.bind(wsC.embed)
  let embedCalls = 0
  wsC.embed.embed = async (texts, opts) => { embedCalls += 1; return origEmbed(texts, opts) }

  const r1 = await precheckDrafts(wsC, config.write.dedupCosine)
  const after1 = embedCalls
  const stC1 = readDraftStatus(cacheDraftPath)
  const draftMtime1 = statSync(cacheDraftPath).mtimeMs
  const r2 = await precheckDrafts(wsC, config.write.dedupCosine)
  const after2 = embedCalls
  const stC2 = readDraftStatus(cacheDraftPath)
  /* ④b：内容改动 ⇒ mtime 变 ⇒ 缓存失效重算（证明缓存键是 mtime，不是「只算一次」） */
  await sleep(10)
  writeCacheDraft('结论：换了一段正文，mtime 变了，就不再复用上一轮的 kNN 结果。')
  utimesSync(cacheDraftPath, new Date(), new Date(Date.now() + 2000))
  const r3 = await precheckDrafts(wsC, config.write.dedupCosine)
  const after3 = embedCalls
  const stC3 = readDraftStatus(cacheDraftPath)

  check('T-4', '缓存腿：同一草稿预审两次只 embed 一次（缓存键 = 文件名 + mtime；mtime 变则重算）',
    after1 === 1 && after2 === 1 && after3 === 2 &&
      stC1?.tagKnn !== null && stC1?.tagKnn?.mtimeMs === draftMtime1 &&
      stC2?.state === 'manual' && stC3?.tagKnn?.mtimeMs !== draftMtime1,
    [
      `轮次读数：${JSON.stringify(r1)} → ${JSON.stringify(r2)} → ${JSON.stringify(r3)}（均为空词汇表桶，恒 manual=1）`,
      `embed 次数：轮1=${after1}（应 1） 轮2=${after2}（应 1 = 未再 embed） 轮3=${after3}（应 2 = mtime 变后重算）`,
      `轮1 状态文件：state=${stC1?.state} reusableTags=${stC1?.reusableTags.length} 个 tagKnn.mtimeMs=${stC1?.tagKnn?.mtimeMs} / 草稿 mtimeMs=${draftMtime1}`,
      `轮2 状态文件：state=${stC2?.state} tagKnn.mtimeMs=${stC2?.tagKnn?.mtimeMs}（与轮1 同键 ⇒ 复用）；reason：${stC2?.reason}`,
      `轮3 状态文件：tagKnn.mtimeMs=${stC3?.tagKnn?.mtimeMs}（应 ≠ 轮1 键）`,
    ])

  /* ── 腿⑤（票 07 窗口补）：空词表桶 ⇒ 内容判定拿不到 Tag ⇒ memo_approve **跳过** ──
   *  T-4 已证「空词表桶 ⇒ 预审恒 manual」，这条把**批准入口**那半也钉住：不写库、草稿留在 pending。
   *  主套件 #14 的边界样本正是照这条路径改写的（旧前提「建议 Tag ∩ 词汇表 < 3」在非空桶不可构造）；
   *  主套件当前被 SIGBUS 环境族堵着，故在快套件里把该前提取到读数。 */
  const emptyDraft = join(pathsC.pendingDir, '2026-09-26-空词表样本-t20.md')
  writeFileSync(emptyDraft, [
    '# 候选草稿（等确认，未入库）',
    '',
    '- 会话：session-empty-t20',
    '- 回合：20 @ 2026-09-26T10:00:20.000Z',
    `- 桶：${BUCKET_C}`,
    '',
    '## 本轮用户',
    '空词表桶里的一篇草稿',
    '',
    '## 本轮助手',
    '结论：这个桶里一条日记都没有，内容判定无从命中。',
    '',
    '## 建议 Tag（内容判定）',
    '(待守护轮填写)',
    '',
    '## 相关旧日记',
    '(无)',
    '',
    '> 本文件是**草稿**：确认后用 memo_write 显式入库（会走 Tag 校验与枢纽闸门）。',
  ].join('\n'), 'utf8')
  const filesCBefore = wsC.store.files(BUCKET_C).length
  const approveEmptyOut = String(await byName('memo_approve').execute({ all: true, bucket: BUCKET_C }, execAt(CWD_C, 'sess-empty-approver')))
  const emptySkipOk =
    approveEmptyOut.includes('跳过') &&
    !approveEmptyOut.includes('✅') &&
    wsC.store.files(BUCKET_C).length === filesCBefore &&
    existsSync(emptyDraft)
  check('T-5', '空词表桶 ⇒ 内容判定无 Tag ⇒ memo_approve 跳过（不写库、草稿留 pending）', emptySkipOk, [
    `回执：${(approveEmptyOut.split('\n').find((l) => l.includes('跳过')) ?? approveEmptyOut.split('\n')[0] ?? '').trim().slice(0, 140)}`,
    `库内篇数：${filesCBefore} → ${wsC.store.files(BUCKET_C).length}（应不变）`,
    `草稿仍在 pending：${existsSync(emptyDraft) ? '✅' : '❌'}`,
  ])

  /* ── 腿⑥（票 07 窗口补）：**嵌入失败** ⇒ 内容判定不可用 ⇒ 预审 manual（且不落缓存，下轮复判） ──
   *  这是「Tag 不足」的另一条可达路径（第一条见 T-5 的空词表）。主套件 #36 的边界样本正走这条，
   *  理由：旧样本「恰好两个可复用 Tag」在票02 后不可构造，而嵌入故障是真实运维里会发生的那种。 */
  const failDraft = join(pathsC.pendingDir, '2026-09-26-嵌入失败样本-t21.md')
  writeFileSync(failDraft, [
    '# 候选草稿（等确认，未入库）',
    '',
    '- 会话：session-embed-down-t21',
    '- 回合：21 @ 2026-09-26T10:00:21.000Z',
    `- 桶：${BUCKET_C}`,
    '',
    '## 本轮用户',
    '嵌入失败样本问一句',
    '',
    '## 本轮助手',
    '结论：嵌入失败时内容判定不可用 ⇒ 需人工。',
    '',
    '## 建议 Tag（内容判定）',
    '(待守护轮填写)',
    '',
    '## 相关旧日记',
    '(无)',
    '',
    '> 本文件是**草稿**：确认后用 memo_write 显式入库（会走 Tag 校验与枢纽闸门）。',
  ].join('\n'), 'utf8')
  const prevEmbed = wsC.embed.embed.bind(wsC.embed)
  wsC.embed.embed = async (texts, opts) => {
    if (texts.some((t) => String(t).includes('嵌入失败'))) throw new Error('stub-embed-down')
    return prevEmbed(texts, opts)
  }
  await precheckDrafts(wsC, config.write.dedupCosine)
  const stFail = readDraftStatus(failDraft)
  const embedDownOk =
    stFail?.state === 'manual' &&
    stFail.reusableTags.length === 0 &&
    String(stFail.reason).includes('嵌入失败') &&
    stFail.tagKnn === null
  check('T-6', '嵌入失败 ⇒ 内容判定不可用 ⇒ 预审 manual（失败不落缓存，下轮自动复判）', embedDownOk, [
    `状态：state=${stFail?.state} reusableTags=${stFail?.reusableTags.length} 个`,
    `reason：${String(stFail?.reason).slice(0, 110)}`,
    `tagKnn 缓存：${stFail?.tagKnn === null ? '✅ 未落缓存（下轮复判）' : '❌ 落了缓存'}`,
  ])

  exitCode = 0
} catch (e) {
  console.error(`\n❌ 套件异常：${String(e?.stack ?? e)}`)
} finally {
  try { wsA?.close() } catch { /* 静默 */ }
  try { wsB?.close() } catch { /* 静默 */ }
  try { wsC?.close() } catch { /* 静默 */ }
  await stub.stop()
  rmSync(TMP, { recursive: true, force: true })
}

hr('结果')
const failed = results.filter((r) => !r.pass)
line(`${results.length - failed.length}/${results.length} PASS${failed.length ? `；FAIL：${failed.map((f) => f.id).join(', ')}` : ''}`)
process.exit(failed.length || exitCode !== 0 ? 1 : 0)
