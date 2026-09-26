#!/usr/bin/env node
/**
 * acceptance-corpus.mjs —— 票 06（corpus-governance-0926）语料治理**五判据**常驻验收。
 *
 * 由头：本轮四条治理判据此前只活在 `scripts/retag-content-tags.mjs` 的收尾自证里
 * （一次性、只对刚改的桶、不能对任意桶复跑）。本套件把它们抽成**可对任意桶例行复跑**的
 * 只读验收，让「语料退化」在例行体检里被检出，而不是等锚全零之后回头考古。
 *
 * 五条腿（全部只读；负样本自测见 --help 末段，样本造在工作区内副本，绝不碰生产桶）：
 *   ① 连通分量 = 1        —— 直调 `lib/health.js` 的 `connectedComponents(store)`（孤岛 ⇒ 多跳通路不存在）
 *   ② 最大 Tag 频次 < 1/3 —— `store.tagFrequency()` top1；**与写侧闸门同口径**：
 *                            判定用 `nudge-guide.ts` 的 `coldTagSuggest`（`f ≥ 3 且 f ≥ files/3` 才算枢纽，
 *                            绝对下限防「1-2 篇的年轻桶里 freq=1 占 100%」被误判成污染——D82/票 11 教训）。
 *                            比值与下限两个读数都打印，口径不一致时说明原因。
 *   ③ 孤儿 Tag = 0        —— `tags` 表里没有任何 `file_tags` 行的行数（判据①失败的最常见前因：
 *                            换词漏留旧词 ⇒ 孤儿自带一个分量）。直接走 `store.db` 的 SQL 查询。
 *   ④ 正文完整性          —— `--baseline <备份桶目录>` 时，两侧**按 `file.path` 对齐**
 *                            （**不用 chunk id**：改写会换 chunk id，file.path 才是稳定键），
 *                            各自去掉 `Tag[：:]…` 行后逐字节比对，不一致逐篇列出（含首个差异偏移与片段）。
 *                            基线只剩的篇目单列为「篇目缺失」告警（合并/归档会合法触发，不判 FAIL）。
 *   ⑤ 闸门口径一致        —— `store.tagFrequency()` 的 top1 与 `memo_stats` 报告的「枢纽 Tag 告警」
 *                            必须点名同一词、同一组数字（防两处判据漂移）。`memo_stats` 侧走
 *                            **同源函数** `healthReport(store, bucket)` + `formatHealth(report)`
 *                            （`src/tools.ts` 的 memo_stats 就是这两行 + 原生资产行），因此不启动插件、
 *                            不建桶、不写 manifest —— 生产桶零写入。
 *
 * 环境事实（勿重新发现）：桶根由 `DSH_HOME` 决定（`memoRiverRoot() = ${DSH_HOME:-~/.dsh}/memo-river`），
 * **不由 cwd 决定**；本机存在**同名同哈希**的桶（生产根 `/home/h/.dsh` vs 沙箱根
 * `.compat/rehearsal/browser`），故本套件**必须**打印 `resolveBucket()` 解析出的 root 供人核对，
 * 并支持 `--bucket <名字>` / `--hash <16hex>` 消歧。打开目标桶用
 * `resolveBucket()` + `acquireBucketRuntime()`，**不把 `config.bucket` 设成目标桶名**、不 `apply()`
 * （插件启动会按 cwd 建「本工作区桶」，传目标名会把本工作区桶改名 ⇒ 凭空长出同名第二桶，
 * 实测会让真路由报「桶名不唯一」；`scripts/retag-content-tags.mjs` 已踩过这两个坑）。
 *
 * 用法：
 *   node scripts/acceptance-corpus.mjs --help
 *   node scripts/acceptance-corpus.mjs --bucket deepseek-harness
 *   node scripts/acceptance-corpus.mjs --hash 50d29236c1297d2c
 *   DSH_HOME=/home/h/.dsh node scripts/acceptance-corpus.mjs --bucket dsh-memo-river
 *   DSH_HOME=/home/h/.dsh node scripts/acceptance-corpus.mjs --bucket deepseek-harness \
 *     --baseline .scratch/backup-20260926-071328/50d29236c1297d2c
 *
 * 退出码：0 = 无 FAIL（允许 ④ SKIP）；1 = 有腿 FAIL；2 = 用法/路由/基线错误。
 */
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { Config as ConfigSchema } from '../lib/index.js'
import { acquireBucketRuntime, releaseAllWorkspaces, resolveBucket } from '../lib/workspace.js'
import { HUB_RATIO_LIMIT, connectedComponents, formatHealth, healthReport } from '../lib/health.js'
import { coldTagSuggest } from '../lib/nudge-guide.js'
import { memoRiverRoot } from '../lib/runtime.js'
import { KnowledgeStore } from '../lib/store.js'

