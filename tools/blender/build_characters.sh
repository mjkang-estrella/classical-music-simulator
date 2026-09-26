#!/usr/bin/env bash
# End-to-end Rocketbox character pipeline.
#
#   tools/blender/build_characters.sh            # fetch -> convert -> LODs -> validate + sidecar -> previews
#   SKIP_FETCH=1 PREVIEW=0 tools/blender/build_characters.sh
#   COMPRESS=1 tools/blender/build_characters.sh # also EXT_meshopt_compression (needs MeshoptDecoder in the app)
#
# Cast: tools/blender/characters.json. Outputs: public/assets/characters/{<id>.glb,characters.json,LICENSE-rocketbox.txt}
# Previews: vendor/previews/<id>.png and vendor/previews/cast_lineup.png
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
CAST=tools/blender/characters.json
OUT=public/assets/characters
REPO=vendor/rocketbox/Microsoft-Rocketbox

if [[ "${SKIP_FETCH:-0}" != "1" ]]; then
  echo "== fetch"
  bash tools/blender/rocketbox_fetch.sh
fi

LOGDIR=vendor/rocketbox/cache
mkdir -p "$LOGDIR"

echo "== convert (Blender)"
if ! tools/blender/run.sh tools/blender/rocketbox_to_glb.py --cast "$CAST" > "$LOGDIR/convert.log" 2>&1; then
  grep -E '^\[rocketbox\]|Error|Traceback|File "' "$LOGDIR/convert.log" >&2 || true
  echo "conversion failed, see $LOGDIR/convert.log" >&2
  exit 1
fi
grep -E '^\[rocketbox\]' "$LOGDIR/convert.log"
GLBS=()
while IFS= read -r id; do
  f="$OUT/$id.glb"
  [[ -f "$f" ]] || { echo "missing $f" >&2; exit 1; }
  GLBS+=("$f")
done < <(python3 -c '
import json, sys
for c in json.load(open(sys.argv[1]))["characters"]:
    if c.get("enabled", True): print(c["id"])
' "$CAST")

echo "== LODs / optional compression (gltf-transform + meshoptimizer)"
bash tools/gltf/optimize-characters.sh "${GLBS[@]}"

echo "== license"
{
  echo "Microsoft Rocketbox avatars (https://github.com/microsoft/Microsoft-Rocketbox)"
  echo "Files: $OUT/rocketbox_*.glb (converted, recolored and decimated from the original FBX/TGA assets)"
  echo
  cat "$REPO/LICENSE.md"
} > "$OUT/LICENSE-rocketbox.txt"

echo "== validate + sidecar"
node tools/gltf/inspect-characters.mjs --write-sidecar "${GLBS[@]}"

if [[ "${PREVIEW:-1}" != "0" ]]; then
  echo "== previews"
  if ! tools/blender/run.sh tools/blender/preview_characters.py --cast "$CAST" > "$LOGDIR/preview.log" 2>&1; then
    echo "preview rendering failed, see $LOGDIR/preview.log" >&2
    exit 1
  fi
  grep -E '^wrote' "$LOGDIR/preview.log"
fi
echo "done"
