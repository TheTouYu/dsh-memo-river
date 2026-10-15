#!/usr/bin/env node
/**
 * probe-injection-adoption.mjs —— 「注入 → 被用上」实验室（2026-10-15）
 *
 * 目的：第三刀（回忆后复查）的**采集判据**不能靠设想，要用真实数据选出来。
 * 本脚本只做三件事：**对齐 / 跑多组判据 / 出三份可核验的产物**。它不判定谁对——
 * 谁是"真的被用上"，由在场者看 `*-sample.md` 判。
 *
 * ⚠️ **判据一律可插拔、阈值一律不写死**（用户 2026-10-15：「判据现在只是你的设想，不要固定死；
 *    最终选择可能两者都不是，要看实际测试结果」）。全部判据与阈值集中在 `CRITERIA` / `TUNING`，
 *    加一条判据 = 往数组里加一个对象，不动主流程。
 *
 * 原数据（2026-10-15 实测，与 SPEC 的差异已在此更正）：
 *   1. 注入事实 = `~/.dsh/memo-river/<桶哈希>/memo-river.log` 的 `inject` 行
 *      （ISO-UTC 时间戳 / `session=<id>` / `ids=D229,D211,…`，跨桶形如 `D3@常识库`）
 *   2. 注入块原文 = 会话 JSONL 的 `agent/inbox/spliced` → `data.inserted[].content[].text`
 *      （**不是** `system/message`——那是系统提示词。实证：有注入的会话 marker 出现 38 次，无注入的 0 次）
 *   3. 模型行为 = 同一 JSONL：`assistant/message`（正文）/ `tool/call`（arguments）/ `tool/result` / `user/message`
 *   4. 条目正文 = 桶库 `knowledge_base.sqlite` 的 `chunks.content`（D 编号 = chunk id）
 *   会话文件是 **session.v4.jsonl.zstd**（SPEC 里写成 v3，已更正）。
 *
 * 用法：
 *   node scripts/probe-injection-adoption.mjs                      # 全部桶，近 72h，≤200 轮
 *   node scripts/probe-injection-adoption.mjs --since-hours 168 --limit 500
 *   node scripts/probe-injection-adoption.mjs --criteria L1,E1,E2  # 只跑指定判据
 *   node scripts/probe-injection-adoption.mjs --no-embed           # 不连嵌入端点（纯字面判据）
 *   node scripts/probe-injection-adoption.mjs --out /tmp/lab
 *   node scripts/probe-injection-adoption.mjs --selftest           # 只跑自检（含负对照），不碰真实会话
 *
 * 只读：不写任何生产数据、不装依赖、不调 LLM；嵌入只打到本机 8099。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/* ══════════════ 调参区（全部可改，没有一处写死在流程里） ══════════════ */
const TUNING = {
  /** 注入后多久内的助手正文算"这一轮"（毫秒）。D106 用的是 10 分钟窗。 */
  alignWindowMs: 10 * 60 * 1000,
  /** 字面判据：CJK 取几字窗口 */
  cjkNgram: 4,
  /** 字面判据：token 文档频率上限（超过视为"通用词"，不算独有）。df 在**桶内全语料**上算。 */
  dfMax: 0.15,
  /** L2 宽松判据里，标题/Tag 词的排除（这些词天然会在别处出现） */
  excludeTitleTagsForLoose: true,
  /** L3：最长公共连续片段的最小长度（CJK 按字符计），低于它不算命中 */
  lcsMinLen: 12,
  /** 嵌入判据：一个句子至少多长才参与比对（太短的句子噪声大） */
  minSentenceChars: 8,
  /** E1/E3：余弦命中阈值（**先给个起点值，实验室会输出分布供重新定标**） */
  cosHit: 0.62,
  /** E2 判别式：要求"最像这条"的领先幅度（相对第二名） */
  discriminativeMargin: 0.01,
  /** E3 对照：正文句子与**排除集**（工具输出/用户消息）的最大余弦，要求记忆至少高出这么多 */
  contrastMargin: 0.02,
  /** 嵌入批大小 */
  embedBatch: 32,
  /** 每轮最多取多少字符的助手正文参与比对（防超长正文拖慢） */
  assistantCharCap: 12000,
  /**
   * **对照条目数（本实验室最重要的一条）**：每轮额外抽 N 条"**没被注入**"的桶内条目，
   * 用完全相同的判据跑一遍 → 得到**基线命中率**。
   *
   * 为什么必须有它：token 重合完全可能只说明"检索本来就切题"（任务在讲 embedTimeoutMs，
   * 记忆里也有 embedTimeoutMs），**那不等于这条记忆起了作用**。判据的信号 = 注入组命中率
   * **减去**对照组命中率。差值（lift）接近 0 ⇒ 该判据在测"话题重合"，不是在测"被用上"。
   */
  decoyCount: 5,
}

