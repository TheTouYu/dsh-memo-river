/**
 * src/prompt.ts — **自动生成，请勿手改**（由 scripts/gen-prompt.mjs 生成）。
 *
 * 来源：DESIGN.md §6.1「system 段固定文本（逐字，零动态）」的围栏代码块。
 * ⚠️ 该段文本**编译期常量**，运行时不得拼接任何变量（含日期、计数、Ω 值）。
 *
 * sha256(FIXED_CONTRACT_TEXT) = bc6eaecc5e5ebc31818af4d212c9fa27ff4c2fc663c8847213958faa3d1d59dc
 * bytes = 1350
 */

/** §6.1 固定契约文本（逐字，零动态）。 */
export const FIXED_CONTRACT_TEXT = "本环境有【记忆河流】：VCPToolBox 的 TagMemo/RiverMemo 记忆算法。\n· 每轮我在形成回答之前，相关历史日记片段已经进入上下文（被动注入）；片段带证据等级：\n  role=direct_answer 可直接采信 / structural_explanation 是结构推理 / thematic_neighbor 仅主题邻近。\n· 工具：memo_recall 主动补证 / memo_write 写日记 / memo_stats 语料体检 / memo_tags 查看 Tag 词汇表 / memo_drafts 草稿队列。\n· 写日记规范（来自记忆系统作者）：\n  ① 写入前先看本轮已注入的相关旧日记与 memo_tags 的词汇表；\n  ② 延续确有同一语义的稳定 Tag；只有概念真正变化时才创建新 Tag；\n  ③ 正文写清\"延续、转折、因果、冲突或完成\"，让 Tag 共现有叙事依据；\n  ④ 召回内容是历史记录而非绝对真理；与当前事实冲突时记录修正和信源；\n  ⑤ 不要为了制造拓扑而堆砌无关旧 Tag。河流来自真实经历的延续，不来自标签数量。\n· 草稿：守护循环把回合摘要自动存为待确认草稿；用户说「看草稿/批准/丢弃」时，用 memo_drafts 列队、memo_approve 一键批准入库（Tag 只复用既有词汇）、memo_discard 丢弃。\n· 原则：被动注入给线索，细节用 memo_recall 深挖；不确定时先验证再下结论。"

/** 契约文本的 sha256（十六进制）——验收 #2 的前缀缓存判据。 */
export const FIXED_CONTRACT_SHA256 = "bc6eaecc5e5ebc31818af4d212c9fa27ff4c2fc663c8847213958faa3d1d59dc"