const VCP = '/home/h/app/VCPToolBox'
/** Tag 行（`Tag: a, b` / `Tag：a、b`）；两侧都按同一规则剔除后再逐字节比对。 */
const TAG_LINE_RE = /^[ \t]*Tag[：:][^\n]*$/gm

const line = (s = '') => console.log(s)
const hr = (t) => line('\n' + '═'.repeat(96) + (t ? `\n${t}` : '') + '\n' + '═'.repeat(96))

const USAGE = `用法：
  node scripts/acceptance-corpus.mjs [--bucket <名字>|--hash <16hex>] [--baseline <备份桶目录>] [--readings <json>]

选项：
  --bucket <名字>   桶名（workspace.json 的 bucket 字段）。缺省 = basename(cwd)（本工作区桶口径）。
  --hash <16hex>    16 位工作区哈希（状态目录名）——同名桶消歧用；给出时优先于 --bucket。
  --baseline <目录> 腿④ 的基线：桶目录（内含 knowledge_base.sqlite），或唯一含库的子目录父目录。
                    两侧按 file.path 对齐，各自去掉 Tag 行后逐字节比对。不给则腿④ SKIP。
  --readings <json> 把五腿读数落盘成 JSON（便于票面回填 / 前后对照）。
  -h, --help        本说明。

五条腿（全部只读）：
  ① 连通分量 = 1        connectedComponents(store)
  ② 最大 Tag 频次 < 1/3 store.tagFrequency() top1；与写侧闸门同口径（f≥3 且 f≥files/3 才算枢纽）
  ③ 孤儿 Tag = 0        tags 表里没有任何 file_tags 行的行数（SELECT … NOT EXISTS …）
  ④ 正文完整性          --baseline 时按 file.path 对齐、剔 Tag 行后逐字节比对，漂移逐篇列出
  ⑤ 闸门口径一致        tagFrequency() top1 与 memo_stats 同源函数（healthReport/formatHealth）
                        的「枢纽 Tag 告警」必须点名同一词、同一组数字

桶根由 DSH_HOME 决定（memoRiverRoot() = \${DSH_HOME:-~/.dsh}/memo-river），不由 cwd 决定。
本机存在同名同哈希的桶（生产根 /home/h/.dsh vs 沙箱根 .compat/rehearsal/browser）——运行前
先核对本套件打印的 root。开桶走 resolveBucket + acquireBucketRuntime（不 apply、不改 manifest），
生产桶零写入。

例：
  # 沙箱根（当前 DSH_HOME）
  node scripts/acceptance-corpus.mjs --bucket deepseek-harness
  # 生产根（只读；/home/h/.dsh 在工作区外，读没问题）
  DSH_HOME=/home/h/.dsh node scripts/acceptance-corpus.mjs --bucket deepseek-harness \\
    --baseline .scratch/backup-20260926-071328/50d29236c1297d2c
  DSH_HOME=/home/h/.dsh node scripts/acceptance-corpus.mjs --bucket dsh-memo-river
  # 同名消歧
  node scripts/acceptance-corpus.mjs --hash 50d29236c1297d2c

负样本自测（在**副本**里造脏数据；生产桶一字不碰）：
  NEG=.scratch/corpus-governance-0926/neg
  mkdir -p "$NEG/dsh-home/memo-river"
  cp -a /home/h/.dsh/memo-river/50d29236c1297d2c "$NEG/dsh-home/memo-river/"
  DB="$NEG/dsh-home/memo-river/50d29236c1297d2c/knowledge_base.sqlite"
  # ① 手插一条孤儿 Tag（无 file_tags 行）⇒ 腿③ 必红并点名
  sqlite3 "$DB" "INSERT INTO tags(name,vector) VALUES('测试孤儿词', zeroblob(12288));"
  DSH_HOME=$PWD/$NEG/dsh-home node scripts/acceptance-corpus.mjs --bucket deepseek-harness
  # ② 把桶内某 Tag 灌到 ≥1/3 篇（f≥3 且 f≥files/3）⇒ 腿② 必红并点名。
  #    例：22 篇时 1/3 = 7.33，top1 已 7 篇 ⇒ 多挂 1 篇即 8/22 = 0.364 过线：
  sqlite3 "$DB" "INSERT INTO file_tags(file_id, tag_id, position)
    SELECT (SELECT f.id FROM files f WHERE f.id NOT IN
              (SELECT ft.file_id FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE t.name = '上游同步')
            ORDER BY f.id LIMIT 1),
           (SELECT id FROM tags WHERE name = '上游同步'), 99;"
  # ③ 改一篇正文 ⇒ 腿④（配 --baseline 快照）必红并逐篇点名。
  #  造完样本务必核对本套件打印的 root 是合成根（$NEG/dsh-home），不是 /home/h/.dsh。

退出码：0 = 无 FAIL（腿④ 未给 --baseline 时 SKIP，不算通过也不算失败）；1 = 有腿 FAIL；2 = 用法/路由错误。`

