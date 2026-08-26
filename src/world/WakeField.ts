import {
  BufferGeometry,
  Float32BufferAttribute,
  GLSL3,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Mesh,
  NoBlending,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Uint16BufferAttribute,
  Vector2,
  Vector4,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
} from 'three';
import type { FrameContext, GameSystem } from '../contracts.ts';

/**
 * THE PERSISTENT WAKE FIELD
 *
 * A square patch of world space — half a kilometre across — carried as a pair
 * of ping-ponged render targets that follow the player. Boats do not draw
 * their wake; they *stamp* a small amount of foam into this field every frame
 * near their own hull, and the field's own decay-and-spread pass turns that
 * trickle into a ribbon that scrolls out behind them, widens, softens and
 * dies. That inversion is the entire point: a wake made of geometry towed
 * behind a boat swings with the boat when it turns, and a wake made of a field
 * does not, because the foam is left in the water where it was made.
 *
 * Per frame:
 *   1. ADVECT+DECAY  reads the *previous* target through a small blur kernel,
 *                    multiplies by a time-based decay, and — critically —
 *                    reprojects by the difference between this frame's centre
 *                    and last frame's, so the field is world-locked and the
 *                    foam does not slide when the patch recentres.
 *   2. STAMP         one instanced draw adds every boat's contribution: two
 *                    diverging bow lobes and a turbulent stern trail.
 *
 * The centre is snapped to whole texels. That is not a micro-optimisation: an
 * unsnapped recentre resamples the whole field through a bilinear filter every
 * frame, and repeated resampling is a low-pass filter, so a wake would dissolve
 * from blur long before the decay factor ever got to it. Snapped, the
 * reprojection is an exact texel-for-texel copy and the only blurring in the
 * system is the blurring we asked for.
 *
 * Channels:
 *   R  foam density, 0..1
 *   G  freshness, decays faster than R so the shader can paint new wake as a
 *      bright core and old wake as the shaded tone
 */

/**
 * One boat's contribution. Deliberately a plain structural type rather than a
 * BoatState: the wake system must not care what a boat is, so hull physics can
 * change shape without touching this file.
 */
export interface WakeEmitter {
  /** World position of the hull, at the waterline. */
  position: { x: number; y: number; z: number };
  /** Unit forward direction in world XZ. y is ignored. */
  forward: { x: number; y: number; z: number };
  /** Speed over ground, m/s. */
  speed: number;
  /** Signed yaw rate, rad/s. Positive turns one way, negative the other. */
  turnRate: number;
  /** Hull beam in metres — the width of the churned stern trail. */
  width: number;
  /** 0..1 master gain. Drop it to nothing when the hull is airborne. */
  strength: number;
}

export interface WakeFieldOptions {
  /** Texture resolution per side. */
  resolution?: number;
  /** Half the width of the covered world patch, in metres. */
  halfExtent?: number;
  /** Seconds for a stamp to fall to a tenth of its initial value. */
  lifetime?: number;
  /** Simulation rate. Below 60 the decay is scaled by real elapsed time. */
  updateHz?: number;
  /** Hard cap on simultaneous emitters. */
  maxEmitters?: number;
}

export type WakeQuality = 'low' | 'medium' | 'high' | 'ultra';

/** Floats per emitter instance across the two instanced attributes. */
const EMITTER_FLOATS_A = 4; // posX, posZ, dirX, dirZ
const EMITTER_FLOATS_B = 4; // speed01, turnRate, width, strength

export class WakeField implements GameSystem {
  readonly name = 'WakeField';

  private readonly renderer: WebGLRenderer;
  private targets: [WebGLRenderTarget, WebGLRenderTarget];
  private current = 0;

  private resolution: number;
  private halfExtent: number;
  private lifetime: number;
  private interval: number;
  private readonly maxEmitters: number;

  /** World centre of the patch, snapped to the texel grid. */
  private centre = new Vector2(0, 0);
  private prevCentre = new Vector2(0, 0);
  /** Where the patch wants to be, before snapping. */
  private followTarget = new Vector2(0, 0);
  private hasFollowTarget = false;

  private accumulator = 0;
  private primed = false;

  private readonly quadScene = new Scene();
  private readonly quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly advectMesh: Mesh;
  private readonly advectMaterial: ShaderMaterial;

  private readonly stampScene = new Scene();
  private readonly stampMesh: Mesh;
  private readonly stampMaterial: ShaderMaterial;
  private readonly stampGeometry: InstancedBufferGeometry;
  private readonly emitterA: InstancedBufferAttribute;
  private readonly emitterB: InstancedBufferAttribute;
  private emitterCount = 0;

