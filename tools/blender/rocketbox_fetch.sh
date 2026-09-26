#!/usr/bin/env bash
# Sparse, blob-less fetch of the Microsoft Rocketbox avatars listed in
# tools/blender/characters.json into vendor/rocketbox/Microsoft-Rocketbox.
# Idempotent: re-running only fetches missing blobs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CAST="$ROOT/tools/blender/characters.json"
DEST="$ROOT/vendor/rocketbox"
REPO_URL="https://github.com/microsoft/Microsoft-Rocketbox"
REPO="$DEST/Microsoft-Rocketbox"

mkdir -p "$DEST"
if [[ ! -d "$REPO/.git" ]]; then
  git clone --filter=blob:none --sparse --depth 1 "$REPO_URL" "$REPO"
fi

# Avatar folders from the cast config (e.g. Assets/Avatars/Professions/Business_Male_01).
# (bash 3.2 compatible: no mapfile)
DIRS=()
while IFS= read -r line; do DIRS+=("$line"); done < <(python3 -c '
import json, sys
for c in json.load(open(sys.argv[1]))["characters"]:
    print(c["sourceDir"])
' "$CAST")

git -C "$REPO" sparse-checkout set "${DIRS[@]}"
git -C "$REPO" checkout -q

for d in "${DIRS[@]}"; do
  name="$(basename "$d")"
  if [[ ! -f "$REPO/$d/Export/$name.fbx" ]]; then
    echo "missing $REPO/$d/Export/$name.fbx" >&2
    exit 1
  fi
done
echo "Rocketbox avatars ready in $REPO (${#DIRS[@]} avatars)"
