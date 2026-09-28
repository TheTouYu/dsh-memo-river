#!/usr/bin/env node
/**
 * zcode-adapter/mcp-server.mjs — ZCode 的 stdio MCP server（记忆河流四工具）。
 *
 * 注册于 ~/.zcode/cli/config.json 的 mcp.servers 键：
 *   "memo-river": { "command": "node", "args": ["<repo>/zcode-adapter/mcp-server.mjs"] }
 *
 * 协议：MCP stdio（换行分隔的 JSON-RPC）：initialize 握手 → tools/list → tools/call。
 * 工具语义对齐 lib/tools.js 的 dsh 工具定义（memo_recall / memo_write / memo_tags /
 * memo_stats）；能力实现全部走 zcode-adapter/headless.mjs 的无框架组装层。
 *
 * cwd 口径：缺省取 server 进程 cwd（ZCode 启动目录），可用环境变量 MEMO_RIVER_CWD
 * 钉死，或每个工具调用的 folder 参数（桶名 / 16 位哈希）真路由到任意桶。
 */
import { createRequire } from 'node:module';
import { runGuarded, protocolWrite } from './fd-guard.mjs';
import * as headless from './headless.mjs';

const requireFromHere = createRequire(import.meta.url);
const { name: packageName, version: packageVersion } = requireFromHere('../package.json');

const SERVER_INFO = { name: `memo-river (${packageName})`, version: packageVersion };
const DEFAULT_PROTOCOL = '2025-06-18';
const SUPPORTED_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

/** 工作目录：环境变量钉死 > 进程 cwd（README 说明两者）。 */
function defaultCwd() {
    return process.env.MEMO_RIVER_CWD || process.cwd();
}

/* ────────────── 工具定义（语义对齐 lib/tools.js installTools） ────────────── */

const TOOLS = [
    {
        name: 'memo_recall',
        description: '主动补证：在记忆河流（VCPToolBox TagMemo/RiverMemo）里定向检索历史日记。被动注入给线索，本工具给细节。' +
            '返回候选列表，每条两行：`· D<id>「<title>」 score= knn= role= anchor= topology= omega= regime= tags=[reward-suppressed]`，' +
            '下一行是其正文片段（默认 120 字；**显式** `truncate:false` 给全文，那是深挖的走法）。' +
            '末尾附 `· 未注入：…` 明细行与 `diagnostics={…}`（含 fallbackReason、gateVector、readoutDiagnostics）。',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '检索意图（自然语言）。' },
                k: { type: 'number', description: '返回条数上限（缺省用注入配置的 k=3）。' },
                mode: { type: 'string', enum: ['tagmemo', 'rivermemo', 'dtsc', 'topology_v3'], description: '读出模式：topology_v3（默认，Ω/role 在这条上）/ dtsc / rivermemo / tagmemo（纯向量）。' },
                rerank: { type: 'boolean', description: '是否做原生重排（false = 只回 KNN 基线）。' },
                truncate: { type: 'boolean', description: '正文是否截断为首句。' },
                timeRange: { type: 'string', description: '::Time 语义，如 2026-09-10~2026-09-11。' },
                folder: { type: 'string', description: '真路由：桶名或 16 位工作区哈希 → 目标桶上执行检索（跨项目知识共享通道）。缺省 = 工作目录对应桶。' },
            },
            required: ['query'],
        },
    },
    {
        name: 'memo_write',
        description: '写一篇日记进记忆河流。执行顺序固定：①回注旧 Tag 词汇表 + 语义相关旧日记 + 枢纽警告 ②校验（必须有 Tag 行、3–5 个 Tag、Tag ≤20 字、不得与既有 Tag 同义）' +
            '③新 Tag 闸门（引入库中不存在的 Tag 必须给 newTagReason）④写入 files/file_tags/tags/chunks + 嵌入 + 索引追加 + 资产重建 ⑤返回体检增量。' +
            '拒绝条件会明确报错，不静默。',
        inputSchema: {
            type: 'object',
            properties: {
                content: { type: 'string', description: '正文（末尾可含 Tag 行）。写清四要素：延续什么/转折什么/因果链/教训。' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Tag 列表（建议；缺省从正文 Tag 行解析）。' },
                title: { type: 'string', description: '标题（缺省取正文首行 # 标题；两者皆无会被拒——不再落「未命名」）。' },
                date: { type: 'string', description: '日期 YYYY-MM-DD（缺省今天）。' },
                folder: { type: 'string', description: '工作区桶名（缺省 = 工作目录对应桶）。' },
                newTagReason: { type: 'string', description: '引入库中不存在的新 Tag 时，必须给出「概念确实变了」的理由，否则拒绝。' },
            },
            required: ['content'],
        },
    },
    {
        name: 'memo_tags',
        description: 'Tag 词汇表：按频次排序的既有 Tag 清单，供续写日记时复用（写前先看，避免同义 Tag 漂移）。',
        inputSchema: {
            type: 'object',
            properties: {
                limit: { type: 'number', description: '返回条数（缺省 30）。' },
                folder: { type: 'string', description: '桶名 / 16 位哈希（缺省 = 工作目录对应桶）。' },
            },
        },
    },
    {
        name: 'memo_stats',
        description: '语料体检（四项判据）+ ⑤ 使用台账视图（最常被召回/从未使用/陈旧度，主动与被动分开；kv 观测，不进打分）。' +
            '①连通分量数（必须=1）②最大 Tag 频次/总篇数（<1/3）③Ω 分布（近 N 次，报分布不只报均值）④未覆盖率。',
        inputSchema: {
            type: 'object',
            properties: {
                rebuild: { type: 'boolean', description: '是否顺带强制重建原生资产（缺省 false，按 artifactSig 比对）。' },
                folder: { type: 'string', description: '桶名 / 16 位哈希（缺省 = 工作目录对应桶）。' },
            },
        },
    },
];

