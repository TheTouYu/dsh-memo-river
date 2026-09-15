// 票 01 探针：慢端点下的注入路径短超时降级 + 合批请求计数。
//
// 判据（票面 #2 + 合批语义）：
//  A. recall(embedTimeoutMs=3000) 对 >3s 才响应的端点：≤~3.5s 返回 injected=false，
//     fallbackReason 以 embed-timeout 开头（日志 reason 可区分），绝不抛、不碰 store/engine。
//  B. 合批：query + gU 锚 + gA 锚三文本在**同一次** HTTP 请求里（服务端计数=1，input.length=3）。
//  C. 不传 embedTimeoutMs（写侧/主动召回口径）→ 用客户端宽松默认，3s 内不降级
//     （此处只验证 3.2s 时仍未失败——宽松路径不被注入预算误伤）。
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EmbedClient } from '../../lib/embed.js'
import { recall } from '../../lib/recall.js'

const dim = 8 // 探针客户端自定义维度（真实 3072 太大，探针只验时序/计数）
const seen = [] // {inputLen, at}
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const input = JSON.parse(body).input
    seen.push({ inputLen: input.length, at: Date.now() })
    setTimeout(() => {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          data: input.map((_, i) => ({ index: i, embedding: Array.from({ length: dim }, (_, j) => (i + j) % 7 === 0 ? 1 : 0.1) })),
        }),
      )
    }, 10_000) // 慢端点：10s 才回 —— 必须被 3s 预算砍掉
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const dir = mkdtempSync(join(tmpdir(), 'probe-slow-embed-'))
const client = new EmbedClient({
  apiUrl: `http://127.0.0.1:${port}`,
  apiKey: 'probe',
  model: 'probe-model',
  dimension: dim,
  cachePath: join(dir, 'emb-cache.json'),
})

// store 桩：chunks 空 → embed 成功路径停在 empty-corpus（recall 对 store.chunks 无 try 包裹，
// 不能抛）；engine 桩抛——empty-corpus 早退，永远不该被碰到。
const boom = () => {
  throw new Error('probe: recall touched engine despite early exit')
}
const deps = {
  store: { chunks: () => [], chunkOwners: () => new Map() },
  embed: client,
  engine: boom,
  dimension: dim,
}
const opts = (embedTimeoutMs) => ({
  mode: 'topology_v3',
  k: 3,
  tokenBudget: 600,
  dynamicK: 1,
  gate: true,
  gateThreshold: 0.55,
  minKnnForReward: 0.6,
  queryId: 'probe-slow',
  gateText: '今天教室建模进度如何？用户锚文本，与查询场不同文。',
  gateAssistantText: '助手锚：最近一条超过一百五十字的助手消息节选，用于门控第二锚校验。',
  embedTimeoutMs,
})

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed++
}

/* A+B: 注入路径 3s 硬顶 + 单次合批请求 */
const t0 = Date.now()
const out = await recall(deps, '查询场：教室建模归档进展与门控校准', opts(3000))
const wall = Date.now() - t0
check('A1 短超时内返回', wall < 3500, `wall=${wall}ms`)
check('A2 injected=false', out.injected === false)
check('A3 reason 可区分 embed-timeout', String(out.fallbackReason ?? '').startsWith('embed-timeout'), `reason=${out.fallbackReason}`)
check('B1 恰好一次 HTTP 请求（合批）', seen.length === 1, `requests=${seen.length}`)
check('B2 三文本同批（query+gU+gA）', seen[0]?.inputLen === 3, `inputLen=${seen[0]?.inputLen}`)

/* C: 缺省（写侧口径）不受注入预算误伤 —— 3.2s 时不降级、请求仍挂着 */
const t1 = Date.now()
const slowNoBudget = recall(deps, '写侧口径：不传 embedTimeoutMs 的宽松调用', opts(undefined)).then((o) => ({ o, wall: Date.now() - t1 }))
await new Promise((r) => setTimeout(r, 3200))
const pending = await Promise.race([slowNoBudget.then(() => 'settled'), Promise.resolve('pending')])
check('C1 3.2s 时宽松调用未降级', pending === 'pending', `state=${pending}`)
const { o: outC, wall: wallC } = await slowNoBudget // 等满 10s 服务端响应回来
check('C2 宽松调用最终走通（非超时路径）', outC.fallbackReason === null || !String(outC.fallbackReason).startsWith('embed-timeout'), `reason=${outC.fallbackReason} wall=${wallC}ms`)

server.close()
rmSync(dir, { recursive: true, force: true })
console.log(failed === 0 ? '\nprobe-slow-endpoint: ALL PASS' : `\nprobe-slow-endpoint: ${failed} FAIL`)
process.exit(failed === 0 ? 0 : 1)
