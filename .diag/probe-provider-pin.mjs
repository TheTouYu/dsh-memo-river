// 用插件自己的 EmbedClient 验「钉 provider → 嵌入逐位可复现」。
// 关键：EmbedClient 有嵌入缓存（同文本第二次直接命中缓存、不发请求）——每次调用用**独立缓存文件**
// 才能保证真的打到端点。捕获出站请求体以直接证明 provider 字段确实发出去了。
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { EmbedClient } from '../lib/embed.js'

const KEY = readFileSync(process.env.HOME + '/.config/memo-river/openrouter.env', 'utf8').match(/OPENROUTER_API_KEY=(\S+)/)[1]
const dir = '/home/h/.dsh/memo-river/b94d8836d6175817/dailynote/dsh-memo-river'
const text = readFileSync(`${dir}/${readdirSync(dir).filter((f) => f.endsWith('.md')).sort().slice(-1)[0]}`, 'utf8').slice(0, 400)

const bodies = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => { try { bodies.push(JSON.parse(init.body)) } catch {} return realFetch(url, init) }

const call = async (tag, providerOrder) => {
  const cachePath = `/var/tmp/pin-probe-${tag}-${process.pid}.bin`
  rmSync(cachePath, { force: true })
  const c = new EmbedClient({ apiUrl: 'https://openrouter.ai/api', apiKey: KEY, model: 'baai/bge-m3',
    dimension: 1024, cachePath, providerOrder, timeoutMs: 45_000,
    logger: { warn: (m) => console.log('  [warn]', m.slice(0, 80)), info: () => {} } })
  const [v] = await c.embed([text])
  return Float32Array.from(v)
}
const maxdiff = (a, b) => Math.max(...a.map((x, i) => Math.abs(x - b[i])))

for (const [label, order] of [['钉 providerOrder=Parasail', 'Parasail'], ['不钉（基线）', '']]) {
  const vs = []
  for (let i = 0; i < 3; i++) vs.push(await call(`${order ? 'pin' : 'base'}${i}`, order))
  const diffs = vs.slice(1).map((v) => maxdiff(vs[0], v))
  console.log(`\n${label}：3 次独立请求（每次新缓存）`)
  console.log(`  与 #0 逐元素最大差：${diffs.map((d) => d.toExponential(2)).join(' / ')}`)
  console.log(`  ${diffs.every((d) => d === 0) ? '✅ 逐位一致' : '⚠️ 有漂移（逐位不可复现）'}`)
}
console.log('\n出站请求体（直接证据）：')
bodies.forEach((b, i) => console.log(`  #${i} ${JSON.stringify({ model: b.model, provider: b.provider ?? '(未发送)' })}`))
globalThis.fetch = realFetch
