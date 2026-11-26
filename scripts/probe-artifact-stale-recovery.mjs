#!/usr/bin/env node
/**
 * probe-artifact-stale-recovery.mjs — 「几何事实陈旧把 artifact 重建锁死」的回归探针（TDD 红→绿）。
 *
 * 生产事故（2026-11-18 起，本桶召回全断 8 天）：Tag 写把 `kbm_runtime_meta.memo_tag_facts`
 * 推进，而最近一次 `unified_geometry` 行的 `graph_generation` 还停在旧值 →
 * `kernel/src/memo_artifact_builder.rs:171` 在 load_anchor_gains 里直接 Err
 * （`KNOWLEDGE_STORE_DERIVED_DEPENDENCY_CONFLICT: geometry facts are stale`）。
 * 该函数由 build 路径 `:817` 调用，于是**重建被自己的陈旧检查否决**：geometry 永远不刷新，
 * facts 永远前进，死锁。正确行为（上游契约注释见 kernel/src/memo_workspace_build_tests.rs:51
 * “A Tag write requires fresh geometry under the existing upstream contract”）：
 * 调用方在重建前先刷新 geometry，再重建 —— 即 `ensureArtifact` 必须能自愈。
 *
 * 本探针用**确定性夹具**复现，不依赖生产桶、不依赖嵌入端点：
 *   ① 临时 DSH_HOME + 临时工作目录（隔离，跑完删）
 *   ② 直接往插件自己的 store 连接里塞 1 file + 3 tag（1024 维单位向量）+ file_tags
 *   ③ ensureArtifact() → 发布 unified_geometry（graph_generation = facts:0）
 *   ④ UPDATE kbm_runtime_meta 把 memo_tag_facts 推到 1（= 生产里「Tag 写了、几何没更」的瞬间）
 *   ⑤ ensureArtifact() 必须仍然成功，且几何世代追平 facts:1
 *
 * 判据：
 *   P0 夹具建立：首次 ensureArtifact 成功且发布 unified_geometry（facts:0）
 *   P1 陈旧前置条件成立：facts=1 ≠ 几何 facts:0（否则本探针失去靶标，必须报错）
 *   P2 【靶标】第二次 ensureArtifact 不抛错（修复前抛 geometry facts are stale）
 *   P3 修复后几何世代 = facts:1（重建之后资产一致，不再陈旧）
 *
 * 用法：node scripts/probe-artifact-stale-recovery.mjs
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = import.meta.dirname
const SCRATCH = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'probe-stale-'))
const DSH_HOME = join(SCRATCH, 'dsh-home')
const WS = join(SCRATCH, 'ws')
mkdirSync(DSH_HOME, { recursive: true })
mkdirSync(WS, { recursive: true })
process.env.DSH_HOME = DSH_HOME // 必须在 import lib 之前

const LIB = join(ROOT, '..', 'lib')
const DIM = 1024
const { Config } = await import(join(LIB, 'config.js'))
const { acquireWorkspace, releaseAllWorkspaces } = await import(join(LIB, 'workspace.js'))

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const config = Config({
  bucket: 'stale-recovery',
  native: { vcpRoot: '/home/h/app/VCPToolBox' },
  embed: { apiUrl: 'http://127.0.0.1:8099', apiKey: 'local', model: 'baai/bge-m3', dimension: DIM },
})

const ws = await acquireWorkspace(WS, config, 'stale-recovery')
await ws.ensureLoaded()
const db = ws.store.db

/* ── 夹具：1 file + 3 tag（1024 维，单位向量）+ file_tags ── */
const blob = (index) => {
  const v = new Float32Array(DIM)
  v[index] = 1
  return Buffer.from(v.buffer)
}
db.exec("INSERT INTO files(id,path,diary_name,checksum,mtime,size) VALUES (1,'synthetic.txt','test','h',1,1)")
const insTag = db.prepare('INSERT INTO tags(id,name,vector) VALUES (?,?,?)')
insTag.run(1, 'a', blob(0))
insTag.run(2, 'b', blob(1))
insTag.run(3, 'c', blob(2))
db.exec('INSERT INTO file_tags VALUES (1,1,1),(1,2,2),(1,3,3)')
db.exec("INSERT OR REPLACE INTO kbm_runtime_meta(key,value) VALUES ('memo_tag_facts','0')")

const geometryGeneration = () => {
  const row = db
    .prepare("SELECT graph_generation FROM tagmemo_artifacts WHERE asset_type='unified_geometry' AND status='ready' ORDER BY updated_at DESC LIMIT 1")
    .get()
  return row?.graph_generation ?? null
}
const facts = () => db.prepare("SELECT value FROM kbm_runtime_meta WHERE key='memo_tag_facts'").get()?.value ?? null

/* ── ① 首次构建：发布几何，世代 facts:0 ── */
const first = await ws.engine.ensureArtifact()
check('P0 首次 ensureArtifact 成功并发布几何', geometryGeneration() === 'facts:0', `nodes=${first.nodeCount} gen=${geometryGeneration()}`)

/* ── ② 模拟生产里的「Tag 写了、几何没更」 ── */
db.exec("UPDATE kbm_runtime_meta SET value='1' WHERE key='memo_tag_facts'")
check('P1 陈旧前置条件成立（facts=1 ≠ 几何 facts:0）', facts() === '1' && geometryGeneration() === 'facts:0', `facts=${facts()} gen=${geometryGeneration()}`)

/* ── ③ 靶标：重建必须自愈，而不是被陈旧检查否决 ── */
let staleError = null
try {
  await ws.engine.ensureArtifact()
} catch (e) {
  staleError = String(e?.message ?? e)
}
check('P2 第二次 ensureArtifact 不抛错（修复前抛 geometry facts are stale）', staleError === null, staleError ?? 'ok')

/* ── ④ 修复后：几何世代追平 facts，之后重建不再陈旧 ── */
const gen = geometryGeneration()
check('P3 几何世代追平 facts:1', gen === 'facts:1', `gen=${gen}`)

releaseAllWorkspaces()
rmSync(SCRATCH, { recursive: true, force: true })

console.log(`\n结果：${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
