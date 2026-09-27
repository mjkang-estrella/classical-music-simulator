# Orchestra: a 3D symphony simulator

This app shows a full symphony orchestra performing the classical piece you pick from the library on the right. Every musician animates from their own part in the score:

- string players bow each note, with direction changes, string crossings, vibrato and fingering positions on the neck;
- wind and brass players raise their instruments before an entrance and breathe in the rests;
- trombone slides move with the pitch;
- timpani and percussion strike exactly on the note;
- the conductor beats the score's own tempo map and cues sections as they come in.

Audio is synthesised in the browser from the same MIDI score using sampled instruments, so sound and motion share one clock.

![stage](docs/stage.png)

## Run it

```sh
pnpm install
pnpm dev            # http://localhost:5173
```

Pick a piece in the **Library** tab and it starts playing.

**Controls**

| Input | Action |
|---|---|
| Drag / scroll / right-drag | Orbit / zoom / pan |
| Camera chips | Audience, balcony, overhead, conductor view, or a section close-up |
| Click a musician | Fly the camera to them and follow them |
| `Space` | Play / pause |
| `←` / `→` | Seek 5 seconds |
| `Esc` | Deselect |

**Inspecting a musician** (the **Musician** tab) shows the notes sounding now, a dynamics meter and a scrolling piano roll of their part. From there you can **solo**, **mute** or **highlight** their section. The **Mixer** tab does the same for every section at once.

**Import MIDI** (the drop zone at the bottom of the library) plays any orchestral `.mid` file you own. Tracks are mapped to sections by track name (English, Italian or German) and General MIDI program. The file never leaves your browser.

## Default library

