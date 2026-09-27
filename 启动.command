#!/bin/bash
set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  NODE_BIN="/Users/bytedance/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
fi

cd "$PROJECT_DIR"
"$NODE_BIN" server.mjs &
SERVER_PID=$!
sleep 1
open "http://127.0.0.1:4173"
wait "$SERVER_PID"
