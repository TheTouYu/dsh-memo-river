//! memo_geometry —— VCP 2.0 复刻 P0.2：AGS 统一几何（Anchored Greedy Gram-Schmidt）。
//!
//! 上游对照：/home/h/app/VCPToolBox-2.0/rust-vexus-lite/src/memo_geometry.rs（972 行，HEAD 174a5e1）。
//! 移植决策（见 research/vcp2.0/port/schema-checklist.md）：
//! - 算法核（gram_gs / select_axes_lazy / effective_k / semantic_weight / star_direction）
//!   与上游逐语义对齐，位级等价由 lazy_gram_columns_match_full_gram_bits 测试钉死。
//! - UnitVectorWorkspace（mmap 工作区）→ 普通 HashMap<i64,Vec<f64>>（免 memmap2/bytemuck 新依赖；
//!   位保留语义同：f32→f64 逐位转，零/非有限/错长向量缺席，不进 Gram 与 mean）。
//! - publication_gate / storage::with_registered_* / DerivedDependencies / content_revision
//!   不随移植：写路径走我方 memo_artifact_builder 的 open_readwrite（内含 BUG-0930 keepalive 契约），
//!   单事务提交；kbm_runtime_meta 由本任务幂等自建自 seed（缺行=SQL 错的硬缺口，核对表第 2 条）。
//! - 本任务只写 tag_intrinsic_residuals(_status)/kv_store/tagmemo_artifacts/kbm_runtime_meta，
//!   **不进读出链**：P0 五腿零漂移由「rebuild 不调用 geometry」保证。
//! - graph_generation 恒为 `facts:{memo_tag_facts}`；本仓无 facts 捕获机器，seed 值即当前值
//!   （陈旧校验的完整 DerivedDependencies 接线是 P3 的事）。

use crate::memo_artifact_builder::{open_readonly, open_readwrite};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::params;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

const ALGORITHM: &str = "unified_geometry_ags_v2";

pub(crate) struct AgsTrace {
    pub(crate) picked: Vec<(i64, f64)>,
    pub(crate) basis: Vec<Vec<f64>>,
    pub(crate) residual_norm: Option<f64>,
}

pub(crate) struct AgsCandidate {
    pub(crate) id: i64,
    pub(crate) prior: f64,
}

pub(crate) enum AgsTarget<'a> {
    Explain(&'a [f64]),
    Span,
}

pub(crate) fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

fn normalize(vector: &mut [f64]) -> bool {
    let sum: f64 = vector.iter().map(|v| v * v).sum();
    if !sum.is_finite() || sum < 1e-12 {
        return false;
    }
    let norm = sum.sqrt();
    for value in vector.iter_mut() {
        *value /= norm;
    }
    true
}

fn gram_gs(
    candidates: &[AgsCandidate],
    diagonal: &[f64],
    mut project: impl FnMut(&[f64], usize) -> Option<Vec<f64>>,
    target: Option<(&[f64], f64)>,
    max_basis: usize,
    min_gain: f64,
) -> Option<AgsTrace> {
    let n = candidates.len();
    let mut basis: Vec<Vec<f64>> = Vec::new();
    let mut projections: Vec<Vec<f64>> = Vec::new();
    let mut target_coefficients: Vec<f64> = Vec::new();
    let mut used = vec![false; n];
    let mut picked = Vec::new();
    for _ in 0..max_basis.min(n) {
        let mut best: Option<(usize, f64, f64, f64)> = None;
        for i in 0..n {
            if used[i] || !candidates[i].prior.is_finite() || candidates[i].prior <= 0.0 {
                continue;
            }
            let norm_sq = diagonal[i] - projections.iter().map(|p| p[i] * p[i]).sum::<f64>();
            let orth = norm_sq.max(0.0).sqrt();
            if orth <= 1e-6 {
                continue;
            }
            let signed = target
                .map(|(correlations, _)| {
                    (correlations[i]
                        - projections
                            .iter()
                            .zip(&target_coefficients)
                            .map(|(p, c)| p[i] * c)
                            .sum::<f64>())
                        / orth
                })
                .unwrap_or(orth);
            let gain = signed.abs();
            let score = gain * orth * candidates[i].prior;
            if best.as_ref().is_none_or(|(j, old, _, _)| {
                score > *old || (score == *old && candidates[i].id < candidates[*j].id)
            }) {
                best = Some((i, score, gain, orth));
            }
        }
        let Some((i, _, gain, orth)) = best else { break };
        if gain < min_gain {
            break;
        }
        used[i] = true;
        let mut coefficients = vec![0.0; n];
        coefficients[i] = 1.0;
        for (axis, p) in basis.iter().zip(&projections) {
            for (value, coefficient) in coefficients.iter_mut().zip(axis) {
                *value -= p[i] * coefficient;
            }
        }
        for value in &mut coefficients {
            *value /= orth;
        }
        let row = project(&coefficients, i)?;
        if let Some((correlations, _)) = target {
            target_coefficients.push(dot(&coefficients, correlations));
        }
        picked.push((candidates[i].id, gain));
        basis.push(coefficients);
        projections.push(row);
    }
    let residual_norm = target.map(|(_, energy)| {
        let residual = (energy - target_coefficients.iter().map(|c| c * c).sum::<f64>()).max(0.0);
        if residual < 1e-14 * energy {
            0.0
        } else {
            residual.sqrt()
        }
    });
    Some(AgsTrace { picked, basis, residual_norm })
}

/// Every Gram entry is bounded by this value when every diagonal entry is
/// (Cauchy-Schwarz: |G_ij| <= sqrt(G_ii * G_jj)), so no entry can overflow.
const LAZY_GRAM_DIAGONAL_LIMIT: f64 = 1e150;

