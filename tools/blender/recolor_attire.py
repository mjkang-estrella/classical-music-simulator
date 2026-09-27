"""
Texture preparation for the Rocketbox characters: HSV recolor rules + downscale.

Pure numpy for the pixel work; Blender (bpy) is used only for image I/O, so this
module runs inside Blender. It is imported by rocketbox_to_glb.py and can also be
run on its own to inspect the recolor result for one character:

  tools/blender/run.sh tools/blender/recolor_attire.py -- \
      --cast tools/blender/characters.json --id rocketbox_business_female_02 \
      [--out vendor/previews/textures]

That writes, per recolored texture, a side-by-side PNG (original | recolored | mask).

Rule format (characters.json -> characters[].recolor.<texture key>[]):
  {
    "name":  "tie",               # label only
    "hue":   [lo, hi],            # 0..1; lo > hi wraps through red (e.g. [0.95, 0.04])
    "sat":   [lo, hi],            # 0..1
    "val":   [lo, hi],            # 0..1 (HSV value of the sRGB-encoded pixel)
    "include": [[x0,y0,x1,y1]],   # optional, normalized image rects, origin top-left
    "exclude": [[x0,y0,x1,y1]],   # optional, same convention
    "satScale": 0.1,              # multiply saturation
    "valScale": 0.2,              # multiply value
    "valMax":  0.15,              # optional clamp after scaling (flattens heather flecks)
    "hueSet":  null,              # optional absolute hue
    "holeFill": 2                 # optional, overrides defaults.recolorHoleFill (closing radius, px)
  }
Pixels are selected with soft (feathered) HSV ranges so the result has no hard
edges. A skin guard (defaults.skinGuard, HSV box) is always subtracted from the
selection, so skin tones are never touched even if a rule's box overlaps them.
The texture key is matched against the image file name suffix, e.g. "body_color"
matches "m005_body_color.tga".
"""
from __future__ import annotations

import json
import math
import os
import sys

import numpy as np

# ---------------------------------------------------------------------------
# colour math
# ---------------------------------------------------------------------------


def rgb_to_hsv(rgb: np.ndarray) -> np.ndarray:
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = rgb.max(-1)
    mn = rgb.min(-1)
    d = mx - mn
    nz = d > 1e-6
    safe_d = np.where(nz, d, 1.0)
    rc = (mx - r) / safe_d
    gc = (mx - g) / safe_d
    bc = (mx - b) / safe_d
    h = np.where(r == mx, bc - gc, np.where(g == mx, 2.0 + rc - bc, 4.0 + gc - rc))
    h = np.where(nz, (h / 6.0) % 1.0, 0.0)
    s = np.where(mx > 1e-6, d / np.where(mx > 1e-6, mx, 1.0), 0.0)
    return np.stack([h, s, mx], -1).astype(np.float32)


def hsv_to_rgb(hsv: np.ndarray) -> np.ndarray:
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    i = np.floor(h * 6.0).astype(np.int32) % 6
    f = h * 6.0 - np.floor(h * 6.0)
    p = v * (1.0 - s)
    q = v * (1.0 - s * f)
    t = v * (1.0 - s * (1.0 - f))
    conds = [i == k for k in range(6)]
    r = np.select(conds, [v, q, p, p, t, v])
    g = np.select(conds, [t, v, v, q, p, p])
    b = np.select(conds, [p, p, t, v, v, q])
    return np.stack([r, g, b], -1).astype(np.float32)


def _smooth_range(x: np.ndarray, lo: float, hi: float, feather: float) -> np.ndarray:
    """1 inside [lo, hi], smooth falloff of width `feather` outside."""
    if feather <= 0:
        return ((x >= lo) & (x <= hi)).astype(np.float32)
    a = np.clip((x - (lo - feather)) / feather, 0.0, 1.0)
    b = np.clip(((hi + feather) - x) / feather, 0.0, 1.0)
    w = np.minimum(a, b)
    return (w * w * (3.0 - 2.0 * w)).astype(np.float32)


def _hue_range(h: np.ndarray, lo: float, hi: float, feather: float) -> np.ndarray:
    if lo <= hi:
        return np.maximum.reduce([
            _smooth_range(h, lo, hi, feather),
            _smooth_range(h - 1.0, lo, hi, feather),
            _smooth_range(h + 1.0, lo, hi, feather),
        ])
    # wraps through 1.0 -> 0.0
    return np.maximum(_hue_range(h, lo, 1.0 + 1e-6, feather), _hue_range(h, -1e-6, hi, feather))


