// 票 02 探针：embed 传输层连接保活（undici Agent）——复用 / 空闲重建 / 连接日志 / env 配置。
//
// 判据（票面 #1 #2 #4）：
//  K1 连接复用：同一 EmbedClient 连续 4 次 embed（间隔 30ms，模拟轮与轮之间的真实间隔）
//     → 计数 server 恰好 1 条 TCP 连接（TLS 握手只发生一次）。
//  K2 TAG_EMBED_CONN_LOG=1 → logger 捕获 embed-transport connect 日志（debug 级连接日志通道）。
//  K3 空闲重建：服务端 Keep-Alive hint=2s（有效窗口 ~1s）→ 空闲 2.5s 后下一次调用
//     自动建新连接、成功返回、无报错。
//  K4 死端点错误分类保持：http://127.0.0.1:9 → embed-request-failed，且带 cause 展开
//     （undici 把网络错误包在 TypeError('fetch failed') 里，真因在 cause）。
//  K5 env 配置：TAG_EMBED_KEEPALIVE_MS / TAG_EMBED_CONNECTIONS 子进程里反映在 embedTransportIntent()。
//
// 注意：TAG_EMBED_CONN_LOG 必须在 import lib 之前设（模块加载时读取）。
process.env.TAG_EMBED_CONN_LOG = '1'

import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { EmbedClient } from '../../lib/embed.js'

const dim = 8 // 探针客户端自定义维度（真实 3072 太大，探针只验连接/计数/分类）
const logs = []
const logger = {
  warn: (m) => logs.push(`warn: ${m}`),
  info: (m) => logs.push(`info: ${m}`),
}

const mkServer = async (keepAliveTimeout) => {
  let conns = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const input = JSON.parse(body).input
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          data: input.map((_, i) => ({ index: i, embedding: Array.from({ length: dim }, (_, j) => (i + j) % 5 === 0 ? 1 : 0.1) })),
        }),
      )
    })
  })
  server.on('connection', () => conns++)
  server.keepAliveTimeout = keepAliveTimeout // Node 会以 `Keep-Alive: timeout=N` hint 通告客户端
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, url: `http://127.0.0.1:${server.address().port}`, count: () => conns }
}

const dir = mkdtempSync(join(tmpdir(), 'probe-ka-'))
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}

/* ── K1+K2：连接复用 + debug 连接日志 ── */
const s1 = await mkServer(60_000) // hint 60s → 有效复用窗口 ~59s，覆盖整段探针
const c1 = new EmbedClient({
  apiUrl: s1.url, apiKey: 'probe', model: 'probe-model', dimension: dim,
  cachePath: join(dir, 'c1.json'), logger,
})
for (let i = 0; i < 4; i++) {
  const vecs = await c1.embed([`keepalive 复用探针文本 ${i}`])
  if (vecs.length !== 1 || vecs[0].length !== dim) throw new Error(`K1 第 ${i} 次调用返回异常`)
  await new Promise((r) => setTimeout(r, 30))
}
check('K1 四次连续调用恰一条连接（TLS 只握一次）', s1.count() === 1, `conns=${s1.count()}`)
const connLogs = logs.filter((l) => l.includes('embed-transport connect'))
check('K2 TAG_EMBED_CONN_LOG=1 输出连接日志', connLogs.length >= 1, `connect 日志 ${connLogs.length} 条`)

/* ── K3：空闲超过有效窗口 → 自动重建，无报错 ── */
const s2 = await mkServer(2_000) // hint 2s → undici 有效 keepAlive ~1s
const c2 = new EmbedClient({
  apiUrl: s2.url, apiKey: 'probe', model: 'probe-model', dimension: dim,
  cachePath: join(dir, 'c2.json'), logger,
})
await c2.embed(['空闲重建第一次']) // 建连
const before = s2.count()
await new Promise((r) => setTimeout(r, 2_500)) // 空闲 2.5s > 有效窗口 ~1s
const vec = await c2.embed(['空闲后第一次请求']) // 必须无报错
check('K3a 空闲后请求成功返回', vec.length === 1 && vec[0].length === dim)
check('K3b 空闲后自动重建连接', s2.count() === before + 1, `conns ${before}→${s2.count()}`)

/* ── K4：死端点错误分类（票 01 语义保持 + cause 展开） ── */
const dead = new EmbedClient({
  apiUrl: 'http://127.0.0.1:9', apiKey: 'x', model: 'm', dimension: dim,
  cachePath: join(dir, 'dead.json'), timeoutMs: 3000, logger,
})
let deadErr = null
try { await dead.embed(['死端点']) } catch (e) { deadErr = e }
check(
  'K4 死端点 embed-request-failed 且带 cause',
  deadErr !== null && /embed-request-failed/.test(String(deadErr?.message)) && /cause:/.test(String(deadErr?.message)),
  String(deadErr?.message ?? '').slice(0, 120),
)

/* ── K5：env 覆盖生效（子进程重新 import） ── */
const intent = execFileSync(
  process.execPath,
  ['-e', "import('./lib/embed.js').then((m) => console.log(m.embedTransportIntent()))"],
  { cwd: process.cwd(), env: { ...process.env, TAG_EMBED_KEEPALIVE_MS: '60000', TAG_EMBED_CONNECTIONS: '4', TAG_EMBED_CONN_LOG: '' } },
  { stdio: ['ignore', 'pipe', 'inherit'] },
).toString().trim()
check('K5 env 覆盖反映在 embedTransportIntent()', intent === 'undici(keepAlive=60000ms,connections=4)', intent)

s1.server.close(); s2.server.close()
rmSync(dir, { recursive: true, force: true })
console.log(failed === 0 ? '\nprobe-keepalive: ALL PASS' : `\nprobe-keepalive: ${failed} FAIL`)
process.exit(failed === 0 ? 0 : 1)
