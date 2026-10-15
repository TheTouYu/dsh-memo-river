#!/usr/bin/env node
/**
 * probe-stale-blind.mjs —— H3 时效签盲测（SPEC-2026-10-16 §6，2026-10-16）
 *
 * 问题：主模型读到「新旧同主题记忆共现」的注入块时，时效签能否把旧篇误引率压下来？
 * 设计：4 臂 × 2 位置 × 6 对断言冲突（D308 定稿）。受试者=glm-5.3-flash（生成模型，
 *       模拟生产主模型行为——编目员是 0.8B，受试者不是编目员，角色勿混）。
 *   臂 A：无签基线（现状渲染）
 *   臂 B：静态时间戳 `[10-14]`（分离「知道多旧」的贡献）
 *   臂 C：语义时效签 `[快照@10-14][易逝] ⚠️同主题存在D<new> 判定:SUPERSEDED(p=0.72)`
 *   臂 D：安慰剂——同款 ⚠️ 但指向无关真篇 D50（若 D≈C ⇒ 纯记号注意力效应；D 无效 C 有效 ⇒ 语义指向才关键）
 * 位置 oldFirst/newFirst：控 LLM recency 偏好（arXiv:2509.11353）。
 * 判分：newKeys 命中=correct / oldKeys 命中=stale / 双中=mixed / 空=unclear（后两者人工复核）。
 *
 * 判官协议照 recall-effect-audit：node:https 直连（undici fetch 有 300s headersTimeout 坑）、
 * thinking disabled、温度 0.2、元问题前缀防「继续原任务」。
 *
 * 用法：
 *   node scripts/probe-stale-blind.mjs --dry-run                 # 看 A/C 臂渲染
 *   node scripts/probe-stale-blind.mjs --pair P1                 # 单对 8 发
 *   node scripts/probe-stale-blind.mjs --arm A,C --pos oldFirst  # 限臂限位置
 *   node scripts/probe-stale-blind.mjs --out /tmp/stale-blind    # 全量 48 发
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import httpsMod from 'node:https'
import { execSync } from 'node:child_process'

/* ── CLI ── */
const ARGS = process.argv.slice(2)
const arg = (n, d) => { const i = ARGS.indexOf(`--${n}`); return i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--') ? ARGS[i + 1] : d }
const DRY = ARGS.includes('--dry-run')
const OUT = arg('out', '')
const CONC = Math.max(1, Number(arg('concurrency', 4)))
const PAIR_FILTER = arg('pair', '')
const ARM_FILTER = arg('arm', '').split(',').filter(Boolean)
const POS_FILTER = arg('pos', '')

/* ── 判官通道（照 judge-replay.mjs 实测坑清单） ── */
const BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4'
const MODEL = arg('model', 'glm-5.3-flash')
function readCredential(name) {
  const fromEnv = process.env[name]
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  const txt = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  let inRefs = false
  for (const line of txt.split('\n')) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue }
    if (!inRefs) continue
    if (/^\S/.test(line) && line.trim()) break
    const m = line.match(/^\s+([A-Za-z0-9_]+):\s*(\S+)\s*$/)
    if (m && m[1] === name) return m[2]
  }
  throw new Error(`凭证 ${name} 未找到`)
}
const KEY = readCredential('ZAI_CODING_CN_API_KEY')

