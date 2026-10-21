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
// 配置面（P2）：--config 指一份 rag_params.json，两侧轨道吃同一份。
// 未给 = 旧行为（VCP_ROOT/rag_params.json，v9.2 基准件），逐字不变。
const CONFIG_PATH = arg('config');
const VCP_ROOT = process.env.VCP_ROOT || '/home/h/app/VCPToolBox';

// modelSig 只影响 artifactSig 字符串，不影响数值（已实证：WSL 有 config.env、本机没有，
// 双方输出仍 bit-exact）。钉死常量保证本机跨次运行确定。
const MODEL_SIG = 'gemini-embedding-2-preview@relayrouter'; // 语料 pairwise 表的真实 sig——钉假 sig 会让 semantic_gain 全程走 fallback

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
// --config 给了就用它（P2 开闸对照：两侧轨道吃同一份 2.0 rag_params），否则旧行为。
const RAG_PARAMS_PATH = CONFIG_PATH || path.join(VCP_ROOT, 'rag_params.json');
const ragParams = JSON.parse(fs.readFileSync(RAG_PARAMS_PATH, 'utf8'));
const KBM = ragParams.KnowledgeBaseManager;
// 扩展映射只在 --config 模式启用：缺省路径的 pipelineConfig 输出保持逐字不变
// （五腿零漂移硬判据）——不把 v9.2 rag_params 里旧映射未覆盖的键引入缺省臂。
const EXTENDED = !!CONFIG_PATH;

const Database = createRequire(import.meta.url)(path.join(VCP_ROOT, 'node_modules', 'better-sqlite3'));

// 数值兜底：配置缺项时用我方 Default 值（与 kernel/src/memo_pipeline.rs:164-195 对齐）
const num = (v, dflt) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);

