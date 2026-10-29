//! topology_scoring —— P3.5/P3.6：RiverMemo 读出心脏，对齐上游 9aa1f67
//! conservative-topology-v2.5-confidence-rrf（评分方程换代 + 虫洞 RRF）。
//!
//! 规格来源 = kernel/docs/reverse-conservative-v2.5.md（396 行契约）+
//! 上游 rust-vexus-lite/src/rivermemo_topology_v3.rs（9aa1f67，3891 行）逐段对照。
//! 方程：S = clip[0,1](B + P + G + A) 四项独立记账——
//!   B = 基础分（query 余弦）+ 场共振封顶增益（≤0.03，先 min 后乘 support）；
//!   P = 路径证据（不乘 Ω），G = 图证据（乘 Ω^γ），P+G ≤ C_T=0.08 共享预算；
//!   A = 锚绝对激活奖励（smoothstep，上限 C_A=0.10），与同伴无关。
//! 批级同伴创新奖励取消（retiredControls 11 项回执）。
//! 虫洞：严格全局准入（双标签双文件 + 第三标签桥 + 异校验和）→
//! explanation-weighted RRF 融合（K=60），无正贡献时基线位级不动。
//!
//! 与上游的刻意差异（均不进判据面）：
//! - 不移植 CosineCache（位级等价的纯缓存，直接调 cosine）；
//! - observation 恢复不预填 TagVectorPool、无 database_generation 陈旧检查
//!   （壳 MemoQueryObservation 无这两个字段；池向量与 DB 同源，数值等价）。

use crate::memo_vector_pool::{ensure_tag_vectors_loaded, TagVectorPool};
use crate::rivermemo_topology_v3::{
    clamp01, load_artifact_from_runtime, positive, MemoRuntime, NativeArtifact,
};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use rayon::prelude::*;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[path = "rivermemo_wormhole.rs"]
mod wormhole;

const RESULT_SCHEMA: &str = "rivermemo-topology-v3-native-result-v1";
const ALGORITHM_VERSION: &str = "rivermemo.conservative-topology-v2.5-confidence-rrf";

fn open_readonly(path: &str) -> std::result::Result<Connection, String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("open readonly SQLite failed: {}", error))?;
    connection
        .busy_timeout(Duration::from_secs(30))
        .map_err(|error| format!("configure SQLite timeout failed: {}", error))?;
    connection
        .pragma_update(None, "query_only", "ON")
        .map_err(|error| format!("configure SQLite query_only failed: {}", error))?;
    Ok(connection)
}

fn cosine(left: &[f32], right: &[f32]) -> f64 {
    if left.len() != right.len() || left.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0;
    let mut left_norm = 0.0;
    let mut right_norm = 0.0;
    for index in 0..left.len() {
        let a = left[index] as f64;
        let b = right[index] as f64;
        dot += a * b;
        left_norm += a * a;
        right_norm += b * b;
    }
    cosine_from_parts(dot, left_norm, right_norm)
}

fn cosine_from_parts(dot: f64, left_norm: f64, right_norm: f64) -> f64 {
    if left_norm > 1e-15 && right_norm > 1e-15 {
        dot / (left_norm.sqrt() * right_norm.sqrt())
    } else {
        0.0
    }
}

/// The three accumulators in `cosine` are independent, so computing each one
/// separately in the same index order yields the same bits.
fn squared_norm(vector: &[f32]) -> f64 {
    let mut total = 0.0;
    for value in vector {
        let value = *value as f64;
        total += value * value;
    }
    total
}

fn decode_vector(bytes: &[u8], dimension: usize) -> Option<Vec<f32>> {
    if bytes.len() != dimension * std::mem::size_of::<f32>() {
        return None;
    }
    Some(
        bytes
            .chunks_exact(4)
            .map(|chunk| f32::from_ne_bytes(chunk.try_into().unwrap()))
            .collect(),
    )
}

fn default_top_k() -> usize {
    10
}

fn default_dimension() -> usize {
    3072
}

fn default_true() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeInput {
    #[serde(default)]
    observation_handle: Option<String>,
    #[serde(default = "default_dimension")]
    dimension: usize,
    #[serde(default = "default_top_k")]
    top_k: usize,
    #[serde(default)]
    include_trace: bool,
    query: QueryInput,
    #[serde(default)]
    denoised_vector: Vec<f32>,
    #[serde(default)]
    local_vector: Vec<f32>,
    #[serde(default)]
    transfer_vector: Vec<f32>,
    #[serde(default)]
    candidates: Vec<CandidateInput>,
    query_state: QueryStateInput,
    #[serde(default)]
    allowed_file_ids: Option<Vec<i64>>,
    #[serde(default)]
    config: NativeConfig,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueryInput {
    #[serde(default, rename = "text")]
    _text: String,
    #[serde(default)]
    vector: Vec<f32>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CandidateInput {
    id: i64,
    #[serde(default)]
    score: f64,
    #[serde(default)]
    hybrid_score: f64,
    #[serde(default)]
    vector_score: f64,
    #[serde(default)]
    bm25_score: f64,
    #[serde(default)]
    time_score: f64,
    #[serde(default)]
    anchor_score: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueryStateInput {
    #[serde(default)]
    query_id: Option<String>,
    #[serde(default)]
    source_field: Vec<(i64, f64)>,
    #[serde(default)]
    local_field: Vec<(i64, f64)>,
    #[serde(default)]
    transfer_field: Vec<(i64, f64)>,
    #[serde(default)]
    local_domain_ids: Vec<i64>,
    #[serde(default)]
    transfer_domain_ids: Vec<i64>,
    #[serde(default)]
    river_nodes: Vec<RiverNode>,
    #[serde(default)]
    river_edges: Vec<RiverEdge>,
    #[serde(default)]
    field_provenance: Vec<SourceProvenance>,
    #[serde(default = "default_true")]
    complete_observation: bool,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RiverNode {
    id: i64,
    #[serde(default)]
    energy: f64,
    #[serde(default)]
    normalized_energy: f64,
    #[serde(default)]
    hop: i64,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RiverEdge {
    source_id: i64,
    target_id: i64,
    #[serde(default)]
    flow: f64,
    #[serde(default)]
    normalized_flow: f64,
    #[serde(default)]
    wormhole: bool,
    #[serde(default)]
    immediate_return: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceProvenance {
    id: i64,
    #[serde(default)]
    hop: i64,
    #[serde(default)]
    source_type: String,
}

#[derive(Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct NativeConfig {
    query_k: usize,
    denoised_k: usize,
    local_field_k: usize,
    transfer_field_k: usize,
    bm25_k: usize,
    anchor_k: usize,
    max_union_candidates: usize,
    local_weight: f64,
    transfer_weight: f64,
    direction_floor: f64,
    closure_floor: f64,
    semantic_node_threshold: f64,
    relative_distance_temperature: f64,
    reverse_direction_credit: f64,
    minimum_river_edge_flow: f64,
    maximum_river_edges: usize,
    node_only_reliability_cap: f64,
    kappa_edge: f64,
    kappa_ratio: f64,
    omega_epsilon: f64,
    collapsed_threshold: f64,
    sparse_threshold: f64,
    semantic_anchor_threshold: f64,
    semantic_anchor_discount: f64,
    specificity_floor: f64,
    rarity_floor: f64,
    reliability_seed_saturation: f64,
    fallback_reliability_cap: f64,
    pure_query_weight: f64,
    pure_local_weight: f64,
    pure_transfer_weight: f64,
    topology_bonus_cap: f64,
    topology_path_saturation: f64,
    conditional_bandwidth: f64,
    conditional_closure_bandwidth: f64,
    conditional_direct_bandwidth: f64,
    minimum_peers: usize,
    minimum_effective_peers: f64,
    innovation_confidence_z: f64,
    innovation_scale: f64,
    omega_gamma: f64,
    struct_role_min_omega: f64,
    anchor_bonus_cap: f64,
    anchor_activation_z: f64,
    anchor_activation_floor: f64,
    anchor_saturation: f64,
    anchor_frontier_contrast: f64,
    anchor_frontier_abs_floor: f64,
}

impl Default for NativeConfig {
    fn default() -> Self {
        Self {
            query_k: 100,
            denoised_k: 100,
            local_field_k: 100,
            transfer_field_k: 100,
            bm25_k: 50,
            anchor_k: 50,
            max_union_candidates: 300,
            local_weight: 0.6,
            transfer_weight: 0.4,
            direction_floor: 0.05,
            closure_floor: 0.0,
            semantic_node_threshold: 0.48,
            relative_distance_temperature: 0.35,
            reverse_direction_credit: 0.25,
            minimum_river_edge_flow: 0.015,
            maximum_river_edges: 96,
            node_only_reliability_cap: 0.2,
            kappa_edge: 0.5,
            kappa_ratio: 0.3,
            omega_epsilon: 0.02,
            collapsed_threshold: 0.12,
            sparse_threshold: 0.45,
            semantic_anchor_threshold: 0.88,
            semantic_anchor_discount: 0.7,
            specificity_floor: 0.35,
            rarity_floor: 0.15,
            reliability_seed_saturation: 2.0,
            fallback_reliability_cap: 0.5,
            pure_query_weight: 0.7,
            pure_local_weight: 0.2,
            pure_transfer_weight: 0.1,
            topology_bonus_cap: 0.08,
            topology_path_saturation: 0.15,
            conditional_bandwidth: 0.04,
            conditional_closure_bandwidth: 0.1,
            conditional_direct_bandwidth: 0.12,
            minimum_peers: 3,
            minimum_effective_peers: 2.5,
            innovation_confidence_z: 1.0,
            innovation_scale: 0.5,
            omega_gamma: 1.0,
            struct_role_min_omega: 0.12,
            anchor_bonus_cap: 0.1,
            anchor_activation_z: 2.0,
            anchor_activation_floor: 0.05,
            anchor_saturation: 0.2,
            anchor_frontier_contrast: 2.0,
            anchor_frontier_abs_floor: 0.1,
        }
    }
}

#[derive(Clone)]
struct TagData {
    id: i64,
    name: String,
    position: i64,
    /// 同一 Tag 在所有候选曲线间共享同一份解码向量，只做引用计数克隆。
    vector: Arc<[f32]>,
    chunk_cosine: f64,
}

#[derive(Clone)]
struct Curve {
    id: i64,
    file_id: i64,
    tags: Vec<TagData>,
    chunk_vector: Arc<[f32]>,
    query_score: f64,
    denoised_score: f64,
    local_score: f64,
    transfer_score: f64,
    bm25_score: f64,
    time_score: f64,
    anchor_score: f64,
    union_score: f64,
    union_rank: usize,
    sources: Vec<String>,
}

/// Tag rows of one file in position order: (Tag ID, position, name).
type FileTagRows = HashMap<i64, Vec<(i64, i64, String)>>;

struct CurveLoadOutput {
    /// Candidate curves without Tags; `attach_tags` adds them after selection.
    curves: Vec<Curve>,
    relations: FileTagRows,
    chunk_sql_batches: usize,
    file_tag_sql_batches: usize,
}

/// Attaches each curve's Tags in position order, keeping only Tags whose vector
/// is in the pool: missing or invalid vector rows are never loaded, so they are
/// dropped exactly as before.
fn attach_tags(curves: &mut [Curve], relations: &FileTagRows, tag_vectors: &TagVectorPool) {
    for curve in curves {
        let chunk_vector = curve.chunk_vector.clone();
        curve.tags = relations
            .get(&curve.file_id)
            .into_iter()
            .flatten()
            .filter_map(|(id, position, name)| {
                let vector = tag_vectors.get(id)?;
                Some(TagData {
                    id: *id,
                    position: *position,
                    name: name.clone(),
                    vector: vector.clone(),
                    chunk_cosine: clamp01(cosine(vector, &chunk_vector)),
                })
            })
            .collect();
    }
}

fn load_curves(
    connection: &Connection,
    candidates: &[CandidateInput],
    dimension: usize,
) -> std::result::Result<CurveLoadOutput, String> {
    const SQLITE_BATCH_SIZE: usize = 500;
    let candidate_ids: Vec<i64> = candidates
        .iter()
        .map(|candidate| candidate.id)
        .filter(|id| *id > 0)
        .collect();
    let mut chunks_by_id: HashMap<i64, (i64, Arc<[f32]>)> =
        HashMap::with_capacity(candidate_ids.len());
    let mut unique_file_ids = HashSet::new();

    let mut chunk_sql_batches = 0usize;
    // Chunk 向量按 ID 分块读取；候选池不再产生逐候选 SQL。
    for batch in candidate_ids.chunks(SQLITE_BATCH_SIZE) {
        if batch.is_empty() {
            continue;
        }
        chunk_sql_batches += 1;
        let placeholders = std::iter::repeat("?")
            .take(batch.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT id, file_id, vector FROM chunks WHERE id IN ({})",
            placeholders
        );
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| format!("prepare batched chunk projection failed: {}", error))?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(batch.iter()), |row| {
                let bytes: Vec<u8> = row.get(2)?;
                Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, bytes))
            })
            .map_err(|error| format!("query batched chunk projection failed: {}", error))?;
        for row in rows {
            // 与旧逐候选实现保持行级故障隔离：单条脏记录不能拖垮
            // 整个候选批次；prepare/query 级数据库错误仍在上方显式返回。
            let Ok((id, file_id, bytes)) = row else {
                continue;
            };
            let Some(vector) = decode_vector(&bytes, dimension) else {
                continue;
            };
            unique_file_ids.insert(file_id);
            chunks_by_id.insert(id, (file_id, Arc::from(vector)));
        }
    }

    // 同一文件的 Tag 关系只读取一次，供该文件的全部候选 Chunk 复用；
    // Tag 向量在候选筛选之后才读取（见 attach_tags）。
    let file_ids: Vec<i64> = unique_file_ids.into_iter().collect();
    let mut relations: FileTagRows = HashMap::with_capacity(file_ids.len());
    let mut file_tag_sql_batches = 0usize;
    for batch in file_ids.chunks(SQLITE_BATCH_SIZE) {
        if batch.is_empty() {
            continue;
        }
        file_tag_sql_batches += 1;
        let placeholders = std::iter::repeat("?")
            .take(batch.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT ft.file_id, ft.tag_id, COALESCE(ft.position, 0), t.name \
             FROM file_tags ft JOIN tags t ON t.id = ft.tag_id \
             WHERE ft.file_id IN ({}) \
             ORDER BY ft.file_id, ft.position, ft.tag_id",
            placeholders
        );
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| format!("prepare batched tag curve projection failed: {}", error))?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(batch.iter()), |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|error| format!("query batched tag curve projection failed: {}", error))?;
        for row in rows {
            // 旧实现通过 rows.flatten() 跳过单条 Tag 行解码错误。
            // 批量化后保留同一容错边界，避免一条脏 Tag 污染整次查询。
            let Ok((file_id, tag_id, position, name)) = row else { continue };
            relations.entry(file_id).or_default().push((tag_id, position, name));
        }
    }

    // 恢复原始候选顺序；稳定排序与旧实现完全一致。
    let mut curves = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let Some((file_id, chunk_vector)) = chunks_by_id.get(&candidate.id) else {
            continue;
        };
        curves.push(Curve {
            id: candidate.id,
            file_id: *file_id,
            tags: Vec::new(),
            chunk_vector: chunk_vector.clone(),
            query_score: 0.0,
            denoised_score: 0.0,
            local_score: 0.0,
            transfer_score: 0.0,
            bm25_score: positive(candidate.bm25_score),
            time_score: positive(candidate.time_score),
            anchor_score: positive(candidate.anchor_score),
            union_score: 0.0,
            union_rank: 0,
            sources: Vec::new(),
        });
    }
    Ok(CurveLoadOutput {
        curves,
        relations,
        chunk_sql_batches,
        file_tag_sql_batches,
    })
}

