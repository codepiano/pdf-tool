#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

mkdir -p .control-panel
npm install

echo "Initialized PDF Tool."
