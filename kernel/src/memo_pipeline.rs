//! memo_pipeline —— 票 08 + VCP 2.0 复刻 P1.2：行为等价复刻上游 memo_pipeline.rs（2.0 HEAD 2460 行）。
//! EPA 轴分析 → 残差金字塔（Gram-Schmidt）→ Handshake → 门控 → Spike 感知 → 融合 → 双场传播。
//! 公式与系数逐字对齐上游；索引层为 usearch（同版本/同参数/同插入序 → 同 knn 结果）。
//!
//! P1.2：①金字塔按层收集**输入残差**（仅 dynamic_wormholes 开时，上游 696）；
//! ②DynamicWormholeContext 接线（上游 1759-1780：seed_levels 由 level_tags 最小层号构建，
//! 层相似度经 reuse_score 复用）；③请求级 TagVectorPool 跨金字塔/融合/双场三段共享
//! （池优先、索引兜底，既有读数口径不变）。缺省 dynamic_wormholes=false → 残差为空、
//! context 被 sensing 强制 None，行为逐字等于 v9.2（五腿零漂移硬判据）。
//!
//! P1.3（暗上线，P3 已退役）：双场投影增 basin 圈选分支——`maxProjectionNodes > 0` 时走
//! memo_projection::{seed_basins, grow}（上游 1404/1412/1806），圈选并集一次性补池（:1431）。
//! P3 二轮：对齐上游 9aa1f67 无条件语义——river_ids + seed_basins 每查询现算，
//! 投影恒走 basin 圈选，预算 = `maxFieldProjectionNodes`（缺省 256）；v9.2 全支撑
//! 投影（project_field）与闸键 `maxProjectionNodes` 同步退役（停止消费）。
//!
//! P3（上游 174a5e1→9aa1f67，conservative-topology-v2.2）：金字塔 safe-stoploss
//! （边际解释能量 < minLayerExplainedEnergy=0.03 止损）、贡献门控（同层 max 贡献 10% 与
//! 绝对 0.05 下限）、隐式种子等比例缩放（显式最大 0.35 倍）、路由残差尾部（尾残差能量
//! 占比 ≥2% 追加、只供路由不当种子层）、图外 Tag 金字塔前置过滤（eligible=node_index）、
//! lexical 锚定（ASCII 词 + CJK bigram，grounding≥0.5）、显式 Core 种子 SQL 解析促升、
//! 双场单趟 pair 传播 + relax_field、basin 投影 hub 折扣。相似度缺省从 legacy 翻为 cosine
//! （对齐上游无条件 cosine；legacy 保留为显式兼容档）。

use crate::memo_sensing::{
    sense_typed, sense_with_context, DynamicWormholeContext, SenseConfig, SenseDiagnostics,
    SenseInput, SenseOutput, SenseSeed,
};
use crate::memo_vector_pool::{ensure_tag_vectors_loaded, TagVectorPool};
use crate::rivermemo_topology_v3::{load_artifact_from_runtime, MemoRuntime, NativeArtifact};
use base64::Engine;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};
use usearch::Index;

const PIPELINE_SCHEMA: &str = "vexus-unified-memo-pipeline-v1";
const PIPELINE_ALGORITHM: &str = "memo.conservative-topology-v2.2";

fn positive(value: f64) -> f64 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    }
}

