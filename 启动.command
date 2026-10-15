#!/bin/bash
set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "请先安装 Node.js 20+（含 npm），并确保 node 和 npm 在 PATH 中。"
  exit 1
fi

cd "$PROJECT_DIR"
npm run build:runtime
node server.mjs &
SERVER_PID=$!
sleep 1
open "http://127.0.0.1:4173"
wait "$SERVER_PID"
