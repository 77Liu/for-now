#!/bin/bash
set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "请先安装 Node.js 20+（含 npm），并确保 node 和 npm 在 PATH 中。"
  exit 1
fi

cd "$PROJECT_DIR"
if [ "${AUTH_REQUIRED:-0}" != "1" ] && [ "${LOCAL_TEST_MODE:-0}" != "1" ]; then
  echo "普通无认证业务模式已退役。"
  echo "账户模式请先配置 AUTH_REQUIRED=1、INVITE_CODE_HASH 和持久化环境；隔离功能验收请运行 npm run start:local-test。"
  exit 2
fi
npm run build:runtime
node server.mjs &
SERVER_PID=$!
sleep 1
open "http://127.0.0.1:4173"
wait "$SERVER_PID"
