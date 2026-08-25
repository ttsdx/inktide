/**
 * GERSTNER OCEAN — the single source of truth for the water surface.
 *
 * The ocean is displaced on the GPU in a vertex shader, but boat buoyancy, the
 * racing-line ribbon, gate floats and spray spawn points all need the *same*
 * surface on the CPU. If those two ever disagree the boats visibly hover or
 * sink, so both sides are generated from the one `WAVES` table below: the GLSL
 * constant array is emitted from the same numbers the TypeScript sampler reads.
 *
 * Formulation follows GPU Gems 1, ch.1 (Finch). For each wave i with direction
 * D, wavelength L, amplitude A and steepness Q:
 *
 *     k     = 2*PI / L                      (wave number)
 *     omega = sqrt(g * k) * speed           (deep-water dispersion)
 *     phase = k * dot(D, xz) - omega*t + off
 *
 *     P.xz += Q * A * D * cos(phase)        (horizontal pinch -> sharp crests)
 *     P.y  += A * sin(phase)
 *
 * Sum(Q_i * A_i * k_i) must stay below 1 or the surface folds through itself.
 * The table below sums to ~0.71, which gives genuinely peaked crests with round
 * troughs — the Wave Race silhouette — while staying single-valued.
 */

export interface WaveParam {
  /** Direction of travel in world XZ. Normalised at build time. */
  dirX: number;
  dirZ: number;
  /** Crest-to-mean height in metres. */
  amplitude: number;
  /** Crest-to-crest distance in metres. */
  wavelength: number;
  /** 0..1 horizontal pinch. Higher = sharper crest, flatter trough. */
  steepness: number;
  /** Multiplier on the physically-derived phase speed. */
  speed: number;
  /** Static phase offset so the waves do not all crest at the origin at t=0. */
  offset: number;
}

const GRAVITY = 9.81;

function norm(x: number, z: number): [number, number] {
  const l = Math.hypot(x, z) || 1;
  return [x / l, z / l];
}

function wave(
  dx: number,
  dz: number,
  amplitude: number,
  wavelength: number,
  steepness: number,
  speed: number,
  offset: number,
): WaveParam {
  const [dirX, dirZ] = norm(dx, dz);
  return { dirX, dirZ, amplitude, wavelength, steepness, speed, offset };
}

/**
 * Six layered waves: two long swells that carry the boat, two mid waves that
 * give the surface its shape, two short chop waves that keep it from ever
 * reading as a repeating pattern. The directions are deliberately non-parallel
 * and the wavelengths are mutually irrational-ish so the combined field has an
 * effective repeat period far longer than any player will drive.
 */
export const WAVES: readonly WaveParam[] = [
  // --- primary swell: the one the boats surf, slow and heavy ---
  wave(1.0, 0.31, 1.9, 112.0, 1.0, 1.0, 0.0),
  wave(0.58, -1.0, 1.35, 78.5, 1.0, 1.03, 1.7),
  // --- mid detail: gives the swell faces their form ---
  wave(-0.77, 0.66, 0.78, 41.3, 1.0, 1.11, 3.4),
  wave(0.91, 0.86, 0.52, 26.7, 1.0, 1.18, 5.1),
  // --- chop: high frequency sparkle-catching ripple ---
  wave(-0.34, -1.0, 0.3, 14.3, 1.0, 1.29, 2.2),
  wave(1.0, -0.27, 0.165, 8.15, 1.0, 1.44, 4.6),
];

export const WAVE_COUNT = WAVES.length;

/** Derived per-wave constants, precomputed once. */
interface WaveDerived extends WaveParam {
  k: number;
  omega: number;
  qa: number; // steepness * amplitude, the horizontal displacement magnitude
}

const DERIVED: WaveDerived[] = WAVES.map((w) => {
  const k = (Math.PI * 2) / w.wavelength;
  return {
    ...w,
    k,
    omega: Math.sqrt(GRAVITY * k) * w.speed,
    qa: w.steepness * w.amplitude,
  };
});

/** Total steepness; kept under 1.0 to guarantee a single-valued surface. */
export const TOTAL_STEEPNESS = DERIVED.reduce((s, w) => s + w.qa * w.k, 0);

/** Sum of amplitudes — the theoretical maximum crest height. */
export const MAX_WAVE_HEIGHT = WAVES.reduce((s, w) => s + w.amplitude, 0);

// ---------------------------------------------------------------------------
// Runtime-tunable globals. These are mirrored into every ocean-aware shader as
// uniforms so the CPU sampler and the GPU vertex shader stay locked together.
// ---------------------------------------------------------------------------

export const oceanParams = {
  /** Global height scale. 1.0 = the table above. */
  amplitude: 0.92,
  /**
   * Horizontal pinch scale. >1 sharpens crests without raising them.
   *
   * The real steepness budget is TOTAL_STEEPNESS * amplitude * choppiness, and
   * it must stay under 1.0 or the displacement map folds back through itself
   * and the surface self-intersects. 0.7148 * 0.92 * 1.34 = 0.881, which sits
   * close enough to the limit to give genuinely peaked crests over round
   * troughs — the Wave Race silhouette — with enough margin that the CPU
   * sampler's three fixed-point inversion steps still converge.
   */
  choppiness: 1.34,
  /** Global time scale. */
  timeScale: 1.0,
};