def _rect_mask(shape, rects) -> np.ndarray:
    h, w = shape
    m = np.zeros((h, w), np.float32)
    for x0, y0, x1, y1 in rects:
        m[int(round(y0 * h)):int(round(y1 * h)), int(round(x0 * w)):int(round(x1 * w))] = 1.0
    return m


def hsv_box(hsv: np.ndarray, box: dict, feather: dict) -> np.ndarray:
    w = np.ones(hsv.shape[:2], np.float32)
    if "hue" in box:
        w *= _hue_range(hsv[..., 0], box["hue"][0], box["hue"][1], feather.get("hue", 0.02))
    if "sat" in box:
        w *= _smooth_range(hsv[..., 1], box["sat"][0], box["sat"][1], feather.get("sat", 0.05))
    if "val" in box:
        w *= _smooth_range(hsv[..., 2], box["val"][0], box["val"][1], feather.get("val", 0.05))
    return w


def _minmax_filter(x: np.ndarray, r: int, op) -> np.ndarray:
    """Square (2r+1)^2 max/min filter via shifted views (edge-clamped)."""
    p = np.pad(x, r, mode="edge")
    h, w = x.shape
    out = x.copy()
    for dy in range(2 * r + 1):
        for dx in range(2 * r + 1):
            out = op(out, p[dy:dy + h, dx:dx + w])
    return out


def close_holes(w: np.ndarray, r: int) -> np.ndarray:
    """Morphological closing of a soft mask: fills holes up to ~2r px (lint specks, stray bright
    fibres that fall outside a rule's HSV box) without growing the mask's outline."""
    if r <= 0:
        return w
    return np.maximum(w, _minmax_filter(_minmax_filter(w, r, np.maximum), r, np.minimum))


def apply_rules(rgba: np.ndarray, rules: list, skin_guard: dict | None = None,
                feather: dict | None = None, hole_fill: int = 0):
    """rgba: (H, W, 4) float32 in 0..1, sRGB-encoded, origin top-left.
    hole_fill: closing radius (px) applied to each rule's HSV selection before the region rects
    and the skin guard. Returns (new_rgba, combined_mask)."""
    feather = feather or {}
    hsv = rgb_to_hsv(rgba[..., :3])
    out_hsv = hsv.copy()
    total = np.zeros(rgba.shape[:2], np.float32)
    guard = None
    if skin_guard:
        guard = hsv_box(hsv, skin_guard, {"hue": 0.01, "sat": 0.03, "val": 0.03})
    for rule in rules:
        w = close_holes(hsv_box(hsv, rule, feather), int(rule.get("holeFill", hole_fill)))
        if rule.get("include"):
            w *= _rect_mask(w.shape, rule["include"])
        if rule.get("exclude"):
            w *= 1.0 - _rect_mask(w.shape, rule["exclude"])
        if guard is not None and not rule.get("ignoreSkinGuard", False):
            w *= 1.0 - guard
        target = hsv.copy()
        if rule.get("hueSet") is not None:
            target[..., 0] = rule["hueSet"]
        target[..., 1] = np.clip(hsv[..., 1] * rule.get("satScale", 1.0), 0, 1)
        target[..., 2] = np.clip(hsv[..., 2] * rule.get("valScale", 1.0), 0, rule.get("valMax", 1.0))
        # blend in HSV value/sat (hue only matters where sat survives)
        out_hsv[..., 1] = out_hsv[..., 1] * (1 - w) + target[..., 1] * w
        out_hsv[..., 2] = out_hsv[..., 2] * (1 - w) + target[..., 2] * w
        if rule.get("hueSet") is not None:
            out_hsv[..., 0] = np.where(w > 0.5, target[..., 0], out_hsv[..., 0])
        total = np.maximum(total, w)
    out = rgba.copy()
    out[..., :3] = hsv_to_rgb(out_hsv)
    return out, total


# ---------------------------------------------------------------------------
# resampling
# ---------------------------------------------------------------------------


