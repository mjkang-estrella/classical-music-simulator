"""
Convert Microsoft Rocketbox avatars (FBX, 3ds Max Biped "Bip01" rig) to web-ready GLBs.

  tools/blender/run.sh tools/blender/rocketbox_to_glb.py -- --cast tools/blender/characters.json [--id <id> ...]

Output contract (per character, public/assets/characters/<id>.glb):
  * meters, +Y up, character faces +Z, feet on y=0, origin between the ankles
  * full Bip01 skeleton (80 joints: fingers, jaw, eyelids, face bones) plus forearm twist bones
    "Bip01 L ForeTwist" / "Bip01 R ForeTwist" (children of the forearms, 55 % elbow->wrist, same
    frame as the forearm; the hands stay children of the forearms); Footsteps helper removed
  * native bind pose (A-pose) as rest pose, no animations
  * four skinned meshes LOD0..LOD3 bound to the same skin:
      LOD0  Rocketbox hipoly mesh, tris->quads, one Catmull-Clark level (close-ups; <= maxTriangles,
            capped by tools/gltf/optimize-characters.sh with meshoptimizer if needed)
      LOD1  the original hipoly mesh
      LOD2/LOD3  meshoptimizer simplifications (tools/gltf/optimize-characters.sh; exported here as copies)
  * textures resolved from the local Textures/ folder, recolored (recolor_attire.py), 2048^2 colour +
    normal (opacity 1024^2), roughness maps derived from the *_specular.tga maps (metallicRoughness.G,
    metallic 0), exported as WebP; hair/lashes/glasses alpha MASK
  * eyeballs and mouth interior (teeth, gums, tongue) split from the head into their own materials
    "<id>_eyes" / "<id>_mouth" (same head textures, constant low roughness)
A small build report is written next to the texture cache (vendor/rocketbox/cache/<id>/report.json).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time

import bmesh
import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import recolor_attire as ra  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
TWIST_BONES = {"L": "Bip01 L ForeTwist", "R": "Bip01 R ForeTwist"}


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def log(*a):
    print("[rocketbox]", *a, flush=True)


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def select_only(objs, active=None):
    for o in bpy.context.view_layer.objects:
        if o is not None:
            o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or (objs[0] if objs else None)


def obj_override(o):
    return bpy.context.temp_override(object=o, active_object=o, selected_objects=[o],
                                     selected_editable_objects=[o])


def tri_count(me) -> int:
    return sum(len(p.vertices) - 2 for p in me.polygons)


def smoothstep(e0, e1, x):
    t = min(max((x - e0) / (e1 - e0), 0.0), 1.0)
    return t * t * (3.0 - 2.0 * t)


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

def cleanup_and_pick(char, report):
    arm_list = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    if len(arm_list) != 1:
        raise RuntimeError(f"expected 1 armature, got {len(arm_list)}")
    arm = arm_list[0]
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
    # props (hats, pistols, equipment): delete their faces, see characters.json -> removeMaterials
    drop = [s.lower() for s in char.get("removeMaterials", [])]
    if drop:
        me = lod0.data
        idx = {i for i, s in enumerate(lod0.material_slots)
               if s.material and any(d in s.material.name.lower() for d in drop)}
        bm = bmesh.new()
        bm.from_mesh(me)
        faces = [f for f in bm.faces if f.material_index in idx]
        bmesh.ops.delete(bm, geom=faces, context="FACES")
        loose = [v for v in bm.verts if not v.link_faces]
        bmesh.ops.delete(bm, geom=loose, context="VERTS")
        bm.to_mesh(me)
        bm.free()
        for i in sorted(idx, reverse=True):
            name = lod0.material_slots[i].material.name
            lod0.active_material_index = i
            with obj_override(lod0):
                bpy.ops.object.material_slot_remove()
            report.setdefault("removedMaterials", []).append(name)
        report["removedFaces"] = len(faces)
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
# eyes / mouth material split
# ---------------------------------------------------------------------------

def material_kind(name: str) -> str:
    n = name.lower()
    if n.endswith("_eyes"):
        return "eyes"
    if n.endswith("_mouth"):
        return "mouth"
    if "glasses" in n:
        return "glasses"
    if "opacity" in n:
        return "opacity"
    if "head" in n:
        return "head"
    return "body"


def split_face_materials(char, obj, arm, cfg, report):
    """Moves the eyeballs and the mouth interior out of the head material.

    eyes : head-material faces whose vertices are all weighted >= 0.5 to Bip01 LEye / REye
           (Rocketbox eyeballs are separate closed meshes rigidly skinned to the eye bones)
    mouth: head-material faces whose UV centroid lies in cfg.mouth.uvRect (the teeth / gums /
           tongue block of the Rocketbox head atlas; normalized, origin top-left) and whose centroid
           is more than cfg.mouth.belowEyes_m below the eye bones and within cfg.mouth.radius_m of
           the lip bones (the rect's corners also catch a few eye-socket / neck faces)
    The new materials are copies of the head material (same images), named <id>_eyes / <id>_mouth."""
    if not cfg or not cfg.get("enabled", True):
        return
    me = obj.data
    head_idx = [i for i, s in enumerate(obj.material_slots) if s.material and material_kind(s.material.name) == "head"]
    if len(head_idx) != 1:
        log(f"{char['id']}: no unique head material, eyes/mouth not split")
        return
    hi = head_idx[0]
    head_mat = obj.material_slots[hi].material
    gidx = {g.name: g.index for g in obj.vertex_groups}
    eye_groups = {gidx[n] for n in ("Bip01 LEye", "Bip01 REye") if n in gidx}
    eye_v = set()
    for v in me.vertices:
        if any(g.group in eye_groups and g.weight >= 0.5 for g in v.groups):
            eye_v.add(v.index)
    uv = me.uv_layers.active.data
    rect = cfg.get("mouth", {}).get("uvRect")
    to_obj = obj.matrix_world.inverted() @ arm.matrix_world
    eye_z = (to_obj @ ((arm.data.bones["Bip01 LEye"].head_local + arm.data.bones["Bip01 REye"].head_local) / 2)).z
    z_max = eye_z - float(cfg.get("mouth", {}).get("belowEyes_m", 0.03))
    lips = [n for n in ("Bip01 MUpperLip", "Bip01 MBottomLip") if n in arm.data.bones]
    mouth_c = (to_obj @ (sum((arm.data.bones[n].head_local for n in lips), Vector()) / len(lips))) if lips else None
    mouth_r = float(cfg.get("mouth", {}).get("radius_m", 0.075))
    eyes, mouth = [], []
    for p in me.polygons:
        if p.material_index != hi:
            continue
        if eye_groups and all(vi in eye_v for vi in p.vertices):
            eyes.append(p.index)
            continue
        if rect:
            u = sum(uv[li].uv.x for li in p.loop_indices) / p.loop_total
            v = 1.0 - sum(uv[li].uv.y for li in p.loop_indices) / p.loop_total
            near = mouth_c is None or (p.center - mouth_c).length < mouth_r
            if rect[0] <= u <= rect[2] and rect[1] <= v <= rect[3] and p.center.z < z_max and near:
                mouth.append(p.index)
    out = {}
    for part, faces in (("eyes", eyes), ("mouth", mouth)):
        if not faces or not cfg.get(part, {}).get("enabled", True):
            continue
        m = head_mat.copy()
        m.name = f"{char['id']}_{part}"
        obj.data.materials.append(m)
        mi = len(obj.material_slots) - 1
        for fi in faces:
            me.polygons[fi].material_index = mi
        vs = {vi for fi in faces for vi in me.polygons[fi].vertices}
        co = [me.vertices[i].co for i in vs]
        out[part] = {"material": m.name, "faces": len(faces), "vertices": len(vs),
                     "bboxMin": [round(min(c[k] for c in co), 3) for k in range(3)],
                     "bboxMax": [round(max(c[k] for c in co), 3) for k in range(3)]}
    # eyes: count the separate closed eyeball shells
    if eyes:
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.faces.ensure_lookup_table()
        fset = set(eyes)
        shells, seen = 0, set()
        closed = True
        for fi in eyes:
            if fi in seen:
                continue
            shells += 1
            stack = [bm.faces[fi]]
            seen.add(fi)
            while stack:
                f = stack.pop()
                for e in f.edges:
                    if e.is_boundary:
                        closed = False
                    for g in e.link_faces:
                        if g.index in fset and g.index not in seen:
                            seen.add(g.index)
                            stack.append(g)
        bm.free()
        out["eyes"].update({"shells": shells, "closed": closed, "bones": ["Bip01 LEye", "Bip01 REye"]})
    report["splitMaterials"] = out


# ---------------------------------------------------------------------------
# twist bones
# ---------------------------------------------------------------------------

def add_twist_bones(arm, cfg, report):
    """Bip01 {L,R} ForeTwist: child of the forearm, at `fraction` of elbow->wrist, same frame (and
    therefore same roll) as the forearm. The hand keeps the forearm as its parent."""
    frac = float(cfg.get("fraction", 0.55))
    select_only([arm], arm)
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm.data.edit_bones
    out = {}
    for side, name in TWIST_BONES.items():
        fa = eb[f"Bip01 {side} Forearm"]
        hand = eb[f"Bip01 {side} Hand"]
        if name in eb:
            eb.remove(eb[name])
        p = fa.head.lerp(hand.head, frac)
        tw = eb.new(name)
        tw.head = (0.0, 0.0, 0.0)
        tw.tail = (0.0, fa.length * 0.5, 0.0)
        M = fa.matrix.copy()
        M.translation = p
        tw.matrix = M
        tw.parent = fa
        tw.use_connect = False
        tw.use_deform = True
        tw.use_inherit_rotation = True
        tw.inherit_scale = fa.inherit_scale
        assert hand.parent == fa, "hand must stay a child of the forearm"
        out[name] = {"parent": fa.name, "head": [round(x, 4) for x in p],
                     "rollMatchesForearm": abs(tw.roll - fa.roll) < 1e-4}
    bpy.ops.object.mode_set(mode="OBJECT")
    report["twistBones"] = out


def reweight_twist(obj, arm, cfg):
    """Move w = smoothstep(t0, t1, t) * share of each vertex's forearm weight to the twist bone
    (t = projection on elbow->wrist, 0 at the elbow). Hand weights are left alone."""
    t0, t1 = cfg.get("smoothstep", [0.15, 1.0])
    share = float(cfg.get("share", 0.85))
    me = obj.data
    bones = arm.data.bones
    to_obj = obj.matrix_world.inverted() @ arm.matrix_world
    stats = {}
    for side, tw_name in TWIST_BONES.items():
        fa_name = f"Bip01 {side} Forearm"
        gf = obj.vertex_groups.get(fa_name)
        if gf is None:
            continue
        gt = obj.vertex_groups.get(tw_name) or obj.vertex_groups.new(name=tw_name)
        e = to_obj @ bones[fa_name].head_local
        w = to_obj @ bones[f"Bip01 {side} Hand"].head_local
        d = w - e
        l2 = d.dot(d)
        moved = 0
        total = 0.0
        for v in me.vertices:
            wf = 0.0
            for g in v.groups:
                if g.group == gf.index:
                    wf = g.weight
                    break
            if wf <= 0.0:
                continue
            t = (v.co - e).dot(d) / l2
            s = smoothstep(t0, t1, t) * share
            if s <= 0.0:
                continue
            m = wf * s
            gf.add([v.index], wf - m, "REPLACE")
            gt.add([v.index], m, "ADD")
            moved += 1
            total += m
        stats[side] = {"vertices": moved, "weightMoved": round(total, 2)}
    return stats


def limit_and_normalize(obj, limit=4, eps=1e-4):
    """Keep the `limit` largest influences per vertex (drop < eps) and renormalize to 1."""
    groups = list(obj.vertex_groups)
    changed = 0
    for v in obj.data.vertices:
        ws = sorted(((g.weight, g.group) for g in v.groups), reverse=True)
        keep = [(w, gi) for w, gi in ws[:limit] if w > eps] or ws[:1]
        total = sum(w for w, _ in keep) or 1.0
        drop = [gi for _, gi in ws if gi not in {k for _, k in keep}]
        for gi in drop:
            groups[gi].remove([v.index])
        for w, gi in keep:
            if abs(w / total - w) > 1e-7:
                groups[gi].add([v.index], w / total, "REPLACE")
        changed += bool(drop) or abs(total - 1.0) > 1e-6
    return changed


def max_influences(obj) -> int:
    return max((len(v.groups) for v in obj.data.vertices), default=0)


# ---------------------------------------------------------------------------
# LODs
# ---------------------------------------------------------------------------

def quadify(o, spec):
    """Join the FBX triangles back into quads (Rocketbox is quad-modelled, the FBX is triangulated),
    never across UV seams, sharp edges or material borders. Better Catmull-Clark, fewer triangles."""
    me = o.data
    bm = bmesh.new()
    bm.from_mesh(me)
    ang = math.radians(float(spec.get("quadifyAngle", 40)))
    bmesh.ops.join_triangles(bm, faces=bm.faces[:], cmp_seam=False, cmp_sharp=True, cmp_uvs=True,
                             cmp_vcols=False, cmp_materials=True,
                             angle_face_threshold=ang, angle_shape_threshold=ang)
    bm.to_mesh(me)
    bm.free()


def subdivide(o, spec, report):
    """One Catmull-Clark level on every material. Weights are interpolated by the modifier; UVs use
    spec.uvSmooth (default PRESERVE_BOUNDARIES = "Keep Borders"). The FBX custom normals are cleared
    afterwards: normals come from the smooth subdivided surface, split only at the sharp edges
    Rocketbox authored (sharp_edge is propagated to the child edges)."""
    me = o.data
    sharp_before = sum(1 for a in me.attributes["sharp_edge"].data if a.value) if "sharp_edge" in me.attributes else 0
    if spec.get("quadify", True):
        tris = tri_count(me)
        quadify(o, spec)
        report["quadify"] = {"trianglesIn": tris, "faces": len(me.polygons),
                             "quads": sum(1 for p in me.polygons if len(p.vertices) == 4)}
    crease_kinds = set(spec.get("creaseMaterialBorders", []))
    if crease_kinds:
        # e.g. "mouth": the lip line is one thin closed loop between the lip skin and the mouth bag;
        # without a crease Catmull-Clark pulls it into the mouth and the lips part.
        kinds = [material_kind(s.material.name) if s.material else "" for s in o.material_slots]
        attr = me.attributes.get("crease_edge") or me.attributes.new("crease_edge", "FLOAT", "EDGE")
        n = 0
        edge_faces = {}
        for p in me.polygons:
            for ek in p.edge_keys:
                edge_faces.setdefault(ek, set()).add(kinds[p.material_index])
        for e in me.edges:
            ks = edge_faces.get(e.key, set())
            if len(ks) > 1 and ks & crease_kinds:
                attr.data[e.index].value = 1.0
                n += 1
        report["creasedEdges"] = n
    mod = o.modifiers.new("Subdiv", "SUBSURF")
    mod.subdivision_type = "CATMULL_CLARK"
    mod.levels = mod.render_levels = int(spec.get("levels", 1))
    mod.quality = 3
    mod.uv_smooth = spec.get("uvSmooth", "PRESERVE_BOUNDARIES")
    mod.boundary_smooth = spec.get("boundarySmooth", "PRESERVE_CORNERS")
    mod.use_creases = True
    mod.use_limit_surface = bool(spec.get("limitSurface", False))
    if hasattr(mod, "use_custom_normals"):
        mod.use_custom_normals = False
    settings = {"levels": mod.levels, "uvSmooth": mod.uv_smooth, "boundarySmooth": mod.boundary_smooth,
                "limitSurface": mod.use_limit_surface}
    o.modifiers.move(len(o.modifiers) - 1, 0)
    with obj_override(o):
        bpy.ops.object.modifier_apply(modifier=mod.name)
    me = o.data
    if me.has_custom_normals:
        with obj_override(o):
            bpy.ops.mesh.customdata_custom_splitnormals_clear()
    if "sharp_face" in me.attributes:
        me.attributes.remove(me.attributes["sharp_face"])
    sharp_after = sum(1 for a in me.attributes["sharp_edge"].data if a.value) if "sharp_edge" in me.attributes else 0
    report["subdivision"] = {**settings, "sharpEdgesBefore": sharp_before, "sharpEdgesAfter": sharp_after,
                             "customNormals": me.has_custom_normals, "triangles": tri_count(me)}


def make_lods(arm, src, char_id, lod_specs, report):
    src.name = "_src"
    objs = []
    for spec in lod_specs:
        o = src.copy()
        o.data = src.data.copy()
        o.name = spec["name"]
        o.data.name = f"{char_id}_{spec['name']}"
        bpy.context.scene.collection.objects.link(o)
        o.parent = arm
        o.matrix_parent_inverse = Matrix.Identity(4)
        for m in o.modifiers:
            if m.type == "ARMATURE":
                m.object = arm
        method = spec.get("method", "meshopt")
        if method == "subdivide":
            subdivide(o, spec, report)
        elif method == "decimate":
            dec = o.modifiers.new("Decimate", "DECIMATE")
            dec.decimate_type = "COLLAPSE"
            dec.ratio = float(spec["ratio"])
            dec.use_collapse_triangulate = True
            dec.use_symmetry = bool(spec.get("symmetry", True))
            dec.symmetry_axis = "X"
            dec.delimit = set(spec.get("delimit", ["UV"]))
            o.modifiers.move(len(o.modifiers) - 1, 0)  # decimate before armature
            with obj_override(o):
                bpy.ops.object.modifier_apply(modifier=dec.name)
            if spec.get("normals", "clear") == "clear":
                with obj_override(o):
                    bpy.ops.mesh.customdata_custom_splitnormals_clear()
        # "copy" / "meshopt": plain copy (meshopt LODs are simplified by tools/gltf/optimize-characters.sh,
        # which keeps original vertices -> exact normals/UVs/skin weights)
        objs.append(o)
    bpy.data.objects.remove(src, do_unlink=True)
    bpy.context.view_layer.update()
    return objs


# ---------------------------------------------------------------------------
# materials / textures
# ---------------------------------------------------------------------------

def rebuild_materials(char, defaults, tex_dir, cache_dir, report):
    tex_size = int(defaults["textureSize"])
    op_size = int(defaults["opacityTextureSize"])
    cutoff = float(char.get("alphaCutoff", defaults["alphaCutoff"]))
    rough = dict(defaults["roughness"])
    rough.update(char.get("roughness", {}))
    rmap_cfg = json.loads(json.dumps(defaults.get("roughnessMap", {})))
    for k, v in char.get("roughnessMap", {}).items():  # per-character overrides, merged per kind
        if isinstance(v, dict) and isinstance(rmap_cfg.get(k), dict):
            rmap_cfg[k].update(v)
        else:
            rmap_cfg[k] = v
    skin_guard = char.get("skinGuard", defaults.get("skinGuard"))
    rmask = char.get("roughnessSkinMask", rmap_cfg.get("skinMask", skin_guard))
    feather = defaults.get("recolorFeather")
    mats_report = []
    for mat in list(bpy.data.materials):
        if mat.users == 0 or not mat.node_tree:
            continue
        kind = material_kind(mat.name)
        src_imgs = sorted({(n.image.filepath or n.image.name) for n in mat.node_tree.nodes
                           if n.type == "TEX_IMAGE" and n.image})
        color_src = normal_src = spec_src = None
        for s in src_imgs:
            b = os.path.basename(s.replace("\\", "/")).lower()
            if b.endswith("_normal.tga"):
                normal_src = s
            elif b.endswith("_color.tga"):
                color_src = s
            elif b.endswith("_specular.tga"):
                spec_src = s
        # Glasses/other: fall back to name-prefix lookup in Textures/
        if color_src is None:
            for f in os.listdir(tex_dir):
                if f.lower().startswith(mat.name.lower()) and f.lower().endswith("_color.tga"):
                    color_src = f
        color_path = find_texture(tex_dir, color_src) if color_src else None
        normal_path = find_texture(tex_dir, normal_src) if normal_src else None
        if not color_path:
            raise RuntimeError(f"{mat.name}: colour texture not found (refs: {src_imgs})")
        spec_path = find_texture(tex_dir, spec_src) if spec_src else None
        if spec_path is None:
            cand = os.path.basename(color_path)[: -len("_color.tga")] + "_specular.tga"
            spec_path = find_texture(tex_dir, cand)
        stem = os.path.basename(color_path)[: -len("_color.tga")]  # e.g. m005_head
        alpha = kind in ("opacity", "glasses")
        size = int(defaults.get("glassesTextureSize", op_size)) if kind == "glasses" else (op_size if alpha else tex_size)
        rules = ra.texture_key_rules(char.get("recolor"), color_path)
        c_png, _ = ra.prepare_texture(color_path, os.path.join(cache_dir, f"{stem}_color.png"), size,
                                      rules=rules, skin_guard=skin_guard, feather=feather,
                                      keep_alpha=alpha, hole_fill=int(defaults.get("recolorHoleFill", 0)))
        n_png = None
        if normal_path:
            n_png, _ = ra.prepare_texture(normal_path, os.path.join(cache_dir, f"{stem}_normal.png"),
                                          size, non_color=True)
        r_png = r_stats = None
        use_rmap = (rmap_cfg.get("enabled", True) and spec_path and not alpha and kind in ("head", "body"))
        if use_rmap:
            params = {k: v for k, v in rmap_cfg.items() if k not in ("head", "body", "skinMask", "$comment")}
            params.update(rmap_cfg.get(kind, {}))  # per-kind overrides (head: singleK + skinRect)
            # mask / suit detection on the recolored texture (c_png): garments are black there
            r_png, r_stats = ra.prepare_roughness(spec_path, c_png, os.path.join(cache_dir, f"{stem}_roughness.png"),
                                                  size, skin_mask_box=rmask, params=params)
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
        img.name = f"{stem}_color"
        img.alpha_mode = "STRAIGHT" if alpha else "NONE"
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = img
        tex.interpolation = "Linear"
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        if n_png:
            nimg = bpy.data.images.load(n_png, check_existing=True)
            nimg.name = f"{stem}_normal"
            nimg.colorspace_settings.name = "Non-Color"
            ntex = nt.nodes.new("ShaderNodeTexImage")
            ntex.image = nimg
            nmap = nt.nodes.new("ShaderNodeNormalMap")
            nt.links.new(ntex.outputs["Color"], nmap.inputs["Color"])
            nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
        if r_png:
            # grey map (R=G=B=roughness): G -> Roughness (factor 1), B * 0 -> Metallic (factor 0).
            # Both channels from one image with matching channels = the exporter writes the image as is.
            rimg = bpy.data.images.load(r_png, check_existing=True)
            rimg.name = f"{stem}_roughness"
            rimg.colorspace_settings.name = "Non-Color"
            rtex = nt.nodes.new("ShaderNodeTexImage")
            rtex.image = rimg
            sep = nt.nodes.new("ShaderNodeSeparateColor")
            nt.links.new(rtex.outputs["Color"], sep.inputs["Color"])
            nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
            mul = nt.nodes.new("ShaderNodeMath")
            mul.operation = "MULTIPLY"
            mul.inputs[1].default_value = 0.0
            nt.links.new(sep.outputs["Blue"], mul.inputs[0])
            nt.links.new(mul.outputs[0], bsdf.inputs["Metallic"])
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
                            "roughnessMap": os.path.basename(spec_path) if r_png else None,
                            "roughness": r_stats if r_png else float(rough.get(kind, 0.6)),
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
        export_image_format=fmt, export_image_quality=int(defaults.get("imageQuality", 88)),
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
    arm, base = cleanup_and_pick(char, report)
    report["bindRestMaxDeviation_m"] = round(bind_rest_deviation(base) * arm.matrix_world.to_scale()[0], 6)
    apply_all_transforms(arm, [base])
    normalize_placement(arm, base, report)
    arm.name = "Bip01"
    arm.data.name = "Bip01"
    split_face_materials(char, base, arm, d.get("splitMaterials"), report)
    twist = dict(d.get("twistBones", {}))
    twist.update(char.get("twistBones", {}))
    if twist.get("enabled", False):
        add_twist_bones(arm, twist, report)
    arm.data.pose_position = "REST"
    lods = make_lods(arm, base, char["id"], char.get("lods", d["lods"]), report)
    arm.data.pose_position = "POSE"
    tw_stats = {}
    for o in lods:
        if twist.get("enabled", False):
            tw_stats[o.name] = reweight_twist(o, arm, twist)
        limit_and_normalize(o, 4)
    if tw_stats:
        report["twistReweight"] = tw_stats
    report["lods"] = [{"name": o.name, "triangles": tri_count(o.data), "vertices": len(o.data.vertices),
                       "maxInfluences": max_influences(o)} for o in lods]
    rebuild_materials(char, d, tex_dir, cache_dir, report)
    report["bones"] = len(arm.data.bones)
    report["boneNamesBlender"] = [b.name for b in arm.data.bones]
    export_glb(arm, lods, out, d)
    report["file"] = os.path.relpath(out, ROOT)
    report["bytes"] = os.path.getsize(out)
    report["seconds"] = round(time.time() - t0, 1)
    with open(os.path.join(cache_dir, "report.json"), "w") as f:
        json.dump(report, f, indent=2)
    rm = {m["material"]: m["roughness"] for m in report["materials"] if isinstance(m["roughness"], dict)}
    log(f"{char['id']}: {report['bytes'] / 1e6:.2f} MB, height {report['height_m']} m, "
        f"LODs {[l['triangles'] for l in report['lods']]}, bones {report['bones']}, "
        f"bind/rest dev {report['bindRestMaxDeviation_m']} m, split {({k: v['faces'] for k, v in report.get('splitMaterials', {}).items()})}, "
        f"roughness {({k: (v['skinMean'], v['clothMean']) for k, v in rm.items()})}, {report['seconds']} s")
    return report


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--cast", default=os.path.join(HERE, "characters.json"))
    ap.add_argument("--id", action="append", default=None, help="character id(s); default: all enabled")
    ap.add_argument("--out-dir", default=None, help="override outputDir (relative to repo root)")
    ap.add_argument("--lod-normals", default=None, help="override decimate-LOD normal mode: clear | keep")
    ap.add_argument("--uv-smooth", default=None, help="override the subdivided LOD's uvSmooth")
    args = ap.parse_args(argv)
    cast = json.load(open(args.cast))
    if args.out_dir:
        cast["outputDir"] = os.path.relpath(os.path.abspath(args.out_dir), ROOT)
    for spec in cast["defaults"]["lods"]:
        if args.lod_normals:
            spec["normals"] = args.lod_normals
        if args.uv_smooth and spec.get("method") == "subdivide":
            spec["uvSmooth"] = args.uv_smooth
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
