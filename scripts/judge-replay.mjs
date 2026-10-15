#!/usr/bin/env node
/**
 * judge-replay.mjs —— **直连模型**的判官（2026-10-15）
 *
 * 用户定的做法：「你直接构造一个一样的请求不好吗？上下文一个字不变，只追加提问：
 * 『哪些召回的记忆对你起到了真正的作用』」——**不经过 subagent**（那层包装本身就是"翻译"：
 * 它给子代理套了自己的系统提示词、工具面，还让子代理去"读文件"，等于把材料当文档递给它看，
 * 而不是让它站在当时的位置上回想）。
 *
 * 输入 = `probe-injection-adoption.mjs --packets` 吐出的 `req-NN.json`
 *   （里面是按真实 role 顺序重建的 messages：用户消息 / 注入块原文 / 助手回复 / 工具返回）
 * 动作 = 末尾**只追加一条 user 提问**，整包发给模型
 * 输出 = 模型的原话（同时可落盘，供外置判据）
 *
 * 凭证：`~/.dsh/.credentials.yaml` 的 `refs:` 段（明文）。**不打印密钥。**
 * 端点：provider `zai-coding-cn`（`@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/providers/zai-coding-cn.js`）
 *
 * 用法：
 *   node scripts/judge-replay.mjs /tmp/labG/judge-packets/req-01.json
 *   node scripts/judge-replay.mjs --dir /tmp/labG/judge-packets --limit 3 --out /tmp/labG/verdicts
 *   node scripts/judge-replay.mjs req-01.json --model glm-5.3 --question '自定义提问'
 *   node scripts/judge-replay.mjs req-01.json --dry-run     # 只拼请求、不发送（查体积/角色序）
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import httpsMod from 'node:https'

const ARGS = process.argv.slice(2)
const arg = (n, d) => {
  const i = ARGS.indexOf(`--${n}`)
  return i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--') ? ARGS[i + 1] : d
}
const flag = (n) => ARGS.includes(`--${n}`)
const FREE = (() => {
  // ⚠️ 不能再写 ARGS.filter(a => !a.startsWith('--'))——那会把 `--concurrency 5` 的值 `5`
  // 也当输入文件（首跑就报 ENOENT: open '5'）。必须跳过紧跟 --flag 的值。
  const out = []
  for (let i = 0; i < ARGS.length; i++) {
    if (ARGS[i].startsWith('--')) { if (ARGS[i + 1] && !ARGS[i + 1].startsWith('--')) i++; continue }
    out.push(ARGS[i])
  }
  return out
})()

const BASE_URL = arg('url', 'https://open.bigmodel.cn/api/coding/paas/v4')
const MODEL = arg('model', 'glm-5.3-flash')
// ⚠️ 必须显式挡住"接着干原任务"：实测 genshin-ts 那轮模型回了「继续。先补最后一批取证…」，
// 完全无视提问（因为上下文末尾是它自己的助手回复，追加的 user 提问被读成"继续"）。
const QUESTION = arg('question',
  '【元问题·不要继续原任务】上面那些自动召回并注入的记忆里，哪些对你起到了真正的作用？' +
  // ⚠️ 2026-10-15 修：**标签必须逐条机读**。原来只要自由文本，导致候选级标签不可靠——
  // 我用正则从 27 份裁决里抽出 281 条候选标签，得到 used 率 **23%**，而同一批的 SUMMARY
  // 汇总只有 **12%**（差 11 个点）。差异来源：散文行里一条提及多个 D 编号、以及正/负向词
  // 同句共存。**决策模型实验需要干净的 per-candidate 标签**，所以强制一行一候选。
  '只回答这个问题，不要接着做原任务。**每个候选条目单独一行**，格式严格为：' +
  '`CAND D<编号> used|topic|unused <理由≤40字>`（used=真起作用且能指到具体决策 / topic=只是话题相关 / unused=没用上；引错的写 `CAND D<编号> harmful <理由>`）。' +
  '正文里可另写归纳，但**标签行必须一行一候选、不得合并**。' +
  // 汇总行是**输出格式**要求，不碰输入（输入仍是一字不改的原文）——首版自由文本没法机器聚合：
  // 我的正则把「D262」当成数字 2/262，算出「注入 1 条起作用 2 条」这种不可能值。
  ' 最后单独一行给汇总，格式严格为：SUMMARY 注入=<本块条目总数> 起作用=<真正起作用的条数> 反作用=<引错的条数>')
const DIR = arg('dir', '')
const LIMIT = Number(arg('limit', 0))
const OUT = arg('out', '')
const DRY = flag('dry-run')
/** 并发数：每轮 glm-flash 要花 3000+ 推理 token，串行太慢（用户 2026-10-15「速度有点慢了」）。
 *  并发只影响吞吐，不影响每一发的请求内容——上下文仍是一字不改的原文。 */
const CONC = Math.max(1, Number(arg('concurrency', 4)))
const TIMEOUT_SEC = Math.max(30, Number(arg('timeout-sec', 900)))  // 单发上限；实测最慢 286s
/** 提速的唯一真杠杆：**推理 token**（实测单发 2400-5900 个 reasoning_tokens，占掉绝大部分墙钟）。
 *  prompt 缓存实测**不命中**（同一请求连发两次 cached_tokens=0），且即便命中也不省生成时间。
 *  `--think off` 试关思考；`--think low|medium|high` 试标准档位。 */