/// `hits(curve)`: the curve's Tags with a vector that lie in the local domain.
fn compute_anchor_scores(curves: &mut [Curve], hits: impl Fn(&Curve) -> usize) {
    let max_hits = curves.iter().map(&hits).max().unwrap_or(0);
    if max_hits == 0 {
        return;
    }
    for curve in curves {
        let hits = hits(curve);
        curve.anchor_score = curve.anchor_score.max(hits as f64 / max_hits as f64);
    }
}

fn source_top(curves: &[Curve], field: fn(&Curve) -> f64, limit: usize) -> Vec<(i64, f64, usize)> {
    let mut ranked: Vec<(i64, f64)> = curves
        .iter()
        .map(|curve| (curve.id, field(curve)))
        .filter(|item| item.1.is_finite() && item.1 > 0.0)
        .collect();
    ranked.sort_by(|left, right| {
        right
            .1
            .partial_cmp(&left.1)
            .unwrap_or(Ordering::Equal)
            .then_with(|| left.0.cmp(&right.0))
    });
    ranked
        .into_iter()
        .take(limit.max(1))
        .enumerate()
        .map(|(index, item)| (item.0, item.1, index + 1))
        .collect()
}

fn select_superset(curves: Vec<Curve>, config: &NativeConfig) -> Vec<Curve> {
    let sources = vec![
        (
            "query_knn",
            source_top(&curves, |curve| curve.query_score, config.query_k),
        ),
        (
            "denoised_field_knn",
            source_top(&curves, |curve| curve.denoised_score, config.denoised_k),
        ),
        (
            "local_field_knn",
            source_top(&curves, |curve| curve.local_score, config.local_field_k),
        ),
        (
            "transfer_field_knn",
            source_top(
                &curves,
                |curve| curve.transfer_score,
                config.transfer_field_k,
            ),
        ),
        (
            "bm25",
            source_top(&curves, |curve| curve.bm25_score, config.bm25_k),
        ),
        (
            "time",
            source_top(&curves, |curve| curve.time_score, config.query_k),
        ),
        (
            "anchor_direct",
            source_top(&curves, |curve| curve.anchor_score, config.anchor_k),
        ),
    ];

    let mut source_map: HashMap<i64, Vec<(String, f64, usize)>> = HashMap::new();
    for (name, ranked) in sources {
        if ranked.is_empty() {
            continue;
        }
        let minimum = ranked
            .iter()
            .map(|entry| entry.1)
            .fold(f64::INFINITY, f64::min);
        let maximum = ranked
            .iter()
            .map(|entry| entry.1)
            .fold(f64::NEG_INFINITY, f64::max);
        let spread = maximum - minimum;
        for (id, raw_score, rank) in ranked {
            let normalized = if spread > 1e-12 {
                clamp01((raw_score - minimum) / spread)
            } else {
                clamp01(1.0 / rank as f64)
            };
            source_map
                .entry(id)
                .or_default()
                .push((name.to_string(), normalized, rank));
        }
    }

    let mut selected: Vec<Curve> = curves
        .into_iter()
        .filter_map(|mut curve| {
            let entries = source_map.get(&curve.id)?;
            let maximum = entries.iter().map(|entry| entry.1).fold(0.0, f64::max);
            let mean = entries.iter().map(|entry| entry.1).sum::<f64>() / entries.len() as f64;
            let reciprocal = entries
                .iter()
                .map(|entry| 1.0 / (60.0 + entry.2 as f64))
                .sum::<f64>();
            let multi_bonus = (0.05 * entries.len().saturating_sub(1) as f64).min(0.2);
            curve.union_score = clamp01(
                0.5 * maximum + 0.25 * mean + 0.25 * clamp01(reciprocal * 20.0) + multi_bonus,
            );
            curve.sources = entries.iter().map(|entry| entry.0.clone()).collect();
            Some(curve)
        })
        .collect();
    selected.sort_by(|left, right| {
        right
            .sources
            .len()
            .cmp(&left.sources.len())
            .then_with(|| {
                right
                    .union_score
                    .partial_cmp(&left.union_score)
                    .unwrap_or(Ordering::Equal)
            })
            .then_with(|| left.id.cmp(&right.id))
    });
    selected.truncate(config.max_union_candidates.max(1));
    for (index, curve) in selected.iter_mut().enumerate() {
        curve.union_rank = index + 1;
    }
    selected
}

#[derive(Clone)]
struct FieldWorkspace {
    local: HashMap<i64, f64>,
    transfer: HashMap<i64, f64>,
    local_domain: HashSet<i64>,
    transfer_domain: HashSet<i64>,
    source_ids: HashSet<i64>,
    active_edges: HashMap<(i64, i64), f64>,
}

