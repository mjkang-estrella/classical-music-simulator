"""
Tier-2 violin family (violin, viola, cello, double bass) + their bows.

  tools/blender/run.sh tools/blender/instruments/bowed.py -- [violin viola cello bass violin_bow ...]

Frame (glTF, matches src/assets/instruments/bowed.ts): origin at the tail end of the body on the
centre line at top-plate level, +Z towards the scroll, +Y = top-plate normal, +X = bass side.
Every anchor position is taken from anchor_contract.json and the strings are laid through the
contract's bridge / nut / contact points, so the skin swap lines up with the TS prototype.
"""
from __future__ import annotations

import json
import math
import os
import sys

import numpy as np
from mathutils import Vector
from mathutils import geometry as mgeo

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common as C  # noqa: E402
from common import Geo, smoothstep  # noqa: E402

CONTRACT = json.load(open(os.path.join(HERE, "anchor_contract.json")))

# ---------------------------------------------------------------------------
# per-instrument dimensions (meters). Widths / lengths from bowed.ts DIMS, the rest from luthier
# measurements of real instruments.
# ---------------------------------------------------------------------------
SPEC = {
    "violin": dict(L=0.356, lower=0.206, top=0.0075, peak=0.0085, arch_top=0.015, edge_t=0.0038, ribs=0.030,
                   arch_back=0.014, overhang=0.0025, purf=(0.0036, 0.0013), fb_w=(0.024, 0.042), fb_t=0.0055,
                   fb_R=0.042, clear=(0.0006, 0.0045), neck_d=(0.0125, 0.0145), heel=0.026, head=1.0,
                   head_tilt=9.0, string_r=(0.0004, 0.000375, 0.000325, 0.00013), chinrest=True, endpin=None,
                   bridge=dict(arch_h=0.24, feet=1.0, notch_y=0.40, heart_y=0.40, kid_y=0.58, t=(0.0042, 0.0014)),
                   tail_len=0.100, tail_w=(0.040, 0.021), fine_tuner=True, bass_form=False, button=(0.0105, 0.0095)),
    "viola": dict(L=0.405, lower=0.235, top=0.008, peak=0.009, arch_top=0.0165, edge_t=0.004, ribs=0.036,
                  arch_back=0.0155, overhang=0.0027, purf=(0.0039, 0.0014), fb_w=(0.026, 0.046), fb_t=0.006,
                  fb_R=0.045, clear=(0.0007, 0.005), neck_d=(0.0135, 0.0155), heel=0.029, head=1.1,
                  head_tilt=9.0, string_r=(0.0005, 0.000425, 0.000365, 0.0003), chinrest=True, endpin=None,
                  bridge=dict(arch_h=0.26, feet=1.0, notch_y=0.40, heart_y=0.40, kid_y=0.58, t=(0.0045, 0.0015)),
                  tail_len=0.113, tail_w=(0.044, 0.023), fine_tuner=False, bass_form=False, button=(0.0115, 0.0105)),
    "cello": dict(L=0.755, lower=0.44, top=0.014, peak=0.014, arch_top=0.025, edge_t=0.0055, ribs=0.118,
                  arch_back=0.024, overhang=0.0035, purf=(0.0055, 0.0018), fb_w=(0.040, 0.074), fb_t=0.009,
                  fb_R=0.075, clear=(0.001, 0.0065), neck_d=(0.024, 0.030), heel=0.05, head=2.0,
                  head_tilt=11.0, string_r=(0.00073, 0.00058, 0.00048, 0.0004), chinrest=False, endpin=0.34,
                  bridge=dict(arch_h=0.40, feet=0.92, notch_y=0.52, heart_y=0.55, kid_y=0.70, t=(0.0075, 0.0025)),
                  tail_len=0.225, tail_w=(0.074, 0.036), fine_tuner=False, bass_form=False, button=(0.020, 0.017)),
    "bass": dict(L=1.10, lower=0.66, top=0.014, peak=0.014, arch_top=0.028, edge_t=0.006, ribs=0.188,
                 arch_back=0.0, overhang=0.004, purf=(0.0065, 0.002), fb_w=(0.058, 0.10), fb_t=0.013,
                 fb_R=0.10, clear=(0.0015, 0.010), neck_d=(0.034, 0.045), heel=0.08, head=2.95,
                 head_tilt=13.0, string_r=(0.00115, 0.00095, 0.0008, 0.00065), chinrest=False, endpin=0.26,
                 bridge=dict(arch_h=0.45, feet=0.86, notch_y=0.56, heart_y=0.58, kid_y=0.72, t=(0.011, 0.0035)),
                 tail_len=0.30, tail_w=(0.105, 0.05), fine_tuner=False, bass_form=True, button=(0.030, 0.02)),
}

# ---------------------------------------------------------------------------
# outline
# ---------------------------------------------------------------------------
# Right half of a Stradivari-pattern violin (mm, x = half width, y from the tail), three
# segments split at the corner tips so the corners stay sharp.
VIOLIN_OUTLINE = [
    [(0, 0), (22, 1.2), (44, 5), (63, 12.5), (79, 23.5), (91, 38), (99, 55), (102.8, 74), (103, 88),
     (101.5, 103), (97.8, 118), (93, 130), (89.2, 139.5), (87.2, 146), (86.3, 150.8)],
    [(86.3, 150.8), (82.8, 149.6), (78.6, 148.9), (72.8, 150.0), (66.2, 153.8), (61.0, 160.2), (57.6, 168.8),
     (55.9, 179.5), (55.5, 190), (56.1, 199.5), (57.9, 208.5), (61.4, 216.3), (66.4, 222.1), (71.4, 225.0),
     (75.4, 225.3), (77.2, 224.4)],
    [(77.2, 224.4), (78.4, 229.5), (80.6, 238.0), (82.8, 248.5), (84.2, 260.0), (84.6, 272.0), (84.2, 283.5),
     (82.6, 294.5), (79.6, 305.0), (74.8, 315.0), (68.0, 324.5), (59.0, 333.0), (47.5, 340.8), (33.5, 347.8),
     (17.5, 353.2), (0, 356)],
]
# Double bass (gamba corners kept small) with sloping shoulders, mm for a 1100 mm body.
BASS_OUTLINE = [
    [(0, 0), (70, 4), (140, 16), (205, 40), (258, 78), (300, 130), (323, 190), (330, 245), (326, 300),
     (312, 350), (292, 395), (272, 432), (262, 452), (258, 463)],
    [(258, 463), (243, 461), (226, 466), (211, 478), (199, 497), (191, 520), (187.5, 545), (187, 570),
     (189, 595), (195, 617), (205, 636), (218, 650), (231, 656), (240, 655)],
    [(240, 655), (246, 664), (251, 680), (254, 700), (252.5, 726), (246, 753), (234, 781), (217, 813),
     (195, 849), (169, 889), (141, 933), (114, 976), (90, 1015), (69, 1050), (51, 1077), (30, 1094), (0, 1100)],
]

def outline_halves(spec, n_per=10):
    """Right-half outline (x, z) in meters for the spec, as 3 dense segments."""
    src = BASS_OUTLINE if spec["bass_form"] else VIOLIN_OUTLINE
    if spec["bass_form"]:
        sz = spec["L"] / 1.100
        sx = spec["lower"] / 0.660
    else:
        sz = spec["L"] / 0.356
        sx = spec["lower"] / 0.206
    segs = []
    for i, seg in enumerate(src):
        P = np.array(seg, float) * [sx, sz] * 0.001
        if i == 0:
            P = np.concatenate([[[-P[1, 0], P[1, 1]]], P])  # mirror neighbour -> horizontal tangent at x=0
            dense = C.catmull(P, n_per)[n_per:]
        elif i == 2:
            P = np.concatenate([P, [[-P[-2, 0], P[-2, 1]]]])
            dense = C.catmull(P, n_per)[: -n_per]
        else:
            dense = C.catmull(P, n_per)
        segs.append(dense)
    return segs


