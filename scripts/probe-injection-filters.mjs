#!/usr/bin/env node
/**
 * probe-injection-filters.mjs — §2/§3/§4 选择链新滤刀与等待锚的行为契约（2026-10-17）。
 *
 * 治什么（PLAN「两真会话注入通道工程优化」）：
 *   · §2 修法3 写入回声冷却——11 例实锤（最快 D331 写入 7 秒注回）；
 *   · §2 修法2 过注入频次上限——D3@常识库 7 连注形态；
 *   · §4 修法③ 弱信号护栏——元操作期 D31/D33 搭主题便车（knn 保护防误杀 D323/D304）；
 *   · §4 修法① 元操作窗口判定 + §3 修法5 等待窗口检测；
 *   · §2 修法1 强刷走去重（压缩泵断开）的纯函数级模拟：注入→在场剔→压缩放行。
 *
 * 纯函数探针（无端点、无夹具、无隔离柜需求——不触工作区）。
 * 用法：`node scripts/probe-injection-filters.mjs`（13 判全绿 exit 0）
 */
import { getSession, resetSessionAudit } from '../lib/session.js'

const {
  filterRecentWriteEcho,
  filterOverInjected,
  filterWeakSignal,
  isMetaOperationWindow,
  detectWaitingWindow,
  liveInjectedKeys,
  filterLiveDuplicates,
  evaluateWriteNudge,
  OVER_INJECT_WINDOW_MS,
} = await import('../lib/injector.js')
const { readUsageLedger, recordUsage, KV_USAGE } = await import('../lib/health.js')

const results = []
const line = (s = '') => console.log(s)
function check(id, title, pass, evidence) {
  results.push({ id, title, pass })
  line(`${pass ? '✓' : '✗'} #${String(id).padStart(2)} ${title}`)
  for (const e of evidence) line(`      ${e}`)
}

/* 候选替身（只带滤刀关心的字段） */
const cand = (id, fileId, over = {}) => ({
  id, fileId, title: `t${id}`, diaryName: `d${id}`, writtenAt: 0,
  knnScore: 0.5, score: 0.5, rawScore: 0.5, role: 'atomic_concept',
  anchorBonus: 0, topologyBonus: 0, omega: null, riverRegime: null,
  matchedTags: [], rewardSuppressed: false, body: 'x', ...over,
})

const MIN = 60_000
const HOUR = 3_600_000
const NOW = 1_800_000_000_000

/* ═══ ①-④ §2 修法3：写入回声冷却 ═══ */
{
  const st = getSession('probe-echo', null)
  st.recentWrites = []
  const wrote = (fileId, chunkId, agoMin) => st.recentWrites.push({ fileId, chunkId, at: NOW - agoMin * MIN })
  wrote(7, 71, 2) // 2 分钟前写过 fileId=7 / chunkId=71
  wrote(8, 81, 20) // 20 分钟前（超 15min 窗）
  const sel = [cand(71, 7), cand(81, 8), cand(9, 9), { ...cand(10, 10), srcBucket: 'parent' }]
  const out = filterRecentWriteEcho(sel, st, 15 * MIN, NOW)
  check(1, '冷却窗内（2min）按 chunkId 与 fileId 双口径命中 → 剔；超窗（20min）放行',
    out.echoed.length === 1 && out.echoed[0].id === 71 && out.kept.map((c) => c.id).join(',') === '81,9,10',
    [`echoed=[${out.echoed.map((d) => `D${d.id}`)}]（期望 [71]——D309/D319/D320/D331 同形态）`,
     `kept=[${out.kept.map((c) => c.id)}]（81=超窗、9=无关、10=父桶候选不冷却——D334 跨会话反例）`])
  check(2, '父桶候选（srcBucket）永不冷却——子代理写入对父会话是 delegation 目标',
    filterRecentWriteEcho([{ ...cand(71, 7), srcBucket: 'p' }], st, 15 * MIN, NOW).echoed.length === 0,
    [`srcBucket='p' 的 D71 同 id 不命中（台账/recentWrites 都在本桶编号空间）`])
  check(3, 'cooldownMs=0 = 关闭（逐位放行）',
    filterRecentWriteEcho(sel, st, 0, NOW).echoed.length === 0 && filterRecentWriteEcho(sel, st, 0, NOW).kept.length === 4,
    ['0=off 回退开关'])
  const st2 = getSession('probe-echo-2', null)
  st2.recentWrites = []
  check(4, '跨会话隔离：另一会话的 recentWrites 不影响本会话（D334 反例的会话级实现）',
    filterRecentWriteEcho([cand(71, 7)], st2, 15 * MIN, NOW).echoed.length === 0,
    ['probe-echo-2 无写入足迹 → D71 放行（父会话注入子代理写的条目正是设计目标）'])
}

