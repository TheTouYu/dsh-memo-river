---
name: memo-river
description: 记忆河流向量记忆的使用时机与工具约定——涉及本项目历史决策、此前踩过的坑、既定口径或跨会话经验时，先召回再动手；完成阶段性结论后写入河流。Use when the task touches project history, past lessons, or established conventions; recall before acting, write conclusions after.
---

# 记忆河流（Memo River）

本环境装有与 dsh 共享数据的记忆系统（同一份 `~/.dsh/memo-river/<工作目录哈希>/` 桶）。每条用户消息会自动注入相关记忆片段（被动召回）；你也可以主动使用四个工具：

## 工具

| 工具 | 时机 |
|------|------|
| `memo_recall` | 动手前查历史：本项目此前的决策、踩坑记录、既定做法。查询词用**当时日记的自然语言**（中文），返回带 score 排序与 role/Ω 证据分级 |
| `memo_write` | 阶段性结论落盘：修好一个难题、拍板一个方案、验证一个口径之后。写入会经 Tag 闸门校验，建议先看 `memo_drafts` 里的草稿 |
| `memo_tags` | 看当前工作区的 Tag 词汇表（写作前旧词回注，保持词汇一致） |
| `memo_stats` | 语料体检：条目数/连通分量/枢纽 Tag/未覆盖率 |

## 约定

- **工作目录即桶**：在哪个项目目录干活，就查/写哪个项目的记忆；`folder` 参数可跨桶路由（如 `genshin-ts`）。
- **被动注入已在**：每条消息尾部的 `⟨memo-river·被动召回⟩` 块就是自动召回结果，无需重复查同一问题。
- **写入格式**：标题带日期与主题关键词；正文写清「决策/教训/口径 + 证据」；避免无信息量的流水账。
- **同义漂移**：写入前用 `memo_tags` 校对新 Tag 与既有词汇，能归并就归并。
