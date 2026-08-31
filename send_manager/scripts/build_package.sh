#!/usr/bin/env bash
# ============================================================================
# 构建部署包：在联网构建机上运行
# 用法：
#   ./scripts/build_package.sh                # 仅打代码包（要求 runtime/ 已存在）
#   ./scripts/build_package.sh --no-node      # 打不含 Node 运行时的代码包
# 产物：dist/RaptorQR_Server_vX.Y.Z.tar.gz
# ============================================================================
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo 1.0.0)"
WITH_NODE=1
for a in "$@"; do
  [ "$a" = "--no-node" ] && WITH_NODE=0
done

echo "== 1/3 依赖重建 =="
NPM="$DIR/runtime/bin/npm"; [ -x "$NPM" ] || NPM="$(command -v npm)"
[ -x "$NPM" ] || { echo "缺少 npm"; exit 1; }
# 注意：须先完整安装（含 devDeps，部分依赖的 prepare 脚本会在安装时构建 dist/），
# 再用 prune --omit=dev 移除开发依赖 —— 不能直接用 ci --omit=dev（会导致 dist 缺失）。
"$NPM" ci --no-audit --no-fund
"$NPM" prune --omit=dev --no-audit --no-fund
[ -d node_modules ] || { echo "node_modules 安装失败"; exit 1; }

echo "== 2/3 前置产物 =="
# 确保发送页副本与接收端产物存在
if [ ! -f app/sender/RaptorQR_彩色版.html ]; then
  "$DIR/runtime/bin/node" scripts/prep.js
fi
[ -f receiver/out/real.html ] || "$DIR/runtime/bin/node" receiver/build_receiver.js
[ -f receiver/out/release.html ] || "$DIR/runtime/bin/node" receiver/build_receiver.js

if [ "$WITH_NODE" = "1" ] && [ ! -x runtime/bin/node ]; then
  echo "警告：未检测到 runtime/bin/node。如需捆绑 Node 24 运行时："
  echo "  curl -L https://nodejs.org/dist/latest-v24.x/node-v24.*-linux-x64.tar.xz | tar -xJ -C runtime --strip-components=1"
fi

echo "== 3/3 打包 =="
DIST="dist"
rm -rf "$DIST"; mkdir -p "$DIST"
TARBALL="$DIST/RaptorQR_Server_v${VERSION}.tar.gz"
# 注意：不能排除 'dist'（会连带排除 node_modules 内所有依赖的 dist/ 产物）
EXCLUDE=(--exclude='data' --exclude='node_modules/.cache' --exclude='*.log')
INCLUDE=(app receiver scripts deploy config.example.json package.json package-lock.json README.md)
[ -d node_modules ] && INCLUDE+=(node_modules)
if [ "$WITH_NODE" = "1" ] && [ -x runtime/bin/node ]; then
  INCLUDE+=(runtime)
fi
tar -czf "$TARBALL" "${EXCLUDE[@]}" "${INCLUDE[@]}"

echo "完成：$TARBALL"
echo "（内含 node_modules 全量；捆绑 Node 运行时: $([ -x runtime/bin/node ] && echo 是 || echo 否)）"
ls -lh "$TARBALL"
