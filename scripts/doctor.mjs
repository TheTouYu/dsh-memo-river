#!/usr/bin/env node
/**
 * scripts/doctor.mjs — 装好之后先跑这个：一次体检把「为什么没生效」变成读数。
 *
 * 检查项与判据：
 *   1. Node 版本（node:sqlite 需要 >=22.5）
 *   2. lib/ 可 import（导出 apply/Config），且不比 src/ 旧
 *   3. kernel/*.node 可装载，且导出 VexusIndex（reimpl 还应有 runMemoGeometry）
 *   4. 嵌入端点：POST /v1/embeddings 真打一次，向量维度 == MEMO_EMBED_DIM，并报往返耗时
 *   5. DSH profile：依赖里有本仓（link）且 dsh.profile.bundles 选了它
 *   6. 工作区根 ~/.dsh/memo-river 可写
 *
 * 退出码：全部 PASS/WARN 时 0；有 FAIL 时 1。WARN 不阻塞启动。
 *
 * 环境变量（与 bundle patch 共用）：
 *   MEMO_EMBED_URL / MEMO_EMBED_MODEL / MEMO_EMBED_DIM
 *   MEMO_EMBED_API_KEY（缺省 local）
 *   DSH_HOME / DSH_PROFILE / DSH_PROFILE_DIR
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, platform } from 'node:os'
import { createRequire } from 'node:module'

// node:sqlite 每次首用都会打 ExperimentalWarning；体检输出里它是噪音，且会被
// PowerShell 当成错误记录（stderr）从而误判退出码。只吞这一条，别的警告照常。
const emitWarning = process.emitWarning.bind(process)
process.emitWarning = (warning, ...rest) => {
  const text = String(warning?.message ?? warning ?? '')
  if (/SQLite is an experimental feature/i.test(text)) return
  return emitWarning(warning, ...rest)
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WIN = platform() === 'win32'
const EMBED_URL = (process.env.MEMO_EMBED_URL || (WIN ? 'http://127.0.0.1:8091' : 'http://127.0.0.1:8099')).replace(/\/+$/, '')
const EMBED_MODEL = process.env.MEMO_EMBED_MODEL || (WIN ? 'Qwen3-Embedding-0.6B' : 'baai/bge-m3')
const EMBED_DIM = Number(process.env.MEMO_EMBED_DIM || 1024)
const EMBED_KEY = process.env.MEMO_EMBED_API_KEY || 'local'

const results = []
const record = (level, name, detail) => {
  results.push({ level, name, detail })
  const icon = level === 'PASS' ? '✓' : level === 'WARN' ? '!' : '✗'
  console.log(`${icon} ${name}${detail ? `\n    ${detail}` : ''}`)
}
const pass = (n, d) => record('PASS', n, d)
const warn = (n, d) => record('WARN', n, d)
const fail = (n, d) => record('FAIL', n, d)

const newestMtime = (dir) => {
  let newest = 0
  const walk = (p) => {
    for (const name of readdirSync(p)) {
      const f = join(p, name)
      const st = statSync(f)
      if (st.isDirectory()) walk(f)
      else if (/\.ts$/.test(name)) newest = Math.max(newest, st.mtimeMs)
    }
  }
  if (existsSync(dir)) walk(dir)
  return newest
}

async function checkNode() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 5)) fail('Node 版本', `${process.versions.node} < 22.5（node:sqlite 不可用）`)
  else pass('Node 版本', process.versions.node)
}

async function checkLib() {
  const index = join(ROOT, 'lib', 'index.js')
  if (!existsSync(index)) return fail('lib/ 构建', '缺 lib/index.js —— 先跑 node scripts/setup.mjs')
  try {
    const mod = await import(`file://${index.replace(/\\/g, '/')}?t=${Date.now()}`)
    const ok = typeof mod.apply === 'function' && mod.Config && typeof mod.name === 'string'
    if (!ok) return fail('lib/ 导出', '缺 apply / Config / name')
    pass('lib/ 导出', `apply + Config（${mod.name}）`)
  } catch (e) {
    return fail('lib/ 可 import', String(e?.message ?? e))
  }
  const srcNewest = newestMtime(join(ROOT, 'src'))
  const libNewest = statSync(index).mtimeMs
  if (srcNewest > libNewest) warn('lib/ 是否最新', 'src/ 有比 lib/index.js 更新的文件 —— 重跑 node scripts/setup.mjs')
  else pass('lib/ 是否最新', 'lib 不旧于 src')
}

async function checkKernel() {
  const entry = join(ROOT, 'kernel', 'index.js')
  if (!existsSync(entry)) return fail('kernel 入口', '缺 kernel/index.js')
  const require = createRequire(import.meta.url)
  try {
    const mod = require(entry)
    if (typeof mod.VexusIndex !== 'function') return fail('kernel 装载', '未导出 VexusIndex')
    const idx = new mod.VexusIndex(4, 8)
    if (typeof idx.addBatch !== 'function') return fail('kernel 契约', 'VexusIndex 实例缺 addBatch')
    const extra = typeof mod.runMemoGeometry === 'function' ? 'runMemoGeometry ✓' : 'runMemoGeometry ✗（旧内核：派生资产不可用，见 docs/WINDOWS-2026-11-25.md）'
    pass('kernel 装载', `VexusIndex ✓  ${extra}`)
    idx.clearMemoRuntime?.()
  } catch (e) {
    fail('kernel 装载', `${String(e?.message ?? e).split('\n')[0]}\n    先跑 node scripts/setup.mjs --kernel-only`)
  }
}

async function checkEmbed() {
  const url = `${EMBED_URL}/v1/embeddings`
  const payload = { model: EMBED_MODEL, input: ['维度体检文本'] }
  const t0 = Date.now()
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${EMBED_KEY}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    })
  } catch (e) {
    const msg = String(e?.cause?.message ?? e?.message ?? e)
    return fail('嵌入端点', `${url} 不可达：${msg}\n    起服务见 docs/LOCAL-EMBED.md；或设 MEMO_EMBED_URL/KEY/MODEL 指向任意 OpenAI 兼容端点`)
  }
  const ms = Date.now() - t0
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200)
    return fail('嵌入端点', `${url} HTTP ${res.status}（${body}）\n    检查 MEMO_EMBED_MODEL 是否是该端点认识的模型名`)
  }
  const json = await res.json().catch(() => null)
  const vec = json?.data?.[0]?.embedding
  if (!Array.isArray(vec)) return fail('嵌入响应', '没有 data[0].embedding（不是 OpenAI /v1/embeddings 形状）')
  if (vec.length !== EMBED_DIM) {
    return fail('嵌入维度', `端点返回 ${vec.length} 维，配置要求 ${EMBED_DIM} 维\n    插件不发 dimensions 参数：MEMO_EMBED_DIM 必须等于模型真实输出维度，否则 KNN 全错位`)
  }
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0))
  pass('嵌入端点', `${EMBED_MODEL} ${vec.length} 维 ${ms}ms（L2=${norm.toFixed(4)}）`)
}

async function checkProfile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const profileDir = process.env.DSH_PROFILE_DIR || join(home, 'profiles', process.env.DSH_PROFILE || 'desktop')
  try { mkdirSync(join(home, 'memo-river'), { recursive: true }) } catch { /* 下面统一判 */ }
  if (!existsSync(home)) return warn('DSH_HOME', `${home} 不存在（还没启动过 DSH？）`)
  if (existsSync(join(home, 'memo-river'))) pass('工作区根可写', join(home, 'memo-river'))
  else fail('工作区根', `无法创建 ${join(home, 'memo-river')}`)

  const manifest = join(profileDir, 'package.json')
  if (!existsSync(manifest)) {
    return warn('DSH profile', `找不到 ${manifest}（CLI 自定义 profile？用 DSH_PROFILE=<名字> / DSH_PROFILE_DIR=<目录> 指过去）`)
  }
  let pkg
  try { pkg = JSON.parse(readFileSync(manifest, 'utf8')) } catch (e) { return warn('DSH profile', `package.json 解析失败：${e.message}`) }
  const dep = pkg?.dependencies?.['@dsh-external/dsh-memo-river']
  const inBundles = (pkg?.dsh?.profile?.bundles || []).includes('@dsh-external/dsh-memo-river')
  if (!dep) {
    return warn('profile 未安装本插件', `在 GUI「插件 → 添加插件」选 ${ROOT}；或让 agent 执行 plugin_manager install_bundle target=${ROOT}`)
  }
  const recorded = String(dep).replace(/^(link|file):/, '')
  const resolved = recorded.startsWith('/') || /^[A-Za-z]:/.test(recorded) ? recorded : resolve(profileDir, recorded)
  if (resolve(resolved) !== ROOT) {
    return warn('profile 装的是另一个 checkout', `记录=${dep} 解析=${resolved}（本仓=${ROOT}）\n    若要用本仓：重装 bundle（remove → install）后再重启 DSH`)
  }
  if (!inBundles) return warn('bundle 未选中', 'dsh.profile.bundles 里没有它 —— 重装：plugin_manager remove_bundle → install_bundle')
  pass('profile 已装', profileDir)
}

async function main() {
  console.log(`\ndsh-memo-river doctor · repo=${ROOT}\n${'─'.repeat(72)}`)
  await checkNode()
  await checkLib()
  await checkKernel()
  await checkEmbed()
  await checkProfile()

  const count = (l) => results.filter((r) => r.level === l).length
  console.log('─'.repeat(72))
  console.log(`${count('PASS')} PASS · ${count('WARN')} WARN · ${count('FAIL')} FAIL`)
  if (count('FAIL') > 0) {
    console.log('\n有 FAIL：按每条下面的提示修，修完重跑 `node scripts/doctor.mjs`。')
    process.exit(1)
  }
  console.log('\n可以用了：GUI 新会话选「记忆河流（Memo River）」；对话里问一句应看到被动召回块。')
}

main().catch((e) => {
  console.error('doctor 自身崩溃：', e)
  process.exit(1)
})
