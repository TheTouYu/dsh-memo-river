#!/usr/bin/env node
/**
 * zcode-adapter/hook-stop.mjs — ZCode Stop hook（写入节律提醒）。
 *
 * 契约（ZCode hooks）：Stop 事件 hook 进程从 stdin 收 JSON，stdout 输出
 * {"additionalContext":"文本"} 则该文本注入对话上下文（下一轮可见）。
 *
 * 语义（lib/injector.js evaluateWriteNudge 的 ZCode 映射，双锚来自
 * bundle/cordis.patch.yml :100-105 的生产拍板）：
 *   · 汇报轮锚 writeNudgeEveryTurns=2 —— 每个 Stop 视为一个回合收尾；
 *     距上次写入/提醒累计 ≥2 个回合且有新 prompt（进展）→ 提醒。
 *   · 时间锚 writeNudgeEveryMinutes=7 —— 距上次写入/提醒 ≥7 分钟且有进展 → 提醒。
 *     （dsh 侧量的是 activeMs「模型实际思考时间」；hook 进程测不到流时长，
 *     退化为墙钟口径——README 已注明差异。）
 *   · 写入时钟：扫桶内 memo-river.log 的 `memo_write bucket=` 行——dsh 与 ZCode
 *     的 memo_write 共用该日志，任一侧写入都会重置两侧节律。
 *   · 文案：lib/render.js renderWriteNudge（与 dsh 侧逐字同格式，含接续锚 /
 *     草稿队列读数）；无桶 / 无进展 / 未到锚 → 输出 {}。
 *   · 任何异常 → {}，绝不非零退出。
 */
import { runGuarded, protocolWrite } from './fd-guard.mjs';
import * as headless from './headless.mjs';
import { renderWriteNudge } from '../lib/render.js';
import { workspacePaths } from '../lib/runtime.js';
import { existsSync } from 'node:fs';

const WATCHDOG_MS = Number(process.env.MEMO_ZCODE_HOOK_TIMEOUT_MS) || 15_000;
const EVERY_TURNS = 2; // writeNudgeEveryTurns（cordis.patch.yml :105）
const EVERY_MINUTES = 7; // writeNudgeEveryMinutes（cordis.patch.yml :104）

const emit = (payload) => {
    try {
        protocolWrite(`${JSON.stringify(payload)}\n`);
    } catch { /* 管道已关：尽力而为 */ }
};
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
    });
}

async function main() {
    let input = {};
    try {
        input = JSON.parse((await readStdin()) || '{}');
    } catch {
        input = {};
    }
    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
    const sessionId = typeof input.session_id === 'string' && input.session_id ? input.session_id : 'default';

    /* 无桶：这个工作区还没有记忆河流，Stop 提醒无从谈起 */
    if (!existsSync(workspacePaths(cwd).dbPath)) {
        emit({});
        return;
    }

    const now = Date.now();
    const state = headless.readHookState(cwd);
    /* 写入时钟：桶日志里的最近 memo_write（dsh/ZCode 共用），与状态文件缓存取大 */
    const loggedWrite = headless.lastWriteAt(cwd);
    state.lastWriteAt = Math.max(state.lastWriteAt ?? 0, loggedWrite);

    const sessions = state.sessions ?? {};
    const prev = sessions[sessionId] ?? {};
    /* 锚点 = 上次写入 / 上次提醒 / 会话锚点三者取最新 */
    const anchorAt = Math.max(prev.anchorAt ?? 0, state.lastWriteAt ?? 0);
    const stops = (prev.stops ?? 0) + 1;
    const minutesSince = (now - anchorAt) / 60_000;
    /* 进展 = 锚点之后有新用户 prompt（hook-submit 落的 lastPromptAt） */
    const progress = (state.lastPromptAt ?? 0) > anchorAt;

    const turnsDue = progress && stops >= EVERY_TURNS;
    const timeDue = progress && minutesSince >= EVERY_MINUTES;

    if (!turnsDue && !timeDue) {
        sessions[sessionId] = { ...prev, stops };
        state.sessions = sessions;
        headless.writeHookState(cwd, state);
        emit({});
        return;
    }

    const reason = turnsDue
        ? `已 ${stops} 轮汇报未写入`
        : `已 ${Math.max(1, Math.round(minutesSince))} 分钟未写`;
    /* Stop hook 看不到助手正文：digest 回落到 dsh 自主态同款兜底文案 */
    const digest = (state.lastPrompt || '').slice(0, 80) || '本轮对话进展';
    const text = renderWriteNudge(reason, stops, digest, [], headless.queueStats(cwd), false, headless.lastDiaryTail(cwd), 0, null);

    sessions[sessionId] = { ...prev, stops: 0, anchorAt: now, lastNudgeAt: now };
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
        process.exit(0);
    });
}
