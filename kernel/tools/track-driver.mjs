#!/usr/bin/env node
// track-driver.mjs —— 差分轨道驱动器（票 02）
// 单个子进程 = 单个模块 + 单个 DB 副本，跑完 rebuildMemoArtifact → runMemoPipeline →
// rerankMemoDtsc / rerankRivermemoTopologyV3 全链，结果落 JSON 供父进程对账。
// 载荷形状照抄 sandbox/classroom-flow/native.cjs（生产形状：KnowledgeBaseManager.js:1422/:1783）。
// 进程级隔离是刻意的：Rust MemoRuntime 有全局态（memoRuntimeStats），同进程双轨会互相污染。

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const MODULE_PATH = arg('module');
const DB_PATH = arg('db');
const QUERIES_PATH = arg('queries');
const OUT_PATH = arg('out');
const LABEL = arg('label') || 'track';
const VCP_ROOT = process.env.VCP_ROOT || '/home/h/app/VCPToolBox';

// modelSig 只影响 artifactSig 字符串，不影响数值（已实证：WSL 有 config.env、本机没有，
// 双方输出仍 bit-exact）。钉死常量保证本机跨次运行确定。
const MODEL_SIG = 'differential-fixed@relayrouter';

const die = (status, detail) => {
  fs.writeFileSync(OUT_PATH, JSON.stringify({ label: LABEL, status, detail, queries: [] }, null, 2));
  console.error(`[${LABEL}] ${status}: ${detail}`);
  process.exit(0); // 「模块不可用」是对账器的 SKIP 输入，不是驱动器崩溃
};

if (!MODULE_PATH || !DB_PATH || !QUERIES_PATH || !OUT_PATH) die('error', 'missing args');

let mod;
try {
  mod = createRequire(import.meta.url)(MODULE_PATH);
} catch (e) {
  die('skipped', `module-load: ${e.message}`);
}

const queries = JSON.parse(fs.readFileSync(QUERIES_PATH, 'utf8'));
const ragParams = JSON.parse(fs.readFileSync(path.join(VCP_ROOT, 'rag_params.json'), 'utf8'));
const KBM = ragParams.KnowledgeBaseManager;

const Database = createRequire(import.meta.url)(path.join(VCP_ROOT, 'node_modules', 'better-sqlite3'));

function pipelineConfig() {
  const rm = KBM.riverMemo || {};
  const local = rm.localField || {}, transfer = rm.transferField || {};
  const support = rm.effectiveSupport || {}, lang = KBM.languageCompensator || {};
  return {
    baseTagBoost: rm.sourceObservation?.baseTagBoost ?? 0.6,
    coreBoostFactor: rm.sourceObservation?.coreBoostFactor ?? 1.33,
    localAlpha: local.alpha ?? 0.15,
    transferAlpha: transfer.alpha ?? 0.55,
    fieldMaxIterations: Math.max(local.maxIterations || 80, transfer.maxIterations || 80),
    localTolerance: local.tolerance ?? 1e-9,
    transferTolerance: transfer.tolerance ?? 1e-9,
    localMassRatio: support.localMassRatio ?? 0.8,
    transferMassRatio: support.transferMassRatio ?? 0.9,
    maxLevels: 3,
    pyramidTopK: 10,
    minEnergyRatio: 0.1,
    layerDecay: 0.7,
    activationMultiplier: KBM.activationMultiplier || [0.5, 1.5],
    dynamicBoostRange: KBM.dynamicBoostRange || [0.3, 2.0],
    coreBoostRange: KBM.coreBoostRange || [1.2, 1.4],
    langConfidenceEnabled: true,
    langPenaltyUnknown: lang.penaltyUnknown ?? 0.05,
    langPenaltyCrossDomain: lang.penaltyCrossDomain ?? 0.1,
    deduplicationThreshold: KBM.deduplicationThreshold ?? 0.88,
  };
}

const cos = (a, b) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na > 0 && nb > 0 ? d / Math.sqrt(na * nb) : 0;
};

