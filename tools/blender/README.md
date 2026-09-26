# Character pipeline (Microsoft Rocketbox → GLB)

```sh
tools/blender/build_characters.sh               # fetch → convert → LODs → validate + sidecar → previews
SKIP_FETCH=1 PREVIEW=0 tools/blender/build_characters.sh
```

Requires Blender 5.x (`BLENDER=/path/to/Blender` to override), Node, and pnpm deps.

| step | file |
|---|---|
| sparse, blob-less clone of the avatars listed in the cast into `vendor/rocketbox/` (gitignored) | `rocketbox_fetch.sh` |
| cast config: avatars, gender, recolor rules, LOD targets, texture sizes | `characters.json` |
| FBX → GLB (import, cleanup, units/orientation, materials, export) | `rocketbox_to_glb.py` |
| HSV recolor + downscale of textures (numpy; standalone before/after sheets) | `recolor_attire.py` |
| LOD1/LOD2 meshoptimizer simplification + skin check (optional `COMPRESS=1`) | `../gltf/optimize-characters.sh` |
| validation + `public/assets/characters/characters.json` sidecar | `../gltf/inspect-characters.mjs --write-sidecar` |
| preview renders of the exported GLBs → `vendor/previews/` | `preview_characters.py` |
| headless Blender wrapper | `run.sh <script.py> [args]` |

## Output contract
- `public/assets/characters/rocketbox_<name>.glb`: meters, +Y up, faces +Z, feet on y=0, origin at the ankle midpoint.
- Root node `Bip01` has an identity transform. It holds the 80-joint Biped skeleton (`Bip01 Pelvis` …, fingers, jaw, eyelids and face bones) and three skinned mesh nodes, `LOD0`, `LOD1` and `LOD2`, all on one skin. `Bip01 Footsteps` is removed.
- Rest pose = the native A-pose bind pose, with no animations. Joint frames follow the 3ds Max Biped convention: limb joints point to their child along local +X, and palm normal = local +Y.
- Textures: WebP, 1024² (opacity maps 512²). Hair, lashes and glasses use `alphaMode: MASK` (cutoff 0.4) and are single-sided, because Rocketbox ships back-to-back hair cards.
- The repo FBX only contains the `hipoly_81_bones` mesh (the other LOD names are empty 3ds Max layers). LOD1 and LOD2 (about 50 % and 22 %) are therefore generated with meshoptimizer, which keeps original vertices, so normals, UVs and weights stay exact.

## Tweaking recolors
Edit `characters.json` → `characters[].recolor.body_color[]`, then run:
```sh
tools/blender/run.sh tools/blender/recolor_attire.py --cast tools/blender/characters.json --id <id>
```
This writes original | recolored | mask sheets to `vendor/previews/textures/`. A skin-hue guard (`defaults.skinGuard`) is always applied unless a rule sets `ignoreSkinGuard`, in which case it must be region-limited.
