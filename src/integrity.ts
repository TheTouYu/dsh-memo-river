/**
 * src/integrity.ts — 完整性哨兵与打开时自动恢复（2026-11-17 三桶同签损坏事故）。
 *
 * 事故签名：integrity_check 报 `2nd reference to page` / `rowid out of order` /
 * `row 3 missing from idx_rivermemo_artifacts_*`——表页与索引页落入不同世代。
 * 两次事发（10-30 / 11-17 genshin 桶，11-17 另两桶轻损）横跨两代内核；guardian
 * 只会退避重试（10-30 连败 15 轮、11-17 连败 13+ 轮），损坏静默存续数小时，
 * 每次都靠人工 .dump 重建后无人回头补哨兵——本模块把「检出 → 留证 → 换新」固化：
 *   · 打开路径（WorkspaceRuntime.open）：损坏 → sqlite3 .recover/.dump 出新件 →
 *     校验 → corrupt-bak-<ts> 留证 → 原子换入；
 *   · 守护轮（daemon ③c）：全量 integrity_check 检出即高声报错 + 写 marker 文件。
 *
 * 为什么全量 integrity_check 而不是 quick_check：quick_check 跳过「索引条目 ↔ 表行」
 * 一致性核对——恰好漏掉本次「row 3 missing from index」轻损签名（实测三桶中两桶
 * 只有这一种损伤）。
 *
 * 安全边界：探测/恢复只在 WorkspaceRuntime.open 触达（该入口仅在 registry 无实例时
 * 被调 → 本进程内该桶没有 rusqlite 在飞，无同进程双 sqlite 盲区）；跨进程写入者由
 * fcntl+shm 正常仲裁，探测拿的是一致快照。守护轮的检查走 node store 自身连接
 * （同库双连接，串行安全），持 withDb 闸。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, renameSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

export interface IntegrityOutcome {
  action: 'ok' | 'recovered' | 'failed'
  detail: string
}

/** 全量 integrity_check，返回问题行（空数组 = 库健康）。异常本身视为损坏证据。 */
export function integrityProblems(db: DatabaseSync, limit = 8): string[] {
  try {
    const rows = db.prepare(`PRAGMA integrity_check(${limit})`).all() as Array<{ integrity_check: string }>
    return rows.map((r) => r.integrity_check).filter((s) => s && s !== 'ok')
  } catch (e) {
    return [`integrity_check-threw: ${String((e as Error)?.message ?? e)}`]
  }
}

/** 开一个一次性探测连接查指定路径（调用方保证此刻该路径无本进程 rusqlite 在飞）。 */
export function problemsOnPath(dbPath: string, limit = 8): string[] {
  let probe: DatabaseSync | null = null
  try {
    probe = new DatabaseSync(dbPath)
    return integrityProblems(probe, limit)
  } catch (e) {
    return [`open-failed: ${String((e as Error)?.message ?? e)}`]
  } finally {
    try { probe?.close() } catch { /* 静默 */ }
  }
}

/** dbPath 全部来自 workspaceHash 状态目录；仍按 shell 字面量加引号防意外注入。 */
function shQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

function countFiles(dbPath: string): number {
  let check: DatabaseSync | null = null
  try {
    check = new DatabaseSync(dbPath)
    return Number((check.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n)
  } catch {
    return -1
  } finally {
    try { check?.close() } catch { /* 静默 */ }
  }
}

/**
 * 损坏库自动换新。流程：.recover 优先（对页级损坏容忍度高于 .dump），失败降级 .dump；
 * 新件必须自身 integrity ok 且 files 行 > 0 才换入。换入顺序：先移走旧 -wal/-shm
 * （防止新库配上旧 WAL），db → corrupt-bak-<ts> 留证，repair → db。两次 rename 之间
 * 的微秒级窗口若被打断，留证件与新件都在盘上，可手工续接。任何失败都放行为
 * `failed` 并按原样打开——绝不比现状更糟。
 */
export function autoRecoverIfCorrupt(dbPath: string): IntegrityOutcome {
  if (!existsSync(dbPath)) return { action: 'ok', detail: 'absent' }
  const problems = problemsOnPath(dbPath)
  if (problems.length === 0) return { action: 'ok', detail: 'ok' }
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
  for (const mode of ['recover', 'dump'] as const) {
    const repair = `${dbPath}.repair-${ts}.sqlite`
    try {
      const sql = mode === 'recover' ? '.recover' : '.dump'
      const res = spawnSync('/bin/sh', ['-c', `sqlite3 ${shQuote(dbPath)} ${sql} | sqlite3 ${shQuote(repair)}`], { timeout: 120_000 })
      if (res.status !== 0 || !existsSync(repair)) continue
      if (problemsOnPath(repair).length > 0) continue
      const files = countFiles(repair)
      if (files <= 0) continue
      for (const suffix of ['-wal', '-shm', '-journal']) {
        try {
          if (existsSync(dbPath + suffix)) renameSync(dbPath + suffix, `${dbPath}${suffix}.corrupt-${ts}`)
        } catch { /* 静默：旧的伴随文件移不走不阻塞换新 */ }
      }
      renameSync(dbPath, `${dbPath}.corrupt-bak-${ts}`)
      renameSync(repair, dbPath)
      return {
        action: 'recovered',
        detail: `mode=${mode} files=${files} 留证=${dbPath}.corrupt-bak-${ts} 首问题=${problems[0]}`,
      }
    } catch {
      /* 本档失败 → 试下一档 */
    }
  }
  return { action: 'failed', detail: `首问题=${problems[0]}（.recover/.dump 均未产出可换新件，按原样打开）` }
}
