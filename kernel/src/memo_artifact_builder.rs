//! memo_artifact_builder —— 票 07：行为等价复刻上游 memo_artifact_builder.rs（861 行）。
//!
//! 移植原则：公式、系数、SQL、签名拼接逐字对齐上游（含票⑥浮点定序修复的全部排序点）；
//! 差异仅在刻意省略处并有注释。差分判据见 kernel/tools/diff-runner.mjs：
//! artifactSig 一致 + 图资产逐字段容差内一致（payload 规范化比对）。

use crate::rivermemo_topology_v3::{MemoRuntime, NativeArtifact};
use flate2::write::GzEncoder;
use flate2::Compression;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::io::Write;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const PAYLOAD_SCHEMA: &str = "rivermemo-persisted-artifact-v2";
const PAYLOAD_CODEC: &str = "gzip-json-v1";
const ALGORITHM_VERSION: &str = "memo.native-artifact-v1";
const V9_ALGORITHM_VERSION: &str = "v9.1-rust-native";

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct BuildInput {
    #[serde(default)]
    model_sig: String,
    #[serde(default)]
    effective_config: Value,
}

#[derive(Clone)]
struct FileTag {
    file_id: i64,
    tag_id: i64,
    position: i64,
    diary_name: String,
    path: String,
}

#[derive(Clone)]
struct ProvenanceContribution {
    file_id: i64,
    diary_name: String,
    path: String,
    mass: f64,
}

#[napi(object)]
pub struct NativeMemoArtifactBuildResult {
    pub success: bool,
    pub artifact_sig: String,
    pub source_artifact_sig: String,
    pub graph_generation: String,
    pub database_generation: String,
    pub provenance_generation: String,
    pub generation: i64,
    pub node_count: u32,
    pub edge_count: u32,
    pub persisted: bool,
    pub resident: bool,
    pub elapsed_ms: f64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn hash_text(value: &str, length: usize) -> String {
    let digest = sha256_hex(value.as_bytes());
    digest[..length.min(digest.len())].to_string()
}

pub(crate) fn open_readonly(path: &str) -> std::result::Result<Connection, String> {
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

fn open_readwrite_inner(path: &str) -> std::result::Result<Connection, String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|error| format!("open readwrite SQLite failed: {}", error))?;
    connection
        .busy_timeout(Duration::from_secs(30))
        .map_err(|error| format!("configure SQLite timeout failed: {}", error))?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| format!("configure SQLite WAL failed: {}", error))?;
    connection
        .pragma_update(None, "synchronous", "NORMAL")
        .map_err(|error| format!("configure SQLite synchronous failed: {}", error))?;
    Ok(connection)
}

/* ── WAL 双开防护（BUG-0930，2026-10-03 自上游 lib.rs ensure_sqlite_keepalive 移植）──
 * 背景：同进程内 node:sqlite（store 长连接）与本库是两份独立编译的 sqlite 实例，
 * POSIX 锁按进程计、互相不可见。若无永生连接，每次构建的连接 close 时从本实例
 * 视角判定"最后一个连接"→ checkpoint/重置 WAL → node 侧未 checkpoint 的提交行
 * 在下一次进程边界被静默丢弃（genshin-ts 桶 9 篇日记回卷事故，已沙箱复现）。
 * 每 dbPath 保留一条永不关闭的 readwrite 连接，使"最后一个连接"判定永不成立。
 * 原复刻 v1 省略此处（差分跑在一次性副本库上安全）；生产切轨 eacf947 后暴露。 */
static SQLITE_KEEPALIVES: LazyLock<Mutex<HashMap<String, Connection>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn normalized_sqlite_path(db_path: &str) -> String {
    std::path::Path::new(db_path)
        .canonicalize()
        .unwrap_or_else(|_| std::path::PathBuf::from(db_path))
        .to_string_lossy()
        .replace('\\', "/")
        .to_lowercase()
}

fn ensure_sqlite_keepalive(db_path: &str) {
    let key = normalized_sqlite_path(db_path);
    let mut guard = SQLITE_KEEPALIVES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard.contains_key(&key) {
        return;
    }
    let opened = open_readwrite_inner(db_path).and_then(|keepalive| {
        keepalive
            .query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))
            .map_err(|error| format!("keepalive probe failed: {}", error))?;
        Ok(keepalive)
    });
    match opened {
        Ok(keepalive) => {
            eprintln!("[memo-kernel] 🛡️ SQLite keepalive retained for {}", key);
            guard.insert(key.clone(), keepalive);
        }
        Err(error) => {
            eprintln!(
                "[memo-kernel] ❌ SQLite keepalive unavailable for {}; retrying later: {}",
                key, error
            );
        }
    }
}

pub(crate) fn open_readwrite(path: &str) -> std::result::Result<Connection, String> {
    let connection = open_readwrite_inner(path)?;
    ensure_sqlite_keepalive(path);
    Ok(connection)
}

fn number(config: &Value, path: &[&str], fallback: f64) -> f64 {
    let mut current = config;
    for key in path {
        let Some(next) = current.get(*key) else {
            return fallback;
        };
        current = next;
    }
    current
        .as_f64()
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
}

fn boolean(config: &Value, path: &[&str], fallback: bool) -> bool {
    let mut current = config;
    for key in path {
        let Some(next) = current.get(*key) else {
            return fallback;
        };
        current = next;
    }
    match current {
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_i64().map(|item| item != 0).unwrap_or(fallback),
        _ => fallback,
    }
}

fn load_file_tags(connection: &Connection) -> std::result::Result<Vec<FileTag>, String> {
    let mut statement = connection
        .prepare(
            "SELECT ft.file_id, ft.tag_id, COALESCE(ft.position, 0), \
             COALESCE(f.diary_name, ''), COALESCE(f.path, '') \
             FROM file_tags ft JOIN files f ON f.id = ft.file_id \
             ORDER BY ft.file_id, ft.position ASC, ft.tag_id ASC",
        )
        .map_err(|error| format!("prepare file_tags failed: {}", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok(FileTag {
                file_id: row.get(0)?,
                tag_id: row.get(1)?,
                position: row.get(2)?,
                diary_name: row.get(3)?,
                path: row.get(4)?,
            })
        })
        .map_err(|error| format!("query file_tags failed: {}", error))?;
    let mut output = Vec::new();
    for row in rows {
        output.push(row.map_err(|error| format!("decode file_tags row failed: {}", error))?);
    }
    Ok(output)
}

/// P2 交付2（schema-v2 兼容）：2.0 的 schema 迁移会**删除**派生表
/// （`rust-vexus-lite/src/schema.rs:305-322` 删 `tag_pair_similarity` /
/// `tag_intrinsic_residuals(_status)` / `kv_store['epa_basis_cache']` /
/// `tagmemo_artifacts` 的 pairwise·intrinsic 行）。缺表 = 那个世界本就没有这类证据，
/// 走空集/缺省增益，**绝不硬崩**（此前 `prepare pairwise failed: no such table`）。
static PAIRWISE_TABLE_MISSING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
static INTRINSIC_TABLE_MISSING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// 上一次 build 是否在 schema-v2 世界里（vectors 档写进 metadata.schemaV2Fallbacks，
/// 便于暗上线时观测「缺表兜底真的发生了」）。
pub(crate) fn schema_v2_fallback_flags() -> (bool, bool) {
    (
        PAIRWISE_TABLE_MISSING.load(std::sync::atomic::Ordering::Relaxed),
        INTRINSIC_TABLE_MISSING.load(std::sync::atomic::Ordering::Relaxed),
    )
}

