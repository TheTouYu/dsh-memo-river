//! memo_geometry —— VCP 2.0 复刻 P3：AGS 统一几何（Anchored Greedy Gram-Schmidt）。
//!
//! 上游对照：/home/h/app/VCPToolBox-2.0/rust-vexus-lite/src/memo_geometry.rs（1346 行，HEAD 9aa1f67，
//! tag p3-baseline-9aa1f67）。174a5e1→9aa1f67 的变化（744a698/b81d2e6 算子迭代、08c155d/45c9c3a perf）
//! 已全部移植，逐变化对齐：
//! - Gram 空间系数法（gram_gs/select_axes_lazy/select_axes_full/LAZY_GRAM_DIAGONAL_LIMIT）整体退役，
//!   换 direct_axes_core：原空间直接选轴 + 投影缓存（首遍消元零点积）+ 四轴分块 CGS 重正交，
//!   严重相消（估计剩余 ≤1e-3·原能量）或缓存不可用时回退两遍逐轴 MGS2；
//!   候选评分阶段估计剩余 ≤1e-8·原能量时直接重算原空间残差（dot_exact 保序）。
//! - dot_exact / dot_four / sub_four / orthogonal_residual(_with_projections) / project_active(_into) /
//!   dot_neighbors / accumulate_captured_energy 逐行对齐：四路分块每路独立累加器按坐标序累加，
//!   单个点积的加法树不变（位级同 dot，测试 reduction_lengths_and_cancellation 钉死）。
//! - 工作区语义修正（对齐上游 read_unit_vectors/UnitVectorWorkspace）：向量 f32→f64 后 **normalize 入区**
//!   （P0 版存原始未归一向量是差分分叉源），norm 非有限或 ≤1e-12 缺席（P0 版判据 sum<1e-12，口径不同）；
//!   slot 按去重升序 id 分配；norms[slot]=build 期 dot(v,v)；mean 按 slot 序累加。
//! - CSR 预排序预截断：edges=(id,slot,w)，max_keep=max(max_neighbors,star_neighbors)，
//!   select_nth_unstable_by+sort_unstable_by（权重降序、同权 id 升序）；support 仍对完整共现邻居求和。
//! - 局部/星团相位 dot_neighbors 一次预计算 raw_dots，语义门控后直接复用为 correlations；
//!   局部 direct_axes_core(keep_basis=false)（只要残差），全局 anchored_gs(keep_basis=true)。
//! - coverage 分块归约：128 一块块内累加、跨块串行合并（上游 par_chunks(128)+collect+for；我方无 rayon，
//!   用 chunks(128) 复刻同一边界与合并顺序——f64 分块合并与全串行位级不同，边界必须一致）。
//! - ALGORITHM=unified_geometry_ags_t4_cached_reorth、epaAlgorithm=ags-global-star-t4-cached-reorth
//!   （以 9aa1f67 源码 :383/:899 为准；README §4.3 写 v4 是文档措辞，源码常量仍是 t4）。
//! 不随移植（我方本地约定，见 kernel/docs/）：
//! - workspace handoff（storage::memo_workspace_slot / workspace::SnapshotKey / handoff.offer）：
//!   上游供建图（memo_artifact_builder）复用同一 mmap 快照；我方 kernel 无 storage.rs、
//!   artifact_builder 为独立实现无接收端——workspace 生命周期保持到函数尾自然释放，无数值影响。
//! - publication_gate/content_revision/with_registered_*：写路径走我方 open_readwrite 单事务
//!   （BUG-0930 keepalive 契约），kbm_runtime_meta 幂等自建自 seed。
//! - memmap2/bytemuck：内存 Vec<f64> 工作区（免新依赖），位语义同（mmap 读回的就是写入的 f64 位型）。

use crate::memo_artifact_builder::{open_readonly, open_readwrite};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::params;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

const ALGORITHM: &str = "unified_geometry_ags_t4_cached_reorth";

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

/// Baseline-order sequential dot product used in rank-degenerate fallback paths
/// to preserve exact tie-breaking on symmetric near-collinear test matrices.
#[inline]
fn dot_exact(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).fold(0.0, |sum, (x, y)| sum + x * y)
}

/// Sequential reduction shared with the baseline; not an exact-arithmetic dot product.
#[inline]
pub(crate) fn dot(a: &[f64], b: &[f64]) -> f64 {
    dot_exact(a, b)
}

/// Four independent accumulators sharing one pass over `vector`, preserving
/// each dot product's exact coordinate addition order bit-for-bit.
#[inline]
fn dot_four(vector: &[f64], [a, b, c, d]: [&[f64]; 4]) -> [f64; 4] {
    let mut sums = [0.0; 4];
    for (coordinate, &q) in vector.iter().enumerate() {
        sums[0] += q * a[coordinate];
        sums[1] += q * b[coordinate];
        sums[2] += q * c[coordinate];
        sums[3] += q * d[coordinate];
    }
    sums
}

