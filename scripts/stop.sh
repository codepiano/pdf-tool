#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
source "./scripts/service-common.sh"

tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true

for pid in $(managed_server_pids); do
  echo "Stopping PDF Tool process $pid"
  kill "$pid" 2>/dev/null || true
done

for _ in $(seq 1 20); do
  [[ -z "$(managed_server_pids)" ]] && break
  sleep 0.25
done

for pid in $(managed_server_pids); do
  echo "Force stopping PDF Tool process $pid"
  kill -9 "$pid" 2>/dev/null || true
done

echo "Stopped PDF Tool."
