#!/usr/bin/env node
/**
 * probe-recall-render.mjs — memo_recall 主动渲染的噪声回归探针（2026-10-17，用户报「主动调用给了不少无用信息」）。
 *
 * 纯函数探针：不连库、不调嵌入，只对 `formatRecallResult` 喂一份合成的 RecallOutcome。
 * 判据（全过 = 渲染契约成立）：
 *   R1 条目数 = selected 条数（k 之外候选不再整段展出；旧实现 candidates.slice(0,12) 会多出 9 条）
 *   R2 未注入行按原因聚合：`k-limit×N` 只报计数，非 k 上限原因带少量 D 号（≤8）
 *   R3 默认不含完整 diagnostics（queryMorphology/readoutDiagnostics 等），debug:true 才给
 *   R4 被取代标注在默认渲染里保留（G3 主动照返 + 标注的契约不受压缩影响）
 *   R5 selected 为空（预算耗尽）时给「无入选」行，不退化回 candidates 铺满
 *   R6 输出体量下降（同一 outcome：旧渲染 vs 新渲染，报字节数与比例）
 * 运行：node scripts/probe-recall-render.mjs
 */
import { join } from 'node:path'

const ROOT = import.meta.dirname
const { formatRecallResult } = await import(join(ROOT, '..', 'lib', 'tools.js'))

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

const BODY = '这是用于渲染探针的正文片段，长度需要超过 120 字才能体现截断效果。'.repeat(4)

function cand(id, extra = {}) {
  return {
    id,
    fileId: id * 10,
    writtenAt: null,
    title: `探针日记 ${id}：${'主题'.repeat(3)}`,
    diaryName: `2026-10-17-probe-${id}.md`,
    knnScore: 0.9 - id * 0.01,
    score: 0.95 - id * 0.01,
    rawScore: 0.95 - id * 0.01,
    role: 'atomic_concept',
    anchorBonus: 0.1,
    topologyBonus: 0,
    omega: 0.985,
    riverRegime: 'dense',
    matchedTags: ['探针', '渲染'],
    rewardSuppressed: false,
    body: BODY,
    ...extra,
  }
}

/* 12 条候选、k=3：旧实现会渲染 12 条，其中 9 条又在未注入行里以 k-limit 复述。 */
const candidates = Array.from({ length: 12 }, (_, i) => cand(i + 1))
const selected = candidates.slice(0, 3)
selected[1].supersededBy = 77
selected[1].supersededByD = 88
const dropped = [
  ...candidates.slice(3).map((c) => ({ id: c.id, title: c.title, reason: 'k-limit' })),
  { id: 5, title: candidates[4].title, reason: 'token-budget' },
  { id: 6, title: candidates[5].title, reason: 'superseded-by-D88' },
]
const outcome = {
  injected: true,
  fallbackReason: null,
  gate: { passed: true, maxKnn: 0.9, threshold: 0.62, enabled: false, gateVector: 'none', retrievalMaxKnn: 0.9 },
  mode: 'topology_v3',
  omega: 0.985,
  regime: 'dense',
  dynamicK: 1,
  candidateCount: candidates.length,
  candidates,
  selected,
  dropped,
  diagnostics: { queryMorphology: { dominantMode: 'atomic' }, readoutDiagnostics: { totalMs: 4 } },
  elapsedMs: 4,
}

const out = formatRecallResult({}, outcome, '探针查询', false)
const debugOut = formatRecallResult({}, outcome, '探针查询', false, true)
const entryCount = (text) => (text.match(/^· D\d+「/gm) ?? []).length

check('R1', entryCount(out) === 3, '条目数 = selected 条数（3），不是 candidates.slice(0,12)')
check('R2a', out.includes('· 未注入 11 条：k-limit×9'), '未注入行按原因聚合：k-limit 只报计数')
check(
  'R2b',
  out.includes('token-budget×1（D5）') && out.includes('superseded-by-D88×1（D6）'),
  '非 k 上限原因带 D 号（≤8）',
)
check(
  'R3',
  !out.includes('queryMorphology') && out.includes('诊断：耗时=4ms') && debugOut.includes('queryMorphology'),
  `默认不含完整 diagnostics；debug:true 才给（default含=${out.includes('queryMorphology')} debug含=${debugOut.includes('queryMorphology')}）`,
)
check('R4', out.includes('⚠️已被 D88 取代'), '被取代标注保留（主动照返 + ⚠️）')
const empty = formatRecallResult({}, { ...outcome, selected: [], injected: false, dropped: candidates.map((c) => ({ id: c.id, title: c.title, reason: 'k-limit' })) }, '探针查询', false)
check('R5', empty.includes('· 无入选') && entryCount(empty) === 0, `selected 为空 → 无入选行，不铺候选（entries=${entryCount(empty)}）`)

/* R6：旧渲染（改动前实现，逐字复刻）作为负对照，量体量差。 */
function oldRender(o) {
  const lines = [`【记忆河流·memo_recall】「探针查询」`]
  lines.push(`· Ω=${o.omega.toFixed(3)} regime=${o.regime} mode=${o.mode} 候选=${o.candidateCount} 注入=${o.selected.length}`)
  for (const c of o.candidates.slice(0, 12)) {
    lines.push(
      `· D${c.id}「${c.title}」 score=${c.score.toFixed(4)} knn=${c.knnScore.toFixed(4)} role=${c.role} ` +
        `anchor=${c.anchorBonus.toFixed(3)} topology=${c.topologyBonus.toFixed(3)} omega=${c.omega.toFixed(3)} regime=${c.riverRegime} ` +
        `tags=${c.matchedTags.join(',') || '-'}`,
    )
    lines.push(`    ${c.body.slice(0, 120)}…`)
  }
  lines.push(`· 未注入：${o.dropped.map((d) => `D${d.id}(${d.reason})`).join(' ')}`)
  lines.push(`· diagnostics=${JSON.stringify(o.diagnostics)} fallbackReason=${o.fallbackReason ?? 'none'}`)
  return lines.join('\n')
}
const oldOut = oldRender(outcome)
check(
  'R6',
  out.length < oldOut.length * 0.65,
  `同一 outcome 体量下降：old=${oldOut.length}B new=${out.length}B（-${(100 - (out.length / oldOut.length) * 100).toFixed(0)}%）`,
)

console.log(`\n通过 ${pass}/${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
