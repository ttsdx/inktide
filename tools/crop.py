#!/usr/bin/env python3
"""
Crop and magnify a region of a captured frame.

Retina captures are 3200x1800. Anything read at fit-to-screen size is being
judged at well under half resolution, which is exactly how a 2 px line artefact
or a 5 cm waterline error goes unnoticed for several rounds. This pulls a region
out at full resolution, optionally magnified with nearest-neighbour so single
pixels stay square and countable.

  python3 tools/crop.py shots/g1/hero-01-chase.png out.png --box 0.4 0.5 0.2 0.3
  python3 tools/crop.py in.png out.png --px 1200 800 400 300 --zoom 3

--box takes fractions of the image (x y w h), --px takes pixels.
"""

import argparse
from PIL import Image


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--box", nargs=4, type=float, metavar=("X", "Y", "W", "H"),
                    help="region as fractions of the image")
    ap.add_argument("--px", nargs=4, type=int, metavar=("X", "Y", "W", "H"),
                    help="region in pixels")
    ap.add_argument("--zoom", type=float, default=1.0)
    ap.add_argument("--grid", type=int, default=0,
                    help="overlay a grid every N source pixels")
    args = ap.parse_args()

    im = Image.open(args.src).convert("RGB")
    W, H = im.size

    if args.px:
        x, y, w, h = args.px
    elif args.box:
        x, y, w, h = (int(args.box[0] * W), int(args.box[1] * H),
                      int(args.box[2] * W), int(args.box[3] * H))
    else:
        x, y, w, h = 0, 0, W, H

    x = max(0, min(W - 1, x))
    y = max(0, min(H - 1, y))
    w = max(1, min(W - x, w))
    h = max(1, min(H - y, h))

    out = im.crop((x, y, x + w, y + h))

    if args.zoom != 1.0:
        out = out.resize((int(w * args.zoom), int(h * args.zoom)), Image.NEAREST)

    if args.grid:
        # A ruler baked into the image, so a measurement taken off the crop can
        # be converted back to source pixels without counting by eye.
        px = out.load()
        step = max(1, int(args.grid * args.zoom))
        for gy in range(0, out.size[1], step):
            for gx in range(out.size[0]):
                px[gx, gy] = (255, 0, 255)
        for gx in range(0, out.size[0], step):
            for gy in range(out.size[1]):
                px[gx, gy] = (255, 0, 255)

    out.save(args.dst)
    print(f"{args.src} {W}x{H} -> {args.dst} {out.size[0]}x{out.size[1]} "
          f"(src region {x},{y} {w}x{h})")


if __name__ == "__main__":
    main()
