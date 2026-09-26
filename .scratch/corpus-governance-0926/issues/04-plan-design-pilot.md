# 04 — 本项目桶 Tag 词汇表设计（PLAN 外置 + 15 篇试跑）

**What to build:** 给 `dsh-memo-river` 桶做与 `deepseek-harness` 同款手术的第一步：**设计**新词汇表并小样试跑。
（执行与全量读数在票 05。）

**目标桶（已定）**：**生产根** `/home/h/.dsh/memo-river/6c8bcf85fe1b56e1`
——81 篇 / 19 Tag，全是流程词，三枢纽超 1/3：`归因错误` 29、`写入去重` 29、`被动召回` 27（对照判据 <1/3）。
沙箱副本（`.compat/rehearsal/browser/memo-river/6c8bcf85fe1b56e1`，82 篇/20 Tag，本会话在写）**不治**，处置见票 07。

**要做**：
1. **`scripts/retag-content-tags.mjs` 增 `--plan <json>`**：PLAN 外置（内置表保留为 deepseek-harness 默认），
   JSON 形状 `{ "1": ["TagA","TagB",…], … }`（键=**chunk id 口径**的 D 编号，脚本已落 `file-map.json` 兜底复跑）。
   自检三条保持硬性：每篇 **3–5** 个、Tag **≤20 字**、每个 Tag **跨篇 ≤ 81/3 的下界（=27，实操定 20–25 更稳）**。
2. **设计 PLAN**：读 81 篇的标题 + 正文首段（`chunks.content` 前 ~600 字）→ 主题聚类 → **25–35 个内容词 Tag** →
   逐篇分配。硬约束：
   - **连通分量 = 1**：`connectedComponents`（`src/health.ts:102-138`）遍历 `tags` 表**全量**，
     孤儿 Tag 自带一个分量 ⇒ 旧 19 个 Tag 各须至少保留在 1 篇里（且该篇的其他 Tag 接得上主图）；
   - 每篇都要与别的篇共享 ≥1 个多篇 Tag（否则该篇的整个 Tag 集成为孤岛）；
   - 不做「同义换皮」：新 Tag 与旧 Tag 的余弦须 < 0.92（写侧闸门 `synonym-of-existing-tag`）。
   产出 `.scratch/corpus-governance-0926/plan-dsh-memo-river.json` + 设计说明（词表 → 篇数分布 → 与旧表的对照）。
3. **15 篇试跑**（桶副本内）：`DSH_HOME=<副本根> node scripts/retag-content-tags.mjs --apply --plan …`，
   拿三项读数：max freq、连通分量、正文逐字节；再用 `scripts/probe-anchor-trace.mjs`
   （`PROBE_SRC=<副本>`）对同 4 个查询取 before/after。

**判据（可复现读数）**：
- [ ] `plan-dsh-memo-river.json`：每篇 3–5 个、Tag ≤20 字、跨篇 ≤25、**连通分量 = 1**、旧 19 词各保留 ≥1 篇
- [ ] 15 篇试跑：15/15 改写成功、正文 15/15 逐字节一致、目标桶读数（max freq <1/3、components=1）
- [ ] before/after 探针读数（同 4 查询：Ω / regime / anchor max / promoted）落 `.scratch/corpus-governance-0926/04-pilot.md`
- [ ] 设计说明写清「为什么是这些内容词」（每词一句话），供三个月后接手者复核

**Blocked by:** 02（先堵 Tag 复现环，否则新词汇表会以同一路径漂回枢纽）。
若要看效果而提前做：票面须标注「复现环未堵的临时态」，并在票 05 之后重跑一次 max freq 观察漂移。

**Status:** 待办 — 2026-09-26

- [ ] 脚本支持 `--plan`
- [ ] 81 篇主题聚类 → 词表 + 分配表（JSON + 设计说明）
- [ ] 15 篇试跑三项读数 + 探针 before/after