/* ═══ ⑤-⑦ §2 修法2：过注入频次上限（本会话 audits 计窗） ═══ */
{
  const st = getSession('probe-over', null)
  resetSessionAudit('probe-over')
  st.audits = []
  const audit = (keys, agoH) => ({ turn: 1, step: 1, blockHash: 'h', chars: 1, tailIndex: null, totalMessages: null, assistantAfter: null, selectionKeys: keys, at: NOW - agoH * HOUR })
  st.audits.push(audit(['A:1', 'A:2'], 20), audit(['A:1', 'A:3'], 2), audit(['A:4'], 23), audit(['A:4'], 3)) // D1/D4 窗内各 2 次；D2/D3 各 1 次
  const ledger = new Map()
  ledger.set(3, { passive: 5, active: 1, lastPassiveAt: NOW - HOUR, lastActiveAt: NOW - 2 * HOUR }) // D3：7d 内主动召回过 → 豁免
  ledger.set(4, { passive: 5, active: 1, lastPassiveAt: NOW - HOUR, lastActiveAt: NOW - 8 * 24 * HOUR }) // D4：active 太旧 → 不豁免
  const sel = [cand(1, 1), cand(3, 3), cand(4, 4), cand(5, 5), { ...cand(6, 6), srcBucket: 'p' }]
  const out = filterOverInjected(sel, st, 'A', ledger, NOW)
  check(5, '本会话 24h 窗内已注 ≥2 且无主动豁免 → 剔；跨会话不累计（验收 #10 教训）；父桶候选不判',
    out.overInjected.map((d) => d.id).join(',') === '1,4' && out.kept.map((c) => c.id).join(',') === '3,5,6',
    [`剔 [${out.overInjected.map((d) => `D${d.id}`)}]：D1=audits 窗内 2 次（D3@常识库 7 连注形态）；D4=active 8d 前超豁免窗`,
     `留 [${out.kept.map((c) => c.id)}]：D3=7d 内主动召回（价值已证）；D5=窗内 0 次；D6=父桶候选（本桶 audits 键空间不含它）`])
  const stFresh = getSession('probe-over-2', null)
  resetSessionAudit('probe-over-2')
  stFresh.audits = []
  const out2 = filterOverInjected(sel, stFresh, 'A', ledger, NOW)
  check(6, '新会话零 audits → 全放行（桶被他注过不抑制本会话——跨会话误伤的回归线）',
    out2.overInjected.length === 0 && out2.kept.length === 5,
    ['首版桶级台账计窗会让同桶第二个会话直接掉条目（acceptance #10 串行/并发分叉实证）'])
  const outN = filterOverInjected(sel, st, 'A', null, NOW)
  check(7, '台账 null（读取失败）= 豁免降级：D3 失去主动豁免（窗内仅 1 次本就不剔）、D1/D4 仍按窗剔（窗计数在会话内）',
    outN.overInjected.map((d) => d.id).join(',') === '1,4' && outN.kept.map((c) => c.id).join(',') === '3,5,6',
    [`无台账剔=[${outN.overInjected.map((d) => `D${d.id}`)}]（台账只供豁免，缺失不产生额外剔除）`])
}

/* ═══ ⑧-⑨ §4 修法③：弱信号护栏 ═══ */
{
  const weak = (id, over = {}) => cand(id, id, { anchorBonus: 0, topologyBonus: 0, ...over })
  const sel = [
    weak(1, { knnScore: 0.4 }), // top-1 无锚无拓扑但排第一 → 豁免（i>0 才判）
    weak(2, { knnScore: 0.4 }), // 弱 knn 搭便车 → 剔（D31/D33 形态）
    weak(3, { knnScore: 0.78 }), // 纯 knn 强命中 → 豁免（D323 knn=0.788 形态）
    weak(4, { anchorBonus: 0.05 }), // 有锚 → 豁免
  ]
  const out = filterWeakSignal(sel)
  check(8, '无锚无拓扑且 knn<0.7 的非 top-1 → 剔；top-1 与强 knn（≥0.7）豁免',
    out.weak.map((d) => d.id).join(',') === '2' && out.kept.map((c) => c.id).join(',') === '1,3,4',
    [`剔 [${out.weak.map((d) => `D${d.id}`)}]；留 [${out.kept.map((c) => c.id)}]（1=top-1 豁免、3=knn≥0.7 豁免、4=有锚）`])
}

