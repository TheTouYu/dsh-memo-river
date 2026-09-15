// 票 02 真实端点探针：连接保活的 RTT 对照（冷连接 vs 保活复用）。
//
// 判据（票面 #3 机理证据）：
//  L1 旧传输（全局 fetch，keepAliveTimeout 4s）：间隔 5s 的三次调用，每次重付
//     connect+TLS（基线 1.19–1.45s）。
//  L2 新传输（undici Agent，keepAliveTimeout 240s）：同样间隔 5s 的三次调用，
//     第 2/3 次走保活连接，RTT 显著下降（预期省 ~0.8–1.2s）。
//  L3 记录服务端 Keep-Alive hint（有效复用窗口 = min(客户端值, hint−1s)）。
// 额度开销：6 条单文本 embed。
import { readFileSync } from 'node:fs'
import { Agent, fetch as undiciFetch } from 'undici'

const env = Object.fromEntries(
  readFileSync('/home/h/app/VCPToolBox/config.env', 'utf8')
    .split('\n')
    .map((l) => l.match(/^([A-Za-z_][\w]*)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim().replace(/^["']|["']$/g, '')]),
)
const url = `${env.API_URL}/v1/embeddings`
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${env.API_Key}` }
const bodyOf = (i) => JSON.stringify({ model: env.WhitelistEmbeddingModel, input: [`票02保活探针样本 ${i} ${Date.now()}`] })

const GAP = 5_000 // 旧传输 4s 保活必过期；新传输 240s（或服务端 hint）窗口内
const run = async (tag, doFetch) => {
  const rtts = []
  let hint = ''
  for (let i = 0; i < 3; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, GAP))
    const t0 = Date.now()
    const res = await doFetch(url, { method: 'POST', headers, body: bodyOf(i) })
    const payload = await res.json()
    const rtt = Date.now() - t0
    hint = res.headers.get('keep-alive') ?? hint
    if (!res.ok || !Array.isArray(payload.data?.[0]?.embedding)) throw new Error(`${tag} call${i} bad response ${res.status}`)
    rtts.push(rtt)
    console.log(`  ${tag} call${i + 1}: ${rtt}ms (dim=${payload.data[0].embedding.length})`)
  }
  return { rtts, hint }
}

console.log(`endpoint=${url} model=${env.WhitelistEmbeddingModel} gap=${GAP}ms`)
const old = await run('L1 旧传输(global fetch)', (u, init) => fetch(u, init))
console.log(`  L1 服务端 keep-alive hint: ${old.hint || '(未通告)'}`)
const agent = new Agent({ keepAliveTimeout: 240_000, connections: 4 })
const neu = await run('L2 新传输(undici Agent)', (u, init) => undiciFetch(u, { ...init, dispatcher: agent }))
console.log(`  L2 服务端 keep-alive hint: ${neu.hint || '(未通告)'}`)
await agent.close()

const oldMean = Math.round(old.rtts.reduce((a, b) => a + b, 0) / 3)
const warm = neu.rtts.slice(1)
const warmMean = Math.round(warm.reduce((a, b) => a + b, 0) / 2)
console.log(`\nL1 均值 ${oldMean}ms；L2 首呼 ${neu.rtts[0]}ms + 保活均值 ${warmMean}ms → 每次省 ~${oldMean - warmMean}ms`)
console.log(warmMean < oldMean * 0.75 ? 'L4 保活收益成立（warm < 75% cold）' : 'L4 ⚠️ 保活收益不显著，检查服务端 hint')
