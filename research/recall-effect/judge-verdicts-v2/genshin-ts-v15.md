<!-- req-15.json  桶=genshin-ts  注入=27条  messages=42  64022字 -->
<!-- question: 【元问题·不要继续原任务】上面那些自动召回并注入的记忆里，哪些对你起到了真正的作用？只回答这个问题，不要接着做原任务。**每个候选条目单独一行**，格式严格为：`CAND D<编号> used|topic|unused <理由≤40字>`（used=真起作用且能指到具体决策 / topic=只是话题相关 / unused=没用上；引错的写 `CAND D<编号> harmful <理由>`）。正文里可另写归纳，但**标签行必须一行一候选、不得合并**。 最后单独一行给汇总，格式严格为：SUMMARY 注入=<本块条目总数> 起作用=<真正起作用的条数> 反作用=<引错的条数> -->
<!-- evidence: 上下文原样 + 末尾追加提问，42 条消息 / 64022 字；模型 glm-5.3-flash；usage={"completion_tokens":230,"completion_tokens_details":{"reasoning_tokens":68},"prompt_tokens":33252,"prompt_tokens_details":{"cached_tokens":0},"total_tokens":33482} -->

CAND D117 unused | 讲 B站字幕/browser-harness 环境，与本任务无关
CAND D262 used | 本轮已写入的分诊日记，召回正文佐证判据与 3 缺口结论
CAND D81 used | 「同任务多篇重复→合并」先例，支撑 70 篇全丢弃决策
CAND D115 topic | 模拟器/客户端Lua 同桶背景，未参与分诊决策
CAND D47 topic | 记忆治理方法论背景，本判定直接依据是 D262/D118
CAND D1 unused | 代理环境常识，本任务无网络抓取，未用到

SUMMARY 注入=6 起作用=2 反作用=0
