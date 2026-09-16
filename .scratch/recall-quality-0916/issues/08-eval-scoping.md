# 08 — eval-production.py 单会话/单桶作用域

**What to build:** 评估脚本加 `--session <session-id>` 与 `--bucket <桶名>`：`--session` 输出该会话八项指标（含其子代理树聚合：注入数/写入数/引用率/时延/自发性对齐）；`--bucket` 输出桶健康（components/hub/used/pending）。把 2026-09-16 对 c9f838ba 的手工深评流程脚本化，下次深评不再手写取证脚本。

**Blocked by:** None — can start immediately

**Status:** done — 2026-09-16（证据：commit `feat(票08): eval-production.py 单会话/单桶作用域` + 手工验收 4/4 条全过：快照口径复现 30 写（父5+子25）/桶 inject 37（树内 36=父8+子28）/父引用 7/12=58%/used 22/26；SPONT 0/NUDGED 30；hub 80.8%/pending 7；缺省 48h 全扫行为不变、全程只读）

- [x] `--session` 指 c9f838ba 复现本次深评关键数字：30 写入（父5+子25）/37 注入/父引用 7/12=58%/桶 used 22/26
  - 实证：`python3 scripts/eval-production.py --session c9f838ba --until '2026-09-16 02:01'`（快照截止——该会话 09-16 晨已被用户复活续跑，活数会漂移，唯有截止口径可确定性复现）
  - 输出：[2 写入纪律] memo_write 30（父 5 + 子 25）；[3] 桶全量 inject 37（树内 36=父8+子28，即报告 metric1「注入 8+28」）+ gate 全过、单次候选峰值 26；[5] 父引用 7/12=58% + 桶 used 22/26=84.6%
  - 树构建：父流 subagent/catalog childId ∪ 同项目目录 parentSession 链接 → 1+26 会话；bucket 由 plugin.log session-start 定位（子会话无自身记录时沿 parentSession 继承）
- [x] `--session` 附写入自发性对齐（write 前最近 nudge 间隔分布，SPONT/NUDGED 标注）
  - 输出：`[写入自发性] 30 写 = SPONT 0 / NUDGED 30 | nudge→write 间隔 p50=53s max=1556s min=6s` + 逐写标注（父：NUDGED(3m/26m/30s/14s/59s)，19 个写的子代理逐条）
  - 规则与深评一致：write 前无任何 nudge 到达=SPONT，否则 NUDGED(间隔秒)；write 时刻取 tool/call（决策时刻），nudge 取会话流到达时刻
- [x] `--bucket genshin-ts` 输出 hub 80.8%/pending 7 等体检读数
  - 输出：`hub=千星官方课程:21/26=80.8% uncovered=4/26 used=22/26=84.6% Ωmean=0.682(N=12) topUsed=D1×36`、`pending 7 篇（.md 口径，剔除 .status.json 边车）`、日志全量 inject n=37 mean 2311ms
- [x] 缺省行为（48h 全扫）不变；只读不写任何库
  - 缺省路径流程/输出结构不变（--out 缺省仍落 /tmp/mr-eval/summary.json）；唯一共享改动=inject 行正则补 `trigger=compaction` 可选段（修复该形态行漏计，三模式同受益）
  - 只读：仅 zstd 流 + 文本日志读 + /tmp JSON 报告输出，不触任何 sqlite/生产桶；build 成功、acceptance 主套件无我方回归（仅存的 2 失败位于其他票在途 src 道，与本脚本无关）

附加交付（快照复现需要）：`--until` 快照截止参数（--session/--bucket 模式），接受 CST 本地时间或 UTC ISO；输出文件名自动加 `-until` 后缀。JSON 产物：/tmp/mr-eval/session-<id19>(-until).json、bucket-<name>(-until).json。
