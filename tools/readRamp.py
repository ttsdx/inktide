#!/usr/bin/env python3
"""
Read the cel ramp off a calibration frame.

The probe sphere is painted with one known colour and lit by one light, so the
distinct values covering it ARE the ramp's bands as the player finally sees
them — after the material, the post chain and the grade have all had a turn.
Reading the ramp anywhere else is reading an intention rather than a result.

Checks the two properties the art direction actually depends on:

  NO CLIPPED CHANNEL. A band with a channel sitting at exactly 0 has been
  clipped, not authored. Clipping is what makes a red hull's shadow come back
  green-black in one frame and blue-black in the next, because which channel
  crosses zero first depends on the pixel.

  STABLE HUE. Every band should be recognisably the paint. A shadow whose hue
  has rotated away from the base is a shadow the eye reads as a different
  object, and it is the difference between cel shading and a posterise filter.

  python3 tools/readRamp.py shots/ramp-after/probe-04-sphere-ramp.png --base ff2e63
"""

import argparse
import colorsys
from collections import Counter
from PIL import Image

LUMA = (0.2126, 0.7152, 0.0722)


def srgb_to_linear(v):
    v /= 255.0
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def lum(c):
    return sum(w * srgb_to_linear(v) for w, v in zip(LUMA, c))


def hue_deg(c):
    h, _, s = colorsys.rgb_to_hsv(c[0] / 255, c[1] / 255, c[2] / 255)
    return h * 360.0, s


def hue_gap(a, b):
    d = abs(a - b) % 360.0
    return min(d, 360.0 - d)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--base", required=True, help="hex base colour of the probe, e.g. ff2e63")
    ap.add_argument("--bands", type=int, default=8, help="how many bands to report")
    ap.add_argument("--hue-tol", type=float, default=60.0,
                    help="degrees of hue either side of the base counted as the object")
    args = ap.parse_args()

    base = tuple(int(args.base[i:i + 2], 16) for i in (0, 2, 4))
    base_h, _ = hue_deg(base)

    im = Image.open(args.image).convert("RGB")
    W, H = im.size
    px = im.load()

    counts = Counter()
    for y in range(0, H, 2):
        for x in range(0, W, 2):
            counts[px[x, y]] += 1
    total = sum(counts.values())

    # Everything within hue tolerance of the paint is the object. The probe
    # sphere is the only thing in frame carrying that hue.
    obj = [(c, n) for c, n in counts.items() if hue_gap(hue_deg(c)[0], base_h) <= args.hue_tol]
    obj.sort(key=lambda t: -t[1])
    obj_total = sum(n for _, n in obj)
    if obj_total == 0:
        print("no pixels matched the base hue; is this the right frame?")
        return

    print(f"{args.image}")
    print(f"  base #{args.base}  hue {base_h:.0f} deg   object covers "
          f"{obj_total / total * 100:.1f}% of sampled pixels\n")
    print("   share   colour            lum    hue   dhue  sat   flags")

    clipped = 0
    for c, n in obj[:args.bands]:
        h, s = hue_deg(c)
        d = hue_gap(h, base_h)
        flags = []
        if 0 in c:
            flags.append("CLIPPED")
            clipped += n
        if d > 25:
            flags.append("HUE DRIFT")
        print(f"  {n / obj_total * 100:5.1f}%   rgb{str(c):16s} {lum(c):.3f}  "
              f"{h:5.0f}  {d:4.0f}  {s:.2f}  {' '.join(flags)}")

    print()
    band_lums = sorted(lum(c) for c, _ in obj[:args.bands])
    print(f"  darkest band luminance : {band_lums[0]:.4f}")
    print(f"  brightest band         : {band_lums[-1]:.4f}")
    print(f"  pixels on a clipped band: {clipped / obj_total * 100:.1f}%"
          + ("   <-- FAIL" if clipped else "   ok"))


if __name__ == "__main__":
    main()
