/**
 * scripts/isolated-env.mjs — **测试套件的自建自净环境**（2026-10-14 卫生整改）。
 *
 * 为什么要它：memo-river 的每个工作目录配一个数据抽屉，抽屉名 = sha256(工作目录路径) 前 16 位
 * （`src/runtime.ts:23`），柜子位置 = `$DSH_HOME/memo-river/`（`src/runtime.ts:14`，缺省 `~/.dsh`）。
 * 套件把**工作目录**放 tmpdir（好习惯），但没设 `DSH_HOME` → 抽屉仍落在**生产柜子**里；而路径带
 * pid，每次跑都是新哈希 → 每次运行永久留下 7~14 个空抽屉（无 `knowledge_base.sqlite`、无 dailynote）。
 * 实测代价：一次追查「无头 emb-cache.bin」时，最早的 8 个可疑文件全躺在这种假桶里，误导取证半小时；
 * 普查 288 个抽屉里 186 个是空壳（其中 35 个正是最近 2 小时 5 次验收跑出来的）。
 *
 * 用法：**作为第一条 import 写进套件**（ESM 按源码顺序求值，它先于其它 import 生效）：
 *   import './isolated-env.mjs'
 * 之后照常 `import { acquireWorkspace } from '../lib/workspace.js'` 即可——`DSH_HOME` 是
 * 调用时懒读的（`runtime.ts:14` 在函数体内），所以文本顺序上「helper 在前」已足够安全。
 *
 * 环境变量：
 *   · `MEMO_ACC_HOME=<dir>` —— **持久隔离柜**：复用同一隔离 home（不删），首轮铺台只花一次
 *   · `MEMO_ACC_FIXTURE_MODE=stub` —— 铺台用 hash 桩（~2s，语义用例会红，仅调试）
 *   · `MEMO_ACC_KEEP=1`        —— 跑完不删临时根（取证用，路径会打到 stderr）
 *   · `MEMO_ACC_TMP_ROOT=<dir>`—— 换临时根的父目录（缺省 `$TMPDIR` 或 `/var/tmp`）
 *   · `MEMO_ACC_NO_ISOLATE=1`  —— 明确要求不隔离（**故意**对真桶干活的运维件才用；
 *                                 测试套件不要设它，那正是本次要消灭的行为）
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const PARENT = process.env.MEMO_ACC_TMP_ROOT || process.env.TMPDIR || tmpdir() || '/var/tmp'
const KEEP = process.env.MEMO_ACC_KEEP === '1'
const NO_ISOLATE = process.env.MEMO_ACC_NO_ISOLATE === '1'
/** 持久隔离柜（复用）：给了就用它当隔离根，且**退出不删**（首轮铺台只花一次）。 */
const PERSIST = process.env.MEMO_ACC_HOME && !NO_ISOLATE ? process.env.MEMO_ACC_HOME : null

/** 仓库根（scripts/ 的上一级）——铺台时定位 `scripts/setup-selftest.mjs`。 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 临时根（保持导出，便于套件自己打印/断言）。 */
export const ISOLATED_ROOT = NO_ISOLATE
  ? null
  : PERSIST
    ? (mkdirSync(PERSIST, { recursive: true }), PERSIST)
    : mkdtempSync(join(PARENT, 'memo-river-acc-'))

if (ISOLATED_ROOT) {
  process.env.DSH_HOME = join(ISOLATED_ROOT, 'dsh-home')
  process.env.MEMO_ACC_ISOLATED = '1'
}

/**
 * 在**隔离 home 里**自铺 `.selftest/教室建模{归档,孤岛,写入测试}` 三夹具（幂等，三库齐了即返回）。
 *
 * 为什么需要它：主套件（acceptance.mjs 等 8 个）跑前有**环境自检**，要求这三个夹具的库存在；
 * 不铺台就隔离 = 自检必红（EXIT=2）。铺台走官方 `scripts/setup-selftest.mjs`，但**必须真向量**
 * （`REAL_EMBED=1`）——缺省它用本地 hash 桩，随机向量下 gate 分数无意义，语义敏感用例成片红
 * （实测 25/37）。真向量走 api.relayrouter.ai（代理见 AGENTS.md），约 30~60s，故只在该 home 空缺时跑。
 *
 * @returns 本次是否真跑了铺台
 */