def downscale(rgba: np.ndarray, size: int) -> np.ndarray:
    """Box-filter downscale to size x size (integer factors), else nearest-ish mean."""
    h, w = rgba.shape[:2]
    if h == size and w == size:
        return rgba
    if h % size == 0 and w % size == 0 and h >= size:
        fy, fx = h // size, w // size
        return rgba.reshape(size, fy, size, fx, rgba.shape[2]).mean(axis=(1, 3)).astype(np.float32)
    # generic fallback: area-average via index binning
    ys = (np.arange(h) * size // h)
    xs = (np.arange(w) * size // w)
    out = np.zeros((size, size, rgba.shape[2]), np.float64)
    cnt = np.zeros((size, size, 1), np.float64)
    np.add.at(out, (ys[:, None], xs[None, :]), rgba)
    np.add.at(cnt, (ys[:, None], xs[None, :]), 1)
    return (out / np.maximum(cnt, 1)).astype(np.float32)


# ---------------------------------------------------------------------------
# bpy image I/O
# ---------------------------------------------------------------------------


def load_rgba(path: str) -> np.ndarray:
    import bpy
    img = bpy.data.images.load(path, check_existing=False)
    try:
        w, h = img.size
        if w == 0 or h == 0:
            raise RuntimeError(f"could not load image {path}")
        buf = np.empty(w * h * 4, np.float32)
        img.pixels.foreach_get(buf)
        return buf.reshape(h, w, 4)[::-1].copy()  # -> origin top-left
    finally:
        bpy.data.images.remove(img)


def save_png(rgba: np.ndarray, path: str, *, non_color: bool = False, keep_alpha: bool = True):
    import bpy
    h, w = rgba.shape[:2]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=keep_alpha)
    try:
        if non_color:
            img.colorspace_settings.name = "Non-Color"
        data = rgba[::-1].copy()
        if not keep_alpha:
            data[..., 3] = 1.0
        img.pixels.foreach_set(data.reshape(-1).astype(np.float32))
        img.filepath_raw = path
        img.file_format = "PNG"
        img.save()
    finally:
        bpy.data.images.remove(img)


def texture_key_rules(recolor: dict, image_name: str) -> list:
    base = os.path.splitext(os.path.basename(image_name))[0].lower()
    rules = []
    for key, rs in (recolor or {}).items():
        if base.endswith(key.lower()):
            rules.extend(rs)
    return rules


def prepare_texture(src: str, dst: str, size: int, *, rules=None, skin_guard=None,
                    feather=None, non_color=False, keep_alpha=False, hole_fill=0, force=False):
    """Load src (TGA), recolor, downscale to size^2, save PNG at dst. Cached by mtime."""
    stamp = dst + ".json"
    sig = json.dumps({"src": os.path.abspath(src), "mtime": os.path.getmtime(src), "size": size,
                      "rules": rules or [], "guard": skin_guard, "feather": feather,
                      "alpha": keep_alpha, "holeFill": hole_fill, "v": 3}, sort_keys=True)
    if not force and os.path.exists(dst) and os.path.exists(stamp):
        with open(stamp) as f:
            if f.read() == sig:
                return dst, None
    rgba = load_rgba(src)
    mask = None
    if rules:
        rgba, mask = apply_rules(rgba, rules, skin_guard, feather, hole_fill)
    small = downscale(rgba, size)
    save_png(small, dst, non_color=non_color, keep_alpha=keep_alpha)
    with open(stamp, "w") as f:
        f.write(sig)
    return dst, mask


# ---------------------------------------------------------------------------
# roughness from the Rocketbox specular maps
# ---------------------------------------------------------------------------


def luminance(rgb: np.ndarray) -> np.ndarray:
    return (0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]).astype(np.float32)


def _solve_k(L: np.ndarray, w: np.ndarray, target: float, lo: float, hi: float,
             k_range=(1.0, 16.0)) -> float:
    """k such that the w-weighted mean of clamp(1 - k*L, lo, hi) == target (bisection; the mean is
    monotonically decreasing in k)."""
    sw = float(w.sum())
    if sw < 1.0:
        return float("nan")
    a, b = k_range

    def mean(k):
        return float((np.clip(1.0 - k * L, lo, hi) * w).sum() / sw)

    if mean(a) <= target:
        return a
    if mean(b) >= target:
        return b
    for _ in range(40):
        m = 0.5 * (a + b)
        if mean(m) > target:
            a = m
        else:
            b = m
    return 0.5 * (a + b)


