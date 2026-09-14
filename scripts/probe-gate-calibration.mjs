// 票04 探针：gate 短指令死区生产标注集 + 三修法分离度（阶段1=吐事件待标注；阶段2=带标注算指标）
// 语料：preset-composer 生产桶 36 篇日记全文嵌入（与生产 chunk 同口径：一篇一全文向量）。
// 事件：桶日志全部 inject / gate-skip 行 × 会话事件流里的「最后真实用户消息」「最后助手实质文本」。
import { rmSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import { acquireWorkspace } from '../lib/workspace.js'
import { workspacePaths } from '../lib/runtime.js'
import { Config as ConfigSchema } from '../lib/index.js'

const BUCKET_ROOT = '/home/h/.dsh/memo-river/a92f187fa21e8a80'
const SESSION_FILE = '/home/h/.dsh/sessions/--home-h-app-dsh-preset-composer--/session-712451cc-9b24-4eda-af25-3f2f185429a3/session.v3.jsonl.zstd'
const LABELS = {
  // 17 条 gate-skip 逐条人工核对（2026-09-14）：全部是项目工作指令 = 任务内应放行（误杀）。
  // 交叉验证：retr 0.69-0.80（窗口在题上）+ gA 0.76-0.88（助手工作陈述在题上）。
  '09-13 17:12': 1, '09-13 17:51': 1, '09-13 17:55': 1, '09-13 18:28': 1, '09-13 19:12': 1,
  '09-13 19:14': 1, '09-13 19:16': 1, '09-13 19:20': 1, '09-13 19:51': 1, '09-13 19:53': 1,
  '09-13 19:55': 1, '09-13 20:20': 1, '09-13 20:22': 1, '09-13 21:34': 1, '09-13 21:37': 1,
  '09-13 21:41': 1, '09-14 11:03': 1,
}
// 合成负样本：明确任务外的用户/助手文本（评估三修法的假阳性面）
const NEGATIVES = [
  '今天天气怎么样？适合出去走走吗？',
  '帮我写一首关于秋天的短诗，四行就够。',
  '这个游戏第三关的Boss有什么打法技巧？',
  '我想给朋友订个生日蛋糕，附近哪家店好评多一点？',
  '昨晚没睡好，今天一直犯困，有什么提神的好办法？',
  '推荐几部最近值得看的电影吧，科幻类的。',
  '怎么把家里路由器的信号弄得好一点？',
  '小孩明年上小学，学区房值得买吗？',
]

const cwd = join(tmpdir(), `probe-gate-${process.pid}`)
const bucket = 'gate探针'
const paths = workspacePaths(cwd, bucket)
rmSync(cwd, { recursive: true, force: true })
rmSync(paths.root, { recursive: true, force: true })
mkdirSync(cwd, { recursive: true })
const ws = acquireWorkspace(cwd, ConfigSchema({ bucket, native: { vcpRoot: '/home/h/app/VCPToolBox' } }))
const dim = ws.resolved.dimension
const cos = (a, b) => {
  let d = 0, x = 0, y = 0
  for (let i = 0; i < dim; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i] }
  return d / Math.sqrt(x * y)
}

/* ── ① 语料向量：生产桶 36 篇全文 ── */
const dir = join(BUCKET_ROOT, 'dailynote/dsh-preset-composer')
const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
const corpusTexts = files.map((f) => readFileSync(join(dir, f), 'utf8'))
const corpusVecs = await ws.embed.embed(corpusTexts)
const maxKnn = (v) => {
  let m = 0
  for (const c of corpusVecs) { const s = cos(v, c); if (s > m) m = s }
  return m
}

/* ── ② 会话时间线：真实用户消息 + 助手实质文本 ── */
const raw = execSync(`zstd -dc ${SESSION_FILE}`, { maxBuffer: 256 * 1024 * 1024 }).toString()
const users = [] // {t, text}
const assts = [] // {t, text}
for (const line of raw.split('\n')) {
  if (!line.trim()) continue
  let e
  try { e = JSON.parse(line) } catch { continue }
  const d = e.get?.('data') ?? e.data
  if (!d) continue
  const t = e.time ?? e.get?.('time') ?? 0
  if (e.type === 'user/message') {
    const src = d.source ?? {}
    if (src.kind !== 'user') continue
    const txt = (d.content ?? []).filter((c) => c?.type === 'text').map((c) => c.text ?? '').join('').trim()
    if (txt && !txt.startsWith('<')) users.push({ t, text: txt })
  } else if (e.type === 'assistant/message') {
    const m = d.message ?? {}
    const txt = (m.content ?? []).filter((c) => c?.type === 'text').map((c) => c.text ?? '').join('').trim()
    if (txt.length > 150) assts.push({ t, text: txt })
  }
}
const lastBefore = (arr, t) => {
  let r = null
  for (const x of arr) { if (x.t <= t) r = x; else break }
  return r
}

