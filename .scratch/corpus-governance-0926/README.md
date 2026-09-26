# corpus-governance-0926 —— 语料治理与写侧质量（系列第 5 辑）

**由来**：2026-09-26 的「让证据分级活过来」任务（票面见 D84）在 `deepseek-harness@50d29236c1297d2c`
桶上收口，同时暴露出**同族的六个未解问题**——它们不是同一个 bug，而是同一病理在不同层：
**词汇表退化 → 检索锚泛化 → 一切看起来一样可信**。本系列把它们拆成可独立验收的票据。

## 一、已完成的事实（票据的依据，均已实测，勿重查）

| 事实 | 读数 |
|---|---|
| 锚全零的真因 | 不是种子空（seedNodes=8/8）、不是接触算不出（contactedSeeds 70），是**相对量激活闸门在均质池上自封**：`threshold = max(floor, mean + z·σ)`，池内同质时 `mean+2σ ≥ max` ⇒ 激活恒 0。改前 4/4 查询逐条命中 |
| 修法与效果 | 8 个流程词 → 29 个内容词；artifact 8/48 → 29/178；Ω 0.2575–0.2670 sparse → 0.4111–0.9954（3/4 dense）；anchor 0/20 → 2/20；`direct_answer` **首次晋升 2 例**（contrast 36.0× / second=0）；Tag 5/20=0.250<1/3；连通分量=1；正文 20/20 逐字节一致；孤儿 Tag=0 |
| 未改一行 Rust | 「JS 侧给 `rerankTopologyV3` 传 `config` 覆写常数」是可行后手（`rivermemo_topology_v3.rs:195-197` `#[serde(default, rename_all="camelCase")]`、无 `deny_unknown_fields`；`src/native.ts:454-492` 目前不传），本轮不需要 |

## 二、未解问题 → 票据

| # | 问题 | 票 |
|---|---|---|
| 三级证据只两级可达 | `structural_explanation` 要求 `mode != "atomic"`（`rivermemo_topology_v3.rs:2231/:2238`），而实测 6/6 查询（含 60+ 字命题式/叙事式）全判 atomic | 01 |
| 草稿是机械拼装 + Tag 复现环 | 草稿正文＝回合原文摘录（`src/daemon.ts:244-262`）；建议 Tag＝**被动召回命中**（`src/index.ts:399-402`）⇒ 召回枢纽词 → 草稿建议它 → 批准写回它 → 枢纽更强 | 02 |
| 写侧提示词在教人复用枢纽词 | nudge「Tag 优先复用词汇表」+ 契约段；且无「不复述工具输出」的反流水账锚 | 03 |
| 本项目自己的桶同款病理 | `dsh-memo-river` 81 篇 / 19 Tag 全是流程词，三枢纽超 1/3（归因错误 29、写入去重 29、被动召回 27） | 04 / 05 |
| 治理判据散落在一次性脚本里 | max freq / 连通分量 / 孤儿 Tag / 正文完整性 | 06 |
| 收尾项 | 草稿队列 7 篇、hub 闸门档位、`deepseek-harness` 4 篇裸 Tag 行、两桶分叉 | 07 |
| 契约源头分叉 | `DESIGN.md` §6.1（1597B、规范 ①–⑦、sha `b08590b5…`）≠ 上线 `FIXED_CONTRACT_TEXT`（2025B、四 role + 规范 ⑧、sha `b5260237…`），而常量记的是 **DESIGN 侧**哈希 ⇒ `acceptance.mjs` #2 算术上必红（票 01 执行途中发现，非本轮引入） | 08 |

## 三、依赖图

```
01 ──> 02 ──> 04 ──> 05 ──> 07
 └───> 03 ────────────┘
06（独立，可与 01 并行）
08（独立，但必须先于 03 —— 改契约之前先让源头自洽）
```

## 三点五、执行途中新增的证据（2026-09-26）

- **复现环已在生产活起来**：`deepseek-harness` 桶 retag 后长到 **22 篇**，新增两篇（file id 43/45）仍复用流程词
  `上游同步` ⇒ 该词 **7/22 = 0.318**，正逼近 1/3 判据位。这正是票 02（草稿建议 Tag 取自被动召回命中）
  ＋票 03（nudge 教「优先复用词汇表」）要堵的那条路。
- **票 01 定论**：`queryMode` 由**观测图拓扑**派生，与查询措辞无关；10 种形态（含 3 种 ≥40 字长句）**10/10 atomic**，
  `effectiveDepth` 恒 0.02–0.04 ⇒ `structural_explanation` 在当前语料规模下结构性不可达（记入 `DESIGN.md` §6.1.1）。
- **沙箱会话的两个环境坑（不是产品问题，但会让「回归」假红）**：
  1. `/var/tmp` 在 workspace-write 沙箱里不可写 ⇒ 套件 `mkdtempSync` 报 EROFS（已修：改走 `TMPDIR`，commit `927e23d`）；
  2. 主套件用**环境里的 `DSH_HOME`** 建/清自净桶，会话若跑在沙箱根（`.compat/rehearsal/browser`）会在 cleanup 阶段
     EROFS 崩在 `scripts/acceptance.mjs:514` ⇒ 必须显式 `DSH_HOME=<workspace>/.selftest/dsh-home`。
  标准跑法：`TMPDIR=$PWD/.scratch/tmp DSH_HOME=$PWD/.selftest/dsh-home node scripts/acceptance.mjs`


## 四、执行纪律（本仓既有红线 + 本系列新增）

1. **一次重启窗口覆盖 01/02/03**：三张票都改 `src/`，必须同批 `bash scripts/build.sh` + 重启 DSH 才进预设代——分两次重启等于把对照条件打乱。04/05 是数据手术，不受重启影响。
2. **生产桶手术三件套**：先 `cp -a` 整桶备份进工作区（**不放 /tmp**）→ 脚本自证读数 → 再动。`/home/h/.dsh/**` 在会话工作区之外，写盘需一次性全权限沙箱（EROFS 发生在盘上文件写入、DB 事务之前，失败后**仍须**按句式核对桶内零残留）。
3. **`DSH_HOME` 决定桶根，不由 cwd 决定**：本机存在**同名同哈希**的两个 `dsh-memo-river` 与两个 `deepseek-harness`（生产根 `/home/h/.dsh` vs 沙箱根 `.compat/rehearsal/browser`）。任何时候先打印 `resolveBucket()` 的 root 核对再写。
4. **一个主题一个提交**；判据=可复现读数，不接受「看起来对了」；票面 `Status` 回填 commit 号。
5. 桶的选择（已定）：04/05 治**生产根** `/home/h/.dsh/memo-river/6c8bcf85fe1b56e1`（81 篇，用户真实会话用；2026-09-17 后无写入）；沙箱副本（82 篇，本会话在写）只在 07 里定处置。
