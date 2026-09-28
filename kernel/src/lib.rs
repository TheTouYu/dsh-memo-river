//! memo-kernel —— vexus-lite 记忆内核复刻（dsh-memo-river 子项目）
//!
//! 目标：行为等价复刻上游 `rust-vexus-lite`（13,598 行 / 8 文件），
//! 判据 = 差分对账（kernel/tools/diff-runner.mjs），不追 bit-exact。
//! 文件拆分镜像上游：memo_artifact_builder（票07 ✅）/ rivermemo_topology_v3（v1 切片，
//! 打分心脏票09 进场）/ memo_pipeline / memo_sensing / memo_dtsc / knowledge_runtime /
//! result_deduplicator / lib。
//!
//! 红线（票⑥ 教训，第一天就生效）：一切 HashMap→f64 累加路径必须定序
//! （排序或 BTreeMap 后累加），确定性是属性测试不是运气。

mod memo_artifact_builder;
mod rivermemo_topology_v3;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::sync::Arc;

/// 内核标识：差分对账器用它区分双轨来源。
#[napi]
pub fn kernel_identity() -> String {
    format!(
        "memo-kernel/{} (reimpl of vexus-lite, artifact-builder ready)",
        env!("CARGO_PKG_VERSION")
    )
}

/// N-API 冒烟导出：证明 .node 加载链与 napi 绑定面活着。
#[napi]
pub fn smoke_add(a: f64, b: f64) -> f64 {
    a + b
}

/// 上游 VexusIndex 的复刻壳（票 07 阶段）。
///
/// 上游此类同时承载 usearch 向量索引（index）与 MemoRuntime；向量索引层随票 10
/// 进场，当前只保留 artifact_builder 依赖的 memo_runtime 与维度信息——
/// rebuildMemoArtifact 全链不读向量索引（纯 sqlite + 配置推导），行为面已完整。
#[napi]
pub struct VexusIndex {
    dimensions: u32,
    #[allow(dead_code)]
    capacity: u32,
    memo_runtime: Arc<rivermemo_topology_v3::MemoRuntime>,
}

#[napi]
impl VexusIndex {
    #[napi(constructor)]
    pub fn new(dimensions: u32, capacity: u32) -> Result<Self> {
        if dimensions == 0 {
            return Err(Error::from_reason("dimensions must be > 0"));
        }
        Ok(Self {
            dimensions,
            capacity,
            memo_runtime: Arc::new(rivermemo_topology_v3::MemoRuntime::new()),
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

    /// 释放本索引持有的统一 Memo 图快照。
    #[napi]
    pub fn clear_memo_runtime(&self) -> Result<()> {
        self.memo_runtime.clear().map_err(Error::from_reason)
    }
}
