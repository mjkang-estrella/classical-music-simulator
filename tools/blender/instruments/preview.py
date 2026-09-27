"""
Eevee preview renders of the exported instrument GLBs (re-imported from disk, so the render shows
the deliverable, not the build scene).

  tools/blender/run.sh tools/blender/instruments/preview.py -- violin cello_bow ...   (default: all GLBs)

Writes vendor/instrument-previews/<name>.png: a large three-quarter view plus detail panels.
Views are specified in the instrument's glTF frame (+Y up): `dir` points from the target to the
camera, `up` is the screen-up direction, `focus` optionally restricts framing to a box.
"""
from __future__ import annotations

import math
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common as C  # noqa: E402

Z_UP = (0, 0, 1)
Y_UP = (0, 1, 0)
BOWED_MAIN = dict(dir=(-0.55, 0.85, -0.25), up=Z_UP)
BOWED_TOP = dict(dir=(0, 1, 0), up=Z_UP, ortho=True)
BOW_MAIN = dict(dir=(1.0, 0.25, 0.0), up=Y_UP)

VIEWS = {
    # name: list of (label, spec)   spec: dir, up, focus (min,max in glTF frame) or None
    "violin": [("main", BOWED_MAIN), ("top", BOWED_TOP),
               ("scroll", dict(dir=(0.9, 0.5, 0.25), up=Z_UP, focus=((-0.03, -0.03, 0.46), (0.05, 0.06, 0.60)))),
               ("back", dict(dir=(0.3, -1, -0.2), up=Z_UP)),
               ("side", dict(dir=(1, 0, 0), up=Z_UP, ortho=True)),
               ("headside", dict(dir=(1, 0, 0), up=Z_UP, ortho=True, focus=((-0.03, -0.03, 0.47), (0.05, 0.06, 0.60)))),
               ("headfront", dict(dir=(0.0, 0.5, 1.0), up=Y_UP, focus=((-0.05, -0.03, 0.50), (0.05, 0.06, 0.60))))],
    "viola": [("main", BOWED_MAIN), ("top", BOWED_TOP),
              ("scroll", dict(dir=(0.9, 0.5, 0.25), up=Z_UP, focus=((-0.03, -0.03, 0.53), (0.05, 0.06, 0.68)))),
              ("back", dict(dir=(0.3, -1, -0.2), up=Z_UP))],
    "cello": [("main", BOWED_MAIN), ("top", BOWED_TOP),
              ("scroll", dict(dir=(0.9, 0.5, 0.25), up=Z_UP, focus=((-0.06, -0.06, 1.0), (0.1, 0.12, 1.26)))),
              ("back", dict(dir=(0.3, -1, -0.2), up=Z_UP))],
    "bass": [("main", BOWED_MAIN), ("top", BOWED_TOP),
             ("scroll", dict(dir=(0.9, 0.5, 0.25), up=Z_UP, focus=((-0.1, -0.1, 1.5), (0.14, 0.16, 1.9)))),
             ("back", dict(dir=(0.3, -1, -0.2), up=Z_UP))],
}
for b in ("violin_bow", "viola_bow", "cello_bow", "bass_bow"):
    VIEWS[b] = [("main", BOW_MAIN),
                ("frog", dict(dir=(1.0, 0.3, -0.2), up=Y_UP, focus=((-0.02, -0.035, -0.05), (0.02, 0.02, 0.07)))),
                ("tip", dict(dir=(1.0, 0.3, 0.3), up=Y_UP, focus=((-0.02, -0.03, 0.66), (0.02, 0.02, 0.78))))]

# family scripts may declare PREVIEW_VIEWS = {name: [(label, spec), ...]} (merged below)
for _fam in ("brass", "winds", "timpani"):
    try:
        _mod = __import__(_fam)
        VIEWS.update(getattr(_mod, "PREVIEW_VIEWS", {}))
    except Exception as _e:  # noqa: BLE001
        if not isinstance(_e, ModuleNotFoundError):
            print("[preview] could not import", _fam, _e)

DEFAULT_VIEWS = [("main", dict(dir=(0.8, 0.5, 0.9), up=Y_UP)), ("front", dict(dir=(0, 0.2, 1), up=Y_UP)),
                 ("side", dict(dir=(1, 0.2, 0), up=Y_UP))]


