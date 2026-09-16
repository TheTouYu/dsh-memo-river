#!/usr/bin/env node
/**
 * 票 11（recall-quality-0916）：委托场景写入引导——acceptance-delegation-guidance
 *
 * 检查项（票面）：
 *   ① 委托变体 nudge 含冷门 Tag 建议（hub Tag 不入建议名单）+ 同轴合并提示，普通场景不变；
 *   ③ 模拟委托波次：连续同轴写入触发合并提示；Tag 建议避开枢纽；
 *   ④ 只读红线（兜底闸门的拦截行为由 hub-gate 8/8、title-gate 6/6、主套件去重项背书）。
 */
import { mkdtempSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDiaryBrief, scanTagAxis, coldTagSuggest, sameAxisHit } from '../lib/nudge-guide.js'
import { renderWriteNudge } from '../lib/render.js'

let pass = 0
let fail = 0
function check(id, name, ok, evidence = []) {
  if (ok) pass++
  else fail++
  console.log(`【${ok ? '✅ PASS' : '❌ FAIL'}】${id} ${name}`)
  for (const e of evidence) console.log(`    · ${e}`)
}

hr(`票 11 委托写入引导 · acceptance-delegation-guidance`)

/* ── G-1 parseDiaryBrief：标题 + 末个 Tag 行（多篇 Tag 行取最后） ── */
{
  const p = parseDiaryBrief('# 标题甲\n\n正文。\n\nTag: a, b\n\n又一段。\n\nTag: c，d、e', 'x.md')
  const t1 = p.title === '标题甲' && p.tags.join('/') === 'c/d/e'
  check('G-1', 'parseDiaryBrief：首 # 行做标题；多 Tag 行取最后；中英文逗号/顿号都切', t1, [
    `title=${p.title} tags=${p.tags.join('/')}`,
  ])
}

/* ── G-2 coldTagSuggest：枢纽（≥1/3）剔除 + 词汇表补齐（只补已存在、非枢纽） ── */
{
  const freq = new Map([
    ['枢纽甲', 4], ['冷门乙', 2], ['冷门丙', 1], ['孤本丁', 1],
  ])
  const scan = { files: 9, freq, recent: [] }
  const r1 = coldTagSuggest(['枢纽甲', '冷门乙'], scan)
  const t2 = !r1.tags.includes('枢纽甲') && r1.tags.includes('冷门乙') && r1.droppedHub.join() === '枢纽甲' &&
    r1.tags.length === 3 && r1.tags.includes('冷门丙') && r1.tags.includes('孤本丁') &&
    !r1.tags.includes('幽灵戊') /* 词汇表不存在 → 不补（会触发 newTagReason 闸门） */
  check('G-2', 'coldTagSuggest：hub≥1/3 剔除；不足从既有非枢纽补齐；不推荐词汇表外的', t2, [
    `tags=${r1.tags.join('/')} droppedHub=${r1.droppedHub.join('/')}`,
  ])
}

/* ── G-3 sameAxisHit：重叠 ≥2 命中取最大；空 suggested → null ── */
{
  const scan = {
    files: 5,
    freq: new Map(),
    recent: [
      { name: 'a.md', title: '轴一', tags: ['甲', '乙', '丙'], mtime: 3 },
      { name: 'b.md', title: '轴二', tags: ['乙', '丙', '丁'], mtime: 2 },
      { name: 'c.md', title: '无关节', tags: ['戊'], mtime: 1 },
    ],
  }
  const hit = sameAxisHit(scan, ['甲', '乙', '丁'])
  const hitUnique = sameAxisHit(scan, ['丙', '丁'])
  const miss = sameAxisHit(scan, ['戊', '己'])
  const empty = sameAxisHit(scan, [])
  const t3 = hit?.title === '轴一' && hit.overlap === 2 && hit.shared.join('/') === '甲/乙' && /* 平票取最新（recent 序） */
    hitUnique?.title === '轴二' && hitUnique.overlap === 2 && hitUnique.shared.join('/') === '丙/丁' &&
    miss === null && empty === null
  check('G-3', 'sameAxisHit：共享 ≥2 命中（最大者；平票取更新近条目）；不足 2 / 空 → null', t3, [
    `hit=${hit ? `${hit.title}(${hit.shared.join('/')})` : 'null'} hitUnique=${hitUnique ? `${hitUnique.title}(${hitUnique.shared.join('/')})` : 'null'} miss=${miss}`,
  ])
}

