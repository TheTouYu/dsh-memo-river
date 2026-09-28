#!/usr/bin/env node
/**
 * scripts/memo-inherit.mjs — 桶继承配置 CLI（inherit-0928）。
 *
 * 用法（在目标工作区目录里跑，或用 --cwd / --bucket 指定目标桶）：
 *   node scripts/memo-inherit.mjs list
 *   node scripts/memo-inherit.mjs add <父桶名|16位哈希>...
 *   node scripts/memo-inherit.mjs remove <父桶名|16位哈希>...
 *
 * 效果：目标桶的**被动注入**（初始上下文）会联邦检索父桶——主桶照常全管线，
 * 父桶各过自己门控后轮转补位（每父桶 ≤2 条，注入块里标注 `D<id>@<父桶>`）。
 * 主动补证不需要继承（memo_recall 的 folder 参数本来就真路由任意桶）；写入永不落父桶。
 *
 * 配置落在目标桶 workspace.json 的 `inherit` 字段（与 dsh / zcode-adapter 同一份状态根）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveBucket } from '../lib/workspace.js'
import { workspacePaths } from '../lib/runtime.js'

const USAGE = `用法：node scripts/memo-inherit.mjs [--cwd <目录>|--bucket <桶名>] <list|add|remove> [父桶名|16位哈希...]]

  list              查看目标桶的继承链（含各父桶解析状态）
  add <父桶>...     追加父桶（须已存在且有库；拒绝自继承与重复项）
  remove <父桶>...  按桶名或哈希移除父桶`;

/* ── 参数解析：命令前的是 flag，命令后的是位置参数 ── */
const argv = process.argv.slice(2);
function flagValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv.splice(i, 2)[1] : undefined;
}
const bucketFlag = flagValue('--bucket');
const cwdFlag = flagValue('--cwd');
const command = argv.find((a) => !a.startsWith('-'));
const operands = argv.filter((a) => a !== command);
if (!command || !['list', 'add', 'remove'].includes(command) || (command === 'add' && operands.length === 0) || (command === 'remove' && operands.length === 0)) {
  console.error(USAGE);
  process.exit(1);
}

/* ── 目标桶解析：--bucket 走 resolveBucket，否则按 cwd 哈希（与 hook 同口径） ── */
let target;
if (bucketFlag) {
  const r = resolveBucket(bucketFlag);
  if (!r.ok) {
    console.error(r.error);
    process.exit(1);
  }
  target = r.entry;
} else {
  const dir = cwdFlag || process.cwd();
  const paths = workspacePaths(dir);
  if (!existsSync(paths.dbPath)) {
    console.error(`此工作区（${dir}）还没有记忆桶——先 memo_write 一篇建桶，再配置继承。`);
    process.exit(1);
  }
  target = { root: paths.root, bucket: paths.bucket, hash: paths.hash, cwd: dir, hasDb: true };
}

/* ── manifest 读改写（保持 ensureWorkspaceDirs 的缩进风格；绝不碰其他字段） ── */
const manifestPath = join(target.root, 'workspace.json');
const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : { cwd: target.cwd ?? null, bucket: target.bucket, hash: target.hash, createdAt: new Date().toISOString() };
const current = Array.isArray(manifest.inherit)
  ? manifest.inherit.filter((x) => typeof x === 'string' && x.trim() !== '')
  : [];

function save(list) {
  if (list.length === 0) delete manifest.inherit;
  else manifest.inherit = list;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

/* ── 子命令 ── */
if (command === 'list') {
  console.log(`目标桶：${target.bucket}@${target.hash}（${target.root}）`);
  if (current.length === 0) {
    console.log('继承链：(空)');
  } else {
    console.log(`继承链（${current.length} 个）：`);
    for (const name of current) {
      const r = resolveBucket(name);
      if (!r.ok) console.log(`  ✗ ${name} —— 解析失败：${r.error.split('\n')[0]}`);
      else console.log(`  ✓ ${r.entry.bucket}@${r.entry.hash}（${r.entry.cwd ?? r.entry.root}）`);
    }
  }
  process.exit(0);
}

if (command === 'add') {
  const added = [];
  for (const name of operands.map((s) => s.trim()).filter(Boolean)) {
    const r = resolveBucket(name);
    if (!r.ok) {
      console.error(`✗ 父桶「${name}」不可用：${r.error.split('\n')[0]}`);
      process.exit(1);
    }
    if (r.entry.hash === target.hash) {
      console.error(`✗ 不能继承自己（${target.bucket}@${target.hash}）`);
      process.exit(1);
    }
    /* 同桶已配（按解析后的哈希判重，桶名/哈希两种写法等价）；manifest 原文保留首次写法 */
    if (current.some((n) => resolveBucket(n).ok && resolveBucket(n).entry.hash === r.entry.hash)) {
      console.log(`· 已在继承链：${r.entry.bucket}@${r.entry.hash}`);
      continue;
    }
    current.push(name);
    added.push(`${r.entry.bucket}@${r.entry.hash}`);
  }
  save(current);
  console.log(added.length > 0 ? `✅ 已追加：${added.join('、')}` : '（无变更）');
  console.log(`当前继承链（${current.length} 个）：${current.join('、') || '(空)'}`);
  process.exit(0);
}

/* remove：按桶名或哈希匹配（配置里两种写法都可能） */
const kept = [];
let removed = 0;
for (const name of current) {
  const hit = operands.some((op) => {
    if (name === op) return true;
    const r = resolveBucket(name);
    return r.ok && (r.entry.hash === op || r.entry.bucket === op);
  });
  if (hit) removed += 1;
  else kept.push(name);
}
save(kept);
console.log(removed > 0 ? `✅ 已移除 ${removed} 项` : '（无匹配项，未变更）');
console.log(`当前继承链（${kept.length} 个）：${kept.join('、') || '(空)'}`);