/* ────────────── 参数 ────────────── */
const argv = process.argv.slice(2)
const opts = { bucket: null, hash: null, baseline: null, readings: null }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--help' || a === '-h') { line(USAGE); process.exit(0) }
  const key = { '--bucket': 'bucket', '--hash': 'hash', '--baseline': 'baseline', '--readings': 'readings' }[a]
  if (!key) { console.error(`❌ 未知参数「${a}」\n\n${USAGE}`); process.exit(2) }
  const v = argv[i + 1]
  if (!v || v.startsWith('--')) { console.error(`❌ ${a} 缺值\n\n${USAGE}`); process.exit(2) }
  opts[key] = v
  i++
}
if (opts.hash && !/^[0-9a-f]{16}$/.test(opts.hash)) {
  console.error(`❌ --hash 须为 16 位小写十六进制（状态目录名），收到「${opts.hash}」`)
  process.exit(2)
}

/* ────────────── 桶解析（root 必须打印，供人核对 DSH_HOME 是否指对了） ────────────── */
const REQUEST = opts.hash ?? opts.bucket ?? basename(process.cwd())
const resolved = resolveBucket(REQUEST)
if (!resolved.ok) {
  console.error(`${resolved.error}\n\n（本套件与 memo_recall 同一套解析：先按 16 位哈希，再按桶名；桶根 = DSH_HOME 决定的 ${memoRiverRoot()}。）`)
  process.exit(2)
}
const entry = resolved.entry
const byHash = Boolean(opts.hash)

hr('语料治理五判据 · acceptance-corpus')
line(`桶解析：${byHash ? `--hash ${REQUEST}` : `--bucket ${REQUEST}`} → ${entry.bucket}@${entry.hash}`)
line(`  root        = ${entry.root}`)
line(`  db          = ${join(entry.root, 'knowledge_base.sqlite')}`)
line(`  cwd(manifest) = ${entry.cwd ?? '-'}`)
line(`  DSH_HOME    = ${process.env.DSH_HOME ?? '(未设 → 缺省 ~/.dsh)'}`)
line(`  memoRiverRoot() = ${memoRiverRoot()}`)
line(`  ⚠️ 同名同哈希的桶可能存在于另一个根（生产 /home/h/.dsh vs 沙箱 .compat/rehearsal/browser）——先核对上面的 root 再读数字。`)

