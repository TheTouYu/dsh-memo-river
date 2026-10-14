/**
 * src/emb-cache.ts — 嵌入缓存的**二进制追加式存储**（2026-10-14「内存鲸鱼」修复；定谳见
 * dsh-plugins 桶日记 D98，实测数字全出在那里）。
 *
 * ## 旧形态（已废弃，本次病根）
 * 整份 `emb-cache.json`：`EmbedClient` 构造时 `readJsonSafe` 全量读、任何新增嵌入后
 * `writeJsonSafe` 全量同步重写。genshin 桶实测 116MB / 1764 条（当时活 chunk 仅 184）：
 * read 369ms + parse 253ms（+282MB 常驻）+ stringify 538ms（瞬态串 114MB）= **单周期
 * 573MB 峰值、1.16s 同步 CPU**；`writeFileSync` 冻结事件循环 → WS 心跳超时 → 在飞回合
 * 被打断（interrupt 簇是症状）；多会话跨桶并行重写叠加 → 12:42 KILL 3G / 13:40 ABRT
 * 2.5G / 14:25 ABRT 2.6G 三次 dsh-web 鲸鱼。纯浮点是 12KB/条，JSON 文本膨胀到 ~68KB/条。
 *
 * ## 新形态：追加式二进制记录日志 `emb-cache.bin`
 * ```
 * 头 16B ： 'M''R''E''C' | version u32 = 1 | dimension u32 | reserved u32 = 0
 * 记录   ： keyLen u32 | vecLen u32 | key(utf8, keyLen B) | Float32 LE × vecLen
 * ```
 * 三条设计判据各自对应一个病根：
 *   ① **Float32Array 常驻**（12KB/条）而不是 boxed `number[]`（~24KB/条）——内存减半；
 *   ② **只追加**：新嵌入 append 一条记录，永不重写全量——写盘 O(新增)，不是 O(全库)；
 *      重复键直接再追加一条（后写覆盖先读），死记录攒够一半由 `compact()` 压实；
 *   ③ **有界**：内存预算（默认 48MB，`MEMO_EMB_CACHE_MAX_MB`）内按 LRU 逐出——缓存永远
 *      只是优化，不会长成鲸鱼。逐出与死记录的判据都只看「值字节」，与键语义无关。
 *
 * 落盘全走 `fs.promises`（去抖 2s 合并 + 单飞链），**绝不阻塞事件循环**；
 * 进程 exit 兜底一次同步 flush（最多丢 2s 的可重算向量）。
 *
 * ## 旧格式透明迁移
 * 首次载入若无 `.bin` 而有 `.json`：按**切片流式解析**（一次 readFileSync 拿字节，逐条
 * `JSON.parse` 出向量切片 → Float32Array），峰值 ≈ 文件字节，不再有 stringify 的第二份
 * 116MB 与 1764 份 boxed 数组；落盘 `.bin` 后原文件改名 `<json>.bak` 留证（不删）。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, truncateSync, writeFileSync } from 'node:fs'
import { appendFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** `emb-cache.json` → 同目录同前缀的二进制主文件 `emb-cache.bin`。 */
export function embCacheBinPath(cachePath: string): string {
  return cachePath.endsWith('.json') ? `${cachePath.slice(0, -'.json'.length)}.bin` : `${cachePath}.bin`
}

/** 迁移后旧 JSON 的留证名。已存在时退化为 `<path>.bak-<n>`（绝不覆盖上一份留证）。 */
export function claimBackupPath(jsonPath: string): string {
  const base = `${jsonPath}.bak`
  if (!existsSync(base)) return base
  for (let n = 2; n < 1000; n++) {
    const cand = `${base}-${n}`
    if (!existsSync(cand)) return cand
  }
  return `${base}-${Date.now()}`
}

const MAGIC = 'MREC'
const VERSION = 1
export const HEADER_BYTES = 16
const RECORD_HEADER = 8

