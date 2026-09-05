#!/bin/sh
# Transfer Hub portable launcher for macOS / Linux.
# Requires Python 3 (installed by default on macOS and most Linux distros).
cd "$(dirname "$0")" || exit 1

if command -v python3 >/dev/null 2>&1; then
  exec python3 server.py
elif command -v python >/dev/null 2>&1; then
  exec python server.py
else
  echo "Transfer Hub needs Python 3. Install it, then run this file again."
  exit 1
fi