/* ═══ ⑩ §4 修法① + §3 修法5：窗口判定 ═══ */
{
  const ac = (calls) => ({ role: 'assistant', content: calls.map((c) => ({ type: 'tool-call', name: c.n, arguments: c.a })) })
  const meta3 = [ac([{ n: 'compress', a: {} }]), ac([{ n: 'acp_status', a: {} }]), ac([{ n: 'search_context', a: { q: 'x' } }])]
  const mixed = [...meta3.slice(0, 2), ac([{ n: 'bash', a: { command: 'ls' } }])]
  const arch = [ac([{ n: 'bash', a: { command: 'zstd -dc ~/.dsh/sessions/x/session.v4.jsonl.zstd | grep y' } }])]
  check(9, '元操作窗口：最近 3 条带工具调用的 assistant 全为 compress/acp_status/search_context → true；混入任务工具 → false；会话考古 bash → true',
    isMetaOperationWindow(meta3) === true && isMetaOperationWindow(mixed) === false && isMetaOperationWindow(arch) === true && isMetaOperationWindow([]) === false,
    ['meta3=true（03:37 考古/D33 形态抑制）；mixed=false（一票否决）；arch=true（.dsh/sessions 读数也算元操作）；空=false'])
  const wait = [
    { role: 'user', content: [{ type: 'text', text: 'u' }] },
    ac([{ n: 'job_output', a: { job_id: 'bash-1502' } }]),
  ]
  const sleepPoll = [ac([{ n: 'bash', a: { command: 'sleep 240; cat /tmp/round2.log' } }])]
  const shortSleep = [ac([{ n: 'bash', a: { command: 'sleep 0.5; xdotool key Esc' } }])]
  const plain = [{ role: 'assistant', content: [{ type: 'text', text: '汇报' }] }]
  const w1 = detectWaitingWindow(wait)
  const w2 = detectWaitingWindow(sleepPoll)
  check(10, '等待窗口：job_output → {jobId}；sleep ≥20s → {null}；sleep 0.5 / 纯汇报 → null',
    w1 && w1.jobId === 'bash-1502' && w2 && w2.jobId === null && detectWaitingWindow(shortSleep) === null && detectWaitingWindow(plain) === null,
    [`job_output → ${JSON.stringify(w1)}；sleep 240 → ${JSON.stringify(w2)}；sleep 0.5=正常节奏=null；纯汇报=null`])
}

/* ═══ ⑪-⑫ §3 修法5：等待锚触发语义 ═══ */
{
  const { Config } = await import('../lib/config.js')
  const fullCfg = Config({ bucket: '', native: { vcpRoot: '/home/h/app/VCPToolBox' } })
  const base = () => {
    const st = getSession('probe-wait', null)
    resetSessionAudit('probe-wait')
    st.lastDiaryWriteAt = NOW - 30 * MIN
    st.lastDiaryWriteTurn = 1
    st.lastDiaryWriteStep = 1
    st.lastWriteNudgeAt = 0
    st.lastWriteNudgeTurn = -1
    st.lastWriteNudgeStep = 0
    st.lastWriteNudgeReason = ''
    st.nudgeAnchorChars = 0
    st.activeMsAnchor = 0
    st.activeMs = 0
    st.lastAssistantDigest = 'ys-loop round all green'
    st.lastDraftSummary = null
    st.compressStreak = 0
    return st
  }
  // 四锚全关（waiting 是第五锚：锚全关时 nudge 整体关闭，等待不单独破闸）。
  const cfg = { ...fullCfg, inject: { ...fullCfg.inject, writeNudgeEverySteps: 0, writeNudgeEveryMinutes: 0, writeNudgeEveryTurns: 0, writeNudgeGrowthChars: 0 } }
  const cfgSteps = { ...fullCfg, inject: { ...fullCfg.inject, writeNudgeEverySteps: 999, writeNudgeEveryMinutes: 0, writeNudgeEveryTurns: 0, writeNudgeGrowthChars: 0 } }
  const n0 = evaluateWriteNudge(cfg, base(), 2, NOW, 10, 5000, undefined, false, undefined, undefined, { jobId: 'bash-1502' })
  const n1 = evaluateWriteNudge(cfgSteps, base(), 2, NOW, 10, 5000, undefined, false, undefined, undefined, { jobId: 'bash-1502' })
  check(11, '等待窗口 + 步距≥3 + 有鲜 digest → 触发，reason 带 job 名；四锚全关时仍不触发（总开关优先）',
    typeof n1 === 'string' && n1.includes('bash-1502') && n1.includes('等待中的后台任务') && n0 === null,
    [`锚开腿触发文案首段=${n1 ? n1.split('\n')[0].slice(0, 90) : '(null)'}`,
     `四锚全关腿 → ${n0 === null ? 'null ✓（等待锚不单独破总闸）' : '触发 ✗'}`])
  const stJustWrote = base()
  stJustWrote.lastDiaryWriteStep = 9 // 刚写过（10-9=1 < 3）
  const n2 = evaluateWriteNudge(cfgSteps, stJustWrote, 2, NOW, 10, 5000, undefined, false, undefined, undefined, { jobId: 'j' })
  const stNoDigest = base()
  stNoDigest.lastAssistantDigest = ''
  const n3 = evaluateWriteNudge(cfgSteps, stNoDigest, 2, NOW, 10, 5000, undefined, false, undefined, undefined, { jobId: 'j' })
  check(12, '步距<3（刚写完不连拍）或无鲜 digest → 不触发',
    n2 === null && n3 === null,
    [`刚写完（stepsSince=1）→ ${n2 === null ? 'null ✓' : '触发 ✗'}；无 digest（没进展可入河）→ ${n3 === null ? 'null ✓' : '触发 ✗'}`])
}

