// 探针：票⑥A artifactSig 确定性验证（验收判据：全新副本库连打 ensureArtifact，
// source_graph_generation 完全一致；跨进程亦一致——两个独立 node 进程各打 3 次）。
// 修复前基线见 D24：全新副本库 6/6 唯一（11-19ms/次）；生产 23 篇积 148 行漂移产物。
//
// 用法：
//   node scripts/probe-sig-determinism.mjs           # 主模式：本进程 6 次 + 两个子进程各 3 次
//   node scripts/probe-sig-determinism.mjs --child   # 子模式：3 次，输出 JSON 供父进程比对
//
// 设计要点：
// · 语料源 = preset-composer 桶（a92f187fa21e8a80，31 篇，闲置，D24 记录 25 种图形状变体）。
// · 每个进程用独立 cwd → 独立 workspacePaths root → 独立库副本（§11 WAL 双开教训：绝不双开同一文件）。
// · ensureArtifact() 默认 force=false：rebuildMemoArtifact 每次都真跑 Rust 构建；
//   force=true 会连 EPA/residuals/pairwise 重算（写库），那不是本票靶标。
// · sourceElapsedMs>0 / nodeCount>0 断言防止「早退未构建」的空洞通过。
import { rmSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { acquireWorkspace, releaseAllWorkspaces } from '../lib/workspace.js'
import { workspacePaths } from '../lib/runtime.js'
import { Config as ConfigSchema } from '../lib/index.js'

const SRC_DB = '/home/h/.dsh/memo-river/a92f187fa21e8a80/knowledge_base.sqlite'
const BUCKET = 'preset-composer'
const VCP_ROOT = '/home/h/app/VCPToolBox'
const childMode = process.argv.includes('--child')

if (!existsSync(SRC_DB)) {
  console.error(`FATAL 源库不存在: ${SRC_DB}`)
  process.exit(1)
}

async function runSet(label, count) {
  const cwd = join(tmpdir(), `probe-sig-${process.pid}-${label}`)
  rmSync(cwd, { recursive: true, force: true })
  mkdirSync(cwd, { recursive: true })
  const paths = workspacePaths(cwd, BUCKET)
  rmSync(paths.root, { recursive: true, force: true })
  mkdirSync(paths.root, { recursive: true })
  copyFileSync(SRC_DB, join(paths.root, 'knowledge_base.sqlite'))

  const ws = acquireWorkspace(cwd, ConfigSchema({ bucket: BUCKET, native: { vcpRoot: VCP_ROOT } }))
  const loaded = await ws.ensureLoaded()
  if (!loaded) throw new Error('engine 未加载')

  const sigs = []
  for (let i = 0; i < count; i++) {
    const state = await ws.engine.ensureArtifact()
    if (!(state.nodeCount > 0)) throw new Error(`run${i + 1} nodeCount=${state.nodeCount}（构建器未跑？）`)
    if (!(state.sourceElapsedMs > 0)) throw new Error(`run${i + 1} sourceElapsedMs=${state.sourceElapsedMs}（早退？）`)
    sigs.push(state.artifactSig)
    if (!childMode) {
      console.log(`  ${label} run${i + 1}: sig=${state.artifactSig.slice(0, 24)}… elapsed=${state.sourceElapsedMs}ms nodes=${state.nodeCount} edges=${state.edgeCount} persisted=${state.persisted}`)
    }
  }
  releaseAllWorkspaces()
  rmSync(cwd, { recursive: true, force: true })
  rmSync(paths.root, { recursive: true, force: true })
  return sigs
}

if (childMode) {
  runSet('child', 3)
    .then((sigs) => { console.log(JSON.stringify({ sigs })) })
    .catch((e) => { console.error(`FATAL ${e}`); process.exit(1) })
} else {
  console.log(`== 票⑥A artifactSig 确定性探针 ==`)
  console.log(`源库: ${SRC_DB}`)
  runSet('main', 6).then(async (mainSigs) => {
    const children = [1, 2].map((n) =>
      spawnSync(process.execPath, [new URL(import.meta.url).pathname, '--child'], { encoding: 'utf8', timeout: 120_000 })
    )
    let childSigs = []
    children.forEach((r, i) => {
      if (r.status !== 0) throw new Error(`child${i + 1} 退出码 ${r.status}: ${r.stderr}`)
      const line = r.stdout.trim().split('\n').pop()
      childSigs = childSigs.concat(JSON.parse(line).sigs)
    })
    const all = [...mainSigs, ...childSigs]
    const unique = [...new Set(all)]
    console.log(`\n== 结果 ==`)
    console.log(`本进程 6 次: ${[...new Set(mainSigs)].length} 个唯一 sig`)
    console.log(`两子进程 3+3 次: ${[...new Set(childSigs)].length} 个唯一 sig`)
    console.log(`合计 ${all.length} 次 / 唯一 ${unique.length} 个`)
    if (unique.length === 1) {
      console.log(`PASS ✅ artifactSig 跨调用跨进程逐位一致: ${unique[0].slice(0, 32)}…`)
      process.exit(0)
    } else {
      console.log(`FAIL ❌ 仍存在漂移（若本进程内即漂移→build 路径残余；若仅跨进程不同→逐进程状态渗入）`)
      unique.forEach((s, i) => console.log(`  [${i}] ${s}`))
      process.exit(1)
    }
  }).catch((e) => { console.error(`FATAL ${e}`); process.exit(1) })
}