function pipelineConfig() {
  const rm = KBM.riverMemo || {};
  const local = rm.localField || {}, transfer = rm.transferField || {};
  const support = rm.effectiveSupport || {}, lang = KBM.languageCompensator || {};
  const spike = KBM.spikeRouting || {};
  const base = {
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
  // 闸门键（P0.2/P1 的暗上线开关）：两侧**键名不同、语义等价**，同一数值都发出去，
  // 两边 serde 各自忽略对方的键名（2.0 全模块无 deny_unknown_fields——已核）：
  //   我方 kernel/src/memo_pipeline.rs:144 max_projection_nodes ← maxProjectionNodes（缺省 0）
  //   2.0  rust-vexus-lite/src/memo_pipeline.rs:118 max_field_projection_nodes ← maxFieldProjectionNodes（缺省 256）
  // 缺省臂（v9.2 rag_params 无 maxProjectionNodes）⇒ 0 ⇒ 我方仍走 v9.2 全支撑投影。
  const rawGate = support.maxProjectionNodes;
  const gateNodes = Number.isFinite(rawGate) && rawGate >= 0 ? Math.floor(rawGate) : (EXTENDED ? 256 : 0);
  base.maxProjectionNodes = gateNodes;
  if (!EXTENDED) return base;
  // ── 2.0 配置面（P2 开闸对照用）───────────────────────────────────────
  // 键名/取值域照抄 2.0 原生管线配置的唯一权威构造点
  // /home/h/app/VCPToolBox-2.0/KnowledgeBaseManager.js:2137-2315
  // （它把 rag_params 折成 runMemoPipeline 的 config JSON）。
  base.maxFieldProjectionNodes = gateNodes;
  base.epaGateMode = KBM.epaGateMode ?? 'backgroundRelative';
  base.maxFusionTags = 128;
  base.maxEmergentNodes = Math.max(0, Math.floor(num(spike.maxEmergentNodes, 50)));
  base.techTagThreshold = num(KBM.techTagThreshold, 0.08);
  base.normalTagThreshold = num(KBM.normalTagThreshold, 0.015);
  base.spikeRouting = {
    maxSafeHops: num(spike.maxSafeHops, 4),
    baseMomentum: num(spike.baseMomentum, 2),
    firingThreshold: num(spike.firingThreshold, 0.1),
    baseDecay: num(spike.baseDecay, 0.25),
    wormholeDecay: num(spike.wormholeDecay, 0.7),
    tensionThreshold: num(spike.tensionThreshold, 1),
    maxNeighborsPerNode: num(spike.maxNeighborsPerNode, 20),
    // 2.0 配置写作 v91* 前缀，我方 SenseConfig 字段是 returnFlowFactor/firGamma/
    // maxPropagationStates——两种拼写都认（2.0 侧只认前者，我方只认后者）。
    returnFlowFactor: num(spike.returnFlowFactor ?? spike.v91ReturnFlowFactor, 0.15),
    firGamma: num(spike.firGamma ?? spike.v91FirGamma, 0.6),
    maxPropagationStates: num(spike.maxPropagationStates ?? spike.v91MaxPropagationStates, 2000),
    minimumInjectedCurrent: num(spike.minimumInjectedCurrent, 0.01),
    maxOutputNodes: 0,
    maxOutputEdges: 0,
    maxTransitionRecords: 0,
    // 暗上线闸：2.0 侧无此键（上游恒开），我方缺省 false；要对照就必须显式打开。
    dynamicWormholes: spike.dynamicWormholes === true,
    dynamicWormholeThreshold: num(spike.dynamicWormholeThreshold, 0.2),
    dynamicWormholeSlots: Math.floor(num(spike.dynamicWormholeSlots, 2)),
    dynamicWormholeMaxTargets: Math.floor(num(spike.dynamicWormholeMaxTargets, 4096)),
  };
  return base;
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

  // ── ABI 分叉（2.0 oracle 适配臂）────────────────────────────────────
  // v9.2：免注册直查——recover/rebuild/pipeline/topo 拿到 dbPath 直接开库。
  // 2.0 ：注册制——所有库访问都走进程级 storage_registry
  //       （rust-vexus-lite/src/storage.rs with_registered_read/write），未注册
  //       一律返回 KNOWLEDGE_STORE_NOT_REGISTERED。必须先
  //       new NativeKnowledgeRuntime(tagIndex) → openAndInitStore(dbPath, optionsJson)
  //       把 store 注册进 registry，同一进程同一 dbPath 只能注册一次。
  // optionsJson 权威形态抄 2.0 的 KnowledgeBaseManager.js:438-452
  // （readPoolSize 4 / mmapSize 64MB / busyTimeoutMs 10000 / schemaVersion 2），
  // 键名见 storage.rs normalize_storage_options（HashMap<String,i64>，全整数）。
  // 两条路径共用同一 DB 副本、同一查询载荷，只是初始化形态不同。
  // 探测判据（踩过）：v9.2 **也导出** NativeKnowledgeRuntime——但那是旧日记索引
  // 注册制（prototype 只有 registerDiaryIndex/executeRiverQuery 等，没有
  // capabilities/openAndInitStore）。2.0 才有 ABI 握手 + 中央 Store 注册这两个方法。
  // 所以用**原型面**探测，不构造实例、无副作用；仅凭 `NativeKnowledgeRuntime 存在`
  // 会把 v9.2 oracle 误送进 2.0 臂（实测：abi handshake failed: null）。
  const ABI2 = typeof mod.NativeKnowledgeRuntime === 'function'
    && typeof mod.NativeKnowledgeRuntime.prototype?.capabilities === 'function'
    && typeof mod.NativeKnowledgeRuntime.prototype?.openAndInitStore === 'function';
  let runtime = null;
  let abiIdentity = null;
  if (ABI2) {
    try {
      runtime = new mod.NativeKnowledgeRuntime(idx);
      const runtimeCaps = typeof runtime.capabilities === 'function' ? runtime.capabilities() : null;
      if (!runtimeCaps || Number(runtimeCaps.abiVersion) !== 2) {
        die('error', `abi handshake failed: ${JSON.stringify(runtimeCaps)}`);
      }
      if (Number(runtimeCaps.dimension) !== dim) {
        die('error', `abi dimension ${runtimeCaps.dimension} != chunks dim ${dim}`);
      }
      if (typeof runtime.openAndInitStore !== 'function') die('error', 'abi2: missing openAndInitStore');
      const storeState = runtime.openAndInitStore(DB_PATH, JSON.stringify({
        readPoolSize: 4,
        mmapSize: 64 * 1024 * 1024,
        busyTimeoutMs: 10000,
        schemaVersion: 2,
      }));
      abiIdentity = `abi=2 schemaVersion=${storeState.schemaVersion} dbGen=${storeState.databaseGeneration} caps=${runtimeCaps.capabilities.length}`;
      console.log(`[${LABEL}] abi2 store registered: ${JSON.stringify(storeState)}`);
    } catch (e) {
      die('error', `abi2 store-init: ${e.message}`);
    }
  }

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
  const PIPE_CONFIG = pipelineConfig();
  const out = {
    label: LABEL, status: 'ok',
    identity: abiIdentity ? `${identity} [${abiIdentity}]` : identity,
    abi: ABI2 ? 2 : 1,
    config: {
      path: RAG_PARAMS_PATH,
      extended: EXTENDED,
      maxProjectionNodes: PIPE_CONFIG.maxProjectionNodes,
      maxFieldProjectionNodes: PIPE_CONFIG.maxFieldProjectionNodes ?? null,
      dynamicWormholes: PIPE_CONFIG.spikeRouting?.dynamicWormholes ?? null,
    },
    artifact, queries: [],
  };
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
        JSON.stringify({ queryId: q.id, queryText: q.text || q.id, coreTags: [], ghostTags: [], config: PIPE_CONFIG }),
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
  // 2.0 注册制：显式关停 runtime（释放 store registry + Write Actor），
  // 避免进程退出时残留后台线程。v9.2 无 runtime，空转。
  if (runtime && typeof runtime.shutdown === 'function') {
    try { runtime.shutdown(); } catch (_) { /* 关停失败不影响已产出的对账读数 */ }
  }
  fs.writeFileSync(OUT_PATH, JSON.stringify(out));
  console.log(`[${LABEL}] ok: ${out.queries.length} queries, sig=${artifactSig.slice(0, 12)}…`);
})().catch((e) => die('error', e.message));