All scores come from [The Mutopia Project](https://www.mutopiaproject.org) and are free to redistribute. Download them with `pnpm music:fetch`; they are already in `public/music`.

| Piece | License |
|---|---|
| Beethoven, Symphony No. 5 / I | Public domain |
| Beethoven, Symphony No. 7 / II | Public domain |
| Beethoven, Egmont Overture | Public domain |
| Beethoven, Coriolan Overture | Public domain |
| Dvořák, Symphony No. 9 / IV | CC BY-SA 3.0 (Keith OHara) |
| Mozart, Eine kleine Nachtmusik / I | Public domain |
| Rossini, *Eduardo e Cristina* overture | Public domain |

Track-to-section fixes for these files, such as horns mislabelled as General MIDI "english horn", live in `public/music/library.json` under `trackOverrides`.

## How it works

```
MIDI ──► Score (parts, beat grid, loudness) ──► Plans (bowing, raises, sticking, beats)
  │                                                     │
  └──► AudioEngine (smplr samples, section mute/solo) ◄─┴── Transport clock (AudioContext time)
                                                        │
                        Actors (rig + instrument + performer) ◄── song time every frame
```

| Area | Files | What it does |
|---|---|---|
| Score | `src/music/*` | Parses MIDI and maps tracks to sections. Builds the conducted beat grid and per-part loudness (velocity × CC7 × CC11). Dynamics are inferred when a file has none. `NoteIndex` answers "what is sounding at t" in O(log n). |
| Audio | `src/audio/*` | `smplr` sampled instruments are scheduled on AudioContext time with a lookahead feeder. The graph is part gate → expression → section gain (mute/solo) → pan → reverb. `getOutputTimestamp()` compensates output latency so visuals match what you hear. If there is no audio device, playback falls back to a silent wall-clock mode. |
| Orchestra | `src/orchestra/*` | American seating with risers, desks and stands. Assigns players to parts, including divisi (outside player takes the top voice) and shared staves (basses read the cello part). |
| Animation | `src/animation/*` | Every performance is a pure function of song time, so seeking and scrubbing just work. Plans are precomputed at load. `Actor` poses a character with bind-pose-agnostic two-bone IK (`src/rig/`) onto anchors on the instrument. |
| Assets | `src/assets/*` | Realistic characters and instruments load from GLBs when present. Otherwise the app falls back to procedural placeholders that use the same skeleton and anchor contract. |

## Realistic assets (Blender pipeline)

- **Musicians** are Microsoft Rocketbox avatars (MIT), converted headless with Blender. The conversion fixes units, orientation and textures, recolours outfits to concert black and generates LODs:
  ```sh
  brew install --cask blender
  tools/blender/build_characters.sh
  ```
  See `tools/blender/README.md`.
- **Instruments** are modelled procedurally with Blender Python in `tools/blender/instruments/`, plus a validator. Each exported GLB keeps exactly the anchor positions the animation code uses; the contract is `tools/blender/instruments/anchor_contract.json`, regenerated with `DUMP_ANCHORS=1 pnpm test`. The app swaps a realistic mesh in for any instrument listed in `public/assets/instruments/instruments.json`.

## Realism features

- **Characters.** 12 Microsoft Rocketbox avatars (7 men, 5 women) are processed by the Blender pipeline in `tools/blender/`:
  - 2k textures, with roughness maps derived from the specular maps;
  - a subdivided LOD for close-ups plus 3 lower LODs;
  - forearm twist bones re-weighted into the skin;
  - outfits recoloured to concert black.
- **Shading** (`src/assets/characterMaterials.ts`). The GLB materials are upgraded at load:
  - **Skin:** a subsurface-scattering approximation (per-channel wrap lighting inside a skin mask), tileable pore detail normals, matte roughness.
  - **Eyes:** wet, near-mirror eyes found from the live eye-bone positions.
  - **Hair:** anisotropic highlights and two-pass rendering (a solid core plus sorted soft edges).
  - **Wool:** a sheen lobe.
  - **Glasses:** glossy frames.
  - **Per-musician variation:** each musician gets their own skin tone, hair colour and ±3.5 % height. Avatars are assigned so neighbours never look alike.
- **Face** (`Actor.face`), using the Rocketbox face rig:
  - **Eyes:** blinks every 2–6 s and at phrase ends. The eyes make micro-saccades, read the part on the stand and glance up at the conductor, and the upper lids follow the gaze.
  - **Brows** lift with crescendos.
  - **Mouth:** wind and brass embouchures (sealed lips, firm corners). Brass players' faces flush in loud passages, and the conductor breathes in on the preparatory beat.
- **Hands** (`src/rig/handPose.ts`):
  - per-joint finger poses taken from real grips (bow holds, fingerboard, keys, valves, mallets, baton);
  - real fingerings (valve combinations, string fingers and positions, woodwind key patterns);
  - forearm pronation shared with the twist bones, wrist limits, shoulder elevation.
- **Body.** Players lean into crescendos, nod on downbeats and breathe. Standing players keep their feet planted and shift their weight.
- **Rendering:**
  - Poly Haven *Music Hall* HDRI; front, back and rim stage lights;
  - ambient occlusion and depth of field when following a musician;
  - Khronos Neutral tone mapping;
  - adaptive pixel ratio to hold 60 fps.

Debug hooks in the browser console include:

| Hook | What it does |
|---|---|
| `__orchestra.lookAtBone(id, bone, x, y, z)` | Frames a bone of a musician |
| `__orchestra.blink(id, 0…1)` | Forces a musician's eyelids open / closed |
| `__orchestra.skin(0…1)` | Sets the skin scattering strength |
| `__orchestra.pores(0…1)` | Sets the pore detail strength |
| `__orchestra.stands(false)` | Hides chairs and music stands |

Two scripts help check motion and speed:
- `node tools/motion-sheet.mjs` renders frame-by-frame contact sheets.
- `node tools/perf.mjs` measures frame rate per camera view. Add `?ao=0&dof=0&msaa=0&post=0` to switch features off.

## Tests

```sh
pnpm test      # unit tests (vitest): MIDI mapping on the real library, note index, beat grid, seating, bowing/sticking plans, IK
pnpm e2e       # Playwright: load a piece, play, seek, inspect, solo/highlight, click-to-select in 3D
```

## Credits

See the in-app **Credits & licenses** panel and `CREDITS.md`.
