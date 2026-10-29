//! memo_artifact_builder —— 对齐上游 9aa1f67（conservative-topology-v2.5-confidence-rrf）。
//!
//! 移植原则：公式、系数、SQL、签名拼接逐字对齐上游；差异仅在刻意省略处并有注释。
//! 上游 174a5e1→9aa1f67 增量：stable_sums 稳定分组求和、add_edge 改 Vec 收集后排序、
//! UnitVectors trait（对接 memo_geometry 工作区）、pair_gains 每无序对一次预计算、
//! median select_nth、penalties 按 target 预计算、provenance Vec+stable_sums、
//! rebuild 前置 stale 几何资产迁移（schema.rs migrate_geometry 的 builder 侧等价）。
//! 差分判据见 kernel/tools/diff-runner.mjs：artifactSig 一致 + payload 深比 1e-9。

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
const ALGORITHM_VERSION: &str = "memo.native-artifact-v2-binary";
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
}

#[derive(Clone)]
struct ProvenanceContribution {
    file_id: i64,
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
    pub phase_summary: String,
    pub raw_bytes: u32,
    pub compressed_bytes: u32,
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
            "SELECT ft.file_id, ft.tag_id, COALESCE(ft.position, 0) \
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
            })
        })
        .map_err(|error| format!("query file_tags failed: {}", error))?;
    let mut output = Vec::new();
    for row in rows {
        output.push(row.map_err(|error| format!("decode file_tags row failed: {}", error))?);
    }
    Ok(output)
}

pub(crate) fn open_readonly(path: &str) -> std::result::Result<Connection, String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("open/config DB readonly failed: {}", error))?;
    connection
        .busy_timeout(Duration::from_secs(30))
        .map_err(|error| format!("configure DB timeout failed: {}", error))?;
    Ok(connection)
}

fn open_readwrite_inner(path: &str) -> std::result::Result<Connection, String> {
    let connection = Connection::open(path)
        .map_err(|error| format!("open/config DB readwrite failed: {}", error))?;
    connection
        .busy_timeout(Duration::from_secs(30))
        .map_err(|error| format!("configure DB timeout failed: {}", error))?;
    Ok(connection)
}

fn normalized_sqlite_path(db_path: &str) -> String {
    let trimmed = db_path.trim();
    if trimmed.is_empty() {
        return std::path::PathBuf::from("knowledge_base.sqlite")
            .canonicalize()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "knowledge_base.sqlite".to_string());
    }
    std::path::Path::new(trimmed)
        .canonicalize()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|_| trimmed.to_string())
}

/// WAL 双库契约（BUG-0930）：同进程内 node:sqlite（store 长连接）与 rusqlite 是两份
/// 独立编译的 sqlite——任何在活桶上开 readwrite 的代码路径必须保 keepalive，
/// 否则 close 从第二实例视角重置 -wal，把 node 侧未 checkpoint 的提交行静默回卷。
static SQLITE_KEEPALIVES: LazyLock<Mutex<HashMap<String, Connection>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn ensure_sqlite_keepalive(db_path: &str) {
    let normalized = normalized_sqlite_path(db_path);
    let mut keepalives = SQLITE_KEEPALIVES.lock().unwrap_or_else(|poison| poison.into_inner());
    if !keepalives.contains_key(&normalized) {
        if let Ok(connection) = open_readwrite_inner(&normalized) {
            keepalives.insert(normalized, connection);
        }
    }
}

pub(crate) fn open_readwrite(path: &str) -> std::result::Result<Connection, String> {
    ensure_sqlite_keepalive(path);
    open_readwrite_inner(path)
}

/// P2 交付2（schema-v2 兼容）：上游 schema 迁移会**删除**派生表
/// （`schema.rs migrate_geometry` 删 `tag_pair_similarity` /
/// `tag_intrinsic_residuals` 行 / `kv_store['epa_basis_cache']` /
/// `tagmemo_artifacts` 的 pairwise·intrinsic 行）。缺表 = 那个世界本就没有这类证据，
/// 走空集/缺省增益，**绝不硬崩**。
static PAIRWISE_TABLE_MISSING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
static INTRINSIC_TABLE_MISSING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// 上一次 build 是否在 schema-v2 世界里（pipeline metadata 的 diagnostics 面外露，
/// 便于观测「缺表兜底真的发生了」）。
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

