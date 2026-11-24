/**
 * safe-rm.mjs — Windows 可用的目录清理。
 *
 * 背景：内核（reimpl）按 WAL 双库契约对每个 dbPath 持有一条**永生 sqlite 连接**
 * （`ensure_sqlite_keepalive`，见 AGENTS.md）。Windows 不允许删除仍被打开的文件，
 * 于是套件收尾的 `rmSync(tmp, {recursive:true, force:true})` 会抛 EPERM——
 * 测试结果其实全绿，进程却以异常退出码结束（假红）。
 *
 * 本函数只吞「文件仍被占用」这一类错误：句柄随进程退出由 OS 释放，
 * 残留的临时目录由下一次运行/系统清理回收；其它错误照抛。
 */
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SWALLOW = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'])

export function safeRm(target) {
  try {
    rmSync(target, { recursive: true, force: true })
    return true
  } catch (e) {
    if (!SWALLOW.has(e?.code)) throw e
    return false
  }
}

/** 临时根（平台可移植）：MEMO_ACC_TMP_ROOT > TMPDIR > os.tmpdir()。 */
export function tmpRoot() {
  return process.env.MEMO_ACC_TMP_ROOT || process.env.TMPDIR || tmpdir()
}

/** 临时目录（带前缀 + pid，避免并发撞名）。 */
export function tmpDir(prefix) {
  return join(tmpRoot(), `${prefix}-${process.pid}`)
}
