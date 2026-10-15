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
const QUESTION = arg('question', '哪些召回的记忆对你起到了真正的作用？')
const DIR = arg('dir', '')
const LIMIT = Number(arg('limit', 0))
const OUT = arg('out', '')
const DRY = flag('dry-run')
/** 并发数：每轮 glm-flash 要花 3000+ 推理 token，串行太慢（用户 2026-10-15「速度有点慢了」）。
 *  并发只影响吞吐，不影响每一发的请求内容——上下文仍是一字不改的原文。 */
const CONC = Math.max(1, Number(arg('concurrency', 4)))
const TIMEOUT_SEC = Math.max(30, Number(arg('timeout-sec', 900)))  // 单发上限；glm-flash 长思考+长上下文实测最慢 153s，留足余量

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
  return { model: MODEL, messages, temperature: 0.2, stream: false }
}

async function callOnce(payload) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_SEC * 1000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`)
  const j = JSON.parse(text)
  const content = j.choices?.[0]?.message?.content ?? ''
  return { content, usage: j.usage, model: j.model }
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
      const scope = basename(join(f, '..', '..'))   // 产物目录名（含桶）
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
