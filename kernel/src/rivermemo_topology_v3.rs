//! rivermemo_topology_v3 —— 票 07 v1 切片：NativeArtifact + MemoRuntime。
//!
//! 打分心脏（Ω regime / 角色 / 锚奖励 / 压制语义）按票 09 进场；
//! 本切片只提供 artifact_builder 依赖的数据结构与发布语义，
//! publish 的幂等契约（同签名不递增代际）与上游逐字对齐——
//! 并发冷查询的幂等命中语义是差分时 observableHandle 缓存行为的前提。

use crate::memo_sensing::SenseOutput;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub(crate) fn positive(value: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
        value
    } else {
        0.0
    }
}

pub(crate) fn clamp01(value: f64) -> f64 {
    value.clamp(0.0, 1.0)
}

pub(crate) struct NativeArtifact {
    pub(crate) node_ids: Vec<i64>,
    pub(crate) node_index: HashMap<i64, usize>,
    pub(crate) row_offsets: Vec<usize>,
    pub(crate) targets: Vec<usize>,
    pub(crate) weights: Vec<f64>,
    pub(crate) inbound: HashMap<i64, f64>,
    pub(crate) max_inbound: f64,
    pub(crate) anchor_gain: HashMap<i64, f64>,
    pub(crate) wormhole_edges: HashSet<(i64, i64)>,
    pub(crate) provenance: HashMap<(i64, i64), Vec<(i64, f64)>>,
}

impl NativeArtifact {
    pub(crate) fn edge_weight(&self, source_id: i64, target_id: i64) -> f64 {
        let Some(&source) = self.node_index.get(&source_id) else {
            return 0.0;
        };
        let Some(&target) = self.node_index.get(&target_id) else {
            return 0.0;
        };
        let start = self.row_offsets[source];
        let end = self.row_offsets[source + 1];
        for cursor in start..end {
            if self.targets[cursor] == target {
                return positive(self.weights[cursor]);
            }
        }
        0.0
    }

    pub(crate) fn independent_fraction(&self, source: i64, target: i64, file_id: i64) -> f64 {
        let Some(contributions) = self.provenance.get(&(source, target)) else {
            return 1.0;
        };
        let total: f64 = contributions.iter().map(|item| item.1).sum();
        if total <= 0.0 {
            return 1.0;
        }
        let own: f64 = contributions
            .iter()
            .filter(|item| item.0 == file_id)
            .map(|item| item.1)
            .sum();
        clamp01(1.0 - own / total).max(0.15)
    }
}

/// 统一管线留在原生侧、供候选阶段两个读出头复用的请求级观测（票 08 切片）。
pub(crate) struct MemoQueryObservation {
    pub(crate) artifact_sig: String,
    pub(crate) artifact_generation: u64,
    pub(crate) observation: Arc<SenseOutput>,
    pub(crate) original_query_vector: Arc<Vec<f32>>,
    pub(crate) enhanced_query_vector: Arc<Vec<f32>>,
    pub(crate) local_vector: Arc<Vec<f32>>,
    pub(crate) transfer_vector: Arc<Vec<f32>>,
    pub(crate) local_field: Arc<Vec<(i64, f64)>>,
    pub(crate) transfer_field: Arc<Vec<(i64, f64)>>,
    pub(crate) local_domain_ids: Arc<Vec<i64>>,
    pub(crate) transfer_domain_ids: Arc<Vec<i64>>,
}

struct MemoQueryCacheEntry {
    value: Arc<MemoQueryObservation>,
    inserted_at: Instant,
}

/// VexusIndex 实例拥有的统一 Memo 原生运行时（票 07/08 切片）。
///
/// 活动资产使用 Arc 快照：查询开始时克隆一次 Arc，后续发布不会改变本次查询。
/// publish 的同签名幂等命中与上游一致；查询缓存容量 256 / TTL 5min 与上游同值。
pub(crate) struct MemoRuntime {
    active_artifact: RwLock<Option<(String, u64, Arc<NativeArtifact>)>>,
    generation: AtomicU64,
    query_sequence: AtomicU64,
    query_cache: Mutex<HashMap<String, MemoQueryCacheEntry>>,
    query_cache_order: Mutex<VecDeque<String>>,
    query_cache_capacity: usize,
    query_cache_ttl: Duration,
}