/** 默认内存预算：48MB ≈ 4000 条 3072 维向量。 */
export const DEFAULT_MAX_BYTES = 48 * 1024 * 1024
/** 低于这个体积不做压实（小文件重写不划算）。 */
const COMPACT_MIN_BYTES = 4 * 1024 * 1024
const DEFAULT_DEBOUNCE_MS = 2_000

export interface EmbCacheLogger {
  warn(msg: string): void
  info(msg: string): void
}

export interface EmbCacheOptions {
  /** 旧 JSON 路径（`WorkspacePaths.embCachePath`）；二进制路径由它推导。 */
  cachePath: string
  dimension: number
  /** 内存预算（字节）。超预算按 LRU 逐出。缺省 `MEMO_EMB_CACHE_MAX_MB` 或 48MB。 */
  maxBytes?: number
  /** 落盘去抖窗口（ms）。缺省 2000。 */
  debounceMs?: number
  logger?: EmbCacheLogger
}

export interface EmbCacheStats {
  entries: number
  liveBytes: number
  fileBytes: number
  pending: number
  evicted: number
  duplicates: number
  migratedFrom: string | null
  loadMs: number
}

function headerBuffer(dimension: number): Buffer {
  const buf = Buffer.alloc(HEADER_BYTES)
  buf.write(MAGIC, 0, 'ascii')
  buf.writeUInt32LE(VERSION, 4)
  buf.writeUInt32LE(dimension, 8)
  buf.writeUInt32LE(0, 12)
  return buf
}

/** 一条记录：`keyLen u32 | vecLen u32 | key | Float32LE×vecLen`。 */
function encodeRecord(key: string, vec: Float32Array): Buffer {
  const keyBuf = Buffer.from(key, 'utf8')
  const rec = Buffer.allocUnsafe(RECORD_HEADER + keyBuf.length + vec.byteLength)
  rec.writeUInt32LE(keyBuf.length, 0)
  rec.writeUInt32LE(vec.length, 4)
  keyBuf.copy(rec, RECORD_HEADER)
  // 宿主是小端（x86-64/aarch64）——与 format 的 Float32 LE 同构，直接 memcpy：
  // Buffer.from(arrayBuffer, off, len) 是共享视图，copy 才是拷贝，比逐元素 writeFloatLE 快一个量级。
  Buffer.from(vec.buffer as ArrayBuffer, vec.byteOffset, vec.byteLength).copy(rec, RECORD_HEADER + keyBuf.length)
  return rec
}

function readVec(buf: Buffer, offset: number, vecLen: number): Float32Array {
  const abs = buf.byteOffset + offset
  if (abs % 4 === 0) return new Float32Array(buf.buffer as ArrayBuffer, abs, vecLen).slice()
  const out = new Float32Array(vecLen)
  for (let i = 0; i < vecLen; i++) out[i] = buf.readFloatLE(offset + i * 4)
  return out
}

interface ScannedBin {
  entries: Array<[string, Float32Array]>
  /** 尾部被截断/追加中途崩溃时，有效字节数 < 文件长度。 */
  validBytes: number
  fileBytes: number
  ok: boolean
  reason?: string
}

