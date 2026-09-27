# Character pipeline (Microsoft Rocketbox → GLB)

```sh
tools/blender/build_characters.sh               # fetch → convert → LODs → validate + sidecar → twist test → previews
SKIP_FETCH=1 PREVIEW=0 tools/blender/build_characters.sh
ONLY="rocketbox_business_male_05" SKIP_FETCH=1 tools/blender/build_characters.sh   # rebuild one character
```

Requires Blender 5.x (`BLENDER=/path/to/Blender` to override), Node, and pnpm deps. A full 12-character run takes about 5 minutes; most of that is the preview renders.

| step | file |
|---|---|
| sparse, blob-less clone of the avatars listed in the cast into `vendor/rocketbox/` (gitignored) | `rocketbox_fetch.sh` |
| cast config: avatars, gender, recolor rules, removed props, LOD specs, texture sizes, roughness, twist bones | `characters.json` |
| FBX → GLB (import, cleanup, units/orientation, eye/mouth split, twist bones, LODs, materials, export) | `rocketbox_to_glb.py` |
| HSV recolor, specular → roughness, resampling of textures (numpy; standalone before/after sheets) | `recolor_attire.py` |
| LOD2/LOD3 meshoptimizer simplification, LOD0 budget trim, skin check (optional `COMPRESS=1`) | `../gltf/optimize-characters.sh` |
| validation + `public/assets/characters/characters.json` sidecar | `../gltf/inspect-characters.mjs --write-sidecar` |
| forearm twist test: numeric check plus a before/after pronation render → `vendor/previews/twist_<id>.png` | `test_twist.py` |
| preview renders of the exported GLBs → `vendor/previews/` (per-character sheets, lineup, `--faces`, `--face-compare`) | `preview_characters.py` |
| headless Blender wrapper | `run.sh <script.py> [args]` |

## Output contract
- `public/assets/characters/rocketbox_<name>.glb`: meters, +Y up, faces +Z, feet on y=0, origin at the ankle midpoint. ≤ 6 MB each.
- Root node `Bip01` has an identity transform. It holds an 82-joint Biped skeleton: the 80 Rocketbox joints (`Bip01 Pelvis` …, fingers, jaw, eyelids, eyes and face bones) plus two forearm twist joints. `Bip01 Footsteps` is removed.
- The root holds four skinned mesh nodes on one skin, all sharing the same materials and textures:

  | node | mesh | triangles |
  |---|---|---|
  | `LOD0` | Rocketbox hipoly mesh, re-quadded, one Catmull-Clark level (close-ups) | 29.7–32 k (≤ 32 000) |
  | `LOD1` | the original hipoly mesh (the previous LOD0) | 6.7–9.0 k |
  | `LOD2` | meshoptimizer, 50 % of LOD1 (the previous LOD1) | 3.5–4.9 k |
  | `LOD3` | meshoptimizer, 22 % of LOD1 (the previous LOD2) | 1.6–2.5 k |
- Rest pose = the native A-pose bind pose, with no animations. Joint frames follow the 3ds Max Biped convention: limb joints point to their child along local +X, and palm normal = local +Y.
- ≤ 4 influences per vertex, weights normalized.

### Forearm twist bones
- `Bip01 L ForeTwist` / `Bip01 R ForeTwist` are children of `Bip01 {L,R} Forearm`, placed 55 % of the way from elbow to wrist. They have exactly the forearm's frame and roll, so local +X points to the wrist. They are leaves.
- `Bip01 {L,R} Hand` stays a child of the forearm, not of the twist bone.
- Weights: every LOD vertex with forearm weight moves `smoothstep(0.15, 1.0, t) · 0.85` of it to the twist bone, where t is its projection on elbow→wrist (0 at the elbow, 1 at the wrist). Hand weights are untouched.
- Driving them: rotate the twist bone about its local +X by the hand's roll (pronation/supination) relative to the forearm; the weights are tuned for 1.0 × the hand roll. Without driving it (identity), the skin behaves exactly like the old rig.
- `test_twist.py` checks that the elbow does not move (0 mm) and that the pure-forearm skin angle rises monotonically. For a 90° hand pronation it compares the maximum twist rate (°/cm) and the wrist radius with and without the twist bone.

