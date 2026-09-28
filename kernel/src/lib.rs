//! memo-kernel —— vexus-lite 记忆内核复刻（dsh-memo-river 子项目）
//!
//! 目标：行为等价复刻上游 `rust-vexus-lite`（13,598 行 / 8 文件），
//! 判据 = 差分对账（kernel/tools/diff-runner.mjs），不追 bit-exact。
//! 已完成：memo_artifact_builder（票07）/ memo_sensing + memo_pipeline（票08）/
//! rivermemo_topology_v3（v1 切片：runtime/观测缓存/冷路径解码）。
//! 待做：memo_dtsc + topology_v3 判分心脏（票09）→ runtime+NAPI 收口（票10）。
//!
//! 红线（票⑥ 教训，第一天就生效）：一切 HashMap→f64 累加路径必须定序
//! （排序或 BTreeMap 后累加），确定性是属性测试不是运气。

mod memo_artifact_builder;
mod memo_pipeline;
mod memo_sensing;
mod rivermemo_topology_v3;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{Connection, OpenFlags};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use usearch::Index;

/// 内核标识：差分对账器用它区分双轨来源。
#[napi]
pub fn kernel_identity() -> String {
    format!(
        "memo-kernel/{} (reimpl of vexus-lite, artifact-builder+pipeline ready)",
        env!("CARGO_PKG_VERSION")
    )
}

/// N-API 冒烟导出：证明 .node 加载链与 napi 绑定面活着。
#[napi]
pub fn smoke_add(a: f64, b: f64) -> f64 {
    a + b
}

/// 上游 VexusIndex 的复刻壳。
///
/// 索引参数与上游逐项一致（L2sq/F32/conn16/add128/search64/multi=false）；
/// recover 的 SQL 行序插入保证 HNSW 图与 oracle 同构 → knn 结果一致。
#[napi]
pub struct VexusIndex {
    index: Arc<RwLock<Index>>,
    dimensions: u32,
    memo_runtime: Arc<rivermemo_topology_v3::MemoRuntime>,
}

fn open_sqlite_readonly(path: &str) -> std::result::Result<Connection, String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("open/config DB readonly failed: {}", error))?;
    connection
        .busy_timeout(Duration::from_secs(30))
        .map_err(|error| format!("configure DB timeout failed: {}", error))?;
    Ok(connection)
}

pub(crate) struct RecoverTask {
    index: Arc<RwLock<Index>>,
    db_path: String,
    table_type: String,
    filter_diary_name: Option<String>,
    dimensions: u32,
}

impl Task for RecoverTask {
    type Output = u32;
    type JsValue = u32;

    fn compute(&mut self) -> Result<Self::Output> {
        let conn = open_sqlite_readonly(&self.db_path)
            .map_err(|e| Error::from_reason(format!("Failed to open/config DB readonly: {}", e)))?;

        let sql = if self.table_type == "tags" {
            "SELECT id, vector FROM tags WHERE vector IS NOT NULL".to_string()
        } else if self.table_type == "chunks" && self.filter_diary_name.is_some() {
            "SELECT c.id, c.vector FROM chunks c JOIN files f ON c.file_id = f.id WHERE f.diary_name = ?1 AND c.vector IS NOT NULL".to_string()
        } else {
            return Ok(0);
        };

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| Error::from_reason(format!("Failed to prepare statement: {}", e)))?;

        let mut count = 0u32;
        let expected_byte_len = self.dimensions as usize * std::mem::size_of::<f32>();

        let index = self
            .index
            .write()
            .map_err(|e| Error::from_reason(format!("Lock failed: {}", e)))?;

        let mut process_row = |id: i64, vector_bytes: Vec<u8>| -> Result<()> {
            if vector_bytes.len() == expected_byte_len {
                let vec_slice: Vec<f32> = vector_bytes
                    .chunks_exact(4)
                    .map(|c| f32::from_ne_bytes(c.try_into().unwrap()))
                    .collect();

                if index.size() + 1 >= index.capacity() {
                    let new_cap = (index.capacity() as f64 * 1.5) as usize;
                    index.reserve(new_cap).map_err(|e| {
                        Error::from_reason(format!(
                            "Recover reserve failed before vector {}: {:?}",
                            id, e
                        ))
                    })?;
                }

                index.add(id as u64, &vec_slice).map_err(|e| {
                    Error::from_reason(format!("Recover add failed for vector {}: {:?}", id, e))
                })?;
                count += 1;
            }
            Ok(())
        };