/* ── G-4 renderWriteNudge：委托+extras 生效；无 extras 逐字回落；普通场景 extras 无效 ── */
{
  const tags = ['枢纽甲', '冷门乙']
  const extras = { coldTags: ['冷门乙', '冷门丙'], sameAxis: { title: '轴一', overlap: 2, shared: ['冷门乙', '冷门丙'] } }
  const del = renderWriteNudge('已 7 分钟未写', 9, '进展', tags, null, true, null, 0, extras)
  const delNoExtras = renderWriteNudge('已 7 分钟未写', 9, '进展', tags, null, true, null, 0)
  const delNoExtrasRef = renderWriteNudge('已 7 分钟未写', 9, '进展', tags, null, true, null, 0, null)
  const normal = renderWriteNudge('已 7 分钟未写', 9, '进展', tags, null, false, null, 0, extras)
  const t4 =
    del.includes('同轴提示：近期已有《轴一》（Tag 重叠 2：冷门乙、冷门丙）') &&
    del.includes('优先 memo_update 并入前篇或 memo_merge 归一') &&
    del.includes('冷门乙、冷门丙') && !del.includes('枢纽甲') &&
    del.split('\n').length === 4 && /* 提醒+委托+同轴+时机 */
    delNoExtras === delNoExtrasRef && delNoExtras.split('\n').length === 3 && /* 缺省逐字回落（票05/12 零回归） */
    !normal.includes('同轴提示') && normal.includes('枢纽甲') /* 普通场景：extras 不生效，Tag 列表不变 */
  check('G-4', 'render：委托+extras=4 行（同轴提示+冷门 Tag）；缺省逐字回落；普通场景 extras 无效', t4, [
    `委托行数=${del.split('\n').length} 同轴行=${del.split('\n')[2]?.slice(0, 50) ?? '(无)'}…`,
    `缺省回落一致=${delNoExtras === delNoExtrasRef} 普通行数=${normal.split('\n').length}`,
  ])
}

/* ── G-5 模拟委托波次（票面③）：tmp 桶写 3 篇同轴 → 第 2/3 篇 nudge 触发合并提示；异轴不触发 ── */
{
  const dir = mkdtempSync(join(tmpdir(), 'mr-deleg-'))
  const write = (name, title, tagline) => writeFileSync(join(dir, name), `# ${title}\n\n正文。\n\nTag: ${tagline}\n`)
  write('01.md', '第一篇·轴甲', '嵌入时延, 上游对照, 门控校准')
  const s1 = scanTagAxis(dir)
  const suggested = ['嵌入时延', '上游对照', '回写策略']
  const r1 = coldTagSuggest(suggested, s1)
  const h1 = sameAxisHit(s1, suggested)
  write('02.md', '第二篇·轴甲', '嵌入时延, 上游对照, 回写策略')
  const s2 = scanTagAxis(dir)
  const h2 = sameAxisHit(s2, suggested)
  const other = sameAxisHit(s2, ['会话预设', '插件拆线'])
  const nudge3 = renderWriteNudge('已 30 步未写', 20, '第三篇进展', suggested, null, true, null, 0, {
    coldTags: r1.tags, sameAxis: h2,
  })
  const t5 = h1 !== null && h1.overlap === 2 && h2 !== null && h2.overlap === 3 && other === null &&
    nudge3.includes('同轴提示') && nudge3.includes('memo_merge 归一') &&
    r1.tags.includes('门控校准') /* 建议从既有词汇补齐而非只回显 suggested */
  check('G-5', '委托波次：第 2 篇起同轴命中（重叠 2→3）；异轴不触发；nudge 带合并提示+补齐 Tag', t5, [
    `第2篇命中=${h1 ? `${h1.title}(${h1.overlap})` : 'null'} 第3篇命中=${h2 ? `${h2.title}(${h2.overlap})` : 'null'} 异轴=${other}`,
    `建议 Tag=${r1.tags.join('/')}`,
  ])
  /* G-6 只读红线：扫描前后目录零变化（文件数/mtime 不变） */
  const before = readdirSync(dir).map((n) => `${n}:${statSync(join(dir, n)).mtimeMs}`)
  scanTagAxis(dir)
  coldTagSuggest(suggested, scanTagAxis(dir))
  const after = readdirSync(dir).map((n) => `${n}:${statSync(join(dir, n)).mtimeMs}`)
  const t6 = before.length === after.length && before.join('|') === after.join('|')
  check('G-6', '只读红线：scan/coldTagSuggest 不改目录（文件数与 mtime 逐项不变）', t6, [
    `files=${after.length}`,
  ])
  rmSync(dir, { recursive: true, force: true })
}

hr(`结果：${pass}/${pass + fail} PASS`)
process.exit(fail === 0 ? 0 : 1)

function hr(title) {
  console.log('═'.repeat(96))
  console.log(title)
  console.log('═'.repeat(96))
}
