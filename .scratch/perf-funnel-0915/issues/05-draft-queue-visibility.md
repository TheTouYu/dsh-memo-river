# 05 — 草稿队列可见性（nudge 带队列数 + 面板常显）

**What to build:** 把「草稿漏斗断裂」暴露到每天都看的地方：① write-nudge 提醒文案追加「草稿队列 N 篇待批（最老 X 小时）」；② 调参面板（tuning panel）顶部常显各桶 pending 计数与最老草稿年龄，队列空时明确显示 0 而非空白。用户视角：不用跑脚本就知道有多少回合摘要躺在队列里等处理（09-15 实测：preset-composer 33 篇、memo-river 6 篇，采集 133 vs 批准 0）。

**Blocked by:** None — can start immediately.

**Status:** done — 2026-09-15（nudge 带「草稿队列 2 篇待批（最老 27 小时）」+ 面板各桶常显 0/计数；acceptance #35 全绿 35/35 + shared-routes 6/6；三生产桶只读核对 stats≡文件系统 34/8/1）

- [x] 真实 write-nudge 文案含队列计数与最老年龄；队列为空时不显示误导性数字
- [x] 面板可见各桶 pending 计数（含当前为 0 的桶）
- [x] 计数与 pending/ 目录实际文件数一致（抽三桶核对）
- [x] nudge 文案长度受控，不挤占原提醒信息

**notes（实现口径）:**
- 计数/年龄原语在 `src/drafts.ts`：`pendingQueueStats(pendingDir)`（单桶，只读永不抛，计数=pending/*.md 实际文件，年龄=最老 mtime）与 `bucketQueueStats()`（全部桶，含 0 桶，pending 降序）。nudge 与面板共用同一读数。
- nudge 渲染：`src/render.ts` `renderWriteNudge` 追加第 3 行「草稿队列 N 篇待批（最老 X）——可提示用户处理（看草稿 / 批准 / 丢弃）」，仅 pending>0 时追加；原两行提醒逐字保留。`src/injector.ts` `evaluateWriteNudge` 新增懒取 `queueProvider`（确认要发才扫目录，读数失败不出数字）。
- 面板：`src/tuning.ts` `TuningSnapshot.draftQueue` + PANEL_HTML 顶部队列表（桶/待批/最老年龄/合计，0 桶显 0，空根显「尚无工作区桶」），JS 拼接不用 `${}`（模板字面量内嵌约束）。
- 票06 扩展形状：`BucketQueueEntry` 为对象（hash/bucket/cwd/pending/oldestAgeHours），预审三态标记作为同条目额外字段挂入，面板 `renderQueue` 行尾加列即可——类型与 JS 两处均留注释标记。
- 验证环境说明：共享工作树同期有票 01/02/03 的在途改动（config.ts embedTimeoutMs 等）触发 SIGBUS（与 D28 记录的并发验收 SIGBUS 同族）；本票在隔离树（HEAD + 仅本票改动）完成 build + acceptance 35/35 + shared-routes 6/6。commit 中 src/injector.ts 不含票 01 的 2 行 embedTimeoutMs 在途 hunk（其依赖未提交的 config.ts；工作树内保持原样，由票 01 随 config.ts 一并提交）。
- 行号漂移：票面提示的渲染处实际在 src/render.ts/renderWriteNudge（非 prompt.ts——那是编译期常量）、面板在 src/tuning.ts PANEL_HTML（无独立 panel/ 目录），语义一致。