/// rebuild 前置迁移：上游 `openAndInitStore → initialize_schema`（schema 事务）里
/// `migrate_geometry`（schema.rs:288）的 builder 侧等价。我方无 ABI2/openAndInitStore
/// 链，rebuild 是唯一入口，故在此把库带到 geometry_schema_v1 世界：
/// - 无条件段：DROP 旧 pairwise 触发器/表/索引 + 清派生代际键 + 清 pairwise·intrinsic
///   资产行（每次 rebuild 幂等执行，与上游每次 open 等价）。
/// - flag 段：`geometry_schema_v1` 键不存在时**一次性**清 `tag_intrinsic_residuals`
///   全行 / `tag_intrinsic_residual_status` / `kv_store['epa_basis_cache']` 并落键。
///   之后 residuals 由 geometry rebuild 重填，rebuild 不再清。
/// 外围不復刻：kbm_memo_changed_tags / memo_training_tag_count / 派生版本触发器
/// （storage 层活性，不进 rebuild 输入输出面，见 docs/reverse-conservative-v2.5.md §6）。
fn migrate_geometry_assets(db_path: &str) -> std::result::Result<(), String> {
    let mut writable = open_readwrite(db_path)?;
    let transaction = writable
        .transaction()
        .map_err(|error| format!("begin geometry migration failed: {}", error))?;
    // 上游 storage.rs initialize_schema_metadata + SCHEMA_SQL 里 rebuild 直接依赖的最小面：
    // kbm_runtime_meta（database_generation 键）与 rivermemo_artifacts（写入目标表）。
    transaction
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS kbm_runtime_meta (
                key TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL
            );
            INSERT OR IGNORE INTO kbm_runtime_meta(key, value) VALUES ('database_generation', '0');
            CREATE TABLE IF NOT EXISTS rivermemo_artifacts (
                artifact_sig TEXT PRIMARY KEY,
                schema_version TEXT NOT NULL,
                algorithm_version TEXT NOT NULL,
                source_v9_artifact_sig TEXT NOT NULL,
                source_graph_generation TEXT NOT NULL,
                model_sig TEXT NOT NULL,
                config_hash TEXT NOT NULL,
                database_generation TEXT NOT NULL,
                provenance_generation TEXT NOT NULL,
                payload_codec TEXT NOT NULL DEFAULT 'gzip-json-v1',
                payload_checksum TEXT,
                payload BLOB,
                status TEXT NOT NULL,
                error_message TEXT,
                node_count INTEGER NOT NULL DEFAULT 0,
                edge_count INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                published_at INTEGER
            );",
        )
        .map_err(|error| format!("initialize geometry migration schema failed: {}", error))?;
    let switched: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM kbm_runtime_meta WHERE key='geometry_schema_v1')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("probe geometry_schema_v1 failed: {}", error))?;
    for name in [
        "trg_tags_delete_pair_cache",
        "trg_pairwise_tags_insert_generation",
        "trg_pairwise_tags_vector_generation",
        "trg_pairwise_tags_delete_generation",
        "trg_pairwise_file_tags_insert_generation",
        "trg_pairwise_file_tags_delete_generation",
    ] {
        transaction
            .execute_batch(&format!("DROP TRIGGER IF EXISTS {name};"))
            .map_err(|error| format!("drop legacy trigger failed: {}", error))?;
    }
    for table in ["tag_pair_similarity", "tag_intrinsic_residuals", "kv_store"] {
        for event in ["INSERT", "UPDATE", "DELETE"] {
            transaction
                .execute_batch(&format!(
                    "DROP TRIGGER IF EXISTS trg_{table}_{event}_derived;"
                ))
                .map_err(|error| format!("drop derived trigger failed: {}", error))?;
        }
    }
    transaction
        .execute_batch(
            "DROP INDEX IF EXISTS idx_intrinsic_residual_artifact;
             DROP TABLE IF EXISTS tag_pair_similarity_status;
             DROP TABLE IF EXISTS tag_pair_similarity;
             DELETE FROM kbm_runtime_meta WHERE key IN ('derived_pairwise','derived_intrinsic','derived_epa');",
        )
        .map_err(|error| format!("migrate geometry assets failed: {}", error))?;
    if table_exists(&transaction, "kv_store")? {
        transaction
            .execute_batch("DELETE FROM kv_store WHERE key='tagmemo_pairwise_fact_generation';")
            .map_err(|error| format!("clear pairwise fact generation failed: {}", error))?;
    }
    if table_exists(&transaction, "tagmemo_artifacts")? {
        transaction
            .execute_batch(
                "DELETE FROM tagmemo_artifacts \
                 WHERE asset_type IN ('pairwise_similarity','intrinsic_residual');",
            )
            .map_err(|error| format!("clear stale memo artifacts failed: {}", error))?;
    }
    if !switched {
        let mut clear = String::new();
        if table_exists(&transaction, "kv_store")? {
            clear.push_str("DELETE FROM kv_store WHERE key='epa_basis_cache';");
        }
        if table_exists(&transaction, "tag_intrinsic_residuals")? {
            clear.push_str("DELETE FROM tag_intrinsic_residuals;");
        }
        if table_exists(&transaction, "tag_intrinsic_residual_status")? {
            clear.push_str("DELETE FROM tag_intrinsic_residual_status;");
        }
        clear.push_str(
            "INSERT INTO kbm_runtime_meta(key,value) VALUES ('geometry_schema_v1','1');",
        );
        transaction
            .execute_batch(&clear)
            .map_err(|error| format!("one-shot geometry switch failed: {}", error))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("commit geometry migration failed: {}", error))?;
    Ok(())
}

/// fact matrix 的语义门输入档位。缺省 `vectors` = 上游 9aa1f67 唯一路径
/// （`UnitVectors` 读 `tags.vector` 单位向量）；`pairwise` = v9.2 显式兼容档
/// （查 `tag_pair_similarity` 表——上游迁移已 DROP 该表，兼容档只对旧库有意义）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum FactMatrixMode {
    Pairwise,
    Vectors,
}

