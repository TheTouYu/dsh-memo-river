（端点跳闸导致 memo_write 被拒，本篇待重写入库。正文见下方，Tag 行已含。）

# 2026-10-14 D214 三刀落地：查询场白名单化 + 召回失败可见化 + 嵌入预算 3s→8s

**决定性数字**：① 同一份生产日志，旧黑名单查询场 4000 字里**自家注入块占 99.2%**（生产实测 99.1%），新白名单下**只剩用户原话 34 字**；② 全库 115 桶 inject 成功 1241 / skip 1027（**45.3%**，超时类 30.5%），成功注入 elapsedMs **p50=3154ms 本身就超 3000ms 预算**；③ 新回归套件 `scripts/acceptance-queryfield.mjs` **6/6 PASS，零端点依赖**；④ 端点对同一文本**确定性**（4 次独立冷调 cos=1.000000），但尾延时实测 **17.2s**——8s 预算仍会偶发超时，抖动源是延时不是向量。

**A 查询场白名单**（`src/injector.ts`）：`DIALOG_SOURCE_KINDS={user,model,agent-message}`，`isDialogMessage` 由黑名单（只排 plugin/tool）改白名单。`agent-message` 必须留（dsh-subagent `createAgentMessage` 的兄弟代理 relay），否则子会话查询场失明；无 source（老会话/种子）放行。新增 `queryFieldExclusionStats()` 每次注入把被排除 kind 计数落桶日志（`query-field-excluded …`）作为漂移哨兵。

**B 降级可见化**（`render.ts:renderRecallNotice` + `injector.ts:recallFailureNotice`）：只有 `embed-*` / `native-unavailable` / `empty-query-field` 三类通道故障发模型可见短通知；回合首发必发、自主态节流 5 分钟、成功清零 streak。通知 form='notice'，不含 BLOCK_CLOSE，自身也被白名单排除。

**逮到的真 bug（Q-4 立功）**：handler 顶部的 `const wstate = peekSession(...)` 是**本步之前**的快照，会话首个 pre-step 时还是 undefined（SessionState 由 buildTailInjection 内的 getSession 现建）→ 通知在**最该发的那一轮**（新会话首轮）永远发不出。修法：通知分支重新 peek。教训：会话级状态别复用「本轮开始时」的引用。

**C 预算**：`src/config.ts` `inject.embedTimeoutMs` 3000→8000。

**验收归因方法论（本轮最贵的教训）**：主套件跑真端点，端点劣化时同一份代码两次跑红集不相交——HEAD 基线红 #1/#4/#5/#31（29/37），改动后两次红 #17/#32/#37（30/37）与 #8/#10/#14/#17/#21（32/37）；#8/#10 三次全红（含基线）。**没有基线就必然把环境抖动误判成自己的回归**。唯一真属于改动的是 #9（编码旧契约「失败时插件不追加任何消息」），已改为期望一条含「召回未生效」且不含 BLOCK_CLOSE 的通知，改动后通过。残余不确定：#17 改动后两次都红（基线绿），但该用例历史全是 user/model 消息、白名单下查询场逐字不变，未找到机制归因——待复跑定罪。

**悬而未决**：① 端点根治（双端点/本地兜底）未落地，17.2s 尾延时证明预算治不了根；② 主套件缺「无端点依赖」跑法（桩向量会掉到 25/37，只能靠基线对照）；③ #17 复跑定罪；④ 查询场窗口构造（lookback=6 拼接摊平语义）另一票未动。

Tag: 注入时序, 被动召回, 嵌入超时预算, 验收套件, 证据分级