def setup_scene(env=1.0):
    C.reset_scene()
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    try:
        sc.eevee.taa_render_samples = 32
    except Exception:
        pass
    for attr, val in (("use_gtao", True), ("use_shadows", True), ("use_raytracing", True)):
        try:
            setattr(sc.eevee, attr, val)
        except Exception:
            pass
    sc.view_settings.view_transform = "Standard"
    sc.render.film_transparent = False
    # studio world: vertical gradient (dark floor, bright ceiling) for metal reflections
    world = bpy.data.worlds.new("studio")
    world.use_nodes = True
    nt = world.node_tree
    bg = nt.nodes.get("Background")
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    maprange = nt.nodes.new("ShaderNodeMapRange")
    maprange.inputs["From Min"].default_value = -1.0
    maprange.inputs["From Max"].default_value = 1.0
    nt.links.new(tc.outputs["Generated"], sep.inputs["Vector"])
    nt.links.new(sep.outputs["Z"], maprange.inputs["Value"])
    nt.links.new(maprange.outputs["Result"], ramp.inputs["Fac"])
    ramp.color_ramp.elements[0].position = 0.35
    ramp.color_ramp.elements[0].color = (0.015, 0.015, 0.017, 1)
    ramp.color_ramp.elements[1].position = 0.8
    ramp.color_ramp.elements[1].color = (0.30 * env, 0.30 * env, 0.32 * env, 1)
    nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 0.6
    sc.world = world
    cam_d = bpy.data.cameras.new("cam")
    cam_d.lens = 85
    cam = bpy.data.objects.new("cam", cam_d)
    sc.collection.objects.link(cam)
    sc.camera = cam
    return sc, cam


def add_lights(center, radius, cam_dir_bl):
    """Key / fill / rim area lights placed relative to the camera direction (Blender frame)."""
    cd = Vector(cam_dir_bl).normalized()
    up = Vector((0, 0, 1))
    right = cd.cross(up).normalized() if abs(cd.z) < 0.95 else Vector((1, 0, 0))
    lights = []
    specs = (
        ("key", cd * 0.8 + right * -1.3 + up * 0.9, 110, 0.55),
        ("fill", cd * 0.9 + right * 1.4 + up * -0.1, 35, 1.0),
        ("rim", -cd * 1.2 + right * 0.6 + up * 0.8, 90, 0.6),
        ("kick", -cd * 0.6 + right * -1.2 + up * -0.4, 40, 0.8),
    )
    for name, d, energy, size in specs:
        ld = bpy.data.lights.new(name, "AREA")
        ld.shape = "DISK"
        ld.size = size * radius * 2
        # energy scales with distance^2
        dist = radius * 4
        ld.energy = energy * (dist ** 2) / 4.0
        lo = bpy.data.objects.new(name, ld)
        bpy.context.scene.collection.objects.link(lo)
        pos = Vector(center) + d.normalized() * dist
        lo.location = pos
        direction = Vector(center) - pos
        lo.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        lights.append(lo)
    return lights


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    return new


def world_points(objs):
    pts = []
    for o in objs:
        if o.type != "MESH":
            continue
        mw = o.matrix_world
        me = o.data
        co = np.empty(len(me.vertices) * 3)
        me.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3)
        M = np.array(mw)
        co = co @ M[:3, :3].T + M[:3, 3]
        pts.append(co)
    return np.concatenate(pts) if pts else np.zeros((1, 3))


def frame_camera(cam, pts_bl, dir_gl, up_gl, focus=None, aspect=1.0, margin=1.08, ortho=False):
    d = Vector(C.gl2bl(dir_gl)).normalized()
    up = Vector(C.gl2bl(up_gl)).normalized()
    if focus is not None:
        lo = np.array(C.gl2bl(focus[0]))
        hi = np.array(C.gl2bl(focus[1]))
        mn, mx = np.minimum(lo, hi), np.maximum(lo, hi)
        inside = np.all((pts_bl >= mn) & (pts_bl <= mx), axis=1)
        pts = pts_bl[inside] if inside.sum() > 10 else pts_bl
    else:
        pts = pts_bl
    # camera basis
    fwd = -d
    right = fwd.cross(up).normalized()
    upv = right.cross(fwd).normalized()
    P = pts
    xs = P @ np.array(right)
    ys = P @ np.array(upv)
    zs = P @ np.array(fwd)
    cx, cy = (xs.min() + xs.max()) / 2, (ys.min() + ys.max()) / 2
    w, h = xs.max() - xs.min(), ys.max() - ys.min()
    center = Vector(right) * cx + Vector(upv) * cy + Vector(fwd) * float(zs.mean())
    fov = 2 * math.atan(36 / 2 / cam.data.lens)  # sensor width 36 (horizontal for aspect>=1)
    span = max(w, h * aspect) * margin
    dist = span / 2 / math.tan(fov / 2) + (zs.max() - zs.min()) / 2
    cam.data.type = "ORTHO" if ortho else "PERSP"
    cam.data.ortho_scale = span
    cam.location = center - fwd * dist
    rot = Matrix((right, upv, -fwd)).transposed()
    cam.rotation_euler = rot.to_euler()
    cam.data.clip_start = dist * 0.01
    cam.data.clip_end = dist * 10
    return center, max(w, h)


