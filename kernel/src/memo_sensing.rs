//! memo_sensing —— 票 08 + VCP 2.0 复刻 P1.1：行为等价复刻上游 memo_sensing.rs（2.0 HEAD 956 行）。
//!
//! 与上游的唯一刻意差异：active/next 用 BTreeMap（上游 HashMap）——迭代序确定（票⑥红线），
//! f64 累加序与 oracle 的随机序存在 ULP 级差（≪1e-6 容差）。输出集合（nodes/edges）本就按全序排序。
//!
//! P1.1 动态虫洞（上游锚点 68-72 / 110 / 190-215 / 228 / 262-366）：
//! - 共鸣 = 更深层金字塔残差与目标原始向量的正余弦 max（layer > source_level）；
//! - 选席序 conductance·resonance⁴ → conductance → node_id；预留席 slots 落在 K 邻居名额内，
//!   其余按历史名次（权重降序）补齐；回流电流闸先于占席（被否决的边不消耗预留席）；
//! - wormhole = dynamic || edge_is_wormhole[cursor] || conductance·node_anchor_gain[target] >= 阈值；
//! - 诊断 6 计数 + DynamicWormholeDiagnostics 工作账。
//!
//! ⚠️ 我方缺省 `dynamic_wormholes = false`（上游 true）——生产正在跑本内核，
//! v9.2 五腿零漂移是硬判据：关 = context 强制 None = 完全旧路径（含边界选择逻辑逐字不变）。
//! 测试里显式开。

use crate::memo_vector_pool::{ensure_tag_vectors_loaded, TagVectorPool};
use crate::rivermemo_topology_v3::NativeArtifact;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap};
use std::time::Instant;

const OBSERVATION_SCHEMA: &str = "vexus-unified-memo-observation-v1";
const ALGORITHM_VERSION: &str = "tagmemo.spike-v9.1-rust-shared";

fn positive(value: f64) -> f64 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    }
}

fn default_energy() -> f64 {
    1.0
}

