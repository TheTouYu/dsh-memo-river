#!/usr/bin/env node
/**
 * acceptance-inject-dedup.mjs — 条目级注入去重（2026-10-15）。
 *
 * 治什么：`src/injector.ts` 的集合级去重（`selectionKey`）只在**入选集合完全不变**时
 * 跳过整块；集合一变（{A,B,C}→{A,B,D}）它就失效，A、B 被白付一遍——HANDOFF 实测的
 * 「同 3 条记忆一场会话被注 9 次」正是这个形状（每条重复都是**零收益、全价成本**）。
 *
 * **设计口径（首版走过弯路，改过一版，别退回去）**：
 *   · 顺序 = 集合级判据 → 条目级过滤 → 渲染。集合级先说话，`identical-selection`
 *     这条既有可观测语义才不会被条目级吞掉（首版把过滤放在召回里 → 主套件 #12 红）。
 *   · **只剔不补**：空出的席位**不**用后位候选回填。回填会把「跳过」变成「每轮注入更弱的
 *     新条目」，总注入量不降反升，且改写步维刷新语义（首版回填 → 主套件 #17 红）。
 *   · 强刷（压缩后 / 隔 N 回合）越过两条去重——强刷是显式意图，也是对「在场判据可能漏判」的兜底。
 *
 * 编号承接 acceptance-selection-weights.mjs（#55-60），本套件 #61-68。
 *
 * 自建自净：`import './isolated-env.mjs'` 把 DSH_HOME 挪进隔离柜，工作目录建在 tmp；
 * 嵌入用 `embed-stub.hashVector` **按 ws.resolved.dimension 裁剪后 patch 进 embed**
 * （不走 HTTP 桩——那个固定 3072 维，与本机 1024 维不符会让 memo_write 静默不落库）。
 * 用法：`node scripts/acceptance-inject-dedup.mjs`
 */
import './isolated-env.mjs' // DSH_HOME 隔离：自建自净，不碰生产桶
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, Config as ConfigSchema } from '../lib/index.js'
import { acquireWorkspace } from '../lib/workspace.js'
import { workspacePaths } from '../lib/runtime.js'
import { candidateKey } from '../lib/recall.js'
import { filterLiveDuplicates, isRecallInfrastructureFailure, liveInjectedKeys } from '../lib/injector.js'
import { renderInjection } from '../lib/render.js'
import { hashVector } from './embed-stub.mjs'

const results = []
const line = (s = '') => console.log(s)
function check(id, title, pass, evidence) {
  results.push({ id, title, pass })
  line(`\n【注入去重-验收 #${id}】${title}  →  ${pass ? '✅ PASS' : '❌ FAIL'}`)
  for (const e of [].concat(evidence)) line(`    ${e}`)
}

const VCP = '/home/h/app/VCPToolBox'
const bucket = '注入去重'

/** 注入块里的入选 D 编号（`[未注入明细] D9(...)` 在 `[本次未注入` 之后，按块结构切掉——
 *  那一行是**未注入声明**，不是重注；不切会把归因当命中，制造假红）。纯函数腿都要用，故定义在最前。 */
const injectedIds = (blockText) =>
  blockText
    .split('[本次未注入')[0]
    .split('\n')
    .map((l) => l.match(/^D(\d+)/))
    .filter(Boolean)
    .map((m) => Number(m[1]))

/* ── 合成候选行（直驱纯函数：分数 / Tag / 时间全可控）── */
const row = (i, srcBucket) => ({
  id: i,
  fileId: i * 100,
  writtenAt: Date.now(),
  title: `D${i} 样本${i}`,
  diaryName: '注入去重测试',
  knnScore: 0.8,
  score: 0.8,
  rawScore: 0.8,
  role: 'thematic_neighbor',
  anchorBonus: 0,
  topologyBonus: 0,
  omega: null,
  riverRegime: null,
  matchedTags: [`轴${i}`],
  rewardSuppressed: false,
  body: `样本${i}正文。`,
  ...(srcBucket ? { srcBucket } : {}),
})

