#!/usr/bin/env node
/**
 * acceptance-hub-gate.mjs —— 票 06（recall-quality-0916）「hub Tag 写入闸门场景化
 * （子代理防推爆）」的实测（.scratch/recall-quality-0916/issues/06-hub-gate-scoped.md）。
 *
 * 六条判据，全部走插件真实入口（mock 的只有 Cordis 壳与 pre-step waterfall；嵌入离线
 * ——闸门频次口径不依赖向量，替代建议走频率回退分支）：
 *   H-1 缺省档 = suggest：委托会话（header.delegationDepth=1）写枢纽 Tag → 放行
 *       + 报告带【hub 闸门·观察】段与词汇表内替代建议 + memo-river.log 落 hub-gate-observe 行
 *   H-2 enforce 档（config.write.hubGateMode=2）：同一委托写 → hub-tag-scoped 硬拒
 *       + 词汇表内替代建议（带桶内频次）+ 库不落篇
 *   H-3 交互会话现状回归：enforce 档下交互写枢纽 Tag → 放行，仅既有「枢纽警告」软警告
 *   H-4 autonomous 信号全链路：真实 pre-step（step=3 无新用户输入）→ SessionState.lastInjectMode
 *       ='autonomous' → enforce 档该会话写枢纽 Tag 被拒（shape=injectMode=autonomous）；
 *       回合首发（step=1 带新输入）回落 interactive → 放行
 *   H-5 preset 级开关可控：memo_tuning {action:set, scope:preset, hubGateMode} 落盘 tuning.json
 *       + 进程内即时生效（0=off 时场景内也只回软警告；缺省值 1=suggest）
 *   H-6 场景内改写豁免：memo_update 目标已有的枢纽 Tag → 放行（跨篇数不 +1，拦它只会阻止修复）；
 *       给无枢纽 Tag 的篇新挂 → 拒
 *   H-7 memo_approve 场景内批草稿（建议 Tag 含枢纽词）→ enforce 拒、草稿留 pending
 *       （D10 机械批准污染样本的闸门对位）
 *   H-8 memo_merge 豁免：委托会话 enforce 档合并两篇枢纽 Tag 日记 → 放行（合并是去枢纽手术工具）
 *
 * 自建自净：DSH_HOME 状态根 + 工作区建在 mktemp 目录，结束整体删除——不碰生产桶。
 * 用法：node scripts/acceptance-hub-gate.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/* ── 自建自净环境：DSH_HOME / tuning 文件都必须在 import lib 之前指好（动态 import） ── */
const TMP = mkdtempSync(join(process.env.TMPDIR || '/var/tmp', 'memo-river-hubgate-'))
process.env.DSH_HOME = join(TMP, 'dsh-home')
const { apply, Config: ConfigSchema } = await import('../lib/index.js')
const { acquireWorkspace } = await import('../lib/workspace.js')
const { workspacePaths } = await import('../lib/runtime.js')
const { peekSession } = await import('../lib/session.js')
const { setTuningFileForTest } = await import('../lib/tuning.js')

const CWD = join(TMP, 'ws')
const BUCKET = '枢纽闸门测试'
const HUB = '枢纽词'
/* 种子语料：6 篇。枢纽词×3（3/6=0.5 ≥1/3）、词汇A×2（2/6 也 ≥1/3——同判据口径）、
 * 其余 12 个词各 ×1（1/6 <1/3 → 候选替代池）。 */
const SEEDS = [
  { t: `# 种子一：${HUB} 首挂`, tags: [HUB, '词汇A', '词汇B'] },
  { t: `# 种子二：${HUB} 再挂`, tags: [HUB, '词汇A', '词汇C'] },
  { t: `# 种子三：${HUB} 三挂`, tags: [HUB, '词汇D', '词汇E'] },
  { t: '# 种子四：无枢纽', tags: ['词汇F', '词汇G', '词汇H'] },
  { t: '# 种子五：无枢纽', tags: ['词汇I', '词汇J', '词汇K'] },
  { t: '# 种子六：无枢纽', tags: ['词汇L', '词汇M', '词汇N'] },
]
const REASON = '闸门测试空库首建：种子 Tag 均为首次引入'

