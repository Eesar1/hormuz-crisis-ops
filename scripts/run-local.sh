#!/usr/bin/env sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
trap 'kill 0 2>/dev/null || true' INT TERM EXIT
(cd "$ROOT/apps/server" && npm run dev) &
SERVER_PID=$!
(cd "$ROOT/apps/web" && npm run dev) &
WEB_PID=$!
echo "Server PID: $SERVER_PID | Web PID: $WEB_PID"
echo "Open http://localhost:3000/command"
wait