/* ── ③ 桶日志事件 ── */
const logLines = readFileSync(join(BUCKET_ROOT, 'memo-river.log'), 'utf8').split('\n')
const events = []
for (const l of logLines) {
  const tm = l.match(/^\[(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/)
  if (!tm || !l.includes('[info] inject')) continue
  const t = new Date(`${tm[1]}T${tm[2]}Z`).getTime()
  const kind = l.includes('inject-skip') ? 'skip' : 'inject'
  const gate = l.match(/"maxKnn":([0-9.]+)/)
  const retr = l.match(/"retrievalMaxKnn":([0-9.]+)/)
  if (kind === 'skip' && !l.includes('gate-below-threshold')) continue
  events.push({ t, kind, gate: gate ? +gate[1] : null, retr: retr ? +retr[1] : null, ids: (l.match(/ids=([A-Z0-9,]+)/) || [])[1] ?? '' })
}

/* ── ④ 每事件：重算 gU（用户锚）与 gA（助手锚） ── */
const key = (t) => {
  const d = new Date(t + 8 * 3600_000)
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
const rows = []
for (const ev of events) {
  const u = lastBefore(users, ev.t)
  const a = lastBefore(assts, ev.t)
  const gU = u ? maxKnn((await ws.embed.embed([u.text]))[0]) : null
  const gA = a ? maxKnn((await ws.embed.embed([a.text.slice(0, 1200)]))[0]) : null
  rows.push({
    key: key(ev.t), kind: ev.kind, logGate: ev.gate, retr: ev.retr, gU, gA,
    uLen: u?.text.length ?? 0, uHead: (u?.text ?? '').slice(0, 55).replace(/\n/g, ' '),
    label: LABELS[key(ev.t)] ?? null,
  })
}

/* ── ⑤ 输出 ── */
console.log(`事件 ${rows.length}（inject=${rows.filter((r) => r.kind === 'inject').length} / gate-skip=${rows.filter((r) => r.kind === 'skip').length}）`)
console.log('── gate-skip 事件（待人工标注：1=任务内应放行 / 0=任务外应压制）──')
for (const r of rows.filter((r) => r.kind === 'skip'))
  console.log(`  "${r.key}": ${r.logGate != null && r.gU != null && Math.abs(r.logGate - r.gU) < 0.06 ? '' : '⚠重算偏差 '}gU=${r.gU?.toFixed(3)} gA=${r.gA?.toFixed(3)} retr=${r.retr?.toFixed(3)} | ${r.uLen}字 ${r.uHead}`)
console.log('── inject 事件（gU 重算应 ≥0.55 = 方法自洽校验）──')
let okN = 0, tot = 0
for (const r of rows.filter((r) => r.kind === 'inject')) {
  if (r.gU == null) continue
  tot++
  if (r.gU >= 0.55) okN++
}
console.log(`  自洽：${okN}/${tot} 注入事件 gU≥0.55（低分者=当时的门控向量另有其文，如助手文本或回退）`)
console.log('  低分注入样本：')
for (const r of rows.filter((r) => r.kind === 'inject' && r.gU != null && r.gU < 0.55).slice(0, 8))
  console.log(`    ${r.key} gU=${r.gU.toFixed(3)} gA=${r.gA?.toFixed(3)} | ${r.uLen}字 ${r.uHead}`)

/* ── 阶段2：三修法分离度（正=17 误杀应放行；负=8 合成任务外文本应压制）── */
console.log('\n══ 阶段2：三修法分离度 ══')
const pos = rows.filter((r) => r.kind === 'skip' && r.label === 1)
const negVecs = await ws.embed.embed(NEGATIVES.map((t) => `问：${t}\n答：${t}`))
const negStats = negVecs.map((v) => ({ gu: maxKnn(v), ga: maxKnn(v) }))
// 负样本的「助手锚」用同文本自问答近似（任务外回合的助手文本同样离题）
const method = (name, passFn) => {
  const fn = pos.filter((r) => !passFn(r)).length
  const fp = negStats.filter((n) => passFn({ gU: n.gu, gA: n.ga, retr: n.gu + 0.1, logGate: n.gu })).length
  console.log(`  ${name}: 漏放(误杀)=${fn}/${pos.length}  误放(任务外注入)=${fp}/${negStats.length}`)
}
method('现状 gU@0.55                    ', (r) => (r.gU ?? 0) >= 0.55)
method('B    gU@0.42（阈值下移死区下沿） ', (r) => (r.gU ?? 0) >= 0.42)
method('A    max(gU,gA)@0.55（锚拼接）  ', (r) => Math.max(r.gU ?? 0, r.gA ?? 0) >= 0.55)
method('C    gU@0.55 ∨ retr−gU>0.25    ', (r) => (r.gU ?? 0) >= 0.55 || (r.retr ?? 0) - (r.gU ?? 0) > 0.25)
method('A+C  max(gU,gA)@0.55 ∨ 分歧>0.25', (r) => Math.max(r.gU ?? 0, r.gA ?? 0) >= 0.55 || (r.retr ?? 0) - (r.gU ?? 0) > 0.25)
console.log(`  负样本 gU 范围：${Math.min(...negStats.map((n) => n.gu)).toFixed(3)}~${Math.max(...negStats.map((n) => n.gu)).toFixed(3)}`)
console.log('  skip 集 gA 范围：' + Math.min(...pos.map((r) => r.gA)).toFixed(3) + '~' + Math.max(...pos.map((r) => r.gA)).toFixed(3))

ws.store.close?.()
rmSync(cwd, { recursive: true, force: true })
rmSync(paths.root, { recursive: true, force: true })