fn normalize_field(entries: &[(i64, f64)]) -> HashMap<i64, f64> {
    let maximum = entries
        .iter()
        .map(|entry| positive(entry.1))
        .fold(0.0, f64::max);
    entries
        .iter()
        .filter_map(|entry| {
            let value = positive(entry.1);
            if entry.0 > 0 && value > 0.0 {
                Some((
                    entry.0,
                    if maximum > 0.0 {
                        value / maximum
                    } else {
                        value
                    },
                ))
            } else {
                None
            }
        })
        .collect()
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct GeometryOutput {
    path_quality: f64,
    path_core: f64,
    tag_closure: f64,
    support_coverage: f64,
    segment_count: usize,
    supported_segments: usize,
    transfer_segments: usize,
    active_segments: usize,
    skip_segments: usize,
    mean_direction: f64,
    mean_continuity: f64,
    mean_local_potential: f64,
    mean_transfer_potential: f64,
}

fn evaluate_path(
    curve: &Curve,
    workspace: &FieldWorkspace,
    artifact: &NativeArtifact,
    config: &NativeConfig,
) -> GeometryOutput {
    let mut output = GeometryOutput::default();
    let mut quality_mass = 0.0;
    let mut used_relations = HashSet::new();
    for start in 0..curve.tags.len().saturating_sub(1) {
        let mut best = GeometryOutput::default();
        let mut best_quality = 0.0;
        let mut best_relation = None;
        for span in 1..=2 {
            let Some(next) = curve.tags.get(start + span) else { continue; };
            let current = &curve.tags[start];
            let relation = (current.id.min(next.id), current.id.max(next.id));
            if current.id == next.id || used_relations.contains(&relation) {
                continue;
            }
            let local_potential = (workspace.local.get(&current.id).copied().unwrap_or(0.0)
                * workspace.local.get(&next.id).copied().unwrap_or(0.0))
            .sqrt();
            let transfer_potential = (workspace.transfer.get(&current.id).copied().unwrap_or(0.0)
                * workspace.transfer.get(&next.id).copied().unwrap_or(0.0))
            .sqrt();
            let forward = artifact.edge_weight(current.id, next.id);
            let reverse = artifact.edge_weight(next.id, current.id);
            let direction = if forward + reverse > 0.0 {
                clamp01(forward / (forward + reverse))
            } else {
                clamp01(config.direction_floor)
            };
            let semantic_continuity = clamp01((cosine(&current.vector, &next.vector) + 1.0) / 2.0);
            let field_continuity = (local_potential.max(transfer_potential)
                * workspace
                    .local
                    .get(&next.id)
                    .copied()
                    .unwrap_or(0.0)
                    .max(workspace.transfer.get(&next.id).copied().unwrap_or(0.0)))
            .sqrt();
            let continuity = clamp01(0.5 * semantic_continuity + 0.5 * field_continuity);
            let local_supported = workspace.local_domain.contains(&current.id)
                && workspace.local_domain.contains(&next.id);
            let transfer_supported = workspace.transfer_domain.contains(&current.id)
                && workspace.transfer_domain.contains(&next.id);
            let supported = (local_supported || transfer_supported)
                && (forward > 0.0 || reverse > 0.0);
            let weight_total = (config.local_weight + config.transfer_weight).max(1e-12);
            let potential = (config.local_weight * local_potential
                + config.transfer_weight * transfer_potential)
                / weight_total;
            let active_forward = workspace
                .active_edges
                .get(&(current.id, next.id))
                .copied()
                .unwrap_or(0.0);
            let active_reverse = workspace
                .active_edges
                .get(&(next.id, current.id))
                .copied()
                .unwrap_or(0.0);
            let active = active_forward.max(active_reverse);
            // Global-only support remains a weak fallback. Active flow is evidence,
            // not an independent additive reward for the same relation.
            let activity_gain = 0.5 + 0.5 * active.sqrt();
            let span_gain = if span == 2 { 0.7 } else { 1.0 };
            let quality = if supported {
                clamp01(
                    potential
                        * (if active > 0.0 {
                            clamp01(active_forward / (active_forward + active_reverse).max(1e-12))
                        } else {
                            direction
                        })
                        .max(config.direction_floor)
                        .sqrt()
                        * continuity.max(0.0).sqrt()
                        * activity_gain
                        * span_gain,
                )
            } else {
                0.0
            };
            if quality > best_quality {
                best_quality = quality;
                best_relation = Some(relation);
                best.supported_segments = usize::from(supported);
                best.active_segments = usize::from(active > 0.0);
                best.skip_segments = usize::from(span == 2);
                best.transfer_segments = usize::from(
                    supported
                        && transfer_supported
                        && (!local_supported || transfer_potential > local_potential),
                );
                best.mean_direction = direction;
                best.mean_continuity = continuity;
                best.mean_local_potential = local_potential;
                best.mean_transfer_potential = transfer_potential;
            }
        }
        if let Some(relation) = best_relation {
            used_relations.insert(relation);
        }
        output.segment_count += 1;
        output.supported_segments += best.supported_segments;
        output.active_segments += best.active_segments;
        output.skip_segments += best.skip_segments;
        output.transfer_segments += best.transfer_segments;
        output.mean_direction += best.mean_direction;
        output.mean_continuity += best.mean_continuity;
        output.mean_local_potential += best.mean_local_potential;
        output.mean_transfer_potential += best.mean_transfer_potential;
        quality_mass += best_quality;
    }

    if output.segment_count > 0 {
        let count = output.segment_count as f64;
        output.path_core = clamp01(quality_mass / count);
        output.mean_direction /= count;
        output.mean_continuity /= count;
        output.mean_local_potential /= count;
        output.mean_transfer_potential /= count;
        output.support_coverage = output.supported_segments as f64 / count;
    } else if let Some(tag) = curve.tags.first() {
        output.path_core = clamp01(
            workspace
                .local
                .get(&tag.id)
                .copied()
                .unwrap_or(0.0)
                .max(workspace.transfer.get(&tag.id).copied().unwrap_or(0.0))
                * 0.5,
        );
    }

    output.tag_closure = if curve.tags.is_empty() {
        0.0
    } else {
        curve
            .tags
            .iter()
            .map(|tag| {
                clamp01(
                    (tag.chunk_cosine - config.closure_floor)
                        / (1.0 - config.closure_floor).max(1e-9),
                )
            })
            .sum::<f64>()
            / curve.tags.len() as f64
    };
    output.path_quality = clamp01(
        output.path_core * (0.5 + 0.25 * output.support_coverage + 0.25 * output.tag_closure),
    );
    output
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct TopologyOutput {
    score: f64,
    reliability: f64,
    reliability_mode: String,
    node_alignment_score: f64,
    edge_graph_score: f64,
    node_graph_score: f64,
    relative_distance_score: f64,
    direction_score: f64,
    edge_topology_score: f64,
    motif_score: f64,
    matched_node_coverage: f64,
    matched_edge_coverage: f64,
    mean_closure: f64,
    candidate_support_density: f64,
    strongest_node_match_quality: f64,
    exact_matched_nodes: usize,
    semantic_matched_nodes: usize,
    matched_nodes: usize,
    matched_edges: usize,
    query_nodes: usize,
    query_edges: usize,
}

#[derive(Clone)]
struct Alignment {
    candidate_index: usize,
    candidate_position: i64,
    quality: f64,
    closure: f64,
}

fn support_density(supported: f64, total: usize) -> f64 {
    // Penalize unsupported opportunities, not richly supported annotation.
    let unsupported = positive(total as f64 - supported);
    1.0 / (1.0 + positive(unsupported - 6.0) / 16.0)
}

/// Saturate at a single supported tributary, not coverage of the whole river.
/// Raw coverage remains available separately in the topology diagnostics.
fn branch_coverage(topology: &TopologyOutput, mode: &str) -> f64 {
    let nodes = clamp01(topology.matched_node_coverage / 0.35);
    let edges = clamp01(topology.matched_edge_coverage / 0.20);
    if mode == "atomic" {
        nodes
    } else if topology.matched_edges == 0 {
        0.35 * nodes
    } else {
        0.70 * edges + 0.30 * nodes
    }
}

fn precision_grounding(topology: &TopologyOutput) -> f64 {
    if topology.exact_matched_nodes == 0 && topology.strongest_node_match_quality < 0.65 {
        0.65
    } else {
        1.0
    }
}

/// Coverage, closure and alignment enter confidence once. The legacy
/// reliability still describes raw full-river coverage but is not multiplied in.
fn branch_confidence(topology: &TopologyOutput, mode: &str) -> f64 {
    clamp01(
        branch_coverage(topology, mode)
            * clamp01(topology.mean_closure)
            * clamp01(topology.node_alignment_score),
    )
    .sqrt()
}

/// Query cosine is the floor; fields only contribute bounded positive surplus.
fn field_resonance(curve: &Curve, input: &NativeInput, support: f64) -> (f64, f64, f64) {
    let local = if input.local_vector.iter().all(|v| v.is_finite())
        && squared_norm(&input.local_vector) > 1e-12 {
        positive(input.config.pure_local_weight)
    } else {
        0.0
    };
    let transfer = if input.transfer_vector.iter().all(|v| v.is_finite())
        && squared_norm(&input.transfer_vector) > 1e-12 {
        positive(input.config.pure_transfer_weight)
    } else {
        0.0
    };
    let total = local + transfer;
    let query = clamp01(curve.query_score);
    let field = if total > 1e-12 {
        clamp01((local * clamp01(curve.local_score) + transfer * clamp01(curve.transfer_score)) / total)
    } else {
        query
    };
    let lambda = clamp01(total / (positive(input.config.pure_query_weight) + total).max(1e-12));
    let gain = ((lambda * positive(field - query)).min(0.03) * clamp01(support))
        .min(1.0 - query);
    (query + gain, field, gain)
}

fn evaluate_topology(
    curve: &Curve,
    input: &NativeInput,
    artifact: &NativeArtifact,
    query_tag_vectors: &TagVectorPool,
) -> TopologyOutput {
    let mut output = TopologyOutput {
        query_nodes: input.query_state.river_nodes.len(),
        ..TopologyOutput::default()
    };
    // Ordered by Tag ID so that `mean_closure` does not sum in hash order.
    let mut alignments = BTreeMap::new();
    let mut total_node_weight = 0.0;
    let mut matched_node_weight = 0.0;
    let mut node_quality_mass = 0.0;

    let mut bindings = Vec::new();
    let mut node_weights = BTreeMap::new();
    for node in &input.query_state.river_nodes {
        let weight = positive(if node.normalized_energy != 0.0 {
            node.normalized_energy
        } else {
            node.energy
        })
        .max(1e-9);
        if node_weights.insert(node.id, weight).is_some() {
            continue;
        }
        total_node_weight += weight;
        for (index, tag) in curve.tags.iter().enumerate() {
            let exact = node.id == tag.id;
            let similarity = if exact {
                1.0
            } else {
                query_tag_vectors
                    .get(&node.id)
                    .map(|v| clamp01(cosine(v, &tag.vector)))
                    .unwrap_or(0.0)
            };
            if !exact && similarity <= input.config.semantic_node_threshold {
                continue;
            }
            let normalized = if exact {
                1.0
            } else {
                clamp01(
                    (similarity - input.config.semantic_node_threshold)
                        / (1.0 - input.config.semantic_node_threshold).max(1e-9),
                )
            };
            let weak_gain = if !exact && similarity < 0.65 {
                (similarity / 0.65).powi(2)
            } else {
                1.0
            };
            let quality = (normalized * tag.chunk_cosine).sqrt() * weak_gain;
            bindings.push((
                exact,
                node.id,
                tag.id,
                weight,
                Alignment {
                    candidate_index: index,
                    candidate_position: tag.position,
                    quality,
                    closure: tag.chunk_cosine,
                },
            ));
        }
    }
    bindings.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| (b.3 * b.4.quality).total_cmp(&(a.3 * a.4.quality)))
            .then_with(|| a.1.cmp(&b.1))
            .then_with(|| a.2.cmp(&b.2))
            .then_with(|| a.4.candidate_index.cmp(&b.4.candidate_index))
    });
    let mut used_tags = HashSet::new();
    for (exact, node_id, tag_id, weight, alignment) in bindings {
        if alignments.contains_key(&node_id) || used_tags.contains(&tag_id) {
            continue;
        }
        used_tags.insert(tag_id);
        output.exact_matched_nodes += usize::from(exact);
        output.semantic_matched_nodes += usize::from(!exact);
        output.strongest_node_match_quality =
            output.strongest_node_match_quality.max(alignment.quality);
        matched_node_weight += weight * alignment.quality;
        node_quality_mass += weight * alignment.quality * alignment.quality;
        alignments.insert(node_id, alignment);
    }
    let density = support_density(
        alignments.values().map(|a| a.quality).sum(),
        curve.tags.len(),
    );
    output.candidate_support_density = density;
    matched_node_weight *= density;
    node_quality_mass *= density;

    output.matched_nodes = alignments.len();
    output.matched_node_coverage = if total_node_weight > 0.0 {
        clamp01(matched_node_weight / total_node_weight)
    } else {
        0.0
    };
    output.node_alignment_score = if matched_node_weight > 0.0 {
        clamp01(node_quality_mass / matched_node_weight)
    } else {
        0.0
    };
    output.mean_closure = if alignments.is_empty() {
        0.0
    } else {
        alignments.values().map(|item| item.closure).sum::<f64>() / alignments.len() as f64
    };

    let maximum_hop = input
        .query_state
        .river_nodes
        .iter()
        .map(|node| node.hop.max(0))
        .max()
        .unwrap_or(1)
        .max(1) as f64;
    let river_node_by_id: HashMap<i64, &RiverNode> = input
        .query_state
        .river_nodes
        .iter()
        .map(|node| (node.id, node))
        .collect();
    let minimum_position = curve.tags.first().map(|tag| tag.position).unwrap_or(0);
    let maximum_position = curve
        .tags
        .last()
        .map(|tag| tag.position)
        .unwrap_or(minimum_position);
    let candidate_span = (maximum_position - minimum_position).max(1) as f64;
    let retained_edges: Vec<&RiverEdge> = input
        .query_state
        .river_edges
        .iter()
        .filter(|edge| {
            clamp01(if edge.normalized_flow != 0.0 {
                edge.normalized_flow
            } else {
                edge.flow
            }) >= input.config.minimum_river_edge_flow
        })
        .take(input.config.maximum_river_edges.max(1))
        .collect();
    output.query_edges = retained_edges.len();

    let mut total_edge_weight = 0.0;
    let mut matched_edge_weight = 0.0;
    let mut distance_mass = 0.0;
    let mut direction_mass = 0.0;
    let mut topology_mass = 0.0;

    for edge in retained_edges {
        let edge_weight = positive(if edge.normalized_flow != 0.0 {
            edge.normalized_flow
        } else {
            edge.flow
        })
        .max(1e-9);
        total_edge_weight += edge_weight;
        let (Some(source), Some(target)) = (
            alignments.get(&edge.source_id),
            alignments.get(&edge.target_id),
        ) else {
            continue;
        };
        if source.candidate_index == target.candidate_index {
            continue;
        }
        let source_hop = river_node_by_id
            .get(&edge.source_id)
            .map(|node| node.hop)
            .unwrap_or(0);
        let target_hop = river_node_by_id
            .get(&edge.target_id)
            .map(|node| node.hop)
            .unwrap_or(0);
        let query_distance = (target_hop - source_hop).abs().max(1) as f64 / maximum_hop;
        let candidate_distance =
            (target.candidate_position - source.candidate_position).abs() as f64 / candidate_span;
        let distance_similarity = (-(query_distance - candidate_distance).abs()
            / input.config.relative_distance_temperature.max(1e-6))
        .exp();
        let direction_similarity = if target.candidate_position > source.candidate_position {
            1.0
        } else {
            clamp01(input.config.reverse_direction_credit)
        };
        let independent =
            artifact.independent_fraction(edge.source_id, edge.target_id, curve.file_id);
        let endpoint = (source.quality * target.quality).sqrt();
        let edge_quality =
            clamp01(endpoint * distance_similarity * direction_similarity * independent);
        matched_edge_weight += edge_weight * endpoint;
        distance_mass += edge_weight * endpoint * distance_similarity;
        direction_mass += edge_weight * endpoint * direction_similarity;
        topology_mass += edge_weight * endpoint * edge_quality;
        output.matched_edges += 1;
    }

    output.matched_edge_coverage = if total_edge_weight > 0.0 {
        clamp01(matched_edge_weight / total_edge_weight)
    } else {
        0.0
    };
    if matched_edge_weight > 0.0 {
        output.relative_distance_score = clamp01(distance_mass / matched_edge_weight);
        output.direction_score = clamp01(direction_mass / matched_edge_weight);
        output.edge_topology_score = clamp01(topology_mass / matched_edge_weight);
    }
    output.motif_score = output.edge_topology_score;
    output.edge_graph_score = clamp01(
        0.18 * output.node_alignment_score
            + 0.22 * output.relative_distance_score
            + 0.18 * output.direction_score
            + 0.28 * output.edge_topology_score
            + 0.14 * output.motif_score,
    );
    output.node_graph_score = clamp01((output.node_alignment_score * output.mean_closure).sqrt());
    if output.matched_edges > 0 {
        output.score = output.edge_graph_score;
        output.reliability = clamp01(
            (output.matched_node_coverage * output.matched_edge_coverage * output.mean_closure)
                .cbrt(),
        );
        output.reliability_mode = "edge_topology".to_string();
    } else if output.matched_nodes > 0 {
        output.score = output.node_graph_score;
        output.reliability = input.config.node_only_reliability_cap.min(clamp01(
            (output.matched_node_coverage * output.mean_closure).sqrt(),
        ));
        output.reliability_mode = "node_alignment_fallback".to_string();
    } else {
        output.reliability_mode = "unavailable".to_string();
    }
    output
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ObservableOutput {
    direct: f64,
    structural: f64,
    thematic: f64,
    closure: f64,
    query_chunk_score: f64,
    semantic_boundary_score: f64,
    local_coverage: f64,
    transfer_coverage: f64,
    local_potential: f64,
    transfer_potential: f64,
    tail_only_ratio: f64,
    field_support: f64,
}

