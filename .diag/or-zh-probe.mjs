import { readFileSync, readdirSync } from 'node:fs'
const KEY = readFileSync(process.env.HOME + '/.config/memo-river/openrouter.env', 'utf8').match(/OPENROUTER_API_KEY=(\S+)/)[1]
const dir = '/home/h/.dsh/memo-river/b94d8836d6175817/dailynote/dsh-memo-river'
const files = readdirSync(dir).filter(f => f.endsWith('.md')).sort().slice(-3).map(f => readFileSync(`${dir}/${f}`, 'utf8'))
const CASES = [['长输入 4000 字', files.join('\n').slice(0, 4000)], ['中篇 2238 字', files[0]], ['短查询 67 字', '上个月 MALFORMED_RESPONSE 复现验证方法：临时起 dsh 实例 3101 端口 mock provider 会话重放']]
for (const m of ['qwen/qwen3-embedding-8b', 'baai/bge-m3']) {
  console.log(`\n── ${m} ──`)
  for (const [name, text] of CASES) {
    const t0 = performance.now()
    try {
      const r = await fetch('https://openrouter.ai/api/v1/embeddings', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: m, input: [text] }), signal: AbortSignal.timeout(60000) })
      const j = await r.json(); const ms = Math.round(performance.now() - t0)
      if (!r.ok) { console.log(`  ${name}: HTTP ${r.status} ${JSON.stringify(j).slice(0, 140)}`); continue }
      const tok = j.usage?.prompt_tokens
      console.log(`  ${name}: dim=${j.data?.[0]?.embedding?.length} tokens=${tok} tok/char=${(tok / text.length).toFixed(3)} provider=${j.provider ?? '-'} ${ms}ms`)
    } catch (e) { console.log(`  ${name}: ERR ${String(e.message).slice(0, 90)}`) }
  }
}