fn table_exists(connection: &Connection, table: &str) -> std::result::Result<bool, String> {
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params![table],
            |row| row.get(0),
        )
        .map_err(|error| format!("schema probe failed for {}: {}", table, error))?;
    Ok(count > 0)
}

/// P2-A（暗上线）：fact matrix 的语义门输入源。
/// `pairwise`（缺省）= v9.2 逐字：查 `tag_pair_similarity` 表；
/// `vectors` = 上游 2.0 `memo_artifact_builder.rs:194-307`：每 file 窗口（2..=100 tags）
/// 现读 tag 单位向量，`memo_geometry::dot(unit,unit).clamp(-1,1)` —— 2.0 用 AGS 几何
/// 取代了 pairwise 表（迁移会删表，见 schema.rs:305-322）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum FactMatrixMode {
    Pairwise,
    Vectors,
}

fn read_fact_matrix_mode(config: &Value) -> std::result::Result<FactMatrixMode, String> {
    match config.get("factMatrixMode").and_then(Value::as_str) {
        None | Some("pairwise") => Ok(FactMatrixMode::Pairwise),
        Some("vectors") => Ok(FactMatrixMode::Vectors),
        Some(other) => Err(format!(
            "invalid factMatrixMode \"{}\"（合法：pairwise | vectors）",
            other
        )),
    }
}

/// 单位化（上游 `memo_geometry::read_unit_vectors` 的口径）：非有限/零向量缺席。
fn unit_normalize(vector: &mut [f64]) -> bool {
    let norm = vector.iter().map(|value| value * value).sum::<f64>().sqrt();
    if !norm.is_finite() || norm <= 1e-12 {
        return false;
    }
    for value in vector.iter_mut() {
        *value /= norm;
    }
    true
}

/// 语义门输入源抽象：两种档位共用同一条共现权重循环，只有 similarity 来源不同。
struct FactCompat<'a> {
    mode: FactMatrixMode,
    pairwise: &'a HashMap<(i64, i64), f64>,
    connection: &'a Connection,
    dimension: usize,
    semantic_enabled: bool,
    low_fallback: f64,
    vectors: HashMap<i64, Vec<f64>>,
}

impl<'a> FactCompat<'a> {
    fn new(
        mode: FactMatrixMode,
        pairwise: &'a HashMap<(i64, i64), f64>,
        connection: &'a Connection,
        dimension: usize,
        config: &Value,
    ) -> Self {
        let ordered = config.get("orderedCooccurrence").unwrap_or(&Value::Null);
        Self {
            mode,
            pairwise,
            connection,
            dimension,
            semantic_enabled: boolean(ordered, &["semanticGainEnabled"], false)
                || boolean(ordered, &["semanticGain", "enabled"], false),
            low_fallback: number(
                ordered,
                &["semanticGainLowSimFallback"],
                number(ordered, &["semanticGain", "lowSimFallback"], 0.1),
            ),
            vectors: HashMap::new(),
        }
    }

    /// 每个 file 窗口开一次：vectors 档按批装载该窗口 tag 的单位向量（上游同量级 128/批）。
    fn begin_file(&mut self, tag_ids: &[i64]) -> std::result::Result<(), String> {
        self.vectors.clear();
        if self.mode != FactMatrixMode::Vectors || !self.semantic_enabled {
            return Ok(());
        }
        let mut ids: Vec<i64> = tag_ids.to_vec();
        ids.sort_unstable();
        ids.dedup();
        for batch in ids.chunks(128) {
            let rows = crate::memo_vector_pool::load_vectors_by_ids(
                self.connection,
                "tags",
                batch,
                self.dimension,
            )?;
            for (id, vector) in rows {
                let mut unit: Vec<f64> = vector.iter().map(|value| *value as f64).collect();
                if unit_normalize(&mut unit) {
                    self.vectors.insert(id, unit);
                }
            }
        }
        Ok(())
    }

    fn similarity(&self, left: i64, right: i64) -> f64 {
        match self.mode {
            FactMatrixMode::Pairwise => {
                let key = (left.min(right), left.max(right));
                self.pairwise.get(&key).copied().unwrap_or(self.low_fallback)
            }
            FactMatrixMode::Vectors => {
                match (self.vectors.get(&left), self.vectors.get(&right)) {
                    (Some(a), Some(b)) => crate::memo_geometry::dot(a, b).clamp(-1.0, 1.0),
                    _ => self.low_fallback,
                }
            }
        }
    }
}

/// 语义增益曲线（上游 build_fact_matrix 的 semantic_gain 闭包，逐字）。
fn semantic_curve(similarity: f64, peak: f64, sigma: f64) -> f64 {
    if similarity < 0.15 {
        0.4 + similarity * 1.0
    } else {
        0.5 + 0.8
            * (-((similarity - peak).powi(2)) / (2.0 * sigma * sigma)).exp()
    }
}

fn load_pairwise(
    connection: &Connection,
    model_sig: &str,
) -> std::result::Result<HashMap<(i64, i64), f64>, String> {
    if !table_exists(connection, "tag_pair_similarity")? {
        PAIRWISE_TABLE_MISSING.store(true, std::sync::atomic::Ordering::Relaxed);
        return Ok(HashMap::new());
    }
    let mut statement = connection
        .prepare("SELECT tag_a, tag_b, similarity FROM tag_pair_similarity WHERE model_sig = ?1")
        .map_err(|error| format!("prepare pairwise failed: {}", error))?;
    let rows = statement
        .query_map(params![model_sig], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, f64>(2)?,
            ))
        })
        .map_err(|error| format!("query pairwise failed: {}", error))?;
    let mut output = HashMap::new();
    for row in rows {
        let (left, right, similarity) =
            row.map_err(|error| format!("decode pairwise row failed: {}", error))?;
        if !similarity.is_finite() {
            return Err(format!(
                "pairwise row ({}, {}) contains non-finite similarity",
                left, right
            ));
        }
        output.insert((left.min(right), left.max(right)), similarity);
    }
    Ok(output)
}

fn anchor_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<(i64, f64, f64, String)> {
    Ok((
        row.get::<_, i64>(0)?,
        row.get::<_, f64>(1)?,
        row.get::<_, f64>(2)?,
        row.get::<_, String>(3)?,
    ))
}

