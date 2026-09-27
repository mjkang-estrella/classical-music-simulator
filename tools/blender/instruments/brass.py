"""
Tier-2 brass: trumpet, horn, trombone, tuba (polished lacquered brass).

  tools/blender/run.sh tools/blender/instruments/brass.py [trumpet horn trombone tuba]

Frames follow src/assets/instruments/winds.ts: origin at the mouthpiece rim, +Y up, +X player's
left. Anchors are copied from anchor_contract.json. The trombone's outer slide is a child node
`slide` (rest = closed position) that carries anchor_grip_R. Bells use a double-sided material.
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
    "trumpet": [("main", dict(env=1.8, dir=(1.0, 0.55, 0.35), up=Y_UP)), ("side", dict(dir=(1, 0.02, 0), up=Y_UP, ortho=True)),
                ("bell", dict(dir=(0.35, 0.25, 1.0), up=Y_UP)), ("top", dict(dir=(0.001, 1, 0), up=(0, 0, 1), ortho=True))],
    "horn": [("main", dict(env=1.8, dir=(0.45, 0.35, 1.0), up=Y_UP)), ("back", dict(dir=(-0.6, 0.15, -1.0), up=Y_UP)),
             ("side", dict(dir=(1, 0.1, 0), up=Y_UP)), ("front", dict(dir=(0, 0.05, 1), up=Y_UP, ortho=True))],
    "trombone": [("main", dict(env=1.8, dir=(1.0, 0.45, 0.25), up=Y_UP)), ("side", dict(dir=(1, 0.02, 0), up=Y_UP, ortho=True)),
                 ("bell", dict(dir=(0.4, 0.2, 1.0), up=Y_UP)), ("top", dict(dir=(0.001, 1, 0), up=(0, 0, 1), ortho=True))],
    "tuba": [("main", dict(env=1.8, dir=(0.75, 0.35, 1.0), up=Y_UP)), ("side", dict(dir=(1, 0.05, 0), up=Y_UP)),
             ("back", dict(dir=(-0.8, 0.3, -0.6), up=Y_UP)), ("front", dict(dir=(0, 0.05, 1), up=Y_UP, ortho=True))],
}

BRASS = dict(color=(0.93, 0.74, 0.40), metallic=1.0, roughness=0.2, double_sided=True)
SILVER = dict(color=(0.92, 0.92, 0.93), metallic=1.0, roughness=0.15)
PEARL = dict(color=(0.93, 0.91, 0.86), roughness=0.25, coat=0.5)


# ---------------------------------------------------------------------------
# helpers (glTF frame)
# ---------------------------------------------------------------------------

def path(pts, n_per=6):
    return C.catmull(np.asarray(pts, float), n_per)


def pipe(pts, r, sides=12, n_per=6, caps=False, r_end=None):
    P = path(pts, n_per)
    if r_end is None:
        rr = r
    else:
        t = np.linspace(0, 1, len(P))
        rr = r + (r_end - r) * t
    return C.tube(P, rr, sides, cap_start=caps, cap_end=caps)


def arc(center, u, v, radius, r_tube, a0, a1, n=24, sides=10):
    a = np.linspace(a0, a1, n)
    u, v = C.norm(u), C.norm(v)
    P = np.asarray(center, float) + radius * (np.cos(a)[:, None] * u + np.sin(a)[:, None] * v)
    return C.tube(P, r_tube, sides)


def u_bend(p_a, p_b, out_dir, r_tube, depth=None, n=10, sides=10):
    """Half-circle crook from p_a to p_b bulging along out_dir."""
    p_a, p_b = np.asarray(p_a, float), np.asarray(p_b, float)
    c = (p_a + p_b) / 2
    R = np.linalg.norm(p_b - p_a) / 2
    u = (p_a - c) / R
    v = C.norm(out_dir)
    v = C.norm(v - np.dot(v, u) * u)
    a = np.linspace(0, math.pi, n)
    d = R if depth is None else depth
    P = c + R * np.cos(a)[:, None] * u + d * np.sin(a)[:, None] * v
    return C.tube(P, r_tube, sides)


def slide_u(base_a, base_b, direction, length, r_tube, sides=10):
    """Tuning slide: two parallel legs from base_a/base_b along `direction`, closed by a crook."""
    d = C.norm(direction)
    a, b = np.asarray(base_a, float), np.asarray(base_b, float)
    ea, eb = a + d * length, b + d * length
    parts = [C.tube([a, ea], r_tube, sides), C.tube([b, eb], r_tube, sides), u_bend(ea, eb, d, r_tube, sides=sides)]
    # ferrules at the slide joints
    for p in (a + d * length * 0.15, b + d * length * 0.15):
        parts.append(C.tube([p - d * 0.003, p + d * 0.003], r_tube * 1.25, sides, True, True))
    return Geo.merge(parts)


def bell(throat, axis, r_t, r_m, length, gamma=0.72, segs=40, n=22, rim=None):
    """Bessel-horn bell flaring from `throat` along `axis`, with a rolled rim (double-sided material)."""
    x0 = length / ((r_m / r_t) ** (1 / gamma) - 1)
    B = r_m * x0 ** gamma
    s = 1 - (1 - np.linspace(0, 1, n)) ** 1.7
    ds = length * s
    r = B * (length - ds + x0) ** (-gamma)
    rim = rim if rim is not None else max(0.0018, r_m * 0.03)
    prof = [(ri, di) for ri, di in zip(r, ds)]
    for ang in np.linspace(0.3, math.pi * 1.1, 6):
        prof.append((r_m + rim * math.sin(ang), length - rim + rim * math.cos(ang)))
    prof.append((r_m - rim * 0.4, length - rim * 2.5))
    g = C.lathe(prof, segs)
    g.apply(C.rot_from_to((0, 1, 0), axis))
    g.translate(throat)
    return g


def mouthpiece(pos, axis, rim_r, shank_r, length, cup=0.6):
    """Lathe mouthpiece: cup + rim at `pos`, shank running along `axis`."""
    L = length
    prof = [(rim_r * 0.12, L * 0.10 * cup), (rim_r * 0.5, L * 0.075 * cup), (rim_r * 0.72, L * 0.025),
            (rim_r * 0.82, 0.0), (rim_r, L * 0.012), (rim_r * 1.02, L * 0.045), (rim_r * 0.9, L * 0.09),
            (rim_r * 0.62, L * 0.2), (shank_r * 1.25, L * 0.4), (shank_r * 1.12, L * 0.8), (shank_r, L)]
    g = C.lathe(prof, 20)
    g.apply(C.rot_from_to((0, 1, 0), axis))
    g.translate(pos)
    return g


def piston_valve(center_xz, y_bot, y_top, r, button_y, mats, parts, axis=(0, 1, 0)):
    """Vertical piston valve: casing, caps, stem, finger button with pearl inlay."""
    x, z = center_xz
    brass, silver, pearl = parts
    brass.append(C.cylinder((x, y_bot, z), (x, y_top, z), r, sides=18, caps=False))
    # bottom cap (knurled look via 3 rings)
    brass.append(C.lathe([(0.0, y_bot - r * 0.8), (r * 0.7, y_bot - r * 0.78), (r * 1.08, y_bot - r * 0.6),
                          (r * 1.1, y_bot - r * 0.15), (r * 1.02, y_bot + r * 0.05)], 18).translate(x, 0, z))
    # ribs / ferrules on the casing
    for yy in (y_bot + (y_top - y_bot) * 0.15, y_top - (y_top - y_bot) * 0.12):
        brass.append(C.cylinder((x, yy - r * 0.18, z), (x, yy + r * 0.18, z), r * 1.07, sides=18))
    # top cap
    brass.append(C.lathe([(r * 1.02, y_top - 0.001), (r * 1.12, y_top), (r * 1.12, y_top + r * 0.45),
                          (r * 0.6, y_top + r * 0.6), (r * 0.3, y_top + r * 0.62)], 18).translate(x, 0, z))
    # stem + button
    silver.append(C.cylinder((x, y_top + r * 0.5, z), (x, button_y - r * 0.2, z), r * 0.24, sides=8))
    silver.append(C.lathe([(r * 0.25, button_y - r * 0.35), (r * 0.8, button_y - r * 0.3), (r * 0.9, button_y - r * 0.1),
                           (r * 0.9, button_y + r * 0.15), (r * 0.8, button_y + r * 0.2)], 16).translate(x, 0, z))
    pearl.append(C.lathe([(r * 0.78, button_y + r * 0.17), (r * 0.6, button_y + r * 0.26), (0.0, button_y + r * 0.28)], 16).translate(x, 0, z))


def new_scene(kind):
    C.reset_scene()
    S = C.Scene(kind)
    S.mat("brass", **BRASS)
    S.mat("silver", **SILVER)
    S.mat("pearl", **PEARL)
    return S


def finish(S, kind):
    for name, pos in CONTRACT[kind]["root"]["anchors"].items():
        S.anchor(name, pos, "slide" if (kind == "trombone" and name in CONTRACT[kind].get("slide", {}).get("anchors", {})) else None)
    C.log(kind, "triangles", S.tri_count())
    S.build()
    C.export_glb(os.path.join(C.OUT_DIR, f"{kind}.glb"))


# ---------------------------------------------------------------------------
# trumpet
# ---------------------------------------------------------------------------

def build_trumpet():
    S = new_scene("trumpet")
    B, Sv, P = [], [], []
    S.add(mouthpiece((0, 0, 0), (0, 0, 1), 0.0132, 0.0046, 0.088), "silver")
    # receiver + leadpipe (player's right, -x) descending to the main tuning slide at the front
    B.append(C.cylinder((0, 0, 0.066), (0, 0, 0.09), 0.0062, sides=14))
    lead = [(0, 0, 0.085), (-0.004, -0.001, 0.125), (-0.015, -0.004, 0.17), (-0.019, -0.006, 0.22),
            (-0.019, -0.009, 0.29), (-0.017, -0.012, 0.345)]
    B.append(pipe(lead, 0.0047, 14, r_end=0.0062))
    # main tuning slide crook (front, below the bell) and return into the 3rd valve
    B.append(pipe([(-0.017, -0.012, 0.345), (-0.016, -0.016, 0.372), (-0.013, -0.032, 0.384), (-0.010, -0.046, 0.372),
                   (-0.008, -0.050, 0.345)], 0.0063, 14))
    B.append(pipe([(-0.008, -0.050, 0.345), (-0.006, -0.050, 0.30), (-0.004, -0.042, 0.268), (-0.002, -0.032, 0.252)], 0.0063, 14))
    # water key on the crook
    B.append(C.box((-0.013, -0.041, 0.392), (0.004, 0.012, 0.003), sharp=30))
    # valves
    zs = [0.19, 0.216, 0.242]
    for z in zs:
        piston_valve((0.0, z), -0.041, 0.033, 0.0088, 0.0625, None, (B, Sv, P))
    # valve slides (player's left, +x): 1st points back, 3rd forward with a finger ring
    B.append(C.tube([(0.006, -0.004, 0.19), (0.024, -0.004, 0.188)], 0.0052, 10))
    B.append(C.tube([(0.006, -0.018, 0.194), (0.024, -0.018, 0.192)], 0.0052, 10))
    B.append(slide_u((0.024, -0.004, 0.188), (0.024, -0.018, 0.192), (0, 0, -1), 0.05, 0.0052))
    B.append(C.tube([(0.006, -0.010, 0.216), (0.02, -0.024, 0.216), (0.02, -0.030, 0.214)], 0.005, 10))
    B.append(C.tube([(0.006, -0.012, 0.242), (0.024, -0.012, 0.246)], 0.0052, 10))
    B.append(C.tube([(0.006, -0.026, 0.238), (0.024, -0.026, 0.242)], 0.0052, 10))
    B.append(slide_u((0.024, -0.012, 0.246), (0.024, -0.026, 0.242), (0, 0, 1), 0.075, 0.0052))
    ring = arc((0.034, -0.019, 0.29), (0, 1, 0), (0, 0, 1), 0.008, 0.0012, 0, 2 * math.pi, 16, 6)
    B.append(ring)
    # bell branch: from the bell throat back along +x past the valves, rear bow, into the 1st valve
    bell_pts = [(0.006, -0.02, 0.325), (0.012, -0.016, 0.30), (0.021, -0.008, 0.26), (0.022, 0.006, 0.21),
                (0.021, 0.008, 0.15), (0.018, 0.006, 0.118)]
    B.append(pipe(bell_pts, 0.0075, 14, r_end=0.0058))
    B.append(pipe([(0.018, 0.006, 0.118), (0.016, 0.0, 0.098), (0.013, -0.018, 0.090), (0.010, -0.034, 0.098),
                   (0.008, -0.036, 0.12), (0.004, -0.034, 0.16), (0.001, -0.030, 0.178)], 0.0058, 14))
    B.append(bell((0.006, -0.02, 0.32), (0, 0, 1), 0.0078, 0.0615, 0.202, gamma=0.8, segs=40))
    # braces + finger hook
    B.append(C.cylinder((-0.018, -0.008, 0.3), (0.016, -0.014, 0.3), 0.0016, sides=6))
    B.append(C.cylinder((-0.018, -0.004, 0.14), (0.02, 0.006, 0.14), 0.0016, sides=6))
    B.append(pipe([(-0.019, -0.002, 0.232), (-0.019, 0.01, 0.232), (-0.016, 0.016, 0.236), (-0.012, 0.014, 0.238)], 0.0016, 6))
    S.add(Geo.merge(B), "brass")
    S.add(Geo.merge(Sv), "silver")
    S.add(Geo.merge(P), "pearl")
    finish(S, "trumpet")


# ---------------------------------------------------------------------------
# horn (double horn, coil in the X-Y plane, bell back-right)
# ---------------------------------------------------------------------------

def torus_wrap(center, radius, r_tube, z, a0=0.0, a1=2 * math.pi, n=56, sides=10):
    c = np.array([center[0], center[1], z])
    return arc(c, (1, 0, 0), (0, 1, 0), radius, r_tube, a0, a1, n, sides)


def build_horn():
    S = new_scene("horn")
    Cc = np.array([-0.07, -0.18, 0.2])
    B, Sv, P = [], [], []
    S.add(mouthpiece((0, 0, 0), (0, 0, 1), 0.0095, 0.0038, 0.07, cup=1.2), "silver")
    B.append(C.cylinder((0, 0, 0.056), (0, 0, 0.075), 0.0056, sides=14))
    # leadpipe spiralling down into the outer wrap
    B.append(pipe([(0, 0, 0.07), (0.004, -0.014, 0.118), (0.022, -0.036, 0.162), (0.042, -0.056, 0.19),
                   (Cc[0] + 0.098, Cc[1] + 0.1, Cc[2] - 0.012)], 0.0042, 12, r_end=0.0056))
    # three wraps of the main coil (tubing widens toward the bell)
    for i, (rad, rt) in enumerate(((0.14, 0.0068), (0.123, 0.0062), (0.106, 0.0058))):
        B.append(torus_wrap(Cc, rad, rt, Cc[2] + (i - 1) * 0.0145))
    # inner F-side wrap (smaller) and a crossing wrap
    B.append(torus_wrap(Cc, 0.088, 0.0055, Cc[2] + 0.005, 0.4, 5.6, 44))
    B.append(torus_wrap(Cc + np.array([0.01, 0.0, 0]), 0.132, 0.0058, Cc[2] - 0.028, 2.2, 5.2, 34))
    # rotary valve cluster on the right of the coil (player's left hand)
    vc = [Cc + np.array([0.112 - 0.004 * i, 0.034 - 0.030 * i, 0.002]) for i in range(4)]
    for i, c in enumerate(vc):
        B.append(C.cylinder(c + [0, 0, -0.022], c + [0, 0, 0.022], 0.0128, sides=18, caps=False))
        for zz, rr in ((-0.024, 0.0136), (0.022, 0.0136)):
            B.append(C.lathe([(0.0, 0.0), (rr * 0.8, 0.0), (rr, 0.0015), (rr, 0.0035), (rr * 0.7, 0.0045), (0.0, 0.0048)], 18)
                     .apply(C.rot_axis((1, 0, 0), math.pi / 2 if zz > 0 else -math.pi / 2)).translate(c + [0, 0, zz]))
        # rotor stop arm + linkage (silver)
        Sv.append(C.box(c + [0.009, 0.0, -0.028], (0.014, 0.003, 0.002), sharp=30))
        Sv.append(C.cylinder(c + [0.015, 0.0, -0.028], c + [0.03, -0.008 + 0.004 * i, -0.05], 0.0011, sides=5))
    # finger levers (spatulas) + thumb lever
    for i in range(3):
        base = np.array([0.03, -0.155 - 0.017 * i, 0.155])
        B.append(C.cylinder(base, base + [0.045, -0.004, -0.012], 0.0014, sides=6))
        B.append(C.ellipsoid(base + [0.05, -0.004, -0.013], (0.0075, 0.0055, 0.0016), 10, 5))
    B.append(C.cylinder((0.03, -0.12, 0.17), (0.07, -0.13, 0.12), 0.0014, sides=6))
    B.append(C.ellipsoid((0.073, -0.131, 0.117), (0.006, 0.006, 0.0016), 10, 5))
    # valve slides protruding up / out
    B.append(slide_u(vc[0] + [0.012, 0.006, 0.0], vc[0] + [0.012, -0.012, 0.0], (1, 0.25, 0), 0.03, 0.005))
    B.append(slide_u(vc[1] + [0.012, 0.004, 0.012], vc[1] + [0.012, -0.012, 0.012], (1, 0.0, 0), 0.036, 0.005))
    B.append(slide_u(vc[2] + [0.012, 0.004, 0.012], vc[2] + [0.012, -0.012, 0.012], (1, -0.2, 0), 0.03, 0.005))
    B.append(slide_u(vc[3] + [0.006, -0.012, 0.0], vc[3] + [-0.01, -0.016, 0.0], (0.2, -1, 0), 0.034, 0.005))
    # main tuning slide on top of the coil
    B.append(slide_u(Cc + [-0.03, 0.135, 0.0], Cc + [0.02, 0.137, 0.0], (0, 1, 0), 0.03, 0.0058))
    # bell tail from the coil to the flare, then the bell
    throat = Cc + np.array([-0.07, -0.1, 0.0])
    axis = C.norm(np.array([-0.42, -0.2, -0.88]))
    B.append(pipe([Cc + [-0.14, -0.02, 0.0], Cc + [-0.135, -0.06, 0.0], Cc + [-0.12, -0.09, 0.0], throat,
                   throat + axis * 0.02], 0.0075, 14, r_end=0.012))
    B.append(bell(throat + axis * 0.02, axis, 0.012, 0.152, 0.28, gamma=0.7, segs=48))
    # braces between wraps and to the bell
    for a in (0.6, 2.2, 3.9):
        p0 = Cc + np.array([math.cos(a) * 0.106, math.sin(a) * 0.106, 0.014])
        p1 = Cc + np.array([math.cos(a) * 0.14, math.sin(a) * 0.14, -0.014])
        B.append(C.cylinder(p0, p1, 0.0018, sides=6))
    S.add(Geo.merge(B), "brass")
    S.add(Geo.merge(Sv), "silver")
    finish(S, "horn")


# ---------------------------------------------------------------------------
# trombone (tenor, slide along +Z, bell on the player's left)
# ---------------------------------------------------------------------------

def build_trombone():
    S = new_scene("trombone")
    S.node("slide")
    low = -0.085
    B, Sv = [], []
    S.add(mouthpiece((0, 0, 0), (0, 0, 1), 0.0128, 0.0055, 0.09, cup=1.0), "silver")
    # inner slide (fixed): long enough to stay engaged when the outer slide moves out
    B.append(C.cylinder((0, 0, 0.082), (0, 0, 0.70), 0.0064, sides=12, caps=False))
    B.append(C.cylinder((0, low, 0.095), (0, low, 0.70), 0.0064, sides=12, caps=False))
    # slide lock + receiver + hand brace (left hand grip)
    B.append(C.cylinder((0, 0, 0.078), (0, 0, 0.1), 0.0085, sides=14))
    B.append(C.cylinder((0, low, 0.09), (0, low, 0.11), 0.0085, sides=14))
    B.append(C.cylinder((0, 0.0, 0.118), (0, low, 0.118), 0.0038, sides=8))
    B.append(pipe([(0, -0.02, 0.118), (0.03, -0.028, 0.121), (0.06, -0.03, 0.122), (0.075, -0.02, 0.12)], 0.0045, 8))
    # bell section: gooseneck from the lower slide tube, back over the shoulder to the tuning slide, forward to the bell
    bx = 0.075
    goose = [(0, low, 0.1), (0.004, low - 0.004, 0.07), (0.02, low - 0.004, 0.02), (0.05, -0.06, -0.05),
             (bx, -0.035, -0.12), (bx, -0.005, -0.2), (bx, 0.02, -0.255)]
    B.append(pipe(goose, 0.0068, 14, r_end=0.0072))
    # tuning slide at the back (crook behind the player's shoulder)
    B.append(C.tube([(bx, 0.02, -0.255), (bx, 0.022, -0.268)], 0.0072, 12))
    B.append(u_bend((bx, 0.022, -0.268), (bx, 0.064, -0.268), (0, 0, -1), 0.0074, depth=0.025, n=12, sides=12))
    B.append(C.tube([(bx, 0.064, -0.268), (bx, 0.063, -0.22)], 0.0074, 12))
    for yy in (0.021, 0.0635):
        B.append(C.cylinder((bx, yy, -0.232), (bx, yy, -0.244), 0.0093, sides=12))
    B.append(C.cylinder((bx, 0.03, -0.255), (bx, 0.056, -0.255), 0.0022, sides=6))
    B.append(pipe([(bx, 0.063, -0.22), (bx, 0.058, -0.1), (bx, 0.048, 0.05), (bx, 0.04, 0.2), (bx, 0.036, 0.285)], 0.0076, 14,
                  r_end=0.0095))
    B.append(bell((bx, 0.035, 0.28), (0, 0, 1), 0.0095, 0.108, 0.34, gamma=0.78, segs=44))
    # bell brace to the slide receiver
    B.append(C.cylinder((0.0, -0.004, 0.235), (bx, 0.035, 0.235), 0.003, sides=8))
    S.add(Geo.merge(B), "brass")
    # ---- outer slide (node `slide`, closed position) ----
    O = []
    O.append(C.cylinder((0, 0, 0.12), (0, 0, 0.715), 0.0078, sides=12, caps=False))
    O.append(C.cylinder((0, low, 0.13), (0, low, 0.715), 0.0078, sides=12, caps=False))
    O.append(u_bend((0, 0, 0.715), (0, low, 0.715), (0, 0, 1), 0.0078, depth=0.03, n=12, sides=12))
    for yy in (0.0, low):
        O.append(C.cylinder((0, yy, 0.12 if yy == 0 else 0.13), (0, yy, 0.135 if yy == 0 else 0.145), 0.0092, sides=12))
    # slide brace (right hand)
    O.append(C.cylinder((0, -0.004, 0.63), (0, low + 0.004, 0.63), 0.0042, sides=8))
    O.append(C.cylinder((0, -0.01, 0.63), (-0.01, -0.02, 0.63), 0.0028, sides=6))
    O.append(C.cylinder((0, -0.075, 0.63), (-0.01, -0.065, 0.63), 0.0028, sides=6))
    O.append(C.cylinder((-0.01, -0.02, 0.63), (-0.01, -0.065, 0.63), 0.0033, sides=8))
    # water key on the slide crook
    O.append(C.box((0.0, low - 0.004, 0.735), (0.004, 0.012, 0.005), sharp=30))
    S.add(Geo.merge(O), "brass", node="slide")
    Bm = [C.lathe([(0.0, 0.0), (0.0085, 0.0), (0.0095, 0.004), (0.0085, 0.008), (0.0, 0.008)], 12)
          .apply(C.rot_axis((1, 0, 0), math.pi / 2)).translate(0, low / 2, 0.748)]
    S.mat("rubber", color=(0.05, 0.05, 0.05), roughness=0.6)
    S.add(Geo.merge(Bm), "rubber", node="slide")
    finish(S, "trombone")


# ---------------------------------------------------------------------------
# tuba (upright, bell up, 4 top-action piston valves on the player's right)
# ---------------------------------------------------------------------------

def build_tuba():
    S = new_scene("tuba")
    bx, bz = 0.03, 0.2
    B, Sv, P = [], [], []
    S.add(mouthpiece((0, 0, 0), (0, 0, 1), 0.0165, 0.0075, 0.1, cup=1.2), "silver")
    B.append(C.cylinder((0, 0, 0.082), (0, 0, 0.105), 0.0092, sides=14))
    B.append(pipe([(0, 0, 0.1), (-0.008, -0.025, 0.13), (-0.04, -0.08, 0.15), (-0.075, -0.13, 0.16),
                   (-0.1, -0.165, bz - 0.075)], 0.0075, 14, r_end=0.0095))
    # valves: 4 vertical pistons
    for i in range(4):
        z = bz - 0.06 + i * 0.03
        piston_valve((-0.1, z), -0.3, -0.172, 0.0128, -0.142, None, (B, Sv, P))
    # valve slides hanging below / forward (toward +x, -y)
    for i in range(4):
        z = bz - 0.06 + i * 0.03
        a = np.array([-0.09, -0.24 - 0.012 * (i % 2), z])
        b = np.array([-0.09, -0.275, z])
        B.append(C.tube([a, a + [0.02, 0, 0]], 0.0075, 10))
        B.append(C.tube([b, b + [0.02, 0, 0]], 0.0075, 10))
        B.append(slide_u(a + [0.02, 0, 0], b + [0.02, 0, 0], (1, -0.3, 0), 0.04 + 0.02 * i, 0.0075))
    # tubing wraps (the coils around the body, in the Y-Z plane)
    cc = np.array([bx - 0.02, -0.38, bz])
    B.append(arc(cc, (0, 1, 0), (0, 0, 1), 0.155, 0.0135, 0.3, 5.2, 48, 12))
    B.append(arc(cc + [0.03, 0, 0], (0, 1, 0), (0, 0, 1), 0.128, 0.0125, -0.4, 4.4, 44, 12))
    # small branch from the valves down into the bottom bow
    B.append(pipe([(-0.1, -0.3, bz), (-0.075, -0.32, bz), (-0.055, -0.36, bz), (bx - 0.085, -0.45, bz)], 0.013, 14, r_end=0.02))
    # bottom bow (large) and the conical body up to the bell
    bow = [(bx - 0.085, -0.45, bz), (bx - 0.095, -0.56, bz), (bx - 0.05, -0.645, bz), (bx + 0.03, -0.655, bz),
           (bx + 0.07, -0.58, bz), (bx + 0.07, -0.45, bz)]
    B.append(pipe(bow, 0.02, 18, r_end=0.045))
    body = C.lathe([(0.045, -0.452), (0.047, -0.35), (0.051, -0.25), (0.056, -0.16), (0.06, -0.1)], 28)
    body.translate(bx + 0.07, 0, bz)
    B.append(body)
    B.append(bell((bx + 0.07, -0.102, bz), (0, 1, 0), 0.06, 0.22, 0.425, gamma=0.62, segs=48))
    # bottom bow guard + ferrules / garland
    B.append(C.cylinder((bx + 0.07, -0.47, bz), (bx + 0.07, -0.44, bz), 0.049, sides=28))
    B.append(C.cylinder((bx + 0.07, -0.11, bz), (bx + 0.07, -0.092, bz), 0.064, sides=28))
    # braces
    B.append(C.cylinder((-0.088, -0.2, bz), (bx + 0.02, -0.2, bz), 0.0028, sides=6))
    B.append(C.cylinder((-0.07, -0.33, bz), (bx + 0.025, -0.33, bz), 0.0028, sides=6))
    B.append(C.cylinder((bx + 0.03, -0.52, bz + 0.12), (bx + 0.07, -0.52, bz + 0.02), 0.0028, sides=6))
    S.add(Geo.merge(B), "brass")
    S.add(Geo.merge(Sv), "silver")
    S.add(Geo.merge(P), "pearl")
    finish(S, "tuba")


BUILDERS = dict(trumpet=build_trumpet, horn=build_horn, trombone=build_trombone, tuba=build_tuba)


def main():
    args = C.script_args() or list(BUILDERS)
    for a in args:
        BUILDERS[a]()


if __name__ == "__main__":
    main()
