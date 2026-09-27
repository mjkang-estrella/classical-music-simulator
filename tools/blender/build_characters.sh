#!/usr/bin/env bash
# End-to-end Rocketbox character pipeline.
#
#   tools/blender/build_characters.sh            # fetch -> convert -> LODs -> validate + sidecar -> twist test -> previews
#   SKIP_FETCH=1 PREVIEW=0 tools/blender/build_characters.sh
#   ONLY="rocketbox_business_male_01 rocketbox_pilot_female_02" SKIP_FETCH=1 tools/blender/build_characters.sh
#   COMPRESS=1 tools/blender/build_characters.sh # also EXT_meshopt_compression (needs MeshoptDecoder in the app)
#   TEST=0 skips the forearm twist-bone test (tools/blender/test_twist.py)
#
# Cast: tools/blender/characters.json. Outputs: public/assets/characters/{<id>.glb,characters.json,LICENSE-rocketbox.txt}
# Previews: vendor/previews/<id>.png, cast_lineup.png, face_<id>.png and face_compare_<id>.png (cast.previewFaces),
#           twist_<id>.png (cast.twistTest)
# A full 12-character run takes ~5 min (previews are most of it); CI-style runs can use PREVIEW=0.
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

IDARGS=()
for id in ${ONLY:-}; do IDARGS+=(--id "$id"); done

echo "== convert (Blender)"
if ! tools/blender/run.sh tools/blender/rocketbox_to_glb.py --cast "$CAST" ${IDARGS[@]+"${IDARGS[@]}"} > "$LOGDIR/convert.log" 2>&1; then
  grep -E '^\[rocketbox\]|Error|Traceback|File "' "$LOGDIR/convert.log" >&2 || true
  echo "conversion failed, see $LOGDIR/convert.log" >&2
  exit 1
fi
grep -E '^\[rocketbox\]' "$LOGDIR/convert.log"
GLBS=()
BUILT=()
while IFS= read -r id; do
  f="$OUT/$id.glb"
  [[ -f "$f" ]] || { echo "missing $f" >&2; exit 1; }
  GLBS+=("$f")
  if [[ -z "${ONLY:-}" || " ${ONLY} " == *" $id "* ]]; then BUILT+=("$f"); fi
done < <(python3 -c '
import json, sys
for c in json.load(open(sys.argv[1]))["characters"]:
    if c.get("enabled", True): print(c["id"])
' "$CAST")

echo "== LODs / optional compression (gltf-transform + meshoptimizer)"
bash tools/gltf/optimize-characters.sh "${BUILT[@]}"

echo "== license"
{
  echo "Microsoft Rocketbox avatars (https://github.com/microsoft/Microsoft-Rocketbox)"
  echo "Files: $OUT/rocketbox_*.glb (converted, recolored and decimated from the original FBX/TGA assets)"
  echo
  cat "$REPO/LICENSE.md"
} > "$OUT/LICENSE-rocketbox.txt"

echo "== validate + sidecar"
node tools/gltf/inspect-characters.mjs --write-sidecar "${GLBS[@]}"

TWIST_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("twistTest") or "")' "$CAST")"
if [[ "${TEST:-1}" != "0" && -n "$TWIST_ID" ]]; then
  echo "== forearm twist test ($TWIST_ID)"
  if ! tools/blender/run.sh tools/blender/test_twist.py --glb "$OUT/$TWIST_ID.glb" > "$LOGDIR/twist.log" 2>&1; then
    grep -E 'TWIST_RESULT|Error|Traceback' "$LOGDIR/twist.log" >&2 || true
    echo "twist test failed, see $LOGDIR/twist.log" >&2
    exit 1
  fi
  grep -E '^TWIST_SUMMARY' "$LOGDIR/twist.log" | cut -d' ' -f2-
fi

if [[ "${PREVIEW:-1}" != "0" ]]; then
  echo "== previews"
  FACES="$(python3 -c 'import json,sys; print(",".join(json.load(open(sys.argv[1])).get("previewFaces", [])))' "$CAST")"
  PREVIEW_ARGS=()
  for id in ${ONLY:-}; do PREVIEW_ARGS+=(--id "$id"); done
  if [[ -n "$FACES" && -z "${ONLY:-}" ]]; then PREVIEW_ARGS+=(--faces "$FACES" --face-compare "$FACES"); fi
  if ! tools/blender/run.sh tools/blender/preview_characters.py --cast "$CAST" ${PREVIEW_ARGS[@]+"${PREVIEW_ARGS[@]}"} > "$LOGDIR/preview.log" 2>&1; then
    echo "preview rendering failed, see $LOGDIR/preview.log" >&2
    exit 1
  fi
  grep -E '^wrote' "$LOGDIR/preview.log"
fi
echo "done"
