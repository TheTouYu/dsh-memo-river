#!/usr/bin/env node
/**
 * gen-prompt.mjs — 从 DESIGN.md §6.1 的围栏代码块中**逐字抽取**固定契约文本，
 * 生成 src/prompt.ts。
 *
 * 目的：契约文本「编译期常量、零动态、逐字」（DESIGN.md §6.1 的 ⚠️ 与 §6.4），
 * 因此不接受任何手抄——手抄会引入不可见的全角/半角与引号差异。
 * 生成的模块同时导出 sha256，供验收 #2（前缀缓存不破）直接比对。
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESIGN = join(HERE, '..', 'DESIGN.md')
const md = readFileSync(DESIGN, 'utf8')

// 锚定 §6.1 标题，取其后的第一个 ``` 围栏块。
const anchor = md.indexOf('### 6.1 system 段固定文本')
if (anchor < 0) throw new Error('DESIGN.md: 找不到 §6.1 标题')
const fenceStart = md.indexOf('```', anchor)
const fenceEnd = md.indexOf('```', fenceStart + 3)
if (fenceStart < 0 || fenceEnd < 0) throw new Error('DESIGN.md: §6.1 代码块不完整')
const text = md.slice(fenceStart + 3, fenceEnd).replace(/^\n/, '').replace(/\n$/, '')

if (/\{\{|\}\}/.test(text)) throw new Error('DESIGN.md §6.1 文本含 {{}} —— 会被 prompt 变量插值当作引用，必须先处理')
const hash = createHash('sha256').update(text, 'utf8').digest('hex')

const out = `/**
 * src/prompt.ts — **自动生成，请勿手改**（由 scripts/gen-prompt.mjs 生成）。
 *
 * 来源：DESIGN.md §6.1「system 段固定文本（逐字，零动态）」的围栏代码块。
 * ⚠️ 该段文本**编译期常量**，运行时不得拼接任何变量（含日期、计数、Ω 值）。
 *
 * sha256(FIXED_CONTRACT_TEXT) = ${hash}
 * bytes = ${Buffer.byteLength(text, 'utf8')}
 */

/** §6.1 固定契约文本（逐字，零动态）。 */
export const FIXED_CONTRACT_TEXT = ${JSON.stringify(text)}

/** 契约文本的 sha256（十六进制）——验收 #2 的前缀缓存判据。 */
export const FIXED_CONTRACT_SHA256 = ${JSON.stringify(hash)}
`

writeFileSync(join(HERE, '..', 'src', 'prompt.ts'), out)
console.log(`wrote src/prompt.ts — ${Buffer.byteLength(text, 'utf8')} bytes, sha256=${hash}`)
