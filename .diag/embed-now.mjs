process.env.EMB_BREAKER = '0'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const { Config: ConfigSchema } = await import('../lib/index.js')
const { resolveEmbed } = await import('../lib/workspace.js')
const { workspacePaths } = await import('../lib/runtime.js')
const { EmbedClient } = await import('../lib/embed.js')
const resolved = resolveEmbed(ConfigSchema({ bucket: '', native: { vcpRoot: '/home/h/app/VCPToolBox' } }), workspacePaths(join(tmpdir(), 'now'), ''))
const TMP = mkdtempSync(join(tmpdir(), 'now-'))
const client = new EmbedClient({ apiUrl: resolved.apiUrl, apiKey: resolved.apiKey, model: resolved.model, dimension: resolved.dimension, cachePath: join(TMP,'c.json'), timeoutMs: 15_000, logger: { warn: ()=>{} , info: ()=>{} } })
console.log('endpoint=', resolved.apiUrl, 'model=', resolved.model)
for (let i=0;i<3;i++){
  const t=performance.now()
  try { const v = await client.embed([`现网探活 #${i} 记忆河流被动注入诊断`]); console.log(`#${i} ok dim=${v[0].length} ms=${(performance.now()-t).toFixed(0)}`) }
  catch(e){ console.log(`#${i} ERR ms=${(performance.now()-t).toFixed(0)} ${String(e.message).slice(0,200)}`) }
  await new Promise(r=>setTimeout(r,800))
}
