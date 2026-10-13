#!/usr/bin/env bash
set -euo pipefail

PORT="${PDF_TOOL_PORT:-4315}"
open "http://127.0.0.1:$PORT"