/** tools/call 分发：能力实现全在 headless；异常统一转 isError 文本，绝不让进程崩。 */
async function callTool(name, args = {}) {
    const cwd = defaultCwd();
    switch (name) {
        case 'memo_recall': {
            const r = await headless.recall({
                cwd,
                folder: args.folder,
                query: args.query,
                k: args.k,
                mode: args.mode,
                rerank: args.rerank,
                /* 与 lib/tools.js memo_recall 同口径：只有**显式** truncate:false 才给全文 */
                fullBody: args.truncate === false,
                timeRange: args.timeRange,
            });
            return r.text;
        }
        case 'memo_write': {
            const r = await headless.write({
                cwd,
                folder: args.folder,
                content: args.content,
                tags: args.tags,
                title: args.title,
                date: args.date,
                newTagReason: args.newTagReason,
            });
            return r.text;
        }
        case 'memo_tags': {
            const r = headless.tags({ cwd, folder: args.folder, limit: args.limit });
            return r.text;
        }
        case 'memo_stats': {
            const r = await headless.stats({ cwd, folder: args.folder, rebuild: args.rebuild });
            return r.text;
        }
        default:
            throw new Error(`unknown tool: ${name}`);
    }
}

/* ────────────── JSON-RPC / MCP 传输（stdio，换行分隔） ────────────── */

function send(obj) {
    protocolWrite(`${JSON.stringify(obj)}\n`);
}
function reply(id, result) {
    if (id === undefined || id === null)
        return; // 通知不回包
    send({ jsonrpc: '2.0', id, result });
}
function replyError(id, code, message) {
    if (id === undefined || id === null)
        return;
    send({ jsonrpc: '2.0', id, error: { code, message } });
}
async function handleMessage(msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string')
        return;
    const { id, method, params } = msg;
    switch (method) {
        case 'initialize':
            reply(id, {
                protocolVersion: SUPPORTED_PROTOCOLS.has(params?.protocolVersion) ? params.protocolVersion : DEFAULT_PROTOCOL,
                capabilities: { tools: { listChanged: false } },
                serverInfo: SERVER_INFO,
            });
            return;
        case 'notifications/initialized':
        case 'notifications/cancelled':
        case 'notifications/progress':
            return; // 通知：不回包
        case 'ping':
            reply(id, {});
            return;
        case 'tools/list':
            reply(id, { tools: TOOLS });
            return;
        case 'tools/call': {
            const name = params?.name;
            const args = params?.arguments ?? {};
            try {
                const text = await callTool(name, args);
                reply(id, { content: [{ type: 'text', text: String(text) }] });
            } catch (e) {
                /* 工具层失败 → isError 结果（MCP 约定），server 不崩 */
                reply(id, { content: [{ type: 'text', text: `memo-river tool error: ${String(e?.message ?? e)}` }], isError: true });
            }
            return;
        }
        case 'resources/list':
            reply(id, { resources: [] });
            return;
        case 'prompts/list':
            reply(id, { prompts: [] });
            return;
        default:
            replyError(id, -32601, `method not found: ${method}`);
    }
}

/* 逐行读取 stdin；坏行跳过；EOF 后等在飞请求回完包再退出。
 * （管道验证首版就在这里翻过车：printf 一把写完即关 stdin，`end` 立即 process.exit，
 *  而异步的 tools/call（原生装载 + artifact）还在飞——响应被拦腰截断。 */
function startServer() {
    let buffer = '';
    let inFlight = 0;
    let stdinEnded = false;
    const maybeExit = () => {
        if (stdinEnded && inFlight === 0) {
            /* 给守护管道一拍排空（writeSync 同步写完即到 OS，这里只等事件循环收尾） */
            setImmediate(() => {
                headless.releaseAllWorkspaces?.();
                process.exit(0);
            });
        }
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line)
                continue;
            let msg;
            try {
                msg = JSON.parse(line);
            } catch {
                continue; // 坏行：跳过不回包（无 id 可回）
            }
            inFlight += 1;
            handleMessage(msg)
                .catch((e) => {
                process.stderr?.write?.(`memo-river mcp handler error: ${String(e?.message ?? e)}\n`);
            })
                .finally(() => {
                inFlight -= 1;
                maybeExit();
            });
        }
    });
    process.stdin.on('end', () => {
        stdinEnded = true;
        maybeExit();
    });
}

/* 入口：父进程只负责 respawn + 转发（fd-guard.mjs）；子进程（fd3=协议管道）才真正服务。 */
if (runGuarded(import.meta.url)) {
    /* 父进程：child.stdio[3].pipe 已接管 stdout，等子进程退出 */
} else {
    startServer();
}