const config = ConfigSchema({ native: { vcpRoot: VCP } })
const ws = acquireBucketRuntime(entry, config)
const store = ws.store
const bucketName = entry.bucket

const results = []
function check(id, title, verdict, evidence) {
  results.push({ id, title, verdict })
  const mark = verdict === 'pass' ? '✅ PASS' : verdict === 'fail' ? '❌ FAIL' : '⏭️ SKIP'
  line(`\n【验收 ${id}】${title}  →  ${mark}`)
  for (const e of [].concat(evidence ?? [])) line(`    ${e}`)
}

const files = store.files()
const total = files.length
const freq = store.tagFrequency()
const top = freq[0] ?? null

hr('读数')
line(`规模：${total} 篇 / ${freq.length} Tag（本桶 ${bucketName}）`)

/* ────────────── ① 连通分量 ────────────── */
const comp = connectedComponents(store)
check(
  '①',
  '连通分量 = 1（孤岛语料下多跳通路不存在）',
  total === 0 ? 'fail' : comp.count === 1 ? 'pass' : 'fail',
  total === 0
    ? [`空库：${total} 篇——判据无从判定（不显示假通过；先入语料）`]
    : [`connectedComponents(store) = ${comp.count}（分量规模 ${comp.sizes.join(',') || '-'}）　判据 = 1 → ${comp.count === 1 ? '✅ PASS' : '❌ FAIL 多分量=孤岛'}`],
)

/* ────────────── ② 最大 Tag 频次（与写侧闸门同口径） ────────────── */
const scan = { files: total, freq: new Map(freq.map((t) => [t.name, t.count])), recent: [] }
/** 写侧口径 = `src/nudge-guide.ts` coldTagSuggest 内的 isHub：f≥3 且 f≥files/3（绝对下限防年轻桶误判）。
 *  直接调生产函数而不是复述公式——公式漂移时本腿会跟着漂，正是要避免的。 */
const gateVerdict = top ? coldTagSuggest([top.name], scan, 1) : { tags: [], droppedHub: [] }
const hubByGate = top ? gateVerdict.droppedHub.includes(top.name) : false
const ratio = top && total > 0 ? top.count / total : 0
const hubByRatio = ratio >= HUB_RATIO_LIMIT
const floorOk = Boolean(top) && top.count >= 3
const leg2Pass = Boolean(top) && total > 0 && !hubByGate
check(
  '②',
  '最大 Tag 频次 < 1/3（写侧同口径：f≥3 且 f≥files/3 才算枢纽）',
  leg2Pass ? 'pass' : 'fail',
  top
    ? [
        `tagFrequency() top1 =「${top.name}」× ${top.count}/${total} = ${ratio.toFixed(3)}（判据 < ${HUB_RATIO_LIMIT.toFixed(4)}）`,
        `写侧同口径 coldTagSuggest(isHub)：${hubByGate ? '枢纽（f≥3 ✅ 且 f≥files/3 ' + (top.count >= total / 3 ? '✅' : '❌') + '）' : '非枢纽（f≥3 ' + (floorOk ? '✅' : '❌') + ' 且 f≥files/3 ' + (top.count >= total / 3 ? '✅' : '❌') + '）'}` +
          (hubByRatio && !hubByGate ? '　← 年轻桶：比值过线但绝对下限不满足，按 D82/票 11 不判枢纽' : ''),
        `判定：${leg2Pass ? `✅ PASS（「${top.name}」未过线）` : `❌ FAIL 枢纽 Tag「${top.name}」已到 ${top.count}/${total} = ${ratio.toFixed(3)}（≥1/3）：直接锚会被泛化`}`,
      ]
    : ['空库：无 Tag，判据无从判定 → ❌ FAIL（不显示假通过）'],
)

