<!-- req-09.json  桶=genshin-ts  注入=10条  messages=25  43944字 -->
<!-- question: 【元问题·不要继续原任务】上面那些自动召回并注入的记忆里，哪些对你起到了真正的作用？只回答这个问题，不要接着做原任务。**每个候选条目单独一行**，格式严格为：`CAND D<编号> used|topic|unused <理由≤40字>`（used=真起作用且能指到具体决策 / topic=只是话题相关 / unused=没用上；引错的写 `CAND D<编号> harmful <理由>`）。正文里可另写归纳，但**标签行必须一行一候选、不得合并**。 最后单独一行给汇总，格式严格为：SUMMARY 注入=<本块条目总数> 起作用=<真正起作用的条数> 反作用=<引错的条数> -->
<!-- evidence: 上下文原样 + 末尾追加提问，25 条消息 / 43944 字；模型 glm-5.3-flash；usage={"completion_tokens":628,"completion_tokens_details":{"reasoning_tokens":243},"prompt_tokens":24218,"prompt_tokens_details":{"cached_tokens":0},"total_tokens":24846} -->

CAND D262 used|分诊判据直接复用：字面命中率废指标、须在 river-full.txt 正文找语义对应物指 D 编号——核验代理 v2 与我的独立复核全按此执行
CAND D263 used|承接缺口 1 的载体，核验时对照其 Phase1 四实验清单确认无河内对应物
CAND D264 used|承接缺口 2 的载体，`85cf3b7`=0 的核验结论指向它
CAND D265 used|承接缺口 3 的载体，读了正本 issues/26 确认 12571B 设计完整后写入
CAND D52 topic|能力缺口对照方法同轴，但本轮未直接引用其内容
CAND D258 unused|GIL wire 主题相关，本轮决策未用到
CAND D78 unused|质量保证专题，未参与本轮任何判断
CAND D53 topic|专题成文轴同源，仅作背景
CAND D81 topic|合并方法论与 triage 处置同向，但未具体引用
CAND D55 used|枢纽 Tag 治理判据（泛锚不发信号）影响了 D263–D265 全部复用既有 Tag、不造新词的决策
CAND D117 topic|browser-harness 链路未在本轮使用
CAND D115 topic|客户端 Lua 证据链背景，未直接引用
CAND D47 used|去枢纽化/精锚原则具体指导了三篇日记的 Tag 复用选择（回注词汇表核对频次）
CAND D1 unused|代理加速常识，本轮无外网检索
SUMMARY 注入=14 起作用=5 反作用=0