fn read_fact_matrix_mode(config: &Value) -> std::result::Result<FactMatrixMode, String> {
    match config.get("factMatrixMode").and_then(Value::as_str) {
        None | Some("vectors") => Ok(FactMatrixMode::Vectors),
        Some("pairwise") => Ok(FactMatrixMode::Pairwise),
        Some(other) => Err(format!(
            "invalid factMatrixMode \"{}\"（合法：vectors | pairwise）",
            other
        )),
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

fn load_anchor_gains(
    connection: &Connection,
    model_sig: &str,
    mode: FactMatrixMode,
) -> std::result::Result<(HashMap<i64, f64>, HashMap<i64, f64>, String), String> {
    // 同族守卫：缺表 = 没有几何残差证据 → 空增益（build_fact_matrix 的
    // unwrap_or(1.0) 兜底），不硬崩。
    if !table_exists(connection, "tag_intrinsic_residuals")? {
        INTRINSIC_TABLE_MISSING.store(true, std::sync::atomic::Ordering::Relaxed);
        return Ok((HashMap::new(), HashMap::new(), String::new()));
    }
    // vectors 档照上游 9aa1f67 :135-186 —— 按 model_sig 过滤 + ORDER BY tag_id，
    // residual signature 的权威源是 unified_geometry 资产行（不是 intrinsic 行），
    // 并校验 memo_tag_facts 指纹；不符 ⇒ 硬拒建。
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

/// Stable grouping keeps every key's original floating-point addition order.
/// Compact in place after sorting; the first addition still starts at +0.0.
fn stable_sums<K: Ord + Copy>(mut entries: Vec<(K, f64)>) -> Vec<(K, f64)> {
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    let mut write = 0usize;
    for read in 0..entries.len() {
        let (key, value) = entries[read];
        if write > 0 && entries[write - 1].0 == key {
            entries[write - 1].1 += value;
        } else {
            let mut sum = 0.0;
            sum += value;
            entries[write] = (key, sum);
            write += 1;
        }
    }
    entries.truncate(write);
    entries
}

fn add_edge(matrix: &mut Vec<((i64, i64), f64)>, source: i64, target: i64, weight: f64) {
    if source == target || !weight.is_finite() || weight <= 0.0 {
        return;
    }
    matrix.push(((source, target), weight));
}

/// Unit vectors of one build snapshot, keyed by Tag ID.
trait UnitVectors: Sync {
    fn unit_vector(&self, id: i64) -> Option<&[f64]>;
}

impl UnitVectors for crate::memo_geometry::UnitVectorWorkspace {
    fn unit_vector(&self, id: i64) -> Option<&[f64]> {
        self.get(&id)
    }
}

impl UnitVectors for HashMap<i64, Vec<f64>> {
    fn unit_vector(&self, id: i64) -> Option<&[f64]> {
        self.get(&id).map(Vec::as_slice)
    }
}

/// 语义门相似度源：vectors 档 = 单位向量 dot（上游唯一路径）；
/// pairwise 兼容档 = 查 `tag_pair_similarity` 表、缺行落 low_fallback（v9.2 行为）。
enum SemanticSource<'a> {
    Vectors {
        vectors: &'a dyn UnitVectors,
        low_fallback: f64,
    },
    Pairwise {
        table: &'a HashMap<(i64, i64), f64>,
        low_fallback: f64,
    },
}

impl SemanticSource<'_> {
    fn similarity(&self, left: i64, right: i64) -> f64 {
        match self {
            Self::Vectors {
                vectors,
                low_fallback,
            } => vectors
                .unit_vector(left)
                .zip(vectors.unit_vector(right))
                .map(|(a, b)| crate::memo_geometry::dot(a, b).clamp(-1.0, 1.0))
                .unwrap_or(*low_fallback),
            Self::Pairwise {
                table,
                low_fallback,
            } => table
                .get(&(left.min(right), left.max(right)))
                .copied()
                .unwrap_or(*low_fallback),
        }
    }
}

fn semantic_gain_enabled(config: &Value) -> bool {
    let ordered = config.get("orderedCooccurrence").unwrap_or(&Value::Null);
    boolean(ordered, &["semanticGainEnabled"], false)
        || boolean(ordered, &["semanticGain", "enabled"], false)
}

fn low_sim_fallback(config: &Value) -> f64 {
    let ordered = config.get("orderedCooccurrence").unwrap_or(&Value::Null);
    number(
        ordered,
        &["semanticGainLowSimFallback"],
        number(ordered, &["semanticGain", "lowSimFallback"], 0.1),
    )
}

/// Tags of the files that contribute cooccurrence (2 to 100 Tags), sorted.
fn cooccurrence_tag_ids(rows: &[FileTag]) -> Vec<i64> {
    let mut ids = Vec::new();
    let mut offset = 0usize;
    while offset < rows.len() {
        let mut end = offset + 1;
        while end < rows.len() && rows[end].file_id == rows[offset].file_id {
            end += 1;
        }
        if end - offset >= 2 && end - offset <= 100 {
            ids.extend(rows[offset..end].iter().map(|tag| tag.tag_id));
        }
        offset = end;
    }
    ids.sort_unstable();
    ids.dedup();
    ids
}

/// Enumerate pairs in first-occurrence order, retaining operand orientation.
/// The set is used only for membership, never for iteration or arithmetic.
fn semantic_pairs(rows: &[FileTag]) -> Vec<(i64, i64)> {
    let mut seen = HashSet::new();
    let mut pairs = Vec::new();
    let mut offset = 0;
    while offset < rows.len() {
        let mut end = offset + 1;
        while end < rows.len() && rows[end].file_id == rows[offset].file_id {
            end += 1;
        }
        let tags = &rows[offset..end];
        if (2..=100).contains(&tags.len()) {
            for (i, left) in tags.iter().enumerate() {
                for right in &tags[i + 1..] {
                    let key = (left.tag_id.min(right.tag_id), left.tag_id.max(right.tag_id));
                    if left.tag_id != right.tag_id && seen.insert(key) {
                        pairs.push((left.tag_id, right.tag_id));
                    }
                }
            }
        }
        offset = end;
    }
    pairs
}

fn configured_build_threads(value: Option<&str>, available: usize) -> usize {
    value
        .and_then(|text| text.parse::<usize>().ok())
        .filter(|&n| n > 0)
        .unwrap_or_else(|| available.clamp(1, 8))
}

fn evaluate_pair_gains(
    pairs: &[(i64, i64)],
    gain: &(impl Fn(i64, i64) -> f64 + Sync),
    threads: usize,
) -> Vec<f64> {
    if threads > 1 && !pairs.is_empty() {
        if let Ok(pool) = rayon::ThreadPoolBuilder::new().num_threads(threads).build() {
            use rayon::prelude::*;
            return pool.install(|| pairs.par_iter().map(|&(a, b)| gain(a, b)).collect());
        }
    }
    pairs.iter().map(|&(a, b)| gain(a, b)).collect()
}

fn build_fact_matrix(
    rows: &[FileTag],
    source: &SemanticSource<'_>,
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
    let semantic_enabled = semantic_gain_enabled(config);
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

    let semantic_gain = |left: i64, right: i64| -> f64 {
        if !semantic_enabled {
            return 1.0;
        }
        let similarity = source.similarity(left, right);
        if similarity < 0.15 {
            0.4 + similarity * 1.0
        } else {
            0.5 + 0.8
                * (-((similarity - semantic_peak).powi(2))
                    / (2.0 * semantic_sigma * semantic_sigma))
                    .exp()
        }
    };

    // One gain per unordered Tag pair. `dot` multiplies the same two vectors in
    // the same index order whichever comes first, so the stored value has the
    // bits every later file would compute. Bounded by the number of fact pairs.
    let pair_gains: HashMap<(i64, i64), f64> = if semantic_enabled {
        let pairs = semantic_pairs(rows);
        let available = std::thread::available_parallelism().map_or(1, usize::from);
        let threads = configured_build_threads(
            std::env::var("VCP_MEMO_BUILD_THREADS").ok().as_deref(),
            available,
        );
        let gains = evaluate_pair_gains(&pairs, &semantic_gain, threads);
        pairs
            .into_iter()
            .zip(gains)
            .map(|((a, b), gain)| ((a.min(b), a.max(b)), gain))
            .collect()
    } else {
        HashMap::new()
    };
    let mut matrix = Vec::new();
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
                    let semantic = if semantic_enabled {
                        let pair =
                            (left.tag_id.min(right.tag_id), left.tag_id.max(right.tag_id));
                        pair_gains[&pair]
                    } else {
                        1.0
                    };
                    if left.position > 0 && right.position > 0 {
                        let count = tags.len() as f64;
                        let phi_left =
                            0.9 - 0.4 * (left.position - 1).max(0) as f64 / (count - 1.0).max(1.0);
                        let phi_right = 0.9
                            - 0.4 * (right.position - 1).max(0) as f64 / (count - 1.0).max(1.0);
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
    let mut output: HashMap<i64, HashMap<i64, f64>> = HashMap::new();
    for ((source, target), weight) in stable_sums(matrix) {
        output.entry(source).or_default().insert(target, weight);
    }
    Ok(output)
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
    // 污染下游 median/penalty/全部边权与 artifactSig。source 升序 + 边按 target 排序。
    let mut sources: Vec<_> = fact.keys().copied().collect();
    sources.sort_unstable();
    for source_id in sources {
        let source = &source_id;
        let mut edges: Vec<_> = fact[source].iter().collect();
        edges.sort_by_key(|(target, _)| **target);
        for (target, compatibility) in edges {
            let evidence = (1.0 + compatibility.max(0.0) * evidence_compression).ln();
            let residual = anchor_gain.get(target).copied().unwrap_or(1.0);
            let wormhole = evidence * residual >= tension_threshold;
            let conductance = evidence * if wormhole { wormhole_gain } else { 1.0 };
            if conductance > 0.0 && conductance.is_finite() {
                raw_rows
                    .entry(*source)
                    .or_default()
                    .push((*target, conductance, wormhole));
                *target_inflow.entry(*target).or_default() += conductance;
            }
        }
    }

    let mut positive: Vec<f64> = target_inflow
        .values()
        .copied()
        .filter(|value| *value > 0.0 && value.is_finite())
        .collect();
    // Linear-time selection of index len/2. `total_cmp` distinguishes every bit
    // pattern, so this is the same value a full sort would place there.
    let median = if positive.is_empty() {
        1.0
    } else {
        let middle = positive.len() / 2;
        *positive
            .select_nth_unstable_by(middle, |left, right| left.total_cmp(right))
            .1
    };
    let smoothing = (median * smoothing_ratio).max(1e-9);
    let hub_penalty = |inflow: f64| -> f64 {
        let relative = inflow / (median + smoothing);
        let raw_penalty = if hub_exponent > 0.0 {
            relative.max(1e-9).powf(-hub_exponent)
        } else {
            1.0
        };
        raw_penalty.clamp(hub_floor, hub_ceiling)
    };
    // The penalty depends only on the target: one `powf` per target, not per edge.
    let penalties: HashMap<i64, f64> = target_inflow
        .iter()
        .map(|(target, inflow)| (*target, hub_penalty(*inflow)))
        .collect();

    let mut transport = HashMap::new();
    let mut wormholes = HashSet::new();
    let mut raw_sources: Vec<i64> = raw_rows.keys().copied().collect();
    raw_sources.sort_unstable();
    for source in &raw_sources {
        let edges = &raw_rows[source];
        let mut adjusted = Vec::new();
        let mut total = 0.0;
        let mut wormhole_total = 0.0;
        for (target, conductance, wormhole) in edges {
            let penalty = penalties
                .get(target)
                .copied()
                .unwrap_or_else(|| hub_penalty(0.0));
            let value = conductance * penalty;
            if value > 0.0 && value.is_finite() {
                total += value;
                if *wormhole {
                    wormhole_total += value;
                }
                adjusted.push((*target, value, *wormhole));
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
    let mut aggregated: Vec<((i64, i64, i64), f64)> = Vec::new();

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
                        aggregated.push(((source, target, file_id), mass));
                    }
                }
            }
        }
        offset = end;
    }

    let mut output: Vec<((i64, i64), Vec<ProvenanceContribution>)> = Vec::new();
    for ((source, target, file_id), mass) in stable_sums(aggregated) {
        let edge = (source, target);
        if output.last().is_none_or(|(previous, _)| *previous != edge) {
            output.push((edge, Vec::new()));
        }
        output
            .last_mut()
            .unwrap()
            .1
            .push(ProvenanceContribution { file_id, mass });
    }
    output.into_iter().collect()
}

