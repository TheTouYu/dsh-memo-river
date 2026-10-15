<!-- req-16.json  桶=miliastra-beyond-simulator  注入=3条  messages=8  36545字 -->
<!-- question: 【元问题·不要继续原任务】上面那些自动召回并注入的记忆里，哪些对你起到了真正的作用？只回答这个问题，不要接着做原任务。**每个候选条目单独一行**，格式严格为：`CAND D<编号> used|topic|unused <理由≤40字>`（used=真起作用且能指到具体决策 / topic=只是话题相关 / unused=没用上；引错的写 `CAND D<编号> harmful <理由>`）。正文里可另写归纳，但**标签行必须一行一候选、不得合并**。 最后单独一行给汇总，格式严格为：SUMMARY 注入=<本块条目总数> 起作用=<真正起作用的条数> 反作用=<引错的条数> -->
<!-- evidence: 上下文原样 + 末尾追加提问，8 条消息 / 36545 字；模型 glm-5.3-flash；usage={"completion_tokens":242,"completion_tokens_details":{"reasoning_tokens":73},"prompt_tokens":15874,"prompt_tokens_details":{"cached_tokens":0},"total_tokens":16116} -->

CAND D3 topic|探针/真机测试话题相关，但未指向具体决策
CAND D2 unused|拖拽阈值取证链与本交付任务无关
CAND D7 used|runtime 差异（id vs Id、updateEnabled 等）直接进了真机风险表
CAND D6 unused|未注入，未起作用
CAND D1 unused|未注入，未起作用

归纳：真正起作用的是 D7 的运行时差异实证（尤其控件 id 字段与假宿主盲区教训），支撑了风险排查重点的排序；D3 仅话题相邻；D2 与本任务无关。注入 5 条中 2 条被截断未生效。

SUMMARY 注入=5 起作用=1 反作用=0