fn normalize(vector: &mut [f64]) -> bool {
    let norm = dot_exact(vector, vector).sqrt();
    if !norm.is_finite() || norm <= 1e-12 {
        return false;
    }
    for value in vector {
        *value /= norm;
    }
    true
}

/// Subtract 4 basis projections in one pass over `residual`.
#[inline]
fn sub_four(residual: &mut [f64], [c0, c1, c2, c3]: [f64; 4], [a0, a1, a2, a3]: [&[f64]; 4]) {
    for (idx, value) in residual.iter_mut().enumerate() {
        let mut v = *value;
        v -= c0 * a0[idx];
        v -= c1 * a1[idx];
        v -= c2 * a2[idx];
        v -= c3 * a3[idx];
        *value = v;
    }
}

/// Construct a residual in the original space, then reorthogonalize once.
/// Uses `dot_exact` to preserve exact tie-breaking under severe cancellation (`near_1e-4..1e-7`).
fn orthogonal_residual(vector: &[f64], basis: &[Vec<f64>]) -> Vec<f64> {
    let mut residual = vector.to_vec();
    if basis.is_empty() {
        return residual;
    }
    for _ in 0..2 {
        for axis in basis {
            let coefficient = dot_exact(&residual, axis);
            for (value, q) in residual.iter_mut().zip(axis) {
                *value -= coefficient * q;
            }
        }
    }
    residual
}

/// Fused projection-cache + selective CGS/MGS2 reorthogonalization:
/// 1. Reuses cached first-pass inner products `<vector, b_m>` (zero dot products on pass 1!).
/// 2. Runs 4-way blocked CGS pass 2, or falls back to exact 2-pass MGS2 under severe cancellation.
fn orthogonal_residual_with_projections(
    vector: &[f64],
    basis: &[Vec<f64>],
    first_pass_coeffs: Option<&[f64]>,
    initial_norm_sq: f64,
    est_norm_sq: f64,
) -> (Vec<f64>, f64) {
    if basis.is_empty() {
        return (vector.to_vec(), initial_norm_sq.sqrt());
    }
    if first_pass_coeffs.is_none() || est_norm_sq <= 1e-3 * initial_norm_sq {
        let residual = orthogonal_residual(vector, basis);
        let norm = dot_exact(&residual, &residual).sqrt();
        return (residual, norm);
    }
    let coeffs = first_pass_coeffs.unwrap();
    let mut residual = vector.to_vec();
    // Pass 1: 4-way fused subtraction using already-computed `<vector, b_m>` (zero dot products!)
    let mut axis_groups = basis.chunks_exact(4);
    let mut coeff_groups = coeffs.chunks_exact(4);
    for (axes, c) in (&mut axis_groups).zip(&mut coeff_groups) {
        sub_four(&mut residual, [c[0], c[1], c[2], c[3]], [&axes[0], &axes[1], &axes[2], &axes[3]]);
    }
    for (axis, &c) in axis_groups.remainder().iter().zip(coeff_groups.remainder()) {
        for (value, q) in residual.iter_mut().zip(axis) {
            *value -= c * q;
        }
    }
    // Pass 2: 4-way blocked CGS reorthogonalization pass
    let mut axis_groups = basis.chunks_exact(4);
    for axes in &mut axis_groups {
        let refs = [axes[0].as_slice(), axes[1].as_slice(), axes[2].as_slice(), axes[3].as_slice()];
        let c = dot_four(&residual, refs);
        sub_four(&mut residual, c, refs);
    }
    for axis in axis_groups.remainder() {
        let c = dot(&residual, axis);
        for (value, q) in residual.iter_mut().zip(axis) {
            *value -= c * q;
        }
    }
    let norm = dot(&residual, &residual).sqrt();
    (residual, norm)
}

#[inline]
fn project_active_into(axis: &[f64], vectors: &[&[f64]], active: &[usize], row: &mut [f64]) {
    let mut groups = active.chunks_exact(4);
    for group in &mut groups {
        let [a, b, c, d] = [group[0], group[1], group[2], group[3]];
        let sums = dot_four(axis, [vectors[a], vectors[b], vectors[c], vectors[d]]);
        row[a] = sums[0];
        row[b] = sums[1];
        row[c] = sums[2];
        row[d] = sums[3];
    }
    for &index in groups.remainder() {
        row[index] = dot(axis, vectors[index]);
    }
}

fn project_active(axis: &[f64], vectors: &[&[f64]], active: &[usize]) -> Vec<f64> {
    let mut row = vec![0.0; vectors.len()];
    project_active_into(axis, vectors, active, &mut row);
    row
}

