import { readFileSync, readdirSync } from 'node:fs'
const yml = readFileSync(process.env.HOME + '/.dsh/.credentials.yaml', 'utf8')
const KEY = (yml.match(/ZAI_CODING_CN_API_KEY:\s*(\S+)/) ?? [])[1]
if (!KEY) { console.log('未取到 key'); process.exit(1) }
console.log('key 形态:', KEY.slice(0, 4) + '…' + KEY.slice(-4), '长度', KEY.length)
const dir = '/home/h/.dsh/memo-river/b94d8836d6175817/dailynote/dsh-memo-river'
const files = readdirSync(dir).filter(f => f.endsWith('.md')).sort().slice(-3).map(f => readFileSync(`${dir}/${f}`, 'utf8'))
const CASES = [
  ['写路径·单篇日记全文', files[0]],
  ['写路径·写前回注 2000', files[0].slice(0, 2000)],
  ['读路径·查询场 4000 字', files.join('\n').slice(0, 4000)],
  ['主动 recall·短查询 67 字', '上个月 MALFORMED_RESPONSE 复现验证方法：临时起 dsh 实例 3101 端口 mock provider 会话重放'],
]
const URLS = [
  ['标准 API', 'https://open.bigmodel.cn/api/paas/v4/embeddings'],
  ['Coding 端点', 'https://open.bigmodel.cn/api/coding/paas/v4/embeddings'],
]
for (const [label, url] of URLS) {
  console.log(`\n── ${label}: ${url} ──`)
  for (const [name, text] of CASES) {
    const t0 = performance.now()
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: 'embedding-3', input: [text] }),
        signal: AbortSignal.timeout(60000),
      })
      const j = await r.json()
      const ms = Math.round(performance.now() - t0)
      if (!r.ok) { console.log(`  ${name}: HTTP ${r.status} ${JSON.stringify(j).slice(0, 160)} ${ms}ms`); continue }
      const tok = j.usage?.prompt_tokens ?? j.usage?.total_tokens
      const dim = j.data?.[0]?.embedding?.length
      console.log(`  ${name}: chars=${text.length} tokens=${tok} tok/char=${(tok / text.length).toFixed(3)} dim=${dim} ${ms}ms`)
    } catch (e) { console.log(`  ${name}: ERR ${String(e.message).slice(0, 100)}`) }
  }
}
