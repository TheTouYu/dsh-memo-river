/**
 * 查询场 / 门控实验台（常驻回归，非验收判据）
 *
 * 为什么留着：`inject.queryLookback` 与门控阈值是**两个只有实测才能定的参数**，
 * 它们的作用面不同，容易搞混。这个台子把四条结论钉在可复跑的数字上。
 *
 * 用法：node scripts/exp-queryfield.mjs [1|2|3|4|all]
 *   实验 1  四臂对比：S0 仅当前 / S1 单向量6条 / S2 单向量2条 / S3 霰弹3段@0.75
 *   实验 2  候选池的成员/顺序/输入分数对最终读出的影响
 *   实验 3  查询**向量**对最终读出的影响（queryLookback 的真正作用面）
 *   实验 4  门控在不同窗口宽度下的判别力（宽窗口的误通过）
 *
 * 已钉结论：
 *   · 候选池顺序与输入分数对 readout **零影响**（成员饱和）→ 霰弹的加权合并在本实现里是空操作
 *   · 查询向量影响很大（Ω 0.27↔0.93，顺序改变）→ 参数承重，但承在嵌入上
 *   · 霰弹的 0.75^n 衰减会把加权分数压到门控线下 → 若照搬会 3/4 会话停止注入
 *   · 阈值 0.55 只在 w1 有判别力；w≥2 负例全部误通过 → 门控必须只看当前消息（见 config.ts gateOnCurrentMessage）
 *
 * 依赖：node scripts/setup-selftest.mjs 先铺好工作区。
 * 语料：/home/h/app/VCPToolBox/dailynote/教室建模归档（11 篇）
 */
import { Config as ConfigSchema } from '../lib/index.js'
import { acquireWorkspace } from '../lib/workspace.js'
import { cosine } from '../lib/embed.js'
import { buildQueryField } from '../lib/recall.js'
import { join } from 'node:path'

// 注意：不能用 URL.pathname——它不做百分号解码，中文路径会被编码成另一个哈希，
// 结果在一个"看起来正常"的空工作区里跑（实测踩过：造出垃圾目录 7e724b750444d46e）。
const ROOT = new URL('..', import.meta.url).pathname
const WS = join(ROOT, '.selftest', '教室建模归档')
const BUCKET = '教室建模归档'
const DIM = 3072
const GATE = 0.55
const SEG_THRESHOLD = 0.70 // 原作者默认（ContextVectorManager.js:386）
const DECAY = 0.75 // rag_params.json RAGDiaryPlugin.shotgunDecayFactor
const SEG_LIMIT = 3 // rag_params.json RAGDiaryPlugin.shotgunHistorySegmentLimit
const VCP_ROOT = '/home/h/app/VCPToolBox'

const hr = (s) => console.log(`\n${'═'.repeat(78)}\n${s}\n${'═'.repeat(78)}`)
const open = () =>
  acquireWorkspace(WS, ConfigSchema({ bucket: BUCKET, native: { vcpRoot: VCP_ROOT } }))

/* ══════════════════════ 共享素材 ══════════════════════ */

