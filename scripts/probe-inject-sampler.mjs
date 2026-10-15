#!/usr/bin/env node
/**
 * probe-inject-sampler.mjs — 注入时延**自然流量**采样器（只读，常驻无害）。
 *
 * 背景：拆批（9a9d2cc）上线后只拿到 1 个自然样本（457ms），不足以给分布。
 * 本件每 N 秒扫一遍全桶 `memo-river.log`，把 `inject bucket=… elapsedMs=…` 行按整行去重落盘。
 * **只统计本次启动之后出现的行**——日志里有换端点前时代的旧样本（p50 3s+），回填会把两代混在一起
 * （2026-10-15 首版就栽在这：1193 条历史样本混进来，p50 假报 3115ms）。
 *
 * 用法：node scripts/probe-inject-sampler.mjs [--minutes=60] [--interval=15] [--out=path.jsonl]
 * 判据：成功注入样本 ≥10 才报分布；<10 只报个体值。
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : dflt
}
const MINUTES = Number(arg('minutes', 60))
const INTERVAL_S = Number(arg('interval', 15))
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const ROOT = join(HOME, 'memo-river')
const OUT = arg('out', join(process.cwd(), '.scratch', 'whale-fix', 'inject-samples.jsonl'))
mkdirSync(join(process.cwd(), '.scratch', 'whale-fix'), { recursive: true })

/** 启动时刻（UTC，与日志行 `[2026-10-15T12:31:31.515Z]` 同格式，字典序即时间序）。 */
const SINCE = new Date().toISOString()
const seen = new Set()
const samples = []
const key = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16)

function scan() {
  let buckets = []
  try {
    buckets = readdirSync(ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return 0
  }
  let added = 0
  for (const b of buckets) {
    const log = join(ROOT, b, 'memo-river.log')
    if (!existsSync(log)) continue
    let text = ''
    try {
      text = readFileSync(log, 'utf8')
    } catch {
      continue
    }
    for (const line of text.slice(-400_000).split('\n')) {
      if (!line.includes('inject bucket=') || !line.includes('elapsedMs=')) continue
      const k = key(line)
      if (seen.has(k)) continue
      seen.add(k) // 历史行也标记（避免每轮重扫），但不入样本
      const ts = /^\[([^\]]+)\]/.exec(line)?.[1] ?? ''
      if (ts < SINCE) continue
      const ms = Number(/elapsedMs=(\d+)/.exec(line)?.[1] ?? NaN)
      if (!Number.isFinite(ms)) continue
      const rec = {
        ts,
        bucket: b,
        elapsedMs: ms,
        kind: line.includes('inject-skip') ? 'skip' : 'inject',
        reason: /reason=([^ ]+)/.exec(line)?.[1] ?? 'ok',
      }
      samples.push(rec)
      appendFileSync(OUT, JSON.stringify(rec) + '\n')
      added++
    }
  }
  return added
}

const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : NaN)
function report(final = false) {
  const live = samples
    .filter((s) => s.kind === 'inject')
    .map((s) => s.elapsedMs)
    .sort((a, b) => a - b)
  const skips = samples.filter((s) => s.kind === 'skip')
  console.log(
    `[采样 ${new Date().toISOString().slice(11, 19)}] 自 ${SINCE.slice(11, 19)} 起：注入了 ${live.length} 次、跳过 ${skips.length} 次` +
      (live.length ? ` | p50=${pct(live, 50)}ms p90=${pct(live, 90)}ms max=${live[live.length - 1]}ms` : ''),
  )
  if (final) {
    console.log(live.length >= 10 ? '判据：样本 ≥10 → 分布可信' : `判据：样本 ${live.length} <10 → 只报个体值，不给分布`)
    console.log('逐条(ms)：', live.join(', '))
    if (skips.length) console.log('跳过原因：', JSON.stringify(skips.map((s) => s.reason)))
  }
}

console.log(`[采样器] 桶柜=${ROOT} 间隔=${INTERVAL_S}s 时长=${MINUTES}min → ${OUT}`)
scan() // 首次只做历史标记
report()
const until = Date.now() + MINUTES * 60_000
let lastReport = Date.now()
while (Date.now() < until) {
  await new Promise((r) => setTimeout(r, INTERVAL_S * 1000))
  scan()
  if (Date.now() - lastReport > 300_000) {
    lastReport = Date.now()
    report()
  }
}
scan()
report(true)