const results = []
const line = (s = '') => console.log(s)
const hr = (t) => line('\n' + '═'.repeat(96) + (t ? `\n${t}` : '') + '\n' + '═'.repeat(96))
function check(id, title, pass, evidence) {
  results.push({ id, title, pass })
  line(`\n【验收 ${id}】${title}  →  ${pass ? '✅ PASS' : '❌ FAIL'}`)
  for (const e of [].concat(evidence)) line(`    ${e}`)
}

function createMockCtx() {
  const listeners = new Map()
  const registered = { tools: [] }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
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
  return { ctx, listeners, registered }
}

/* pre-step waterfall 台架（与 acceptance.mjs 同款；被测的 injector 监听器是真实注册物） */
const pluginMsg = (text) => ({ role: 'user', content: text, source: { kind: 'plugin', plugin: 'runtime-context' } })
const textMsg = (role, text) => ({ role, content: text, source: { kind: role === 'user' ? 'user' : 'model' } })
function createAgent(sessionId, cwd, priorLog = []) {
  const log = [...priorLog]
  return { session: { id: sessionId, header: { cwd }, deriveMessages: () => log }, log }
}
async function runPreStep(h, agent, turn, claimed, step = 1) {
  for (const m of claimed) if (agent.log.includes(m)) throw new Error('claimed 已在日志中（harness 不变量）')
  const list = h.listeners.get('agent/pre-step') ?? []
  const runtimeContext = pluginMsg('Current runtime context.')
  let next = async () => ({ kind: 'enter', messages: [...claimed, runtimeContext] })
  for (let i = list.length - 1; i >= 0; i--) {
    const fn = list[i].fn
    const downstream = next
    next = () => fn({ agent, messages: claimed, turn, step, signal: { aborted: false } }, downstream)
  }
  const decision = await next()
  if (decision?.kind === 'enter') agent.log.push(...decision.messages)
  return decision
}

/* ── 前置：隔离 tuning 文件（防真实 ~/.agent-presets 泄入）+ 自建工作区（嵌入离线） ── */
setTuningFileForTest(join(TMP, 'tuning.json'))
const paths = workspacePaths(CWD, BUCKET)
mkdirSync(CWD, { recursive: true })

hr(`票 06 hub 写入闸门场景化 · acceptance-hub-gate（工作区 ${CWD}）`)
const config = ConfigSchema({ bucket: BUCKET, native: { vcpRoot: join(CWD, 'no-vcp') } })
const h = createMockCtx()
await apply(h.ctx, config)
const byName = (n) => h.registered.tools.find((t) => t.name === n)
const writeTool = byName('memo_write')
const updateTool = byName('memo_update')
const mergeTool = byName('memo_merge')
const approveTool = byName('memo_approve')
const tuningTool = byName('memo_tuning')
if (!writeTool || !updateTool || !mergeTool || !approveTool || !tuningTool) {
  console.error('❌ 工具未注册齐全')
  process.exit(2)
}
const ws = acquireWorkspace(CWD, config)
/* exec 桩：interExec=交互（无 depth、未见过的会话）；delExec=被派的孩子（depth=1）。 */
const interExec = (sid = 'sess-interactive') => ({ agent: { session: { id: sid, header: { cwd: CWD } } } })
const delExec = (sid = 'sess-child-1', depth = 1) => ({ agent: { session: { id: sid, header: { cwd: CWD, delegationDepth: depth } } } })
const exec = (t, args, e = interExec()) => t.execute(args, e)
const fileCount = () => ws.store.files(BUCKET).length
const logTail = () => {
  try { return readFileSync(join(paths.root, 'memo-river.log'), 'utf8') } catch { return '' }
}

