#!/usr/bin/env bash

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION_NAME="pdf-tool-vite"
PORT="${PDF_TOOL_PORT:-4315}"
APP_URL="http://127.0.0.1:$PORT"

project_server_pids() {
  lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true
}

is_project_server_pid() {
  local pid="$1"
  local cwd
  local command

  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"

  [[ "$cwd" == "$ROOT_DIR" ]] && [[ "$command" == *"vite"* ]]
}

managed_server_pids() {
  local pid
  while IFS= read -r pid; do
    [[ -n "$pid" ]] && is_project_server_pid "$pid" && echo "$pid"
  done < <(project_server_pids)
}

app_is_healthy() {
  curl --fail --silent --max-time 2 "$APP_URL" >/dev/null
}
