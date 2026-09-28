# 01 — 立项与骨架：campaign / 分支 / crate 冒烟

**What to build:** kernel-reimpl-0928 campaign 落盘（README 看板 + 11 票）；从 zcode-adapter 头切 `kernel-reimpl` 分支；`kernel/` cargo crate 骨架（依赖集镜像上游 Cargo.toml，napi 冒烟导出 kernel_identity/smoke_add）；`.gitignore` 加 kernel 构建产物；更正 scripts/README.md:80-84 的「已知红 #2」陈旧注记（26dd770 已修，勿让后来者重查）。

**Blocked by:** None — can start immediately.

**Status:** done — 2026-09-28（commit f1af6ec；cargo 全依赖集含 usearch/rusqlite-bundled 编译绿，kernelIdentity/smokeAdd node 26.10 加载实跑；注记更正 dc60b8c）

- [x] `cargo build --release` 绿（上游全依赖集含 usearch/rusqlite-bundled 在本机编译通过——工具链风险最早暴露）
- [x] cdylib 拷为 `memo-kernel.linux-x64-gnu.node`，`node -e "require('./kernel').kernelIdentity()"` 返回标识串（node 26.10）
- [x] `.gitignore` 含 `kernel/target/` 与 `kernel/*.node`
- [x] scripts/README.md 注记更正为「#2 已于 26dd770 修复」口径
- [x] campaign README + 11 票入库，本票 Status 回填 commit 号（第二笔 chore）
