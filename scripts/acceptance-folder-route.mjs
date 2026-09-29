#!/usr/bin/env node
/**
 * acceptance-folder-route.mjs —— 票 01（recall-quality-0916）「memo_recall folder 真路由」的实测。
 *
 * 五条判据，全部走插件真实路径（mock 的只有 Cordis 壳，被测逻辑不 mock）：
 *   FR-1 跨桶：本桶 A 会话里 folder=routeB → 直接查到 B 桶真实条目（旧实现此处必然 0 命中）
 *   FR-2 不存在桶：folder=不存在 → 明确报错并列出可用桶名（含 routeA/routeB）
 *   FR-3 缺省回归：不传 folder / folder=本桶名 → 本桶行为不变
 *   FR-4 使用台账：跨桶召回的 active 足迹记在**目标桶** B，本桶 A 的台账不动
 *   FR-5 同名消歧：同名多桶 → 报错列候选；folder 传 16 位哈希 → 精确路由
 *
 * 自建自净：整个环境（DSH_HOME 状态根 + A/B/B′ 三个 cwd 工作区）建在 mktemp 目录里，
 * 结束整体删除——绝不触碰 ~/.dsh/memo-river 生产桶。嵌入走真实 API（与其余套件同口径）。
 *
 * 用法：node scripts/acceptance-folder-route.mjs
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/* ── 自建自净环境：DSH_HOME 必须在 import lib 之前指好（动态 import） ── */
const TMP = mkdtempSync(join(process.env.TMPDIR || '/var/tmp', 'memo-river-route-'))
process.env.DSH_HOME = join(TMP, 'dsh-home')
const { apply, Config: ConfigSchema } = await import('../lib/index.js')
const { startEmbedStub } = await import('./embed-stub.mjs')
const { acquireWorkspace, releaseAllWorkspaces, resolveBucket } = await import('../lib/workspace.js')
const { readUsageLedger, KV_USAGE } = await import('../lib/health.js')
const { workspacePaths } = await import('../lib/runtime.js')

const VCP = '/home/h/app/VCPToolBox'
/** 三个 cwd 工作区：x/routeA、y/routeB、z/routeB（后两个**同名桶**、不同哈希——FR-5 消歧用）。 */
const WS_A = join(TMP, 'x', 'routeA')
const WS_B = join(TMP, 'y', 'routeB')
const WS_B2 = join(TMP, 'z', 'routeB')
for (const d of [WS_A, WS_B, WS_B2]) mkdirSync(d, { recursive: true })

const results = []
const line = (s = '') => console.log(s)
const hr = (t) => line('\n' + '═'.repeat(96) + (t ? `\n${t}` : '') + '\n' + '═'.repeat(96))
function check(id, title, pass, evidence) {
  results.push({ id, title, pass })
  line(`\n【验收 ${id}】${title}  →  ${pass ? '✅ PASS' : '❌ FAIL'}`)
  for (const e of [].concat(evidence)) line(`    ${e}`)
}

