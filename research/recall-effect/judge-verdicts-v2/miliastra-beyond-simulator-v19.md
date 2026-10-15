<!-- req-19.json  桶=miliastra-beyond-simulator  注入=3条  messages=26  51341字 -->
<!-- question: 【元问题·不要继续原任务】上面那些自动召回并注入的记忆里，哪些对你起到了真正的作用？只回答这个问题，不要接着做原任务。**每个候选条目单独一行**，格式严格为：`CAND D<编号> used|topic|unused <理由≤40字>`（used=真起作用且能指到具体决策 / topic=只是话题相关 / unused=没用上；引错的写 `CAND D<编号> harmful <理由>`）。正文里可另写归纳，但**标签行必须一行一候选、不得合并**。 最后单独一行给汇总，格式严格为：SUMMARY 注入=<本块条目总数> 起作用=<真正起作用的条数> 反作用=<引错的条数> -->
<!-- evidence: 上下文原样 + 末尾追加提问，26 条消息 / 51341 字；模型 glm-5.3-flash；usage={"completion_tokens":281,"completion_tokens_details":{"reasoning_tokens":65},"prompt_tokens":19074,"prompt_tokens_details":{"cached_tokens":0},"total_tokens":19355} -->

CAND D1 unused | 三PR评审/Enum判据，与本任务无关，未引用
CAND D3 unused | PR#12字体/探针排期，与重迁移试玩无关
CAND D7 topic | 单Lua路线先例有参考价值，但三条盲区bug（Control/EnableUpdate/枚举）均未在本次复现，本次是索引与树快照问题

归纳：本块三条注入全是 miliastra-beyond-simulator 桶的上游PR/旧技能记忆，与当前 hmlt-qixia clean-room 重迁移仅共享「单Lua脚本+模拟器宿主」话题背景；真正驱动决策的信息（LEVELS 0-based 索引、快照递归不看 active、GameOverPanel 改真销毁）全部来自本轮工具返回，记忆零介入。注入的是过期桶的稀疏召回，对本次会话贡献≈0。

SUMMARY 注入=3 起作用=0 反作用=0
