#!/usr/bin/env node
/**
 * zcode-adapter/hook-submit.mjs — ZCode UserPromptSubmit hook（被动召回注入）。
 *
 * 契约（ZCode hooks）：hook 进程从 stdin 收 JSON（含用户 prompt），进程 cwd 即会话
 * 工作目录；stdout 输出 {"additionalContext":"文本"} 则该文本注入对话上下文。
 *
 * 语义（lib/injector.js buildTailInjection 的单消息窗口版）：
 *   · cwd 算桶（workspaceHash，与 dsh 同一状态根 ~/.dsh/memo-river/）
 *   · recall 走 gate / topology_v3 / tokenBudget=3500 / embedTimeoutMs=8000 生产调参
 *   · 注入块用 lib/render.js renderInjection（与 dsh 侧逐字同格式）
 *   · 入选集合去重（dedupeSelection）落在桶内 zcode-hook-state.json——hook 每 prompt
 *     一个进程，dsh 侧的会话内 Map 在这里只能落盘；dedupeRefreshTurns=8 映射为
 *     「隔 8 次 prompt 强制重注」
 *   · embed 失败 / gate 不过 / 无桶 / 任何异常 → stdout 输出 {}：绝不阻塞、绝不非零退出
 */
import { runGuarded, protocolWrite } from './fd-guard.mjs';
import * as headless from './headless.mjs';
import { workspacePaths } from '../lib/runtime.js';
import { existsSync } from 'node:fs';

const WATCHDOG_MS = Number(process.env.MEMO_ZCODE_HOOK_TIMEOUT_MS) || 30_000;
const DEDUPE_REFRESH_PROMPTS = 8; // config.inject.dedupeRefreshTurns 的 prompt 计数版

const emit = (payload) => {
    try {
        protocolWrite(`${JSON.stringify(payload)}\n`);
    } catch { /* 管道已关：尽力而为 */ }
};

/* 看门狗：任何卡死（嵌入慢 / 原生重建）都不许拖住 ZCode 主循环。 */
const watchdog = setTimeout(() => {
    emit({});
    process.exit(0);
}, WATCHDOG_MS);
watchdog.unref?.();

function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (c) => { data += c; });
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', () => resolve(''));
        /* stdin 永不关闭的病态情形：看门狗兜底 */
    });
}

async function main() {
    let input = {};
    try {
        input = JSON.parse((await readStdin()) || '{}');
    } catch {
        input = {};
    }
    const prompt = typeof input.prompt === 'string' ? input.prompt : String(input.input ?? input.message ?? '');
    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
    const sessionId = typeof input.session_id === 'string' && input.session_id ? input.session_id : 'default';

    /* 无桶：静默 {}（不建桶、不落状态——否则每个陌生 cwd 都会在状态根长出空桶目录） */
    if (!existsSync(workspacePaths(cwd).dbPath)) {
        emit({});
        return;
    }

    /* 进展标记 + 去重状态（与 hook-stop 共享同一份桶内状态文件） */
    const state = headless.readHookState(cwd);
    state.lastPromptAt = Date.now();
    state.lastPrompt = prompt.slice(0, 200);

    const { text, outcome, reason } = await headless.injectRecall({ cwd, prompt });
    if (!text) {
        /* gate 不过 / embed 失败 / 无桶 → {}（绝不阻塞） */
        state.sessions = state.sessions ?? {};
        state.sessions[sessionId] = { ...(state.sessions[sessionId] ?? {}), promptCount: (state.sessions[sessionId]?.promptCount ?? 0) + 1 };
        headless.writeHookState(cwd, state);
        emit({});
        return;
    }
    /* 入选集合去重（dedupeSelection：同一组日记连续注入没有新信息） */
    const sessions = state.sessions ?? {};
    const prev = sessions[sessionId] ?? {};
    const selectionKey = outcome.selected.map((c) => c.id).sort((a, b) => a - b).join(',');
    const promptCount = (prev.promptCount ?? 0) + 1;
    const refreshDue = promptCount - (prev.lastInjectPromptCount ?? -Infinity) >= DEDUPE_REFRESH_PROMPTS;
    if (selectionKey && selectionKey === prev.lastSelectionKey && !refreshDue) {
        sessions[sessionId] = { ...prev, promptCount, lastSelectionKey: prev.lastSelectionKey };
        state.sessions = sessions;
        headless.writeHookState(cwd, state);
        emit({}); // 同集合不重注（压缩风险由 refreshDue 兜底）
        return;
    }
    sessions[sessionId] = { ...prev, promptCount, lastSelectionKey: selectionKey, lastInjectPromptCount: promptCount, lastInjectAt: Date.now() };
    state.sessions = sessions;
    headless.writeHookState(cwd, state);
    emit({ additionalContext: text });
}

/* 入口：父进程只 respawn + 转发（原生日志去 stderr）；子进程干活。 */
if (runGuarded(import.meta.url)) {
    /* 父进程：fd-guard 已接管 stdout */
} else {
    main()
        .catch(() => emit({}))
        .finally(() => {
        clearTimeout(watchdog);
        try {
            headless.releaseAllWorkspaces?.();
        }
        catch { /* 收尾失败静默 */ }
        process.exit(0);
    });
}