impl MemoRuntime {
    pub(crate) fn new() -> Self {
        Self {
            active_artifact: RwLock::new(None),
            generation: AtomicU64::new(0),
            query_sequence: AtomicU64::new(0),
            query_cache: Mutex::new(HashMap::new()),
            query_cache_order: Mutex::new(VecDeque::new()),
            query_cache_capacity: 256,
            query_cache_ttl: Duration::from_secs(5 * 60),
        }
    }

    fn active_generation(&self, artifact_sig: &str) -> std::result::Result<u64, String> {
        let guard = self
            .active_artifact
            .read()
            .map_err(|error| format!("memo runtime generation lock failed: {}", error))?;
        guard
            .as_ref()
            .filter(|(signature, _, _)| signature == artifact_sig)
            .map(|(_, generation, _)| *generation)
            .ok_or_else(|| format!("memo artifact {} is not resident", artifact_sig))
    }

    #[allow(dead_code)]
    pub(crate) fn get(&self, artifact_sig: &str) -> std::result::Result<Option<Arc<NativeArtifact>>, String> {
        let guard = self
            .active_artifact
            .read()
            .map_err(|error| format!("memo runtime read lock failed: {}", error))?;
        Ok(guard
            .as_ref()
            .filter(|(signature, _, _)| signature == artifact_sig)
            .map(|(_, _, artifact)| artifact.clone()))
    }

    pub(crate) fn store_query_observation(
        &self,
        artifact_sig: &str,
        observation: SenseOutput,
        original_query_vector: Vec<f32>,
        enhanced_query_vector: Vec<f32>,
        local_vector: Vec<f32>,
        transfer_vector: Vec<f32>,
        local_field: Vec<(i64, f64)>,
        transfer_field: Vec<(i64, f64)>,
        local_domain_ids: Vec<i64>,
        transfer_domain_ids: Vec<i64>,
    ) -> std::result::Result<String, String> {
        let artifact_generation = self.active_generation(artifact_sig)?;
        let sequence = self.query_sequence.fetch_add(1, Ordering::AcqRel) + 1;
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let handle = format!(
            "memoq-{:016x}-{:016x}-{:016x}",
            artifact_generation,
            sequence,
            (timestamp as u64) ^ sequence.rotate_left(17)
        );
        let value = Arc::new(MemoQueryObservation {
            artifact_sig: artifact_sig.to_string(),
            artifact_generation,
            observation: Arc::new(observation),
            original_query_vector: Arc::new(original_query_vector),
            enhanced_query_vector: Arc::new(enhanced_query_vector),
            local_vector: Arc::new(local_vector),
            transfer_vector: Arc::new(transfer_vector),
            local_field: Arc::new(local_field),
            transfer_field: Arc::new(transfer_field),
            local_domain_ids: Arc::new(local_domain_ids),
            transfer_domain_ids: Arc::new(transfer_domain_ids),
        });

        let now = Instant::now();
        let mut cache = self
            .query_cache
            .lock()
            .map_err(|error| format!("memo query cache lock failed: {}", error))?;
        let mut order = self
            .query_cache_order
            .lock()
            .map_err(|error| format!("memo query cache order lock failed: {}", error))?;
        while let Some(front) = order.front().cloned() {
            let expired = cache
                .get(&front)
                .map(|entry| now.duration_since(entry.inserted_at) > self.query_cache_ttl)
                .unwrap_or(true);
            if !expired && cache.len() < self.query_cache_capacity {
                break;
            }
            order.pop_front();
            cache.remove(&front);
        }
        while cache.len() >= self.query_cache_capacity {
            let Some(oldest) = order.pop_front() else {
                break;
            };
            cache.remove(&oldest);
        }
        cache.insert(
            handle.clone(),
            MemoQueryCacheEntry {
                value,
                inserted_at: now,
            },
        );
        order.push_back(handle.clone());
        Ok(handle)
    }