  /** Point splashes waiting to be stamped, as a flat ring buffer. */
  private splashes = new Float32Array(64 * 4);
  private splashCount = 0;

  constructor(renderer: WebGLRenderer, opts: WakeFieldOptions = {}) {
    this.renderer = renderer;
    this.resolution = opts.resolution ?? 1024;
    this.halfExtent = opts.halfExtent ?? 260;
    this.lifetime = opts.lifetime ?? 8.0;
    this.interval = 1 / (opts.updateHz ?? 60);
    this.maxEmitters = opts.maxEmitters ?? 8;

    this.targets = [this.makeTarget(this.resolution), this.makeTarget(this.resolution)];

    // --- advect + decay pass ---
    this.advectMaterial = new ShaderMaterial({
      name: 'WakeAdvect',
      glslVersion: GLSL3,
      uniforms: {
        uPrev: { value: null as Texture | null },
        uTexel: { value: new Vector2(1 / this.resolution, 1 / this.resolution) },
        // xy = (prevCentre - centre) expressed in UV, z = decay, w = fresh decay
        uShift: { value: new Vector4(0, 0, 0.98, 0.94) },
        uSpread: { value: 1.0 },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: ADVECT_FRAG,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    });
    this.advectMesh = new Mesh(unitQuad(), this.advectMaterial);
    this.advectMesh.frustumCulled = false;
    this.quadScene.add(this.advectMesh);

    // --- stamp pass ---
    this.stampGeometry = new InstancedBufferGeometry();
    const plane = new PlaneGeometry(1, 1);
    this.stampGeometry.setAttribute('position', plane.getAttribute('position'));
    this.stampGeometry.setAttribute('uv', plane.getAttribute('uv'));
    this.stampGeometry.setIndex(plane.getIndex());
    plane.dispose();

    this.emitterA = new InstancedBufferAttribute(
      new Float32Array(this.maxEmitters * EMITTER_FLOATS_A),
      EMITTER_FLOATS_A,
    );
    this.emitterB = new InstancedBufferAttribute(
      new Float32Array(this.maxEmitters * EMITTER_FLOATS_B),
      EMITTER_FLOATS_B,
    );
    this.emitterA.setUsage(35048 /* DynamicDrawUsage */);
    this.emitterB.setUsage(35048);
    this.stampGeometry.setAttribute('iEmitterA', this.emitterA);
    this.stampGeometry.setAttribute('iEmitterB', this.emitterB);
    this.stampGeometry.instanceCount = 0;

    this.stampMaterial = new ShaderMaterial({
      name: 'WakeStamp',
      glslVersion: GLSL3,
      uniforms: {
        // xy = patch centre, z = half extent, w = seconds of stamping
        uPatch: { value: new Vector4(0, 0, this.halfExtent, 1 / 60) },
        uTime: { value: 0 },
      },
      vertexShader: STAMP_VERT,
      fragmentShader: STAMP_FRAG,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      // Additive: a boat that sits still keeps topping up the same texels and
      // saturates, a boat that moves lays a continuous ribbon. Both correct.
      blending: 2 /* AdditiveBlending */,
    });
    this.stampMesh = new Mesh(this.stampGeometry, this.stampMaterial);
    this.stampMesh.frustumCulled = false;
    this.stampScene.add(this.stampMesh);
  }

  private makeTarget(size: number): WebGLRenderTarget {
    // Half float, not bytes. The decay is a multiply by ~0.99 per frame, and
    // in 8-bit any value under about 100/255 multiplied by 0.99 rounds straight
    // back to itself — the wake would stop fading and sit on the water forever.
    const rt = new WebGLRenderTarget(size, size, {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    rt.texture.name = 'WakeField';
    return rt;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** The field texture to hand to Ocean.setWakeField. */
  get texture(): Texture {
    return this.targets[this.current].texture;
  }

  get size(): number {
    return this.resolution;
  }

  get centerX(): number {
    return this.centre.x;
  }

  get centerZ(): number {
    return this.centre.y;
  }

  get extent(): number {
    return this.halfExtent;
  }

  /** Ask the patch to centre itself here. Snapping happens at update time. */
  follow(x: number, z: number): void {
    this.followTarget.set(x, z);
    this.hasFollowTarget = true;
  }

  /**
   * Submit this frame's emitters. Copied into the instance buffers immediately
   * so the caller keeps ownership of its objects and nothing is retained.
   */
  submit(emitters: readonly WakeEmitter[]): void {
    const n = Math.min(emitters.length, this.maxEmitters);
    const a = this.emitterA.array as Float32Array;
    const b = this.emitterB.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const e = emitters[i];
      const fl = Math.hypot(e.forward.x, e.forward.z) || 1;
      a[i * 4 + 0] = e.position.x;
      a[i * 4 + 1] = e.position.z;
      a[i * 4 + 2] = e.forward.x / fl;
      a[i * 4 + 3] = e.forward.z / fl;
      // Normalised against a nominal top speed: the shape of a wake changes
      // with speed but its brightness must not run away with it.
      b[i * 4 + 0] = Math.min(e.speed / 34, 1.4);
      b[i * 4 + 1] = e.turnRate;
      b[i * 4 + 2] = Math.max(e.width, 0.4);
      b[i * 4 + 3] = Math.max(e.strength, 0);
    }
    this.emitterCount = n;
    this.emitterA.needsUpdate = true;
    this.emitterB.needsUpdate = true;
    if (!this.hasFollowTarget && n > 0) {
      this.followTarget.set(emitters[0].position.x, emitters[0].position.z);
    }
  }

  /**
   * A one-off circular stamp — a spray particle hitting the water, a hull
   * slamming down. Queued and flushed on the next update, so callers may fire
   * these from anywhere without caring about render target state.
   */
  splash(x: number, z: number, radius: number, strength: number): void {
    const cap = this.splashes.length / 4;
    if (this.splashCount >= cap) return;
    const i = this.splashCount * 4;
    this.splashes[i] = x;
    this.splashes[i + 1] = z;
    this.splashes[i + 2] = radius;
    this.splashes[i + 3] = strength;
    this.splashCount++;
  }

  /**
   * Two full-screen passes over a 1024x1024 target is nothing on real hardware
   * and quite noticeable on a software rasteriser, so both the resolution and
   * the update rate move with the tier. Halving the resolution costs texel
   * density, halving the rate costs nothing visible at all below about 30 Hz
   * because the decay is scaled by real elapsed time either way.
   */
  setQuality(tier: WakeQuality): void {
    switch (tier) {
      case 'low':
        this.setResolution(256);
        this.setUpdateRate(20);
        break;
      case 'medium':
        this.setResolution(512);
        this.setUpdateRate(30);
        break;
      case 'high':
        this.setResolution(512);
        this.setUpdateRate(30);
        break;
      case 'ultra':
        this.setResolution(1024);
        this.setUpdateRate(60);
        break;
    }
  }

  setResolution(size: number): void {
    const n = Math.max(64, Math.round(size));
    if (n === this.resolution) return;
    this.resolution = n;
    this.targets[0].dispose();
    this.targets[1].dispose();
    this.targets = [this.makeTarget(n), this.makeTarget(n)];
    (this.advectMaterial.uniforms.uTexel.value as Vector2).set(1 / n, 1 / n);
    // Everything in the old field is gone; do not reproject from a dead target.
    this.primed = false;
  }

  setUpdateRate(hz: number): void {
    this.interval = 1 / Math.max(5, hz);
  }

  /** Seconds for a stamp to fade to a tenth. */
  setLifetime(seconds: number): void {
    this.lifetime = Math.max(0.5, seconds);
  }

  update(ctx: FrameContext): void {
    this.accumulator += ctx.dt;
    if (this.primed && this.accumulator < this.interval) return;
    const step = Math.min(this.accumulator, 0.25);
    this.accumulator = 0;

    // Snap the centre to the texel grid so the reprojection below is an exact
    // copy rather than a resample. See the note at the top of the file.
    const texelWorld = (this.halfExtent * 2) / this.resolution;
    this.prevCentre.copy(this.centre);
    this.centre.set(
      Math.round(this.followTarget.x / texelWorld) * texelWorld,
      Math.round(this.followTarget.y / texelWorld) * texelWorld,
    );

    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    const src = this.targets[this.current];
    const dst = this.targets[this.current ^ 1];

    // --- 1. advect + decay ---
    const au = this.advectMaterial.uniforms;
    au.uPrev.value = this.primed ? src.texture : null;
    // A stamp should fall to a tenth over `lifetime`, so the per-second factor
    // is 0.1^(1/lifetime) and the per-step factor is that raised to the step.
    const decay = this.primed ? Math.pow(0.1, step / this.lifetime) : 0;
    (au.uShift.value as Vector4).set(
      (this.prevCentre.x - this.centre.x) / (this.halfExtent * 2),
      (this.prevCentre.y - this.centre.y) / (this.halfExtent * 2),
      decay,
      // Freshness has to die well before the foam does or every wake reads as
      // brand new along its whole length and the ribbon loses its direction.
      this.primed ? Math.pow(0.1, step / (this.lifetime * 0.22)) : 0,
    );
    au.uSpread.value = 1.0;

    r.autoClear = false;
    r.setRenderTarget(dst);
    r.clear(true, false, false);
    r.render(this.quadScene, this.quadCamera);

    // --- 2. stamp ---
    const su = this.stampMaterial.uniforms;
    (su.uPatch.value as Vector4).set(this.centre.x, this.centre.y, this.halfExtent, step);
    su.uTime.value = ctx.elapsed;

    // Splashes ride in the same instanced draw as boats: a zero forward vector
    // and a negative speed flag make the shape shader draw a ring instead.
    const total = this.packSplashes();
    this.stampGeometry.instanceCount = total;
    if (total > 0) r.render(this.stampScene, this.quadCamera);
    this.splashCount = 0;

    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;

    this.current ^= 1;
    this.primed = true;
  }

  /**
   * Append queued splashes after the boat emitters in the instance buffer.
   * Returns the total instance count to draw.
   */
  private packSplashes(): number {
    const a = this.emitterA.array as Float32Array;
    const b = this.emitterB.array as Float32Array;
    let n = this.emitterCount;
    for (let s = 0; s < this.splashCount && n < this.maxEmitters; s++, n++) {
      const i = s * 4;
      a[n * 4 + 0] = this.splashes[i];
      a[n * 4 + 1] = this.splashes[i + 1];
      a[n * 4 + 2] = 0;
      a[n * 4 + 3] = 0;
      b[n * 4 + 0] = -1; // marks a splash rather than a hull
      b[n * 4 + 1] = 0;
      b[n * 4 + 2] = this.splashes[i + 2];
      b[n * 4 + 3] = this.splashes[i + 3];
    }
    if (n !== this.emitterCount) {
      this.emitterA.needsUpdate = true;
      this.emitterB.needsUpdate = true;
    }
    return n;
  }

  dispose(): void {
    this.targets[0].dispose();
    this.targets[1].dispose();
    this.advectMaterial.dispose();
    this.advectMesh.geometry.dispose();
    this.stampMaterial.dispose();
    this.stampGeometry.dispose();
  }
}

/** A full-target triangle pair in clip space. */
function unitQuad(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute(
    'position',
    new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3),
  );
  g.setIndex(new Uint16BufferAttribute([0, 1, 2], 1));
  return g;
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const QUAD_VERT = /* glsl */ `
precision highp float;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Advect, spread and decay.
 *
 * The blur is a five-tap cross rather than a full gaussian. A wake spreads
 * *outwards* over time, which a cross does correctly at a fifth of the cost,
 * and running it every frame compounds into something much smoother than any
 * single-frame kernel could be. The kernel is deliberately weighted towards
 * the centre so the spread is slow: a wake that blurs quickly stops looking
 * like foam and starts looking like fog.
 */
const ADVECT_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

uniform sampler2D uPrev;
uniform vec2 uTexel;
uniform vec4 uShift;
uniform float uSpread;

void main() {
  if (uShift.z <= 0.0) {
    outColor = vec4(0.0);
    return;
  }

  // Reprojection. The patch may have moved since the last step, so the world
  // point under this texel was under a *different* texel last frame. Shifting
  // the read by the centre delta is what world-locks the foam; without it the
  // whole wake slides along with the player like a decal stuck to the camera.
  vec2 uv = vUv + uShift.xy;

  // Off the edge of the previous patch is water we have never simulated.
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) {
    outColor = vec4(0.0);
    return;
  }

  // The weights are the spread *rate*, and they compound. A kernel that looks
  // conservative for one frame is not: at 60 Hz over an eight second lifetime
  // it is applied five hundred times, and the foam performs a random walk with
  // a standard deviation of the square root of that. The first version put 48%
  // of the weight off-centre, which spread a three-metre ribbon into a fifteen
  // metre blob — the wake stopped being a wake and became weather.
  vec2 o = uTexel * uSpread;
  vec4 c = texture(uPrev, uv) * 0.88;
  c += texture(uPrev, uv + vec2(o.x, 0.0)) * 0.03;
  c += texture(uPrev, uv - vec2(o.x, 0.0)) * 0.03;
  c += texture(uPrev, uv + vec2(0.0, o.y)) * 0.03;
  c += texture(uPrev, uv - vec2(0.0, o.y)) * 0.03;

  // Saturate. The stamp pass blends additively into a half-float target, which
  // unlike an 8-bit one does not clamp for us, and the difference is not
  // academic: a boat circling its own wake drove texels to about 3.0, and since
  // the decay is a multiply it then took three extra lifetimes just to get back
  // down to 1.0. Every one of those seconds looked identical, because anything
  // at or above 1.0 shades the same. The result was a wake that read as a solid
  // white slab and appeared to be immortal — the overhead capture came back as
  // a filled ring of foam with no ribbon structure left in it at all. Clamping
  // on read caps the debt at a single frame's deposit, so decay starts working
  // the instant the boat leaves and re-crossing a wake brightens it to full
  // rather than into invisible headroom.
  c = min(c, vec4(1.0));

  outColor = vec4(c.r * uShift.z, c.g * uShift.w, 0.0, 1.0);
}
`;

/**
 * Stamp geometry.
 *
 * Each emitter gets one quad sized to its own footprint and oriented to its
 * own heading, so the fragment shader only runs over the few thousand texels a
 * boat can actually affect. The alternative — one full-target pass looping
 * over emitters — costs a million texels a frame whether or not any boat is
 * near them, which is exactly the sort of thing that is free on a GPU and
 * ruinous on the software rasteriser this project is verified against.
 */
const STAMP_VERT = /* glsl */ `
precision highp float;

in vec4 iEmitterA;   // posX, posZ, dirX, dirZ
in vec4 iEmitterB;   // speed01 (or -1 for a splash), turnRate, width, strength

uniform vec4 uPatch; // xy centre, z half extent, w step seconds

out vec2 vLocal;     // metres, x = across the hull, y = along it (negative aft)
out vec4 vParams;
out float vIsSplash;

void main() {
  float isSplash = step(iEmitterB.x, -0.5);
  vIsSplash = isSplash;
  vParams = iEmitterB;

  vec2 dir = isSplash > 0.5 ? vec2(0.0, 1.0) : iEmitterA.zw;
  vec2 right = vec2(dir.y, -dir.x);

  float speed01 = max(iEmitterB.x, 0.0);
  float width = iEmitterB.z;

  // Footprint. The bow lobes reach sideways as the boat goes faster and the
  // stern churn reaches back; both are clamped so a stationary boat still
  // stamps something and a flat-out one does not blow the quad up.
  float halfAcross = isSplash > 0.5 ? width : (width * 1.5 + 1.8 + speed01 * 2.6);
  float halfAlong = isSplash > 0.5 ? width : (width * 1.8 + 3.2 + speed01 * 5.0);

  vec2 local = vec2(position.x * 2.0 * halfAcross, position.y * 2.0 * halfAlong);
  vLocal = local;

  vec2 world = iEmitterA.xy + right * local.x + dir * local.y;
  vec2 uv = (world - uPatch.xy) / (uPatch.z * 2.0);
  gl_Position = vec4(uv * 2.0, 0.0, 1.0);
}
`;

/**
 * The wake shape.
 *
 * Three ingredients, all stamped only in the immediate neighbourhood of the
 * hull. The ribbon behind the boat is NOT drawn here — it is what the field's
 * own persistence makes out of these stamps as the boat drives away from them.
 *
 *   BOW LOBES   two narrow arms leaving the bow at the Kelvin angle. Widened
 *               from the physical 19.5 degrees to 26 because the real angle
 *               reads as parallel lines at gameplay camera distances.
 *   STERN CHURN a short turbulent patch straight behind the transom, which is
 *               what the ribbon is mostly made of.
 *   TURN SMEAR  the stern kicks out when the boat rotates, so the churn is
 *               displaced across the hull by the yaw rate. This is what makes
 *               a powerslide throw a visible arc of foam instead of the same
 *               straight ribbon as a corner taken flat.
 */
const STAMP_FRAG = /* glsl */ `
precision highp float;

in vec2 vLocal;
in vec4 vParams;
in float vIsSplash;

uniform vec4 uPatch;
uniform float uTime;

layout(location = 0) out vec4 outColor;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  float speed01 = max(vParams.x, 0.0);
  float turn = vParams.y;
  float width = vParams.z;
  float strength = vParams.w;

  // Seconds of stamping, so the deposited amount is frame-rate independent.
  float dt = uPatch.w;

  if (vIsSplash > 0.5) {
    // A spray droplet landing: a small ring, brightest at its rim.
    //
    // The radius is wobbled by an angular hash before the ring is cut, not
    // after, so the tear is in the *shape* rather than a texture laid over a
    // circle. A perfect circle is the one thing that cannot appear here: the
    // overhead capture had a machined 2 m ring sitting in the middle of the
    // ribbon, and a single geometric primitive in a frame of hand-drawn foam
    // reads as a bug even to someone who could not say why.
    float ang = atan(vLocal.y, vLocal.x);
    float wobble = 0.74 + 0.34 * hash21(vec2(floor(ang * 3.5), floor(width * 13.0)));
    float r = length(vLocal) / max(width * wobble, 0.05);
    float ring = smoothstep(1.0, 0.55, r) * smoothstep(0.15, 0.5, r);
    float amt = ring * strength * 0.55;
    outColor = vec4(amt, amt, 0.0, 1.0);
    return;
  }

  float across = vLocal.x;
  float along = vLocal.y;
  float aft = max(-along, 0.0);

  // --- bow lobes -----------------------------------------------------------
  // |across| should equal tan(26 deg) * distance aft. The arm thickens as it
  // travels so the V has weight at its outer ends rather than tapering away.
  float armCentre = 0.4877 * (aft + width * 0.5);
  float armWidth = width * 0.34 + aft * 0.10 + 0.16;
  float armDist = abs(abs(across) - armCentre);
  float arm = 1.0 - smoothstep(armWidth * 0.45, armWidth, armDist);
  // Only stamp the first couple of hull lengths of the arm; the rest of the V
  // is drawn by persistence as the boat advances past this water.
  arm *= 1.0 - smoothstep(width * 2.0, width * 4.5 + 6.0, aft);
  arm *= smoothstep(0.0, 0.35, speed01);

  // --- stern churn ---------------------------------------------------------
  // Displaced across the hull by the yaw rate: a boat rotating hard is
  // presenting its flank to the water and throwing foam to the outside.
  float smear = clamp(turn * 1.35, -1.6, 1.6) * (width * 0.85);
  float churnX = abs(across - smear) / (width * (0.5 + speed01 * 0.16));
  float churn = (1.0 - smoothstep(0.55, 1.15, churnX))
              * (1.0 - smoothstep(width * 0.6, width * 3.4 + 4.0, aft));
  churn *= 0.35 + speed01 * 0.9 + abs(turn) * 0.5;

  // Ahead of the bow there is nothing at all — a wake that leaks forward looks
  // like the boat is being pushed by it.
  float forwardKill = 1.0 - smoothstep(width * 0.2, width * 0.9, max(along, 0.0));

  // A light grain, no more. The torn edge of the finished wake is cut by the
  // ocean shader against its own foam noise, and putting a second, unrelated
  // noise in here as well only fights it — the first attempt stamped hard
  // 30 cm blocks and the ribbon came back looking crocheted.
  float grain = 0.88 + 0.24 * hash21(floor(vLocal * 1.4) + floor(uTime * 6.0));

  // The arms out-weigh the churn, which is the opposite of how much foam each
  // one really carries. It is a drawing decision: from above, the pair of
  // diverging cusp lines is the only part of a wake that says "boat" — the
  // churn behind the transom is just a bright smear that any moving object
  // would leave. Weighting the read towards the arms keeps the V legible after
  // eight seconds of blur have rounded everything off.
  float amount = (arm * 1.5 + churn * 0.7) * strength * forwardKill * grain;

  // Deposit RATE, not deposit, so 60 Hz and 30 Hz lay the same ribbon. The
  // rate rises with speed for a reason that is easy to get wrong: a patch of
  // water sits under the stern for (churn length / speed) seconds, so a fixed
  // rate would make a slow boat lay a far denser ribbon than a fast one. Rate
  // proportional to speed cancels the dwell time and leaves the density of the
  // ribbon constant, which is what a wake actually looks like. The constant
  // term is what stops a drifting boat from laying nothing at all.
  //
  // The absolute scale is set so that one pass of the stern lands about 0.7,
  // not 1.0. Foam that arrives already saturated has nowhere to go, so the
  // ribbon has no falloff along its length and the blur has no gradient to
  // work on — it spreads a plateau sideways instead of a ridge, which is how
  // a six metre trail measured eleven metres wide in the overhead capture.
  amount *= dt * (0.55 + speed01 * 1.8);

  if (amount <= 0.0) discard;
  outColor = vec4(amount, amount * 1.25, 0.0, 1.0);
}
`;
