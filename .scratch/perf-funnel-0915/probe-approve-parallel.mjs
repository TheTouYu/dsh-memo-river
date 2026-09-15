// 票 04 探针：memo_approve 并行批处理 vs 串行基线 + 混合批次部分成功语义。
//
// 判据（票面验收）：
//  A. 串行基线（MEMO_APPROVE_CONCURRENCY=1）：嵌入请求逐一发出（服务端实测 maxConcurrent=1），
//     6 篇可批草稿墙钟 ≈ 6×RTT。
//  B. 并行（缺省 5）：服务端实测 maxConcurrent≥4（有界 5）；墙钟 < 串行/2；
//     库内 files +6、approved/ 6 文件、pending 残留 1（Tag 不足者），无半写。
//  C. 部分成功语义：Tag 不足篇逐条说明（⏭ …可复用 Tag 仅 0 个…）且留在 pending/；
//     其余 ✅ 入库；无「处理异常」兜底行（闸门链在并发下不炸）。
//  D. 进度汇报：中央日志通道逐篇收到 progress=i/N。
//
// 运行：node .scratch/perf-funnel-0915/probe-approve-parallel.mjs
// （父进程两次自再入：MEMO_APPROVE_CONCURRENCY=1 / =5 —— 并行度是模块加载期常量，
//   与 embed.ts TAG_VECTORIZE_CONCURRENCY 同款，进程外对比才忠实。）
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const VCP = '/home/h/app/VCPToolBox'
const RTT_MS = 1200 // 实测 relay 单条 embed RTT 1.19–1.45s 的代表值
const DIM = 8

/* ── 模拟嵌入端点：按文本哈希出确定性向量（异文余弦 ~0.6 < 去重/同义阈值 0.95/0.92），
 *    固定 RTT，统计在飞并发峰值。同批多条 input 也按各自文本出向量。 ── */
const hashVec = (text) => {
  let h = 2166136261
  for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0
  return Array.from({ length: DIM }, (_, j) => ((h >>> (j % 32)) & 1) === 1 ? 1 : 0.1)
}

