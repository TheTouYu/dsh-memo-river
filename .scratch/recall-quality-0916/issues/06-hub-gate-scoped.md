# 06 — hub Tag 写入闸门场景化（子代理防推爆）

**What to build:** 会话形态感知的 hub 闸门：**autonomous/delegation 会话**（injectMode=autonomous 或 delegationDepth>0）写入已枢纽化 Tag（桶内频次 ≥1/3）时，从软警告升级为**可配置硬拒**——拒绝并给出词汇表内替代 Tag 建议；交互会话保持现状软警告。开关落 preset 级（tuning），缺省建议模式（先观察后收紧）。与 perf-funnel-0915 票 08（存量三桶手术）衔接：手术后本票防复发。

**证据：** c9f838ba 一夜 26 子代理 25 篇把「千星官方课程」推到 21/26=80.8%（health round=27 告警）；写侧枢纽警告全部触发但**全部放行**（D55/D58）。dsh-memo-river 本桶同病：「记忆自驱」42%。

**Blocked by:** None — can start immediately

**Status:** done — 2026-09-16（证据：commit `918c0e4` + acceptance-hub-gate 8/8；主套件回归 36/37 与 merge 态基线持平；生产桶 /tmp 副本试运行三档行为符合预期——见 DESIGN §7.1.4「试运行」）

- [x] 模拟委托会话写枢纽 Tag：被拒 + 收到词汇表内替代建议（H-2/H-4：delegationDepth=1 与 injectMode=autonomous 两路信号都验）
- [x] 交互会话：仅软警告（现状回归）（H-3：enforce 档下交互写放行，仅「枢纽警告」软警告，无闸门痕迹）
- [x] 开关可控（preset 级），缺省建议模式有观察说明（H-1/H-5：缺省 1=suggest 放行+【hub 闸门·观察】段+hub-gate-observe 日志行；memo_tuning preset 落盘 tuning.json 即时生效，0=off 回滚位）
- [x] acceptance 用例；附对 dsh-memo-river「记忆自驱」场景的试运行效果说明（scripts/acceptance-hub-gate.mjs H-1..H-8；试运行：files=70 桶 记忆自驱 25/70=35.7% ≥1/3，enforce 拒+替代建议「归因错误×23 写入去重×23 …」，suggest 观察，交互放行）

实现要点（与票02 同区，写路径共用核心 writeDiaryCore 步 2.5）：
- 信号面（探明写侧可拿的三个）：exec 头 `delegationDepth>0`（viewerOf 扩展）> `delegationActive` 闩锁（票05）> `SessionState.lastInjectMode`（本票新增：injector 每 pre-step 持久化 isTurnStart 判定）。
- 档位 `write.hubGateMode`：0=off / 1=suggest（缺省）/ 2=enforce；preset 级（memo_tuning/tuning.json/面板，TUNING_SPEC 首个 write 段键）。
- 频次口径 = 桶内跨篇数（tagFrequency() 跨桶全局口径会错分母，写侧单独算）；豁免：memo_merge（去枢纽手术工具）与 memo_update 目标自身已有 Tag（跨篇数不 +1）。
- 覆盖 memo_write/update/approve 三入口（approve 按批准者会话形态算——D10 机械批准对位）。
