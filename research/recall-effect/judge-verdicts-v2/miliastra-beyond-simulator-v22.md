<!-- req-22.json  桶=miliastra-beyond-simulator  注入=3条  messages=76  237114字 -->
<!-- question: 【元问题·不要继续原任务】上面那些自动召回并注入的记忆里，哪些对你起到了真正的作用？只回答这个问题，不要接着做原任务。**每个候选条目单独一行**，格式严格为：`CAND D<编号> used|topic|unused <理由≤40字>`（used=真起作用且能指到具体决策 / topic=只是话题相关 / unused=没用上；引错的写 `CAND D<编号> harmful <理由>`）。正文里可另写归纳，但**标签行必须一行一候选、不得合并**。 最后单独一行给汇总，格式严格为：SUMMARY 注入=<本块条目总数> 起作用=<真正起作用的条数> 反作用=<引错的条数> -->
<!-- evidence: 上下文原样 + 末尾追加提问，76 条消息 / 237114 字；模型 glm-5.3-flash；usage={"completion_tokens":153,"completion_tokens_details":{"reasoning_tokens":64},"prompt_tokens":78163,"prompt_tokens_details":{"cached_tokens":0},"total_tokens":78316} -->

CAND D3 unused 上游PR与probe排期信息与本次单Lua实战无关，未引用
CAND D2 unused 5px拖拽取证链未影响本次任何决策
CAND D6 used R2U架构事实（单Lua交付/控件调度器）直接支撑本次实战路线与vcl设计核查

SUMMARY 注入=3 起作用=1 反作用=0
