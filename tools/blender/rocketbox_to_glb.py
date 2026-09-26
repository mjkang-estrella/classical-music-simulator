"""
Convert Microsoft Rocketbox avatars (FBX, 3ds Max Biped "Bip01" rig) to web-ready GLBs.

  tools/blender/run.sh tools/blender/rocketbox_to_glb.py -- --cast tools/blender/characters.json [--id <id> ...]

Output contract (per character, public/assets/characters/<id>.glb):
  * meters, +Y up, character faces +Z, feet on y=0, origin between the ankles
  * full Bip01 skeleton (80 joints: fingers, jaw, eyelids, face bones); Footsteps helper removed
  * native bind pose (A-pose) as rest pose, no animations
  * three skinned meshes LOD0 / LOD1 / LOD2 bound to the same skin
    (the repo FBX ships only the hipoly_81_bones mesh; LOD1/LOD2 are exported as copies and
    simplified by tools/gltf/optimize-characters.sh with meshoptimizer -- or, with
    lods[].method = "blender", collapse-decimated here)
  * textures resolved from the local Textures/ folder, recolored (recolor_attire.py),
    downscaled to 1024^2 (opacity 512^2), exported as WebP; hair/lashes/glasses alpha MASK
A small build report is written next to the texture cache (vendor/rocketbox/cache/<id>/report.json).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time

import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import recolor_attire as ra  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def log(*a):
    print("[rocketbox]", *a, flush=True)


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def select_only(objs, active=None):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or (objs[0] if objs else None)


def tri_count(me) -> int:
    return sum(len(p.vertices) - 2 for p in me.polygons)


def import_fbx(path: str) -> str:
    """Blender 5.x ufbx importer first, legacy Python importer as fallback."""
    def ok():
        return (any(o.type == "ARMATURE" for o in bpy.data.objects)
                and any(o.type == "MESH" for o in bpy.data.objects))
    if hasattr(bpy.ops.wm, "fbx_import"):
        try:
            bpy.ops.wm.fbx_import(filepath=path, use_anim=False)
            if ok():
                return "wm.fbx_import"
            log("wm.fbx_import produced no armature/mesh, falling back")
        except Exception as e:  # pragma: no cover
            log("wm.fbx_import failed:", e)
        reset_scene()
    bpy.ops.import_scene.fbx(filepath=path, use_anim=False, ignore_leaf_bones=False,
                             automatic_bone_orientation=False)
    if not ok():
        raise RuntimeError(f"FBX import failed for {path}")
    return "import_scene.fbx"


def find_texture(tex_dir: str, name: str) -> str | None:
    base = os.path.basename(name.replace("\\", "/"))
    files = {f.lower(): f for f in os.listdir(tex_dir)}
    if base.lower() in files:
        return os.path.join(tex_dir, files[base.lower()])
    return None


# ---------------------------------------------------------------------------
# scene cleanup / transforms
# ---------------------------------------------------------------------------

def cleanup_and_pick(report):
    arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    if len(arms) != 1:
        raise RuntimeError(f"expected 1 armature, got {len(arms)}")
    arm = arms[0]
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    hip = [o for o in meshes if "hipoly" in o.name.lower()]
    lod0 = hip[0] if hip else max(meshes, key=lambda o: tri_count(o.data))
    report["sourceMesh"] = lod0.name
    report["sourceMeshes"] = [o.name for o in meshes]
    # Delete everything that is not the armature or the hipoly mesh (Footsteps empty, other LODs)
    for o in list(bpy.data.objects):
        if o is arm or o is lod0:
            continue
        report.setdefault("deletedObjects", []).append(f"{o.name} ({o.type})")
        bpy.data.objects.remove(o, do_unlink=True)
    # Footsteps as a bone (legacy importer) -> delete if it carries no weights
    fs = [b.name for b in arm.data.bones if "footsteps" in b.name.lower()]
    if fs:
        weighted = {g.name for g in lod0.vertex_groups}
        select_only([arm])
        bpy.ops.object.mode_set(mode="EDIT")
        for n in fs:
            if n not in weighted:
                arm.data.edit_bones.remove(arm.data.edit_bones[n])
                report.setdefault("deletedBones", []).append(n)
        bpy.ops.object.mode_set(mode="OBJECT")
    # No animation: drop actions, reset pose to rest (= bind pose)
    for o in bpy.data.objects:
        o.animation_data_clear()
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)
    for pb in arm.pose.bones:
        pb.matrix_basis = Matrix.Identity(4)
    # Only the armature modifier on the mesh
    for m in list(lod0.modifiers):
        if m.type != "ARMATURE":
            lod0.modifiers.remove(m)
    if not any(m.type == "ARMATURE" for m in lod0.modifiers):
        mod = lod0.modifiers.new("Armature", "ARMATURE")
        mod.object = arm
    # drop shape keys / vertex colors (not used)
    if lod0.data.shape_keys:
        lod0.shape_key_clear()
    for attr in list(lod0.data.color_attributes):
        lod0.data.color_attributes.remove(attr)
    return arm, lod0


def bind_rest_deviation(mesh_obj) -> float:
    """Max distance between the armature-deformed mesh (pose = rest) and the raw mesh."""
    dg = bpy.context.evaluated_depsgraph_get()
    ev = mesh_obj.evaluated_get(dg)
    me = ev.to_mesh()
    try:
        raw = mesh_obj.data.vertices
        if len(me.vertices) != len(raw):
            return float("nan")
        return max((a.co - b.co).length for a, b in zip(me.vertices, raw))
    finally:
        ev.to_mesh_clear()


def apply_all_transforms(arm, meshes):
    for m in meshes:
        mw = m.matrix_world.copy()
        m.parent = None
        m.matrix_world = mw
    select_only([arm] + meshes, arm)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for m in meshes:
        m.parent = arm
        m.matrix_parent_inverse = Matrix.Identity(4)
        m.matrix_basis = Matrix.Identity(4)


def normalize_placement(arm, lod0, report):
    """Face -Y in Blender (= +Z glTF), feet on z=0, ankle midpoint at the origin."""
    b = arm.data.bones
    head = b["Bip01 Head"].head_local
    nose = b["Bip01 MNose"].head_local if "Bip01 MNose" in b else (
        (b["Bip01 LEye"].head_local + b["Bip01 REye"].head_local) / 2)
    fwd = nose - head
    if fwd.y > 0:  # facing +Y -> turn around
        log("rotating 180 deg to face -Y (glTF +Z)")
        R = Matrix.Rotation(math.pi, 4, "Z")
        arm.matrix_world = R @ arm.matrix_world
        lod0.matrix_world = R @ lod0.matrix_world
        apply_all_transforms(arm, [lod0])
    if b["Bip01 L UpperArm"].head_local.x <= 0:
        raise RuntimeError("character's left side is not on +X; unexpected mirroring")
    zs = [v.co.z for v in lod0.data.vertices]
    minz = min(zs)
    mid = (b["Bip01 L Foot"].head_local + b["Bip01 R Foot"].head_local) / 2
    T = Matrix.Translation((-mid.x, -mid.y, -minz))
    arm.matrix_world = T @ arm.matrix_world
    lod0.matrix_world = T @ lod0.matrix_world
    apply_all_transforms(arm, [lod0])
    zs = [v.co.z for v in lod0.data.vertices]
    report["height_m"] = round(max(zs) - min(zs), 4)
    report["groundOffset_m"] = [round(-mid.x, 4), round(-mid.y, 4), round(-minz, 4)]


# ---------------------------------------------------------------------------
# LODs
# ---------------------------------------------------------------------------

def make_lods(arm, lod0, char_id, lod_specs, report):
    lod0.name = lod_specs[0]["name"]
    lod0.data.name = f"{char_id}_{lod_specs[0]['name']}"
    objs = [lod0]
    for spec in lod_specs[1:]:
        o = lod0.copy()
        o.data = lod0.data.copy()
        o.name = spec["name"]
        o.data.name = f"{char_id}_{spec['name']}"
        bpy.context.scene.collection.objects.link(o)
        o.parent = arm
        o.matrix_parent_inverse = Matrix.Identity(4)
        for m in o.modifiers:
            if m.type == "ARMATURE":
                m.object = arm
        if spec.get("method", "meshopt") == "meshopt":
            # plain copy; tools/gltf/optimize-characters.sh simplifies it with meshoptimizer
            # (keeps original vertices -> exact normals/UVs/skin weights)
            objs.append(o)
            continue
        dec = o.modifiers.new("Decimate", "DECIMATE")
        dec.decimate_type = "COLLAPSE"
        dec.ratio = float(spec["ratio"])
        dec.use_collapse_triangulate = True
        dec.use_symmetry = bool(spec.get("symmetry", True))
        dec.symmetry_axis = "X"
        dec.delimit = set(spec.get("delimit", ["UV"]))
        o.modifiers.move(len(o.modifiers) - 1, 0)  # decimate before armature
        select_only([o], o)
        with bpy.context.temp_override(object=o, active_object=o, selected_objects=[o]):
            bpy.ops.object.modifier_apply(modifier=dec.name)
        # Normals: the collapse invalidates LOD0's FBX custom normals.
        #   "clear"  -> recompute smooth normals from the decimated geometry (keeps sharp edges)
        #   "keep"   -> whatever the decimate modifier interpolated
        #   "transfer:<loop_mapping>" -> Data Transfer from LOD0 (e.g. transfer:NEAREST_POLYNOR)
        mode = spec.get("normals", "clear")
        if mode == "clear":
            with bpy.context.temp_override(object=o, active_object=o, selected_objects=[o]):
                bpy.ops.mesh.customdata_custom_splitnormals_clear()
        elif mode.startswith("transfer:"):
            dt = o.modifiers.new("NormalsXfer", "DATA_TRANSFER")
            dt.object = lod0
            dt.use_loop_data = True
            dt.data_types_loops = {"CUSTOM_NORMAL"}
            dt.loop_mapping = mode.split(":", 1)[1]
            o.modifiers.move(len(o.modifiers) - 1, 0)
            select_only([o], o)
            with bpy.context.temp_override(object=o, active_object=o, selected_objects=[o]):
                bpy.ops.object.modifier_apply(modifier=dt.name)
        # re-normalize the interpolated weights
        select_only([o], o)
        with bpy.context.temp_override(object=o, active_object=o, selected_objects=[o]):
            bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL", lock_active=False)
        objs.append(o)
    report["lods"] = [{"name": o.name, "triangles": tri_count(o.data), "vertices": len(o.data.vertices)}
                      for o in objs]
    return objs


# ---------------------------------------------------------------------------
# materials / textures
# ---------------------------------------------------------------------------

def material_kind(name: str) -> str:
    n = name.lower()
    if "glasses" in n:
        return "glasses"
    if "opacity" in n:
        return "opacity"
    if "head" in n:
        return "head"
    return "body"


def rebuild_materials(char, defaults, tex_dir, cache_dir, report):
    tex_size = int(defaults["textureSize"])
    op_size = int(defaults["opacityTextureSize"])
    cutoff = float(char.get("alphaCutoff", defaults["alphaCutoff"]))
    rough = dict(defaults["roughness"])
    rough.update(char.get("roughness", {}))
    skin_guard = char.get("skinGuard", defaults.get("skinGuard"))
    feather = defaults.get("recolorFeather")
    mats_report = []
    for mat in list(bpy.data.materials):
        if mat.users == 0 or not mat.node_tree:
            continue
        kind = material_kind(mat.name)
        src_imgs = sorted({(n.image.filepath or n.image.name) for n in mat.node_tree.nodes
                           if n.type == "TEX_IMAGE" and n.image})
        color_src = normal_src = None
        for s in src_imgs:
            b = os.path.basename(s.replace("\\", "/")).lower()
            if b.endswith("_normal.tga"):
                normal_src = s
            elif b.endswith("_color.tga"):
                color_src = s
        # Glasses/other: fall back to name-prefix lookup in Textures/
        if color_src is None:
            for f in os.listdir(tex_dir):
                if f.lower().startswith(mat.name.lower()) and f.lower().endswith("_color.tga"):
                    color_src = f
        color_path = find_texture(tex_dir, color_src) if color_src else None
        normal_path = find_texture(tex_dir, normal_src) if normal_src else None
        if not color_path:
            raise RuntimeError(f"{mat.name}: colour texture not found (refs: {src_imgs})")
        alpha = kind in ("opacity", "glasses")
        size = op_size if alpha else tex_size
        rules = ra.texture_key_rules(char.get("recolor"), color_path)
        c_png, mask = ra.prepare_texture(color_path, os.path.join(cache_dir, f"{mat.name}_color.png"), size,
                                         rules=rules, skin_guard=skin_guard, feather=feather,
                                         keep_alpha=alpha)
        n_png = None
        if normal_path:
            n_png, _ = ra.prepare_texture(normal_path, os.path.join(cache_dir, f"{mat.name}_normal.png"),
                                          size if alpha else tex_size, non_color=True)
        # --- fresh node tree -------------------------------------------------
        nt = mat.node_tree
        nt.nodes.clear()
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
        bsdf.inputs["Base Color"].default_value = (1, 1, 1, 1)  # Rocketbox issue #2: factor was black
        bsdf.inputs["Metallic"].default_value = 0.0
        bsdf.inputs["Roughness"].default_value = float(rough.get(kind, 0.6))
        img = bpy.data.images.load(c_png, check_existing=True)
        img.name = f"{char['id']}_{mat.name}_color"
        img.alpha_mode = "STRAIGHT" if alpha else "NONE"
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = img
        tex.interpolation = "Linear"
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        if n_png:
            nimg = bpy.data.images.load(n_png, check_existing=True)
            nimg.name = f"{char['id']}_{mat.name}_normal"
            nimg.colorspace_settings.name = "Non-Color"
            ntex = nt.nodes.new("ShaderNodeTexImage")
            ntex.image = nimg
            nmap = nt.nodes.new("ShaderNodeNormalMap")
            nt.links.new(ntex.outputs["Color"], nmap.inputs["Color"])
            nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
        if alpha:
            # glTF alphaMode MASK: alpha -> (x < cutoff) -> (1 - x) -> BSDF Alpha
            lt = nt.nodes.new("ShaderNodeMath")
            lt.operation = "LESS_THAN"
            lt.inputs[1].default_value = cutoff
            sub = nt.nodes.new("ShaderNodeMath")
            sub.operation = "SUBTRACT"
            sub.inputs[0].default_value = 1.0
            nt.links.new(tex.outputs["Alpha"], lt.inputs[0])
            nt.links.new(lt.outputs[0], sub.inputs[1])
            nt.links.new(sub.outputs[0], bsdf.inputs["Alpha"])
            if hasattr(mat, "surface_render_method"):
                mat.surface_render_method = "DITHERED"
            # Rocketbox hair already contains back-to-back card pairs (authored for Unity's
            # back-face-culled Standard shader); doubleSided would expose inward-facing backsides.
            mat.use_backface_culling = not bool(char.get("doubleSidedAlpha", defaults.get("doubleSidedAlpha", False)))
        else:
            mat.use_backface_culling = True
        mats_report.append({"material": mat.name, "kind": kind, "color": os.path.basename(color_path),
                            "normal": os.path.basename(normal_path) if normal_path else None,
                            "recolorRules": [r.get("name") for r in rules], "alphaMode": "MASK" if alpha else "OPAQUE",
                            "size": size})
    # drop the dangling original TGA image datablocks
    for im in list(bpy.data.images):
        if im.users == 0:
            bpy.data.images.remove(im)
    report["materials"] = mats_report


# ---------------------------------------------------------------------------
# export
# ---------------------------------------------------------------------------

def export_glb(arm, lods, path, defaults):
    select_only([arm] + lods, arm)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fmt = defaults.get("imageFormat", "WEBP")
    kw = dict(
        filepath=path, export_format="GLB", use_selection=True,
        export_animations=False, export_skins=True, export_morph=False,
        export_yup=True, export_apply=False,
        export_texcoords=True, export_normals=True, export_tangents=False,
        export_materials="EXPORT", export_vertex_color="NONE", export_attributes=False,
        export_cameras=False, export_lights=False, export_extras=False,
        export_def_bones=False, export_leaf_bone=False, export_rest_position_armature=True,
        export_influence_nb=4, export_all_influences=False,
        export_image_format=fmt, export_image_quality=int(defaults.get("imageQuality", 82)),
        export_image_add_webp=False, export_image_webp_fallback=False,
    )
    try:
        bpy.ops.export_scene.gltf(**kw)
    except Exception as e:
        if fmt == "WEBP":
            log("WEBP export failed, retrying with JPEG:", e)
            kw["export_image_format"] = "JPEG"
            bpy.ops.export_scene.gltf(**kw)
        else:
            raise


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def convert(char, cast):
    d = cast["defaults"]
    t0 = time.time()
    src_dir = os.path.join(ROOT, cast["sourceRoot"], char["sourceDir"])
    fbx = os.path.join(src_dir, "Export", f"{char['name']}.fbx")
    tex_dir = os.path.join(src_dir, "Textures")
    cache_dir = os.path.join(ROOT, cast["cacheDir"], char["id"])
    out = os.path.join(ROOT, cast["outputDir"], f"{char['id']}.glb")
    os.makedirs(cache_dir, exist_ok=True)
    report = {"id": char["id"], "source": os.path.relpath(fbx, ROOT)}

    reset_scene()
    report["importer"] = import_fbx(fbx)
    arm, lod0 = cleanup_and_pick(report)
    report["bindRestMaxDeviation_m"] = round(bind_rest_deviation(lod0) * arm.matrix_world.to_scale()[0], 6)
    apply_all_transforms(arm, [lod0])
    normalize_placement(arm, lod0, report)
    arm.name = "Bip01"
    arm.data.name = "Bip01"
    arm.data.pose_position = "REST"
    lods = make_lods(arm, lod0, char["id"], char.get("lods", d["lods"]), report)
    arm.data.pose_position = "POSE"
    rebuild_materials(char, d, tex_dir, cache_dir, report)
    report["bones"] = len(arm.data.bones)
    report["boneNamesBlender"] = [b.name for b in arm.data.bones]
    export_glb(arm, lods, out, d)
    report["file"] = os.path.relpath(out, ROOT)
    report["bytes"] = os.path.getsize(out)
    report["seconds"] = round(time.time() - t0, 1)
    with open(os.path.join(cache_dir, "report.json"), "w") as f:
        json.dump(report, f, indent=2)
    log(f"{char['id']}: {report['bytes'] / 1e6:.2f} MB, height {report['height_m']} m, "
        f"LODs {[l['triangles'] for l in report['lods']]}, bind/rest dev {report['bindRestMaxDeviation_m']} m, "
        f"importer {report['importer']}")
    return report


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--cast", default=os.path.join(HERE, "characters.json"))
    ap.add_argument("--id", action="append", default=None, help="character id(s); default: all enabled")
    ap.add_argument("--out-dir", default=None, help="override outputDir (relative to repo root)")
    ap.add_argument("--lod-normals", default=None, help="override LOD normal mode: clear | keep | transfer:<mapping>")
    args = ap.parse_args(argv)
    cast = json.load(open(args.cast))
    if args.out_dir:
        cast["outputDir"] = os.path.relpath(os.path.abspath(args.out_dir), ROOT)
    if args.lod_normals:
        for l in cast["defaults"]["lods"]:
            l["normals"] = args.lod_normals
    chars = [c for c in cast["characters"] if c.get("enabled", True)]
    if args.id:
        chars = [c for c in cast["characters"] if c["id"] in args.id]
        missing = set(args.id) - {c["id"] for c in chars}
        if missing:
            raise SystemExit(f"unknown ids: {sorted(missing)}")
    failures = []
    for c in chars:
        try:
            convert(c, cast)
        except Exception as e:
            import traceback
            traceback.print_exc()
            failures.append((c["id"], str(e)))
    if failures:
        for f in failures:
            log("FAILED", *f)
        sys.exit(1)


if __name__ == "__main__":
    main()