/// Gram column j of a selected candidate is computed only when it is selected.
/// Unselected candidates keep a coefficient of exactly +0.0, so in
/// `dot(coefficients, gram[j])` their terms are +0.0 * finite = +-0.0 and adding
/// them never changes a nonzero sum. Summing the selected terms in the same
/// index order therefore reproduces the full-Gram projections bit for bit.
fn select_axes_lazy(
    candidates: &[AgsCandidate],
    vectors: &[&[f64]],
    diagonal: &[f64],
    target: Option<(&[f64], f64)>,
    max_basis: usize,
    min_gain: f64,
) -> Option<AgsTrace> {
    if !diagonal
        .iter()
        .all(|value| value.is_finite() && *value <= LAZY_GRAM_DIAGONAL_LIMIT)
    {
        return None;
    }
    let n = candidates.len();
    let mut columns: Vec<Vec<f64>> = vec![Vec::new(); n];
    let mut selected: Vec<usize> = Vec::new();
    gram_gs(
        candidates,
        diagonal,
        |coefficients, picked| {
            if !coefficients.iter().all(|value| value.is_finite()) {
                return None;
            }
            // Same argument order as the full Gram entry gram[j][picked].
            columns[picked] = vectors.iter().map(|v| dot(v, vectors[picked])).collect();
            selected.insert(selected.partition_point(|&m| m < picked), picked);
            let row: Vec<f64> = (0..n)
                .map(|j| selected.iter().map(|&m| coefficients[m] * columns[m][j]).sum())
                .collect();
            row.iter().all(|value| value.is_finite()).then_some(row)
        },
        target,
        max_basis,
        min_gain,
    )
}

fn select_axes_full(
    candidates: &[AgsCandidate],
    vectors: &[&[f64]],
    diagonal: &[f64],
    target: Option<(&[f64], f64)>,
    max_basis: usize,
    min_gain: f64,
) -> AgsTrace {
    let gram: Vec<Vec<f64>> = vectors
        .iter()
        .map(|a| vectors.iter().map(|b| dot(a, b)).collect())
        .collect();
    gram_gs(
        candidates,
        diagonal,
        |coefficients, _| {
            Some((0..candidates.len()).map(|j| dot(coefficients, &gram[j])).collect())
        },
        target,
        max_basis,
        min_gain,
    )
    .expect("full Gram projections are always available")
}

/// Greedy selection in coefficient space: `basis` holds each axis as
/// coefficients over `vectors`, not as a vector in the original space.
fn select_axes(
    target: AgsTarget<'_>,
    candidates: &[AgsCandidate],
    vectors: &[&[f64]],
    max_basis: usize,
    min_gain: f64,
) -> AgsTrace {
    let diagonal: Vec<f64> = vectors.iter().map(|v| dot(v, v)).collect();
    let correlations: Vec<f64> = match target {
        AgsTarget::Explain(t) => vectors.iter().map(|v| dot(t, v)).collect(),
        AgsTarget::Span => Vec::new(),
    };
    let target_data = match target {
        AgsTarget::Explain(t) => Some((correlations.as_slice(), dot(t, t))),
        AgsTarget::Span => None,
    };
    select_axes_lazy(candidates, vectors, &diagonal, target_data, max_basis, min_gain).unwrap_or_else(
        || select_axes_full(candidates, vectors, &diagonal, target_data, max_basis, min_gain),
    )
}

pub(crate) fn anchored_gs(
    target: AgsTarget<'_>,
    candidates: &[AgsCandidate],
    vectors: &[&[f64]],
    max_basis: usize,
    min_gain: f64,
) -> AgsTrace {
    let mut trace = select_axes(target, candidates, vectors, max_basis, min_gain);
    let dim = vectors.first().map_or(0, |v| v.len());
    trace.basis = trace
        .basis
        .iter()
        .map(|coefficients| {
            let mut axis = vec![0.0; dim];
            for (c, vector) in coefficients.iter().zip(vectors) {
                for (value, source) in axis.iter_mut().zip(*vector) {
                    *value += c * source;
                }
            }
            axis
        })
        .collect();
    trace
}

fn effective_k(coverage: &[f64], k_sem: usize, epsilon: f64, delta: f64) -> usize {
    let minimum = k_sem.min(coverage.len());
    for k in minimum.max(1)..=coverage.len() {
        let previous = if k > 1 { coverage[k - 2] } else { 0.0 };
        if 1.0 - coverage[k - 1] <= epsilon || coverage[k - 1] - previous < delta {
            return k;
        }
    }
    coverage.len()
}

fn semantic_weight(sim: f64, enabled: bool, peak: f64, sigma: f64, floor: f64, hard_floor: f64) -> f64 {
    if !enabled {
        1.0
    } else if sim < hard_floor {
        0.0
    } else if sim <= 0.0 {
        floor
    } else {
        (0.5 + 0.8 * (-(sim - peak).powi(2) / (2.0 * sigma * sigma)).exp()).max(floor)
    }
}

/// A bounded mixture, not an unbounded sum of raw cooccurrence counts.
/// Both target and neighbors are centered in the same unit-vector coordinate system.
fn star_direction(target: &[f64], mean: &[f64], neighbors: &[(&[f64], f64)], mix: f64) -> Vec<f64> {
    let weight_sum: f64 = neighbors.iter().map(|(_, w)| *w).sum();
    let mix = if weight_sum > 1e-12 { mix } else { 0.0 };
    let mut direction: Vec<f64> = target
        .iter()
        .zip(mean)
        .map(|(v, m)| (1.0 - mix) * (v - m))
        .collect();
    if mix > 0.0 {
        for (vector, weight) in neighbors {
            for ((out, v), m) in direction.iter_mut().zip(*vector).zip(mean) {
                *out += mix * weight / weight_sum * (v - m);
            }
        }
    }
    if !normalize(&mut direction) {
        direction = target.iter().zip(mean).map(|(v, m)| v - m).collect();
        normalize(&mut direction);
    }
    direction
}