const THINK = String(arg('think', 'default'))

/* ── 凭证：~/.dsh/.credentials.yaml 的 refs 段。只读需要的那个键，不打印值 ── */
function readCredential(name) {
  const fromEnv = process.env[name]
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  const p = join(homedir(), '.dsh', '.credentials.yaml')
  const txt = readFileSync(p, 'utf8')
  let inRefs = false
  for (const line of txt.split('\n')) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue }
    if (!inRefs) continue
    if (/^\S/.test(line) && line.trim()) break     // 离开 refs 段
    const m = line.match(/^\s+([A-Za-z0-9_]+):\s*(\S+)\s*$/)
    if (m && m[1] === name) return m[2]
  }
  throw new Error(`凭证 ${name} 未在 ~/.dsh/.credentials.yaml 的 refs 段找到`)
}

const KEY = readCredential('ZAI_CODING_CN_API_KEY')

/* ── 组包：原样 messages + 末尾只追加一条提问 ── */
function buildPayload(req) {
  const messages = req.messages.map((m) => ({ role: m.role, content: m.content }))
  // 末尾若已是 user（工具返回），提问直接并进这一条，避免连续同角色被端点拒
  const last = messages[messages.length - 1]
  if (last && last.role === 'user') last.content += `\n\n【提问】${QUESTION}`
  else messages.push({ role: 'user', content: QUESTION })
  const body = { model: MODEL, messages, temperature: 0.2, stream: false }
  if (THINK === 'off') body.thinking = { type: 'disabled' }
  else if (THINK !== 'default') body.reasoning_effort = THINK
  return body
}

/**
 * ⚠️ 必须用 node:https，**不能用 fetch**：undici 的 `headersTimeout` 默认 300s，
 * 它会在模型还没吐完时就掐断，报成 `TypeError: fetch failed`——而这是**与我设的
 * TIMEOUT_SEC 无关的第二个 300s**（实测同一轮连续两次都恰好卡在 300s，即使传了
 * `--timeout-sec 1200`）。用 https 才拿得回超时控制权。
 */
function callOnce(payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${BASE_URL}/chat/completions`)
    const body = JSON.stringify(payload)
    const req = httpsMod.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${KEY}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: TIMEOUT_SEC * 1000,
    }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { raw += c })
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 400)}`))
        }
        try {
          const j = JSON.parse(raw)
          resolve({ content: j.choices?.[0]?.message?.content ?? '', usage: j.usage, model: j.model })
        } catch (e) { reject(new Error(`响应不是 JSON：${raw.slice(0, 200)}`)) }
      })
    })
    req.on('timeout', () => { req.destroy(new Error(`本地超时 ${TIMEOUT_SEC}s`)) })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

const files = DIR
  ? readdirSync(DIR).filter((f) => /^req-\d+\.json$/.test(f)).sort().slice(0, LIMIT > 0 ? LIMIT : undefined).map((f) => join(DIR, f))
  : FREE.map((f) => f)

if (files.length === 0) { console.error('用法：node scripts/judge-replay.mjs <req-NN.json | --dir DIR>'); process.exit(2) }
if (OUT) mkdirSync(OUT, { recursive: true })

async function runOne(f) {
  const req = JSON.parse(readFileSync(f, 'utf8'))
  const payload = buildPayload(req)
  const chars = payload.messages.reduce((n, m) => n + m.content.length, 0)
  const head = `${basename(f)}  桶=${req.bucket}  注入=${req.injectedIds.length}条  messages=${payload.messages.length}  ${chars}字`
  if (DRY) { console.log(`[dry] ${head}`); return null }
  const t0 = Date.now()
  try {
    const r = await callOnce(payload)
    const secs = ((Date.now() - t0) / 1000).toFixed(0)
    console.log(`\n════ ${head} ════  ${secs}s`)
    console.log(r.content)
    if (OUT) {
      // ⚠️ 作用域必须取 req 里的**真实桶名**：所有题面都写在同一个 judge-packets/ 里，
      // 用产物目录名会让跨桶的 req-01 互相覆盖（实测 24 发只剩 <24 个文件）。
      const scope = String(req.bucket || basename(join(f, '..', '..'))).replace(/[^\w.-]+/g, '_')
      writeFileSync(join(OUT, `${scope}-${basename(f).replace(/^req-/, 'v').replace(/\.json$/, '.md')}`),
        `<!-- ${head} -->\n<!-- question: ${QUESTION} -->\n<!-- evidence: 上下文原样 + 末尾追加提问，${payload.messages.length} 条消息 / ${chars} 字；模型 ${r.model ?? MODEL}；usage=${JSON.stringify(r.usage)} -->\n\n${r.content}\n`)
    }
    return { f, secs }
  } catch (e) {
    console.error(`✗ ${basename(f)} 调用失败：${String(e).slice(0, 200)}`)
    return null
  }
}

const t0 = Date.now()
for (let i = 0; i < files.length; i += CONC) {
  const batch = files.slice(i, i + CONC)
  await Promise.all(batch.map(runOne))
}
if (!DRY) console.log(`\n共 ${files.length} 发，并发 ${CONC}，总耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`)
if (OUT) console.log(`裁决已落盘：${OUT}/`)