/* ═══ #61 纯函数：candidateKey 跨桶命名空间 ═══ */
{
  const kHome = candidateKey({ id: 5 }, 'A')
  const kParent = candidateKey({ id: 5, srcBucket: 'B' }, 'A')
  const kLegacy = candidateKey({ id: 5 })
  check(
    61,
    'candidateKey：本桶 / 父桶 / 旧无前缀三种形态互不相等（跨桶 id 不互斥）',
    kHome === 'A:5' && kParent === 'B:5' && kLegacy === '5' && kHome !== kParent,
    [
      `本桶 candidateKey({id:5},'A') = ${kHome}`,
      `父桶 candidateKey({id:5,srcBucket:'B'},'A') = ${kParent}（父桶条目在合并时才盖章，故必须以主桶名作基准）`,
      `旧形态 candidateKey({id:5}) = ${kLegacy}（仅兼容旧调用点）`,
    ],
  )
}

/* ═══ #62 纯函数：只剔不补 + 归因 + 保序 ═══ */
{
  const sel = [row(1), row(2), row(3), row(4)]
  const live = new Set(['A:2', 'A:4'])
  const out = filterLiveDuplicates(sel, live, 'A')
  const keptIds = out.kept.map((c) => c.id)
  const dupIds = out.duplicated.map((d) => d.id)
  const keepOrder = JSON.stringify(keptIds) === JSON.stringify([1, 3])
  check(
    62,
    'filterLiveDuplicates：命中项剔除、其余**保序**、被剔项带 already-in-context 归因，且**不回填**（结果 ⊆ 输入）',
    keepOrder &&
      JSON.stringify(dupIds) === JSON.stringify([2, 4]) &&
      out.duplicated.every((d) => d.reason === 'already-in-context') &&
      out.kept.length + out.duplicated.length === sel.length,
    [
      `输入 [${sel.map((c) => c.id)}] − 在场 ${[...live]} → kept=[${keptIds}]（保序 ✅）、duplicated=[${dupIds}]`,
      `kept+duplicated = ${out.kept.length}+${out.duplicated.length} = ${sel.length}（**只剔不补**：没有引入任何输入之外的条目 ✅）`,
      `归因一律 already-in-context=${out.duplicated.every((d) => d.reason === 'already-in-context')}（渲染时会出现在「未注入明细」行，不静默）`,
    ],
  )
}

/* ═══ #63 纯函数：无在场键 = 逐位不变（负对照） ═══ */
{
  const sel = [row(1), row(2), row(3)]
  const a = filterLiveDuplicates(sel, new Set(), 'A')
  const b = filterLiveDuplicates(sel, new Set(['B:9']), 'A')
  const same = (o) => JSON.stringify(o.kept.map((c) => c.id))
  check(
    63,
    '无命中 = 逐位不变（负对照：本刀不改变任何既有选择）',
    same(a) === same(b) && same(a) === JSON.stringify([1, 2, 3]) && a.duplicated.length === 0,
    [`空集 → [${a.kept.map((c) => c.id)}]；只含他桶键 → [${b.kept.map((c) => c.id)}]（本桶条目不受影响 ✅）`],
  )
}