fn database_generation(connection: &Connection) -> std::result::Result<String, String> {
    connection
        .query_row(
            "SELECT value FROM kbm_runtime_meta \
             WHERE key = 'database_generation'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| format!("read persisted database generation failed: {}", error))
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
    // 上游 9aa1f67 :655-667：返回已 prepared() 的 artifact——行内按正权重降序重排
    // （并列按 node_id 升序 tie-break）+ 物化 node_anchor_gain/edge_is_wormhole，
    // payload 的 sharedTransport 直接从 targets/weights 序列化 ⇒ 行内降序。
    // （P2-F「oracle 行序非降序证伪 prepared」是 174a5e1 时代实测，9aa1f67 已改。）
    Arc::new(NativeArtifact {
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
        ..NativeArtifact::default()
    }
    .prepared())
}

fn artifact_payload(
    artifact: &NativeArtifact,
    provenance: &BTreeMap<(i64, i64), Vec<ProvenanceContribution>>,
    metadata: &Value,
) -> Value {
    // 上游 9aa1f67 provenanceView.schema 已换代 file-mass-v2（[[fileId,mass]...] 二元组，
    // v9.2 的四元组 diary_name/path 随 FileTag 字段删除一并退役）。
    let provenance_edges: Vec<Value> = provenance
        .iter()
        .map(|((source, target), contributions)| {
            json!([
                format!("{}:{}", source, target),
                contributions
                    .iter()
                    .map(|item| json!([item.file_id, item.mass]))
                    .collect::<Vec<_>>()
            ])
        })
        .collect();
    let mut inbound: Vec<(i64, f64)> = artifact
        .inbound
        .iter()
        .map(|(id, mass)| (*id, *mass))
        .collect();
    inbound.sort_unstable_by_key(|entry| entry.0);
    let mut anchor_gain: Vec<(i64, f64)> = artifact
        .anchor_gain
        .iter()
        .map(|(id, gain)| (*id, *gain))
        .collect();
    anchor_gain.sort_unstable_by_key(|entry| entry.0);
    let mut wormhole_ids: Vec<(i64, i64)> =
        artifact.wormhole_edges.iter().copied().collect();
    wormhole_ids.sort_unstable();
    let inbound: Vec<Value> = inbound.into_iter().map(|(id, mass)| json!([id, mass])).collect();
    let anchor_gain: Vec<Value> = anchor_gain
        .into_iter()
        .map(|(id, gain)| json!([id, gain]))
        .collect();
    let wormholes: Vec<Value> = wormhole_ids
        .into_iter()
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
            "schema": "tagmemo-provenance-file-mass-v2",
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
    dimension: usize,
) -> std::result::Result<NativeMemoArtifactBuildResult, String> {
    let started = Instant::now();
    let input: BuildInput = serde_json::from_str(input_json)
        .map_err(|error| format!("invalid native artifact build JSON: {}", error))?;
    if input.model_sig.trim().is_empty() {
        return Err("native artifact build requires modelSig".to_string());
    }

    // rebuild 前置：把库带到 geometry_schema_v1 世界（上游 openAndInitStore 迁移的
    // builder 侧等价——清 stale 几何资产，见 migrate_geometry_assets 注释）。
    migrate_geometry_assets(db_path)?;

    let readonly = open_readonly(db_path)?;
    let mode = read_fact_matrix_mode(&input.effective_config)?;
    let rows = load_file_tags(&readonly)?;
    let (anchor_gain, _raw_residuals, residual_sig) =
        load_anchor_gains(&readonly, &input.model_sig, mode)?;
    // vectors 档（缺省）：每个 Tag 向量在快照内读+单位化一次（memo_geometry 的
    // UnitVectorWorkspace，与 geometry 预计算同读法）；semantic 关闭时空工作区，
    // 无向量 SQL。pairwise 显式兼容档：语义源 = tag_pair_similarity 表。
    let (vectors, pairwise) = match mode {
        FactMatrixMode::Vectors => (
            if semantic_gain_enabled(&input.effective_config) {
                let ids = cooccurrence_tag_ids(&rows);
                crate::memo_geometry::UnitVectorWorkspace::build(&readonly, &ids, dimension)?
            } else {
                crate::memo_geometry::UnitVectorWorkspace::empty(dimension)
            },
            HashMap::new(),
        ),
        FactMatrixMode::Pairwise => (
            crate::memo_geometry::UnitVectorWorkspace::empty(dimension),
            load_pairwise(&readonly, &input.model_sig)?,
        ),
    };
    let semantic_source = match mode {
        FactMatrixMode::Vectors => SemanticSource::Vectors {
            vectors: &vectors,
            low_fallback: low_sim_fallback(&input.effective_config),
        },
        FactMatrixMode::Pairwise => SemanticSource::Pairwise {
            table: &pairwise,
            low_fallback: low_sim_fallback(&input.effective_config),
        },
    };
    let fact = build_fact_matrix(&rows, &semantic_source, &anchor_gain, &input.effective_config)?;
    drop(semantic_source);
    drop(vectors);
    drop(pairwise);
    let load_ms = started.elapsed().as_secs_f64() * 1000.0;

    let (transport, wormholes) = build_transport(&fact, &anchor_gain, &input.effective_config);
    drop(fact);
    let provenance = build_provenance(&rows, &input.effective_config);
    drop(rows);

    let mut inbound = HashMap::new();
    let mut sources: Vec<_> = transport.keys().copied().collect();
    sources.sort_unstable();
    let mut graph_hasher = Sha256::new();
    graph_hasher.update(b"memo-graph-le-v2");
    graph_hasher.update((sources.len() as u64).to_le_bytes());
    for source in sources {
        let mut edges: Vec<_> = transport[&source].iter().collect();
        edges.sort_by_key(|(target, _)| **target);
        graph_hasher.update(source.to_le_bytes());
        graph_hasher.update((edges.len() as u64).to_le_bytes());
        for (target, weight) in edges {
            *inbound.entry(*target).or_default() += *weight;
            graph_hasher.update(target.to_le_bytes());
            graph_hasher.update(weight.to_le_bytes());
        }
    }
    let graph_digest = format!("{:x}", graph_hasher.finalize())[..48].to_owned();
    let mut provenance_hasher = Sha256::new();
    provenance_hasher.update(b"memo-provenance-le-v2");
    provenance_hasher.update((provenance.len() as u64).to_le_bytes());
    for ((source, target), values) in &provenance {
        provenance_hasher.update(source.to_le_bytes());
        provenance_hasher.update(target.to_le_bytes());
        provenance_hasher.update((values.len() as u64).to_le_bytes());
        for value in values {
            provenance_hasher.update(value.file_id.to_le_bytes());
            provenance_hasher.update(value.mass.to_le_bytes());
        }
    }
    let provenance_generation = format!("{:x}", provenance_hasher.finalize())[..40].to_owned();
    let database_generation = database_generation(&readonly)?;
    drop(readonly);
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

    let native = build_native_artifact(&transport, inbound, anchor_gain, wormholes, &provenance);
    drop(transport);
    let graph_ms = started.elapsed().as_secs_f64() * 1000.0 - load_ms;
    let published_at = now_ms();
    let metadata = json!({
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
    let payload = artifact_payload(&native, &provenance, &metadata);
    let raw = serde_json::to_vec(&payload)
        .map_err(|error| format!("encode native artifact payload failed: {}", error))?;
    drop(payload);
    drop(provenance);
    let checksum = sha256_hex(&raw);
    let encode_ms = started.elapsed().as_secs_f64() * 1000.0 - load_ms - graph_ms;
    let raw_bytes = raw.len() as u32;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder
        .write_all(&raw)
        .map_err(|error| format!("compress native artifact failed: {}", error))?;
    let compressed = encoder
        .finish()
        .map_err(|error| format!("finish native artifact compression failed: {}", error))?;

    drop(raw);
    let compressed_bytes = compressed.len() as u32;
    let compression_ms = started.elapsed().as_secs_f64() * 1000.0 - load_ms - graph_ms - encode_ms;
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
    drop(writable);

    // native 已 prepared（上游 :1019 同形状直接 clone 发布；prepared 幂等有测试覆盖）。
    let generation = runtime.publish(&artifact_sig, native.clone())?;
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
        phase_summary: format!(
            "load={load_ms:.3};graph={graph_ms:.3};encode={encode_ms:.3};compress={compression_ms:.3};publish={:.3}",
            started.elapsed().as_secs_f64() * 1000.0 - load_ms - graph_ms - encode_ms - compression_ms
        ),
        raw_bytes,
        compressed_bytes,
    })
}

pub struct NativeMemoArtifactBuildTask {
    runtime: Arc<MemoRuntime>,
    db_path: String,
    input_json: String,
    dimension: usize,
}

impl Task for NativeMemoArtifactBuildTask {
    type Output = NativeMemoArtifactBuildResult;
    type JsValue = NativeMemoArtifactBuildResult;

    fn compute(&mut self) -> Result<Self::Output> {
        run_build(&self.runtime, &self.db_path, &self.input_json, self.dimension)
            .map_err(Error::from_reason)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub(crate) fn rebuild_with_runtime(
    runtime: Arc<MemoRuntime>,
    db_path: String,
    input_json: String,
    dimension: usize,
) -> AsyncTask<NativeMemoArtifactBuildTask> {
    AsyncTask::new(NativeMemoArtifactBuildTask {
        runtime,
        db_path,
        input_json,
        dimension,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic_rows() -> Vec<FileTag> {
        // 三个 file，各 2-3 tag，跨 file 复现 tag 对（制造同 key 多次累加）。
        vec![
            FileTag { file_id: 1, tag_id: 10, position: 1 },
            FileTag { file_id: 1, tag_id: 20, position: 2 },
            FileTag { file_id: 1, tag_id: 30, position: 3 },
            FileTag { file_id: 2, tag_id: 20, position: 1 },
            FileTag { file_id: 2, tag_id: 10, position: 2 },
            FileTag { file_id: 3, tag_id: 10, position: 1 },
            FileTag { file_id: 3, tag_id: 20, position: 2 },
        ]
    }

    fn config() -> Value {
        json!({})
    }

    fn memory_db() -> Connection {
        Connection::open_in_memory().unwrap()
    }

    fn canonical_transport(transport: &HashMap<i64, HashMap<i64, f64>>) -> Vec<(i64, Vec<(i64, f64)>)> {
        let mut rows: Vec<(i64, Vec<(i64, f64)>)> = transport
            .iter()
            .map(|(source, edges)| {
                let mut ordered: Vec<(i64, f64)> =
                    edges.iter().map(|(target, weight)| (*target, *weight)).collect();
                ordered.sort_by_key(|item| item.0);
                (*source, ordered)
            })
            .collect();
        rows.sort_by_key(|item| item.0);
        rows
    }

    #[test]
    fn stable_sums_matches_entry_accumulation_bits() {
        // stable_sums（sort + 原地压缩，首加法 +0.0 起）与 HashMap entry 直加
        // 在同 key 多值场景下必须位级一致（0.0+v == v，IEEE）。
        let entries = vec![
            ((7i64, 9i64), 0.1f64),
            ((3, 5), 0.25),
            ((7, 9), 0.2),
            ((3, 5), 1.0 / 3.0),
            ((7, 9), 0.30000000000000004),
        ];
        let mut baseline: HashMap<(i64, i64), f64> = HashMap::new();
        for (key, value) in entries.iter() {
            *baseline.entry(*key).or_default() += *value;
        }
        for (key, sum) in stable_sums(entries) {
            assert_eq!(sum.to_bits(), baseline[&key].to_bits(), "key {:?}", key);
        }
    }

    #[test]
    fn transport_is_insensitive_to_hashmap_iteration_order() {
        let anchor = HashMap::new();
        let config = config();
        // 两份等价 fact（构造时插入序不同）→ transport 规范形必须一致。
        let mut fact_a: HashMap<i64, HashMap<i64, f64>> = HashMap::new();
        fact_a.insert(10, HashMap::from([(20, 0.5), (30, 1.5)]));
        fact_a.insert(20, HashMap::from([(10, 0.7)]));
        let mut fact_b: HashMap<i64, HashMap<i64, f64>> = HashMap::new();
        fact_b.insert(20, HashMap::from([(10, 0.7)]));
        fact_b.insert(10, HashMap::from([(30, 1.5), (20, 0.5)]));
        let (transport_a, _) = build_transport(&fact_a, &anchor, &config);
        let (transport_b, _) = build_transport(&fact_b, &anchor, &config);
        assert_eq!(canonical_transport(&transport_a), canonical_transport(&transport_b));
    }

    #[test]
    fn fact_matrix_mode_config_parsing() {
        assert!(matches!(
            read_fact_matrix_mode(&json!({})),
            Ok(FactMatrixMode::Vectors)
        ));
        assert!(matches!(
            read_fact_matrix_mode(&json!({"factMatrixMode": "vectors"})),
            Ok(FactMatrixMode::Vectors)
        ));
        assert!(matches!(
            read_fact_matrix_mode(&json!({"factMatrixMode": "pairwise"})),
            Ok(FactMatrixMode::Pairwise)
        ));
        assert!(read_fact_matrix_mode(&json!({"factMatrixMode": "bogus"})).is_err());
    }

    #[test]
    fn vectors_mode_uses_unit_dot_instead_of_pairwise_table() {
        let rows = synthetic_rows();
        let anchor = HashMap::new();
        let config = json!({
            "orderedCooccurrence": {"semanticGainEnabled": true, "semanticGainPeak": 0.65, "semanticGainSigma": 0.25}
        });
        // tag 10 与 20 同向（dot≈1）、与 30 正交（dot≈0）。
        let unit = |angle: f64| -> Vec<f64> {
            let mut v = vec![angle.cos(), angle.sin()];
            let norm = (v[0] * v[0] + v[1] * v[1]).sqrt();
            v.iter_mut().for_each(|x| *x /= norm);
            v
        };
        let vectors: HashMap<i64, Vec<f64>> =
            HashMap::from([(10, unit(0.0)), (20, unit(0.0)), (30, unit(std::f64::consts::FRAC_PI_2))]);
        let vectors_source = SemanticSource::Vectors { vectors: &vectors, low_fallback: 0.1 };
        let fact = build_fact_matrix(&rows, &vectors_source, &anchor, &config).unwrap();
        // 同向对的边权 = 纯 phi 结构（curve(≈1) = 0.5+0.8*exp(-(1-0.65)^2/(2*0.0625))）。
        let aligned = fact[&10][&20];
        // 正交对 curve(0)=0.5+0.8*exp(-0.65^2/0.125)。
        let orthogonal = fact[&10][&30];
        assert!(aligned > orthogonal, "aligned {} vs orthogonal {}", aligned, orthogonal);
        // 空 pairwise 表（上游迁移后世界）→ similarity 全落 low_fallback=0.1 → curve=0.5。
        let empty: HashMap<(i64, i64), f64> = HashMap::new();
        let pairwise_source = SemanticSource::Pairwise { table: &empty, low_fallback: 0.1 };
        let fact_pairwise = build_fact_matrix(&rows, &pairwise_source, &anchor, &config).unwrap();
        assert!(fact_pairwise[&10][&20] != fact[&10][&20]);
    }

    #[test]
    fn pairwise_mode_matches_legacy_entry_accumulation() {
        // pairwise 显式兼容档与 v9.2 的逐边算式必须位等价（单 file 双 tag，
        // 方向唯一、phi/curve 可手工展开）。
        let rows = vec![
            FileTag { file_id: 1, tag_id: 10, position: 1 },
            FileTag { file_id: 1, tag_id: 20, position: 2 },
        ];
        let anchor = HashMap::new();
        let config = json!({"orderedCooccurrence": {"semanticGainEnabled": true}});
        let table: HashMap<(i64, i64), f64> = HashMap::from([((10, 20), 0.8)]);
        let source = SemanticSource::Pairwise { table: &table, low_fallback: 0.1 };
        let fact = build_fact_matrix(&rows, &source, &anchor, &config).unwrap();
        // phi(position=1,count=2)=0.9；phi(position=2)=0.9-0.4*1/1=0.5；base=0.45。
        // curve(0.8)=0.5+0.8*exp(-((0.8-0.65)^2)/(2*0.25^2))（峰值 0.65/σ0.25 缺省）。
        let curve = 0.5 + 0.8 * (-((0.8 - 0.65f64).powi(2)) / (2.0 * 0.25 * 0.25)).exp();
        let forward = 0.9f64 * 0.5 * 1.0 * curve;
        // reverse_gain 缺省 0.42 → clamp(0.25,0.70) 不变；backward=min(0.45*0.42*curve, forward*0.95)。
        let backward = (0.9f64 * 0.5 * 0.42 * curve).min(forward * 0.95);
        assert_eq!(fact[&10][&20].to_bits(), forward.to_bits());
        assert_eq!(fact[&20][&10].to_bits(), backward.to_bits());
    }

    #[test]
    fn semantic_pairs_first_occurrence_order() {
        let rows = synthetic_rows();
        let pairs = semantic_pairs(&rows);
        // 首次出现序：file1 的 (10,20)(10,30)(20,30) 之后 file2/file3 的对都已 seen。
        assert_eq!(pairs, vec![(10, 20), (10, 30), (20, 30)]);
        let ids = cooccurrence_tag_ids(&rows);
        assert_eq!(ids, vec![10, 20, 30]);
        // 窗口界外（1 tag / >100 tags）不参与。
        let single = vec![FileTag { file_id: 9, tag_id: 99, position: 1 }];
        assert!(semantic_pairs(&single).is_empty());
        assert!(cooccurrence_tag_ids(&single).is_empty());
    }

    #[test]
    fn anchor_signature_requires_geometry_row_and_matching_facts() {
        let connection = memory_db();
        connection
            .execute_batch(
                "CREATE TABLE tag_intrinsic_residuals(tag_id INTEGER, model_sig TEXT, v9_anchor_gain REAL, residual_energy REAL, raw_residual_ratio REAL, artifact_sig TEXT);
                 CREATE TABLE tagmemo_artifacts(asset_type TEXT, model_sig TEXT, status TEXT, artifact_sig TEXT, graph_generation TEXT, updated_at INTEGER);
                 CREATE TABLE kbm_runtime_meta(key TEXT PRIMARY KEY, value TEXT);
                 INSERT INTO tag_intrinsic_residuals VALUES (10, 'm', 1.2, 1.2, 0.3, 'sig-intrinsic');
                 INSERT INTO tagmemo_artifacts VALUES ('unified_geometry', 'm', 'ready', 'sig-geometry', 'facts:41', 1);
                 INSERT INTO kbm_runtime_meta VALUES ('memo_tag_facts', '40');",
            )
            .unwrap();
        // facts 指纹不匹配 → 硬拒。
        let err = load_anchor_gains(&connection, "m", FactMatrixMode::Vectors).unwrap_err();
        assert!(err.contains("DERIVED_DEPENDENCY_CONFLICT"), "{}", err);
        connection
            .execute("UPDATE kbm_runtime_meta SET value='41' WHERE key='memo_tag_facts'", [])
            .unwrap();
        let (gains, raw, signature) =
            load_anchor_gains(&connection, "m", FactMatrixMode::Vectors).unwrap();
        assert_eq!(signature, "sig-geometry");
        assert_eq!(gains[&10], 1.2);
        assert_eq!(raw[&10], 0.3);
        // pairwise 档不读 unified_geometry：signature 取 intrinsic 行。
        let (_, _, pairwise_sig) =
            load_anchor_gains(&connection, "m", FactMatrixMode::Pairwise).unwrap();
        assert_eq!(pairwise_sig, "sig-intrinsic");
    }

    #[test]
    fn workspace_source_matches_in_memory_vectors_bits() {
        // 上游 bounded_workspace_tests 的可移植子集：tags 表建 2 维 f32 LE blob，
        // UnitVectorWorkspace::build 与 HashMap 单位向量作为 SemanticSource 必须
        // 产出位级相同的 fact matrix（同一 normalize 口径）。
        let rows: Vec<_> = (1..=50)
            .flat_map(|file_id| {
                (1..=3).map(move |position| FileTag {
                    file_id,
                    tag_id: file_id + position,
                    position,
                })
            })
            .collect();
        let connection = memory_db();
        connection
            .execute_batch("CREATE TABLE tags(id INTEGER PRIMARY KEY, vector BLOB)")
            .unwrap();
        for id in 1..=53_i64 {
            let x = id as f32 * 0.013;
            let bytes: Vec<u8> = [x.cos(), x.sin()]
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect();
            connection
                .execute("INSERT INTO tags VALUES (?1,?2)", params![id, bytes])
                .unwrap();
        }
        let ids = cooccurrence_tag_ids(&rows);
        let workspace = crate::memo_geometry::UnitVectorWorkspace::build(&connection, &ids, 2).unwrap();
        // 内存版 HashMap：f32→f64 + normalize（与 workspace 同口径）。
        let mut in_memory: HashMap<i64, Vec<f64>> = HashMap::new();
        for id in &ids {
            let bytes: Vec<u8> = connection
                .query_row("SELECT vector FROM tags WHERE id=?1", [id], |row| {
                    row.get::<_, Vec<u8>>(0)
                })
                .unwrap();
            let mut vector: Vec<f64> = bytes
                .chunks_exact(4)
                .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]) as f64)
                .collect();
            let norm = (vector[0] * vector[0] + vector[1] * vector[1]).sqrt();
            if norm > 1e-12 {
                vector.iter_mut().for_each(|v| *v /= norm);
                in_memory.insert(*id, vector);
            }
        }
        let config = json!({"orderedCooccurrence": {"semanticGainEnabled": true}});
        let anchor = HashMap::new();
        let ws_source = SemanticSource::Vectors { vectors: &workspace, low_fallback: 0.1 };
        let mapped = build_fact_matrix(&rows, &ws_source, &anchor, &config).unwrap();
        let mem_source = SemanticSource::Vectors { vectors: &in_memory, low_fallback: 0.1 };
        let heap = build_fact_matrix(&rows, &mem_source, &anchor, &config).unwrap();
        assert_eq!(mapped.len(), heap.len());
        for (source, edges) in &heap {
            for (target, weight) in edges {
                assert_eq!(
                    mapped[source][target].to_bits(),
                    weight.to_bits(),
                    "edge {}→{}",
                    source,
                    target
                );
            }
        }
    }

    #[test]
    fn semantic_gain_formula_anchors() {
        let vectors: HashMap<i64, Vec<f64>> = HashMap::new();
        // 缺向量（低相似度臂）→ low_fallback=0.1 < 0.15 → semantic=0.4+0.1*1.0=0.5。
        let rows = vec![
            FileTag { file_id: 1, tag_id: 1, position: 1 },
            FileTag { file_id: 1, tag_id: 2, position: 2 },
        ];
        let config = json!({"orderedCooccurrence": {"semanticGainEnabled": true}});
        let source = SemanticSource::Vectors { vectors: &vectors, low_fallback: 0.1 };
        let fact = build_fact_matrix(&rows, &source, &HashMap::new(), &config).unwrap();
        // phi(position=1,count=2)=0.9、phi(position=2)=0.5 → base=0.45；
        // forward = base * forward_gain(1.0) * semantic(0.5) = 0.225。
        let expected = 0.9f64 * 0.5 * 1.0 * 0.5;
        assert_eq!(fact[&1][&2].to_bits(), expected.to_bits());
    }

    #[test]
    fn provenance_stable_sums_keep_file_order_and_edge_order() {
        let rows = synthetic_rows();
        let config = json!({});
        let provenance = build_provenance(&rows, &config);
        // BTreeMap 键序 = (source,target) 升序；每边 contributions 沿 file 出现序。
        let keys: Vec<(i64, i64)> = provenance.keys().copied().collect();
        let mut sorted_keys = keys.clone();
        sorted_keys.sort();
        assert_eq!(keys, sorted_keys);
        // file1 与 file3 都贡献 (10,20)：mass 相同（position 结构同）→ 稳定求和。
        assert_eq!(provenance[&(10, 20)].len(), 3);
    }
}
