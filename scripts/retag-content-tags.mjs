#!/usr/bin/env node
/**
 * retag-content-tags.mjs —— 把桶里的**流程词 Tag** 换成**内容词 Tag**（2026-09-25）。
 *
 * 由头（任务书第二步）：桶 `deepseek-harness` 的 8 个 Tag 全是流程词
 * （干跑验证 13/20、DSH升级 12、本地补丁 10、预设迁移 9、版本盘点 8、构建闸门 7、
 *  上游同步 6、生命周期握手 5）——自然语言查询里永远不会出现这些词，锚无从建立；
 *  hub 闸门（≥1/3）每次写入都在警告却一直被放行。这是 anchor 全零的土壤。
 *
 * 本脚本做四件事：
 *   ① 按「每篇正文主题」重挂 3–5 个内容词 Tag（PLAN 表就是设计本身，进仓可审计）
 *   ② 只改每篇末尾那一行 `Tag: …`——**正文逐字节不动**（脚本自己校验并落读数）
 *   ③ 走**真实写路径**（memo_update 工具 → writeDiaryCore 全套闸门：3–5 个、≤20 字、
 *      新 Tag 必给理由、同义漂移 >0.92 拒绝、hub 闸门），不打后门、不直接写库
 *   ④ 收尾自证：Tag 频次表 + 连通分量 + 正文完整性 + 落盘 readings JSON
 *
 * 纪律：默认 `--dry` 只打印计划；`--apply` 才写。**要测先指 DSH_HOME 到副本**
 * （桶路径 = $DSH_HOME/memo-river/<hash>/），生产根一字不碰。
 *
 * 用法：
 *   node scripts/retag-content-tags.mjs                          # 干跑（打印计划 + 闸门预检）
 *   DSH_HOME=<副本根> node scripts/retag-content-tags.mjs --apply # 在副本上真写
 *   node scripts/retag-content-tags.mjs --apply --folder deepseek-harness
 *   node scripts/retag-content-tags.mjs --apply --only 1,2,3      # 只补做指定 D 编号
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, Config as ConfigSchema } from '../lib/index.js'
import { acquireBucketRuntime, resolveBucket } from '../lib/workspace.js'
import { KnowledgeStore } from '../lib/store.js'
import { connectedComponents } from '../lib/health.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const VCP = '/home/h/app/VCPToolBox'
const WS = join(ROOT, '.scratch', 'retag', 'ws')

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const argOf = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const FOLDER = argOf('--folder', 'deepseek-harness')
const ONLY = argOf('--only', '')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isSafeInteger(n) && n > 0)

/* ────────────── 设计表：D 编号（= memo 里的 D-id 口径）→ 新 Tag 列表 ──────────────
 *
 * 三条设计约束（也是验收判据）：
 *   · 每篇 3–5 个（写侧闸门 TAG_MIN=3 / 上限 5）
 *   · 每个 Tag 跨篇 ≤5（20 篇 × 1/3 = 6.67 → 必须 <6.67；取 5 留出新增篇的余量）
 *   · 8 个旧 Tag 各保留 ≥1 篇（**不是美观问题**：connectedComponents 遍历 tags 表全量，
 *     孤儿 Tag 自带一个连通分量 ⇒ 判据①「必须 =1」当场破）
 */
const PLAN = {
  1: ['上游同步', '版本盘点', '补丁器锚点移植', '环境保真度', '干跑验证'],
  2: ['DSH升级', '上游同步', 'peer上限阻塞', '消费面核查'],
  3: ['版本盘点', '本地补丁', '补丁器锚点移植', 'agent事件改名'],
  4: ['本地补丁', '生命周期握手', 'agent事件改名'],
  5: ['本地补丁', '上游同步', '构建闸门', '推送闸门脏增量'],
  6: ['本地补丁', '上游同步', '预设迁移', '补丁器锚点移植', '环境保真度'],
  7: ['本地补丁', '上游同步', '补丁器锚点移植', '环境保真度', '工具可信度自证'],
  8: ['DSH升级', 'peer上限阻塞', '沙箱演练', '环境保真度'],
  9: ['预设迁移', '沙箱演练', '相对路径解析'],
  10: ['沙箱演练', '会话格式V4', '会话代迁移'],
  11: ['预设迁移', '沙箱演练', '环境保真度', '干跑验证'],
  12: ['DSH升级', '生命周期握手', '构建闸门', '沙箱演练', '会话代迁移'],
  13: ['插件适配0.1.7', '会话格式V4', '消息来源字段'],
  14: ['预设迁移', '相对路径解析', '插件适配0.1.7', '会话格式V4', '消息来源字段'],
  15: ['DSH升级', 'peer上限阻塞', '消费面核查', '插件适配0.1.7'],
  16: ['沙箱验收', '嵌入端点时延', '注入超时丢召回', '工具可信度自证'],
  18: ['嵌入端点时延', '工具可信度自证', '代理传输'],
  19: ['沙箱验收', '注入超时丢召回', '注入窗口截断', '契约实现不符'],
  20: ['插件适配0.1.7', '消息来源字段', '沙箱验收'],
  21: ['沙箱验收', 'profile清单校验', '历史坑复现'],
}