/* ═══ #64 纯函数：近因保底的相互作用在**注入侧**兜底 ═══
   `recall()` ⑥ 的近因保底不了解「在场」概念，可能把一条仍在上下文里的最新日记拽回 selected。
   首版试图在 `recall()` 里给保底加守卫；改版后不需要——过滤发生在渲染前，保底拉回的条目
   照样在注入侧被剔掉。这条腿钉住这个兜底关系（删掉过滤就会红）。 */
{
  const floored = [row(1), row(2), row(7)] // 7 是保底拉回的「已在场」条目
  const out = filterLiveDuplicates(floored, new Set(['A:7']), 'A')
  const p1 = out.kept.map((c) => c.id)
  const rendered = renderInjection(
    { injected: true, selected: out.kept, dropped: [...out.duplicated], candidateCount: 3, mode: 'topology_v3', omega: 0.5, regime: 'dense', dynamicK: 1, candidates: [] },
    bucket,
  )
  const renderIds = injectedIds(String(rendered))
  check(
    64,
    '近因保底拉回的「已在场」条目被注入侧兜底剔除（故 recall() 里不需要加守卫）',
    JSON.stringify(p1) === JSON.stringify([1, 2]) && !renderIds.includes(7),
    [
      `保底后的入选 [${floored.map((c) => c.id)}] − 在场 A:7 → [${p1}]`,
      `渲染块里的**入选条目** = [${renderIds}]（必须不含 7：保底不得绕过条目级去重把已注过的再注一遍）`,
      `注意 D7 会出现在「未注入明细」行（already-in-context 归因）——那是**未注入**声明，不是重注；` +
        `本腿用 injectedIds() 按块结构切掉该行，避免把归因当命中（首版就踩了这个假红）`,
    ],
  )
}

/* ── 最小 Cordis / Agent 替身（与 acceptance-selection-weights.mjs 同款，只 mock 宿主不 mock 被测逻辑）── */
function createMockCtx() {
  const listeners = new Map()
  const registered = { sections: [], contexts: [], tools: [] }
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
      disposers.push(cb())
      return () => {
        try {
          disposers.forEach((d) => d?.())
        } catch {
          /* 静默 */
        }
      }
    },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    tools: {
      register(t) {
        registered.tools.push(t)
        return () => {}
      },
    },
    get: () => undefined,
    interval: () => () => {},
  }
  return { ctx, listeners, registered, dispose: () => disposers.forEach((d) => { try { d?.() } catch { /* 静默 */ } }) }
}
const textMsg = (role, text) => ({ role, content: [{ type: 'text', text }], source: { kind: role === 'user' ? 'user' : 'model' } })
function createAgent(sessionId, cwd, priorLog = []) {
  const log = [...priorLog]
  return { session: { id: sessionId, header: { cwd }, deriveMessages: () => log }, log }
}
const textOf = (m) => {
  const c = m?.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n')
}
/** 注入块里的入选 D 编号（定义见文件头部——纯函数腿 #64 也要用）。 */

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

const ROOT = join(tmpdir(), `memo-river-idedup-${process.pid}`)
mkdirSync(ROOT, { recursive: true })

/**
 * 集成腿环境：真 workspace + **patch 过的嵌入**（词袋哈希按 `ws.resolved.dimension` 裁剪）。
 * 不用 HTTP 桩的原因见文件头；`configured` 用 getter 覆盖，否则写入路径报「embed 未配置」拒写。
 */
function makeEnv(legName, injectOverrides = {}) {
  const cwd = join(ROOT, legName)
  rmSync(cwd, { recursive: true, force: true })
  mkdirSync(cwd, { recursive: true })
  rmSync(workspacePaths(cwd, bucket).root, { recursive: true, force: true })
  const config = ConfigSchema({ bucket, native: { vcpRoot: VCP }, inject: injectOverrides })
  const h = createMockCtx()
  apply(h.ctx, config)
  const ws = acquireWorkspace(cwd, config)
  const dim = ws.resolved.dimension
  const vec = (text) => {
    const v = hashVector(text)
    const out = new Float32Array(dim)
    for (let i = 0; i < dim; i++) out[i] = v[i % v.length]
    return out
  }
  ws.embed.embed = async (texts) => texts.map(vec)
  Object.defineProperty(ws.embed, 'configured', { get: () => true, configurable: true })
  const writeTool = h.registered.tools.find((t) => (t.name ?? t.definition?.name) === 'memo_write')
  const wExec = writeTool.execute.bind(writeTool)
  /** 写一篇日记；id 从工具输出「✅ 已写入 D<n>」解析（不猜序号）。 */
  const writeDiary = async (n, { title, body, tags }) => {
    const out = String(
      await wExec(
        {
          content: `# ${title}\n\n结论：${body}。\n\nTag: ${tags.join(', ')}`,
          newTagReason: `${title}：三个 Tag（${tags.join('/')}）均为本篇专属主题词，语义不重复`,
        },
        { agent: createAgent(`sess-${legName}-w${n}`, cwd, []) },
      ),
    )
    const m = out.match(/已写入\s*D(\d+)/)
    return { ok: out.includes('已写入'), id: m ? Number(m[1]) : null, text: out }
  }
  return { cwd, config, h, ws, writeDiary, close: () => { ws.close?.(); h.dispose() } }
}

