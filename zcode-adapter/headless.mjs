/**
 * zcode-adapter/headless.mjs — 无 Cordis 的组装层（ZCode 适配版）。
 *
 * dsh 侧由 lib/index.js 的 Cordis 壳（inject ['llm','systemPrompt','tools','webServer']）
 * 组装 workspace/daemon/embed/native；本模块用同一批 lib 纯 Node 模块手工组装，
 * 导出 recall / write / tags / stats 四能力，供 mcp-server.mjs 与两个 hook 复用。
 *
 * 关键对齐点（语义来源逐条标注）：
 *   · embed 配置：~/.env 的 TAG_EMBED_KEY + relayrouter 端点（bundle/cordis.patch.yml :87）
 *   · inject 调参：gate/k/tokenBudget=3500/mode=topology_v3/embedTimeoutMs=8000（同文件 :88-120）
 *   · recall 工具语义：lib/tools.js memo_recall execute（gate=false，主动补证不套被动门控）
 *   · 注入语义：lib/injector.js buildTailInjection + recallOptions（gate=true + 当前消息锚）
 *   · write 语义：lib/tools.js writeDiaryCore（硬契约：回注→校验→闸门→写入→体检增量）
 *   · 渲染：lib/render.js renderInjection / renderWriteNudge（注入块格式与 dsh 侧逐字一致）
 *
 * 数据桶与 dsh 完全共享：~/.dsh/memo-river/<sha256(cwd) 前 16 位>/。
 */
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { Config } from '../lib/config.js';
import { cosine, WRITE_EMBED_OPTIONS } from '../lib/embed.js';
import { formatHealth, healthReport, HUB_RATIO_LIMIT, recordOmega, recordUsage } from '../lib/health.js';
import { continuationTail, renderInjection, renderSkipNotice } from '../lib/render.js';
import { loadEnvFile, workspacePaths, workspaceHash } from '../lib/runtime.js';
import { formatRecallResult, parseTagLine, writeDiaryCore } from '../lib/tools.js';
import { acquireBucketRuntime, acquireWorkspace, releaseAllWorkspaces, resolveBucket } from '../lib/workspace.js';
import { pendingQueueStats } from '../lib/drafts.js';

/* ────────────── 配置组装 ────────────── */

/** 环境变量文件：缺省 ~/.env（TAG_EMBED_KEY 所在），可用 MEMO_RIVER_ENV 改指。 */
function envFilePath() {
    return process.env.MEMO_RIVER_ENV || join(homedir(), '.env');
}
/** 嵌入代理：缺省本机 7890（与 dsh 部署一致）；置 MEMO_ZCODE_NOPROXY=1 关闭。 */
function ensureEmbedProxy() {
    if (process.env.TAG_EMBED_PROXY || process.env.TAG_EMBED_PROXY_FROM_ENV)
        return;
    if (process.env.MEMO_ZCODE_NOPROXY === '1')
        return;
    process.env.TAG_EMBED_PROXY = 'http://127.0.0.1:7890';
}
/**
 * 组装运行期配置：schemastery 默认值（与 dsh 侧同一份 lib/config.js 解析）
 * + bundle/cordis.patch.yml 的生产覆盖 + ~/.env 的 TAG_EMBED_KEY。
 */
export function buildConfig(overrides = {}) {
    loadEnvFile(envFilePath());
    ensureEmbedProxy();
    const config = Config({});
    /* cordis.patch.yml :87 —— embed: relayrouter + TAG_EMBED_KEY */
    config.embed = {
        apiUrl: 'https://api.relayrouter.ai',
        apiKey: process.env.TAG_EMBED_KEY || '',
        model: 'gemini-embedding-2-preview',
        dimension: 3072,
        ...(overrides.embed ?? {}),
    };
    /* cordis.patch.yml :88-120 —— inject 生产调参（默认值之外的覆盖项） */
    config.inject = { ...config.inject, ...(overrides.inject ?? {}) };
    config.native = { ...config.native, ...(overrides.native ?? {}) };
    config.write = { ...config.write, ...(overrides.write ?? {}) };
    return config;
}
/** 插件级配置缓存（hook / MCP server 各自进程内复用；key 为配置指纹无意义，单例即可）。 */
let cachedConfig = null;
export function sharedConfig() {
    if (!cachedConfig)
        cachedConfig = buildConfig();
    return cachedConfig;
}

/* ────────────── 工作区路由 ────────────── */

