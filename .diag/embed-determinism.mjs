import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
process.env.EMB_BREAKER = '0'
const { Config: ConfigSchema } = await import('../lib/index.js')
const { resolveEmbed } = await import('../lib/workspace.js')
const { workspacePaths } = await import('../lib/runtime.js')
const { EmbedClient } = await import('../lib/embed.js')
const resolved = resolveEmbed(ConfigSchema({ bucket: '', native: { vcpRoot: '/home/h/app/VCPToolBox' } }), workspacePaths('/tmp/det-probe', ''))
const TEXT = '我这边现在渲染又卡了，上次教室那个是怎么解决的？请把阴影贴图的处理再讲一遍。'
const vecs = []
for (let i = 0; i < 4; i++) {
  const TMP = mkdtempSync(join('/var/tmp', `det-${i}-`))   // 每次独立缓存 → 不命中
  const c = new EmbedClient({ apiUrl: resolved.apiUrl, apiKey: resolved.apiKey, model: resolved.model, dimension: resolved.dimension, cachePath: join(TMP, 'c.bin'), timeoutMs: 30000, logger: { warn(){}, info(){} } })
  const t0 = performance.now()
  try { const [v] = await c.embed([TEXT]); vecs.push({ i, v, ms: Math.round(performance.now()-t0) }) }
  catch (e) { console.log(`#${i} ERR ${Math.round(performance.now()-t0)}ms ${String(e.message).slice(0,90)}`) }
}
const cos = (a,b) => { let d=0,na=0,nb=0; for(let i=0;i<a.length;i++){d+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i]} return d/Math.sqrt(na*nb) }
console.log('成功样本:', vecs.map(v=>`#${v.i} ${v.ms}ms`).join(' '))
for (let i=1;i<vecs.length;i++) console.log(`cos(#0,#${vecs[i].i}) = ${cos(vecs[0].v, vecs[i].v).toFixed(6)}`)