fn scalar_field_support(coverage: f64, potential: f64) -> f64 {
    let potential = positive(potential);
    let covered = clamp01(coverage / 0.5);
    let saturated = clamp01(potential / 0.02);
    let domain = (covered * saturated).sqrt();
    let tail = 0.1 * (potential / (potential + 0.02)).sqrt();
    clamp01(domain.max(tail))
}

fn evaluate_observables(
    curve: &Curve,
    geometry: &GeometryOutput,
    input: &NativeInput,
    workspace: &FieldWorkspace,
    visible: bool,
) -> ObservableOutput {
    let mut seen_ids = HashSet::new();
    let tags: Vec<&TagData> = curve.tags.iter().filter(|t| seen_ids.insert(t.id)).collect();
    let chain_size = tags.len().max(1) as f64;
    let mut exact_seed_hits = 0usize;
    let mut local_contacts = 0usize;
    let mut transfer_contacts = 0usize;
    let mut local_potential = 0.0;
    let mut transfer_potential = 0.0;
    let mut tail_only = 0usize;
    let mut boundary: f64 = 0.0;

    for tag in &tags {
        let local = workspace.local.get(&tag.id).copied().unwrap_or(0.0);
        let transfer = workspace.transfer.get(&tag.id).copied().unwrap_or(0.0);
        exact_seed_hits += usize::from(workspace.source_ids.contains(&tag.id));
        local_contacts += usize::from(workspace.local_domain.contains(&tag.id));
        transfer_contacts += usize::from(workspace.transfer_domain.contains(&tag.id));
        local_potential += local;
        transfer_potential += transfer;
        tail_only += usize::from(
            (local > 0.0 || transfer > 0.0)
                && !workspace.local_domain.contains(&tag.id)
                && !workspace.transfer_domain.contains(&tag.id),
        );
        boundary = boundary
            .max((clamp01(cosine(&input.query.vector, &tag.vector)) * tag.chunk_cosine).sqrt());
    }

    let local_coverage = local_contacts as f64 / chain_size;
    let transfer_coverage = transfer_contacts as f64 / chain_size;
    let local_mean = local_potential / chain_size;
    let transfer_mean = transfer_potential / chain_size;
    let tail_ratio = tail_only as f64 / chain_size;
    let dual_agreement = 1.0 - (clamp01(local_mean) - clamp01(transfer_mean)).abs();
    let thematic = clamp01(
        0.25 * local_coverage
            + 0.2 * transfer_coverage
            + 0.2 * clamp01(local_mean)
            + 0.15 * clamp01(transfer_mean)
            + 0.2 * dual_agreement,
    ) * (1.0 - 0.5 * clamp01(tail_ratio));
    let query_chunk = clamp01(cosine(&input.query.vector, &curve.chunk_vector));
    let direct_contact = clamp01(exact_seed_hits as f64 / workspace.source_ids.len().max(1) as f64);
    let semantic_boundary_score = if boundary >= 0.55 { boundary } else { 0.0 };
    let direct = if visible {
        clamp01((0.75 * direct_contact).max(semantic_boundary_score))
    } else {
        0.0
    };
    let closure = clamp01(0.65 * query_chunk + 0.35 * geometry.tag_closure);
    ObservableOutput {
        direct,
        structural: geometry.path_quality,
        thematic,
        closure,
        query_chunk_score: query_chunk,
        semantic_boundary_score,
        local_coverage,
        transfer_coverage,
        local_potential: local_mean,
        transfer_potential: transfer_mean,
        tail_only_ratio: tail_ratio,
        field_support: scalar_field_support(local_coverage, local_mean)
            .max(scalar_field_support(transfer_coverage, transfer_mean)),
    }
}