(async () => {
  const identity = typeof mod.kernelIdentity === 'function' ? mod.kernelIdentity() : `${path.basename(MODULE_PATH)} (no identity fn)`;
  const VexusIndex = mod.VexusIndex;
  if (typeof VexusIndex !== 'function') die('skipped', 'no VexusIndex export');

  // 能力分级探测（票 07 起逐模块点亮）：rebuild 是差分地基必须存在；
  // recover（向量索引层，票 10）与 pipeline/rerank（票 08/09）缺失按能力退化，不整体跳过。
  const has = (m) => typeof VexusIndex.prototype[m] === 'function' || typeof VexusIndex[m] === 'function';
  const caps = {
    recover: has('recoverFromSqlite'),
    rebuild: has('rebuildMemoArtifact'),
    pipeline: has('runMemoPipeline'),
    dtsc: has('rerankMemoDtsc'),
    topo: has('rerankRivermemoTopologyV3'),
  };
  if (!caps.rebuild) die('skipped', 'missing methods: rebuildMemoArtifact');

  const db = new Database(DB_PATH, { readonly: true });
  // 过滤 NULL 向量行（待嵌入的遗留 chunk）：KNN 基线与候选集同口径排除
  const chunkRows = db.prepare('SELECT id, vector FROM chunks').all().filter((r) => r.vector);
  const dim = chunkRows.length ? chunkRows[0].vector.byteLength / 4 : 3072;
  const idx = new VexusIndex(dim, 512);
  if (caps.recover) await idx.recoverFromSqlite(DB_PATH, 'tags', null);
  else console.log(`[${LABEL}] recover 不可用（票 10 前正常），跳过索引载入`);

  // ① 图资产
  const art = await idx.rebuildMemoArtifact(DB_PATH, JSON.stringify({ modelSig: MODEL_SIG, effectiveConfig: KBM }));
  const artifactSig = art && art.artifactSig;
  if (!artifactSig) die('error', 'no artifactSig');
  const artifact = {
    artifactSig,
    sourceArtifactSig: art.sourceArtifactSig,
    graphGeneration: art.graphGeneration,
    databaseGeneration: art.databaseGeneration,
    provenanceGeneration: art.provenanceGeneration,
    nodeCount: art.nodeCount ?? null,
    edgeCount: art.edgeCount ?? null,
  };

  // artifact 行回读（票 07 判据）：payload 里 inboundMassView/anchorGainView/wormholeView/
  // provenanceView 由 HashMap 迭代序决定排列（连 oracle 自己跨进程都不同），比对前规范化排序。
  db.close();
  const db2 = new Database(DB_PATH, { readonly: true });
  const row = db2.prepare(
    'SELECT artifact_sig, source_graph_generation, config_hash, database_generation, provenance_generation, node_count, edge_count, payload FROM rivermemo_artifacts WHERE artifact_sig = ?',
  ).get(artifactSig);
  db2.close();
  let artifactPayload = null;
  if (row && row.payload) {
    const zlib = await import('node:zlib');
    const parsed = JSON.parse(zlib.gunzipSync(Buffer.from(row.payload)).toString('utf8'));
    const canon = (arr) => (Array.isArray(arr) ? [...arr].sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1) : arr);
    if (parsed.inboundMassView) parsed.inboundMassView = canon(parsed.inboundMassView);
    if (parsed.anchorGainView) parsed.anchorGainView = canon(parsed.anchorGainView);
    if (parsed.wormholeView) parsed.wormholeView = canon(parsed.wormholeView);
    if (parsed.provenanceView?.edges) {
      parsed.provenanceView.edges = parsed.provenanceView.edges
        .map(([key, contribs]) => [key, [...contribs].sort((a, b) => a[0] - b[0])])
        .sort((a, b) => (a[0] < b[0] ? -1 : 1));
    }
    artifactPayload = parsed;
  }
  artifact.rowPresent = !!row;
  artifact.payload = artifactPayload;

  // ②③ 每查询：pipeline + 双读出
  const out = { label: LABEL, status: 'ok', identity, artifact, queries: [] };
  for (const q of queries) {
    const qVec = Float32Array.from(q.vector);
    const knn = chunkRows
      .map((r) => ({ id: Number(r.id), score: cos(qVec, new Float32Array(r.vector.buffer, r.vector.byteOffset, dim)) }))
      .sort((a, b) => b.score - a.score);
    const candidates = knn.map((c) => ({ id: c.id, score: c.score }));

    const entry = { queryId: q.id, knnOrder: knn.slice(0, 12).map((c) => c.id) };
    try {
      if (!caps.pipeline) { entry.error = 'not-implemented:pipeline'; out.queries.push(entry); continue; }
      const pipe = await idx.runMemoPipeline(
        DB_PATH, artifactSig,
        JSON.stringify({ queryId: q.id, queryText: q.text || q.id, coreTags: [], ghostTags: [], config: pipelineConfig() }),
        qVec, new Float32Array(0),
      );
      const meta = JSON.parse(pipe.metadataJson || '{}');
      entry.enhancedVector = pipe.enhancedVector ? Array.from(pipe.enhancedVector) : null;
      entry.pipelineMetaKeys = Object.keys(meta).sort();
      entry.epa = meta.epa || null;
      entry.pyramid = meta.pyramid || null;
      entry.diagnostics = meta.diagnostics || null;
      const handle = meta.observationHandle;
      if (!handle) { entry.error = 'no observationHandle'; out.queries.push(entry); continue; }
      const geoState = { epa: meta.epa || {}, pyramid: meta.pyramid || {} };

      const dtscRaw = caps.dtsc ? await idx.rerankMemoDtsc(DB_PATH, artifactSig, JSON.stringify({
        dimension: dim, observationHandle: handle, queryGeometryState: geoState,
        topK: candidates.length, candidates, includeTrace: true,
      })) : null;
      const dtsc = dtscRaw ? JSON.parse(dtscRaw) : null;
      entry.dtsc = dtsc ? {
        ranked: (dtsc.results || []).map((r) => ({ id: Number(r.chunkId ?? r.id), score: Number(r.score), role: r.role ?? null })),
        diagnostics: dtsc.diagnostics ?? null,
      } : { notImplemented: true };

      const topoRaw = caps.topo ? await idx.rerankRivermemoTopologyV3(DB_PATH, artifactSig, JSON.stringify({
        observationHandle: handle, dimension: dim, topK: candidates.length, includeTrace: true,
        query: { text: q.text || q.id, vector: [] },
        queryState: {
          queryId: q.id, sourceField: [], localField: [], transferField: [],
          localDomain: { ids: [] }, transferDomain: { ids: [] },
          queryRiverGraph: meta.queryRiverGraph || null,
          sourceObservation: { epa: meta.epa || {}, pyramid: meta.pyramid || {}, diagnostics: meta.diagnostics || {} },
          fieldDiagnostics: { backend: 'vexus-unified-memo-pipeline-handle' },
        },
        candidates,
      })) : null;
      const topo = topoRaw ? JSON.parse(topoRaw) : null;
      entry.topo = topo ? {
        ranked: (topo.results || []).map((r) => ({ id: Number(r.chunkId ?? r.id), score: Number(r.score), role: r.role ?? null })),
        omega: topo.omega?.omega ?? null,
        regime: topo.omega?.regime ?? null,
        queryMode: topo.queryMode ?? null,
        diagnostics: topo.diagnostics ?? null,
      } : { notImplemented: true };
    } catch (e) {
      entry.error = `${e.message}`;
    }
    out.queries.push(entry);
  }
  fs.writeFileSync(OUT_PATH, JSON.stringify(out));
  console.log(`[${LABEL}] ok: ${out.queries.length} queries, sig=${artifactSig.slice(0, 12)}…`);
})().catch((e) => die('error', e.message));
