/**
 * src/vitals.ts — **记忆系统的生命体征**：把「每个组件是活着还是空转」变成可读的判定（2026-10-19）。
 *
 * ## 为什么要有这个文件
 *
 * 今天最大的发现不是某个 bug，而是一个**形状**：本仓有好几处「以为在跑、其实空转」
 * 或者「建好了、没人用」的组件，而**没有任何地方会说出来**。实测到的三例：
 *
 *   1. 压缩式遗忘引擎：三判定在当前规模**两道恒假**（251 篇里 0 篇 >14 天未动；
 *      31375 对里最大 cos=0.8978 < 阈值 0.90）⇒ 守护轮永远报「候选 0 篇」。
 *   2. `hurt` 传感器：字段建了、视图算了、**渲染不印**（今天才修）。
 *   3. 新工具 `memo_read`：落地即有探针 13/13，但**没有任何代码记录它被调过几次**。
 *
 * 前两个是「空转但静默」，第三个是「未知」。**未知比空转更危险**——空转至少还是零。
 *
 * ## 四态判定（本模块的核心主张）
 *
 * 对任何需要样本的组件，**必须区分四态**，不能把后三态都叫「0」：
 *
 * | 态 | 含义 | 该做什么 |
 * |---|---|---|
 * | `live` | 样本够、且真的在产出 | 正常 |
 * | `idle` | 样本不够，还判断不了 | **等**（别急着改） |
 * | `inert` | 样本够（或条件恒假）、零产出 | **修阈值/修接线** |
 * | `unknown` | 没有可观测的量 | **先建观测** |
 *
 * 「`idle` 与 `inert` 的区别」就是本文件存在的全部理由：把「还判断不了」误读成
 * 「坏了」会去改一个没坏的东西；把「坏了」误读成「还判断不了」会一直等。
 *
 * ## 数学依据（禁自动退役的同一把尺）
 *
 * Ratchet（arXiv:2605.22148）的 Hoeffding 精度 `ε = sqrt(ln(2/δ)/(2n))`，
 * δ=1e-3：n=20 → ε≈0.436、n=100 → ε≈0.195。本仓中位召回次数 n=12 ⇒ ε≈0.56 ≫ τ=0.10
 * ⇒ **任何「按贡献判好坏」的结论在本仓规模下都是噪声**。
 * 本模块因此只做**读数**，不产任何动作。
 */

import type { UsageEntry } from './health.js'
import type { Observation } from './observation.js'

/** 四态。见文件头表格。 */
export type VitalState = 'live' | 'idle' | 'inert' | 'unknown'

/** 一条生命体征。 */
export interface Vital {
  /** 组件名（人读）。 */
  name: string
  state: VitalState
  /** 一句话读法：**必须能独立看懂**，不依赖其它字段。 */
  reading: string
  /** 判定依据（可复算的数字/条件）。 */
  basis: string
  /** 建议动作（`live` 时为空）。 */
  action?: string
}

/** 判定样本是否足够的最小 n（对齐 Ratchet 的 N_min 量级，取保守下界）。 */
export const MIN_SAMPLE = 10

/**
 * 工具活跃度判定：**这个工具到底有没有人调**。
 *
 * 这是「未知 → 已知」的那一步。在此之前，「`memo_read` 有没有用」是无法回答的问题。
 */
export function vitalForTool(observations: readonly Observation[], tool: string, windowMs = 7 * 86_400_000, now = Date.now()): Vital {
  const hits = observations.filter((o) => o.tool === tool)
  const recent = hits.filter((o) => now - o.at <= windowMs)
  const errs = hits.filter((o) => o.error).length
  if (hits.length === 0) {
    return {
      name: `工具 ${tool}`,
      state: 'unknown',
      reading: `从未被调用（观测环共 ${observations.length} 条，跨度${
        observations.length > 0 ? ` ${Math.round((now - Math.min(...observations.map((o) => o.at))) / 3_600_000)}h` : '—'
      }）`,
      basis: `hits=0 / ring=${observations.length}`,
      action: '若它是本轮新加的能力，先确认真实会话里模型知道它的存在（提示词/工具描述）；确认后仍 0 次就把「不被用」当结论，别当异常。',
    }
  }
  return {
    name: `工具 ${tool}`,
    state: 'live',
    reading: `累计 ${hits.length} 次（近 7 天 ${recent.length} 次${errs > 0 ? `，报错 ${errs} 次` : ''}）`,
    basis: `hits=${hits.length} recent=${recent.length} errors=${errs}`,
  }
}

/**
 * 遗忘引擎活性判定。
 *
 * 这是今天最实在的一处「以为有、其实是空转」：引擎在跑，但两道阈值在当前规模恒假。
 * **注意判据用「条件是否可达」而不是「产出是否为 0」**——后者会把「语料确实很干净」
 * 误判成「引擎坏了」。
 */
