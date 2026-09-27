"""
Tier-2 timpani: four pedal timpani (Dresden-style) in an arc around the player.

  tools/blender/run.sh tools/blender/instruments/timpani.py

Layout copied from buildTimpani() in src/assets/instruments/percussion.ts: diameters 0.81/0.74/0.66/0.58 m,
angles 52/18/-18/-52 deg, centre (sin a * 0.72, 0, cos a * 0.72 - 0.05), head height 0.86 - k*0.02.
All drum meshes and the anchor_head_k beating spots live under the node `floor` (identity).
Per drum: hammered-copper kettle, calfskin head with collar, chrome counter hoop, 8 tension rods with
T-handles, suspension ring + struts, black three-leg base with casters and the tuning pedal.
"""
from __future__ import annotations

import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common as C  # noqa: E402
from common import Geo  # noqa: E402

CONTRACT = json.load(open(os.path.join(HERE, "anchor_contract.json")))
Y_UP = (0, 1, 0)
PREVIEW_VIEWS = {
    "timpani": [("main", dict(env=1.8, dir=(0.25, 0.75, -1.0), up=Y_UP)), ("player", dict(dir=(0.0, 1.2, -0.25), up=Y_UP)),
                ("side", dict(dir=(1, 0.25, 0.4), up=Y_UP)),
                ("drum", dict(dir=(0.5, 0.6, -1.0), up=Y_UP, focus=((0.05, 0.0, -0.1), (0.8, 0.9, 0.7))))],
}

DIAM = [0.81, 0.74, 0.66, 0.58]
ANGLES = [52, 18, -18, -52]


def calfskin_tex(res=256):
    H = W = res
    n1 = C.fbm(H, W, 5, 5, 4, seed=91)
    n2 = C.fbm(H, W, 16, 16, 2, seed=92)
    base = np.array([0.90, 0.85, 0.72])
    dark = np.array([0.76, 0.67, 0.50])
    rgb = C.lerp_color(base, dark, np.clip((n1 - 0.4) * 1.6, 0, 1) * 0.6 + (n2 - 0.5) * 0.1)
    # slightly darker rim band (the collar area near the hoop)
    y, x = np.mgrid[0:H, 0:W]
    d = np.hypot(x - W / 2 + 0.5, y - H / 2 + 0.5) / (W / 2)
    rgb = C.lerp_color(rgb, dark * 0.9, C.smoothstep(0.86, 0.98, d) * 0.5)
    return rgb


def copper_tex(res=256):
    """Hammered copper: dimpled brightness variation (tileable)."""
    H = W = res
    n1 = C.fbm(H, W, 18, 18, 2, seed=95)
    n2 = C.fbm(H, W, 3, 3, 3, seed=96)
    base = np.array([0.86, 0.52, 0.34])
    return base * (0.86 + 0.18 * n1[..., None] + 0.08 * (n2[..., None] - 0.5))


