# kernel/prebuilt —— 随仓预编译内核

目的：**让没有 Rust 工具链的人也能先把插件跑起来**。`scripts/setup.mjs` 的策略是
「有 cargo 就源码编译，没有才用这里」。

| 目录 | 平台 | 来源 |
|---|---|---|
| `win32-x64/memo-kernel.win32-x64-unknown.node` | Windows x64 | 2026-11-25 本机 `cargo build --release`（rustc 1.100 MSVC），源 = 提交 `105fca0` 的 `kernel/` |

## 注意

- **预编译件可能落后于 `kernel/` 源码**。改过内核后必须重编并覆盖本目录，
  否则用户拿到的是旧行为（`node scripts/doctor.mjs` 的 kernel 行会显示它导出了什么）。
- 它不是 gitignore 的 `kernel/*.node`（那条只匹配 `kernel/` 下一层），所以能入库。
- 只有 Windows x64 有预编译。Linux / macOS 需要 Rust：
  `curl https://sh.rustup.rs -sSf | sh`（Windows 用 rustup + VS Build Tools C++ 负载），
  然后 `node scripts/setup.mjs --kernel-only`。
- 换预编译件请走「临时文件 + rename」（`setup.mjs` 已这么做）：`cp` 原地覆盖会改写
  已 mmap 的同一 inode，是 2026-10-22 四连崩事故的成因。