const QUERY = '渲染又卡了，上一批是怎么解决的'
/**
 * 6 篇同域日记：机制词、Tag **全不相同**。
 *
 * 为什么必须不同：写侧有 `synonym-of-existing-tag` 闸（余弦 >0.92 拒写）。首版给 Tag 加序号
 * （`样本1`/`样本2`）→ 桩嵌入下余弦 1.0000 → 第 2 篇起全被拒，本套件表现为「写 3 篇全 0、
 * 池 0、empty-corpus」，看上去像被测代码坏了，其实是夹具不合法。
 */
const RENDER_DIARIES = [
  { mech: '阴影贴图档位过高', body: '第 1 批的渲染卡顿来自阴影贴图档位过高，降到 1024 后帧率恢复', tags: ['阴影贴图', '档位校准', '帧率恢复'] },
  { mech: '顶点数超预算', body: '渲染卡顿来自顶点数超预算导致合批失败，按材质排序后恢复', tags: ['顶点数', '合批策略', '材质排序'] },
  { mech: '后处理采样过多', body: '渲染卡顿来自后处理 bloom 采样过多，关掉后帧率恢复', tags: ['后处理', '管线简化', '采样开销'] },
  { mech: '光照阴影偏移抖动', body: '渲染卡顿来自光照阴影偏移抖动，改用固定偏移后稳定', tags: ['光照阴影', '阴影偏移', '抖动抑制'] },
  { mech: '贴图精度过高', body: '渲染卡顿来自贴图精度过高占用带宽，降到 512 后流畅', tags: ['贴图精度', '带宽占用', '纹理压缩'] },
  { mech: '着色器分支过多', body: '渲染卡顿来自着色器分支过多导致 GPU 空转，合并分支后恢复', tags: ['着色器分支', '指令合并', '空转消除'] },
]

const isRecallBlock = (m) => m?.source?.kind === 'memo-river' && m?.source?.form === 'recall'
const isNotice = (m) => m?.source?.kind === 'memo-river' && m?.source?.form === 'notice'

