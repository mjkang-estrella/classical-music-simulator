"""
Tier-2 woodwinds: flute, piccolo, oboe, clarinet, bassoon.

  tools/blender/run.sh tools/blender/instruments/winds.py [flute piccolo oboe clarinet bassoon]

Frames follow src/assets/instruments/winds.ts:
  flute/piccolo: origin at the embouchure hole, +Z toward the foot, +Y keys up, tube axis at y = -r
  oboe/clarinet: origin at the reed / mouthpiece tip, +Z down the body, +Y front (tone holes)
  bassoon:       origin at the reed, body along +Y, bocal curving down to the wing joint
Grenadilla (blackwood) and red-brown maple are small tiling numpy textures; keys are silver.
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
Z_UP = (0, 0, 1)
PREVIEW_VIEWS = {
    "flute": [("main", dict(env=2.2, dir=(0.8, 0.9, 0.35), up=Y_UP)), ("keys", dict(dir=(0.5, 1, 0.2), up=Y_UP, focus=((-0.02, -0.03, 0.17), (0.02, 0.01, 0.40)))),
              ("head", dict(dir=(-0.4, 1, -0.4), up=Y_UP, focus=((-0.02, -0.03, -0.07), (0.02, 0.01, 0.06)))), ("side", dict(dir=(1, 0.01, 0), up=Y_UP, ortho=True))],
    "piccolo": [("main", dict(env=2.2, dir=(0.8, 0.9, 0.35), up=Y_UP)), ("keys", dict(dir=(0.5, 1, 0.2), up=Y_UP, focus=((-0.02, -0.03, 0.08), (0.02, 0.01, 0.25)))),
                ("head", dict(dir=(-0.4, 1, -0.4), up=Y_UP, focus=((-0.02, -0.03, -0.04), (0.02, 0.01, 0.04))))],
    "oboe": [("main", dict(env=2.2, dir=(0.8, 0.7, -0.35), up=(0, 0, -1))), ("front", dict(dir=(0.05, 1, 0), up=(0, 0, -1), ortho=True)),
             ("top", dict(dir=(0.6, 0.8, -0.3), up=(0, 0, -1), focus=((-0.03, -0.03, -0.01), (0.03, 0.03, 0.2)))), ("bell", dict(dir=(0.7, 0.6, 0.4), up=(0, 0, -1), focus=((-0.04, -0.04, 0.45), (0.04, 0.04, 0.66))))],
    "clarinet": [("main", dict(env=2.2, dir=(0.8, 0.7, -0.35), up=(0, 0, -1))), ("front", dict(dir=(0.05, 1, 0), up=(0, 0, -1), ortho=True)),
                 ("top", dict(dir=(0.6, 0.2, -0.3), up=(0, 0, -1), focus=((-0.03, -0.03, -0.01), (0.03, 0.03, 0.2)))), ("bell", dict(dir=(0.7, 0.6, 0.4), up=(0, 0, -1), focus=((-0.04, -0.04, 0.45), (0.04, 0.04, 0.67))))],
    "bassoon": [("main", dict(env=2.2, dir=(0.6, 0.15, -1.0), up=Y_UP)), ("side", dict(dir=(1, 0.05, 0.1), up=Y_UP)),
                ("boot", dict(dir=(0.5, 0.2, -1.0), up=Y_UP, focus=((-0.06, -0.63, 0.1), (0.06, -0.2, 0.3)))), ("reed", dict(dir=(1, 0.4, -0.4), up=Y_UP, focus=((-0.03, -0.14, -0.01), (0.03, 0.02, 0.21))))],
}

SILVER = dict(color=(0.92, 0.92, 0.93), metallic=1.0, roughness=0.15)


# ---------------------------------------------------------------------------
# textures + materials
# ---------------------------------------------------------------------------

def grenadilla_tex(res=256):
    H = W = res
    n1 = C.fbm(H, W, 3, 40, 3, seed=71)  # fine streaks along v
    n2 = C.fbm(H, W, 4, 4, 2, seed=72)
    base = np.array([0.075, 0.055, 0.048])
    streak = np.array([0.16, 0.10, 0.075])
    t = np.clip((n1 - 0.45) * 2.5, 0, 1) * (0.5 + 0.5 * n2)
    return C.lerp_color(base, streak, t * 0.8)


def bassoon_tex(res=512):
    """Stained flamed maple, red-brown, tileable, flames varying along v."""
    H = W = res
    v = (np.arange(H) + 0.5) / H
    n1 = C.fbm(H, W, 3, 3, 3, seed=81)
    n2 = C.fbm(H, W, 10, 5, 2, seed=82)
    ph = v[:, None] * 14 + (n1 - 0.5) * 1.5
    fl = np.clip(0.5 + 0.5 * np.sin(2 * math.pi * ph + (n2 - 0.5) * 2), 0, 1) ** 1.3
    base = np.array([0.42, 0.13, 0.05])
    light = np.array([0.62, 0.24, 0.09])
    dark = np.array([0.26, 0.07, 0.03])
    patch = 0.35 + 0.5 * C.fbm(H, W, 3, 2, 2, seed=84)
    rgb = C.lerp_color(base, light, np.clip((fl - 0.45) * 2, 0, 1) * 0.35 * patch)
    rgb = C.lerp_color(rgb, dark, np.clip((0.45 - fl) * 2, 0, 1) * 0.3 * patch)
    grain = C.fbm(H, W, 60, 4, 2, seed=83)
    return rgb * (0.92 + 0.12 * grain[..., None])


def new_scene(kind):
    C.reset_scene()
    S = C.Scene(kind)
    S.mat("silver", **SILVER)
    return S


def finish(S, kind):
    for name, pos in CONTRACT[kind]["root"]["anchors"].items():
        S.anchor(name, pos)
    C.log(kind, "triangles", S.tri_count())
    S.build()
    C.export_glb(os.path.join(C.OUT_DIR, f"{kind}.glb"))


# ---------------------------------------------------------------------------
# geometry helpers
# ---------------------------------------------------------------------------

def lathe_z(profile, segs=20, center=(0, 0), phase=0.0, cap_start=False, cap_end=False):
    """Revolve [(r, z)] around the +Z axis through (center.x, center.y)."""
    g = C.lathe(profile, segs, phase=phase, cap_start=cap_start, cap_end=cap_end)
    g.apply(C.rot_axis((1, 0, 0), math.pi / 2))  # +Y -> +Z
    g.translate(center[0], center[1], 0)
    return g


def lathe_y(profile, segs=20, center=(0, 0), cap_start=False, cap_end=False):
    """Revolve [(r, y)] around +Y through (x, z) = center."""
    g = C.lathe(profile, segs, cap_start=cap_start, cap_end=cap_end)
    g.translate(center[0], 0, center[1])
    return g


class Tube:
    """A straight cylindrical body along an axis, with helpers to put key work on its surface."""

    def __init__(self, origin, axis, radius_fn, up=(0, 1, 0)):
        self.o = np.asarray(origin, float)
        self.a = C.norm(np.asarray(axis, float))
        up = np.asarray(up, float)
        self.u = C.norm(up - np.dot(up, self.a) * self.a)  # phi = 0 direction
        self.v = np.cross(self.u, self.a)  # phi = +90deg direction
        self.r = radius_fn

    def radial(self, phi):
        return math.cos(phi) * self.u + math.sin(phi) * self.v

    def surf(self, s, phi, lift=0.0):
        return self.o + self.a * s + self.radial(phi) * (self.r(s) + lift)

    def cup(self, s, phi, rc, h=0.0016, open_hole=False, lift=0.0006, segs=14):
        n = self.radial(phi)
        if open_hole:
            prof = [(rc * 0.42, h * 0.7), (rc * 0.52, h), (rc * 0.88, h), (rc, h * 0.55), (rc, 0.0), (rc * 0.9, -0.0003)]
        else:
            prof = [(0.0, h * 1.05), (rc * 0.85, h), (rc, h * 0.55), (rc, 0.0), (rc * 0.9, -0.0003)]
        g = C.lathe(prof, segs)
        g.apply(C.rot_from_to((0, 1, 0), n))
        g.translate(self.surf(s, phi, lift))
        return g

    def ring(self, s, phi, rr, w=0.0007, segs=14):
        n = self.radial(phi)
        g = C.lathe([(rr - w, 0.0012), (rr + w, 0.0012), (rr + w, 0.0), (rr - w, 0.0)], segs)
        g.apply(C.rot_from_to((0, 1, 0), n))
        g.translate(self.surf(s, phi, 0.0))
        return g

    def hole(self, s, phi, rh, segs=12):
        n = self.radial(phi)
        g = C.lathe([(rh, 0.00035), (0.0, 0.0004)], segs)
        g.apply(C.rot_from_to((0, 1, 0), n))
        g.translate(self.surf(s, phi, 0.0))
        return g

    def rod(self, s0, s1, phi, dist, rr=0.0011, sides=6):
        p0 = self.o + self.a * s0 + self.radial(phi) * (self.r(s0) + dist)
        p1 = self.o + self.a * s1 + self.radial(phi) * (self.r(s1) + dist)
        return C.cylinder(p0, p1, rr, sides=sides)

    def post(self, s, phi, dist, rr=0.0011):
        p0 = self.surf(s, phi, -0.0005)
        p1 = self.surf(s, phi, dist + 0.0008)
        g = C.cylinder(p0, p1, rr, sides=6)
        return Geo.merge([g, C.ellipsoid(p1, (rr * 1.4,) * 3, 8, 4)])

    def arm(self, s_rod, phi_rod, dist, s_cup, phi_cup, rc):
        p0 = self.o + self.a * s_rod + self.radial(phi_rod) * (self.r(s_rod) + dist)
        p1 = self.surf(s_cup, phi_cup, 0.0018) - self.radial(phi_cup) * 0.0 + (self.radial(phi_rod) - self.radial(phi_cup)) * rc * 0.6
        return C.cylinder(p0, p1, 0.0009, sides=5)

    def lever(self, s0, s1, phi, lift, w=0.0035):
        """Flat touch piece lying on the surface from s0 to s1."""
        n = self.radial(phi)
        t = np.cross(self.a, n)
        c = (self.surf(s0, phi, lift) + self.surf(s1, phi, lift)) / 2
        g = C.box((0, 0, 0), (w, 0.0012, abs(s1 - s0)), sharp=30)
        g.apply(C.basis(t, n, self.a))
        g.translate(c)
        return g


# ---------------------------------------------------------------------------
# flute / piccolo
# ---------------------------------------------------------------------------

def build_flute(piccolo=False):
    kind = "piccolo" if piccolo else "flute"
    S = new_scene(kind)
    s = 0.5 if piccolo else 1.0
    r = 0.0072 if piccolo else 0.0095
    S.mat("dark", color=(0.02, 0.02, 0.02), roughness=0.6)
    if piccolo:
        S.mat("grenadilla", tex=C.make_image("piccolo_grenadilla", grenadilla_tex()), roughness=0.28, coat=0.7, coat_roughness=0.08)
        body_mat = "grenadilla"
    else:
        body_mat = "silver"
    Sv, Bd, Dk = [], [], []
    ax = (0.0, -r)
    z_crown, z_end = -0.058 * s, 0.615 * s
    z_head, z_foot = 0.19 * s, (0.53 * s if not piccolo else None)
    # tube sections (head joint silver even on the piccolo's lip area)
    def rad(z):
        if piccolo:
            return r * (1.0 - 0.12 * np.clip((z - 0.1) / 0.2, 0, 1))
        return r * (0.94 + 0.06 * np.clip((z - z_crown) / 0.2, 0, 1))
    zz = np.linspace(z_crown + 0.004 * s, z_end, 14)
    g = lathe_z([(rad(z), z) for z in zz], 22, center=ax)
    (Bd if piccolo else Sv).append(g)
    # crown + ferrules / tenon rings
    Sv.append(lathe_z([(0.0, z_crown - 0.006 * s), (r * 0.55, z_crown - 0.0058 * s), (r * 0.8, z_crown - 0.004 * s),
                       (r * 1.12, z_crown - 0.002 * s), (r * 1.12, z_crown + 0.006 * s), (rad(z_crown) * 1.0, z_crown + 0.007 * s)], 20, center=ax))
    rings = [z_head, z_end - 0.004 * s] + ([z_foot] if z_foot else []) + ([0.02 * s, 0.1 * s] if piccolo else [])
    for zr in rings:
        rr = rad(zr) * 1.09
        Sv.append(lathe_z([(rad(zr) * 0.99, zr - 0.006 * s), (rr, zr - 0.0055 * s), (rr, zr + 0.0055 * s), (rad(zr) * 0.99, zr + 0.006 * s)], 20, center=ax))
    # lip plate + embouchure hole + riser
    lp = C.ellipsoid((0, 0, 0), (r * 1.22, 0.003 * (r / 0.0095), 0.0158 * (r / 0.0095)), 18, 8)
    lp.translate(0, -r + r * 0.86, 0)
    lp.v[:, 1] = np.maximum(lp.v[:, 1], -r * 0.6)  # flatten the underside into the tube
    Sv.append(lp)
    top_y = -r + r * 0.86 + 0.003 * (r / 0.0095)
    Dk.append(C.ellipsoid((0, top_y - 0.00035, 0), (0.0046 * (r / 0.0095), 0.0004, 0.0059 * (r / 0.0095)), 14, 4))
    # ---- key work ----
    T = Tube((0, -r, 0), (0, 0, 1), lambda z: float(rad(z)))
    rod_phi, rod_d = 1.0, 0.0034 * (r / 0.0095) ** 0.5
    rc = 0.0069 if not piccolo else 0.0048
    cups = []  # (z, phi, radius, open)
    if not piccolo:
        cups = [(0.215, 0.9, 0.0042, False), (0.232, 0.9, 0.0042, False), (0.252, -0.1, rc, False), (0.285, -0.1, rc, True),
                (0.314, -0.1, rc, True), (0.330, 0.75, 0.0055, False), (0.358, -0.1, rc, False), (0.388, -0.1, rc, True),
                (0.418, -0.1, rc, True), (0.448, -0.1, rc, True), (0.482, 0.85, 0.0062, False), (0.505, -0.1, rc, False),
                (0.556, 0.95, rc, False), (0.586, 0.95, rc, False)]
    else:
        cups = [(0.12, -0.1, rc, False), (0.14, -0.1, rc, False), (0.158, -0.1, rc, False), (0.168, 0.8, 0.0035, False),
                (0.19, -0.1, rc, False), (0.21, -0.1, rc, False), (0.228, -0.1, rc, False), (0.247, 0.85, 0.004, False),
                (0.27, -0.1, rc, False)]
    for (z, phi, rcu, op) in cups:
        zz_ = z if not piccolo else z
        Sv.append(T.cup(zz_, phi, rcu, h=0.0022 * (r / 0.0095) ** 0.5, open_hole=op, lift=0.0011))
        if abs(phi - rod_phi) > 0.3:
            Sv.append(T.arm(zz_, rod_phi, rod_d, zz_, phi, rcu))
    z0 = cups[0][0] - 0.01 * s
    z1 = cups[-1][0] + 0.006 * s
    zsplit = [z0, 0.34 * s, 0.525 * s if not piccolo else z1, z1]
    for a_, b_ in zip(zsplit[:-1], zsplit[1:]):
        if b_ - a_ > 0.01:
            Sv.append(T.rod(a_, b_, rod_phi, rod_d, rr=0.0012 * (r / 0.0095) ** 0.5))
    for zp in np.linspace(z0 + 0.004, z1 - 0.004, 7 if not piccolo else 5):
        Sv.append(T.post(float(zp), rod_phi, rod_d, rr=0.001 * (r / 0.0095) ** 0.5))
    # thumb key (player side) + trill / pinky touches + foot rollers
    Sv.append(T.lever(0.255 * s, 0.28 * s, -1.7, 0.002))
    Sv.append(T.lever(0.37 * s, 0.39 * s, -1.0, 0.0022, w=0.003))
    if not piccolo:
        Sv.append(T.lever(0.49, 0.515, -0.8, 0.0025, w=0.0045))
        for zr in (0.535, 0.55):
            n = T.radial(-0.55)
            c = T.surf(zr, -0.55, 0.0035)
            Sv.append(C.cylinder(c - n * 0.0 + np.array([0, 0, -0.005]), c + np.array([0, 0, 0.005]), 0.0022, sides=10))
    S.add(Geo.merge(Sv), "silver")
    if Bd:
        S.add(Geo.merge(Bd), body_mat)
    S.add(Geo.merge(Dk), "dark")
    finish(S, kind)


# ---------------------------------------------------------------------------
# clarinet / oboe
# ---------------------------------------------------------------------------

def reed_body(profile, segs=22):
    return lathe_z(profile, segs, center=(0, 0))


def build_clarinet():
    S = new_scene("clarinet")
    S.mat("grenadilla", tex=C.make_image("clarinet_grenadilla", grenadilla_tex()), roughness=0.28, coat=0.7, coat_roughness=0.08)
    S.mat("ebonite", color=(0.02, 0.02, 0.022), roughness=0.22, coat=0.4)
    S.mat("cane", color=(0.86, 0.74, 0.47), roughness=0.55)
    Sv, Gw, Eb, Cn = [], [], [], []
    # mouthpiece: lathe then flatten the reed table on the back (-Y)
    mp = lathe_z([(0.0012, 0.0), (0.0055, 0.003), (0.0085, 0.012), (0.0102, 0.028), (0.0112, 0.05), (0.0118, 0.068),
                  (0.0112, 0.07), (0.0105, 0.078)], 20)
    zt = mp.v[:, 2]
    table = -(0.0018 + 0.0045 * np.clip(zt / 0.03, 0, 1))
    mp.v[:, 1] = np.maximum(mp.v[:, 1], table)
    Eb.append(mp)
    # reed on the table
    reed = C.box((0, 0, 0), (0.0128, 0.001, 0.066), sharp=30)
    reed.v[:, 1] += np.where(reed.v[:, 1] > 0, 0.0, 0.0)
    reed.v[:, 1] -= 0.0012 * (reed.v[:, 2] + 0.033) / 0.066 * (reed.v[:, 1] < 0)
    reed.translate(0, -0.0024, 0.034)
    reed.v[:, 1] = np.minimum(reed.v[:, 1], -(0.0016 + 0.0045 * np.clip(reed.v[:, 2] / 0.03, 0, 1)) + 0.0001)
    Cn.append(reed)
    # ligature: band + screws on the reed side
    Sv.append(lathe_z([(0.0114, 0.03), (0.0122, 0.0305), (0.0124, 0.043), (0.0116, 0.0435)], 20))
    for zz in (0.033, 0.041):
        Sv.append(C.cylinder((-0.009, -0.011, zz), (0.009, -0.011, zz), 0.0011, sides=6))
        for sx in (-1, 1):
            Sv.append(C.cylinder((sx * 0.009, -0.011, zz), (sx * 0.014, -0.011, zz), 0.0018, sides=8))
    # barrel, joints, bell
    Gw.append(lathe_z([(0.0118, 0.074), (0.0135, 0.078), (0.0145, 0.1), (0.0142, 0.13), (0.0136, 0.14)], 22))
    Gw.append(lathe_z([(0.0136, 0.14), (0.0133, 0.2), (0.0133, 0.37), (0.0136, 0.382)], 22))
    Gw.append(lathe_z([(0.0138, 0.382), (0.0137, 0.45), (0.0139, 0.55)], 22))
    Gw.append(lathe_z([(0.0139, 0.55), (0.015, 0.575), (0.0175, 0.6), (0.023, 0.625), (0.031, 0.645), (0.0355, 0.657),
                       (0.036, 0.66), (0.033, 0.66), (0.026, 0.645)], 30))
    for zr, rr in ((0.0765, 0.0137), (0.139, 0.0146), (0.141, 0.0142), (0.376, 0.0143), (0.386, 0.0144), (0.548, 0.0146),
                   (0.553, 0.0147), (0.656, 0.0366)):
        Sv.append(lathe_z([(rr * 0.97, zr - 0.0022), (rr, zr - 0.002), (rr, zr + 0.002), (rr * 0.97, zr + 0.0022)], 22))
    # ---- key work: front (+Y) tone holes with rings, side keys, rods either side ----
    T = Tube((0, 0, 0), (0, 0, 1), lambda z: 0.0133 if z < 0.38 else 0.0138)
    for z in (0.225, 0.252, 0.278, 0.43, 0.458, 0.486):
        Sv.append(T.ring(z, 0.0, 0.0052))
        Eb.append(T.hole(z, 0.0, 0.0042))
    # thumb hole + ring and register key on the back
    Sv.append(T.ring(0.205, math.pi, 0.0052))
    Eb.append(T.hole(0.205, math.pi, 0.0042))
    Sv.append(T.cup(0.182, math.pi * 0.92, 0.0035))
    Sv.append(T.lever(0.188, 0.21, math.pi * 0.8, 0.002, w=0.003))
    for (z, phi, rc) in ((0.16, 0.2, 0.0045), (0.172, -0.25, 0.0045), (0.19, 0.75, 0.004), (0.2, 0.9, 0.004), (0.215, 1.0, 0.004),
                         (0.237, 1.0, 0.004), (0.3, 0.6, 0.0055), (0.325, -0.6, 0.0055), (0.345, 0.5, 0.0055),
                         (0.4, 0.7, 0.0055), (0.505, -0.3, 0.0068), (0.525, 0.35, 0.0068), (0.54, -0.7, 0.0068)):
        Sv.append(T.cup(z, phi, rc))
        side = 1.05 if phi > 0 else -1.05
        Sv.append(T.arm(z, side, 0.0034, z, phi, rc))
    for side in (1.05, -1.05):
        Sv.append(T.rod(0.155, 0.37, side, 0.0034, rr=0.0012))
        Sv.append(T.rod(0.395, 0.545, side, 0.0034, rr=0.0012))
        for zp in (0.16, 0.25, 0.36, 0.4, 0.47, 0.54):
            Sv.append(T.post(zp, side, 0.0034))
    # long pinky keys (both sides) and trill keys
    for side in (1, -1):
        Sv.append(T.lever(0.33, 0.37, side * 1.4, 0.0026, w=0.004))
        Sv.append(T.lever(0.495, 0.52, side * 1.35, 0.0026, w=0.004))
        Sv.append(T.rod(0.33, 0.52, side * 1.45, 0.003, rr=0.0011))
    Sv.append(T.lever(0.245, 0.27, -1.2, 0.0024, w=0.0028))
    # thumb rest (back, lower joint)
    Sv.append(T.lever(0.405, 0.42, math.pi, 0.0028, w=0.006))
    S.add(Geo.merge(Gw), "grenadilla")
    S.add(Geo.merge(Sv), "silver")
    S.add(Geo.merge(Eb), "ebonite")
    S.add(Geo.merge(Cn), "cane")
    finish(S, "clarinet")


def build_oboe():
    S = new_scene("oboe")
    S.mat("grenadilla", tex=C.make_image("oboe_grenadilla", grenadilla_tex()), roughness=0.28, coat=0.7, coat_roughness=0.08)
    S.mat("cane", color=(0.86, 0.74, 0.47), roughness=0.5)
    S.mat("thread", color=(0.55, 0.08, 0.06), roughness=0.7)
    Sv, Gw, Cn, Th = [], [], [], []
    # double reed: two flattened cane blades, thread wrap, cork on the staple
    blade = lathe_z([(0.0003, 0.0), (0.003, 0.002), (0.0036, 0.012), (0.0033, 0.024), (0.0025, 0.03)], 16)
    blade.v[:, 1] *= 0.32
    Cn.append(blade)
    Th.append(lathe_z([(0.0024, 0.029), (0.0031, 0.03), (0.0031, 0.046), (0.0028, 0.047)], 14))
    Cn.append(lathe_z([(0.0028, 0.046), (0.0042, 0.047), (0.0045, 0.062), (0.0043, 0.064)], 14))  # cork
    # top joint, lower joint, bell (conical bore, outer turned profile)
    Gw.append(lathe_z([(0.0065, 0.061), (0.0095, 0.062), (0.0104, 0.075), (0.0106, 0.12), (0.0112, 0.2), (0.0116, 0.3)], 22))
    Gw.append(lathe_z([(0.0122, 0.307), (0.0124, 0.35), (0.0128, 0.45), (0.013, 0.52)], 22))
    Gw.append(lathe_z([(0.0131, 0.52), (0.0142, 0.55), (0.017, 0.585), (0.022, 0.615), (0.0255, 0.635), (0.0262, 0.643),
                       (0.024, 0.65), (0.021, 0.648)], 28))
    for zr, rr in ((0.062, 0.0101), (0.3, 0.0125), (0.31, 0.0129), (0.516, 0.0134), (0.524, 0.0139), (0.642, 0.0266)):
        Sv.append(lathe_z([(rr * 0.97, zr - 0.0022), (rr, zr - 0.002), (rr, zr + 0.002), (rr * 0.97, zr + 0.0022)], 22))
    T = Tube((0, 0, 0), (0, 0, 1), lambda z: 0.0106 + 0.0024 * np.clip((z - 0.06) / 0.46, 0, 1))
    # plateau keys / ring keys down the front
    for z in (0.17, 0.2, 0.232, 0.36, 0.392, 0.424):
        Sv.append(T.cup(z, 0.0, 0.0055, open_hole=True))
        Sv.append(T.arm(z, 1.0, 0.0028, z, 0.0, 0.0055))
    for (z, phi, rc) in ((0.1, 0.35, 0.004), (0.118, -0.35, 0.004), (0.135, 0.9, 0.0038), (0.15, -0.9, 0.0038), (0.26, 0.8, 0.0045),
                         (0.28, -0.8, 0.0045), (0.33, 0.6, 0.0048), (0.46, 0.7, 0.0052), (0.48, -0.7, 0.0052), (0.5, 0.2, 0.0055),
                         (0.555, 0.3, 0.0068), (0.575, -0.4, 0.0072)):
        Sv.append(T.cup(z, phi, rc))
        side = 1.0 if phi >= 0 else -1.0
        Sv.append(T.arm(z, side, 0.0028, z, phi, rc))
    for side in (1.0, -1.0, 1.6, -1.6):
        d = 0.0028 if abs(side) < 1.5 else 0.0024
        Sv.append(T.rod(0.09, 0.298, side, d, rr=0.001))
        Sv.append(T.rod(0.318, 0.51, side, d, rr=0.001))
        for zp in (0.095, 0.19, 0.29, 0.325, 0.42, 0.505):
            Sv.append(T.post(zp, side, d, rr=0.0009))
    # octave keys on the back / side, thumb plate, pinky keys
    Sv.append(T.lever(0.105, 0.135, math.pi, 0.0022, w=0.004))
    Sv.append(T.lever(0.15, 0.18, math.pi * 0.7, 0.0022, w=0.003))
    for side in (1, -1):
        Sv.append(T.lever(0.27, 0.3, side * 1.35, 0.0024, w=0.0035))
        Sv.append(T.lever(0.47, 0.5, side * 1.3, 0.0024, w=0.0035))
    Sv.append(T.lever(0.33, 0.345, math.pi, 0.0026, w=0.0055))  # thumb rest
    S.add(Geo.merge(Gw), "grenadilla")
    S.add(Geo.merge(Sv), "silver")
    S.add(Geo.merge(Cn), "cane")
    S.add(Geo.merge(Th), "thread")
    finish(S, "oboe")


# ---------------------------------------------------------------------------
# bassoon
# ---------------------------------------------------------------------------

def build_bassoon():
    S = new_scene("bassoon")
    S.mat("maple_red", tex=C.make_image("bassoon_maple", bassoon_tex()), roughness=0.3, coat=0.9, coat_roughness=0.06)
    S.mat("ivory", color=(0.93, 0.9, 0.82), roughness=0.3)
    S.mat("cane", color=(0.86, 0.74, 0.47), roughness=0.5)
    S.mat("black", color=(0.03, 0.03, 0.03), roughness=0.45)
    W = np.array([0.0, -0.12, 0.2])
    bottom = W[1] - 0.5
    top = W[1] + 0.85
    Mw, Sv, Iv, Cn, Bk = [], [], [], [], []
    tile = 0.09

    def uv_wood(g):
        ang = np.arctan2(g.v[:, 0] - g.v[:, 0].mean(), g.v[:, 2] - g.v[:, 2].mean())
        g.uv = np.stack([ang / (2 * math.pi) * 0.9, g.v[:, 1] / tile], axis=1)
        return g
    # boot joint (oval, double bore) with silver U-cap
    boot = lathe_y([(0.03, bottom + 0.03), (0.034, bottom + 0.04), (0.034, W[1] - 0.05), (0.032, W[1] - 0.025), (0.026, W[1] - 0.02)], 26,
                   center=(0.0, W[2]))
    Mw.append(uv_wood(boot))
    Sv.append(lathe_y([(0.0, bottom), (0.028, bottom + 0.001), (0.0345, bottom + 0.006), (0.0352, bottom + 0.03), (0.0335, bottom + 0.034)],
                      26, center=(0.0, W[2])))
    # wing joint (with the thick "wing" on the front carrying the finger holes)
    wx, wz = 0.012, W[2] + 0.004
    Mw.append(uv_wood(lathe_y([(0.019, W[1] - 0.03), (0.019, W[1] + 0.3), (0.0205, W[1] + 0.355), (0.017, W[1] + 0.362)], 20, center=(wx, wz))))
    wing = C.ellipsoid((wx, W[1] + 0.07, wz - 0.012), (0.013, 0.11, 0.016), 14, 10)
    Mw.append(uv_wood(wing))
    # long (bass) joint + bell with the white top ring
    lx, lz = -0.018, W[2] - 0.004
    Mw.append(uv_wood(lathe_y([(0.021, W[1] - 0.03), (0.0215, W[1] + 0.3), (0.0235, top - 0.145)], 20, center=(lx, lz))))
    Mw.append(uv_wood(lathe_y([(0.0235, top - 0.145), (0.026, top - 0.12), (0.028, top - 0.03), (0.0295, top - 0.008)], 20, center=(lx, lz))))
    Iv.append(lathe_y([(0.0295, top - 0.009), (0.031, top - 0.008), (0.031, top), (0.0205, top), (0.0205, top - 0.004)], 20, center=(lx, lz)))
    # joint ferrules (silver) at the boot top and joint junctions
    for (cx, cz, yy, rr) in ((0.0, W[2], W[1] - 0.05, 0.0352), (wx, wz, W[1] + 0.3, 0.0198), (lx, lz, W[1] + 0.3, 0.0222),
                             (lx, lz, top - 0.145, 0.0243), (wx, wz, W[1] + 0.355, 0.021)):
        Sv.append(lathe_y([(rr * 0.97, yy - 0.004), (rr, yy - 0.0035), (rr, yy + 0.0035), (rr * 0.97, yy + 0.004)], 22, center=(cx, cz)))
    # bocal: silver crook from the reed into the wing joint, with the whisper key pad
    bocal = C.catmull(np.array([[0, 0, 0.004], [0, -0.008, 0.06], [0.0, -0.03, 0.12], [0.004, -0.065, 0.17], [wx, W[1] + 0.35, wz - 0.02],
                                [wx, W[1] + 0.362, wz]]), 8)
    bocal = C.catmull(np.array([[0, 0, 0.006], [0, -0.006, 0.06], [0.002, -0.028, 0.12], [0.006, -0.06, 0.165], [wx, W[1] + 0.37, wz - 0.012],
                                [wx, W[1] + 0.358, wz]]), 8)
    Sv.append(C.tube(bocal, np.linspace(0.0022, 0.0048, len(bocal)), 10))
    Sv.append(C.cylinder((0.004, -0.058, 0.162), (0.009, -0.058, 0.162), 0.003, sides=10))
    # reed: flattened double reed, wire rings, thread ball
    rb = lathe_z([(0.0004, -0.003), (0.0065, 0.002), (0.0072, 0.012), (0.006, 0.022), (0.0045, 0.028)], 16)
    rb.v[:, 1] *= 0.28
    Cn.append(rb)
    for zr in (0.012, 0.02):
        Sv.append(lathe_z([(0.0066, zr - 0.0006), (0.0068, zr), (0.0066, zr + 0.0006)], 12).apply(np.diag([1, 0.4, 1])))
    Bk.append(lathe_z([(0.0046, 0.027), (0.0052, 0.03), (0.0048, 0.036), (0.0036, 0.038)], 12))
    # ---- key work ----
    Tb = Tube((0.0, 0.0, W[2]), (0, 1, 0), lambda y: 0.034, up=(0, 0, -1))
    for (y, phi, rc) in ((-0.56, 0.3, 0.007), (-0.52, -0.4, 0.007), (-0.48, 0.5, 0.0065), (-0.44, -0.2, 0.0065), (-0.4, 0.9, 0.006),
                         (-0.36, -0.8, 0.006), (-0.3, 0.2, 0.006), (-0.26, -0.5, 0.0055), (-0.54, 2.4, 0.007), (-0.47, 2.6, 0.0065),
                         (-0.4, 2.3, 0.006), (-0.32, 2.7, 0.006)):
        Sv.append(Tb.cup(y, phi, rc))
    for phi in (1.4, -1.4, 3.1):
        Sv.append(Tb.rod(-0.58, -0.22, phi, 0.004, rr=0.0015))
        for yp in (-0.57, -0.45, -0.33, -0.23):
            Sv.append(Tb.post(yp, phi, 0.004, rr=0.0013))
    for (y0, y1, phi) in ((-0.5, -0.46, 2.0), (-0.42, -0.38, 2.1), (-0.35, -0.31, -2.0), (-0.28, -0.24, 1.9)):
        Sv.append(Tb.lever(y0, y1, phi, 0.004, w=0.006))
    Tl = Tube((lx, 0.0, lz), (0, 1, 0), lambda y: 0.0225, up=(0, 0, -1))
    for (y, phi, rc) in ((W[1] + 0.05, 2.6, 0.006), (W[1] + 0.12, 2.9, 0.006), (W[1] + 0.2, 3.1, 0.0055), (W[1] + 0.28, 2.7, 0.0055),
                         (W[1] + 0.4, 2.8, 0.006), (W[1] + 0.52, 2.5, 0.0062)):
        Sv.append(Tl.cup(y, phi, rc))
    Sv.append(Tl.rod(W[1], W[1] + 0.56, 3.6, 0.0035, rr=0.0012))
    Sv.append(Tl.rod(W[1], W[1] + 0.56, 2.0, 0.0035, rr=0.0012))
    for yp in (W[1] + 0.01, W[1] + 0.2, W[1] + 0.38, W[1] + 0.55):
        Sv.append(Tl.post(yp, 3.6, 0.0035))
        Sv.append(Tl.post(yp, 2.0, 0.0035))
    Tw = Tube((wx, 0.0, wz), (0, 1, 0), lambda y: 0.0195, up=(0, 0, -1))
    Sv.append(Tw.rod(W[1] + 0.12, W[1] + 0.33, -1.2, 0.003, rr=0.0011))
    for (y, phi) in ((W[1] + 0.14, -1.0), (W[1] + 0.2, -0.8), (W[1] + 0.27, -1.1), (W[1] + 0.31, -0.6)):
        Sv.append(Tw.cup(y, phi, 0.0045))
    # hand rest (crutch) on the boot, seat-strap ring at the bottom
    Bk.append(C.cylinder((0.0, -0.36, W[2] - 0.03), (0.03, -0.34, W[2] - 0.06), 0.004, sides=8))
    Bk.append(C.ellipsoid((0.035, -0.335, W[2] - 0.065), (0.012, 0.018, 0.007), 12, 6))
    Sv.append(C.cylinder((0.0, bottom + 0.01, W[2] + 0.028), (0.0, bottom + 0.02, W[2] + 0.034), 0.004, sides=8))
    S.add(Geo.merge(Mw), "maple_red")
    S.add(Geo.merge(Sv), "silver")
    S.add(Geo.merge(Iv), "ivory")
    S.add(Geo.merge(Cn), "cane")
    S.add(Geo.merge(Bk), "black")
    finish(S, "bassoon")


BUILDERS = dict(flute=build_flute, piccolo=lambda: build_flute(True), oboe=build_oboe, clarinet=build_clarinet, bassoon=build_bassoon)


def main():
    args = C.script_args() or list(BUILDERS)
    for a in args:
        BUILDERS[a]()


if __name__ == "__main__":
    main()
