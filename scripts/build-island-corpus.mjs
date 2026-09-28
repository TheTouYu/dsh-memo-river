#!/usr/bin/env node
/**
 * build-island-corpus.mjs — 物化「孤岛语料」（DESIGN.md §2.1 的 v0 版）。
 *
 * 来源：`VCPToolBox/sandbox/classroom-flow/tag-river-backup.json`
 * —— 那是 retag.cjs 动手之前的**原始 Tag 行留档**（11 篇 × 5 个一次性 Tag，
 *    跨篇零共享 → Tag 共现图必然裂成 11 个连通分量）。
 *
 * 正文沿用河流版（同一批日记的同一段经历），只把 Tag 行换回原始孤岛版，
 * 这样验收 #7「体检抓孤岛」的变量只有一个：Tag 是否复用。
 *
 * 用法：node scripts/build-island-corpus.mjs [--out <dir>]
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const VCP = '/home/h/app/VCPToolBox'
const SRC = join(VCP, 'dailynote', '教室建模归档')
const BACKUP = join(VCP, 'sandbox', 'classroom-flow', 'tag-river-backup.json')

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1])
const OUT = args.get('out') || new URL('../.selftest/island-corpus', import.meta.url).pathname

const backup = JSON.parse(readFileSync(BACKUP, 'utf8'))
mkdirSync(OUT, { recursive: true })

let slots = 0
const unique = new Set()
for (const [file, tagLine] of Object.entries(backup)) {
  const raw = readFileSync(join(SRC, file), 'utf8')
  const body = raw
    .split(/\r?\n/)
    .filter((l) => !/^Tag\s*[:：]/i.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
  writeFileSync(join(OUT, file), `${body}\n\n${tagLine}\n`)
  const tags = String(tagLine).replace(/^Tag\s*[:：]\s*/i, '').split(/[,，、]/).map((t) => t.trim()).filter(Boolean)
  slots += tags.length
  for (const t of tags) unique.add(t)
}
console.log(`孤岛语料已物化 → ${OUT}`)
console.log(`  篇数=${Object.keys(backup).length}  Tag 槽位=${slots}  唯一 Tag=${unique.size}`)
console.log(`  复用检查：${slots === unique.size ? '全部只出现 1 次（孤岛）' : `有 ${slots - unique.size} 个 Tag 被复用（不是孤岛！）`}`)
console.log(`  文件：${readdirSync(OUT).join(' ')}`)
