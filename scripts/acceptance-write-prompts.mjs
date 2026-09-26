#!/usr/bin/env node
/**
 * acceptance-write-prompts.mjs —— 票 12（recall-quality-0916）「写侧提示词质量升级：
 * 给锚不给令」的实测（.scratch/recall-quality-0916/issues/12-write-prompt-quality.md）。
 *
 * 四个注入面 × 五条判据（mock 的只有 Cordis 壳；嵌入用固定向量桩——近重复引导需要向量）：
 *   T-1 nudge 无 tail：文案与票 05 前状态逐字一致（#37 零回归）+ 行数 ≤3
 *   T-2 nudge 带 tail/压缩计数：接续锚「上一篇止于「…」」+ 压缩提示进第 1 行；委托变体不回归
 *   T-3 continuationTail 单元：剥 Tag 行取末段、36 字截断、空→null
 *   T-4 真实 memo_write 回注：质量四要素行常在；近重复（knn≥0.80）出现「memo_update 并入」引导
 *   T-5 schema 描述含四要素 + 回注新增行总量 ≤300 字符（预算红线）
 *
 * 用法：node scripts/acceptance-write-prompts.mjs（自建自净 /tmp 工作区）
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, Config as ConfigSchema } from '../lib/index.js'
import { workspacePaths } from '../lib/runtime.js'
import { renderWriteNudge, continuationTail } from '../lib/render.js'

const CWD = join(tmpdir(), `memo-river-wp-${process.pid}`)
const BUCKET = '写侧提示词测试'
const TAGS = '写入测试, 种子语料, 回注引导'

const results = []
const line = (s = '') => console.log(s)
const hr = (t) => line('\n' + '═'.repeat(96) + (t ? `\n${t}` : '') + '\n' + '═'.repeat(96))
function check(id, title, pass, evidence) {
  results.push({ id, title, pass })
  line(`\n【验收 ${id}】${title}  →  ${pass ? '✅ PASS' : '❌ FAIL'}`)
  for (const e of [].concat(evidence)) line(`    ${e}`)
}

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
const execStub = (cwd) => ({ agent: { session: { id: 'write-prompts-acceptance', header: { cwd } } } })

/* ── 前置：自建自净 /tmp 工作区 ── */
const paths = workspacePaths(CWD, BUCKET)
rmSync(CWD, { recursive: true, force: true })
rmSync(paths.root, { recursive: true, force: true })
mkdirSync(CWD, { recursive: true })

hr(`票 12 写侧提示词 · acceptance-write-prompts（工作区 ${CWD}）`)

