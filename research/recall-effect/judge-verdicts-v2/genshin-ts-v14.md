<!-- req-14.json  桶=genshin-ts  注入=27条  messages=37  52847字 -->
<!-- question: 【元问题·不要继续原任务】上面那些自动召回并注入的记忆里，哪些对你起到了真正的作用？只回答这个问题，不要接着做原任务。**每个候选条目单独一行**，格式严格为：`CAND D<编号> used|topic|unused <理由≤40字>`（used=真起作用且能指到具体决策 / topic=只是话题相关 / unused=没用上；引错的写 `CAND D<编号> harmful <理由>`）。正文里可另写归纳，但**标签行必须一行一候选、不得合并**。 最后单独一行给汇总，格式严格为：SUMMARY 注入=<本块条目总数> 起作用=<真正起作用的条数> 反作用=<引错的条数> -->
<!-- evidence: 上下文原样 + 末尾追加提问，37 条消息 / 52847 字；模型 glm-5.3-flash；usage={"completion_tokens":215,"completion_tokens_details":{"reasoning_tokens":63},"prompt_tokens":27587,"prompt_tokens_details":{"cached_tokens":0},"total_tokens":27802} -->

CAND D117 topic | 字幕轨/browser-harness 与本轮分诊无关，仅作背景
CAND D262 used | 本轮任务核心先例：判据（字面命中率是废指标）、抽正文找 D 编号、70 篇结论均据其接续
CAND D81 topic | 合并方法论与草稿治理同族，但本轮未直接引用其决策
CAND D47 topic | 去枢纽化提醒影响 Tag 谨慎度，但无具体决策可指
CAND D1@常识库 unused | 代理加速与分诊任务完全无关

SUMMARY 注入=5 起作用=1 反作用=0
