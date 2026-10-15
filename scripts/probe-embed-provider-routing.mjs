#!/usr/bin/env node
/**
 * 探针：EmbedClient 的 OpenRouter provider 路由字段（`providerOrder` → 请求体 `provider:{order:[...]}`）。
 *
 * 为何要有它（2026-10-15）：切到 baai/bge-m3 后，同一文本连打 6 次被 OpenRouter 按价格负载均衡
 * 路由到 DeepInfra / Parasail 两家，逐元素最大差 3.8e-4~7.3e-4（cos ≥0.99997，方向不变但**逐位
 * 不可复现**）——这让「同一查询、并发 == 串行、逐名次比对」这类恒等断言随机变红（主套件 #10）。
 * 钉住 order 后同一 provider 连打 3 次逐元素差 0.00e+0。
 *
 * 本探针**零端点依赖**（本地 http 回显，不花 token、不碰 API key）：
 *   P1 providerOrder 已设 → 请求体带 provider:{order:['Parasail']}
 *   P2 providerOrder 多为 'A, B' → 逗号切分 + trim（顺序保留）
 *   P3 providerOrder 缺省/空 → 请求体**不含** provider 字段（旧行为逐字不变，非 OpenRouter 端点安全）
 *   P4 model / input 仍在请求体里（没被 spread 挤掉）
 *   P5 请求路径 = `${apiUrl}/v1/embeddings`（apiUrl 不带 /v1 的约定）
 *   P6 双通道：primary 拒连 → fallback lane 接管，且 fallback 请求体同样带 provider 字段
 *     （2026-10-15 晚生产形态：主 = 本地 8099 bge-m3，保底 = OpenRouter/Parasail fallbackProviderOrder）
 */
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { EmbedClient } from '../lib/embed.js'

const DIM = 1024
const received = []
let hits = 0

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    hits += 1
    let body = null
    try { body = JSON.parse(raw) } catch {}
    received.push({ path: req.url, body })
    const n = Array.isArray(body?.input) ? body.input.length : 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      model: body?.model ?? 'echo',
      data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: new Array(DIM).fill(0.25) })),
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const results = []
const check = (id, name, pass, detail) => {
  results.push({ id, name, pass })
  console.log(`  ${pass ? '✅' : '❌'} P${id} ${name}`)
  if (detail) console.log(`      ${detail}`)
}

const callOnce = async (tag, providerOrder) => {
  const cachePath = join(tmpdir(), `probe-provider-routing-${tag}-${process.pid}.bin`)
  rmSync(cachePath, { force: true })
  const client = new EmbedClient({
    apiUrl: `http://127.0.0.1:${port}`,
    apiKey: 'probe-not-a-real-key',
    model: 'baai/bge-m3',
    dimension: DIM,
    cachePath,
    ...(providerOrder === undefined ? {} : { providerOrder }),
    timeoutMs: 5_000,
    logger: { warn: () => {}, info: () => {} },
  })
  await client.embed(['探针文本'])
  return received[received.length - 1]
}

const a = await callOnce('pin', 'Parasail')
check(1, "providerOrder='Parasail' → 请求体带 provider:{order:['Parasail']}",
  JSON.stringify(a.body?.provider) === JSON.stringify({ order: ['Parasail'] }),
  `实际 provider=${JSON.stringify(a.body?.provider)}`)

const b = await callOnce('multi', ' Parasail , DeepInfra ')
check(2, "providerOrder=' Parasail , DeepInfra ' → 逗号切分 + trim，顺序保留",
  JSON.stringify(b.body?.provider) === JSON.stringify({ order: ['Parasail', 'DeepInfra'] }),
  `实际 provider=${JSON.stringify(b.body?.provider)}`)

const c = await callOnce('empty', '')
const d = await callOnce('absent', undefined)
check(3, "providerOrder='' / 未提供 → 请求体不含 provider 字段（旧行为不变）",
  !('provider' in (c.body ?? {})) && !('provider' in (d.body ?? {})),
  `空串: provider in body = ${'provider' in (c.body ?? {})}；未提供: provider in body = ${'provider' in (d.body ?? {})}`)

check(4, 'model / input 仍在请求体里（未被 spread 挤掉）',
  a.body?.model === 'baai/bge-m3' && JSON.stringify(a.body?.input) === JSON.stringify(['探针文本']),
  `model=${a.body?.model} input=${JSON.stringify(a.body?.input)}`)

check(5, '请求路径 = `${apiUrl}/v1/embeddings`',
  received.every((r) => r.path === '/v1/embeddings'),
  `实际路径集合=${JSON.stringify([...new Set(received.map((r) => r.path))])}（共 ${hits} 次请求）`)

/* P6：双通道——primary 指向必然拒连的端口（127.0.0.1:1），fallback 指向回显且带 providerOrder。
 * 期望：embed() 整体成功（lane 切换生效），且回显收到的那条请求体带 provider:{order:['Parasail']}。 */
{
  const p6Cache = join(tmpdir(), `probe-provider-routing-p6-${process.pid}.bin`)
  rmSync(p6Cache, { force: true })
  const c6 = new EmbedClient({
    apiUrl: 'http://127.0.0.1:1', apiKey: 'probe', model: 'baai/bge-m3', dimension: DIM,
    cachePath: p6Cache, timeoutMs: 3_000,
    fallback: { apiUrl: `http://127.0.0.1:${port}`, apiKey: 'probe', model: 'baai/bge-m3', providerOrder: 'Parasail' },
    logger: { warn: () => {}, info: () => {} },
  })
  const before = received.length
  let ok = false
  let detail = ''
  try {
    await c6.embed(['探针文本-回退'])
    const fb = received[received.length - 1]
    ok = received.length === before + 1
      && JSON.stringify(fb?.body?.provider) === JSON.stringify({ order: ['Parasail'] })
    detail = `fallback 收到 provider=${JSON.stringify(fb?.body?.provider)}（primary 拒连后由 fallback 承接）`
  } catch (e) {
    detail = `embed 抛错（lane 未切换？）：${String(e.message).slice(0, 100)}`
  }
  check(6, "primary 拒连 → fallback lane 接管，且 fallback 请求体带 provider:{order:['Parasail']}", ok, detail)
}

server.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n【探针】EmbedClient provider 路由：${results.length - failed.length}/${results.length} PASS`)
process.exit(failed.length > 0 ? 1 : 0)