/* ────────────── ③ 孤儿 Tag（tags 表里没有任何 file_tags 行） ────────────── */
const orphans = store.db
  .prepare(
    `SELECT t.id AS id, t.name AS name FROM tags t
     WHERE NOT EXISTS (SELECT 1 FROM file_tags ft WHERE ft.tag_id = t.id) ORDER BY t.id`,
  )
  .all()
  .map((r) => ({ id: Number(r.id), name: String(r.name) }))
check(
  '③',
  '孤儿 Tag = 0（换词漏留旧词 ⇒ 孤儿自带一个连通分量）',
  orphans.length === 0 ? 'pass' : 'fail',
  [
    `SQL：SELECT … FROM tags t WHERE NOT EXISTS (SELECT 1 FROM file_tags ft WHERE ft.tag_id = t.id)`,
    `孤儿 = ${orphans.length} 个${orphans.length ? '：' + orphans.slice(0, 20).map((o) => `#${o.id}「${o.name}」`).join(' ') + (orphans.length > 20 ? ` …还有 ${orphans.length - 20} 个` : '') : ''}`,
    `判定：${orphans.length === 0 ? '✅ PASS' : `❌ FAIL 点名：${orphans.map((o) => `「${o.name}」`).join('、')}`}`,
  ],
)

/* ────────────── ④ 正文完整性（--baseline；按 file.path 对齐） ────────────── */
/** 一侧的 file.path → 正文（去掉 Tag 行 + 尾部空白）。多 chunk 篇按 chunk_index 拼接（两侧同规则）。 */
function bodiesByPath(s) {
  const perFile = new Map()
  for (const c of s.chunks()) {
    const list = perFile.get(c.file_id) ?? []
    list.push(c)
    perFile.set(c.file_id, list)
  }
  const out = new Map()
  for (const f of s.files()) {
    const list = (perFile.get(f.id) ?? []).slice().sort((a, b) => a.chunk_index - b.chunk_index)
    const body = list.map((c) => String(c.content ?? '')).join('\n').replace(TAG_LINE_RE, '').replace(/\s+$/, '')
    out.set(f.path, body)
  }
  return out
}
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  const clip = (s) => JSON.stringify(s.slice(Math.max(0, i - 20), i + 44))
  return `@${i}：基线 ${clip(b)}\n        现桶 ${clip(a)}`
}
/** 基线目录定位：直接含库，或唯一含库的子目录（如 backup-…/<16hex>/）。 */
function locateBaselineDb(dir) {
  if (existsSync(join(dir, 'knowledge_base.sqlite'))) return join(dir, 'knowledge_base.sqlite')
  let subs = []
  try {
    subs = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(dir, d.name))
      .filter((d) => existsSync(join(d, 'knowledge_base.sqlite')))
  } catch {
    return null
  }
  return subs.length === 1 ? join(subs[0], 'knowledge_base.sqlite') : null
}
const leg4 = { skipped: false, same: 0, drift: [], missing: [], added: [], files: 0 }
if (!opts.baseline) {
  leg4.skipped = true
  check('④', '正文完整性（按 file.path 对齐，剔 Tag 行后逐字节比对）', 'skip', [
    '未给 --baseline：本腿 SKIP（不算通过；要真判请给备份桶目录）',
    '用法：--baseline .scratch/backup-20260926-071328/50d29236c1297d2c',
  ])
} else {
  const blDir = resolve(opts.baseline)
  const blDb = existsSync(blDir) ? locateBaselineDb(blDir) : null
  if (!blDb) {
    console.error(`\n❌ --baseline「${opts.baseline}」里找不到 knowledge_base.sqlite（也不含唯一含库子目录）。\n   本腿按**两侧库内 file.path** 对齐，基线须是桶目录的拷贝（cp -a 整桶）。`)
    process.exit(2)
  }
  const base = new KnowledgeStore(blDb)
  try {
    const baseBodies = bodiesByPath(base)
    const liveBodies = bodiesByPath(store)
    leg4.files = baseBodies.size
    for (const [p, body] of liveBodies) {
      if (!baseBodies.has(p)) { leg4.added.push(p); continue }
      if (baseBodies.get(p) === body) leg4.same++
      else leg4.drift.push({ path: p, diff: firstDiff(body, baseBodies.get(p)) })
    }
    for (const p of baseBodies.keys()) if (!liveBodies.has(p)) leg4.missing.push(p)
    const driftLines = leg4.drift.slice(0, 20).map((d) => `✗ ${d.path}\n        ${d.diff}`)
    check(
      '④',
      '正文完整性（按 file.path 对齐，剔 Tag 行后逐字节比对）',
      leg4.drift.length === 0 ? 'pass' : 'fail',
      [
        `基线：${blDb}`,
        `对齐键 = file.path（不用 chunk id：改写会换 chunk id）　基线 ${baseBodies.size} 篇 / 现桶 ${liveBodies.size} 篇`,
        `逐字节一致 ${leg4.same}/${Math.min(baseBodies.size, liveBodies.size)}　漂移 ${leg4.drift.length}　基线有/现桶无 ${leg4.missing.length}　现桶新增 ${leg4.added.length}`,
        ...driftLines,
        ...(leg4.drift.length > 20 ? [`…还有 ${leg4.drift.length - 20} 篇漂移`] : []),
        ...(leg4.missing.length
          ? [`⚠️ 篇目缺失（基线有、现桶无；合并/归档会合法触发，**不计入本腿 FAIL**，但正文护城河一旦缺篇就无法复现）：${leg4.missing.slice(0, 10).map((p) => p.split('/').pop()).join('、')}${leg4.missing.length > 10 ? ` …+${leg4.missing.length - 10}` : ''}`]
          : []),
        `判定：${leg4.drift.length === 0 ? `✅ PASS（${leg4.same} 篇剔 Tag 行后逐字节一致${leg4.missing.length ? `；另有 ${leg4.missing.length} 篇缺失仅告警` : ''}）` : `❌ FAIL 正文漂移 ${leg4.drift.length} 篇（见上）`}`,
      ],
    )
  } finally {
    base.close()
  }
}

