#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
source "./scripts/service-common.sh"

LOG_FILE=".control-panel/vite.log"
mkdir -p .control-panel

if ./scripts/status.sh >/dev/null 2>&1; then
  echo "PDF Tool is already running."
  exit 0
fi

tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use; refusing to start PDF Tool." >&2
  exit 1
fi

tmux new-session -d -s "$SESSION_NAME" -c "$ROOT_DIR" \
  "exec npm run dev -- --host 127.0.0.1 --port '$PORT' --strictPort >> '$LOG_FILE' 2>&1"

for _ in $(seq 1 30); do
  if ./scripts/status.sh >/dev/null 2>&1; then
    echo "Started PDF Tool at $APP_URL"
    exit 0
  fi
  sleep 0.5
done

echo "PDF Tool failed to start. See $LOG_FILE" >&2
exit 1