def render(path, w, h):
    sc = bpy.context.scene
    sc.render.resolution_x = w
    sc.render.resolution_y = h
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = "PNG"
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(path, check_existing=False)
    buf = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(buf)
    bpy.data.images.remove(img)
    return buf.reshape(h, w, 4)[::-1].copy()


def save_png(rgba, path):
    h, w = rgba.shape[:2]
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=False)
    img.pixels.foreach_set(rgba[::-1].reshape(-1).astype(np.float32))
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)


def preview(name, glb, out):
    views = VIEWS.get(name, DEFAULT_VIEWS)
    sc, cam = setup_scene(views[0][1].get("env", 1.0))
    objs = import_glb(glb)
    pts = world_points(objs)
    tmp = os.path.join(C.BUILD_DIR, "render")
    os.makedirs(tmp, exist_ok=True)
    panels = []
    lights = []
    for i, (label, spec) in enumerate(views):
        for lo in lights:
            bpy.data.objects.remove(lo)
        main = i == 0
        W, H = (700, 700) if main else (350, 350)
        center, size = frame_camera(cam, pts, spec["dir"], spec["up"], spec.get("focus"), W / H, ortho=spec.get("ortho", False))
        lights = add_lights(center, size * 0.6, C.gl2bl(spec["dir"]))
        panels.append(render(os.path.join(tmp, f"{name}_{label}.png"), W, H))
    main = panels[0]
    small = panels[1:]
    if small:
        col = np.concatenate(small[:2], axis=0) if len(small) >= 2 else np.concatenate([small[0], np.zeros_like(small[0])], axis=0)
        sheet = np.concatenate([main, col], axis=1)
        if len(small) > 2:
            extra = small[2]
            row = np.zeros((extra.shape[0], sheet.shape[1], 4), np.float32)
            row[..., 3] = 1
            for j, p in enumerate(small[2:5]):
                row[:, j * 350:(j + 1) * 350] = p
            sheet = np.concatenate([sheet, row], axis=0)
    else:
        sheet = main
    sheet[..., 3] = 1
    save_png(sheet, out)
    C.log("preview", os.path.relpath(out, C.ROOT))


def zoom(name, glb, out, spec, size=700):
    sc, cam = setup_scene()
    objs = import_glb(glb)
    pts = world_points(objs)
    center, sz = frame_camera(cam, pts, spec["dir"], spec["up"], spec.get("focus"), 1.0, ortho=spec.get("ortho", False))
    add_lights(center, sz * 0.6, C.gl2bl(spec["dir"]))
    img = render(out, size, size)
    C.log("zoom", out)


def main():
    args = C.script_args()
    if args and args[0] == "--zoom":
        # --zoom name dx,dy,dz upx,upy,upz [minx,miny,minz,maxx,maxy,maxz] [ortho]
        name = args[1]
        d = tuple(float(v) for v in args[2].split(","))
        u = tuple(float(v) for v in args[3].split(","))
        focus = None
        if len(args) > 4 and args[4] != "-":
            f = [float(v) for v in args[4].split(",")]
            focus = (tuple(f[:3]), tuple(f[3:]))
        spec = dict(dir=d, up=u, focus=focus, ortho=len(args) > 5 and args[5] == "ortho")
        zoom(name, os.path.join(C.OUT_DIR, f"{name}.glb"), os.path.join(C.BUILD_DIR, "render", f"zoom_{name}.png"), spec)
        return
    names = [a for a in args if not a.startswith("-")]
    if not names:
        names = sorted(os.path.splitext(f)[0] for f in os.listdir(C.OUT_DIR) if f.endswith(".glb"))
    os.makedirs(C.PREVIEW_DIR, exist_ok=True)
    for n in names:
        glb = os.path.join(C.OUT_DIR, f"{n}.glb")
        if not os.path.exists(glb):
            C.log("missing", glb)
            continue
        preview(n, glb, os.path.join(C.PREVIEW_DIR, f"{n}.png"))


if __name__ == "__main__":
    main()