/// O(K*n*dim + K²*dim + K*n); basis vectors are already in original space.
/// Incremental scalar energy/correlation accumulators avoid O(K²*n) rescans while
/// preserving IEEE-754 left-fold addition order bit-for-bit. Near rank loss,
/// recompute the residual rather than trusting a difference of energies.
fn direct_axes_core(
    target: AgsTarget<'_>,
    candidates: &[AgsCandidate],
    vectors: &[&[f64]],
    precomputed_diagonal: Option<&[f64]>,
    precomputed_correlations: Option<&[f64]>,
    max_basis: usize,
    min_gain: f64,
    keep_basis: bool,
) -> AgsTrace {
    let n = candidates.len();
    assert_eq!(n, vectors.len(), "AGS candidate/vector mismatch");
    let dim = vectors.first().map_or(0, |v| v.len());
    assert!(vectors.iter().all(|v| v.len() == dim), "AGS dimension mismatch");
    let target = match target {
        AgsTarget::Explain(t) => {
            assert!(vectors.is_empty() || t.len() == dim, "AGS target dimension mismatch");
            Some(t)
        }
        AgsTarget::Span => None,
    };

    let owned_diagonal: Vec<f64>;
    let diagonal: &[f64] = match precomputed_diagonal {
        Some(d) => {
            assert_eq!(d.len(), n, "AGS diagonal length mismatch");
            d
        }
        None => {
            owned_diagonal = vectors.iter().map(|v| dot(v, v)).collect();
            &owned_diagonal
        }
    };

    let mut used: Vec<bool> = candidates
        .iter()
        .zip(diagonal)
        .map(|(c, norm)| !c.prior.is_finite() || c.prior <= 0.0 || !norm.is_finite())
        .collect();
    let mut active: Vec<usize> = (0..n).filter(|&j| !used[j]).collect();

    let owned_correlations: Vec<f64>;
    let correlations: &[f64] = match (target, precomputed_correlations) {
        (Some(_), Some(c)) => {
            assert_eq!(c.len(), n, "AGS correlations length mismatch");
            c
        }
        (Some(t), None) => {
            owned_correlations = project_active(t, vectors, &active);
            &owned_correlations
        }
        (None, _) => &[],
    };

    let limit = max_basis.min(n);
    let mut basis: Vec<Vec<f64>> = Vec::with_capacity(limit);
    let mut proj_history: Vec<f64> = Vec::new();
    let mut row_buf: Vec<f64> = Vec::new();
    let mut proj_sq_sum = vec![0.0; n];
    let mut proj_target_sum = vec![0.0; n];
    let mut target_residual = target.map(<[f64]>::to_vec);
    let mut picked = Vec::with_capacity(limit);

    while picked.len() < limit {
        let mut best: Option<(usize, f64)> = None;
        let mut best_pos = 0;
        let mut write_pos = 0;
        let current_k = basis.len();
        for read_pos in 0..active.len() {
            let i = active[read_pos];
            let norm_sq = diagonal[i] - proj_sq_sum[i];
            let numerator = target.map(|_| correlations[i] - proj_target_sum[i]);
            let (orth, signed) = if norm_sq <= 1e-8 * diagonal[i] {
                let residual = orthogonal_residual(vectors[i], &basis);
                let orth = dot_exact(&residual, &residual).sqrt();
                let signed = target.map_or(orth, |t| dot_exact(t, &residual) / orth);
                (orth, signed)
            } else {
                let orth = norm_sq.sqrt();
                (orth, numerator.map_or(orth, |value| value / orth))
            };
            if !orth.is_finite() || orth <= 1e-6 || !signed.is_finite() {
                used[i] = true;
                continue;
            }
            active[write_pos] = i;
            let score = signed.abs() * orth * candidates[i].prior;
            if best.as_ref().is_none_or(|(j, old)| {
                score > *old || (score == *old && candidates[i].id < candidates[*j].id)
            }) {
                best = Some((i, score));
                best_pos = write_pos;
            }
            write_pos += 1;
        }
        active.truncate(write_pos);
        let Some((i, _)) = best else { break };
        used[i] = true;
        active.remove(best_pos);

        let est_norm_sq = diagonal[i] - proj_sq_sum[i];
        let coeffs = (current_k > 0 && !proj_history.is_empty())
            .then(|| &proj_history[i * limit..i * limit + current_k]);
        let (mut axis, norm) = orthogonal_residual_with_projections(
            vectors[i],
            &basis,
            coeffs,
            diagonal[i],
            est_norm_sq,
        );
        if !norm.is_finite() || norm <= 1e-6 {
            continue;
        }
        for value in &mut axis {
            *value /= norm;
        }
        let coefficient = target.map(|t| dot(t, &axis));
        let gain = coefficient.map_or(norm, f64::abs);
        if gain < min_gain {
            break;
        }
        if let Some(coefficient) = coefficient {
            for (value, q) in target_residual.as_mut().unwrap().iter_mut().zip(&axis) {
                *value -= coefficient * q;
            }
        }
        picked.push((candidates[i].id, gain));
        if picked.len() < limit && !active.is_empty() {
            if proj_history.is_empty() {
                proj_history.resize(n * limit, 0.0);
                row_buf.resize(n, 0.0);
            }
            project_active_into(&axis, vectors, &active, &mut row_buf);
            if let Some(c) = coefficient {
                for &j in &active {
                    let p = row_buf[j];
                    proj_history[j * limit + current_k] = p;
                    proj_sq_sum[j] += p * p;
                    proj_target_sum[j] += p * c;
                }
            } else {
                for &j in &active {
                    let p = row_buf[j];
                    proj_history[j * limit + current_k] = p;
                    proj_sq_sum[j] += p * p;
                }
            }
        }
        basis.push(axis);
    }
    let residual_norm = target_residual.map(|residual| {
        let energy = dot(&residual, &residual);
        let original = target.map_or(0.0, |t| dot(t, t));
        if energy < 1e-14 * original {
            0.0
        } else {
            energy.sqrt()
        }
    });
    if !keep_basis {
        basis.clear();
    }
    AgsTrace { picked, basis, residual_norm }
}

