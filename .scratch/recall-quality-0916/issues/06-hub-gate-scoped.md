# 06 — hub Tag 写入闸门场景化（子代理防推爆）

**What to build:** 会话形态感知的 hub 闸门：**autonomous/delegation 会话**（injectMode=autonomous 或 delegationDepth>0）写入已枢纽化 Tag（桶内频次 ≥1/3）时，从软警告升级为**可配置硬拒**——拒绝并给出词汇表内替代 Tag 建议；交互会话保持现状软警告。开关落 preset 级（tuning），缺省建议模式（先观察后收紧）。与 perf-funnel-0915 票 08（存量三桶手术）衔接：手术后本票防复发。

**证据：** c9f838ba 一夜 26 子代理 25 篇把「千星官方课程」推到 21/26=80.8%（health round=27 告警）；写侧枢纽警告全部触发但**全部放行**（D55/D58）。dsh-memo-river 本桶同病：「记忆自驱」42%。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 模拟委托会话写枢纽 Tag：被拒 + 收到词汇表内替代建议
- [ ] 交互会话：仅软警告（现状回归）
- [ ] 开关可控（preset 级），缺省建议模式有观察说明
- [ ] acceptance 用例；附对 dsh-memo-river「记忆自驱」场景的试运行效果说明
