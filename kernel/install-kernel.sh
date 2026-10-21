#!/usr/bin/env bash
# install-kernel.sh —— 内核二进制原子安装（2026-10-22 四连崩事故后立）
#
# 事故复盘（session-c83522c9，dsh-web NRestarts=3）：
#   cp 原地覆盖（O_TRUNC 写同一 inode）会替换 dsh-web 已 mmap 的 .node 代码页，
#   下一次调用即 SIGSEGV/SIGILL。cargo build 后直接 cp 是被旧文档带偏的危险操作。
# 修复原理：
#   先拷到同目录临时文件，再 mv（rename）——换新 inode，运行中进程继续用旧 inode，
#   不崩溃；新内核要等下次进程加载（dsh-web 需重启，重启时机必须先与用户确认）。
#
# 用法：cd kernel && cargo build --release && ./install-kernel.sh
#   （本脚本不做构建——构建失败就不该有任何安装动作；set -euo pipefail 防管道吞退出码）

set -euo pipefail
cd "$(dirname "$0")"

SRC="${1:-target/release/libmemo_kernel.so}"
DST="memo-kernel.linux-x64-gnu.node"

if [ ! -f "$SRC" ]; then
  echo "缺少构建产物 $SRC（先 cargo build --release）" >&2
  exit 1
fi

# 禁止再走原地覆盖（cp 直写同 inode）——一律走下面的「临时文件 + rename」。
# 同目录临时文件 + rename = 原子换 inode
TMP=".install-$$.tmp"
trap 'rm -f "$TMP"' EXIT
cp "$SRC" "$TMP"
sync "$TMP"
mv -f "$TMP" "$DST"
trap - EXIT

INODE=$(stat -c '%i' "$DST")
MTIME=$(stat -c '%y' "$DST")
echo "✅ 原子安装完成：$DST（inode=$INODE, mtime=$MTIME）"

if systemctl --user is-active --quiet dsh-web 2>/dev/null; then
  MAIN_PID=$(systemctl --user show dsh-web -p MainPID --value 2>/dev/null || true)
  echo "⚠️  dsh-web 正在运行（MainPID=${MAIN_PID:-?}）：它仍映射旧 inode。"
  echo "   新内核需重启 dsh-web 后生效——重启会斩断飞行中工具调用与会话，"
  echo "   必须先与用户确认时机（全局守则 2）。"
fi