fn number(v: &Value, key: &str, default: f64, min: f64, max: f64) -> f64 {
    v.get(key)
        .and_then(Value::as_f64)
        .filter(|x| x.is_finite())
        .unwrap_or(default)
        .clamp(min, max)
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// f32-LE 向量 → base64（与上游 encode_vector 逐字节一致）。
fn encode_vector(v: &[f64]) -> String {
    use base64::Engine;
    let bytes: Vec<u8> = v.iter().flat_map(|x| (*x as f32).to_le_bytes()).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// SQL 原件向量装载（替代上游 mmap UnitVectorWorkspace）：
/// 位保留 f32→f64；零/非有限/错长向量缺席——「Invalid/zero vectors remain absent,
/// never enter Gram matrices or the mean」。
fn load_tag_vectors(
    connection: &rusqlite::Connection,
    ids: &[i64],
    dimension: usize,
) -> std::result::Result<(HashMap<i64, Vec<f64>>, usize), String> {
    let mut out = HashMap::new();
    let mut statement = connection
        .prepare("SELECT id, vector FROM tags")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Option<Vec<u8>>>(1)?))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (id, raw) = row.map_err(|e| e.to_string())?;
        let Some(bytes) = raw else { continue };
        if bytes.len() != dimension * 4 {
            continue;
        }
        let mut vector = Vec::with_capacity(dimension);
        let mut valid = true;
        for chunk in bytes.chunks_exact(4) {
            let value = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            if !value.is_finite() {
                valid = false;
                break;
            }
            vector.push(value as f64);
        }
        if !valid || vector.iter().map(|v| v * v).sum::<f64>() < 1e-12 {
            continue;
        }
        out.insert(id, vector);
    }
    let fallback = out.len();
    // 只保留本次需要的 id（缺向量的 id 不进工作区）。
    out.retain(|id, _| ids.contains(id));
    Ok((out, fallback))
}

#[napi(object)]
pub struct GeometryResult {
    pub success: bool,
    pub artifact_sig: String,
    pub config_hash: String,
    pub algorithm_version: String,
    pub tag_count: u32,
    pub computed_count: u32,
    pub skipped_count: u32,
    pub vector_fallback_count: u32,
    pub k_eff: u32,
    pub coverage: Vec<f64>,
    pub elapsed_ms: f64,
    pub phase_summary: String,
}

pub struct GeometryTask {
    pub(crate) dimensions: usize,
    pub(crate) db_path: String,
    pub(crate) model_sig: String,
    pub(crate) config_json: String,
}

struct LocalResult {
    id: i64,
    status: &'static str,
    count: usize,
    residual: f64,
}

