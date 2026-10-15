<!-- req-07.json  桶=dsh-plugins  注入=20条  messages=37  164307字 -->
<!-- question: 【元问题·不要继续原任务】上面那些自动召回并注入的记忆里，哪些对你起到了真正的作用？只回答这个问题，不要接着做原任务。**每个候选条目单独一行**，格式严格为：`CAND D<编号> used|topic|unused <理由≤40字>`（used=真起作用且能指到具体决策 / topic=只是话题相关 / unused=没用上；引错的写 `CAND D<编号> harmful <理由>`）。正文里可另写归纳，但**标签行必须一行一候选、不得合并**。 最后单独一行给汇总，格式严格为：SUMMARY 注入=<本块条目总数> 起作用=<真正起作用的条数> 反作用=<引错的条数> -->
<!-- evidence: 上下文原样 + 末尾追加提问，37 条消息 / 164307 字；模型 glm-5.3-flash；usage={"completion_tokens":433,"completion_tokens_details":{"reasoning_tokens":130},"prompt_tokens":57521,"prompt_tokens_details":{"cached_tokens":0},"total_tokens":57954} -->

CAND D78 unused 记录的是系统清理/git接线，与本轮技能优化无直接决策作用
CAND D15 used 提到技能根是 git 仓+去软链化，佐证了「技能目录不该写缓存」的判断
CAND D20 topic 常识桶分流判据，话题沾边但未影响决策
CAND D23 topic 远端推送核验方法，未用到（本轮未推远端）
CAND D82 topic 命令注册/热载，与 dsh-ops 研究无关
CAND D175 unused SIGBUS 崩因细节，本轮完全用不上
CAND D93 used 极简底座砍 section 的机制，印证插件注入面知识，辅助理解 dsh-ops 的 promptPolicy 设计

SUMMARY 注入=7 起作用=2 反作用=0

归纳：本桶注入命中率偏低（2/7）。起作用的两条都是「机制知识」类（技能根是 git 仓、注入面闸门），而流程记录类（D78/D23/D82）和深水区细节（D175）在本轮无消费点——召回对「任务类型切换」的敏感度可以改进：研究第三方插件源码时，最值钱的其实是 AGENTS.md 里的硬坑（tsc 假壳、沙箱 SSH）而非桶内日记。
