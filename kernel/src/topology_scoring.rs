//! topology_scoring —— 票 09：RiverMemo Topology V3 判分心脏复刻。
//! 上游位于 rivermemo_topology_v3.rs 的判分段（:69-2857）；此处独立成模块便于
//! 增量演进，规格来源 = kernel/docs/reverse-topology-v3.md（v1）+ 上游源码逐行对照。
//!
//! 刻意差异（均 ULP 级、输出集合等价）：alignments 用 BTreeMap、matched_tags 用
//! BTreeSet——上游 HashMap/HashSet 迭代序连自身跨进程都不稳定。

use crate::rivermemo_topology_v3::{
    clamp01, load_artifact_from_runtime, positive, MemoRuntime, NativeArtifact,
};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};
use rusqlite::{Connection, OpenFlags};

const RESULT_SCHEMA: &str = "rivermemo-topology-v3-native-result-v1";
const ALGORITHM_VERSION: &str = "rivermemo.topology-v3.1-rust";

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

fn cosine_f32(left: &[f32], right: &[f32]) -> f64 {
    if left.len() != right.len() || left.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f64;
    let mut na = 0.0f64;
    let mut nb = 0.0f64;
    for index in 0..left.len() {
        dot += left[index] as f64 * right[index] as f64;
        na += left[index] as f64 * left[index] as f64;
        nb += right[index] as f64 * right[index] as f64;
    }
    let denominator = na.sqrt() * nb.sqrt();
    if denominator > 1e-12 {
        dot / denominator
    } else {
        0.0
    }
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
    allowed_file_ids: Vec<i64>,
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

#[derive(Deserialize)]
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
            semantic_anchor_threshold: 0.8,
            semantic_anchor_discount: 0.7,
            specificity_floor: 0.35,
            rarity_floor: 0.15,
            reliability_seed_saturation: 2.0,
            fallback_reliability_cap: 0.5,
            pure_query_weight: 0.25,
            pure_local_weight: 0.2,
            pure_transfer_weight: 0.15,
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
    vector: Vec<f32>,
    chunk_cosine: f64,
}

#[derive(Clone)]
struct Curve {
    id: i64,
    file_id: i64,
    tags: Vec<TagData>,
    chunk_vector: Vec<f32>,
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

struct CurveLoadOutput {
    curves: Vec<Curve>,
    chunk_sql_batches: usize,
    file_tag_sql_batches: usize,
}

fn load_curves(
    db_path: &str,
    candidates: &[CandidateInput],
    dimension: usize,
) -> std::result::Result<CurveLoadOutput, String> {
    const SQLITE_BATCH_SIZE: usize = 500;

    let connection = open_readonly(db_path)?;
    let candidate_ids: Vec<i64> = candidates
        .iter()
        .map(|candidate| candidate.id)
        .filter(|id| *id > 0)
        .collect();
    let mut chunks_by_id: HashMap<i64, (i64, Vec<f32>)> =
        HashMap::with_capacity(candidate_ids.len());
    let mut unique_file_ids = HashSet::new();

    let mut chunk_sql_batches = 0usize;
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
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                ))
            })
            .map_err(|error| format!("query batched chunk projection failed: {}", error))?;
        for row in rows {
            let Ok((id, file_id, bytes)) = row else {
                continue;
            };
            let Some(vector) = decode_vector(&bytes, dimension) else {
                continue;
            };
            unique_file_ids.insert(file_id);
            chunks_by_id.insert(id, (file_id, vector));
        }
    }

    let file_ids: Vec<i64> = unique_file_ids.into_iter().collect();
    let mut tags_by_file: HashMap<i64, Vec<(i64, i64, String, Vec<f32>)>> =
        HashMap::with_capacity(file_ids.len());
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
            "SELECT ft.file_id, ft.tag_id, COALESCE(ft.position, 0), t.name, t.vector \
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
                    row.get::<_, Vec<u8>>(4)?,
                ))
            })
            .map_err(|error| format!("query batched tag curve projection failed: {}", error))?;
        for row in rows {
            let Ok((file_id, tag_id, position, name, bytes)) = row else {
                continue;
            };
            if let Some(vector) = decode_vector(&bytes, dimension) {
                tags_by_file
                    .entry(file_id)
                    .or_default()
                    .push((tag_id, position, name, vector));
            }
        }
    }

    let mut curves = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let Some((file_id, chunk_vector)) = chunks_by_id.get(&candidate.id) else {
            continue;
        };
        let tags = tags_by_file
            .get(file_id)
            .into_iter()
            .flatten()
            .map(|(id, position, name, vector)| TagData {
                id: *id,
                position: *position,
                name: name.clone(),
                vector: vector.clone(),
                chunk_cosine: clamp01(cosine_f32(vector, chunk_vector)),
            })
            .collect();

        curves.push(Curve {
            id: candidate.id,
            file_id: *file_id,
            tags,
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
        chunk_sql_batches,
        file_tag_sql_batches,
    })
}

