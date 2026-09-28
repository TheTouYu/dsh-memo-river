#!/usr/bin/env node
/**
 * setup-selftest.mjs — 一次性铺好验收用的三个工作区（幂等、可重复）。
 *
 *   · 教室建模归档      河流语料（11 篇，15 个复用 Tag，连通分量 = 1）—— #8 的对照基准
 *   · 教室建模孤岛      孤岛语料（11 篇，54 个一次性 Tag，连通分量 = 11）—— #7 的回归样本
 *   · 教室建模写入测试  河流语料的**副本**——#6 的写入回归在这里落库，
 *                       保证 #8 面对的语料始终是原始对照（早期版本 #6 直接写河流库，
 *                       把 #8 的 chunk id 整体顶掉了，属于测试编排缺陷而非实现缺陷）。
 *
 * 只清理这三个工作区对应的 `~/.dsh/memo-river/<hash>` 目录，不动其它工作区数据。
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { workspacePaths } from '../lib/runtime.js'
import { KnowledgeStore } from '../lib/store.js'

/* 仓库根按脚本自身位置解析（迁移后仓库不在 /home/h/app/dsh-memo-river 了）。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VCP = '/home/h/app/VCPToolBox'
const RIVER_SRC = join(VCP, 'dailynote', '教室建模归档')
const ISLAND_SRC = join(ROOT, '.selftest', 'island-corpus')
const ISLAND_STAGE = join(ROOT, '.selftest', 'island-corpus')

const WS_RIVER = { cwd: join(ROOT, '.selftest', '教室建模归档'), bucket: '教室建模归档' }
const WS_ISLAND = { cwd: join(ROOT, '.selftest', '教室建模孤岛'), bucket: '教室建模孤岛' }
const WS_WRITE = { cwd: join(ROOT, '.selftest', '教室建模写入测试'), bucket: '教室建模写入测试' }

/* 提速资产（0916）：异步 spawn——同步版会阻塞父进程事件循环，父进程里的嵌入桩
 * 无法应答子进程请求 → 60s 死锁超时（write-prompts 无此问题因为不分叉）。 */
const execFileAsync = promisify(execFile)
const run = async (args) => {
  console.log(`\n$ node ${args.join(' ')}`)
  const { stdout } = await execFileAsync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' })
  console.log(stdout.trim())
}

/* ① 清理这三个工作区（只删它们自己的目录） */
for (const ws of [WS_RIVER, WS_ISLAND, WS_WRITE]) {
  const paths = workspacePaths(ws.cwd, ws.bucket)
  if (existsSync(paths.root)) {
    rmSync(paths.root, { recursive: true, force: true })
    console.log(`清理 ${paths.root}`)
  }
  mkdirSync(ws.cwd, { recursive: true })
}

/* ② 河流语料 */
/* 提速资产（0916）：缺省本地嵌入桩（REAL_EMBED=1 回落真端点）→ setup 从 ~30s 降到秒级。 */
const { startEmbedStub } = await import('./embed-stub.mjs')
const REAL_EMBED = process.env.REAL_EMBED === '1'
const stub = REAL_EMBED ? null : await startEmbedStub('hash')
if (stub) process.env.EMBED_STUB_URL = stub.url

await run(['scripts/import-dailynote.mjs', '--force', '--src', RIVER_SRC, '--cwd', WS_RIVER.cwd, '--bucket', WS_RIVER.bucket])

/* ③ 孤岛语料（先生成再导入） */
await run(['scripts/build-island-corpus.mjs', '--out', ISLAND_STAGE])
await run(['scripts/import-dailynote.mjs', '--force', '--src', ISLAND_SRC, '--cwd', WS_ISLAND.cwd, '--bucket', WS_ISLAND.bucket])

/* ④ 写入测试工作区 = 河流库的副本（含 emb-cache，写入时命中缓存不再消耗额度） */
{
  const src = workspacePaths(WS_RIVER.cwd, WS_RIVER.bucket)
  const dst = workspacePaths(WS_WRITE.cwd, WS_WRITE.bucket)
  mkdirSync(dst.root, { recursive: true })
  rmSync(dst.dbPath, { force: true })
  // 源库先 checkpoint 再拷贝：导入后数据可能全悬在源库自己的 WAL 里（rust keepalive 连接不随
  // 进程退出做 last-close checkpoint），只拷主库会得到 4KB 空壳——实测曾拷出只剩 1 篇的副本。
  {
    const srcStore = new KnowledgeStore(src.dbPath)
    srcStore.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    srcStore.close()
  }
  copyFileSync(src.dbPath, dst.dbPath)
  copyFileSync(src.embCachePath, dst.embCachePath)
  // 桶名不同 → 把副本里的 diary_name 改写为写入测试桶，避免两条工作区互相看见
  const store = new KnowledgeStore(dst.dbPath)
  store.db.exec(`UPDATE files SET diary_name = '${WS_WRITE.bucket}'`)
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)') // 副本自带全量数据，不依赖 WAL 恢复
  const counts = store.counts()
  store.close()
  console.log(`\n写入测试工作区 → ${dst.dbPath} ${JSON.stringify(counts)}`)
}

console.log('\n✅ 三个工作区已就绪')

try { await stub?.stop() } catch { /* 已关 */ }