const ARGS = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = ARGS.indexOf(`--${name}`)
  return i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--') ? ARGS[i + 1] : dflt
}
const flag = (name) => ARGS.includes(`--${name}`)

const SINCE_HOURS = Number(arg('since-hours', 72))
const LIMIT = Number(arg('limit', 200))
const OUT = String(arg('out', '/tmp/mr-adoption-lab'))
const EMBED_URL = String(arg('embed', 'http://127.0.0.1:8099'))
const USE_EMBED = !flag('no-embed')
const ONLY = String(arg('criteria', '')).split(',').map((s) => s.trim()).filter(Boolean)

const MEMO_HOME = process.env.MEMO_HOME || join(homedir(), '.dsh', 'memo-river')
const SESS_HOME = join(homedir(), '.dsh', 'sessions')

/* ══════════════ 基础设施 ══════════════ */
const log = (...a) => console.log(...a)
const cosine = (a, b) => {
  let d = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return na && nb ? d / Math.sqrt(na * nb) : 0
}
const unzstd = (file) => execFileSync('zstd', ['-dc', file], { maxBuffer: 1 << 30, encoding: 'utf8' })
const isCJK = (c) => /[\u4e00-\u9fff]/.test(c)

/** 词元抽取：拉丁标识符/路径 + 数字 + CJK n-gram。用于字面判据与"独有 token"定义。 */
function tokenize(text, n = TUNING.cjkNgram) {
  const out = new Set()
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_.\-:/]{2,}/g)) out.add(m[0])
  for (const m of text.matchAll(/\d+(?:\.\d+)?%?/g)) out.add(m[0])
  const cjk = text.replace(/[^\u4e00-\u9fff]+/g, ' ')
  for (const run of cjk.split(/\s+/)) {
    for (let i = 0; i + n <= run.length; i++) out.add(run.slice(i, i + n))
  }
  return out
}

/** 切句（中英标点 + 换行）。 */
function sentences(text) {
  return text
    .split(/(?<=[。！？!?；;\n])|(?<=\.\s)/)
    .map((s) => s.trim())
    .filter((s) => s.length >= TUNING.minSentenceChars)
}

/** 最长公共连续片段长度（DP，滚动数组；只回长度，够用）。 */
function lcsLen(a, b) {
  if (!a || !b) return 0
  let prev = new Int32Array(b.length + 1)
  let best = 0
  for (let i = 1; i <= a.length; i++) {
    const cur = new Int32Array(b.length + 1)
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1
        if (cur[j] > best) best = cur[j]
      }
    }
    prev = cur
  }
  return best
}
/** 最长公共片段的实际文本（用于证据展示；只在需要时跑）。 */
function lcsText(a, b) {
  let best = ''
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1))
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
        if (dp[i][j] > best.length) best = a.slice(i - dp[i][j], i)
      }
    }
  }
  return best
}

/* ══════════════ 1. 原数据：注入事实 ══════════════ */
function loadInjectFacts() {
  const facts = []
  let skippedRounds = 0
  if (!existsSync(MEMO_HOME)) return { facts, skippedRounds }
  for (const hash of readdirSync(MEMO_HOME)) {
    const logFile = join(MEMO_HOME, hash, 'memo-river.log')
    if (!existsSync(logFile)) continue
    let lines = []
    try { lines = readFileSync(logFile, 'utf8').split('\n') } catch { continue }
    for (const line of lines) {
      if (!line.includes('inject bucket=')) {
        if (line.includes('inject-skip')) skippedRounds++
        continue
      }
      const ts = (line.match(/^\[([^\]]+)\]/) || [])[1]
      const bucket = (line.match(/inject bucket=(\S+)/) || [])[1]
      const idsRaw = (line.match(/\bids=(\S*)/) || [])[1] ?? ''
      const session = (line.match(/\bsession=(\S+)/) || [])[1]
      if (!ts || !session) continue
      const t = Date.parse(ts)
      if (!Number.isFinite(t)) continue
      const items = idsRaw
        .split(',')
        .filter(Boolean)
        .map((tok) => {
          const m = tok.match(/^D(\d+)(?:@(\S+))?$/)
          return m ? { d: Number(m[1]), foreignBucket: m[2] ?? null } : null
        })
        .filter(Boolean)
      if (items.length === 0) continue
      facts.push({ t, tsIso: ts, hash, bucket, session, items })
    }
  }
  facts.sort((a, b) => b.t - a.t)
  return { facts, skippedRounds }
}

