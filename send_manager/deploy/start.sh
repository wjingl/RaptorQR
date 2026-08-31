#!/usr/bin/env bash
# start — RaptorQR 服务（委托 service.sh）
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/service.sh" start "$@"
