#!/usr/bin/env node
/**
 * acceptance-supersede.mjs — G3 语料有效性（2026-10-15）。
 *
 * 治什么：库里存的是**事件史**，模型要的是**当前状态**。一条过期结论被当事实注入，
 * 比不注入更糟——模型会基于一个已经不成立的世界做诊断（本桶现成病例：D208/D214 讲
 * 「3s 嵌入硬顶 → 45.3% 静默跳过」，而超时预算早已 8s、端点也已换过）。
 *
 * 与既有机制的分工（别混）：
 *   · `memo_update` = 原地重写，旧内容消失 → 不存在过期条目；
 *   · `memo_merge`  = 并入后归档退役（行级删除）→ 不存在过期条目；
 *   · **本机制**处理第三种：新篇推翻了旧篇的结论，**两篇都留着**。
 *
 * 口径（2026-10-15 用户拍板）：
 *   · 被动注入 → **不注入**，并在「未注入明细」行归因 `superseded-by-D<继任>`（不静默）；
 *   · 主动 memo_recall → **照常返回**，逐条标注「⚠️已被 D<n> 取代」；
 *   · 标记通道 = `memo_write(supersedes)` + 独立工具 `memo_supersede`；patrol 自动检出**不做**。
 *
 * 编号自成体系（S-1..S-8）。自建自净：isolated-env 隔离 DSH_HOME，工作目录建在 tmp；
 * 嵌入走 `embed-stub.hashVector` **按 ws.resolved.dimension 裁剪后 patch 进 embed**
 * （不走 HTTP 桩——它固定 3072 维而本机是 1024，会让 memo_write 静默不落库）。
 * 用法：`node scripts/acceptance-supersede.mjs`
 */
import './isolated-env.mjs'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, Config as ConfigSchema } from '../lib/index.js'
import { acquireWorkspace } from '../lib/workspace.js'
import { workspacePaths } from '../lib/runtime.js'
import { filterSuperseded } from '../lib/injector.js'
import { hashVector } from './embed-stub.mjs'

const results = []
const line = (s = '') => console.log(s)
function check(id, title, pass, evidence) {
  results.push({ id, title, pass })
  line(`\n【G3-验收 ${id}】${title}  →  ${pass ? '✅ PASS' : '❌ FAIL'}`)
  for (const e of [].concat(evidence)) line(`    ${e}`)
}

const VCP = '/home/h/app/VCPToolBox'
const bucket = '取代测试'

/* ── 最小 Cordis / Agent 替身（与 acceptance-inject-dedup.mjs 同款）── */
function createMockCtx() {
  const listeners = new Map()
  const registered = { tools: [] }
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
/** 注入块里的入选 D 编号（`[未注入明细]` 那段是**未注入声明**，按块结构切掉——防把归因当命中）。 */
const injectedIds = (blockText) =>
  blockText
    .split('[本次未注入')[0]
    .split('\n')
    .map((l) => l.match(/^D(\d+)/))
    .filter(Boolean)
    .map((m) => Number(m[1]))
const isRecallBlock = (m) => m?.source?.kind === 'memo-river' && m?.source?.form === 'recall'

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

const ROOT = join(tmpdir(), `memo-river-supersede-${process.pid}`)
mkdirSync(ROOT, { recursive: true })

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
  const tool = (name) => h.registered.tools.find((t) => (t.name ?? t.definition?.name) === name)
  const writeDiary = async (n, { title, body, tags, supersedes }) => {
    const args = {
      content: `# ${title}\n\n结论：${body}。\n\nTag: ${tags.join(', ')}`,
      newTagReason: `${title}：三个 Tag（${tags.join('/')}）均为本篇专属主题词，语义不重复`,
    }
    if (supersedes) args.supersedes = supersedes
    const out = String(await tool('memo_write').execute(args, { agent: createAgent(`sess-${legName}-w${n}`, cwd, []) }))
    const m = out.match(/已写入\s*D(\d+)/)
    return { ok: out.includes('已写入'), id: m ? Number(m[1]) : null, text: out }
  }
  return { cwd, config, h, ws, tool, writeDiary, close: () => { ws.close?.(); h.dispose() } }
}
/** 三篇同域但 Tag/机制词全不同（避免写侧 synonym-of-existing-tag 余弦闸误拒）。 */
const DIARIES = [
  { title: '阴影贴图档位过高', body: '第 1 批的渲染卡顿来自阴影贴图档位过高，降到 1024 后帧率恢复', tags: ['阴影贴图', '档位校准', '帧率恢复'] },
  { title: '顶点数超预算', body: '渲染卡顿来自顶点数超预算导致合批失败，按材质排序后恢复', tags: ['顶点数', '合批策略', '材质排序'] },
  { title: '后处理采样过多', body: '渲染卡顿来自后处理 bloom 采样过多，关掉后帧率恢复', tags: ['后处理', '管线简化', '采样开销'] },
]
const QUERY = '渲染又卡了，上一批是怎么解决的'

