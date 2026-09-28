#!/usr/bin/env node
// diff-runner.mjs —— 差分对账器（票 02，阶段②）
// 双轨 = oracle 模块（上游 vexus-lite）vs 候选模块（kernel/ 复刻），
// 同源 DB 各自副本、同查询载荷、子进程隔离驱动，逐项对账。
// 判据口径（PLAN §4）：选集 ID 名次完全一致 / 分数 ±1e-6 /
// enhancedVector 余弦 ≥0.999999 / Ω ±1e-9 且 regime 相等 / 角色序列相等。
// 自校验腿（oracle vs oracle）必须 PASS——对账器零误报是它自身有效的证明。

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const DRIVER = path.join(HERE, 'track-driver.mjs');
const VCP_ROOT = process.env.VCP_ROOT || '/home/h/app/VCPToolBox';
const REPORT_DIR = path.join(HERE, 'diff-report');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const ORACLE = arg('oracle', path.join(VCP_ROOT, 'rust-vexus-lite'));
const CANDIDATE = arg('candidate', path.join(REPO, 'kernel'));
const LEGS = (arg('legs', 'selfcheck,classroom,buckets')).split(',');
const BUCKET_CWDS = (arg('buckets', '/home/h/dsh-plugins/dsh-memo-river,/home/h/dsh-plugins/dsh-preset-composer,/home/h/genshin-ts')).split(',');

// ── 容差（判据口径，勿放宽） ─────────────────────────────────────────────
const TOL = { score: 1e-6, omega: 1e-9, enhancedCos: 0.999999 };

// ── 查询集构造 ─────────────────────────────────────────────────────────
function classroomQueries(dbPath) {
  // 与 native.cjs 完全同源：emb-cache 的三查询向量
  const cache = JSON.parse(fs.readFileSync(path.join(VCP_ROOT, 'sandbox/classroom-flow/emb-cache.json'), 'utf8'));
  const QS = {
    A: '我这边现在渲染又卡了，上次教室那个是怎么解决的？',
    B: '上次那个桌子漂浮的问题，后来到底是怎么发现原因的？',
    C: '那个视频到底是怎么做到真 60 帧的？编码卡在哪一步？',
  };
  const out = [];
  for (const [k, text] of Object.entries(QS)) {
    const v = cache[text];
    if (!v) throw new Error(`emb-cache 缺查询 ${k}`);
    out.push({ id: `classroom-${k}`, text, vector: v });
  }
  return out;
}

async function makeBucketQueries(dbPath, bucketName) {
  // 确定性派生（免嵌入端点）：按 chunk id 均匀取 6 个自身向量 + 2 个混合向量。
  // 混合向量制造非平凡检索面（两个语义场的叠加），比纯自匹配更能压出读出差异。
  const { createRequire } = await import('node:module');
  const Database = createRequire(import.meta.url)(path.join(VCP_ROOT, 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare('SELECT id, vector FROM chunks ORDER BY id').all().filter((r) => r.vector);
  db.close();
  if (!rows.length) throw new Error(`${bucketName}: 空 chunks`);
  const dim = rows[0].vector.byteLength / 4;
  const pick = (i) => new Float32Array(rows[i].vector.buffer, rows[i].vector.byteOffset, dim);
  const queries = [];
  const step = Math.max(1, Math.floor(rows.length / 6));
  for (let i = 0; i < 6; i++) {
    const r = rows[Math.min(i * step, rows.length - 1)];
    queries.push({ id: `${bucketName}-chunk${r.id}`, text: `deterministic-chunk-${r.id}`, vector: Array.from(pick(Math.min(i * step, rows.length - 1))) });
  }
  for (const [a, b] of [[0, 1], [Math.floor(rows.length / 2), rows.length - 1]]) {
    const va = pick(a), vb = pick(b), mix = new Float32Array(dim);
    let nrm = 0;
    for (let i = 0; i < dim; i++) { mix[i] = va[i] + vb[i]; nrm += mix[i] * mix[i]; }
    nrm = Math.sqrt(nrm) || 1;
    for (let i = 0; i < dim; i++) mix[i] /= nrm;
    queries.push({ id: `${bucketName}-mix${a}x${b}`, text: `deterministic-mix-${a}-${b}`, vector: Array.from(mix) });
  }
  return queries;
}

// ── DB 副本（rebuildMemoArtifact 会写 artifact 行：每轨独立副本，互不可见） ──
function freshCopy(srcDb, dir, tag) {
  const dst = path.join(dir, `${tag}-knowledge_base.sqlite`);
  fs.copyFileSync(srcDb, dst);
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(srcDb + ext)) fs.copyFileSync(srcDb + ext, dst + ext);
  }
  return dst;
}

