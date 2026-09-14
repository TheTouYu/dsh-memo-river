# 实施启动提示词

把下面这段整段贴给一个 DSH 会话（工作目录建议 `/home/h/app/dsh-memo-river`）：

---

在 `/home/h/app/dsh-memo-river` 实现 `@dsh-external/dsh-memo-river`。**先完整读 `DESIGN.md`，它是唯一依据**；有冲突以它为准，不要自行发挥。

目标：把 VCPToolBox 的 TagMemo/RiverMemo 记忆算法接进 DSH，做成 agent preset `memo-river`——被动注入为主干、工具补证、守护维护。

按 DESIGN.md §12 的三步走，每步做完先自测再进下一步：

- **P1 注入管线（主干）**：`node:sqlite` 建工作区级库（VCP schema，文件名必须 `knowledge_base.sqlite`）→ 嵌入（relayrouter / 3072 维，复用 `/home/h/app/VCPToolBox/EmbeddingUtils.js` 的调用形状）→ 复用 `/home/h/app/VCPToolBox/rust-vexus-lite` 原生内核（`rebuildMemoArtifact` → `runMemoPipeline` → `rerankMemoDtsc` / `rerankRivermemoTopologyV3`）→ `llm/stream` 拦截做**消息尾注入**。
- **P2 工具面**：`memo_recall` / `memo_write`（写前强制回注旧 Tag 词汇 + 相关旧日记 + 枢纽警告）/ `memo_tags` / `memo_stats`。
- **P3 守护与预设化**：timer 维护 + 四项体检 + 草稿；建 `/home/h/.dsh/.agent-presets/memo-river/`（`preset.yml` + `agent.cordis.yml` + `memo-river.mjs` wrapper）。

四条最容易做错的铁律（DESIGN.md §6/§7）：

1. `systemPrompt.context` 只放**固定文本，零动态**（保前缀缓存）；一切动态召回**只走消息尾注入**。
2. `llm/stream` 里必须 `next()` 委托；失败降级为"不注入 + 记日志"，绝不阻塞主流程。
3. 门控不过 → **清空不注入**并带 `fallbackReason`；注入块必须带 `role` / `Ω` / 未注入说明。
4. 会话状态**按 session id 键**，禁止全局 `lastXxx`。

环境事实（已实测，别再假设）：DSH 跑 Node **v26.7.0**；`vexus-lite`（N-API）在 26 上加载正常；`node:sqlite` 可用；`~/.cargo` 只读，重编原生要换 `CARGO_HOME`。

验证素材：`/home/h/app/VCPToolBox/dailynote/教室建模归档/`（11 篇日记，已按作者规范连成一条河）；回归对照脚本 `/home/h/app/VCPToolBox/sandbox/classroom-flow/native.cjs`；孤岛语料回归样本见 DESIGN.md 验收 #7。

验收以 DESIGN.md §10 的 10 条判据为准，逐条给出实测输出（不接受"看起来对"）。做完用 `dev_build_plugin` → `dev_inject_plugin` 验证，再建预设。

---