def full_outline(spec, spacing, button=None):
    """Closed CCW outline (X, Z) resampled to ~`spacing`, corners preserved; optional back button."""
    segs = outline_halves(spec)
    right = []
    corner_idx = []
    for k, seg in enumerate(segs):
        n = max(3, int(np.sum(np.linalg.norm(np.diff(seg, axis=0), axis=1)) / spacing))
        rs = C.resample_open(seg, n + 1)
        if k > 0:
            rs = rs[1:]
        right.append(rs)
    right = np.concatenate(right)
    # right: from (0,0) to (0,L) going up the +X side
    if button is not None:
        bw, bh = button
        L = spec["L"]
        # replace the top-centre region |x| < bw*1.25 with a semicircular button
        keep = right[:, 0] > bw * 1.05
        cut = np.where(~keep)[0]
        cut = cut[cut > len(right) // 2]
        right = right[: cut[0]]
        zj = np.interp(bw, right[::-1, 0], right[::-1, 1]) if right[-1, 0] < bw else right[-1, 1]
        a = np.linspace(0, math.pi / 2, 9)[1:]
        arc = np.stack([np.cos(a) * bw, zj + np.sin(a) * (L + bh - zj)], axis=1)
        right = np.concatenate([right, arc])
    left = right[::-1].copy()
    left[:, 0] *= -1
    # drop duplicated centre points
    poly = np.concatenate([right[:-1], left[:-1]])
    return poly


def poly_sdf(px, pz, poly):
    """Signed distance (positive inside) from points to a closed polygon, numpy, chunked by segment."""
    P = np.asarray(poly, float)
    A = P
    B = np.roll(P, -1, axis=0)
    shape = px.shape
    x = px.ravel()
    z = pz.ravel()
    dmin = np.full(x.shape, np.inf)
    inside = np.zeros(x.shape, bool)
    for (ax, az), (bx, bz) in zip(A, B):
        ex, ez = bx - ax, bz - az
        L2 = ex * ex + ez * ez
        t = np.clip(((x - ax) * ex + (z - az) * ez) / (L2 if L2 > 0 else 1), 0, 1)
        dx = x - (ax + t * ex)
        dz = z - (az + t * ez)
        np.minimum(dmin, dx * dx + dz * dz, out=dmin)
        cond = ((az > z) != (bz > z))
        xc = ax + (z - az) * ex / np.where(ez == 0, 1e-12, ez)
        inside ^= cond & (x < xc)
    d = np.sqrt(dmin)
    return np.where(inside, d, -d).reshape(shape)


def halfwidth_at(poly, z):
    """Max |x| of the outline at height z (per element of z)."""
    P = np.asarray(poly)
    A = P
    B = np.roll(P, -1, axis=0)
    z = np.asarray(z, float)
    w = np.zeros_like(z)
    for (ax, az), (bx, bz) in zip(A, B):
        lo, hi = min(az, bz), max(az, bz)
        m = (z >= lo) & (z <= hi) & (hi > lo)
        if not m.any():
            continue
        t = (z[m] - az) / (bz - az)
        w[m] = np.maximum(w[m], np.abs(ax + t * (bx - ax)))
    return w


def offset_poly(poly, d):
    """Offset a CCW polygon by d (negative = inward) along averaged normals (miter clamped)."""
    P = np.asarray(poly, float)
    e_prev = P - np.roll(P, 1, axis=0)
    e_next = np.roll(P, -1, axis=0) - P
    def nrm(e):
        n = np.stack([e[:, 1], -e[:, 0]], axis=1)
        return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    n1, n2 = nrm(e_prev), nrm(e_next)
    n = n1 + n2
    n = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    cosh = np.clip(np.sum(n * n1, axis=1), 0.35, 1.0)
    return P + n * (d / cosh)[:, None]


# ---------------------------------------------------------------------------
# textures
# ---------------------------------------------------------------------------

def f_hole_mask(X, Z, spec):
    """Anti-aliased f-hole coverage (1 = hole) in mm-free meters coordinates, both sides."""
    if spec["bass_form"]:
        s_x = spec["lower"] / 0.206 * 0.92
        s_z = spec["L"] / 0.356 * 1.02
        z_shift = 0.02 * spec["L"]
    else:
        s_x = spec["lower"] / 0.206
        s_z = spec["L"] / 0.356
        z_shift = 0.0
    px = np.abs(X) / s_x * 1000.0  # violin-equivalent mm
    pz = (Z - z_shift) / s_z * 1000.0
    cov = np.zeros_like(X)
    # stem: cubic bezier from the upper eye to the lower eye with a width profile
    P0, P1, P2, P3 = np.array([21.5, 196.0]), np.array([23.5, 171.0]), np.array([36.0, 147.0]), np.array([41.5, 124.0])
    ts = np.linspace(0, 1, 60)
    curve = C.bezier(P0, P1, P2, P3, 60)
    width = np.interp(ts, [0, 0.06, 0.18, 0.5, 0.82, 0.94, 1.0], [0.9, 1.25, 1.75, 1.95, 1.85, 1.3, 1.1])
    pix = 0.7 * (s_x ** 0.0)  # soft edge in mm
    d_stem = np.full(X.shape, np.inf)
    w_at = np.zeros(X.shape)
    for i in range(len(curve) - 1):
        a, b = curve[i], curve[i + 1]
        e = b - a
        L2 = e @ e
        t = np.clip(((px - a[0]) * e[0] + (pz - a[1]) * e[1]) / L2, 0, 1)
        dd = np.hypot(px - (a[0] + t * e[0]), pz - (a[1] + t * e[1]))
        better = dd < d_stem
        d_stem = np.where(better, dd, d_stem)
        w_at = np.where(better, width[i] + (width[i + 1] - width[i]) * t, w_at)
    cov = np.maximum(cov, np.clip((w_at - d_stem) / pix + 0.5, 0, 1))
    # wings: tapered blades - upper wing on the outer side below the upper eye, lower wing on the inner side
    for (a, b, wa) in (((22.3, 188.0), (28.8, 193.2), 1.55), ((40.6, 131.0), (33.6, 125.8), 1.75)):
        a, b = np.array(a), np.array(b)
        e = b - a
        L2 = e @ e
        t = np.clip(((px - a[0]) * e[0] + (pz - a[1]) * e[1]) / L2, 0, 1)
        dd = np.hypot(px - (a[0] + t * e[0]), pz - (a[1] + t * e[1]))
        w = wa * (1 - t) ** 0.8
        cov = np.maximum(cov, np.clip((w - dd) / pix + 0.5, 0, 1))
    # eyes
    for (cx, cz, r) in ((21.5, 197.0, 3.3), (41.5, 123.5, 4.3)):
        dd = np.hypot(px - cx, pz - cz)
        cov = np.maximum(cov, np.clip((r - dd) / pix + 0.5, 0, 1))
    # nicks at the bridge line
    for side in (-1, 1):
        a = np.array([29.5, 159.5])
        dd = np.hypot(px - (a[0] + side * 2.6), pz - a[1])
        cov = np.maximum(cov, np.clip((0.9 - dd) / pix + 0.5, 0, 1))
    return cov


def wood_colors():
    return dict(
        top_early=np.array([0.70, 0.36, 0.12]),
        top_late=np.array([0.36, 0.13, 0.04]),
        maple_base=np.array([0.56, 0.24, 0.075]),
        maple_light=np.array([0.80, 0.44, 0.16]),
        maple_dark=np.array([0.33, 0.11, 0.035]),
        edge=np.array([0.30, 0.11, 0.04]),
        purf_black=np.array([0.04, 0.03, 0.025]),
        purf_white=np.array([0.70, 0.55, 0.33]),
        hole=np.array([0.015, 0.01, 0.008]),
    )


def plate_textures(spec, top_poly, back_poly, res=1024):
    """Returns (atlas image rgb (res, 2res, 3), mapping dict)."""
    col = wood_colors()
    L = spec["L"]
    s = L / 0.356
    wmax = float(np.max(np.abs(top_poly[:, 0])))
    mx = wmax + 0.004 * s
    z0 = -0.004 * s
    z1 = float(np.max(back_poly[:, 1])) + 0.004 * s
    H = W = res
    j = (np.arange(W) + 0.5) / W
    i = (np.arange(H) + 0.5) / H
    X = -mx + j[None, :] * 2 * mx + np.zeros((H, 1))
    Z = z1 - i[:, None] * (z1 - z0) + np.zeros((1, W))
    # distance fields at half resolution, upsampled
    hr = res // 2
    jh = (np.arange(hr) + 0.5) / hr
    Xh = -mx + jh[None, :] * 2 * mx + np.zeros((hr, 1))
    Zh = z1 - jh[:, None] * (z1 - z0) + np.zeros((1, hr))
    sd_top_h = poly_sdf(Xh, Zh, C.resample_closed(top_poly, 700))
    sd_back_h = poly_sdf(Xh, Zh, C.resample_closed(back_poly, 700))

    def up(a):
        # bilinear upsample x2
        yi = np.clip((np.arange(H) + 0.5) / 2 - 0.5, 0, hr - 1)
        xi = np.clip((np.arange(W) + 0.5) / 2 - 0.5, 0, hr - 1)
        y0 = np.floor(yi).astype(int)
        x0 = np.floor(xi).astype(int)
        y1 = np.minimum(y0 + 1, hr - 1)
        x1 = np.minimum(x0 + 1, hr - 1)
        fy = (yi - y0)[:, None]
        fx = (xi - x0)[None, :]
        return (a[y0][:, x0] * (1 - fx) * (1 - fy) + a[y0][:, x1] * fx * (1 - fy)
                + a[y1][:, x0] * (1 - fx) * fy + a[y1][:, x1] * fx * fy)
    sd_top = up(sd_top_h)
    sd_back = up(sd_back_h)
    px_m = 2 * mx / W  # meters per pixel (x)

    def band(sd, a, b):
        aa = px_m * 0.7
        return np.clip((sd - a) / aa + 0.5, 0, 1) * np.clip((b - sd) / aa + 0.5, 0, 1)

    pi_, pw = spec["purf"]
    gs = max(1.0, s ** 0.5)
    # ---------------- top: spruce ----------------
    ax = np.abs(X) * 1000 / gs  # mm, bookmatched
    wob = (C.fbm(H, W, 6, 3, 3, seed=11) - 0.5) * 2.2
    spacing = 0.9 + 1.4 * np.clip(ax / 105.0, 0, 1) ** 1.3
    phase = np.cumsum(np.ones_like(ax[:1]) , axis=1)  # placeholder (not used)
    # grain phase: integral of 1/spacing over |x|
    xs = np.linspace(0, 140, 4000)
    sp = 0.9 + 1.4 * np.clip(xs / 105.0, 0, 1) ** 1.3
    ph = np.concatenate([[0], np.cumsum(np.diff(xs) / sp[1:])])
    grain_phase = np.interp(ax + wob * 0.35, xs, ph)
    f = grain_phase % 1.0
    late = np.clip(1 - np.abs(f - 0.8) / 0.16, 0, 1) ** 1.5
    fine = C.fbm(H, W, 64, 6, 2, seed=5)
    rgb = C.lerp_color(col["top_early"], col["top_late"], np.clip(late * 0.85 + (fine - 0.5) * 0.15, 0, 1))
    # varnish thickness / wear: lighter golden centre, darker toward the edges
    wear = smoothstep(0.004 * s, 0.05 * s, sd_top) * (0.75 + 0.25 * C.fbm(H, W, 5, 3, 3, seed=21))
    rgb = rgb * (0.78 + 0.26 * wear[..., None])
    varn = C.fbm(H, W, 8, 5, 4, seed=31)
    rgb = rgb * (0.9 + 0.18 * varn[..., None])
    rgb = C.lerp_color(rgb, rgb * np.array([1.05, 0.93, 0.85]), 0.5 * (1 - wear))
    # purfling + edge
    rgb = C.lerp_color(rgb, col["purf_black"], band(sd_top, pi_, pi_ + pw * 0.28))
    rgb = C.lerp_color(rgb, col["purf_white"], band(sd_top, pi_ + pw * 0.28, pi_ + pw * 0.72))
    rgb = C.lerp_color(rgb, col["purf_black"], band(sd_top, pi_ + pw * 0.72, pi_ + pw))
    rgb = C.lerp_color(rgb, col["edge"], np.clip(1 - (sd_top - 0.0006 * s) / (0.0022 * s), 0, 1) * 0.85)
    # f-holes
    fh = f_hole_mask(X, Z, spec)
    rgb = C.lerp_color(rgb, col["hole"], fh)
    top_rgb = rgb

    # ---------------- back: two-piece flamed maple ----------------
    fx = np.abs(X) * 1000 / s  # violin-equivalent mm
    fz = Z * 1000 / s
    n1 = C.fbm(H, W, 6, 3, 3, seed=41)
    n2 = C.fbm(H, W, 16, 8, 3, seed=43)
    n3 = C.fbm(H, W, 3, 2, 2, seed=45)
    # flame "curl": bands slanting up toward the joint, irregular spacing and strength
    period = 4.2 + 2.2 * n3
    flame_phase = (fz + fx * 0.36 + (n1 - 0.5) * 22.0) / period
    fl = 0.5 + 0.5 * np.sin(2 * math.pi * flame_phase + (n2 - 0.5) * 3.0)
    fl = np.clip(fl, 0, 1) ** 1.3
    patch = smoothstep(0.3, 0.8, C.fbm(H, W, 5, 3, 3, seed=47))
    intensity = 0.25 + 0.55 * patch
    base = C.lerp_color(col["maple_base"] * 0.95, col["maple_base"] * 1.12, C.fbm(H, W, 8, 4, 3, seed=48))
    rgb = C.lerp_color(base, col["maple_light"], np.clip((fl - 0.45) * 2, 0, 1) * intensity)
    rgb = C.lerp_color(rgb, col["maple_dark"], np.clip((0.45 - fl) * 2, 0, 1) * intensity * 0.8)
    gr = C.fbm(H, W, 90, 5, 2, seed=49)
    rgb = rgb * (0.93 + 0.12 * gr[..., None])
    wearb = smoothstep(0.004 * s, 0.06 * s, sd_back)
    rgb = rgb * (0.8 + 0.24 * wearb[..., None])
    joint = np.clip(1 - np.abs(X) / (px_m * 1.2), 0, 1) * 0.35
    rgb = C.lerp_color(rgb, col["maple_dark"] * 0.8, joint)
    if not spec["bass_form"]:
        rgb = C.lerp_color(rgb, col["purf_black"], band(sd_top, pi_, pi_ + pw * 0.28))
        rgb = C.lerp_color(rgb, col["purf_white"], band(sd_top, pi_ + pw * 0.28, pi_ + pw * 0.72))
        rgb = C.lerp_color(rgb, col["purf_black"], band(sd_top, pi_ + pw * 0.72, pi_ + pw))
    rgb = C.lerp_color(rgb, col["edge"], np.clip(1 - (sd_back - 0.0006 * s) / (0.0022 * s), 0, 1) * 0.85)
    back_rgb = rgb
    atlas = np.concatenate([top_rgb, back_rgb], axis=1)
    mapping = dict(mx=mx, z0=z0, z1=z1)
    return atlas, mapping


def maple_tile(res=512, seed=3):
    """Tileable flamed maple (stripes vary along u), softer than the back."""
    col = wood_colors()
    H = W = res
    u = (np.arange(W) + 0.5) / W
    n1 = C.fbm(H, W, 3, 3, 3, seed=seed)
    n2 = C.fbm(H, W, 6, 12, 2, seed=seed + 1)
    K = 13
    ph = u[None, :] * K + (n1 - 0.5) * 1.6 + (C.value_noise(H, W, 2, 4, seed + 5) - 0.5) * 0.8
    fl = np.clip(0.5 + 0.5 * np.sin(2 * math.pi * ph + (n2 - 0.5) * 2.0), 0, 1) ** 1.3
    patch = 0.3 + 0.45 * C.fbm(H, W, 2, 3, 2, seed=seed + 7)
    base = C.lerp_color(col["maple_base"] * 0.95, col["maple_base"] * 1.1, C.fbm(H, W, 4, 4, 2, seed=seed + 8))
    rgb = C.lerp_color(base, col["maple_light"], np.clip((fl - 0.45) * 2, 0, 1) * patch)
    rgb = C.lerp_color(rgb, col["maple_dark"], np.clip((0.45 - fl) * 2, 0, 1) * patch * 0.8)
    grain = C.fbm(H, W, 4, 70, 2, seed=seed + 9)  # fine lines along u
    rgb = rgb * (0.93 + 0.1 * grain[..., None])
    return rgb * 0.9


def bridge_tex(res=256):
    H = W = res
    base = np.array([0.86, 0.74, 0.54])
    n = C.fbm(H, W, 4, 4, 3, seed=61)
    rgb = base * (0.93 + 0.1 * n[..., None])
    # medullary ray flecks: short horizontal streaks
    r = C.rng(62)
    fl = np.zeros((H, W))
    for _ in range(140):
        y = r.integers(0, H)
        x = r.integers(0, W)
        ln = r.integers(4, 16)
        fl[y:y + 2, x:x + ln] = r.uniform(0.3, 1.0)
    rgb = C.lerp_color(rgb, np.array([0.68, 0.5, 0.3]), fl * 0.5)
    return rgb


# ---------------------------------------------------------------------------
# body
# ---------------------------------------------------------------------------

def arch_height(px, pz, poly, w_of_z, spec, which):
    """Top / back surface heights (glTF y) at points."""
    s = spec["L"] / 0.356
    d = np.maximum(poly_sdf(px, pz, poly), 0.0)
    w = np.maximum(w_of_z(pz), 1e-4)
    ch = 0.0048 * s ** 0.8
    t = np.clip((d - ch * 0.45) / np.maximum(w * 0.97 - ch * 0.45, 1e-4), 0, 1)
    S = np.sin(math.pi / 2 * t) ** 1.25
    dip = 0.0007 * s ** 0.7 * np.exp(-((d - ch) / (0.45 * ch)) ** 2)
    y_rt = spec["peak"] - spec["arch_top"]
    y_edge_top = y_rt + spec["edge_t"]
    y_rb = y_rt - spec["ribs"]
    if which == "top":
        A = spec["peak"] - y_edge_top
        return y_edge_top + A * S - dip * (1 - t)
    # back
    y_edge_b = y_rb - spec["edge_t"]
    if spec["arch_back"] <= 0:
        # flat bass back with the upper "break" (cant) toward the neck
        zc = pz / spec["L"]
        cant = smoothstep(0.80, 1.0, zc) * 0.030 * (spec["L"] / 1.1)
        return y_edge_b + cant
    A = spec["arch_back"] - spec["edge_t"]
    return y_edge_b - A * S + dip * (1 - t)


def plate_surface(spec, poly, which, spacing):
    """CDT plate surface over the polygon with arching. Returns Geo (verts in glTF)."""
    s = spec["L"] / 0.356
    P = np.asarray(poly, float)
    pts = [P]
    # interior: rings near the edge + a jittered grid inside
    for dd in (0.0022 * s, 0.0048 * s, 0.009 * s, 0.015 * s):
        ring = offset_poly(P, -dd)
        ring = C.resample_closed(ring, max(12, int(len(P) * (1.0 if dd < 0.006 * s else 0.6))))
        sd = poly_sdf(ring[:, 0], ring[:, 1], P)
        ok = np.abs(sd - dd) < dd * 0.35
        pts.append(ring[ok])
    g = spacing * 1.6
    xs = np.arange(P[:, 0].min(), P[:, 0].max(), g)
    zs = np.arange(P[:, 1].min(), P[:, 1].max(), g * 1.15)
    GX, GZ = np.meshgrid(xs, zs)
    GX = GX + (np.arange(GZ.shape[0])[:, None] % 2) * g * 0.5
    gp = np.stack([GX.ravel(), GZ.ravel()], axis=1)
    sd = poly_sdf(gp[:, 0], gp[:, 1], P)
    pts.append(gp[sd > 0.021 * s])
    allp = np.concatenate(pts)
    # dedupe
    keep = []
    from mathutils.kdtree import KDTree
    kd = KDTree(len(allp))
    for i, p in enumerate(allp):
        kd.insert((p[0], p[1], 0), i)
    kd.balance()
    removed = np.zeros(len(allp), bool)
    nb = len(P)
    for i, p in enumerate(allp):
        if removed[i]:
            continue
        keep.append(i)
        for (_, j, dist) in kd.find_range((p[0], p[1], 0), spacing * 0.35):
            if j != i and j >= nb and not removed[j]:
                removed[j] = True
    allp = allp[keep]
    verts2 = [Vector((p[0], p[1])) for p in allp]
    face = [list(range(len(P)))]
    out = mgeo.delaunay_2d_cdt(verts2, [], face, 1, 1e-7, True)
    ov, _, of = out[0], out[1], out[2]
    ov = np.array([[v.x, v.y] for v in ov])
    zmax = P[:, 1].max()
    w_of_z = lambda z: halfwidth_at(P if which == "top" else spec["_top_poly"], np.clip(z, 0, spec["L"]))
    y = arch_height(ov[:, 0], ov[:, 1], P if which == "top" else spec["_top_poly"], w_of_z, spec, which)
    if which == "back":
        # button region: outside the body outline -> continue at edge height
        pass
    verts = np.stack([ov[:, 0], y, ov[:, 1]], axis=1)
    faces = [tuple(f) for f in of]
    geo = Geo(verts, faces)
    # orient normals: top up, back down
    nsum = 0.0
    for f in faces[:200]:
        a, b, c = verts[list(f)]
        nsum += np.cross(b - a, c - a)[1]
    if (which == "top" and nsum < 0) or (which == "back" and nsum > 0):
        geo.flip()
    return geo, ov


def ring_band(rings, closed=True):
    return C.loft(rings, closed=closed)


def build_body(S, spec, mat_plates, mat_maple, mapping, top_poly, back_poly, rib_poly):
    s = spec["L"] / 0.356
    y_rt = spec["peak"] - spec["arch_top"]
    y_et = y_rt + spec["edge_t"]
    y_rb = y_rt - spec["ribs"]
    y_eb = y_rb - spec["edge_t"]
    mx, z0, z1 = mapping["mx"], mapping["z0"], mapping["z1"]

    def atlas_uv(geo, half):
        u = (geo.v[:, 0] + mx) / (2 * mx) * 0.5 + (0.5 if half == "back" else 0.0)
        v = (geo.v[:, 2] - z0) / (z1 - z0)
        geo.uv = np.stack([u, v], axis=1)
        return geo

    spacing = 0.0114 * s
    top, _ = plate_surface(spec, top_poly, "top", spacing)
    back, _ = plate_surface(spec, back_poly, "back", spacing)
    # edge bands (share outline positions with the plate boundary)
    def edge_rings(poly, y_surface, y_under, sign):
        P = np.asarray(poly)
        out1 = offset_poly(P, 0.00035 * s)
        out2 = offset_poly(P, 0.0005 * s)
        rib = rib_poly
        def lift(p2, y):
            return np.stack([p2[:, 0], np.broadcast_to(y, len(p2)), p2[:, 1]], axis=1)
        ys = y_surface
        r0 = lift(P, ys)
        r1 = lift(out1, ys + sign * -0.0012 * s)
        r2 = lift(out2, ys + sign * -(ys - y_under) * sign * 0.6 if False else (ys * 0.35 + y_under * 0.65))
        r3 = lift(out1, y_under + sign * 0.0004 * s)
        r4 = lift(P, y_under)
        return [r0, r1, r2, r3, r4]
    y_top_edge = arch_height(top_poly[:, 0], top_poly[:, 1], top_poly, lambda z: halfwidth_at(top_poly, z), spec, "top")
    y_back_edge = arch_height(back_poly[:, 0], back_poly[:, 1], top_poly, lambda z: halfwidth_at(top_poly, z), spec, "back")
    tr = edge_rings(top_poly, y_top_edge, y_rt, +1)
    tb = ring_band(tr)
    br = edge_rings(back_poly, y_back_edge, y_rb, -1)
    bb = ring_band(br[::-1])
    # plate undersides at the overhang: outline -> rib line, need matching counts -> separate lofts
    def underside(poly, y):
        P = np.asarray(poly)
        # project each outline point to the nearest rib point
        R = np.asarray(rib_poly)
        idx = np.argmin(((P[:, None, :] - R[None, :, :]) ** 2).sum(-1), axis=1)
        inner = R[idx]
        a = np.stack([P[:, 0], np.full(len(P), y), P[:, 1]], axis=1)
        b = np.stack([inner[:, 0], np.full(len(P), y), inner[:, 1]], axis=1)
        return a, b
    ta, tb2 = underside(top_poly, y_rt)
    tu = C.loft([ta, tb2])
    ba, bb2 = underside(back_poly, y_rb)
    bu = C.loft([bb2, ba])
    for g, half in ((top, "top"), (tb, "top"), (tu, "top"), (back, "back"), (bb, "back"), (bu, "back")):
        atlas_uv(g, half)
    S.add(top, mat_plates)
    S.add(tb, mat_plates)
    S.add(tu, mat_plates)
    S.add(back, mat_plates)
    S.add(bb, mat_plates)
    S.add(bu, mat_plates)
    # ribs
    R = np.asarray(rib_poly)
    a = np.stack([R[:, 0], np.full(len(R), y_rt), R[:, 1]], axis=1)
    b = np.stack([R[:, 0], np.full(len(R), y_rb), R[:, 1]], axis=1)
    ribs = C.loft([a, b])
    seg = np.linalg.norm(np.diff(np.concatenate([R, R[:1]]), axis=0), axis=1)
    arc = np.concatenate([[0], np.cumsum(seg)])
    tile = 0.064 * s ** 0.6
    K = len(R) + 1
    uu = np.tile(arc / tile, 2)
    vv = np.repeat([0.0, spec["ribs"] / tile], K)
    ribs.uv = np.stack([uu, vv], axis=1)
    # orientation: outward
    f0 = ribs.f[0]
    va, vb, vc = ribs.v[list(f0[:3])]
    nrm = np.cross(vb - va, vc - va)
    mid = (va + vb + vc) / 3
    if np.dot(nrm[[0, 2]], mid[[0, 2]] - np.array([0, spec["L"] * 0.5])) < 0:
        ribs.flip()
    S.add(ribs, mat_maple)
    return dict(y_rt=y_rt, y_rb=y_rb, y_et=y_et, y_eb=y_eb)


# ---------------------------------------------------------------------------
# neck, fingerboard, head
# ---------------------------------------------------------------------------

def string_line(bw):
    bz, nz, by, ny = bw["bridgeZ"], bw["nutZ"], bw["bridgeY"], bw["nutY"]
    return lambda z: by + (np.asarray(z) - bz) / (nz - bz) * (ny - by)


def fb_geometry(spec, bw):
    sl = string_line(bw)
    nz = bw["nutZ"]
    fb_len = (nz - bw["bridgeZ"]) * 0.8
    fe = nz - fb_len
    c0, c1 = spec["clear"]
    w0, w1 = spec["fb_w"]
    def top_y(z):
        f = (nz - np.asarray(z)) / fb_len
        return sl(z) - (c0 + (c1 - c0) * f)
    def width(z):
        f = (nz - np.asarray(z)) / fb_len
        return w0 + (w1 - w0) * f
    return fe, top_y, width


def build_fingerboard(S, spec, bw, mat):
    fe, top_y, width = fb_geometry(spec, bw)
    nz = bw["nutZ"]
    t = spec["fb_t"]
    R = spec["fb_R"]
    zs = np.linspace(fe, nz, 14)
    secs = []
    for z in zs:
        w = width(z)
        yt = top_y(z)
        # crown: circular arc of radius R through the top centre
        xs = np.linspace(-w / 2, w / 2, 9)
        ys = yt - (R - np.sqrt(np.maximum(R * R - xs ** 2, 0)))
        edge_y = ys[0]
        loop = [(w / 2, edge_y - t)]
        loop += [(x, y) for x, y in zip(xs[::-1], ys[::-1])]
        loop += [(-w / 2, edge_y - t)]
        secs.append(np.array([[x, y, z] for x, y in loop]))
    g = C.loft(secs, closed=True, cap_start=True, cap_end=True, sharp=40)
    g.sharp = 40
    S.add(g, mat)
    # nut (ebony) at nutZ: sits on the neck in front of the pegbox
    w = width(nz)
    yt = top_y(nz)
    nut = C.box((0, yt + 0.0004 * spec["head"], nz + 0.003 * spec["head"]),
                (w, t + 0.0012 * spec["head"], 0.006 * spec["head"]), sharp=30)
    nut.translate(0, -t / 2, 0)
    S.add(nut, mat)
    return fe, top_y, width


def superellipse_half(w, d, n=10, p=2.4):
    """Bottom half loop from (w/2, 0) down to (0,-d) to (-w/2, 0) (K=n points)."""
    a = np.linspace(0, math.pi, n)
    c, s_ = np.cos(a), np.sin(a)
    x = np.sign(c) * np.abs(c) ** (2 / p) * w / 2
    y = -np.abs(s_) ** (2 / p) * d
    return np.stack([x, y], axis=1)


def build_neck(S, spec, bw, fbinfo, body, mat_maple):
    fe, top_y, width = fbinfo
    L = spec["L"]
    nz = bw["nutZ"]
    t = spec["fb_t"]
    d0, d1 = spec["neck_d"]
    heel = spec["heel"]
    bw_, bh = spec["button"]
    y_bottom_button = body["y_eb"] - 0.0005
    zs = np.concatenate([np.linspace(L - 0.006 * spec["head"], L + heel, 12), np.linspace(L + heel, nz + 0.004 * spec["head"], 10)[1:]])
    secs = []
    for z in zs:
        ytop = top_y(z) - t + 0.0006  # under the fingerboard
        f = np.clip((nz - z) / (nz - L), 0, 1)
        dn = d0 + (d1 - d0) * f + 0.0045 * spec["head"] * smoothstep(nz - 0.03 * spec["head"], nz + 0.004 * spec["head"], z)
        ybot_neck = ytop - dn
        # heel: quarter ellipse from the button bottom up to the neck line
        u = np.clip((z - L) / heel, 0, 1)
        yh = y_bottom_button + (ybot_neck - y_bottom_button) * (1 - np.sqrt(np.maximum(1 - u * u, 0)) if u < 1 else 1)
        yb = min(ybot_neck, yh) if z < L + heel else ybot_neck
        wn = width(min(z, fe + (nz - fe))) * 0.96 if z > fe else width(fe) * 0.96
        wn = min(wn, width(L) * 0.96)
        if z < L + heel:
            wn = wn * (1 - 0.25 * (1 - u)) if False else wn
            wn = min(wn, bw_ * 2.6)
        d = ytop - yb
        half = superellipse_half(wn, d, 11, 2.6)
        loop = np.concatenate([half, [[-wn / 2 * 0.98, 0.0005], [wn / 2 * 0.98, 0.0005]]])
        secs.append(np.array([[x, ytop + y, z] for x, y in loop]))
    g = C.loft(secs, closed=True, cap_start=False, cap_end=True, sharp=None)
    g.uv = np.stack([g.v[:, 2] / (0.064 * spec["head"] ** 0.6), (g.v[:, 0] + g.v[:, 1]) / (0.064 * spec["head"] ** 0.6)], axis=1)
    # orientation check: normals away from the neck axis
    f0 = g.f[len(g.f) // 2]
    va, vb, vc = g.v[list(f0[:3])]
    n = np.cross(vb - va, vc - va)
    ctr = np.array([0, top_y(va[2]) - t - 0.01 * spec["head"], va[2]])
    if np.dot(n, (va - ctr)) < 0:
        g.flip()
    S.add(g, mat_maple)


def head_frame(spec, bw, fbinfo):
    fe, top_y, width = fbinfo
    nz = bw["nutZ"]
    k = spec["head"]
    tilt = math.radians(spec["head_tilt"])
    a = np.array([0, -math.sin(tilt), math.cos(tilt)])
    u = np.array([0, math.cos(tilt), math.sin(tilt)])
    ex = np.array([1.0, 0, 0])
    O = np.array([0, top_y(nz) - 0.0015 * k, nz + 0.006 * k])
    def P(s_, t_, x_):
        return O + np.multiply.outer(s_, a) + np.multiply.outer(t_, u) + np.multiply.outer(x_, ex)
    return O, a, u, ex, P


def build_head(S, spec, bw, fbinfo, mat_maple, mat_ebony, mat_strings, mat_metal):
    k = spec["head"]
    fe, top_y, width = fbinfo
    nz = bw["nutZ"]
    O, a, u, ex, P = head_frame(spec, bw, fbinfo)
    w_nut = width(nz)
    # ---------------- pegbox (U channel) ----------------
    pb_len = 0.070 * k          # end of the open cavity (volute turn starts here)
    pb_ext = pb_len + 0.010 * k  # cheeks continue under the volute
    wall = 0.0045 * k
    floor = 0.0042 * k
    ss = np.linspace(-0.004 * k, pb_ext, 14)
    secs = []
    for s_ in ss:
        f = np.clip(s_ / pb_len, 0, 1)
        w = w_nut * (1.0 - 0.1 * f)
        tb = -(0.0205 * k) + 0.002 * k * f
        tt = 0.0 - 0.0015 * k * f
        if s_ > pb_len:
            w = w_nut * 0.9 * (1 - 0.04 * (s_ - pb_len) / (pb_ext - pb_len))
        r = 0.004 * k
        prof = [(w / 2, tt), (w / 2, tb + r)]
        for ang in np.linspace(0, math.pi / 2, 4)[1:-1]:
            prof.append((w / 2 - r + r * math.cos(ang), tb + r - r * math.sin(ang)))
        prof += [(w / 2 - r, tb), (-w / 2 + r, tb)]
        for ang in np.linspace(math.pi / 2, math.pi, 4)[1:-1]:
            prof.append((-w / 2 + r + r * math.cos(ang), tb + r - r * math.sin(ang)))
        prof += [(-w / 2, tb + r), (-w / 2, tt), (-w / 2 + wall, tt), (-w / 2 + wall, tb + floor),
                 (w / 2 - wall, tb + floor), (w / 2 - wall, tt)]
        prof = np.array(prof)
        secs.append(P(np.full(len(prof), s_), prof[:, 1], prof[:, 0]))
    pg = C.loft(secs, closed=True, sharp=50)
    # end cap at the nut side (U polygon) via tessellation
    prof0 = secs[0]
    loc = np.stack([(prof0 - O) @ ex, (prof0 - O) @ u], axis=1)
    tris = C.polygon_fill([loc])
    cap = Geo(prof0.copy(), [tuple(t_) for t_ in tris])
    nrm = np.cross(prof0[tris[0][1]] - prof0[tris[0][0]], prof0[tris[0][2]] - prof0[tris[0][0]])
    if np.dot(nrm, -a) < 0:
        cap.flip()
    # outward orientation for the U loft: test one outer-wall face against +x
    f0 = pg.f[0]
    va, vb, vc = pg.v[list(f0[:3])]
    if np.dot(np.cross(vb - va, vc - va), ex) < 0:
        pg.flip()
    pg = Geo.merge([pg, cap])
    pg.sharp = 50
    tile = 0.064 * k ** 0.6
    pg.uv = np.stack([((pg.v - O) @ a) / tile, ((pg.v - O) @ u + (pg.v @ ex) * 0.3) / tile], axis=1)
    S.add(pg, mat_maple)

    # ---------------- scroll (volute) ----------------
    R0 = 0.019 * k
    fct = 0.58
    turns = 3.0
    th0 = -math.pi / 3  # start behind the eye so the throat grows out of the pegbox floor
    s_c = pb_len + 0.013 * k
    t_c = -0.008 * k
    w_throat = w_nut * 0.9 * 1.03
    w_eye = 0.0355 * k if k < 1.5 else 0.0355 * k * 0.93
    th_max = turns * 2 * math.pi
    r_end = R0 * fct ** turns
    def r_of(th):
        return R0 * fct ** (np.asarray(th) / (2 * math.pi))
    def w_of(th):
        rr = r_of(th)
        fr = np.clip((rr - r_end) / (R0 - r_end), 0, 1)
        return w_throat + (w_eye - w_throat) * (1 - fr) ** 2.0
    n_th = int(turns * 18)
    ths = np.linspace(th0, th_max, n_th)
    secs = []
    for th in ths:
        ro = r_of(th)
        ri = r_of(th + 2 * math.pi) if th + 2 * math.pi <= th_max + 1e-9 else r_of(th) * fct * 0.9
        ri = max(ri, 0.0006 * k)
        w = w_of(th)
        band = ro - ri
        # fluting: two channels either side of a central spine on the first turn
        fd = 0.16 * band * smoothstep(th0, th0 + 0.6, th) * (1 - smoothstep(5.0, 7.0, th))
        rr = min(0.22 * band, 0.12 * w)
        g = min(0.32 * band, 0.16 * w)  # groove: side face slopes inward toward the next turn
        xs = np.linspace(-w / 2 + rr, w / 2 - rr, 7)
        q = np.abs(xs) / (w / 2 - rr)
        outer = [(x, ro - fd * np.sin(math.pi * q_) ** 1.2) for x, q_ in zip(xs, q)]
        prof = ([(-w / 2, ro - rr)] + outer +
                [(w / 2, ro - rr), (w / 2 - g * 0.25, ro - band * 0.45), (w / 2 - g, ri + band * 0.12),
                 (w / 2 - g * 1.05, ri), (-w / 2 + g * 1.05, ri), (-w / 2 + g, ri + band * 0.12),
                 (-w / 2 + g * 0.25, ro - band * 0.45)])
        prof = np.array(prof)  # (x, rho)
        phi = -math.pi / 2 + th
        cs, sn = math.cos(phi), math.sin(phi)
        s_pts = s_c + prof[:, 1] * cs
        t_pts = t_c + prof[:, 1] * sn
        secs.append(P(s_pts, t_pts, prof[:, 0]))
    vol = C.loft(secs, closed=True, cap_start=False, cap_end=True, sharp=None)
    # orientation: first station outer face should point along -u (down/back)
    f0 = vol.f[3]
    va, vb, vc = vol.v[list(f0[:3])]
    if np.dot(np.cross(vb - va, vc - va), -u) < 0:
        vol.flip()
    vol.uv = np.stack([((vol.v - O) @ a) / tile, ((vol.v - O) @ u) / tile + (vol.v @ ex) * 0.0], axis=1)
    S.add(vol, mat_maple)
    # eye bosses
    eye_r = r_end * 1.15
    for sgn in (1, -1):
        e = C.ellipsoid((0, 0, 0), (eye_r, eye_r, 0.0022 * k), 12, 6)
        # ellipsoid axes: x,y in the (a,u) plane, z along the lateral axis
        M = C.basis(a, u, ex * sgn)
        e.apply(M)
        e.translate(P(s_c, t_c, sgn * (w_eye / 2 - 0.0016 * k)))
        e.uv = np.stack([((e.v - O) @ a) / tile, ((e.v - O) @ u) / tile], axis=1)
        S.add(e, mat_maple)

    # ---------------- pegs ----------------
    pegs = []
    peg_pos = [(+1, 0.056), (+1, 0.030), (-1, 0.017), (-1, 0.043)]  # string 0..3 (low -> high)
    peg_geo = []
    shaft_pts = []
    for (side, s_), in zip(peg_pos):
        s_ = s_ * k
        f = np.clip(s_ / pb_len, 0, 1)
        w = w_nut * (1.0 - 0.1 * f)
        tb = -(0.0205 * k) + 0.002 * k * f
        tm = tb + 0.0105 * k
        # peg axis: lateral, tilted slightly back
        axis = C.norm(ex * side + a * 0.08 - u * 0.1)
        base = P(s_, tm, 0.0)
        # shaft through both cheeks
        p_in = base - axis * (w / 2 + 0.002 * k)
        p_out = base + axis * (w / 2 + 0.0035 * k)
        peg_geo.append(C.cylinder(p_in, p_out, 0.0028 * k, 0.0034 * k, 8))
        # collar
        c0 = base + axis * (w / 2 + 0.0015 * k)
        c1 = base + axis * (w / 2 + 0.0055 * k)
        peg_geo.append(C.tube([c0, c0 + axis * 0.0008 * k, c1 - axis * 0.0008 * k, c1],
                              [0.0036 * k, 0.0043 * k, 0.0043 * k, 0.0036 * k], 10, True, True))
        # head: lathe profile along the peg axis (collar, neck, bulb, pip), squashed along the pegbox axis
        prof = [(0.0036, 0.0), (0.0040, 0.0015), (0.0034, 0.0035), (0.0048, 0.0060), (0.0085, 0.0100),
                (0.0105, 0.0150), (0.0100, 0.0200), (0.0078, 0.0240), (0.0040, 0.0262), (0.0026, 0.0270),
                (0.0028, 0.0285), (0.0018, 0.0300), (0.0, 0.0303)]
        hd = C.lathe([(r_ * k * 0.95, y_ * k * 0.78) for r_, y_ in prof], 10, cap_start=True)
        hd.scale(1.0, 1.0, 0.42)  # lathe axis = +Y; squash along local z
        yv = C.norm(np.cross(a, axis))
        zv = np.cross(axis, yv)
        hd.apply(C.basis(yv, axis, zv))
        hd.translate(base + axis * (w / 2 + 0.0045 * k))
        peg_geo.append(hd)
        shaft_pts.append((base, axis, w))
    S.add(Geo.merge(peg_geo), mat_ebony)
    return dict(shafts=shaft_pts, O=O, a=a, u=u, P=P)


# ---------------------------------------------------------------------------
# bridge, tailpiece, fittings
# ---------------------------------------------------------------------------

def bridge_outline(bs):
    """Normalised bridge outline (x in [-0.5,0.5] of width, y in [0,1] of height) + holes."""
    ah = bs["arch_h"]
    fw = bs["feet"]  # feet span relative to top width
    ny = bs["notch_y"]
    right = []
    # central arch between the feet (semi-ellipse)
    for ang in np.linspace(math.pi / 2, 0, 9):
        right.append((0.22 * fw * math.cos(ang), ah * math.sin(ang)))
    # foot
    right += [(0.23 * fw, 0.0), (0.5 * fw, 0.0), (0.5 * fw - 0.005, 0.035)]
    # outer leg edge rising to the side notch
    right += [(0.47 * fw - 0.01, 0.09), (0.44 - 0.02 * (1 - fw), ny - 0.16), (0.42, ny - 0.07),
              (0.375, ny - 0.02), (0.355, ny + 0.02), (0.37, ny + 0.06), (0.42, ny + 0.1), (0.445, ny + 0.15),
              (0.44, ny + 0.24)]
    # upper side up to the top corner, then top arch
    right += [(0.43, 0.9), (0.42, 0.955)]
    for xx in np.linspace(0.40, 0.0, 8):
        right.append((xx, 0.955 + 0.045 * (1 - (xx / 0.42) ** 2)))
    right = np.array(right)
    left = right[::-1].copy()
    left[:, 0] *= -1
    outer = np.concatenate([right[:-1], left[1:-1]])
    # make CCW
    area = 0.5 * np.sum(outer[:, 0] * np.roll(outer[:, 1], -1) - np.roll(outer[:, 0], -1) * outer[:, 1])
    if area < 0:
        outer = outer[::-1]
    holes = []
    # heart
    hy = bs["heart_y"]
    heart = []
    for tt in np.linspace(0, 2 * math.pi, 16, endpoint=False):
        x = 16 * math.sin(tt) ** 3
        y = 13 * math.cos(tt) - 5 * math.cos(2 * tt) - 2 * math.cos(3 * tt) - math.cos(4 * tt)
        heart.append((x / 16 * 0.075, hy + y / 17 * 0.085))
    holes.append(np.array(heart)[::-1])
    # kidneys
    ky = bs["kid_y"]
    for sgn in (1, -1):
        kid = []
        for tt in np.linspace(0, 2 * math.pi, 14, endpoint=False):
            x = 0.075 * math.cos(tt)
            y = 0.045 * math.sin(tt) + 0.02 * math.cos(tt) ** 2
            ang = sgn * 0.5
            xr = x * math.cos(ang) - y * math.sin(ang)
            yr = x * math.sin(ang) + y * math.cos(ang)
            kid.append((sgn * 0.2 + xr, ky + yr))
        kid = np.array(kid)
        a2 = 0.5 * np.sum(kid[:, 0] * np.roll(kid[:, 1], -1) - np.roll(kid[:, 0], -1) * kid[:, 1])
        if a2 > 0:
            kid = kid[::-1]
        holes.append(kid)
    return outer, holes


def build_bridge(S, spec, bw, mat_bridge):
    bs = spec["bridge"]
    Wt = 2 * abs(bw["bridgeX"][0]) + 0.0075 * (spec["L"] / 0.356) ** 0.7
    y_top = bw["bridgeY"] - max(spec["string_r"]) * 0.6
    y_foot = spec["peak"] - 0.0015 * (spec["L"] / 0.356) ** 0.5
    H = y_top - y_foot
    outer, holes = bridge_outline(bs)
    t0, t1 = bs["t"]
    bz = bw["bridgeZ"]
    loops = [np.stack([l[:, 0] * Wt, l[:, 1]], axis=1) for l in [outer] + holes]

    def m3(p, zz):
        x, yn = p
        th = t0 + (t1 - t0) * yn
        # zz in [-1, 1]: back / front face; the back face (tailpiece side) is vertical, front tapers
        z = bz + (zz * 0.5 + 0.5) * th - t0 * 0.5
        return np.array([x, y_foot + yn * H, z])
    g = C.extrude(loops, -1.0, 1.0, map3d=m3, sharp=35)
    g.uv = np.stack([g.v[:, 0] / Wt * 0.9 + 0.5, (g.v[:, 1] - y_foot) / H * 0.9 + 0.05], axis=1)
    S.add(g, mat_bridge)


def build_tailpiece(S, spec, bw, body, mat_ebony, mat_metal, mat_strings):
    k = spec["L"] / 0.356
    L_t = spec["tail_len"]
    w_top, w_bot = spec["tail_w"]
    z_top = bw["bridgeZ"] - (bw["nutZ"] - bw["bridgeZ"]) / 6.0 - 0.004 * k
    z_bot = z_top - L_t
    y_rt = body["y_rt"]
    y_top_plate = arch_height(np.array([0.0]), np.array([z_top]), spec["_top_poly"], lambda z: halfwidth_at(spec["_top_poly"], z), spec, "top")[0]
    y_hi = y_top_plate + 0.011 * k ** 0.85
    y_lo = body["y_et"] + 0.0045 * k ** 0.85
    zs = np.linspace(z_bot, z_top, 14)
    secs = []
    for z in zs:
        f = (z - z_bot) / (z_top - z_bot)
        # plan shape: slightly concave sides, rounded wide end
        w = w_bot + (w_top - w_bot) * (f ** 0.9)
        if f > 0.9:
            w *= math.sqrt(max(1 - ((f - 0.9) / 0.1) ** 2 * 0.55, 0.05))
        yc = y_lo + (y_hi - y_lo) * f
        th = 0.0055 * k ** 0.8
        n = 11
        xs = np.linspace(-w / 2, w / 2, n)
        q = xs / (w / 2)
        top = yc + th * 0.5 + 0.0018 * k ** 0.8 * (1 - q ** 2)
        loop = [(x, y) for x, y in zip(xs[::-1], top[::-1])]
        loop += [(-w / 2 * 0.96, yc - th * 0.5), (w / 2 * 0.96, yc - th * 0.5)]
        secs.append(np.array([[x, y, z] for x, y in loop]))
    g = C.loft(secs, closed=True, cap_start=True, cap_end=True, sharp=45)
    f0 = g.f[len(g.f) // 2]
    va, vb, vc = g.v[list(f0[:3])]
    if np.cross(vb - va, vc - va)[1] < 0 and abs(np.cross(vb - va, vc - va)[1]) > abs(np.cross(vb - va, vc - va)[0]):
        g.flip()
    S.add(g, mat_ebony)
    # fret (string bar) at the wide end
    fret = C.cylinder((-w_top * 0.42, y_hi + 0.004 * k ** 0.8, z_top - 0.006 * k), (w_top * 0.42, y_hi + 0.004 * k ** 0.8, z_top - 0.006 * k),
                      0.0016 * k ** 0.8, sides=6)
    S.add(fret, mat_ebony)
    # saddle and tail gut
    sad = C.box((0, body["y_et"] + 0.0015 * k ** 0.8, 0.0035 * k), (w_bot * 1.25, 0.004 * k ** 0.8, 0.007 * k), sharp=30)
    S.add(sad, mat_ebony)
    gut = C.tube([(0.004 * k, y_lo, z_bot + 0.004 * k), (0.004 * k, body["y_et"] + 0.004 * k ** 0.8, 0.004 * k),
                  (0.003 * k, (body["y_rt"] + body["y_rb"]) * 0.5 + 0.006 * k, -0.006 * k)], 0.0011 * k ** 0.8, 5)
    gut2 = C.tube([(-0.004 * k, y_lo, z_bot + 0.004 * k), (-0.004 * k, body["y_et"] + 0.004 * k ** 0.8, 0.004 * k),
                   (-0.003 * k, (body["y_rt"] + body["y_rb"]) * 0.5 + 0.006 * k, -0.006 * k)], 0.0011 * k ** 0.8, 5)
    S.add(Geo.merge([gut, gut2]), mat_ebony)
    anchors = []
    for i, bx in enumerate(bw["bridgeX"]):
        anchors.append(np.array([bx * 0.62, y_hi + 0.0045 * k ** 0.8, z_top - 0.006 * k]))
    if spec["fine_tuner"]:
        # E-string fine tuner: body plate, screw, lever
        x = bw["bridgeX"][3] * 0.62
        base = np.array([x, y_hi + 0.002, z_top - 0.016])
        ft = [C.box(base + [0, 0.0015, 0], (0.0065, 0.0025, 0.016), sharp=30),
              C.cylinder(base + [0, 0.002, -0.004], base + [0, 0.0105, -0.004], 0.0018, sides=10),
              C.cylinder(base + [0, 0.0105, -0.004], base + [0, 0.012, -0.004], 0.0032, sides=12),
              C.tube([base + [0, 0.004, -0.007], base + [0, 0.0055, 0.004], base + [0, 0.0045, 0.009]], 0.0011, 5)]
        S.add(Geo.merge(ft), mat_metal)
        anchors[3] = base + np.array([0, 0.0045, 0.009])
    return anchors


def build_strings(S, spec, bw, tail_pts, head, mat_strings):
    geos = []
    by, ny = bw["bridgeY"], bw["nutY"]
    bz, nz = bw["bridgeZ"], bw["nutZ"]
    for k in range(4):
        r = spec["string_r"][k]
        pb = np.array([bw["bridgeX"][k], by, bz])
        pn = np.array([bw["nutX"][k], ny, nz])
        geos.append(C.tube([tail_pts[k], pb], r, 5))
        geos.append(C.tube([pb, pn], r, 5))
        base, axis, w = head["shafts"][k]
        # string winds onto the peg shaft inside the box
        x_on = np.clip(pn[0] * 0.5 + (0.3 if k < 2 else -0.3) * w * 0.3, -w * 0.3, w * 0.3)
        pw = base + axis * (x_on * np.sign(axis[0]) if axis[0] != 0 else 0)
        pw = base + np.array([x_on, 0, 0]) + head["u"] * 0.0032 * spec["head"]
        geos.append(C.tube([pn + np.array([0, 0, 0.001]), pn + (pw - pn) * 0.3 + head["u"] * 0.001, pw], r, 5))
    S.add(Geo.merge(geos), mat_strings)


def build_chinrest(S, spec, body, mat_ebony, mat_metal, rib_poly):
    k = spec["L"] / 0.356
    anc = CONTRACT[spec["_kind"]]["root"]["anchors"]["anchor_chinrest"]
    cx, cy, cz = anc
    # cup: kidney-shaped dish whose rim passes just above the anchor, on a narrower waist and foot
    rx, rz = 0.031 * k, 0.0235 * k
    ccx = cx + 0.002 * k
    ccz = cz - 0.006 * k
    rim_y = cy + 0.0012
    base_y = body["y_et"] - 0.0005
    prof = [(0.0, rim_y - 0.0052), (0.4, rim_y - 0.0046), (0.72, rim_y - 0.003), (0.9, rim_y - 0.0008),
            (0.965, rim_y), (1.0, rim_y - 0.0016), (0.985, rim_y - 0.0048), (0.9, rim_y - 0.0078),
            (0.7, rim_y - 0.0098), (0.55, (rim_y - 0.0098) * 0.5 + base_y * 0.5), (0.52, base_y + 0.003),
            (0.56, base_y)]
    n = 20
    ang = np.linspace(0, 2 * math.pi, n, endpoint=False)
    # kidney plan: indent on the tailpiece side (-x)
    plan_r = 1 - 0.16 * np.clip(np.cos(ang - math.pi), 0, 1) ** 3
    rings = []
    for rr, yy in prof:
        rr = max(rr, 1e-4)
        rings.append(np.stack([ccx + np.cos(ang) * rx * rr * plan_r, np.full(n, yy), ccz + np.sin(ang) * rz * rr * plan_r], axis=1))
    g = C.loft(rings, closed=True, cap_end=True)
    # orientation: the dish (first band) normal should point up
    f0 = g.f[n]
    va, vb, vc = g.v[list(f0[:3])]
    if np.cross(vb - va, vc - va)[1] < 0:
        g.flip()
    S.add(g, mat_ebony)
    # clamp barrels on the rib at the tail
    R = np.asarray(rib_poly)
    low = R[R[:, 1] < spec["L"] * 0.3]
    parts = []
    for xx in (ccx - 0.012 * k, ccx + 0.012 * k):
        zr = np.interp(abs(xx), np.sort(np.abs(low[:, 0])), low[np.argsort(np.abs(low[:, 0])), 1])
        zz = zr - 0.0022 * k
        parts.append(C.cylinder((xx, body["y_rt"] - 0.001, zz), (xx, body["y_rb"] + 0.003, zz), 0.0019 * k, sides=10))
        parts.append(C.cylinder((xx, body["y_rt"] + 0.0005, zz + 0.0005), (xx, body["y_rt"] + 0.0005, zz + 0.006 * k), 0.0012 * k, sides=6))
    S.add(Geo.merge(parts), mat_metal)


def build_endpin(S, spec, body, mat_ebony, mat_metal, kind):
    k = spec["L"] / 0.356
    ep = spec["endpin"]
    anc = CONTRACT[kind]["root"]["anchors"].get("anchor_endpin")
    if anc is None:
        # violin/viola: small end button
        ym = (body["y_rt"] + body["y_rb"]) * 0.5
        g = C.lathe([(0.0, -0.0075), (0.0028, -0.0072), (0.0042, -0.005), (0.0045, -0.002), (0.0055, -0.0005), (0.0055, 0.0005)], 12)
        g.v[:, 1] *= k ** 0.5
        g.v[:, [0, 2]] *= k ** 0.5
        # lathe axis is +Y: rotate so the axis runs along +Z, button pointing to -Z
        g.apply(C.rot_axis((1, 0, 0), math.pi / 2))
        g.translate(0, ym, 0.0)
        S.add(g, mat_ebony)
        return
    ax, ay, az = anc
    # socket (ebony cone) at the tail block and the steel pin to the contract tip
    sock = C.lathe([(0.0, -0.028 * k ** 0.5), (0.010 * k ** 0.5, -0.026 * k ** 0.5), (0.014 * k ** 0.5, -0.012 * k ** 0.5),
                    (0.017 * k ** 0.5, 0.0), (0.018 * k ** 0.5, 0.004)], 16)
    sock.apply(C.rot_axis((1, 0, 0), math.pi / 2))
    sock.translate(0, ay, 0.0)
    S.add(sock, mat_ebony)
    r = 0.0045 if kind == "cello" else 0.0065
    pin = C.cylinder((0, ay, -0.02 * k ** 0.5), (0, ay, az + 0.012), r, sides=10)
    tip = C.lathe([(r * 1.2, 0.0), (r * 1.5, -0.004), (r * 1.4, -0.009), (0.0, -0.0125)], 10, cap_start=True)
    tip.apply(C.rot_axis((1, 0, 0), -math.pi / 2))
    tip.translate(0, ay, az + 0.0125)
    collar = C.cylinder((0, ay, -0.028 * k ** 0.5), (0, ay, -0.04 * k ** 0.5), r * 2.2, sides=12)
    S.add(Geo.merge([pin, collar]), mat_metal)
    S.add(tip, mat_ebony)


def build_bass_machines(S, spec, head, mat_brass, mat_metal):
    """Double bass machine heads: brass plates on the cheeks, worm keys pointing back."""
    k = spec["head"]
    P, a, u, O = head["P"], head["a"], head["u"], head["O"]
    geos = []
    metal = []
    for side in (1, -1):
        shafts = [sh for sh in head["shafts"] if np.sign(sh[1][0]) == side]
        if not shafts:
            continue
        w = shafts[0][2]
        plate_c = (shafts[0][0] + shafts[-1][0]) / 2
        L_pl = abs((shafts[0][0] - shafts[-1][0]) @ a) + 0.03 * k
        pl = C.box((0, 0, 0), (0.0015 * k, 0.02 * k, L_pl), sharp=30)
        pl.apply(C.basis(np.array([1.0, 0, 0]), u, a))
        pl.translate(plate_c + np.array([side * (w / 2 + 0.001 * k), 0, 0]))
        geos.append(pl)
        for base, axis, w_ in shafts:
            gear_c = base + np.array([side * (w_ / 2 + 0.004 * k), 0, 0])
            geos.append(C.cylinder(gear_c - np.array([side * 0.002 * k, 0, 0]), gear_c + np.array([side * 0.002 * k, 0, 0]), 0.0065 * k, sides=12))
            # worm shaft running back (-u) past the pegbox, key at the end
            w0 = gear_c + np.array([side * 0.004 * k, 0, 0]) + u * 0.004 * k
            w1 = w0 - u * 0.03 * k
            metal.append(C.cylinder(w0, w1, 0.0013 * k, sides=8))
            key = C.ellipsoid((0, 0, 0), (0.0022 * k, 0.009 * k, 0.0065 * k), 10, 6)
            key.apply(C.basis(np.array([1.0, 0, 0]), u, a))
            key.translate(w1 - u * 0.008 * k)
            geos.append(key)
    S.add(Geo.merge(geos), mat_brass)
    S.add(Geo.merge(metal), mat_metal)


# ---------------------------------------------------------------------------
# instrument
# ---------------------------------------------------------------------------

def build_instrument(kind):
    spec = dict(SPEC[kind])
    spec["_kind"] = kind
    # body width: fill the TS bounds (outline max half width = bounds max x minus the edge rounding)
    spec["lower"] = 2 * (CONTRACT[kind]["root"]["bounds"]["max"][0] - 0.0006)
    bw = CONTRACT[kind]["bowed"]
    k = spec["L"] / 0.356
    C.reset_scene()
    S = C.Scene(kind)
    top_poly_tex = full_outline(spec, 0.0012 * k)
    top_poly = full_outline(spec, 0.0068 * k)
    back_poly = full_outline(spec, 0.0068 * k, button=spec["button"])
    back_poly_tex = full_outline(spec, 0.0012 * k, button=spec["button"])
    spec["_top_poly"] = top_poly_tex
    rib_poly = offset_poly(top_poly, -spec["overhang"])

    atlas, mapping = plate_textures(spec, top_poly_tex, back_poly_tex, 1024)
    img_pl = C.make_image(f"{kind}_plates", atlas)
    img_mp = C.make_image(f"{kind}_maple", maple_tile(512, seed=3 + len(kind)))
    img_br = C.make_image(f"{kind}_bridge", bridge_tex(256))
    m_pl = S.mat("varnish_plates", tex=img_pl, roughness=0.42, coat=1.0, coat_roughness=0.06)
    m_mp = S.mat("varnish_maple", tex=img_mp, roughness=0.42, coat=1.0, coat_roughness=0.06)
    m_eb = S.mat("ebony", color=(0.035, 0.03, 0.028), roughness=0.36)
    m_br = S.mat("bridge_maple", tex=img_br, roughness=0.62)
    m_st = S.mat("strings", color=(0.80, 0.78, 0.74), metallic=1.0, roughness=0.3)
    m_me = S.mat("silver", color=(0.92, 0.92, 0.93), metallic=1.0, roughness=0.15)

    body = build_body(S, spec, m_pl, m_mp, mapping, top_poly, back_poly, rib_poly)
    fbinfo = build_fingerboard(S, spec, bw, m_eb)
    build_neck(S, spec, bw, fbinfo, body, m_mp)
    head = build_head(S, spec, bw, fbinfo, m_mp, m_eb, m_st, m_me)
    build_bridge(S, spec, bw, m_br)
    tail_pts = build_tailpiece(S, spec, bw, body, m_eb, m_me, m_st)
    build_strings(S, spec, bw, tail_pts, head, m_st)
    if spec["chinrest"]:
        build_chinrest(S, spec, body, m_eb, m_me, rib_poly)
    build_endpin(S, spec, body, m_eb, m_me, kind)
    if kind == "bass":
        m_bz = S.mat("brass", color=(0.88, 0.70, 0.38), metallic=1.0, roughness=0.25)
        build_bass_machines(S, spec, head, m_bz, m_me)

    for name, pos in CONTRACT[kind]["root"]["anchors"].items():
        S.anchor(name, pos)
    C.log(kind, "triangles", S.tri_count())
    S.build()
    C.export_glb(os.path.join(C.OUT_DIR, f"{kind}.glb"))


# ---------------------------------------------------------------------------
# bows
# ---------------------------------------------------------------------------

BOW = {
    "violin": dict(r=(0.0043, 0.00265), frog_w=0.0115, hair_w=0.0095, head_h=1.0),
    "viola": dict(r=(0.0045, 0.0028), frog_w=0.012, hair_w=0.0105, head_h=1.05),
    "cello": dict(r=(0.0051, 0.0033), frog_w=0.0135, hair_w=0.012, head_h=1.25),
    "bass": dict(r=(0.0056, 0.0037), frog_w=0.0155, hair_w=0.014, head_h=1.45),
}


def build_bow(kind):
    bw = CONTRACT[kind]["bowed"]
    bs = BOW[kind]
    L = bw["bowLength"]
    gap = bw["hairGap"]
    C.reset_scene()
    name = f"{kind}_bow"
    S = C.Scene(name)
    m_st = S.mat("pernambuco", color=(0.33, 0.12, 0.045), roughness=0.3, coat=0.6, coat_roughness=0.1)
    m_eb = S.mat("ebony", color=(0.035, 0.03, 0.028), roughness=0.28)
    m_me = S.mat("silver", color=(0.92, 0.92, 0.93), metallic=1.0, roughness=0.15)
    m_hr = S.mat("hair", color=(0.94, 0.92, 0.86), roughness=0.75)
    m_iv = S.mat("ivory", color=(0.94, 0.9, 0.8), roughness=0.3)
    r0, r1 = bs["r"]
    hh = bs["head_h"]

    def camber(z):
        t = (np.asarray(z) + 0.03) / (L + 0.03)
        return -gap * 0.35 * np.sin(np.pi * t) + gap * 0.15 * t

    def radius(z):
        f = np.clip((np.asarray(z) - 0.09) / (L - 0.09), 0, 1)
        return r0 + (r1 - r0) * f ** 0.85

    # stick: octagonal part, then round part
    z_head = L - 0.018 * hh
    za = np.linspace(-0.012, 0.23, 8)
    zb = np.linspace(0.23, z_head, 20)
    for zs, sides, sharp in ((za, 8, 30), (zb, 10, None)):
        path = np.stack([np.zeros_like(zs), camber(zs), zs], axis=1)
        g = C.tube(path, radius(zs), sides, up_hint=(0, 1, 0), sharp=sharp, phase=math.pi / 8 if sides == 8 else 0)
        S.add(g, m_st)
    # button (adjuster): silver - ebony - silver
    y0 = camber(-0.012)
    btn = []
    for z0_, z1_, rr, m in ((-0.0125, -0.015, r0 * 1.0, m_me), (-0.015, -0.026, r0 * 0.98, m_eb), (-0.026, -0.0285, r0 * 0.98, m_me)):
        g = C.cylinder((0, y0, z0_), (0, y0, z1_), rr, sides=12)
        S.add(g, m)
    cap = C.ellipsoid((0, y0, -0.0288), (r0 * 0.8, r0 * 0.8, 0.0012), 12, 4)
    S.add(cap, m_me)
    # thumb leather + silver winding
    zl0, zl1 = 0.037, 0.057
    S.add(C.tube(np.stack([np.zeros(2), camber(np.array([zl0, zl1])), [zl0, zl1]], axis=1), radius(np.array([zl0, zl1])) + 0.0007, 10, True, True), m_eb)
    zw = np.linspace(zl1, 0.125, 5)
    S.add(C.tube(np.stack([np.zeros(5), camber(zw), zw], axis=1), radius(zw) + 0.00045, 10, True, True), m_me)
    # frog: side profile extruded across x, tapering toward the stick
    fw = bs["frog_w"]
    yb = -gap - 0.0009
    ys = camber(0.0) - r0 * 0.92
    sc = gap / 0.015
    prof = [(0.031, ys), (0.0285, ys - 0.0022 * sc), (0.0285, ys - 0.006 * sc), (0.0305, yb + 0.0035 * sc),
            (0.0345, yb + 0.0012), (0.0355, yb), (-0.004, yb), (-0.0075, yb + 0.0012 * sc), (-0.0098, yb + 0.004 * sc),
            (-0.0102, ys - 0.0035 * sc), (-0.0088, ys - 0.0008), (-0.0078, ys)]
    prof = np.array(prof)  # (z, y)
    loop = np.stack([prof[:, 0], prof[:, 1]], axis=1)
    area = 0.5 * np.sum(loop[:, 0] * np.roll(loop[:, 1], -1) - np.roll(loop[:, 0], -1) * loop[:, 1])
    if area < 0:
        loop = loop[::-1]

    def m3(p, xx):
        z, y = p
        f = np.clip((y - yb) / (ys - yb), 0, 1)
        half = fw / 2 * (1 - 0.3 * f)
        return np.array([xx * half, y, z])
    frog = C.extrude([loop], -1.0, 1.0, map3d=m3, sharp=40)
    S.add(frog, m_eb)
    # pearl eyes
    for sgn in (1, -1):
        eye = C.ellipsoid((0, 0, 0), (0.0022 * sc ** 0.5, 0.0022 * sc ** 0.5, 0.0004), 10, 4)
        eye.apply(C.basis(np.array([0, 0, -sgn * 1.0]), np.array([0, 1.0, 0]), np.array([sgn * 1.0, 0, 0])))
        f_mid = np.clip(((yb + ys) / 2 - yb) / (ys - yb), 0, 1)
        eye.translate(sgn * (fw / 2 * (1 - 0.3 * f_mid) + 0.0001), (yb + ys) / 2 - 0.0005, 0.011)
        S.add(eye, m_iv)
    # ferrule + underslide + heel plate (silver)
    fer = C.box((0, yb + 0.0022 * sc, 0.033), (fw * 1.02, 0.0046 * sc, 0.004), sharp=30)
    slide = C.box((0, yb - 0.0002, 0.013), (fw * 0.92, 0.0007, 0.036), sharp=30)
    S.add(Geo.merge([fer, slide]), m_me)
    # hair ribbon
    hs, he = bw["hairStart"], bw["hairEnd"]
    hair = C.box((0, -gap, (hs + he) / 2 - 0.001), (bs["hair_w"], 0.0006, he - hs + 0.002), sharp=30)
    S.add(hair, m_hr)
    # head: side profile extruded, ivory face plate
    yt = camber(z_head)
    hp = [(z_head - 0.022 * hh, yt - radius(z_head) * 0.9), (z_head - 0.004 * hh, yt - radius(z_head) * 0.95),
          (L - 0.0125 * hh, -gap * 0.55), (L - 0.0125 * hh, -gap - 0.0008), (L - 0.001, -gap - 0.0008),
          (L + 0.0065 * hh, yt + 0.001 * hh), (L + 0.001, yt + radius(z_head) * 1.05),
          (z_head - 0.005 * hh, yt + radius(z_head) * 1.02), (z_head - 0.022 * hh, yt + radius(z_head) * 0.95)]
    hp = np.array(hp)
    area = 0.5 * np.sum(hp[:, 0] * np.roll(hp[:, 1], -1) - np.roll(hp[:, 0], -1) * hp[:, 1])
    if area < 0:
        hp = hp[::-1]
    hw = r1 * 1.3

    def m3h(p, xx):
        z, y = p
        return np.array([xx * hw, y, z])
    head = C.extrude([hp], -1.0, 1.0, map3d=m3h, sharp=35)
    S.add(head, m_st)
    # ivory plate on the front face: from bottom-front to the point
    a = np.array([0.0, -gap - 0.0008, L - 0.001])
    b = np.array([0.0, yt + 0.001 * hh, L + 0.0065 * hh])
    face_dir = C.norm(b - a)
    nrm = C.norm(np.cross(face_dir, [1.0, 0, 0]))
    if nrm[2] < 0:
        nrm = -nrm
    plate_len = np.linalg.norm(b - a)
    pl = C.box((0, 0, 0), (hw * 2.02, plate_len * 0.98, 0.0012), sharp=30)
    pl.apply(C.basis(np.array([1.0, 0, 0]), face_dir, nrm))
    pl.translate((a + b) / 2 + nrm * 0.0005)
    S.add(pl, m_iv)
    for name_, pos in CONTRACT[kind]["bow"]["anchors"].items():
        S.anchor(name_, pos)
    C.log(name, "triangles", S.tri_count())
    S.build()
    C.export_glb(os.path.join(C.OUT_DIR, f"{name}.glb"))


def main():
    args = C.script_args()
    targets = args or ["violin", "viola", "cello", "bass", "violin_bow", "viola_bow", "cello_bow", "bass_bow"]
    for t in targets:
        if t.endswith("_bow"):
            build_bow(t[:-4])
        else:
            build_instrument(t)


if __name__ == "__main__":
    main()
