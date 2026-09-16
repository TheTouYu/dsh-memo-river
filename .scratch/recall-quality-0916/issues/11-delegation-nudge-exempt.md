# 11 — 委托场景写入引导：堵改疏（用户设计修正）

**What to build:** 把委托场景（子代理/delegation）的写侧策略从「豁免/禁写」反转为**引导高质量写入**（用户拍板：与其堵不如顺着写意，本功能倾向就是让代理写；要治的是质量与重复，不是写的动作）：

① **nudge 委托变体强化**（票 05 已落「先落盘+读者是兄弟代理+写增量」三要素，在此基础上加两条）：**冷门 Tag 建议**——委托变体的建议 Tag 从词汇表里避开枢纽 Tag（hub≥1/3 的不入建议名单）；**同轴合并提示**——检测到本会话/本波已有同轴条目（标题前缀或 Tag 高重叠）时，提示「这是同轴第 N 篇：优先 memo_update 并入前篇或 memo_merge 归一，而非新开篇」。
② **编排模板修正**（技能票 01 联动）：COMMON 块对子代理的写侧指令从「禁止写生产桶」改为「写高质量日记：增量、延续/转折/因果叙事、Tag 避开枢纽并给理由、同轴先合并」。
③ **兜底仍是闸门不是禁令**：hub-gate（票 06）enforce 档 + 去重 0.95 + 标题闸门（票 02）在质量层拦截，不拦「写」本身。

**证据与教训：** recall-quality-0916 工作流我在编排 prompt 里设「禁写生产桶」红线——18 次 memo_write、6 篇落河，红线零抵抗力（docs/EVAL-工作流效率-0916.md R4）；而 c9f838ba 里子代理写日记是知识总线的最佳实证（D18-D21 跨代理共享）。堵是错的，缺的是质量引导。

**Blocked by:** None — can start immediately（依赖票 05 delegation 信号已在 HEAD；hub-gate 待重启生效）

**Status:** done — 2026-09-16（证据：src/nudge-guide.ts 新模块【parseDiaryBrief/scanTagAxis/coldTagSuggest/sameAxisHit 纯 fs 扫描，无 getWorkspace 副作用】+ render.ts DelegationExtras 第 10 参（仅委托分支生效）+ injector.ts delegationExtrasFor 懒取接线（evaluateWriteNudge 加 extrasProvider，pre-step 调用点传闭包）；acceptance-delegation-guidance 6/6（G-1 末 Tag 行取最后/中英顿号都切、G-2 hub 剔除+词汇表补齐、G-3 平票取最新、G-4 委托 4 行+缺省逐字回落+普通场景 extras 无效、G-5 模拟委托波次重叠 2→3、G-6 只读红线 mtime 零变化）；write-prompts 5/5 + title-gate 6/6 回归绿；实现期真 bug ①：小桶 hub 判据失效（1 文件桶 freq=1 即 100% 全判枢纽→建议名单被清空只剩词汇表外 Tag）→加绝对下限 `f≥3 且 f≥files/3`；编排模板条款已同步 orchestration-skill-0916 票 01（验收线从「无子代理日记落河」改为「零枢纽污染」）；主套件回归 37/37 exit 0 全绿）

- [x] 委托变体 nudge 含冷门 Tag 建议（hub Tag 不入建议名单）+ 同轴合并提示，普通场景不变（G-2/G-4/G-5）
- [x] 技能/编排模板（orchestration-skill-0916 票 01）写侧指令改为质量指导，无禁写条款（票 01 What-to-build 已含引导协议+本次验收线修正；技能本体在独立轨道落地）
- [x] 模拟委托波次：连续 3 篇同轴写入，第 2/3 篇触发合并提示；Tag 建议避开枢纽（G-5）
- [x] 兜底验证：质量闸门（dedup/标题/hub-gate）拦截坏写入，好写入全绿放行（hub-gate 8/8 + title-gate 6/6 + 主套件去重项背书，本次回归 title-gate 复跑绿）
