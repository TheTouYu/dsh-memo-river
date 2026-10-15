import { readFileSync, readdirSync } from 'node:fs'
const KEY = readFileSync(process.env.HOME + '/.config/memo-river/openrouter.env', 'utf8').match(/OPENROUTER_API_KEY=(\S+)/)[1]
const dir = '/home/h/.dsh/memo-river/b94d8836d6175817/dailynote/dsh-memo-river'
const files = readdirSync(dir).filter(f => f.endsWith('.md')).sort().slice(-3).map(f => readFileSync(`${dir}/${f}`, 'utf8'))
const LONG = files.join('\n').slice(0, 2000)          // 写路径/查询场代表长度
const SHORT = '上个月 MALFORMED_RESPONSE 复现验证方法：临时起 dsh 实例 3101 端口 mock provider 会话重放'
const MODELS = ['baai/bge-m3', 'qwen/qwen3-embedding-8b']
const N = 8
const stat = (a) => { const s = a.slice().sort((x, y) => x - y); const q = (p) => Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]); return `min ${Math.round(s[0])} / p50 ${q(.5)} / p90 ${q(.9)} / max ${Math.round(s[s.length - 1])}` }
const res = {}
for (const [kind, text] of [['long', LONG], ['short', SHORT]]) {
  for (let i = 0; i < N; i++) {
    for (const m of MODELS) {   // 交替发，抵消时间漂移
      const t0 = performance.now()
      try {
        const r = await fetch('https://openrouter.ai/api/v1/embeddings', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
          body: JSON.stringify({ model: m, input: [text] }), signal: AbortSignal.timeout(45000) })
        const j = await r.json(); const ms = performance.now() - t0
        const k = `${m}|${kind}`
        res[k] ??= { ms: [], toks: [], dim: 0, prov: new Set(), err: 0 }
        if (!r.ok) { res[k].err++; continue }
        res[k].ms.push(ms); res[k].toks.push(j.usage?.prompt_tokens ?? 0)
        res[k].dim = j.data?.[0]?.embedding?.length ?? res[k].dim; res[k].prov.add(j.provider ?? '?')
      } catch { (res[`${m}|${kind}`] ??= { ms: [], toks: [], dim: 0, prov: new Set(), err: 0 }).err++ }
    }
  }
}
console.log(`N=${N}/模型/长度，交替发送，输入长 ${LONG.length} 字 / 短 ${SHORT.length} 字\n`)
for (const m of MODELS) {
  for (const kind of ['long', 'short']) {
    const r = res[`${m}|${kind}`]
    const avgTok = r.toks.length ? (r.toks.reduce((a, b) => a + b, 0) / r.toks.length) : 0
    const chars = kind === 'long' ? LONG.length : SHORT.length
    console.log(`${m.padEnd(26)} ${kind.padEnd(6)} n=${r.ms.length} 错=${r.err} dim=${r.dim} tok/字=${(avgTok / chars).toFixed(3)} provider=${[...r.prov].join(',')}\n${' '.repeat(28)}${stat(r.ms)} ms`)
  }
}
