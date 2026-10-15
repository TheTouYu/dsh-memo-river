<!-- req-05.json  桶=dsh-plugins  注入=15条  messages=28  127068字 -->
<!-- question: 【元问题·不要继续原任务】上面那些自动召回并注入的记忆里，哪些对你起到了真正的作用？只回答这个问题，不要接着做原任务。**每个候选条目单独一行**，格式严格为：`CAND D<编号> used|topic|unused <理由≤40字>`（used=真起作用且能指到具体决策 / topic=只是话题相关 / unused=没用上；引错的写 `CAND D<编号> harmful <理由>`）。正文里可另写归纳，但**标签行必须一行一候选、不得合并**。 最后单独一行给汇总，格式严格为：SUMMARY 注入=<本块条目总数> 起作用=<真正起作用的条数> 反作用=<引错的条数> -->
<!-- evidence: 上下文原样 + 末尾追加提问，28 条消息 / 127068 字；模型 glm-5.3-flash；usage={"completion_tokens":685,"completion_tokens_details":{"reasoning_tokens":282},"prompt_tokens":44515,"prompt_tokens_details":{"cached_tokens":0},"total_tokens":45200} -->

CAND D135 topic｜cu bug 案与 dsh-ops 研究无直接因果
CAND D125 unused｜DeepSeek retry 配置案与本次任务无关
CAND D1 unused｜环境迁移首篇，仅背景
CAND D136 unused｜嵌入传输层，无关
CAND D176 unused｜SIGBUS 设计，无关
CAND D71 used｜「DSH 插件形态/补丁台账」为研究 dsh-ops 提供分类框架
CAND D78 used｜git 备份通道教训→判断技能仓脏文件归属时不误提交
CAND D15 topic｜技能还原背景，与本次脚本优化弱相关
CAND D20 unused｜常识桶分流，无关
CAND D23 unused｜插件推送核验，无关
CAND D82 topic｜skill-switches 开发脉络，未影响本次决策
CAND D175 unused｜SIGBUS 复现，无关
CAND D93 topic｜极简底座与插件形态，未落到决策
CAND D30 unused｜收官总结，无关
CAND D134 unused｜鲸鱼案，无关
CAND D60 unused｜鲸鱼 bisect，无关
CAND D131 unused｜subagents 复现，无关
CAND D94 topic｜技能迁移脉络，未影响决策
CAND D8 unused｜零填充案，无关
CAND D102 unused｜鲸鱼核验，无关
CAND D85 unused｜memo-river 重启验证，无关
CAND D88 topic｜极简底座闸门，与插件形态研究同域
CAND D229 unused｜嵌入端点复评，无关
CAND D16 topic｜契约测试教训→读 dsh-ops contract.rs 时有参照意识

SUMMARY 注入=24 起作用=2 反作用=0