// ── 子进程驱动一条轨 ───────────────────────────────────────────────────
function runTrack(modulePath, dbPath, queries, dir, label) {
  const qFile = path.join(dir, `${label}-queries.json`);
  const rFile = path.join(dir, `${label}-result.json`);
  fs.writeFileSync(qFile, JSON.stringify(queries));
  const res = spawnSync(process.execPath, [DRIVER, '--module', modulePath, '--db', dbPath, '--queries', qFile, '--out', rFile, '--label', label], {
    timeout: 300_000, encoding: 'utf8', env: { ...process.env, VCP_ROOT },
  });
  if (res.status !== 0 || !fs.existsSync(rFile)) {
    return { label, status: 'error', detail: `child exit ${res.status}: ${(res.stderr || '').slice(0, 500)}`, queries: [] };
  }
  return JSON.parse(fs.readFileSync(rFile, 'utf8'));
}

// ── 对账 ───────────────────────────────────────────────────────────────
const cos = (a, b) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na > 0 && nb > 0 ? d / Math.sqrt(na * nb) : 0;
};

// 规范化后的 payload 深比对：整数/字符串/布尔精确相等；浮点 |Δ|≤tol（票 07 判据 1e-9）。
// 记录最大浮点差与首个分歧路径（可定位），分歧超过 20 条即止（防刷屏）。
function deepCompare(a, b, tol, report, prefix = '') {
  if (typeof a === 'number' && typeof b === 'number') {
    const d = Math.abs(a - b);
    if (Number.isInteger(a) && Number.isInteger(b) ? a !== b : d > tol) {
      if (report.mismatchCount < 20) report.mismatches.push(`${prefix}: ${a} vs ${b} (Δ${d.toExponential(2)})`);
      report.mismatchCount++;
    }
    report.maxFloatDiff = Math.max(report.maxFloatDiff, d);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      if (report.mismatchCount < 20) report.mismatches.push(`${prefix}: 数组长度 ${a.length} vs ${b.length}`);
      report.mismatchCount++;
      return;
    }
    for (let i = 0; i < a.length; i++) deepCompare(a[i], b[i], tol, report, `${prefix}[${i}]`);
    return;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (!(k in a) || !(k in b)) {
        if (report.mismatchCount < 20) report.mismatches.push(`${prefix}.${k}: 缺侧`);
        report.mismatchCount++;
        continue;
      }
      deepCompare(a[k], b[k], tol, report, `${prefix}.${k}`);
    }
    return;
  }
  if (a !== b) {
    if (report.mismatchCount < 20) report.mismatches.push(`${prefix}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    report.mismatchCount++;
  }
}

function compareRanked(name, a, b, issues) {
  if (a.length !== b.length) { issues.push(`${name}: 长度 ${a.length} vs ${b.length}`); return; }
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) { issues.push(`${name}[${i}]: id ${a[i].id} vs ${b[i].id}（名次分歧）`); return; }
    if (Math.abs(a[i].score - b[i].score) > TOL.score) issues.push(`${name}[${i}] D${a[i].id}: 分数差 ${Math.abs(a[i].score - b[i].score).toExponential(2)} > ${TOL.score.toExponential(0)}`);
    if ((a[i].role ?? null) !== (b[i].role ?? null)) issues.push(`${name}[${i}] D${a[i].id}: role ${a[i].role} vs ${b[i].role}`);
  }
}

// 阶段级对账（票 08）：EPA / 金字塔 / 融合选择 / 双场收敛——比端到端更可定位。
// 计时字段（*_ms）不比；Tag 名集合化（去重序不定）。
function compareStageMeta(qa, qb, issues, meta) {
  const qid = qa.queryId;
  const num = (a, b, name, tol = 1e-9) => {
    const d = Math.abs((a ?? 0) - (b ?? 0));
    meta.stageMaxDiff = Math.max(meta.stageMaxDiff ?? 0, d);
    if (d > tol) issues.push(`${qid}: ${name} 差 ${d.toExponential(2)}（${a} vs ${b}）`);
  };
  const ea = qa.epa, eb = qb.epa;
  if (ea && eb) {
    num(ea.logicDepth, eb.logicDepth, 'epa.logicDepth');
    num(ea.entropy, eb.entropy, 'epa.entropy');
    num(ea.resonance, eb.resonance, 'epa.resonance', 1e-9);
    const la = (ea.dominantAxes || []).map((a) => a.label).join('|');
    const lb = (eb.dominantAxes || []).map((a) => a.label).join('|');
    if (la !== lb) issues.push(`${qid}: EPA 主轴不一致（${la} vs ${lb}）`);
  }
  const pa = qa.pyramid, pb = qb.pyramid;
  if (pa && pb) {
    for (const k of ['depth', 'coverage', 'novelty', 'coherence', 'activation']) num(pa.features?.[k], pb.features?.[k], `pyramid.features.${k}`);
    const levelsA = pa.levels || [], levelsB = pb.levels || [];
    if (levelsA.length !== levelsB.length) issues.push(`${qid}: 金字塔层数 ${levelsA.length} vs ${levelsB.length}`);
    for (let i = 0; i < Math.min(levelsA.length, levelsB.length); i++) {
      const idsA = (levelsA[i].tags || []).map((t) => t.id).join(',');
      const idsB = (levelsB[i].tags || []).map((t) => t.id).join(',');
      if (idsA !== idsB) issues.push(`${qid}: 金字塔 L${i} Tag 序不一致（${idsA} vs ${idsB}）`);
      num(levelsA[i].energyExplained, levelsB[i].energyExplained, `pyramid.L${i}.energyExplained`);
    }
  }
  const da = qa.diagnostics, db = qb.diagnostics;
  if (da && db) {
    const fa = da.fusion, fb = db.fusion;
    if (fa && fb) {
      const idsA = (fa.selectedTagIds || []).join(',');
      const idsB = (fb.selectedTagIds || []).join(',');
      if (idsA !== idsB) issues.push(`${qid}: 融合选择集不一致（${idsA.slice(0, 80)} vs ${idsB.slice(0, 80)}）`);
      for (const k of ['requestedCount', 'foundCount', 'deduplicatedCount', 'emergentCount']) {
        if (fa[k] !== fb[k]) issues.push(`${qid}: fusion.${k} ${fa[k]} vs ${fb[k]}`);
      }
    }
    const dfa = da.dualField, dfb = db.dualField;
    if (dfa && dfb) {
      for (const k of ['iterations', 'localConverged', 'transferConverged']) {
        if (dfa[k] !== dfb[k]) issues.push(`${qid}: dualField.${k} ${dfa[k]} vs ${dfb[k]}`);
      }
      num(dfa.localResidual, dfb.localResidual, 'dualField.localResidual', 1e-9);
      num(dfa.transferResidual, dfb.transferResidual, 'dualField.transferResidual', 1e-9);
    }
  }
}

function compareLeg(a, b) {
  const issues = [];
  const meta = { queries: 0, scoreMaxDiff: 0, omegaMaxDiff: 0, enhancedMinCos: Infinity, notImplemented: 0, payloadMaxDiff: 0, payloadMismatches: 0 };
  if (a.status !== 'ok' || b.status !== 'ok') {
    return { verdict: a.status !== 'ok' ? a.status : b.status, issues, meta: { queries: 0, scoreMaxDiff: 0, omegaMaxDiff: 0, enhancedMinCos: null }, detail: `${a.status}/${b.status}: ${a.detail || ''}${b.detail || ''}` };
  }
  if (a.artifact.artifactSig !== b.artifact.artifactSig) issues.push(`artifactSig 不一致（${a.artifact.artifactSig.slice(0, 12)}… vs ${b.artifact.artifactSig.slice(0, 12)}…）`);
  // 图资产逐字段对账（票 07 判据）：payload 已在驱动器侧规范化排序，浮点容差 1e-9
  if (a.artifact.payload && b.artifact.payload) {
    const report = { maxFloatDiff: 0, mismatchCount: 0, mismatches: [] };
    deepCompare(a.artifact.payload, b.artifact.payload, 1e-9, report, 'payload');
    meta.payloadMaxDiff = report.maxFloatDiff;
    meta.payloadMismatches = report.mismatchCount;
    if (report.mismatchCount) issues.push(`payload 分歧 ${report.mismatchCount} 处，首个：${report.mismatches[0]}`);
  } else if (a.artifact.payload !== b.artifact.payload) {
    issues.push('payload 单侧缺失（row 回读失败？）');
  }
  if (a.queries.length !== b.queries.length) issues.push(`查询数 ${a.queries.length} vs ${b.queries.length}`);
  for (let qi = 0; qi < Math.min(a.queries.length, b.queries.length); qi++) {
    const qa = a.queries[qi], qb = b.queries[qi], qid = qa.queryId;
    meta.queries++;
    if (qa.error || qb.error) {
      const err = qa.error || qb.error;
      if (err.startsWith('not-implemented')) { meta.notImplemented++; continue; }
      issues.push(`${qid}: 轨道错误 ${err}`);
      continue;
    }
    compareStageMeta(qa, qb, issues, meta);
    if (JSON.stringify(qa.knnOrder) !== JSON.stringify(qb.knnOrder)) issues.push(`${qid}: KNN 基线序不一致（语料副本漂移？）`);
    if (qa.dtsc?.ranked && qb.dtsc?.ranked) {
      compareRanked(`${qid}/dtsc`, qa.dtsc.ranked, qb.dtsc.ranked, issues);
      for (let i = 0; i < Math.min(qa.dtsc.ranked.length, qb.dtsc.ranked.length); i++) {
        meta.scoreMaxDiff = Math.max(meta.scoreMaxDiff, Math.abs(qa.dtsc.ranked[i].score - qb.dtsc.ranked[i].score));
      }
    } else if (qa.dtsc?.notImplemented || qb.dtsc?.notImplemented) meta.notImplemented++;
    if (qa.topo?.ranked && qb.topo?.ranked) {
      compareRanked(`${qid}/topo`, qa.topo.ranked, qb.topo.ranked, issues);
      for (let i = 0; i < Math.min(qa.topo.ranked.length, qb.topo.ranked.length); i++) {
        meta.scoreMaxDiff = Math.max(meta.scoreMaxDiff, Math.abs(qa.topo.ranked[i].score - qb.topo.ranked[i].score));
      }
      if (qa.topo.omega != null && qb.topo.omega != null) {
        const d = Math.abs(qa.topo.omega - qb.topo.omega);
        meta.omegaMaxDiff = Math.max(meta.omegaMaxDiff, d);
        if (d > TOL.omega) issues.push(`${qid}: Ω 差 ${d.toExponential(2)}`);
      }
      if (qa.topo.regime !== qb.topo.regime) issues.push(`${qid}: regime ${qa.topo.regime} vs ${qb.topo.regime}`);
      if (qa.topo.queryMode !== qb.topo.queryMode) issues.push(`${qid}: queryMode ${qa.topo.queryMode} vs ${qb.topo.queryMode}`);
    } else if (qa.topo?.notImplemented || qb.topo?.notImplemented) meta.notImplemented++;
    if (qa.enhancedVector && qb.enhancedVector) {
      const c = cos(qa.enhancedVector, qb.enhancedVector);
      meta.enhancedMinCos = Math.min(meta.enhancedMinCos, c);
      if (c < TOL.enhancedCos) issues.push(`${qid}: enhancedVector 余弦 ${c.toFixed(9)} < ${TOL.enhancedCos}`);
    } else if (!qa.error && !qb.error && (qa.enhancedVector || qb.enhancedVector)) {
      issues.push(`${qid}: enhancedVector 单侧缺失`);
    }
  }
  if (!isFinite(meta.enhancedMinCos)) meta.enhancedMinCos = null;
  const verdict = issues.length ? 'FAIL' : (meta.notImplemented ? 'PARTIAL' : 'PASS');
  return { verdict, issues, meta };
}

// ── 腿编排 ─────────────────────────────────────────────────────────────
async function main() {
  const runId = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 17);
  const outDir = path.join(REPORT_DIR, runId);
  fs.mkdirSync(outDir, { recursive: true });
  const legs = [];
  const sources = [];

  const classroomDb = path.join(VCP_ROOT, 'sandbox/classroom-flow/full/knowledge_base.sqlite');
  if (LEGS.includes('selfcheck')) sources.push({ leg: 'selfcheck', db: classroomDb, queries: classroomQueries() });
  if (LEGS.includes('classroom')) sources.push({ leg: 'classroom', db: classroomDb, queries: classroomQueries() });
  if (LEGS.includes('buckets')) {
    for (const cwd of BUCKET_CWDS) {
      const hash = crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 16);
      const db = path.join(os.homedir(), '.dsh/memo-river', hash, 'knowledge_base.sqlite');
      if (!fs.existsSync(db)) { legs.push({ leg: `bucket:${path.basename(cwd)}`, verdict: 'SKIP', note: `桶不存在 ${hash}` }); continue; }
      sources.push({ leg: `bucket:${path.basename(cwd)}`, db, queries: await makeBucketQueries(db, path.basename(cwd)) });
    }
  }

  for (const src of sources) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `diffrun-${src.leg.replace(/[^a-z0-9-]/gi, '')}-`));
    const dbA = freshCopy(src.db, tmp, 'oracle');
    const dbB = freshCopy(src.db, tmp, 'cand');
    console.log(`▶ ${src.leg}：oracle 轨…`);
    const trackA = runTrack(ORACLE, dbA, src.queries, tmp, 'oracle');
    // 自校验腿 = oracle vs oracle（对账器零误报证明）；其余腿 = oracle vs 候选
    const moduleB = src.leg === 'selfcheck' ? ORACLE : CANDIDATE;
    console.log(`▶ ${src.leg}：${src.leg === 'selfcheck' ? 'oracle(第二实例)' : 'candidate'} 轨…`);
    const trackB = runTrack(moduleB, dbB, src.queries, tmp, src.leg === 'selfcheck' ? 'oracle2' : 'cand');
    const cmp = compareLeg(trackA, trackB);
    legs.push({ leg: src.leg, ...cmp, oracleIdentity: trackA.identity, candidateIdentity: trackB.identity });
    fs.writeFileSync(path.join(outDir, `${src.leg.replace(/[^a-z0-9-]/gi, '_')}-tracks.json`), JSON.stringify({ oracle: trackA, candidate: trackB }, null, 2));
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`  → ${cmp.verdict}${cmp.meta.queries ? `（${cmp.meta.queries} 查询，分数最大差 ${(cmp.meta.scoreMaxDiff || 0).toExponential(2)}，Ω 最大差 ${(cmp.meta.omegaMaxDiff || 0).toExponential(2)}）` : ''}`);
  }

  // 报告
  const md = [`# 差分报告 ${runId}`, '', `- oracle: ${ORACLE}`, `- candidate: ${CANDIDATE}`, '', '| 腿 | 判定 | 查询数 | 分数最大差 | Ω 最大差 | enhanced 最小余弦 | 备注 |', '|---|---|---|---|---|---|---|'];
  for (const l of legs) {
    md.push(`| ${l.leg} | ${l.verdict} | ${l.meta?.queries ?? '-'} | ${l.meta?.scoreMaxDiff != null ? l.meta.scoreMaxDiff.toExponential(2) : '-'} | ${l.meta?.omegaMaxDiff != null ? l.meta.omegaMaxDiff.toExponential(2) : '-'} | ${l.meta?.enhancedMinCos != null ? l.meta.enhancedMinCos.toFixed(9) : '-'} | ${l.detail || l.note || (l.issues?.length ? `首个分歧：${l.issues[0]}` : '')} |`);
  }
  if (legs.some((l) => l.issues?.length)) {
    md.push('', '## 分歧明细', '');
    for (const l of legs) for (const i of l.issues || []) md.push(`- [${l.leg}] ${i}`);
  }
  const selfcheck = legs.find((l) => l.leg === 'selfcheck');
  const verdict = selfcheck && selfcheck.verdict !== 'PASS' ? 'SELF-CHECK-FAILED'
    : legs.some((l) => l.verdict === 'FAIL') ? 'FAIL'
      : legs.some((l) => l.verdict === 'error') ? 'ERROR' : 'OK';
  md.push('', `**总判定：${verdict}**（自校验必须 PASS；候选未实现记 PARTIAL/SKIP 不算失败，payload 分歧即 FAIL）`);
  fs.writeFileSync(path.join(outDir, 'summary.md'), md.join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'legs.json'), JSON.stringify(legs, null, 2));
  console.log(`\n报告：${path.join(outDir, 'summary.md')}\n总判定：${verdict}`);
  process.exit(verdict === 'OK' ? 0 : 1);
}

main().catch((e) => { console.error('diff-runner FAILED:', e); process.exit(1); });
