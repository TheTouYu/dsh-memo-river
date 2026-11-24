/**
 * scripts/lib/extract-asar-deps.mjs — 由 Electron-as-node 运行（asar 只能被 Electron 的 fs 读）。
 *
 * 把 DSH Desktop 的 app.asar 里「与本次构建/运行相关」的包，连同它们的 dependencies
 * 递归复制到 <dest>/node_modules。缺失的包只记 warning，不中断（Node 解析不到就回退）。
 *
 * 调用方：scripts/setup.mjs
 *   ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness 可执行文件>" scripts/lib/extract-asar-deps.mjs <asarRoot> <dest>
 *   asarRoot = <...>/resources/app.asar/dsh（含 node_modules）
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const [asarRoot, dest] = process.argv.slice(2)
if (!asarRoot || !dest) {
  console.error('usage: extract-asar-deps.mjs <asarRoot> <destDir>')
  process.exit(64)
}
const SRC = join(asarRoot, 'node_modules')
const OUT = join(dest, 'node_modules')

/** 构建与运行期真正需要的包（typescript 不在 asar 里，由 setup 走 npm 安装）。 */
const ROOTS = [
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/cordis',
  '@deepseek-ai/cosmokit',
  '@deepseek-ai/schemastery',
  '@standard-schema/spec',
  '@types/node',
  'undici',
]

function copyTree(src, out, stats) {
  const st = statSync(src)
  if (st.isDirectory()) {
    mkdirSync(out, { recursive: true })
    for (const name of readdirSync(src)) copyTree(join(src, name), join(out, name), stats)
    return
  }
  mkdirSync(dirname(out), { recursive: true })
  const buf = readFileSync(src)
  writeFileSync(out, buf)
  stats.files++
  stats.bytes += buf.length
}

const seen = new Set()
const queue = [...ROOTS]
const copied = []
const missing = []
const stats = { files: 0, bytes: 0 }

while (queue.length) {
  const name = queue.shift()
  if (seen.has(name)) continue
  seen.add(name)
  const pkgFile = join(SRC, name, 'package.json')
  if (!existsSync(pkgFile)) { missing.push(name); continue }
  let pkg
  try { pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) } catch { missing.push(`${name} (bad manifest)`); continue }
  try {
    copyTree(join(SRC, name), join(OUT, name), stats)
    copied.push(`${name}@${pkg.version ?? '?'}`)
  } catch (e) {
    missing.push(`${name} (${e.message})`)
    continue
  }
  for (const dep of Object.keys(pkg.dependencies ?? {})) if (!seen.has(dep)) queue.push(dep)
}

try { writeFileSync(join(dest, 'runtime.json'), readFileSync(join(asarRoot, 'package.json'))) } catch (e) { console.log('[extract] runtime.json 写入失败:', e.message) }
console.log(`[extract] copied ${copied.length} packages, ${stats.files} files, ${(stats.bytes / 1048576).toFixed(1)} MB`)
if (missing.length) console.log(`[extract] skipped ${missing.length}: ${missing.join(', ')}`)
