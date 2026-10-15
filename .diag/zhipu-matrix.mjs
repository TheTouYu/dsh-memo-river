import { readFileSync } from 'node:fs'
const KEY = (readFileSync(process.env.HOME + '/.dsh/.credentials.yaml', 'utf8').match(/ZAI_CODING_CN_API_KEY:\s*(\S+)/) ?? [])[1]
const TEXT = '上个月 MALFORMED_RESPONSE 复现验证方法：临时起 dsh 实例 3101 端口 mock provider 会话重放'
const EPS = [
  ['标准-CN', 'https://open.bigmodel.cn/api/paas/v4'],
  ['coding-CN', 'https://open.bigmodel.cn/api/coding/paas/v4'],
  ['标准-海外', 'https://api.z.ai/api/paas/v4'],
  ['coding-海外', 'https://api.z.ai/api/coding/paas/v4'],
]
const MODELS = [
  ['embedding-3', 'embeddings'],
  ['embedding-2', 'embeddings'],
  ['glm-4.6', 'chat/completions'], // 对照：探账户到底有没有任何额度
]
for (const [label, base] of EPS) {
  for (const [model, path] of MODELS) {
    const url = `${base}/${path}`
    const body = path === 'embeddings' ? { model, input: [TEXT] } : { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }
    const t0 = performance.now()
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(30000) })
      const j = await r.json(); const ms = Math.round(performance.now() - t0)
      const ok = r.ok
      const detail = ok ? (path === 'embeddings' ? `dim=${j.data?.[0]?.embedding?.length} tok=${j.usage?.prompt_tokens}` : `chat ok: ${String(j.choices?.[0]?.message?.content ?? '').slice(0, 30)}`)
        : `HTTP ${r.status} code=${j.error?.code ?? '-'} ${String(j.error?.message ?? JSON.stringify(j)).slice(0, 90)}`
      console.log(`${ok ? '✅' : '❌'} ${label.padEnd(10)} ${model.padEnd(12)} ${detail}  ${ms}ms`)
    } catch (e) { console.log(`❌ ${label.padEnd(10)} ${model.padEnd(12)} ERR ${String(e.message).slice(0, 80)}`) }
  }
}
