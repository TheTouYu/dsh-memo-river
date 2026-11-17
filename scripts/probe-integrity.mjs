#!/usr/bin/env node
/**
 * scripts/probe-integrity.mjs — 完整性哨兵与自动恢复的独立验收（自建自净，无端点依赖）。
 *
 * 覆盖（2026-11-17 三桶损坏事故的根治件）：
 *   P1 健康库：autoRecoverIfCorrupt → action=ok，不产生任何留证文件；
 *   P2 损坏库（页级同款损伤：把页 3 的字节覆写到页 5 → rowid 乱序/二次引用类签名）：
 *      → action=recovered，原库留证 corrupt-bak-*，新库 integrity ok 且 files 行数保住；
 *   P3 不可救库（非 sqlite 文件）：→ action=failed，原样放行不炸；
 *   P4 哨兵口径：integrityProblems 对健康库返回 []，对 P2 损伤非空
 *      （quick_check 恰好漏掉的索引↔表失配，这里用全量口径断言非空）。
 *
 * 跑法：node scripts/probe-integrity.mjs   （需先 build 出 lib/）
 */
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { autoRecoverIfCorrupt, integrityProblems, problemsOnPath } from '../lib/integrity.js'

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.log(`  ✗ ${name} ${detail}`) }
}

function makeDb(path, rows = 5) {
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT)')
  db.exec('CREATE INDEX idx_files_path ON files(path)')
  for (let i = 1; i <= rows; i++) {
    const pad = 'x'.repeat(120)
    db.prepare('INSERT INTO files (path) VALUES (?)').run(`dailynote/d${i}-${pad}.md`)
  }
  db.close()
}

/** 确定性页级损伤：零化最后一个完整页（父 cell 仍引用它 → 索引失配/缺行类签名）。 */
function corruptLastPage(path) {
  const buf = readFileSync(path)
  const raw = buf.readUInt16BE(16)
  const PS = raw === 1 ? 65536 : raw
  const npages = Math.floor(buf.length / PS)
  if (npages < 2) throw new Error('db too small to corrupt')
  buf.fill(0, (npages - 1) * PS)
  writeFileSync(path, buf)
}

const root = mkdtempSync(join(tmpdir(), 'memo-integrity-'))
try {
  /* P1 健康库直通 */
  const healthy = join(root, 'healthy.sqlite')
  makeDb(healthy)
  const out1 = autoRecoverIfCorrupt(healthy)
  check('P1 健康库 action=ok', out1.action === 'ok', JSON.stringify(out1))
  check('P1 不留证文件', readdirSync(root).filter((f) => f.startsWith('healthy.')).length === 1)

  /* P2 页级损坏 → 自动换新 */
  const corrupt = join(root, 'corrupt.sqlite')
  makeDb(corrupt, 60)
  corruptLastPage(corrupt)
  const problems = problemsOnPath(corrupt)
  check('P4 全量口径对损伤非空', problems.length > 0, JSON.stringify(problems))
  const out2 = autoRecoverIfCorrupt(corrupt)
  check('P2 action=recovered', out2.action === 'recovered', JSON.stringify(out2))
  check('P2 新库 integrity ok', problemsOnPath(corrupt).length === 0)
  const bak = readdirSync(root).filter((f) => f.startsWith('corrupt.sqlite.corrupt-bak-'))
  check('P2 原库留证存在', bak.length === 1)
  let n = -1
  { const db = new DatabaseSync(corrupt); n = Number(db.prepare('SELECT count(*) AS n FROM files').get().n); db.close() }
  check('P2 files 行数保住', n === 60, `n=${n}`)

  /* P3 非 sqlite 文件 → failed 放行，不炸 */
  const junk = join(root, 'junk.sqlite')
  writeFileSync(junk, 'this is not a database at all, definitely not sqlite')
  const out3 = autoRecoverIfCorrupt(junk)
  check('P3 action=failed（不可救则原样放行）', out3.action === 'failed', JSON.stringify(out3))
  check('P3 原文件未被动过', readFileSync(junk, 'utf8').startsWith('this is not'))

  /* P4 补：健康库 integrityProblems 空 */
  { const db = new DatabaseSync(healthy); check('P4 健康库 problems=[]', integrityProblems(db).length === 0); db.close() }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(failed === 0 ? `\nintegrity probe ${passed}/${passed + failed} PASS` : `\nintegrity probe ${passed}/${passed + failed} FAIL`)
process.exit(failed === 0 ? 0 : 1)
