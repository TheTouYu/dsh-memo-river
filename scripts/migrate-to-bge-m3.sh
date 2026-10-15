#!/usr/bin/env bash
# 一步式 bge-m3 迁移：停 dsh-web → 全库向量重嵌 → 起 dsh-web → 自检验收。
#
# ⚠️ 必须**脱离 dsh-web 进程树**运行，否则第①步停服务会把脚本自己一起杀掉：
#     systemd-run --user --unit=memo-bgem3-migration --collect \
#       bash /home/h/dsh-plugins/dsh-memo-river/scripts/migrate-to-bge-m3.sh
#
# 日志 /var/tmp/memo-bgem3-migration.log，状态 /var/tmp/memo-bgem3-migration.status。
# 设计取舍：宁可让 GUI 停 20-40 分钟，也不做「先重嵌再重启」——那种顺序会让
# 半迁移状态下的活进程拿旧维度写新库（混维度 → 内核 decode_vector 全 None）。
set -uo pipefail
# systemd-run 起的单元环境很干净：显式补 PATH（本机 node/curl/systemctl 都在 /usr/sbin）
export PATH=/usr/sbin:/usr/bin:/sbin:/bin:$PATH
# 批量迁移关掉端点跳闸：一次瞬时失败不该把剩下几百条一起短路
export EMB_BREAKER=0

REPO=/home/h/dsh-plugins/dsh-memo-river
LOG=/var/tmp/memo-bgem3-migration.log
STATUS=/var/tmp/memo-bgem3-migration.status
: > "$LOG"
echo "RUNNING $(date -Is)" > "$STATUS"

say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

say "=== bge-m3 迁移开始（日志 $LOG）==="
say "目标：openrouter.ai/api · baai/bge-m3 · dim 1024（原 relayrouter · gemini-embedding-2-preview · 3072）"
sleep 10   # 给这条汇报留送达时间，随后停服务会断开 GUI 会话

say "① 停 dsh-web（GUI 会话与飞行中的调用会断开）"
if ! systemctl --user stop dsh-web; then
  say "✗ 停服务失败，未做任何写入"
  echo "FAILED stop $(date -Is)" > "$STATUS"
  exit 1
fi
for _ in $(seq 1 30); do systemctl --user is-active --quiet dsh-web || break; sleep 1; done
say "   dsh-web 状态：$(systemctl --user is-active dsh-web)（服务已停，独占库访问）"

say "② 全库重嵌（每桶先备份再事务写入）"
cd "$REPO" || { echo "FAILED cd $(date -Is)" > "$STATUS"; exit 1; }
node scripts/reembed-migrate.mjs --apply 2>&1 | tee -a "$LOG"
rc=${PIPESTATUS[0]}
say "   重嵌退出码=$rc（0 = 全部桶成功；非 0 见上面 ✗ 行）"

say "③ 起 dsh-web"
systemctl --user start dsh-web || say "✗ 启动失败（需人工介入）"
code=000
for _ in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3080 || true)
  case "$code" in 200|401|403) break ;; esac   # 401/403 = 服务在应答（GUI 根路径要鉴权），不是故障
  sleep 2
done
say "   HTTP 探测 127.0.0.1:3080 → $code"

say "④ 验收：查询场套件（零端点依赖，判据 6/6）"
if [ -f scripts/acceptance-queryfield.mjs ]; then
  node scripts/acceptance-queryfield.mjs 2>&1 | tail -25 | tee -a "$LOG"
  qf=${PIPESTATUS[0]}
  say "   acceptance-queryfield 退出码=$qf"
else
  say "   （未找到 acceptance-queryfield.mjs，跳过）"
  qf=255
fi

if [ "$rc" -eq 0 ] && [ "$code" != "000" ] && [ "$qf" -eq 0 ]; then
  echo "DONE $(date -Is) reembed=$rc http=$code queryfield=$qf" > "$STATUS"
  say "=== ✅ 迁移完成：切到 baai/bge-m3（1024 维） ==="
else
  echo "ATTENTION $(date -Is) reembed=$rc http=$code queryfield=$qf" > "$STATUS"
  say "=== ⚠️ 迁移结束但有需要人看的项：重嵌=$rc HTTP=$code 查询场套件=$qf ==="
fi
say "回看：cat $LOG   状态：cat $STATUS"
say "建议人工抽查一次：新会话里问一句需要历史知识的话，看被动召回是否命中，或直接调 memo_recall 看 score/gate。"