/* ══════════════ 2. 原数据：会话事件 ══════════════ */
const sessionCache = new Map()
function loadSession(sessionId) {
  if (sessionCache.has(sessionId)) return sessionCache.get(sessionId)
  let result = null
  for (const dir of existsSync(SESS_HOME) ? readdirSync(SESS_HOME) : []) {
    const d = join(SESS_HOME, dir, sessionId)
    if (!existsSync(d)) continue
    const z = readdirSync(d).find((f) => f.endsWith('.jsonl.zstd'))
    if (!z) continue
    try {
      const evs = unzstd(join(d, z)).split('\n').filter(Boolean).map((l) => JSON.parse(l))
      result = { dir, events: evs }
    } catch (e) {
      result = { dir, events: [], error: String(e).slice(0, 120) }
    }
    break
  }
  sessionCache.set(sessionId, result)
  return result
}

const msgText = (m) =>
  (m?.content ?? [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')

/**
 * 对齐一轮。
 *
 * ⚠️ 三个实测踩出来的坑（2026-10-15 首跑全 0 命中，根因全在这里）：
 *   1. **注入块是 `user/message`**，文本以 `⟨memo-river·被动召回⟩` 开头——不是 `agent/inbox/spliced`，
 *      也不是 `system/message`（那是系统提示词）。首跑块长全 0 就是因为找错了类型。
 *   2. **一轮 ≠ 注入后的第一条 assistant 消息**：那通常只是调工具前的一句开场白
 *      （实测首跑抓到的"正文"只有 43–200 字，判据自然全 0）。**一轮 = 同一个 `turn` 的全部助手正文**。
 *      改用 `data.turn` 界定，比按时间窗更准。
 *   3. **注入块必须从排除集里剔除**：它本身是 `user/message`，若按"用户消息一律进排除集"处理，
 *      就会把"记忆里的话"当成"模型从别处读到的"，把真命中错误地压掉。
 */
function alignRound(fact, sess) {
  if (!sess || sess.events.length === 0) return null
  const evs = sess.events
  const textOf = (e) => {
    if (e.type === 'user/message') return msgText({ content: e.data?.content ?? e.data?.message?.content })
    if (e.type === 'assistant/message') return msgText(e.data?.message)
    return ''
  }
  const isMemoBlock = (e) => e.type === 'user/message' && textOf(e).includes('memo-river·被动召回')

  // ① 注入块原文：时间上贴近 fact.t 的那条 memo-river 用户消息
  let blockText = ''
  for (const e of evs) {
    if (!isMemoBlock(e)) continue
    if (typeof e.time !== 'number' || e.time < fact.t - 3000 || e.time > fact.t + 30000) continue
    blockText += '\n' + textOf(e)
  }

  // ② 定这一轮：注入后第一条有正文的 assistant 消息所在的 turn
  let anchor = null
  for (const e of evs) {
    if (e.type !== 'assistant/message' || typeof e.time !== 'number' || e.time < fact.t) continue
    if (textOf(e).trim().length > 0) { anchor = e; break }
    if (e.time - fact.t > TUNING.alignWindowMs) break
  }
  if (!anchor) return null
  const turn = anchor.data?.turn
  const inTurn = (e) =>
    typeof e.time === 'number' &&
    e.time >= fact.t &&
    e.time <= anchor.time + TUNING.alignWindowMs &&
    (turn === undefined || e.data?.turn === undefined || e.data.turn === turn)

  // ③ 助手正文 = 该 turn 的全部正文（不是第一条）
  const asstParts = []
  const exTool = [], exUser = [], toolCalls = []
  for (const e of evs) {
    if (!inTurn(e)) continue
    if (e.type === 'assistant/message') {
      const t = textOf(e)
      if (t.trim()) asstParts.push(t)
    } else if (e.type === 'tool/result') exTool.push(JSON.stringify(e.data))
    else if (e.type === 'tool/call') toolCalls.push({ name: e.data?.name, args: String(e.data?.arguments ?? '') })
    else if (e.type === 'user/message' && !isMemoBlock(e)) exUser.push(textOf(e))
  }
  if (asstParts.length === 0) return null
  return {
    blockText,
    assistant: asstParts.join('\n').slice(0, TUNING.assistantCharCap),
    excludeText: [...exTool, ...exUser].join('\n').slice(0, 200000),
    toolCalls,
    turn,
    step: anchor.data?.step,
  }
}

/* ══════════════ 3. 原数据：条目正文 + 桶内 df ══════════════ */
const dbCache = new Map()
function openBucket(hash) {
  if (dbCache.has(hash)) return dbCache.get(hash)
  const p = join(MEMO_HOME, hash, 'knowledge_base.sqlite')
  let store = null
  if (existsSync(p)) {
    try {
      const db = new DatabaseSync(p, { readOnly: true })
      const rows = db.prepare('SELECT id, content FROM chunks').all()
      const bodies = new Map(rows.map((r) => [Number(r.id), String(r.content ?? '')]))
      // 桶内 df（用于"独有 token"）：对全部 chunk 取词元并集统计
      const df = new Map()
      for (const body of bodies.values()) for (const tk of tokenize(body)) df.set(tk, (df.get(tk) ?? 0) + 1)
      store = { bodies, df, docCount: bodies.size }
      db.close()
    } catch (e) { store = { bodies: new Map(), df: new Map(), docCount: 0, error: String(e).slice(0, 120) } }
  } else store = { bodies: new Map(), df: new Map(), docCount: 0 }
  dbCache.set(hash, store)
  return store
}
/** 条目的"独有 token"：df 低于阈值（即不是通用词）。tagWords 里的词被排除。 */
function uniqueTokens(store, dId, tagWords) {
  const body = store.bodies.get(dId) ?? ''
  const dfMax = Math.max(1, Math.floor(store.docCount * TUNING.dfMax))
  const out = new Set()
  for (const tk of tokenize(body)) {
    if ((store.df.get(tk) ?? 0) > dfMax) continue
    if (tagWords.has(tk)) continue
    out.add(tk)
  }
  return { body, tokens: out }
}

/* ══════════════ 4. 判据（可插拔；加一条 = 加一个对象） ══════════════
 * 每个判据：{ id, kind, desc, needsEmbed, run(ctx) -> Map<dId, {hit, score, evidence}> }
 * ctx = { assistant, sentences, excludeText, toolCalls, items:[{d, body, tokens, tagWords}], embedMsgs(texts) }
 */
const CRITERIA = [
  {
    id: 'L1',
    kind: 'lexical-strict',
    desc: '独占 token ∩ 助手正文，且该 token 不在同轮工具输出/用户消息里',
    needsEmbed: false,
    run: (ctx) => {
      const m = new Map()
      const ex = new Set(tokenize(ctx.excludeText))
      for (const it of ctx.items) {
        const hit = [...it.tokens].filter((t) => ctx.assistant.includes(t) && !ex.has(t))
        m.set(it.d, { hit: hit.length > 0, score: hit.length, evidence: hit.slice(0, 6).join(' ') })
      }
      return m
    },
  },
  {
    id: 'L2',
    kind: 'lexical-loose',
    desc: '独占 token ∩ 助手正文（不排除工具输出——用来量化"排除集到底值多少"）',
    needsEmbed: false,
    run: (ctx) => {
      const m = new Map()
      for (const it of ctx.items) {
        const hit = [...it.tokens].filter((t) => ctx.assistant.includes(t))
        m.set(it.d, { hit: hit.length > 0, score: hit.length, evidence: hit.slice(0, 6).join(' ') })
      }
      return m
    },
  },
  {
    id: 'L3',
    kind: 'lexical-continuous',
    desc: `最长公共连续片段 ≥ ${TUNING.lcsMinLen} 字（给连续量，不必拍二值阈值）`,
    needsEmbed: false,
    run: (ctx) => {
      const m = new Map()
      for (const it of ctx.items) {
        const L = lcsLen(ctx.assistant, it.body)
        m.set(it.d, {
          hit: L >= TUNING.lcsMinLen,
          score: L,
          evidence: L >= 6 ? lcsText(ctx.assistant, it.body).slice(0, 60) : '',
        })
      }
      return m
    },
  },
  {
    id: 'L4',
    kind: 'lexical-structured',
    desc: '该条的独占 token 出现在 tool/call 的 arguments 里（"影响了动作"）',
    needsEmbed: false,
    run: (ctx) => {
      const m = new Map()
      const argsAll = ctx.toolCalls.map((c) => c.args).join('\n')
      for (const it of ctx.items) {
        const hit = [...it.tokens].filter((t) => argsAll.includes(t))
        m.set(it.d, { hit: hit.length > 0, score: hit.length, evidence: hit.slice(0, 6).join(' ') })
      }
      return m
    },
  },
  {
    id: 'E1',
    kind: 'embedding-absolute',
    desc: `助手正文逐句与该条正文的最大余弦 ≥ ${TUNING.cosHit}`,
    needsEmbed: true,
    run: async (ctx) => {
      const m = new Map()
      if (!ctx.sentences.length) return m
      const sv = await ctx.embedMsgs(ctx.sentences)
      for (const it of ctx.items) {
        const [bv] = await ctx.embedMsgs([it.body.slice(0, 2000)])
        let best = -1, bestS = ''
        for (let i = 0; i < sv.length; i++) {
          const c = cosine(sv[i], bv)
          if (c > best) { best = c; bestS = ctx.sentences[i] }
        }
        m.set(it.d, { hit: best >= TUNING.cosHit, score: best, evidence: bestS.slice(0, 60) })
      }
      return m
    },
  },
  {
    id: 'E2',
    kind: 'embedding-discriminative',
    desc: `判别式：某句"最像的条目"必须就是这条，且领先第二名 ≥ ${TUNING.discriminativeMargin}`,
    needsEmbed: true,
    run: async (ctx) => {
      const m = new Map()
      if (!ctx.sentences.length) return m
      const sv = await ctx.embedMsgs(ctx.sentences)
      const bodies = ctx.items.map((it) => it.body.slice(0, 2000))
      const bv = await ctx.embedMsgs(bodies)
      // 每句对每条打一次余弦
      const best = ctx.items.map(() => ({ cos: -1, sent: '', second: -1 }))
      for (let s = 0; s < sv.length; s++) {
        const scored = ctx.items.map((_, k) => cosine(sv[s], bv[k])).map((c, k) => ({ c, k })).sort((a, b) => b.c - a.c)
        const top = scored[0]
        if (top && top.c > best[top.k].cos) {
          best[top.k] = { cos: top.c, sent: ctx.sentences[s], second: scored[1]?.c ?? 0 }
        }
      }
      ctx.items.forEach((it, k) => {
        const b = best[k]
        m.set(it.d, {
          hit: b.cos >= TUNING.cosHit && b.cos - b.second >= TUNING.discriminativeMargin,
          score: b.cos,
          evidence: `lead=${(b.cos - b.second).toFixed(4)} ${b.sent.slice(0, 48)}`,
        })
      })
      return m
    },
  },
  {
    id: 'E3',
    kind: 'embedding-contrastive',
    desc: `对照式：句子→该条的余弦，要比它→**同轮工具输出/用户消息**的余弦高出 ≥ ${TUNING.contrastMargin}`,
    needsEmbed: true,
    run: async (ctx) => {
      const m = new Map()
      const exSent = sentences(ctx.excludeText).slice(0, 60)
      if (!ctx.sentences.length || !exSent.length) return m
      const sv = await ctx.embedMsgs(ctx.sentences)
      const xv = await ctx.embedMsgs(exSent)
      for (const it of ctx.items) {
        const [bv] = await ctx.embedMsgs([it.body.slice(0, 2000)])
        let best = -1, bestS = '', exMax = 0
        for (let i = 0; i < sv.length; i++) {
          const c = cosine(sv[i], bv)
          if (c > best) {
            best = c; bestS = ctx.sentences[i]
            exMax = Math.max(...xv.map((x) => cosine(sv[i], x)))
          }
        }
        m.set(it.d, {
          hit: best >= TUNING.cosHit && best - exMax >= TUNING.contrastMargin,
          score: best - exMax,
          evidence: `cos=${best.toFixed(4)} exMax=${exMax.toFixed(4)} ${bestS.slice(0, 40)}`,
        })
      }
      return m
    },
  },
]

/* ══════════════ 嵌入客户端（本机 8099） ══════════════ */
function makeEmbedder() {
  let calls = 0, chars = 0, fails = 0
  const cache = new Map()
  const embed = async (texts) => {
    const out = new Array(texts.length)
    const todo = []
    for (let i = 0; i < texts.length; i++) {
      const key = createHash('sha1').update(texts[i]).digest('hex')
      if (cache.has(key)) out[i] = cache.get(key)
      else todo.push({ i, key, text: texts[i] })
    }
    for (let s = 0; s < todo.length; s += TUNING.embedBatch) {
      const batch = todo.slice(s, s + TUNING.embedBatch)
      const body = JSON.stringify({ model: 'bge-m3', input: batch.map((b) => b.text || ' ') })
      let json = null
      for (let attempt = 0; attempt < 2 && !json; attempt++) {
        try {
          const raw = execFileSync('curl', ['-s', '--max-time', '60', '-X', 'POST', `${EMBED_URL}/v1/embeddings`,
            '-H', 'Content-Type: application/json', '-d', body], { maxBuffer: 1 << 28, encoding: 'utf8' })
          json = JSON.parse(raw)
        } catch { fails++ }
      }
      if (!json?.data) { for (const b of batch) out[b.i] = new Float32Array(1024) ; continue }
      calls++
      for (const it of json.data) {
        const b = batch[it.index]
        const v = Float32Array.from(it.embedding)
        out[b.i] = v
        cache.set(b.key, v)
        chars += b.text.length
      }
    }
    return out
  }
  return { embed, stats: () => ({ calls, chars, fails, cached: cache.size }) }
}

/* ══════════════ 主流程 ══════════════ */
const report = []
const rounds = []
const t0 = Date.now()
const embedder = makeEmbedder()
const active = CRITERIA.filter((c) => (ONLY.length === 0 || ONLY.includes(c.id)) && (!c.needsEmbed || USE_EMBED))

log(`【注入→被用上 实验室】since=${SINCE_HOURS}h limit=${LIMIT} 判据=[${active.map((c) => c.id).join(',')}] embed=${USE_EMBED ? EMBED_URL : 'off'}`)
const { facts, skippedRounds } = loadInjectFacts()
log(`  注入事实 ${facts.length} 条（另有 inject-skip ${skippedRounds} 条）`)

const cutoff = Date.now() - SINCE_HOURS * 3600_000
const picked = facts.filter((f) => f.t >= cutoff).slice(0, LIMIT)
log(`  窗口内 ${facts.filter((f) => f.t >= cutoff).length} 条 → 取 ${picked.length} 条`)

let aligned = 0, noSession = 0, noAssistant = 0, noBody = 0
for (const f of picked) {
  const sess = loadSession(f.session)
  if (!sess?.events?.length) { noSession++; continue }
  const al = alignRound(f, sess)
  if (!al) { noAssistant++; continue }
  const store = openBucket(f.hash)
  const items = []
  for (const it of f.items) {
    if (it.foreignBucket) continue // v1：跨桶条目先跳过（正文在另一个库）
    const { body, tokens } = uniqueTokens(store, it.d, new Set())
    if (!body) { noBody++; continue }
    items.push({ d: it.d, body, tokens })
  }
  if (items.length === 0) { noBody++; continue }
  const ctx = {
    assistant: al.assistant,
    sentences: sentences(al.assistant),
    excludeText: al.excludeText,
    toolCalls: al.toolCalls,
    items,
    embedMsgs: embedder.embed,
  }
  const injectedSet = new Set(items.map((i) => i.d))
  // 对照条目：同桶、**没被注入**、正文够长（太短的正文没有可判别的 token）
  const pool = [...store.bodies.entries()]
    .filter(([id, b]) => !injectedSet.has(id) && b.length > 80)
    .map(([id]) => id)
  // 确定性抽样（按轮次时间做种子，可复跑复现同一组对照）
  let seed = f.t % 2147483647
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
  const decoyIds = []
  for (let i = 0; i < Math.min(TUNING.decoyCount, pool.length); i++) {
    const k = Math.floor(rnd() * pool.length)
    const id = pool.splice(k, 1)[0]
    if (id !== undefined) decoyIds.push(id)
  }
  const decoys = decoyIds.map((id) => {
    const { body, tokens } = uniqueTokens(store, id, new Set())
    return { d: id, body, tokens }
  })

  const per = {}
  const perDecoy = {}
  for (const c of active) {
    try {
      const r = await c.run(ctx)
      // ⚠️ 键必须与 `injectedIds` 同格式（`D121`）。首版写成 `String(k)`＝`"121"`，
      // 而汇总侧按 `D121` 查 → 全部查不到 → **所有判据都显示 0.0%**（自欺的绿灯/红灯）。
      per[c.id] = Object.fromEntries([...r].map(([k, v]) => [`D${k}`, v]))
    } catch (e) {
      per[c.id] = { __error: String(e).slice(0, 140) }
    }
    if (decoys.length > 0) {
      try {
        const rd = await c.run({ ...ctx, items: decoys })
        perDecoy[c.id] = Object.fromEntries([...rd].map(([k, v]) => [`D${k}`, v]))
      } catch (e) {
        perDecoy[c.id] = { __error: String(e).slice(0, 140) }
      }
    }
  }
  rounds.push({
    ts: f.tsIso, session: f.session, bucket: f.bucket, hash: f.hash,
    turn: al.turn, step: al.step,
    injectedIds: items.map((i) => `D${i.d}`),
    decoyIds: decoys.map((i) => `D${i.d}`),
    assistantChars: al.assistant.length,
    blockChars: al.blockText.length,
    toolNames: al.toolCalls.map((c) => c.name),
    quoted: per,
    quotedDecoy: perDecoy,
  })
  aligned++
  if (aligned % 10 === 0) log(`  …已对齐 ${aligned} 轮`)
}

// 汇总（含**对照基线**与 lift —— 本实验室的主判据）
const summary = active.map((c) => {
  let hitRounds = 0, hitItems = 0, totalItems = 0
  let decoyHit = 0, decoyTotal = 0
  const scores = []
  for (const r of rounds) {
    const per = r.quoted[c.id] ?? {}
    let any = false
    for (const d of r.injectedIds) {
      totalItems++
      const v = per[d]
      if (v?.__error) continue
      if (typeof v?.score === 'number') scores.push(v.score)
      if (v?.hit) { hitItems++; any = true }
    }
    if (any) hitRounds++
    const pd = r.quotedDecoy?.[c.id] ?? {}
    for (const d of r.decoyIds ?? []) {
      const v = pd[d]
      if (!v || v.__error) continue
      decoyTotal++
      if (v.hit) decoyHit++
    }
  }
  const rate = totalItems ? hitItems / totalItems : 0
  const base = decoyTotal ? decoyHit / decoyTotal : 0
  return { id: c.id, kind: c.kind, desc: c.desc, hitRounds, hitItems, totalItems, decoyHit, decoyTotal, rate, base, lift: rate - base, scores }
})

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'adoption-rounds.jsonl'), rounds.map((r) => JSON.stringify(r)).join('\n'))