function callOnce(messages) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${BASE_URL}/chat/completions`)
    const body = JSON.stringify({ model: MODEL, messages, temperature: 0.2, stream: false, thinking: { type: 'disabled' } })
    const req = httpsMod.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}`, 'Content-Length': Buffer.byteLength(body) },
      timeout: 300000,
    }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { raw += c })
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 300)}`))
        try { resolve(JSON.parse(raw).choices?.[0]?.message?.content ?? '') } catch { reject(new Error(`非 JSON：${raw.slice(0, 150)}`)) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('本地超时 300s')))
    req.on('error', reject)
    req.write(body); req.end()
  })
}

/* ── 桶与正文（只读真源：files.path → md 文件） ── */
const BUCKET = join(homedir(), '.dsh/memo-river/b94d8836d6175817')
const DB = join(BUCKET, 'knowledge_base.sqlite')
function loadEntry(d) {
  // SQLite 字符串字面量不认 \t 转义（拼出字面反斜杠t）——分两次查询最稳
  const q = (col) => execSync(`sqlite3 "${DB}" "SELECT ${col} FROM files WHERE id=${d}"`).toString().trim()
  const path = q('path')
  if (!path) throw new Error(`D${d} 不在 files 表`)
  const diaryName = q('diary_name')
  const md = readFileSync(path, 'utf8')
  const date = (path.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] ?? '????-??-??'
  const title = (md.match(/^#\s+(.+)$/m) || [])[1]?.slice(0, 60) ?? `D${d}`   // diary_name 是桶名，真标题在 md 首行
  const body = md.split('\n').filter((l) => !l.startsWith('# ')).join('\n').replace(/\n{3,}/g, '\n\n').slice(0, 600)
  return { d, title, date, dateShort: date.slice(5), body }
}

/* ── 六对断言冲突（D308 定稿；oldKeys/newKeys 须防子串互吞，mixed/unclear 人工兜底） ── */
const PAIRS = [
  {
    id: 'P1-skip',
    old: 214, new: 230,
    question: '现在记忆注入链路的嵌入超时/跳过情况怎么样？给出现状数字。',
    oldKeys: ['45', '50%', 'skip 率', '跳过率', '3s', '3000ms', '硬顶'],
    newKeys: ['归零', '超顶', '8000', '8s', '8 秒', '1949', '预算'],
  },
  {
    id: 'P2-gpu',
    old: 248, new: 262,
    question: 'chinese-decision-0.8b 在本机做单次判别读出，本地跑可行吗？单次延迟多少？',
    oldKeys: ['不可行', '不成立', '1.8', '4.4', '数量级'],
    newKeys: ['0.15', '150ms', '0.68', 'GPU'],
  },
  {
    id: 'P3-sigbus',
    old: 173, new: 175,
    question: '之前遇到的 SIGBUS 崩溃，根因定性是什么？',
    oldKeys: ['游移', '竞态', '未定', '待查'],
    newKeys: ['锁盲区', 'fcntl', '两份 sqlite', 'keepalive', '读写混合'],
  },
  {
    id: 'P4-portal',
    old: 187, new: 194,
    question: 'portal 键盘输入通道可靠吗？有什么已知问题？',
    oldKeys: ['免授权', '直通'],
    newKeys: ['乱键', '不可靠'],
  },
  {
    id: 'P5-huohua',
    old: 274, new: 282,
    question: '读侧残差选择（火花①）项目现在什么状态？原因是什么？',
    oldKeys: ['冻结', '高冗余'],
    newKeys: ['退役', '0.90', '干净', '0 对'],
  },
  {
    id: 'P6-batch',
    old: 265, new: 272,
    question: '嵌入写路径合批 vs 拆批的延迟对比，最终结论是什么？',
    oldKeys: ['49%', '662'],
    newKeys: ['55%', '860', 'padding'],
  },
]

/* ── 渲染 ── */
function headerLine(e, arm, pair, isOld) {
  if (arm === 'C2' && isOld) {
    return `D${e.d}「${e.title}」 [已被D${pair.newId}@${pair.newE.dateShort} 取代，正文折叠]`
  }
  let h = `D${e.d}「${e.title}」`
  if (arm === 'B') h += ` [${e.dateShort}]`
  if ((arm === 'C' || arm === 'D') && isOld) {
    const pointer = arm === 'C' ? `D${pair.newId}` : 'D50'
    h += ` [快照@${e.dateShort}][易逝] ⚠️同主题存在${pointer} 判定:SUPERSEDED(p=0.72)`
  }
  return h
}
function render(pair, arm, pos) {
  const seq = pos === 'oldFirst' ? ['old', 'new'] : ['new', 'old']
  const blocks = seq.map((side) => {
    const isOld = side === 'old'
    const e = isOld ? pair.oldE : pair.newE
    const body = (arm === 'C2' && isOld) ? '（正文折叠：本篇断言已被同主题新篇取代，不再注入）' : e.body
    return `${headerLine(e, arm, pair, isOld)}\n  ${body}`
  }).join('\n')
  return [
    '你是工程代理，正在处理工作区的运维任务。以下是记忆系统自动召回并注入的历史日记片段：',
    '',
    '⟨memo-river·被动召回⟩',
    '[记忆河流·被动召回 | 本桶=dsh-memo-river | mode=topology_v3 | 动态K×1]',
    blocks,
    '⟨/memo-river⟩',
    '',
    `【元问题·不要继续原任务】只回答这个问题，第一行必须以「现状：」开头给一句话结论（只陈述当前有效的数字/状态，不要在现状行里提历史值），然后可用一两句补充：${pair.question}`,
  ].join('\n')
}

/* ── 判分：锚「现状：」行（P1 实测教训：受试者答「旧 45%→现归零」的对照式正确回答会两组词都命中→mixed；
        现状行只允许当前值，历史值若泄进现状行才算真误引）── */
function score(text, oldKeys, newKeys) {
  const m = text.match(/现状[：:]\s*([^\n]*)/)
  const target = m ? m[1] : text          // 无「现状：」行时退回全文（记 verdict 供人工看）
  const src = m ? target : text
  const nHit = newKeys.filter((k) => src.includes(k))
  const oHit = oldKeys.filter((k) => src.includes(k))
  if (nHit.length && !oHit.length) return { verdict: 'correct', nHit, oHit, anchored: !!m }
  if (oHit.length && !nHit.length) return { verdict: 'stale', nHit, oHit, anchored: !!m }
  if (oHit.length && nHit.length) return { verdict: 'mixed', nHit, oHit, anchored: !!m }
  return { verdict: 'unclear', nHit, oHit, anchored: !!m }
}

/* ── 主流程 ── */
const arms = ARM_FILTER.length ? ARM_FILTER : ['A', 'B', 'C', 'D']
const poss = POS_FILTER ? [POS_FILTER] : ['oldFirst', 'newFirst']
const pairs = (PAIR_FILTER ? PAIRS.filter((p) => PAIR_FILTER.split(',').includes(p.id)) : PAIRS)
  .map((p) => {
    const oldE = loadEntry(p.old), newE = loadEntry(p.new)
    return { ...p, oldE, newE, newId: p.new }
  })

if (DRY) {
  const sample = pairs[0] ?? PAIRS[0]
  if (sample.oldE) {
    console.log('════ 臂A / oldFirst ════\n' + render(sample, 'A', 'oldFirst'))
    console.log('\n════ 臂C / oldFirst ════\n' + render(sample, 'C', 'oldFirst'))
  }
  console.log(`\n[dry] 对=${pairs.length} 臂=${arms.join(',')} 位置=${poss.join(',')} 总发数=${pairs.length * arms.length * poss.length}`)
  process.exit(0)
}

const jobs = []
for (const p of pairs) for (const arm of arms) for (const pos of poss) jobs.push({ p, arm, pos })
if (OUT) mkdirSync(OUT, { recursive: true })

const results = []
let done = 0
async function runJob(j) {
  const prompt = render(j.p, j.arm, j.pos)
  const t0 = Date.now()
  try {
    const reply = await callOnce([{ role: 'user', content: prompt }])
    const s = score(reply, j.p.oldKeys, j.p.newKeys)
    const row = { pair: j.p.id, arm: j.arm, pos: j.pos, secs: +((Date.now() - t0) / 1000).toFixed(0), verdict: s.verdict, nHit: s.nHit, oHit: s.oHit, reply: reply.slice(0, 500) }
    results.push(row); done++
    console.log(`[${done}/${jobs.length}] ${j.p.id} ${j.arm}/${j.pos} → ${s.verdict} (${row.secs}s)  ${(s.nHit.length ? 'new:' + s.nHit.join('|') : '')}${(s.oHit.length ? ' old:' + s.oHit.join('|') : '')}`)
    if (OUT) writeFileSync(join(OUT, `${j.p.id}-${j.arm}-${j.pos}.md`), `<!-- ${j.p.id} ${j.arm}/${j.pos} verdict=${s.verdict} -->\n${reply}\n`)
    return row
  } catch (e) {
    console.error(`✗ ${j.p.id} ${j.arm}/${j.pos}: ${String(e).slice(0, 160)}`)
    results.push({ pair: j.p.id, arm: j.arm, pos: j.pos, verdict: 'error', error: String(e).slice(0, 200) })
  }
}
const t0 = Date.now()
for (let i = 0; i < jobs.length; i += CONC) await Promise.all(jobs.slice(i, i + CONC).map(runJob))

/* 汇总：臂 × 位置 的 stale/correct 矩阵 */
const cell = {}
for (const r of results) {
  if (r.verdict === 'error') continue
  const k = `${r.arm}/${r.pos}`
  cell[k] = cell[k] ?? { stale: 0, correct: 0, mixed: 0, unclear: 0 }
  cell[k][r.verdict]++
}
console.log(`\n════ 汇总（总耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s）════`)
console.log('格\tstale\tcorrect\tmixed\tunclear\tstale率')
for (const arm of arms) for (const pos of poss) {
  const c = cell[`${arm}/${pos}`] ?? { stale: 0, correct: 0, mixed: 0, unclear: 0 }
  const tot = c.stale + c.correct + c.mixed + c.unclear
  console.log(`${arm}/${pos}\t${c.stale}\t${c.correct}\t${c.mixed}\t${c.unclear}\t${tot ? (c.stale / tot * 100).toFixed(0) + '%' : '-'}`)
}
// 臂级聚合（合并位置）
console.log('\n臂\tstale\tcorrect\tmixed\tunclear\tstale率')
for (const arm of arms) {
  const c = { stale: 0, correct: 0, mixed: 0, unclear: 0 }
  for (const pos of poss) { const x = cell[`${arm}/${pos}`]; if (x) for (const k of Object.keys(c)) c[k] += x[k] }
  const tot = c.stale + c.correct + c.mixed + c.unclear
  console.log(`${arm}\t${c.stale}\t${c.correct}\t${c.mixed}\t${c.unclear}\t${tot ? (c.stale / tot * 100).toFixed(0) + '%' : '-'}`)
}
if (OUT) {
  writeFileSync(join(OUT, 'results.jsonl'), results.map((r) => JSON.stringify(r)).join('\n') + '\n')
  console.log(`\n产物落盘：${OUT}/`)
}