impl GeometryTask {
    pub(crate) fn run(&self) -> std::result::Result<GeometryResult, String> {
        if self.model_sig.trim().is_empty() {
            return Err("geometry requires modelSig".into());
        }
        let started = Instant::now();
        let config: Value = serde_json::from_str(&self.config_json).map_err(|e| e.to_string())?;
        let local = config.get("local").unwrap_or(&config);
        let global = config.get("global").unwrap_or(&Value::Null);
        let max_neighbors = number(local, "maxNeighbors", 48.0, 1.0, 256.0) as usize;
        let min_neighbors = number(local, "minNeighbors", 3.0, 1.0, 256.0) as usize;
        let max_basis = number(local, "maxBasis", 4.0, 1.0, 32.0) as usize;
        let min_gain = number(local, "minGain", 0.015, 0.0, 1.0);
        let decay = number(local, "positionDecay", 0.15, 0.0, 4.0);
        let k_max = number(global, "kMax", 32.0, 1.0, 128.0) as usize;
        let k_sem = number(global, "kSem", 8.0, 1.0, k_max as f64) as usize;
        let mut signature_config = config.clone();
        if let Some(object) = signature_config.as_object_mut() {
            object.remove("forceRecompute");
        }
        let config_hash = hash(signature_config.to_string().as_bytes());

        // ── 读相：快照 facts/tags/file_tags，判缓存命中，装向量 ──
        let read_connection = open_readonly(&self.db_path)?;
        let mut digest = Sha256::new();
        let mut adjacency: BTreeMap<i64, BTreeMap<i64, f64>> = BTreeMap::new();
        let mut ids = Vec::new();
        let mut names = HashMap::new();
        let facts: String = read_connection
            .query_row(
                "SELECT value FROM kbm_runtime_meta WHERE key='memo_tag_facts'",
                [],
                |row| row.get(0),
            )
            .unwrap_or_else(|_| "0".to_string());
        let graph_generation = format!("facts:{facts}");
        {
            let mut statement = read_connection
                .prepare("SELECT id,name,vector_version FROM tags ORDER BY id")
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (id, name, version) = row.map_err(|e| e.to_string())?;
                digest.update(id.to_le_bytes());
                digest.update(version.to_le_bytes());
                digest.update((name.len() as u64).to_le_bytes());
                digest.update(name.as_bytes());
                ids.push(id);
                names.insert(id, name);
            }
        }
        let flush = |tags: &[(i64, i64)], graph: &mut BTreeMap<i64, BTreeMap<i64, f64>>| {
            if !(2..=100).contains(&tags.len()) {
                return;
            }
            for i in 0..tags.len() {
                for j in i + 1..tags.len() {
                    let (a, p) = tags[i];
                    let (b, q) = tags[j];
                    if a == b {
                        continue;
                    }
                    let delta = if p > 0 && q > 0 { (p - q).abs().max(1) as f64 } else { 1.0 };
                    let weight = (-decay * (delta - 1.0)).exp();
                    *graph.entry(a).or_default().entry(b).or_default() += weight;
                    *graph.entry(b).or_default().entry(a).or_default() += weight;
                }
            }
        };
        {
            let mut statement = read_connection
                .prepare("SELECT file_id,tag_id,COALESCE(position,0) FROM file_tags ORDER BY file_id,position,tag_id")
                .map_err(|e| e.to_string())?;
            let mut rows = statement.query([]).map_err(|e| e.to_string())?;
            let mut file = None;
            let mut tags = Vec::new();
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let fid: i64 = row.get(0).map_err(|e| e.to_string())?;
                let id: i64 = row.get(1).map_err(|e| e.to_string())?;
                let pos: i64 = row.get(2).map_err(|e| e.to_string())?;
                digest.update(fid.to_le_bytes());
                digest.update(id.to_le_bytes());
                digest.update(pos.to_le_bytes());
                if file != Some(fid) {
                    flush(&tags, &mut adjacency);
                    tags.clear();
                    file = Some(fid);
                }
                // Retain at most 101 entries: oversized files are skipped without unbounded memory.
                if tags.len() <= 100 {
                    tags.push((id, pos));
                }
            }
            flush(&tags, &mut adjacency);
        }
        let content = format!("{:x}", digest.finalize());
        let signature = hash(
            format!(
                "{}|{}|{}|{}|{}",
                ALGORITHM, self.dimensions, self.model_sig, config_hash, content
            )
            .as_bytes(),
        );
        let force = config
            .get("forceRecompute")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let cached: Option<Value> = if force {
            None
        } else {
            use rusqlite::OptionalExtension;
            let raw: Option<String> = read_connection
                .query_row(
                    "SELECT k.value FROM tagmemo_artifacts a JOIN kv_store k ON k.key='epa_basis_cache' \
                     WHERE a.asset_type='unified_geometry' AND a.artifact_sig=?1 \
                     AND a.graph_generation=?2 AND a.status='ready'",
                    params![signature, graph_generation],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            raw.and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .filter(|v| v["artifactSig"].as_str() == Some(signature.as_str()))
        };
        let load_ms = started.elapsed().as_secs_f64() * 1000.0;
        if let Some(cache) = cached {
            return Ok(GeometryResult {
                success: true,
                artifact_sig: signature,
                config_hash,
                algorithm_version: ALGORITHM.into(),
                tag_count: ids.len() as u32,
                computed_count: 0,
                skipped_count: ids.len() as u32,
                vector_fallback_count: 0,
                k_eff: cache["basis"].as_array().map_or(0, |b| b.len()) as u32,
                coverage: serde_json::from_value(cache["coverage"].clone()).unwrap_or_default(),
                elapsed_ms: load_ms,
                phase_summary: format!("cache_hit;load={load_ms:.3}ms"),
            });
        }
        let (vectors, fallback) = load_tag_vectors(&read_connection, &ids, self.dimensions)?;
        drop(read_connection);

        // ── 局部 Explain 相：每 Tag 的残差率 ──
        let mut offsets = vec![0];
        let mut edges = Vec::new();
        let mut support = Vec::new();
        for id in &ids {
            let neighbors = adjacency.remove(id).unwrap_or_default();
            support.push(neighbors.values().sum::<f64>());
            edges.extend(neighbors);
            offsets.push(edges.len());
        }
        drop(adjacency);
        let gate = local.get("semanticGate").unwrap_or(local);
        let gate_enabled = gate
            .get("enabled")
            .or_else(|| gate.get("semanticEnabled"))
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let peak = number(gate, "peak", number(local, "semanticPeak", 0.65, -1.0, 1.0), -1.0, 1.0);
        let sigma = number(gate, "sigma", number(local, "semanticSigma", 0.25, 0.02, 2.0), 0.02, 2.0);
        let floor = number(gate, "floor", number(local, "semanticFloor", 0.35, 0.0, 1.0), 0.0, 1.0);
        let hard_floor = number(gate, "hardFloor", number(local, "semanticHardFloor", -1.0, -1.0, 1.0), -1.0, 1.0);
        let results: Vec<LocalResult> = ids
            .iter()
            .enumerate()
            .map(|(i, id)| {
                let mut result = LocalResult { id: *id, status: "failed", count: 0, residual: 1.0 };
                let Some(target) = vectors.get(id) else { return result };
                let mut neighbors: Vec<_> = edges[offsets[i]..offsets[i + 1]]
                    .iter()
                    .filter(|(id, _)| vectors.contains_key(id))
                    .copied()
                    .collect();
                neighbors.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
                neighbors.truncate(max_neighbors);
                let mut candidates = Vec::new();
                let mut refs = Vec::new();
                for (nid, w) in neighbors {
                    let v = &vectors[&nid];
                    let sim = dot(target, v).clamp(-1.0, 1.0);
                    let semantic = semantic_weight(sim, gate_enabled, peak, sigma, floor, hard_floor);
                    if semantic > 0.0 {
                        candidates.push(AgsCandidate { id: nid, prior: w.ln_1p() * semantic });
                        refs.push(v.as_slice());
                    }
                }
                result.count = candidates.len();
                if result.count < min_neighbors {
                    result.status = "insufficient_neighbors";
                    return result;
                }
                let trace = select_axes(AgsTarget::Explain(target), &candidates, &refs, max_basis, min_gain);
                result.residual = trace.residual_norm.unwrap_or(1.0).clamp(0.0, 1.0);
                // Orthogonal targets correctly have residual=1, not a failed status.
                result.status = "computed";
                result
            })
            .collect();
        let local_ms = started.elapsed().as_secs_f64() * 1000.0 - load_ms;

        // ── 全局 Span 相：星团中心化 + 膝点截断 ──
        let mut mean = vec![0.0; self.dimensions];
        for id in &ids {
            if let Some(v) = vectors.get(id) {
                for (m, x) in mean.iter_mut().zip(v) {
                    *m += x;
                }
            }
        }
        if !vectors.is_empty() {
            for m in &mut mean {
                *m /= vectors.len() as f64;
            }
        }
        let min_support = number(global, "minSupport", 3.0, 0.0, 1e12);
        let a = number(global, "supportExponent", 0.65, 0.0, 4.0);
        let b = number(global, "residualExponent", 0.35, 0.0, 4.0);
        let prior_mode = global.get("priorMode").and_then(Value::as_str).unwrap_or("support");
        if !["support", "explained", "residual"].contains(&prior_mode) {
            return Err("geometry global.priorMode must be support, explained or residual".into());
        }
        let candidate_mode = global.get("candidateMode").and_then(Value::as_str).unwrap_or("star");
        if !["star", "anchor"].contains(&candidate_mode) {
            return Err("geometry global.candidateMode must be star or anchor".into());
        }
        let mut pool: Vec<_> = results
            .iter()
            .enumerate()
            .filter(|(i, r)| r.status == "computed" && support[*i] >= min_support)
            .map(|(i, r)| {
                let factor = match prior_mode {
                    "explained" => (1.0 - r.residual * r.residual).max(0.0).powf(b),
                    "residual" => r.residual.powf(b),
                    _ => 1.0,
                };
                AgsCandidate { id: r.id, prior: support[i].powf(a) * factor }
            })
            .collect();
        pool.sort_by(|a, b| b.prior.total_cmp(&a.prior).then(a.id.cmp(&b.id)));
        pool.truncate(number(global, "candidatePool", 512.0, 1.0, 4096.0) as usize);
        let star_neighbors = number(global, "starNeighbors", max_neighbors as f64, 1.0, 256.0) as usize;
        let mix = number(global, "starMix", 0.8, 0.0, 1.0);
        let centered: Vec<Vec<f64>> = pool
            .iter()
            .map(|c| {
                let target = &vectors[&c.id];
                let i = ids.binary_search(&c.id).unwrap();
                let mut neighbors: Vec<_> = edges[offsets[i]..offsets[i + 1]]
                    .iter()
                    .filter(|(id, _)| vectors.contains_key(id))
                    .copied()
                    .collect();
                neighbors.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
                neighbors.truncate(star_neighbors);
                let weighted: Vec<_> = neighbors
                    .iter()
                    .filter_map(|(id, w)| {
                        let v = &vectors[id];
                        let weight = w.ln_1p()
                            * semantic_weight(
                                dot(target, v).clamp(-1.0, 1.0),
                                gate_enabled,
                                peak,
                                sigma,
                                floor,
                                hard_floor,
                            );
                        (weight > 0.0).then_some((v.as_slice(), weight))
                    })
                    .collect();
                star_direction(target, &mean, &weighted, if candidate_mode == "star" { mix } else { 0.0 })
            })
            .collect();
        let refs: Vec<_> = centered.iter().map(Vec::as_slice).collect();
        let mut trace = anchored_gs(AgsTarget::Span, &pool, &refs, k_max, number(global, "minGain", 0.02, 0.0, 1.0));
        drop(refs);
        drop(centered);
        drop(pool);
        drop(edges);
        drop(offsets);
        drop(support);
        let global_ms = started.elapsed().as_secs_f64() * 1000.0 - load_ms - local_ms;
        // 串行归约（上游为线程数无关位级确定性做 par_chunks+串行求和；我方单线程同序累加，
        // 位级等价：同索引序的 f64 加法链一致）。
        let mut total = 0.0;
        let mut energies = vec![0.0; trace.basis.len()];
        for id in &ids {
            if let Some(v) = vectors.get(id) {
                let x: Vec<_> = v.iter().zip(&mean).map(|(v, m)| v - m).collect();
                total += dot(&x, &x);
                for (c, axis) in energies.iter_mut().zip(&trace.basis) {
                    *c += dot(&x, axis).powi(2);
                }
            }
        }
        drop(vectors);
        let mut cumulative = 0.0;
        let mut coverage: Vec<_> = energies
            .iter()
            .map(|e| {
                cumulative += e;
                if total > 1e-12 {
                    (cumulative / total).clamp(0.0, 1.0)
                } else {
                    0.0
                }
            })
            .collect();
        let full_coverage = coverage.clone();
        let k = effective_k(
            &coverage,
            k_sem,
            number(global, "epsilon", 0.1, 0.0, 1.0),
            number(global, "kneeDelta", 0.0, 0.0, 1.0),
        );
        trace.basis.truncate(k);
        trace.picked.truncate(k);
        energies.truncate(k);
        coverage.truncate(k);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        let cache = json!({
            "basis": trace.basis.iter().map(|v| encode_vector(v)).collect::<Vec<_>>(),
            "mean": encode_vector(&mean), "energies": energies, "coverage": coverage,
            "labels": trace.picked.iter().map(|(id, _)| names[id].clone()).collect::<Vec<_>>(),
            "anchorTagIds": trace.picked.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
            "totalEnergy": total, "kSem": k_sem, "kMax": k_max, "epaAlgorithm": "ags-global-star-v2",
            "candidateMode": candidate_mode, "priorMode": prior_mode, "fullCoverage": full_coverage,
            "artifactSig": signature, "tagCount": ids.len(), "timestamp": now
        })
        .to_string();
        let coverage_ms = started.elapsed().as_secs_f64() * 1000.0 - load_ms - local_ms - global_ms;
        let computed = results.iter().filter(|r| r.status == "computed").count();
        let anchor = local.get("anchorGain").unwrap_or(local);
        let base = number(anchor, "base", number(local, "v9AnchorBase", 0.75, 0.0, 4.0), 0.0, 4.0);
        let scale = number(anchor, "scale", number(local, "v9AnchorScale", 1.25, 0.0, 4.0), 0.0, 4.0);
        let gamma = number(anchor, "gamma", number(local, "v9AnchorGamma", 1.0, 0.1, 8.0), 0.1, 8.0);
        let low = number(anchor, "min", number(local, "v9AnchorMin", 0.5, 0.0, 4.0), 0.0, 4.0);
        let high = number(anchor, "max", number(local, "v9AnchorMax", 2.0, 0.0, 8.0), 0.0, 8.0);

        // ── 写相：单事务（keepalive 由 open_readwrite 保证，BUG-0930 契约）──
        let mut write_connection = open_readwrite(&self.db_path)?;
        let transaction = write_connection
            .transaction()
            .map_err(|e| format!("geometry begin transaction failed: {}", e))?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS kbm_runtime_meta(key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL); \
                 INSERT OR IGNORE INTO kbm_runtime_meta(key,value) VALUES \
                 ('schema_version','1'),('database_generation','0'),('derived_geometry','0');",
            )
            .map_err(|e| e.to_string())?;
        // execute_batch 不支持参数绑定，memo_tag_facts 单独带参写入。
        transaction
            .execute(
                "INSERT OR IGNORE INTO kbm_runtime_meta(key,value) VALUES ('memo_tag_facts',?1)",
                params![facts],
            )
            .map_err(|e| e.to_string())?;
        let delete_started = Instant::now();
        transaction
            .execute_batch("DELETE FROM tag_intrinsic_residuals; DELETE FROM tag_intrinsic_residual_status;")
            .map_err(|e| e.to_string())?;
        let delete_ms = delete_started.elapsed().as_secs_f64() * 1000.0;
        let insert_started = Instant::now();
        {
            let mut values = transaction
                .prepare_cached(
                    "INSERT INTO tag_intrinsic_residuals \
                     (tag_id,residual_energy,neighbor_count,raw_residual_ratio,v8_3_compat_gain,v9_anchor_gain,model_sig,artifact_sig,algorithm_version,config_hash,status) \
                     VALUES (?1,?2,?3,?4,NULL,?2,?5,?6,?7,?8,'computed')",
                )
                .map_err(|e| e.to_string())?;
            let mut status = transaction
                .prepare_cached(
                    "INSERT INTO tag_intrinsic_residual_status \
                     (tag_id,artifact_sig,status,neighbor_count,error_message,computed_at) VALUES (?1,?2,?3,?4,NULL,?5)",
                )
                .map_err(|e| e.to_string())?;
            for r in results {
                if r.status == "computed" {
                    let gain = (base + scale * r.residual.powf(gamma)).clamp(low.min(high), low.max(high));
                    values
                        .execute(params![r.id, gain, r.count as i64, r.residual, self.model_sig, signature, ALGORITHM, config_hash])
                        .map_err(|e| e.to_string())?;
                } else {
                    // Success is represented by the value row; status contains exceptions only.
                    status
                        .execute(params![r.id, signature, r.status, r.count as i64, now])
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        let insert_ms = insert_started.elapsed().as_secs_f64() * 1000.0;
        let metadata_started = Instant::now();
        transaction
            .execute(
                "INSERT OR REPLACE INTO kv_store(key,value) VALUES ('epa_basis_cache',?1)",
                params![cache],
            )
            .map_err(|e| e.to_string())?;
        transaction
            .execute(
                "INSERT OR REPLACE INTO tagmemo_artifacts \
                 (artifact_sig,asset_type,model_sig,graph_generation,algorithm_version,config_hash,effective_config,status,created_at,updated_at) \
                 VALUES (?1,'unified_geometry',?2,?7,?3,?4,?5,'ready',?6,?6)",
                params![signature, self.model_sig, ALGORITHM, config_hash, self.config_json, now, graph_generation],
            )
            .map_err(|e| e.to_string())?;
        transaction
            .execute(
                "DELETE FROM tagmemo_artifacts WHERE asset_type='unified_geometry' AND artifact_sig!=?1",
                params![signature],
            )
            .map_err(|e| e.to_string())?;
        transaction
            .execute(
                "UPDATE kbm_runtime_meta SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='derived_geometry'",
                [],
            )
            .map_err(|e| e.to_string())?;
        let metadata_ms = metadata_started.elapsed().as_secs_f64() * 1000.0;
        transaction
            .commit()
            .map_err(|e| format!("geometry commit failed: {}", e))?;
        drop(write_connection);
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        Ok(GeometryResult {
            success: true,
            artifact_sig: signature,
            config_hash,
            algorithm_version: ALGORITHM.into(),
            tag_count: ids.len() as u32,
            computed_count: computed as u32,
            skipped_count: (ids.len() - computed) as u32,
            vector_fallback_count: fallback as u32,
            k_eff: k as u32,
            coverage,
            elapsed_ms: elapsed,
            phase_summary: format!(
                "load={load_ms:.3};local={local_ms:.3};global={global_ms:.3};coverage={coverage_ms:.3};delete={delete_ms:.3};insert={insert_ms:.3};metadata={metadata_ms:.3}"
            ),
        })
    }
}

impl Task for GeometryTask {
    type Output = GeometryResult;
    type JsValue = GeometryResult;
    fn compute(&mut self) -> Result<Self::Output> {
        self.run().map_err(Error::from_reason)
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_nested_and_orthogonal() {
        let vectors: Vec<Vec<f64>> = (0..32)
            .map(|i| {
                let mut v = vec![0.0; 32];
                v[i] = 1.0;
                v
            })
            .collect();
        let refs: Vec<_> = vectors.iter().map(Vec::as_slice).collect();
        let candidates: Vec<_> = (0..32).map(|i| AgsCandidate { id: i, prior: 1.0 }).collect();
        let short = anchored_gs(AgsTarget::Span, &candidates, &refs, 8, 0.0);
        let long = anchored_gs(AgsTarget::Span, &candidates, &refs, 32, 0.0);
        assert_eq!(short.basis, long.basis[..8]);
        assert_eq!(short.picked, long.picked[..8]);
        for (i, a) in long.basis.iter().enumerate() {
            for (j, b) in long.basis.iter().enumerate() {
                assert!((dot(a, b) - if i == j { 1.0 } else { 0.0 }).abs() < 1e-12);
            }
        }
    }

    #[test]
    fn gram_matches_direct_residual_and_local_semantics() {
        let candidates = [AgsCandidate { id: 2, prior: 1.0 }, AgsCandidate { id: 1, prior: 1.0 }];
        let a = [1.0, 0.0, 0.0];
        let b = [0.6, 0.8, 0.0];
        for target in [[0.6, 0.8, 0.0], [0.0, 0.0, 1.0], [0.3, 0.4, 0.8660254037844386]] {
            let trace = anchored_gs(AgsTarget::Explain(&target), &candidates, &[&a, &b], 2, 0.0);
            let mut residual = target;
            for axis in &trace.basis {
                let c = dot(&target, axis);
                for (r, x) in residual.iter_mut().zip(axis) {
                    *r -= c * x;
                }
            }
            assert!((trace.residual_norm.unwrap() - dot(&residual, &residual).sqrt()).abs() < 1e-9);
        }
    }

    #[test]
    fn star_mixture_is_count_scale_invariant_and_cancels_neighbor_noise() {
        let target = [1.0, 0.0, 0.0];
        let a = [0.8, 0.6, 0.0];
        let b = [0.8, -0.6, 0.0];
        let mean = [0.0; 3];
        let first = star_direction(&target, &mean, &[(&a, 2.0), (&b, 2.0)], 0.75);
        let second = star_direction(&target, &mean, &[(&a, 200.0), (&b, 200.0)], 0.75);
        assert_eq!(first, second);
        assert!((first[0] - 1.0).abs() < 1e-12);
        assert!(first[1].abs() < 1e-12);
        assert_eq!(star_direction(&target, &mean, &[], 1.0), target);
        assert_eq!(star_direction(&target, &mean, &[(&[-1.0, 0.0, 0.0], 1.0)], 0.5), target);
    }

    fn full_gram_selection(
        target: Option<&[f64]>,
        candidates: &[AgsCandidate],
        vectors: &[&[f64]],
        max_basis: usize,
        min_gain: f64,
    ) -> AgsTrace {
        let diagonal: Vec<f64> = vectors.iter().map(|v| dot(v, v)).collect();
        let correlations: Vec<f64> =
            target.map_or(Vec::new(), |t| vectors.iter().map(|v| dot(t, v)).collect());
        let target_data = target.map(|t| (correlations.as_slice(), dot(t, t)));
        select_axes_full(candidates, vectors, &diagonal, target_data, max_basis, min_gain)
    }

    fn trace_bits(trace: &AgsTrace) -> (Vec<(i64, u64)>, Vec<Vec<u64>>, Option<u64>) {
        (
            trace.picked.iter().map(|(id, gain)| (*id, gain.to_bits())).collect(),
            trace.basis.iter().map(|axis| axis.iter().map(|v| v.to_bits()).collect()).collect(),
            trace.residual_norm.map(f64::to_bits),
        )
    }

    #[test]
    fn lazy_gram_columns_match_full_gram_bits() {
        let mut state = 0x2545_f491_4f6c_dd1d_u64;
        let mut next = move || {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((state >> 11) as f64) / ((1u64 << 53) as f64) - 0.5
        };
        for (n, dim, max_basis, min_gain) in [(3, 8, 4, 0.015), (48, 64, 4, 0.015), (60, 24, 32, 0.0)] {
            for round in 0..20 {
                let shared: Vec<f64> = (0..dim).map(|_| next()).collect();
                let mut vectors: Vec<Vec<f64>> = (0..n)
                    .map(|_| {
                        let weight = next() * 4.0;
                        let mut v: Vec<f64> = shared.iter().map(|s| next() + weight * s).collect();
                        normalize(&mut v);
                        v
                    })
                    .collect();
                if round % 4 == 0 && n > 2 {
                    vectors[1] = vectors[0].clone(); // exact duplicate
                }
                let refs: Vec<&[f64]> = vectors.iter().map(Vec::as_slice).collect();
                let candidates: Vec<AgsCandidate> = (0..n)
                    .map(|i| AgsCandidate { id: ((i * 7) % n) as i64, prior: next() + 0.5 })
                    .collect();
                let mut target: Vec<f64> = shared.iter().map(|s| next() + s).collect();
                normalize(&mut target);
                for explain in [Some(target.as_slice()), None] {
                    let ags_target = explain.map_or(AgsTarget::Span, AgsTarget::Explain);
                    let lazy = select_axes(ags_target, &candidates, &refs, max_basis, min_gain);
                    let full = full_gram_selection(explain, &candidates, &refs, max_basis, min_gain);
                    assert_eq!(trace_bits(&lazy), trace_bits(&full));
                }
            }
        }
    }

    #[test]
    fn overflowing_gram_falls_back_to_full_gram() {
        // The middle candidate never qualifies, but its Gram entries overflow.
        let vectors = [[2.0, 0.0], [1e308, 1e308], [0.0, 4.0]];
        let refs: Vec<&[f64]> = vectors.iter().map(|v| v.as_slice()).collect();
        let candidates = [
            AgsCandidate { id: 1, prior: 1.0 },
            AgsCandidate { id: 2, prior: 0.0 },
            AgsCandidate { id: 3, prior: 1.0 },
        ];
        let diagonal: Vec<f64> = refs.iter().map(|v| dot(v, v)).collect();
        assert!(select_axes_lazy(&candidates, &refs, &diagonal, None, 3, 0.0).is_none());
        let selected = select_axes(AgsTarget::Span, &candidates, &refs, 3, 0.0);
        let full = full_gram_selection(None, &candidates, &refs, 3, 0.0);
        assert_eq!(trace_bits(&selected), trace_bits(&full));
    }

    #[test]
    fn epsilon_and_knee_respect_semantic_prefix() {
        assert_eq!(effective_k(&[0.4, 0.8, 1.0, 1.0], 2, 0.1, 0.005), 3);
        assert_eq!(effective_k(&[0.99, 0.991, 0.992], 3, 0.1, 0.005), 3);
        assert_eq!(effective_k(&[], 8, 0.1, 0.005), 0);
    }
}

#[cfg(test)]
mod task_tests {
    use super::*;
    use rusqlite::Connection;

    fn fixture_db() -> String {
        let root = std::env::temp_dir().join(format!(
            "ags-task-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let db = root.join("test.sqlite").to_string_lossy().into_owned();
        let connection = Connection::open(&db).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE tags(id INTEGER PRIMARY KEY, name TEXT, vector BLOB, vector_version INTEGER NOT NULL DEFAULT 1); \
                 CREATE TABLE file_tags(file_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, position INTEGER NOT NULL DEFAULT 0); \
                 CREATE TABLE kv_store(key TEXT PRIMARY KEY, value TEXT); \
                 CREATE TABLE tagmemo_artifacts(artifact_sig TEXT PRIMARY KEY, asset_type TEXT, model_sig TEXT, graph_generation TEXT, algorithm_version TEXT, config_hash TEXT, effective_config TEXT, status TEXT DEFAULT 'ready', created_at INTEGER, updated_at INTEGER); \
                 CREATE TABLE tag_intrinsic_residuals(tag_id INTEGER PRIMARY KEY, residual_energy REAL NOT NULL, neighbor_count INTEGER NOT NULL, computed_at TEXT NOT NULL DEFAULT (datetime('now')), raw_residual_ratio REAL, v8_3_compat_gain REAL, v9_anchor_gain REAL, model_sig TEXT, artifact_sig TEXT, algorithm_version TEXT, config_hash TEXT, status TEXT NOT NULL DEFAULT 'computed'); \
                 CREATE TABLE tag_intrinsic_residual_status(tag_id INTEGER NOT NULL, artifact_sig TEXT NOT NULL, status TEXT NOT NULL, neighbor_count INTEGER NOT NULL DEFAULT 0, error_message TEXT, computed_at INTEGER NOT NULL, PRIMARY KEY(tag_id, artifact_sig));",
            )
            .unwrap();
        for i in 0..6i64 {
            let angle = i as f32 * 0.5;
            let bytes: Vec<u8> = [angle.cos(), angle.sin(), 0.2]
                .iter()
                .flat_map(|x| x.to_le_bytes())
                .collect();
            connection
                .execute(
                    "INSERT INTO tags(id,name,vector) VALUES (?1,?2,?3)",
                    params![i + 1, format!("tag-{i}"), bytes],
                )
                .unwrap();
            connection
                .execute("INSERT INTO file_tags VALUES (1,?1,?1)", params![i + 1])
                .unwrap();
        }
        drop(connection);
        db
    }

    #[test]
    fn task_is_deterministic_and_cache_hits() {
        let db = fixture_db();
        let task = GeometryTask {
            dimensions: 3,
            db_path: db.clone(),
            model_sig: "test".into(),
            config_json: r#"{"forceRecompute":true,"global":{"minSupport":0,"residualExponent":0,"kSem":2}}"#.into(),
        };
        let first = task.run().unwrap();
        assert_eq!(first.algorithm_version, "unified_geometry_ags_v2");
        assert_eq!(first.vector_fallback_count, 6);
        assert!(first.k_eff > 0);
        assert!(first.coverage.windows(2).all(|w| w[0] <= w[1]));
        assert!(first.coverage.iter().all(|c| *c <= 1.0));
        // 第二次同 force 跑：签名与缓存逐字节一致（去掉 timestamp）。
        let second = task.run().unwrap();
        assert_eq!(first.artifact_sig, second.artifact_sig);
        let read_cache = |conn: &Connection| -> Value {
            let raw: String = conn
                .query_row("SELECT value FROM kv_store WHERE key='epa_basis_cache'", [], |r| r.get(0))
                .unwrap();
            let mut value: Value = serde_json::from_str(&raw).unwrap();
            value.as_object_mut().unwrap().remove("timestamp");
            value
        };
        let c1 = {
            let conn = Connection::open(&db).unwrap();
            read_cache(&conn)
        };
        // 去 force 后应命中缓存（skipped=tag_count、不重算）。
        let cache_task = GeometryTask {
            config_json: r#"{"global":{"minSupport":0,"residualExponent":0,"kSem":2}}"#.into(),
            ..GeometryTask {
                dimensions: 3,
                db_path: db.clone(),
                model_sig: "test".into(),
                config_json: String::new(),
            }
        };
        let cached = cache_task.run().unwrap();
        assert_eq!(cached.skipped_count, 6);
        assert_eq!(cached.computed_count, 0);
        assert_eq!(cached.artifact_sig, first.artifact_sig);
        let c2 = {
            let conn = Connection::open(&db).unwrap();
            read_cache(&conn)
        };
        assert_eq!(c1, c2);
        // 残差表：6 行 computed，v9_anchor_gain == residual_energy（同 clamp 值约定）。
        {
            let conn = Connection::open(&db).unwrap();
            let rows: Vec<(f64, Option<f64>, f64)> = conn
                .prepare("SELECT residual_energy, v8_3_compat_gain, v9_anchor_gain FROM tag_intrinsic_residuals")
                .unwrap()
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .map(|r| r.unwrap())
                .collect();
            assert_eq!(rows.len(), 6);
            for (energy, compat, gain) in rows {
                assert!(compat.is_none(), "v8_3_compat_gain 必须写 NULL");
                assert!((energy - gain).abs() < 1e-15, "v9_anchor_gain 应等于 gain 值");
            }
        }
        let _ = std::fs::remove_file(&db);
    }
}
