#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
source "./scripts/service-common.sh"

if ! app_is_healthy; then
  exit 1
fi

if tmux has-session -t "$SESSION_NAME" >/dev/null 2>&1; then
  echo "PDF Tool is running in tmux."
  exit 0
fi

if managed_pids="$(managed_server_pids)" && [[ -n "$managed_pids" ]]; then
  echo "PDF Tool is running outside tmux (pid: ${managed_pids//$'\n'/, })."
  exit 0
fi

exit 1