fn clamp01(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

fn magnitude(vector: &[f32]) -> f64 {
    vector
        .iter()
        .map(|value| (*value as f64) * (*value as f64))
        .sum::<f64>()
        .sqrt()
}

fn dot(left: &[f32], right: &[f32]) -> f64 {
    left.iter()
        .zip(right.iter())
        .map(|(a, b)| (*a as f64) * (*b as f64))
        .sum()
}

fn cosine(left: &[f32], right: &[f32]) -> f64 {
    if left.len() != right.len() || left.is_empty() {
        return 0.0;
    }
    let denominator = magnitude(left) * magnitude(right);
    if denominator > 1e-12 {
        dot(left, right) / denominator
    } else {
        0.0
    }
}

/// P2 交付1：金字塔相似度口径。
/// - `legacy` = v9.2 逐字实现：`1/(1+d)`，其中 d 是 usearch 返回的**平方** L2
///   （等价 1/(1+L2²)；实测口径见 research/vcp2.0/port/p2-divergence-2026-10-22.md §5）。
/// - `cosine`（P3 起缺省）= 上游 2.0 `memo_pipeline.rs:648`：`cosine(residual, SQL 原件向量)`。
///
/// 这条通道的杀伤力在动态虫洞：相似度经 `reuse_score` 进 `known_scores` 后被当作
/// 更深层共鸣值，再与 `dynamic_wormhole_threshold`(0.2) 二值化比较——近正交时
/// legacy 给 1/3（恒过阈）、cosine 给 ≈0（恒不过阈）。闸关时 context=None，零漂移。
#[derive(Clone, Copy, Deserialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
enum SimilarityMode {
    Legacy,
    Cosine,
}

fn pyramid_similarity(
    mode: SimilarityMode,
    distance: Option<f32>,
    residual: &[f32],
    vector: &[f32],
) -> f64 {
    match mode {
        SimilarityMode::Legacy => distance
            .map(|distance| 1.0 / (1.0 + distance as f64))
            .unwrap_or(0.0),
        SimilarityMode::Cosine => cosine(residual, vector),
    }
}

/// 配置键优先；缺省（None）= cosine（P3 起：对齐上游 2.0 无条件
/// `cosine(residual, SQL 原件向量)`——上游 memo_pipeline.rs:648）。
/// `legacy` 保留为显式兼容档（v9.2 的 1/(1+L2²)，五腿 vs 1.0 用）。
/// 不做 env 后门（裁决②：kernel 只留一个配置面；B 的 driver 白名单已加转发）。
fn resolve_similarity_mode(configured: Option<SimilarityMode>) -> SimilarityMode {
    configured.unwrap_or(SimilarityMode::Cosine)
}

fn normalize(vector: &mut [f64]) -> bool {
    let norm = vector.iter().map(|value| value * value).sum::<f64>().sqrt();
    if norm <= 1e-12 {
        return false;
    }
    for value in vector {
        *value /= norm;
    }
    true
}

fn open_readonly(path: &str) -> std::result::Result<Connection, String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("open Memo pipeline SQLite failed: {}", error))?;
    connection
        .busy_timeout(Duration::from_secs(30))
        .map_err(|error| format!("configure Memo pipeline timeout failed: {}", error))?;
    connection
        .pragma_update(None, "query_only", "ON")
        .map_err(|error| format!("configure Memo pipeline query_only failed: {}", error))?;
    Ok(connection)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PipelineInput {
    #[serde(default)]
    query_id: Option<String>,
    #[serde(default, rename = "queryText")]
    query_text: String,
    #[serde(default)]
    query_vector: Vec<f32>,
    #[serde(default)]
    core_tags: Vec<String>,
    #[serde(default)]
    ghost_tags: Vec<GhostTagInput>,
    #[serde(default)]
    config: PipelineConfig,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhostTagInput {
    name: String,
    #[serde(default)]
    vector: Vec<f32>,
    #[serde(default)]
    is_core: bool,
}

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct PipelineConfig {
    base_tag_boost: f64,
    core_boost_factor: f64,
    local_alpha: f64,
    transfer_alpha: f64,
    field_max_iterations: usize,
    local_tolerance: f64,
    transfer_tolerance: f64,
    local_mass_ratio: f64,
    transfer_mass_ratio: f64,
    /// P3（上游 9aa1f67 memo_pipeline.rs:118）：双场投影的圈选预算
    /// `maxFieldProjectionNodes`，缺省 256。上游语义为**无条件** basin 圈选
    /// （river_ids + seed_basins 每查询现算，grow 预算 = 本值）。
    /// 旧暗上线键 `maxProjectionNodes`（0 = v9.2 全支撑投影）停止消费：
    /// 差分缺省臂会显式发送 0，若当别名会把 256 预算降级成无界。
    #[serde(default = "default_max_field_projection_nodes")]
    max_field_projection_nodes: usize,
    /// P2 交付1（暗上线）：金字塔相似度口径。缺省（None）= v9.2 的 1/(1+L2²)；
    /// `"cosine"` = 上游 2.0 memo_pipeline.rs:648。
    #[serde(default)]
    similarity_mode: Option<SimilarityMode>,
    /// 诊断档（P2 取证）：把请求级双场投影向量外露到 pipeline metadata 的
    /// `diagnostics.dualFieldVectors`。**只写 pipeline metadata，绝不进 artifact payload**；
    /// 缺省 false ⇒ 输出逐字节不变（五腿零漂移）。
    #[serde(default)]
    debug_dual_field_vectors: bool,
    max_levels: usize,
    pyramid_top_k: usize,
    min_energy_ratio: f64,
    layer_decay: f64,
    /// P3（上游 9aa1f67）：safe-stoploss——层边际解释能量低于此值即止损（不再入层、
    /// 不入 total_explained、不产残差）。容器级 serde default ⇒ 缺键取 Default 0.03。
    min_layer_explained_energy: f64,
    /// P3：贡献门控阈值 = max(同层最大贡献×ratio, floor)。
    seed_contribution_ratio: f64,
    seed_contribution_floor: f64,
    activation_multiplier: Vec<f64>,
    dynamic_boost_range: Vec<f64>,
    core_boost_range: Vec<f64>,
    lang_confidence_enabled: bool,
    lang_penalty_unknown: f64,
    lang_penalty_cross_domain: f64,
    deduplication_threshold: f64,
    max_fusion_tags: usize,
    max_emergent_nodes: usize,
    tech_tag_threshold: f64,
    normal_tag_threshold: f64,
    #[serde(default)]
    spike_routing: SenseConfig,
}

fn default_max_field_projection_nodes() -> usize {
    256
}

impl Default for PipelineConfig {
    fn default() -> Self {
        Self {
            base_tag_boost: 0.6,
            core_boost_factor: 1.33,
            local_alpha: 0.15,
            transfer_alpha: 0.55,
            field_max_iterations: 80,
            local_tolerance: 1e-9,
            transfer_tolerance: 1e-9,
            local_mass_ratio: 0.8,
            transfer_mass_ratio: 0.9,
            max_field_projection_nodes: default_max_field_projection_nodes(), // 上游缺省 256（无条件 basin 圈选）
            similarity_mode: None,   // 暗上线：None = v9.2 的 1/(1+L2²)
            debug_dual_field_vectors: false,
            max_levels: 3,
            pyramid_top_k: 10,
            min_energy_ratio: 0.1,
            layer_decay: 0.7,
            // P3（上游 9aa1f67 Default）：
            min_layer_explained_energy: 0.03,
            seed_contribution_ratio: 0.1,
            seed_contribution_floor: 0.05,
            activation_multiplier: vec![0.5, 1.5],
            dynamic_boost_range: vec![0.3, 2.0],
            core_boost_range: vec![1.2, 1.4],
            lang_confidence_enabled: true,
            lang_penalty_unknown: 0.05,
            lang_penalty_cross_domain: 0.2,
            deduplication_threshold: 0.88,
            max_fusion_tags: 128,
            max_emergent_nodes: 50,
            tech_tag_threshold: 0.08,
            normal_tag_threshold: 0.015,
            spike_routing: SenseConfig::default(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EpaCache {
    basis: Vec<String>,
    mean: String,
    #[serde(default, rename = "energies")]
    _energies: Vec<f64>,
    #[serde(default)]
    labels: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EpaAxis {
    index: usize,
    label: String,
    energy: f64,
    projection: f64,
    score: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EpaBridge {
    from: String,
    to: String,
    strength: f64,
    balance: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EpaOutput {
    logic_depth: f64,
    entropy: f64,
    resonance: f64,
    dominant_axes: Vec<EpaAxis>,
    bridges: Vec<EpaBridge>,
    basis_count: usize,
    cache_available: bool,
}

fn decode_f32_base64(encoded: &str, dimension: usize) -> Option<Vec<f32>> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    if bytes.len() != dimension * std::mem::size_of::<f32>() {
        return None;
    }
    Some(
        bytes
            .chunks_exact(4)
            .map(|chunk| f32::from_ne_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
            .collect(),
    )
}

fn analyze_epa(connection: &Connection, query: &[f32], dimension: usize) -> EpaOutput {
    let empty = || EpaOutput {
        logic_depth: 0.0,
        entropy: 1.0,
        resonance: 0.0,
        dominant_axes: Vec::new(),
        bridges: Vec::new(),
        basis_count: 0,
        cache_available: false,
    };
    let raw = match connection.query_row(
        "SELECT value FROM kv_store WHERE key = 'epa_basis_cache'",
        [],
        |row| row.get::<_, String>(0),
    ) {
        Ok(value) => value,
        Err(_) => return empty(),
    };
    let cache: EpaCache = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(_) => return empty(),
    };
    let mean = match decode_f32_base64(&cache.mean, dimension) {
        Some(value) => value,
        None => return empty(),
    };
    let bases: Vec<Vec<f32>> = cache
        .basis
        .iter()
        .filter_map(|encoded| decode_f32_base64(encoded, dimension))
        .collect();
    if bases.is_empty() {
        return empty();
    }

    let centered: Vec<f32> = query
        .iter()
        .zip(mean.iter())
        .map(|(value, average)| value - average)
        .collect();
    let projections: Vec<f64> = bases.iter().map(|basis| dot(&centered, basis)).collect();
    let total_energy = projections.iter().map(|value| value * value).sum::<f64>();
    if total_energy <= 1e-12 {
        return empty();
    }
    let probabilities: Vec<f64> = projections
        .iter()
        .map(|value| value * value / total_energy)
        .collect();
    let raw_entropy = probabilities
        .iter()
        .filter(|value| **value > 1e-9)
        .map(|value| -value * value.log2())
        .sum::<f64>();
    let normalized_entropy = if probabilities.len() > 1 {
        clamp01(raw_entropy / (probabilities.len() as f64).log2())
    } else {
        0.0
    };
    let mut dominant_axes: Vec<EpaAxis> = probabilities
        .iter()
        .enumerate()
        .filter(|(_, energy)| **energy > 0.05)
        .map(|(index, energy)| EpaAxis {
            index,
            label: cache
                .labels
                .get(index)
                .cloned()
                .unwrap_or_else(|| "Unknown".to_string()),
            energy: *energy,
            projection: projections[index],
            score: *energy,
        })
        .collect();
    dominant_axes.sort_by(|left, right| {
        right
            .energy
            .partial_cmp(&left.energy)
            .unwrap_or(Ordering::Equal)
    });

    let mut bridges = Vec::new();
    if let Some(primary) = dominant_axes.first() {
        for secondary in dominant_axes.iter().skip(1) {
            let strength = (primary.energy * secondary.energy).sqrt();
            if strength > 0.15 {
                bridges.push(EpaBridge {
                    from: primary.label.clone(),
                    to: secondary.label.clone(),
                    strength,
                    balance: if primary.energy.max(secondary.energy) > 0.0 {
                        primary.energy.min(secondary.energy) / primary.energy.max(secondary.energy)
                    } else {
                        0.0
                    },
                });
            }
        }
    }
    let resonance = bridges.iter().map(|bridge| bridge.strength).sum();

    EpaOutput {
        logic_depth: 1.0 - normalized_entropy,
        entropy: normalized_entropy,
        resonance,
        dominant_axes,
        bridges,
        basis_count: bases.len(),
        cache_available: true,
    }
}

#[derive(Clone)]
struct PyramidTagWork {
    id: i64,
    name: String,
    vector: Vec<f32>,
    similarity: f64,
    contribution: f64,
    handshake_magnitude: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PyramidTagOutput {
    id: i64,
    name: String,
    similarity: f64,
    contribution: f64,
    handshake_magnitude: f64,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct HandshakeFeatures {
    direction_coherence: f64,
    pattern_strength: f64,
    novelty_signal: f64,
    noise_signal: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PyramidLevelOutput {
    level: usize,
    tags: Vec<PyramidTagOutput>,
    projection_magnitude: f64,
    residual_magnitude: f64,
    residual_energy_ratio: f64,
    energy_explained: f64,
    handshake_features: HandshakeFeatures,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct PyramidFeatures {
    depth: usize,
    coverage: f64,
    novelty: f64,
    coherence: f64,
    activation: f64,
    expansion_signal: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PyramidOutput {
    levels: Vec<PyramidLevelOutput>,
    total_explained_energy: f64,
    features: PyramidFeatures,
}

fn orthogonal_projection(
    query: &[f32],
    tags: &[PyramidTagWork],
    dimension: usize,
) -> (Vec<f32>, Vec<f32>, Vec<f64>) {
    let mut basis: Vec<Vec<f64>> = Vec::with_capacity(tags.len());
    let mut coefficients = vec![0.0; tags.len()];
    for (index, tag) in tags.iter().enumerate() {
        let mut vector: Vec<f64> = tag.vector.iter().map(|value| *value as f64).collect();
        for unit in &basis {
            let projection = vector
                .iter()
                .zip(unit.iter())
                .map(|(left, right)| left * right)
                .sum::<f64>();
            for offset in 0..dimension {
                vector[offset] -= projection * unit[offset];
            }
        }
        if normalize(&mut vector) {
            coefficients[index] = query
                .iter()
                .zip(vector.iter())
                .map(|(left, right)| (*left as f64) * right)
                .sum::<f64>()
                .abs();
            basis.push(vector);
        }
    }

    let mut projection = vec![0.0f32; dimension];
    for unit in &basis {
        let coefficient = query
            .iter()
            .zip(unit.iter())
            .map(|(left, right)| (*left as f64) * right)
            .sum::<f64>();
        for offset in 0..dimension {
            projection[offset] += (coefficient * unit[offset]) as f32;
        }
    }
    let residual = query
        .iter()
        .zip(projection.iter())
        .map(|(source, explained)| source - explained)
        .collect();
    (projection, residual, coefficients)
}

fn analyze_handshakes(
    query: &[f32],
    tags: &mut [PyramidTagWork],
    dimension: usize,
) -> HandshakeFeatures {
    if tags.is_empty() {
        return HandshakeFeatures::default();
    }
    let mut directions = Vec::with_capacity(tags.len());
    let mut average = vec![0.0f64; dimension];
    for tag in tags.iter_mut() {
        let mut direction = vec![0.0f64; dimension];
        let mut magnitude_squared = 0.0;
        for offset in 0..dimension {
            let delta = (query[offset] - tag.vector[offset]) as f64;
            direction[offset] = delta;
            magnitude_squared += delta * delta;
        }
        let distance = magnitude_squared.sqrt();
        tag.handshake_magnitude = distance;
        if distance > 1e-9 {
            for offset in 0..dimension {
                direction[offset] /= distance;
                average[offset] += direction[offset];
            }
        }
        directions.push(direction);
    }
    for value in &mut average {
        *value /= tags.len() as f64;
    }
    let direction_coherence = clamp01(
        average
            .iter()
            .map(|value| value * value)
            .sum::<f64>()
            .sqrt(),
    );
    let limit = directions.len().min(5);
    let mut pairwise_sum = 0.0;
    let mut pair_count = 0usize;
    for left in 0..limit {
        for right in (left + 1)..limit {
            pairwise_sum += directions[left]
                .iter()
                .zip(directions[right].iter())
                .map(|(a, b)| a * b)
                .sum::<f64>()
                .abs();
            pair_count += 1;
        }
    }
    let pattern_strength = if pair_count > 0 {
        clamp01(pairwise_sum / pair_count as f64)
    } else {
        0.0
    };
    HandshakeFeatures {
        direction_coherence,
        pattern_strength,
        novelty_signal: direction_coherence,
        noise_signal: (1.0 - direction_coherence) * (1.0 - pattern_strength),
    }
}

fn load_tag_names(
    connection: &Connection,
    ids: &[i64],
) -> std::result::Result<HashMap<i64, String>, String> {
    let mut names = HashMap::new();
    let mut statement = connection
        .prepare("SELECT name FROM tags WHERE id = ?1")
        .map_err(|error| format!("prepare Memo pipeline Tag name query failed: {}", error))?;
    for id in ids {
        if let Ok(name) = statement.query_row(rusqlite::params![id], |row| row.get::<_, String>(0))
        {
            names.insert(*id, name);
        }
    }
    Ok(names)
}

fn analyze_pyramid(
    index: &Index,
    connection: &Connection,
    query: &[f32],
    dimension: usize,
    config: &PipelineConfig,
    tag_vectors: &mut TagVectorPool,
    eligible: Option<&HashMap<i64, usize>>,
) -> std::result::Result<(PyramidOutput, Vec<Vec<PyramidTagWork>>, Vec<Vec<f32>>), String> {
    let original_energy = magnitude(query).powi(2);
    if original_energy <= 1e-12 {
        return Ok((
            PyramidOutput {
                levels: Vec::new(),
                total_explained_energy: 0.0,
                features: PyramidFeatures {
                    novelty: 1.0,
                    expansion_signal: 1.0,
                    ..PyramidFeatures::default()
                },
            },
            Vec::new(),
            Vec::new(),
        ));
    }

    let mut residual = query.to_vec();
    let similarity_mode = resolve_similarity_mode(config.similarity_mode);
    let mut levels_output = Vec::new();
    let mut levels_work = Vec::new();
    let mut residuals: Vec<Vec<f32>> = Vec::new();
    let mut total_explained = 0.0;
    for level in 0..config.max_levels.clamp(1, 8) {
        let matches = index
            .search(&residual, config.pyramid_top_k.clamp(1, 128))
            .map_err(|error| format!("Memo pyramid usearch search failed: {:?}", error))?;
        if matches.keys.is_empty() {
            break;
        }
        // P3（上游 9aa1f67）：Gram-Schmidt 之前过滤图外 Tag——图外方向拿不到被接纳
        // 传播种子能承载的能量；不要求出度（eligible = artifact.node_index）。
        // 命中与距离成对过滤，legacy 档的距离配对不因过滤错位。
        let hits: Vec<(i64, Option<f32>)> = matches
            .keys
            .iter()
            .zip(matches.distances.iter())
            .map(|(id, distance)| (*id as i64, Some(*distance)))
            .filter(|(id, _)| eligible.map_or(true, |nodes| nodes.contains_key(id)))
            .collect();
        let ids: Vec<i64> = hits.iter().map(|(id, _)| *id).collect();
        let names = load_tag_names(connection, &ids)?;
        // P1.2：向量装载走请求级共享池（SQL 权威行），池里缺的仍读索引——
        // 相似度口径（1/(1+L2)，取自 usearch 距离）保持不变，既有读数不漂。
        ensure_tag_vectors_loaded(connection, tag_vectors, &ids, dimension)?;
        let mut buffer = vec![0.0f32; dimension];
        let mut tags = Vec::new();
        for (position, id) in ids.iter().enumerate() {
            let vector = match tag_vectors.get(id) {
                Some(vector) => vector.as_ref().to_vec(),
                None => {
                    let found = index.get(*id as u64, &mut buffer).map_err(|error| {
                        format!("Memo pyramid Tag vector read failed: {:?}", error)
                    })?;
                    if found == 0 {
                        continue;
                    }
                    buffer.clone()
                }
            };
            tags.push(PyramidTagWork {
                id: *id,
                name: names
                    .get(id)
                    .cloned()
                    .unwrap_or_else(|| format!("Tag#{}", id)),
                similarity: pyramid_similarity(
                    similarity_mode,
                    hits[position].1,
                    &residual,
                    &vector,
                ),
                vector,
                contribution: 0.0,
                handshake_magnitude: 0.0,
            });
        }
        if tags.is_empty() {
            break;
        }

        let current_energy = magnitude(&residual).powi(2);
        let (projection, next_residual, coefficients) =
            orthogonal_projection(&residual, &tags, dimension);
        // P3（上游 9aa1f67）：层内归一化——贡献 = 系数 / sqrt(层输入能量)。
        for (tag, coefficient) in tags.iter_mut().zip(coefficients.iter()) {
            tag.contribution = *coefficient / current_energy.sqrt().max(1e-12);
        }
        let handshake = analyze_handshakes(&residual, &mut tags, dimension);
        let residual_magnitude = magnitude(&next_residual);
        let residual_energy = residual_magnitude * residual_magnitude;
        let energy_explained = positive(current_energy - residual_energy) / original_energy;
        // P3：safe-stoploss——大残差不是「再来一层有用」的证据。在发布层工作与
        // 残差（含动态虫洞输入）之前拒绝本层。
        if energy_explained < config.min_layer_explained_energy.clamp(0.0, 1.0) {
            break;
        }
        total_explained += energy_explained;
        levels_output.push(PyramidLevelOutput {
            level,
            tags: tags
                .iter()
                .map(|tag| PyramidTagOutput {
                    id: tag.id,
                    name: tag.name.clone(),
                    similarity: tag.similarity,
                    contribution: tag.contribution,
                    handshake_magnitude: tag.handshake_magnitude,
                })
                .collect(),
            projection_magnitude: magnitude(&projection),
            residual_magnitude,
            residual_energy_ratio: residual_energy / original_energy,
            energy_explained,
            handshake_features: handshake,
        });
        // P1.2（上游 696）：该层**输入**残差进动态虫洞上下文——只有更深的层能给源提供共鸣。
        if config.spike_routing.dynamic_wormholes {
            residuals.push(residual.clone());
        }
        levels_work.push(tags);
        residual = next_residual;
        if residual_energy / original_energy < config.min_energy_ratio.clamp(0.0, 1.0) {
            break;
        }
    }

    // P3（上游 9aa1f67）：每个被接纳层一条前置残差，随后是未解释尾部。尾部只供
    // 路由证据，绝不再当种子层。
    let tail_energy = magnitude(&residual).powi(2);
    if config.spike_routing.dynamic_wormholes
        && !levels_work.is_empty()
        && tail_energy.is_finite()
        && tail_energy > 1e-12
        && tail_energy / original_energy >= 0.02
    {
        residuals.push(residual);
    }

    let coverage = clamp01(total_explained);
    let first_handshake = levels_output
        .first()
        .map(|level| level.handshake_features.clone())
        .unwrap_or_default();
    let novelty = clamp01((1.0 - coverage) * 0.7 + first_handshake.novelty_signal * 0.3);
    let coherence = first_handshake.pattern_strength;
    let activation = clamp01(coverage * coherence * (1.0 - first_handshake.noise_signal));
    let features = PyramidFeatures {
        depth: levels_output.len(),
        coverage,
        novelty,
        coherence,
        activation,
        expansion_signal: novelty,
    };
    Ok((
        PyramidOutput {
            levels: levels_output,
            total_explained_energy: total_explained,
            features,
        },
        levels_work,
        residuals,
    ))
}

#[derive(Clone)]
struct GatedTag {
    id: i64,
    name: String,
    weight: f64,
    is_core: bool,
    /// P3（上游 9aa1f67）：lexical 锚定（query_text 与 Tag 名的词法接地 ≥0.5）。
    lexical: bool,
}

// P3（上游 9aa1f67）：ASCII 词有词界；CJK 用相邻 bigram（单字连续段只出单字）。
// 标点绝不拼接无关 ASCII 词。
fn lexical_tokens(text: &str) -> HashSet<String> {
    let mut tokens = HashSet::new();
    let mut ascii = String::new();
    let mut cjk = Vec::new();
    let flush = |ascii: &mut String, cjk: &mut Vec<char>, tokens: &mut HashSet<String>| {
        if !ascii.is_empty() {
            tokens.insert(std::mem::take(ascii));
        }
        if cjk.len() == 1 {
            tokens.insert(cjk[0].to_string());
        }
        for pair in cjk.windows(2) {
            tokens.insert(pair.iter().collect());
        }
        cjk.clear();
    };
    for ch in text.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            if !cjk.is_empty() {
                flush(&mut ascii, &mut cjk, &mut tokens);
            }
            ascii.push(ch);
        } else if ('\u{4e00}'..='\u{9fff}').contains(&ch) {
            if !ascii.is_empty() {
                flush(&mut ascii, &mut cjk, &mut tokens);
            }
            cjk.push(ch);
        } else {
            flush(&mut ascii, &mut cjk, &mut tokens);
        }
    }
    flush(&mut ascii, &mut cjk, &mut tokens);
    tokens
}

fn lexical_grounding(query: &str, name: &str) -> f64 {
    let query = lexical_tokens(query);
    let tag = lexical_tokens(name);
    if tag.is_empty() {
        return 0.0;
    }
    tag.intersection(&query).count() as f64 / tag.len() as f64
}

fn range_value(values: &[f64], index: usize, fallback: f64) -> f64 {
    values
        .get(index)
        .copied()
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
}

fn contains_cjk(value: &str) -> bool {
    value
        .chars()
        .any(|character| ('\u{4e00}'..='\u{9fff}').contains(&character))
}

fn technical_name(value: &str, allow_space: bool) -> bool {
    !contains_cjk(value)
        && value.chars().count() > 3
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, '-' | '_' | '.')
                || (allow_space && character.is_ascii_whitespace())
        })
}

/// P3（上游 9aa1f67）：旧入口降为测试薄壳——生产路径全部走 gate_tags_for_graph。
#[cfg(test)]
fn gate_tags(
    levels: &[Vec<PyramidTagWork>],
    epa: &EpaOutput,
    pyramid: &PyramidOutput,
    core_tags: &[String],
    config: &PipelineConfig,
    query_text: &str,
) -> (Vec<GatedTag>, f64, f64) {
    gate_tags_for_graph(levels, epa, pyramid, core_tags, config, query_text, None, &[])
}

/// P3（上游 9aa1f67）：隐式种子等比例缩放——非 core/lexical 的最大权重不超过
/// 显式（core/lexical 且图内）最大权重的 0.35 倍。
fn scale_implicit_seeds(gated: &mut [GatedTag], eligible: Option<&HashMap<i64, usize>>) {
    let explicit_max = gated
        .iter()
        .filter(|tag| (tag.is_core || tag.lexical)
            && eligible.map_or(true, |ids| ids.contains_key(&tag.id)))
        .map(|tag| tag.weight)
        .fold(0.0, f64::max);
    let implicit_max = gated
        .iter()
        .filter(|tag| !tag.is_core && !tag.lexical)
        .map(|tag| tag.weight)
        .fold(0.0, f64::max);
    if explicit_max > 0.0 && implicit_max > 0.35 * explicit_max {
        let scale = 0.35 * explicit_max / implicit_max;
        for tag in gated {
            if !tag.is_core && !tag.lexical {
                tag.weight *= scale;
            }
        }
    }
}

/// P3（上游 9aa1f67）：显式名字对 SQL 原件解析，绝不发明图节点。硬幽灵可绑定
/// 真 Tag；软幽灵与未知幽灵保持 fusion-only。
fn resolve_core_seeds(
    connection: &Connection,
    core_tags: &[String],
    ghost_tags: &[GhostTagInput],
    eligible: &HashMap<i64, usize>,
    pool: &mut TagVectorPool,
    dimension: usize,
) -> std::result::Result<Vec<(i64, String)>, String> {
    let mut statement = connection
        .prepare("SELECT id, name FROM tags WHERE lower(name) = lower(?1) LIMIT 1")
        .map_err(|error| format!("prepare Memo core seed query failed: {}", error))?;
    let mut resolved = Vec::new();
    let mut seen = HashSet::new();
    for name in core_tags
        .iter()
        .map(String::as_str)
        .chain(
            ghost_tags
                .iter()
                .filter(|tag| tag.is_core)
                .map(|tag| tag.name.as_str()),
        )
    {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let row = statement.query_row(rusqlite::params![name], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        });
        match row {
            Ok((id, name)) if id > 0 && eligible.contains_key(&id) && seen.insert(id) => {
                resolved.push((id, name));
            }
            Ok(_) | Err(rusqlite::Error::QueryReturnedNoRows) => {}
            Err(error) => return Err(format!("query Memo core seed failed: {}", error)),
        }
    }
    let ids: Vec<i64> = resolved.iter().map(|tag| tag.0).collect();
    ensure_tag_vectors_loaded(connection, pool, &ids, dimension)?;
    resolved.retain(|(id, _)| pool.get(id).is_some_and(|vector| magnitude(&vector) > 1e-12));
    Ok(resolved)
}

fn gate_tags_for_graph(
    levels: &[Vec<PyramidTagWork>],
    epa: &EpaOutput,
    pyramid: &PyramidOutput,
    core_tags: &[String],
    config: &PipelineConfig,
    query_text: &str,
    eligible: Option<&HashMap<i64, usize>>,
    explicit_cores: &[(i64, String)],
) -> (Vec<GatedTag>, f64, f64) {
    let activation_min = range_value(&config.activation_multiplier, 0, 0.5);
    let activation_max = range_value(&config.activation_multiplier, 1, 1.5);
    let activation_multiplier =
        activation_min + pyramid.features.activation * (activation_max - activation_min);
    let dynamic_factor = epa.logic_depth * (1.0 + epa.resonance.ln_1p())
        / (1.0 + epa.entropy * 0.5)
        * activation_multiplier;
    let boost_min = range_value(&config.dynamic_boost_range, 0, 0.3);
    let boost_max = range_value(&config.dynamic_boost_range, 1, 2.0);
    let effective_boost =
        positive(config.base_tag_boost) * dynamic_factor.clamp(boost_min, boost_max);

    let core_metric = epa.logic_depth * 0.5 + (1.0 - pyramid.features.coverage) * 0.5;
    let core_min = range_value(&config.core_boost_range, 0, 1.2);
    let core_max = range_value(&config.core_boost_range, 1, 1.4);
    let dynamic_core_boost = core_min + core_metric * (core_max - core_min);
    let core_names: HashSet<String> = core_tags
        .iter()
        .map(|name| name.trim().to_lowercase())
        .chain(explicit_cores.iter().map(|(_, name)| name.to_lowercase()))
        .collect();
    let world = epa
        .dominant_axes
        .first()
        .map(|axis| axis.label.as_str())
        .unwrap_or("Unknown");
    let world_lower = world.to_ascii_lowercase();
    let social_world = ["politics", "society", "history", "economics", "culture"]
        .iter()
        .any(|token| world_lower.contains(token));
    let technical_world = world != "Unknown" && technical_name(world, false);

    let mut seen = HashSet::new();
    let mut gated = Vec::new();
    for (level, tags) in levels.iter().enumerate() {
        let maximum = tags
            .iter()
            .map(|tag| positive(tag.contribution))
            .fold(0.0, f64::max);
        let threshold = (maximum * config.seed_contribution_ratio.clamp(0.0, 1.0))
            .max(config.seed_contribution_floor.max(0.0));
        let dominant = tags
            .first()
            .filter(|tag| tag.contribution.powi(2) > 0.85 && tag.similarity > 0.0);
        // 至多两个冗余方向借幅，总量有界；原始正交贡献与残差不动。
        let mut redundancy_left = dominant.map_or(0.0, |tag| 0.3 * tag.contribution);
        let mut redundancy_slots = 2usize;
        for tag in tags {
            let is_core = core_names.contains(&tag.name.to_lowercase());
            if tag.id <= 0 || seen.contains(&tag.id) {
                continue;
            }
            let grounding = lexical_grounding(query_text, &tag.name);
            let lexical = grounding >= 0.5;
            // 只有已独立支撑的同伴能借幅；低贡献别名不能递归赞助别的别名。
            let sponsor = tags
                .iter()
                .filter(|peer| peer.id != tag.id
                    && peer.contribution >= threshold
                    && peer.similarity > 0.0)
                .filter_map(|peer| {
                    let tightness = clamp01(cosine(&peer.vector, &tag.vector));
                    (tightness >= 0.80).then_some(peer.contribution * tightness)
                })
                .fold(0.0, f64::max);
            let alias = tag.similarity >= 0.20 && sponsor > 0.0;
            let collapsed_redundant = !is_core
                && !lexical
                && tag.contribution < 1e-6
                && tag.similarity >= 0.75
                && dominant.is_some_and(|first| first.id != tag.id
                    && cosine(&first.vector, &tag.vector) >= 0.90);
            let redundant = collapsed_redundant && redundancy_slots > 0;
            if collapsed_redundant && !redundant {
                continue;
            }
            let redundancy_floor = if redundant {
                let first = dominant.unwrap();
                let borrowed = (0.15 * first.contribution
                    * clamp01(tag.similarity / first.similarity)
                    * clamp01(cosine(&first.vector, &tag.vector)))
                .min(redundancy_left);
                redundancy_left -= borrowed;
                redundancy_slots -= 1;
                borrowed
            } else {
                0.0
            };
            if !is_core && !lexical && !alias
                && (tag.contribution < threshold || tag.similarity <= 0.0)
            {
                continue;
            }
            let effective_contribution = if lexical {
                // 字面焦点独立点燃，不受别名策略压低。
                tag.contribution.max(0.6 * sponsor).max(0.6 * maximum)
            } else if redundant {
                tag.contribution.max(redundancy_floor)
            } else if alias {
                tag.contribution.max(0.6 * sponsor * tag.similarity.clamp(0.2, 1.0))
            } else {
                tag.contribution
            };
            seen.insert(tag.id);
            // Cosine zero is a measured orthogonal relationship, not a
            // missing-score sentinel. Every pyramid candidate is measured
            // against its SQL original before entering this gate.
            let relevance = if tag.similarity != 0.0 {
                tag.similarity
            } else {
                0.5
            };
            let core_gain = if is_core {
                dynamic_core_boost * (0.95 + relevance * 0.1)
            } else {
                1.0
            };
            let mut language_gain = 1.0;
            if !lexical
                && config.lang_confidence_enabled
                && technical_name(&tag.name, true)
                && !technical_world
            {
                let penalty = if world == "Unknown" {
                    config.lang_penalty_unknown
                } else {
                    config.lang_penalty_cross_domain
                }
                .clamp(0.0, 1.0);
                language_gain = if social_world {
                    penalty.sqrt()
                } else {
                    penalty
                };
            }
            let decay = config.layer_decay.clamp(0.0, 1.0).powi(level as i32);
            // 恢复（绝不放大）被接纳层里的强残差焦点。
            let independent_support = clamp01(effective_contribution / maximum.max(1e-12));
            let layer_gain = if lexical {
                1.0
            } else {
                decay + (1.0 - decay) * independent_support
            };
            let raw_weight = positive(effective_contribution)
                * layer_gain
                * language_gain
                * core_gain
                * if lexical && !is_core {
                    1.6
                } else {
                    1.0
                };
            let weight = if is_core {
                raw_weight
            } else {
                raw_weight.min(1.0)
            };
            if weight > 0.0 {
                gated.push(GatedTag {
                    id: tag.id,
                    name: tag.name.clone(),
                    weight,
                    is_core,
                    lexical,
                });
            }
        }
    }
    // 显式焦点有单位基础幅值，独立于 ANN 召回与 Gram-Schmidt 贡献。
    // 促升既有 ID，绝不复制。
    for (id, name) in explicit_cores {
        if let Some(tag) = gated.iter_mut().find(|tag| tag.id == *id) {
            tag.is_core = true;
            tag.weight = tag.weight.max(dynamic_core_boost);
        } else {
            gated.push(GatedTag {
                id: *id,
                name: name.clone(),
                weight: dynamic_core_boost,
                is_core: true,
                lexical: false,
            });
        }
    }
    scale_implicit_seeds(&mut gated, eligible);
    (gated, effective_boost.clamp(0.0, 1.0), dynamic_core_boost)
}

#[derive(Clone)]
struct FusionTag {
    id: i64,
    name: String,
    weight: f64,
    is_core: bool,
    vector: Vec<f32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FusionDiagnostics {
    requested_count: usize,
    found_count: usize,
    deduplicated_count: usize,
    total_weight: f64,
    selected_tag_ids: Vec<i64>,
    emergent_count: usize,
    supplemented_core_count: usize,
    ghost_count: usize,
}

fn fuse_observation(
    index: &Index,
    connection: &Connection,
    tag_vectors: &mut TagVectorPool,
    query: &[f32],
    observation: &SenseOutput,
    gated_tags: &[GatedTag],
    core_tags: &[String],
    ghost_tags: &[GhostTagInput],
    dynamic_core_boost: f64,
    dimension: usize,
    alpha: f64,
    config: &PipelineConfig,
) -> std::result::Result<(Vec<f64>, FusionDiagnostics, Vec<FusionTag>), String> {
    // 与 JS SOTA 完全相同：传播后的原始种子取 max，防止循环共现膨胀；
    // 纯涌现节点按能量排序后只保留 Top-N。
    let gated_by_id: HashMap<i64, &GatedTag> = gated_tags.iter().map(|tag| (tag.id, tag)).collect();
    let mut merged = Vec::new();
    let mut emergent = Vec::new();
    for node in &observation.nodes {
        if node.id <= 0 || node.energy <= 0.0 {
            continue;
        }
        if let Some(seed) = gated_by_id.get(&node.id) {
            merged.push(GatedTag {
                id: seed.id,
                name: seed.name.clone(),
                weight: seed.weight.max(node.energy),
                is_core: seed.is_core,
                lexical: seed.lexical,
            });
        } else {
            emergent.push(GatedTag {
                id: node.id,
                name: String::new(),
                weight: node.energy,
                is_core: false,
                lexical: false,
            });
        }
    }
    emergent.sort_by(|left, right| {
        right
            .weight
            .partial_cmp(&left.weight)
            .unwrap_or(Ordering::Equal)
            .then_with(|| left.id.cmp(&right.id))
    });
    if config.max_emergent_nodes > 0 {
        emergent.truncate(config.max_emergent_nodes);
    }
    let emergent_count = emergent.len();
    merged.extend(emergent);

    let core_divisor =
        if config.core_boost_factor.is_finite() && config.core_boost_factor.abs() > 1e-12 {
            config.core_boost_factor
        } else {
            1.33
        };
    let max_base_weight = merged
        .iter()
        .map(|tag| tag.weight / core_divisor)
        .fold(0.0, f64::max)
        .max(if merged.is_empty() { 1.0 } else { 0.0 });

    // 图内有效 Core 已提前作为 Spike 起点；此处保留未入图 Core 的融合回退。
    let mut present_names: HashSet<String> = merged
        .iter()
        .filter(|tag| !tag.name.is_empty())
        .map(|tag| tag.name.to_lowercase())
        .collect();
    let mut supplemented_core_count = 0usize;
    let mut core_statement = connection
        .prepare("SELECT id, name FROM tags WHERE lower(name) = lower(?1) LIMIT 1")
        .map_err(|error| format!("prepare Memo core supplement query failed: {}", error))?;
    for core_name in core_tags {
        let normalized = core_name.to_lowercase();
        if normalized.is_empty() || present_names.contains(&normalized) {
            continue;
        }
        if let Ok((id, name)) = core_statement.query_row(rusqlite::params![core_name], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        }) {
            if merged.iter().any(|tag| tag.id == id) {
                continue;
            }
            present_names.insert(name.to_lowercase());
            merged.push(GatedTag {
                id,
                name,
                weight: max_base_weight * dynamic_core_boost,
                is_core: true,
                lexical: false,
            });
            supplemented_core_count += 1;
        }
    }

    let requested_count = merged.len() + ghost_tags.len();
    let mut buffer = vec![0.0f32; dimension];
    let mut vectors = Vec::with_capacity(requested_count);
    // P1.2：融合向量也走共享池（金字塔阶段已装载的行直接命中；缺的读索引兜底）。
    let merged_ids: Vec<i64> = merged.iter().map(|tag| tag.id).collect();
    ensure_tag_vectors_loaded(connection, tag_vectors, &merged_ids, dimension)?;
    for tag in merged {
        let vector = match tag_vectors.get(&tag.id) {
            Some(vector) => vector.as_ref().to_vec(),
            None => {
                let found = index.get(tag.id as u64, &mut buffer).map_err(|error| {
                    format!("Memo pipeline fusion vector read failed: {:?}", error)
                })?;
                if found == 0 {
                    continue;
                }
                buffer.clone()
            }
        };
        if magnitude(&vector) > 1e-12 {
            vectors.push(FusionTag {
                id: tag.id,
                name: if tag.name.is_empty() {
                    format!("Tag#{}", tag.id)
                } else {
                    tag.name
                },
                weight: tag.weight,
                is_core: tag.is_core,
                vector,
            });
        }
    }

    // 幽灵节点使用专属负 ID，仅参与去重与向量融合，绝不进入 Artifact/Spike。
    let mut ghost_id = -1i64;
    let mut accepted_ghosts = 0usize;
    for ghost in ghost_tags {
        // P3（上游 9aa1f67）：绑定到真 core 种子的硬幽灵已贡献其 SQL 向量，跳过。
        if ghost.is_core
            && gated_tags
                .iter()
                .any(|tag| tag.is_core && tag.name.eq_ignore_ascii_case(ghost.name.trim()))
        {
            continue;
        }
        if ghost.vector.len() != dimension || magnitude(&ghost.vector) <= 1e-12 {
            continue;
        }
        vectors.push(FusionTag {
            id: ghost_id,
            name: ghost.name.clone(),
            weight: max_base_weight
                * if ghost.is_core {
                    dynamic_core_boost
                } else {
                    1.0
                },
            is_core: ghost.is_core,
            vector: ghost.vector.clone(),
        });
        ghost_id -= 1;
        accepted_ghosts += 1;
    }
    let found_count = vectors.len();

    // JS SOTA：按权重降序贪心去重；冗余标签把 20% 能量转移给代表标签
    vectors.sort_by(|left, right| {
        right
            .weight
            .partial_cmp(&left.weight)
            .unwrap_or(Ordering::Equal)
            .then_with(|| left.id.cmp(&right.id))
    });
    let threshold = config.deduplication_threshold.clamp(-1.0, 1.0);
    let mut selected: Vec<FusionTag> = Vec::new();
    for candidate in vectors {
        let redundant_index = selected
            .iter()
            .position(|existing| cosine(&candidate.vector, &existing.vector) > threshold);
        if let Some(index) = redundant_index {
            selected[index].weight += candidate.weight * 0.2;
            selected[index].is_core |= candidate.is_core;
        } else {
            selected.push(candidate);
        }
    }

    let total_weight = selected.iter().map(|entry| entry.weight).sum::<f64>();
    if total_weight <= 0.0 {
        // JS applyTagBoost() 的兼容契约：无法构造 Tag 上下文时原样返回查询向量
        let diagnostics = FusionDiagnostics {
            requested_count,
            found_count,
            deduplicated_count: 0,
            total_weight: 0.0,
            selected_tag_ids: Vec::new(),
            emergent_count,
            supplemented_core_count,
            ghost_count: accepted_ghosts,
        };
        return Ok((
            query.iter().map(|value| *value as f64).collect(),
            diagnostics,
            Vec::new(),
        ));
    }
    let mut context = vec![0.0f64; dimension];
    for tag in &selected {
        for offset in 0..dimension {
            context[offset] += tag.vector[offset] as f64 * tag.weight;
        }
    }
    for value in &mut context {
        *value /= total_weight;
    }
    normalize(&mut context);

    let fused: Vec<f64> = query
        .iter()
        .zip(context.iter())
        .map(|(source, memo)| (1.0 - alpha) * (*source as f64) + alpha * *memo)
        .collect();
    let mut fused = fused;
    normalize(&mut fused);
    let diagnostics = FusionDiagnostics {
        requested_count,
        found_count,
        deduplicated_count: selected.len(),
        total_weight,
        selected_tag_ids: selected.iter().map(|entry| entry.id).collect(),
        emergent_count,
        supplemented_core_count,
        ghost_count: accepted_ghosts,
    };
    Ok((fused, diagnostics, selected))
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct DualFieldDiagnostics {
    iterations: usize,
    local_converged: bool,
    transfer_converged: bool,
    local_residual: f64,
    transfer_residual: f64,
    local_mass: f64,
    transfer_mass: f64,
    // ── P1.3（上游 1098-1123）：投影支撑账。maxProjectionNodes=0 时全部留在缺省 0。──
    /// 圈选并集里已装载到池的节点数；0 表示没走 basin 圈选（或空 core）。
    projected_nodes: usize,
    selected_projection_nodes: usize,
    sql_fetched_nodes: usize,
    sql_requested_nodes: usize,
    sql_batches: usize,
    growth: crate::memo_projection::GrowthDiagnostics,
    local_support: ProjectionSupportDiagnostics,
    transfer_support: ProjectionSupportDiagnostics,
    local_selected_mass_ratio: f64,
    transfer_selected_mass_ratio: f64,
    local_projected_mass_ratio: f64,
    transfer_projected_mass_ratio: f64,
    solve_ms: f64,
    domain_ms: f64,
    project_ms: f64,
}

/// 每侧支撑的读数（上游 1273-1281）。
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionSupportDiagnostics {
    core_nodes: usize,
    selected_nodes: usize,
    outside_domain_nodes: usize,
    missing_vector_nodes: usize,
    stop_reason: String,
}

struct DualFieldOutput {
    local_field: Vec<(i64, f64)>,
    transfer_field: Vec<(i64, f64)>,
    local_domain_ids: Vec<i64>,
    transfer_domain_ids: Vec<i64>,
    local_vector: Vec<f32>,
    transfer_vector: Vec<f32>,
    diagnostics: DualFieldDiagnostics,
}

fn apply_transport(artifact: &NativeArtifact, input: &[f64], output: &mut [f64]) {
    output.fill(0.0);
    for source in 0..artifact.node_ids.len() {
        let mass = input[source];
        if mass == 0.0 {
            continue;
        }
        for cursor in artifact.row_offsets[source]..artifact.row_offsets[source + 1] {
            output[artifact.targets[cursor]] += mass * positive(artifact.weights[cursor]);
        }
    }
}

/// P3（上游 9aa1f67）：`apply_transport` 的双场单趟版——一次 CSR 遍历同时产出
/// 两场。每个输出位置收到的加法与两次独立遍历完全同序，各场保留自己的零质量跳过。
fn apply_transport_pair(
    artifact: &NativeArtifact,
    local: &[f64],
    transfer: &[f64],
    local_output: &mut [f64],
    transfer_output: &mut [f64],
) {
    local_output.fill(0.0);
    transfer_output.fill(0.0);
    for source in 0..artifact.node_ids.len() {
        let local_mass = local[source];
        let transfer_mass = transfer[source];
        let local_active = local_mass != 0.0;
        let transfer_active = transfer_mass != 0.0;
        if !local_active && !transfer_active {
            continue;
        }
        for cursor in artifact.row_offsets[source]..artifact.row_offsets[source + 1] {
            let weight = positive(artifact.weights[cursor]);
            let target = artifact.targets[cursor];
            if local_active {
                local_output[target] += local_mass * weight;
            }
            if transfer_active {
                transfer_output[target] += transfer_mass * weight;
            }
        }
    }
}

/// P3（上游 9aa1f67）：`next = (1 - alpha) * source + alpha * propagated`，单趟同时
/// 累计对 `current` 的 L1 变化——算术与索引序和「先更新再求非负项 L1 和」一致。
fn relax_field(
    source: &[f64],
    propagated: &[f64],
    alpha: f64,
    current: &[f64],
    next: &mut [f64],
) -> f64 {
    let mut residual = 0.0;
    for index in 0..source.len() {
        next[index] = (1.0 - alpha) * source[index] + alpha * propagated[index];
        residual += (next[index] - current[index]).abs();
    }
    residual
}

fn field_mass(field: &[f64]) -> f64 {
    field.iter().map(|value| positive(*value)).sum()
}

fn effective_domain(artifact: &NativeArtifact, field: &[f64], ratio: f64) -> Vec<i64> {
    let total = field_mass(field);
    if total <= 0.0 {
        return Vec::new();
    }
    let mut ranked: Vec<(i64, f64)> = artifact
        .node_ids
        .iter()
        .copied()
        .zip(field.iter().copied())
        .filter(|(_, mass)| *mass > 0.0)
        .collect();
    ranked.sort_by(|left, right| {
        right
            .1
            .partial_cmp(&left.1)
            .unwrap_or(Ordering::Equal)
            .then_with(|| left.0.cmp(&right.0))
    });
    let mut retained = Vec::new();
    let mut mass = 0.0;
    for (id, value) in ranked {
        retained.push(id);
        mass += value;
        if mass / total >= ratio.clamp(0.01, 1.0) {
            break;
        }
    }
    retained
}

/// P1.3 basin 圈选投影（上游 memo_pipeline.rs:1404-1444 逐语义）：
/// grow 给出两场各自的支撑（并集共用 maxProjectionNodes 预算），并集一次性补池后按
/// 选中节点的场质量加权平均。缺向量的节点跳过——读数由 missing_vector_nodes /
/// projected_mass_ratio 明示，绝不静默补 0。
fn project_basin_fields(
    connection: &Connection,
    artifact: &NativeArtifact,
    fields: [&[f64]; 2],
    domains: [&[i64]; 2],
    dimension: usize,
    limit: usize,
    river_ids: &[i64],
    basins: &[crate::memo_projection::Basin],
    pool: &mut TagVectorPool,
    diagnostics: &mut DualFieldDiagnostics,
) -> std::result::Result<(Vec<f32>, Vec<f32>), String> {
    let supports = crate::memo_projection::grow(
        artifact, fields, domains, river_ids, basins, limit,
    )?;
    let selected = supports.ids;
    let growth = supports.diagnostics;
    let support_diagnostics = |field: usize| {
        let domain: HashSet<i64> = domains[field].iter().copied().collect();
        ProjectionSupportDiagnostics {
            core_nodes: growth.core_nodes,
            selected_nodes: selected[field].len(),
            outside_domain_nodes: selected[field]
                .iter()
                .filter(|id| !domain.contains(id))
                .count(),
            stop_reason: growth.stop_reason.clone(),
            ..ProjectionSupportDiagnostics::default()
        }
    };
    diagnostics.local_support = support_diagnostics(0);
    diagnostics.transfer_support = support_diagnostics(1);
    let mut union: Vec<i64> = selected.iter().flatten().copied().collect();
    union.sort_unstable();
    union.dedup();
    diagnostics.selected_projection_nodes = union.len();
    let stats = ensure_tag_vectors_loaded(connection, pool, &union, dimension)?;
    diagnostics.sql_fetched_nodes = stats.fetched_nodes;
    diagnostics.sql_requested_nodes = stats.requested_nodes;
    diagnostics.sql_batches = stats.sql_batches;
    diagnostics.projected_nodes = union.iter().filter(|id| pool.contains_key(id)).count();
    diagnostics.local_support.missing_vector_nodes = selected[0]
        .iter()
        .filter(|id| !pool.contains_key(id))
        .count();
    diagnostics.transfer_support.missing_vector_nodes = selected[1]
        .iter()
        .filter(|id| !pool.contains_key(id))
        .count();
    diagnostics.growth = growth;

    let mut outputs = [vec![0.0f64; dimension], vec![0.0f64; dimension]];
    let mut selected_ratios = [0.0; 2];
    let mut projected_ratios = [0.0; 2];
    for field in 0..2 {
        let total_mass = field_mass(fields[field]);
        let mut selected_mass = 0.0;
        let mut projected_mass = 0.0;
        for id in &selected[field] {
            let Some(&index) = artifact.node_index.get(id) else {
                continue;
            };
            let mass = positive(fields[field][index]);
            selected_mass += mass;
            let Some(vector) = pool.get(id) else {
                continue;
            };
            projected_mass += mass;
            // P3（上游 9aa1f67）：传输已经惩罚过枢纽。这里只做温和的残差投影折扣，
            // 保留观测到的 query core 不动。
            let hub_ratio = if artifact.max_inbound > 0.0 {
                positive(artifact.inbound.get(id).copied().unwrap_or(0.0)) / artifact.max_inbound
            } else {
                0.0
            };
            let projection_gain = if river_ids.contains(id) {
                1.0
            } else {
                1.0 / (1.0 + hub_ratio.sqrt())
            };
            for (out, value) in outputs[field].iter_mut().zip(vector.iter()) {
                *out += *value as f64 * mass * projection_gain;
            }
        }
        if projected_mass > 0.0 {
            for out in &mut outputs[field] {
                *out /= projected_mass;
            }
            normalize(&mut outputs[field]);
        }
        if total_mass > 0.0 {
            selected_ratios[field] = selected_mass / total_mass;
            projected_ratios[field] = projected_mass / total_mass;
        }
    }
    diagnostics.local_selected_mass_ratio = selected_ratios[0];
    diagnostics.transfer_selected_mass_ratio = selected_ratios[1];
    diagnostics.local_projected_mass_ratio = projected_ratios[0];
    diagnostics.transfer_projected_mass_ratio = projected_ratios[1];
    let [local, transfer] = outputs;
    Ok((
        local.into_iter().map(|value| value as f32).collect(),
        transfer.into_iter().map(|value| value as f32).collect(),
    ))
}

fn solve_dual_fields(
    artifact: &NativeArtifact,
    connection: &Connection,
    tag_vectors: &mut TagVectorPool,
    source_entries: &[(i64, f64)],
    river_ids: &[i64],
    basins: &[crate::memo_projection::Basin],
    dimension: usize,
    config: &PipelineConfig,
) -> std::result::Result<DualFieldOutput, String> {
    let mut source = vec![0.0f64; artifact.node_ids.len()];
    for (id, mass) in source_entries {
        if let Some(index) = artifact.node_index.get(id) {
            source[*index] += positive(*mass);
        }
    }
    let source_mass = field_mass(&source);
    if source_mass <= 0.0 {
        return Ok(DualFieldOutput {
            local_field: Vec::new(),
            transfer_field: Vec::new(),
            local_domain_ids: Vec::new(),
            transfer_domain_ids: Vec::new(),
            local_vector: vec![0.0; dimension],
            transfer_vector: vec![0.0; dimension],
            diagnostics: DualFieldDiagnostics {
                iterations: 0,
                local_converged: true,
                transfer_converged: true,
                ..DualFieldDiagnostics::default()
            },
        });
    }
    for value in &mut source {
        *value /= source_mass;
    }

    let local_alpha = config.local_alpha.clamp(0.0, 0.999999);
    let transfer_alpha = config.transfer_alpha.clamp(0.0, 0.999999);
    let solve_started = Instant::now();
    let mut local = source.clone();
    let mut transfer = source.clone();
    let mut next_local = vec![0.0; source.len()];
    let mut next_transfer = vec![0.0; source.len()];
    let mut propagated_local = vec![0.0; source.len()];
    let mut propagated_transfer = vec![0.0; source.len()];
    let mut local_converged = false;
    let mut transfer_converged = false;
    let mut local_residual = f64::INFINITY;
    let mut transfer_residual = f64::INFINITY;
    let mut iterations = 0;

    for iteration in 1..=config.field_max_iterations.max(1) {
        iterations = iteration;
        // P3（上游 9aa1f67）：两场独立；双场都在动时一趟 CSR 服务两场。
        if !local_converged && !transfer_converged {
            apply_transport_pair(
                artifact,
                &local,
                &transfer,
                &mut propagated_local,
                &mut propagated_transfer,
            );
        } else if !local_converged {
            apply_transport(artifact, &local, &mut propagated_local);
        } else if !transfer_converged {
            apply_transport(artifact, &transfer, &mut propagated_transfer);
        }
        if !local_converged {
            local_residual =
                relax_field(&source, &propagated_local, local_alpha, &local, &mut next_local);
            local_converged = local_residual <= config.local_tolerance.max(1e-15);
            std::mem::swap(&mut local, &mut next_local);
        }
        if !transfer_converged {
            transfer_residual = relax_field(
                &source,
                &propagated_transfer,
                transfer_alpha,
                &transfer,
                &mut next_transfer,
            );
            transfer_converged = transfer_residual <= config.transfer_tolerance.max(1e-15);
            std::mem::swap(&mut transfer, &mut next_transfer);
        }
        if local_converged && transfer_converged {
            break;
        }
    }

    let local_field: Vec<(i64, f64)> = artifact
        .node_ids
        .iter()
        .copied()
        .zip(local.iter().copied())
        .filter(|(_, mass)| *mass > 0.0)
        .collect();
    let transfer_field: Vec<(i64, f64)> = artifact
        .node_ids
        .iter()
        .copied()
        .zip(transfer.iter().copied())
        .filter(|(_, mass)| *mass > 0.0)
        .collect();
    let solve_ms = solve_started.elapsed().as_secs_f64() * 1000.0;
    let domain_started = Instant::now();
    let local_domain_ids = effective_domain(artifact, &local, config.local_mass_ratio);
    let transfer_domain_ids = effective_domain(artifact, &transfer, config.transfer_mass_ratio);
    let domain_ms = domain_started.elapsed().as_secs_f64() * 1000.0;
    let local_mass = field_mass(&local);
    let transfer_mass = field_mass(&transfer);
    let mut diagnostics = DualFieldDiagnostics {
        iterations,
        local_converged,
        transfer_converged,
        local_residual,
        transfer_residual,
        local_mass,
        transfer_mass,
        solve_ms,
        domain_ms,
        ..DualFieldDiagnostics::default()
    };
    // P3（上游 9aa1f67 solve_dual_fields_with_pool:1893-1896）：投影无条件走
    // basin 圈选（grow 预算 = max_field_projection_nodes，缺省 256），
    // v9.2 全支撑投影路径退役。
    let project_started = Instant::now();
    let (local_vector, transfer_vector) = project_basin_fields(
        connection,
        artifact,
        [&local, &transfer],
        [&local_domain_ids, &transfer_domain_ids],
        dimension,
        config.max_field_projection_nodes,
        river_ids,
        basins,
        tag_vectors,
        &mut diagnostics,
    )?;
    diagnostics.project_ms = project_started.elapsed().as_secs_f64() * 1000.0;

    Ok(DualFieldOutput {
        local_field,
        transfer_field,
        local_domain_ids,
        transfer_domain_ids,
        local_vector,
        transfer_vector,
        diagnostics,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PipelineDiagnostics {
    backend: String,
    runtime_ownership: String,
    epa_ms: f64,
    pyramid_ms: f64,
    gating_ms: f64,
    sensing_ms: f64,
    fusion_ms: f64,
    total_ms: f64,
    seed_nodes: usize,
    /// P3（上游 9aa1f67）：路由残差数与「尾部残差是否追加」。
    routing_residual_count: usize,
    routing_tail_appended: bool,
    observation_cached: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    observation_cache_error: Option<String>,
    dual_field: DualFieldDiagnostics,
    fusion: FusionDiagnostics,
    /// P1.2（上游 1646）：感知层诊断（含动态虫洞 6 计数与工作账）随管线外露——
    /// 暗上线期间看「关」是否真零工作、开闸后看虫洞命中。
    sensing: SenseDiagnostics,
    /// P2：上一次 `rebuildMemoArtifact` 的 schema-v2 兜底探针（2.0 迁移会删
    /// `tag_pair_similarity` / `tag_intrinsic_residuals`）。放这里而不是 artifact payload，
    /// 因为 payload 是逐字节深比对面（多一个键就记「缺侧」）。
    build_schema_v2: BuildSchemaV2Flags,
    /// 仅 `debugDualFieldVectors: true` 时出现（取证用；缺省 None ⇒ 不序列化）。
    #[serde(skip_serializing_if = "Option::is_none")]
    dual_field_vectors: Option<DualFieldVectors>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct DualFieldVectors {
    local: Vec<f32>,
    transfer: Vec<f32>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildSchemaV2Flags {
    pairwise_table_missing: bool,
    intrinsic_table_missing: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PipelineMetadataOutput {
    schema: String,
    algorithm_version: String,
    artifact_sig: String,
    query_id: Option<String>,
    observation_handle: String,
    epa: EpaOutput,
    pyramid: PyramidOutput,
    matched_tags: Vec<String>,
    core_tags_matched: Vec<String>,
    effective_tag_boost: f64,
    // 上游 9aa1f67 同位：input.config.spike_routing 的回显（SenseConfig 已带 Serialize）。
    propagation_parameters: SenseConfig,
    diagnostics: PipelineDiagnostics,
}

pub struct MemoPipelineComputeOutput {
    metadata_json: String,
    enhanced_vector: Vec<f32>,
}

#[napi(object)]
pub struct MemoPipelineResult {
    pub metadata_json: String,
    pub enhanced_vector: Float32Array,
}

fn run_pipeline(
    index: &Arc<RwLock<Index>>,
    runtime: &MemoRuntime,
    db_path: &str,
    artifact_sig: &str,
    dimensions: usize,
    input_json: &str,
    query_vector: &[f32],
    ghost_vectors: &[f32],
) -> std::result::Result<MemoPipelineComputeOutput, String> {
    let total_started = Instant::now();
    let mut input: PipelineInput = serde_json::from_str(input_json)
        .map_err(|error| format!("invalid unified Memo pipeline input JSON: {}", error))?;
    input.query_vector = query_vector.to_vec();
    if input.query_vector.len() != dimensions {
        return Err(format!(
            "Memo pipeline dimension mismatch: expected {}, got {}",
            dimensions,
            input.query_vector.len()
        ));
    }
    let expected_ghost_values = input
        .ghost_tags
        .len()
        .checked_mul(dimensions)
        .ok_or_else(|| "Memo pipeline ghost vector size overflow".to_string())?;
    if ghost_vectors.len() != expected_ghost_values {
        return Err(format!(
            "Memo pipeline ghost vector size mismatch: ghosts={}, expected values={}, got={}",
            input.ghost_tags.len(),
            expected_ghost_values,
            ghost_vectors.len()
        ));
    }
    for (position, ghost) in input.ghost_tags.iter_mut().enumerate() {
        let start = position * dimensions;
        ghost.vector = ghost_vectors[start..start + dimensions].to_vec();
    }
    let artifact = load_artifact_from_runtime(runtime, db_path, artifact_sig)?;
    let connection = open_readonly(db_path)?;

    let epa_started = Instant::now();
    let epa = analyze_epa(&connection, &input.query_vector, dimensions);
    let epa_ms = epa_started.elapsed().as_secs_f64() * 1000.0;

    let pyramid_started = Instant::now();
    let index_guard = index
        .read()
        .map_err(|error| format!("Memo pipeline index lock failed: {}", error))?;
    // P1.2：请求级共享 Tag 向量池——金字塔装载、虫洞共鸣、融合、双场投影共用。
    let mut tag_vectors = TagVectorPool::new();
    let (pyramid, level_tags, residuals) = analyze_pyramid(
        &index_guard,
        &connection,
        &input.query_vector,
        dimensions,
        &input.config,
        &mut tag_vectors,
        Some(&artifact.node_index),
    )?;
    let pyramid_ms = pyramid_started.elapsed().as_secs_f64() * 1000.0;

    let gating_started = Instant::now();
    // P3（上游 9aa1f67）：显式 Core/硬幽灵先对 SQL 原件解析成图内种子。
    let explicit_cores = resolve_core_seeds(
        &connection,
        &input.core_tags,
        &input.ghost_tags,
        &artifact.node_index,
        &mut tag_vectors,
        dimensions,
    )?;
    let (gated_tags, effective_tag_boost, dynamic_core_boost) = gate_tags_for_graph(
        &level_tags,
        &epa,
        &pyramid,
        &input.core_tags,
        &input.config,
        &input.query_text,
        Some(&artifact.node_index),
        &explicit_cores,
    );
    // 空 Pyramid 也能点燃合法的显式 Core。图外/未知 Core 与幽灵保留 fusion-only 回退。
    let seeds: Vec<SenseSeed> = gated_tags
        .iter()
        .map(|tag| SenseSeed {
            id: tag.id,
            energy: tag.weight,
            source_type: if tag.is_core {
                "core".to_string()
            } else if tag.lexical {
                "lexical_seed".to_string()
            } else {
                "seed".to_string()
            },
        })
        .collect();
    let gating_ms = gating_started.elapsed().as_secs_f64() * 1000.0;

    let sensing_started = Instant::now();
    // P1.2（上游 1759-1780）：种子层号 = 该 Tag 在金字塔中出现的最小层；层相似度复用
    // （同层残差与目标向量的余弦就是金字塔的 similarity，无需重复点积）。
    let mut seed_levels: HashMap<i64, usize> = HashMap::new();
    for (level, tags) in level_tags.iter().enumerate() {
        for tag in tags {
            seed_levels.entry(tag.id).or_insert(level);
        }
    }
    // P3（上游 9aa1f67）：路由残差账——层数之外的即尾部追加了那条。
    let routing_residual_count = residuals.len();
    let routing_tail_appended = residuals.len() > level_tags.len();
    let mut wormholes =
        DynamicWormholeContext::new(&connection, &mut tag_vectors, residuals, seed_levels);
    for (layer, tags) in level_tags.iter().enumerate() {
        for tag in tags {
            wormholes.reuse_score(layer, tag.id, tag.similarity);
        }
    }
    let observation = sense_with_context(
        &artifact,
        artifact_sig,
        SenseInput {
            query_id: input.query_id.clone(),
            seeds,
            config: input.config.spike_routing.clone(),
        },
        Some(&mut wormholes),
    )?;
    let sensing_diagnostics = observation.diagnostics.clone();
    drop(wormholes);
    let sensing_ms = sensing_started.elapsed().as_secs_f64() * 1000.0;

    let fusion_started = Instant::now();
    let (enhanced_vector, fusion, selected_tags) = fuse_observation(
        &index_guard,
        &connection,
        &mut tag_vectors,
        &input.query_vector,
        &observation,
        &gated_tags,
        &input.core_tags,
        &input.ghost_tags,
        dynamic_core_boost,
        dimensions,
        effective_tag_boost,
        &input.config,
    )?;
    let fusion_ms = fusion_started.elapsed().as_secs_f64() * 1000.0;
    // P3（上游 9aa1f67 run_pipeline:2105-2111）：basin 圈选与 river_ids 每查询
    // 无条件现算（上游无闸）；limit 在 solve 内取 max_field_projection_nodes。
    let river_ids = observation
        .nodes
        .iter()
        .map(|node| node.id)
        .collect::<Vec<i64>>();
    let basins = crate::memo_projection::seed_basins(&observation, &artifact);
    let dual_fields = solve_dual_fields(
        &artifact,
        &connection,
        &mut tag_vectors,
        &observation.source_field,
        &river_ids,
        &basins,
        dimensions,
        &input.config,
    )?;
    drop(index_guard);
    drop(connection);

    let enhanced_vector_f32: Vec<f32> =
        enhanced_vector.iter().map(|value| *value as f32).collect();
    let observation_handle = runtime.store_query_observation(
        artifact_sig,
        observation,
        input.query_vector.clone(),
        enhanced_vector_f32.clone(),
        dual_fields.local_vector.clone(),
        dual_fields.transfer_vector.clone(),
        dual_fields.local_field.clone(),
        dual_fields.transfer_field.clone(),
        dual_fields.local_domain_ids.clone(),
        dual_fields.transfer_domain_ids.clone(),
    )?;

    let maximum_weight = selected_tags
        .iter()
        .map(|tag| tag.weight)
        .fold(0.0, f64::max);
    let matched_tags = selected_tags
        .iter()
        .filter(|tag| {
            tag.is_core
                || tag.weight
                    > maximum_weight
                        * if technical_name(&tag.name, true) {
                            input.config.tech_tag_threshold
                        } else {
                            input.config.normal_tag_threshold
                        }
        })
        .map(|tag| tag.name.clone())
        .collect::<Vec<_>>();
    let core_tags_matched = selected_tags
        .iter()
        .filter(|tag| tag.is_core)
        .map(|tag| tag.name.clone())
        .collect::<Vec<_>>();
    let seed_nodes = gated_tags.len();

    let dual_field_diagnostics = dual_fields.diagnostics;
    let metadata_json = serde_json::to_string(&PipelineMetadataOutput {
        schema: PIPELINE_SCHEMA.to_string(),
        algorithm_version: PIPELINE_ALGORITHM.to_string(),
        artifact_sig: artifact_sig.to_string(),
        query_id: input.query_id.clone(),
        observation_handle,
        epa,
        pyramid,
        matched_tags,
        core_tags_matched,
        effective_tag_boost,
        propagation_parameters: input.config.spike_routing.clone(),
        diagnostics: PipelineDiagnostics {
            backend: "rust-unified-memo-pipeline".to_string(),
            runtime_ownership: "vexus-index-instance".to_string(),
            epa_ms,
            pyramid_ms,
            gating_ms,
            sensing_ms,
            fusion_ms,
            total_ms: total_started.elapsed().as_secs_f64() * 1000.0,
            seed_nodes,
            routing_residual_count,
            routing_tail_appended,
            observation_cached: true,
            observation_cache_error: None,
            dual_field: dual_field_diagnostics,
            fusion,
            sensing: sensing_diagnostics,
            dual_field_vectors: if input.config.debug_dual_field_vectors {
                Some(DualFieldVectors {
                    local: dual_fields.local_vector.clone(),
                    transfer: dual_fields.transfer_vector.clone(),
                })
            } else {
                None
            },
            build_schema_v2: {
                let (pairwise_missing, intrinsic_missing) =
                    crate::memo_artifact_builder::schema_v2_fallback_flags();
                BuildSchemaV2Flags {
                    pairwise_table_missing: pairwise_missing,
                    intrinsic_table_missing: intrinsic_missing,
                }
            },
        },
    })
    .map_err(|error| format!("encode unified Memo pipeline metadata failed: {}", error))?;

    Ok(MemoPipelineComputeOutput {
        metadata_json,
        enhanced_vector: enhanced_vector_f32,
    })
}

pub struct MemoPipelineTask {
    index: Arc<RwLock<Index>>,
    runtime: Arc<MemoRuntime>,
    db_path: String,
    artifact_sig: String,
    dimensions: usize,
    input_json: String,
    query_vector: Vec<f32>,
    ghost_vectors: Vec<f32>,
}

impl Task for MemoPipelineTask {
    type Output = MemoPipelineComputeOutput;
    type JsValue = MemoPipelineResult;

    fn compute(&mut self) -> Result<Self::Output> {
        run_pipeline(
            &self.index,
            &self.runtime,
            &self.db_path,
            &self.artifact_sig,
            self.dimensions,
            &self.input_json,
            &self.query_vector,
            &self.ghost_vectors,
        )
        .map_err(Error::from_reason)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(MemoPipelineResult {
            metadata_json: output.metadata_json,
            enhanced_vector: Float32Array::new(output.enhanced_vector),
        })
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn run_with_runtime(
    index: Arc<RwLock<Index>>,
    runtime: Arc<MemoRuntime>,
    db_path: String,
    artifact_sig: String,
    dimensions: usize,
    input_json: String,
    query_vector: Vec<f32>,
    ghost_vectors: Vec<f32>,
) -> AsyncTask<MemoPipelineTask> {
    AsyncTask::new(MemoPipelineTask {
        index,
        runtime,
        db_path,
        artifact_sig,
        dimensions,
        input_json,
        query_vector,
        ghost_vectors,
    })
}

#[cfg(test)]
mod geometry_epa_tests {
    use super::*;
    use crate::memo_projection::grow;

    /// 生产路径的诊断折算（project_basin_fields 前半段的纯函数版，无 SQL）。
    /// 第二场恒为 0 质量 → 该 lane 不活跃，等价于单场观测。
    fn support(
        graph: &NativeArtifact,
        field: &[f64],
        domain: &[i64],
        core: &[i64],
        limit: usize,
    ) -> std::result::Result<(Vec<i64>, ProjectionSupportDiagnostics), String> {
        let zero = vec![0.0f64; graph.node_ids.len()];
        let supports = grow(graph, [field, &zero], [domain, domain], core, &[], limit)?;
        let domain_set: HashSet<i64> = domain.iter().copied().collect();
        let diagnostics = ProjectionSupportDiagnostics {
            core_nodes: supports.diagnostics.core_nodes,
            selected_nodes: supports.ids[0].len(),
            outside_domain_nodes: supports.ids[0]
                .iter()
                .filter(|id| !domain_set.contains(id))
                .count(),
            stop_reason: supports.diagnostics.stop_reason.clone(),
            ..ProjectionSupportDiagnostics::default()
        };
        Ok((supports.ids[0].clone(), diagnostics))
    }

    /// 1 -> 2 -> 3；1 -> 4；5 是不可达的高质量孤岛（上游 2370 同构）。
    fn support_graph() -> NativeArtifact {
        NativeArtifact {
            node_ids: vec![1, 2, 3, 4, 5],
            node_index: (1..=5).enumerate().map(|(i, id)| (id, i)).collect(),
            row_offsets: vec![0, 2, 3, 3, 3, 3],
            targets: vec![1, 3, 2],
            weights: vec![0.5, 0.5, 1.0],
            ..NativeArtifact::default()
        }
    }

    #[test]
    fn growing_keeps_low_mass_bridge_and_rejects_global_islands() {
        let graph = support_graph();
        let field = [0.1, 0.01, 0.3, 0.02, 0.57];
        let (ids, diagnostics) = support(&graph, &field, &[5, 3, 1], &[1], 0).unwrap();
        // 我方 grow 按图距离（-ln w）推进；上游旧启发式给 [1,4,2,3]——集合相同。
        assert_eq!(ids, vec![1, 2, 3, 4]);
        assert_eq!(diagnostics.outside_domain_nodes, 2); // 2、4 在域外，3 在域内
        assert_eq!(diagnostics.stop_reason, "frontier_exhausted");
        // 每个非 core 节点都有更早入选的正权前驱：绝不发明连接边。
        for (position, id) in ids.iter().enumerate().skip(1) {
            assert!(
                ids[..position]
                    .iter()
                    .any(|parent| graph.edge_weight(*parent, *id) > 0.0),
                "node {} lacks an admitted predecessor",
                id
            );
        }
        let (limited, diagnostics) = support(&graph, &field, &[5, 3, 1], &[1], 3).unwrap();
        assert_eq!(limited, vec![1, 2, 3]);
        assert_eq!(limited.len(), 3);
        assert_eq!(diagnostics.stop_reason, "budget");
    }

    #[test]
    fn fields_grow_independently_and_ties_use_tag_id() {
        let graph = support_graph();
        // 每场只在自家节点上有质量 → 支撑互不借用（上游同构断言）。
        let (local, _) = support(&graph, &[0.1, 0.6, 0.0, 0.0, 0.0], &[1, 2], &[1], 2).unwrap();
        let (transfer, _) = support(&graph, &[0.1, 0.0, 0.0, 0.6, 0.0], &[1, 4], &[1], 2).unwrap();
        assert_eq!(local, vec![1, 2]);
        assert_eq!(transfer, vec![1, 4]);
        // 等距平手按 Tag ID 升序取席。
        let (tied, diagnostics) = support(&graph, &[0.2; 5], &[1, 2, 3, 4, 5], &[1], 2).unwrap();
        assert_eq!(tied, vec![1, 2]);
        assert_eq!(diagnostics.stop_reason, "budget");
    }

    #[test]
    fn core_budget_empty_core_and_mass_stop_are_explicit() {
        let graph = support_graph();
        let field = [0.2; 5];
        let error = support(&graph, &field, &[1, 2], &[1, 2], 1).err().unwrap();
        assert!(error.starts_with("MEMO_PROJECTION_CORE_EXCEEDS_BUDGET:"));
        let (empty, diagnostics) = support(&graph, &field, &[1, 2], &[], 2).unwrap();
        assert!(empty.is_empty());
        assert_eq!(diagnostics.stop_reason, "empty_core");
        let (stopped, diagnostics) = support(&graph, &field, &[1], &[1], 256).unwrap();
        assert_eq!(stopped, vec![1]);
        assert_eq!(diagnostics.stop_reason, "mass_target");
        // 独立的 seed 分量各自成立；不发明桥接边。
        let (multi, diagnostics) = support(&graph, &field, &[1, 5], &[5, 1, 5], 2).unwrap();
        assert_eq!(multi, vec![1, 5]);
        assert_eq!(diagnostics.core_nodes, 2);
    }

    #[test]
    fn zero_edges_cycles_and_numerical_tails_never_fill_seats() {
        let mut graph = support_graph();
        graph.weights[0] = 0.0; // 1 的唯一入边权重为 0
        let (ids, diagnostics) =
            support(&graph, &[0.1, 0.4, 0.3, 1e-15, 0.2], &[1, 2, 3, 5], &[1], 256).unwrap();
        assert_eq!(ids, vec![1]);
        assert_eq!(diagnostics.stop_reason, "frontier_exhausted");
        // 自环 + 双边环：不重复占席、不卡死。
        let cyclic = NativeArtifact {
            node_ids: vec![1, 2],
            node_index: HashMap::from([(1, 0), (2, 1)]),
            row_offsets: vec![0, 2, 3],
            targets: vec![0, 1, 0],
            weights: vec![1.0; 3],
            ..NativeArtifact::default()
        };
        let (ids, diagnostics) = support(&cyclic, &[0.5, 0.5], &[1, 2], &[1], 0).unwrap();
        assert_eq!(ids, vec![1, 2]);
        assert_eq!(diagnostics.stop_reason, "mass_target");
    }

    #[test]
    fn budget_config_is_nonnegative_integer_with_default() {
        // P3（上游 9aa1f67）：maxFieldProjectionNodes 缺省 256（无条件 basin 圈选）；
        // 旧暗上线键 maxProjectionNodes 停止消费（缺省臂会显式发 0，当别名会
        // 把 256 预算降级成无界），发送它不影响新键取值。
        let default: PipelineConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(default.max_field_projection_nodes, 256);
        for k in [0usize, 64, 193, 512] {
            let config: PipelineConfig =
                serde_json::from_value(serde_json::json!({ "maxFieldProjectionNodes": k }))
                    .unwrap();
            assert_eq!(config.max_field_projection_nodes, k);
        }
        // 旧键被忽略：显式 maxProjectionNodes=0 不再把缺省 256 降级。
        let legacy: PipelineConfig =
            serde_json::from_value(serde_json::json!({ "maxProjectionNodes": 0 })).unwrap();
        assert_eq!(legacy.max_field_projection_nodes, 256);
        for value in [
            serde_json::json!(-1),
            serde_json::json!(1.5),
            serde_json::json!("256"),
        ] {
            assert!(serde_json::from_value::<PipelineConfig>(
                serde_json::json!({ "maxFieldProjectionNodes": value })
            )
            .is_err());
        }
    }

    #[test]
    fn basin_projection_loads_union_once_and_reports_sql_batches() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("CREATE TABLE tags(id INTEGER PRIMARY KEY, vector BLOB);")
            .unwrap();
        for (id, values) in [(1i64, [1.0f32, 0.0]), (2, [0.0, 1.0]), (3, [0.5, 0.5])] {
            let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
            connection
                .execute("INSERT INTO tags VALUES (?1,?2)", rusqlite::params![id, bytes])
                .unwrap();
        }
        let artifact = NativeArtifact {
            node_ids: vec![1, 2, 3],
            node_index: HashMap::from([(1, 0), (2, 1), (3, 2)]),
            row_offsets: vec![0, 2, 2, 2],
            targets: vec![1, 2],
            weights: vec![0.5, 0.5],
            ..NativeArtifact::default()
        };
        let local = [0.7, 0.2, 0.1];
        let transfer = [0.1, 0.7, 0.2];
        let mut pool = TagVectorPool::new();
        let mut diagnostics = DualFieldDiagnostics::default();
        let projected = project_basin_fields(
            &connection,
            &artifact,
            [&local, &transfer],
            [&[1, 2], &[2, 3]],
            2,
            2,
            &[1],
            &[],
            &mut pool,
            &mut diagnostics,
        )
        .unwrap();
        // 每场被自家质量主导（不是被对方的向量拉平）。
        assert!(projected.0[0] > projected.0[1]);
        assert!(projected.1[1] > projected.1[0]);
        assert_eq!(diagnostics.selected_projection_nodes, 2);
        assert_eq!(diagnostics.projected_nodes, 2);
        assert_eq!(diagnostics.sql_requested_nodes, 2);
        assert_eq!(diagnostics.sql_fetched_nodes, 2);
        assert_eq!(diagnostics.sql_batches, 1);
        assert_eq!(diagnostics.local_support.selected_nodes, 2);
        assert_eq!(diagnostics.local_support.outside_domain_nodes, 0);
        assert_eq!(diagnostics.transfer_support.outside_domain_nodes, 1);
        assert_eq!(diagnostics.local_support.stop_reason, "budget");
        assert!((diagnostics.local_selected_mass_ratio - 0.9).abs() < 1e-12);
        // 同一请求内池已热：第二次零 SQL（并集一次性补池的判据）。
        project_basin_fields(
            &connection,
            &artifact,
            [&local, &transfer],
            [&[1, 2], &[2, 3]],
            2,
            2,
            &[1],
            &[],
            &mut pool,
            &mut diagnostics,
        )
        .unwrap();
        assert_eq!(diagnostics.sql_batches, 0);
        assert_eq!(diagnostics.sql_fetched_nodes, 0);
        assert_eq!(pool.len(), 2);
    }
}

#[cfg(test)]
mod similarity_mode_tests {
    use super::*;

    #[test]
    fn similarity_mode_config_defaults_to_cosine_and_rejects_unknown() {
        // P3 起缺省翻为 cosine（对齐上游 2.0 无条件 cosine）；legacy 为显式兼容档。
        let default: PipelineConfig = serde_json::from_str("{}").unwrap();
        assert!(default.similarity_mode.is_none());
        assert_eq!(
            resolve_similarity_mode(default.similarity_mode),
            SimilarityMode::Cosine
        );
        let cosine: PipelineConfig =
            serde_json::from_value(serde_json::json!({ "similarityMode": "cosine" })).unwrap();
        assert_eq!(
            resolve_similarity_mode(cosine.similarity_mode),
            SimilarityMode::Cosine
        );
        let legacy: PipelineConfig =
            serde_json::from_value(serde_json::json!({ "similarityMode": "legacy" })).unwrap();
        assert_eq!(
            resolve_similarity_mode(legacy.similarity_mode),
            SimilarityMode::Legacy
        );
        // 未知档位必须炸（不静默回退：配置面写错要立刻知道）
        assert!(serde_json::from_value::<PipelineConfig>(
            serde_json::json!({ "similarityMode": "cos" })
        )
        .is_err());
    }

    /// B 实测口径（p2-divergence-2026-10-22.md §5）：单位向量下 L2² = 2-2cos，
    /// 所以 legacy 的 1/(1+d)（d = usearch 的平方距离）= 1/(1+2-2cos)，与 cos 不同口径。
    /// tag5 实测：cos 0.5525 / L2² 0.895 / legacy 0.5277。
    #[test]
    fn legacy_is_one_over_one_plus_squared_l2_while_cosine_is_geometric() {
        let residual = [1.0f32, 0.0];
        let cosine_target = 0.5525f32;
        let vector = [cosine_target, (1.0 - cosine_target * cosine_target).sqrt()];
        let squared_l2 = 2.0 - 2.0 * cosine_target as f64; // 0.895
        let distance = Some(squared_l2 as f32);
        let legacy = pyramid_similarity(SimilarityMode::Legacy, distance, &residual, &vector);
        let cosine = pyramid_similarity(SimilarityMode::Cosine, distance, &residual, &vector);
        assert!((legacy - 1.0 / (1.0 + squared_l2)).abs() < 1e-12);
        assert!((legacy - 0.5277).abs() < 1e-4, "legacy {}", legacy);
        assert!((cosine - cosine_target as f64).abs() < 1e-6, "cosine {}", cosine);
        assert!(cosine > legacy, "正交附近 cos 高于 1/(1+L2²)");
    }

    /// 杀伤力所在：近正交时 legacy 给 1/3（>0.2 恒过阈），cosine 给 ≈0（恒不过阈）⇒
    /// 动态虫洞的 known_scores 通道被二值化翻转（闸关时 context=None，零漂移）。
    #[test]
    fn near_orthogonal_similarity_straddles_dynamic_wormhole_threshold() {
        let residual = [1.0f32, 0.0];
        let orthogonal = [0.0f32, 1.0];
        let legacy = pyramid_similarity(SimilarityMode::Legacy, Some(2.0), &residual, &orthogonal);
        let cosine = pyramid_similarity(SimilarityMode::Cosine, Some(2.0), &residual, &orthogonal);
        assert!((legacy - 1.0 / 3.0).abs() < 1e-12);
        assert!(legacy >= 0.2, "legacy {} 应过 0.2 阈值", legacy);
        assert!(cosine < 0.2, "cosine {} 不应过 0.2 阈值", cosine);
        // 向量维度不匹配（未装载成功的脏行）时余弦给 0，不伪造支撑
        assert_eq!(
            pyramid_similarity(SimilarityMode::Cosine, Some(2.0), &residual, &[1.0f32]),
            0.0
        );
    }
}

#[cfg(test)]
mod stoploss_gate_tests {
    use super::*;

    fn epa() -> EpaOutput {
        EpaOutput {
            logic_depth: 0.5,
            entropy: 0.5,
            resonance: 0.0,
            dominant_axes: vec![],
            bridges: vec![],
            basis_count: 0,
            cache_available: false,
        }
    }

    #[test]
    fn contribution_tails_are_removed_and_residual_focus_keeps_weight() {
        let make = |id, contribution, similarity| PyramidTagWork {
            id,
            name: format!("标签{id}"),
            vector: if id == 2 || id == 4 {
                vec![0.0_f32, 1.0]
            } else {
                vec![1.0_f32, 0.0]
            },
            similarity,
            contribution,
            handshake_magnitude: 0.0,
        };
        let levels = vec![
            vec![make(1, 0.66, 0.66), make(2, 0.02, 0.6)],
            vec![
                make(3, 0.2, 0.32),
                make(4, 0.01, 0.1),
                make(5, 0.1, -0.1),
            ],
        ];
        let pyramid = PyramidOutput {
            levels: vec![],
            total_explained_energy: 0.68,
            features: PyramidFeatures::default(),
        };
        let (gated, _, _) = gate_tags(
            &levels,
            &epa(),
            &pyramid,
            &[],
            &PipelineConfig::default(),
            "",
        );
        assert_eq!(gated.iter().map(|t| t.id).collect::<Vec<_>>(), vec![1, 3]);
        assert!((gated[1].weight - 0.2).abs() < 1e-12);
    }
}

#[cfg(test)]
mod lexical_patch_tests {
    use super::*;

    fn epa() -> EpaOutput {
        EpaOutput {
            logic_depth: 0.5,
            entropy: 0.5,
            resonance: 0.0,
            dominant_axes: vec![],
            bridges: vec![],
            basis_count: 0,
            cache_available: false,
        }
    }

    #[test]
    fn lexical_grounding_respects_ascii_boundaries_and_mixed_names() {
        let query = "小冰，还记得那个 Lunarium 星之旅吗？";
        for name in ["Lunarium星之旅", "Lunarium", "星之旅"] {
            assert_eq!(lexical_grounding(query, name), 1.0);
        }
        assert_eq!(lexical_grounding(query, "AI自编自演Galgame"), 0.0);
        assert_eq!(lexical_grounding("chair", "AI"), 0.0);
        assert_eq!(lexical_grounding("", "Lunarium"), 0.0);
        assert_eq!(lexical_grounding("测试", ""), 0.0);
    }

    #[test]
    fn grounded_residual_and_short_alias_survive_and_ignite_without_lowering_threshold() {
        let make = |id, name: &str, contribution, similarity, vector: Vec<f32>| PyramidTagWork {
            id,
            name: name.into(),
            contribution,
            similarity,
            vector,
            handshake_magnitude: 0.0,
        };
        // 现实的层归一化系数；短别名在 Gram-Schmidt 下失去独立分量但保留身份。
        let levels = vec![
            vec![make(1, "AI自编自演Galgame", 0.6604, 0.66, vec![1.0, 0.0])],
            vec![
                make(2, "Lunarium星之旅", 0.2109 / 0.6648, 0.32, vec![0.0, 1.0]),
                make(3, "Lunarium", 0.0288 / 0.6648, 0.23, vec![0.0, 1.0]),
            ],
        ];
        let pyramid = PyramidOutput {
            levels: vec![],
            total_explained_energy: 0.68,
            features: PyramidFeatures::default(),
        };
        let (gated, _, _) = gate_tags(
            &levels,
            &epa(),
            &pyramid,
            &[],
            &PipelineConfig::default(),
            "Lunarium 星之旅有问题",
        );
        let focus = gated.iter().find(|t| t.id == 2).unwrap();
        let alias = gated.iter().find(|t| t.id == 3).unwrap();
        let implicit = gated.iter().find(|t| t.id == 1).unwrap();
        assert!(focus.lexical && alias.lexical);
        assert!(focus.weight > 0.5);
        assert!(alias.weight > 0.3); // ASCII 语言罚不得压低字面名
        assert!(implicit.weight <= focus.weight * 0.35);
        let graph = crate::rivermemo_topology_v3::NativeArtifact {
            node_ids: vec![1, 2, 3, 4],
            node_index: [(1, 0), (2, 1), (3, 2), (4, 3)].into_iter().collect(),
            row_offsets: vec![0, 0, 1, 1, 1],
            targets: vec![3],
            weights: vec![0.1],
            ..crate::rivermemo_topology_v3::NativeArtifact::default()
        }
        .prepared();
        let output = sense_typed(
            &graph,
            "lexical-test",
            SenseInput {
                query_id: None,
                seeds: gated
                    .iter()
                    .map(|t| SenseSeed {
                        id: t.id,
                        energy: t.weight,
                        source_type: if t.lexical { "lexical_seed" } else { "seed" }.into(),
                    })
                    .collect(),
                config: SenseConfig::default(),
            },
        )
        .unwrap();
        assert!(output.edges.iter().any(|e| e.source_id == 2 && e.target_id == 4));
        assert_eq!(
            output.nodes.iter().find(|n| n.id == 2).unwrap().source_type,
            "lexical_seed"
        );
    }
}

#[cfg(test)]
mod v21_seed_tests {
    use super::*;

    fn tag(id: i64, weight: f64, lexical: bool) -> GatedTag {
        GatedTag {
            id,
            name: id.to_string(),
            weight,
            lexical,
            is_core: false,
        }
    }

    fn epa() -> EpaOutput {
        EpaOutput {
            logic_depth: 0.5,
            entropy: 0.5,
            resonance: 0.0,
            dominant_axes: vec![],
            bridges: vec![],
            basis_count: 0,
            cache_available: false,
        }
    }

    #[test]
    fn proportional_scaling_preserves_ratios_and_ignores_missing_explicit_node() {
        let original = vec![tag(1, 0.4, true), tag(2, 0.8, false), tag(3, 0.4, false)];
        let mut accepted = original.clone();
        scale_implicit_seeds(&mut accepted, Some(&HashMap::from([(1, 0)])));
        assert!((accepted[1].weight - 0.14).abs() < 1e-12);
        assert!((accepted[1].weight / accepted[2].weight - 2.0).abs() < 1e-12);
        let mut missing = original.clone();
        scale_implicit_seeds(&mut missing, Some(&HashMap::from([(2, 0), (3, 1)])));
        assert_eq!(
            missing.iter().map(|t| t.weight).collect::<Vec<_>>(),
            vec![0.4, 0.8, 0.4]
        );
    }

    #[test]
    fn sponsorship_has_gradient_and_collapsed_rescue_is_bounded_without_rewriting_energy() {
        let make = |id, similarity, contribution| PyramidTagWork {
            id,
            name: format!("标签{id}"),
            similarity,
            contribution,
            vector: vec![1.0, 0.0],
            handshake_magnitude: 0.0,
        };
        let pyramid = PyramidOutput {
            levels: vec![],
            total_explained_energy: 1.0,
            features: PyramidFeatures::default(),
        };
        let config = PipelineConfig::default();
        let levels = vec![vec![
            make(1, 0.8, 0.8),
            make(2, 0.7, 0.01),
            make(3, 0.4, 0.01),
        ]];
        let (gated, _, _) = gate_tags(&levels, &epa(), &pyramid, &[], &config, "");
        assert!(gated[1].weight > gated[2].weight);
        assert!((gated[1].weight / gated[2].weight - 1.75).abs() < 1e-12);
        let levels = vec![vec![
            make(1, 0.96, 0.96),
            make(2, 0.90, 1e-9),
            make(3, 0.80, 1e-10),
            make(4, 0.76, 1e-11),
        ]];
        let (gated, _, _) = gate_tags(&levels, &epa(), &pyramid, &[], &config, "");
        assert_eq!(gated.len(), 3);
        assert!(gated[1].weight > gated[2].weight);
        assert!(gated[1..].iter().map(|t| t.weight).sum::<f64>() <= 0.3 * 0.96);
        assert!(gated.iter().all(|t| !t.lexical && !t.is_core));
        assert_eq!(levels[0][1].contribution, 1e-9);
        assert_eq!(pyramid.total_explained_energy, 1.0);
    }
}

#[cfg(test)]
mod v22_residual_tests {
    use super::*;
    use crate::rivermemo_topology_v3::NativeArtifact;

    fn test_index(dimensions: usize, capacity: usize) -> Index {
        let index = Index::new(&usearch::IndexOptions {
            dimensions,
            metric: usearch::MetricKind::L2sq,
            quantization: usearch::ScalarKind::F32,
            connectivity: 16,
            expansion_add: 128,
            expansion_search: 64,
            multi: false,
        })
        .unwrap();
        index.reserve(capacity).unwrap();
        index
    }

    fn fixture() -> (Connection, Index) {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE tags(id INTEGER PRIMARY KEY,name TEXT,vector BLOB);")
            .unwrap();
        let index = test_index(3, 16);
        for (id, v) in [
            (1, [1.0_f32, 0.0, 0.0]),
            (2, [0.0, 1.0, 0.0]),
            (3, [0.0, 0.0, 1.0]),
            (99, [3.0, 2.0, 1.0]),
        ] {
            let bytes: Vec<u8> = v.iter().flat_map(|x| x.to_le_bytes()).collect();
            db.execute(
                "INSERT INTO tags VALUES (?1,?2,?3)",
                rusqlite::params![id, format!("tag{id}"), bytes],
            )
            .unwrap();
            if id != 3 {
                index.add(id as u64, &v).unwrap();
            }
        }
        db.execute_batch("BEGIN").unwrap();
        (db, index)
    }

    #[test]
    fn graph_external_tag_is_filtered_before_projection_but_isolated_member_survives() {
        let (db, index) = fixture();
        // 我方缺省 dynamic_wormholes=false（上游 true），显式开闸对齐上游测试前提。
        let config = PipelineConfig {
            max_levels: 1,
            pyramid_top_k: 3,
            spike_routing: SenseConfig {
                dynamic_wormholes: true,
                ..SenseConfig::default()
            },
            ..PipelineConfig::default()
        };
        let eligible = HashMap::from([(1, 0)]);
        let (p, tags, residuals) = analyze_pyramid(
            &index,
            &db,
            &[3.0, 2.0, 1.0],
            3,
            &config,
            &mut TagVectorPool::new(),
            Some(&eligible),
        )
        .unwrap();
        assert_eq!(tags[0].iter().map(|t| t.id).collect::<Vec<_>>(), vec![1]);
        assert!((p.total_explained_energy - 9.0 / 14.0).abs() < 1e-6);
        assert_eq!(residuals.len(), 2);
        assert_eq!(residuals[1], vec![0.0, 2.0, 1.0]);
        let empty = HashMap::new();
        let (p, tags, residuals) = analyze_pyramid(
            &index,
            &db,
            &[3.0, 2.0, 1.0],
            3,
            &config,
            &mut TagVectorPool::new(),
            Some(&empty),
        )
        .unwrap();
        assert!(p.levels.is_empty() && tags.is_empty() && residuals.is_empty());
    }

    #[test]
    fn final_tail_routes_single_and_last_accepted_layer_without_extra_seeds() {
        let (db, _index) = fixture();
        // 把图外 top 命中从索引移除做单命中层测试。SQL 仍是向量权威；
        // 独立索引只含两条种子轴。
        let axes = test_index(3, 16);
        axes.add(1, &[1.0, 0.0, 0.0]).unwrap();
        axes.add(2, &[0.0, 1.0, 0.0]).unwrap();
        let graph = NativeArtifact {
            node_ids: vec![1, 2, 3],
            node_index: HashMap::from([(1, 0), (2, 1), (3, 2)]),
            row_offsets: vec![0, 1, 2, 2],
            targets: vec![2, 2],
            weights: vec![0.2, 0.2],
            ..NativeArtifact::default()
        }
        .prepared();
        for depth in [1, 2] {
            let config = PipelineConfig {
                max_levels: depth,
                pyramid_top_k: 1,
                spike_routing: SenseConfig {
                    dynamic_wormholes: true,
                    ..SenseConfig::default()
                },
                ..PipelineConfig::default()
            };
            let mut pool = TagVectorPool::new();
            let (p, tags, residuals) = analyze_pyramid(
                &axes,
                &db,
                &[3.0, 2.0, 1.0],
                3,
                &config,
                &mut pool,
                Some(&graph.node_index),
            )
            .unwrap();
            assert_eq!(p.levels.len(), depth);
            assert_eq!(tags.len(), depth);
            assert_eq!(residuals.len(), depth + 1);
            let last = tags.last().unwrap()[0].id;
            let mut ctx =
                DynamicWormholeContext::new(&db, &mut pool, residuals, HashMap::from([(last, depth - 1)]));
            let output = sense_with_context(
                &graph,
                "tail-test",
                SenseInput {
                    query_id: None,
                    seeds: vec![SenseSeed {
                        id: last,
                        energy: 1.0,
                        source_type: "seed".into(),
                    }],
                    config: SenseConfig {
                        max_safe_hops: 1,
                        dynamic_wormholes: true,
                        ..SenseConfig::default()
                    },
                },
                Some(&mut ctx),
            )
            .unwrap();
            assert_eq!(output.diagnostics.accepted_seed_nodes, 1);
            assert!(output.diagnostics.dynamic_wormhole_candidates > 0);
            assert_eq!(output.diagnostics.dynamic_wormhole_edges_fired, 1);
            assert!(output
                .edges
                .iter()
                .all(|e| e.source_id == last && e.target_id == 3));
        }
    }

    #[test]
    fn disabled_tiny_exhausted_and_unaccepted_tails_are_not_appended() {
        let (db, index) = fixture();
        let eligible = HashMap::from([(1, 0)]);
        for (enabled, query, minimum, expected_layers, expected_residuals) in [
            (false, [3.0, 2.0, 1.0], 0.03, 1, 0),
            (true, [10.0, 1.0, 0.0], 0.03, 1, 1),
            (true, [1.0, 0.0, 0.0], 0.03, 1, 1),
            (true, [3.0, 2.0, 1.0], 0.99, 0, 0),
        ] {
            let config = PipelineConfig {
                max_levels: 1,
                pyramid_top_k: 3,
                min_layer_explained_energy: minimum,
                spike_routing: SenseConfig {
                    dynamic_wormholes: enabled,
                    ..SenseConfig::default()
                },
                ..PipelineConfig::default()
            };
            let (p, _, residuals) = analyze_pyramid(
                &index,
                &db,
                &query,
                3,
                &config,
                &mut TagVectorPool::new(),
                Some(&eligible),
            )
            .unwrap();
            assert_eq!(p.levels.len(), expected_layers);
            assert_eq!(residuals.len(), expected_residuals);
        }
    }
}

#[cfg(test)]
mod explicit_core_seed_tests {
    use super::*;

    fn epa() -> EpaOutput {
        EpaOutput {
            logic_depth: 0.0,
            entropy: 1.0,
            resonance: 0.0,
            dominant_axes: vec![],
            bridges: vec![],
            basis_count: 0,
            cache_available: false,
        }
    }

    #[test]
    fn sql_cores_and_hard_anchors_ignite_without_pyramid_but_soft_ghosts_do_not() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE tags(id INTEGER PRIMARY KEY,name TEXT,vector BLOB);")
            .unwrap();
        for (id, name, vector) in [
            (1, "尊界", [1.0_f32, 0.0]),
            (2, "问界", [0.0, 1.0]),
            (3, "软标签", [1.0, 1.0]),
            (4, "图外", [1.0, 0.0]),
            (5, "坏向量", [0.0, 0.0]),
        ] {
            let bytes: Vec<u8> = vector.iter().flat_map(|v| v.to_le_bytes()).collect();
            db.execute(
                "INSERT INTO tags VALUES (?1,?2,?3)",
                rusqlite::params![id, name, bytes],
            )
            .unwrap();
        }
        let ghost =
            |name: &str, is_core| GhostTagInput {
                name: name.into(),
                vector: vec![1.0, 0.0],
                is_core,
            };
        let ghosts = vec![ghost("问界", true), ghost("软标签", false), ghost("不存在", true)];
        let cores = vec![" 尊界 ".into(), "尊界".into(), "图外".into(), "坏向量".into()];
        let graph = crate::rivermemo_topology_v3::NativeArtifact {
            node_ids: vec![1, 2, 3, 5],
            node_index: HashMap::from([(1, 0), (2, 1), (3, 2), (5, 3)]),
            row_offsets: vec![0, 1, 1, 1, 1],
            targets: vec![2],
            weights: vec![0.5],
            ..crate::rivermemo_topology_v3::NativeArtifact::default()
        }
        .prepared();
        let resolved = resolve_core_seeds(
            &db,
            &cores,
            &ghosts,
            &graph.node_index,
            &mut TagVectorPool::new(),
            2,
        )
        .unwrap();
        assert_eq!(resolved, vec![(1, "尊界".into()), (2, "问界".into())]);
        let pyramid = PyramidOutput {
            levels: vec![],
            total_explained_energy: 0.0,
            features: PyramidFeatures::default(),
        };
        let (gated, _, boost) = gate_tags_for_graph(
            &[],
            &epa(),
            &pyramid,
            &cores,
            &PipelineConfig::default(),
            "",
            Some(&graph.node_index),
            &resolved,
        );
        assert_eq!(gated.len(), 2);
        assert!(gated.iter().all(|t| t.is_core && t.weight == boost));
        let observation = sense_typed(
            &graph,
            "explicit-core",
            SenseInput {
                query_id: None,
                config: SenseConfig::default(),
                seeds: gated
                    .iter()
                    .map(|t| SenseSeed {
                        id: t.id,
                        energy: t.weight,
                        source_type: "core".into(),
                    })
                    .collect(),
            },
        )
        .unwrap();
        assert_eq!(observation.diagnostics.accepted_seed_nodes, 2);
        for id in [1, 2] {
            let node = observation.nodes.iter().find(|n| n.id == id).unwrap();
            assert_eq!(node.hop, 0);
            assert_eq!(node.source_type, "core");
        }
        assert!(!observation.edges.is_empty());
        let index = Index::new(&usearch::IndexOptions {
            dimensions: 2,
            metric: usearch::MetricKind::L2sq,
            quantization: usearch::ScalarKind::F32,
            connectivity: 16,
            expansion_add: 128,
            expansion_search: 64,
            multi: false,
        })
        .unwrap();
        let (_, fusion, _) = fuse_observation(
            &index,
            &db,
            &mut TagVectorPool::new(),
            &[1.0, 0.0],
            &observation,
            &gated,
            &[],
            &ghosts[..1],
            boost,
            2,
            0.2,
            &PipelineConfig::default(),
        )
        .unwrap();
        assert_eq!(fusion.ghost_count, 0);

        let levels = vec![vec![PyramidTagWork {
            id: 1,
            name: "尊界".into(),
            vector: vec![1.0, 0.0],
            similarity: 0.2,
            contribution: 0.01,
            handshake_magnitude: 0.0,
        }]];
        let (promoted, _, boost) = gate_tags_for_graph(
            &levels,
            &epa(),
            &pyramid,
            &cores,
            &PipelineConfig::default(),
            "",
            Some(&graph.node_index),
            &resolved,
        );
        assert_eq!(promoted.len(), 2);
        assert!(promoted.iter().all(|t| t.is_core && t.weight >= boost));
    }
}
