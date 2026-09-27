#!/usr/bin/env bash
# Rebuild every tier-2 instrument headless, render the Eevee previews and validate.
#   tools/blender/instruments/build_all.sh            # build + previews + validate (+ instruments.json)
#   PREVIEW=0 tools/blender/instruments/build_all.sh  # skip the previews
# Override the Blender binary with BLENDER=/path/to/Blender. Logs: vendor/instrument-previews/_build/logs/
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
RUN="$ROOT/tools/blender/run.sh"
LOGS="$ROOT/vendor/instrument-previews/_build/logs"
mkdir -p "$LOGS"
cd "$ROOT"

run_step() { # name script [args...]
  local name="$1"; shift
  echo "== $name"
  if ! "$RUN" "$@" >"$LOGS/$name.log" 2>&1; then
    grep -E 'Error|Traceback|File "' "$LOGS/$name.log" | tail -20 >&2 || true
    echo "!! $name failed (see $LOGS/$name.log)" >&2
    exit 1
  fi
  grep -E '^\[instruments\]' "$LOGS/$name.log" || true
}

# one Blender invocation per instrument keeps each step short
for k in violin viola cello bass violin_bow viola_bow cello_bow bass_bow; do run_step "$k" "$HERE/bowed.py" "$k"; done
for k in trumpet horn trombone tuba; do run_step "$k" "$HERE/brass.py" "$k"; done
for k in flute piccolo oboe clarinet bassoon; do run_step "$k" "$HERE/winds.py" "$k"; done
run_step timpani "$HERE/timpani.py"

if [[ "${PREVIEW:-1}" != "0" ]]; then
  run_step previews "$HERE/preview.py"
fi

echo "== validate"
node "$HERE/validate.mjs"
