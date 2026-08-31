#!/usr/bin/env bash
# ============================================================================
# 备份：SQLite 在线安全备份（WAL 语义）+ secrets 复制 + 保留最近 N 份
# 用法：./deploy/backup.sh [备份目录]（默认 data/backups）
# ============================================================================
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="$DIR/runtime/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node)"
KEEP="${KEEP:-7}"
BACKUP_DIR="${1:-$DIR/data/backups}"

mkdir -p "$BACKUP_DIR"
"$NODE" "$DIR/scripts/cli.js" backup "$BACKUP_DIR"

# 保留最近 K 份（db-*.sqlite），清理更早的
ls -1t "$BACKUP_DIR"/db-*.sqlite 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "备份完成，保留最近 $KEEP 份："
ls -1t "$BACKUP_DIR"/db-*.sqlite | head -n "$KEEP"
