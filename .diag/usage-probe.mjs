process.env.EMB_BREAKER = '0'
const { Config: ConfigSchema } = await import('../lib/index.js')
const { resolveEmbed } = await import('../lib/workspace.js')
const { workspacePaths } = await import('../lib/runtime.js')
const { readFileSync } = await import('node:fs')
const r = resolveEmbed(ConfigSchema({ bucket: '', native: { vcpRoot: '/home/h/app/VCPToolBox' } }), workspacePaths('/tmp/up', ''))
console.log('endpoint=', r.apiUrl, 'model=', r.model, 'dim=', r.dimension)
// 真实语料样本：本桶最近三篇日记全文拼接
const dir = '/home/h/.dsh/memo-river/b94d8836d6175817/dailynote/dsh-memo-river'
const { readdirSync } = await import('node:fs')
const files = readdirSync(dir).filter(f=>f.endsWith('.md')).sort().slice(-3).map(f=>readFileSync(`${dir}/${f}`,'utf8'))
const diary = files.join('\n')
const cases = [
  ['单篇日记全文(典型)', files[0]],
  ['三篇拼接(~整篇写入+)', diary.slice(0, 6000)],
  ['查询场形态(6条窗口上限 4000 字)', 'x'.repeat(0) + diary.slice(0, 4000)],
  ['短查询(主动 memo_recall 形态)', '上个月 MALFORMED_RESPONSE 复现验证方法：临时起 dsh 实例 3101 端口 mock provider 会话重放'],
  ['纯中文长句样本', '这是一段用于测量分词比例的中文文本。'.repeat(30)],
]
for (const [name, text] of cases) {
  const t0 = performance.now()
  try {
    const res = await fetch(`${r.apiUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${r.apiKey}` },
      body: JSON.stringify({ model: r.model, input: [text], dimensions: r.dimension }),
      signal: AbortSignal.timeout(60000),
    })
    const j = await res.json()
    const u = j.usage ?? {}
    const chars = text.length
    const tok = u.prompt_tokens ?? u.total_tokens
    console.log(`${name}: chars=${chars} prompt_tokens=${tok ?? '(无 usage 字段)'} token/char=${tok ? (tok/chars).toFixed(3) : 'n/a'} ${Math.round(performance.now()-t0)}ms`)
  } catch (e) { console.log(`${name}: ERR ${String(e.message).slice(0,80)}`) }
}
