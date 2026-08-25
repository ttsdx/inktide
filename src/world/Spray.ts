import {
  Color,
  GLSL3,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { FrameContext, GameSystem, SprayRequest } from '../contracts.ts';
import { PALETTE } from '../core/Palette.ts';
import { GERSTNER_GLSL, oceanHeight, oceanParams } from './gerstner.ts';
import { LAYER_OVERLAY } from '../render/layers.ts';

/**
 * SPRAY
 *
 * One instanced mesh of camera-facing quads, one draw call, a fixed pool and a
 * ring-buffer allocator. Nothing is allocated after construction — a racing
 * game throws spray on every landing and every corner, and a system that
 * allocates per burst hands the frame budget to the garbage collector at
 * exactly the moment the player is doing something interesting.
 *
 * Simulation lives entirely in the vertex shader. Each particle uploads its
 * spawn position, velocity, birth time and size once; the shader evaluates
 * ballistic motion from the current clock. That means the CPU never touches a
 * particle again after it is emitted, updating is a single uniform write, and
 * a particle costs nothing until it is drawn.
 *
 * Death is by water contact rather than by timer alone: the shader samples
 * gerstnerHeightAtWorld — the same wave field the ocean surface and the boat
 * buoyancy use — and kills the particle the moment it falls through it. A
 * droplet that hangs in the air after the wave has risen under it is the sort
 * of thing nobody can name but everybody notices.
 *
 * Art direction: these are drawn droplets, not sprites. A hard-edged lumpy
 * blob, a shaded lower half, an ink rim around the whole silhouette, and an
 * opacity that steps through three values over its life and never fades
 * smoothly. Anything soft or round here reads as a particle system.
 */

export interface SprayOptions {
  /** Pool size. Bursts beyond this recycle the oldest particles. */
  capacity?: number;
  /** Metres per second squared. Slightly under real gravity reads better. */
  gravity?: number;
}

export type SprayQuality = 'low' | 'medium' | 'high' | 'ultra';

/** A predicted water impact, queued for whoever wants to stamp foam there. */
export type SprayImpactSink = (x: number, z: number, radius: number, strength: number) => void;

const A_FLOATS = 4; // originX, originY, originZ, birth
const B_FLOATS = 4; // velX, velY, velZ, life
const C_FLOATS = 4; // size, seed, drag, unused

const MAX_PENDING_IMPACTS = 48;

export class Spray implements GameSystem {
  readonly name = 'Spray';
  readonly root: Mesh;

  private readonly material: ShaderMaterial;
  private readonly geometry: InstancedBufferGeometry;
  private readonly attrA: InstancedBufferAttribute;
  private readonly attrB: InstancedBufferAttribute;
  private readonly attrC: InstancedBufferAttribute;
  private readonly attrColor: InstancedBufferAttribute;

  private readonly capacity: number;
  private readonly gravity: number;
  /** Ring-buffer write cursor. */
  private cursor = 0;
  private dirty = false;
  private time = 0;
  private qualityScale = 1;

  private impactSink: SprayImpactSink | null = null;
  /** Flat ring of (time, x, z, strength) for impacts not yet reported. */
  private pending = new Float32Array(MAX_PENDING_IMPACTS * 4);
  private pendingCount = 0;

  private readonly tmpColor = new Color();

  constructor(opts: SprayOptions = {}) {
    this.capacity = opts.capacity ?? 1200;
    this.gravity = opts.gravity ?? 16.5;

    this.geometry = new InstancedBufferGeometry();
    const plane = new PlaneGeometry(1, 1);
    this.geometry.setAttribute('position', plane.getAttribute('position'));
    this.geometry.setAttribute('uv', plane.getAttribute('uv'));
    this.geometry.setIndex(plane.getIndex());
    plane.dispose();

    const mk = (n: number) => {
      const a = new InstancedBufferAttribute(new Float32Array(this.capacity * n), n);
      a.setUsage(35048 /* DynamicDrawUsage */);
      return a;
    };
    this.attrA = mk(A_FLOATS);
    this.attrB = mk(B_FLOATS);
    this.attrC = mk(C_FLOATS);
    this.attrColor = mk(3);

    // Every particle starts long dead, so the first frame draws nothing rather
    // than a thousand droplets sitting at the origin.
    const a = this.attrA.array as Float32Array;
    const b = this.attrB.array as Float32Array;
    for (let i = 0; i < this.capacity; i++) {
      a[i * A_FLOATS + 3] = -1000;
      b[i * B_FLOATS + 3] = 0.001;
    }

    this.geometry.setAttribute('iSpawn', this.attrA);
    this.geometry.setAttribute('iVel', this.attrB);
    this.geometry.setAttribute('iShape', this.attrC);
    this.geometry.setAttribute('iColor', this.attrColor);
    this.geometry.instanceCount = this.capacity;

    this.material = new ShaderMaterial({
      name: 'Spray',
      glslVersion: GLSL3,
      uniforms: {
        uTime: { value: 0 },
        uGravity: { value: this.gravity },
        uAmplitude: { value: oceanParams.amplitude },
        uChoppiness: { value: oceanParams.choppiness },
        uFoam: { value: PALETTE.foam.clone() },
        uFoamShade: { value: PALETTE.foamShade.clone() },
        uInk: { value: PALETTE.inkSoft.clone() },
        uSizeScale: { value: 1 },
        uCameraFar: { value: 4000 },
      },
      vertexShader: SPRAY_VERT,
      fragmentShader: SPRAY_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });

    this.root = new Mesh(this.geometry, this.material);
    this.root.name = 'Spray';
    this.root.frustumCulled = false;
    this.root.userData.noOutline = true;
    this.root.renderOrder = 10;
    this.root.layers.set(LAYER_OVERLAY);
  }

  /**
   * Where to report predicted water impacts. WakeField.splash matches this
   * signature, so wiring the two together is one line and neither module has
   * to know the other exists.
   */
  setImpactSink(sink: SprayImpactSink | null): void {
    this.impactSink = sink;
  }

  emit(req: SprayRequest): void {
    const count = Math.min(Math.max(1, Math.round(req.count * this.qualityScale)), this.capacity);
    const life = Math.max(0.05, req.life);
    const spread = Math.max(0, req.spread);
    const size = Math.max(0.01, req.size);

    const a = this.attrA.array as Float32Array;
    const b = this.attrB.array as Float32Array;
    const c = this.attrC.array as Float32Array;
    const col = this.attrColor.array as Float32Array;

    // White, not the foam colour. The shader multiplies this into uFoam, which
    // is already the foam colour, so defaulting it to foam squared it — and a
    // pale cyan squared is a middling blue-grey. That is the whole reason the
    // droplets kept reading as wet gravel rather than water no matter what was
    // done to the rim and the shading: their base colour was simply wrong.
    // White is the identity here, and req.color still tints from there.
    const tint = req.color ?? this.tmpColor.setRGB(1, 1, 1);

    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.capacity;

      // Spawn inside a squashed sphere: a burst leaving a hull is wider than
      // it is tall, and a perfectly spherical puff reads as a smoke grenade.
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const r = Math.cbrt(Math.random());
      const sx = Math.sqrt(1 - u * u) * Math.cos(th) * r;
      const sy = u * r * 0.55;
      const sz = Math.sqrt(1 - u * u) * Math.sin(th) * r;

      a[i * A_FLOATS + 0] = req.position.x + sx * spread;
      a[i * A_FLOATS + 1] = req.position.y + Math.abs(sy) * spread * 0.7;
      a[i * A_FLOATS + 2] = req.position.z + sz * spread;
      a[i * A_FLOATS + 3] = this.time;

      // Velocity spreads outwards from the burst centre and always has some
      // upward bias, because spray that only goes sideways looks like dust.
      const jitter = 0.55 + Math.random() * 0.9;
      b[i * B_FLOATS + 0] = req.velocity.x + sx * spread * 2.4 * jitter;
      b[i * B_FLOATS + 1] = req.velocity.y + (0.35 + Math.random() * 1.15) * spread * 1.5;
      b[i * B_FLOATS + 2] = req.velocity.z + sz * spread * 2.4 * jitter;
      b[i * B_FLOATS + 3] = life * (0.62 + Math.random() * 0.62);

      c[i * C_FLOATS + 0] = size * (0.55 + Math.random() * 0.95);
      c[i * C_FLOATS + 1] = Math.random() * 1000;
      // Air drag varies per droplet: uniform drag makes a burst move as one
      // rigid shape, and the shape is the thing that gives it away.
      c[i * C_FLOATS + 2] = 0.5 + Math.random() * 1.1;
      c[i * C_FLOATS + 3] = 0;

      col[i * 3 + 0] = tint.r;
      col[i * 3 + 1] = tint.g;
      col[i * 3 + 2] = tint.b;
    }

    this.dirty = true;
    this.queueImpact(req, life);
  }

  /**
   * Predict where the burst centre will hit the water and queue one foam stamp
   * for that moment.
   *
   * Only the centre, not every droplet: the particles are simulated on the GPU
   * and the CPU genuinely does not know where any individual one ends up, and
   * reproducing the whole integration per droplet on the CPU to find out would
   * cost more than the entire rest of this system. One stamp per burst is what
   * reads on screen anyway, because forty droplets landing inside a two metre
   * circle make one patch of foam, not forty.
   */
  private queueImpact(req: SprayRequest, life: number): void {
    if (!this.impactSink || this.pendingCount >= MAX_PENDING_IMPACTS) return;

    const g = this.gravity;
    let x = req.position.x;
    let y = req.position.y;
    let z = req.position.z;
    let vx = req.velocity.x;
    let vy = req.velocity.y;
    let vz = req.velocity.z;

    // Coarse forward integration, capped at the burst's own lifetime. Twelve
    // steps is plenty to find a crossing to within a few centimetres, and this
    // runs once per burst rather than once per particle.
    const steps = 12;
    const dt = life / steps;
    let hitT = -1;
    for (let s = 0; s < steps; s++) {
      vy -= g * dt;
      x += vx * dt;
      y += vy * dt;
      z += vz * dt;
      if (vy < 0 && y <= sampleHeight(x, z, this.time + dt * (s + 1))) {
        hitT = dt * (s + 1);
        break;
      }
    }
    if (hitT < 0) return;

    const i = this.pendingCount * 4;
    this.pending[i] = this.time + hitT;
    this.pending[i + 1] = x;
    this.pending[i + 2] = z;
    this.pending[i + 3] = Math.min(1, req.count / 26);
    this.pendingCount++;
  }

  /**
   * Particle count scales with tier; nothing else does. Halving the droplets
   * in a burst is invisible, halving their size or their opacity is not.
   */
  setQuality(tier: SprayQuality): void {
    this.qualityScale = tier === 'low' ? 0.3 : tier === 'medium' ? 0.6 : 1;
  }

  update(ctx: FrameContext): void {
    this.time = ctx.elapsed;
    const u = this.material.uniforms;
    u.uTime.value = ctx.elapsed;
    u.uAmplitude.value = oceanParams.amplitude;
    u.uChoppiness.value = oceanParams.choppiness;

    if (this.dirty) {
      this.attrA.needsUpdate = true;
      this.attrB.needsUpdate = true;
      this.attrC.needsUpdate = true;
      this.attrColor.needsUpdate = true;
      this.dirty = false;
    }

    // Flush any impacts whose time has come, compacting the ring in place.
    if (this.impactSink && this.pendingCount > 0) {
      let write = 0;
      for (let r = 0; r < this.pendingCount; r++) {
        const i = r * 4;
        if (this.pending[i] <= ctx.elapsed) {
          this.impactSink(
            this.pending[i + 1],
            this.pending[i + 2],
            1.1 + this.pending[i + 3] * 2.2,
            this.pending[i + 3] * 0.8,
          );
        } else {
          const w = write * 4;
          this.pending[w] = this.pending[i];
          this.pending[w + 1] = this.pending[i + 1];
          this.pending[w + 2] = this.pending[i + 2];
          this.pending[w + 3] = this.pending[i + 3];
          write++;
        }
      }
      this.pendingCount = write;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** CPU-side surface height — the same field the vertex shader kills against. */
function sampleHeight(x: number, z: number, t: number): number {
  return oceanHeight(x, z, t);
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const SPRAY_VERT = /* glsl */ `
precision highp float;

${GERSTNER_GLSL}

uniform float uTime;
uniform float uGravity;
uniform float uAmplitude;
uniform float uChoppiness;
uniform float uSizeScale;

in vec4 iSpawn;   // xyz origin, w birth time
in vec4 iVel;     // xyz initial velocity, w lifetime
in vec4 iShape;   // x size, y seed, z drag
in vec3 iColor;

out vec2 vQuad;
out float vLife01;
out float vSeed;
out vec3 vTint;
out float vViewDepth;

void main() {
  float age = uTime - iSpawn.w;
  float life01 = age / max(iVel.w, 0.001);

  // Ballistic motion with exponential drag. The closed form matters: this has
  // to be evaluatable at an arbitrary time so a particle can be re-simulated
  // from scratch every frame without the CPU keeping any state for it.
  float k = iShape.z;
  float decay = (1.0 - exp(-k * age)) / max(k, 0.001);
  vec3 pos = iSpawn.xyz + iVel.xyz * decay + vec3(0.0, -0.5 * uGravity * age * age, 0.0);

  // Kill on water contact using the same field the ocean surface is built
  // from, so a droplet always disappears exactly at the surface it is falling
  // towards rather than at y = 0.
  float waterY = gerstnerHeightAtWorld(pos.xz, uTime, uAmplitude, uChoppiness);
  bool drowned = pos.y < waterY;
  bool expired = life01 >= 1.0 || age < 0.0;

  if (drowned || expired) {
    // Push the vertex outside the clip volume. Cheaper and more reliable than
    // a zero-size quad, which still rasterises a pixel or two at some angles.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vQuad = vec2(0.0);
    vLife01 = 1.0;
    vSeed = 0.0;
    vTint = iColor;
    vViewDepth = 0.0;
    return;
  }

  // Droplets shed mass as they fly: shrink towards the end of life, but in
  // three steps rather than smoothly, to match the quantised opacity.
  float shrink = 1.0 - floor(life01 * 3.0) / 3.0 * 0.42;
  float size = iShape.x * uSizeScale * shrink;

  vec3 viewPos = (viewMatrix * vec4(pos, 1.0)).xyz;
  // Billboard in view space: the quad is always square-on to the camera, and
  // it costs two adds rather than a basis reconstruction in world space.
  viewPos.xy += position.xy * size;

  vQuad = position.xy * 2.0;
  vLife01 = life01;
  vSeed = iShape.y;
  vTint = iColor;
  vViewDepth = -viewPos.z;

  gl_Position = projectionMatrix * vec4(viewPos, 1.0);
}
`;

const SPRAY_FRAG = /* glsl */ `
precision highp float;

layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outNormalDepth;

uniform vec3 uFoam;
uniform vec3 uFoamShade;
uniform vec3 uInk;
uniform float uCameraFar;

in vec2 vQuad;
in float vLife01;
in float vSeed;
in vec3 vTint;
in float vViewDepth;

void main() {
  float a = atan(vQuad.y, vQuad.x);
  float r = length(vQuad);

  // Lumpy, not round. Two low harmonics with a per-particle phase give each
  // droplet its own silhouette, so a burst is forty different shapes rather
  // than forty copies of one circle at forty sizes.
  float lump = 1.0
    + 0.20 * sin(a * 3.0 + vSeed)
    + 0.11 * sin(a * 5.0 - vSeed * 1.7);
  float edge = 0.86 * lump;

  // Hard cut. fwidth keeps it exactly one pixel wide, so a droplet two metres
  // from the camera and one thirty metres away have the same drawn line
  // weight — which is the whole premise of the ink in this project.
  float aa = max(fwidth(r), 0.0025);
  float body = 1.0 - smoothstep(edge - aa, edge + aa, r);
  // The ink contour is a *line*, not a band. At 26% of the radius — which is
  // what the first version drew — a droplet is more outline than droplet, and
  // the capture came back as a scatter of dark grey pebbles instead of white
  // water. Ink is the last 10%, and everything inside it is foam.
  // 4% of the radius, not 10%. Particles sit at the BOTTOM of the ink
  // hierarchy: a frame audit found forty spray droplets each carrying a
  // heavier contour than the hero boat, which inverts the reading order and
  // sends the eye to the popcorn. The droplets keep a contour so they still
  // read as drawn rather than as bloom, but it must never out-weigh the hull.
  float rimRaw = 1.0 - smoothstep(edge * 0.96 - aa, edge * 0.96 + aa, r);

  // Band-limit the ink, and do it explicitly rather than trusting the hard
  // step to degrade gracefully — it does not.
  //
  // The contour is 10% of the radius wide. Once a droplet is small enough on
  // screen that one pixel covers more than that, the inner and outer
  // smoothsteps overlap, and their difference stops being a line: it becomes a
  // partial ink wash over the entire droplet, centre included. Foam mixed
  // halfway to a navy ink is a mid grey, which is exactly what the burst
  // capture showed near the horizon — a scatter of grey gravel hanging over
  // blue water. Below the resolvable width the ink is dropped entirely and the
  // droplet is drawn as pure foam, which is the same trade an inker makes when
  // a shape gets too small to outline: you do not draw a thinner line, you stop
  // drawing the line.
  float inkVisible = 1.0 - smoothstep(edge * 0.06, edge * 0.18, aa);
  float rim = mix(1.0, rimRaw, inkVisible);

  if (body <= 0.0) discard;

  vec3 col = mix(uInk, uFoam * vTint, rim);
  // One shaded crescent on the away side, offset rather than concentric, so
  // every droplet in a burst is lit from the same direction as the sun. It
  // fades out with the ink for the same reason: a two-tone droplet four pixels
  // across is a one-tone droplet with the wrong tone.
  float shade = smoothstep(edge * 0.68 - aa, edge * 0.68 + aa,
                           length(vQuad - vec2(-0.30, 0.34)));
  col = mix(col, uFoamShade, shade * rim * 0.5 * mix(0.35, 1.0, inkVisible));

  // Opacity steps through three values and holds. A smooth fade is what makes
  // a particle read as a particle; a drawn droplet is either there or it is
  // not, and it leaves in visible increments.
  float fade = 1.0 - vLife01;
  float steps = ceil(clamp(fade, 0.0, 1.0) * 3.0) / 3.0;
  float alpha = body * steps;
  // Except right at birth, where one frame of ramp-in stops a burst appearing
  // as a single popped-on wall of white.
  alpha *= smoothstep(0.0, 0.06, vLife01);

  outColor = vec4(col, alpha);

  // Deliberately transparent in the edge buffer. Spray is drawn after the
  // water into the same attachment, so writing a real normal and depth here
  // would punch particle-shaped holes in the ocean's entry and the Sobel pass
  // would outline every single droplet. A zero alpha leaves the water's own
  // packed normal untouched under the blend.
  outNormalDepth = vec4(0.0);
}
`;