fn direct_axes(
    target: AgsTarget<'_>,
    candidates: &[AgsCandidate],
    vectors: &[&[f64]],
    max_basis: usize,
    min_gain: f64,
    keep_basis: bool,
) -> AgsTrace {
    direct_axes_core(target, candidates, vectors, None, None, max_basis, min_gain, keep_basis)
}

/// Test and isolated-benchmark entry point; production uses precomputed inputs
/// through direct_axes_core. Internal axes still support reorthogonalization.
#[allow(dead_code)]
fn select_axes(
    target: AgsTarget<'_>,
    candidates: &[AgsCandidate],
    vectors: &[&[f64]],
    max_basis: usize,
    min_gain: f64,
) -> AgsTrace {
    direct_axes(target, candidates, vectors, max_basis, min_gain, false)
}

pub(crate) fn anchored_gs(
    target: AgsTarget<'_>,
    candidates: &[AgsCandidate],
    vectors: &[&[f64]],
    max_basis: usize,
    min_gain: f64,
) -> AgsTrace {
    direct_axes(target, candidates, vectors, max_basis, min_gain, true)
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

/// 构建期不可变单位向量工作区（内存版，替代上游 mmap UnitVectorWorkspace，免 memmap2/bytemuck）。
/// 语义对齐上游 read_unit_vectors + UnitVectorWorkspace::build：
/// - f32→f64 逐位转后 **normalize 入区**；norm 非有限或 ≤1e-12 的向量缺席，
///   「Invalid/zero vectors remain absent, never enter projections or the mean」。
/// - slot 按去重升序 id 分配（上游 unique.sort_unstable().dedup() 后逐批装配）；
///   mean 按 slot 序累加 = 升序 id 序。
/// - norms[slot] = build 期 dot(vector, vector)（局部相位 diagonal 直取）。
/// - tags 表行数量级 = tag 数，全表扫一次后按 unique 序装配（上游按 128 id 分批 SQL，
///   行集相同、位级无差；分批仅为有界 SQL 面）。
pub(crate) struct UnitVectorWorkspace {
    values: Vec<f64>,
    slots: HashMap<i64, usize>,
    norms: Vec<f64>,
    dimension: usize,
}

impl UnitVectorWorkspace {
    pub(crate) fn empty(dimension: usize) -> Self {
        Self { values: Vec::new(), slots: HashMap::new(), norms: Vec::new(), dimension }
    }

    pub(crate) fn build(
        connection: &rusqlite::Connection,
        ids: &[i64],
        dimension: usize,
    ) -> std::result::Result<Self, String> {
        if dimension == 0 {
            return Err("invalid geometry workspace dimension".to_string());
        }
        let mut raw: HashMap<i64, Vec<u8>> = HashMap::new();
        {
            let mut statement = connection
                .prepare("SELECT id, vector FROM tags")
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, Option<Vec<u8>>>(1)?))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (id, blob) = row.map_err(|e| e.to_string())?;
                if let Some(bytes) = blob {
                    raw.insert(id, bytes);
                }
            }
        }
        let mut unique = ids.to_vec();
        unique.sort_unstable();
        unique.dedup();
        let mut workspace = Self::empty(dimension);
        for id in unique {
            let Some(bytes) = raw.remove(&id) else { continue };
            if bytes.len() != dimension * 4 {
                continue;
            }
            let mut vector = Vec::with_capacity(dimension);
            for chunk in bytes.chunks_exact(4) {
                vector.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]) as f64);
            }
            // normalize 失败（norm 非有限或 ≤1e-12，含 NaN/Inf/零向量）整行缺席。
            if !normalize(&mut vector) {
                continue;
            }
            workspace.norms.push(dot(&vector, &vector));
            workspace.slots.insert(id, workspace.slots.len());
            workspace.values.extend(vector);
        }
        Ok(workspace)
    }

    #[inline]
    fn slot(&self, id: &i64) -> Option<usize> {
        self.slots.get(id).copied()
    }

    #[inline]
    fn get_by_slot(&self, slot: usize) -> &[f64] {
        let start = slot * self.dimension;
        &self.values[start..start + self.dimension]
    }

    #[inline]
    fn norm_by_slot(&self, slot: usize) -> f64 {
        self.norms[slot]
    }

    pub(crate) fn get(&self, id: &i64) -> Option<&[f64]> {
        let slot = *self.slots.get(id)?;
        let start = slot * self.dimension;
        self.values.get(start..start + self.dimension)
    }

    fn contains_key(&self, id: &i64) -> bool {
        self.slots.contains_key(id)
    }
    fn len(&self) -> usize {
        self.slots.len()
    }
    fn is_empty(&self) -> bool {
        self.slots.is_empty()
    }
}