async function child() {
  const { Config } = await import('../../lib/index.js')
  const { installTools } = await import('../../lib/tools.js')
  const { acquireWorkspace } = await import('../../lib/workspace.js')

  let inFlight = 0
  let maxInFlight = 0
  let requests = 0
  const resetStats = () => {
    inFlight = 0
    maxInFlight = 0
    requests = 0
  }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      requests += 1
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      const input = JSON.parse(body).input
      setTimeout(() => {
        inFlight -= 1
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ data: input.map((t, i) => ({ index: i, embedding: hashVec(t) })) }))
      }, RTT_MS)
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  const BUCKET = '批准并行探针'
  const cwd = mkdtempSync(join(tmpdir(), 'probe-approve-'))

  // 孤儿清理：前次（或崩溃前）子进程在 ~/.dsh/memo-river/ 下留下的探针根——不删会被
  // all=true + bucket 过滤扫进本批（实测污染过一跑：targets 7→8/9）。只删「桶=本探针
  // 且 cwd 指向已消失的探针临时目录」的根，绝不触碰任何生产桶。
  const { memoRiverRoot, workspacePaths, readJsonSafe } = await import('../../lib/runtime.js')
  const purgeOrphans = () => {
    let roots = []
    try {
      roots = readdirSync(memoRiverRoot(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(memoRiverRoot(), d.name))
    } catch {
      return
    }
    for (const root of roots) {
      const manifest = readJsonSafe(join(root, 'workspace.json'), {})
      if (manifest.bucket === BUCKET && typeof manifest.cwd === 'string' && manifest.cwd.includes('probe-approve-') && !existsSync(manifest.cwd)) {
        rmSync(root, { recursive: true, force: true })
      }
    }
  }
  purgeOrphans()

  const config = Config({
    bucket: BUCKET,
    native: { vcpRoot: VCP },
    embed: { apiUrl: `http://127.0.0.1:${port}`, apiKey: 'probe', model: 'probe-model', dimension: DIM },
  })
  const registered = []
  const ctx = { tools: { register: (t) => registered.push(t) && (() => {}) } }
  const progressLines = []
  const log = (lvl, msg) => {
    if (msg.includes('progress=')) progressLines.push(msg)
  }
  installTools(ctx, { config, getWorkspace: (c) => acquireWorkspace(c, config), log })

  const ws = acquireWorkspace(cwd, config)
  const byName = (n) => registered.find((t) => (t.name ?? t.definition?.name) === n)
  const wExec = byName('memo_write').execute.bind(byName('memo_write'))
  const aExec = byName('memo_approve').execute.bind(byName('memo_approve'))
  const exec = { agent: { session: { id: 'probe-approve', header: { cwd } } } }

  // ① 种子词汇（空库 ⇒ 3 个新 Tag 带 reason；一次合批嵌入请求）
  const seed = await wExec(
    {
      content: '# 种子：并行批处理探针\n\n结论：为票 04 验证并行批准的时延与语义。\n\nTag: 并行批处理, 草稿闸门, 批准时延',
      newTagReason: '探针空库，三概念首引',
    },
    exec,
  )
  if (!String(seed).includes('✅ 已写入')) throw new Error(`seed write failed: ${String(seed).slice(0, 300)}`)

  // 种子写入的回注+合批两次嵌入会短暂并发（票 03 语义，与本票无关）——计时窗清零，
  // 此后的并发/请求计数只归属 memo_approve 批处理本身。
  resetStats()

  // ② 混合批次：6 篇可批（建议 Tag ⊇ 3 个既有词）+ 1 篇必失败（建议 Tag 全新 ⇒ 策展 0 < 3）
  const draftBody = (turn, user, assistant, tags) =>
    [
      '# 候选草稿（等确认，未入库）',
      '',
      `- 会话：probe-approve-${turn}`,
      `- 回合：${turn} @ 2026-09-15T10:00:0${turn}.000Z`,
      `- 桶：${ws.paths.bucket}`,
      '',
      '## 本轮用户',
      user,
      '',
      '## 本轮助手',
      assistant,
      '',
      '## 建议 Tag（来自本轮被动召回的 matchedTags，须经 memo_tags 复核后复用）',
      tags,
      '',
      '## 相关旧日记',
      '(无)',
      '',
      '> 本文件是**草稿**：确认后用 memo_write 显式入库（会走 Tag 校验与枢纽闸门）。',
    ].join('\n')
  const topics = [
    ['并行度如何定', '结论：沿用 TAG_VECTORIZE_CONCURRENCY 的 worker-pool 模式，缺省 5。'],
    ['部分成功怎么保', '结论：单篇 try/catch 兜底，意外异常折算该篇失败行，整批继续。'],
    ['输出顺序乱吗', '结论：outcomes 按下标落位，完成序乱、汇报序不乱。'],
    ['半写风险在哪', '结论：better-sqlite3 全同步 + writeDiary 单事务，天然无半写。'],
    ['闸门语义变吗', '结论：approveOne 与串行版同一份代码，零复制。'],
    ['耗时怎么报', '结论：小计行带耗时与并行度，中央日志逐篇 progress=i/N。'],
  ]
  mkdirSync(ws.paths.pendingDir, { recursive: true })
  topics.forEach(([u, a], i) =>
    writeFileSync(
      join(ws.paths.pendingDir, `2026-09-15-可批-d${i + 1}.md`),
      draftBody(i + 1, u, a, '并行批处理, 草稿闸门, 批准时延, 建议词噪声X'),
    ),
  )
  writeFileSync(
    join(ws.paths.pendingDir, '2026-09-15-必失败-d7.md'),
    draftBody(7, 'Tag 不够怎么办', '结论：可复用 Tag 不足 3 个的草稿必须跳过待人工。', '全新概念甲, 全新概念乙'),
  )

  // ③ 计时批准（all=true + bucket 过滤，绝不碰真实桶）
  const filesBefore = ws.store.counts().files
  const t0 = Date.now()
  const out = await aExec({ all: true, bucket: ws.paths.bucket }, exec)
  const wallMs = Date.now() - t0
  const filesAfter = ws.store.counts().files

  const approvedDir = join(ws.paths.root, 'approved')
  const pendingLeft = existsSync(ws.paths.pendingDir) ? readdirSync(ws.paths.pendingDir).filter((f) => f.endsWith('.md')) : []
  const result = {
    wallMs,
    requests,
    maxInFlight,
    filesDelta: filesAfter - filesBefore,
    approvedFiles: existsSync(approvedDir) ? readdirSync(approvedDir).filter((f) => f.endsWith('.md')).length : 0,
    pendingLeft,
    progressLines: progressLines.length,
    output: String(out),
  }
  console.log('<<<PROBE_JSON>>>' + JSON.stringify(result) + '<<<PROBE_JSON>>>')
  server.close()
  try {
    ws.close()
  } catch {}
  rmSync(workspacePaths(cwd, BUCKET).root, { recursive: true, force: true }) // 自净：memo-river 根 + 临时 cwd 都不留
  rmSync(cwd, { recursive: true, force: true })
  process.exit(0)
}