/* ── T-1/T-2/T-3：renderWriteNudge 与 continuationTail 纯函数断言 ── */
{
  const tags = ['写入测试', '种子语料']
  /* 票03（corpus-governance-0926）预算红线：末行字数增量以「票03 前文案」为基线常量化，不靠人眼。
   * 规则本身（内容词/枢纽/自造/newTagReason/反流水账）逐条断言——文案可以重写，规则不许丢。 */
  const OLD_NO_TAIL =
    '现在正是写日记的时机：用 memo_write 落一篇，写增量（延续/转折/因果），不复述已入河内容；Tag 优先复用词汇表：写入测试、种子语料。规范见「写日记规范」段。'
  const TAGS_CLAUSE = 'Tag 用内容词（主题/机制/对象/判据）'
  const HUB_CLAUSE = '跨篇 ≥1/3 的枢纽词不复用'
  const NEWTAG_CLAUSE = 'newTagReason'
  const NARRATION_CLAUSE = '只写决策/数字/判据/教训/悬而未决'
  const old1 = renderWriteNudge('已 2 轮汇报未写入', 5, '某进展', tags, null, false)
  const newLine1 = old1.split('\n')[1] ?? ''
  const t1 =
    old1.includes(TAGS_CLAUSE) && old1.includes(HUB_CLAUSE) && old1.includes(NEWTAG_CLAUSE) && old1.includes(NARRATION_CLAUSE) &&
    !old1.includes('Tag 优先复用词汇表') &&
    old1.split('\n').length === 2 &&
    !old1.includes('上一篇止于') && !old1.includes('刚压缩过') &&
    renderWriteNudge('已 2 轮汇报未写入', 5, '某进展', tags, { pending: 2, oldestAgeHours: 5 }, false).split('\n').length === 3
  check('T-1', 'nudge 无 tail：内容词 Tag 规则 + 反流水账锚在场，行数 ≤3 未增（票03 预算红线）', t1, [
    `末行字符：${newLine1.length}（票03 前 ${OLD_NO_TAIL.length}，Δ${newLine1.length - OLD_NO_TAIL.length >= 0 ? '+' : ''}${newLine1.length - OLD_NO_TAIL.length}）；行数 2（带队列 3）`,
    `规则在场：内容词=${old1.includes(TAGS_CLAUSE)} 枢纽=${old1.includes(HUB_CLAUSE)} newTagReason=${old1.includes(NEWTAG_CLAUSE)} 反流水账=${old1.includes(NARRATION_CLAUSE)} 旧措辞已除=${!old1.includes('Tag 优先复用词汇表')}`,
  ])

  const withTail = renderWriteNudge('已 7 分钟未写', 9, '某进展', tags, null, false, '票 11 落地完成，正进入票 12。', 0)
  const withBoth = renderWriteNudge('上下文已增 44K 字', 14, '某进展', tags, { pending: 3, oldestAgeHours: 42 }, false, '上一篇末段锚点。', 2)
  const del = renderWriteNudge('已 7 分钟未写', 9, '扇出前进展', tags, null, true, '锚点。', 1)
  const t2 =
    withTail.includes('上一篇止于「票 11 落地完成，正进入票 12。」') && withTail.includes('写增量（延续/转折/因果）') &&
    withTail.includes(TAGS_CLAUSE) && withTail.includes(NARRATION_CLAUSE) &&
    withBoth.split('\n')[0].includes('刚压缩过 2 段——优先落盘被压缩前的关键细节') &&
    withBoth.split('\n').length === 3 &&
    withBoth.includes(TAGS_CLAUSE) &&
    del.includes('兄弟代理') && del.includes('刚压缩过 1 段') && del.includes(TAGS_CLAUSE) && del.split('\n').length === 3
  check('T-2', 'nudge 带 tail/压缩计数/委托三态：接续锚+压缩提示（第 1 行）＋三态均带内容词规则，行数不增', t2, [
    `普通+tail 末行：${(withTail.split('\n')[1] ?? '').slice(0, 46)}…`,
    `压缩子句：${withBoth.split('\n')[0].match(/刚压缩过[^，]*/)?.[0] ?? '(无)'}；行数 ${withBoth.split('\n').length}（应 3）`,
    `委托末行：${(del.split('\n')[del.split('\n').length - 1] ?? '').slice(0, 46)}…；行数 ${del.split('\n').length}（应 3）`,
  ])

  const long = 'x'.repeat(50)
  const t3 =
    continuationTail('# 标\n\n正文末段这句是锚点。\n\nTag: a, b') === '正文末段这句是锚点。' &&
    continuationTail(`正文\n\n${long}\n\nTag: a`) === `${'x'.repeat(36)}…` &&
    continuationTail('Tag: a, b') === null && continuationTail('') === null && continuationTail('# 只有标题\n\nTag: a') === '# 只有标题'
  check('T-3', 'continuationTail：剥 Tag 行取末段、36 字截断、空/纯 Tag→null', t3, [
    `末段锚点：${continuationTail('正文甲。\n\n正文乙。\n\nTag: t')}`,
  ])
}

