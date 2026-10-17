/**
 * src/embed-health.ts — 嵌入链路的健康台账（进程内单例）。
 *
 * 用户令（2026-10-15）：本地推理上生产时，「本地失败 → 回退远端」必须**看得见**——
 * 失败要以**不挡事、可复制**的形式出现在浏览器页面，用户才能据此去修。两条出口共用本台账：
 *   ① 对话内通知：注入路径把未播报的事件渲染成一条 `form:'notice'` 消息（不冒充用户、不挡事）
 *   ② 调参面板卡片：`/memo-river/tuning/panel` 的「嵌入链路」卡，含**完整可复制**的排障文本
 *
 * detail 一律写成「谁失败了/错误原文/回退到哪/影响面/怎么查」的完整段落——用户复制走就能开工。
 * 台账只在内存（进程重启即清空），事件上限 50 条；对话通道按**状态转换沿**播报（degraded/recovered
 * 各报一次，中间静默），面板卡片与日志始终全量。
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
  /**
   * 状态转换沿（2026-10-17 §1，PLAN「两真会话注入通道工程优化」）：`${lane}` → 最近一次
   * **播报**所代表的链路状态。'degraded'=该 lane 故障已播报（failover）；'ok'=恢复已播报。
   * 同一状态持续期间的新事件一律静默吸收——取代旧的「(kind,lane) 冷却窗」语义。
   * 旧语义的击穿点：冷却一过、新事件带新 id 又进队列 → 持续降级时每个冷却窗报一条
   * （生产实证 genshin-ts 13h 同内容通知 77 次、模型零理会）。
   */
  private announcedState = new Map<string, 'degraded' | 'ok'>()
  /** 已播报/已吸收的事件 id——同一事件只出对话通道一次；面板卡片与日志仍全量可见。 */
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
   * 待播报事件（最多一条）：**该 lane 最新状态相对上次播报发生了转换**才返回。
   *
   * 语义（2026-10-17 §1）：degraded 报一次、recovered 报一次，中间无论重试多少次
   * 全部静默（面板卡片与桶日志仍全量可见）。判定对象是「最新一条非 all-failed 事件」
   * 所代表的状态——而非任意未播报事件：否则 degraded→recovered→degraded 快速抖动时，
   * 中间那条已被覆盖的 recovered 会被翻出来误报。
   *
   * **`all-failed` 刻意不进对话通道**——它已有既有可见路径：注入失败走 `inject-skip` 的
   * 「召回未生效」通知、写入失败走工具报错；同一件事报两遍只会挤占每一轮的注入预算
   * （2026-10-15 实测：多发一条会把验收 #9 的「额外消息数」从 2 顶到 3）。它仍进面板卡片与日志。
   */
  pending(now = Date.now()): EmbedHealthEvent | null {
    void now // 状态转换沿不依赖时钟（旧冷却窗语义已废弃）
    let latest: EmbedHealthEvent | null = null
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i]!
      if (ev.kind === 'all-failed') continue
      latest = ev
      break
    }
    if (!latest) return null
    const stateOf = latest.kind === 'recovered' ? 'ok' : 'degraded'
    const announced = this.announcedState.get(latest.lane)
    if (announced === stateOf) {
      // 同一状态仍在持续：吸收进状态沿，不单独播报（幂等 add，不影响面板/日志全量可见）。
      this.announcedIds.add(latest.id)
      return null
    }
    if (stateOf === 'ok' && announced === undefined) {
      // 没报过降级就别报恢复（2026-10-15 语义保留）；进程启动时端点本就正常的 recovered 静默。
      this.announcedIds.add(latest.id)
      return null
    }
    if (this.announcedIds.has(latest.id)) return null // 防御：markAnnounced 与 pending 不在同拍时
    return latest
  }

  markAnnounced(ev: EmbedHealthEvent, now = Date.now()): void {
    void now
    this.announcedIds.add(ev.id)
    this.announcedState.set(ev.lane, ev.kind === 'recovered' ? 'ok' : 'degraded')
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
    this.announcedState.clear()
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