    pub(crate) fn get_query_observation(
        &self,
        handle: &str,
        artifact_sig: &str,
    ) -> std::result::Result<Arc<MemoQueryObservation>, String> {
        let active_generation = self.active_generation(artifact_sig)?;
        let now = Instant::now();
        let mut cache = self
            .query_cache
            .lock()
            .map_err(|error| format!("memo query cache lock failed: {}", error))?;
        let entry = cache
            .get(handle)
            .ok_or_else(|| format!("memo query observation handle {} is unavailable", handle))?;
        if now.duration_since(entry.inserted_at) > self.query_cache_ttl {
            cache.remove(handle);
            return Err(format!("memo query observation handle {} expired", handle));
        }
        if entry.value.artifact_sig != artifact_sig
            || entry.value.artifact_generation != active_generation
        {
            return Err("memo query observation artifact generation mismatch".to_string());
        }
        Ok(entry.value.clone())
    }

    pub(crate) fn publish(
        &self,
        artifact_sig: &str,
        artifact: Arc<NativeArtifact>,
    ) -> std::result::Result<u64, String> {
        let mut guard = self
            .active_artifact
            .write()
            .map_err(|error| format!("memo runtime publish lock failed: {}", error))?;

        // 同签名幂等命中：不递增 generation（内容寻址身份，见上游注释）
        if let Some((active_sig, active_generation, _)) = guard.as_ref() {
            if active_sig == artifact_sig {
                return Ok(*active_generation);
            }
        }

        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        *guard = Some((artifact_sig.to_string(), generation, artifact));
        drop(guard);

        // 只有真正切换到不同 Artifact 时，旧代请求观测才必须失效（上游语义）
        let mut cache = self
            .query_cache
            .lock()
            .map_err(|error| format!("memo query cache lock failed: {}", error))?;
        self.query_cache_order
            .lock()
            .map_err(|error| format!("memo query cache order lock failed: {}", error))?
            .clear();
        cache.clear();
        Ok(generation)
    }

    pub(crate) fn clear(&self) -> std::result::Result<(), String> {
        let mut guard = self
            .active_artifact
            .write()
            .map_err(|error| format!("memo runtime clear lock failed: {}", error))?;
        *guard = None;
        drop(guard);
        let mut cache = self
            .query_cache
            .lock()
            .map_err(|error| format!("memo query cache lock failed: {}", error))?;
        self.query_cache_order
            .lock()
            .map_err(|error| format!("memo query cache order lock failed: {}", error))?
            .clear();
        cache.clear();
        Ok(())
    }

    pub(crate) fn diagnostics(&self) -> std::result::Result<(Option<String>, u64, usize, usize), String> {
        let guard = self
            .active_artifact
            .read()
            .map_err(|error| format!("memo runtime diagnostics lock failed: {}", error))?;
        match guard.as_ref() {
            Some((signature, generation, artifact)) => Ok((
                Some(signature.clone()),
                *generation,
                artifact.node_ids.len(),
                artifact.targets.len(),
            )),
            None => Ok((None, 0, 0, 0)),
        }
    }
}

// ── 冷路径：从 rivermemo_artifacts 行解压解码（票 08，管线的兜底） ──────────

use flate2::read::GzDecoder;
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use sha2::Digest;
use std::io::Read;

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

