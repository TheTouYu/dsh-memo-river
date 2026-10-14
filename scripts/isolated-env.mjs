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
 *   · `MEMO_ACC_KEEP=1`        —— 跑完不删临时根（取证用，路径会打到 stderr）
 *   · `MEMO_ACC_TMP_ROOT=<dir>`—— 换临时根的父目录（缺省 `$TMPDIR` 或 `/var/tmp`）
 *   · `MEMO_ACC_NO_ISOLATE=1`  —— 明确要求不隔离（**故意**对真桶干活的运维件才用；
 *                                 测试套件不要设它，那正是本次要消灭的行为）
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const PARENT = process.env.MEMO_ACC_TMP_ROOT || process.env.TMPDIR || tmpdir() || '/var/tmp'
const KEEP = process.env.MEMO_ACC_KEEP === '1'
const NO_ISOLATE = process.env.MEMO_ACC_NO_ISOLATE === '1'

/** 临时根（保持导出，便于套件自己打印/断言）。 */
export const ISOLATED_ROOT = NO_ISOLATE ? null : mkdtempSync(join(PARENT, 'memo-river-acc-'))

if (ISOLATED_ROOT) {
  process.env.DSH_HOME = join(ISOLATED_ROOT, 'dsh-home')
  process.env.MEMO_ACC_ISOLATED = '1'
}

let cleaned = false
/** 清理隔离根（幂等）。不隔离时是空操作。 */
export function cleanupIsolatedEnv() {
  if (!ISOLATED_ROOT || cleaned) return
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
