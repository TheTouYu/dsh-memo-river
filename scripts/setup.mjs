#!/usr/bin/env node
/**
 * scripts/setup.mjs — 一条命令把仓库准备到可运行（Windows / macOS / Linux，零第三方依赖）。
 *
 * 做的事（幂等，可反复跑）：
 *   1. 校验 Node（node:sqlite 需要 ≥22.5）
 *   2. 准备 node_modules：缺 typescript 就 `npm install`
 *   3. 解析「与运行期同一份」的 DSH 类型源，并 link 进 node_modules：
 *        · 已安装的 npm 布局（dsh 在 PATH / DSH_INSTALL_DIR）
 *        · DSH 源码 checkout（DSH_CHECKOUT）
 *        · Desktop 的 app.asar（用 Electron-as-node 抽出所需包到 .deps/）
 *   4. 编译 src/ → lib/（tsc），并校验产物不是 0 字节假成功
 *   5. 内核 kernel/ → .node：有 cargo 就源码编译；没有则用随仓预编译件
 *      （仓库只带 Windows x64 预编译；其它平台需装 Rust）
 *
 * 用法：
 *   node scripts/setup.mjs               # 全流程
 *   node scripts/setup.mjs --no-kernel   # 只准备 lib（内核另行处理）
 *   node scripts/setup.mjs --kernel-only # 只处理内核
 *   node scripts/setup.mjs --force-types # 强制重建类型链接（DSH 升级后用）
 *
 * 退出码：0 全好；1 有硬失败；2 只有内核未就绪（其余可用）
 */
import { existsSync, mkdirSync, rmSync, symlinkSync, copyFileSync, renameSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { join, dirname, resolve, relative, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { homedir, platform, arch } from 'node:os'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEPS = join(ROOT, '.deps')
const NM = join(ROOT, 'node_modules')
const IS_WIN = platform() === 'win32'
const ARGS = new Set(process.argv.slice(2))
const FLAG = (name) => ARGS.has(`--${name}`)
const KERNEL_EXT = IS_WIN ? 'unknown' : platform() === 'linux' ? 'gnu' : 'unknown'
const KERNEL_NAME = `memo-kernel.${platform()}-${arch()}-${KERNEL_EXT}.node`

const log = (msg) => console.log(`[setup] ${msg}`)
const warn = (msg) => console.warn(`[setup] WARN ${msg}`)
const fail = (msg) => { console.error(`[setup] FAIL ${msg}`); process.exit(1) }
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts })

/**
 * 调 npm 的稳妥方式：优先用 `node <npm-cli.js>`（无 shell、无参数拼接、无 DEP0190），
 * 找不到再退回 `npm(.cmd) + shell`（Node 不允许 shell:false 直接跑 .cmd）。
 */
function npmCommand(args) {
  const candidates = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  const cli = candidates.find((p) => existsSync(p))
  if (cli) return { cmd: process.execPath, args: [cli, ...args], shell: false }
  return IS_WIN ? { cmd: 'npm.cmd', args, shell: true } : { cmd: 'npm', args, shell: false }
}


/* ─────────────────────────── 1. Node 版本 ─────────────────────────── */
function checkNode() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 5)) fail(`Node ${process.versions.node} 太旧：本插件用 node:sqlite（DatabaseSync），需要 >=22.5（建议 24 LTS）`)
  if (major < 24) warn(`Node ${process.versions.node}：仓库在 24.x 上验证；22.x 可用但未做全套回归`)
  log(`node ${process.versions.node} (${platform()}-${arch()}) OK`)
}