fn decode_artifact(
    db_path: &str,
    artifact_sig: &str,
) -> std::result::Result<Arc<NativeArtifact>, String> {
    const MAX_DECOMPRESSED_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;

    let connection = open_readonly(db_path)?;
    let (codec, expected_checksum, compressed): (String, String, Vec<u8>) = connection
        .query_row(
            "SELECT payload_codec, payload_checksum, payload FROM rivermemo_artifacts \
             WHERE artifact_sig = ?1 AND status = 'ready' LIMIT 1",
            rusqlite::params![artifact_sig],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| format!("RiverMemo artifact {} unavailable: {}", artifact_sig, error))?;
    if codec != "gzip-json-v1" {
        return Err(format!("unsupported RiverMemo artifact codec: {}", codec));
    }

    let decoder = GzDecoder::new(compressed.as_slice());
    let mut limited = decoder.take(MAX_DECOMPRESSED_ARTIFACT_BYTES + 1);
    let mut raw = Vec::new();
    limited
        .read_to_end(&mut raw)
        .map_err(|error| format!("decompress RiverMemo artifact failed: {}", error))?;
    if raw.len() as u64 > MAX_DECOMPRESSED_ARTIFACT_BYTES {
        return Err(format!(
            "RiverMemo artifact {} exceeds decompressed size limit of {} bytes",
            artifact_sig, MAX_DECOMPRESSED_ARTIFACT_BYTES
        ));
    }
    let actual_checksum = format!("{:x}", sha2::Sha256::digest(&raw));
    if expected_checksum.is_empty() || actual_checksum != expected_checksum {
        return Err(format!(
            "RiverMemo artifact {} checksum mismatch",
            artifact_sig
        ));
    }

    let payload: Value = serde_json::from_slice(&raw)
        .map_err(|error| format!("decode RiverMemo artifact JSON failed: {}", error))?;

    let transport = payload
        .get("sharedTransport")
        .ok_or_else(|| "RiverMemo artifact has no sharedTransport".to_string())?;
    let node_ids: Vec<i64> = serde_json::from_value(
        transport
            .get("nodeIds")
            .cloned()
            .unwrap_or(Value::Array(Vec::new())),
    )
    .map_err(|error| format!("decode transport nodeIds failed: {}", error))?;
    let row_offsets_u64: Vec<u64> = serde_json::from_value(
        transport
            .get("rowOffsets")
            .cloned()
            .unwrap_or(Value::Array(Vec::new())),
    )
    .map_err(|error| format!("decode transport rowOffsets failed: {}", error))?;
    let targets_u64: Vec<u64> = serde_json::from_value(
        transport
            .get("targetIndices")
            .cloned()
            .unwrap_or(Value::Array(Vec::new())),
    )
    .map_err(|error| format!("decode transport targets failed: {}", error))?;
    let weights: Vec<f64> = serde_json::from_value(
        transport
            .get("weights")
            .cloned()
            .unwrap_or(Value::Array(Vec::new())),
    )
    .map_err(|error| format!("decode transport weights failed: {}", error))?;

    let mut unique_node_ids = HashSet::with_capacity(node_ids.len());
    if node_ids
        .iter()
        .any(|id| *id <= 0 || !unique_node_ids.insert(*id))
    {
        return Err(format!(
            "RiverMemo artifact {} contains invalid or duplicate node IDs",
            artifact_sig
        ));
    }
    if row_offsets_u64.len() != node_ids.len() + 1 {
        return Err(format!(
            "RiverMemo artifact {} CSR rowOffsets length mismatch",
            artifact_sig
        ));
    }
    if row_offsets_u64.first().copied() != Some(0)
        || row_offsets_u64.windows(2).any(|pair| pair[0] > pair[1])
    {
        return Err(format!(
            "RiverMemo artifact {} CSR rowOffsets are not monotonic from zero",
            artifact_sig
        ));
    }
    if targets_u64.len() != weights.len()
        || row_offsets_u64.last().copied() != Some(targets_u64.len() as u64)
    {
        return Err(format!(
            "RiverMemo artifact {} CSR edge array length mismatch",
            artifact_sig
        ));
    }
    if targets_u64
        .iter()
        .any(|target| *target >= node_ids.len() as u64)
    {
        return Err(format!(
            "RiverMemo artifact {} CSR target index out of bounds",
            artifact_sig
        ));
    }
    if weights
        .iter()
        .any(|weight| !weight.is_finite() || *weight < 0.0)
    {
        return Err(format!(
            "RiverMemo artifact {} contains invalid edge weights",
            artifact_sig
        ));
    }

    let node_index = node_ids
        .iter()
        .enumerate()
        .map(|(index, id)| (*id, index))
        .collect();
    let row_offsets = row_offsets_u64
        .into_iter()
        .map(|value| value as usize)
        .collect();
    let targets = targets_u64
        .into_iter()
        .map(|value| value as usize)
        .collect();

    let mut inbound = HashMap::new();
    if let Some(entries) = payload.get("inboundMassView").and_then(Value::as_array) {
        for entry in entries {
            if let Some(parts) = entry.as_array() {
                if parts.len() >= 2 {
                    if let (Some(id), Some(value)) = (parts[0].as_i64(), parts[1].as_f64()) {
                        inbound.insert(id, positive(value));
                    }
                }
            }
        }
    }
    let max_inbound = payload
        .get("artifact")
        .and_then(|value| value.get("maxInbound"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);

    let mut anchor_gain = HashMap::new();
    if let Some(entries) = payload.get("anchorGainView").and_then(Value::as_array) {
        for entry in entries {
            let Some(parts) = entry.as_array() else {
                continue;
            };
            if parts.len() < 2 {
                continue;
            }
            if let (Some(id), Some(value)) = (parts[0].as_i64(), parts[1].as_f64()) {
                anchor_gain.insert(id, positive(value));
            }
        }
    }

    let mut wormhole_edges = HashSet::new();
    if let Some(entries) = payload.get("wormholeView").and_then(Value::as_array) {
        for entry in entries {
            let Some(key) = entry.as_str() else {
                continue;
            };
            let ids: Vec<i64> = key
                .split(':')
                .filter_map(|value| value.parse::<i64>().ok())
                .collect();
            if ids.len() == 2 {
                wormhole_edges.insert((ids[0], ids[1]));
            }
        }
    }

    let mut provenance = HashMap::new();
    if let Some(edges) = payload
        .get("provenanceView")
        .and_then(|value| value.get("edges"))
        .and_then(Value::as_array)
    {
        for edge in edges {
            let Some(parts) = edge.as_array() else {
                continue;
            };
            if parts.len() < 2 {
                continue;
            }
            let Some(key) = parts[0].as_str() else {
                continue;
            };
            let ids: Vec<i64> = key
                .split(':')
                .filter_map(|value| value.parse::<i64>().ok())
                .collect();
            if ids.len() != 2 {
                continue;
            }
            let mut contributions = Vec::new();
            if let Some(rows) = parts[1].as_array() {
                for row in rows {
                    let Some(values) = row.as_array() else {
                        continue;
                    };
                    if values.len() >= 4 {
                        if let (Some(file_id), Some(mass)) =
                            (values[0].as_i64(), values[3].as_f64())
                        {
                            contributions.push((file_id, positive(mass)));
                        }
                    }
                }
            }
            provenance.insert((ids[0], ids[1]), contributions);
        }
    }

    Ok(Arc::new(NativeArtifact {
        node_ids,
        node_index,
        row_offsets,
        targets,
        weights,
        inbound,
        max_inbound,
        anchor_gain,
        wormhole_edges,
        provenance,
    }))
}

pub(crate) fn load_artifact_from_runtime(
    runtime: &MemoRuntime,
    db_path: &str,
    artifact_sig: &str,
) -> std::result::Result<Arc<NativeArtifact>, String> {
    if let Some(artifact) = runtime.get(artifact_sig)? {
        return Ok(artifact);
    }

    // 解码和校验在写锁外完成；发布临界区只替换 Arc。
    let staging = decode_artifact(db_path, artifact_sig)?;
    runtime.publish(artifact_sig, staging.clone())?;
    Ok(staging)
}