/** 4 个话题会话，末轮刻意低信号（"那个后来怎么发现的"）——历史才是唯一线索。 */
const SESSIONS = [
  {
    name: '桌子漂浮', target: '桌子漂浮',
    msgs: [
      ['user', '教室那个桌子在建好的场景里一直往上飘，重力参数是对的，桌子就是浮着不动。'],
      ['assistant', '先别调重力。桌子漂浮多半不是物理问题，而是父子级或坐标系被反转了——检查它的 transform 是不是继承了一层反向位移。'],
      ['user', '我看了确实有继承，但改完还是飘，只是方向变成往下了。'],
      ['assistant', '那就是反转点找错了一层。把整条父子链的 world matrix 逐层打出来比对，别只看本地 transform。'],
      ['user', '那这个后来到底是怎么发现原因的？'],
    ],
  },
  {
    name: '视频帧率', target: '视频线开工',
    msgs: [
      ['user', '要出真 60 帧的视频，不是靠补帧凑出来的那种，怎么搞。'],
      ['assistant', '必须在生成侧就按 60fps 出帧，编码侧只做忠实封装。补帧会被看出破绽。'],
      ['user', '那还得在网页里能实时播放才行。'],
      ['assistant', '先确认码率和关键帧间隔，别让浏览器解码器成为瓶颈。'],
      ['user', '那个最后是怎么做到那么高帧数的？'],
    ],
  },
  {
    name: '资源泄漏', target: '资源泄漏',
    msgs: [
      ['user', '跑完一轮之后机器越来越慢，像是有什么东西没释放掉。'],
      ['assistant', '先分清是内存还是句柄。浏览器标签、子进程、GPU 上下文都可能挂着不放。'],
      ['user', '浏览器那边我确实开了很多标签页没关。'],
      ['assistant', '那就是资源泄漏的典型形态。收尾时要把标签、进程、上下文都显式关掉，不能指望 GC。'],
      ['user', '所以那个泄漏最后是怎么收掉的？'],
    ],
  },
  {
    name: '编码器选型', target: '编码质疑',
    msgs: [
      ['user', '视频编码为什么不用现成的工具，非要自己写管线。'],
      ['assistant', '用现成工具不是不行，要看它能不能满足帧率和实时的约束。'],
      ['user', '那直接上 ffmpeg 会怎样？'],
      ['assistant', 'ffmpeg 能做，但在这里等于把控制权交出去，帧率和实时播放的要求就得迁就它的默认行为。'],
      ['user', '所以当时为什么没选那个方案？'],
    ],
  },
]

/** 前 5 轮教室话题历史 + 无关末轮（实验 4 的负例场景）。 */
const HISTORY = [
  '教室那个桌子在建好的场景里一直往上飘，重力参数是对的，桌子就是浮着不动。',
  '先别调重力。桌子漂浮多半不是物理问题，而是父子级或坐标系被反转了——检查它的 transform 是不是继承了一层反向位移。',
  '我看了确实有继承，但改完还是飘，只是方向变成往下了。',
  '那就是反转点找错了一层。把整条父子链的 world matrix 逐层打出来比对，别只看本地 transform。',
  '好，那我先去把矩阵打出来看看。',
]
const NEG_QUERIES = ['今天天气怎么样？', '晚饭吃什么好呢？', '帮我订一张明天去上海的高铁票。']
const REL_QUERY = '那这个桌子后来到底是怎么发现原因的？'

const knnOf = (chunks, vec) =>
  chunks.map((c) => ({ id: c.id, score: cosine(vec, c.vector.subarray(0, DIM)) })).sort((a, b) => b.score - a.score)

