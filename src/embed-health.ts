/**
 * src/embed-health.ts — 嵌入链路的健康台账（进程内单例）。
 *
 * 用户令（2026-10-15）：本地推理上生产时，「本地失败 → 回退远端」必须**看得见**——
 * 失败要以**不挡事、可复制**的形式出现在浏览器页面，用户才能据此去修。两条出口共用本台账：
 *   ① 对话内通知：注入路径把未播报的事件渲染成一条 `form:'notice'` 消息（不冒充用户、不挡事）
 *   ② 调参面板卡片：`/memo-river/tuning/panel` 的「嵌入链路」卡，含**完整可复制**的排障文本
 *
 * detail 一律写成「谁失败了/错误原文/回退到哪/影响面/怎么查」的完整段落——用户复制走就能开工。
 * 台账只在内存（进程重启即清空），事件上限 50 条；播报有冷却，防止劣化时刷屏。
 */

export type EmbedHealthKind = 'failover' | 'all-failed' | 'recovered'

export interface EmbedHealthEvent {
  id: number
  at: number
  kind: EmbedHealthKind
  /** 出事/接手的端点标签（primary / fallback） */
  lane: string
  endpoint: string
  /** 错误类（embed-timeout / embed-http-500 / ECONNREFUSED …） */
  reason: string
  /** 完整可复制文本（排障主体） */
  detail: string
  /** 处置提示（命令级） */
  hint: string
}

/** 同一 (kind,lane) 的播报冷却：劣化期反复触发时只报第一条。 */
const ANNOUNCE_COOLDOWN_MS = 5 * 60_000
const MAX_EVENTS = 50

export interface EmbedHealthSnapshot {
  counters: Record<string, number>
  lastError: string | null
  pendingCount: number
  events: EmbedHealthEvent[]
}

class EmbedHealthLedger {
  private seq = 0
  private events: EmbedHealthEvent[] = []
  private announced = new Map<string, number>() // `${kind}:${lane}` → 上次播报时刻（冷却窗口用）
  /** 已播报过的事件 id——**同一事件只报一次**；冷却窗口只用来压同类的"新"事件。 */
  private announcedIds = new Set<number>()
  counters: Record<string, number> = {}
  lastError: string | null = null

  record(e: Omit<EmbedHealthEvent, 'id' | 'at'> & { at?: number }): EmbedHealthEvent {
    const ev: EmbedHealthEvent = { id: ++this.seq, at: e.at ?? Date.now(), ...e }
    this.events.push(ev)
    if (this.events.length > MAX_EVENTS) {
      const dropped = this.events.splice(0, this.events.length - MAX_EVENTS)
      for (const d of dropped) this.announcedIds.delete(d.id)
    }
    this.counters[ev.kind] = (this.counters[ev.kind] ?? 0) + 1
    if (ev.kind !== 'recovered') this.lastError = `${ev.reason} @ ${ev.endpoint}`
    return ev
  }

  /**
   * 待播报事件（最多一条）：同 (kind,lane) 已过冷却期。
   *
   * **`all-failed` 刻意不进对话通道**——它已有既有可见路径：注入失败走 `inject-skip` 的
   * 「召回未生效」通知、写入失败走工具报错；同一件事报两遍只会挤占每一轮的注入预算
   * （2026-10-15 实测：多发一条会把验收 #9 的「额外消息数」从 2 顶到 3）。它仍进面板卡片与日志。
   */
  pending(now = Date.now()): EmbedHealthEvent | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i]!
      if (ev.kind === 'all-failed') continue
      // 2026-10-15 实测缺陷：只按 (kind,lane) 做冷却 → 冷却一过，**同一条旧事件**会被重新播报
      // （用户在同一会话里看到 10:52:34 的回退通知在 11:0x 又出现一次）。同一 id 只报一次。
      if (this.announcedIds.has(ev.id)) continue
      const key = `${ev.kind}:${ev.lane}`
      const last = this.announced.get(key)
      if (last !== undefined && now - last < ANNOUNCE_COOLDOWN_MS) continue
      if (ev.kind === 'recovered' && this.announced.get(key) === undefined) continue // 没报过降级就别报恢复
      return ev
    }
    return null
  }

  markAnnounced(ev: EmbedHealthEvent, now = Date.now()): void {
    this.announcedIds.add(ev.id)
    this.announced.set(`${ev.kind}:${ev.lane}`, now)
  }

  snapshot(): EmbedHealthSnapshot {
    return {
      counters: { ...this.counters },
      lastError: this.lastError,
      pendingCount: this.pending() ? 1 : 0,
      events: this.events.slice(-12).reverse(),
    }
  }

  /** 测试/探针用：清空。 */
  reset(): void {
    this.events = []
    this.announced.clear()
    this.announcedIds.clear()
    this.counters = {}
    this.lastError = null
    this.seq = 0
  }
}

export const embedHealth = new EmbedHealthLedger()

/** 组装一条人类可读、可复制的排障文本（对话通知与面板共用）。 */
export function formatEmbedEvent(e: EmbedHealthEvent): string {
  const ts = new Date(e.at).toISOString().replace('T', ' ').slice(0, 19)
  return `[memo-river 嵌入链路] ${e.detail}\n时间 ${ts} ｜ 端点 ${e.endpoint} ｜ 错误类 ${e.reason}\n处置：${e.hint}`
}