const hist = (xs, lo, hi, bins = 12) => {
  if (!xs.length) return '（无数据）'
  const w = (hi - lo) / bins
  const h = new Array(bins).fill(0)
  for (const x of xs) {
    const i = Math.min(bins - 1, Math.max(0, Math.floor((x - lo) / w)))
    h[i]++
  }
  const max = Math.max(...h)
  return h.map((n, i) => `    ${(lo + i * w).toFixed(2)}-${(lo + (i + 1) * w).toFixed(2)} ${'█'.repeat(Math.round((n / max) * 40))} ${n}`).join('\n')
}

const lines = []
lines.push('# 注入 → 被用上：实验室汇总', '')
lines.push(`- 窗口：近 ${SINCE_HOURS}h ｜ 取 ${picked.length} 条注入 → **成功对齐 ${aligned} 轮**`)
lines.push(`- 丢弃：无会话 ${noSession} ｜ 无助手正文 ${noAssistant} ｜ 桶里取不到条目正文 ${noBody}`)
lines.push(`- 判据：${active.map((c) => c.id).join(', ')}（阈值为起点值，**看分布再定**）`)
lines.push(`- 嵌入：${USE_EMBED ? EMBED_URL : '未使用'} ｜ 调用 ${embedder.stats().calls} 批 / ${embedder.stats().chars} 字 / 失败 ${embedder.stats().fails}`)
lines.push('', '## 主判据：注入组 vs 对照组（**lift 才是信号；lift≈0 ⇒ 该判据在测"话题重合"而不是"被用上"**）', '')
lines.push('| 判据 | 注入命中 | 对照命中（没被注入的条目） | **lift** | 读法 |')
lines.push('|---|---|---|---|---|')
for (const s of summary) {
  const lift = (s.lift * 100).toFixed(1) + 'pp'
  const verdict = s.lift >= 0.3 ? '信号强' : s.lift >= 0.15 ? '有信号' : s.lift >= 0.05 ? '信号弱' : '**几乎无信号**'
  lines.push(
    `| ${s.id} | ${s.hitItems}/${s.totalItems} = ${(s.rate * 100).toFixed(1)}% | ${s.decoyHit}/${s.decoyTotal} = ${(s.base * 100).toFixed(1)}% | **${lift}** | ${verdict} |`,
  )
}
lines.push('')
lines.push('## 判据一览（命中率 = 命中条数 / 参评条数）', '')
lines.push('| 判据 | 类型 | 命中轮次 | 命中条数/参评 | 条命中率 | 说明 |')
lines.push('|---|---|---|---|---|---|')
for (const s of summary) {
  const rate = s.totalItems ? ((s.hitItems / s.totalItems) * 100).toFixed(1) + '%' : '-'
  lines.push(`| ${s.id} | ${s.kind} | ${s.hitRounds}/${rounds.length} | ${s.hitItems}/${s.totalItems} | ${rate} | ${s.desc} |`)
}
lines.push('', '## 连续量分布（**双峰 = 判据可用，阈值落谷底；单峰 = 换判据**）', '')
for (const s of summary) {
  if (s.id !== 'L3' && !s.kind.startsWith('embedding')) continue
  const lo = s.id === 'L3' ? 0 : 0.3
  const hi = s.id === 'L3' ? 80 : 1.0
  lines.push(`### ${s.id}（n=${s.scores.length}）`, '```', hist(s.scores, lo, hi), '```', '')
}
lines.push('## 包含关系自检（不成立 = 脚本有 bug，先修脚本再谈结论）', '')
const pair = (a, b, label) => {
  let viol = 0, n = 0
  for (const r of rounds) {
    for (const d of r.injectedIds) {
      const va = r.quoted[a]?.[d], vb = r.quoted[b]?.[d]
      if (!va || !vb || va.__error || vb.__error) continue
      n++
      if (va.hit && !vb.hit) viol++
    }
  }
  lines.push(`- ${label}：${viol} 例反例 / ${n} 对照（应为 0）`)
}
if (rounds.length) {
  if (active.some((c) => c.id === 'L1') && active.some((c) => c.id === 'L2')) pair('L1', 'L2', 'L1 ⊆ L2')
  if (active.some((c) => c.id === 'L4') && active.some((c) => c.id === 'L3')) pair('L4', 'L3', 'L4 ⊆ L3（弱形式）')
}
writeFileSync(join(OUT, 'adoption-summary.md'), lines.join('\n'))