// ---------------------------------------------------------------------------
// CPU sampler
// ---------------------------------------------------------------------------

export interface OceanSample {
  /** Water surface height (world Y) at the queried XZ. */
  height: number;
  /** Unit surface normal. */
  nx: number;
  ny: number;
  nz: number;
  /**
   * Folding measure of the horizontal displacement field. Approaches 0 (and
   * below) where the surface pinches at a crest — the classic foam mask.
   */
  jacobian: number;
}

const _sample: OceanSample = { height: 0, nx: 0, ny: 1, nz: 0, jacobian: 1 };

/**
 * Evaluate the displaced surface for a *source* grid point.
 * This is the direct forward evaluation, matching the vertex shader exactly.
 */
function evaluate(px: number, pz: number, t: number, out: OceanSample): OceanSample {
  const amp = oceanParams.amplitude;
  const chop = oceanParams.choppiness;

  let y = 0;
  // Normal accumulators (GPU Gems form).
  let nAx = 0;
  let nAz = 0;
  let nAy = 0;
  // Jacobian accumulators.
  let jxx = 0;
  let jzz = 0;
  let jxz = 0;

  for (let i = 0; i < DERIVED.length; i++) {
    const w = DERIVED[i];
    const phase = w.k * (w.dirX * px + w.dirZ * pz) - w.omega * t + w.offset;
    const s = Math.sin(phase);
    const c = Math.cos(phase);
    const a = w.amplitude * amp;
    const wa = w.k * a;
    const qa = w.qa * amp * chop;

    y += a * s;

    nAx += w.dirX * wa * c;
    nAz += w.dirZ * wa * c;
    nAy += w.steepness * wa * s;

    const qak = qa * w.k * s;
    jxx -= w.dirX * w.dirX * qak;
    jzz -= w.dirZ * w.dirZ * qak;
    jxz -= w.dirX * w.dirZ * qak;
  }

  const nx = -nAx;
  const ny = 1.0 - nAy;
  const nz = -nAz;
  const inv = 1 / (Math.hypot(nx, ny, nz) || 1);

  out.height = y;
  out.nx = nx * inv;
  out.ny = ny * inv;
  out.nz = nz * inv;
  out.jacobian = (1 + jxx) * (1 + jzz) - jxz * jxz;
  return out;
}

/** Horizontal displacement only — used by the fixed-point inversion below. */
function horizontal(px: number, pz: number, t: number, out: { x: number; z: number }): void {
  const chop = oceanParams.choppiness * oceanParams.amplitude;
  let dx = 0;
  let dz = 0;
  for (let i = 0; i < DERIVED.length; i++) {
    const w = DERIVED[i];
    const phase = w.k * (w.dirX * px + w.dirZ * pz) - w.omega * t + w.offset;
    const c = Math.cos(phase) * w.qa * chop;
    dx += w.dirX * c;
    dz += w.dirZ * c;
  }
  out.x = dx;
  out.z = dz;
}

const _h = { x: 0, z: 0 };

/**
 * Sample the ocean at a **world** XZ position.
 *
 * Gerstner waves move vertices horizontally, so the vertex that ends up above
 * world point (x,z) did not start there. We invert the horizontal displacement
 * with three fixed-point iterations, which converges to well under a centimetre
 * for our steepness budget and costs far less than a search.
 */
export function sampleOcean(x: number, z: number, t: number, out: OceanSample = _sample): OceanSample {
  let sx = x;
  let sz = z;
  for (let iter = 0; iter < 3; iter++) {
    horizontal(sx, sz, t, _h);
    sx = x - _h.x;
    sz = z - _h.z;
  }
  return evaluate(sx, sz, t, out);
}

/** Convenience: just the water height at a world XZ. */
export function oceanHeight(x: number, z: number, t: number): number {
  return sampleOcean(x, z, t, _sample).height;
}

// ---------------------------------------------------------------------------
// GLSL emission
// ---------------------------------------------------------------------------

const f = (n: number) => {
  const s = n.toFixed(6);
  return s.includes('.') ? s : `${s}.0`;
};

/**
 * The wave table as a GLSL constant array. Emitted from `WAVES` so the shader
 * and the CPU sampler can never drift apart.
 * Layout: vec4(dirX, dirZ, amplitude, waveNumber k)
 *         vec4(omega, steepness, 0, 0) packed as a second array.
 */