/** 扫描 `.bin`：坏头/坏版本/维度不符 → ok=false（调用方当作空缓存，绝不崩）。 */
function scanBin(buf: Buffer, dimension: number): ScannedBin {
  const fileBytes = buf.length
  const bad = (reason: string): ScannedBin => ({ entries: [], validBytes: 0, fileBytes, ok: false, reason })
  if (fileBytes < HEADER_BYTES) return bad(`短于头部 ${fileBytes}B`)
  if (buf.toString('ascii', 0, 4) !== MAGIC) return bad('魔数不符')
  const version = buf.readUInt32LE(4)
  if (version !== VERSION) return bad(`版本 ${version} != ${VERSION}`)
  const dim = buf.readUInt32LE(8)
  if (dim !== dimension) return bad(`维度 ${dim} != 配置 ${dimension}`)
  const entries: Array<[string, Float32Array]> = []
  let p = HEADER_BYTES
  while (p + RECORD_HEADER <= fileBytes) {
    const keyLen = buf.readUInt32LE(p)
    const vecLen = buf.readUInt32LE(p + 4)
    if (vecLen !== dimension || keyLen > 1 << 20) return bad(`记录头异常 @${p} keyLen=${keyLen} vecLen=${vecLen}`)
    const end = p + RECORD_HEADER + keyLen + vecLen * 4
    if (end > fileBytes) break // 尾部截断（追加中途进程死）——保留前面已扫到的，后面接续追加
    const key = buf.toString('utf8', p + RECORD_HEADER, p + RECORD_HEADER + keyLen)
    entries.push([key, readVec(buf, p + RECORD_HEADER + keyLen, vecLen)])
    p = end
  }
  return { entries, validBytes: p, fileBytes, ok: true }
}

/**
 * 切片流式解析旧 JSON（`{"key":[f,f,…], …}`）。**不构造整份对象**：只对每个向量的
 * 数字切片做一次 `JSON.parse`，随即转 Float32Array 交给回调——峰值 = 文件字节 + 单条。
 * 返回实际解析出的条目数；结构性损坏时抛错（调用方当作空缓存）。
 */
export function scanLegacyJson(buf: Buffer, onEntry: (key: string, vec: Float32Array) => void): number {
  const n = buf.length
  let i = 0
  const skipWs = (): void => {
    while (i < n) {
      const c = buf[i]!
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) i++
      else break
    }
  }
  skipWs()
  if (buf[i] !== 0x7b) throw new Error('emb-cache 旧格式：根不是对象')
  i++
  let count = 0
  for (;;) {
    skipWs()
    const c = buf[i]
    if (c === 0x7d) break // '}'
    if (c === 0x2c) {
      i++
      continue
    }
    if (c !== 0x22) throw new Error(`emb-cache 旧格式：期望键字符串 @${i}`)
    // 键：扫到未转义的闭引号
    const keyStart = i
    i++
    while (i < n) {
      const ch = buf[i]!
      if (ch === 0x5c) i += 2
      else if (ch === 0x22) break
      else i++
    }
    if (i >= n) throw new Error('emb-cache 旧格式：键未闭合')
    const key = JSON.parse(buf.toString('utf8', keyStart, i + 1)) as string
    i++
    skipWs()
    if (buf[i] !== 0x3a) throw new Error(`emb-cache 旧格式：期望冒号 @${i}`)
    i++
    skipWs()
    if (buf[i] !== 0x5b) {
      // 非数组值（理论上不存在）：跳过这一个值，保留其余缓存
      while (i < n && buf[i] !== 0x2c && buf[i] !== 0x7d) i++
      continue
    }
    const vecStart = i + 1
    const vecEnd = buf.indexOf(0x5d, vecStart) // 向量数组只含数字，无嵌套
    if (vecEnd < 0) throw new Error('emb-cache 旧格式：向量数组未闭合')
    // 连方括号一起切（JSON.parse 要的是完整数组字面量）
    const arr = JSON.parse(buf.toString('utf8', vecStart - 1, vecEnd + 1)) as number[]
    onEntry(key, Float32Array.from(arr))
    count++
    i = vecEnd + 1
  }
  return count
}

/** 只读载入（脚本/工具用，不做迁移、不写盘）：`.bin` 优先，回退旧 JSON。 */
export function loadEmbCacheEntries(cachePath: string, dimension: number): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>()
  const binPath = embCacheBinPath(cachePath)
  if (existsSync(binPath)) {
    const scanned = scanBin(readFileSync(binPath), dimension)
    if (scanned.ok) for (const [k, v] of scanned.entries) out.set(k, v)
  } else if (existsSync(cachePath)) {
    try {
      scanLegacyJson(readFileSync(cachePath), (k, v) => {
        if (v.length === dimension) out.set(k, v)
      })
    } catch {
      /* 损坏 → 空缓存 */
    }
  }
  return out
}

