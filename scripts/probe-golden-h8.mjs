#!/usr/bin/env node
/**
 * probe-golden-h8.mjs — H8 三态金标抽料器（只读，不写库）。
 * 把对表里每对的 old/new 正文头部（600 字，同 L2 BODY_CHARS 口径）dump 成 corpus.md，
 * 供人工标注三态（SUPERSEDED / COMPATIBLE / NEEDS-CONFIRMATION）+ 理由一行。
 *
 * 对表三层（SPEC §7.5.4）：
 *   pos  = 正例层（账本 2 对 + H3 六对断言冲突，去重后 7 对）
 *   neg  = 负例层（patrol 同轴流水账簇的相邻对——勘察→落地→收官型，同主题非取代）
 *   mix  = 易混层（双源互补 / 版本快照 / 部分取代型）
 * 层只是抽取来源标签；真实三态标注以读文为准（如 neg 层若读出断言反转照样标 SUPERSEDED）。
 */
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const DB = join(process.env.HOME, '.dsh/memo-river/b94d8836d6175817/knowledge_base.sqlite')
const OUT = join(import.meta.dirname, '..', '.scratch', 'golden-h8')
mkdirSync(OUT, { recursive: true })

const PAIRS = [
  /* ── 正例层：账本（248→262、309→310）+ H3 六对（P1-P6），去重 ── */
  { id: 'G01', layer: 'pos', old: 214, new: 230, src: 'H3-P1' },
  { id: 'G02', layer: 'pos', old: 248, new: 262, src: '账本+H3-P2' },
  { id: 'G03', layer: 'pos', old: 173, new: 175, src: 'H3-P3' },
  { id: 'G04', layer: 'mix', old: 187, new: 194, src: 'H3-P4·两真一半' },
  { id: 'G05', layer: 'pos', old: 274, new: 282, src: 'H3-P5' },
  { id: 'G06', layer: 'pos', old: 265, new: 272, src: 'H3-P6' },
  { id: 'G07', layer: 'pos', old: 309, new: 310, src: '账本' },
  /* ── 易混层：版本快照 / 双源互补 / 部分修正 ── */
  { id: 'G08', layer: 'mix', old: 226, new: 230, src: '簇0.808·裁决vs重测' },
  { id: 'G09', layer: 'mix', old: 245, new: 246, src: '簇0.844·调研中期vs完结' },
  { id: 'G10', layer: 'mix', old: 269, new: 271, src: '簇0.852·调查中期vs硬数字' },
  { id: 'G11', layer: 'mix', old: 242, new: 243, src: '簇0.810·两轮调查' },
  { id: 'G12', layer: 'mix', old: 180, new: 182, src: '簇0.815·RouteA弹药vs上半场' },
  { id: 'G13', layer: 'mix', old: 294, new: 295, src: '簇0.809·两波复盘' },
  { id: 'G14', layer: 'mix', old: 5, new: 6, src: '簇0.810·同日两篇' },
  { id: 'G15', layer: 'mix', old: 26, new: 31, src: '簇0.826·票06vs票08' },
  { id: 'G16', layer: 'mix', old: 301, new: 302, src: '簇0.832·闸①-③ vs 闸④' },
  /* ── 负例层：同轴流水账相邻对（勘察→落地→收官） ── */
  { id: 'G17', layer: 'neg', old: 42, new: 44, src: '簇0.881·票01勘察vs票03判定' },
  { id: 'G18', layer: 'neg', old: 44, new: 47, src: '簇0.881·票03判定vs落地' },
  { id: 'G19', layer: 'neg', old: 27, new: 29, src: '簇0.867·merge落地vs检测落地' },
  { id: 'G20', layer: 'neg', old: 29, new: 36, src: '簇0.867·检测落地vs六票收官' },
  { id: 'G21', layer: 'neg', old: 176, new: 178, src: '簇0.898·SIGBUS设计vs进度' },
  { id: 'G22', layer: 'neg', old: 178, new: 185, src: '簇0.898·SIGBUS进度vs验收' },
  { id: 'G23', layer: 'neg', old: 271, new: 273, src: '簇0.852·硬数字vs收官' },
  { id: 'G24', layer: 'neg', old: 186, new: 188, src: '簇0.843·首跑绿vs全链差分' },
  { id: 'G25', layer: 'neg', old: 50, new: 54, src: '簇0.806·票06开工vs完成' },
  { id: 'G26', layer: 'neg', old: 62, new: 69, src: '簇0.811·票02勘察vs落地' },
  { id: 'G27', layer: 'neg', old: 70, new: 72, src: '簇0.813·票04勘察vs代码' },
  { id: 'G28', layer: 'neg', old: 81, new: 204, src: '簇0.815·票10落地vs完成' },
  { id: 'G29', layer: 'neg', old: 82, new: 205, src: '簇0.862·票11落地vs完成' },
  { id: 'G30', layer: 'neg', old: 32, new: 34, src: '簇0.824·票06修复vs收官' },
  { id: 'G31', layer: 'neg', old: 174, new: 179, src: '簇0.816·立项vs一日四票' },
  { id: 'G32', layer: 'neg', old: 38, new: 39, src: '簇0.806·范围锁定vs八项结论' },
  { id: 'G33', layer: 'neg', old: 60, new: 75, src: '簇0.803·九票启动vs终验' },
]

