<!-- req-11.json  桶=genshin-ts  注入=19条  messages=29  35837字 -->
<!-- question: 【元问题·不要继续原任务】上面那些自动召回并注入的记忆里，哪些对你起到了真正的作用？只回答这个问题，不要接着做原任务。**每个候选条目单独一行**，格式严格为：`CAND D<编号> used|topic|unused <理由≤40字>`（used=真起作用且能指到具体决策 / topic=只是话题相关 / unused=没用上；引错的写 `CAND D<编号> harmful <理由>`）。正文里可另写归纳，但**标签行必须一行一候选、不得合并**。 最后单独一行给汇总，格式严格为：SUMMARY 注入=<本块条目总数> 起作用=<真正起作用的条数> 反作用=<引错的条数> -->
<!-- evidence: 上下文原样 + 末尾追加提问，29 条消息 / 35837 字；模型 glm-5.3-flash；usage={"completion_tokens":305,"completion_tokens_details":{"reasoning_tokens":79},"prompt_tokens":18804,"prompt_tokens_details":{"cached_tokens":0},"total_tokens":19109} -->

CAND D262 used|直接约束本轮分诊复核的判据与结论（勿再全量复读）
CAND D52 topic|Tag 搭桥教训相关，但本轮未动 Tag 治理
CAND D258 unused|Lua wire 内容与本轮分诊/日记无关
CAND D78 unused|K8 专题仅同轴提示，未采纳
CAND D53 unused|专题写作轴无关
CAND D81 used|佐证「多篇同轴应合并」判断，支持复用 Tag 不新开篇
CAND D55 unused|枢纽告警方法论本轮未触发
CAND D117 unused|环境迁移/字幕轨与本题无关
CAND D115 topic|客户端Lua同轴，未影响决策
CAND D47 used|提醒枢纽检查与 Tag 纪律，写 D263-265 时复用词表
CAND D1 unused|代理加速常识未用上

SUMMARY 注入=11 起作用=3 反作用=0