try {
  /* ═══ #65 集成：全部入选都还在场 → 专属 fallbackReason + 不发「召回未生效」通知 ═══
     3 篇日记 + k=3 → 两轮的入选集合恒为 {1,2,3}。**关掉集合级去重**才能让流程走到条目级
     （否则集合级先命中、轮不到这条新分支）——这正是 §顺序 的语义边界。 */
  {
    const env = makeEnv('all-visible', {
      gate: false, k: 3, adaptiveKRatio: 0, tokenBudget: 1e9,
      queryLookback: 1, dedupeSelection: false, dedupeLiveEntries: true,
    })
    const { h, cwd, writeDiary, close } = env
    let okW = true
    for (const [i, d] of RENDER_DIARIES.slice(0, 3).entries()) {
      const w = await writeDiary(i + 1, { title: `渲染卡顿${i + 1}：${d.mech}`, body: d.body, tags: d.tags })
      okW = w.ok && okW
    }
    const agent = createAgent('sess-allvisible', cwd, [textMsg('user', QUERY)])
    const d1 = await runPreStep(h, agent, 1, [textMsg('user', QUERY)], 1)
    const ids1 = d1.messages.filter(isRecallBlock).map(textOf).flatMap(injectedIds)
    const d2 = await runPreStep(h, agent, 2, [textMsg('user', QUERY)], 1)
    const added2 = d2.messages.filter((m) => !d1.messages.includes(m))
    const ids2 = added2.filter(isRecallBlock).map(textOf).flatMap(injectedIds)
    const notices = added2.filter(isNotice).map(textOf).join('\n')
    const reason = 'all-selected-already-in-context'
    check(
      65,
      '全部入选都还在场：第 2 轮不注入 + fallbackReason=all-selected-already-in-context，且**不发**「召回未生效」通知',
      okW &&
        JSON.stringify(ids1) === JSON.stringify([1, 2, 3]) &&
        ids2.length === 0 &&
        !notices.includes('召回未生效') &&
        isRecallInfrastructureFailure(reason) === false &&
        renderInjection({ injected: true, selected: [], dropped: [], candidateCount: 3, mode: 'topology_v3', omega: 0.5, regime: null, dynamicK: 1, candidates: [] }, bucket) === null,
      [
        `3 篇写入 ✅=${okW}；第 1 轮注入 ids=[${ids1}]`,
        `第 2 轮 memo-river 召回块 = ${ids2.length}（要求 0）`,
        `第 2 轮 notice 文本 = ${JSON.stringify(notices) || '(无)'}（不得含「召回未生效」✅）`,
        `isRecallInfrastructureFailure('${reason}')=${isRecallInfrastructureFailure(reason)}（false ⇒ 去重成功不被当成降级、不污染连续失败计数）`,
      ],
    )
    close()
  }

  /* ═══ #66 / #67：真 pre-step 多轮（主判据 + 负对照）═══
     不变量 = **同一 D 编号绝不跨轮重复出现**（块从不被压缩，故它始终在场）。
     开：每轮只注「还没注过的」；关：曝光抑制让选集轮换 → 必然出现跨轮重复。 */
  const runRounds = async (label, dedupeLiveEntries, rounds = 4) => {
    const env = makeEnv(`rounds-${label}`, {
      gate: false, k: 3, adaptiveKRatio: 0, tokenBudget: 1e9, queryLookback: 1,
      dedupeSelection: true, dedupeRefreshTurns: 8, dedupeLiveEntries,
    })
    const { h, cwd, writeDiary, close } = env
    let okW = true
    for (const [i, d] of RENDER_DIARIES.entries()) {
      const w = await writeDiary(i + 1, { title: `多轮样本${i + 1}：${d.mech}`, body: d.body, tags: d.tags })
      okW = w.ok && okW
    }
    const agent = createAgent(`sess-rounds-${label}`, cwd, [textMsg('user', QUERY)])
    const perRound = []
    for (let t = 1; t <= rounds; t++) {
      const d = await runPreStep(h, agent, t, [textMsg('user', QUERY)], 1)
      const seen = new Set()
      for (const m of agent.log) if (isRecallBlock(m)) seen.add(textOf(m))
      perRound.push(d.messages.filter(isRecallBlock).map(textOf).flatMap(injectedIds))
    }
    const all = perRound.flat()
    const dupes = all.filter((id, i) => all.indexOf(id) !== i)
    close()
    return { okW, perRound, all, dupes, injectedRounds: perRound.filter((r) => r.length > 0).length }
  }

  const on = await runRounds('on', true)
  check(
    66,
    '真 pre-step 4 轮（dedupeLiveEntries=true）：同一 D 编号**绝不跨轮重复注入**',
    on.okW &&
      JSON.stringify(on.perRound[0]) === JSON.stringify([4, 5, 6]) &&
      on.all.length >= 3 &&
      on.dupes.length === 0,
    [
      `6 篇写入 ✅=${on.okW}`,
      `逐轮注入：${on.perRound.map((r, i) => `第${i + 1}轮=[${r}]`).join('　')}`,
      `注入过的条目合计 ${on.all.length} 条、跨轮重复 ${on.dupes.length} 条（必须 0）；有注入的轮数 ${on.injectedRounds}/${on.perRound.length}`,
      `判据依据：块从不被压缩 ⇒ 前一轮注过的条目始终在场 ⇒ 再次出现即为白付一遍`,
    ],
  )

  const off = await runRounds('off', false)
  check(
    67,
    '负对照（dedupeLiveEntries=false）：多轮之间**必然出现**重复注入 ⇒ #66 归因成立',
    off.okW && off.all.length >= 3 && off.dupes.length > 0,
    [
      `逐轮注入：${off.perRound.map((r, i) => `第${i+1}轮=[${r}]`).join('　')}`,
      `跨轮重复 ${off.dupes.length} 条：${JSON.stringify(off.dupes)} —— 就是本刀要治的浪费（已在上下文里还再付一遍）`,
      `对比 #66（开关打开）：重复 0 条、注入过的条目合计 ${on.all.length} 条 —— 两腿唯一差异是开关本身 ✅`,
      `注：集合级去重两腿都开着；关掉条目级后它只挡「集合完全不变」那种情形，曝光抑制导致的选集轮换挡不住`,
    ],
  )

  /* ═══ #68 接线断言（源码级：顺序 / 输入 / 只剔不补）═══ */
  {
    const src = readFileSync(new URL('../src/injector.ts', import.meta.url), 'utf8')
    const recallSrc = readFileSync(new URL('../src/recall.ts', import.meta.url), 'utf8')
    const gated = /inject\.dedupeLiveEntries\s*&&\s*!refreshDue/.test(src)
    const rawInput = /liveInjectedKeys\(\[\.\.\.rawHistory,/.test(src)
    const historyInput = /liveInjectedKeys\(\[\.\.\.history,/.test(src)
    const usesFilter = /filterLiveDuplicates\(outcome\.selected/.test(src)
    // 顺序：过滤必须在渲染之前（否则过滤不到已渲染的文本）
    const iFilter = src.indexOf('filterLiveDuplicates(outcome.selected')
    const iRender = src.indexOf('renderInjection(effective')
    const ordered = iFilter > 0 && iRender > iFilter
    // 只剔不补：召回层不得再出现 excludeKeys 那套「腾出席位给后位候选」的路径
    const noBackfill = !/excludeKeys/.test(recallSrc)
    const wired = gated && rawInput && !historyInput && usesFilter && ordered && noBackfill
    check(
      68,
      '接线断言：开关门 + 输入 rawHistory + 过滤先于渲染 + **召回层无回填路径**',
      wired,
      [
        `开关门命中=${gated}｜rawHistory 命中=${rawInput}｜误用 history 命中=${historyInput}（末项必须 false）`,
        `filterLiveDuplicates 用于 selected=${usesFilter}；调用点(${iFilter}) 早于 renderInjection(${iRender})=${ordered}`,
        `recall.ts 含 excludeKeys（回填路径）=${!noBackfill}（必须 false——「只剔不补」是本刀的设计决定，要改必须显式改本腿）`,
        `为什么必须 rawHistory：isDialogMessage（src/injector.ts:164）把 kind==='memo-river' 的注入块整个排掉，` +
          `用 history 当输入会让本功能永远返回空集、**静默失效**（无日志、无告警）`,
      ],
    )
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}

const passed = results.filter((r) => r.pass).length
line('\n' + '═'.repeat(88))
line(`注入去重验收：${passed}/${results.length} ${passed === results.length ? '✅ 全绿' : '❌ 有红'}`)
for (const r of results) if (!r.pass) line(`  ❌ #${r.id} ${r.title}`)
line('═'.repeat(88))
if (passed !== results.length) process.exitCode = 1
