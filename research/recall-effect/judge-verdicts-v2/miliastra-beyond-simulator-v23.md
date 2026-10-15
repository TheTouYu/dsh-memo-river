<!-- req-23.json  桶=miliastra-beyond-simulator  注入=2条  messages=39  207243字 -->
<!-- question: 【元问题·不要继续原任务】上面那些自动召回并注入的记忆里，哪些对你起到了真正的作用？只回答这个问题，不要接着做原任务。**每个候选条目单独一行**，格式严格为：`CAND D<编号> used|topic|unused <理由≤40字>`（used=真起作用且能指到具体决策 / topic=只是话题相关 / unused=没用上；引错的写 `CAND D<编号> harmful <理由>`）。正文里可另写归纳，但**标签行必须一行一候选、不得合并**。 最后单独一行给汇总，格式严格为：SUMMARY 注入=<本块条目总数> 起作用=<真正起作用的条数> 反作用=<引错的条数> -->
<!-- evidence: 上下文原样 + 末尾追加提问，39 条消息 / 207243 字；模型 glm-5.3-flash；usage={"completion_tokens":196,"completion_tokens_details":{"reasoning_tokens":92},"prompt_tokens":74117,"prompt_tokens_details":{"cached_tokens":0},"total_tokens":74313} -->

CAND D3 topic | probe 真机排期仍悬置，本轮未涉及
CAND D1 used | addScript 漏传 controlAsset 教训→本轮显式传参验证分流
CAND D5 used | 单Lua/冻结存档判据直接决定本轮建模板方式
CAND D2 topic | PR 评审内容与试玩闭环无关

SUMMARY 注入=4 起作用=2 反作用=0
