import { readFileSync, readdirSync } from 'node:fs'
const KEY = process.env.OPENROUTER_API_KEY
const dir = '/home/h/.dsh/memo-river/b94d8836d6175817/dailynote/dsh-memo-river'
const files = readdirSync(dir).filter(f => f.endsWith('.md')).sort().slice(-3).map(f => readFileSync(`${dir}/${f}`, 'utf8'))
const cases = [
  ['写路径·单篇日记全文(典型)', files[0]],
  ['写路径·写前回注上限 2000', files[0].slice(0, 2000)],
  ['读路径·查询场 4000 字', files.join('\n').slice(0, 4000)],
  ['读路径·助手锚 1200 字', files[1].slice(0, 1200)],
  ['主动 recall·短查询 67 字', '上个月 MALFORMED_RESPONSE 复现验证方法：临时起 dsh 实例 3101 端口 mock provider 会话重放'],
]
const out = []
for (const [name, text] of cases) {
  const t0 = performance.now()
  const r = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'openai/text-embedding-3-small', input: [text] }),
    signal: AbortSignal.timeout(60000),
  })
  const j = await r.json()
  if (!r.ok) { console.log(`${name}: HTTP ${r.status} ${JSON.stringify(j).slice(0,200)}`); continue }
  const tok = j.usage?.prompt_tokens
  const dim = j.data?.[0]?.embedding?.length
  const line = `${name}: chars=${text.length} tokens=${tok} tok/char=${(tok/text.length).toFixed(3)} dim=${dim} ${Math.round(performance.now()-t0)}ms provider=${j.provider ?? '-'}`
  console.log(line); out.push({ name, chars: text.length, tok })
}
console.log('\n--- 与 Gemini(gemini-embedding-2-preview) 实测对比：0.590 / 0.578 / 0.611 tok/char ---')