try {
  /* ═══ S-1 存储层：UPSERT / 废止 / 悬挂过滤 / 清理 ═══ */
  {
    const env = makeEnv('store')
    const { ws, close, writeDiary } = env
    const w = []
    for (const [i, d] of DIARIES.entries()) w.push(await writeDiary(i + 1, d))
    const okW = w.every((x) => x.ok)
    const r = await ws.withDb(async () => {
      const ids = ws.store.files().map((f) => f.id)
      ws.store.markSuperseded({ oldFileId: ids[0], newFileId: ids[1], reason: '甲', markedBy: 'test' })
      ws.store.markSuperseded({ oldFileId: ids[0], newFileId: ids[1], reason: '甲改', markedBy: 'test' }) // UPSERT 幂等
      ws.store.markSuperseded({ oldFileId: ids[2], newFileId: null, reason: '废止', markedBy: 'test' })
      const m1 = ws.store.supersessions()
      /* ① 继任篇消失（如被 memo_merge 归档）：标记**必须保留**——旧篇的结论仍然是被取代的，
       *    清掉它等于让过期结论重新可注入（方向反了）。代价只是展示降级为 superseded-by-D?。 */
      ws.store.run('DELETE FROM files WHERE id = ?', ids[1])
      const mAfterSuccessorGone = ws.store.supersessions()
      const prunedSuccessorGone = ws.store.pruneSupersessions()
      const mKeep = ws.store.supersessions()
      /* ② 源篇消失：标记失去主体，读取时 JOIN 过滤 + prune 清掉。 */
      ws.store.run('DELETE FROM files WHERE id = ?', ids[2])
      const m2 = ws.store.supersessions()
      const pruned = ws.store.pruneSupersessions()
      const m3 = ws.store.supersessions()
      const cleared = ws.store.clearSupersession(ids[0])
      const clearedAgain = ws.store.clearSupersession(ids[0])
      return { ids, m1, mAfterSuccessorGone, prunedSuccessorGone, mKeep, m2, pruned, m3, cleared, clearedAgain }
    })
    const e0 = r.m1.get(r.ids[0])
    check(
      'S-1',
      '存储层：UPSERT 幂等 / new=null 表废止 / **继任篇消失不清标**（清=让过期结论复活）/ 源篇消失才清 / clear 以行数回报',
      okW &&
        r.m1.size === 2 &&
        e0?.reason === '甲改' &&
        e0?.newFileId === r.ids[1] &&
        r.m1.get(r.ids[2])?.newFileId === null &&
        r.mAfterSuccessorGone.size === 2 &&
        r.prunedSuccessorGone === 0 &&
        r.mKeep.size === 2 &&
        r.m2.size === 1 &&
        r.pruned === 1 &&
        /* prune 只清「源篇没了」那条；ids[0] 那条的**继任篇**早先被删，按设计**保留** → 仍剩 1 条。 */
        r.m3.size === 1 &&
        r.cleared === 1 &&
        r.clearedAgain === 0,
      [
        `写入 3 篇 ✅=${okW}`,
        `标记后 size=${r.m1.size}（一条取代 + 一条废止）；同一 old 二次标记后 reason=「${e0?.reason}」（UPSERT 幂等 ✅）`,
        `继任篇被删后 size=${r.mAfterSuccessorGone.size}、prune 清理 ${r.prunedSuccessorGone} 条 → 仍 ${r.mKeep.size} 条（**标记保留**：旧篇结论仍是被取代的 ✅）`,
        `源篇被删后 supersessions() size=${r.m2.size}（JOIN files 过滤悬挂 ✅）；prune 清理 ${r.pruned} 条 → 剩 ${r.m3.size}`,
        `clearSupersession 首次=${r.cleared}、再次=${r.clearedAgain}（幂等、以行数回报 ✅）`,
      ],
    )
    close()
  }

  /* ═══ S-2 召回层盖标：supersededBy(fileId) + supersededByD(展示口径) ═══ */
  {
    const env = makeEnv('stamp', { gate: false, k: 3, adaptiveKRatio: 0, tokenBudget: 1e9 })
    const { ws, close, writeDiary } = env
    const w = []
    for (const [i, d] of DIARIES.entries()) w.push(await writeDiary(i + 1, d))
    const okW = w.every((x) => x.ok)
    const marked = await ws.withDb(async () => {
      const ids = ws.store.files().map((f) => f.id)
      ws.store.markSuperseded({ oldFileId: ids[0], newFileId: ids[1], reason: '被顶点篇取代', markedBy: 'test' })
      return ids
    })
    const out = await ws.recall(QUERY, {
      mode: 'topology_v3', k: 3, tokenBudget: 1e9, dynamicK: 1, gate: false,
      gateThreshold: 0.55, minKnnForReward: 0.6, queryId: 'stamp-1',
    })
    const old = out.candidates.find((c) => c.fileId === marked[0])
    const successor = out.candidates.find((c) => c.fileId === marked[1])
    const third = out.candidates.find((c) => c.fileId === marked[2])
    check(
      'S-2',
      '召回层盖标：被取代条目带 supersededBy(fileId)+supersededByD(展示 D 编号)；未标记条目不受影响（负对照）',
      okW &&
        out.candidates.length === 3 &&
        old?.supersededBy === marked[1] &&
        typeof old?.supersededByD === 'number' &&
        successor?.supersededBy === undefined &&
        third?.supersededBy === undefined,
      [
        `3 篇写入 ✅=${okW}；候选 ${out.candidates.length} 条`,
        `被取代篇（fileId=${marked[0]}）：supersededBy=${old?.supersededBy}（=继任 fileId ✅）supersededByD=D${old?.supersededByD}（展示口径=该篇当前 chunk id）`,
        `继任篇 fileId=${marked[1]}：supersededBy=${String(successor?.supersededBy)}（undefined=无标记 ✅）；第三篇同理=${String(third?.supersededBy)}`,
        `两套编号分开的理由：chunk id 会随 memo_update 改写而变，fileId 稳定——混用会让模型去错篇（D108 记过这个双口径）`,
      ],
    )
    close()
  }

  /* ═══ S-3 被动注入剔除 + 归因（真 pre-step）═══ */
  {
    const env = makeEnv('passive', { gate: false, k: 3, adaptiveKRatio: 0, tokenBudget: 1e9, queryLookback: 1 })
    const { h, cwd, ws, close, writeDiary } = env
    const w = []
    for (const [i, d] of DIARIES.entries()) w.push(await writeDiary(i + 1, d))
    const okW = w.every((x) => x.ok)
    const marked = await ws.withDb(async () => {
      const ids = ws.store.files().map((f) => f.id)
      ws.store.markSuperseded({ oldFileId: ids[0], newFileId: ids[1], reason: '被顶点篇取代', markedBy: 'test' })
      return ids
    })
    const agent = createAgent('sess-passive', cwd, [textMsg('user', QUERY)])
    const d1 = await runPreStep(h, agent, 1, [textMsg('user', QUERY)], 1)
    const block = d1.messages.filter(isRecallBlock).map(textOf).join('\n')
    const ids = injectedIds(block)
    const successorD = (await ws.withDb(async () => {
      const owners = ws.store.chunkOwners()
      for (const [cid, o] of owners) if (o.fileId === marked[1]) return cid
      return null
    }))
    check(
      'S-3',
      '被动注入：被取代条目**不注入**，且在「未注入明细」行以 superseded-by-D<继任> 归因（不静默）',
      okW &&
        ids.length === 2 &&
        !block.includes(`D${marked[0]}「`) &&
        block.includes(`superseded-by-D${successorD}`) &&
        block.includes('[本次未注入'),
      [
        `3 篇写入 ✅=${okW}；被取代篇 fileId=${marked[0]}（继任 fileId=${marked[1]} → D${successorD}）`,
        `注入块入选条目 ids=[${ids}]（应为 2 条，且不含被取代那篇）`,
        `「未注入明细」行归因命中 superseded-by-D${successorD}=${block.includes(`superseded-by-D${successorD}`)}`,
        `块内是否出现被取代篇的条目行「D${marked[0]}「」=${block.includes(`D${marked[0]}「`)}（必须 false）`,
      ],
    )
    close()
  }

  /* ═══ S-4 主动召回照返带标 ═══ */
  {
    const env = makeEnv('active', { gate: false, k: 3, adaptiveKRatio: 0, tokenBudget: 1e9 })
    const { ws, close, writeDiary, tool } = env
    const w = []
    for (const [i, d] of DIARIES.entries()) w.push(await writeDiary(i + 1, d))
    const okW = w.every((x) => x.ok)
    const marked = await ws.withDb(async () => {
      const ids = ws.store.files().map((f) => f.id)
      ws.store.markSuperseded({ oldFileId: ids[0], newFileId: ids[1], reason: '被顶点篇取代', markedBy: 'test' })
      return ids
    })
    const out = String(
      await tool('memo_recall').execute({ query: QUERY, k: 3 }, { agent: createAgent('sess-active', env.cwd, []) }),
    )
    const successorD = await ws.withDb(async () => {
      const owners = ws.store.chunkOwners()
      for (const [cid, o] of owners) if (o.fileId === marked[1]) return cid
      return null
    })
    check(
      'S-4',
      '主动 memo_recall：被取代条目**照常返回**并带「⚠️已被 D<n> 取代」标注（主动查历史要看得到全貌）',
      okW && out.includes(`⚠️已被 D${successorD} 取代`) && out.includes(`D${marked[0]}「`),
      [
        `3 篇写入 ✅=${okW}`,
        `输出含被取代篇条目=${out.includes(`D${marked[0]}「`)}（必须 true——主动查询不剔除）`,
        `输出含标注「⚠️已被 D${successorD} 取代」=${out.includes(`⚠️已被 D${successorD} 取代`)}`,
        `对照 S-3：同一份 outcome，被动剔除、主动照返——剔除责任放在**消费方** ✅`,
      ],
    )
    close()
  }

  /* ═══ S-5 memo_write(supersedes) 写入通道 ═══ */
  {
    const env = makeEnv('writechannel', { gate: false, k: 3, adaptiveKRatio: 0, tokenBudget: 1e9 })
    const { ws, close, writeDiary } = env
    const w1 = await writeDiary(1, DIARIES[0])
    const w2 = await writeDiary(2, { ...DIARIES[1], supersedes: [w1.id] })
    const w3 = await writeDiary(3, { ...DIARIES[2], supersedes: [w1.id, 99999, w1.id] })
    const m = await ws.withDb(async () => ws.store.supersessions())
    /* fileId 用 chunkOwners 反查（**别按标题猜路径**：slug 会把标题字符换掉，首版就是这么假红的）。 */
    const ownerOf = (chunkId) => ws.withDb(async () => ws.store.chunkOwners().get(chunkId)?.fileId ?? null)
    const f1 = await ownerOf(w1.id)
    const f3 = await ownerOf(w3.id)
    const mark = f1 === null ? undefined : m.get(f1)
    check(
      'S-5',
      'memo_write(supersedes)：落库；重复项去重；不存在的 D 编号**逐条报出且不落库**（不静默）',
      w1.ok &&
        w2.ok &&
        w3.ok &&
        w2.text.includes('已声明取代') &&
        w3.text.includes('没有这个 D 编号') &&
        w3.text.includes('已声明取代') &&
        mark?.newFileId === f3 &&
        m.size === 1,
      [
        `三篇写入 ✅=${w1.ok && w2.ok && w3.ok}`,
        `第 2 篇 supersedes:[D${w1.id}] → 报告含「已声明取代」=${w2.text.includes('已声明取代')}`,
        `第 3 篇 supersedes:[D${w1.id}, 99999, D${w1.id}]（重复 + 不存在）→ 报出不存在=${w3.text.includes('没有这个 D 编号')}；仍应用了合法项=${w3.text.includes('已声明取代')}`,
        `最终取代关系：old fileId=${f1} → new fileId=${mark?.newFileId}（应等于第 3 篇的 fileId ${f3}——后声明 UPSERT 覆盖）；总数=${m.size}（同一 old 只留一条 ✅）`,
      ],
    )
    close()
  }

  /* ═══ S-6 memo_supersede 工具（标记 / 废止 / 解除 / 互斥 / 不存在）═══ */
  {
    const env = makeEnv('tool', { gate: false, k: 3, adaptiveKRatio: 0, tokenBudget: 1e9 })
    const { ws, close, writeDiary, tool } = env
    const w = []
    for (const [i, d] of DIARIES.entries()) w.push(await writeDiary(i + 1, d))
    const okW = w.every((x) => x.ok)
    const t = tool('memo_supersede')
    const ctx = { agent: createAgent('sess-tool', env.cwd, []) }
    const rMark = String(await t.execute({ old: w[0].id, replacement: w[1].id, reason: '结论被推翻' }, ctx))
    const rBoth = String(await t.execute({ old: w[0].id, replacement: w[1].id, void: true }, ctx))
    const rVoid = String(await t.execute({ old: w[2].id, void: true, reason: '无继任篇地撤回' }, ctx))
    const afterVoid = await ws.withDb(async () => ws.store.supersessions())
    const rMissing = String(await t.execute({ old: 99999, void: true }, ctx))
    const rSelf = String(await t.execute({ old: w[1].id, replacement: w[1].id }, ctx))
    const rClear = String(await t.execute({ old: w[0].id, clear: true }, ctx))
    const afterClear = await ws.withDb(async () => ws.store.supersessions())
    const rClearAgain = String(await t.execute({ old: w[0].id, clear: true }, ctx))
    const rNoArgs = String(await t.execute({ old: w[0].id }, ctx))
    const tag = 'S-6'
    check(
      tag,
      'memo_supersede：标记 / 废止(new=null) / 解除 / replacement 与 void 互斥 / 目标不存在 / 自指 —— 全部显式回报，不静默',
      okW &&
        rMark.includes('已标记') &&
        rMark.includes('clear:true') &&
        rBoth.includes('互斥') &&
        rVoid.includes('已废止') &&
        rMissing.includes('没有 D99999') &&
        rSelf.includes('不能取代它自己') &&
        rClear.includes('已解除') &&
        rClearAgain.includes('本来就没有') &&
        rNoArgs.includes('三者之一'),
      [
        `三篇写入 ✅=${okW}`,
        `标记：${rMark.split('\n')[0]}`,
        `互斥：${rBoth}`,
        `废止：${rVoid.split('\n')[0]}`,
        `不存在：${rMissing}`,
        `自指：${rSelf}`,
        `解除：${rClear}｜再次解除：${rClearAgain}｜缺参数：${rNoArgs}`,
        `解除后取代关系总数=${afterClear.size}（原 2 条 → 解除 1 条 ✅，但废止那条仍在；afterVoid 快照 size=${afterVoid.size}）`,
      ],
    )
    close()
  }

  /* ═══ S-7 纯函数：filterSuperseded 只剔不补 + 归因形状 ═══ */
  {
    const mk = (id, supersededBy, supersededByD) => ({
      id,
      fileId: id * 10,
      writtenAt: Date.now(),
      title: `D${id} 样本`,
      diaryName: '取代测试',
      knnScore: 0.8,
      score: 0.8,
      rawScore: 0.8,
      role: 'thematic_neighbor',
      anchorBonus: 0,
      topologyBonus: 0,
      omega: null,
      riverRegime: null,
      matchedTags: [`轴${id}`],
      rewardSuppressed: false,
      body: '正文',
      ...(supersededBy === undefined ? {} : { supersededBy }),
      ...(supersededByD === undefined ? {} : { supersededByD }),
    })
    const sel = [mk(1), mk(2, 7, 8), mk(3, null, null), mk(4, undefined, undefined)]
    const out = filterSuperseded(sel)
    const reasons = out.duplicated.map((d) => d.reason)
    check(
      'S-7',
      'filterSuperseded（纯）：只剔不补、保序、废止归 superseded-void、有继任归 superseded-by-D<n>',
      JSON.stringify(out.kept.map((c) => c.id)) === JSON.stringify([1, 4]) &&
        JSON.stringify(reasons) === JSON.stringify(['superseded-by-D8', 'superseded-void']) &&
        out.kept.length + out.duplicated.length === sel.length,
      [
        `输入 [1,2(取代 by D8),3(废止),4(无标记)] → kept=[${out.kept.map((c) => c.id)}]（保序 ✅）`,
        `duplicated 归因=[${reasons}]`,
        `kept+duplicated=${out.kept.length + out.duplicated.length}=${sel.length}（**只剔不补**：没引入输入之外的条目 ✅）`,
      ],
    )
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}

const passed = results.filter((r) => r.pass).length
line('\n' + '═'.repeat(88))
line(`G3 语料有效性验收：${passed}/${results.length} ${passed === results.length ? '✅ 全绿' : '❌ 有红'}`)
for (const r of results) if (!r.pass) line(`  ❌ ${r.id} ${r.title}`)
line('═'.repeat(88))
if (passed !== results.length) process.exitCode = 1