export function vitalForConsolidation(input: {
  totalFiles: number
  /** 最久未动天数（0 = 全部今天动过）。 */
  maxIdleDays: number
  /** 全库两两最大余弦（0 = 无可比对，单篇库）。 */
  maxPairCos: number
  minAgeDays: number
  overlapCosine: number
  candidates: number
}): Vital {
  const ageReachable = input.maxIdleDays >= input.minAgeDays
  const cosReachable = input.maxPairCos >= input.overlapCosine
  const basis =
    `idle≥${input.minAgeDays}d：${input.totalFiles} 篇里最久 ${input.maxIdleDays.toFixed(1)} 天` +
    `（${ageReachable ? '可达' : '**恒假**'}）｜` +
    `maxPairCos=${input.maxPairCos.toFixed(4)} vs 阈值 ${input.overlapCosine}（${cosReachable ? '可达' : '**恒假**'}）`
  if (input.totalFiles < MIN_SAMPLE) {
    return {
      name: '压缩式遗忘引擎',
      state: 'idle',
      reading: `语料仅 ${input.totalFiles} 篇，不足以判断阈值是否可达`,
      basis,
    }
  }
  if (!ageReachable || !cosReachable) {
    const dead: string[] = []
    if (!ageReachable) dead.push(`年龄判据（最久 ${input.maxIdleDays.toFixed(1)} 天 < ${input.minAgeDays} 天）`)
    if (!cosReachable) dead.push(`冗余判据（最大余弦 ${input.maxPairCos.toFixed(4)} < ${input.overlapCosine}）`)
    return {
      name: '压缩式遗忘引擎',
      state: 'inert',
      reading: `**空转**：${dead.join('、')}在当前规模下永远不成立 ⇒ 候选恒为 ${input.candidates}`,
      basis,
      action:
        '阈值是 27 篇时定的，语料到 250 篇后两两最大余弦必然下沉。**改默认值前先想清楚**：' +
        'patrol 报的近重复簇里大量是同轴递进链（同一事故的勘察/判定/落地三篇），合并会摧毁时间线。' +
        '正确做法是把「不可达」变成读数（本行），而不是降阈值让引擎「有产出」。',
    }
  }
  return {
    name: '压缩式遗忘引擎',
    state: input.candidates > 0 ? 'live' : 'idle',
    reading:
      input.candidates > 0
        ? `在产出：候选 ${input.candidates} 篇`
        : `条件可达但本轮无候选（语料可能确实干净）`,
    basis,
  }
}

/** 判定 Critic 传感器活性。**「0 次」和「不知道」必须分开**。 */
export function vitalForCritic(entries: readonly UsageEntry[], observationSpanHours: number): Vital {
  const hurtTotal = entries.reduce((a, e) => a + (e.hurt ?? 0), 0)
  const recalled = entries.reduce((a, e) => a + e.passive + e.active, 0)
  const basis = `hurt=${hurtTotal} recalled=${recalled} span=${observationSpanHours.toFixed(1)}h entries=${entries.length}`
  if (recalled === 0) {
    return {
      name: 'Critic（召回归因）',
      state: 'unknown',
      reading: '没有任何召回记录，无从判断纠偏率',
      basis,
    }
  }
  if (hurtTotal === 0) {
    /* 关键区分：零 hurt 可能是「真的没那么多纠偏」，也可能是「判定过严/没接上」。
     * 用观测跨度做门槛——样本太小时诚实地叫 idle。 */
    return {
      name: 'Critic（召回归因）',
      state: observationSpanHours >= 24 ? 'inert' : 'idle',
      reading:
        observationSpanHours >= 24
          ? `已观测 ${observationSpanHours.toFixed(0)}h、${recalled} 次召回，但 hurt 恒 0 —— 判定可能是**假阴性**`
          : `已观测 ${observationSpanHours.toFixed(1)}h，样本不足以判断（hurt=0 属预期）`,
      basis,
      action:
        observationSpanHours >= 24
          ? '查三处：①`pendingHurt` 是否被正确设置（看 critic-hurt 日志有没有出现）②纠偏词表是否覆盖真实用语 ③「紧接着的下一轮」这个窗口是否太窄'
          : undefined,
    }
  }
  return {
    name: 'Critic（召回归因）',
    state: 'live',
    reading: `在产出：累计 ${hurtTotal} 次纠偏信号`,
    basis,
  }
}

/** 汇总成报告文本（`memo_selfcheck` 的正文）。 */
export function formatVitals(vitals: readonly Vital[]): string {
  const icon: Record<VitalState, string> = { live: '✅', idle: '⏳', inert: '⚠️', unknown: '❓' }
  const lines = ['【记忆河流·自检】']
  for (const v of vitals) {
    lines.push(`${icon[v.state]} ${v.name} — ${v.reading}`)
    lines.push(`   依据：${v.basis}`)
    if (v.action) lines.push(`   建议：${v.action}`)
  }
  const counts = vitals.reduce<Record<string, number>>((a, v) => {
    a[v.state] = (a[v.state] ?? 0) + 1
    return a
  }, {})
  lines.push(
    `· 汇总：live=${counts.live ?? 0} idle=${counts.idle ?? 0} inert=${counts.inert ?? 0} unknown=${counts.unknown ?? 0}`,
  )
  if ((counts.inert ?? 0) > 0 || (counts.unknown ?? 0) > 0) {
    lines.push('· ⚠️ 有组件处于 inert/unknown —— 前者是「以为在跑其实没有」，后者是「不知道」。两种都别当成 0。')
  }
  return lines.join('\n')
}