/* ── 进程退出兜底：最多丢 2s 的可重算向量，但尽量别丢 ── */
const liveCaches = new Set<EmbCache>()
let exitHookInstalled = false
function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => {
    for (const cache of liveCaches) {
      try {
        cache.flushSync()
      } catch {
        /* 退出路径不报错 */
      }
    }
  })
}

export class EmbCache {
  private readonly binPath: string
  private readonly cachePath: string
  private readonly dimension: number
  private readonly maxBytes: number
  private readonly debounceMs: number
  private readonly logger: EmbCacheLogger | undefined
  private readonly map = new Map<string, Float32Array>()
  private readonly pending = new Map<string, Float32Array>()
  private liveBytes = 0
  private fileBytes = 0
  private headerEnsured = false
  private timer: NodeJS.Timeout | null = null
  private chain: Promise<void> = Promise.resolve()
  private compacting = false
  private evicted = 0
  private duplicates = 0
  private migratedFrom: string | null = null
  private loadMs = 0

  constructor(options: EmbCacheOptions) {
    this.cachePath = options.cachePath
    this.binPath = embCacheBinPath(options.cachePath)
    this.dimension = options.dimension
    const envMb = Number(process.env.MEMO_EMB_CACHE_MAX_MB)
    this.maxBytes = options.maxBytes ?? (Number.isFinite(envMb) && envMb > 0 ? envMb * 1024 * 1024 : DEFAULT_MAX_BYTES)
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.logger = options.logger
    const t0 = Date.now()
    this.load()
    this.loadMs = Date.now() - t0
    liveCaches.add(this)
    installExitHook()
  }

  /* ────────────── 载入 + 迁移 ────────────── */

  private load(): void {
    if (existsSync(this.binPath)) {
      const scanned = scanBin(readFileSync(this.binPath), this.dimension)
      if (!scanned.ok) {
        // 畸形 .bin：改名留证后从零开始（否则新追加的记录永远落在坏头之后 = 全库不可读）
        this.logger?.warn(`emb-cache .bin 不可用（${scanned.reason}）→ 改名留证并重建，缓存待重算`)
        try {
          renameSync(this.binPath, `${this.binPath}.corrupt-${Date.now()}`)
        } catch {
          /* 留证失败不影响重建 */
        }
        return
      }
      for (const [k, v] of scanned.entries) this.insert(k, v)
      this.fileBytes = scanned.fileBytes
      this.headerEnsured = true
      if (scanned.validBytes < scanned.fileBytes) {
        // 尾部截断（追加中途进程死）：截到有效长度，后续 append 才能被正常扫描
        try {
          truncateSync(this.binPath, scanned.validBytes)
          this.fileBytes = scanned.validBytes
          this.logger?.warn(
            `emb-cache .bin 尾部截断已修（有效 ${scanned.validBytes}B / 原文件 ${scanned.fileBytes}B）`,
          )
        } catch (e) {
          this.logger?.warn(`emb-cache .bin 截断修复失败：${String((e as Error)?.message ?? e)}`)
          this.headerEnsured = false
          this.fileBytes = 0
        }
      }
      return
    }
    if (!existsSync(this.cachePath)) return
    this.migrateLegacy()
  }