function waveTableGLSL(): string {
  const a = DERIVED.map((w) => `vec4(${f(w.dirX)}, ${f(w.dirZ)}, ${f(w.amplitude)}, ${f(w.k)})`);
  const b = DERIVED.map((w) => `vec3(${f(w.omega)}, ${f(w.steepness)}, ${f(w.offset)})`);
  return `
const int GERSTNER_COUNT = ${WAVE_COUNT};
// (dirX, dirZ, amplitude, waveNumber)
const vec4 GERSTNER_A[GERSTNER_COUNT] = vec4[GERSTNER_COUNT](
  ${a.join(',\n  ')}
);
// (omega, steepness, phaseOffset)
const vec3 GERSTNER_B[GERSTNER_COUNT] = vec3[GERSTNER_COUNT](
  ${b.join(',\n  ')}
);`;
}

/**
 * GLSL implementation of the wave field.
 *
 * Provides:
 *   `GerstnerResult gerstnerEval(vec2 p, float t, float amp, float chop)`
 *     -> displaced position, analytic normal, folding jacobian, crest weight.
 *
 * `crest` is a 0..1 measure of how close the sample is to a wave peak, built
 * from the swell-only height so that short chop does not confetti the foam.
 */
export const GERSTNER_GLSL = /* glsl */ `
${waveTableGLSL()}

struct GerstnerResult {
  vec3 position;   // world-space displaced point
  vec3 normal;     // unit surface normal
  float jacobian;  // <1 where the surface folds (crest pinch) -> foam mask
  float crest;     // 0..1 swell-only crest proximity
  float slope;     // 0..1 steepness of the face
};

GerstnerResult gerstnerEval(vec2 p, float t, float amp, float chop) {
  GerstnerResult r;

  vec3 disp = vec3(0.0);
  vec3 nAcc = vec3(0.0);   // (x accum, y accum, z accum)
  float jxx = 0.0;
  float jzz = 0.0;
  float jxz = 0.0;
  float swellHeight = 0.0;
  float swellAmp = 0.0;

  for (int i = 0; i < GERSTNER_COUNT; i++) {
    vec4 A = GERSTNER_A[i];
    vec3 B = GERSTNER_B[i];
    vec2 dir = A.xy;
    float amplitude = A.z * amp;
    float k = A.w;
    float omega = B.x;
    float steep = B.y;
    float phaseOff = B.z;

    float phase = k * dot(dir, p) - omega * t + phaseOff;
    float s = sin(phase);
    float c = cos(phase);

    float qa = steep * amplitude * chop;
    disp.xz += dir * qa * c;
    disp.y  += amplitude * s;

    float wa = k * amplitude;
    nAcc.x += dir.x * wa * c;
    nAcc.z += dir.y * wa * c;
    nAcc.y += steep * wa * s;

    float qak = qa * k * s;
    jxx -= dir.x * dir.x * qak;
    jzz -= dir.y * dir.y * qak;
    jxz -= dir.x * dir.y * qak;

    // The first two entries are the long swell; track them separately so the
    // crest mask follows the big rollers instead of every ripple.
    if (i < 2) {
      swellHeight += amplitude * s;
      swellAmp += amplitude;
    }
  }

  r.position = vec3(p.x + disp.x, disp.y, p.y + disp.z);
  vec3 n = normalize(vec3(-nAcc.x, 1.0 - nAcc.y, -nAcc.z));
  r.normal = n;
  r.jacobian = (1.0 + jxx) * (1.0 + jzz) - jxz * jxz;
  r.crest = clamp(swellHeight / max(swellAmp, 0.0001) * 0.5 + 0.5, 0.0, 1.0);
  r.slope = clamp(1.0 - n.y, 0.0, 1.0);
  return r;
}

// Height-only variant for cheap lookups (ribbons, floats, LOD skirts).
float gerstnerHeight(vec2 p, float t, float amp) {
  float y = 0.0;
  for (int i = 0; i < GERSTNER_COUNT; i++) {
    vec4 A = GERSTNER_A[i];
    vec3 B = GERSTNER_B[i];
    float phase = A.w * dot(A.xy, p) - B.x * t + B.z;
    y += A.z * amp * sin(phase);
  }
  return y;
}

// Invert the horizontal pinch so a world XZ maps back to its source grid point.
// Matches sampleOcean() on the CPU: three fixed-point iterations.
vec2 gerstnerUnproject(vec2 worldXZ, float t, float amp, float chop) {
  vec2 p = worldXZ;
  for (int iter = 0; iter < 3; iter++) {
    vec2 d = vec2(0.0);
    for (int i = 0; i < GERSTNER_COUNT; i++) {
      vec4 A = GERSTNER_A[i];
      vec3 B = GERSTNER_B[i];
      float phase = A.w * dot(A.xy, p) - B.x * t + B.z;
      d += A.xy * (B.y * A.z * amp * chop) * cos(phase);
    }
    p = worldXZ - d;
  }
  return p;
}

// Surface height at a true world XZ (unprojects first). Used by the racing-line
// ribbon and anything else that must sit exactly on the water.
float gerstnerHeightAtWorld(vec2 worldXZ, float t, float amp, float chop) {
  return gerstnerHeight(gerstnerUnproject(worldXZ, t, amp, chop), t, amp);
}
`;