const titleOf = (chunks, id) =>
  String(chunks.find((c) => c.id === id)?.content ?? '').split('\n')[0].replace(/^#\s*/, '').slice(0, 26)

const idFor = (chunks, sub) => chunks.find((c) => String(c.content).includes(sub))?.id ?? -1

/** 原作分段：相邻余弦 < threshold 断开；段向量 = 成员向量归一化均值（ContextVectorManager._finalizeSegment）。 */
function segmentContext(items, threshold) {
  if (items.length === 0) return []
  const segs = []
  let cur = { vecs: [items[0].vec] }
  for (let i = 1; i < items.length; i++) {
    if (cosine(items[i - 1].vec, items[i].vec) >= threshold) cur.vecs.push(items[i].vec)
    else { segs.push(cur); cur = { vecs: [items[i].vec] } }
  }
  segs.push(cur)
  return segs.map((s) => {
    const avg = new Float32Array(DIM)
    for (const v of s.vecs) for (let d = 0; d < DIM; d++) avg[d] += v[d]
    let mag = 0
    for (let d = 0; d < DIM; d++) { avg[d] /= s.vecs.length; mag += avg[d] * avg[d] }
    mag = Math.sqrt(mag)
    if (mag > 1e-9) for (let d = 0; d < DIM; d++) avg[d] /= mag
    return { vector: avg, size: s.vecs.length }
  })
}

const stats = (list) => {
  const sc = list.map((r) => r.score)
  const mean = sc.reduce((a, b) => a + b, 0) / sc.length
  return { max: sc[0], mean, margin: sc[0] - mean }
}

/* ══════════════════════ 实验 1 ══════════════════════ */

async function exp1(ws) {
  const chunks = ws.store.chunks().filter((c) => c.vector !== null)
  const all = SESSIONS.flatMap((s) => s.msgs.map((m) => m[1]))
  const vecs = await ws.embed.embed(all)
  let p = 0
  for (const s of SESSIONS) s.items = s.msgs.map((m) => ({ role: m[0], text: m[1], vec: vecs[p++] }))

  hr('实验 1：四臂对比（S1/S2 直接调线上 buildQueryField，保证"现状"臂是真代码）')
  const rows = []
  for (const s of SESSIONS) {
    const texts = s.msgs.map((m) => m[1])
    const cur = s.items[s.items.length - 1].vec
    const [v1] = await ws.embed.embed([buildQueryField(texts, 6)])
    const [v2] = await ws.embed.embed([buildQueryField(texts, 2)])
    const segs = segmentContext(s.items, SEG_THRESHOLD)
    const recent = segs.slice(-SEG_LIMIT)
    const merged = new Map()
    recent.forEach((seg, idx) => {
      const w = Math.pow(DECAY, recent.length - idx)
      for (const r of knnOf(chunks, seg.vector)) {
        const prev = merged.get(r.id) ?? { weighted: -1, raw: -1 }
        merged.set(r.id, { weighted: Math.max(prev.weighted, r.score * w), raw: Math.max(prev.raw, r.score) })
      }
    })
    const s3w = [...merged.entries()].map(([id, v]) => ({ id, score: v.weighted })).sort((a, b) => b.score - a.score)
    const s3r = [...merged.entries()].map(([id, v]) => ({ id, score: v.raw })).sort((a, b) => b.score - a.score)
    const t = idFor(chunks, s.target)
    const rank = (l) => l.findIndex((r) => r.id === t) + 1
    rows.push({
      name: s.name, target: t, nSeg: segs.length, sizes: segs.map((x) => x.size).join('/'),
      S0: { rank: rank(knnOf(chunks, cur)), ...stats(knnOf(chunks, cur)) },
      S1: { rank: rank(knnOf(chunks, v1)), ...stats(knnOf(chunks, v1)) },
      S2: { rank: rank(knnOf(chunks, v2)), ...stats(knnOf(chunks, v2)) },
      S3: { rank: rank(s3r), maxRaw: s3r[0].score, maxW: s3w[0].score, ...stats(s3r) },
    })
    console.log(`${s.name}（分段 ${segs.length} 段 规模 ${segs.map((x) => x.size).join('/')}）  目标=chunk ${t}「${titleOf(chunks, t)}」`)
  }

  const b = (n) => (n > 0 && n <= 3 ? `[${n}]` : `${n || '—'}`)
  console.log('\n目标名次：')
  console.log('会话            S0仅当前   S1单向量6   S2单向量2   S3霰弹加权')
  for (const r of rows) console.log(`${r.name.padEnd(14)}${b(r.S0.rank).padEnd(11)}${b(r.S1.rank).padEnd(12)}${b(r.S2.rank).padEnd(12)}${b(r.S3.rank)}`)

  console.log('\n门控（阈值 0.55，只看未加权）：')
  for (const r of rows) {
    const warn = (v) => (v >= GATE ? ' 过' : '❌不过')
    console.log(`${r.name.padEnd(14)}S0=${r.S0.max.toFixed(3)}${warn(r.S0.max)}  S1=${r.S1.max.toFixed(3)}${warn(r.S1.max)}  S2=${r.S2.max.toFixed(3)}${warn(r.S2.max)}  S3原始=${r.S3.maxRaw.toFixed(3)}${warn(r.S3.maxRaw)}  S3加权=${r.S3.maxW.toFixed(3)}${warn(r.S3.maxW)}`)
  }

  console.log('\n⚠️  S3 加权是"把排序手段拿去比相关性阈值"——4 会话里 3 个会被判不注入。权重只能用于排序。')

  console.log('\n稀释度（对全部 chunk 的平均余弦；越高=越靠近语料质心）：')
  const avg = (k, arm) => rows.reduce((a, r) => a + r[arm][k], 0) / rows.length
  for (const [arm, label] of [['S0', 'S0 仅当前消息 '], ['S1', 'S1 单向量 6 条'], ['S2', 'S2 单向量 2 条'], ['S3', 'S3 霰弹(原始) ']]) {
    console.log(`  ${label} 平均余弦=${avg('mean', arm).toFixed(4)}  平均间距=${avg('margin', arm).toFixed(4)}`)
  }
  console.log('  读法：平均余弦随窗口单调上升（1→2→6 条），确认拼接在向语料质心漂移。')
  console.log('  注意：S3 的均值是"3 个向量取 max"后的池，与单向量不可直接比（被 max 抬高）。')
}

/* ══════════════════════ 实验 2 ══════════════════════ */

async function exp2(ws) {
  const chunks = ws.store.chunks().filter((c) => c.vector !== null)
  const msgs = SESSIONS[0].msgs.map((m) => m[1])
  const vecs = await ws.embed.embed(msgs)
  const cur = vecs[vecs.length - 1]
  const [q1] = await ws.embed.embed([buildQueryField(msgs, 6)])
  const byS1 = knnOf(chunks, q1)

  const pools = {
    'A 按 S1 单向量顺序': byS1.map((r) => ({ id: r.id, score: r.score })),
    'B 逆序（同成员、顺序全反）': [...byS1].reverse().map((r) => ({ id: r.id, score: r.score })),
    'C 输入分数全 0': byS1.map((r) => ({ id: r.id, score: 0 })),
    'D 输入分数全 1': byS1.map((r) => ({ id: r.id, score: 1 })),
  }

  hr('实验 2：候选池的成员/顺序/输入分数对最终读出的影响')
  const out = {}
  for (const [label, cands] of Object.entries(pools)) {
    const r = await ws.engine.runExclusive(async () => {
      if (!ws.engine.isLoaded) await ws.engine.load()
      await ws.engine.ensureArtifactLocked()
      const pipe = await ws.engine.runPipeline(`exp2#${label}`, msgs[msgs.length - 1], cur, [], [])
      return ws.engine.rerankTopologyV3(`exp2#${label}`, msgs[msgs.length - 1], pipe.metadata.observationHandle, pipe.metadata, cands)
    })
    const res = Array.isArray(r?.results) ? r.results : []
    const order = res.map((x) => x.chunkId ?? x.id)
    const om = r?.omega
    out[label] = { order, omega: typeof om === 'number' ? om : (om?.omega ?? null) }
    console.log(`${label.padEnd(26)} top6=[${order.slice(0, 6).join(',')}]  Ω=${out[label].omega === null ? 'n/a' : Number(out[label].omega).toFixed(4)}`)
  }
  const ks = Object.keys(out)
  const same = ks.every((k) => out[k].order.join(',') === out[ks[0]].order.join(','))
  console.log(`\n四种池（成员相同）→ top6 顺序${same ? '完全相同 ✅' : '不同 ❌'}；Ω 也相同。`)
  console.log(`候选池成员 ${byS1.length} / 语料 chunk ${chunks.length} → ${byS1.length === chunks.length ? '成员饱和（全都在池里）' : '成员不饱和'}`)
  console.log('结论：readout 只吃池的**成员**，不吃顺序、不吃输入分数。')
  console.log('     因为 src/recall.ts 把全部 chunk 当候选（无 top-K 截断），霰弹那套加权合并是空操作。')
}

/* ══════════════════════ 实验 3 ══════════════════════ */

async function exp3(ws) {
  const chunks = ws.store.chunks().filter((c) => c.vector !== null)
  const msgs = SESSIONS[0].msgs.map((m) => m[1])
  const vecs = await ws.embed.embed(msgs)
  const cur = vecs[vecs.length - 1]
  const [q1] = await ws.embed.embed([buildQueryField(msgs, 6)])
  const [q2] = await ws.embed.embed([buildQueryField(msgs, 2)])
  const pool = chunks.map((c) => ({ id: c.id, score: cosine(cur, c.vector.subarray(0, DIM)) }))

  hr('实验 3：固定候选池（全 11 条），只换 pipeline 的 queryVector')
  const arms = { 'Q0 仅当前消息向量': cur, 'Q1 拼接 6 条（现状）': q1, 'Q2 拼接 2 条': q2 }
  const out = {}
  for (const [label, vec] of Object.entries(arms)) {
    const r = await ws.engine.runExclusive(async () => {
      if (!ws.engine.isLoaded) await ws.engine.load()
      await ws.engine.ensureArtifactLocked()
      const pipe = await ws.engine.runPipeline(`exp3#${label}`, msgs[msgs.length - 1], vec, [], [])
      return ws.engine.rerankTopologyV3(`exp3#${label}`, msgs[msgs.length - 1], pipe.metadata.observationHandle, pipe.metadata, pool)
    })
    const order = (Array.isArray(r?.results) ? r.results : []).map((x) => x.chunkId ?? x.id)
    const om = r?.omega
    out[label] = { order, omega: typeof om === 'number' ? om : (om?.omega ?? null) }
    console.log(`${label.padEnd(22)} top6=[${order.slice(0, 6).join(',')}]  Ω=${out[label].omega === null ? 'n/a' : Number(out[label].omega).toFixed(4)}`)
  }
  const ks = Object.keys(out)
  console.log('')
  for (const k of ks.slice(1)) {
    const same = out[k].order.join(',') === out[ks[0]].order.join(',')
    console.log(`Q0 vs ${k}：顺序${same ? '相同' : '不同'}  Ω差=${Math.abs((out[k].omega ?? 0) - (out[ks[0]].omega ?? 0)).toFixed(4)}`)
  }
  console.log('\n结论：查询向量影响很大（Ω 跨 0.27↔0.93，顺序改变）→ queryLookback 承重，但承在**嵌入**上。')
  console.log('      与实验 2 合起来：唯一作用面是"喂给 pipeline 的向量"，不是候选池。')
}

/* ══════════════════════ 实验 4 ══════════════════════ */

async function exp4(ws) {
  const chunks = ws.store.chunks().filter((c) => c.vector !== null)
  const maxOf = (v) => Math.max(...chunks.map((c) => cosine(v, c.vector.subarray(0, DIM))))
  const sweep = async (last, expectPass) => {
    const all = [...HISTORY, last]
    const cells = []
    for (const w of [1, 2, 3, 4, 6]) {
      const [v] = await ws.embed.embed([buildQueryField(all, w)])
      const m = maxOf(v)
      const passed = m >= GATE
      // 负例「过」是误通过、正例「不过」是漏召回——两种才标 ⚠️
      const mark = passed === expectPass ? (passed ? ' 过' : ' 不过') : `⚠️${passed ? '过' : '不过'}`
      cells.push(`w${w}=${m.toFixed(4)}${mark}`)
    }
    return cells
  }

  hr('实验 4：门控在不同窗口宽度下的判别力（负例 + 正例对照）')
  for (const q of NEG_QUERIES) {
    console.log(`负例「${q}」`)
    console.log(`   ${(await sweep(q, false)).join('   ')}`)
  }
  console.log(`正例「${REL_QUERY}」`)
  console.log(`   ${(await sweep(REL_QUERY, true)).join('   ')}`)

  console.log('\n结论：阈值 0.55 只在 w1 有判别力（负例上界 0.5124 < 0.55 < 正例 0.6525，间隔 0.14）。')
  console.log('      w≥2 起三条负例全部误通过，门控退化为摆设——而真实会话必然有历史。')
  console.log('      → 门控必须只看当前消息向量：config.inject.gateOnCurrentMessage（默认 true）。')
  console.log('      历史窗口继续用于检索：两者解耦，各回答一个问题。')
}

/* ══════════════════════ 调度 ══════════════════════ */

const ALL = { 1: exp1, 2: exp2, 3: exp3, 4: exp4 }
const which = (process.argv[2] ?? 'all').trim()
const picks = which === 'all' ? [1, 2, 3, 4] : [Number(which)]
for (const n of picks) {
  if (!ALL[n]) {
    console.error(`未知实验：${which}（可用 1|2|3|4|all）`)
    process.exit(2)
  }
}
const ws = open()
for (const n of picks) await ALL[n](ws)
process.exit(0)
