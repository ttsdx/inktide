#!/usr/bin/env python3
"""
Read a waterline calibration frame and print the CPU/GPU surface disagreement
in metres.

The rig (src/dev/WaterlineRig.ts) plants a banded staff whose zero — the top
edge of the single red band — is placed at exactly the height sampleOcean()
reports. The vertex shader displaces the water independently. Wherever the water
actually crosses the staff IS the shader's answer, so the gap between that
crossing and the top of the red band is the disagreement, and the band pitch
gives the scale to convert it from pixels to metres.

This is done numerically rather than by eye because the interesting errors are
small: at the near station one band is 10 cm and 20 screen pixels, so a 3 cm
error is 6 pixels and completely invisible at fit-to-screen size.

  python3 tools/readWaterline.py shots/wl1/wl-0-6m-t7.png --band 0.10
"""

import argparse
import sys
from PIL import Image


def classify(p):
    """staff-dark | staff-light | zero | water | other

    'other' is mostly the anti-aliased pixel or two on every band boundary. The
    run-length pass below skips those rather than treating them as a class, so
    the boundary is found at the last pixel that still clearly belonged to the
    band above it.
    """
    r, g, b = p
    # The staff's dark band renders as a dark green with no red in it at all.
    # Water is also red-free but is far brighter in green and blue.
    if r < 70 and 35 < g < 150 and b < 110:
        return "dark"
    if r > 200 and g < 170 and b < 120:
        return "zero"
    if r > 150 and g > 180 and b > 175:
        return "light"
    if r < 110 and g > 150 and b > 175:
        return "water"
    return "other"


def find_staff_columns(im):
    """Columns holding enough staff-dark pixels to be a staff, grouped."""
    W, H = im.size
    px = im.load()
    hits = []
    for x in range(W):
        n = 0
        for y in range(0, H, 2):
            if classify(px[x, y]) == "dark":
                n += 1
        if n >= 4:
            hits.append(x)
    groups = []
    for x in hits:
        if groups and x - groups[-1][-1] <= 6:
            groups[-1].append(x)
        else:
            groups.append([x])
    return groups


def runs_for_column(px, x, H):
    """Class runs down one column, with 'other' pixels dropped."""
    out = []
    for y in range(H):
        c = classify(px[x, y])
        if c == "other":
            continue
        if out and out[-1][0] == c:
            out[-1][2] = y
        else:
            out.append([c, y, y])
    return out


def analyse(im, xs, band_m):
    W, H = im.size
    px = im.load()

    # Measure on the column with the most band runs: the staff's lit face has
    # the crispest boundaries, its shaded face can lose a band into 'other'.
    best = None
    for x in xs:
        runs = runs_for_column(px, x, H)
        n = sum(1 for r in runs if r[0] in ("dark", "light"))
        if best is None or n > best[0]:
            best = (n, x, runs)
    _, x, runs = best

    band_runs = [r for r in runs if r[0] in ("dark", "light")]
    if len(band_runs) < 4:
        return {"x": x, "note": "not enough bands to measure", "error_m": None}

    # One band's height in pixels, as the median run length. Runs touching the
    # waterline or the top of the staff are partial, so a median rather than a
    # mean is what keeps them from dragging the scale.
    lens = sorted(r[2] - r[1] + 1 for r in band_runs)
    px_per_band = lens[len(lens) // 2]
    if px_per_band < 2:
        return {"x": x, "note": "bands are sub-pixel here", "error_m": None}

    zero_runs = [r for r in runs if r[0] == "zero"]
    if not zero_runs:
        return {"x": x, "px_per_band": px_per_band,
                "note": "red zero band not visible", "error_m": None}
    zero_y = zero_runs[0][1]

    water = [r for r in runs if r[0] == "water" and r[1] >= zero_y]
    if not water:
        return {"x": x, "px_per_band": px_per_band, "zero_y": zero_y,
                "note": "no water below zero", "error_m": None}
    water_y = water[0][1]

    # Positive => the staff is still visible below its own zero mark => the
    # drawn water is LOWER than the sampler says => anything placed from the
    # sampler hovers by this much.
    return {
        "x": x,
        "px_per_band": px_per_band,
        "zero_y": zero_y,
        "water_y": water_y,
        "error_m": (water_y - zero_y) / px_per_band * band_m,
        "note": "",
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("images", nargs="+")
    ap.add_argument("--band", type=float, default=0.10,
                    help="metres per band on the staff in these frames")
    args = ap.parse_args()

    for path in args.images:
        im = Image.open(path).convert("RGB")
        groups = find_staff_columns(im)
        if not groups:
            print(f"{path}: no staff found")
            continue
        # The widest group is the nearest staff, which is the one framed.
        # The widest group is the nearest staff, which is the framed one.
        groups.sort(key=len, reverse=True)
        r = analyse(im, groups[0], args.band)
        if r["error_m"] is None:
            extra = f", {r['px_per_band']} px/band" if "px_per_band" in r else ""
            print(f"{path}: {r['note']}  [x={r['x']}{extra}]")
            continue
        sign = ("hovers" if r["error_m"] > 0.01
                else "sinks" if r["error_m"] < -0.01 else "agrees")
        print(f"{path}: {r['error_m']*100:+.1f} cm  ({sign})  "
              f"[x={r['x']}, {r['px_per_band']} px/band, "
              f"zero y={r['zero_y']}, water y={r['water_y']}]")


if __name__ == "__main__":
    sys.exit(main())
