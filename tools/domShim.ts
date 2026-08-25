/**
 * A canvas stub for headless probes.
 *
 * Several of the game's materials paint their textures on a 2D canvas at
 * construction time, which means a probe cannot build a `Rider` or a `Boat` in
 * Node without a `document`. The probes never rasterise anything — they measure
 * bone positions, physics state and race logic — so the pixels those textures
 * would contain are irrelevant and only the calls must not throw.
 *
 * Deliberately not jsdom or node-canvas: pulling either in to satisfy a handful
 * of no-op drawing calls would add a heavy dependency to a project whose entire
 * premise is that it has almost none, and node-canvas needs native compilation
 * on top of that. This is thirty lines and it cannot drift, because anything the
 * game starts calling that is missing here fails loudly on the next probe run.
 *
 * Import it for side effects before anything that builds a material:
 *
 *   import './domShim.ts';
 */

class StubContext {
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  lineCap = 'butt';
  lineJoin = 'miter';
  font = '';
  textAlign = 'start';
  textBaseline = 'alphabetic';
  globalAlpha = 1;
  globalCompositeOperation = 'source-over';

  private readonly w: number;
  private readonly h: number;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
  }

  save(): void {}
  restore(): void {}
  beginPath(): void {}
  closePath(): void {}
  clip(): void {}
  fill(): void {}
  stroke(): void {}
  moveTo(): void {}
  lineTo(): void {}
  arc(): void {}
  ellipse(): void {}
  rect(): void {}
  fillRect(): void {}
  clearRect(): void {}
  strokeRect(): void {}
  fillText(): void {}
  strokeText(): void {}
  translate(): void {}
  rotate(): void {}
  scale(): void {}
  setTransform(): void {}
  drawImage(): void {}
  quadraticCurveTo(): void {}
  bezierCurveTo(): void {}
  measureText(): { width: number } {
    return { width: 0 };
  }
  createLinearGradient(): { addColorStop(): void } {
    return { addColorStop() {} };
  }
  createRadialGradient(): { addColorStop(): void } {
    return { addColorStop() {} };
  }
  getImageData(): { data: Uint8ClampedArray; width: number; height: number } {
    return { data: new Uint8ClampedArray(this.w * this.h * 4), width: this.w, height: this.h };
  }
  putImageData(): void {}
}

class StubCanvas {
  width = 300;
  height = 150;
  getContext(): StubContext {
    return new StubContext(this.width, this.height);
  }
  toDataURL(): string {
    return 'data:,';
  }
}

if (typeof (globalThis as { document?: unknown }).document === 'undefined') {
  (globalThis as { document?: unknown }).document = {
    createElement(tag: string) {
      if (tag === 'canvas') return new StubCanvas();
      return {};
    },
  };
}