/**
 * 打开目标工作区。folder 优先（桶名 / 16 位哈希，同 memo_recall folder 真路由）；
 * 否则按 cwd 哈希开桶。create=false 且桶里没有 knowledge_base.sqlite 时返回 null
 * （读路径不为陌生 cwd 建桶；write 传 create=true 与 dsh 行为一致）。
 */
export function openTarget({ cwd, folder }, config = sharedConfig(), { create = false } = {}) {
    const trimmed = typeof folder === 'string' ? folder.trim() : '';
    if (trimmed) {
        const resolution = resolveBucket(trimmed);
        if (!resolution.ok)
            return { ok: false, error: resolution.error };
        return { ok: true, workspace: acquireBucketRuntime(resolution.entry, config) };
    }
    const dir = cwd || process.cwd();
    const paths = workspacePaths(dir, config.bucket, config.logFile || undefined);
    if (!create && !existsSync(paths.dbPath))
        return { ok: false, error: null }; // 无桶：调用方决定如何呈现
    return { ok: true, workspace: acquireWorkspace(dir, config) };
}
/** cwd → 桶哈希（hook 侧算桶用，不触任何 I/O）。 */
export { workspaceHash };

/* ────────────── ① recall（memo_recall 工具语义） ────────────── */

/** lib/tools.js 的私有 parseTimeRange/dateOf 复刻（timeRange 过滤在结果集上做）。 */
function parseTimeRange(raw) {
    if (!raw)
        return null;
    const m = String(raw).match(/^\s*(\d{4}-\d{2}-\d{2})\s*[~～-]\s*(\d{4}-\d{2}-\d{2})\s*$/);
    return m ? { from: m[1], to: m[2] } : null;
}
function dateOf(path) {
    const base = String(path).replace(/\\/g, '/').split('/').pop() ?? '';
    const m = base.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
}
/** injector.js recallOptions 的主动工具版：gate=false（§1 不变量 2），dynamicK=1。 */
export function toolRecallOptions(config, k, mode, rerank) {
    return {
        mode: rerank ? mode : 'tagmemo',
        k,
        tokenBudget: config.inject.tokenBudget,
        dynamicK: 1,
        adaptiveKRatio: config.inject.adaptiveKRatio,
        adaptiveKMax: config.inject.adaptiveKMax,
        selectionWeights: {
            tagCap: config.inject.selectionTagCap,
            exposureCap: config.inject.selectionExposureCap,
            exposureHalfLifeHours: config.inject.selectionExposureHalfLifeHours,
            recencyCap: config.inject.selectionRecencyCap,
            recencyWindowHours: config.inject.selectionRecencyWindowHours,
        },
        recencyFloorDays: config.inject.recencyFloorDays,
        gate: false,
        gateThreshold: config.inject.gateThreshold,
        minKnnForReward: config.inject.minKnnForReward,
        queryId: `zcode-recall-${Date.now()}`,
        tieBreaker: null,
    };
}
/**
 * 主动补证（memo_recall 语义）。返回 { text, outcome }；无桶返回 { text, missing }。
 */
export async function recall({ cwd, folder, query, k, mode, rerank = true, fullBody = false, timeRange }) {
    const config = sharedConfig();
    const target = openTarget({ cwd, folder }, config);
    if (!target.ok)
        return { text: target.error ?? `【记忆河流·memo_recall】此工作区（${cwd || process.cwd()}）还没有记忆桶——先 memo_write 一篇即可建桶。`, outcome: null };
    const workspace = target.workspace;
    const effectiveMode = typeof mode === 'string' && mode ? mode : config.inject.mode;
    const effectiveK = typeof k === 'number' && k > 0 ? k : config.inject.k;
    const outcome = await workspace.recall(String(query ?? ''), toolRecallOptions(config, effectiveK, effectiveMode, rerank));
    /* timeRange 过滤（在目标桶结果集上做，同 memo_recall execute） */
    const range = parseTimeRange(timeRange);
    if (range) {
        const owners = workspace.store.chunkOwners();
        const keep = (id) => {
            const owner = owners.get(id);
            const d = owner ? dateOf(owner.path) : null;
            return Boolean(d && d >= range.from && d <= range.to);
        };
        outcome.candidates = outcome.candidates.filter((c) => keep(c.id));
        outcome.selected = outcome.selected.filter((c) => keep(c.id));
        outcome.candidateCount = outcome.candidates.length;
    }
    /* 使用台账（票 01）：主动补证也是「使用」——只记刻意呈现的 selected。 */
    try {
        if (outcome.selected.length > 0)
            recordUsage(workspace.store, outcome.selected.map((c) => c.fileId), 'active');
    } catch { /* 台账失败静默：观测不能伤害补证 */ }
    const text = formatRecallResult(workspace, outcome, String(query ?? ''), fullBody === true);
    return { text, outcome, workspace };
}