#[derive(Clone, Default)]
struct AnchorOutput {
    score: f64,
    reliability: f64,
    strength: f64,
    contacted_seeds: usize,
    exact_contacts: usize,
    semantic_contacts: usize,
    explicit_exact_contacts: usize,
    explicit_semantic_contacts: usize,
    has_explicit_focus: bool,
    mean_closure: f64,
    implicit_only: bool,
}

fn anchor_contacts(
    curve: &Curve,
    seeds: &[(i64, f64)],
    seed_vectors: &TagVectorPool,
    config: &NativeConfig,
) -> Vec<(i64, i64, bool, f64, f64, f64)> {
    // Enumerate edges before assignment: exact contacts reserve both endpoints.
    let mut edges = Vec::new();
    for (seed_id, mass) in seeds {
        for tag in &curve.tags {
            let exact = tag.id == *seed_id;
            let similarity = if exact {
                1.0
            } else {
                seed_vectors
                    .get(seed_id)
                    .map(|vector| cosine(vector, &tag.vector))
                    .unwrap_or(0.0)
            };
            if exact || similarity >= config.semantic_anchor_threshold.max(0.88) {
                edges.push((*seed_id, tag.id, exact, similarity, *mass, tag.chunk_cosine));
            }
        }
    }
    edges.sort_by(|a, b| {
        b.2.cmp(&a.2)
            .then_with(|| (b.3 * b.4 * b.5).total_cmp(&(a.3 * a.4 * a.5)))
            .then_with(|| a.0.cmp(&b.0))
            .then_with(|| a.1.cmp(&b.1))
    });
    let mut used_seeds = HashSet::new();
    let mut used_tags = HashSet::new();
    let mut contacts = Vec::new();
    for edge in edges {
        if used_seeds.contains(&edge.0) || used_tags.contains(&edge.1) {
            continue;
        }
        used_seeds.insert(edge.0);
        used_tags.insert(edge.1);
        contacts.push(edge);
        if contacts.len() == 3 {
            break;
        }
    }
    contacts
}

fn compute_anchors(
    curves: &[Curve],
    seeds: &[(i64, f64)],
    seed_vectors: &TagVectorPool,
    artifact: &NativeArtifact,
    config: &NativeConfig,
    fallback: bool,
    explicit_ids: &HashSet<i64>,
) -> Vec<AnchorOutput> {
    let contacts: Vec<Vec<(i64, i64, bool, f64, f64, f64)>> = curves
        .par_iter()
        .map(|curve| anchor_contacts(curve, seeds, seed_vectors, config))
        .collect();
    let explicit_max = seeds
        .iter()
        .filter(|s| explicit_ids.contains(&s.0))
        .map(|s| positive(s.1))
        .fold(0.0, f64::max);
    let max_seed_mass = if explicit_max > 0.0 {
        explicit_max
    } else {
        seeds.iter().map(|seed| positive(seed.1)).fold(0.0, f64::max)
    };
    contacts
        .into_par_iter()
        .map(|candidate_contacts| {
            let mut no_contact_probability = 1.0;
            let mut closure_sum = 0.0;
            let mut exact = 0usize;
            let implicit_only = !candidate_contacts.is_empty()
                && !candidate_contacts.iter().any(|c| explicit_ids.contains(&c.0));
            for contact in &candidate_contacts {
                let inbound = artifact.inbound.get(&contact.1).copied().unwrap_or(0.0);
                let specificity = if artifact.max_inbound > 0.0 {
                    config
                        .specificity_floor
                        .max(1.0 - clamp01(inbound / artifact.max_inbound).sqrt())
                } else {
                    1.0
                };
                // Global specificity, not the accidental composition of this pool.
                let rarity = config.rarity_floor.max(specificity);
                let normalized_mass = if max_seed_mass > 0.0 {
                    clamp01(contact.4 / max_seed_mass)
                } else {
                    0.0
                };
                let match_weight = if contact.2 {
                    exact += 1;
                    1.0
                } else {
                    config.semantic_anchor_discount
                        * clamp01(
                            (contact.3 - config.semantic_anchor_threshold.max(0.88))
                                / (1.0 - config.semantic_anchor_threshold.max(0.88)).max(1e-9),
                        )
                };
                let grounding_gain = if !explicit_ids.contains(&contact.0) {
                    0.35
                } else {
                    1.0
                };
                let contribution = clamp01(
                    normalized_mass
                        * specificity
                        * contact.5
                        * rarity
                        * match_weight
                        * grounding_gain,
                );
                no_contact_probability *= 1.0 - contribution;
                closure_sum += contact.5;
            }
            let contacted = candidate_contacts.len();
            let mean_closure = if contacted > 0 {
                closure_sum / contacted as f64
            } else {
                0.0
            };
            let score = clamp01(1.0 - no_contact_probability);
            // A single exact focus is sufficient identity evidence. Quantity is
            // never a substitute for closure; semantic-only contacts stay discounted.
            let mut reliability = clamp01(mean_closure).sqrt()
                * if exact > 0 { 1.0 } else { config.semantic_anchor_discount };
            if fallback {
                reliability = reliability.min(config.fallback_reliability_cap);
            }
            if implicit_only {
                reliability = reliability.min(0.35);
            }
            AnchorOutput {
                score,
                reliability,
                strength: if implicit_only {
                    clamp01(score * reliability).min(0.035)
                } else {
                    clamp01(score * reliability)
                },
                implicit_only,
                explicit_exact_contacts: candidate_contacts
                    .iter()
                    .filter(|c| c.2 && explicit_ids.contains(&c.0))
                    .count(),
                explicit_semantic_contacts: candidate_contacts
                    .iter()
                    .filter(|c| !c.2 && explicit_ids.contains(&c.0))
                    .count(),
                has_explicit_focus: explicit_max > 0.0,
                contacted_seeds: contacted,
                exact_contacts: exact,
                semantic_contacts: contacted.saturating_sub(exact),
                mean_closure,
            }
        })
        .collect()
}

