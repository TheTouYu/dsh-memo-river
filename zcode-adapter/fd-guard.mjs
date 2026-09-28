/**
 * zcode-adapter/fd-guard.mjs — stdout 守护：Rust 原生日志与协议 JSON 分流。
 *
 * rust-vexus-lite（/home/h/app/VCPToolBox/rust-vexus-lite）直接向 fd 1 println!，
 * 且无日志开关——stdio JSON 流（MCP 的 JSON-RPC、hook 的 {"additionalContext":…}）
 * 会被 `[Vexus-Lite][EPA] …` 行打花，客户端第一行 JSON 就解析失败（实测复现）。
 *
 * 解法（respawn 守护，零原生依赖）：首次启动的父进程立刻重 spawn 自身，
 * stdio = ['inherit', 2, 2, 'pipe']：
 *   · 子进程 fd 1/2 → dup 到父进程的 stderr（原生日志照常可查，不再污染协议流）
 *   · 子进程 fd 3  → 专属管道，协议 JSON 只写这里，由父进程转发到真 stdout
 *
 * 用法（入口文件顶部）：
 *   import { runGuarded, protocolWrite } from './fd-guard.mjs';
 *   if (runGuarded(import.meta.url)) {
 *     // 父进程：转发已接管，无事可做
 *   } else {
 *     // 子进程：真正干活，输出一律走 protocolWrite(...)
 *   }
 */
import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PROTOCOL_FD = Number(process.env.MEMO_RIVER_PROTO_FD || 3);

/**
 * 守护入口。已在守护子进程里（MEMO_RIVER_GUARDED=1）返回 false；
 * 否则 respawn 守护子进程并返回 true（父进程此后只等子进程退出）。
 */
export function runGuarded(moduleUrl) {
    if (process.env.MEMO_RIVER_GUARDED === '1')
        return false;
    const selfPath = fileURLToPath(moduleUrl);
    const child = spawn(process.execPath, [selfPath], {
        env: { ...process.env, MEMO_RIVER_GUARDED: '1', MEMO_RIVER_PROTO_FD: '3' },
        /* fd1 不能 'inherit'——那会继承父进程 stdout，原生日志照样混进协议流；
         * 用 fd 号 2 让子进程 fd1/2 都 dup 到父进程的 stderr。 */
        stdio: ['inherit', 2, 2, 'pipe'],
    });
    child.stdio[3].pipe(process.stdout);
    for (const sig of ['SIGINT', 'SIGTERM'])
        process.on(sig, () => child.kill(sig));
    child.on('error', () => process.exit(1));
    child.on('exit', (code) => process.exit(code ?? 0));
    return true;
}

/** 协议输出：写守护管道 fd 3；管道不在（手动直跑未带 env）时退回常规 stdout。 */
export function protocolWrite(text) {
    try {
        writeSync(PROTOCOL_FD, text);
    } catch {
        process.stdout.write(text);
    }
}