/* ────────────── ② 注入召回（UserPromptSubmit hook 语义） ────────────── */

/**
 * 被动注入召回（lib/injector.js buildTailInjection 的单消息窗口版）：
 *   · 查询场 = 当前用户 prompt（ZCode hook 只能看到这一条，等价 queryLookback 窗口只含它）
 *   · 门控锚 = 同一条 prompt（gateOnCurrentMessage=true；无助手历史 → gA 锚空）
 *   · 产出 renderInjection 注入块；门控不过 / 失败 → null（调用方输出 {}）
 */
export async function injectRecall({ cwd, prompt }) {
    const config = sharedConfig();
    const dir = cwd || process.cwd();
    const paths = workspacePaths(dir, config.bucket, config.logFile || undefined);
    if (!existsSync(paths.dbPath))
        return { text: null, outcome: null, reason: 'no-bucket' };
    const workspace = acquireWorkspace(dir, config);
    const text = String(prompt ?? '').trim();
    if (!text)
        return { text: null, outcome: null, reason: 'empty-prompt', workspace };
    const options = {
        mode: config.inject.mode,
        k: config.inject.k,
        tokenBudget: config.inject.tokenBudget,
        dynamicK: config.inject.dynamicK,
        adaptiveKRatio: config.inject.adaptiveKRatio,
        adaptiveKMax: config.inject.adaptiveKMax,
        selectionWeights: {
            tagCap: config.inject.selectionTagCap,
            exposureCap: config.inject.selectionExposureCap,
            exposureHalfLifeHours: config.inject.selectionExposureHalfLifeHours,
            recencyCap: config.inject.selectionRecencyCap,
            recencyWindowHours: config.inject.selectionRecencyWindowHours,
        },
        recencyFloorDays: config.inject.recencyFloorDays,
        gate: config.inject.gate,
        gateThreshold: config.inject.gateThreshold,
        minKnnForReward: config.inject.minKnnForReward,
        queryId: `zcode-inject-${Date.now()}`,
        gateText: config.inject.gateOnCurrentMessage ? text : '',
        gateAssistantText: '',
        embedTimeoutMs: config.inject.embedTimeoutMs,
    };
    const outcome = await workspace.recall(text, options);
    /* §7.3 ③④：Ω 与召回足迹记进 kv_store（体检素材），无论是否注入。 */
    try {
        recordOmega(workspace.store, outcome.omega, outcome.regime ?? '');
        if (outcome.injected)
            recordUsage(workspace.store, outcome.selected.map((c) => c.fileId), 'passive');
    } catch { /* 观测失败不阻塞注入 */ }
    const block = renderInjection(outcome, workspace.paths.bucket);
    if (!block) {
        workspace.logger.info(`${renderSkipNotice(outcome, workspace.paths.bucket)} source=zcode-hook`);
        return { text: null, outcome, reason: outcome.fallbackReason, workspace };
    }
    workspace.logger.info(`inject source=zcode-hook bucket=${workspace.paths.bucket} ids=${outcome.selected.map((c) => `D${c.id}`).join(',')} omega=${outcome.omega === null ? 'n/a' : outcome.omega.toFixed(3)} chars=${block.length} elapsedMs=${outcome.elapsedMs}`);
    return { text: block, outcome, reason: null, workspace };
}

/* ────────────── ③ write（memo_write 工具语义） ────────────── */