  /** 旧 JSON → `.bin`，原文件留 `.bak`。同步完成（一次性事件，量级 = 迁移后缓存体积）。 */
  private migrateLegacy(): void {
    const t0 = Date.now()
    let buf: Buffer
    try {
      buf = readFileSync(this.cachePath)
    } catch (e) {
      this.logger?.warn(`emb-cache 旧 JSON 读取失败：${String((e as Error)?.message ?? e)}`)
      return
    }
    let total = 0
    let dropped = 0
    try {
      scanLegacyJson(buf, (key, vec) => {
        total++
        if (vec.length !== this.dimension) {
          dropped++
          return
        }
        this.insert(key, vec) // 预算内直接入内存（超预算按 LRU 逐出），不额外留一份
      })
    } catch (e) {
      this.logger?.warn(`emb-cache 旧 JSON 解析失败（视为空缓存）：${String((e as Error)?.message ?? e)}`)
      return
    }
    // 迁移当期就把缓存压到实际保留集
    const parts: Buffer[] = [headerBuffer(this.dimension)]
    for (const [k, v] of this.map) parts.push(encodeRecord(k, v))
    const body = Buffer.concat(parts)
    try {
      mkdirSync(dirname(this.binPath), { recursive: true })
      const tmp = `${this.binPath}.tmp-${process.pid}`
      writeFileSync(tmp, body)
      renameSync(tmp, this.binPath)
      const bak = claimBackupPath(this.cachePath)
      renameSync(this.cachePath, bak)
      this.migratedFrom = bak
    } catch (e) {
      this.logger?.warn(`emb-cache 迁移落盘失败（内存命中仍可用）：${String((e as Error)?.message ?? e)}`)
      return
    }
    this.fileBytes = body.length
    this.headerEnsured = true
    this.logger?.info(
      `emb-cache 迁移：${total} 条 → 保留 ${this.map.size} 条` +
        `${dropped ? `（维度不符丢弃 ${dropped}）` : ''}，` +
        `${(buf.length / 1048576).toFixed(1)}MB JSON → ${(body.length / 1048576).toFixed(1)}MB bin，` +
        `耗时 ${Date.now() - t0}ms，旧文件留 ${this.migratedFrom}`,
    )
  }

  /* ────────────── 读 ────────────── */

  get size(): number {
    return this.map.size
  }

  get bytes(): number {
    return this.liveBytes
  }

  /** 命中即 LRU 触新（Map 插入序 = 新近度）。返回的 Float32Array 是**共享实例**，只读。 */
  get(key: string): Float32Array | undefined {
    const hit = this.map.get(key)
    if (hit === undefined) return undefined
    this.map.delete(key)
    this.map.set(key, hit)
    return hit
  }

  has(key: string): boolean {
    return this.map.has(key)
  }

  stats(): EmbCacheStats {
    return {
      entries: this.map.size,
      liveBytes: this.liveBytes,
      fileBytes: this.fileBytes,
      pending: this.pending.size,
      evicted: this.evicted,
      duplicates: this.duplicates,
      migratedFrom: this.migratedFrom,
      loadMs: this.loadMs,
    }
  }

  /* ────────────── 写（内存 + 去抖落盘） ────────────── */

  set(key: string, vec: Float32Array): void {
    this.insert(key, vec)
    this.pending.set(key, vec)
    this.schedule()
  }

  private insert(key: string, vec: Float32Array): void {
    const prev = this.map.get(key)
    if (prev !== undefined) {
      this.map.delete(key)
      this.liveBytes -= prev.byteLength
      this.duplicates++
    }
    this.map.set(key, vec)
    this.liveBytes += vec.byteLength
    this.evictToBudget()
  }