/* ────────────── ⑤ 闸门口径一致（memo_stats 同源函数 vs tagFrequency top1） ────────────── */
const report = healthReport(store, bucketName)
const reportText = formatHealth(report)
const hubWarn = report.warnings.find((w) => w.startsWith('枢纽 Tag')) ?? null
const warnName = hubWarn ? /枢纽 Tag「([^」]+)」/.exec(hubWarn)?.[1] ?? null : null
const warnCounts = hubWarn ? /出现 (\d+)\/(\d+) 篇/.exec(hubWarn) : null
const line2 = /最大 Tag 频次「([^」]+)」= (\d+)\/(\d+)/.exec(reportText)
const sameWord =
  Boolean(top) &&
  warnName !== null &&
  warnName === top.name &&
  warnCounts !== null &&
  Number(warnCounts[1]) === top.count &&
  Number(warnCounts[2]) === total
const sameStructured = Boolean(top) && report.hub?.name === top.name && report.hub?.count === top.count
const alarmDrift = hubByGate && hubWarn === null // 真枢纽却不告警 = 危险的漏报方向
const leg5Pass = Boolean(top) && total > 0 && (hubWarn ? sameWord && sameStructured : sameStructured && Boolean(line2)) && !alarmDrift
check(
  '⑤',
  '闸门口径一致：tagFrequency() top1 与 memo_stats「枢纽 Tag 告警」点名同一词',
  leg5Pass ? 'pass' : 'fail',
  [
    `本套件 tagFrequency() top1 =「${top ? top.name : '-'}」× ${top ? top.count : 0}/${total}`,
    `memo_stats 同源（healthReport + formatHealth，src/tools.ts 的 memo_stats 即此二函数）：枢纽告警 = ${hubWarn ? `「${warnName}」出现 ${warnCounts?.[1]}/${warnCounts?.[2]} 篇（≥1/3）` : '无（未过线）'}`,
    `结构化字段 report.hub = ${report.hub ? `「${report.hub.name}」×${report.hub.count}/${total} ratio=${report.hub.ratio.toFixed(3)}` : 'null'}` +
      `　formatHealth ② 行 = 「${line2?.[1] ?? '-'}」×${line2?.[2] ?? '-'}/${line2?.[3] ?? '-'}`,
    `criterion 对照：本套件/写侧阈（coldTagSuggest isHub）= ${hubByGate ? '枢纽' : '非枢纽'}；memo_stats 告警存在 = ${hubWarn ? '是' : '否'}` +
      (alarmDrift
        ? '　← ❌ 真枢纽但告警缺失（漏报方向的口径漂移）'
        : hubByRatio && !hubByGate && hubWarn
          ? '　← ⚠️ 年轻桶：memo_stats 按纯比值告警、写侧按绝对下限不判枢纽（误报方向；非语料退化，不判 FAIL）'
          : '　← 两处一致'),
    `判定：${leg5Pass ? `✅ PASS（同一词「${top ? top.name : '-'}」，计数 ${top ? top.count : 0}/${total} 一致）` : `❌ FAIL 口径漂移（top1=「${top ? top.name : '-'}」，告警点名=「${warnName ?? '-'}」）`}`,
    '（memo_stats 文本对照，同源函数原样输出）',
    ...reportText.split('\n').map((l) => '  ' + l),
  ],
)

