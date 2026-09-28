# kernel-reimpl-0928 —— vexus-lite 内核复刻（系列第 6 辑，首个子项目级 campaign）

**由来**：记忆河流的核心算法直依赖上游 `~/app/VCPToolBox/rust-vexus-lite` 二进制（同心脏、不同躯壳，D119 定格）。2026-09-28 前置资产盘点齐备（D169-D171）：源码 8 文件 13,598 行在位、oracle 对照台 classroom-flow 修通且 66/66 bit-exact、cargo 1.98.1 可用。用户拍板按项目推进，容器 = dsh-memo-river 子项目（`kernel/`），蓝图 = `docs/PLAN-vexus-kernel-reimplementation-benchmark.md` v1。分支 `kernel-reimpl`（自 zcode-adapter 头切出——zcode-adapter/ 目录被已装 ZCode 插件按绝对路径引用，不能从 main 切）。

## 一、已完成的事实（票据依据，均已实测，勿重查）

| 事实 | 读数 |
|---|---|
| oracle 本机复现 | classroom-flow native.cjs vs WSL 录制结果：66/66 条目一致，最大数值差 0.000e+0（D171，bit-exact） |
| Rust 工具链 | rustc/cargo 1.98.1（本机），上游依赖集含 usearch/rusqlite-bundled 可编译（票 01 验证） |
| 上游依赖基线 | Cargo.toml 镜像：napi 2.16 / rusqlite 0.29 bundled / nalgebra 0.32 / usearch 2.8 / rayon 1.10——**勿随手升级，同版本是差分数值可比的前提** |
| 已知红 #2 | 已于 26dd770 修复（DESIGN §6.1 对齐上线文本，三处逐字节一致）；scripts/README.md:80-84 注记系陈旧文档，票 01 顺手更正 |
| 内核切换面 | `src/native.ts:92 loadVexus(vcpRoot)` 单点 require；vcpRoot 默认 `/home/h/app/VCPToolBox`（src/config.ts:314） |
| 差分判据口径 | 名次完全一致 / 分数 ±1e-6 / enhancedVector 余弦 ≥0.999999 / Ω 与角色相等（PLAN §4，行为等价不追 bit-exact） |
| 许可证 | 上游 CC BY-NC-SA：复刻物自用无碍、分发受限（与现状同） |

## 二、未解问题 → 票据

| # | 问题 | 票 |
|---|---|---|
| 立项 | campaign 骨架 / 分支 / crate 冒烟 / 陈旧注记 | 01 |
| 阶段② | 差分对账器（双轨驱动 + 比较 + 自校验 + 回放） | 02 |
| 阶段① | topology_v3 2897 行未逆向（打分心脏） | 03 |
| 阶段① | memo_dtsc 1655 行未逆向 | 04 |
| 阶段① | knowledge_runtime 1536 行未逆向 | 05 |
| 阶段① | lib.rs 4285 行 N-API 面/运行时未逆向（契约面已熟） | 06 |
| 阶段③ | 复刻 artifact_builder（861 行，票⑥逐行修过） | 07 |
| 阶段③ | 复刻 pipeline + sensing（1550+529 行） | 08 |
| 阶段③ | 复刻 topology_v3 + dtsc（深水区 4552 行） | 09 |
| 阶段③ | 复刻 runtime + NAPI 绑定面 | 10 |
| 阶段④ | 收口与切换（config.native.kernel 开关） | 11 |

## 三、依赖图

```
01 ──> 02 ──> 07 ──> 08 ──> 09 ──> 10 ──> 11
          └──> 03 ─────────────┘（逆向票 03-06 可与 07-08 并行，
              └──> 04 ──────────  09 开工前必须 03/04 done）
                   └──> 05
                        └──> 06（06 在 10 前完成即可）
```

## 四、执行纪律

1. **验收先行**：写复刻代码前，对应模块的差分腿必须已在 02 对账器里就位（oracle vs oracle 绿是前置）。
2. **确定性红线**：一切 HashMap→f64 累加路径定序（票⑥教训）；每模块首个 PR 必带「同输入连跑输出逐位一致」属性测试。
3. **一个主题一个提交**；判据 = 可复现读数，不接受「看起来对了」；票面 `Status` 回填 commit 号（引用哈希的回填拆第二笔 chore 提交，D156 教训）。
4. **只 add 自己的文件**：工作树里有用户先行删除 `.scratch` 的未提交状态，不属于本 campaign，不得卷入提交。
5. **生产桶只打副本**（cp sqlite+wal+shm 三件套到 /tmp），live 库有 rust keepalive 连接（§11 教训）。
6. 上游依赖版本冻结；升级 = 单独票 + 全量差分重跑。