def gaussian_blur(img: np.ndarray, sigma: float) -> np.ndarray:
    """Separable Gaussian blur of a 2-D array (edge-clamped)."""
    if sigma <= 0:
        return img
    r = max(1, int(math.ceil(sigma * 3)))
    x = np.arange(-r, r + 1, dtype=np.float32)
    k = np.exp(-0.5 * (x / sigma) ** 2)
    k /= k.sum()
    out = img.astype(np.float32)
    for axis in (0, 1):
        pad = [(0, 0), (0, 0)]
        pad[axis] = (r, r)
        p = np.pad(out, pad, mode="edge")
        acc = np.zeros_like(out)
        n = out.shape[axis]
        for i, w in enumerate(k):
            acc += w * (p[i:i + n] if axis == 0 else p[:, i:i + n])
        out = acc
    return out


def roughness_from_specular(spec_rgba: np.ndarray, color_rgba: np.ndarray, *, skin_mask_box: dict,
                            target_skin=0.5, target_cloth=0.75, lo=0.25, hi=0.95, k_range=(1.0, 16.0),
                            single_k=False, skin_rect=None, blur_px=1.0, suit_max_val=0.3, regions=None,
                            k_default=6.0, min_pixels=2000):
    """roughness = clamp(1 - L*k, lo, hi) with L = specular luminance (sRGB-encoded values, as painted).

    k is tuned per texture and per region so that skin averages `target_skin` and everything else
    (suit, shirt, tie, shoes, hair) averages `target_cloth`: a soft HSV skin mask of the *colour*
    texture blends k_skin and k_cloth per pixel, so there are no hard region edges. Within each region
    the specular map's own variation survives (oily T-zone vs matte cheeks, satin tie vs wool jacket).
    color_rgba should be the *recolored* colour texture: garments are then black/grey and cannot be
    mistaken for skin (e.g. a brown jacket), and k_cloth is solved on the dark garment ("suit")
    pixels (non-skin, HSV value < suit_max_val; all non-skin if there are too few), so the suit
    itself averages target_cloth while shirts / ties / shoes keep their relative specular level.
    regions: optional [{"name", "include": [[x0,y0,x1,y1]...], "target"}] -- own k inside the rects
    (whole UV islands), for garments whose specular level is far off the rest (e.g. denim).
    single_k (head textures): one k for the whole texture, solved on the skin inside `skin_rect`
    (normalized, origin top-left; the face block of the atlas) -- hair, lips, eyes follow the face's k.
    k is limited to k_range so near-black specular regions are not amplified into noise.
    Returns (roughness HxW float32, stats dict)."""
    L = gaussian_blur(luminance(spec_rgba[..., :3]), blur_px)  # 8-bit specular steps x k = visible noise
    hsv = rgb_to_hsv(color_rgba[..., :3])
    valid = (color_rgba[..., :3].max(-1) > 0.02).astype(np.float32)  # atlas padding is black
    skin = hsv_box(hsv, skin_mask_box, {"hue": 0.015, "sat": 0.04, "val": 0.04}) * valid
    cloth = (1.0 - skin) * valid
    solve_skin = skin * _rect_mask(skin.shape, [skin_rect]) if skin_rect else skin
    k_skin = _solve_k(L, solve_skin, target_skin, lo, hi, k_range) if solve_skin.sum() > min_pixels else float("nan")
    k_cloth = float("nan")
    suit = cloth * _smooth_range(hsv[..., 2], -1.0, suit_max_val, 0.05)
    solve_cloth = suit if suit.sum() > min_pixels else cloth
    if regions:  # garments with their own k do not bias the suit's k
        solve_cloth = solve_cloth * (1.0 - _rect_mask(L.shape, [r for reg in regions for r in reg["include"]]))
    if not single_k and solve_cloth.sum() > min_pixels:
        k_cloth = _solve_k(L, solve_cloth, target_cloth, lo, hi, k_range)
    if not np.isfinite(k_skin):
        k_skin = k_cloth if np.isfinite(k_cloth) else k_default
    if single_k or not np.isfinite(k_cloth):
        k_cloth = k_skin
    k = skin * k_skin + (1.0 - skin) * k_cloth
    region_stats = {}
    for reg in regions or []:
        m = _rect_mask(L.shape, reg["include"]) * (1.0 - skin) * valid
        if m.sum() > min_pixels:
            kr = _solve_k(L, m, float(reg.get("target", target_cloth)), lo, hi, k_range)
            k = np.where(m > 0, kr, k)
            region_stats[reg.get("name", "region")] = round(float(kr), 3)
    rough = np.clip(1.0 - k * L, lo, hi).astype(np.float32)

    def wmean(x, w):
        s = float(w.sum())
        return round(float((x * w).sum() / s), 3) if s > 0 else None

    stats = {"k_skin": round(float(k_skin), 3), "k_cloth": round(float(k_cloth), 3), "singleK": bool(single_k),
             "skinMean": wmean(rough, solve_skin), "clothMean": wmean(rough, cloth), "suitMean": wmean(rough, suit),
             "regions": region_stats,
             "skinFraction": round(float(skin.sum() / max(valid.sum(), 1)), 3),
             "specLuminanceMean": wmean(L, valid)}
    return rough, stats


