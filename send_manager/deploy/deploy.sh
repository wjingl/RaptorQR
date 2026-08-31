#!/usr/bin/env bash
# ============================================================================
# RaptorQR 发送端管理系统 —— 一键部署
# 环境：Linux x86（glibc 主流发行版）；服务器无环境、不可联网也可用
#   （部署包已内置 node_modules 全量 + 可选捆绑 Node 运行时）
# 用法：
#   sudo ./deploy/deploy.sh
#   或自定义安装目录：  INSTALL_DIR=/opt/raptorqr ./deploy/deploy.sh
# 说明：优先 systemd（推荐，带安全加固），无 systemd 时退回 nohup 托管。
# ============================================================================
set -euo pipefail

APP_NAME="raptorqr-sender"
PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${INSTALL_DIR:-$PKG_DIR}"
SERVICE_USER="${SERVICE_USER:-rqr}"
PORT="${PORT:-1145}"
HOST="${HOST:-0.0.0.0}"

# 超级管理员引导（可选）：部署时通过环境变量注入，未配置则使用默认凭据并强制改密
ADMIN_ENV_LINE=""
[ -n "${RQR_ADMIN_USERNAME:-}" ] && ADMIN_ENV_LINE="$ADMIN_ENV_LINE
Environment=RQR_ADMIN_USERNAME=$RQR_ADMIN_USERNAME"
[ -n "${RQR_ADMIN_PASSWORD:-}" ] && ADMIN_ENV_LINE="$ADMIN_ENV_LINE
Environment=RQR_ADMIN_PASSWORD=$RQR_ADMIN_PASSWORD"
[ -n "${RQR_ADMIN_DISPLAY:-}" ] && ADMIN_ENV_LINE="$ADMIN_ENV_LINE
Environment=RQR_ADMIN_DISPLAY=$RQR_ADMIN_DISPLAY"

say()  { printf '\033[1;32m[部署]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[注意]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[失败]\033[0m %s\n' "$*" >&2; exit 1; }

[ -d "$INSTALL_DIR" ] || mkdir -p "$INSTALL_DIR"

# ---------- 1. 确定 Node 运行时（优先捆绑，保证 ABI 一致） ----------
if [ -x "$PKG_DIR/runtime/bin/node" ]; then
  NODE="$PKG_DIR/runtime/bin/node"
  say "使用捆绑运行时：$($NODE -v)"
elif command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
  VER="$("$NODE" -v)"
  MAJOR="${VER#v}"; MAJOR="${MAJOR%%.*}"
  [ "$MAJOR" -ge 22 ] || die "系统 Node 版本过低（$VER），需 >=22。请将 Node 24 放入部署包 runtime/ 目录后重试。"
  say "使用系统 Node：$VER"
else
  die "未找到 Node 运行时。请把 Node 24 linux-x64 解压到部署包 runtime/ 目录后重试。"
fi
NPM="$NODE"

# ---------- 2. 依赖就绪校验（部署包须已含 node_modules，服务器离线） ----------
if [ ! -d "$PKG_DIR/node_modules" ]; then
  die "node_modules 缺失：请使用 scripts/build_package.sh 在联网构建机上打包后重新部署。"
fi
say "依赖就绪：$(ls "$PKG_DIR"/node_modules | wc -l) 个包"

# ---------- 3. 安装到目标目录（数据与配置保留策略） ----------
if [ "$INSTALL_DIR" != "$PKG_DIR" ]; then
  say "安装到 $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  # 保留已有 data/ 与 config.json / secrets
  for keep in data config.json; do
    [ -e "$INSTALL_DIR/$keep" ] && cp -a "$INSTALL_DIR/$keep" "$PKG_DIR/.keep-$keep" 2>/dev/null || true
  done
  cp -a "$PKG_DIR/." "$INSTALL_DIR/" || true
  for keep in data config.json; do
    [ -e "$PKG_DIR/.keep-$keep" ] && { rm -rf "$INSTALL_DIR/$keep"; mv "$PKG_DIR/.keep-$keep" "$INSTALL_DIR/$keep"; } || true
  done
fi
cd "$INSTALL_DIR"

# ---------- 4. 配置初始化 ----------
if [ ! -f config.json ]; then
  cp config.example.json config.json
  warn "已生成 config.json（默认端口 $PORT）。请检查 batchRegister.initialPassword 后重启。"