def build_drum(k, parts):
    Cu, Hd, Cr, Bk = parts
    dm = DIAM[k]
    r = dm / 2
    a = math.radians(ANGLES[k])
    cx = math.sin(a) * 0.72
    cz = math.cos(a) * 0.72 - 0.05
    h = 0.86 - k * 0.02
    c = np.array([cx, 0.0, cz])
    to_player = C.norm(np.array([-cx, 0.0, -cz]))
    side = np.cross(Y_UP, to_player)
    depth = r * 0.9
    prof = []
    for th in np.linspace(0.0, math.pi / 2, 14):
        rr = r * 0.985 * math.sin(th) ** 0.75
        prof.append((rr, h - 0.022 - depth * math.cos(th) ** 1.15))
    prof[0] = (r * 0.06, prof[0][1])
    prof = [(0.0, prof[0][1] - 0.002)] + prof
    prof += [(r * 1.0, h - 0.017), (r * 1.003, h - 0.012)]
    bowl = C.lathe(prof, 44)
    bowl.translate(c)
    bowl.uv = np.stack([(bowl.v[:, 0] + bowl.v[:, 2]) * 2.2, bowl.v[:, 1] * 2.2], axis=1)
    Cu.append(bowl)
    # ---- head (slightly domed) + collar over the bowl edge ----
    head_prof = [(0.0, h + 0.0035), (r * 0.5, h + 0.003), (r * 0.9, h + 0.0015), (r * 1.0, h - 0.002), (r * 1.012, h - 0.012),
                 (r * 1.012, h - 0.02)]
    head = C.lathe(head_prof, 44)
    head.flip()  # profile runs centre -> rim: default winding faces down
    head.translate(c)
    head.uv = np.stack([(head.v[:, 0] - cx) / (2 * r * 1.02) + 0.5, (head.v[:, 2] - cz) / (2 * r * 1.02) + 0.5], axis=1)
    Hd.append(head)
    # ---- chrome counter hoop ----
    ro = r * 1.012
    hoop = C.lathe([(ro, h - 0.024), (ro + 0.012, h - 0.024), (ro + 0.014, h - 0.02), (ro + 0.014, h + 0.0005),
                    (ro + 0.011, h + 0.004), (ro + 0.001, h + 0.004), (ro, h + 0.001)], 48)
    hoop.translate(c)
    Cr.append(hoop)
    # suspension ring (holds the bowl) with three struts down to the base
    yr = h - 0.30 * (r / 0.4)
    cth = min(max((h - 0.022 - yr) / depth, 0.0), 1.0) ** (1 / 1.15)
    rr_ring = r * 0.985 * math.sin(math.acos(cth)) ** 0.75 + 0.012
    ring = C.lathe([(rr_ring - 0.004, yr - 0.012), (rr_ring + 0.008, yr - 0.012), (rr_ring + 0.008, yr + 0.012), (rr_ring - 0.004, yr + 0.012)], 40)
    ring.translate(c)
    Bk.append(ring)
    # ---- tension rods: lug on the hoop, rod down the bowl, T-handle on top ----
    n_rods = 8
    for i in range(n_rods):
        ang = (i + 0.5) / n_rods * 2 * math.pi
        dvec = np.array([math.cos(ang), 0.0, math.sin(ang)])
        top = c + dvec * (ro + 0.03) + np.array([0, h + 0.012, 0])
        lug = c + dvec * (ro + 0.03) + np.array([0, h - 0.03, 0])
        Cr.append(C.box(c + dvec * (ro + 0.022) + np.array([0, h - 0.012, 0]), (0.03, 0.018, 0.03), sharp=30))
        low = c + dvec * (rr_ring + 0.018) + np.array([0, yr + 0.01, 0])
        Cr.append(C.cylinder(lug, low, 0.0042, sides=6, caps=False))
        Cr.append(C.cylinder(lug + np.array([0, 0.028, 0]), top, 0.0045, sides=6))
        tang = np.cross(Y_UP, dvec)
        Cr.append(C.cylinder(top - tang * 0.028, top + tang * 0.028, 0.004, sides=6))
        Cr.append(C.box(low, (0.018, 0.02, 0.018), sharp=30))
    # ---- base: three legs with casters, central column, pedal ----
    y_base = 0.07
    hub = c + np.array([0, y_base + 0.02, 0])
    Bk.append(C.cylinder(c + np.array([0, h - 0.022 - depth - 0.01, 0]), hub + np.array([0, 0.02, 0]), 0.022, sides=10))
    for i in range(3):
        ang = math.atan2(to_player[2], to_player[0]) + math.pi + (i - 1) * 2.1
        dvec = np.array([math.cos(ang), 0, math.sin(ang)])
        foot = c + dvec * r * 0.82 + np.array([0, 0.054, 0])
        Bk.append(C.cylinder(hub, foot, 0.016, 0.013, sides=8))
        # strut from the foot up to the suspension ring
        Bk.append(C.cylinder(foot + np.array([0, 0.01, 0]), c + dvec * (rr_ring + 0.004) + np.array([0, yr - 0.01, 0]), 0.011, sides=8))
        # caster: fork + wheel
        Cr.append(C.cylinder(foot, foot - np.array([0, 0.018, 0]), 0.009, sides=8))
        wheel_c = foot - np.array([0, 0.027, 0])
        tang = np.cross(Y_UP, dvec)
        Bk.append(C.cylinder(wheel_c - tang * 0.011, wheel_c + tang * 0.011, 0.027, sides=12))
    # pedal toward the player: hinged plate on a short arm
    p_base = c + to_player * (r * 0.55) + np.array([0, 0.05, 0])
    p_tip = c + to_player * (r * 0.95) + np.array([0, 0.09, 0])
    Bk.append(C.cylinder(hub, p_base, 0.014, sides=8))
    pd = C.box((0, 0, 0), (0.12, 0.018, 0.24), sharp=30)
    fwd = C.norm(p_tip - p_base)
    upv = C.norm(np.cross(fwd, side))
    if upv[1] < 0:
        upv = -upv
    pd.apply(C.basis(C.norm(np.cross(upv, fwd)), upv, fwd))
    pd.translate((p_base + p_tip) / 2 + np.array([0, 0.01, 0]))
    Bk.append(pd)
    # ribbed pedal pad (chrome edge strip)
    Cr.append(C.box((p_base + p_tip) / 2 + upv * 0.012 + np.array([0, 0.01, 0]), (0.11, 0.004, 0.02), sharp=30))
    # fine tuner handle near the player (Dresden style)
    ft = c + to_player * (ro + 0.035) + side * 0.12 + np.array([0, h - 0.06, 0])
    Cr.append(C.cylinder(ft, ft + to_player * 0.06 + np.array([0, -0.02, 0]), 0.005, sides=8))
    Bk.append(C.ellipsoid(ft + to_player * 0.07 + np.array([0, -0.024, 0]), (0.016, 0.016, 0.016), 10, 6))


def build_timpani():
    C.reset_scene()
    S = C.Scene("timpani")
    S.node("floor")
    S.mat("copper", tex=C.make_image("timpani_copper", copper_tex()), metallic=1.0, roughness=0.28)
    S.mat("calfskin", tex=C.make_image("timpani_calfskin", calfskin_tex()), roughness=0.75)
    S.mat("chrome", color=(0.9, 0.9, 0.92), metallic=1.0, roughness=0.15)
    S.mat("black", color=(0.035, 0.035, 0.038), roughness=0.45)
    Cu, Hd, Cr, Bk = [], [], [], []
    for k in range(4):
        build_drum(k, (Cu, Hd, Cr, Bk))
    S.add(Geo.merge(Cu), "copper", node="floor")
    S.add(Geo.merge(Hd), "calfskin", node="floor")
    S.add(Geo.merge(Cr), "chrome", node="floor")
    S.add(Geo.merge(Bk), "black", node="floor")
    for name, pos in CONTRACT["timpani"]["root"]["anchors"].items():
        S.anchor(name, pos, "floor")
    C.log("timpani", "triangles", S.tri_count())
    S.build()
    C.export_glb(os.path.join(C.OUT_DIR, "timpani.glb"))


def main():
    build_timpani()


if __name__ == "__main__":
    main()
