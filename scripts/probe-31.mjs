#!/usr/bin/env node
/**
 * probe-31.mjs —— #31（压缩后查询锚）单点复现探针（2026-09-16 固化资产）。
 *
 * 背景：主套件 37 项整跑 ~2min 且当期环境 SIGBUS 高频（4 跑 3 崩）——为判一个
 * 疑似回归整跑代价太高。本探针把 #31 的 fixture（自有 tmp 桶 + 两篇种子 +
 * 压缩事件注入断言）原样抽出，秒级复跑 N 次做统计判别（flake vs 真回归）。
 * 用法：node scripts/probe-31.mjs [次数=1]   （输出每次的入选/日志判定）
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, Config as ConfigSchema } from '../lib/index.js'
import { acquireWorkspace, releaseAllWorkspaces } from '../lib/workspace.js'
import { workspacePaths } from '../lib/runtime.js'

const VCP = '/home/h/app/VCPToolBox'
const N = Number(process.argv[2] ?? 1)

function createMockCtx() {
  const listeners = new Map()
  const registered = { sections: [], contexts: [], tools: [] }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(event, fn) {
      const list = listeners.get(event) ?? []
      list.push({ fn })
      listeners.set(event, list)
      return () => {}
    },
    effect(cb) { cb(); return () => {} },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    tools: { register(t) { registered.tools.push(t); return () => {} } },
    get: () => undefined,
    interval(fn) { const h = setInterval(fn, 3_600_000); h.unref?.(); return () => clearInterval(h) },
  }
  return { ctx, listeners, registered }
}

const textMsg = (role, text) => ({ role, content: [{ type: 'text', text }], source: { kind: role === 'user' ? 'user' : 'model' } })
const pluginMsg = (text, plugin = 'runtime-context') => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin, form: 'snapshot' } })
const msgText = (m) => String((m?.content ?? []).filter((c) => c?.type === 'text').map((c) => c.text).join(' '))
function createAgent(sessionId, cwd, priorLog = []) {
  const log = [...priorLog]
  return { session: { id: sessionId, header: { cwd }, deriveMessages: () => log }, log }
}

async function runPreStep(h, agent, turn, claimed, step = 1) {
  const list = h.listeners.get('agent/pre-step') ?? []
  const runtimeContext = pluginMsg('Current runtime context.')
  let next = async () => ({ kind: 'enter', messages: [...claimed, runtimeContext] })
  for (let i = list.length - 1; i >= 0; i--) {
    const cur = list[i]
    const nxt = next
    next = async () => cur.fn({ agent, turn, step, signal: undefined }, nxt)
  }
  const d = await next()
  agent.log.push(...(d.messages ?? []))
  return d
}

const makeConfig = (o = {}) => ConfigSchema({ bucket: '', native: { vcpRoot: VCP }, ...o })

let fail = 0
for (let i = 1; i <= N; i++) {
  const CA_CWD = join(tmpdir(), `memo-river-probe31-${process.pid}-${Date.now()}`)
  const caPaths = workspacePaths(CA_CWD, '压缩锚测试')
  rmSync(CA_CWD, { recursive: true, force: true })
  rmSync(caPaths.root, { recursive: true, force: true })
  mkdirSync(CA_CWD, { recursive: true })
  acquireWorkspace(CA_CWD, makeConfig({ bucket: '压缩锚测试' }))
  const h = createMockCtx()
  await apply(h.ctx, makeConfig({ bucket: '压缩锚测试' }))
  const wTool = h.registered.tools.find((t) => (t.name ?? t.definition?.name) === 'memo_write')
  const execW = wTool.execute.bind(wTool)
  const wCtx = { agent: createAgent(`probe31-w-${i}`, CA_CWD, []) }
  const exec = (title, date, body, reason) => {
    const args = { content: `# ${title}\n\n${body}\n\nTag: 压缩锚, 渲染管线, 热载方案` }
    if (date !== undefined) args.date = date
    if (reason !== undefined) args.newTagReason = reason
    return execW(args, wCtx)
  }
  const w1 = String(await exec('旧渲染卡顿复盘', '2026-01-05', '结论：渲染卡顿是阴影贴图分辨率过高，降到一半就流畅了。', '新开测试桶，三个 Tag 都是该桶首批词汇'))
  const w2 = String(await exec('预设热载方案', undefined, '结论：会话级热载走注册到 agent.ctx 的路径，进程级路由一个进程只能挂一次。'))
  const w1ok = /已写入 D\d+/.test(w1)
  const w2ok = /已写入 D\d+/.test(w2)
  const compact31 = {
    role: 'user',
    content: [{ type: 'text', text: 'Compressed 2 block(s), ~9286 tokens reclaimed. 摘要：本轮之前在排查渲染卡顿，讨论了阴影贴图与分辨率。 (id=acc31-c1)' }],
    source: { kind: 'plugin', plugin: 'compact', compactionId: 'acc31-c1' },
  }
  const h31 = createMockCtx()
  apply(h31.ctx, makeConfig({ bucket: '压缩锚测试', inject: { k: 1, dynamicK: 1, autonomousInjectEverySteps: 99, dedupeRefreshTurns: 99, tokenBudget: 900 } }))
  const agent31 = createAgent(`probe31-r-${i}`, CA_CWD, [
    textMsg('user', '渲染又卡了，上次怎么解决的来着？'),
    compact31,
    textMsg('assistant', '热载方案：先写契约测试，然后把会话级注册走 agent.ctx，进程级路由只能挂一次要绕开。'),
  ])
  const d31 = await runPreStep(h31, agent31, 1, [], 2)
  const t31 = d31.messages.map(msgText).join('\n')
  const titles31 = [...t31.matchAll(/D\d+「([^」]+)」/g)].map((m) => m[1])
  let log31 = ''
  try { log31 = readFileSync(join(caPaths.root, 'memo-river.log'), 'utf8') } catch { /* 无日志 */ }
  const pickedHot = titles31.some((t) => t.includes('热载'))
  const notOld = !titles31.some((t) => t.includes('渲染'))
  const triggerOk = log31.includes('trigger=compaction') && log31.includes(`session=probe31-r-${i}`)
  const pass = w1ok && w2ok && pickedHot && notOld && triggerOk
  if (!pass) fail++
  console.log(`#${i} ${pass ? '✅' : '❌'} 种子写:1=${w1ok ? '✅' : '❌'} 2=${w2ok ? '✅' : '❌（尾行: ' + w2.split('\n').slice(-2).join(' ⏎ ').slice(0, 120) + '）'} 入选:[${titles31.join(' | ')}] trigger日志:${triggerOk ? '✅' : '❌'}`)
  rmSync(CA_CWD, { recursive: true, force: true })
  rmSync(caPaths.root, { recursive: true, force: true })
  try { releaseAllWorkspaces() } catch { /* 已关 */ }
}
console.log(fail === 0 ? `全部通过（${N} 次）` : `${fail}/${N} 失败`)
process.exit(fail ? 1 : 0)
