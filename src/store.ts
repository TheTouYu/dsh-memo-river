/**
 * src/store.ts — 工作区级知识库（`node:sqlite`，零依赖）。
 *
 * DESIGN.md §9：表为 VCP schema 子集，DDL 逐字取自 VCPToolBox（见 src/schema.ts）。
 * 全部派生资产（图 / CSR / provenance）由原生 rebuildMemoArtifact 从库重建，
 * **不单独持久化为真相**——本模块只负责基座表。
 */
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA_STATEMENTS } from './schema.js'

export interface TagRow {
  id: number
  name: string
  vector: Float32Array | null
}

export interface ChunkRow {
  id: number
  file_id: number
  chunk_index: number
  content: string
  vector: Float32Array | null
}

export interface FileRow {
  id: number
  path: string
  diary_name: string
  checksum: string
  mtime: number
  size: number
  updated_at: number | null
}

/** BLOB → Float32Array（node:sqlite 给 Uint8Array，better-sqlite3 给 Buffer，两者都吃）。 */
export function blobToVector(blob: unknown): Float32Array | null {
  if (blob === null || blob === undefined) return null
  if (blob instanceof Uint8Array) {
    // 复制一份，避免对同一 ArrayBuffer 的对齐/长度假设。
    const copy = new Uint8Array(blob.byteLength)
    copy.set(blob)
    return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4))
  }
  return null
}

/** Float32Array → BLOB（小端，与 VCP 写入一致）。 */
export function vectorToBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength)
}

export class KnowledgeStore {
  readonly db: DatabaseSync
  private closed = false

  constructor(readonly dbPath: string) {
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA busy_timeout = 5000')
    // node26 下 node:sqlite .all() 走 mmap 读页，与 rust keepalive 连接并发写/截断 WAL 时
    // 页被回收 → BUS_ADRERR（SIGBUS）。mmap_size=0 强制走 read() 拷贝路径，绕开 mmaps。
    this.db.exec('PRAGMA mmap_size = 0')
    // 幂等建表：参考 DDL 全部为 CREATE ...（IF NOT EXISTS 由本处兜底判定）
    for (const stmt of SCHEMA_STATEMENTS) {
      try {
        this.db.exec(stmt)
      } catch (e) {
        if (!/already exists/i.test(String(e))) throw e
      }
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.db.close()
    } catch {
      /* 关闭失败静默 */
    }
  }

  /* ────────────── SIGBUS 安全闸（2026-09-28 崩因修复） ──────────────
   *
   * 崩因：node 内嵌 sqlite 与 rust-vexus-lite 内嵌 rusqlite 是两份独立编译的 sqlite
   * 实例，各持独立进程全局态——POSIX fcntl 锁按进程计，同进程内两份库互相看不见对方
   * 的锁。WAL 的 wal-index（-shm 文件，无条件 mmap，不受 mmap_size 控制）被两侧并发
   * 读写 → node 侧 .all() 拿过期 wal-index 读到越界地址 → BUS_ADRERR（SIGBUS）。
   * 复现：/tmp/sigbus-repro2.mjs（node 主线程读写 × rust AsyncTask 线程池，双侧真实写）。
   *
   * 闸门：WorkspaceRuntime 安装 accessGuard——rust AsyncTask 在飞（nativeBusy>0）时，
   * store 任何方法调用立即抛错（把崩溃变成可归因的异常）。正常路径不会被绊到：
   * 所有流程经 workspace.withDb 串行化，native 窗口内主线程不做 store 访问。 */

  private accessGuard: (() => void) | null = null

  /** 安装/卸载访问闸（workspace 构造时安装；check 抛错=拒绝访问）。幂等。 */
  setAccessGuard(check: (() => void) | null): void {
    this.accessGuard = check
  }

  /** 原生 SQL 通道：历史直连 `store.db.prepare(...)` 的调用点（合并/清理）改走这里，
   * 与其余方法吃同一道闸。 */
  exec(sql: string): void {
    this.#guardCheck()
    this.db.exec(sql)
  }