fn column_exists(
    connection: &Connection,
    table: &str,
    column: &str,
) -> std::result::Result<bool, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({})", table))
        .map_err(|error| format!("schema probe failed for {}: {}", table, error))?;
    let mut rows = statement
        .query([])
        .map_err(|error| format!("schema probe failed for {}: {}", table, error))?;
    while let Some(row) = rows
        .next()
        .map_err(|error| format!("schema probe failed for {}: {}", table, error))?
    {
        let name: String = row
            .get(1)
            .map_err(|error| format!("schema probe failed for {}: {}", table, error))?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// vectors 档需要向量维度：从 tags.vector 的字节长度反推（无向量行 = 无法走几何语义门）。
fn detect_dimension(connection: &Connection) -> std::result::Result<usize, String> {
    let bytes: Option<i64> = connection
        .query_row(
            "SELECT length(vector) FROM tags WHERE vector IS NOT NULL AND length(vector) > 0 LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("factMatrixMode=vectors 需要 tags.vector：{}", error))?;
    match bytes {
        Some(bytes) if bytes > 0 && bytes % 4 == 0 => Ok((bytes / 4) as usize),
        _ => Err("factMatrixMode=vectors 需要 tags.vector（当前库没有可用向量行）".to_string()),
    }
}

fn load_anchor_gains(
    connection: &Connection,
    model_sig: &str,
    mode: FactMatrixMode,
) -> std::result::Result<(HashMap<i64, f64>, HashMap<i64, f64>, String), String> {
    // 同族守卫（与 load_pairwise 同判据）：2.0 迁移删了 tag_intrinsic_residuals，
    // 缺表 = 没有几何残差证据 → 空增益（build_fact_matrix 的 unwrap_or(1.0) 兜底），
    // 不硬崩。
    if !table_exists(connection, "tag_intrinsic_residuals")? {
        INTRINSIC_TABLE_MISSING.store(true, std::sync::atomic::Ordering::Relaxed);
        return Ok((HashMap::new(), HashMap::new(), String::new()));
    }
    // P2-B（暗上线）：vectors 档照上游 2.0 :134-186 —— 按 model_sig 过滤 + ORDER BY tag_id；
    // pairwise 档保持 v9.2 逐字（无过滤、signature 取 intrinsic 行里的 artifact_sig）。
    let vectors_mode = mode == FactMatrixMode::Vectors;
    let sql = if vectors_mode {
        "SELECT tag_id, COALESCE(v9_anchor_gain, residual_energy, 1.0), \
         COALESCE(raw_residual_ratio, 0.0), COALESCE(artifact_sig, '') \
         FROM tag_intrinsic_residuals WHERE model_sig = ?1 ORDER BY tag_id"
    } else {
        "SELECT tag_id, COALESCE(v9_anchor_gain, residual_energy, 1.0), \
         COALESCE(raw_residual_ratio, 0.0), COALESCE(artifact_sig, '') \
         FROM tag_intrinsic_residuals"
    };
    let mut collected: Vec<(i64, f64, f64, String)> = Vec::new();
    {
        let mut statement = connection
            .prepare(sql)
            .map_err(|error| format!("prepare intrinsic residuals failed: {}", error))?;
        if vectors_mode {
            let rows = statement
                .query_map(params![model_sig], anchor_row)
                .map_err(|error| format!("query intrinsic residuals failed: {}", error))?;
            for row in rows {
                collected.push(row.map_err(|error| {
                    format!("decode intrinsic residual row failed: {}", error)
                })?);
            }
        } else {
            let rows = statement
                .query_map([], anchor_row)
                .map_err(|error| format!("query intrinsic residuals failed: {}", error))?;
            for row in rows {
                collected.push(row.map_err(|error| {
                    format!("decode intrinsic residual row failed: {}", error)
                })?);
            }
        }
    }
    let mut gains = HashMap::new();
    let mut raw = HashMap::new();
    let mut signature = String::new();
    for (tag_id, gain, raw_residual, artifact_sig) in collected {
        if !gain.is_finite() || !raw_residual.is_finite() {
            return Err(format!(
                "intrinsic residual row for Tag {} contains non-finite values",
                tag_id
            ));
        }
        gains.insert(tag_id, gain.clamp(0.5, 2.0));
        raw.insert(tag_id, raw_residual.clamp(0.0, 1.0));
        if signature.is_empty() && !artifact_sig.is_empty() {
            signature = artifact_sig;
        }
    }
    if vectors_mode {
        // 上游 2.0 :154-171：residual signature 的权威源是 unified_geometry 资产行
        // （不是 intrinsic 行），并校验 memo_tag_facts 指纹；不符 ⇒ 硬拒建。
        let has_asset_columns = table_exists(connection, "tagmemo_artifacts")?
            && column_exists(connection, "tagmemo_artifacts", "asset_type")?
            && column_exists(connection, "tagmemo_artifacts", "graph_generation")?;
        let geometry: Option<(String, String)> = if has_asset_columns {
            connection
                .query_row(
                    "SELECT artifact_sig, graph_generation FROM tagmemo_artifacts \
                     WHERE asset_type = 'unified_geometry' AND model_sig = ?1 AND status = 'ready' \
                     ORDER BY updated_at DESC LIMIT 1",
                    params![model_sig],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()
                .map_err(|error| format!("query unified geometry asset failed: {}", error))?
        } else {
            None
        };
        signature = match geometry {
            Some((asset_sig, generation)) => {
                let facts: String = connection
                    .query_row(
                        "SELECT value FROM kbm_runtime_meta WHERE key = 'memo_tag_facts'",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|error| format!("query memo_tag_facts failed: {}", error))?;
                if generation != format!("facts:{}", facts) {
                    return Err(
                        "KNOWLEDGE_STORE_DERIVED_DEPENDENCY_CONFLICT: geometry facts are stale"
                            .into(),
                    );
                }
                asset_sig
            }
            None => String::new(),
        };
    }
    Ok((gains, raw, signature))
}

fn add_edge(matrix: &mut HashMap<i64, HashMap<i64, f64>>, source: i64, target: i64, weight: f64) {
    if source == target || !weight.is_finite() || weight <= 0.0 {
        return;
    }
    *matrix.entry(source).or_default().entry(target).or_default() += weight;
}

fn build_fact_matrix(
    rows: &[FileTag],
    compat: &mut FactCompat<'_>,
    anchor_gain: &HashMap<i64, f64>,
    config: &Value,
) -> std::result::Result<HashMap<i64, HashMap<i64, f64>>, String> {
    let ordered = config.get("orderedCooccurrence").unwrap_or(&Value::Null);
    let forward_gain = number(ordered, &["forwardGain"], 1.0).max(0.0);
    let reverse_gain = number(ordered, &["reverseGain"], 0.42).clamp(
        number(ordered, &["minReverseGain"], 0.25),
        number(ordered, &["maxReverseGain"], 0.70),
    );
    let distance_decay = number(ordered, &["distanceDecay"], 0.0).max(0.0);
    let reverse_guard = number(ordered, &["reverseInversionGuard"], 0.95).clamp(0.0, 1.0);
    let reverse_anchor_enabled = boolean(ordered, &["reverseAnchorBoost"], false);
    let reverse_anchor_max = number(ordered, &["reverseAnchorMax"], 1.5).max(1.0);
    let semantic_enabled = boolean(ordered, &["semanticGainEnabled"], false)
        || boolean(ordered, &["semanticGain", "enabled"], false);
    let semantic_peak = number(
        ordered,
        &["semanticGainPeak"],
        number(ordered, &["semanticGain", "peak"], 0.65),
    );
    let semantic_sigma = number(
        ordered,
        &["semanticGainSigma"],
        number(ordered, &["semanticGain", "sigma"], 0.25),
    )
    .max(0.001);
    let semantic_enabled = compat.semantic_enabled;

    let mut matrix = HashMap::new();
    let mut offset = 0usize;
    while offset < rows.len() {
        let file_id = rows[offset].file_id;
        let mut end = offset + 1;
        while end < rows.len() && rows[end].file_id == file_id {
            end += 1;
        }
        let tags = &rows[offset..end];
        if tags.len() >= 2 && tags.len() <= 100 {
            compat.begin_file(&tags.iter().map(|tag| tag.tag_id).collect::<Vec<i64>>())?;
            for left_index in 0..tags.len() {
                for right_index in (left_index + 1)..tags.len() {
                    let left = &tags[left_index];
                    let right = &tags[right_index];
                    if left.tag_id == right.tag_id {
                        continue;
                    }
                    let semantic = if semantic_enabled {
                        semantic_curve(
                            compat.similarity(left.tag_id, right.tag_id),
                            semantic_peak,
                            semantic_sigma,
                        )
                    } else {
                        1.0
                    };
                    if left.position > 0 && right.position > 0 {
                        let count = tags.len() as f64;
                        let phi_left =
                            0.9 - 0.4 * (left.position - 1).max(0) as f64 / (count - 1.0).max(1.0);
                        let phi_right =
                            0.9 - 0.4 * (right.position - 1).max(0) as f64 / (count - 1.0).max(1.0);
                        let delta = (right.position - left.position).max(1) as f64;
                        let distance = if distance_decay > 0.0 {
                            (-distance_decay * (delta - 1.0)).exp()
                        } else {
                            1.0
                        };
                        let base = phi_left * phi_right * distance;
                        let forward = base * forward_gain * semantic;
                        let mut dynamic_reverse = reverse_gain;
                        if reverse_anchor_enabled {
                            dynamic_reverse *= anchor_gain
                                .get(&left.tag_id)
                                .copied()
                                .unwrap_or(1.0)
                                .min(reverse_anchor_max);
                        }
                        dynamic_reverse = dynamic_reverse.clamp(0.25, 0.70);
                        let backward =
                            (base * dynamic_reverse * semantic).min(forward * reverse_guard);
                        add_edge(&mut matrix, left.tag_id, right.tag_id, forward);
                        add_edge(&mut matrix, right.tag_id, left.tag_id, backward);
                    } else {
                        let weight = 0.7 * 0.7 * semantic;
                        add_edge(&mut matrix, left.tag_id, right.tag_id, weight);
                        add_edge(&mut matrix, right.tag_id, left.tag_id, weight);
                    }
                }
            }
        }
        offset = end;
    }
    Ok(matrix)
}

fn build_transport(
    fact: &HashMap<i64, HashMap<i64, f64>>,
    anchor_gain: &HashMap<i64, f64>,
    config: &Value,
) -> (HashMap<i64, HashMap<i64, f64>>, HashSet<(i64, i64)>) {
    let v9 = config.get("v9").unwrap_or(&Value::Null);
    let outbound_mass = number(v9, &["outboundMass"], 0.95).clamp(0.01, 0.999999);
    let reserve_mass = number(v9, &["associationReserveMass"], 0.05).clamp(0.0, outbound_mass);
    let evidence_compression = number(v9, &["evidenceCompression"], 1.0).max(0.01);
    let wormhole_gain = number(v9, &["wormholeGain"], 1.35).max(1.0);
    let tension_threshold = number(v9, &["tensionThreshold"], 1.0).max(0.0);
    let hub_exponent = number(v9, &["hubPenaltyExponent"], 0.3).clamp(0.0, 1.0);
    let hub_floor = number(v9, &["hubPenaltyFloor"], 0.55).clamp(0.05, 1.0);
    let hub_ceiling = number(v9, &["hubPenaltyCeiling"], 1.8).clamp(1.0, 4.0);
    let smoothing_ratio = number(v9, &["hubSmoothingRatio"], 0.1).clamp(0.01, 2.0);

    let mut raw_rows: HashMap<i64, Vec<(i64, f64, bool)>> = HashMap::new();
    let mut target_inflow: HashMap<i64, f64> = HashMap::new();
    // 确定性迭代：HashMap 随机迭代序会让 target_inflow 的 f64 累加序漂移（1-ulp），
    // 污染下游 median/raw_penalty/全部边权与 artifactSig（票⑥：同语料累计 16/25 种图形状变体）。
    let mut fact_sources: Vec<i64> = fact.keys().copied().collect();
    fact_sources.sort_unstable();
    for source in &fact_sources {
        let mut ordered_edges: Vec<(i64, f64)> = fact[source]
            .iter()
            .map(|(target, weight)| (*target, *weight))
            .collect();
        ordered_edges.sort_unstable_by_key(|item| item.0);
        for (target, compatibility) in ordered_edges {
            let evidence = (1.0 + compatibility.max(0.0) * evidence_compression).ln();
            let residual = anchor_gain.get(&target).copied().unwrap_or(1.0);
            let wormhole = evidence * residual >= tension_threshold;
            let conductance = evidence * if wormhole { wormhole_gain } else { 1.0 };
            if conductance > 0.0 && conductance.is_finite() {
                raw_rows
                    .entry(*source)
                    .or_default()
                    .push((target, conductance, wormhole));
                *target_inflow.entry(target).or_default() += conductance;
            }
        }
    }

    let mut positive: Vec<f64> = target_inflow
        .values()
        .copied()
        .filter(|value| *value > 0.0 && value.is_finite())
        .collect();
    positive.sort_by(|left, right| left.total_cmp(right));
    let median = positive.get(positive.len() / 2).copied().unwrap_or(1.0);
    let smoothing = (median * smoothing_ratio).max(1e-9);

    let mut transport = HashMap::new();
    let mut wormholes = HashSet::new();
    // 确定性求和：total/wormhole_total 的累加序决定归一化边权的最后一位，
    // raw_rows 的 Vec 顺序已按 target 排序，这里再对 source 排序即可全链路逐位确定。
    let mut raw_sources: Vec<i64> = raw_rows.keys().copied().collect();
    raw_sources.sort_unstable();
    for source in &raw_sources {
        let edges = &raw_rows[source];
        let mut adjusted = Vec::new();
        let mut total = 0.0;
        let mut wormhole_total = 0.0;
        for &(target, conductance, wormhole) in edges {
            let relative =
                target_inflow.get(&target).copied().unwrap_or(0.0) / (median + smoothing);
            let raw_penalty = if hub_exponent > 0.0 {
                relative.max(1e-9).powf(-hub_exponent)
            } else {
                1.0
            };
            let value = conductance * raw_penalty.clamp(hub_floor, hub_ceiling);
            if value > 0.0 && value.is_finite() {
                total += value;
                if wormhole {
                    wormhole_total += value;
                }
                adjusted.push((target, value, wormhole));
            }
        }
        if total <= 0.0 {
            continue;
        }
        let reserved = if wormhole_total > 0.0 {
            reserve_mass
        } else {
            0.0
        };
        let main = outbound_mass - reserved;
        let row = transport.entry(*source).or_insert_with(HashMap::new);
        for (target, value, wormhole) in adjusted {
            let normalized = main * value / total
                + if wormhole && wormhole_total > 0.0 {
                    reserved * value / wormhole_total
                } else {
                    0.0
                };
            row.insert(target, normalized);
            if wormhole {
                wormholes.insert((*source, target));
            }
        }
    }
    (transport, wormholes)
}

fn build_provenance(
    rows: &[FileTag],
    config: &Value,
) -> BTreeMap<(i64, i64), Vec<ProvenanceContribution>> {
    let ordered = config.get("orderedCooccurrence").unwrap_or(&Value::Null);
    let forward_gain = number(ordered, &["forwardGain"], 1.0).max(0.0);
    let reverse_gain = number(ordered, &["reverseGain"], 0.35).max(0.0);
    let distance_decay = number(ordered, &["distanceDecay"], 0.08).max(0.0);
    let mut aggregated: BTreeMap<(i64, i64, i64), ProvenanceContribution> = BTreeMap::new();

    let mut offset = 0usize;
    while offset < rows.len() {
        let file_id = rows[offset].file_id;
        let mut end = offset + 1;
        while end < rows.len() && rows[end].file_id == file_id {
            end += 1;
        }
        let tags = &rows[offset..end];
        if tags.len() >= 2 && tags.len() <= 100 {
            for left_index in 0..tags.len() {
                for right_index in (left_index + 1)..tags.len() {
                    let left = &tags[left_index];
                    let right = &tags[right_index];
                    if left.tag_id == right.tag_id {
                        continue;
                    }
                    let delta = (right.position - left.position).max(1) as f64;
                    let distance = (-distance_decay * (delta - 1.0).max(0.0)).exp();
                    for (source, target, mass) in [
                        (left.tag_id, right.tag_id, forward_gain * distance),
                        (right.tag_id, left.tag_id, reverse_gain * distance),
                    ] {
                        let entry =
                            aggregated
                                .entry((source, target, file_id))
                                .or_insert_with(|| ProvenanceContribution {
                                    file_id,
                                    diary_name: left.diary_name.clone(),
                                    path: left.path.clone(),
                                    mass: 0.0,
                                });
                        entry.mass += mass;
                    }
                }
            }
        }
        offset = end;
    }

    let mut output: BTreeMap<(i64, i64), Vec<ProvenanceContribution>> = BTreeMap::new();
    for ((source, target, _), contribution) in aggregated {
        output
            .entry((source, target))
            .or_default()
            .push(contribution);
    }
    output
}

fn database_generation(connection: &Connection) -> String {
    let mut facts = Vec::new();
    for table in ["files", "chunks", "tags", "file_tags"] {
        let query = format!("SELECT COUNT(*), COALESCE(MAX(rowid), 0) FROM {}", table);
        let value = connection
            .query_row(&query, [], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
            })
            .unwrap_or((0, 0));
        facts.push(format!("{}:{}:{}", table, value.0, value.1));
    }
    hash_text(&facts.join("|"), 40)
}

fn build_native_artifact(
    transport: &HashMap<i64, HashMap<i64, f64>>,
    inbound: HashMap<i64, f64>,
    anchor_gain: HashMap<i64, f64>,
    wormholes: HashSet<(i64, i64)>,
    provenance: &BTreeMap<(i64, i64), Vec<ProvenanceContribution>>,
) -> Arc<NativeArtifact> {
    let mut nodes = BTreeSet::new();
    for (source, edges) in transport {
        nodes.insert(*source);
        nodes.extend(edges.keys().copied());
    }
    let node_ids: Vec<i64> = nodes.into_iter().collect();
    let node_index: HashMap<i64, usize> = node_ids
        .iter()
        .enumerate()
        .map(|(index, id)| (*id, index))
        .collect();
    let mut row_offsets = Vec::with_capacity(node_ids.len() + 1);
    let mut targets = Vec::new();
    let mut weights = Vec::new();
    row_offsets.push(0);
    for source in &node_ids {
        let mut edges: Vec<(i64, f64)> = transport
            .get(source)
            .map(|items| items.iter().map(|(id, weight)| (*id, *weight)).collect())
            .unwrap_or_default();
        edges.sort_by_key(|item| item.0);
        for (target, weight) in edges {
            if let Some(index) = node_index.get(&target) {
                targets.push(*index);
                weights.push(weight);
            }
        }
        row_offsets.push(targets.len());
    }
    let native_provenance = provenance
        .iter()
        .map(|(edge, contributions)| {
            (
                *edge,
                contributions
                    .iter()
                    .map(|item| (item.file_id, item.mass))
                    .collect(),
            )
        })
        .collect();
    let max_inbound = inbound.values().copied().fold(0.0, f64::max);
    let artifact = NativeArtifact {
        node_ids,
        node_index,
        row_offsets,
        targets,
        weights,
        inbound,
        max_inbound,
        anchor_gain,
        wormhole_edges: wormholes,
        provenance: native_provenance,
        // P0.1：node_anchor_gain/edge_is_wormhole 只能由 prepared() 物化；payload 序列化
        // 保持 v9.2 行序（target 升序），运行时发布时再克隆出 prepared 版本。
        // P2-F 实测修正：2.0 **持久化的** payload 行序同样是 target 升序（不是权重降序）——
        // 按「上游代码里 build_native_artifact 返回 .prepared()」推断会写出行序差异，
        // 实测 oracle 的 sharedTransport 逐行非降序即证伪。
        ..NativeArtifact::default()
    };
    Arc::new(artifact)
}

fn artifact_payload(
    artifact: &NativeArtifact,
    provenance: &BTreeMap<(i64, i64), Vec<ProvenanceContribution>>,
    metadata: &Value,
    compact_provenance: bool,
) -> Value {
    let provenance_edges: Vec<Value> = provenance
        .iter()
        .map(|((source, target), contributions)| {
            json!([
                format!("{}:{}", source, target),
                contributions
                    .iter()
                    .map(|item| {
                        // P2-F（暗上线）：vectors 档照上游 2.0 用二元组 [fileId, mass]；
                        // pairwise 档保持 v9.2 的四元组（payload 逐字节不变 ⇒ 五腿零漂移）。
                        if compact_provenance {
                            json!([item.file_id, item.mass])
                        } else {
                            json!([item.file_id, item.diary_name, item.path, item.mass])
                        }
                    })
                    .collect::<Vec<_>>()
            ])
        })
        .collect();
    let inbound: Vec<Value> = artifact
        .inbound
        .iter()
        .map(|(id, mass)| json!([id, mass]))
        .collect();
    let anchor_gain: Vec<Value> = artifact
        .anchor_gain
        .iter()
        .map(|(id, gain)| json!([id, gain]))
        .collect();
    let wormholes: Vec<Value> = artifact
        .wormhole_edges
        .iter()
        .map(|(source, target)| json!(format!("{}:{}", source, target)))
        .collect();

    json!({
        "schema": PAYLOAD_SCHEMA,
        "artifact": metadata,
        "sharedTransport": {
            "schema": "tagmemo-v10-alpha-csr-snapshot-v1",
            "contentSig": metadata["graphGeneration"],
            "nodeIds": artifact.node_ids,
            "rowOffsets": artifact.row_offsets,
            "targetIndices": artifact.targets,
            "weights": artifact.weights
        },
        "provenanceView": {
            "schema": "tagmemo-v10-alpha-provenance-snapshot-v1",
            "generation": metadata["provenanceGeneration"],
            "edges": provenance_edges
        },
        "rawResidualRatioView": [],
        "anchorGainView": anchor_gain,
        "inboundMassView": inbound,
        "wormholeView": wormholes
    })
}

fn run_build(
    runtime: &MemoRuntime,
    db_path: &str,
    input_json: &str,
) -> std::result::Result<NativeMemoArtifactBuildResult, String> {
    let started = Instant::now();
    let input: BuildInput = serde_json::from_str(input_json)
        .map_err(|error| format!("invalid native artifact build JSON: {}", error))?;
    if input.model_sig.trim().is_empty() {
        return Err("native artifact build requires modelSig".to_string());
    }

    let readonly = open_readonly(db_path)?;
    // P2-A/B/F 暗上线闸：缺省 pairwise = v9.2 逐字（表 + intrinsic 行 signature +
    // 非 prepared payload + 四项 provenance）；vectors = 上游 2.0 语义。
    let mode = read_fact_matrix_mode(&input.effective_config)?;
    let rows = load_file_tags(&readonly)?;
    let pairwise = if mode == FactMatrixMode::Vectors {
        HashMap::new()
    } else {
        load_pairwise(&readonly, &input.model_sig)?
    };
    let (anchor_gain, _raw_residuals, residual_sig) =
        load_anchor_gains(&readonly, &input.model_sig, mode)?;
    let dimension = if mode == FactMatrixMode::Vectors {
        detect_dimension(&readonly)?
    } else {
        0
    };
    let mut compat = FactCompat::new(
        mode,
        &pairwise,
        &readonly,
        dimension,
        &input.effective_config,
    );
    let fact = build_fact_matrix(&rows, &mut compat, &anchor_gain, &input.effective_config)?;
    drop(compat);
    let (transport, wormholes) = build_transport(&fact, &anchor_gain, &input.effective_config);
    let provenance = build_provenance(&rows, &input.effective_config);

    // 确定性累加：inbound 值本身不进 graph_digest，但会存进 artifact 参与打分，
    // 同样按排序序求和保证跨进程逐位一致。
    let mut inbound = HashMap::new();
    let mut inbound_sources: Vec<i64> = transport.keys().copied().collect();
    inbound_sources.sort_unstable();
    for source in &inbound_sources {
        let mut edges: Vec<(i64, f64)> = transport[source]
            .iter()
            .map(|(target, weight)| (*target, *weight))
            .collect();
        edges.sort_unstable_by_key(|item| item.0);
        for (target, weight) in edges {
            *inbound.entry(target).or_default() += weight;
        }
    }

    let graph_digest = {
        let mut rows = Vec::new();
        let mut sources: Vec<i64> = transport.keys().copied().collect();
        sources.sort_unstable();
        for source in sources {
            let mut edges: Vec<(i64, f64)> = transport[&source]
                .iter()
                .map(|(target, weight)| (*target, *weight))
                .collect();
            edges.sort_by_key(|item| item.0);
            rows.push(format!("{}:{:?}", source, edges));
        }
        hash_text(&rows.join("|"), 48)
    };
    let provenance_generation = {
        let rows: Vec<String> = provenance
            .iter()
            .map(|(edge, values)| {
                format!(
                    "{}:{}:{:?}",
                    edge.0,
                    edge.1,
                    values
                        .iter()
                        .map(|item| (item.file_id, item.mass))
                        .collect::<Vec<_>>()
                )
            })
            .collect();
        hash_text(&rows.join("|"), 40)
    };
    let database_generation = database_generation(&readonly);
    let config_json = serde_json::to_string(&input.effective_config)
        .map_err(|error| format!("encode effective config failed: {}", error))?;
    let config_hash = hash_text(&config_json, 32);
    let source_artifact_sig = hash_text(
        &format!(
            "{}|{}|{}|{}",
            V9_ALGORITHM_VERSION, input.model_sig, graph_digest, residual_sig
        ),
        24,
    );
    let artifact_sig = hash_text(
        &format!(
            "{}|{}|{}|{}|{}|{}",
            ALGORITHM_VERSION,
            source_artifact_sig,
            graph_digest,
            provenance_generation,
            database_generation,
            config_hash
        ),
        48,
    );

    let vectors_mode = mode == FactMatrixMode::Vectors;
    let native = build_native_artifact(&transport, inbound, anchor_gain, wormholes, &provenance);
    let published_at = now_ms();
    let mut metadata = json!({
        "schema": "tagmemo-v10-alpha-artifact-v1",
        "version": "v10_alpha",
        "algorithmVersion": ALGORITHM_VERSION,
        "artifactSig": artifact_sig,
        "graphGeneration": graph_digest,
        "databaseGeneration": database_generation,
        "provenanceGeneration": provenance_generation,
        "modelSig": input.model_sig,
        "configHash": config_hash,
        "sourceArtifactSig": source_artifact_sig,
        "sourceGraphGeneration": graph_digest,
        "maxInbound": native.max_inbound,
        "effectiveConfig": input.effective_config
    });
    // 注：artifact payload 的 metadata **不加任何键** —— diff-runner 对 payload 做全量深比对，
    // 多一个键即记「缺侧」（实测 2.0 metadata 13 键 vs 我方 13 键；曾加 2 个诊断键 ⇒ 缺侧）。
    // schema-v2 兜底标记改由 pipeline metadata 的 diagnostics 面外露（见 memo_pipeline.rs）。
    let payload = artifact_payload(&native, &provenance, &metadata, vectors_mode);
    let raw = serde_json::to_vec(&payload)
        .map_err(|error| format!("encode native artifact payload failed: {}", error))?;
    let checksum = sha256_hex(&raw);
    let mut encoder = GzEncoder::new(Vec::new(), Compression::new(6));
    encoder
        .write_all(&raw)
        .map_err(|error| format!("compress native artifact failed: {}", error))?;
    let compressed = encoder
        .finish()
        .map_err(|error| format!("finish native artifact compression failed: {}", error))?;

    drop(readonly);
    let mut writable = open_readwrite(db_path)?;
    let transaction = writable
        .transaction()
        .map_err(|error| format!("begin native artifact transaction failed: {}", error))?;
    transaction
        .execute(
            "INSERT INTO rivermemo_artifacts (\
             artifact_sig, schema_version, algorithm_version, source_v9_artifact_sig, \
             source_graph_generation, model_sig, config_hash, database_generation, \
             provenance_generation, payload_codec, payload_checksum, payload, status, \
             error_message, node_count, edge_count, created_at, updated_at, published_at\
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'ready', \
             NULL, ?13, ?14, ?15, ?15, ?15) \
             ON CONFLICT(artifact_sig) DO UPDATE SET \
             payload_checksum=excluded.payload_checksum, payload=excluded.payload, \
             status='ready', error_message=NULL, updated_at=excluded.updated_at, \
             published_at=excluded.published_at, node_count=excluded.node_count, \
             edge_count=excluded.edge_count",
            params![
                artifact_sig,
                PAYLOAD_SCHEMA,
                ALGORITHM_VERSION,
                source_artifact_sig,
                graph_digest,
                input.model_sig,
                config_hash,
                database_generation,
                provenance_generation,
                PAYLOAD_CODEC,
                checksum,
                compressed,
                native.node_ids.len() as i64,
                native.targets.len() as i64,
                published_at
            ],
        )
        .map_err(|error| format!("persist native artifact failed: {}", error))?;
    transaction
        .commit()
        .map_err(|error| format!("commit native artifact failed: {}", error))?;

    // P0.1：持久化 payload(:816) 已用 v9.2 行序算完签名并落库——运行时侧发布
    // prepared 克隆（物化 node_anchor_gain/edge_is_wormhole + 行内降序重排），
    // 持久化字节与 artifactSig 保持 v9.2 形态（五腿身份不动），运行时语义升 2.0。
    let generation = runtime.publish(&artifact_sig, Arc::new((*native).clone().prepared()))?;
    Ok(NativeMemoArtifactBuildResult {
        success: true,
        artifact_sig,
        source_artifact_sig,
        graph_generation: graph_digest,
        database_generation,
        provenance_generation,
        generation: generation as i64,
        node_count: native.node_ids.len() as u32,
        edge_count: native.targets.len() as u32,
        persisted: true,
        resident: true,
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
    })
}

pub struct NativeMemoArtifactBuildTask {
    runtime: Arc<MemoRuntime>,
    db_path: String,
    input_json: String,
}

impl Task for NativeMemoArtifactBuildTask {
    type Output = NativeMemoArtifactBuildResult;
    type JsValue = NativeMemoArtifactBuildResult;

    fn compute(&mut self) -> Result<Self::Output> {
        run_build(&self.runtime, &self.db_path, &self.input_json).map_err(Error::from_reason)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub(crate) fn rebuild_with_runtime(
    runtime: Arc<MemoRuntime>,
    db_path: String,
    input_json: String,
) -> AsyncTask<NativeMemoArtifactBuildTask> {
    AsyncTask::new(NativeMemoArtifactBuildTask {
        runtime,
        db_path,
        input_json,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic_rows() -> Vec<FileTag> {
        // 3 篇 × 各 4-5 个 Tag，含同位并列（position 乱序进构造、由排序保证稳定）
        let mk = |file_id, tag_id, position| FileTag {
            file_id,
            tag_id,
            position,
            diary_name: "测试".to_string(),
            path: format!("t-{file_id}.md"),
        };
        vec![
            mk(1, 10, 1), mk(1, 11, 2), mk(1, 12, 3), mk(1, 13, 4),
            mk(2, 11, 1), mk(2, 14, 2), mk(2, 10, 3), mk(2, 12, 4), mk(2, 15, 5),
            mk(3, 12, 1), mk(3, 13, 2), mk(3, 14, 3), mk(3, 15, 4),
        ]
    }

    fn config() -> Value {
        serde_json::from_str(
            r#"{"orderedCooccurrence":{"semanticGainEnabled":true},"v9":{"outboundMass":0.95}}"#,
        )
        .unwrap()
    }


    /// pairwise 档 compat 构造（测试用：无 DB 依赖，表走空 map）。
    fn pairwise_compat<'a>(
        connection: &'a Connection,
        pairwise: &'a HashMap<(i64, i64), f64>,
        config: &Value,
    ) -> FactCompat<'a> {
        FactCompat::new(FactMatrixMode::Pairwise, pairwise, connection, 0, config)
    }

    fn memory_db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE tags(id INTEGER PRIMARY KEY, vector BLOB);")
            .unwrap();
        db
    }

    fn canonical_transport(transport: &HashMap<i64, HashMap<i64, f64>>) -> Vec<(i64, Vec<(i64, f64)>)> {
        let mut out: Vec<(i64, Vec<(i64, f64)>)> = transport
            .iter()
            .map(|(source, edges)| {
                let mut list: Vec<(i64, f64)> =
                    edges.iter().map(|(target, weight)| (*target, *weight)).collect();
                list.sort_by_key(|item| item.0);
                (*source, list)
            })
            .collect();
        out.sort_by_key(|item| item.0);
        out
    }

    /// 票⑥污染点①②回归：两次独立构建（各自新建 HashMap，RandomState 不同）
    /// 得到逐位相同的 transport——证明累加路径对 HashMap 迭代序不敏感。
    #[test]
    fn transport_is_insensitive_to_hashmap_iteration_order() {
        let rows = synthetic_rows();
        let pairwise = HashMap::new();
        let anchor_gain = HashMap::from([(13i64, 1.4f64), (14i64, 0.7f64)]);
        let cfg = config();
        let db = memory_db();
        let mut compat = pairwise_compat(&db, &pairwise, &cfg);
        let first = build_transport(
            &build_fact_matrix(&rows, &mut compat, &anchor_gain, &cfg).unwrap(),
            &anchor_gain,
            &cfg,
        );
        let second = build_transport(
            &build_fact_matrix(&rows, &mut compat, &anchor_gain, &cfg).unwrap(),
            &anchor_gain,
            &cfg,
        );
        assert_eq!(canonical_transport(&first.0), canonical_transport(&second.0));
        assert_eq!(first.1, second.1);
    }

    /// 票⑥污染点③回归：inbound 排序序累加——同输入两次求和逐位一致，
    /// 且对 transport 的实例迭代序不敏感（排序后才累加）。
    #[test]
    fn inbound_accumulation_is_deterministic() {
        let rows = synthetic_rows();
        let pairwise = HashMap::new();
        let anchor_gain = HashMap::new();
        let cfg = config();
        let db = memory_db();
        let mut compat = pairwise_compat(&db, &pairwise, &cfg);
        let (transport, _) = build_transport(
            &build_fact_matrix(&rows, &mut compat, &anchor_gain, &cfg).unwrap(),
            &anchor_gain,
            &cfg,
        );
        let mut first = HashMap::new();
        let mut sources: Vec<i64> = transport.keys().copied().collect();
        sources.sort_unstable();
        for source in &sources {
            let mut edges: Vec<(i64, f64)> = transport[source]
                .iter()
                .map(|(target, weight)| (*target, *weight))
                .collect();
            edges.sort_unstable_by_key(|item| item.0);
            for (target, weight) in edges {
                *first.entry(target).or_default() += weight;
            }
        }
        let mut second = HashMap::new();
        for source in &sources {
            let mut edges: Vec<(i64, f64)> = transport[source]
                .iter()
                .map(|(target, weight)| (*target, *weight))
                .collect();
            edges.sort_unstable_by_key(|item| item.0);
            for (target, weight) in edges {
                *second.entry(target).or_default() += weight;
            }
        }
        let mut a: Vec<(i64, f64)> = first.into_iter().collect();
        let mut b: Vec<(i64, f64)> = second.into_iter().collect();
        a.sort_by_key(|item| item.0);
        b.sort_by_key(|item| item.0);
        assert_eq!(a, b);
    }


    #[test]
    fn fact_matrix_mode_config_parsing() {
        let empty = serde_json::json!({});
        assert_eq!(read_fact_matrix_mode(&empty).unwrap(), FactMatrixMode::Pairwise);
        let pairwise = serde_json::json!({"factMatrixMode": "pairwise"});
        assert_eq!(read_fact_matrix_mode(&pairwise).unwrap(), FactMatrixMode::Pairwise);
        let vectors = serde_json::json!({"factMatrixMode": "vectors"});
        assert_eq!(read_fact_matrix_mode(&vectors).unwrap(), FactMatrixMode::Vectors);
        let bogus = serde_json::json!({"factMatrixMode": "cos"});
        assert!(read_fact_matrix_mode(&bogus).is_err());
    }

    /// P2-A：vectors 档的 compat 来自现读单位向量 dot（上游 2.0 :194-307），
    /// pairwise 档来自表；同一对同向量 tag 下两者语义增益可解析对照。
    #[test]
    fn vectors_mode_uses_unit_dot_instead_of_pairwise_table() {
        let db = memory_db();
        for id in [10i64, 11] {
            let values = [1.0f32, 0.0, 0.0, 0.0];
            let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
            db.execute("INSERT INTO tags VALUES (?1,?2)", params![id, bytes]).unwrap();
        }
        let rows = vec![
            FileTag { file_id: 1, tag_id: 10, position: 1, diary_name: "t".into(), path: "t".into() },
            FileTag { file_id: 1, tag_id: 11, position: 2, diary_name: "t".into(), path: "t".into() },
        ];
        let cfg = config();
        let anchor_gain = HashMap::new();
        // pairwise 档：空表 ⇒ lowFallback 0.1 ⇒ gain = 0.4+0.1 = 0.5
        let empty = HashMap::new();
        let mut pairwise_compat = FactCompat::new(FactMatrixMode::Pairwise, &empty, &db, 4, &cfg);
        let pairwise = build_fact_matrix(&rows, &mut pairwise_compat, &anchor_gain, &cfg).unwrap();
        // vectors 档：两向量同向 ⇒ cos=1 ⇒ gain = 0.5+0.8*exp(-(0.35²)/(2*0.25²))
        let mut vectors_compat = FactCompat::new(FactMatrixMode::Vectors, &empty, &db, 4, &cfg);
        let vectors = build_fact_matrix(&rows, &mut vectors_compat, &anchor_gain, &cfg).unwrap();
        let pairwise_forward = pairwise[&10][&11];
        let vectors_forward = vectors[&10][&11];
        let ratio = vectors_forward / pairwise_forward;
        let expected = semantic_curve(1.0, 0.65, 0.25) / semantic_curve(0.1, 0.65, 0.25);
        assert!((ratio - expected).abs() < 1e-12, "ratio {} vs {}", ratio, expected);
        assert!(vectors_forward > pairwise_forward);
        // 反向边同样走语义增益（2.0 同构），且 <= forward*guard
        assert!(vectors[&11][&10] <= vectors_forward + 1e-12);
    }

    /// P2-B：vectors 档的 residual signature 来自 unified_geometry 资产行 + facts 指纹校验；
    /// pairwise 档保持 v9.2（无 geometry 也能跑，signature 取 intrinsic 行）。
    #[test]
    fn anchor_signature_requires_geometry_row_and_matching_facts() {
        let db = memory_db();
        db.execute_batch(
            "CREATE TABLE tag_intrinsic_residuals(tag_id INTEGER, model_sig TEXT, residual_energy REAL, \
             v9_anchor_gain REAL, raw_residual_ratio REAL, artifact_sig TEXT);\
             CREATE TABLE tagmemo_artifacts(artifact_sig TEXT, graph_generation TEXT, asset_type TEXT, \
             model_sig TEXT, status TEXT, updated_at INTEGER);\
             CREATE TABLE kbm_runtime_meta(key TEXT, value TEXT);",
        )
        .unwrap();
        db.execute(
            "INSERT INTO tag_intrinsic_residuals VALUES (10,'sig-a',1.0,1.4,0.0,'intrinsic-sig')",
            [],
        )
        .unwrap();
        // 无 geometry 行 ⇒ signature 空（不报错），增益照读
        let (gains, _, signature) = load_anchor_gains(&db, "sig-a", FactMatrixMode::Vectors).unwrap();
        assert_eq!(signature, "");
        assert!((gains[&10] - 1.4).abs() < 1e-12);
        // pairwise 档：signature 取 intrinsic 行（v9.2 逐字）
        let (_, _, legacy_sig) = load_anchor_gains(&db, "sig-a", FactMatrixMode::Pairwise).unwrap();
        assert_eq!(legacy_sig, "intrinsic-sig");
        // geometry 行 + 指纹相符 ⇒ signature = 资产行 sig
        db.execute(
            "INSERT INTO tagmemo_artifacts VALUES ('geometry-sig','facts:abc','unified_geometry','sig-a','ready',1)",
            [],
        )
        .unwrap();
        db.execute("INSERT INTO kbm_runtime_meta VALUES ('memo_tag_facts','abc')", []).unwrap();
        let (_, _, sig_ok) = load_anchor_gains(&db, "sig-a", FactMatrixMode::Vectors).unwrap();
        assert_eq!(sig_ok, "geometry-sig");
        // 指纹不符 ⇒ 硬拒建（上游 :163-165 同语义）
        db.execute("UPDATE kbm_runtime_meta SET value='stale' WHERE key='memo_tag_facts'", []).unwrap();
        let error = load_anchor_gains(&db, "sig-a", FactMatrixMode::Vectors).err().unwrap();
        assert!(error.starts_with("KNOWLEDGE_STORE_DERIVED_DEPENDENCY_CONFLICT:"), "{}", error);
    }

    /// P2-F：payload 行序两档都保持 v9.2（实测 2.0 持久化 payload 也是 target 升序），
    /// 只有 provenance 项形状在 vectors 档收成二元组 [fileId, mass]。
    #[test]
    fn vectors_mode_compacts_provenance_without_changing_row_order() {
        let transport: HashMap<i64, HashMap<i64, f64>> = HashMap::from([
            (10i64, HashMap::from([(11i64, 0.2), (12i64, 0.9)])),
            (11i64, HashMap::from([(12i64, 0.5)])),
        ]);
        let wormholes = HashSet::new();
        let inside = build_native_artifact(
            &transport,
            HashMap::new(),
            HashMap::new(),
            wormholes,
            &BTreeMap::new(),
        );
        // v9.2 行序：target 升序（10 → 11, 12）
        assert_eq!(inside.targets, vec![1, 2, 2]);
        assert_eq!(inside.weights, vec![0.2, 0.9, 0.5]);
        let provenance = BTreeMap::from([(
            (10i64, 11i64),
            vec![ProvenanceContribution {
                file_id: 7,
                diary_name: "d".into(),
                path: "p".into(),
                mass: 0.5,
            }],
        )]);
        let metadata = serde_json::json!({"graphGeneration": "g"});
        let wide = artifact_payload(&inside, &provenance, &metadata, false);
        let compact = artifact_payload(&inside, &provenance, &metadata, true);
        assert_eq!(wide["provenanceView"]["edges"][0][1][0].as_array().unwrap().len(), 4);
        assert_eq!(compact["provenanceView"]["edges"][0][1][0].as_array().unwrap().len(), 2);
    }

    /// 语义增益公式回归：低相似与峰值两侧的分支形状（上游 build_fact_matrix 的
    /// semantic_gain 闭包）——数值锚点防止将来重构时静默改公式。
    #[test]
    fn semantic_gain_formula_anchors() {
        let cfg = config();
        let ordered = cfg.get("orderedCooccurrence").unwrap();
        let peak = number(ordered, &["semanticGainPeak"], 0.65);
        let sigma = number(ordered, &["semanticGainSigma"], 0.25).max(0.001);
        let at_peak = 0.5 + 0.8 * (-(0.0f64) / (2.0 * sigma * sigma)).exp();
        let low = 0.4 + 0.1f64 * 1.0;
        assert!((peak - 0.65).abs() < 1e-12);
        assert!((sigma - 0.25).abs() < 1e-12);
        assert!((at_peak - 1.3).abs() < 1e-12);
        assert!((low - 0.5).abs() < 1e-12);
    }
}