/* ── T-4/T-5：真实 memo_write 走插件入口（嵌入=本地 HTTP 桩走真实 EmbedClient 传输） ──
 * 桩返回固定 3072 维向量（=resolved.dimension，不匹配会被 embed-dim-mismatch 拒）：
 * 所有文本同向量 → 第二篇与第一篇 knn=1.000 ≥0.80 触发并入引导；≥0.95 被去重闸门拒（引导先行，闸门兜底）。
 * （前两版猴子补丁均失败：实例替换对工具路径的 workspace 无效、原型 getter 会 configured=false 拦在
 *   writeEmbed 之前——走真传输零补丁，保真度更高。） */
const { createServer } = await import('node:http')
const DIM = 3072
const V = Array.from({ length: DIM }, (_, i) => (i % 2 ? 0.2 : 0.9))
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    let n = 1
    try { n = JSON.parse(body).input.length } catch { /* 单条兜底 */ }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: V })) }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const config = ConfigSchema({ bucket: BUCKET, embed: { apiUrl: `http://127.0.0.1:${port}`, apiKey: 'stub-key' } })
const h = createMockCtx()
await apply(h.ctx, config)
const writeTool = h.registered.tools.find((t) => t.name === 'memo_write')
if (!writeTool) { console.error('❌ memo_write 未注册'); process.exit(2) }
const exec = (args) => writeTool.execute(args, execStub(CWD))

{
  const rA = String(await exec({
    title: '第一篇种子',
    content: '# 第一篇种子\n\n种子正文：建立语料基线。\n\nTag: ' + TAGS,
    newTagReason: '首建测试桶',
  }))
  const rB = String(await exec({
    title: '第二篇近重复',
    content: '# 第二篇近重复\n\n高度相似的正文：与第一篇同向量（桩），应触发并入引导而非静默新开。\n\nTag: ' + TAGS,
  }))
  const t4 = rA.includes('质量四要素') && rB.includes('最相似 D') && rB.includes('memo_update 并入')
    && rA.includes('Tag 自检') && rA.includes('写内容词') // 票03：写前回注 Tag 自检行
  check('T-4', '真实 memo_write：四要素行 + Tag 自检行常在；近重复出现「memo_update 并入」引导', t4, [
    `A Tag 自检行：${(rA.match(/【写前回注】Tag 自检[^\n]*/) ?? ['(无)'])[0].slice(0, 58)}…`,
    `A 四要素行：${(rA.match(/【写前回注】质量四要素[^\n]*/) ?? ['(无)'])[0].slice(0, 50)}…`,
    `B 引导行：${(rB.match(/【写前回注】最相似[^\n]*/) ?? ['(无)'])[0].slice(0, 60)}…`,
    `B 结局：${rB.includes('被拒绝') ? '近重复被拒（引导先行，闸门兜底——符合设计）' : '写入成功'}`,
  ])

  const schemaStr = JSON.stringify(writeTool)
  const addLines = [...rA.matchAll(/【写前回注】(质量四要素|最相似|Tag 自检)[^\n]*/g)].map((m) => m[0])
    .concat([...rB.matchAll(/【写前回注】(质量四要素|最相似|Tag 自检)[^\n]*/g)].map((m) => m[0]))
  const t5 = schemaStr.includes('四要素') && addLines.every((l) => l.length <= 160) && addLines.reduce((s, l) => s + l.length, 0) / 2 <= 300
  check('T-5', 'schema 描述含四要素 + 回注新增行 ≤300 字符（预算红线）', t5, [
    `schema 含四要素：${schemaStr.includes('四要素') ? '✅' : '❌'}`,
    `单篇新增行字符：${[...rA.matchAll(/【写前回注】(质量四要素|最相似|Tag 自检)[^\n]*/g)].map((m) => m[0].length).join('+') || 0} ≤300`,
  ])
}

rmSync(CWD, { recursive: true, force: true })
rmSync(paths.root, { recursive: true, force: true })
server.close()

hr('结果')
const pass = results.filter((r) => r.pass).length
line(`${pass}/${results.length} PASS`)
process.exit(pass === results.length ? 0 : 1)