const NEW_TAG_REASON =
  '2026-09-25 内容词 Tag 重构：原 8 个 Tag 全是流程词（干跑验证 13/20 等），自然语言查询命中不了，' +
  '锚无从建立。逐篇读正文后按**主题**重挂 21 个内容词 Tag（每篇 3–5 个、跨篇 ≤5），正文一字不动。'

const TAG_LINE_RE = /^[ \t]*Tag[：:][ \t]*(.+)$/gm
const bodyOf = (s) => s.replace(/^[ \t]*Tag[：:][ \t]*(.+)$/m, '').replace(/\s+$/, '')

const line = (s = '') => console.log(s)
const hr = (t) => line('\n' + '═'.repeat(96) + (t ? `\n${t}` : '') + '\n' + '═'.repeat(96))

/* ── 计划自检（不碰任何 I/O）：条数 / 长度 / 跨篇频次 ── */
const freq = new Map()
for (const [d, tags] of Object.entries(PLAN)) for (const t of tags) freq.set(t, (freq.get(t) ?? 0) + 1)
const nFiles = Object.keys(PLAN).length
const planErrors = []
for (const [d, tags] of Object.entries(PLAN)) {
  if (tags.length < 3 || tags.length > 5) planErrors.push(`D${d}：${tags.length} 个 Tag（须 3–5）`)
  for (const t of tags) if (t.length > 20) planErrors.push(`D${d}：「${t}」超 20 字`)
  if (new Set(tags).size !== tags.length) planErrors.push(`D${d}：Tag 重复`)
}
for (const [t, c] of freq) if (c > 5) planErrors.push(`「${t}」跨 ${c} 篇（>5）`)
const planMax = Math.max(...freq.values())

hr('Tag 重构计划（内容词）')
line(`桶 = ${FOLDER}　篇数（计划覆盖）= ${nFiles}　Tag 种类 = ${freq.size}　最大跨篇 = ${planMax}`)
line(`判据 ②：最大频次 < 1/3 → 需 < ${(nFiles / 3).toFixed(2)}；本计划 ${planMax}/${nFiles} = ${(planMax / nFiles).toFixed(3)}`)
line('\nTag → 篇数：')
for (const [t, c] of [...freq].sort((a, b) => b[1] - a[1])) line(`  ${String(c).padStart(2)}  ${t}`)
if (planErrors.length) {
  hr('❌ 计划自检失败')
  for (const e of planErrors) line('  ' + e)
  process.exit(2)
}
line('\n✅ 计划自检通过（3–5 个/篇、≤20 字、跨篇 ≤5）')

/* ── 打开目标桶（DSH_HOME 决定根；--dry 也要打开，才能报「实际」频次） ── */
function mockCtx() {
  const tools = []
  return {
    tools,
    ctx: {
      logger: { info() {}, warn() {}, error() {} },
      on() { return () => {} },
      effect(cb) { cb(); return () => {} },
      systemPrompt: { section: () => () => {}, context: () => () => {} },
      tools: { register(t) { tools.push(t); return () => {} } },
      get: () => undefined,
      interval(fn) { const h = setInterval(fn, 3_600_000); h.unref?.(); return () => clearInterval(h) },
    },
  }
}
const h = mockCtx()

/* 目标桶 = folder 真路由解析出的那个（DSH_HOME 决定状态根；本会话 DSH_HOME = 3101 沙箱，
 * 要打生产根须显式 DSH_HOME=/home/h/.dsh）。不用本地 ws：那是 cwd 哈希桶，不是目标桶。 */