impl std::ops::Index<&i64> for UnitVectorWorkspace {
    type Output = [f64];
    fn index(&self, id: &i64) -> &Self::Output {
        self.get(id).expect("geometry vector ID has been validated")
    }
}

/// Compute `dot(target, v)` across a slice of neighbor vectors using 4-way blocking.
/// Preserves exact per-vector coordinate addition order bit-for-bit.
fn dot_neighbors<'a>(target: &[f64], neighbor_vecs: &[&'a [f64]]) -> Vec<f64> {
    let mut out = vec![0.0; neighbor_vecs.len()];
    let mut groups = neighbor_vecs.chunks_exact(4).zip(out.chunks_exact_mut(4));
    for (vecs, dst) in &mut groups {
        let sums = dot_four(target, [vecs[0], vecs[1], vecs[2], vecs[3]]);
        dst.copy_from_slice(&sums);
    }
    let start = neighbor_vecs.len() & !3;
    for (dst, &v) in out[start..].iter_mut().zip(&neighbor_vecs[start..]) {
        *dst = dot(target, v);
    }
    out
}

/// Accumulate squared projections of `x` onto `basis` axes using 4-way blocking.
/// Preserves `dot(&x, axis).powi(2)` bit-for-bit.
fn accumulate_captured_energy(x: &[f64], basis: &[Vec<f64>], captured: &mut [f64]) {
    let mut axis_groups = basis.chunks_exact(4);
    let mut cap_groups = captured.chunks_exact_mut(4);
    for (axes, cap) in (&mut axis_groups).zip(&mut cap_groups) {
        let sums = dot_four(x, [&axes[0], &axes[1], &axes[2], &axes[3]]);
        cap[0] += sums[0].powi(2);
        cap[1] += sums[1].powi(2);
        cap[2] += sums[2].powi(2);
        cap[3] += sums[3].powi(2);
    }
    for (c, axis) in cap_groups.into_remainder().iter_mut().zip(axis_groups.remainder()) {
        *c += dot(x, axis).powi(2);
    }
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
        if let Some(cache) = &cached {
            // 缓存命中不装工作区（上游同：empty workspace）。
            let load_ms = started.elapsed().as_secs_f64() * 1000.0;
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
        let vectors = UnitVectorWorkspace::build(&read_connection, &ids, self.dimensions)?;
        let fallback = vectors.len();
        drop(read_connection);
        let load_ms = started.elapsed().as_secs_f64() * 1000.0;

        // ── 预截断预排序 Slot-CSR（上游 08c155d：过滤无效向量、截断到 max_keep 各一次）──
        let star_neighbors = number(global, "starNeighbors", max_neighbors as f64, 1.0, 256.0) as usize;
        let max_keep = max_neighbors.max(star_neighbors);
        let mut offsets = vec![0];
        let mut edges: Vec<(i64, usize, f64)> = Vec::new();
        let mut support = Vec::with_capacity(ids.len());
        let cmp_edge = |a: &(i64, usize, f64), b: &(i64, usize, f64)| b.2.total_cmp(&a.2).then(a.0.cmp(&b.0));
        for id in &ids {
            let neighbors = adjacency.remove(id).unwrap_or_default();
            support.push(neighbors.values().sum::<f64>());
            if vectors.contains_key(id) {
                let mut valid_edges: Vec<(i64, usize, f64)> = neighbors
                    .into_iter()
                    .filter_map(|(nid, w)| vectors.slot(&nid).map(|slot| (nid, slot, w)))
                    .collect();
                if valid_edges.len() > max_keep {
                    valid_edges.select_nth_unstable_by(max_keep - 1, cmp_edge);
                    valid_edges.truncate(max_keep);
                }
                valid_edges.sort_unstable_by(cmp_edge);
                edges.extend(valid_edges);
            }
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
        // 局部相位（上游 par_iter：每 id 独立闭包无归约，我方串行 map 位级等价）。
        let results: Vec<LocalResult> = ids
            .iter()
            .enumerate()
            .map(|(i, id)| {
                let mut result = LocalResult { id: *id, status: "failed", count: 0, residual: 1.0 };
                let Some(target_slot) = vectors.slot(id) else { return result };
                let target = vectors.get_by_slot(target_slot);
                let end = offsets[i + 1].min(offsets[i] + max_neighbors);
                let neighbors = &edges[offsets[i]..end];
                let neighbor_vecs: Vec<&[f64]> =
                    neighbors.iter().map(|&(_, slot, _)| vectors.get_by_slot(slot)).collect();
                let raw_dots = dot_neighbors(target, &neighbor_vecs);
                let mut candidates = Vec::with_capacity(neighbors.len());
                let mut refs = Vec::with_capacity(neighbors.len());
                let mut diagonal = Vec::with_capacity(neighbors.len());
                let mut correlations = Vec::with_capacity(neighbors.len());
                for (&(nid, slot, w), (&v, raw_dot)) in
                    neighbors.iter().zip(neighbor_vecs.iter().zip(raw_dots))
                {
                    let sim = raw_dot.clamp(-1.0, 1.0);
                    let semantic = semantic_weight(sim, gate_enabled, peak, sigma, floor, hard_floor);
                    if semantic > 0.0 {
                        candidates.push(AgsCandidate { id: nid, prior: w.ln_1p() * semantic });
                        refs.push(v);
                        diagonal.push(vectors.norm_by_slot(slot));
                        correlations.push(raw_dot);
                    }
                }
                result.count = candidates.len();
                if result.count < min_neighbors {
                    result.status = "insufficient_neighbors";
                    return result;
                }
                let trace = direct_axes_core(
                    AgsTarget::Explain(target),
                    &candidates,
                    &refs,
                    Some(&diagonal),
                    Some(&correlations),
                    max_basis,
                    min_gain,
                    false,
                );
                result.residual = trace.residual_norm.unwrap_or(1.0).clamp(0.0, 1.0);
                result.status = "computed";
                result
            })
            .collect();
        let local_ms = started.elapsed().as_secs_f64() * 1000.0 - load_ms;

        // ── 全局 Span 相：星团中心化 + 膝点截断 ──
        let mut mean = vec![0.0; self.dimensions];
        for slot in 0..vectors.len() {
            let v = vectors.get_by_slot(slot);
            for (m, x) in mean.iter_mut().zip(v) {
                *m += x;
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
        let mix = number(global, "starMix", 0.8, 0.0, 1.0);
        let centered: Vec<Vec<f64>> = pool
            .iter()
            .map(|c| {
                let target = &vectors[&c.id];
                let i = ids.binary_search(&c.id).unwrap();
                let end = offsets[i + 1].min(offsets[i] + star_neighbors);
                let neighbors = &edges[offsets[i]..end];
                let neighbor_vecs: Vec<&[f64]> =
                    neighbors.iter().map(|&(_, slot, _)| vectors.get_by_slot(slot)).collect();
                let raw_dots = dot_neighbors(target, &neighbor_vecs);
                let weighted: Vec<_> = neighbors
                    .iter()
                    .zip(neighbor_vecs.iter().zip(raw_dots))
                    .filter_map(|(&(nid, _, w), (&v, raw_dot))| {
                        let weight = w.ln_1p()
                            * semantic_weight(
                                raw_dot.clamp(-1.0, 1.0),
                                gate_enabled,
                                peak,
                                sigma,
                                floor,
                                hard_floor,
                            );
                        (weight > 0.0).then_some((v, weight))
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
        // 固定分块 + 逐块累加 + 串行合并 = 位级线程无关（上游 par_chunks(128)+collect+for；
        // 我方无 rayon，用 chunks(128) 复刻同一分块边界与合并顺序——f64 分块合并与全串行位级不同）。
        let partial: Vec<_> = ids
            .chunks(128)
            .map(|batch| {
                let mut energy = 0.0;
                let mut captured = vec![0.0; trace.basis.len()];
                let mut x = vec![0.0; self.dimensions];
                for id in batch {
                    if let Some(v) = vectors.get(id) {
                        for ((out, &val), &m) in x.iter_mut().zip(v).zip(&mean) {
                            *out = val - m;
                        }
                        energy += dot(&x, &x);
                        accumulate_captured_energy(&x, &trace.basis, &mut captured);
                    }
                }
                (energy, captured)
            })
            .collect();
        let mut total = 0.0;
        let mut energies = vec![0.0; trace.basis.len()];
        for (energy, values) in partial {
            total += energy;
            for (e, v) in energies.iter_mut().zip(values) {
                *e += v;
            }
        }
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
            "totalEnergy": total, "kSem": k_sem, "kMax": k_max, "epaAlgorithm": "ags-global-star-t4-cached-reorth",
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
    fn direct_residual_and_local_semantics() {
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

    #[test]
    fn randomized_direct_geometry_invariants() {
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
                let diag: Vec<f64> = refs.iter().map(|v| dot(v, v)).collect();
                let corrs = dot_neighbors(&target, &refs);
                for explain in [Some(target.as_slice()), None] {
                    let ags_target = explain.map_or(AgsTarget::Span, AgsTarget::Explain);
                    let direct = anchored_gs(ags_target, &candidates, &refs, max_basis, min_gain);
                    let local = select_axes(explain.map_or(AgsTarget::Span, AgsTarget::Explain),
                        &candidates, &refs, max_basis, min_gain);
                    let pre = direct_axes_core(
                        explain.map_or(AgsTarget::Span, AgsTarget::Explain),
                        &candidates,
                        &refs,
                        Some(&diag),
                        explain.map(|_| corrs.as_slice()),
                        max_basis,
                        min_gain,
                        false,
                    );
                    assert_eq!(direct.picked, local.picked);
                    assert_eq!(direct.residual_norm, local.residual_norm);
                    assert_eq!(local.picked, pre.picked);
                    assert_eq!(local.residual_norm.map(f64::to_bits), pre.residual_norm.map(f64::to_bits));
                    assert!(local.basis.is_empty());
                    assert_eq!(direct.picked.len(), direct.basis.len());
                    for (i, axis) in direct.basis.iter().enumerate() {
                        for (j, other) in direct.basis.iter().enumerate() {
                            assert!((dot(axis, other) - if i == j { 1.0 } else { 0.0 }).abs() < 1e-12);
                        }
                    }
                    if let Some(t) = explain {
                        let mut residual = t.to_vec();
                        for ((_, gain), axis) in direct.picked.iter().zip(&direct.basis) {
                            let coefficient = dot(t, axis);
                            assert!((coefficient.abs() - gain).abs() < 1e-12);
                            for (r, q) in residual.iter_mut().zip(axis) { *r -= coefficient * q; }
                        }
                        let expected = dot(&residual, &residual).sqrt();
                        assert!((direct.residual_norm.unwrap() - expected).abs() < 1e-7);
                    }
                }
            }
        }
    }

    #[test]
    fn overflowing_inactive_vector_does_not_contaminate_axes() {
        // The inactive vector overflows its norm but must not contaminate valid axes.
        let vectors = [[2.0, 0.0], [1e308, 1e308], [0.0, 4.0]];
        let refs: Vec<&[f64]> = vectors.iter().map(|v| v.as_slice()).collect();
        let candidates = [
            AgsCandidate { id: 1, prior: 1.0 },
            AgsCandidate { id: 2, prior: 0.0 },
            AgsCandidate { id: 3, prior: 1.0 },
        ];
        let selected = anchored_gs(AgsTarget::Span, &candidates, &refs, 3, 0.0);
        assert_eq!(selected.picked, vec![(3, 4.0), (1, 2.0)]);
        assert_eq!(selected.basis, vec![vec![0.0, 1.0], vec![1.0, 0.0]]);
    }

    #[test]
    fn direct_reorthogonalization_and_rank_cutoff() {
        for epsilon in [1e-4, 1e-5, 1e-6, 1e-7] {
            let mut vectors = Vec::new();
            for i in 0..12 {
                let mut v = vec![1.0; 256];
                normalize(&mut v);
                v[i] += epsilon;
                normalize(&mut v);
                vectors.push(v);
            }
            let refs: Vec<_> = vectors.iter().map(Vec::as_slice).collect();
            let candidates: Vec<_> = (0..12).map(|id|
                AgsCandidate { id, prior: 1.0 }).collect();
            let trace = anchored_gs(AgsTarget::Span, &candidates, &refs, 12, 0.0);
            assert!(!trace.basis.is_empty());
            if epsilon >= 1e-5 { assert_eq!(trace.basis.len(), 12); }
            if epsilon == 1e-7 { assert_eq!(trace.basis.len(), 1); }
            for (i, a) in trace.basis.iter().enumerate() {
                for (j, b) in trace.basis.iter().enumerate() {
                    assert!((dot(a, b) - if i == j { 1.0 } else { 0.0 }).abs() < 1e-12);
                }
            }
            let mut target = vec![0.0; 256];
            target[0] = 1.0;
            let full = anchored_gs(AgsTarget::Explain(&target), &candidates, &refs, 4, 0.0);
            let local = select_axes(AgsTarget::Explain(&target), &candidates, &refs, 4, 0.0);
            assert_eq!(full.picked, local.picked);
            assert_eq!(full.residual_norm, local.residual_norm);
            assert!(local.basis.is_empty());
            let mut residual = target.clone();
            for axis in &full.basis {
                let coefficient = dot(&target, axis);
                for (r, q) in residual.iter_mut().zip(axis) { *r -= coefficient * q; }
            }
            assert!((full.residual_norm.unwrap() - dot(&residual, &residual).sqrt()).abs() < 1e-12);
        }
    }

    #[test]
    fn reduction_lengths_and_cancellation() {
        for n in [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 37, 38, 39, 1024] {
            let a: Vec<f64> = (0..n).map(|i| (i as f64 * 0.13).sin()).collect();
            let b: Vec<f64> = (0..n).map(|i| (i as f64 * 0.19).cos()).collect();
            for x in dot_four(&a, [&b, &b, &b, &b]) {
                assert_eq!(x.to_bits(), dot(&a, &b).to_bits(), "length {n}");
            }
        }
        let a = [1.0; 8];
        let b = [1e16, 1.0, -1e16, 1.0, -1e16, 0.0, 1e16, 0.0];
        for x in dot_four(&a, [&b, &b, &b, &b]) {
            assert_eq!(x.to_bits(), dot(&a, &b).to_bits());
        }
    }

    #[test]
    fn blocked_projection_preserves_dot_bits_and_tail() {
        let axis: Vec<_> = (0..37).map(|i| (i as f64 * 0.13).sin()).collect();
        let vectors: Vec<Vec<_>> = (0..11).map(|j| (0..37)
            .map(|i| ((i + j) as f64 * 0.19).cos()).collect()).collect();
        let refs: Vec<_> = vectors.iter().map(Vec::as_slice).collect();
        for count in 0..=11 {
            let active: Vec<_> = (0..count).collect();
            let row = project_active(&axis, &refs, &active);
            for &i in &active { assert_eq!(row[i].to_bits(), dot(&axis, refs[i]).to_bits()); }
            assert!(row[count..].iter().all(|v| *v == 0.0));
        }
        let mut cap_blocked = vec![0.0; vectors.len()];
        let mut cap_scalar = vec![0.0; vectors.len()];
        accumulate_captured_energy(&axis, &vectors, &mut cap_blocked);
        for (c, v) in cap_scalar.iter_mut().zip(&vectors) {
            *c += dot(&axis, v).powi(2);
        }
        for (a, b) in cap_blocked.iter().zip(&cap_scalar) {
            assert_eq!(a.to_bits(), b.to_bits());
        }
    }

    #[test]
    fn direct_handles_empty_duplicates_and_invalid_priors() {
        let empty = anchored_gs(AgsTarget::Explain(&[3.0, 4.0]), &[], &[], 4, 0.0);
        assert_eq!(empty.residual_norm, Some(5.0));
        assert!(empty.basis.is_empty());
        let vectors: [&[f64]; 5] = [&[1.0, 0.0], &[1.0, 0.0],
            &[0.0, 1.0], &[0.0, 1.0], &[f64::NAN, 0.0]];
        let candidates: Vec<_> = [1.0, 1.0, f64::INFINITY, 1.0, 1.0]
            .iter().enumerate().map(|(i, prior)| AgsCandidate { id: i as i64, prior: *prior }).collect();
        let trace = anchored_gs(AgsTarget::Span, &candidates, &vectors, 5, 0.0);
        assert_eq!(trace.picked.iter().map(|p| p.0).collect::<Vec<_>>(), vec![0, 3]);
    }

    #[test]
    fn epsilon_and_knee_respect_semantic_prefix() {
        assert_eq!(effective_k(&[0.4, 0.8, 1.0, 1.0], 2, 0.1, 0.005), 3);
        assert_eq!(effective_k(&[0.99, 0.991, 0.992], 3, 0.1, 0.005), 3);
        assert_eq!(effective_k(&[], 8, 0.1, 0.005), 0);
    }

    #[test]
    fn in_memory_workspace_normalizes_bits_norms_and_absence() {
        // 上游 mapped_workspace_preserves_bits_and_releases_file 的内存版对照：
        // normalize 入区、norms 位级 = dot(v,v)、零/错长/NULL 向量缺席、slot 按升序 id 分配。
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch("CREATE TABLE tags(id INTEGER PRIMARY KEY, vector BLOB)")
            .unwrap();
        let ids: Vec<i64> = (1..=8).collect();
        for id in &ids {
            let x = *id as f32 * 0.013;
            let bytes: Vec<u8> = [x.cos(), x.sin(), 0.5]
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect();
            connection
                .execute("INSERT INTO tags VALUES (?1,?2)", params![id, bytes])
                .unwrap();
        }
        connection.execute("UPDATE tags SET vector=zeroblob(12) WHERE id=7", []).unwrap(); // 零向量
        connection.execute("UPDATE tags SET vector=zeroblob(8) WHERE id=8", []).unwrap(); // 错长
        let workspace = UnitVectorWorkspace::build(&connection, &ids, 3).unwrap();
        assert_eq!(workspace.len(), 6); // 1..=6
        assert!(!workspace.contains_key(&7));
        assert!(!workspace.contains_key(&8));
        for id in 1..=6i64 {
            let x = id as f32 * 0.013;
            let mut expected: Vec<f64> = [x.cos(), x.sin(), 0.5]
                .iter()
                .map(|v| *v as f64)
                .collect();
            normalize(&mut expected);
            let slot = workspace.slot(&id).unwrap();
            assert_eq!(slot, (id - 1) as usize, "slot 按升序 id 分配");
            assert_eq!(workspace.norm_by_slot(slot).to_bits(), dot(&expected, &expected).to_bits());
            assert!(workspace.get(&id).unwrap().iter().zip(expected)
                .all(|(a, b)| a.to_bits() == b.to_bits()));
        }
        let empty = UnitVectorWorkspace::build(&connection, &[], 3).unwrap();
        assert!(empty.is_empty());
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
        assert_eq!(first.algorithm_version, "unified_geometry_ags_t4_cached_reorth");
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
        // epaAlgorithm 常量随 9aa1f67 换代（源码 :899 为准，README v4 是文档措辞）。
        assert_eq!(c1["epaAlgorithm"], "ags-global-star-t4-cached-reorth");
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