fn load_tag_vectors_by_ids(
    connection: &Connection,
    ids: &[i64],
    dimension: usize,
) -> std::result::Result<(HashMap<i64, Vec<f32>>, usize), String> {
    const SQLITE_BATCH_SIZE: usize = 500;

    let mut unique_ids: Vec<i64> = ids
        .iter()
        .copied()
        .filter(|id| *id > 0)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    unique_ids.sort_unstable();

    let mut vectors = HashMap::with_capacity(unique_ids.len());
    let mut sql_batches = 0usize;
    for batch in unique_ids.chunks(SQLITE_BATCH_SIZE) {
        if batch.is_empty() {
            continue;
        }
        sql_batches += 1;
        let placeholders = std::iter::repeat("?")
            .take(batch.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!("SELECT id, vector FROM tags WHERE id IN ({})", placeholders);
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| format!("prepare batched Tag vector read failed: {}", error))?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(batch.iter()), |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
            })
            .map_err(|error| format!("query batched Tag vectors failed: {}", error))?;
        for row in rows {
            let Ok((id, bytes)) = row else {
                continue;
            };
            if let Some(vector) = decode_vector(&bytes, dimension) {
                vectors.insert(id, vector);
            }
        }
    }
    Ok((vectors, sql_batches))
}

fn compute_anchor_scores(curves: &mut [Curve], local_domain: &HashSet<i64>) {
    if local_domain.is_empty() {
        return;
    }
    let max_hits = curves
        .iter()
        .map(|curve| {
            curve
                .tags
                .iter()
                .filter(|tag| local_domain.contains(&tag.id))
                .count()
        })
        .max()
        .unwrap_or(0);
    if max_hits == 0 {
        return;
    }
    for curve in curves {
        let hits = curve
            .tags
            .iter()
            .filter(|tag| local_domain.contains(&tag.id))
            .count();
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
            source_top(&curves, |curve| curve.transfer_score, config.transfer_field_k),
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
    for pair in curve.tags.windows(2) {
        let current = &pair[0];
        let next = &pair[1];
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
        let semantic_continuity = clamp01((cosine_f32(&current.vector, &next.vector) + 1.0) / 2.0);
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
        let supported = (local_supported || transfer_supported) && (forward > 0.0 || reverse > 0.0);
        let weight_total = (config.local_weight + config.transfer_weight).max(1e-12);
        let potential = (config.local_weight * local_potential
            + config.transfer_weight * transfer_potential)
            / weight_total;
        let quality = if supported {
            clamp01(
                potential
                    * direction.max(config.direction_floor).sqrt()
                    * continuity.max(0.0).sqrt(),
            )
        } else {
            0.0
        };
        output.segment_count += 1;
        output.supported_segments += usize::from(supported);
        output.transfer_segments += usize::from(
            supported
                && transfer_supported
                && (!local_supported || transfer_potential > local_potential),
        );
        output.mean_direction += direction;
        output.mean_continuity += continuity;
        output.mean_local_potential += local_potential;
        output.mean_transfer_potential += transfer_potential;
        quality_mass += quality;
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

fn evaluate_topology(
    curve: &Curve,
    input: &NativeInput,
    artifact: &NativeArtifact,
    query_tag_vectors: &HashMap<i64, Vec<f32>>,
) -> TopologyOutput {
    let mut output = TopologyOutput {
        query_nodes: input.query_state.river_nodes.len(),
        ..TopologyOutput::default()
    };
    let mut alignments: BTreeMap<i64, Alignment> = BTreeMap::new();
    let mut total_node_weight = 0.0;
    let mut matched_node_weight = 0.0;
    let mut node_quality_mass = 0.0;

    for node in &input.query_state.river_nodes {
        let weight = positive(if node.normalized_energy != 0.0 {
            node.normalized_energy
        } else {
            node.energy
        })
        .max(1e-9);
        total_node_weight += weight;
        let exact = curve
            .tags
            .iter()
            .enumerate()
            .find(|item| item.1.id == node.id);
        let alignment = if let Some((index, tag)) = exact {
            Some(Alignment {
                candidate_index: index,
                candidate_position: tag.position,
                quality: tag.chunk_cosine.sqrt(),
                closure: tag.chunk_cosine,
            })
        } else {
            let query_vector = query_tag_vectors.get(&node.id);
            curve
                .tags
                .iter()
                .enumerate()
                .filter_map(|(index, tag)| {
                    let similarity = query_vector
                        .map(|vector| clamp01(cosine_f32(vector, &tag.vector)))
                        .unwrap_or(0.0);
                    if similarity < input.config.semantic_node_threshold {
                        return None;
                    }
                    let normalized = clamp01(
                        (similarity - input.config.semantic_node_threshold)
                            / (1.0 - input.config.semantic_node_threshold).max(1e-9),
                    );
                    Some(Alignment {
                        candidate_index: index,
                        candidate_position: tag.position,
                        quality: (normalized * tag.chunk_cosine).sqrt(),
                        closure: tag.chunk_cosine,
                    })
                })
                .max_by(|left, right| {
                    left.quality
                        .partial_cmp(&right.quality)
                        .unwrap_or(Ordering::Equal)
                        .then_with(|| right.candidate_index.cmp(&left.candidate_index))
                })
        };
        if let Some(alignment) = alignment {
            matched_node_weight += weight;
            node_quality_mass += weight * alignment.quality;
            alignments.insert(node.id, alignment);
        }
    }

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
        matched_edge_weight += edge_weight;
        distance_mass += edge_weight * distance_similarity;
        direction_mass += edge_weight * direction_similarity;
        topology_mass += edge_weight * edge_quality;
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
}

fn evaluate_observables(
    curve: &Curve,
    geometry: &GeometryOutput,
    input: &NativeInput,
    workspace: &FieldWorkspace,
    visible: bool,
) -> ObservableOutput {
    let chain_size = curve.tags.len().max(1) as f64;
    let mut exact_seed_hits = 0usize;
    let mut local_contacts = 0usize;
    let mut transfer_contacts = 0usize;
    let mut local_potential = 0.0;
    let mut transfer_potential = 0.0;
    let mut tail_only = 0usize;
    let mut boundary: f64 = 0.0;

    for tag in &curve.tags {
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
            .max((clamp01(cosine_f32(&input.query.vector, &tag.vector)) * tag.chunk_cosine).sqrt());
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
    let query_chunk = clamp01(cosine_f32(&input.query.vector, &curve.chunk_vector));
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
    mean_closure: f64,
}

fn anchor_contacts(
    curve: &Curve,
    seeds: &[(i64, f64)],
    seed_vectors: &HashMap<i64, Vec<f32>>,
    config: &NativeConfig,
) -> Vec<(i64, i64, bool, f64, f64, f64)> {
    let mut contacts = Vec::new();
    for (seed_id, mass) in seeds {
        if let Some(tag) = curve.tags.iter().find(|tag| tag.id == *seed_id) {
            contacts.push((*seed_id, tag.id, true, 1.0, *mass, tag.chunk_cosine));
            continue;
        }
        let Some(seed_vector) = seed_vectors.get(seed_id) else {
            continue;
        };
        if let Some((tag, similarity)) = curve
            .tags
            .iter()
            .map(|tag| (tag, cosine_f32(seed_vector, &tag.vector)))
            .filter(|item| item.1 >= config.semantic_anchor_threshold)
            .max_by(|left, right| left.1.partial_cmp(&right.1).unwrap_or(Ordering::Equal))
        {
            contacts.push((*seed_id, tag.id, false, similarity, *mass, tag.chunk_cosine));
        }
    }
    contacts
}

fn compute_anchors(
    curves: &[Curve],
    seeds: &[(i64, f64)],
    seed_vectors: &HashMap<i64, Vec<f32>>,
    artifact: &NativeArtifact,
    config: &NativeConfig,
    fallback: bool,
) -> Vec<AnchorOutput> {
    let contacts: Vec<Vec<(i64, i64, bool, f64, f64, f64)>> = curves
        .par_iter()
        .map(|curve| anchor_contacts(curve, seeds, seed_vectors, config))
        .collect();
    let mut pool_counts: HashMap<i64, usize> = seeds.iter().map(|seed| (seed.0, 0)).collect();
    for candidate_contacts in &contacts {
        for contact in candidate_contacts {
            *pool_counts.entry(contact.0).or_default() += 1;
        }
    }
    let max_seed_mass = seeds
        .iter()
        .map(|seed| positive(seed.1))
        .fold(0.0, f64::max);
    contacts
        .into_par_iter()
        .map(|candidate_contacts| {
            let mut no_contact_probability = 1.0;
            let mut closure_sum = 0.0;
            let mut exact = 0usize;
            for contact in &candidate_contacts {
                let inbound = artifact.inbound.get(&contact.1).copied().unwrap_or(0.0);
                let specificity = if artifact.max_inbound > 0.0 {
                    config
                        .specificity_floor
                        .max(1.0 - clamp01(inbound / artifact.max_inbound).sqrt())
                } else {
                    1.0
                };
                let rarity = config.rarity_floor.max(
                    1.0 - pool_counts.get(&contact.0).copied().unwrap_or(0) as f64
                        / curves.len().max(1) as f64,
                );
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
                };
                let contribution =
                    clamp01(normalized_mass * specificity * contact.5 * rarity * match_weight);
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
            let mut reliability = clamp01(
                (mean_closure
                    * (contacted as f64 / config.reliability_seed_saturation.max(1.0)).min(1.0))
                .sqrt(),
            );
            if fallback {
                reliability = reliability.min(config.fallback_reliability_cap);
            }
            AnchorOutput {
                score,
                reliability,
                strength: clamp01(score * reliability),
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
    graph_score: f64,
    direct_evidence: f64,
    role: String,
    anchor: AnchorOutput,
    v2_bonus: f64,
    gated_bonus: f64,
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
    let maximum_pure = work.iter().map(|item| item.pure_score).fold(0.0, f64::max);
    for item in work.iter_mut() {
        let near_frontier = item.pure_score >= maximum_pure - 0.03;
        let direct_answer = mode != "atomic"
            && item.observables.closure >= 0.55
            && (item.direct_evidence >= 0.55 || (near_frontier && item.curve.query_score >= 0.55));
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

    let direct_frontier = work
        .iter()
        .filter(|item| item.role == "direct_answer")
        .map(|item| item.pure_score)
        .fold(0.0, f64::max);

    for index in 0..work.len() {
        let mut peers: Vec<(usize, f64)> = (0..work.len())
            .filter(|peer| *peer != index)
            .map(|peer| {
                let pure_delta = (work[peer].pure_score - work[index].pure_score)
                    / config.conditional_bandwidth.max(1e-4);
                let closure_delta = (work[peer].observables.closure
                    - work[index].observables.closure)
                    / config.conditional_closure_bandwidth.max(1e-4);
                let direct_delta = (work[peer].direct_evidence - work[index].direct_evidence)
                    / config.conditional_direct_bandwidth.max(1e-4);
                let role_weight = if work[peer].role == work[index].role {
                    1.0
                } else {
                    0.35
                };
                (
                    peer,
                    role_weight
                        * (-0.5
                            * (pure_delta * pure_delta
                                + closure_delta * closure_delta
                                + direct_delta * direct_delta))
                            .exp(),
                )
            })
            .collect();
        peers.sort_by(|left, right| right.1.partial_cmp(&left.1).unwrap_or(Ordering::Equal));
        peers.retain(|entry| entry.1 >= 1e-4);
        if peers.len() < config.minimum_peers {
            let existing: HashSet<usize> = peers.iter().map(|entry| entry.0).collect();
            let mut fallback: Vec<(usize, f64)> = (0..work.len())
                .filter(|peer| *peer != index && !existing.contains(peer))
                .map(|peer| (peer, 1e-4))
                .take(config.minimum_peers.saturating_sub(peers.len()))
                .collect();
            peers.append(&mut fallback);
        }
        let total_weight: f64 = peers.iter().map(|entry| entry.1).sum();
        let squared_weight: f64 = peers.iter().map(|entry| entry.1 * entry.1).sum();
        let expected = if total_weight > 1e-12 {
            peers
                .iter()
                .map(|entry| entry.1 * work[entry.0].graph_score)
                .sum::<f64>()
                / total_weight
        } else {
            work[index].graph_score
        };
        let variance = if total_weight > 1e-12 {
            peers
                .iter()
                .map(|entry| entry.1 * (work[entry.0].graph_score - expected).powi(2))
                .sum::<f64>()
                / total_weight
        } else {
            0.0
        };
        let effective_peers = if squared_weight > 1e-12 {
            total_weight * total_weight / squared_weight
        } else {
            0.0
        };
        let uncertainty = (variance * (1.0 + 1.0 / effective_peers.max(1.0))).sqrt();
        let innovation = positive(
            work[index].graph_score - expected - config.innovation_confidence_z * uncertainty,
        );
        let candidate_confidence = if mode == "atomic" {
            (work[index].observables.closure
                * clamp01(
                    0.55 * work[index].topology.matched_node_coverage
                        + 0.45 * work[index].topology.node_alignment_score,
                ))
            .sqrt()
        } else {
            (work[index].observables.closure
                * clamp01(
                    0.75 * work[index].topology.matched_edge_coverage
                        + 0.25 * work[index].topology.matched_node_coverage,
                )
                * clamp01(
                    0.7 * work[index].topology.reliability
                        + 0.3 * work[index].topology.node_alignment_score,
                ))
            .cbrt()
        };
        let statistical = clamp01(effective_peers / config.minimum_effective_peers);
        let combined_confidence = clamp01(candidate_confidence * statistical);
        let (role_cap, multiplier) = match work[index].role.as_str() {
            "atomic_concept" => (config.topology_bonus_cap, 1.0),
            "direct_answer" => (0.02, 0.35),
            "structural_explanation" => (0.045, 0.7),
            _ => (0.008, 0.15),
        };
        let requested = innovation * combined_confidence * config.innovation_scale * multiplier;
        let mut bonus = requested.min(role_cap).min(config.topology_bonus_cap);
        if direct_frontier > 0.0 && work[index].role != "direct_answer" && mode != "atomic" {
            bonus = bonus.min(positive(direct_frontier - 0.005 - work[index].pure_score));
        }
        work[index].v2_bonus = clamp01(bonus);
    }

    let anchor_mean = if work.is_empty() {
        0.0
    } else {
        work.iter().map(|item| item.anchor.strength).sum::<f64>() / work.len() as f64
    };
    let anchor_variance = if work.is_empty() {
        0.0
    } else {
        work.iter()
            .map(|item| (item.anchor.strength - anchor_mean).powi(2))
            .sum::<f64>()
            / work.len() as f64
    };
    let anchor_std = anchor_variance.sqrt();
    let threshold = clamp01(
        config
            .anchor_activation_floor
            .max(anchor_mean + config.anchor_activation_z * anchor_std),
    );
    let mut ranked_anchors: Vec<(usize, f64)> = work
        .iter()
        .enumerate()
        .map(|(index, item)| (index, item.anchor.strength))
        .collect();
    ranked_anchors.sort_by(|left, right| right.1.partial_cmp(&left.1).unwrap_or(Ordering::Equal));
    let strongest = ranked_anchors.first().copied();
    let second = ranked_anchors.get(1).map(|item| item.1).unwrap_or(0.0);
    let promote = strongest
        .map(|item| {
            item.1 >= config.anchor_frontier_abs_floor
                && item.1 >= config.anchor_frontier_contrast * second
        })
        .unwrap_or(false);
    let graph_gate = omega.omega.powf(config.omega_gamma.max(0.0));

    for (index, item) in work.iter_mut().enumerate() {
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
        if promote && strongest.map(|entry| entry.0) == Some(index) {
            item.role = "direct_answer".to_string();
        } else if omega.omega < config.struct_role_min_omega
            && item.role == "structural_explanation"
        {
            item.role = "thematic_neighbor".to_string();
        }
        item.gated_bonus = item.v2_bonus * graph_gate;
        item.final_score = clamp01(item.pure_score + item.gated_bonus + item.anchor_bonus);
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
    topology_bonus: f64,
    anchor_bonus: f64,
    role: String,
    omega: f64,
    river_regime: String,
    matched_tags: Vec<String>,
    core_tags_matched: Vec<String>,
    candidate_sources: Vec<String>,
    original_score: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    topology_v3: Option<serde_json::Value>,
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
    diagnostics: NativeDiagnostics,
    results: Vec<NativeResultItem>,
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
    let artifact = load_artifact_from_runtime(runtime, db_path, artifact_sig)?;
    let curve_load = load_curves(db_path, &input.candidates, dimension)?;
    let mut curves = curve_load.curves;
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
    compute_anchor_scores(&mut curves, &local_domain);
    curves.par_iter_mut().for_each(|curve| {
        curve.query_score = cosine_f32(&input.query.vector, &curve.chunk_vector);
        curve.denoised_score = cosine_f32(&input.denoised_vector, &curve.chunk_vector);
        curve.local_score = cosine_f32(&input.local_vector, &curve.chunk_vector);
        curve.transfer_score = cosine_f32(&input.transfer_vector, &curve.chunk_vector);
    });
    let projected_count = curves.len();
    let curves = select_superset(curves, &input.config);
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
    };
    let direct_ids: Vec<i64> = input
        .query_state
        .field_provenance
        .iter()
        .filter(|entry| {
            entry.hop == 0 && (entry.source_type == "core" || entry.source_type == "seed")
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
    let seeds: Vec<(i64, f64)> = input
        .query_state
        .source_field
        .iter()
        .filter(|entry| anchor_ids.contains(&entry.0) && entry.1 > 0.0)
        .copied()
        .collect();

    let mut requested_tag_ids: Vec<i64> = input
        .query_state
        .river_nodes
        .iter()
        .map(|node| node.id)
        .collect();
    requested_tag_ids.extend(seeds.iter().map(|seed| seed.0));
    let connection = open_readonly(db_path)?;
    let (query_and_seed_tag_vectors, query_tag_sql_batches) =
        load_tag_vectors_by_ids(&connection, &requested_tag_ids, dimension)?;
    drop(connection);
    let load_ms = load_started.elapsed().as_secs_f64() * 1000.0;

    let compute_started = Instant::now();
    let morphology = compute_query_morphology(&input);
    let allowed: HashSet<i64> = input.allowed_file_ids.iter().copied().collect();
    let explicit_scope = !allowed.is_empty();

    let anchor_results = compute_anchors(
        &curves,
        &seeds,
        &query_and_seed_tag_vectors,
        &artifact,
        &input.config,
        fallback_anchor,
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
            let topology = evaluate_topology(
                &curve,
                &input,
                &artifact,
                &query_and_seed_tag_vectors,
            );
            let visible = !explicit_scope || allowed.contains(&curve.file_id);
            let observables = evaluate_observables(&curve, &geometry, &input, &workspace, visible);
            let semantic_total = (input.config.pure_query_weight
                + input.config.pure_local_weight
                + input.config.pure_transfer_weight)
            .max(1e-12);
            let semantic_base = clamp01(
                (input.config.pure_query_weight * clamp01(curve.query_score)
                    + input.config.pure_local_weight * clamp01(curve.local_score)
                    + input.config.pure_transfer_weight * clamp01(curve.transfer_score))
                    / semantic_total,
            );
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
            let pure_score =
                clamp01(semantic_base + topology_bonus.min(input.config.topology_bonus_cap));
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
                graph_score,
                role: String::new(),
                anchor,
                v2_bonus: 0.0,
                gated_bonus: 0.0,
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
    let ranked_count = work.len();

    let results: Vec<NativeResultItem> = work
        .into_iter()
        .take(input.top_k.max(1))
        .enumerate()
        .map(|(index, item)| {
            let matched_tags: Vec<String> = item
                .curve
                .tags
                .iter()
                .map(|tag| tag.name.clone())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            let core_tags_matched = matched_tags
                .iter()
                .filter(|name| core_tag_names.contains(&name.to_lowercase()))
                .cloned()
                .collect();
            let topology_v3 = if input.include_trace {
                Some(json!({
                    "mode": "river_observability_gated_v2_with_direct_anchor",
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
                    "anchorBonus": item.anchor_bonus,
                    "contactedSeeds": item.anchor.contacted_seeds,
                    "exactContacts": item.anchor.exact_contacts,
                    "semanticContacts": item.anchor.semantic_contacts,
                    "meanClosure": item.anchor.mean_closure,
                    "role": item.role,
                    "pureScore": item.pure_score,
                    "finalScore": item.final_score,
                    "nativeBackend": "rust-rayon"
                }))
            } else {
                None
            };
            NativeResultItem {
                id: item.curve.id,
                chunk_id: item.curve.id,
                rank: index + 1,
                score: item.final_score,
                base_score: item.pure_score,
                topology_bonus: item.gated_bonus,
                anchor_bonus: item.anchor_bonus,
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
        },
        results,
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