fi
# 用传入的 PORT/HOST 更新配置（仅当 config.json 使用默认值且传入不同值）
if grep -q '"port": *1145' config.json 2>/dev/null && [ "$PORT" != "1145" ]; then
  sed -i "s/\"port\": *1145/\"port\": $PORT/" config.json
fi
if grep -q '"host": *"0.0.0.0"' config.json 2>/dev/null && [ "$HOST" != "0.0.0.0" ]; then
  sed -i "s/\"host\": *\"0.0.0.0\"/\"host\": \"$HOST\"/" config.json
fi
mkdir -p data

# ---------- 5. 专用服务账号（非 root 运行） ----------
RUN_AS_ROOT=0
if [ "$(id -u)" = "0" ]; then RUN_AS_ROOT=1; fi
if [ "$RUN_AS_ROOT" = "1" ]; then
  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    useradd -r -s /usr/sbin/nologin "$SERVICE_USER"
    say "已创建系统服务账号：$SERVICE_USER"
  fi
  chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR" 2>/dev/null || true
  chmod 700 data
fi

# ---------- 6. 启动方式 ----------
PORT_FROM_CFG="$(grep -oP '"port"\s*:\s*\K[0-9]+' config.json 2>/dev/null || echo "$PORT")"

install_systemd() {
  local unit="/etc/systemd/system/$APP_NAME.service"
  cat > "$unit" <<EOF
[Unit]
Description=RaptorQR 发送端管理系统
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
Environment=RQR_CONFIG=$INSTALL_DIR/config.json
$ADMIN_ENV_LINE
ExecStart=$NODE $INSTALL_DIR/app/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$INSTALL_DIR/data
CapabilityBoundingSet=
AmbientCapabilities=
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "$APP_NAME" >/dev/null 2>&1 || true
  systemctl restart "$APP_NAME"
  say "systemd 服务已安装并启动：$APP_NAME"
}

install_nohup() {
  "$NODE" "$INSTALL_DIR/app/server.js" >> "$INSTALL_DIR/data/nohup.log" 2>&1 &
  echo $! > "$INSTALL_DIR/data/$APP_NAME.pid"
  say "nohup 托管启动，PID=$(cat "$INSTALL_DIR/data/$APP_NAME.pid")（日志：data/nohup.log）"
}

if command -v systemctl >/dev/null 2>&1 && [ "$RUN_AS_ROOT" = "1" ]; then
  install_systemd
else
  if [ "$RUN_AS_ROOT" != "1" ]; then
    warn "未以 root 运行，无法安装 systemd 服务，使用 nohup 托管。生产环境请用 root 执行以启用 systemd 加固。"
  fi
  # nohup 路径：通过 env 前缀传递管理员引导配置
  export RQR_ADMIN_USERNAME="${RQR_ADMIN_USERNAME:-}"
  export RQR_ADMIN_PASSWORD="${RQR_ADMIN_PASSWORD:-}"
  export RQR_ADMIN_DISPLAY="${RQR_ADMIN_DISPLAY:-}"
  install_nohup
fi

# ---------- 7. 健康检查 ----------
say "健康检查中（端口 $PORT_FROM_CFG）..."
for i in $(seq 1 15); do
  if "$NODE" -e "fetch('http://127.0.0.1:$PORT_FROM_CFG/api/health').then(r=>{if(r.ok)process.exit(0);process.exit(1)}).catch(()=>process.exit(1))" 2>/dev/null; then
    say "服务已就绪！"
    break
  fi
  [ "$i" = "15" ] && die "健康检查超时，请查看日志：$INSTALL_DIR/data/logs/ 或 data/nohup.log"
  sleep 1
done

# ---------- 8. 输出访问信息 ----------
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -z "$IP" ] && IP="<服务器IP>"
say "============================================================"
say "  部署完成！访问地址：  http://$IP:$PORT_FROM_CFG"
say "  超级管理员：已按 config.admin.bootstrap 自动创建"
say "    （未配置时使用默认：admin / Admin@1145，首次登录强制改密）"
say "  或已配置 RQR_ADMIN_USERNAME/RQR_ADMIN_PASSWORD 环境变量则使用之"
say "  常用命令： ./deploy/status.sh  ./deploy/backup.sh  ./deploy/update.sh"
say "  安全提醒：请仅在办公网段放行端口 $PORT_FROM_CFG（防火墙/安全组）"
say "============================================================"
