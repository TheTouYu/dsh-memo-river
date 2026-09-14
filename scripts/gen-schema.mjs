#!/usr/bin/env node
/**
 * gen-schema.mjs — 从 VCPToolBox 的参考知识库中抽取**逐字 DDL**，生成 src/schema.ts。
 *
 * 依据：DESIGN.md §9「表：VCP schema 子集（tags/files/file_tags/chunks/kv_store），
 * DDL 取自 VCPToolBox/modules/knowledgeBase/schemaManager.js」。派生资产表
 * （rivermemo_artifacts / v10_* / tag_*_residuals / tag_pair_similarity ...）与
 * 触发器必须一并落地——原生 rebuildMemoArtifact 会直接读写它们，缺表即失败。
 *
 * 用法：node scripts/gen-schema.mjs [参考 db 路径]
 */
import { DatabaseSync } from 'node:sqlite'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REF = process.argv[2] || '/home/h/app/VCPToolBox/sandbox/classroom-flow/full/knowledge_base.sqlite'
const HERE = dirname(fileURLToPath(import.meta.url))

const db = new DatabaseSync(REF, { readOnly: true })
const rows = db
  .prepare(`SELECT type, name, sql FROM sqlite_master
            WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
            ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'trigger' THEN 2 ELSE 3 END, name`)
  .all()
db.close()

const stmts = rows.map((r) => `${String(r.sql).trim()};`)
const body = stmts.join('\n\n')

const out = `/**
 * src/schema.ts — **自动生成，请勿手改**（由 scripts/gen-schema.mjs 生成）。
 *
 * 来源：${REF}
 * 共 ${stmts.length} 条 DDL（table/index/trigger）。
 * 依据 DESIGN.md §9：表为 VCP schema 子集，DDL 逐字取自 VCPToolBox。
 */

/** 按序执行的建表语句（全部 IF NOT EXISTS 语义由参考 DDL 自身保证；本函数幂等）。 */
export const SCHEMA_STATEMENTS: readonly string[] = ${JSON.stringify(stmts, null, 2)}
`

writeFileSync(join(HERE, '..', 'src', 'schema.ts'), out)
console.log(`wrote src/schema.ts — ${stmts.length} statements from ${REF}`)