  /** 原生 SQL 通道（带参 run）。 */
  run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    this.#guardCheck()
    const r = this.db.prepare(sql).run(...(params as [])) as unknown as {
      changes: number
      lastInsertRowid: number | bigint
    }
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid }
  }

  /** 原生 SQL 通道（泛型 SELECT，全部行）。 */
  allRows(sql: string, ...params: unknown[]): Array<Record<string, unknown>> {
    this.#guardCheck()
    const stmt = this.db.prepare(sql)
    const rows = (params.length > 0 ? stmt.all(...(params as [])) : stmt.all()) as unknown as Array<Record<string, unknown>>
    return rows
  }

  #guardCheck(): void {
    if (this.accessGuard) this.accessGuard()
  }

  /** 把原型上全部公有方法包上闸检查（实例级遮蔽）。close() 不设闸——关停路径不吃异常。 */
  static installGuard(store: KnowledgeStore, check: () => void): void {
    store.setAccessGuard(check)
    const proto = KnowledgeStore.prototype as unknown as Record<string, unknown>
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor' || name === 'close' || name === 'setAccessGuard') continue
      const desc = Object.getOwnPropertyDescriptor(proto, name)
      if (!desc || typeof desc.value !== 'function') continue
      const orig = desc.value as (this: KnowledgeStore, ...a: unknown[]) => unknown
      Object.defineProperty(store, name, {
        value(this: KnowledgeStore, ...args: unknown[]) {
          this.#guardCheck()
          return orig.call(this, ...args)
        },
        writable: true,
        enumerable: false,
        configurable: true,
      })
    }
  }

  /* ────────────── 读 ────────────── */

  files(diaryName?: string): FileRow[] {
    const sql = diaryName
      ? 'SELECT id, path, diary_name, checksum, mtime, size, updated_at FROM files WHERE diary_name = ? ORDER BY id'
      : 'SELECT id, path, diary_name, checksum, mtime, size, updated_at FROM files ORDER BY id'
    const stmt = this.db.prepare(sql)
    const rows = (diaryName ? stmt.all(diaryName) : stmt.all()) as unknown as FileRow[]
    return rows.map((r) => ({ ...r, id: Number(r.id) }))
  }

  chunks(diaryName?: string): ChunkRow[] {
    const sql = diaryName
      ? `SELECT c.id, c.file_id, c.chunk_index, c.content, c.vector
         FROM chunks c JOIN files f ON f.id = c.file_id
         WHERE f.diary_name = ? ORDER BY c.id`
      : 'SELECT id, file_id, chunk_index, content, vector FROM chunks ORDER BY id'
    const stmt = this.db.prepare(sql)
    const rows = (diaryName ? stmt.all(diaryName) : stmt.all()) as unknown as Array<Omit<ChunkRow, 'vector'> & { vector: unknown }>
    return rows.map((r) => ({
      id: Number(r.id),
      file_id: Number(r.file_id),
      chunk_index: Number(r.chunk_index),
      content: String(r.content),
      vector: blobToVector(r.vector),
    }))
  }

  tags(): TagRow[] {
    const rows = this.db.prepare('SELECT id, name, vector FROM tags ORDER BY id').all() as unknown as Array<{
      id: number
      name: string
      vector: unknown
    }>
    return rows.map((r) => ({ id: Number(r.id), name: String(r.name), vector: blobToVector(r.vector) }))
  }

  tagNameToId(): Map<string, number> {
    const rows = this.db.prepare('SELECT id, name FROM tags').all() as unknown as Array<{ id: number; name: string }>
    return new Map(rows.map((r) => [String(r.name), Number(r.id)]))
  }

  /** Tag 频次（跨篇数），按降序。DESIGN §7.4 词汇表 / §7.3 枢纽度体检。 */
  tagFrequency(): Array<{ id: number; name: string; count: number }> {
    const rows = this.db
      .prepare(
        `SELECT t.id AS id, t.name AS name, COUNT(DISTINCT ft.file_id) AS count
         FROM tags t LEFT JOIN file_tags ft ON ft.tag_id = t.id
         GROUP BY t.id ORDER BY count DESC, t.id ASC`,
      )
      .all() as unknown as Array<{ id: number; name: string; count: number }>
    return rows.map((r) => ({ id: Number(r.id), name: String(r.name), count: Number(r.count) }))
  }

  fileTags(fileId: number): Array<{ tag_id: number; name: string; position: number }> {
    const rows = this.db
      .prepare(
        `SELECT ft.tag_id AS tag_id, t.name AS name, ft.position AS position
         FROM file_tags ft JOIN tags t ON t.id = ft.tag_id
         WHERE ft.file_id = ? ORDER BY ft.position`,
      )
      .all(fileId) as unknown as Array<{ tag_id: number; name: string; position: number }>
    return rows.map((r) => ({ tag_id: Number(r.tag_id), name: String(r.name), position: Number(r.position) }))
  }

  /** chunk id → 所属 file 的 path / diary_name / 写入时间戳（注入块的「D<n>」标题与近因保底用）。 */
  chunkOwners(): Map<number, { fileId: number; path: string; diaryName: string; writtenAt: number | null }> {
    const rows = this.db
      .prepare(
        `SELECT c.id AS cid, f.id AS fid, f.path AS path, f.diary_name AS diary, f.updated_at AS updated
         FROM chunks c JOIN files f ON f.id = c.file_id`,
      )
      .all() as unknown as Array<{ cid: number; fid: number; path: string; diary: string; updated: number | null }>
    return new Map(
      rows.map((r) => [
        Number(r.cid),
        {
          fileId: Number(r.fid),
          path: String(r.path),
          diaryName: String(r.diary),
          writtenAt: r.updated == null ? null : Number(r.updated),
        },
      ]),
    )
  }

  kvGet(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM kv_store WHERE key = ?').get(key) as unknown as
      | { value: string | null }
      | undefined
    return row?.value ?? null
  }

  kvSet(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO kv_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }

  counts(): { tags: number; files: number; chunks: number; fileTags: number } {
    const one = (sql: string): number => Number((this.db.prepare(sql).get() as unknown as { n: number }).n)
    return {
      tags: one('SELECT COUNT(*) AS n FROM tags'),
      files: one('SELECT COUNT(*) AS n FROM files'),
      chunks: one('SELECT COUNT(*) AS n FROM chunks'),
      fileTags: one('SELECT COUNT(*) AS n FROM file_tags'),
    }
  }

  /* ────────────── 写（memo_write 用） ────────────── */

  /** 取或建 tag；返回 tag id（Tag 名稳定，`name` UNIQUE）。 */
  upsertTag(name: string, vector?: Float32Array | null): number {
    const existing = this.db.prepare('SELECT id FROM tags WHERE name = ?').get(name) as unknown as { id: number } | undefined
    if (existing) {
      const id = Number(existing.id)
      if (vector) this.db.prepare('UPDATE tags SET vector = ? WHERE id = ?').run(vectorToBlob(vector), id)
      return id
    }
    const info = this.db.prepare('INSERT INTO tags (name, vector) VALUES (?, ?)').run(name, vector ? vectorToBlob(vector) : null)
    return Number(info.lastInsertRowid)
  }

  /** 写一篇日记：files + chunks + file_tags（VCP schema）。返回 file_id / chunk_id。 */
  writeDiary(input: {
    path: string
    diaryName: string
    checksum: string
    mtime: number
    size: number
    content: string
    chunkVector: Float32Array | null
    tagIds: number[]
  }): { fileId: number; chunkId: number } {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO files (path, diary_name, checksum, mtime, size, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET diary_name = excluded.diary_name, checksum = excluded.checksum,
           mtime = excluded.mtime, size = excluded.size, updated_at = excluded.updated_at`,
      )
      .run(input.path, input.diaryName, input.checksum, input.mtime, input.size, now)
    const fileRow = this.db.prepare('SELECT id FROM files WHERE path = ?').get(input.path) as unknown as { id: number }
    const fileId = Number(fileRow.id)

    // 单 chunk（与参考语料一致：一篇日记一个 chunk）
    this.db.prepare('DELETE FROM chunks WHERE file_id = ?').run(fileId)
    const chunkInfo = this.db
      .prepare('INSERT INTO chunks (file_id, chunk_index, content, vector) VALUES (?, 0, ?, ?)')
      .run(fileId, input.content, input.chunkVector ? vectorToBlob(input.chunkVector) : null)
    const chunkId = Number(chunkInfo.lastInsertRowid)

    this.db.prepare('DELETE FROM file_tags WHERE file_id = ?').run(fileId)
    input.tagIds.forEach((tagId, i) => {
      // **position 是 1-based**（VCP 约定，见参考库 file_tags：首 Tag position=1）。
      // 这一列参与原生图的 content/provenance 代际哈希，写成 0-based 会让
      // artifactSig 与生产库分叉、读出排名在近似并列处翻转（实测 A/C 两查询受影响）。
      this.db.prepare('INSERT OR IGNORE INTO file_tags (file_id, tag_id, position) VALUES (?, ?, ?)').run(fileId, tagId, i + 1)
    })
    return { fileId, chunkId }
  }

  /** 语料体检用：已入库文件路径集合。 */
  filePaths(): Set<string> {
    return new Set(this.files().map((f) => f.path))
  }
}