/* D 编号（fileId 或 chunk 口径）→ files 表 path → md 全文 → 头部 */
function loadEntry(d) {
  const q = (sql) => {
    const out = execSync(
      `sqlite3 -separator '|' "${DB}" "${sql.replace(/"/g, '""')}"`,
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    )
    return out.trimEnd().split('\n').filter(Boolean)
  }
  // 先按 fileId 直查，miss 再按 chunk id 反查 owner
  let rows = q(`select id, path from files where id=${d}`)
  if (rows.length === 0) {
    rows = q(
      `select f.id, f.path from files f join chunks c on c.file_id=f.id where c.id=${d} limit 1`,
    )
  }
  if (rows.length === 0) return null
  const [id, path] = rows[0].split('|')
  const raw = readFileSync(path, 'utf8')
  const lines = raw.split('\n').filter((l) => !l.startsWith('# '))
  const body = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  const title = (raw.match(/^# (.+)$/m) ?? [, path.split('/').pop()])[1]
  const date = (path.match(/(\d{4}-\d{2}-\d{2})/) ?? [, '?'])[1]
  return { fileId: Number(id), title, date, head: body.slice(0, 600) }
}

const out = []
out.push(`# H8 三态金标·待标语料（${PAIRS.length} 对，HEAD 600 字/篇）`)
out.push(`生成：2026-10-16 · 口径：跳 # 标题行后正文前 600 字（同 L2 BODY_CHARS）`)
out.push('')
for (const p of PAIRS) {
  const oldE = loadEntry(p.old)
  const newE = loadEntry(p.new)
  out.push('─'.repeat(72))
  out.push(`### ${p.id} [${p.layer}] ${p.src} — D${p.old}(旧) vs D${p.new}(新)`)
  if (!oldE || !newE) {
    out.push(`!! 缺文：old=${oldE ? 'ok' : 'MISS'} new=${newE ? 'ok' : 'MISS'}`)
    continue
  }
  out.push(``)
  out.push(`【旧 D${p.old}】${oldE.title} (${oldE.date})`)
  out.push(oldE.head)
  out.push(``)
  out.push(`【新 D${p.new}】${newE.title} (${newE.date})`)
  out.push(newE.head)
  out.push('')
}
writeFileSync(join(OUT, 'corpus.md'), out.join('\n'))
console.log(`OK ${PAIRS.length} 对 → ${join(OUT, 'corpus.md')}`)
const miss = PAIRS.filter((p) => !loadEntry(p.old) || !loadEntry(p.new))
if (miss.length) console.log('MISS:', miss.map((p) => p.id).join(','))
