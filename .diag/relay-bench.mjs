import { readFileSync, readdirSync } from 'node:fs'
const env = readFileSync('/home/h/app/VCPToolBox/config.env', 'utf8')
const API_URL = env.match(/^API_URL=(.+)$/m)?.[1]?.trim()
const KEY = env.match(/^API_Key=(.+)$/m)?.[1]?.trim()
const dir = '/home/h/.dsh/memo-river/b94d8836d6175817/dailynote/dsh-memo-river'
const LONG = readdirSync(dir).filter(f => f.endsWith('.md')).sort().slice(-3)
  .map(f => readFileSync(`${dir}/${f}`, 'utf8')).join('\n').slice(0, 4000)
const SHORT = '上个月 MALFORMED_RESPONSE 复现验证方法：临时起 dsh 实例 3101 端口 mock provider 会话重放'
const MODELS = ['gemini-embedding-2-preview', 'gemini-embedding-001', 'text-embedding-3-large', 'text-embedding-3-small', 'text-embedding-ada-002']
const p = (a, q) => a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))] : NaN
console.log(`端点 ${API_URL}  |  长输入 4000 字 / 短输入 ${SHORT.length} 字  |  每个模型各 3 次\n`)
console.log('模型'.padEnd(28) + '长输 p50'.padStart(10) + '短输 p50'.padStart(10) + 'dim'.padStart(7) + '  错误')
for (const m of MODELS) {
  const L = [], S = [], errs = []; let dim = '-'
  for (const [kind, text, acc] of [['long', LONG, L], ['short', SHORT, S], ['long', LONG, L], ['short', SHORT, S], ['long', LONG, L], ['short', SHORT, S]]) {
    const t0 = performance.now()
    try {
      const r = await fetch(`${API_URL}/v1/embeddings`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: m, input: [text] }), signal: AbortSignal.timeout(30000) })
      const j = await r.json(); const ms = performance.now() - t0
      if (!r.ok) { errs.push(`HTTP${r.status}:${String(j.error?.message ?? '').slice(0, 40)}`); continue }
      dim = j.data?.[0]?.embedding?.length ?? dim; acc.push(ms)
    } catch (e) { errs.push(String(e.message).slice(0, 40)) }
  }
  console.log(m.padEnd(28) + `${Math.round(p(L, .5))}ms`.padStart(10) + `${Math.round(p(S, .5))}ms`.padStart(10) + String(dim).padStart(7) + '  ' + (errs.slice(0, 2).join(' | ') || '—'))
}
