# zcode-adapter — 记忆河流的 ZCode 适配版

让 ZCode（coding agent CLI）与 dsh 共享**同一份**记忆河流数据：
`~/.dsh/memo-river/<sha256(cwd) 前 16 位>/`（knowledge_base.sqlite + emb-cache.json + dailynote/…）。
不引入第二份存储、不改 lib/ 的任何行为——组装层（`headless.mjs`）直接复用
`../lib/` 的纯 Node 模块（workspace / recall / embed / native / store / tools /
render / health），只有 Cordis 壳（`lib/index.js`）被替换。

## 组成

| 文件 | 作用 |
| --- | --- |
| `headless.mjs` | 无框架组装层：recall / write / tags / stats 四能力 + hook 共享状态工具。embed 配置取 `~/.env` 的 `TAG_EMBED_KEY`，inject 调参取 `bundle/cordis.patch.yml` 的生产值（tokenBudget=3500、embedTimeoutMs=8000、gate=0.55 双锚…） |
| `mcp-server.mjs` | stdio MCP server，四工具 `memo_recall` / `memo_write` / `memo_tags` / `memo_stats`，语义对齐 `lib/tools.js` 的 dsh 工具定义 |
| `hook-submit.mjs` | ZCode `UserPromptSubmit` hook：stdin 收 JSON（含 prompt），cwd 算桶，跑 gate/topology_v3 召回，stdout `{"additionalContext":"⟨memo-river·被动召回⟩…"}`；失败/门控不过输出 `{}`，绝不阻塞、绝不非零退出 |
| `hook-stop.mjs` | ZCode `Stop` hook：写入节律提醒（writeNudgeEveryTurns=2、writeNudgeEveryMinutes=7 双锚，文案 `lib/render.js renderWriteNudge`） |
| `fd-guard.mjs` | stdout 守护：rust-vexus-lite 直接向 fd 1 println!（无日志开关），会打花 stdio JSON 流；三个入口都经它 respawn 一次——子进程 fd1/2 接 stderr（日志可查），协议 JSON 走 fd 3 专属管道由父进程转发 |

## 安装

### 1. 依赖

- Node ≥ 26（`node:sqlite`），本仓库 `node_modules/`（`undici`、`schemastery`、`@deepseek-ai/dsh-tools`——`headless.mjs` 复用 `lib/tools.js` 的 `writeDiaryCore`）。
- `~/.env` 里有 `TAG_EMBED_KEY=`（嵌入端点 `https://api.relayrouter.ai/v1/embeddings`，模型 `gemini-embedding-2-preview`，3072 维）。**key 只从该文件读，不要写进任何仓库文件。**
- 嵌入需要代理：缺省自动设 `TAG_EMBED_PROXY=http://127.0.0.1:7890`（`lib/embed.js` 的传输层原样复用）。改代理：设 `TAG_EMBED_PROXY`；直连：设 `MEMO_ZCODE_NOPROXY=1`。
- 原生模块 `/home/h/app/VCPToolBox/rust-vexus-lite/`（`vexus-lite.linux-x64-gnu.node` 预编译，require 即加载）。

### 2. MCP server（~/.zcode/cli/config.json 的 `mcp.servers`）

```json
{
  "mcp": {
    "servers": {
      "memo-river": {
        "command": "node",
        "args": ["/home/h/dsh-plugins/dsh-memo-river/zcode-adapter/mcp-server.mjs"],
        "env": { "MEMO_RIVER_CWD": "/home/h/dsh-plugins/dsh-memo-river" }
      }
    }
  }
}
```

- `MEMO_RIVER_CWD` 钉死工具的缺省工作目录（ZCode 全局 MCP server 的进程 cwd
  不一定是项目目录）；不设则用进程 cwd。任何时候可用工具参数 `folder`
  （桶名或 16 位哈希，如 `dsh-memo-river` / `b94d8836d6175817`）真路由到任意桶
  （`memo_write` 会为新 cwd 建桶；recall/tags/stats 对无桶目录只报提示、不建桶）。

### 3. Hooks（同文件 `hooks` 键）

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "UserPromptSubmit": [
        {
          "type": "command",
          "command": "node /home/h/dsh-plugins/dsh-memo-river/zcode-adapter/hook-submit.mjs"
        }
      ],
      "Stop": [
        {
          "type": "command",
          "command": "node /home/h/dsh-plugins/dsh-memo-river/zcode-adapter/hook-stop.mjs"
        }
      ]
    }
  }
}
```

（`type`/`command` 字段名以所用 ZCode 版本的 hooks 文档为准；要点是：
hook 进程 **cwd = 会话工作目录**、stdin 收事件 JSON、stdout 回 `{"additionalContext": …}`。）

## 行为口径（与 dsh 侧的差异点）

- **hook-submit 每 prompt 冷启动**：一次进程 = 索引装载 + artifact 比对 + 一次合批
  嵌入（8s 超时）+ 原生流水线；看门狗 30s（`MEMO_ZCODE_HOOK_TIMEOUT_MS` 可调）内
  未完成则输出 `{}` 放行。dsh 侧的会话内常驻索引在 hook 形态下不可得。
- **入选集合去重落盘**：dsh 的 `dedupeSelection` 状态在会话 Map 里；ZCode 侧落在
  桶内 `zcode-hook-state.json`（键=会话 id），`dedupeRefreshTurns=8` 映射为
  「隔 8 次 prompt 强制重注」。
- **hook-stop 的时间锚是墙钟**：dsh 侧 7 分钟量的是 `activeMs`（模型实际思考时间，
  工具执行与空闲不计入）；Stop hook 测不到流时长，退化为墙钟。写入时钟取桶内
  `memo-river.log` 的最近 `memo_write` 行——**dsh 与 ZCode 任一侧写入都会重置两侧节律**。
- **hub 闸门按交互会话处理**（`hubGate.scoped=false`）：与 dsh 交互会话同口径
  （软警告），enforce 硬拒只保留给 dsh 侧 autonomous/delegation 形态。
- **门控助手锚为空**：UserPromptSubmit 只能看到当前 prompt，gA 锚（最近 ≥150 字
  助手消息）不可得，单 gU 锚判 `gateThreshold=0.55`；查询场窗口也只含当前 prompt
  （等价 `queryLookback` 窗口长度为 1 的退化情形，见 `lib/config.ts`
  `gateOnCurrentMessage` 的判别力说明）。

## 验证（本目录开发时实际跑过的三条）

```bash
# a. headless 对真实桶 recall（走真实 embed API，应返回条目且 fallbackReason=none）
node -e "import('./zcode-adapter/headless.mjs').then(async h=>{
  const r = await h.recall({ cwd: '/home/h/dsh-plugins/dsh-memo-river', query: '沙箱验收' });
  console.log(r.text); })"

# b. MCP 手动管道：initialize + tools/list + tools/call(memo_stats)
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"memo_stats","arguments":{}}}' \
  | MEMO_RIVER_CWD=/home/h/dsh-plugins/dsh-memo-river node zcode-adapter/mcp-server.mjs

# c. hook-submit 管道（stdout 必须是合法 JSON）
cd /home/h/dsh-plugins/dsh-memo-river && echo '{"prompt":"测试沙箱验收"}' | node zcode-adapter/hook-submit.mjs
```