const resolved = resolveBucket(FOLDER)
if (!resolved.ok) { console.error('❌ folder 路由失败\n' + resolved.error); process.exit(2) }
const entry = resolved.entry

/* 关键：**不要**把 config.bucket 设成目标桶名。插件启动会按 process.cwd() 建/写「本工作区桶」，
 * 那时 bucket = config.bucket || basename(cwd) —— 传 'deepseek-harness' 会让
 * 「dsh-memo-river 工作区」的桶被命名成 deepseek-harness（实测：副本里凭空长出同名第二桶，
 * 真路由随即报「桶名不唯一」；打到生产根则等于改写本项目自己桶的 manifest 身份）。
 * 改为 chdir 到目标工作区 cwd：本工作区桶 = 目标桶，全程只碰这一个桶。 */
const config = ConfigSchema({ native: { vcpRoot: VCP } })
process.chdir(entry.cwd ?? entry.root)
await apply(h.ctx, config)
const updateTool = h.tools.find((t) => t.name === 'memo_update')
if (!updateTool) { console.error('❌ memo_update 未注册'); process.exit(2) }

const ws = acquireBucketRuntime(entry, config)
await ws.ensureLoaded?.()
const store = ws.store
const dbPath = ws.paths.dbPath
const execStub = (cwd) => ({ agent: { session: { id: 'retag-content-tags', header: { cwd } } } })
line(`\n路由：folder=${FOLDER} → ${entry.bucket}@${entry.hash}\n  root=${entry.root}\n  cwd=${entry.cwd ?? '-'}\n  DSH_HOME=${process.env.DSH_HOME ?? '(缺省 ~/.dsh)'}`)

const chunks = store.chunks(FOLDER)
const byId = new Map(chunks.map((c) => [c.id, c]))
line(`\n目标桶库：${dbPath}`)
line(`桶内篇数 = ${store.files(FOLDER).length}　chunk = ${chunks.length}`)

/* D 编号定位：首次运行 D = chunk id；但 **memo_update 会换 chunk**（新 chunk id），
 * 所以从第二次起必须靠落盘的 fileId 映射（file id / 路径在改写中不变）。 */
const filesById = new Map(store.files(FOLDER).map((f) => [f.id, f]))
const chunkByFile = new Map(chunks.map((c) => [c.file_id, c]))
const MAP_PATH = join(ROOT, '.scratch', 'retag', 'file-map.json')
const fileMap = existsSync(MAP_PATH) ? JSON.parse(readFileSync(MAP_PATH, 'utf8')) : {}

const before = new Map() // D-id → { fileId, content, body, tagLine, index, length, path }
const resolvedIds = {}
for (const d of Object.keys(PLAN).map(Number)) {
  let chunk = byId.get(d)
  let fileId = chunk ? chunk.file_id : fileMap[d]?.fileId ?? null
  if (!chunk && fileId) chunk = chunkByFile.get(fileId)
  if (!chunk || !fileId) {
    console.error(`❌ 定位不到 D${d}（chunk id 口径无此 id，${MAP_PATH} 也无记录）——改用 --only 分批或先确认桶内容`)
    process.exit(2)
  }
  const content = String(chunk.content ?? '')
  const matches = [...content.matchAll(TAG_LINE_RE)]
  if (matches.length !== 1) { console.error(`❌ D${d} 的 Tag 行有 ${matches.length} 处（期望 1）`); process.exit(2) }
  const path = filesById.get(fileId)?.path ?? '?'
  resolvedIds[d] = { fileId, path }
  before.set(d, {
    fileId,
    content,
    body: bodyOf(content),
    tagLine: matches[0][1].trim(),
    index: matches[0].index,
    length: matches[0][0].length,
    path,
  })
}
mkdirSync(dirname(MAP_PATH), { recursive: true })
writeFileSync(MAP_PATH, JSON.stringify(resolvedIds, null, 2))

if (!APPLY) {
  hr('干跑：将写入的改动（每篇只动末尾 Tag 行）')
  for (const [d, tags] of Object.entries(PLAN).map(([k, v]) => [Number(k), v])) {
    const b = before.get(d)
    line(`\nD${d}　${b.path.split('/').pop()}`)
    line(`  旧：${b.tagLine}`)
    line(`  新：${tags.join(', ')}`)
  }
  line(`\n（未加 --apply，未写任何东西。）`)
  process.exit(0)
}