// 人工判样本（给材料，不给结论）
const sample = []
sample.push('# 注入 → 被用上：人工判样本（请逐轮判：□真用了 □碰巧）', '')
sample.push(`判据代码：${active.map((c) => `${c.id}=${c.kind}`).join(' ｜ ')}`, '')
for (const [i, r] of rounds.slice(0, 50).entries()) {
  sample.push(`## 轮 #${i + 1}  ${r.ts}  session=${r.session.slice(0, 20)}…  bucket=${r.bucket}  turn=${r.turn}/${r.step}`)
  sample.push(`注入 ${r.injectedIds.length} 条 ｜ 助手正文 ${r.assistantChars} 字 ｜ 块 ${r.blockChars} 字 ｜ 工具 ${r.toolNames.join(',') || '无'}`)
  const hits = active.map((c) => `${c.id}:${r.injectedIds.filter((d) => r.quoted[c.id]?.[d]?.hit).join('') || '-'}`).join('  ')
  sample.push(`各判据命中：${hits}`)
  for (const d of r.injectedIds) {
    const ev = active
      .map((c) => {
        const v = r.quoted[c.id]?.[d]
        if (v?.__error) return `${c.id}=ERR`
        if (typeof v?.score === 'number') return `${c.id}=${v.score.toFixed ? v.score.toFixed(3) : v.score}${v.hit ? '✓' : ''}`
        return `${c.id}=${v?.hit ? '✓' : '-'}`
      })
      .join(' ')
    sample.push(`  ${d}  ${ev}`)
    for (const c of active) {
      const v = r.quoted[c.id]?.[d]
      if (v?.evidence) sample.push(`      [${c.id}] ${String(v.evidence).slice(0, 110)}`)
    }
  }
  sample.push('  判定：□真用了  □碰巧  □无法判断', '')
}
writeFileSync(join(OUT, 'adoption-sample-50.md'), sample.join('\n'))

log('')
for (const l of lines.slice(0, 14)) log(l)
log('')
log(`产物：${OUT}/adoption-rounds.jsonl ｜ adoption-summary.md ｜ adoption-sample-50.md`)
log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