export async function ensureSelftestFixtures() {
  if (!ISOLATED_ROOT) return false
  const { workspacePaths } = await import('../lib/runtime.js')
  const fixtures = [
    ['教室建模归档', '教室建模归档'],
    ['教室建模孤岛', '教室建模孤岛'],
    ['教室建模写入测试', '教室建模写入测试'],
  ]
  const missingOf = () =>
    fixtures.filter(([dir, bucket]) => !existsSync(workspacePaths(join(REPO_ROOT, '.selftest', dir), bucket).dbPath))
  const missing = missingOf()
  // **每次重铺**（这些套件会消耗共享夹具：实测一波变体跑完，写入测试夹具从 11 篇掉到 1 篇——
  // merge 归档源篇、update 改写、consolidation/usage 各自写自己的小语料）。它们的文件头写的就是
  // `setup-selftest && acceptance-X`，即「每次先铺台」。要省这 ~20s 就设 MEMO_ACC_NO_REFRESH=1
  //（只在库缺失时铺）——但夹具不新鲜时会出现「明明隔离没错却成片红」的假象。
  const refresh = process.env.MEMO_ACC_NO_REFRESH !== '1'
  if (missing.length === 0 && !refresh) return false
  const stub = process.env.MEMO_ACC_FIXTURE_MODE === 'stub'
  process.stderr.write(
    `[isolated-env] 隔离柜${missing.length ? `缺 ${missing.length} 个夹具（${missing.map(([d]) => d).join('/')}）` : '重铺夹具'}→ 在 ${ISOLATED_ROOT} 内铺台` +
      `（${stub ? 'hash 桩：语义敏感用例会红' : 'REAL_EMBED=1 真向量，约 30~60s'}）…\n`,
  )
  const t0 = Date.now()
  const { spawnSync } = await import('node:child_process')
  let res = { status: -1 }
  let left = missingOf()
  // 连跑时铺台偶发失败（实测 rc=1、第三个夹具没铺出来——上一轮套件留下的库锁/异步任务未收）
  // → 退避 5s 重试一次；仍缺就由套件自己的环境自检报红（不静默）。
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      process.stderr.write(`[isolated-env] 仍缺 ${left.length} 个夹具 → 5s 后重试铺台（第 ${attempt + 1} 次）\n`)
      await new Promise((r) => setTimeout(r, 5000))
    }
    res = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'setup-selftest.mjs')], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: { ...process.env, DSH_HOME: process.env.DSH_HOME, REAL_EMBED: stub ? '0' : '1' },
    })
    left = missingOf()
    if (left.length === 0) break
  }
  process.stderr.write(
    `[isolated-env] 铺台结束 rc=${res.status} 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s` +
      `，仍缺 ${left.length} 个${left.length ? `（${left.map(([d]) => d).join('/')}）❌` : ' ✅'}\n`,
  )
  return true
}

let cleaned = false
/** 清理隔离根（幂等）。不隔离时是空操作。 */
export function cleanupIsolatedEnv() {
  if (!ISOLATED_ROOT || cleaned || PERSIST) return
  cleaned = true
  if (KEEP) {
    process.stderr.write(`[isolated-env] MEMO_ACC_KEEP=1，保留 ${ISOLATED_ROOT}\n`)
    return
  }
  try {
    rmSync(ISOLATED_ROOT, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响退出码 */
  }
}

if (ISOLATED_ROOT) {
  process.on('exit', cleanupIsolatedEnv)
  // 信号路径：清完再按默认语义自杀（保留被信号终止的退出码语义），避免只删一半就退出
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const onSignal = () => {
      process.off(sig, onSignal)
      cleanupIsolatedEnv()
      process.kill(process.pid, sig)
    }
    process.on(sig, onSignal)
  }
}