try {
  /* ── 铺底：6 篇种子（交互会话写——闸门不对交互生效，缺省 suggest 档下也只走软警告） ── */
  let seeded = 0
  for (const s of SEEDS) {
    const r = String(await exec(writeTool, { content: `${s.t}\n\n种子正文：铺出枢纽频次与替代词汇池。\n\nTag: ${s.tags.join(', ')}`, newTagReason: REASON }))
    if (r.includes('✅ 已写入')) seeded += 1
  }
  if (seeded !== SEEDS.length || fileCount() !== 6) {
    check('H-0', '铺底：6 篇种子全部入库', false, [`seeded=${seeded} files=${fileCount()}`])
    process.exit(1)
  }
  const hubCount = ws.store.files(BUCKET).filter((f) => ws.store.fileTags(f.id).some((t) => t.name === HUB)).length
  line(`铺底：6 篇入库，「${HUB}」挂 ${hubCount}/6 = ${(hubCount / 6).toFixed(3)}（≥1/3 ✅ 已枢纽化）`)

  /* ── H-1 缺省档 = suggest：委托写枢纽 Tag → 放行 + 观察段 + 替代建议 + 观察日志行 ── */
  const defaultModeOk = config.write.hubGateMode === 1
  const before1 = fileCount()
  const r1 = String(await exec(writeTool, {
    content: `# 子代理落盘：又写枢纽\n\n委托进行中的进展日记，Tag 踩在枢纽词上。\n\nTag: ${HUB}, 词汇B, 词汇C`,
  }, delExec()))
  const log1 = logTail()
  const altLine1 = r1.split('\n').find((l) => l.includes('替代建议')) ?? ''
  const t1 =
    defaultModeOk && r1.includes('✅ 已写入') && fileCount() === before1 + 1 &&
    r1.includes('【hub 闸门·观察】') && r1.includes(HUB) && altLine1.includes('「') &&
    log1.includes('hub-gate-observe') && log1.includes(`tag=${HUB}`) && log1.includes('shape=delegationDepth=1')
  check('H-1', '缺省 suggest 档：委托写枢纽 Tag → 放行 + 观察段 + 替代建议 + hub-gate-observe 日志', t1, [
    `缺省值 config.write.hubGateMode=${config.write.hubGateMode}（应为 1）`,
    `观察段：${(r1.match(/· 【hub 闸门·观察】[^\n]*/) ?? ['(未找到)'])[0]}`,
    `替代建议：${altLine1.slice(0, 90)}`,
    `日志行：${(log1.split('\n').filter((l) => l.includes('hub-gate-observe')).pop() ?? '(未找到)').slice(0, 120)}`,
  ])

  /* ── H-2 enforce 档：同一委托写 → 硬拒 + 替代建议（带频次）+ 不落库 ── */
  config.write.hubGateMode = 2
  const before2 = fileCount()
  const r2 = String(await exec(writeTool, {
    content: `# 子代理再写：enforce 应拒\n\n同一委托会话的第二次写入。\n\nTag: ${HUB}, 词汇B, 词汇D`,
  }, delExec('sess-child-2')))
  const rejectLine = r2.split('\n').find((l) => l.includes('被拒绝')) ?? ''
  const advice2 = r2.split('\n').find((l) => l.includes('词汇表内替代建议')) ?? ''
  const t2 =
    r2.includes('❌ memo_write 被拒绝：hub-tag-scoped') && fileCount() === before2 &&
    advice2.includes('「') && /\「[^」]+」×\d/.test(advice2) && !advice2.includes(`「${HUB}」`) &&
    logTail().includes('rejected=hub-tag-scoped')
  check('H-2', 'enforce 档：委托写枢纽 Tag → hub-tag-scoped 硬拒 + 词汇表内替代建议 + 不落库', t2, [
    `拒绝行：${rejectLine}`,
    `建议行（带桶内频次）：${advice2.slice(0, 100)}`,
    `库内篇数：${fileCount()}（拒绝前后应相等 = ${before2}）`,
  ])

  /* ── H-3 交互会话现状回归：enforce 档下交互写枢纽 → 放行，仅软警告 ── */
  const before3 = fileCount()
  const r3 = String(await exec(writeTool, {
    content: `# 交互会话写枢纽：现状回归\n\n人类在场的会话不受闸门约束，保持软警告。\n\nTag: ${HUB}, 词汇E, 词汇F`,
  }, interExec('sess-interactive-h3')))
  const t3 =
    r3.includes('✅ 已写入') && fileCount() === before3 + 1 &&
    r3.includes('枢纽警告') && !r3.includes('hub-tag-scoped') && !r3.includes('【hub 闸门·观察】')
  check('H-3', '交互会话：enforce 档也只软警告（现状回归，放行）', t3, [
    `写入：${r3.includes('✅ 已写入') ? '✅ 放行' : '❌'}（库 ${before3}→${fileCount()}）`,
    `软警告：${(r3.match(/⚠️ 枢纽警告[^\n]*/) ?? ['(未找到)'])[0].slice(0, 80)}`,
    `无 hub 闸门痕迹：${!r3.includes('hub-tag-scoped') && !r3.includes('【hub 闸门·观察】') ? '✅' : '❌'}`,
  ])

  /* ── H-4 autonomous 信号全链路：真实 pre-step 落 lastInjectMode → 写侧读到 → enforce 拒 ── */
  const AUT = 'sess-autonomous-h4'
  const agAut = createAgent(AUT, CWD, [textMsg('user', '自主任务开始'), textMsg('assistant', '收到。')])
  await runPreStep(h, agAut, 2, [textMsg('user', '接着干')], 1) // 回合首发 → interactive
  const stAut = peekSession(AUT)
  const interactiveSeen = stAut?.lastInjectMode === 'interactive'
  await runPreStep(h, agAut, 2, [], 3) // 同回合步 3、无新用户输入 → autonomous
  const autonomousSeen = stAut?.lastInjectMode === 'autonomous'
  const before4 = fileCount()
  const r4 = String(await exec(writeTool, {
    content: `# 自主态写枢纽：应拒\n\noneshot 长回合无新用户输入的写入。\n\nTag: ${HUB}, 词汇G, 词汇H`,
  }, interExec(AUT))) // depth=0、闩锁 false——只靠 injectMode=autonomous 命中
  const t4 =
    interactiveSeen && autonomousSeen &&
    r4.includes('❌ memo_write 被拒绝：hub-tag-scoped') && fileCount() === before4 &&
    r4.includes('injectMode=autonomous')
  check('H-4', 'autonomous 信号全链路：pre-step 落 lastInjectMode → 写侧 enforce 拒（shape=injectMode=autonomous）', t4, [
    `pre-step step=1（新输入）→ ${interactiveSeen ? "interactive ✅" : `❌ ${stAut?.lastInjectMode}`}`,
    `pre-step step=3（无新输入）→ ${autonomousSeen ? 'autonomous ✅' : `❌ ${stAut?.lastInjectMode}`}`,
    `写入：${r4.includes('hub-tag-scoped') ? '✅ 被拒（库不增）' : `❌ ${r3.slice(0, 60)}`}`,
  ])

  /* ── H-5 preset 级开关：memo_tuning 落盘 + 即时生效（0=off 场景内回软警告） ── */
  const tuningFile = join(TMP, 'tuning.json')
  const setOut0 = String(await exec(tuningTool, { action: 'set', scope: 'preset', hubGateMode: 0 }, interExec('sess-tune')))
  const file0 = JSON.parse(readFileSync(tuningFile, 'utf8'))
  const offActive = config.write.hubGateMode === 0
  const before5 = fileCount()
  const r5 = String(await exec(writeTool, {
    content: `# off 档委托写：回软警告\n\n档位归零后场景内也只软警告。\n\nTag: ${HUB}, 词汇I, 词汇J`,
  }, delExec('sess-child-5')))
  const t5 =
    setOut0.includes('hubGateMode') && file0.hubGateMode === 0 && offActive &&
    r5.includes('✅ 已写入') && fileCount() === before5 + 1 && r5.includes('枢纽警告') && !r5.includes('【hub 闸门·观察】')
  const getOut5 = String(await exec(tuningTool, { action: 'get' }, interExec('sess-tune')))
  check('H-5', 'preset 级开关可控：memo_tuning set 落盘 tuning.json + 即时生效（0=off 场景内回软警告）', t5 && getOut5.includes('hubGateMode'), [
    `set 回执：${setOut0.replace(/\n/g, ' ').slice(0, 90)}`,
    `tuning.json：${JSON.stringify(file0)}；config.write.hubGateMode=${config.write.hubGateMode}`,
    `off 档委托写：${r5.includes('✅ 已写入') && !r5.includes('【hub 闸门·观察】') ? '✅ 放行且无观察段（软警告仍在）' : '❌'}`,
    `action=get 可见：${getOut5.includes('hubGateMode') ? '✅' : '❌'}`,
  ])

  /* 恢复 enforce 供后续用例 */
  config.write.hubGateMode = 2

  /* ── H-6 memo_update：目标已有枢纽 Tag 豁免；给无枢纽篇新挂 → 拒 ── */
  const hubFile = ws.store.files(BUCKET).find((f) => ws.store.fileTags(f.id).some((t) => t.name === HUB && f.path.includes('种子一')))
     ?? ws.store.files(BUCKET).find((f) => ws.store.fileTags(f.id).some((t) => t.name === HUB))
  const plainFile = ws.store.files(BUCKET).find((f) => !ws.store.fileTags(f.id).some((t) => t.name === HUB) && f.path.includes('种子四'))
  const r6a = String(await exec(updateTool, {
    id: hubFile.id,
    content: `改写自家旧文：Tag 仍带 ${HUB}，跨篇数不 +1，应豁免放行。\n\nTag: ${HUB}, 词汇A, 词汇B`,
  }, delExec('sess-child-6a')))
  const r6b = String(await exec(updateTool, {
    id: plainFile.id,
    content: `改写给别的篇新挂 ${HUB}：跨篇数 +1，enforce 应拒。\n\nTag: ${HUB}, 词汇F, 词汇G`,
  }, delExec('sess-child-6b')))
  const t6 = r6a.includes('✅ 已写入') && r6b.includes('❌ memo_update 被拒绝：hub-tag-scoped')
  check('H-6', 'memo_update 场景内：目标已有枢纽 Tag 豁免放行；新挂枢纽 Tag → 拒', t6, [
    `改写枢纽篇（自身已有）：${r6a.includes('✅ 已写入') ? '✅ 放行' : `❌ ${(r6a.match(/被拒绝：[^\n]*/) ?? ['?'])[0]}`}`,
    `改写无枢纽篇新挂：${r6b.includes('hub-tag-scoped') ? '✅ 被拒' : `❌ ${r6b.split('\n')[0]?.slice(0, 60)}`}`,
  ])

  /* ── H-7（票02 corpus-governance-0926 重写）：批准入口**不再能把枢纽 Tag 写进库** ──
   * 票02 把批准路径的 Tag 来源从「草稿的建议 Tag（= 被动召回命中的转写）」换成
   * **内容 kNN + 剔枢纽**（`src/drafts.ts` curateTags），于是 hub 闸门在这个入口
   * 结构性不可触发：要么内容命中 <TAG_MIN 被跳过（本套件嵌入未配置 ⇒ 即此，
   * 票02 明写「不回落召回词」），要么入库的 Tag 里**不可能**有枢纽词。
   * 判据相应改为断言这条更强的性质：收据不带 hub-tag-scoped、库内零新增枢纽篇、
   * 草稿不被误吞。原判据（枢纽建议 Tag → enforce 拒）在票02 后无法构造。 */
  mkdirSync(ws.paths.pendingDir, { recursive: true })
  const draftPath = join(ws.paths.pendingDir, '2026-09-16-机械批准样本-t12.md')
  writeFileSync(draftPath, [
    '# 候选草稿（等确认，未入库）', '',
    `- 会话：sess-child-approve`, `- 回合：12 @ 2026-09-16T22:25:00.000Z`, `- 桶：${BUCKET}`, '',
    '## 本轮用户', '把这一批都批了', '',
    '## 本轮助手', '一键批准进行中。', '',
    '## 建议 Tag（来自本轮被动召回的 matchedTags，须经 memo_tags 复核后复用）',
    `${HUB}, 词汇B, 词汇C`, '',
    '## 相关旧日记', '(无)', '',
    '> 本文件是**草稿**：确认后用 memo_write 显式入库（会走 Tag 校验与枢纽闸门）。',
  ].join('\n'), 'utf8')
  const before7 = fileCount()
  const hubFilesBefore7 = ws.store.files(BUCKET).filter((f) => ws.store.fileTags(f.id).some((t) => t.name === HUB)).length
  const r7 = String(await exec(approveTool, { ids: ['机械批准样本'] }, delExec('sess-child-approve')))
  const skipLine7 = r7.split('\n').find((l) => l.includes('⏭') || l.includes('❌')) ?? ''
  const hubFilesAfter7 = ws.store.files(BUCKET).filter((f) => ws.store.fileTags(f.id).some((t) => t.name === HUB)).length
  const t7 =
    !r7.includes('hub-tag-scoped') && fileCount() === before7 && hubFilesAfter7 === hubFilesBefore7 &&
    existsSync(draftPath) && skipLine7.includes('内容 Tag 命中')
  check('H-7', '票02 后：批准入口不再能把枢纽 Tag 写进库（内容判定剔枢纽 ⇒ 库内零新增枢纽篇）', t7, [
    `批凖回执：${skipLine7.slice(0, 130)}`,
    `hub 闸门未触发（hub-tag-scoped 缺席）：${!r7.includes('hub-tag-scoped') ? '✅' : '❌'}`,
    `库内篇数不变：${fileCount() === before7 ? '✅' : `❌ ${before7}→${fileCount()}`}；带「${HUB}」的篇 ${hubFilesBefore7}→${hubFilesAfter7}（应不变）；草稿留 pending：${existsSync(draftPath) ? '✅' : '❌'}`,
  ])

  /* ── H-8 memo_merge 豁免：委托 enforce 档合并两篇枢纽日记 → 放行 ── */
  const twoHub = ws.store.files(BUCKET).filter((f) => ws.store.fileTags(f.id).some((t) => t.name === HUB)).slice(0, 2)
  const r8 = String(await exec(mergeTool, {
    sources: twoHub.map((f) => f.id),
    content: `# 合并去枢纽\n\n两篇枢纽日记并一篇（${HUB} 跨篇数 -1），闸门豁免放行。\n\nTag: ${HUB}, 词汇B, 词汇C`,
  }, delExec('sess-child-8')))
  const t8 = r8.includes('✅ 已写入') && !r8.includes('hub-tag-scoped') && r8.includes('归档')
  check('H-8', 'memo_merge 豁免：合并是去枢纽手术工具（净文件数只减不增），场景内也放行', t8, [
    `合并回执：${(r8.match(/✅ 已写入[^\n]*/) ?? ['(未找到)'])[0]}`,
    `未被 hub 闸门拦：${!r8.includes('hub-tag-scoped') ? '✅' : '❌'}；归档行：${r8.includes('【归档】') ? '✅' : '❌'}`,
  ])
} finally {
  ws.store.close?.()
  rmSync(TMP, { recursive: true, force: true })
}

hr('结果')
const failed = results.filter((r) => !r.pass)
line(`${results.length - failed.length}/${results.length} PASS${failed.length ? `；FAIL：${failed.map((f) => f.id).join(', ')}` : ''}`)
process.exit(failed.length ? 1 : 0)
