"""
Forearm twist-bone test on an exported character GLB (the deliverable, re-imported from disk).

  tools/blender/run.sh tools/blender/test_twist.py -- [--glb public/assets/characters/<id>.glb]
                                                      [--lod LOD0] [--side L] [--out vendor/previews/twist_<id>.png]

1. Twist only: rotate "Bip01 <side> ForeTwist" 90 deg about the forearm axis (elbow -> wrist) and
   measure, per vertex of the forearm skin, the rotation angle about that axis as a function of
   t (0 = elbow, 1 = wrist). Pass: the elbow stays put (t < 0.1: < 0.5 mm) and, on the pure forearm
   skin (no hand weight), the angle rises monotonically towards the wrist and the twist rate
   between neighbouring vertices stays below 20 deg/cm.
2. Hand pronation 90 deg: rest | without twist (= the old rig: twist bone at rest) | twist bone
   following the hand roll. Pass: the twist version has a lower max twist rate (deg/cm along the
   axis between neighbouring vertices: no candy-wrapper shear band) and keeps more of the wrist
   cross-section radius.
   Renders both states (front + side view) next to the rest pose.
Prints a JSON summary line "TWIST_RESULT {...}" and exits 1 if the numeric test fails.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import recolor_attire as ra  # noqa: E402
import preview_characters as pc  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))


def bone_world(arm, name):
    return arm.matrix_world @ arm.data.bones[name].head_local


def set_rotation_about_axis(arm, bone, axis, pivot, angle):
    """Pose `bone` so that its armature-space matrix = rotation(axis, angle) about `pivot` @ rest."""
    pb = arm.pose.bones[bone]
    inv = arm.matrix_world.inverted()
    a = (inv.to_3x3() @ axis).normalized()
    p = inv @ pivot
    R = Matrix.Translation(p) @ Matrix.Rotation(angle, 4, a) @ Matrix.Translation(-p)
    pb.matrix = R @ arm.data.bones[bone].matrix_local
    bpy.context.view_layer.update()


def reset_pose(arm):
    for pb in arm.pose.bones:
        pb.matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()


def deformed(obj):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    me = ev.to_mesh()
    try:
        co = np.empty(len(me.vertices) * 3, np.float64)
        me.vertices.foreach_get("co", co)
    finally:
        ev.to_mesh_clear()
    co = co.reshape(-1, 3)
    M = np.array(obj.matrix_world)
    return co @ M[:3, :3].T + M[:3, 3]


def palm_normal(arm, side):
    P = lambda n: bone_world(arm, f"Bip01 {side} {n}")
    palm = (P("Finger1") - P("Finger4")).cross(P("Finger2") - P("Hand")).normalized()
    curl = (P("Finger22") - P("Finger21")).normalized() - (P("Finger21") - P("Finger2")).normalized()
    return -palm if palm.dot(curl) < 0 else palm


def signed_angle(u, v, axis):
    """Signed angle (deg) from u to v about axis; u, v: (N,3) already perpendicular to axis."""
    c = np.einsum("ij,ij->i", u, v)
    s = np.einsum("ij,ij->i", np.cross(u, v), np.broadcast_to(axis, u.shape))
    return np.degrees(np.arctan2(s, c))


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--glb", default=os.path.join(ROOT, "public/assets/characters/rocketbox_business_male_01.glb"))
    ap.add_argument("--lod", default="LOD0")
    ap.add_argument("--side", default="L")
    ap.add_argument("--angle", type=float, default=90.0)
    ap.add_argument("--out", default=None)
    args = ap.parse_args(argv)
    cid = os.path.splitext(os.path.basename(args.glb))[0]
    out = args.out or os.path.join(ROOT, "vendor/previews", f"twist_{cid}.png")
    tmp = os.path.join(os.path.dirname(out), "_tmp")
    os.makedirs(tmp, exist_ok=True)

    sc, cam = pc.setup_scene()
    root, arm, meshes, _ = pc.import_glb(args.glb)
    pc.show_only(meshes, [args.lod])
    obj = meshes[args.lod]
    side = args.side
    tw = f"Bip01 {side} ForeTwist"
    if tw not in arm.data.bones:
        raise SystemExit(f"{tw} missing in {args.glb}")
    bn = arm.data.bones
    assert bn[f"Bip01 {side} Hand"].parent.name == f"Bip01 {side} Forearm", "hand is not a child of the forearm"
    assert bn[tw].parent.name == f"Bip01 {side} Forearm", "twist bone is not a child of the forearm"

    elbow = bone_world(arm, f"Bip01 {side} Forearm")
    wrist = bone_world(arm, f"Bip01 {side} Hand")
    d = wrist - elbow
    axis = d.normalized()
    ax = np.array(axis)
    L = d.length
    # pronation sign: the palm turns backwards (character faces -Y in Blender -> back = +Y)
    n = palm_normal(arm, side)
    sign = 1.0 if (Matrix.Rotation(math.radians(args.angle), 3, axis) @ n).y > (Matrix.Rotation(-math.radians(args.angle), 3, axis) @ n).y else -1.0
    ang = sign * math.radians(args.angle)

    # forearm skin = vertices weighted to the forearm or its twist bone
    gi = {g.index: g.name for g in obj.vertex_groups}
    fa_names = {f"Bip01 {side} Forearm", tw}
    hand_names = {n for n in gi.values() if n.startswith(f"Bip01 {side} Hand") or n.startswith(f"Bip01 {side} Finger")}
    sel, wtw, whand = [], [], []
    for v in obj.data.vertices:
        w = {gi[g.group]: g.weight for g in v.groups if g.weight > 0}
        if fa_names & set(w):
            sel.append(v.index)
            wtw.append(w.get(tw, 0.0))
            whand.append(sum(x for k, x in w.items() if k in hand_names))
    sel = np.array(sel)
    whand = np.array(whand)
    rest = deformed(obj)
    rel = rest[sel] - np.array(elbow)
    t = rel @ ax / L
    idx = {int(v): i for i, v in enumerate(sel)}
    edges = [(idx[a], idx[b]) for a, b in (e.vertices for e in obj.data.edges) if a in idx and b in idx]

    def perp(x):
        r = x - np.array(elbow)
        return r - np.outer(r @ ax, ax)

    def max_jump(angle, mask=None):
        """max twist rate over mesh edges, deg per cm along the forearm axis (edges shorter than
        5 mm along the axis count as 5 mm) -- a candy-wrapper band shows up as a high rate."""
        j = [abs(angle[a] - angle[b]) / max(abs(t[a] - t[b]) * L * 100.0, 0.5)
             for a, b in edges if mask is None or (mask[a] and mask[b])]
        return round(float(max(j)), 1) if j else 0.0

    bins = [(-1.0, 0.1), (0.1, 0.25), (0.25, 0.4), (0.4, 0.55), (0.55, 0.7), (0.7, 0.85), (0.85, 1.0), (1.0, 2.0)]

    def bin_table(angle, disp, mask):
        out = []
        for lo, hi in bins:
            m = (t >= lo) & (t < hi) & mask
            if m.any():
                out.append({"t": [lo, hi], "n": int(m.sum()), "meanAngle": round(float(angle[m].mean()), 1),
                            "maxDisp_mm": round(float(disp[m].max() * 1000), 2)})
        return out

    # --- 1. twist bone alone: pure forearm skin (no hand weight) must follow smoothstep(t) ----
    set_rotation_about_axis(arm, tw, axis, bone_world(arm, tw), ang)
    posed = deformed(obj)
    reset_pose(arm)
    angle = signed_angle(perp(rest[sel]), perp(posed[sel]), ax) * sign
    disp = np.linalg.norm(posed[sel] - rest[sel], axis=1)
    pure = whand <= 1e-4
    table = bin_table(angle, disp, pure)
    elbow_m = t < 0.1
    elbow_disp = float(disp[elbow_m].max() * 1000) if elbow_m.any() else 0.0
    means = [r["meanAngle"] for r in table]
    monotonic = all(b >= a - 1.0 for a, b in zip(means, means[1:]))
    twist_only = {"elbowMaxDisp_mm": round(elbow_disp, 3), "monotonic": monotonic,
                  "maxTwistRate_degPerCm": max_jump(angle, pure), "bins": table}

    # --- 2. hand pronation: no twist (= old rig) vs twist bone following the hand roll ---------
    wrist_m = (t > 0.8) & (t <= 1.0)

    def radius(pos):
        return float(np.linalg.norm(perp(pos[sel][wrist_m]), axis=1).mean())

    states = {}
    panels = []
    W, H = 520, 520
    center = elbow.lerp(wrist, 0.75)
    r0 = None
    for label, twist in (("rest", None), ("hand90_noTwist", 0.0), ("hand90_twist90", 1.0)):
        reset_pose(arm)
        if twist is not None:
            set_rotation_about_axis(arm, f"Bip01 {side} Hand", axis, wrist, ang)
            if twist:
                set_rotation_about_axis(arm, tw, axis, bone_world(arm, tw), ang * twist)
        pos = deformed(obj)
        a = signed_angle(perp(rest[sel]), perp(pos[sel]), ax) * sign
        r = radius(pos)
        r0 = r0 or r
        states[label] = {"wristRadius_mm": round(r * 1000, 2), "wristRadiusKept": round(r / r0, 3),
                         "maxTwistRate_degPerCm": max_jump(a)}
        if twist is not None:
            states[label]["bins"] = [{"t": b["t"], "meanAngle": b["meanAngle"]}
                                     for b in bin_table(a, np.zeros_like(a), np.ones_like(pure))]
        row = []
        for vname, vdir in (("front", Vector((0.25, -1.0, 0.1))), ("side", Vector((1.0, -0.15, 0.25)) if side == "L" else Vector((-1.0, -0.15, 0.25)))):
            cam.data.type = "PERSP"
            cam.data.lens = 85
            loc = center + vdir.normalized() * 0.75
            cam.location = loc
            cam.rotation_euler = (center - loc).to_track_quat("-Z", "Y").to_euler()
            row.append(pc.render_to(os.path.join(tmp, f"twist_{label}_{vname}.png"), W, H))
        panels.append(np.concatenate(row, axis=0))
    reset_pose(arm)
    sheet = np.concatenate(panels, axis=1)
    sheet[..., 3] = 1.0
    ra.save_png(sheet, out)
    nt, wt = states["hand90_noTwist"], states["hand90_twist90"]
    ok = (elbow_disp < 0.5 and monotonic and twist_only["maxTwistRate_degPerCm"] < 20.0
          and wt["maxTwistRate_degPerCm"] < nt["maxTwistRate_degPerCm"] and wt["wristRadius_mm"] > nt["wristRadius_mm"])
    res = {"glb": os.path.relpath(args.glb, ROOT), "lod": args.lod, "side": side, "twistBone": tw,
           "angle_deg": args.angle, "forearmVertices": int(len(sel)), "twistWeighted": int(sum(1 for w in wtw if w > 0)),
           "twistOnly": twist_only, "pronation": states, "pass": ok, "png": os.path.relpath(out, ROOT)}
    print("TWIST_RESULT " + json.dumps(res), flush=True)
    print(f"TWIST_SUMMARY {tw}: elbow moved {twist_only['elbowMaxDisp_mm']} mm, forearm skin angle monotonic "
          f"{monotonic} ({' '.join(str(r['meanAngle']) for r in twist_only['bins'])} deg by t-bin); hand pronation "
          f"{args.angle:g} deg: max twist rate {nt['maxTwistRate_degPerCm']} -> {wt['maxTwistRate_degPerCm']} deg/cm, "
          f"wrist radius kept {nt['wristRadiusKept']} -> {wt['wristRadiusKept']}; pass {ok}", flush=True)
    print("wrote", out, flush=True)
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