        let rows = if let Some(name) = &self.filter_diary_name {
            let rows = stmt
                .query_map([name], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
                })
                .map_err(|e| Error::from_reason(format!("Query failed: {}", e)))?;
            for row_result in rows {
                let (id, vector_bytes) = row_result
                    .map_err(|e| Error::from_reason(format!("Decode recovery row failed: {}", e)))?;
                process_row(id, vector_bytes)?;
            }
            ()
        } else {
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
                })
                .map_err(|e| Error::from_reason(format!("Query failed: {}", e)))?;
            for row_result in rows {
                let (id, vector_bytes) = row_result
                    .map_err(|e| Error::from_reason(format!("Decode recovery row failed: {}", e)))?;
                process_row(id, vector_bytes)?;
            }
            ()
        };
        let _ = rows;
        Ok(count)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
impl VexusIndex {
    #[napi(constructor)]
    pub fn new(dimensions: u32, capacity: u32) -> Result<Self> {
        if dimensions == 0 {
            return Err(Error::from_reason("dimensions must be > 0"));
        }
        let index = Index::new(&usearch::IndexOptions {
            dimensions: dimensions as usize,
            metric: usearch::MetricKind::L2sq,
            quantization: usearch::ScalarKind::F32,
            connectivity: 16,
            expansion_add: 128,
            expansion_search: 64,
            multi: false,
        })
        .map_err(|e| Error::from_reason(format!("Failed to create index: {:?}", e)))?;

        index
            .reserve(capacity as usize)
            .map_err(|e| Error::from_reason(format!("Failed to reserve capacity: {:?}", e)))?;

        Ok(Self {
            index: Arc::new(RwLock::new(index)),
            dimensions,
            memo_runtime: Arc::new(rivermemo_topology_v3::MemoRuntime::new()),
        })
    }

    /// 从 SQLite 恢复向量索引（tags 全量 / chunks 按日记过滤）。
    #[napi]
    pub fn recover_from_sqlite(
        &self,
        db_path: String,
        table_type: String,
        filter_diary_name: Option<String>,
    ) -> AsyncTask<RecoverTask> {
        AsyncTask::new(RecoverTask {
            index: self.index.clone(),
            db_path,
            table_type,
            filter_diary_name,
            dimensions: self.dimensions,
        })
    }

    /// 建 Rust 侧 CSR / 图资产（票 07：与上游逐公式对齐）。
    #[napi]
    pub fn rebuild_memo_artifact(
        &self,
        db_path: String,
        input_json: String,
    ) -> AsyncTask<memo_artifact_builder::NativeMemoArtifactBuildTask> {
        memo_artifact_builder::rebuild_with_runtime(self.memo_runtime.clone(), db_path, input_json)
    }

    /// 统一 Memo 查询管线（票 08：EPA/金字塔/门控/Spike/融合/双场）。
    #[napi]
    pub fn run_memo_pipeline(
        &self,
        db_path: String,
        artifact_sig: String,
        input_json: String,
        query_vector: Float32Array,
        ghost_vectors: Float32Array,
    ) -> AsyncTask<memo_pipeline::MemoPipelineTask> {
        memo_pipeline::run_with_runtime(
            self.index.clone(),
            self.memo_runtime.clone(),
            db_path,
            artifact_sig,
            self.dimensions as usize,
            input_json,
            query_vector.to_vec(),
            ghost_vectors.to_vec(),
        )
    }

    /// 释放本索引持有的统一 Memo 图快照。
    #[napi]
    pub fn clear_memo_runtime(&self) -> Result<()> {
        self.memo_runtime.clear().map_err(Error::from_reason)
    }
}
