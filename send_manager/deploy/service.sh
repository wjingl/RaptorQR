#!/usr/bin/env bash
# ============================================================================
# 服务管理：start / stop / restart / status
# 自动识别 systemd 或 nohup 托管方式
# ============================================================================
set -euo pipefail
APP_NAME="raptorqr-sender"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="$DIR/runtime/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node)"
PIDFILE="$DIR/data/$APP_NAME.pid"

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q "$APP_NAME"; then
  case "${1:-status}" in
    start)   systemctl start "$APP_NAME" ;;
    stop)    systemctl stop "$APP_NAME" ;;
    restart) systemctl restart "$APP_NAME" ;;
    status)  systemctl status "$APP_NAME" --no-pager || true ;;
    *) echo "用法: $0 {start|stop|restart|status}"; exit 1 ;;
  esac
else
  case "${1:-status}" in
    start)
      if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
        echo "已在运行 (PID $(cat "$PIDFILE"))"
      else
        "$NODE" "$DIR/app/server.js" >> "$DIR/data/nohup.log" 2>&1 &
        echo $! > "$PIDFILE"
        echo "已启动 (PID $(cat "$PIDFILE"))"
      fi
      ;;
    stop)
      [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null && rm -f "$PIDFILE" && echo "已停止" || echo "未在运行"
      ;;
    restart) "$0" stop; sleep 1; "$0" start ;;
    status)
      if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
        echo "运行中 (PID $(cat "$PIDFILE"))"
      else
        echo "未运行"
        exit 1
      fi
      ;;
    *) echo "用法: $0 {start|stop|restart|status}"; exit 1 ;;
  esac
fi