### Materials and textures
- WebP (quality 88). Head and body colour, normal and roughness maps are 2048². Hair opacity maps are 1024², glasses 512².
- **Roughness** comes from the Rocketbox `*_specular.tga` maps: `roughness = clamp(1 − L·k, 0.25, 0.95)`, where L is the specular luminance after a σ = 1 texel blur (this removes amplified 8-bit steps). The map is stored grey (R = G = B), so glTF `metallicRoughness.G` carries it; `metallicFactor` is 0 and `roughnessFactor` is 1 (the map drives it).
  - Head textures use a single k, solved so the face skin averages 0.5.
  - Body textures blend `k_skin` (hands, legs → 0.5) and `k_cloth` (suit, shirt, tie, shoes → 0.75) with a soft skin mask.
  - k is capped at 16. The male Rocketbox hand specular is near black, so their hands end up ~0.65–0.75. See `defaults.roughnessMap`; per-texture k and means are in `vendor/rocketbox/cache/<id>/report.json`.
- **Eyes and mouth**: the eyeballs are separate open shells (73 vertices each), rigidly skinned to `Bip01 LEye` / `Bip01 REye`. They get their own material `<id>_eyes`. The mouth interior (teeth, gums, tongue; the mouth block of the head atlas) gets `<id>_mouth`. Both share the head's colour and normal textures and have constant roughness (eyes 0.05, mouth 0.2). The lip line (the head/mouth border) is creased before subdivision so the lips stay closed.
- Hair, lashes and glasses use `alphaMode: MASK` (cutoff 0.4) and are single-sided, because Rocketbox ships back-to-back hair cards.

### LOD0 subdivision
- Triangle pairs are joined back into quads (never across UV seams, sharp edges or material borders). Then one Catmull-Clark level is applied to all materials:
  - UV smoothing "Keep Borders" (`PRESERVE_BOUNDARIES`). "Keep Corners" was tried and showed a seam at the back of the shirt collar and nape.
  - Boundary smoothing "Keep Corners".
  - No limit surface.
  - Vertex-group weights are interpolated.
- The FBX custom normals are dropped. Normals come from the smooth subdivided surface, split only at the `sharp_edge` edges Rocketbox authored.
- If the result exceeds 32 000 triangles, `optimize-characters.sh` trims it with meshoptimizer: flattest regions first, relative error ~1e-3.

## Cast
`characters.json` → `characters[]`. The 12 enabled characters are Business_Male_01–07, Business_Female_01–04 and Pilot_Female_02.
- `removeMaterials: ["hat"]` deletes prop geometry by material name. Pilot_Female_02's cap is removed this way; her hair bun is modelled underneath.
- Faces and hair are never recolored: rules are keyed to `body_color` only.
- Other usable Professions avatars:
  - `Security_Female_01`: black jacket; needs `removeMaterials: ["hat", "pistol"]`, and has a hat-band line baked into the forehead textures.
  - `Pilot_Female_01`: white blouse and cap, like Pilot_Female_02.

## Tweaking recolors
Edit `characters.json` → `characters[].recolor.body_color[]`, then run:
```sh
tools/blender/run.sh tools/blender/recolor_attire.py --cast tools/blender/characters.json --id <id>
```
This writes original | recolored | mask sheets to `vendor/previews/textures/`.
- A skin-hue guard (`defaults.skinGuard`) is always applied unless a rule sets `ignoreSkinGuard`, in which case it must be region-limited.
- Each rule's HSV selection is closed morphologically (`defaults.recolorHoleFill`, 2 px at 2048²) before the region rects and the skin guard. This recolors stray lint or fibre specks that fall outside the HSV box; at 1024² they were averaged away, but at 2048² they show.
- `roughnessMap.body.regions` (per character) gives one garment its own roughness k, e.g. Business_Male_07's recolored denim, whose specular level is far above the shirt's.

## App notes
- LOD indices shifted: the old LOD0 is now `LOD1`. To keep the old per-distance cost, use `LOD0` (32 k tris) only for close-ups/hero shots and map the old distance bands to LOD1–LOD3.
- The twist bones are only visible in the skin if they are driven; left at identity, the skin behaves exactly like the old rig.
