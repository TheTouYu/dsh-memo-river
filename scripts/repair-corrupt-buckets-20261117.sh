#!/usr/bin/env bash
# 2026-11-17 损坏桶修复 runbook（一次性；证据链：日记 + plugin.log 10-30/11-17 guardian 连败 + 三桶 corrupt-bak 留证）
# 必须以 systemd-run --user 脱离 dsh-web 进程树运行（脚本会停/起 dsh-web，会话随之中断）：
#   systemd-run --user --collect --unit=memo-repair-20261117 bash scripts/repair-corrupt-buckets-20261117.sh
# 幂等性：重复跑安全（损坏备份名带时间戳；恢复件只换一次）。
set -euo pipefail
ROOT=/var/tmp/memo-repair-20261117
REPO=/home/h/dsh-plugins/dsh-memo-river
MEMO=/home/h/.dsh/memo-river
mkdir -p "$ROOT"
exec >>"$ROOT/report.log" 2>&1
echo "=== $(date -Is) repair start (pid $$) ==="

# ① 停 dsh-web（所有桶连接退出，换件安全）
systemctl --user stop dsh-web
for _ in $(seq 1 30); do systemctl --user is-active --quiet dsh-web || break; sleep 0.5; done
if systemctl --user is-active --quiet dsh-web; then echo "FATAL: dsh-web 停不下来"; exit 1; fi
echo "dsh-web stopped"

# ② genshin-ts 桶（4bde…）：换入用户已验证的 .dump 修复副本（ok / files=673）
G="$MEMO/4bde2299850f027e"
if [ -f "$G/knowledge_base.repair-20261117.sqlite" ] && [ -f "$G/knowledge_base.sqlite" ]; then
  mv "$G/knowledge_base.sqlite" "$G/knowledge_base.sqlite.corrupt-bak-20261117b"
  mv "$G/knowledge_base.repair-20261117.sqlite" "$G/knowledge_base.sqlite"
fi
rm -f "$G/knowledge_base.sqlite-wal" "$G/knowledge_base.sqlite-shm"
echo "genshin swap: $(sqlite3 "$G/knowledge_base.sqlite" 'PRAGMA integrity_check(2);' | tr '\n' ' ') files=$(sqlite3 "$G/knowledge_base.sqlite" 'SELECT count(*) FROM files;')"

# ③ 另两桶（b94d=本仓、8d28=preset-composer）：走新哨兵的自动恢复（.recover → 校验 → 留证 → 换入）
for H in b94d8836d6175817 8d283eef828dccb0; do
  echo "auto-recover $H:"
  DBPATH="$MEMO/$H/knowledge_base.sqlite" node --input-type=module -e \
    "import { autoRecoverIfCorrupt } from '$REPO/lib/integrity.js'; const r = autoRecoverIfCorrupt(process.env.DBPATH); console.log('  ->', r.action, r.detail)" || true
done

# ④ 三桶复核（integrity + 行数）
for H in 4bde2299850f027e b94d8836d6175817 8d283eef828dccb0; do
  echo "verify $H: $(sqlite3 "$MEMO/$H/knowledge_base.sqlite" 'PRAGMA integrity_check(3);' | tr '\n' ' ') files=$(sqlite3 "$MEMO/$H/knowledge_base.sqlite" 'SELECT count(*) FROM files;' 2>&1)"
done

# ⑤ 起 dsh-web + 活体验证（新 lib 的 workspace-open / integrity 哨兵应出现在 plugin.log）
systemctl --user start dsh-web
sleep 8
if ! systemctl --user is-active --quiet dsh-web; then
  echo "FATAL: dsh-web start failed"
  systemctl --user status dsh-web --no-pager | head -15
  exit 1
fi
echo "dsh-web active"
sleep 20
echo "=== plugin.log tail ==="
tail -n 6 "$MEMO/plugin.log"
echo "=== $(date -Is) repair done ==="
