#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

./scripts/stop.sh
rm -rf .control-panel

echo "Removed PDF Tool control-panel runtime files."