/** 写前回注（lib/tools.js composeReinjection 的对齐复刻：词汇表 + 相关旧日记 + 枢纽警告）。 */
async function composeReinjectionLite(workspace, content) {
    const bucket = workspace.paths.bucket;
    const freq = workspace.store.tagFrequency();
    const total = workspace.store.files().length;
    const reinjectTop = freq.slice(0, 30).map((t) => `${t.name}×${t.count}`).join(', ') || '(空库)';
    const related = await relatedDiariesLite(workspace, content);
    const pre = healthReport(workspace.store, bucket);
    const hubWarn = pre.hub && pre.hub.ratio >= HUB_RATIO_LIMIT
        ? `⚠️ 枢纽警告：「${pre.hub.name}」已出现 ${pre.hub.count}/${total} 篇（≥1/3），再堆它会让直接锚泛化`
        : `枢纽检查：当前最大 Tag 频次 ${pre.hub ? `${pre.hub.name}×${pre.hub.count}` : 'n/a'}（<1/3 ✅）`;
    const relatedStr = related.map((c) => `D${c.id}「${c.title}」 knn=${c.score.toFixed(3)}`).join(' / ');
    const top = related[0];
    const mergeHint = top && top.score >= 0.8
        ? `【写前回注】最相似 D${top.id}《${top.title}》knn=${top.score.toFixed(2)}——同一主题的延续优先 memo_update 并入，别新开复读篇。`
        : '';
    return [
        `【写前回注】旧 Tag 词汇表（top ${Math.min(30, freq.length)}）：${reinjectTop}`,
        `【写前回注】语义相关旧日记：${relatedStr || '(无)'}`,
        `【写前回注】${hubWarn}；当前连通分量 = ${pre.components}（判据 =1）`,
        '【写前回注】Tag 自检：跨篇 ≥1/3 的枢纽词会被写侧闸门拦下或警告；不确定就写内容词（主题/机制/对象/判据）。',
        '【写前回注】质量四要素：写清——延续什么 / 转折什么 / 因果链 / 教训（读者是三个月后的自己或接手的兄弟代理）。',
        ...(mergeHint ? [mergeHint] : []),
    ].join('\n');
}
/** lib/tools.js relatedDiaries 的对齐复刻（写路径嵌入预算同款）。 */
async function relatedDiariesLite(workspace, content, limit = 3) {
    try {
        if (!workspace.embed.configured)
            return [];
        const [vec] = await workspace.embed.embed([String(content).slice(0, 2000)], WRITE_EMBED_OPTIONS);
        if (!vec)
            return [];
        const chunks = workspace.store.chunks().filter((c) => c.vector !== null);
        const owners = workspace.store.chunkOwners();
        return chunks
            .map((c) => ({ id: c.id, score: cosine(vec, c.vector.subarray(0, workspace.resolved.dimension)) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map((c) => {
            const owner = owners.get(c.id);
            const title = owner ? (owner.path.replace(/\\/g, '/').split('/').pop() ?? '').replace(/\.[^.]+$/, '') : `D${c.id}`;
            return { id: c.id, title, score: c.score };
        });
    } catch {
        return [];
    }
}
/**
 * 写一篇日记（memo_write 硬契约：回注 → 校验 → 闸门 → 写入 → 体检增量）。
 * 核心直接复用 lib/tools.js 的 writeDiaryCore——闸门口径与 dsh 侧只此一份。
 */
export async function write({ cwd, folder, content, tags, title = '', date, newTagReason = '' }) {
    const config = sharedConfig();
    const target = openTarget({ cwd, folder }, config, { create: true });
    if (!target.ok)
        return { text: target.error };
    const workspace = target.workspace;
    const trimmedContent = String(content ?? '').trim();
    const bucket = workspace.paths.bucket;
    const effectiveDate = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10);
    const fromArg = Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean) : [];
    const effectiveTags = fromArg.length > 0 ? fromArg : parseTagLine(trimmedContent);
    /* ① 回注（Promise 传入——与写侧合批嵌入并行在飞，同 memo_write execute） */
    const preamble = composeReinjectionLite(workspace, trimmedContent);
    /* ②–⑤ 校验 + 闸门 + 写入 + 体检 */
    const result = await writeDiaryCore(workspace, {
        content: trimmedContent,
        tags: effectiveTags,
        title: String(title ?? '').trim(),
        date: effectiveDate,
        bucket,
        dedupCosine: config.write.dedupCosine,
        hubGate: { mode: config.write.hubGateMode, scoped: false, source: 'zcode-interactive' },
        newTagReason: String(newTagReason ?? '').trim(),
        preamble,
        toolName: 'memo_write',
    });
    return { text: result.report, status: result.status, workspace };
}

/* ────────────── ④ tags / stats ────────────── */

/** Tag 词汇表（memo_tags 语义：频次排序 + 枢纽标记 + 复用提示）。 */
export function tags({ cwd, folder, limit } = {}) {
    const config = sharedConfig();
    const target = openTarget({ cwd, folder }, config);
    if (!target.ok)
        return { text: target.error ?? `【记忆河流·memo_tags】此工作区还没有记忆桶。` };
    const workspace = target.workspace;
    const effectiveLimit = typeof limit === 'number' && limit > 0 ? limit : 30;
    const freq = workspace.store.tagFrequency();
    const total = workspace.store.files().length;
    const lines = [`【记忆河流·memo_tags】桶=${workspace.paths.bucket} 共 ${freq.length} 个 Tag / ${total} 篇日记`];
    for (const t of freq.slice(0, effectiveLimit)) {
        const ratio = total > 0 ? t.count / total : 0;
        const flag = ratio >= HUB_RATIO_LIMIT ? '  ⚠️枢纽(≥1/3)' : '';
        lines.push(`· ${t.name}  ×${t.count}${flag}`);
    }
    if (freq.length > effectiveLimit)
        lines.push(`· …还有 ${freq.length - effectiveLimit} 个（提高 limit 查看）`);
    lines.push('· 写新日记时优先复用以上 Tag；只有概念真正变化时才创建新 Tag（需在 memo_write 里给出 newTagReason）。');
    return { text: lines.join('\n'), workspace };
}
/** 语料体检（memo_stats 语义：四项判据 + 使用台账 + 原生资产状态）。 */
export async function stats({ cwd, folder, rebuild = false } = {}) {
    const config = sharedConfig();
    const target = openTarget({ cwd, folder }, config);
    if (!target.ok)
        return { text: target.error ?? `【记忆河流·memo_stats】此工作区还没有记忆桶。` };
    const workspace = target.workspace;
    const report = healthReport(workspace.store, workspace.paths.bucket);
    const lines = [formatHealth(report)];
    const loaded = await workspace.ensureLoaded();
    if (loaded) {
        const state = await workspace.engine.ensureArtifact(rebuild === true);
        lines.push(`· 原生资产：artifactSig=${state.artifactSig.slice(0, 24)}… 节点=${state.nodeCount} 边=${state.edgeCount} ` +
            `persisted=${state.persisted} resident=${state.resident} 本次重建耗时=${state.elapsedMs}ms`);
    } else {
        lines.push('· 原生资产：未载入（native-unavailable）');
    }
    return { text: lines.join('\n'), workspace };
}

/* ────────────── hook 共享：状态文件 + 写入节律素材 ────────────── */

/** ZCode hook 的跨进程状态（dsh 侧放 src/session.ts 的 Map；hook 每 prompt 一个进程，只能落盘）。 */
export function hookStatePath(cwd) {
    return join(workspacePaths(cwd || process.cwd()).root, 'zcode-hook-state.json');
}
export function readHookState(cwd) {
    try {
        const raw = readFileSync(hookStatePath(cwd), 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}
export function writeHookState(cwd, state) {
    try {
        const path = hookStatePath(cwd);
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, JSON.stringify(state));
    } catch { /* 状态落盘失败静默：节律提醒是锦上添花，不能因此炸 hook */ }
}
/** 最近一篇日记的末段一句（lib/injector.js lastDiaryTail 的复刻——票12 接续锚）。 */
export function lastDiaryTail(cwd) {
    try {
        const paths = workspacePaths(cwd || process.cwd());
        const dir = join(paths.root, 'dailynote', paths.bucket);
        const names = readdirSync(dir).filter((n) => n.endsWith('.md'));
        if (names.length === 0)
            return null;
        let newest = { name: names[0], mtime: statSync(join(dir, names[0])).mtimeMs };
        for (const n of names.slice(1)) {
            const m = statSync(join(dir, n)).mtimeMs;
            if (m > newest.mtime)
                newest = { name: n, mtime: m };
        }
        return continuationTail(readFileSync(join(dir, newest.name), 'utf8'));
    } catch {
        return null;
    }
}
/** 草稿队列读数（renderWriteNudge 的 queue 弹药，同 pendingQueueStats 签名）。 */
export function queueStats(cwd) {
    try {
        const paths = workspacePaths(cwd || process.cwd());
        return pendingQueueStats(paths.pendingDir);
    } catch {
        return null;
    }
}
/** 本桶最近一次 memo_write 的毫秒时间戳（扫 memo-river.log，dsh/ZCode 写入共用此日志）。 */
export function lastWriteAt(cwd) {
    try {
        const paths = workspacePaths(cwd || process.cwd());
        const log = readFileSync(paths.logPath, 'utf8');
        const hits = [...log.matchAll(/\[([^\]]+)\] \[info\] memo_write bucket=/g)];
        const last = hits.at(-1);
        const ms = last ? Date.parse(last[1]) : NaN;
        return Number.isFinite(ms) ? ms : 0;
    } catch {
        return 0;
    }
}
/** 释放全部工作区（长进程收尾用；一次性脚本可不调）。 */
export { releaseAllWorkspaces };
