#!/usr/bin/env node
// replay-validate-topology.mjs —— 票 03 复放验证：逆向文档 §5/§6 判定树 vs oracle 实际输出。
// 方法：classroom 三查询 includeTrace 全量跑 oracle，用 trace 观测量在 JS 侧重演文档结论
// （regime 阈值 / dominant_mode / 角色条件树 / 锚晋升），与实际输出逐环对照。
// 这不是复刻——是文档正确性的机器裁决。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const VCP_ROOT = process.env.VCP_ROOT || '/home/h/app/VCPToolBox';
const require = createRequire(import.meta.url);
const Database = require(path.join(VCP_ROOT, 'node_modules', 'better-sqlite3'));
const { VexusIndex } = require(path.join(VCP_ROOT, 'rust-vexus-lite'));
const KBM = JSON.parse(fs.readFileSync(path.join(VCP_ROOT, 'rag_params.json'), 'utf8')).KnowledgeBaseManager;
const MODEL_SIG = 'gemini-embedding-2-preview@relayrouter'; // 语料 pairwise 表的真实 sig——钉假 sig 会让 semantic_gain 全程走 fallback

const cos = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return na > 0 && nb > 0 ? d / Math.sqrt(na * nb) : 0; };
const clamp01 = (x) => Math.min(1, Math.max(0, x));

