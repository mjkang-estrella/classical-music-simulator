#!/usr/bin/env bash
# Run a Blender Python script headless.
#   tools/blender/run.sh <script.py> [script args...]
# Override the binary with BLENDER=/path/to/blender.
set -euo pipefail
BLENDER="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
if [[ $# -lt 1 ]]; then
  echo "usage: $0 <script.py> [args...]" >&2
  exit 2
fi
script="$1"; shift
exec "$BLENDER" -b --factory-startup -noaudio --python-exit-code 1 -P "$script" -- "$@"