/* ────────────── 真写：逐篇 memo_update（同一份闸门） ────────────── */
hr(`真写：${APPLY ? 'APPLY' : 'DRY'}　DSH_HOME=${process.env.DSH_HOME ?? '(缺省 ~/.dsh)'}`)
const results = []
for (const [d, tags] of Object.entries(PLAN).map(([k, v]) => [Number(k), v])) {
  if (ONLY.length && !ONLY.includes(d)) continue
  const b = before.get(d)
  const newContent = b.content.slice(0, b.index) + `Tag: ${tags.join(', ')}` + b.content.slice(b.index + b.length)
  const t0 = Date.now()
  let report = ''
  try {
    /* 传**解析后的 fileId**，不传 PLAN 的键：键是 chunk id 口径，而工具是 file-id 优先解析
     * （本桶实测 chunk 18 → file 17，存在 chunk id 无对应 file 的空档；改写还会换 chunk id）。 */
    report = String(await updateTool.execute(
      { id: b.fileId, content: newContent, tags, folder: FOLDER, newTagReason: NEW_TAG_REASON },
      execStub(entry.cwd ?? entry.root),
    ))
  } catch (e) {
    report = `❌ 抛异常：${e?.message ?? e}`
  }
  const ms = Date.now() - t0
  const ok = !report.startsWith('❌')
  results.push({ d, tags, ok, ms, report: report.split('\n')[0].slice(0, 200) })
  line(`\nD${d} ${ok ? '✅' : '❌'} ${(ms / 1000).toFixed(1)}s`)
  line('  ' + report.split('\n').slice(0, 3).join('\n  '))
}

/* ────────────── 收尾自证（重新开库读，不用内存缓存） ────────────── */
hr('收尾读数')
const store2 = new KnowledgeStore(dbPath)
const files2 = store2.files(FOLDER)
const chunks2 = store2.chunks(FOLDER)
const byId2 = new Map(chunks2.map((c) => [c.id, c]))

/* ① 正文完整性：去掉 Tag 行后逐字节相同（按 **fileId** 找当前 chunk——改写换 chunk id） */
let bodyDrift = []
const chunkByFile2 = new Map(chunks2.map((c) => [c.file_id, c]))
for (const d of before.keys()) {
  const b = before.get(d)
  const c2 = chunkByFile2.get(b.fileId)
  if (!c2) { bodyDrift.push(`D${d}(file ${b.fileId}) 消失`); continue }
  if (bodyOf(String(c2.content)) !== b.body) bodyDrift.push(`D${d}`)
}

/* ② Tag 频次 + ③ 连通分量 */
const freq2 = store2.tagFrequency()
const total = files2.length
const maxTag = freq2[0]
const comp = connectedComponents(store2)

line(`篇数 = ${total}（改写前 ${chunks.length}）　chunk = ${chunks2.length}`)
line(`\nTag 频次（新词汇表，降序）：`)
for (const t of freq2) line(`  ${String(t.count).padStart(2)}  ${t.name}${t.count === 0 ? '  ⚠️ 孤儿（0 篇）' : ''}`)
line(`\n判据 ②（最大频次 < 1/3）：最大 = ${maxTag.count}/${total} = ${(maxTag.count / total).toFixed(3)} → ${maxTag.count / total < 1 / 3 ? '✅ PASS' : '❌ FAIL'}（「${maxTag.name}」）`)
line(`判据 ①（连通分量 = 1）：${comp.count}（规模 ${comp.sizes.join(',')}）→ ${comp.count === 1 ? '✅ PASS' : '❌ FAIL'}`)
line(`正文完整性（只改 Tag 行）：${bodyDrift.length === 0 ? '✅ 20/20 逐字节一致' : '❌ 漂移：' + bodyDrift.join(',')}`)
line(`写入结果：${results.filter((r) => r.ok).length}/${results.length} 成功`)

const readings = {
  at: new Date().toISOString(),
  folder: FOLDER,
  dshHome: process.env.DSH_HOME ?? null,
  dbPath,
  plan: PLAN,
  results,
  files: total,
  tagFrequency: freq2,
  maxFreqRatio: maxTag.count / total,
  components: comp,
  bodyDrift,
}
const outDir = join(ROOT, '.scratch', 'retag')
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, `readings-${Date.now()}.json`)
writeFileSync(outPath, JSON.stringify(readings, null, 2))
line(`\n读数落盘：${outPath}`)