/* ── 最小 Cordis 替身（与 acceptance-usage.mjs 同款思路，独立一份） ── */
function createMockCtx() {
  const listeners = new Map()
  const registered = { tools: [] }
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

const execStub = (cwd) => ({ agent: { session: { id: 'route-acceptance', header: { cwd } } } })

/* 语料：A 桶=教室渲染话题，B 桶=布料模拟话题——词汇完全不交叠，跨桶命中可判 */
const CORPUS = [
  [WS_A, '# 教室渲染卡顿的根因排查', '教室场景在 Blender 视口掉到 12 帧：draw call 过万、实例化未合并。把课桌椅合并成三个 mesh instance 组后回升到 55 帧。', '渲染优化, 排查记录, 教室建模'],
  [WS_A, '# 烘焙光照贴图后的帧率回升', '教室场景烘焙光照贴图后实时灯从 32 盏降到 2 盏，帧率稳定 60。注意 UV2 展开重叠会让贴图出现漏光。', '光照烘焙, 渲染优化, 教室建模'],
  [WS_B, '# 布料模拟褶皱参数调优', '裙摆布料解算：迭代次数 12、自碰撞厚度 0.8cm、碰撞距离放大 1.2 倍后，褶皱自然且不再穿插。厚度太小会爆布料，太大褶皱消失。', '布料模拟, 参数调优, 角色动画'],
  [WS_B, '# 蒙皮权重对裙摆抖动的修复', '裙摆根部顶点权重刷不匀会让布料模拟抖动：把权重过渡带从 2 帧拉宽到 8 帧，抖动消失。', '蒙皮权重, 布料模拟, 角色动画'],
]

let failed = false
try {
  hr('票 01 folder 真路由 · acceptance-folder-route')
  /* bucket 配置留空 → 每个工作区桶名 = basename(cwd)（routeA / routeB） */
  /* 提速资产（0916）：缺省本地嵌入桩（秒级、零网络、确定性）；REAL_EMBED=1 回落真端点。
   * 桩的词袋余弦尺度低于真嵌入 → gate 阈值同步调低（本套件测路由与落桶，不测语义门限）。 */
  const REAL_EMBED = process.env.REAL_EMBED === '1'
  const stub = REAL_EMBED ? null : await startEmbedStub('hash')
  const config = ConfigSchema({
    native: { vcpRoot: VCP },
    ...(stub ? { embed: { apiUrl: stub.url, apiKey: 'stub' }, inject: { gateThreshold: 0.2 } } : {}),
  })
  const h = createMockCtx()
  await apply(h.ctx, config)
  const memoWrite = h.registered.tools.find((t) => t.name === 'memo_write')
  const memoRecall = h.registered.tools.find((t) => t.name === 'memo_recall')
  if (!memoWrite || !memoRecall) {
    console.error('❌ 工具未注册：memo_write / memo_recall')
    process.exit(2)
  }

  /* ── 建桶：两桶各两篇（真实写路径 + 真实嵌入；端点偶发 HTTP/2 GOAWAY → 小重试兜底） ── */
  const writeWithRetry = async (ws, args, tries = 3) => {
    let last = ''
    for (let i = 0; i < tries; i++) {
      const out = await memoWrite.execute(args, execStub(ws))
      const text = Array.isArray(out) ? out.join('\n') : String(out)
      if (/已写入 D\d+/.test(text)) return text
      last = text
      if (!/embed-unavailable|embed-request-failed|GOAWAY|fetch failed/i.test(text)) break
      await new Promise((r) => setTimeout(r, 2500))
    }
    return last
  }
  for (const [ws, title, body, tags] of CORPUS) {
    const content = `${title}\n\n${body}\n\nTag: ${tags}`
    const text = await writeWithRetry(ws, { content, newTagReason: '自建自净测试桶首写：词汇表从零建立' })
    if (!/已写入 D\d+/.test(text)) {
      line(`❌ 写入失败（${ws}）：${text.slice(0, 300)}`)
      process.exit(2)
    }
  }
  const wsA = acquireWorkspace(WS_A, config)
  const wsB = acquireWorkspace(WS_B, config)
  const hashB = workspacePaths(WS_B).hash
  /* SIGBUS 闸适配（2026-09-29）：建桶写入的 native 异步可能仍在飞——裸 store 读前先收干两桶。 */
  await Promise.all([wsA.withDb(async () => {}), wsB.withDb(async () => {})])
  line(`\n建桶完成：A=${wsA.paths.bucket}@${wsA.paths.hash}（${wsA.store.files().length} 篇）` +
    `  B=${wsB.paths.bucket}@${wsB.paths.hash}（${wsB.store.files().length} 篇）`)

  /* ── FR-4 基线：两桶台账快照 ── */
  const ledgerA0 = wsA.store.kvGet(KV_USAGE)
  const ledgerB0 = wsB.store.kvGet(KV_USAGE)
  const activeB0 = new Map(readUsageLedger(wsB.store))

  /* ── FR-1 跨桶：A 会话查 B 桶 ── */
  const r1 = String(await memoRecall.execute({ query: '布料模拟 褶皱 自碰撞 厚度 迭代次数', folder: 'routeB' }, execStub(WS_A)))
  const r1ok = r1.includes('布料模拟褶皱参数调优') && !r1.includes('教室渲染卡顿') && r1.includes('🔄 folder 路由 → 桶=routeB@')
  check('FR-1', 'folder=routeB（A 会话）→ 返回 B 桶真实条目，无 A 桶串扰，路由标注在案', r1ok, [
    `路由行：${r1.split('\n')[0]}`,
    `命中：${(r1.match(/· D\d+「[^」]+」/g) ?? []).join(' ')}`,
  ])

  /* ── FR-4 台账足迹在目标桶 ── */
  const activeB1 = readUsageLedger(wsB.store)
  const gained = [...activeB1.entries()].filter(([id, e]) => e.active > (activeB0.get(id)?.active ?? 0))
  const aUnchanged = wsA.store.kvGet(KV_USAGE) === ledgerA0
  check('FR-4', '跨桶召回的 active 台账记在目标桶 B；本桶 A 台账零变更', gained.length > 0 && aUnchanged, [
    `B 桶 Δactive≥1 的篇：${gained.map(([id, e]) => `D${id}(active=${e.active})`).join(' ') || '（无）'}`,
    `A 桶台账键：${aUnchanged ? `冻结（${ledgerA0 === null ? 'null' : '原值'}）` : '⚠️ 被写入'}`,
  ])

  /* ── FR-2 不存在桶 → 报错 + 可用桶清单 ── */
  const r2 = String(await memoRecall.execute({ query: '布料', folder: 'route-不存在' }, execStub(WS_A)))
  const r2ok = r2.includes('不存在桶') && r2.includes('routeA') && r2.includes('routeB') && r2.includes('可用桶')
  check('FR-2', "folder=不存在桶 → 明确报错并列出可用桶名（含 routeA、routeB）", r2ok, [r2.split('\n')[0], r2.split('\n').find((l) => l.includes('可用桶')) ?? ''])

  /* ── FR-3 缺省回归：不传 folder / folder=本桶名 ── */
  const r3a = String(await memoRecall.execute({ query: '教室渲染 draw call 实例化合并 帧率' }, execStub(WS_A)))
  const r3b = String(await memoRecall.execute({ query: '教室渲染 draw call 实例化合并 帧率', folder: 'routeA' }, execStub(WS_A)))
  const r3ok = r3a.includes('教室渲染卡顿的根因排查') && !r3a.includes('布料模拟褶皱') &&
    r3b.includes('教室渲染卡顿的根因排查') && !r3b.includes('🔄 folder 路由')
  check('FR-3', '缺省（不传 folder）与 folder=本桶名：本桶检索行为不变（无路由标注）', r3ok, [
    `缺省命中：${(r3a.match(/· D\d+「[^」]+」/g) ?? []).slice(0, 3).join(' ')}`,
    `folder=routeA：${r3b.includes('🔄 folder 路由') ? '⚠️ 多余的路由标注' : '无路由标注（等价缺省）✓'}`,
  ])

  /* ── FR-5 同名消歧：z/routeB 再建同名桶 → 按名报错、按哈希精确路由 ── */
  const dup = '# 布料模拟的备选解算器对比\n\n对比 XPBD 与位置积分两种解算器在裙摆上的稳定性差异：XPBD 迭代少也不爆炸。\n\nTag: 布料模拟, 解算器, 角色动画'
  const dupOut = await writeWithRetry(WS_B2, { content: dup, newTagReason: '同名消歧测试桶首写：词汇表从零建立' })
  if (!/已写入 D\d+/.test(Array.isArray(dupOut) ? dupOut.join('\n') : String(dupOut))) {
    line(`❌ 同名桶写入失败：${String(dupOut).slice(0, 200)}`)
    process.exit(2)
  }
  const hashB2 = workspacePaths(WS_B2).hash
  const r5name = String(await memoRecall.execute({ query: '布料模拟 褶皱', folder: 'routeB' }, execStub(WS_A)))
  const r5hash = String(await memoRecall.execute({ query: '布料模拟 褶皱 自碰撞 厚度', folder: hashB }, execStub(WS_A)))
  const nameBlocked = r5name.includes('不唯一') && r5name.includes(hashB) && r5name.includes(hashB2)
  const hashRouted = r5hash.includes('🔄 folder 路由 → 桶=routeB@' + hashB) && r5hash.includes('布料模拟褶皱参数调优')
  check('FR-5', '同名多桶按名报错列候选；folder=16 位哈希精确路由到指定桶', nameBlocked && hashRouted, [
    `按名：${r5name.split('\n')[0]}`,
    `候选：${(r5name.match(/· routeB@[0-9a-f]{16} → \S+/g) ?? []).join(' | ')}`,
    `按哈希 ${hashB}：${r5hash.split('\n')[0]}；命中褶皱篇=${r5hash.includes('布料模拟褶皱参数调优')}`,
  ])

  /* ── FR-7/8/9（0916 手术现场 bug 回归）：跨桶 write/update/merge 真路由 ──
   * 生产翻车样本：memo_merge{folder} 报「D-id 不在桶」——folder 只当 diary_name 过滤器用、
   * 工作区仍是 cwd 本桶。此处三用例锁死三条写路径。 */
  const memoUpdate = h.registered.tools.find((t) => t.name === 'memo_update')
  const memoMerge = h.registered.tools.find((t) => t.name === 'memo_merge')
  if (!memoUpdate || !memoMerge) { console.error('❌ 工具未注册：memo_update / memo_merge'); process.exit(2) }

  const countB = () => wsB.store.files('routeB').length
  const countA = () => wsA.store.files('routeA').length
  const b0 = countB(), a0 = countA()

  /* FR-7 跨桶写入：A 会话 folder=routeB → 落 B 桶，A 桶零变更 */
  const w7 = await writeWithRetry(WS_A, {
    content: '# 跨桶写入验证：路由后落对桶\n\n从 routeA 会话用 folder=routeB 写入：验证 write 族真路由（手术现场 bug 回归）。布料桶的冷启动条目。\n\nTag: 布料模拟, 参数调优, 角色动画',
    folder: hashB, newTagReason: '跨桶路由回归测试写入',
  })
  const w7ok = /已写入 D\d+/.test(w7) && countB() === b0 + 1 && countA() === a0
  check('FR-7', 'memo_write{folder=哈希路由 routeB}（A 会话；按名会撞 FR-5 同名歧义）→ 落 B 桶（+1），A 桶零变更', w7ok, [
    `写入输出（尾 4 行）：${w7.split('\n').slice(-4).join(' ⏎ ')}`, `B=${countB()}（${b0}→+1 应 ${b0 + 1}） A=${countA()}（应恒 ${a0}）`,
  ])

  /* FR-8 跨桶改写：A 会话 folder=routeB 定位 FR-7 条目原地更新 */
  const u8 = String(await memoUpdate.execute({
    title: '跨桶写入验证', folder: hashB,
    content: '# 跨桶写入验证：路由后落对桶\n\n改写体：update 族跨桶路由回归（0916 手术 bug：folder 曾只改 diary_name 不换工作区）。\n\nTag: 布料模拟, 参数调优, 角色动画',
  }, execStub(WS_A)))
  const u8ok = !u8.includes('不在桶') && /已更新|✅/.test(u8)
  check('FR-8', 'memo_update{folder=哈希路由 routeB}（A 会话）→ 命中 B 桶条目原地改写', u8ok, [u8.split('\n')[0]])

  /* FR-9 跨桶合并：A 会话 folder=routeB 合并 B 桶两篇（生产事故原样路径） */
  const fb = wsB.store.files('routeB')
  const cloth = fb.find((f) => f.path.includes('褶皱参数调优'))
  const skin = fb.find((f) => f.path.includes('蒙皮权重'))
  const m9 = String(await memoMerge.execute({
    folder: hashB, sources: [cloth.id, skin.id], keep: cloth.id,
    content: '# 布料模拟两篇归一：褶皱参数与蒙皮权重\n\n合并自褶皱参数调优（迭代 12/自碰撞 0.8cm/碰撞放大 1.2）与蒙皮权重修复（过渡带 2→8 帧消抖）——跨桶 merge 路由回归篇。\n\nTag: 布料模拟, 参数调优, 角色动画',
  }, execStub(WS_A)))
  await wsB.withDb(async () => {})
  await wsB.withDb(async () => {}) /* SIGBUS 闸适配：merge 的 native 异步收干后再读 B 桶计数 */
  const m9ok = !m9.includes('不在桶') && /合并|归一|✅/.test(m9) && countB() === b0 /* +1(FR-7) 后 2→1 合并回 b0 */
  check('FR-9', 'memo_merge{folder=哈希路由, sources=B 桶 D-id}（A 会话）→ 解析成功并归一（不报「不在桶」）', m9ok, [
    m9.split('\n')[0], `B=${countB()}（FR-7 后 ${b0 + 1}，合并 2→1 应回 ${b0}）`,
  ])

  /* 附加取证：resolver 纯函数面（可用桶清单确实含两个真实桶 + 哈希匹配可独立命中） */
  const entries = (await import('../lib/workspace.js')).listBuckets().filter((e) => e.hasDb)
  line(`\n（取证）隔离状态根里有库桶：${entries.map((e) => `${e.bucket}@${e.hash}`).join('、')}`)
} catch (e) {
  failed = true
  line(`❌ 异常：${e?.stack ?? e}`)
} finally {
  try { releaseAllWorkspaces() } catch { /* 已关 */ }
  try { await stub?.stop() } catch { /* 已关 */ }
  rmSync(TMP, { recursive: true, force: true })
  line(`\n（自净）已删除 ${TMP}`)
}

hr('结果')
const bad = results.filter((r) => !r.pass)
line(`${results.length - bad.length}/${results.length} PASS${bad.length ? `；FAIL：${bad.map((f) => f.id).join(', ')}` : ''}`)
process.exit(bad.length || failed ? 1 : 0)