  private evictToBudget(): void {
    while (this.liveBytes > this.maxBytes && this.map.size > 0) {
      const oldest = this.map.keys().next()
      if (oldest.done) break
      const key = oldest.value
      const vec = this.map.get(key)!
      this.map.delete(key)
      this.pending.delete(key) // 逐出即不再落盘（否则下次载入又回来）
      this.liveBytes -= vec.byteLength
      this.evicted++
    }
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.enqueue()
    }, this.debounceMs)
    // 不吊住事件循环：缓存落盘不是进程存活理由
    this.timer.unref?.()
  }

  private enqueue(): void {
    this.chain = this.chain.then(() => this.flushOnce()).catch(() => undefined)
  }

  /** 立即落盘（测试/收尾用）。 */
  async flushNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.enqueue()
    await this.chain
  }

  /** 退出路径的同步落盘（append 一条内存缓冲，量级 = 未落盘增量）。 */
  flushSync(): void {
    if (this.pending.size === 0) return
    const recs = [...this.pending]
    this.pending.clear()
    const body = Buffer.concat(recs.map(([k, v]) => encodeRecord(k, v)))
    try {
      mkdirSync(dirname(this.binPath), { recursive: true })
      this.ensureHeaderSync()
      appendFileSync(this.binPath, body)
      this.fileBytes += body.length
    } catch {
      /* 退出路径静默 */
    }
  }

  private ensureHeaderSync(): void {
    if (this.headerEnsured) return
    this.headerEnsured = true
    try {
      writeFileSync(this.binPath, headerBuffer(this.dimension), { flag: 'wx' })
      if (this.fileBytes < HEADER_BYTES) this.fileBytes = HEADER_BYTES
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') this.headerEnsured = false
    }
  }

  private async ensureHeader(): Promise<void> {
    if (this.headerEnsured) return
    mkdirSync(dirname(this.binPath), { recursive: true })
    try {
      await writeFile(this.binPath, headerBuffer(this.dimension), { flag: 'wx' })
      this.fileBytes = HEADER_BYTES
      this.headerEnsured = true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        this.headerEnsured = true
        try {
          this.fileBytes = (await stat(this.binPath)).size
        } catch {
          /* 忽略 */
        }
        return
      }
      throw e
    }
  }

  private async flushOnce(): Promise<void> {
    if (this.pending.size === 0) return
    const recs = [...this.pending]
    this.pending.clear()
    const body = Buffer.concat(recs.map(([k, v]) => encodeRecord(k, v)))
    try {
      await this.ensureHeader()
      await appendFile(this.binPath, body)
      this.fileBytes += body.length
    } catch (e) {
      // 回填（仅当内存里还是同一份向量——已被逐出/覆盖的不再落盘），下次去抖窗口重试
      for (const [k, v] of recs) if (this.map.get(k) === v) this.pending.set(k, v)
      this.logger?.warn(`emb-cache 落盘失败（${recs.length} 条重试）：${String((e as Error)?.message ?? e)}`)
      this.schedule()
      return
    }
    void this.maybeCompact()
  }

  /**
   * 压实：死记录（重复键 + 已逐出条目）占到一半且文件够大时，后台 tmp+rename 重写。
   * 与 flush 同一条链（单飞），不与追加交错。
   */
  private async maybeCompact(): Promise<void> {
    if (this.compacting) return
    if (this.pending.size > 0) return
    if (this.fileBytes < COMPACT_MIN_BYTES) return
    if (this.liveBytes * 2 > this.fileBytes) return
    this.compacting = true
    try {
      const parts: Buffer[] = [headerBuffer(this.dimension)]
      for (const [k, v] of this.map) parts.push(encodeRecord(k, v))
      const body = Buffer.concat(parts)
      const tmp = `${this.binPath}.tmp-${process.pid}`
      await writeFile(tmp, body)
      await rename(tmp, this.binPath)
      this.fileBytes = body.length
      this.logger?.info(
        `emb-cache 压实：${this.map.size} 条 → ${(body.length / 1048576).toFixed(2)}MB（值 ${(this.liveBytes / 1048576).toFixed(2)}MB）`,
      )
    } catch (e) {
      this.logger?.warn(`emb-cache 压实失败：${String((e as Error)?.message ?? e)}`)
    } finally {
      this.compacting = false
    }
  }

  /** 卸载/测试收尾：清定时器（不再接收 flush）。 */
  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    liveCaches.delete(this)
  }
}
