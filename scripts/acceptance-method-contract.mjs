#!/usr/bin/env node
/**
 * 方法层第一刀验收：注入块「用法契约」（docs/DESIGN-2026-10-18-注入块用法契约.md）
 *
 * 判据（全部可证伪，不靠肉眼）：
 *   M-1 纯函数：methodContract=false 时输出**不含**契约行，且与「不传该参」逐字节相同
 *   M-2 纯函数：methodContract=true 时只多一行，条文位置在 BLOCK_CLOSE 之前
 *   M-3 内容不变：开关前后**逐条正文与 id 行完全相同**（契约不得压掉任何材料）
 *   M-4 契约不含 BLOCK_CLOSE（验收 #1 靠它定位注入块边界）
 *   M-5 不注入时（未过门控/空选集）两种取值都返回 null —— 契约不制造空块
 *   M-6 源码接线：injector 真正把 config.inject.methodContract 传进 renderInjection
 *   M-7 配置默认值 = false（上线那一刻零行为变化）
 *
 * 退出码：0 全绿 / 1 有失败
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const { renderInjection, BLOCK_CLOSE, BLOCK_OPEN } = await import(pathToFileURL(join(ROOT, 'lib/render.js')).href)
const { Config } = await import(pathToFileURL(join(ROOT, 'lib/config.js')).href)

const CONTRACT_MARK = '[用法]'
let pass = 0
let fail = 0
const results = []

function check(name, ok, detail) {
  results.push({ name, ok, detail })
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 构造一个确定性的 RecallOutcome（不依赖嵌入端点、不依赖时间）。 */
function makeOutcome(overrides = {}) {
  const cand = (id, title, body) => ({
    id,
    fileId: id,
    writtenAt: 1750000000000,
    title,
    diaryName: `d${id}.md`,
    knnScore: 0.8,
    score: 0.8,
    rawScore: 0.8,
    role: 'atomic_concept',
    anchorBonus: 0,
    topologyBonus: 0,
    omega: 0.9,
    riverRegime: 'dense',
    matchedTags: ['tagA'],
    rewardSuppressed: false,
    body,
  })
  return {
    injected: true,
    fallbackReason: null,
    gate: { passed: true, maxKnn: 0.8, threshold: 0.55, enabled: true, gateVector: 'gU', retrievalMaxKnn: 0.8 },
    mode: 'topology_v3',
    omega: 0.9,
    regime: 'dense',
    dynamicK: 1,
    candidateCount: 3,
    candidates: [],
    selected: [cand(101, '甲篇', '# 甲篇\n结论先行：A 成立。\nTag: x'), cand(102, '乙篇', '# 乙篇\n正文乙。\nTag: y')],
    dropped: [{ id: 103, reason: 'k-limit' }],
    diagnostics: {},
    elapsedMs: 12,
    ...overrides,
  }
}

const BUCKET = 'unit-test-bucket'

/* ── M-1 关闭 = 旧行为（逐字节） ───────────────────────────── */
{
  const o = makeOutcome()
  const asOff = renderInjection(o, BUCKET, false)
  const asDefault = renderInjection(o, BUCKET) // 不传第三参 = 改动前的调用形态
  check('M-1a methodContract=false 输出不含契约行', !!asOff && !asOff.includes(CONTRACT_MARK), asOff ? 'ok' : 'null')
  check('M-1b 显式 false 与不传参逐字节相同', asOff === asDefault, asOff === asDefault ? 'identical' : 'DIFF')
}

/* ── M-2 开启只多一行，位置正确 ───────────────────────────── */
{
  const o = makeOutcome()
  const off = renderInjection(o, BUCKET, false)
  const on = renderInjection(o, BUCKET, true)
  const offLines = off.split('\n')
  const onLines = on.split('\n')
  check('M-2a 开启后恰好多 1 行', onLines.length === offLines.length + 1, `${offLines.length} → ${onLines.length}`)
  const contractIdx = onLines.findIndex((l) => l.startsWith(CONTRACT_MARK))
  const closeIdx = onLines.indexOf(BLOCK_CLOSE)
  check('M-2b 契约行在 BLOCK_CLOSE 之前', contractIdx >= 0 && contractIdx < closeIdx, `idx=${contractIdx} close=${closeIdx}`)
  check('M-2c 块首仍是 BLOCK_OPEN', onLines[0].startsWith(BLOCK_OPEN), onLines[0].slice(0, 20))
}

/* ── M-3 内容不变（契约不得压掉任何材料） ─────────────────── */
{
  const o = makeOutcome()
  const off = renderInjection(o, BUCKET, false)
  const on = renderInjection(o, BUCKET, true)
  // 去掉契约行后，必须与 off 逐字节相同
  const onSansContract = on
    .split('\n')
    .filter((l) => !l.startsWith(CONTRACT_MARK))
    .join('\n')
  check('M-3a 抽掉契约行后与关闭档逐字节相同', onSansContract === off, onSansContract === off ? 'identical' : 'DIFF')
  check('M-3b 两条候选的 id 行都在', on.includes('D101') && on.includes('D102'), 'D101/D102')
  check('M-3c 正文未被压缩（甲篇结论仍在）', on.includes('A 成立'), 'A 成立')
}

/* ── M-4 契约行不得含块结束符 ─────────────────────────────── */
{
  const on = renderInjection(makeOutcome(), BUCKET, true)
  const contractLine = on.split('\n').find((l) => l.startsWith(CONTRACT_MARK))
  check('M-4 契约行不含 BLOCK_CLOSE', !contractLine.includes(BLOCK_CLOSE), contractLine?.slice(0, 24))
}

/* ── M-5 不注入时不制造空块 ───────────────────────────────── */
{
  const notInjected = makeOutcome({ injected: false })
  const emptySel = makeOutcome({ selected: [] })
  check('M-5a injected=false → 两种取值都 null', renderInjection(notInjected, BUCKET, false) === null && renderInjection(notInjected, BUCKET, true) === null)
  check('M-5b selected=[] → 两种取值都 null', renderInjection(emptySel, BUCKET, false) === null && renderInjection(emptySel, BUCKET, true) === null)
}

/* ── M-6 源码接线（配置真的传进去了） ─────────────────────── */
{
  const injectorSrc = readFileSync(join(ROOT, 'src/injector.ts'), 'utf8')
  const wired = /renderInjection\(\s*finalOutcome,\s*workspace\.paths\.bucket,\s*deps\.config\.inject\.methodContract\s*\)/.test(injectorSrc)
  check('M-6 injector 把 config.inject.methodContract 传入 renderInjection', wired, wired ? 'wired' : '未接线')
}

/* ── M-7 默认值 false（零行为变化） ───────────────────────── */
{
  const cfg = Config({})
  const def = cfg?.inject?.methodContract
  check('M-7 配置缺省 = false', def === false, String(def))
}

console.log('')
if (fail === 0) {
  console.log(`${pass}/${pass + fail} 全绿`)
  process.exit(0)
}
console.log(`${pass}/${pass + fail}，失败 ${fail} 项`)
process.exit(1)

import { pathToFileURL } from 'node:url'
