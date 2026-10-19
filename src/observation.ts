/**
 * src/observation.ts — **自我观测层**：记忆系统自己的工具调用足迹（2026-10-19）。
 *
 * ## 为什么需要它
 *
 * 这一轮（2026-10-19）做了六件事，其中三件在交付时**无法回答「它有用吗」**：
 * `memo_read` 会不会被调、`hurt` 会不会进数据、注入的条目会不会被消费。
 * 而两条研究线的结论恰好都是同一句话——
 *   · 28 个 B 站视频的共同主线：**上下文的价值取决于有效信息密度**
 *   · 18 篇 arXiv 的共同主线：**作者侧已够，管理员侧是空的**
 * 我们研究了「有效性」，却没给自己建「有效性」的读数。
 *
 * 本模块补的就是这一层：**先能看见，再谈判断**。
 *
 * ## 设计约束（三条，都有理由）
 *
 * 1. **有界环，不无限增长**。`memo_river.observation_ring` 只留最近 N 条
 *    （缺省 500）。观测数据不能自己变成下一个「无界累积 → 漂移」的案例
 *    （Library Drift 的 bloat 子模式）。
 *
 * 2. **只写 `kv_store`，不进 artifactSig**。与使用台账同一条纪律：观测不参与
 *    内容寻址，不触发原生资产重建（见 `DESIGN.md §7.3` 与 `health.ts` 三条红线）。
 *
 * 3. **失败绝不抛**。所有写入包在 try/catch 里 —— 观测伤害主流程是本末倒置。
 *
 * ## 与使用台账的分工（**别混**）
 *
 * | | 使用台账 `usage_ledger` | 本模块 `observation_ring` |
 * |---|---|---|
 * | 记什么 | 每篇日记被**召回/回读**的次数 | 每次**工具调用**的时间线与参数摘要 |
 * | 粒度 | 按条目聚合（fileId → 计数） | 按事件追加（时间序，有界） |
 * | 回答 | 「这篇被用过几次」 | 「这个工具到底有没有人调」 |
 *
 * 台账回答不了「`memo_read` 一次都没被调」——因为没调用就没有条目可记。
 * 这正是本模块存在的理由：**零次调用必须是一个可读到的「零」，不是一片空白**。
 */

import type { KnowledgeStore } from './store.js'

/** 观测环的 kv 键。**不入 artifactSig**（kv_store 不是签名输入）。 */
export const KV_OBSERVATION = 'memo_river.observation_ring'

/** 环容量上限。有界是硬约束——见文件头「设计约束 1」。 */
export const OBSERVATION_CAP = 500

/** 一条工具调用观测。字段刻意少：够回答「有没有调、多久调、带没带 id」即可。 */
export interface Observation {
  /** 工具名（`memo_read` / `memo_recall` …）。 */
  tool: string
  /** 毫秒时间戳。 */
  at: number
  /** 会话 id（可空：某些调用路径拿不到）。 */
  session?: string
  /**
   * 参数摘要 —— **只记结构特征，不记内容**。
   * 例如 `id=12`、`q=len(37)`、`folder=常识库`。
   * 不记查询原文/正文：观测面不该变成第二份语料（D228/D246 的隐私与体积教训）。
   */
  arg?: string
  /** 是否抛错。 */
  error?: boolean
  /** 耗时毫秒（调用方给得出就给）。 */
  ms?: number
}

/** 读观测环。**任何解析失败都返回空数组**（不抛）。 */
export function readObservations(store: KnowledgeStore): Observation[] {
  try {
    const raw = store.kvGet(KV_OBSERVATION)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (x): x is Observation =>
        !!x && typeof x === 'object' && typeof (x as Observation).tool === 'string' &&
        typeof (x as Observation).at === 'number',
    )
  } catch {
    return []
  }
}

/**
 * 追加一条观测。超出容量时丢最旧的（FIFO 环）。
 *
 * **为什么不批量落盘**：每条工具调用一次 `kvGet+kvSet` 与使用台账同构
 * （`health.ts:recordUsage` 也是这么做的），实测开销可忽略；
 * 而批量会引入「进程退出时缓冲区丢失」的窗口——观测丢数据比观测慢更糟。
 */
export function recordObservation(store: KnowledgeStore, obs: Observation): void {
  try {
    const ring = readObservations(store)
    ring.push(obs)
    const trimmed = ring.length > OBSERVATION_CAP ? ring.slice(ring.length - OBSERVATION_CAP) : ring
    store.kvSet(KV_OBSERVATION, JSON.stringify(trimmed))
  } catch {
    /* 观测失败绝不伤害主流程（约束 3） */
  }
}

/** 参数摘要：只保留**结构特征**，不保留内容。 */
export function summarizeArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue
    if (typeof v === 'number') parts.push(`${k}=${v}`)
    else if (typeof v === 'boolean') parts.push(`${k}=${v}`)
    else if (typeof v === 'string') {
      /* 短枚举值直接记；长文本只记长度（防把正文抄进观测环）。 */
      parts.push(v.length <= 24 ? `${k}=${v}` : `${k}=len(${v.length})`)
    } else if (Array.isArray(v)) parts.push(`${k}=[${v.length}]`)
    else if (typeof v === 'object') parts.push(`${k}={…}`)
  }
  return parts.slice(0, 6).join(' ')
}