/* ────────────── 汇总 ────────────── */
hr('结果')
const bad = results.filter((r) => r.verdict === 'fail')
const skipped = results.filter((r) => r.verdict === 'skip')
line(`桶 = ${bucketName}@${entry.hash}（root ${entry.root}）`)
line(`篇数 = ${total}　Tag = ${freq.length}　最大频次 = ${top ? `「${top.name}」×${top.count}` : 'n/a'}（${ratio.toFixed(3)}）　孤儿 = ${orphans.length}　连通分量 = ${comp.count}${leg4.skipped ? '' : `　正文一致 ${leg4.same}/${leg4.files}`}`)
line(
  `${results.length - bad.length - skipped.length}/${results.length - skipped.length} PASS` +
    (bad.length ? `；FAIL：${bad.map((f) => f.id).join(', ')}` : '') +
    (skipped.length ? `；SKIP：${skipped.map((s) => s.id).join(', ')}（未给 --baseline）` : ''),
)

if (opts.readings) {
  const out = resolve(opts.readings)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(
    out,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        dshHome: process.env.DSH_HOME ?? null,
        memoRiverRoot: memoRiverRoot(),
        bucket: bucketName,
        hash: entry.hash,
        root: entry.root,
        dbPath: join(entry.root, 'knowledge_base.sqlite'),
        files: total,
        tags: freq.length,
        tagFrequency: freq,
        legs: {
          components: comp,
          maxFreq: top ? { name: top.name, count: top.count, ratio, hubByGate, hubByRatio, limit: HUB_RATIO_LIMIT } : null,
          orphans,
          bodyIntegrity: leg4.skipped ? { skipped: true } : { baseline: resolve(opts.baseline), ...leg4, drift: leg4.drift.map((d) => d.path), missing: leg4.missing, added: leg4.added },
          gateConsistency: { top1: top?.name ?? null, alarm: warnName, alarmCounts: warnCounts ? [Number(warnCounts[1]), Number(warnCounts[2])] : null, hubByGate, hubByRatio, hubWarn },
        },
        results,
      },
      null,
      2,
    ),
  )
  line(`读数落盘：${out}`)
}

try { releaseAllWorkspaces() } catch { /* 已关 */ }
process.exit(bad.length ? 1 : 0)
