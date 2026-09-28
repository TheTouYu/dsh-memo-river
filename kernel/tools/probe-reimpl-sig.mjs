#!/usr/bin/env node
// probe-reimpl-sig.mjs —— 候选内核确定性探针（票 07，口径对齐 scripts/probe-sig-determinism.mjs）
// 判据：① 本进程连打 6 次 rebuild，artifactSig 逐位一致且 sourceElapsedMs>0（构建器真在跑）
//      ② 跨进程 2 子进程 × 3 次，全部一致（HashMap SipHash 种子每实例随机，跨进程才抓得住残余序依赖）
// 用语料：classroom-flow（15 节点图）+ preset-composer 生产桶副本（真实规模）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const HERE = import.meta.url.startsWith('file:') ? path.dirname(new URL(import.meta.url).pathname) : '.';
const KERNEL = path.resolve(HERE, '..');
const VCP_ROOT = process.env.VCP_ROOT || '/home/h/app/VCPToolBox';
const MODEL_SIG = 'differential-fixed@relayrouter';

const require = createRequire(import.meta.url);
const Database = require(path.join(VCP_ROOT, 'node_modules', 'better-sqlite3'));
const KBM = JSON.parse(fs.readFileSync(path.join(VCP_ROOT, 'rag_params.json'), 'utf8')).KnowledgeBaseManager;

function freshCopy(src, dir, tag) {
  const dst = path.join(dir, `${tag}.sqlite`);
  fs.copyFileSync(src, dst);
  for (const ext of ['-wal', '-shm']) if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, dst + ext);
  return dst;
}

async function rebuildOnce(modulePath, dbPath) {
  const mod = createRequire(import.meta.url)(modulePath);
  const idx = new mod.VexusIndex(3072, 512);
  const art = await idx.rebuildMemoArtifact(dbPath, JSON.stringify({ modelSig: MODEL_SIG, effectiveConfig: KBM }));
  return art;
}

const corpora = [];
{
  const classroom = path.join(VCP_ROOT, 'sandbox/classroom-flow/full/knowledge_base.sqlite');
  if (fs.existsSync(classroom)) corpora.push({ name: 'classroom', src: classroom });
  const bucketHash = crypto.createHash('sha256').update('/home/h/dsh-plugins/dsh-preset-composer').digest('hex').slice(0, 16);
  const bucket = path.join(os.homedir(), '.dsh/memo-river', bucketHash, 'knowledge_base.sqlite');
  if (fs.existsSync(bucket)) corpora.push({ name: 'preset-composer', src: bucket });
}

let failed = false;
for (const corpus of corpora) {
  // ① 本进程 6 连打
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sig7-'));
  const db = freshCopy(corpus.src, tmp, 'a');
  const sigs = [];
  for (let i = 0; i < 6; i++) {
    const art = await rebuildOnce(path.join(KERNEL, 'index.js'), db);
    if (!(art.elapsedMs > 0)) { console.error(`✗ ${corpus.name}: 第${i + 1}次 elapsedMs=${art.elapsedMs}（构建器没真跑）`); failed = true; }
    sigs.push(art.artifactSig);
  }
  const uniq = new Set(sigs);
  console.log(`① ${corpus.name} 本进程 6 连打：${uniq.size === 1 ? '✅ 全同' : '❌ ' + uniq.size + ' 种'} ${sigs[0].slice(0, 16)}…`);

  // ② 跨进程 2×3
  const childSrc = `
    const { createRequire } = require('node:module');
    const req = createRequire(process.argv[1]);
    (async () => {
      const mod = req(process.argv[1]);
      const out = [];
      for (let i = 0; i < 3; i++) {
        const idx = new mod.VexusIndex(3072, 512);
        const art = await idx.rebuildMemoArtifact(process.argv[2], JSON.stringify({ modelSig: ${JSON.stringify(MODEL_SIG)}, effectiveConfig: ${JSON.stringify(KBM)} }));
        out.push(art.artifactSig);
      }
      console.log(JSON.stringify(out));
    })().catch(e => { console.error(e.message); process.exit(1); });
  `;
  const childSigs = [];
  for (let c = 0; c < 2; c++) {
    const db2 = freshCopy(corpus.src, tmp, `c${c}`);
    const res = spawnSync(process.execPath, ['-e', childSrc, path.join(KERNEL, 'index.js'), db2], { encoding: 'utf8', timeout: 120_000 });
    if (res.status !== 0) { console.error(`✗ ${corpus.name} 子进程${c + 1} 失败: ${(res.stderr || '').slice(0, 200)}`); failed = true; continue; }
    childSigs.push(...JSON.parse(res.stdout.trim().split('\n').pop()));
  }
  const allUniq = new Set([...sigs, ...childSigs]);
  console.log(`② ${corpus.name} 跨进程 2×3：${allUniq.size === 1 ? '✅ 与本进程全同' : '❌ 共 ' + allUniq.size + ' 种'}`);
  if (uniq.size !== 1 || allUniq.size !== 1) failed = true;
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? '\n❌ 确定性探针未过' : '\n✅ 确定性探针全绿（票 07 判据达成）');
process.exit(failed ? 1 : 0);