/* ═══ ⑬ §2 修法1：压缩泵断开（纯函数级模拟） ═══ */
{
  // 三轮模拟：注入 → 同批在场（强刷语境）→ 压缩吃掉块后再强刷。
  // 断言：同条目整个模拟内注入 ≤2 次（首次 + 压缩后补注一次），在场时强刷不重放。
  const st = getSession('probe-pump', null)
  resetSessionAudit('probe-pump')
  st.audits = []
  st.lastSelectionKey = null
  st.lastInjectTurn = -1
  st.lastCompactionId = null
  const { createHash } = await import('node:crypto')
  const sha = (t) => createHash('sha256').update(t).digest('hex')
  const entries = [cand(1, 1), cand(2, 2)]
  const block = '⟨memo-river·被动召回⟩ D1 t1 D2 t2 ⟨/memo-river⟩'
  const withBlock = [{ role: 'user', content: [{ type: 'text', text: block }], source: { kind: 'memo-river' } }]
  const afterCompaction = [{ role: 'user', content: [{ type: 'text', text: '[compact-checkpoint] 摘要' }], source: { kind: 'compact-checkpoint' } }]
  let injectedCount = 0
  // 轮 1：首注
  st.audits.push({ turn: 1, step: 1, blockHash: sha(block), chars: block.length, tailIndex: null, totalMessages: null, assistantAfter: null, selectionKeys: ['A:1', 'A:2'], at: NOW })
  injectedCount += entries.length
  // 轮 2：块仍在场（refreshDue=true 模拟）→ 条目级剔光 → 注入 0
  const liveK2 = liveInjectedKeys(withBlock, st)
  const r2 = filterLiveDuplicates(entries, liveK2, 'A')
  injectedCount += r2.kept.length
  // 轮 3：压缩吃掉块（消息数组里只剩摘要）→ 放行重注（记忆不静默丢）
  const liveK3 = liveInjectedKeys(afterCompaction, st)
  const r3 = filterLiveDuplicates(entries, liveK3, 'A')
  injectedCount += r3.kept.length
  check(13, '压缩泵断开：在场时强刷不重放（r2 剔光）、压缩吃掉后放行补注（r3 全放）——同条目全程 ≤2 次',
    r2.kept.length === 0 && r2.duplicated.length === 2 && r3.kept.length === 2 && injectedCount === 4 && injectedCount / entries.length === 2,
    [`轮2 在场剔=[${r2.duplicated.map((d) => `D${d.id}`)}]（旧语义此处会整批重放=泵）；轮3 压缩后放行=[${r3.kept.map((c) => c.id)}]`,
     `每条目注入 ${injectedCount / entries.length} 次（判据 ≤2）`])
}

line('\n' + '═'.repeat(72))
const passed = results.filter((r) => r.pass).length
line(`注入滤刀探针：${passed}/${results.length} ${passed === results.length ? '✅ 全绿' : '❌ 有红'}`)
for (const r of results) if (!r.pass) line(`  ❌ #${r.id} ${r.title}`)
if (passed !== results.length) process.exitCode = 1