#[derive(Clone)]
struct ScoredWork {
    curve: Curve,
    geometry: GeometryOutput,
    topology: TopologyOutput,
    observables: ObservableOutput,
    pure_score: f64,
    field_score: f64,
    field_resonance_bonus: f64,
    graph_score: f64,
    direct_evidence: f64,
    role: String,
    anchor: AnchorOutput,
    v2_bonus: f64,
    gated_bonus: f64,
    path_bonus: f64,
    anchor_bonus: f64,
    final_score: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct QueryMorphology {
    atomic_weight: f64,
    propositional_weight: f64,
    narrative_weight: f64,
    confidence: f64,
    effective_depth: f64,
    depth_variance: f64,
    energy_concentration: f64,
    shallow_energy_ratio: f64,
    forward_flow_ratio: f64,
    same_level_flow_ratio: f64,
    chainness: f64,
    branching: f64,
    merging: f64,
    growth_persistence: f64,
    dominant_mode: String,
}

fn compute_query_morphology(input: &NativeInput) -> QueryMorphology {
    let nodes = &input.query_state.river_nodes;
    let edges = &input.query_state.river_edges;
    let node_count = nodes.len();
    let edge_count = edges.len();
    let hop_by_id: HashMap<i64, usize> = nodes
        .iter()
        .map(|node| (node.id, node.hop.max(0) as usize))
        .collect();
    let maximum_hop = hop_by_id.values().copied().max().unwrap_or(0);

    let energies: Vec<f64> = nodes
        .iter()
        .map(|node| {
            positive(if node.normalized_energy != 0.0 {
                node.normalized_energy
            } else {
                node.energy
            })
        })
        .collect();
    let total_energy: f64 = energies.iter().sum();
    let weighted_hop = if total_energy > 1e-12 {
        nodes
            .iter()
            .zip(&energies)
            .map(|(node, energy)| node.hop.max(0) as f64 * energy)
            .sum::<f64>()
            / total_energy
    } else {
        0.0
    };
    let hop_variance = if total_energy > 1e-12 {
        nodes
            .iter()
            .zip(&energies)
            .map(|(node, energy)| energy * (node.hop.max(0) as f64 - weighted_hop).powi(2))
            .sum::<f64>()
            / total_energy
    } else {
        0.0
    };
    let effective_depth = clamp01(1.0 - (-weighted_hop / 1.75).exp());
    let depth_variance = clamp01(1.0 - (-hop_variance.sqrt() / 1.5).exp());
    let shallow_energy_ratio = if total_energy > 1e-12 {
        nodes
            .iter()
            .zip(&energies)
            .filter(|(node, _)| node.hop <= 1)
            .map(|(_, energy)| *energy)
            .sum::<f64>()
            / total_energy
    } else {
        1.0
    };

    let raw_hhi = if total_energy > 1e-12 {
        energies
            .iter()
            .map(|energy| (energy / total_energy).powi(2))
            .sum::<f64>()
    } else {
        1.0
    };
    let uniform_hhi = 1.0 / node_count.max(1) as f64;
    let energy_concentration = if node_count > 1 {
        clamp01((raw_hhi - uniform_hhi) / (1.0 - uniform_hhi))
    } else {
        1.0
    };

    let mut inbound_degree: HashMap<i64, usize> = HashMap::new();
    let mut outbound_degree: HashMap<i64, usize> = HashMap::new();
    let mut total_flow = 0.0;
    let mut forward_flow = 0.0;
    let mut same_level_flow = 0.0;
    for edge in edges {
        let flow = positive(if edge.normalized_flow != 0.0 {
            edge.normalized_flow
        } else {
            edge.flow
        });
        if flow <= 0.0 {
            continue;
        }
        total_flow += flow;
        *outbound_degree.entry(edge.source_id).or_default() += 1;
        *inbound_degree.entry(edge.target_id).or_default() += 1;
        let source_hop = hop_by_id.get(&edge.source_id).copied().unwrap_or(0);
        let target_hop = hop_by_id.get(&edge.target_id).copied().unwrap_or(0);
        if target_hop > source_hop {
            forward_flow += flow;
        } else if target_hop == source_hop {
            same_level_flow += flow;
        }
    }
    let forward_flow_ratio = if total_flow > 1e-12 {
        clamp01(forward_flow / total_flow)
    } else {
        0.0
    };
    let same_level_flow_ratio = if total_flow > 1e-12 {
        clamp01(same_level_flow / total_flow)
    } else {
        0.0
    };

    let reached_nodes: Vec<i64> = nodes
        .iter()
        .filter(|node| node.hop > 0)
        .map(|node| node.id)
        .collect();
    let reached_count = reached_nodes.len().max(1) as f64;
    let chain_fit = reached_nodes
        .iter()
        .filter(|id| {
            inbound_degree.get(*id).copied().unwrap_or(0) <= 1
                && outbound_degree.get(*id).copied().unwrap_or(0) <= 1
        })
        .count() as f64
        / reached_count;
    let branching = clamp01(
        reached_nodes
            .iter()
            .map(|id| {
                outbound_degree
                    .get(id)
                    .copied()
                    .unwrap_or(0)
                    .saturating_sub(1)
            })
            .sum::<usize>() as f64
            / reached_count,
    );
    let merging = clamp01(
        reached_nodes
            .iter()
            .map(|id| {
                inbound_degree
                    .get(id)
                    .copied()
                    .unwrap_or(0)
                    .saturating_sub(1)
            })
            .sum::<usize>() as f64
            / reached_count,
    );
    let chainness = clamp01(
        chain_fit
            * forward_flow_ratio.sqrt()
            * (0.35 + 0.65 * effective_depth)
            * (1.0 - 0.5 * branching),
    );

    let occupied_hops: HashSet<usize> = hop_by_id.values().copied().collect();
    let level_occupancy = if maximum_hop > 0 {
        occupied_hops.len().saturating_sub(1) as f64 / maximum_hop as f64
    } else {
        0.0
    };
    let growth_persistence = clamp01(level_occupancy * effective_depth.sqrt());
    let middle_depth = clamp01(1.0 - (2.0 * effective_depth - 1.0).abs());
    let relational_complexity =
        clamp01(0.35 * same_level_flow_ratio + 0.35 * branching + 0.3 * merging);

    let sample_reliability = clamp01(
        (1.0 - (-(node_count as f64) / 8.0).exp()) * (1.0 - (-(edge_count as f64) / 8.0).exp()),
    )
    .sqrt();
    let completeness = if input.query_state.complete_observation {
        1.0
    } else {
        0.5
    };
    let confidence = clamp01(sample_reliability * completeness);

    let atomic_logit = 1.45 * shallow_energy_ratio + 0.9 * energy_concentration
        - 1.25 * effective_depth
        - 0.65 * growth_persistence
        - 0.45 * chainness;
    let propositional_logit =
        1.25 * relational_complexity + 0.7 * middle_depth + 0.35 * depth_variance
            - 0.25 * chainness;
    let narrative_logit = 1.4 * effective_depth
        + 1.15 * chainness
        + 0.8 * forward_flow_ratio
        + 0.65 * growth_persistence
        - 0.65 * branching
        - 0.3 * energy_concentration;

    const TEMPERATURE: f64 = 1.0;
    let logits = [atomic_logit, propositional_logit, narrative_logit];
    let maximum_logit = logits.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let exponentials = logits.map(|logit| ((logit - maximum_logit) / TEMPERATURE).exp());
    let exponential_sum: f64 = exponentials.iter().sum();
    let topology_weights = exponentials.map(|value| value / exponential_sum.max(1e-12));
    let prior = [1.0 / 3.0; 3];
    let weights = [
        confidence * topology_weights[0] + (1.0 - confidence) * prior[0],
        confidence * topology_weights[1] + (1.0 - confidence) * prior[1],
        confidence * topology_weights[2] + (1.0 - confidence) * prior[2],
    ];
    let dominant_mode = if weights[0] >= weights[1] && weights[0] >= weights[2] {
        "atomic"
    } else if weights[2] >= weights[1] {
        "narrative"
    } else {
        "propositional"
    };

    QueryMorphology {
        atomic_weight: weights[0],
        propositional_weight: weights[1],
        narrative_weight: weights[2],
        confidence,
        effective_depth,
        depth_variance,
        energy_concentration,
        shallow_energy_ratio,
        forward_flow_ratio,
        same_level_flow_ratio,
        chainness,
        branching,
        merging,
        growth_persistence,
        dominant_mode: dominant_mode.to_string(),
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OmegaOutput {
    omega: f64,
    omega_edge: f64,
    omega_emerge: f64,
    omega_flow: f64,
    regime: String,
    active_edges: usize,
    seed_nodes: usize,
    reached_nodes: usize,
    emergent_nodes: usize,
    complete_observation: bool,
}

fn compute_omega(input: &NativeInput) -> OmegaOutput {
    let active_edges = input.query_state.river_edges.len();
    let seed_nodes = input
        .query_state
        .river_nodes
        .iter()
        .filter(|node| node.hop == 0)
        .count();
    let reached_nodes = input.query_state.river_nodes.len();
    let emergent_nodes = reached_nodes.saturating_sub(seed_nodes);
    let safe_seed = seed_nodes.max(1) as f64;
    let omega_edge = clamp01(active_edges as f64 / (input.config.kappa_edge * safe_seed));
    let omega_emerge = clamp01(emergent_nodes as f64 / (input.config.kappa_ratio * safe_seed));
    let flows: Vec<f64> = input
        .query_state
        .river_edges
        .iter()
        .map(|edge| positive(edge.flow))
        .filter(|value| *value > 0.0)
        .collect();
    let omega_flow = if flows.is_empty() {
        0.0
    } else if flows.len() == 1 {
        0.5
    } else {
        let total: f64 = flows.iter().sum();
        let entropy = flows
            .iter()
            .map(|flow| {
                let probability = *flow / total;
                -probability * probability.ln()
            })
            .sum::<f64>();
        clamp01(entropy / (flows.len() as f64).ln())
    };
    let geometric = (omega_edge.max(input.config.omega_epsilon)
        * omega_emerge.max(input.config.omega_epsilon)
        * omega_flow.max(input.config.omega_epsilon))
    .cbrt();
    let observation_factor = if input.query_state.complete_observation {
        1.0
    } else {
        0.5
    };
    let omega = clamp01(geometric * observation_factor);
    let regime = if omega < input.config.collapsed_threshold {
        "collapsed"
    } else if omega < input.config.sparse_threshold {
        "sparse"
    } else {
        "dense"
    };
    OmegaOutput {
        omega,
        omega_edge,
        omega_emerge,
        omega_flow,
        regime: regime.to_string(),
        active_edges,
        seed_nodes,
        reached_nodes,
        emergent_nodes,
        complete_observation: input.query_state.complete_observation,
    }
}

fn assign_v3_scores(
    work: &mut [ScoredWork],
    mode: &str,
    omega: &OmegaOutput,
    config: &NativeConfig,
) {
    for item in work.iter_mut() {
        let direct_answer = mode != "atomic"
            && item.observables.closure >= 0.55
            && item.anchor.explicit_exact_contacts > 0;
        let structural = (item.topology.matched_edge_coverage
            * item.topology.reliability
            * item.observables.closure)
        .cbrt();
        item.role = if mode == "atomic" {
            "atomic_concept"
        } else if direct_answer {
            "direct_answer"
        } else if structural >= 0.35 {
            "structural_explanation"
        } else {
            "thematic_neighbor"
        }
        .to_string();
    }

    for item in work.iter_mut() {
        // Candidate-self evidence, not exceptionalness among its peers. Roles
        // explain evidence and never allocate ranking privilege.
        let confidence = branch_confidence(&item.topology, mode);
        let direction = if item.topology.matched_edges > 0 {
            0.25 + 0.75 * item.topology.direction_score
        } else {
            0.25
        };
        let requested = positive(config.topology_bonus_cap)
            * item.graph_score
            * confidence
            * direction
            * precision_grounding(&item.topology);
        item.v2_bonus = clamp01(requested.min(positive(config.topology_bonus_cap)));
    }

    // Absolute activation: unrelated candidates cannot change eligibility.
    let threshold = clamp01(config.anchor_activation_floor);
    let graph_gate = omega.omega.powf(config.omega_gamma.max(0.0));

    for item in work.iter_mut() {
        let activation = if item.anchor.strength <= threshold {
            0.0
        } else if config.anchor_saturation - threshold > 1e-12 {
            let normalized = clamp01(
                (item.anchor.strength - threshold) / (config.anchor_saturation - threshold),
            );
            normalized * normalized * (3.0 - 2.0 * normalized)
        } else {
            1.0
        };
        item.anchor_bonus = config.anchor_bonus_cap * activation;
        if omega.omega < config.struct_role_min_omega && item.role == "structural_explanation" {
            item.role = "thematic_neighbor".to_string();
        }
        item.gated_bonus = (item.v2_bonus * graph_gate)
            .min(positive(config.topology_bonus_cap - item.path_bonus));
        item.final_score =
            clamp01(item.pure_score + item.path_bonus + item.gated_bonus + item.anchor_bonus);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeResultItem {
    id: i64,
    chunk_id: i64,
    rank: usize,
    score: f64,
    base_score: f64,
    field_score: f64,
    field_resonance_bonus: f64,
    topology_bonus: f64,
    anchor_bonus: f64,
    path_bonus: f64,
    graph_bonus: f64,
    score_clipping: f64,
    role: String,
    omega: f64,
    river_regime: String,
    matched_tags: Vec<String>,
    core_tags_matched: Vec<String>,
    candidate_sources: Vec<String>,
    original_score: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    topology_v3: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    relative_topology: Option<TopologyOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    geometry: Option<GeometryOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    observables: Option<ObservableOutput>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeDiagnostics {
    backend: String,
    offered_candidates: usize,
    projected_candidates: usize,
    selected_candidates: usize,
    ranked_candidates: usize,
    returned_candidates: usize,
    rayon_threads: usize,
    artifact_nodes: usize,
    artifact_edges: usize,
    load_ms: f64,
    compute_ms: f64,
    total_ms: f64,
    chunk_sql_batches: usize,
    file_tag_sql_batches: usize,
    query_tag_sql_batches: usize,
    candidate_tag_vector_sql_batches: usize,
    candidate_tag_vector_fetched_nodes: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeOutput {
    schema: String,
    algorithm_version: String,
    artifact_sig: String,
    query_id: Option<String>,
    omega: OmegaOutput,
    query_mode: String,
    query_morphology: QueryMorphology,
    results: Vec<NativeResultItem>,
    diagnostics: NativeDiagnostics,
    parameters: Value,
}

pub(crate) fn run_native(
    runtime: &MemoRuntime,
    db_path: &str,
    artifact_sig: &str,
    input_json: &str,
) -> std::result::Result<String, String> {
    let total_started = Instant::now();
    let mut input: NativeInput = serde_json::from_str(input_json)
        .map_err(|error| format!("invalid RiverMemo native input JSON: {}", error))?;
    if let Some(handle) = input.observation_handle.as_deref() {
        let cached = runtime.get_query_observation(handle, artifact_sig)?;
        input.query.vector = cached.original_query_vector.as_ref().clone();
        input.denoised_vector = cached.enhanced_query_vector.as_ref().clone();
        input.local_vector = cached.local_vector.as_ref().clone();
        input.transfer_vector = cached.transfer_vector.as_ref().clone();
        input.query_state.source_field = cached.observation.source_field.clone();
        input.query_state.local_field = cached.local_field.as_ref().clone();
        input.query_state.transfer_field = cached.transfer_field.as_ref().clone();
        input.query_state.local_domain_ids = cached.local_domain_ids.as_ref().clone();
        input.query_state.transfer_domain_ids = cached.transfer_domain_ids.as_ref().clone();
        input.query_state.river_nodes = cached
            .observation
            .nodes
            .iter()
            .map(|node| RiverNode {
                id: node.id,
                energy: node.energy,
                normalized_energy: node.normalized_energy,
                hop: node.hop as i64,
            })
            .collect();
        input.query_state.river_edges = cached
            .observation
            .edges
            .iter()
            .map(|edge| RiverEdge {
                source_id: edge.source_id,
                target_id: edge.target_id,
                flow: edge.flow,
                normalized_flow: edge.normalized_flow,
                wormhole: edge.wormhole,
                immediate_return: edge.immediate_return,
            })
            .collect();
        input.query_state.field_provenance = cached
            .observation
            .nodes
            .iter()
            .map(|node| SourceProvenance {
                id: node.id,
                hop: node.hop as i64,
                source_type: node.source_type.clone(),
            })
            .collect();
        input.query_state.complete_observation = !cached.observation.source_field.is_empty();
        if input.query_state.query_id.is_none() {
            input.query_state.query_id = cached.observation.query_id.clone();
        }
    }
    let dimension = input.dimension;
    if input.query.vector.len() != dimension
        || input.denoised_vector.len() != dimension
        || input.local_vector.len() != dimension
        || input.transfer_vector.len() != dimension
    {
        return Err(format!(
            "RiverMemo native vector dimension mismatch: expected {}",
            dimension
        ));
    }

    let load_started = Instant::now();
    let connection = open_readonly(db_path)?;
    let artifact = load_artifact_from_runtime(runtime, db_path, artifact_sig)?;
    let mut tag_vectors = TagVectorPool::new();
    let curve_load = load_curves(&connection, &input.candidates, dimension)?;
    let mut curves = curve_load.curves;
    // 显式空集合也意味着无权限；必须在候选归一化和统计前移除越权项。
    let allowed: Option<HashSet<i64>> = input
        .allowed_file_ids
        .as_ref()
        .map(|ids| ids.iter().copied().collect());
    if let Some(scope) = &allowed {
        curves.retain(|curve| scope.contains(&curve.file_id));
    }
    let original_score_by_id: HashMap<i64, f64> = input
        .candidates
        .iter()
        .map(|candidate| {
            (
                candidate.id,
                if candidate.score != 0.0 {
                    candidate.score
                } else if candidate.hybrid_score != 0.0 {
                    candidate.hybrid_score
                } else {
                    candidate.vector_score
                },
            )
        })
        .collect();
    let local_domain: HashSet<i64> = input.query_state.local_domain_ids.iter().copied().collect();
    // Anchor hits count only Tags with a loadable vector, as when every candidate
    // Tag was loaded up front, so the local-domain Tags are checked now; the
    // other Tags are read only for the curves that survive selection.
    let file_tags =
        |curve: &Curve| curve_load.relations.get(&curve.file_id).into_iter().flatten();
    let domain_tag_ids: Vec<i64> = curves
        .iter()
        .flat_map(file_tags)
        .map(|relation| relation.0)
        .filter(|id| local_domain.contains(id))
        .collect();
    let domain_stats =
        ensure_tag_vectors_loaded(&connection, &mut tag_vectors, &domain_tag_ids, dimension)?;
    compute_anchor_scores(&mut curves, |curve| {
        file_tags(curve)
            .filter(|relation| {
                local_domain.contains(&relation.0) && tag_vectors.contains_key(&relation.0)
            })
            .count()
    });
    curves.par_iter_mut().for_each(|curve| {
        curve.query_score = cosine(&input.query.vector, &curve.chunk_vector);
        curve.denoised_score = cosine(&input.denoised_vector, &curve.chunk_vector);
        curve.local_score = cosine(&input.local_vector, &curve.chunk_vector);
        curve.transfer_score = cosine(&input.transfer_vector, &curve.chunk_vector);
    });
    let projected_count = curves.len();
    let mut curves = select_superset(curves, &input.config);
    let selected_tag_ids: Vec<i64> = curves
        .iter()
        .flat_map(file_tags)
        .map(|relation| relation.0)
        .collect();
    let selected_stats =
        ensure_tag_vectors_loaded(&connection, &mut tag_vectors, &selected_tag_ids, dimension)?;
    attach_tags(&mut curves, &curve_load.relations, &tag_vectors);
    let selected_count = curves.len();

    let workspace = FieldWorkspace {
        local: normalize_field(&input.query_state.local_field),
        transfer: normalize_field(&input.query_state.transfer_field),
        local_domain,
        transfer_domain: input
            .query_state
            .transfer_domain_ids
            .iter()
            .copied()
            .collect(),
        source_ids: input
            .query_state
            .source_field
            .iter()
            .map(|entry| entry.0)
            .collect(),
        active_edges: input
            .query_state
            .river_edges
            .iter()
            .filter_map(|edge| {
                // Query support is conditioned on an observed, real transport edge.
                let flow = clamp01(if edge.normalized_flow != 0.0 {
                    edge.normalized_flow
                } else {
                    edge.flow
                });
                (flow >= input.config.minimum_river_edge_flow
                    && artifact.edge_weight(edge.source_id, edge.target_id) > 0.0)
                    .then_some(((edge.source_id, edge.target_id), flow))
            })
            .collect(),
    };
    let direct_ids: Vec<i64> = input
        .query_state
        .field_provenance
        .iter()
        .filter(|entry| {
            entry.hop == 0
                && matches!(entry.source_type.as_str(), "core" | "lexical_seed" | "seed")
        })
        .map(|entry| entry.id)
        .collect();
    let fallback_anchor = direct_ids.is_empty();
    let anchor_ids: HashSet<i64> = if fallback_anchor {
        input
            .query_state
            .source_field
            .iter()
            .map(|entry| entry.0)
            .collect()
    } else {
        direct_ids.into_iter().collect()
    };
    let mut seeds: Vec<(i64, f64)> = input
        .query_state
        .source_field
        .iter()
        .filter(|entry| anchor_ids.contains(&entry.0) && entry.1 > 0.0)
        .copied()
        .collect();

    let maximum_seed = seeds.iter().map(|s| s.1).fold(0.0, f64::max);
    let core_ids: HashSet<i64> = input
        .query_state
        .field_provenance
        .iter()
        .filter(|p| p.hop == 0 && matches!(p.source_type.as_str(), "core" | "lexical_seed"))
        .map(|p| p.id)
        .collect();
    seeds.retain(|s| s.1 >= maximum_seed * 0.2 || core_ids.contains(&s.0));

    // Query River 节点和 Direct Anchor/Seed 共享一次分块 Tag 向量读取。
    // 同一 ID 同时属于河网和锚点时只读取、解码并存储一次。
    let mut requested_tag_ids: Vec<i64> = input
        .query_state
        .river_nodes
        .iter()
        .map(|node| node.id)
        .collect();
    requested_tag_ids.extend(seeds.iter().map(|seed| seed.0));
    requested_tag_ids.extend(
        input
            .query_state
            .river_edges
            .iter()
            .filter(|edge| edge.wormhole)
            .map(|edge| edge.target_id),
    );
    let query_stats =
        ensure_tag_vectors_loaded(&connection, &mut tag_vectors, &requested_tag_ids, dimension)?;
    let query_tag_sql_batches = query_stats.sql_batches;
    let query_and_seed_tag_vectors = tag_vectors;
    let mut wormhole_model = wormhole::build(&input, &query_and_seed_tag_vectors, &artifact);
    let mut wormhole_gate = wormhole::gate(&mut wormhole_model, &connection)?;
    wormhole::refine(&mut wormhole_model, &mut wormhole_gate, &connection, &input)?;
    let load_ms = load_started.elapsed().as_secs_f64() * 1000.0;

    let compute_started = Instant::now();
    let morphology = compute_query_morphology(&input);

    // Indexed parallel results preserve curve order; rewards do not depend on peers.
    let anchor_results = compute_anchors(
        &curves,
        &seeds,
        &query_and_seed_tag_vectors,
        &artifact,
        &input.config,
        fallback_anchor,
        &core_ids,
    );
    let core_tag_names: HashSet<String> = input
        .query_state
        .field_provenance
        .iter()
        .filter(|entry| entry.source_type == "core")
        .filter_map(|entry| {
            curves
                .iter()
                .flat_map(|curve| curve.tags.iter())
                .find(|tag| tag.id == entry.id)
                .map(|tag| tag.name.to_lowercase())
        })
        .collect();

    let mut work: Vec<ScoredWork> = curves
        .into_par_iter()
        .zip(anchor_results.into_par_iter())
        .map(|(curve, anchor)| {
            let geometry = evaluate_path(&curve, &workspace, &artifact, &input.config);
            let topology = evaluate_topology(&curve, &input, &artifact, &query_and_seed_tag_vectors);
            let visible = true; // 越权候选已在进入候选池前删除。
            let observables =
                evaluate_observables(&curve, &geometry, &input, &workspace, visible);
            let (semantic_base, field_score, field_resonance_bonus) =
                field_resonance(&curve, &input, observables.field_support);
            let topology_raw = clamp01(
                0.625 * geometry.path_quality
                    + 0.375
                        * clamp01(
                            0.35 * observables.local_coverage
                                + 0.25 * observables.transfer_coverage
                                + 0.25 * clamp01(observables.local_potential)
                                + 0.15 * clamp01(observables.transfer_potential),
                        ),
            );
            let path_reliability =
                clamp01(geometry.path_quality / input.config.topology_path_saturation.max(1e-6));
            let topology_reliability = (path_reliability * observables.query_chunk_score).sqrt();
            let topology_bonus =
                input.config.topology_bonus_cap * topology_raw * topology_reliability;
            let pure_score = semantic_base;
            let path_bonus = topology_bonus.min(input.config.topology_bonus_cap);
            let atomic_score = 0.75 * topology.node_graph_score + 0.25 * topology.edge_graph_score;
            let propositional_score =
                0.25 * topology.node_graph_score + 0.75 * topology.edge_graph_score;
            let narrative_score =
                0.15 * topology.node_graph_score + 0.85 * topology.edge_graph_score;
            let graph_score = clamp01(
                morphology.atomic_weight * atomic_score
                    + morphology.propositional_weight * propositional_score
                    + morphology.narrative_weight * narrative_score,
            );
            ScoredWork {
                curve,
                geometry,
                topology,
                direct_evidence: observables.semantic_boundary_score.max(observables.direct),
                observables,
                pure_score,
                field_score,
                field_resonance_bonus,
                graph_score,
                role: String::new(),
                anchor,
                v2_bonus: 0.0,
                gated_bonus: 0.0,
                path_bonus,
                anchor_bonus: 0.0,
                final_score: 0.0,
            }
        })
        .collect();

    let omega = compute_omega(&input);
    let mode = morphology.dominant_mode.as_str();
    assign_v3_scores(&mut work, mode, &omega, &input.config);
    work.sort_by(|left, right| {
        right
            .final_score
            .partial_cmp(&left.final_score)
            .unwrap_or(Ordering::Equal)
            .then_with(|| {
                right
                    .curve
                    .union_score
                    .partial_cmp(&left.curve.union_score)
                    .unwrap_or(Ordering::Equal)
            })
            .then_with(|| left.curve.union_rank.cmp(&right.curve.union_rank))
    });
    let wormhole_traces = wormhole::fuse_rrf(&mut work, &wormhole_model, &input, &omega);
    // Stable sort retains the complete baseline comparator for equal fusion scores.
    work.sort_by(|a, b| b.final_score.total_cmp(&a.final_score));
    let ranked_count = work.len();

    let results: Vec<NativeResultItem> = work
        .into_iter()
        .take(input.top_k.max(1))
        .enumerate()
        .map(|(index, item)| {
            // Same set as before, listed in curve order instead of hash order.
            let mut seen_names = HashSet::new();
            let matched_tags: Vec<String> = item
                .curve
                .tags
                .iter()
                .filter(|tag| seen_names.insert(tag.name.as_str()))
                .map(|tag| tag.name.clone())
                .collect();
            let core_tags_matched = matched_tags
                .iter()
                .filter(|name| core_tag_names.contains(&name.to_lowercase()))
                .cloned()
                .collect();
            let topology_v3 = if input.include_trace {
                Some(json!({
                    "mode": "conservative_candidate_self_topology_v2.2",
                    "branchNodeCoverage": clamp01(item.topology.matched_node_coverage / 0.35),
                    "branchEdgeCoverage": clamp01(item.topology.matched_edge_coverage / 0.20),
                    "branchCoverage": branch_coverage(&item.topology, mode),
                    "branchConfidence": branch_confidence(&item.topology, mode),
                    "strongestNodeMatchQuality": item.topology.strongest_node_match_quality,
                    "precisionGrounding": precision_grounding(&item.topology),
                    "fieldSupport": item.observables.field_support,
                    "fieldResonanceBeforeSupport": field_resonance(&item.curve, &input, 1.0).2,
                    "queryScore": clamp01(item.curve.query_score),
                    "fieldScore": item.field_score,
                    "fieldResonanceBonus": item.field_resonance_bonus,
                    "directEvidence": item.direct_evidence,
                    "omega": omega.omega,
                    "regime": omega.regime,
                    "omegaEdge": omega.omega_edge,
                    "omegaEmerge": omega.omega_emerge,
                    "omegaFlow": omega.omega_flow,
                    "omegaGamma": input.config.omega_gamma,
                    "graphGate": omega.omega.powf(input.config.omega_gamma.max(0.0)),
                    "v2Bonus": item.v2_bonus,
                    "gatedV2Bonus": item.gated_bonus,
                    "anchorScore": item.anchor.score,
                    "anchorReliability": item.anchor.reliability,
                    "anchorStrength": item.anchor.strength,
                    "implicitOnlyAnchor": item.anchor.implicit_only,
                    "explicitExactContacts": item.anchor.explicit_exact_contacts,
                    "explicitSemanticContacts": item.anchor.explicit_semantic_contacts,
                    "hasExplicitFocus": item.anchor.has_explicit_focus,
                    "anchorBonus": item.anchor_bonus,
                    "contactedSeeds": item.anchor.contacted_seeds,
                    "exactContacts": item.anchor.exact_contacts,
                    "semanticContacts": item.anchor.semantic_contacts,
                    "meanClosure": item.anchor.mean_closure,
                    "role": item.role,
                    "pureScore": item.pure_score,
                    "pathBonus": item.path_bonus,
                    "graphBonus": item.gated_bonus,
                    "requestedGraphBonus": item.v2_bonus * omega.omega.powf(input.config.omega_gamma.max(0.0)),
                    "finalScore": item.final_score,
                    "nativeBackend": "rust-rayon"
                })).map(|mut trace| {
                    trace["wormholeRrf"] = wormhole_traces
                        .get(&item.curve.id)
                        .cloned()
                        .unwrap_or(Value::Null);
                    trace
                })
            } else {
                None
            };
            NativeResultItem {
                id: item.curve.id,
                chunk_id: item.curve.id,
                rank: index + 1,
                score: item.final_score,
                base_score: item.pure_score,
                field_score: item.field_score,
                field_resonance_bonus: item.field_resonance_bonus,
                topology_bonus: item.path_bonus + item.gated_bonus,
                anchor_bonus: item.anchor_bonus,
                path_bonus: item.path_bonus,
                graph_bonus: item.gated_bonus,
                score_clipping: positive(
                    item.pure_score + item.path_bonus + item.gated_bonus + item.anchor_bonus
                        - wormhole_traces
                            .get(&item.curve.id)
                            .and_then(|v| v["baselineScore"].as_f64())
                            .unwrap_or(item.final_score),
                ),
                role: item.role,
                omega: omega.omega,
                river_regime: omega.regime.clone(),
                matched_tags,
                core_tags_matched,
                candidate_sources: item.curve.sources,
                original_score: original_score_by_id
                    .get(&item.curve.id)
                    .copied()
                    .unwrap_or(0.0),
                topology_v3,
                relative_topology: input.include_trace.then_some(item.topology),
                geometry: input.include_trace.then_some(item.geometry),
                observables: input.include_trace.then_some(item.observables),
            }
        })
        .collect();
    let compute_ms = compute_started.elapsed().as_secs_f64() * 1000.0;

    let output = NativeOutput {
        schema: RESULT_SCHEMA.to_string(),
        algorithm_version: ALGORITHM_VERSION.to_string(),
        artifact_sig: artifact_sig.to_string(),
        query_id: input.query_state.query_id.clone(),
        omega,
        query_mode: mode.to_string(),
        query_morphology: morphology,
        diagnostics: NativeDiagnostics {
            backend: "rust-rayon-sqlite".to_string(),
            offered_candidates: input.candidates.len(),
            projected_candidates: projected_count,
            selected_candidates: selected_count,
            ranked_candidates: ranked_count,
            returned_candidates: results.len(),
            rayon_threads: rayon::current_num_threads(),
            artifact_nodes: artifact.node_ids.len(),
            artifact_edges: artifact.targets.len(),
            load_ms,
            compute_ms,
            total_ms: total_started.elapsed().as_secs_f64() * 1000.0,
            chunk_sql_batches: curve_load.chunk_sql_batches,
            file_tag_sql_batches: curve_load.file_tag_sql_batches,
            query_tag_sql_batches,
            candidate_tag_vector_sql_batches: domain_stats.sql_batches + selected_stats.sql_batches,
            candidate_tag_vector_fetched_nodes: domain_stats.fetched_nodes
                + selected_stats.fetched_nodes,
        },
        results,
        parameters: json!({
            "parsedConfig": input.config,
            "wormholeGateMode": "global-two-joint-files-distinct-checksums-third-tag-explicit-focus",
            "wormholeEvidenceScope": "global-file-tag-graph; independent-of-candidate-and-retrieval-scope",
            "wormholeGate": wormhole_gate,
            "wormholeEligibleRoutes": wormhole_model.eligible_routes,
            "wormholeAcceptedRoutes": wormhole_model.routes.len(),
            "wormholeScoring": "strict-global-gate; explanation-weighted-RRF; untouched-baseline-channel",
            "wormholeRrfK": 60,
            "wormholeStrongFlowRatio": 0.5,
            "wormholeWeightReference": "maximum observed non-return ordinary edge flow; observation maximum if absent",
            "baselineAlgorithm": "rivermemo.conservative-topology-v2.2",
            "fieldResonanceCap": 0.03,
            "fieldSupportPotentialSaturation": 0.02,
            "fieldSupportCoverageSaturation": 0.5,
            "fieldSupportTailCap": 0.1,
            "implicitContactDiscount": 0.35,
            "implicitStrengthCap": 0.035,
            "weakSemanticPivot": 0.65,
            "span2Discount": 0.7,
            "globalOnlyPathGain": 0.5,
            "unsupportedTagAllowance": 6,
            "unsupportedTagScale": 16,
            "branchNodeSaturation": 0.35,
            "branchEdgeSaturation": 0.20,
            "branchEdgeWeight": 0.70,
            "branchNodeWeight": 0.30,
            "branchNodeOnlyWeight": 0.35,
            "softMatchQualityThreshold": 0.65,
            "softMatchDiscount": 0.65,
            "graphConfidence": "sqrt(branchCoverage*meanClosure*nodeAlignmentScore)",
            "graphReward": "candidate-self-no-role-multiplier",
            "retiredControls": ["conditionalBandwidth", "conditionalClosureBandwidth",
                "conditionalDirectBandwidth", "minimumPeers", "minimumEffectivePeers",
                "innovationConfidenceZ", "innovationScale", "anchorActivationZ",
                "anchorFrontierContrast", "anchorFrontierAbsFloor", "reliabilitySeedSaturation"]
        }),
    };
    serde_json::to_string(&output)
        .map_err(|error| format!("encode RiverMemo native output failed: {}", error))
}

pub struct RiverMemoTopologyV3Task {
    runtime: Arc<MemoRuntime>,
    db_path: String,
    artifact_sig: String,
    input_json: String,
}

impl Task for RiverMemoTopologyV3Task {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        run_native(
            &self.runtime,
            &self.db_path,
            &self.artifact_sig,
            &self.input_json,
        )
        .map_err(Error::from_reason)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub(crate) fn rerank_with_runtime(
    runtime: Arc<MemoRuntime>,
    db_path: String,
    artifact_sig: String,
    input_json: String,
) -> AsyncTask<RiverMemoTopologyV3Task> {
    AsyncTask::new(RiverMemoTopologyV3Task {
        runtime,
        db_path,
        artifact_sig,
        input_json,
    })
}
