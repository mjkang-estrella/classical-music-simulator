"""
Shared helpers for the tier-2 instrument builders (run inside headless Blender).

All geometry is authored in the FINAL glTF / three.js frame (meters, +Y up) as numpy arrays and
converted to Blender's Z-up frame only when the Blender objects are created:

    glTF (x, y, z)  ->  Blender (x, -z, y)          (the exporter maps it back with export_yup)

A builder collects `Geo` parts into buckets keyed by (node, material). `Scene.build()` merges each
bucket into ONE mesh object (one draw call per material per node), creates the node hierarchy and
the `anchor_*` empties, and `export_glb()` writes the GLB.
"""
from __future__ import annotations

import math
import os
import sys
from collections import OrderedDict

import bpy
import numpy as np
from mathutils import geometry as mgeo

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
OUT_DIR = os.path.join(ROOT, "public", "assets", "instruments")
PREVIEW_DIR = os.path.join(ROOT, "vendor", "instrument-previews")
BUILD_DIR = os.path.join(PREVIEW_DIR, "_build")


def log(*a):
    print("[instruments]", *a, flush=True)


def script_args():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    return [a for a in args if a != "--"]


# ---------------------------------------------------------------------------
# small linear algebra helpers (glTF frame)
# ---------------------------------------------------------------------------

def v3(x, y, z):
    return np.array([x, y, z], float)


def norm(a):
    a = np.asarray(a, float)
    n = np.linalg.norm(a, axis=-1, keepdims=True)
    return a / np.where(n < 1e-12, 1.0, n)


