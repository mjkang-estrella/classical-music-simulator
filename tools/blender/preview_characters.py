"""
Render preview PNGs of the exported character GLBs (re-imported from disk, so this checks the
actual deliverable, not the Blender scene that produced it).

  tools/blender/run.sh tools/blender/preview_characters.py -- [--cast tools/blender/characters.json] [--id <id> ...]

Per character: vendor/previews/<id>.png with panels
  LOD0 front | LOD0 back-3/4 | LOD1 front | LOD2 front | face close-up
plus vendor/previews/cast_lineup.png with every character's LOD0 side by side (front, same scale).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import recolor_attire as ra  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))


def setup_scene(engine_pref="BLENDER_EEVEE"):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    engines = {e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items}
    sc.render.engine = engine_pref if engine_pref in engines else "BLENDER_WORKBENCH"
    if sc.render.engine == "BLENDER_WORKBENCH":
        sc.display.shading.light = "STUDIO"
        sc.display.shading.color_type = "TEXTURE"
    else:
        try:
            sc.eevee.taa_render_samples = 16
        except Exception:
            pass
    sc.view_settings.view_transform = "Standard"
    sc.render.film_transparent = False
    world = bpy.data.worlds.new("W")
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs["Color"].default_value = (0.32, 0.34, 0.38, 1)
    bg.inputs["Strength"].default_value = 0.6
    sc.world = world
    # key / fill / rim
    for name, rot, energy in (("key", (math.radians(50), 0, math.radians(-30)), 3.5),
                              ("fill", (math.radians(60), 0, math.radians(40)), 1.2),
                              ("rim", (math.radians(60), 0, math.radians(180)), 2.0)):
        ld = bpy.data.lights.new(name, "SUN")
        ld.energy = energy
        lo = bpy.data.objects.new(name, ld)
        lo.rotation_euler = rot
        sc.collection.objects.link(lo)
    cam_d = bpy.data.cameras.new("cam")
    cam_d.type = "ORTHO"
    cam = bpy.data.objects.new("cam", cam_d)
    sc.collection.objects.link(cam)
    sc.camera = cam
    return sc, cam


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    arm = next(o for o in new if o.type == "ARMATURE")
    root = arm
    while root.parent:
        root = root.parent
    meshes = {o.name.split(".")[0]: o for o in new if o.type == "MESH"}
    return root, arm, meshes, new


def frame(cam, center, width, height, aspect):
    """aspect = render W / H. Blender's ortho_scale spans the larger render dimension."""
    if aspect >= 1.0:
        cam.data.ortho_scale = max(width, height * aspect)
    else:
        cam.data.ortho_scale = max(height, width / aspect)
    cam.location = (center[0], center[1] - 10.0, center[2])
    cam.rotation_euler = (math.radians(90), 0, 0)


def render_to(path, w, h):
    sc = bpy.context.scene
    sc.render.resolution_x = w
    sc.render.resolution_y = h
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = "PNG"
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    return ra.load_rgba(path)


def show_only(meshes, keep):
    for n, o in meshes.items():
        vis = any(n.startswith(k) for k in keep)
        o.hide_render = not vis
        o.hide_viewport = not vis


def preview_one(glb, out_png, tmp):
    sc, cam = setup_scene()
    root, arm, meshes, _ = import_glb(glb)
    W, H = 420, 720
    aspect = H / W
    height = 1.85
    panels = []
    # LOD0 front, back-3/4, LOD1, LOD2
    for label, keep, rot in (("lod0", ["LOD0"], 0), ("lod0_back", ["LOD0"], 150), ("lod1", ["LOD1"], 0), ("lod2", ["LOD2"], 0)):
        show_only(meshes, keep)
        root.rotation_mode = "XYZ"
        root.rotation_euler = (root.rotation_euler[0], root.rotation_euler[1], math.radians(rot))
        frame(cam, (0, 0, height / 2), 1.45, height + 0.08, W / H)
        panels.append(render_to(os.path.join(tmp, f"{label}.png"), W, H))
    root.rotation_euler = (root.rotation_euler[0], root.rotation_euler[1], math.radians(20))
    show_only(meshes, ["LOD0"])
    head = arm.matrix_world @ arm.data.bones["Bip01 Head"].head_local
    frame(cam, (head.x, 0, head.z + 0.02), 0.34 / aspect, 0.42, W / H)
    panels.append(render_to(os.path.join(tmp, "face.png"), W, H))
    sheet = np.concatenate(panels, axis=1)
    sheet[..., 3] = 1.0
    ra.save_png(sheet, out_png)
    print("wrote", out_png, flush=True)


def lineup(glbs, out_png, tmp):
    sc, cam = setup_scene()
    x = 0.0
    spacing = 0.9
    for g in glbs:
        root, arm, meshes, _ = import_glb(g)
        show_only(meshes, ["LOD0"])
        # fold arms out of the way is not possible without posing; A-pose width ~1.35m -> overlap is fine
        root.location.x = x
        x += spacing
    width = x - spacing + 1.5
    W, H = 300 * len(glbs), 760
    frame(cam, ((x - spacing) / 2, 0, 0.95), width, 2.0, W / H)
    img = render_to(os.path.join(tmp, "lineup.png"), W, H)
    img[..., 3] = 1.0
    ra.save_png(img, out_png)
    print("wrote", out_png, flush=True)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--cast", default=os.path.join(HERE, "characters.json"))
    ap.add_argument("--id", action="append", default=None)
    ap.add_argument("--no-lineup", action="store_true")
    ap.add_argument("--glb", default=None, help="preview a single GLB file instead of the cast")
    ap.add_argument("--out", default=None, help="output PNG for --glb")
    args = ap.parse_args(argv)
    if args.glb:
        tmp = os.path.join(os.path.dirname(os.path.abspath(args.out)), "_tmp")
        os.makedirs(tmp, exist_ok=True)
        preview_one(args.glb, args.out, tmp)
        return
    cast = json.load(open(args.cast))
    chars = [c for c in cast["characters"] if c.get("enabled", True) and (not args.id or c["id"] in args.id)]
    out_dir = os.path.join(ROOT, cast["previewDir"])
    tmp = os.path.join(out_dir, "_tmp")
    os.makedirs(tmp, exist_ok=True)
    glbs = []
    for c in chars:
        glb = os.path.join(ROOT, cast["outputDir"], f"{c['id']}.glb")
        if not os.path.exists(glb):
            print("missing", glb)
            continue
        glbs.append(glb)
        preview_one(glb, os.path.join(out_dir, f"{c['id']}.png"), tmp)
    if glbs and not args.no_lineup and not args.id:
        lineup(glbs, os.path.join(out_dir, "cast_lineup.png"), tmp)


if __name__ == "__main__":
    main()