/* ── 父进程：串行 vs 并行两轮 + 断言 ── */
function runRound(concurrency) {
  const r = spawnSync(process.execPath, [new URL(import.meta.url).pathname, 'child'], {
    env: { ...process.env, PROBE_CHILD: '1', MEMO_APPROVE_CONCURRENCY: String(concurrency) },
    encoding: 'utf8',
    timeout: 120_000,
  })
  if (r.status !== 0) throw new Error(`child(${concurrency}) failed: ${r.stderr.slice(-1500)}`)
  const m = r.stdout.match(/<<<PROBE_JSON>>>(.*)<<<PROBE_JSON>>>/)
  if (!m) throw new Error(`child(${concurrency}) no JSON marker; stdout head: ${r.stdout.slice(0, 300)}`)
  return JSON.parse(m[1])
}

if (process.env.PROBE_CHILD === '1') {
  await child()
} else {
  let failed = 0
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
    if (!ok) failed++
  }
  const serial = runRound(1)
  const parallel = runRound(5)
  console.log(`串行基线（C=1）：wall=${serial.wallMs}ms  请求=${serial.requests}  峰值并发=${serial.maxInFlight}`)
  console.log(`并行批处理（C=5）：wall=${parallel.wallMs}ms  请求=${parallel.requests}  峰值并发=${parallel.maxInFlight}`)

  for (const [tag, r] of [['串行', serial], ['并行', parallel]]) {
    check(`${tag}·部分成功：6 ✅ + 1 ⏭（Tag 不足逐条说明）`, r.output.includes('✅') && r.output.includes('可复用 Tag 仅 0 个') && r.output.includes('批准 6 / 跳过 1'), r.output.split('\n').filter((l) => l.startsWith('·')).join(' | ').slice(0, 400))
    check(`${tag}·无意外异常兜底行`, !r.output.includes('处理异常'))
    check(`${tag}·无半写：库内 +6 == approved/ 6 文件`, r.filesDelta === 6 && r.approvedFiles === 6, `filesDelta=${r.filesDelta} approvedFiles=${r.approvedFiles}`)
    check(`${tag}·必失败篇留在 pending/`, r.pendingLeft.length === 1 && r.pendingLeft[0].includes('必失败'), `pending=${JSON.stringify(r.pendingLeft)}`)
    check(`${tag}·进度逐篇汇报 progress=i/N`, r.progressLines === 7, `progressLines=${r.progressLines}`)
    check(`${tag}·小计带耗时与并行度`, /耗时 [\d.]+s（并行度 \d+/.test(r.output), r.output.split('\n').find((l) => l.includes('耗时')))
  }
  check('A 串行基线：批准阶段嵌入逐一发出（峰值并发=1）', serial.maxInFlight === 1, `maxInFlight=${serial.maxInFlight}`)
  check('A 串行基线：墙钟 ≈ 6×RTT（6×1200=7200ms ±40%）', serial.wallMs > 0.6 * 6 * RTT_MS && serial.wallMs < 1.4 * 6 * RTT_MS, `wall=${serial.wallMs}ms`)
  check('B 并行：峰值并发 ≥4（有界 5）', parallel.maxInFlight >= 4 && parallel.maxInFlight <= 5, `maxInFlight=${parallel.maxInFlight}`)
  check('B 并行：两轮各恰 6 次嵌入（每可批篇一次，不重复不多发）', serial.requests === 6 && parallel.requests === 6, `serial=${serial.requests} parallel=${parallel.requests}`)
  check('B 并行：墙钟 < 串行/2（≈⌈6/5⌉×RTT）', parallel.wallMs < serial.wallMs / 2, `parallel=${parallel.wallMs}ms serial=${serial.wallMs}ms speedup=${(serial.wallMs / parallel.wallMs).toFixed(2)}x`)

  console.log(failed === 0 ? '\nprobe-approve-parallel: ALL PASS' : `\nprobe-approve-parallel: ${failed} FAIL`)
  process.exit(failed === 0 ? 0 : 1)
}
