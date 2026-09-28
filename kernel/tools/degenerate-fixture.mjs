#!/usr/bin/env node
// degenerate-fixture.mjs —— 票 08 退化路径夹具：空库 / 单篇 / 全同向量。
// 双轨（oracle vs 候选）各跑 rebuild+pipeline，判据：不崩溃（status ok）+
// artifactSig 一致 + enhancedVector 余弦 ≥0.999999。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = path.join(HERE, 'track-driver.mjs');
const ORACLE = '/home/h/app/VCPToolBox/rust-vexus-lite';
const CAND = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);
const Database = require('/home/h/app/VCPToolBox/node_modules/better-sqlite3');
const KBM = JSON.parse(fs.readFileSync('/home/h/app/VCPToolBox/rag_params.json', 'utf8')).KnowledgeBaseManager;

const SCHEMA = `
CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT NOT NULL DEFAULT '', diary_name TEXT NOT NULL DEFAULT '', created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
CREATE TABLE chunks (id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL DEFAULT 0, tag_text TEXT NOT NULL DEFAULT '', vector BLOB, created_at INTEGER DEFAULT 0);
CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL, vector BLOB);
CREATE TABLE file_tags (file_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, position INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (file_id, tag_id));
CREATE TABLE tag_pair_similarity (tag_a INTEGER, tag_b INTEGER, similarity REAL, model_sig TEXT);
CREATE TABLE tag_intrinsic_residuals (tag_id INTEGER PRIMARY KEY, v9_anchor_gain REAL, residual_energy REAL, raw_residual_ratio REAL, artifact_sig TEXT);
CREATE TABLE rivermemo_artifacts (id INTEGER PRIMARY KEY AUTOINCREMENT, artifact_sig TEXT UNIQUE NOT NULL, schema_version TEXT, algorithm_version TEXT, source_v9_artifact_sig TEXT, source_graph_generation TEXT, model_sig TEXT, config_hash TEXT, database_generation TEXT, provenance_generation TEXT, payload_codec TEXT, payload_checksum TEXT, payload BLOB, status TEXT NOT NULL DEFAULT 'ready', error_message TEXT, node_count INTEGER, edge_count INTEGER, created_at INTEGER, updated_at INTEGER, published_at INTEGER);
CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT);
`;

function makeFixture(dir, name, { files, sameVector }) {
  const dbPath = path.join(dir, `${name}.sqlite`);
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  const dim = 32;
  const rng = (seed) => () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed % 1000) / 1000 - 0.5;
  };
  let chunkId = 1, tagId = 1;
  for (let f = 1; f <= files; f++) {
    db.prepare('INSERT INTO files (id, path, diary_name) VALUES (?, ?, ?)').run(f, `/t/${f}.md`, 'fixture');
    const chunkVec = Buffer.alloc(dim * 4);
    if (sameVector) {
      for (let i = 0; i < dim; i++) chunkVec.writeFloatLE(0.1, i * 4);
    } else {
      const r = rng(f * 7919);
      for (let i = 0; i < dim; i++) chunkVec.writeFloatLE(r(), i * 4);
    }
    db.prepare('INSERT INTO chunks (id, file_id, vector) VALUES (?, ?, ?)').run(chunkId, f, chunkVec);
    const tagCount = 3 + (f % 3);
    for (let t = 0; t < tagCount; t++) {
      const tv = Buffer.alloc(dim * 4);
      if (sameVector) {
        for (let i = 0; i < dim; i++) tv.writeFloatLE(0.1, i * 4);
      } else {
        const r2 = rng((f * 31 + t) * 104729);
        for (let i = 0; i < dim; i++) tv.writeFloatLE(r2(), i * 4);
      }
      db.prepare('INSERT INTO tags (id, name, vector) VALUES (?, ?, ?)').run(tagId, `tag${f}_${t}`, tv);
      db.prepare('INSERT INTO file_tags (file_id, tag_id, position) VALUES (?, ?, ?)').run(f, tagId, t + 1);
      tagId++;
    }
    chunkId++;
  }
  db.close();
  return { dbPath, chunkVec: files > 0 ? dim : 0 };
}

function runTrack(modulePath, dbPath, queries, tmp, label) {
  const qFile = path.join(tmp, `${label}-q.json`);
  const rFile = path.join(tmp, `${label}-r.json`);
  fs.writeFileSync(qFile, JSON.stringify(queries));
  const res = spawnSync(process.execPath, [DRIVER, '--module', modulePath, '--db', dbPath, '--queries', qFile, '--out', rFile, '--label', label], { timeout: 120_000, encoding: 'utf8' });
  if (res.status !== 0 || !fs.existsSync(rFile)) return { label, status: 'error', detail: `exit ${res.status}: ${(res.stderr || '').slice(0, 300)}`, queries: [] };
  return JSON.parse(fs.readFileSync(rFile, 'utf8'));
}

const cos = (a, b) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na > 0 && nb > 0 ? d / Math.sqrt(na * nb) : 0;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'degen8-'));
const fixtures = [
  { name: 'empty', opts: { files: 0, sameVector: false } },
  { name: 'single', opts: { files: 1, sameVector: false } },
  { name: 'samevec', opts: { files: 5, sameVector: true } },
];
let failed = false;
for (const fx of fixtures) {
  const { dbPath } = makeFixture(tmp, fx.name, fx.opts);
  const queries = [{
    id: `${fx.name}-q1`, text: 'fixture query',
    // 空库时驱动器无 chunk 可推维度、缺省 3072；有 chunk 时为 32
    vector: Array.from({ length: fx.opts.files > 0 ? 32 : 3072 }, (_, i) => Math.sin(i + 1) / 10),
  }];
  const oracle = runTrack(ORACLE, dbPath, queries, tmp, `o-${fx.name}`);
  const cand = runTrack(CAND, dbPath, queries, tmp, `c-${fx.name}`);
  const problems = [];
  if (oracle.status !== 'ok') problems.push(`oracle 轨 ${oracle.status}: ${oracle.detail ?? ''}`);
  if (cand.status !== 'ok') problems.push(`候选轨 ${cand.status}: ${cand.detail ?? ''}`);
  if (oracle.status === 'ok' && cand.status === 'ok') {
    if (oracle.artifact.artifactSig !== cand.artifact.artifactSig) problems.push(`sig 不一致 ${oracle.artifact.artifactSig.slice(0, 10)} vs ${cand.artifact.artifactSig.slice(0, 10)}`);
    const qa = oracle.queries[0], qb = cand.queries[0];
    if (qa.error || qb.error) problems.push(`查询错误 ${qa.error || qb.error}`);
    else if (qa.enhancedVector && qb.enhancedVector) {
      const c = cos(qa.enhancedVector, qb.enhancedVector);
      if (c < 0.999999) problems.push(`enhanced 余弦 ${c}`);
    }
  }
  if (problems.length) { failed = true; console.error(`✗ ${fx.name}: ${problems.join('；')}`); }
  else console.log(`✓ ${fx.name}：双轨 ok，sig 一致，enhanced 余弦达标`);
  fs.rmSync(dbPath, { force: true });
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? '\n❌ 退化夹具未过' : '\n✅ 退化夹具三连绿（票 08 判据达成）');
process.exit(failed ? 1 : 0);