def prepare_roughness(spec_path: str, color_path: str, dst: str, size: int, *, skin_mask_box: dict,
                      params: dict | None = None, force=False):
    """Specular TGA -> roughness PNG (grey, R=G=B=roughness, so glTF metallicRoughness.G carries it
    and lossy WebP keeps it all in luma). Cached by mtime + parameters. Returns (dst, stats)."""
    params = params or {}
    stamp = dst + ".json"
    sig = {"spec": os.path.abspath(spec_path), "mtime": os.path.getmtime(spec_path),
           "color": os.path.abspath(color_path), "cmtime": os.path.getmtime(color_path),
           "size": size, "mask": skin_mask_box, "params": params, "v": 3}
    if not force and os.path.exists(dst) and os.path.exists(stamp):
        with open(stamp) as f:
            prev = json.load(f)
        if prev.get("sig") == json.loads(json.dumps(sig)):
            return dst, prev.get("stats")
    spec = downscale(load_rgba(spec_path), size)
    color = downscale(load_rgba(color_path), size)
    rough, stats = roughness_from_specular(
        spec, color, skin_mask_box=skin_mask_box,
        target_skin=params.get("targetSkin", 0.5), target_cloth=params.get("targetCloth", 0.75),
        lo=params.get("min", 0.25), hi=params.get("max", 0.95), k_range=tuple(params.get("kRange", (1.0, 16.0))),
        single_k=bool(params.get("singleK", False)), skin_rect=params.get("skinRect"),
        blur_px=float(params.get("blurPx", 1.0)), suit_max_val=float(params.get("suitMaxVal", 0.3)),
        regions=params.get("regions"))
    img = np.repeat(rough[..., None], 4, -1)
    img[..., 3] = 1.0
    save_png(img, dst, non_color=True, keep_alpha=False)
    with open(stamp, "w") as f:
        json.dump({"sig": sig, "stats": stats}, f)
    return dst, stats


# ---------------------------------------------------------------------------
# CLI: before/after comparison sheets
# ---------------------------------------------------------------------------


def _cli():
    import argparse
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--cast", required=True)
    ap.add_argument("--id", action="append", required=True)
    ap.add_argument("--out", default=None)
    args = ap.parse_args(argv)
    root = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(args.cast)), "..", ".."))
    cast = json.load(open(args.cast))
    d = cast["defaults"]
    out = args.out or os.path.join(root, "vendor", "previews", "textures")
    for c in cast["characters"]:
        if c["id"] not in args.id:
            continue
        tex_dir = os.path.join(root, cast["sourceRoot"], c["sourceDir"], "Textures")
        for fn in sorted(os.listdir(tex_dir)):
            rules = texture_key_rules(c.get("recolor"), fn)
            if not rules:
                continue
            rgba = load_rgba(os.path.join(tex_dir, fn))
            new, mask = apply_rules(rgba, rules, c.get("skinGuard", d.get("skinGuard")), d.get("recolorFeather"),
                                    int(d.get("recolorHoleFill", 0)))
            a = downscale(rgba, 512)
            b = downscale(new, 512)
            m = downscale(np.repeat(mask[..., None], 4, -1), 512)
            m[..., 3] = 1
            sheet = np.concatenate([a, b, m], axis=1)
            sheet[..., 3] = 1
            dst = os.path.join(out, f"{c['id']}__{os.path.splitext(fn)[0]}.png")
            save_png(sheet, dst)
            print("wrote", dst)


if __name__ == "__main__":
    _cli()
