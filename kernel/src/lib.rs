//! memo-kernel —— vexus-lite 记忆内核复刻（票 01 骨架）
//!
//! 目标：行为等价复刻上游 `rust-vexus-lite`（13,598 行 / 8 文件），
//! 判据 = 差分对账（kernel/tools/diff-runner.mjs），不追 bit-exact。
//! 文件拆分将镜像上游：memo_artifact_builder / memo_pipeline / memo_sensing /
//! memo_dtsc / rivermemo_topology_v3 / knowledge_runtime / result_deduplicator / lib。
//!
//! 红线（票 ⑥ 教训，第一天就生效）：一切 HashMap→f64 累加路径必须定序
//! （排序或 BTreeMap 后累加），确定性是属性测试不是运气。

use napi_derive::napi;

/// 内核标识：差分对账器用它区分双轨来源。
#[napi]
pub fn kernel_identity() -> String {
    format!("memo-kernel/{} (reimpl of vexus-lite)", env!("CARGO_PKG_VERSION"))
}

/// N-API 冒烟导出：证明 .node 加载链与 napi 绑定面活着。
#[napi]
pub fn smoke_add(a: f64, b: f64) -> f64 {
    a + b
}
