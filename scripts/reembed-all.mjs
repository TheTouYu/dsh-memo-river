#!/usr/bin/env node
/**
 * reembed-all.mjs —— 换嵌入模型时的全库重嵌【盘点器】（阶段 1：只读 dry-run）。
 *
 * 背景：换嵌入模型 = 换向量空间，全库已有向量全部作废，必须重嵌。本脚本只做
 * **规模、代价、风险盘点**，不写任何东西；真正的重嵌（阶段 2）等目标端点可用后，
 * 先拿**单个桶**试点验证，再全量——见文件末尾 PLAN 段。
 *
 * 用法：
 *   node scripts/reembed-all.mjs                      # 默认 dry-run（读 $DSH_HOME/memo-river/*）
 *   node scripts/reembed-all.mjs --ratio 0.65         # 指定 token/字符比（缺省 0.65）
 *   node scripts/reembed-all.mjs --price 0.5          # 指定单价（元/百万 token，缺省智谱 0.5）
 *   node scripts/reembed-all.mjs --top 20             # 只列最大的 N 个桶
 *
 * 判据（退出码）：0 = 盘点完成（有无需重嵌的桶都算完成）；1 = 状态根不存在。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const argv = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt
}
const RATIO = Number(argOf('--ratio', '0.65')) // token / 字符（中文语料实测 0.58-0.74）
const PRICE = Number(argOf('--price', '0.5')) // 元 / 百万 token
const TOP = Number(argOf('--top', '12'))

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const root = join(dshHome, 'memo-river')
if (!existsSync(root)) {
  console.error(`❌ 状态根不存在：${root}（可用 DSH_HOME 覆盖）`)
  process.exit(1)
}

/** 递归收集 dailynote 下的 .md（一篇 = 一个 chunk，携整篇向量；见 src/store.ts:302）。 */
function collectDiaries(dir) {
  const out = []
  const walk = (d) => {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && e.name.endsWith('.md')) out.push(p)
    }
  }
  walk(dir)
  return out
}

const rows = []
for (const name of readdirSync(root)) {
  const bucketRoot = join(root, name)
  let st
  try {
    st = statSync(bucketRoot)
  } catch {
    continue
  }
  if (!st.isDirectory()) continue
  const hasDb = existsSync(join(bucketRoot, 'knowledge_base.sqlite'))
  const diaryDir = join(bucketRoot, 'dailynote')
  const files = existsSync(diaryDir) ? collectDiaries(diaryDir) : []
  let bytes = 0
  for (const f of files) {
    try {
      bytes += statSync(f).size
    } catch {
      /* 跳过读不到的文件 */
    }
  }
  const empty = !hasDb && files.length === 0
  rows.push({ name, hasDb, diaries: files.length, bytes, empty })
}

const live = rows.filter((r) => !r.empty).sort((a, b) => b.bytes - a.bytes)
const totalDiaries = live.reduce((s, r) => s + r.diaries, 0)
const totalBytes = live.reduce((s, r) => s + r.bytes, 0)
// 一次重嵌 = 每篇日记一次整篇嵌入（+ 该篇 Tag 名，几十字节，忽略）≈ 正文字节数
const estTokens = (totalBytes * RATIO) / 1e6
const estCost = estTokens * PRICE

console.log(`状态根：${root}`)
console.log(`桶目录 ${rows.length} 个；其中有内容的 ${live.length} 个，空壳 ${rows.length - live.length} 个\n`)
console.log(`  ${'桶(状态目录)'.padEnd(20)} ${'库'.padEnd(4)} ${'日记'.padStart(6)} ${'字节'.padStart(12)}`)
for (const r of live.slice(0, TOP)) {
  console.log(`  ${r.name.padEnd(20)} ${(r.hasDb ? '✓' : '✗').padEnd(4)} ${String(r.diaries).padStart(6)} ${String(r.bytes).padStart(12)}`)
}
if (live.length > TOP) console.log(`  … 其余 ${live.length - TOP} 个桶省略（--top 调整）`)

const nullish = live.filter((r) => !r.hasDb)
console.log(`\n合计：${totalDiaries} 篇日记 / ${(totalBytes / 1024 / 1024).toFixed(2)} MB 正文`)
console.log(`预估重嵌：${(totalBytes * RATIO / 1e6).toFixed(2)}M token（按 ${RATIO} token/字符）`)
console.log(`一次性成本：约 ${estCost.toFixed(2)} 元（按 ${PRICE} 元/百万 token）`)
console.log(`预估耗时：单篇一次嵌入请求，按当前端点 1.5-3s/请求串行 ≈ ${Math.ceil((totalDiaries * 2.2) / 60)} 分钟（合批/并发可显著缩短）`)
if (nullish.length) console.log(`⚠️ ${nullish.length} 个桶有日记但没有 knowledge_base.sqlite（疑似孤儿/未入库），建议先跑 scripts/reimport-orphans.mjs 核对`)

console.log(`
── PLAN：阶段 2（全库重嵌）在目标端点可用后执行，三步都留证 ──
1. 单桶试点：改配置 → 对**一个**桶重嵌 → 抽查 3 篇的向量维度与 KNN 自查询命中 → 才允许全量
2. 全量重嵌 + artifact 重建（每桶重嵌后引擎自动重建索引；artifactSig 会变，属预期）
3. 重启 dsh-web（**必须先与用户确认时机**——重启会斩断飞行中的工具调用与子会话）→ 跑
   \`node scripts/acceptance-queryfield.mjs\` 6/6 与 \`node scripts/acceptance.mjs\` 对比换模型前后

⚠️ 关键坑（已核代码）：\`src/embed.ts:278\` 的缓存命中判据带维度校验
   \`if (hit && hit.length === this.options.dimension)\` —— 换模型必然换维度，旧 emb-cache 自动全 miss，
   不会把旧模型的向量当新向量用。但缓存文件里会留下大量孤儿条目，重嵌完跑
   \`node scripts/compact-emb-cache.mjs\` 清淤。
`)