def rot_axis(axis, ang):
    """3x3 rotation matrix about `axis` by `ang` radians (right-handed)."""
    x, y, z = norm(axis)
    c, s = math.cos(ang), math.sin(ang)
    C = 1 - c
    return np.array([
        [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
        [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
        [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
    ])


def rot_from_to(a, b):
    a, b = norm(a), norm(b)
    c = float(np.dot(a, b))
    if c > 1 - 1e-9:
        return np.eye(3)
    if c < -1 + 1e-9:
        p = np.array([1.0, 0, 0]) if abs(a[0]) < 0.9 else np.array([0, 1.0, 0])
        return rot_axis(np.cross(a, p), math.pi)
    ax = np.cross(a, b)
    return rot_axis(ax, math.acos(max(-1.0, min(1.0, c))))


def basis(x, y, z):
    """Matrix whose columns are the given axes (maps local -> parent)."""
    return np.stack([np.asarray(x, float), np.asarray(y, float), np.asarray(z, float)], axis=1)


# ---------------------------------------------------------------------------
# Geo: a polygon soup with per-vertex UVs (duplicate vertices at seams)
# ---------------------------------------------------------------------------

class Geo:
    def __init__(self, v=None, f=None, uv=None, sharp=None):
        self.v = np.zeros((0, 3)) if v is None else np.asarray(v, float).reshape(-1, 3)
        self.f = [] if f is None else [tuple(int(i) for i in p) for p in f]
        if uv is None:
            self.uv = np.zeros((len(self.v), 2))
        else:
            self.uv = np.asarray(uv, float).reshape(-1, 2)
        # auto-smooth angle in degrees (None = fully smooth, 0 = flat)
        self.sharp = sharp

    def copy(self):
        g = Geo(self.v.copy(), list(self.f), self.uv.copy(), self.sharp)
        return g

    # transforms ---------------------------------------------------------
    def apply(self, M, t=None):
        M = np.asarray(M, float)
        if M.shape == (4, 4):
            t = M[:3, 3]
            M = M[:3, :3]
        self.v = self.v @ M.T
        if t is not None:
            self.v = self.v + np.asarray(t, float)
        if np.linalg.det(M) < 0:
            self.f = [tuple(reversed(p)) for p in self.f]
        return self

    def translate(self, x, y=None, z=None):
        t = np.array([x, y, z], float) if y is not None else np.asarray(x, float)
        self.v = self.v + t
        return self

    def scale(self, sx, sy=None, sz=None):
        s = np.array([sx, sx if sy is None else sy, sx if sz is None else sz], float)
        return self.apply(np.diag(s))

    def rotate(self, axis, ang, center=None):
        c = np.zeros(3) if center is None else np.asarray(center, float)
        self.v = self.v - c
        self.apply(rot_axis(axis, ang))
        self.v = self.v + c
        return self

    def mirror_x(self):
        return self.apply(np.diag([-1.0, 1.0, 1.0]))

    def flip(self):
        self.f = [tuple(reversed(p)) for p in self.f]
        return self

    def uv_transform(self, su=1.0, sv=1.0, ou=0.0, ov=0.0):
        self.uv = self.uv * np.array([su, sv]) + np.array([ou, ov])
        return self

    def uv_planar(self, u_axis, v_axis, su=1.0, sv=1.0, ou=0.0, ov=0.0):
        """UV = (dot(p, u_axis) * su + ou, dot(p, v_axis) * sv + ov)."""
        self.uv = np.stack([self.v @ np.asarray(u_axis, float) * su + ou,
                            self.v @ np.asarray(v_axis, float) * sv + ov], axis=1)
        return self

    def tri_count(self):
        return sum(len(p) - 2 for p in self.f)

    @staticmethod
    def merge(geos):
        geos = [g for g in geos if g is not None and len(g.v)]
        if not geos:
            return Geo()
        out = Geo()
        vs, uvs, fs = [], [], []
        off = 0
        for g in geos:
            vs.append(g.v)
            uvs.append(g.uv)
            fs.extend(tuple(i + off for i in p) for p in g.f)
            off += len(g.v)
        out.v = np.concatenate(vs)
        out.uv = np.concatenate(uvs)
        out.f = fs
        sh = [g.sharp for g in geos]
        out.sharp = sh[0] if all(s == sh[0] for s in sh) else max((s for s in sh if s is not None), default=None)
        return out


# ---------------------------------------------------------------------------
# primitives
# ---------------------------------------------------------------------------

def loft(sections, closed=True, cap_start=False, cap_end=False, u_param=None, v_param=None, sharp=None):
    """
    Connect a list of M point loops (each (K,3), same K) with quads.
    closed: loops are closed rings (duplicates the seam column for UVs).
    UV: u runs around the loop (0..1, or `u_param` (K,) values), v along the sections
    (cumulative mean distance, or `v_param` (M,) values).
    Caps are fans around the loop centroid.
    """
    S = np.asarray(sections, float)
    M, K = S.shape[0], S.shape[1]
    if closed:
        S2 = np.concatenate([S, S[:, :1]], axis=1)
    else:
        S2 = S
    Kc = S2.shape[1]
    verts = S2.reshape(-1, 3)
    if u_param is None:
        seg = np.linalg.norm(np.diff(S2, axis=1), axis=2).mean(axis=0)
        u = np.concatenate([[0], np.cumsum(seg)])
        u = u / (u[-1] if u[-1] > 0 else 1)
    else:
        u = np.asarray(u_param, float)
        if closed and len(u) == K:
            u = np.concatenate([u, [u[0] + 1.0 if u[-1] <= u[0] + 1 else u[-1]]])
    if v_param is None:
        c = S.mean(axis=1)
        d = np.linalg.norm(np.diff(c, axis=0), axis=1)
        v = np.concatenate([[0], np.cumsum(d)])
    else:
        v = np.asarray(v_param, float)
    uu, vv = np.meshgrid(u, v)
    uv = np.stack([uu.ravel(), vv.ravel()], axis=1)
    faces = []
    for m in range(M - 1):
        for k in range(Kc - 1):
            a = m * Kc + k
            b = m * Kc + k + 1
            c_ = (m + 1) * Kc + k + 1
            d_ = (m + 1) * Kc + k
            faces.append((a, b, c_, d_))
    g = Geo(verts, faces, uv, sharp)
    caps = []
    if cap_start:
        caps.append(fan_cap(S[0], flip=False))
    if cap_end:
        caps.append(fan_cap(S[-1], flip=True))
    if caps:
        g = Geo.merge([g] + caps)
        g.sharp = sharp if sharp is not None else 50
    return g


def fan_cap(loop, flip=False, center=None):
    loop = np.asarray(loop, float)
    c = loop.mean(axis=0) if center is None else np.asarray(center, float)
    verts = np.concatenate([loop, c[None]])
    n = len(loop)
    faces = [(i, (i + 1) % n, n) for i in range(n)]
    g = Geo(verts, faces, np.zeros((n + 1, 2)) + 0.5)
    # orientation: loft winding (a,b,c,d) around the loop -> start cap faces backwards
    g.flip()
    if flip:
        g.flip()
    return g


def circle(n, r=1.0, phase=0.0):
    a = np.linspace(0, 2 * math.pi, n, endpoint=False) + phase
    return np.stack([np.cos(a) * r, np.sin(a) * r], axis=1)


def rmf_frames(path, up_hint=None):
    """Rotation-minimising frames along a polyline. Returns T, N, B (each (M,3))."""
    P = np.asarray(path, float)
    M = len(P)
    T = np.zeros_like(P)
    T[1:-1] = P[2:] - P[:-2]
    T[0] = P[1] - P[0]
    T[-1] = P[-1] - P[-2]
    T = norm(T)
    if up_hint is None:
        up_hint = np.array([0, 1.0, 0]) if abs(T[0][1]) < 0.9 else np.array([1.0, 0, 0])
    N0 = np.cross(np.cross(T[0], up_hint), T[0])
    if np.linalg.norm(N0) < 1e-9:
        N0 = np.cross(T[0], [1.0, 0, 0])
    N = np.zeros_like(P)
    N[0] = norm(N0)
    for i in range(1, M):
        # double reflection method
        v1 = P[i] - P[i - 1]
        c1 = np.dot(v1, v1)
        if c1 < 1e-18:
            N[i] = N[i - 1]
            continue
        rL = N[i - 1] - (2 / c1) * np.dot(v1, N[i - 1]) * v1
        tL = T[i - 1] - (2 / c1) * np.dot(v1, T[i - 1]) * v1
        v2 = T[i] - tL
        c2 = np.dot(v2, v2)
        N[i] = rL - (2 / c2) * np.dot(v2, rL) * v2 if c2 > 1e-18 else rL
        N[i] = norm(N[i])
    B = np.cross(T, N)
    return T, N, B


def sweep(path, profile, scales=None, closed_profile=True, cap_start=False, cap_end=False,
          up_hint=None, frames=None, sharp=None, v_scale=1.0):
    """
    Sweep a 2D profile (K,2) (coords along N, B) along a 3D path (M,3).
    `scales`: (M,) uniform or (M,2) per-axis scale of the profile, or a callable(i)->(K,2) profile.
    """
    P = np.asarray(path, float)
    M = len(P)
    if frames is None:
        T, N, B = rmf_frames(P, up_hint)
    else:
        T, N, B = frames
    secs = []
    for i in range(M):
        prof = profile(i) if callable(profile) else np.asarray(profile, float)
        if scales is not None:
            s = np.asarray(scales[i], float)
            prof = prof * (s if s.shape else np.array([s, s]))
        secs.append(P[i] + prof[:, :1] * N[i] + prof[:, 1:2] * B[i])
    d = np.linalg.norm(np.diff(P, axis=0), axis=1)
    vparam = np.concatenate([[0], np.cumsum(d)]) * v_scale
    return loft(secs, closed=closed_profile, cap_start=cap_start, cap_end=cap_end, v_param=vparam, sharp=sharp)


def tube(path, radius, sides=8, cap_start=False, cap_end=False, up_hint=None, sharp=None, phase=0.0):
    P = np.asarray(path, float)
    r = np.broadcast_to(np.asarray(radius, float), (len(P),))
    prof = circle(sides, 1.0, phase)
    return sweep(P, prof, scales=r, cap_start=cap_start, cap_end=cap_end, up_hint=up_hint, sharp=sharp)


def lathe(profile, segs=24, cap_start=False, cap_end=False, sharp=None, arc=2 * math.pi, phase=0.0):
    """Revolve [(r, y), ...] around +Y. UV u = angle fraction, v = profile arc length."""
    prof = np.asarray(profile, float)
    full = abs(arc - 2 * math.pi) < 1e-9
    n = segs if full else segs + 1
    a = phase + np.linspace(0, arc, n, endpoint=not full)
    secs = []
    # sections = profile points; loops = around the axis
    for r, y in prof:
        secs.append(np.stack([np.sin(a) * r, np.full_like(a, y), np.cos(a) * r], axis=1))
    d = np.linalg.norm(np.diff(prof, axis=0), axis=1)
    vparam = np.concatenate([[0], np.cumsum(d)])
    g = loft(secs, closed=full, v_param=vparam, cap_start=cap_start, cap_end=cap_end, sharp=sharp)
    return g


def cylinder(p0, p1, r0, r1=None, sides=12, caps=True, sharp=40):
    r1 = r0 if r1 is None else r1
    return tube([p0, p1], [r0, r1], sides, cap_start=caps, cap_end=caps, sharp=sharp)


def box(center, size, sharp=30):
    cx, cy, cz = center
    sx, sy, sz = np.asarray(size, float) / 2
    v = np.array([[x, y, z] for z in (-sz, sz) for y in (-sy, sy) for x in (-sx, sx)]) + [cx, cy, cz]
    # index = zi*4 + yi*2 + xi
    f = [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)]
    # un-share vertices for flat shading + uv
    verts, faces, uvs = [], [], []
    for quad in f:
        base = len(verts)
        verts.extend(v[list(quad)])
        faces.append(tuple(range(base, base + 4)))
        uvs.extend([(0, 0), (1, 0), (1, 1), (0, 1)])
    return Geo(verts, faces, uvs, sharp)


def ellipsoid(center, radii, seg_u=16, seg_v=10, sharp=None):
    prof = []
    for i in range(seg_v + 1):
        t = math.pi * i / seg_v
        prof.append((math.sin(t), -math.cos(t)))
    g = lathe(prof, seg_u)
    g.v = g.v * np.asarray(radii, float) + np.asarray(center, float)
    g.sharp = sharp
    return g


def polygon_fill(loops2d):
    """Triangulate 2D loops (outer + holes) -> list of triangles over the concatenated vertex list."""
    from mathutils import Vector
    vl = [[Vector((p[0], p[1], 0.0)) for p in loop] for loop in loops2d]
    tris = mgeo.tessellate_polygon(vl)
    return tris


def extrude(loops2d, z0, z1, map3d=None, sharp=35, side_uv_scale=1.0):
    """
    Extrude 2D loops (first = outer CCW, rest = holes) between depth z0 and z1.
    map3d(p2, z) -> 3D point (default (x, y, z)). Returns caps + side walls.
    """
    if map3d is None:
        def map3d(p, z):
            return np.array([p[0], p[1], z])
    loops = [np.asarray(l, float) for l in loops2d]
    allp = np.concatenate(loops)
    tris = polygon_fill(loops)
    parts = []
    for z, flip in ((z1, False), (z0, True)):
        verts = np.array([map3d(p, z) for p in allp])
        faces = [tuple(t) for t in tris]
        g = Geo(verts, faces, allp.copy())
        # orient: make the cap normal point away from the solid
        n_avg = np.zeros(3)
        for t in faces[:50]:
            a, b, c = verts[list(t)]
            n_avg += np.cross(b - a, c - a)
        other = np.array([map3d(p, z0 if z == z1 else z1) for p in allp[:1]])[0]
        outward = verts[0] - other
        if np.dot(n_avg, outward) < 0:
            g.flip()
        parts.append(g)
    for li, loop in enumerate(loops):
        K = len(loop)
        a = np.array([map3d(p, z0) for p in loop])
        b = np.array([map3d(p, z1) for p in loop])
        wall = loft([a, b], closed=True)
        # orientation check using the 2D winding: outer loop CCW -> outward normals
        area = 0.5 * np.sum(loop[:, 0] * np.roll(loop[:, 1], -1) - np.roll(loop[:, 0], -1) * loop[:, 1])
        ccw = area > 0
        want_ccw = (li == 0)
        mid = wall
        # determine by comparing normal with the 2D outward direction of the first edge
        e = loop[1 % K] - loop[0]
        out2d = np.array([e[1], -e[0]])  # right-hand normal = outward for CCW
        if not ccw:
            out2d = -out2d
        if not want_ccw:
            out2d = -out2d
        p0 = map3d(loop[0], (z0 + z1) / 2)
        p1 = map3d(loop[0] + out2d * 1e-3, (z0 + z1) / 2)
        outward = p1 - p0
        f0 = wall.f[0]
        va, vb, vc = wall.v[list(f0[:3])]
        if np.dot(np.cross(vb - va, vc - va), outward) < 0:
            wall.flip()
        wall.sharp = sharp
        parts.append(wall)
    g = Geo.merge(parts)
    g.sharp = sharp
    return g


def resample_closed(pts, n):
    """Resample a closed polyline to n points evenly by arc length."""
    P = np.asarray(pts, float)
    P2 = np.concatenate([P, P[:1]])
    d = np.linalg.norm(np.diff(P2, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(d)])
    t = np.linspace(0, s[-1], n, endpoint=False)
    out = np.stack([np.interp(t, s, P2[:, k]) for k in range(P.shape[1])], axis=1)
    return out


def resample_open(pts, n):
    P = np.asarray(pts, float)
    d = np.linalg.norm(np.diff(P, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(d)])
    t = np.linspace(0, s[-1], n)
    return np.stack([np.interp(t, s, P[:, k]) for k in range(P.shape[1])], axis=1)


def catmull(points, n_per=8, closed=False, alpha=0.5):
    """Centripetal Catmull-Rom through the points."""
    P = np.asarray(points, float)
    if closed:
        P = np.concatenate([P[-1:], P, P[:2]])
    else:
        P = np.concatenate([2 * P[:1] - P[1:2], P, 2 * P[-1:] - P[-2:-1]])
    out = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]

        def tj(ti, a, b):
            return ti + max(np.linalg.norm(b - a), 1e-9) ** alpha
        t0 = 0.0
        t1 = tj(t0, p0, p1)
        t2 = tj(t1, p1, p2)
        t3 = tj(t2, p2, p3)
        last = (i == len(P) - 3) and not closed
        ts = np.linspace(t1, t2, n_per + (1 if last else 0), endpoint=last)
        for t in ts:
            a1 = (t1 - t) / (t1 - t0) * p0 + (t - t0) / (t1 - t0) * p1
            a2 = (t2 - t) / (t2 - t1) * p1 + (t - t1) / (t2 - t1) * p2
            a3 = (t3 - t) / (t3 - t2) * p2 + (t - t2) / (t3 - t2) * p3
            b1 = (t2 - t) / (t2 - t0) * a1 + (t - t0) / (t2 - t0) * a2
            b2 = (t3 - t) / (t3 - t1) * a2 + (t - t1) / (t3 - t1) * a3
            out.append((t2 - t) / (t2 - t1) * b1 + (t - t1) / (t2 - t1) * b2)
    return np.array(out)


def bezier(p0, p1, p2, p3, n=12, endpoint=True):
    t = np.linspace(0, 1, n, endpoint=endpoint)[:, None]
    p0, p1, p2, p3 = (np.asarray(p, float) for p in (p0, p1, p2, p3))
    return ((1 - t) ** 3) * p0 + 3 * ((1 - t) ** 2) * t * p1 + 3 * (1 - t) * t * t * p2 + (t ** 3) * p3


def smoothstep(e0, e1, x):
    t = np.clip((np.asarray(x, float) - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


# ---------------------------------------------------------------------------
# textures (numpy, sRGB floats 0..1, origin top-left, shape (H, W, 3|4))
# ---------------------------------------------------------------------------

_rng = np.random.default_rng(1234)


def rng(seed):
    return np.random.default_rng(seed)


def value_noise(h, w, cells_y, cells_x, seed=0, tile=True):
    """Smooth value noise in [0,1] on an (h, w) grid with (cells_y, cells_x) lattice cells."""
    r = rng(seed)
    gy, gx = int(cells_y), int(cells_x)
    lat = r.random((gy + 1, gx + 1))
    if tile:
        lat[-1, :] = lat[0, :]
        lat[:, -1] = lat[:, 0]
    y = np.linspace(0, gy, h, endpoint=False)
    x = np.linspace(0, gx, w, endpoint=False)
    y0 = np.floor(y).astype(int)
    x0 = np.floor(x).astype(int)
    fy = y - y0
    fx = x - x0
    sy = fy * fy * (3 - 2 * fy)
    sx = fx * fx * (3 - 2 * fx)
    a = lat[y0][:, x0]
    b = lat[y0][:, x0 + 1]
    c = lat[y0 + 1][:, x0]
    d = lat[y0 + 1][:, x0 + 1]
    top = a + (b - a) * sx[None, :]
    bot = c + (d - c) * sx[None, :]
    return top + (bot - top) * sy[:, None]


def fbm(h, w, cells_y, cells_x, octaves=4, seed=0, gain=0.5):
    tot = np.zeros((h, w))
    amp = 1.0
    norm_ = 0.0
    for o in range(octaves):
        tot += amp * value_noise(h, w, cells_y * 2 ** o, cells_x * 2 ** o, seed + 17 * o)
        norm_ += amp
        amp *= gain
    return tot / norm_


def lerp_color(a, b, t):
    a = np.asarray(a, float)
    b = np.asarray(b, float)
    t = np.asarray(t, float)[..., None]
    return a + (b - a) * t


def srgb_to_linear(c):
    c = np.asarray(c, float)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def make_image(name, rgb, alpha=None):
    """Create a Blender image from an (H, W, 3) sRGB array (top-left origin), saved as PNG in BUILD_DIR."""
    rgb = np.clip(np.asarray(rgb, float), 0, 1)
    h, w = rgb.shape[:2]
    rgba = np.ones((h, w, 4), np.float32)
    rgba[..., :3] = rgb
    if alpha is not None:
        rgba[..., 3] = alpha
    os.makedirs(BUILD_DIR, exist_ok=True)
    path = os.path.join(BUILD_DIR, f"{name}.png")
    img = bpy.data.images.new(name, w, h, alpha=alpha is not None)
    img.pixels.foreach_set(rgba[::-1].reshape(-1).astype(np.float32))
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)
    img = bpy.data.images.load(path, check_existing=False)
    img.name = name
    return img


# ---------------------------------------------------------------------------
# materials
# ---------------------------------------------------------------------------

def make_material(name, color=(0.8, 0.8, 0.8), metallic=0.0, roughness=0.5, tex=None,
                  coat=0.0, coat_roughness=0.05, double_sided=False, rough_tex=None, normal_tex=None,
                  normal_strength=1.0, specular=0.5, alpha_tex=False):
    """Principled BSDF material that exports cleanly to glTF PBR (+ KHR_materials_clearcoat)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*srgb_to_linear(color)[:3], 1.0)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = coat
        bsdf.inputs["Coat Roughness"].default_value = coat_roughness
    if tex is not None:
        tn = nt.nodes.new("ShaderNodeTexImage")
        tn.image = tex
        tn.interpolation = "Linear"
        nt.links.new(tn.outputs["Color"], bsdf.inputs["Base Color"])
        if alpha_tex:
            nt.links.new(tn.outputs["Alpha"], bsdf.inputs["Alpha"])
    if rough_tex is not None:
        # glTF metallicRoughness: roughness in G, metallic in B
        rn = nt.nodes.new("ShaderNodeTexImage")
        rn.image = rough_tex
        rough_tex.colorspace_settings.name = "Non-Color"
        sep = nt.nodes.new("ShaderNodeSeparateColor")
        nt.links.new(rn.outputs["Color"], sep.inputs["Color"])
        nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
        nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    if normal_tex is not None:
        nn = nt.nodes.new("ShaderNodeTexImage")
        nn.image = normal_tex
        normal_tex.colorspace_settings.name = "Non-Color"
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.inputs["Strength"].default_value = normal_strength
        nt.links.new(nn.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    m.use_backface_culling = not double_sided
    try:
        m.use_backface_culling_shadow = False
    except Exception:
        pass
    return m


# ---------------------------------------------------------------------------
# scene assembly
# ---------------------------------------------------------------------------

def gl2bl(p):
    p = np.asarray(p, float)
    return (float(p[0]), float(-p[2]), float(p[1]))


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


class Scene:
    """
    Collects geometry per (node, material) and anchors per node, then builds Blender objects.
    Nodes: the root plus optional child empties (e.g. `slide`, `floor`), each with a local
    translation (glTF frame) relative to its parent.
    """

    def __init__(self, root_name):
        self.root = root_name
        self.nodes = OrderedDict()  # name -> (parent, local_pos)
        self.nodes[root_name] = (None, np.zeros(3))
        self.parts = OrderedDict()  # (node, mat) -> [Geo]
        self.anchors = []  # (name, node, local_pos)
        self.materials = {}

    def node(self, name, parent=None, pos=(0, 0, 0)):
        self.nodes[name] = (parent or self.root, np.asarray(pos, float))
        return name

    def mat(self, key, **kw):
        if key not in self.materials:
            self.materials[key] = make_material(key, **kw)
        return key

    def add(self, geo, mat, node=None):
        node = node or self.root
        if geo is None or len(geo.v) == 0:
            return
        self.parts.setdefault((node, mat), []).append(geo)

    def anchor(self, name, pos, node=None):
        if not name.startswith("anchor_"):
            name = "anchor_" + name
        self.anchors.append((name, node or self.root, np.asarray(pos, float)))

    def tri_count(self):
        return sum(g.tri_count() for gs in self.parts.values() for g in gs)

    def world_pos(self, node):
        p = np.zeros(3)
        while node is not None:
            parent, lp = self.nodes[node]
            p = p + lp
            node = parent
        return p

    def build(self):
        objs = {}
        for name, (parent, lp) in self.nodes.items():
            o = bpy.data.objects.new(name, None)
            o.empty_display_type = "PLAIN_AXES"
            o.empty_display_size = 0.05
            bpy.context.scene.collection.objects.link(o)
            if parent is not None:
                o.parent = objs[parent]
            o.location = gl2bl(lp)
            objs[name] = o
        for (node, mat), geos in self.parts.items():
            g = Geo.merge(geos)
            # vertices are authored in the root frame: express them relative to the node
            g.v = g.v - self.world_pos(node)
            ob = self._mesh_object(f"{node}_{mat}", g, self.materials[mat])
            ob.parent = objs[node]
        for name, node, pos in self.anchors:
            o = bpy.data.objects.new(name, None)
            o.empty_display_type = "ARROWS"
            o.empty_display_size = 0.02
            bpy.context.scene.collection.objects.link(o)
            o.parent = objs[node]
            o.location = gl2bl(pos - self.world_pos(node))
        return objs

    def _mesh_object(self, name, g, material):
        me = bpy.data.meshes.new(name)
        vb = np.stack([g.v[:, 0], -g.v[:, 2], g.v[:, 1]], axis=1)
        me.from_pydata(vb.tolist(), [], g.f)
        uvl = me.uv_layers.new(name="UVMap")
        loop_vi = np.empty(len(me.loops), np.int64)
        me.loops.foreach_get("vertex_index", loop_vi)
        uv = g.uv[loop_vi].astype(np.float32)
        uvl.data.foreach_set("uv", uv.reshape(-1))
        me.materials.append(material)
        me.validate(clean_customdata=False)
        if g.sharp == 0:
            me.shade_flat()
        else:
            me.shade_smooth()
            if g.sharp is not None:
                try:
                    me.set_sharp_from_angle(angle=math.radians(g.sharp))
                except Exception:
                    pass
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        return ob


def export_glb(path, root_obj_name=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_image_format="WEBP",
        export_image_quality=82,
        export_yup=True,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
        export_extras=False,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        use_selection=False,
    )
    log("wrote", os.path.relpath(path, ROOT), f"{os.path.getsize(path) / 1024:.0f} KB")