function pipelineConfig() {
  const rm = KBM.riverMemo || {};
  const local = rm.localField || {}, transfer = rm.transferField || {};
  const support = rm.effectiveSupport || {}, lang = KBM.languageCompensator || {};
  return {
    baseTagBoost: rm.sourceObservation?.baseTagBoost ?? 0.6, coreBoostFactor: rm.sourceObservation?.coreBoostFactor ?? 1.33,
    localAlpha: local.alpha ?? 0.15, transferAlpha: transfer.alpha ?? 0.55,
    fieldMaxIterations: Math.max(local.maxIterations || 80, transfer.maxIterations || 80),
    localTolerance: local.tolerance ?? 1e-9, transferTolerance: transfer.tolerance ?? 1e-9,
    localMassRatio: support.localMassRatio ?? 0.8, transferMassRatio: support.transferMassRatio ?? 0.9,
    maxLevels: 3, pyramidTopK: 10, minEnergyRatio: 0.1, layerDecay: 0.7,
    activationMultiplier: KBM.activationMultiplier || [0.5, 1.5], dynamicBoostRange: KBM.dynamicBoostRange || [0.3, 2.0],
    coreBoostRange: KBM.coreBoostRange || [1.2, 1.4], langConfidenceEnabled: true,
    langPenaltyUnknown: lang.penaltyUnknown ?? 0.05, langPenaltyCrossDomain: lang.penaltyCrossDomain ?? 0.1,
    deduplicationThreshold: KBM.deduplicationThreshold ?? 0.88,
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rev3-'));
const src = path.join(VCP_ROOT, 'sandbox/classroom-flow/full/knowledge_base.sqlite');
const DB = path.join(tmp, 'kb.sqlite');
fs.copyFileSync(src, DB);
const cache = JSON.parse(fs.readFileSync(path.join(VCP_ROOT, 'sandbox/classroom-flow/emb-cache.json'), 'utf8'));
const QS = {
  A: '我这边现在渲染又卡了，上次教室那个是怎么解决的？',
  B: '上次那个桌子漂浮的问题，后来到底是怎么发现原因的？',
  C: '那个视频到底是怎么做到真 60 帧的？编码卡在哪一步？',
};

const db = new Database(DB, { readonly: true });
const chunkRows = db.prepare('SELECT id, vector FROM chunks').all().filter((r) => r.vector);
const dim = chunkRows[0].vector.byteLength / 4;
const idx = new VexusIndex(dim, 512);
// recoverFromSqlite 必须先跑：查询河网来自管线感知、感知依赖 tag 索引——
// 漏掉它河网为空，Ω 退化 0.01 collapsed、形态权重退均匀先验（实测教训）。
await idx.recoverFromSqlite(DB, 'tags', null);
const art = await idx.rebuildMemoArtifact(DB, JSON.stringify({ modelSig: MODEL_SIG, effectiveConfig: KBM }));
const sig = art.artifactSig;
db.close();

let checks = 0, fails = 0;
const fail = (msg) => { fails++; console.error('  ✗ ' + msg); };
const ok = (msg) => { checks++; console.log('  ✓ ' + msg); };

for (const [k, text] of Object.entries(QS)) {
  console.log(`查询 ${k}：「${text}」`);
  const qVec = Float32Array.from(cache[text]);
  const knn = chunkRows.map((r) => ({ id: Number(r.id), score: cos(qVec, new Float32Array(r.vector.buffer, r.vector.byteOffset, dim)) })).sort((a, b) => b.score - a.score);
  const candidates = knn.map((c) => ({ id: c.id, score: c.score }));
  const pipe = await idx.runMemoPipeline(DB, sig, JSON.stringify({ queryId: `rev3-${k}`, queryText: text, coreTags: [], ghostTags: [], config: pipelineConfig() }), qVec, new Float32Array(0));
  const meta = JSON.parse(pipe.metadataJson || '{}');
  const topo = JSON.parse(await idx.rerankRivermemoTopologyV3(DB, sig, JSON.stringify({
    observationHandle: meta.observationHandle, dimension: dim, topK: candidates.length, includeTrace: true,
    query: { text, vector: [] },
    queryState: {
      queryId: `rev3-${k}`, sourceField: [], localField: [], transferField: [], localDomain: { ids: [] }, transferDomain: { ids: [] },
      queryRiverGraph: meta.queryRiverGraph || null,
      sourceObservation: { epa: meta.epa || {}, pyramid: meta.pyramid || {}, diagnostics: meta.diagnostics || {} },
      fieldDiagnostics: { backend: 'vexus-unified-memo-pipeline-handle' },
    },
    candidates,
  })));

  // ── §5 regime 阈值树 ──
  const omega = topo.omega.omega;
  const predictedRegime = omega < 0.12 ? 'collapsed' : omega < 0.45 ? 'sparse' : 'dense';
  predictedRegime === topo.omega.regime ? ok(`regime：Ω=${omega.toFixed(4)} → ${predictedRegime}（实际 ${topo.omega.regime}）`) : fail(`regime 树不符：预测 ${predictedRegime} vs 实际 ${topo.omega.regime}（Ω=${omega}）`);

  // ── §4 dominant_mode 比较序（atomic > narrative > propositional）──
  const m = topo.queryMorphology;
  const [wa, wp, wn] = [m.atomicWeight, m.propositionalWeight, m.narrativeWeight];
  const predictedMode = wa >= wp && wa >= wn ? 'atomic' : wn >= wp ? 'narrative' : 'propositional';
  predictedMode === m.dominantMode ? ok(`dominant_mode：(${wa.toFixed(3)},${wp.toFixed(3)},${wn.toFixed(3)}) → ${predictedMode}`) : fail(`mode 序不符：预测 ${predictedMode} vs 实际 ${m.dominantMode}`);

  // ── §6 角色条件树（逐候选重演）──
  const mode = m.dominantMode;
  const items = topo.results || [];
  const maxPure = Math.max(...items.map((r) => r.topologyV3?.pureScore ?? 0));
  const anchorStrengths = items.map((r) => r.topologyV3?.anchorStrength ?? 0).sort((a, b) => b - a);
  const promote = anchorStrengths[0] >= 0.1 && anchorStrengths[0] >= 2.0 * (anchorStrengths[1] ?? 0);
  let promoteIdx = -1;
  if (promote) promoteIdx = items.findIndex((r) => (r.topologyV3?.anchorStrength ?? 0) === anchorStrengths[0]);

  let roleOk = 0, roleBad = [], noTrace = 0;
  for (const r of items) {
    const t = r.topologyV3, o = r.observables, tp = r.relativeTopology;
    if (!t || !o || !tp) { noTrace++; continue; }
    const directEvidence = Math.max(o.semanticBoundaryScore ?? 0, o.direct ?? 0);
    const nearFrontier = t.pureScore >= maxPure - 0.03;
    const directAnswer = mode !== 'atomic' && o.closure >= 0.55 && (directEvidence >= 0.55 || (nearFrontier && o.queryChunkScore >= 0.55));
    const structural = Math.cbrt(Math.max(0, tp.matchedEdgeCoverage * tp.reliability * o.closure));
    let role = mode === 'atomic' ? 'atomic_concept' : directAnswer ? 'direct_answer' : structural >= 0.35 ? 'structural_explanation' : 'thematic_neighbor';
    if (omega < 0.12 && role === 'structural_explanation') role = 'thematic_neighbor'; // §6c 降级
    if (items.indexOf(r) === promoteIdx) role = 'direct_answer'; // §6c 晋升
    role === r.role ? roleOk++ : roleBad.push(`D${r.chunkId}: 预测 ${role} vs 实际 ${r.role}（closure=${o.closure.toFixed(3)} direct=${directEvidence.toFixed(3)} pure=${t.pureScore.toFixed(3)}）`);
  }
  roleBad.length === 0 && noTrace === 0 ? ok(`角色树 ${roleOk}/${items.length} 全吻合${promote ? '（锚晋升触发）' : ''}`) : fail(`角色树不符（无 trace ${noTrace} 项 / 分歧 ${roleBad.length} 处）：\n    ${roleBad.join('\n    ')}`);

  // ── §6d 终值合成 ──
  let finOk = 0, finBad = 0;
  for (const r of items) {
    const t = r.topologyV3;
    if (!t) { finBad++; continue; }
    const pred = clamp01(t.pureScore + t.gatedV2Bonus + t.anchorBonus);
    Math.abs(pred - t.finalScore) <= 1e-9 ? finOk++ : finBad++;
  }
  finBad === 0 ? ok(`final = pure + gated + anchor：${finOk}/${items.length} 逐项重合（≤1e-9）`) : fail(`终值合成 ${finBad} 处不符`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fails === 0 ? '✅ 复放验证全绿' : '❌ ' + fails + ' 类不符'}（通过断言 ${checks} 组）`);
process.exit(fails ? 1 : 0);