/* ─────────────────────── 2. 找 DSH（类型源） ─────────────────────── */
function desktopCandidates() {
  const list = []
  if (process.env.DSH_DESKTOP_ROOT) list.push(process.env.DSH_DESKTOP_ROOT)
  const local = process.env.LOCALAPPDATA || ''
  if (IS_WIN) list.push(join(local, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar', 'dsh'))
  if (platform() === 'darwin') list.push('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh')
  if (platform() === 'linux') {
    list.push('/opt/DeepSeek Harness/resources/app.asar/dsh')
    list.push(join(homedir(), '.local', 'share', 'deepseek-harness', 'resources', 'app.asar', 'dsh'))
  }
  return list
}

/** 从 PATH 上的 dsh（npm 全局安装）猜包根。 */
function installedFromPath() {
  const exts = IS_WIN ? ['.cmd', '.exe', ''] : ['']
  for (const dir of (process.env.PATH || '').split(IS_WIN ? ';' : ':')) {
    if (!dir) continue
    for (const ext of exts) {
      const bin = join(dir, IS_WIN ? `dsh${ext}` : 'dsh')
      if (!existsSync(bin)) continue
      // <prefix>/bin/dsh -> <prefix>/lib/node_modules/@deepseek-ai/dsh（或 <prefix>/node_modules/...）
      for (const up of [join(dir, '..'), dir, join(dir, '..', 'lib')]) {
        for (const nm of [join(up, 'node_modules'), join(up, 'lib', 'node_modules')]) {
          if (existsSync(join(nm, '@deepseek-ai', 'dsh-tools'))) return nm
          const nested = join(nm, '@deepseek-ai', 'dsh', 'node_modules')
          if (existsSync(join(nested, '@deepseek-ai', 'dsh-tools'))) return nested
        }
      }
    }
  }
  return null
}

/** @returns {{kind:'nm'|'asar'|'checkout', nodeModules?:string, asarRoot?:string, electron?:string, checkout?:string, label:string}} */
function findDsh() {
  // a) 显式 DSH_INSTALL_DIR（桌面版 launcher 会注入，指向 <asar>/dsh/node_modules）
  const envDir = process.env.DSH_INSTALL_DIR
  if (envDir && existsSync(join(envDir, '@deepseek-ai', 'dsh-tools'))) return { kind: 'nm', nodeModules: envDir, label: envDir }

  // b) PATH 上的 npm 全局 dsh
  const nm = installedFromPath()
  if (nm) return { kind: 'nm', nodeModules: nm, label: nm }

  // c) 源码 checkout
  const checkout = process.env.DSH_CHECKOUT
  if (checkout && existsSync(join(checkout, 'packages'))) return { kind: 'checkout', checkout, label: checkout }

  // d) Desktop 的 app.asar（普通 node 看不见 asar 内部，只能验 asar 文件与可执行文件）
  for (const root of desktopCandidates()) {
    const asarFile = dirname(root) // <resources>/app.asar
    if (basename(asarFile) !== 'app.asar' || !existsSync(asarFile)) continue
    const resources = dirname(asarFile)
    const product = dirname(resources)
    const electron = IS_WIN
      ? join(product, 'DeepSeek Harness.exe')
      : platform() === 'darwin'
        ? join(product, 'MacOS', 'DeepSeek Harness')
        : join(product, 'deepseek-harness')
    if (!existsSync(electron)) continue
    return { kind: 'asar', asarRoot: root, electron, label: root }
  }
  return null
}

/* ─────────────────── 3. node_modules / typescript ─────────────────── */
function ensureNpmDeps() {
  mkdirSync(NM, { recursive: true })
  if (existsSync(join(NM, 'typescript', 'lib', 'tsc.js'))) {
    log('typescript 已就绪')
    return
  }
  if (FLAG('no-npm')) fail('缺 typescript 且指定了 --no-npm：请先 `npm install`，或用 TSC=<tsc 路径> 指一个现成编译器')
  log('未找到 typescript，执行 npm install（只装 devDependencies 需要的包）…')
  const npm = npmCommand(['install', '--no-audit', '--no-fund'])
  const res = run(npm.cmd, npm.args, { shell: npm.shell })
  if (res.status !== 0) {
    fail('npm install 失败。常见原因：registry 不可达/需代理。可设 `npm config set registry https://registry.npmmirror.com`，或手动 `npm install` 后重跑本脚本')
  }
  if (!existsSync(join(NM, 'typescript', 'lib', 'tsc.js'))) fail('npm install 完成但仍找不到 typescript —— 检查 package.json devDependencies')
}

/* ───────────── 4. 类型源：从 DSH 安装 / checkout / asar 链接 ───────── */
const LINK_PLAN = [
  // [node_modules 里的名字, npm 安装布局下的真实包名]
  ['cordis', '@deepseek-ai/cordis'],
  ['cosmokit', '@deepseek-ai/cosmokit'],
  ['schemastery', '@deepseek-ai/schemastery'],
  ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-tools'],
  ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-llm'],
  ['@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-system-prompt'],
  ['@types/node', '@types/node'],
  ['@standard-schema/spec', '@standard-schema/spec'],
  ['undici', 'undici'],
]
const CHECKOUT_PLAN = {
  cordis: ['vendor', 'cordis'],
  cosmokit: ['vendor', 'cosmokit'],
  schemastery: ['vendor', 'schemastery'],
  '@deepseek-ai/dsh-tools': ['packages', 'core', 'tools'],
  '@deepseek-ai/dsh-llm': ['packages', 'llm', 'llm'],
  '@deepseek-ai/dsh-system-prompt': ['packages', 'core', 'system-prompt'],
  '@types/node': ['node_modules', '@types', 'node'],
}

function linkInto(name, target) {
  const link = join(NM, name)
  rmSync(link, { recursive: true, force: true })
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(target, link, IS_WIN ? 'junction' : 'dir')
  log(`link ${name} -> ${relative(ROOT, target) || target}`)
}

function extractAsarDeps(dsh) {
  const marker = join(DEPS, 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json')
  if (!FLAG('force-types') && existsSync(marker)) { log('.deps 已有抽取结果（--force-types 可重建）'); return }
  log('从 Desktop app.asar 抽取类型/运行期包到 .deps …')
  rmSync(DEPS, { recursive: true, force: true })
  mkdirSync(DEPS, { recursive: true })
  const helper = join(ROOT, 'scripts', 'extract-asar-deps.mjs')
  const res = spawnSync(dsh.electron, [helper, dsh.asarRoot, DEPS], {
    cwd: ROOT, stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  if (res.status !== 0) fail('asar 抽取失败：确认 DeepSeek Harness 安装完整（Electron-as-node 可运行）')
}

const ASAR_TYPE_PKGS = [
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/cordis',
  '@deepseek-ai/cosmokit',
  '@deepseek-ai/schemastery',
]

/**
 * Desktop 的 app.asar **剥掉了 .d.ts**，光抽包无法编译。
 * 对策：从 asar 的 package.json 读出运行期版本，用 npm 装**同版本**的类型包到 .deps/types。
 * （这就是「类型必须与运行期同一份」红线的落地方式；离线环境只能改用 DSH 源码 checkout。）
 */
function installAsarTypes() {
  const typesDir = join(DEPS, 'types')
  const marker = join(typesDir, 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json')
  if (!FLAG('force-types') && existsSync(marker)) { log('.deps/types 类型包已就绪'); return true }
  const runtimeFile = join(DEPS, 'runtime.json')
  if (!existsSync(runtimeFile)) { warn('缺 .deps/runtime.json，无法确定运行期版本'); return false }
  let deps = {}
  try { deps = JSON.parse(readFileSync(runtimeFile, 'utf8')).dependencies ?? {} } catch { /* 下面按空处理 */ }
  const specs = ASAR_TYPE_PKGS.map((n) => (deps[n] ? `${n}@${deps[n]}` : null)).filter(Boolean)
  if (specs.length < ASAR_TYPE_PKGS.length) {
    warn(`runtime.json 只给出 ${specs.length}/${ASAR_TYPE_PKGS.length} 个包版本`)
  }
  if (!specs.length) return false
  log(`Desktop asar 不含 .d.ts；从 npm 装同版本类型包（${specs.length} 个）…`)
  rmSync(typesDir, { recursive: true, force: true })
  mkdirSync(typesDir, { recursive: true })
  const npm = npmCommand(['install', '--prefix', typesDir, '--no-save', '--no-package-lock', '--no-audit', '--no-fund', ...specs])
  const res = spawnSync(npm.cmd, npm.args, { cwd: typesDir, stdio: 'inherit', shell: npm.shell })
  if (res.status !== 0) {
    warn('类型包 npm 安装失败（离线/registry 不可达）：改用 .deps 的 asar 运行期包，tsc 可能报缺声明')
    return false
  }
  return true
}

function ensureTypes(dsh) {
  if (FLAG('force-types')) {
    for (const [name] of LINK_PLAN) rmSync(join(NM, name), { recursive: true, force: true })
  }
  const missing = LINK_PLAN.filter(([name]) => !existsSync(join(NM, name, 'package.json')))
  if (missing.length === 0) { log('类型/运行期包链接齐全'); return }

  if (dsh.kind === 'asar') {
    // 抽包拿到运行期包 + runtime.json；类型声明必须另从 npm 装同版本（asar 里被剥掉了）
    extractAsarDeps(dsh)
    installAsarTypes()
  }

  for (const [name, pkg] of missing) {
    const candidates = []
    if (dsh.kind === 'nm') candidates.push(join(dsh.nodeModules, ...pkg.split('/')))
    if (dsh.kind === 'asar') {
      candidates.push(join(DEPS, 'types', 'node_modules', ...pkg.split('/')))
      candidates.push(join(DEPS, 'node_modules', ...pkg.split('/')))
    }
    if (dsh.kind === 'checkout' && CHECKOUT_PLAN[name]) candidates.push(join(dsh.checkout, ...CHECKOUT_PLAN[name]))
    if (name === '@standard-schema/spec' && dsh.kind === 'checkout') {
      // pnpm checkout：在 .pnpm 里找
      const pnpmDir = join(dsh.checkout, 'node_modules', '.pnpm')
      if (existsSync(pnpmDir)) {
        for (const entry of readdirSync(pnpmDir)) {
          if (!entry.startsWith('@standard-schema+spec@')) continue
          candidates.push(join(pnpmDir, entry, 'node_modules', '@standard-schema', 'spec'))
        }
      }
    }
    const target = candidates.find((p) => existsSync(join(p, 'package.json')))
    if (!target) {
      warn(`找不到 ${name} 的类型源（DSH=${dsh.label}）；tsc 可能报 Cannot find module '${name}'`)
      continue
    }
    linkInto(name, target)
  }
}

/* ─────────────────────────── 5. 编译 src → lib ─────────────────────────── */
function buildLib() {
  const tsc = [process.env.TSC, join(NM, 'typescript', 'lib', 'tsc.js'), join(ROOT, 'node_modules', '.bin', IS_WIN ? 'tsc.cmd' : 'tsc')]
    .filter(Boolean).find((p) => existsSync(p))
  if (!tsc) fail('找不到 tsc：`npm install` 之后应出现 node_modules/typescript；也可用 TSC=<tsc> 指定')
  log(`tsc: ${relative(ROOT, tsc) || tsc}`)
  const res = tsc.endsWith('.js') ? run(process.execPath, [tsc, '-p', 'tsconfig.json']) : run(tsc, ['-p', 'tsconfig.json'], { shell: IS_WIN })
  if (res.status !== 0) fail(`tsc 退出码 ${res.status}（滚上去看第一条 TS 错误）`)

  const index = join(ROOT, 'lib', 'index.js')
  if (!existsSync(index)) fail('编译"成功"但 lib/index.js 不存在——典型的 0 字节 tsc 坏壳，换 `node node_modules/typescript/lib/tsc.js` 重跑')
  const size = statSync(index).size
  if (size < 4096) fail(`lib/index.js 只有 ${size}B，构建明显不完整`)
  const count = readdirSync(join(ROOT, 'lib')).filter((f) => f.endsWith('.js')).length
  for (const marker of ['apply', 'Config']) {
    if (!readFileSync(index, 'utf8').includes(marker)) fail(`lib/index.js 缺导出标记 ${marker}`)
  }
  log(`lib OK: ${count} 个 .js，index.js ${size}B`)
}

/* ─────────────────────────── 6. 内核 .node ─────────────────────────── */
function placeKernel(fromFile) {
  const kernelDir = join(ROOT, 'kernel')
  for (const name of [KERNEL_NAME, 'memo-kernel.node']) {
    const dest = join(kernelDir, name)
    const tmp = join(kernelDir, `.${name}.tmp-${process.pid}`)
    copyFileSync(fromFile, tmp)
    renameSync(tmp, dest) // 换 inode：已 mmap 的旧 .node 不会被原地改写
  }
}

function verifyKernel() {
  const probe = `const m=require(${JSON.stringify(join(ROOT, 'kernel', 'index.js'))});const i=new m.VexusIndex(4,8);console.log('exports='+Object.keys(m).join(','));`
  const res = spawnSync(process.execPath, ['-e', probe], { cwd: ROOT, encoding: 'utf8' })
  if (res.status !== 0) fail(`内核装载失败：${(res.stderr || '').split('\n')[0]}`)
  return res.stdout.trim()
}

function buildKernel() {
  const kernelDir = join(ROOT, 'kernel')
  const triple = `${platform()}-${arch()}`
  const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8' })
  const hasCargo = cargo.status === 0

  if (hasCargo) {
    log(`cargo: ${cargo.stdout.trim()}`)
    const res = run('cargo', ['build', '--release'], { cwd: kernelDir })
    if (res.status !== 0) fail(`cargo build 失败（Windows 需要 MSVC：cl/link；Linux 需 gcc/clang）`)
    const artifact = join(kernelDir, 'target', 'release', IS_WIN ? 'memo_kernel.dll' : platform() === 'darwin' ? 'libmemo_kernel.dylib' : 'libmemo_kernel.so')
    if (!existsSync(artifact)) fail(`cargo 成功但产物不存在：${artifact}`)
    placeKernel(artifact)
    return { status: 'built', detail: verifyKernel() }
  }

  const prebuilt = join(kernelDir, 'prebuilt', triple, KERNEL_NAME)
  if (existsSync(prebuilt)) {
    warn('cargo 不在 PATH，使用随仓预编译内核（可能与 kernel/ 源码不同步；装 Rust 后跑 --kernel-only 重编）')
    placeKernel(prebuilt)
    return { status: 'prebuilt', detail: verifyKernel() }
  }
  return { status: 'missing', detail: `$(cargo 不在 PATH)，且没有 kernel/prebuilt/${triple}/` }
}

/* ─────────────────────────────── main ─────────────────────────────── */
function main() {
  console.log('')
  log(`repo: ${ROOT}`)
  log(`platform: ${platform()}-${arch()}`)

  const onlyKernel = FLAG('kernel-only')
  if (!onlyKernel) {
    checkNode()
    const dsh = findDsh()
    if (!dsh) {
      fail('找不到 DSH（类型来源）。三条路任选：\n' +
        '  · 装 Desktop 版并至少启动过一次（脚本会自动从 app.asar 抽类型）\n' +
        '  · 设 DSH_CHECKOUT=<dsh 源码目录>（含 packages/）\n' +
        '  · 设 DSH_INSTALL_DIR=<含 @deepseek-ai/dsh-tools 的 node_modules 目录>')
    }
    log(`DSH: ${dsh.kind} ${dsh.label}`)
    ensureNpmDeps()
    ensureTypes(dsh)
    buildLib()
  }

  let kernel = { status: 'skipped', detail: '--no-kernel / --kernel-only 未执行' }
  if (!FLAG('no-kernel')) kernel = buildKernel()

  console.log('')
  console.log('─'.repeat(72))
  log(`lib:    ${onlyKernel ? '(skipped)' : 'built'}`)
  log(`kernel: ${kernel.status}${kernel.status === 'missing' ? '' : `  ${kernel.detail}`}`)
  if (kernel.status === 'missing') {
    console.log('')
    warn('内核未就绪 → 召回不可用。二选一：')
    warn('  · 装 Rust（https://rustup.rs；Windows 另需 VS Build Tools 的 C++ 工作负载），然后 node scripts/setup.mjs --kernel-only')
    warn('  · 或把某台机器上编好的 kernel/memo-kernel.<platform>-<arch>-<gnu|unknown>.node 放进 kernel/')
  }
  console.log('')
  log('下一步：')
  log('  1) node scripts/doctor.mjs       # 体检：内核可装载 + 嵌入端点维度 + profile 是否已装')
  log('  2) 把插件装进 DSH：GUI「插件 → 添加插件」选本目录；或让 DSH 里的 agent 执行')
  log(`     plugin_manager action=install_bundle target=${ROOT}`)
  log('  3) GUI 新会话选「记忆河流（Memo River）」')
  console.log('')
  if (kernel.status === 'missing') process.exit(2)
}

main()

