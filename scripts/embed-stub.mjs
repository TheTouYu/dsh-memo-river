/**
 * 本地嵌入桩（0916 固化资产：验收套件提速）。
 *
 * 背景：folder-route / merge / update 三套件走真端点，每次 1.2–1.5s RTT × 十余次
 * 嵌入 + 失败重试 → 单套件数分钟；一次 7 分钟整跑只为看一条失败输出，不可持续。
 * 桩走**真实 EmbedClient 传输**（HTTP，OpenAI 风格响应），零猴子补丁（前两版补丁
 * 均失败的教训见 acceptance-write-prompts T-4 注释）。
 *
 * 两种向量模式：
 *  · hash（缺省，通用）：词袋哈希——ascii 词 + CJK 二元组各哈希到 3072 维一个桶，
 *    归一化。共享词汇 → 高余弦（语义可判：同题文本互相像、异题互相远），向量随文本
 *    变化（merge 套件挑最相似对、folder-route 断言「布料命中教室不命中」都靠它）。
 *  · fixed（去重/并入测试用）：所有文本同向量 → 第二篇起 knn=1.0，触发并入引导/去重闸门
 *    （acceptance-write-prompts 的用法，可迁移）。
 *
 * 用法：
 *   import { startEmbedStub } from './embed-stub.mjs'
 *   const stub = await startEmbedStub()           // { port, url, stop }
 *   const config = ConfigSchema({ ..., embed: { apiUrl: stub.url, apiKey: 'stub' } })
 *   // 真端点对照：REAL_EMBED=1 环境变量让套件回落原配置（各套件自行支持）。
 *   await stub.stop()
 */
import { createServer } from 'node:http'

const DIM = 3072

/** FNV-1a 32bit。 */
function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** 词袋：ascii 词 + CJK 二元组（+首字一元，短文本也有一元信号）。 */
function tokenize(text) {
  const tokens = []
  const ascii = text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []
  tokens.push(...ascii)
  const cjk = text.match(/[\u4e00-\u9fff]/g) ?? []
  for (let i = 0; i < cjk.length; i++) {
    if (i === 0 || cjk.length === 1) tokens.push(cjk[i])
    if (i + 1 < cjk.length) tokens.push(cjk[i] + cjk[i + 1])
  }
  return tokens
}

export function hashVector(text) {
  const v = new Array(DIM).fill(0)
  for (const t of tokenize(text)) {
    v[fnv1a(t) % DIM] += 1
    v[fnv1a(t + '\u0000x') % DIM] += 0.5 // 第二哈希降碰撞不对称
  }
  let norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  if (norm === 0) { v[0] = 1; norm = 1 }
  return v.map((x) => x / norm)
}

/**
 * 起桩。返回 { port, url, stop }。mode='hash' | 'fixed'。
 * fixed 模式的向量与 acceptance-write-prompts 原桩一致（奇偶 0.9/0.2）。
 */
export async function startEmbedStub(mode = 'hash') {
  const fixed = Array.from({ length: DIM }, (_, i) => (i % 2 ? 0.2 : 0.9))
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      let inputs = []
      try {
        const parsed = JSON.parse(body)
        const raw = parsed.input ?? parsed.text ?? body
        inputs = Array.isArray(raw) ? raw : [String(raw)]
      } catch {
        inputs = [body]
      }
      const data = inputs.map((text, i) => ({
        index: i,
        embedding: mode === 'fixed' ? fixed : hashVector(String(text)),
      }))
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise((r) => server.close(r)),
  }
}