fn default_source_type() -> String {
    "seed".to_string()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SenseInput {
    #[serde(default)]
    pub(crate) query_id: Option<String>,
    #[serde(default)]
    pub(crate) seeds: Vec<SenseSeed>,
    #[serde(default)]
    pub(crate) config: SenseConfig,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SenseSeed {
    pub(crate) id: i64,
    #[serde(default = "default_energy")]
    pub(crate) energy: f64,
    #[serde(default = "default_source_type")]
    pub(crate) source_type: String,
}

#[derive(Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct SenseConfig {
    pub(crate) max_safe_hops: usize,
    pub(crate) base_momentum: f64,
    pub(crate) firing_threshold: f64,
    pub(crate) base_decay: f64,
    pub(crate) wormhole_decay: f64,
    pub(crate) tension_threshold: f64,
    pub(crate) max_neighbors_per_node: usize,
    pub(crate) return_flow_factor: f64,
    pub(crate) fir_gamma: f64,
    pub(crate) max_propagation_states: usize,
    pub(crate) minimum_injected_current: f64,
    pub(crate) max_output_nodes: usize,
    pub(crate) max_output_edges: usize,
    /// 0 关闭路由记录。记录从不改变传播（上游 65-66）。
    pub(crate) max_transition_records: usize,
    /// 只有管线侧会提供残差上下文；独立 sensing 走旧路径（上游 67-68）。
    /// ⚠️ 我方缺省 false（上游 true）：暗上线，保 v9.2 五腿零漂移。
    pub(crate) dynamic_wormholes: bool,
    pub(crate) dynamic_wormhole_threshold: f64,
    pub(crate) dynamic_wormhole_slots: usize,
    /// 请求级唯一目标预算。0 关闭本地向量工作（上游 71-72）。
    pub(crate) dynamic_wormhole_max_targets: usize,
}

impl Default for SenseConfig {
    fn default() -> Self {
        Self {
            max_safe_hops: 4,
            base_momentum: 2.0,
            firing_threshold: 0.10,
            base_decay: 0.25,
            wormhole_decay: 0.70,
            tension_threshold: 1.0,
            max_neighbors_per_node: 20,
            return_flow_factor: 0.15,
            fir_gamma: 0.6,
            max_propagation_states: 2000,
            minimum_injected_current: 0.01,
            // 0 表示完整输出；截断只发生在后续融合层
            max_output_nodes: 0,
            max_output_edges: 0,
            max_transition_records: 0,
            dynamic_wormholes: false, // 上游 true；我方暗上线（见模块头）
            dynamic_wormhole_threshold: 0.2,
            dynamic_wormhole_slots: 2,
            dynamic_wormhole_max_targets: 4096,
        }
    }
}

#[derive(Clone)]
struct SpikeState {
    node_index: usize,
    previous_index: Option<usize>,
    energy: f64,
    momentum: f64,
    source_type: String,
    hop: usize,
    seed_id: i64,
    /// 该状态携带的最小残差层号（上游 111）：只有更深层的残差能给源提供支撑。
    residual_level: usize,
}

#[derive(Clone)]
struct Provenance {
    source_type: String,
    origin_type: Option<String>,
    hop: usize,
    seed_id: Option<i64>,
}

#[derive(Clone)]
struct Parent {
    parent_id: i64,
    flow: f64,
    hop: usize,
    wormhole: bool,
}

#[derive(Clone)]
struct EdgeFlow {
    source_id: i64,
    target_id: i64,
    flow: f64,
    max_flow: f64,
    conductance: f64,
    min_hop: usize,
    wormhole: bool,
    immediate_return: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ObservationNode {
    pub(crate) id: i64,
    pub(crate) energy: f64,
    pub(crate) normalized_energy: f64,
    pub(crate) source_type: String,
    pub(crate) origin_type: Option<String>,
    pub(crate) hop: usize,
    pub(crate) seed_id: Option<i64>,
    pub(crate) strongest_parent: Option<ObservationParent>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ObservationParent {
    pub(crate) parent_id: i64,
    pub(crate) flow: f64,
    pub(crate) hop: usize,
    pub(crate) wormhole: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ObservationEdge {
    pub(crate) source_id: i64,
    pub(crate) target_id: i64,
    pub(crate) flow: f64,
    pub(crate) max_flow: f64,
    pub(crate) normalized_flow: f64,
    pub(crate) conductance: f64,
    pub(crate) min_hop: usize,
    pub(crate) wormhole: bool,
    pub(crate) immediate_return: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SenseDiagnostics {
    pub(crate) backend: String,
    pub(crate) seed_nodes: usize,
    pub(crate) reached_nodes: usize,
    pub(crate) active_edges: usize,
    pub(crate) maximum_node_energy: f64,
    pub(crate) maximum_edge_flow: f64,
    pub(crate) return_flow_suppressed_mass: f64,
    pub(crate) state_truncations: usize,
    pub(crate) hop_in_flight_mass: Vec<f64>,
    pub(crate) artifact_nodes: usize,
    pub(crate) artifact_edges: usize,
    pub(crate) elapsed_ms: f64,
    /// 在被目的地状态上限剪枝之前统计的「已接受电流」事件数（上游 193）。
    pub(crate) wormhole_edges_fired: usize,
    pub(crate) dynamic_wormhole_edges_fired: usize,
    pub(crate) promoted_wormhole_transitions: usize,
    pub(crate) dynamic_wormhole_candidates: usize,
    pub(crate) dynamic_wormhole_selected: usize,
    pub(crate) dynamic_wormhole_work: DynamicWormholeDiagnostics,
}

/// 已接受传播状态之间的时序展开转移（上游 202-215）。
/// 状态身份是 (hop, previous_id, node_id)，不是 Tag ID；多条种子路径可并成同一状态。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ObservationTransition {
    pub(crate) source_id: i64,
    pub(crate) target_id: i64,
    pub(crate) previous_id: Option<i64>,
    pub(crate) hop: usize,
    pub(crate) flow: f64,
    pub(crate) wormhole: bool,
    pub(crate) immediate_return: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SenseOutput {
    pub(crate) schema: String,
    pub(crate) algorithm_version: String,
    pub(crate) artifact_sig: String,
    pub(crate) query_id: Option<String>,
    pub(crate) source_field: Vec<(i64, f64)>,
    pub(crate) nodes: Vec<ObservationNode>,
    pub(crate) edges: Vec<ObservationEdge>,
    pub(crate) diagnostics: SenseDiagnostics,
    pub(crate) transitions: Vec<ObservationTransition>,
    pub(crate) transitions_truncated: bool,
}

fn fir_weights(config: &SenseConfig) -> Vec<f64> {
    let gamma = config.fir_gamma.clamp(0.05, 0.95);
    let mut weights: Vec<f64> = (0..=config.max_safe_hops)
        .map(|hop| gamma.powi(hop as i32))
        .collect();
    let total: f64 = weights.iter().sum();
    if total > 0.0 {
        for weight in &mut weights {
            *weight /= total;
        }
    }
    weights
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DynamicWormholeDiagnostics {
    pub(crate) targets_evaluated: usize,
    pub(crate) sql_fetched_nodes: usize,
    pub(crate) sql_batches: usize,
    pub(crate) dot_products: usize,
    pub(crate) cache_hits: usize,
    pub(crate) budget_exhausted: bool,
    pub(crate) load_ms: f64,
    pub(crate) score_ms: f64,
    pub(crate) selection_ms: f64,
}

/// 请求局部，绝不改图资产、绝不持久化残差（上游 260-271）。
/// 层 L 的源只被 > L 的残差支撑。
pub(crate) struct DynamicWormholeContext<'a> {
    pub(crate) connection: &'a Connection,
    pub(crate) pool: &'a mut TagVectorPool,
    pub(crate) residuals: Vec<Vec<f32>>,
    residual_norms: Vec<f64>,
    known_scores: HashMap<(usize, i64), f64>,
    pub(crate) seed_levels: HashMap<i64, usize>,
    scores: HashMap<usize, Vec<f64>>,
    pub(crate) diagnostics: DynamicWormholeDiagnostics,
}

impl<'a> DynamicWormholeContext<'a> {
    pub(crate) fn new(
        connection: &'a Connection,
        pool: &'a mut TagVectorPool,
        residuals: Vec<Vec<f32>>,
        seed_levels: HashMap<i64, usize>,
    ) -> Self {
        let residual_norms = residuals
            .iter()
            .map(|residual| {
                residual
                    .iter()
                    .map(|&value| (value as f64).powi(2))
                    .sum::<f64>()
                    .sqrt()
            })
            .collect();
        Self {
            connection,
            pool,
            residuals,
            residual_norms,
            seed_levels,
            known_scores: HashMap::new(),
            scores: HashMap::new(),
            diagnostics: DynamicWormholeDiagnostics::default(),
        }
    }

    /// 复用金字塔阶段已算出的层相似度（同一残差层的同义读数），避免重复点积。
    pub(crate) fn reuse_score(&mut self, layer: usize, id: i64, score: f64) {
        if score.is_finite() {
            self.known_scores.insert((layer, id), score.clamp(-1.0, 1.0));
        }
    }

    fn prepare(
        &mut self,
        artifact: &NativeArtifact,
        active: &BTreeMap<(Option<usize>, usize), SpikeState>,
        config: &SenseConfig,
    ) -> std::result::Result<(), String> {
        if self.residuals.len() < 2 {
            return Ok(());
        }
        let mut targets = Vec::new();
        for spike in active.values().filter(|state| {
            state.energy >= config.firing_threshold
                && state.momentum >= 0.0
                && state.residual_level + 1 < self.residuals.len()
        }) {
            for cursor in
                artifact.row_offsets[spike.node_index]..artifact.row_offsets[spike.node_index + 1]
            {
                if positive(artifact.weights[cursor]) <= 0.0 {
                    break;
                }
                let target = artifact.targets[cursor];
                if !self.scores.contains_key(&target) {
                    targets.push(target);
                }
            }
        }
        // 确定性的请求级预算，与 HashMap 迭代序无关（上游 305）。
        targets.sort_unstable();
        targets.dedup();
        let remaining = config
            .dynamic_wormhole_max_targets
            .saturating_sub(self.scores.len());
        if targets.len() > remaining {
            self.diagnostics.budget_exhausted = true;
        }
        targets.truncate(remaining);
        if targets.is_empty() {
            return Ok(());
        }
        let dimension = self.residuals[0].len();
        let ids: Vec<i64> = targets.iter().map(|&index| artifact.node_ids[index]).collect();
        let began = Instant::now();
        let stats = ensure_tag_vectors_loaded(self.connection, self.pool, &ids, dimension)?;
        self.diagnostics.load_ms += began.elapsed().as_secs_f64() * 1000.0;
        self.diagnostics.sql_fetched_nodes += stats.fetched_nodes;
        self.diagnostics.sql_batches += stats.sql_batches;
        let began = Instant::now();
        for target in targets {
            // 缺失/脏行也缓存：绝不每跳重试同一条 SQL 行（上游 321）。
            let mut scores = vec![0.0; self.residuals.len()];
            if let Some(vector) = self.pool.get(&artifact.node_ids[target]) {
                let norm = vector
                    .iter()
                    .map(|&value| (value as f64).powi(2))
                    .sum::<f64>()
                    .sqrt();
                if vector.len() == dimension && norm.is_finite() && norm > 1e-12 {
                    for (layer, residual) in self.residuals.iter().enumerate().skip(1) {
                        let residual_norm = self.residual_norms[layer];
                        if residual.len() != dimension {
                            continue;
                        }
                        if residual_norm.is_finite() && residual_norm > 1e-12 {
                            if let Some(&score) =
                                self.known_scores.get(&(layer, artifact.node_ids[target]))
                            {
                                scores[layer] = positive(score);
                                self.diagnostics.cache_hits += 1;
                            } else {
                                let dot = residual
                                    .iter()
                                    .zip(vector.iter())
                                    .map(|(&a, &b)| a as f64 * b as f64)
                                    .sum::<f64>();
                                scores[layer] = positive(dot / (norm * residual_norm)).min(1.0);
                                self.diagnostics.dot_products += 1;
                            }
                        }
                    }
                }
            }
            self.scores.insert(target, scores);
        }
        self.diagnostics.targets_evaluated = self.scores.len();
        self.diagnostics.score_ms += began.elapsed().as_secs_f64() * 1000.0;
        Ok(())
    }

    fn resonance(&mut self, target: usize, source_level: usize) -> f64 {
        let Some(scores) = self.scores.get(&target) else {
            return 0.0;
        };
        self.diagnostics.cache_hits += 1;
        scores
            .iter()
            .skip(source_level.saturating_add(1))
            .copied()
            .fold(0.0, f64::max)
    }
}

/// 旧入口（上游 2.0 已降为 #[cfg(test)]）：我方保留为无上下文薄壳，
/// 供独立 sensing 调用面与单测使用——关掉动态虫洞时与 sense_with_context(…, None) 逐字等价。
#[allow(dead_code)]
pub(crate) fn sense_typed(
    artifact: &NativeArtifact,
    artifact_sig: &str,
    input: SenseInput,
) -> std::result::Result<SenseOutput, String> {
    sense_with_context(artifact, artifact_sig, input, None)
}

pub(crate) fn sense_with_context(
    artifact: &NativeArtifact,
    artifact_sig: &str,
    input: SenseInput,
    mut context: Option<&mut DynamicWormholeContext<'_>>,
) -> std::result::Result<SenseOutput, String> {
    let started_at = Instant::now();
    let config = input.config;
    // 关闸即完全旧路径：context 强制 None，边界选择与 wormhole 判据逐字回到 v9.2。
    if !config.dynamic_wormholes
        || config.dynamic_wormhole_slots == 0
        || config.dynamic_wormhole_max_targets == 0
    {
        context = None;
    }
    if !config.dynamic_wormhole_threshold.is_finite()
        || !(0.0..=1.0).contains(&config.dynamic_wormhole_threshold)
    {
        return Err("dynamicWormholeThreshold must be finite and in [0,1]".into());
    }
    let weights = fir_weights(&config);
    let mut active: BTreeMap<(Option<usize>, usize), SpikeState> = BTreeMap::new();
    let mut accumulated: HashMap<usize, f64> = HashMap::new();
    let mut provenance: HashMap<usize, Provenance> = HashMap::new();
    let mut edge_flows: HashMap<(usize, usize), EdgeFlow> = HashMap::new();
    let mut parents: HashMap<usize, Parent> = HashMap::new();

    for seed in input
        .seeds
        .iter()
        .filter(|seed| seed.id > 0 && seed.energy > 0.0)
    {
        let Some(&node_index) = artifact.node_index.get(&seed.id) else {
            continue;
        };
        let energy = positive(seed.energy);
        let source_type = if seed.source_type.is_empty() {
            "seed".to_string()
        } else {
            seed.source_type.clone()
        };
        active
            .entry((None, node_index))
            .and_modify(|state| state.energy += energy)
            .or_insert(SpikeState {
                node_index,
                previous_index: None,
                energy,
                momentum: config.base_momentum,
                source_type: source_type.clone(),
                hop: 0,
                seed_id: seed.id,
                residual_level: context
                    .as_ref()
                    .and_then(|ctx| ctx.seed_levels.get(&seed.id).copied())
                    .unwrap_or(usize::MAX / 2),
            });
        *accumulated.entry(node_index).or_default() += energy * weights[0];
        provenance.entry(node_index).or_insert(Provenance {
            source_type,
            origin_type: None,
            hop: 0,
            seed_id: Some(seed.id),
        });
    }

    // 空种子是合法的请求级观测：仍允许传播后补入字符串 Core/幽灵节点参与最终融合
    let mut return_flow_suppressed_mass = 0.0;
    let mut state_truncations = 0usize;
    let mut hop_in_flight_mass = Vec::new();
    let transition_limit = config.max_transition_records.min(16_000);
    let mut transitions: Vec<ObservationTransition> = Vec::new();
    let mut transitions_truncated = false;

    let mut wormhole_edges_fired = 0;
    let mut dynamic_wormhole_edges_fired = 0;
    let mut promoted_wormhole_transitions = 0;
    let mut dynamic_wormhole_candidates = 0;
    let mut dynamic_wormhole_selected = 0;
    // 逐 spike 复用的临时区（上游 441-442 同构，避免每跳小分配）。
    let mut ranked_scratch: Vec<(usize, f64)> = Vec::new();
    let mut candidate_scratch: Vec<(usize, f64, f64)> = Vec::new();
    let mut selected_scratch: Vec<(usize, f64, bool)> = Vec::new();

    for hop in 0..config.max_safe_hops {
        if let Some(ctx) = context.as_deref_mut() {
            ctx.prepare(artifact, &active, &config)?;
        }
        let mut next: BTreeMap<(Option<usize>, usize), SpikeState> = BTreeMap::new();
        let mut hop_transitions: Vec<ObservationTransition> = Vec::new();

        for spike in active.values() {
            if spike.energy < config.firing_threshold || spike.momentum < 0.0 {
                continue;
            }
            let start = artifact.row_offsets[spike.node_index];
            let end = artifact.row_offsets[spike.node_index + 1];
            // 历史名次：整行按权重降序（平手保行序）。prepared() 的行序已是
            // 「权重降序、平手 node_id 升序」，故与上游 start..limit 逐位一致；
            // 未 prepared 的资产上也保持 v9.2 的查询期重排语义。
            // 注意这里是**整行**（动态虫洞的候选来自历史窗口之外），
            // 历史席位只是它的前 K 个。
            ranked_scratch.clear();
            ranked_scratch.extend(
                (start..end)
                    .map(|cursor| (artifact.targets[cursor], positive(artifact.weights[cursor])))
                    .filter(|entry| entry.1 > 0.0),
            );
            ranked_scratch
                .sort_by(|left, right| right.1.partial_cmp(&left.1).unwrap_or(Ordering::Equal));
            let history_len = ranked_scratch
                .len()
                .min(config.max_neighbors_per_node.max(1));

            selected_scratch.clear();
            if let Some(ctx) = context.as_deref_mut() {
                let began = Instant::now();
                let slots =
                    config.dynamic_wormhole_slots.min(config.max_neighbors_per_node.max(1));
                candidate_scratch.clear();
                for &(target, conductance) in &ranked_scratch {
                    if target == spike.node_index {
                        continue;
                    }
                    let resonance = ctx.resonance(target, spike.residual_level);
                    if resonance <= 0.0 || resonance < config.dynamic_wormhole_threshold {
                        continue;
                    }
                    dynamic_wormhole_candidates += 1;
                    // 回流电流闸先于占席：被否决的边不消耗预留席。
                    let return_factor = if spike.previous_index == Some(target) {
                        config.return_flow_factor.clamp(0.0, 1.0)
                    } else {
                        1.0
                    };
                    if spike.energy * conductance * config.wormhole_decay * return_factor
                        < config.minimum_injected_current
                    {
                        continue;
                    }
                    candidate_scratch.push((
                        target,
                        conductance,
                        conductance * resonance.powi(4),
                    ));
                }
                candidate_scratch.sort_unstable_by(|left, right| {
                    right
                        .2
                        .total_cmp(&left.2)
                        .then_with(|| right.1.total_cmp(&left.1))
                        .then_with(|| {
                            artifact.node_ids[left.0].cmp(&artifact.node_ids[right.0])
                        })
                });
                for &(target, conductance, _) in candidate_scratch.iter().take(slots) {
                    selected_scratch.push((target, conductance, true));
                }
                // 预留席落在 K 名额内；其余席位按历史名次补齐，不重复占席。
                for &(target, conductance) in ranked_scratch.iter().take(history_len) {
                    if selected_scratch.len() >= config.max_neighbors_per_node.max(1) {
                        break;
                    }
                    if !selected_scratch
                        .iter()
                        .any(|(selected, _, _)| *selected == target)
                    {
                        selected_scratch.push((target, conductance, false));
                    }
                }
                ctx.diagnostics.selection_ms += began.elapsed().as_secs_f64() * 1000.0;
            } else {
                selected_scratch.extend(
                    ranked_scratch
                        .iter()
                        .take(history_len)
                        .map(|&(target, conductance)| (target, conductance, false)),
                );
            }

            for &(target_index, conductance, dynamic_wormhole) in &selected_scratch {
                dynamic_wormhole_selected += usize::from(dynamic_wormhole);
                let source_id = artifact.node_ids[spike.node_index];
                let target_id = artifact.node_ids[target_index];
                let residual = artifact.anchor_gain.get(&target_id).copied().unwrap_or(1.0);
                let wormhole = dynamic_wormhole
                    || artifact.wormhole_edges.contains(&(source_id, target_id))
                    || conductance * residual >= config.tension_threshold;
                let decay = if wormhole {
                    config.wormhole_decay
                } else {
                    config.base_decay
                };
                let immediate_return = spike.previous_index == Some(target_index);
                let unpenalized = spike.energy * conductance * decay;
                let injected = unpenalized
                    * if immediate_return {
                        config.return_flow_factor.clamp(0.0, 1.0)
                    } else {
                        1.0
                    };
                if immediate_return {
                    return_flow_suppressed_mass += positive(unpenalized - injected);
                }
                if injected < config.minimum_injected_current {
                    continue;
                }

                wormhole_edges_fired += usize::from(wormhole);
                dynamic_wormhole_edges_fired += usize::from(dynamic_wormhole);
                // 历史窗口之外的动态边 = 提升（promotion）——诊断用。
                if dynamic_wormhole
                    && !ranked_scratch
                        .iter()
                        .take(history_len)
                        .any(|(target, _)| *target == target_index)
                {
                    promoted_wormhole_transitions += 1;
                }

                let edge = edge_flows
                    .entry((spike.node_index, target_index))
                    .or_insert(EdgeFlow {
                        source_id,
                        target_id,
                        flow: 0.0,
                        max_flow: 0.0,
                        conductance,
                        min_hop: spike.hop + 1,
                        wormhole,
                        immediate_return,
                    });
                edge.flow += injected;
                edge.max_flow = edge.max_flow.max(injected);
                edge.min_hop = edge.min_hop.min(spike.hop + 1);
                edge.wormhole |= wormhole;
                edge.immediate_return |= immediate_return;

                let parent = parents.entry(target_index).or_insert(Parent {
                    parent_id: source_id,
                    flow: injected,
                    hop: spike.hop + 1,
                    wormhole,
                });
                if injected > parent.flow
                    || (injected == parent.flow && spike.hop + 1 < parent.hop)
                {
                    *parent = Parent {
                        parent_id: source_id,
                        flow: injected,
                        hop: spike.hop + 1,
                        wormhole,
                    };
                }

                let next_momentum = spike.momentum - if wormhole { 0.0 } else { 1.0 };
                if next_momentum < 0.0 && !wormhole {
                    continue;
                }
                if transition_limit > 0 {
                    // 临时存储与保留观测都设上限（上游 567）。
                    if hop_transitions.len() < transition_limit {
                        hop_transitions.push(ObservationTransition {
                            source_id,
                            target_id,
                            previous_id: spike.previous_index.map(|index| artifact.node_ids[index]),
                            hop: spike.hop + 1,
                            flow: injected,
                            wormhole,
                            immediate_return,
                        });
                    } else {
                        transitions_truncated = true;
                    }
                }
                next.entry((Some(spike.node_index), target_index))
                    .and_modify(|state| {
                        state.energy += injected;
                        state.momentum = state.momentum.max(next_momentum);
                        state.residual_level = state.residual_level.min(spike.residual_level);
                    })
                    .or_insert(SpikeState {
                        node_index: target_index,
                        previous_index: Some(spike.node_index),
                        energy: injected,
                        momentum: next_momentum,
                        source_type: spike.source_type.clone(),
                        hop: spike.hop + 1,
                        seed_id: spike.seed_id,
                        residual_level: spike.residual_level,
                    });
            }
        }

        if next.len() > config.max_propagation_states.max(100) {
            let mut retained: Vec<SpikeState> = next.into_values().collect();
            retained.sort_by(|left, right| {
                right
                    .energy
                    .partial_cmp(&left.energy)
                    .unwrap_or(Ordering::Equal)
            });
            let limit = config.max_propagation_states.max(100);
            state_truncations += retained.len().saturating_sub(limit);
            retained.truncate(limit);
            next = retained
                .into_iter()
                .map(|state| ((state.previous_index, state.node_index), state))
                .collect();
        }

        // 目的地状态被状态上限剪掉的转移一律不留（上游 618-626）。
        hop_transitions.retain(|edge| {
            let source = artifact.node_index.get(&edge.source_id).copied();
            let target = artifact.node_index.get(&edge.target_id).copied();
            match (source, target) {
                (Some(source), Some(target)) => next.contains_key(&(Some(source), target)),
                _ => false,
            }
        });
        hop_transitions.sort_by(|left, right| {
            right
                .flow
                .total_cmp(&left.flow)
                .then_with(|| left.source_id.cmp(&right.source_id))
                .then_with(|| left.target_id.cmp(&right.target_id))
                .then_with(|| left.previous_id.cmp(&right.previous_id))
        });
        let remaining = transition_limit.saturating_sub(transitions.len());
        if hop_transitions.len() > remaining {
            transitions_truncated = true;
            hop_transitions.truncate(remaining);
        }
        transitions.extend(hop_transitions);

        let mut node_energy: BTreeMap<usize, f64> = BTreeMap::new();
        let mut in_flight = 0.0;
        for spike in next.values() {
            *node_energy.entry(spike.node_index).or_default() += spike.energy;
            in_flight += spike.energy;
            provenance
                .entry(spike.node_index)
                .and_modify(|value| {
                    if spike.hop < value.hop {
                        *value = Provenance {
                            source_type: "emergent".to_string(),
                            origin_type: Some(spike.source_type.clone()),
                            hop: spike.hop,
                            seed_id: Some(spike.seed_id),
                        };
                    }
                })
                .or_insert(Provenance {
                    source_type: "emergent".to_string(),
                    origin_type: Some(spike.source_type.clone()),
                    hop: spike.hop,
                    seed_id: Some(spike.seed_id),
                });
        }
        hop_in_flight_mass.push(in_flight);

        let field_weight = weights[hop + 1];
        let mut propagated = false;
        for (node_index, energy) in node_energy {
            *accumulated.entry(node_index).or_default() += energy * field_weight;
            propagated |= energy > config.minimum_injected_current;
        }
        if !propagated {
            break;
        }
        active = next;
    }

    let maximum_node_energy = accumulated.values().copied().fold(0.0, f64::max);
    let maximum_edge_flow = edge_flows
        .values()
        .map(|edge| edge.flow)
        .fold(0.0, f64::max);

    let mut nodes: Vec<ObservationNode> = accumulated
        .iter()
        .map(|(&index, &energy)| {
            let meta = provenance.get(&index);
            ObservationNode {
                id: artifact.node_ids[index],
                energy,
                normalized_energy: if maximum_node_energy > 0.0 {
                    energy / maximum_node_energy
                } else {
                    0.0
                },
                source_type: meta
                    .map(|value| value.source_type.clone())
                    .unwrap_or_else(|| "unknown".to_string()),
                origin_type: meta.and_then(|value| value.origin_type.clone()),
                hop: meta.map(|value| value.hop).unwrap_or(0),
                seed_id: meta.and_then(|value| value.seed_id),
                strongest_parent: parents.get(&index).map(|parent| ObservationParent {
                    parent_id: parent.parent_id,
                    flow: parent.flow,
                    hop: parent.hop,
                    wormhole: parent.wormhole,
                }),
            }
        })
        .collect();
    nodes.sort_by(|left, right| {
        right
            .energy
            .partial_cmp(&left.energy)
            .unwrap_or(Ordering::Equal)
            .then_with(|| left.id.cmp(&right.id))
    });
    if config.max_output_nodes > 0 {
        nodes.truncate(config.max_output_nodes);
    }

    let mut edges: Vec<ObservationEdge> = edge_flows
        .into_values()
        .map(|edge| ObservationEdge {
            source_id: edge.source_id,
            target_id: edge.target_id,
            flow: edge.flow,
            max_flow: edge.max_flow,
            normalized_flow: if maximum_edge_flow > 0.0 {
                edge.flow / maximum_edge_flow
            } else {
                0.0
            },
            conductance: edge.conductance,
            min_hop: edge.min_hop,
            wormhole: edge.wormhole,
            immediate_return: edge.immediate_return,
        })
        .collect();
    edges.sort_by(|left, right| {
        right
            .flow
            .partial_cmp(&left.flow)
            .unwrap_or(Ordering::Equal)
            .then_with(|| left.source_id.cmp(&right.source_id))
            .then_with(|| left.target_id.cmp(&right.target_id))
    });
    if config.max_output_edges > 0 {
        edges.truncate(config.max_output_edges);
    }

    let total_mass: f64 = nodes.iter().map(|node| node.energy).sum();
    let source_field = nodes
        .iter()
        .filter(|node| node.id > 0 && node.energy > 0.0)
        .map(|node| {
            (
                node.id,
                if total_mass > 0.0 {
                    node.energy / total_mass
                } else {
                    0.0
                },
            )
        })
        .collect();

    Ok(SenseOutput {
        schema: OBSERVATION_SCHEMA.to_string(),
        algorithm_version: ALGORITHM_VERSION.to_string(),
        artifact_sig: artifact_sig.to_string(),
        query_id: input.query_id,
        source_field,
        diagnostics: SenseDiagnostics {
            backend: "rust-shared-memo-runtime".to_string(),
            seed_nodes: input.seeds.len(),
            reached_nodes: nodes.len(),
            active_edges: edges.len(),
            maximum_node_energy,
            maximum_edge_flow,
            return_flow_suppressed_mass,
            state_truncations,
            hop_in_flight_mass,
            artifact_nodes: artifact.node_ids.len(),
            artifact_edges: artifact.targets.len(),
            elapsed_ms: started_at.elapsed().as_secs_f64() * 1000.0,
            wormhole_edges_fired,
            dynamic_wormhole_edges_fired,
            promoted_wormhole_transitions,
            dynamic_wormhole_candidates,
            dynamic_wormhole_selected,
            dynamic_wormhole_work: context
                .as_ref()
                .map(|ctx| ctx.diagnostics.clone())
                .unwrap_or_default(),
        },
        nodes,
        edges,
        transitions,
        transitions_truncated,
    })
}

#[cfg(test)]
mod csr_preparation_tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn ranked_rows_preserve_flags_and_request_thresholds() {
        let graph = NativeArtifact {
            node_ids: vec![10, 30, 20, 40],
            node_index: HashMap::from([(10, 0), (30, 1), (20, 2), (40, 3)]),
            row_offsets: vec![0, 3, 3, 3, 3],
            targets: vec![3, 1, 2],
            weights: vec![0.1, 0.5, 0.5],
            anchor_gain: HashMap::from([(20, 2.0)]),
            wormhole_edges: HashSet::from([(10, 30)]),
            ..NativeArtifact::default()
        }
        .prepared();
        assert_eq!(graph.targets, vec![2, 1, 3]);
        assert_eq!(graph.weights, vec![0.5, 0.5, 0.1]);
        assert_eq!(graph.node_anchor_gain, vec![1.0, 1.0, 2.0, 1.0]);
        assert_eq!(graph.edge_is_wormhole, vec![false, true, false]);
        let run = |threshold, k| {
            sense_typed(
                &graph,
                "test",
                SenseInput {
                    query_id: None,
                    seeds: vec![SenseSeed {
                        id: 10,
                        energy: 1.0,
                        source_type: "seed".into(),
                    }],
                    config: SenseConfig {
                        max_safe_hops: 1,
                        max_neighbors_per_node: k,
                        tension_threshold: threshold,
                        minimum_injected_current: 0.0,
                        ..SenseConfig::default()
                    },
                },
            )
            .unwrap()
        };
        let high = run(2.0, 2);
        assert_eq!(high.edges.len(), 2);
        assert!(!high
            .edges
            .iter()
            .find(|edge| edge.target_id == 20)
            .unwrap()
            .wormhole);
        assert!(high
            .edges
            .iter()
            .find(|edge| edge.target_id == 30)
            .unwrap()
            .wormhole);
        let low = run(1.0, 2);
        assert!(low.edges.iter().all(|edge| edge.wormhole));
        let top_one = run(2.0, 1);
        assert_eq!(top_one.edges[0].target_id, 20);
        let again = graph.prepared();
        assert_eq!(again.targets, vec![2, 1, 3]);
        assert_eq!(again.edge_is_wormhole, vec![false, true, false]);
    }
}

#[cfg(test)]
mod dynamic_wormhole_tests {
    use super::*;

    fn graph() -> NativeArtifact {
        NativeArtifact {
            node_ids: (1..=26).collect(),
            node_index: (1..=26).enumerate().map(|(index, id)| (id, index)).collect(),
            row_offsets: std::iter::once(0).chain(std::iter::repeat(25).take(26)).collect(),
            targets: (1..=25).collect(),
            weights: (0..25).map(|index| if index < 20 { 0.05 } else { 0.04 }).collect(),
            ..NativeArtifact::default()
        }
        .prepared()
    }

    fn database() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE tags(id INTEGER PRIMARY KEY,vector BLOB);")
            .unwrap();
        for id in 2..=26 {
            let vector = if id == 22 { [0.0f32, 1.0] } else { [1.0f32, 0.0] };
            let bytes: Vec<u8> = vector.iter().flat_map(|value| value.to_le_bytes()).collect();
            db.execute("INSERT INTO tags VALUES (?1,?2)", rusqlite::params![id, bytes])
                .unwrap();
        }
        db
    }

    fn input(config: SenseConfig) -> SenseInput {
        SenseInput {
            query_id: None,
            seeds: vec![SenseSeed {
                id: 1,
                energy: 1.0,
                source_type: "seed".into(),
            }],
            config,
        }
    }

    #[test]
    fn residual_rescues_historical_tail_without_inventing_edges() {
        let graph = graph();
        let db = database();
        let mut pool = TagVectorPool::new();
        let mut context = DynamicWormholeContext::new(
            &db,
            &mut pool,
            vec![vec![1.0, 0.0], vec![0.0, 1.0]],
            HashMap::from([(1, 0)]),
        );
        let output = sense_with_context(
            &graph,
            "test",
            input(SenseConfig {
                max_safe_hops: 1,
                dynamic_wormholes: true,
                ..SenseConfig::default()
            }),
            Some(&mut context),
        )
        .unwrap();
        assert_eq!(output.edges.len(), 20);
        let rescued = output.edges.iter().find(|edge| edge.target_id == 22).unwrap();
        assert!(rescued.wormhole);
        assert!((rescued.flow - 0.028).abs() < 1e-12);
        assert_eq!(output.diagnostics.dynamic_wormhole_edges_fired, 1);
        assert_eq!(output.diagnostics.promoted_wormhole_transitions, 1);
        assert_eq!(output.diagnostics.dynamic_wormhole_work.sql_batches, 1);
        assert_eq!(output.diagnostics.dynamic_wormhole_work.dot_products, 25);
        assert!(output
            .edges
            .iter()
            .all(|edge| (2..=26).contains(&edge.target_id)));
    }

    #[test]
    fn disabled_budget_and_last_layer_keep_legacy_selection() {
        for (enabled, budget, source_layer) in [(false, 4096, 0), (true, 0, 0), (true, 4096, 1)] {
            let graph = graph();
            let db = database();
            let mut pool = TagVectorPool::new();
            let mut context = DynamicWormholeContext::new(
                &db,
                &mut pool,
                vec![vec![1.0, 0.0], vec![0.0, 1.0]],
                HashMap::from([(1, source_layer)]),
            );
            let output = sense_with_context(
                &graph,
                "test",
                input(SenseConfig {
                    max_safe_hops: 1,
                    dynamic_wormholes: enabled,
                    dynamic_wormhole_max_targets: budget,
                    ..SenseConfig::default()
                }),
                Some(&mut context),
            )
            .unwrap();
            assert!(!output.edges.iter().any(|edge| edge.target_id == 22));
            assert_eq!(output.diagnostics.dynamic_wormhole_edges_fired, 0);
            assert_eq!(output.diagnostics.dynamic_wormhole_work.sql_batches, 0);
        }
    }

    #[test]
    fn current_gate_does_not_spend_a_reserved_seat() {
        let graph = graph();
        let db = database();
        let mut pool = TagVectorPool::new();
        let mut context = DynamicWormholeContext::new(
            &db,
            &mut pool,
            vec![vec![1.0, 0.0], vec![0.0, 1.0]],
            HashMap::from([(1, 0)]),
        );
        let output = sense_with_context(
            &graph,
            "test",
            input(SenseConfig {
                max_safe_hops: 1,
                minimum_injected_current: 0.03,
                dynamic_wormholes: true,
                ..SenseConfig::default()
            }),
            Some(&mut context),
        )
        .unwrap();
        assert_eq!(output.diagnostics.dynamic_wormhole_candidates, 1);
        assert_eq!(output.diagnostics.dynamic_wormhole_selected, 0);
        assert_eq!(output.diagnostics.dynamic_wormhole_edges_fired, 0);
    }

    #[test]
    fn known_scores_and_missing_vectors_are_request_cached() {
        let graph = graph();
        let db = database();
        db.execute("DELETE FROM tags WHERE id=26", []).unwrap();
        let mut pool = TagVectorPool::new();
        let mut context = DynamicWormholeContext::new(
            &db,
            &mut pool,
            vec![vec![1.0, 0.0], vec![0.0, 1.0]],
            HashMap::from([(1, 0)]),
        );
        context.reuse_score(1, 22, 1.0);
        let config = SenseConfig {
            max_safe_hops: 1,
            dynamic_wormholes: true,
            ..SenseConfig::default()
        };
        let first = sense_with_context(
            &graph,
            "test",
            input(config.clone()),
            Some(&mut context),
        )
        .unwrap();
        let dots = context.diagnostics.dot_products;
        let batches = context.diagnostics.sql_batches;
        let second = sense_with_context(
            &graph,
            "test",
            input(config),
            Some(&mut context),
        )
        .unwrap();
        assert_eq!(dots, 23);
        assert_eq!(context.diagnostics.dot_products, dots);
        assert_eq!(context.diagnostics.sql_batches, batches);
        assert_eq!(
            serde_json::to_value(first.edges).unwrap(),
            serde_json::to_value(second.edges).unwrap()
        );
    }

    /// 我方硬判据（上游没有这条）：缺省关闸下 context 与 None 逐字等价——
    /// 预留席/共鸣/诊断一个都不许漏进 v9.2 路径。
    #[test]
    fn disabled_dynamic_wormholes_is_bit_identical_to_no_context() {
        let graph = graph();
        let db = database();
        let mut pool = TagVectorPool::new();
        let mut context = DynamicWormholeContext::new(
            &db,
            &mut pool,
            vec![vec![1.0, 0.0], vec![0.0, 1.0]],
            HashMap::from([(1, 0)]),
        );
        let config = SenseConfig {
            max_safe_hops: 4,
            dynamic_wormholes: false,
            ..SenseConfig::default()
        };
        let legacy = sense_typed(&graph, "test", input(config.clone())).unwrap();
        let gated = sense_with_context(
            &graph,
            "test",
            input(config),
            Some(&mut context),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(&legacy.nodes).unwrap(),
            serde_json::to_value(&gated.nodes).unwrap()
        );
        assert_eq!(
            serde_json::to_value(&legacy.edges).unwrap(),
            serde_json::to_value(&gated.edges).unwrap()
        );
        assert_eq!(legacy.source_field, gated.source_field);
        assert_eq!(gated.diagnostics.dynamic_wormhole_candidates, 0);
        assert_eq!(gated.diagnostics.dynamic_wormhole_selected, 0);
        assert_eq!(gated.diagnostics.dynamic_wormhole_work.sql_batches, 0);
        assert_eq!(gated.diagnostics.dynamic_wormhole_work.dot_products, 0);
    }
}
