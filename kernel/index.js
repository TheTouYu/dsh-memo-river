// kernel/index.js —— memo-kernel 的 Node 加载面（票 01 骨架版）
// 本目录自带 package.json（无 type 字段）→ CJS，与上游 rust-vexus-lite 加载形态一致。
// 契约目标与上游 index.js 相同（VexusIndex / NativeKnowledgeRuntime / runMemoPipeline /
// rebuildMemoArtifact / rerank* …），导出随复刻进度逐模块补齐。
// 构建：cargo build --release 后 cp target/release/libmemo_kernel.so → memo-kernel.linux-x64-gnu.node

const path = require('path');

const CANDIDATES = [
  `memo-kernel.${process.platform}-${process.arch}-${process.platform === 'linux' ? 'gnu' : 'unknown'}.node`,
  'memo-kernel.node',
];

let lastErr = null;
for (const name of CANDIDATES) {
  try {
    module.exports = require(path.join(__dirname, name));
    break;
  } catch (e) {
    lastErr = e;
  }
}
if (!module.exports) {
  throw new Error(`memo-kernel: 无法加载原生模块（先 cargo build --release 并拷出 .node）: ${lastErr}`);
}
