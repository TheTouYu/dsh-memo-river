<!-- req-03.json  桶=dsh-plugins  注入=19条  messages=57  268006字 -->
<!-- question: 【元问题·不要继续原任务】上面那些自动召回并注入的记忆里，哪些对你起到了真正的作用？只回答这个问题，不要接着做原任务。**每个候选条目单独一行**，格式严格为：`CAND D<编号> used|topic|unused <理由≤40字>`（used=真起作用且能指到具体决策 / topic=只是话题相关 / unused=没用上；引错的写 `CAND D<编号> harmful <理由>`）。正文里可另写归纳，但**标签行必须一行一候选、不得合并**。 最后单独一行给汇总，格式严格为：SUMMARY 注入=<本块条目总数> 起作用=<真正起作用的条数> 反作用=<引错的条数> -->
<!-- evidence: 上下文原样 + 末尾追加提问，57 条消息 / 268006 字；模型 glm-5.3-flash；usage={"completion_tokens":518,"completion_tokens_details":{"reasoning_tokens":68},"prompt_tokens":92365,"prompt_tokens_details":{"cached_tokens":0},"total_tokens":92883} -->

CAND D30 unused 会话收尾清单，与本会话任务无交集
CAND D134 unused 鲸鱼GUI案，未参与任何决策
CAND D60 unused 内存归因方法论未用到（本会话无内存问题）
CAND D131 unused 会话复现技巧未用到
CAND D94 used 「先拿现成的别自写」判据影响了技能优化走改既有 search.mjs 而非重写
CAND D8 unused 数据恢复案，无关
CAND D85 unused 写日记节律参考价值弱，按提醒执行即可
CAND D88 unused 组合器压制闸门，无关
CAND D229 unused 嵌入端点勘误，无关
CAND D16 unused 契约测试教训，无关

CAND D149 used 本会话 dsh-ops 研究的接续锚点——组件模型/权限桥接结论直接延续，避免重读
CAND D110 used 报告自审参照其「批判性自审+证据化」口径组织汇报结构
CAND D96 unused skill-switches 全链路，无关
CAND D51 unused 升级预演结论，无关
CAND D12 unused 基准验证数字，无关
CAND D113 used 三篇孤岛日记之一，修连通分量时直接提供了 Tag 归因证据
CAND D138 unused 身份句残余图，无关
CAND D176 unused SIGBUS 设计，无关
CAND D95 unused 千星奇域笔记，纯噪音
CAND D185 unused SIGBUS 验收数字，无关
CAND D88 topic 重复注入，仍无关
CAND D2 used 「敷衍=有说得过去的答案就停」正是本次用户批评的既有判据，修复思维直接对齐
CAND D3 used 交付前自审三问支撑了「顺手修+验证收敛」的执行方式
CAND D91 unused 注入审计方法，无关

SUMMARY 注入=24 起作用=6 反作用=0
