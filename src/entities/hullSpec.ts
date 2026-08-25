import { Vector3 } from 'three';
import type { BoatSpec } from '../contracts.ts';

/**
 * HULL SPEC
 *
 * The dimensions and attachment points every part of the boat subsystem agrees
 * on. This file exists so that the physics and the geometry can be written
 * independently: the physics needs to know where the hull's buoyancy probes and
 * thrust point are, the geometry needs to build a shape that actually has
 * material at those places, and neither should have to import the other.
 *
 * All coordinates are hull-local, in metres:
 *   +X starboard, +Y up, +Z forward (the bow).
 *   The origin sits at the design waterline, mid-hull.
 */

/** Bow to transom. */
export const HULL_LENGTH = 5.4;
/** Maximum beam across the sponsons. */
export const HULL_BEAM = 2.45;
/** Beam of the centre hull alone, excluding sponsons. */
export const HULL_CENTRE_BEAM = 1.32;
/** Design waterline to the lowest point of the keel. */
export const HULL_DRAFT = 0.46;
/** Waterline to the top of the deck coaming. */
export const HULL_FREEBOARD = 0.72;

/**
 * Buoyancy probes: six points on the actual hull bottom.
 *
 * Placement is the whole game here. Probes clustered near the centreline give a
 * boat that heaves but never rolls; probes pushed out to the sponsons give it
 * real roll authority off a wave face. Likewise the bow/stern spread sets how
 * violently it pitches into a trough. These are deliberately spread to about
 * 80% of the hull's half-beam and 78% of its half-length — wide enough to feel
 * like a boat fighting water, short of the extremes where a single probe
 * catching a crest can flip the whole hull.
 *
 * Y values follow the keel rocker: deepest amidships, rising towards the bow so
 * the boat can plane, and rising slightly at the transom.
 */
export const HULL_PROBE_POINTS: readonly Vector3[] = [
  // bow centre — the probe that slams into troughs
  new Vector3(0.0, -0.30, 2.10),
  // forward pair, at the sponson shoulders
  new Vector3(-0.96, -0.34, 1.05),
  new Vector3(0.96, -0.34, 1.05),
  // aft pair, at the sponson tails — the main planing surfaces
  new Vector3(-0.98, -0.44, -1.30),
  new Vector3(0.98, -0.44, -1.30),
  // transom centre
  new Vector3(0.0, -0.40, -2.15),
] as const;

/** Relative share of total buoyancy each probe carries; sums to 1. */
export const HULL_PROBE_WEIGHTS: readonly number[] = [0.13, 0.17, 0.17, 0.21, 0.21, 0.11];

/** Where thrust is applied. Below the waterline at the transom, like a real jet. */
export const THRUST_POINT = new Vector3(0, -0.28, -2.35);

/** Where the rudder pivots; the yaw reference for steering. */
export const RUDDER_POINT = new Vector3(0, -0.34, -2.5);

/** Cockpit floor the rider stands/sits on. */
export const RIDER_MOUNT = new Vector3(0, 0.30, -0.28);

/** Handlebar position the rider's hands are IK'd to. */
export const HANDLEBAR_POINT = new Vector3(0, 1.02, 0.62);

/** Engine intake / exhaust glow position. */
export const ENGINE_POINT = new Vector3(0, 0.46, -1.72);

/** Points that spray is emitted from: bow wave left/right and the stern rooster. */
export const SPRAY_POINTS: readonly Vector3[] = [
  new Vector3(-0.72, -0.05, 1.75),
  new Vector3(0.72, -0.05, 1.75),
  new Vector3(0.0, -0.05, -2.05),
] as const;

/**
 * Collision capsule in the XZ plane: the hull is treated as a circle of this
 * radius for boat-to-boat contact. A capsule along the keel would be more
 * accurate, but four arcade boats bumping need predictable, forgiving contact
 * far more than they need accuracy.
 */
export const HULL_COLLISION_RADIUS = 1.55;

/** Mass distribution: yaw inertia relative to mass, in m^2. */
export const HULL_YAW_INERTIA = 2.4;
export const HULL_PITCH_INERTIA = 3.1;
export const HULL_ROLL_INERTIA = 1.35;

// ---------------------------------------------------------------------------
// The four racers
// ---------------------------------------------------------------------------

/**
 * Specs are differentiated along one axis each so the differences are legible
 * from the driver's seat rather than being a wash of small numbers. The player
 * gets the balanced boat; if the player's boat has a quirk, every mistake feels
 * like the game's fault.
 */
export const BOAT_SPECS: readonly BoatSpec[] = [
  {
    name: 'Vermillion',
    colorIndex: 0,
    topSpeed: 34.0,
    acceleration: 15.5,
    turnRate: 1.62,
    mass: 420,
    slidiness: 0.5,
  },
  {
    // Fastest flat out, but it will not stick. Punishes greed.
    name: 'Emberjack',
    colorIndex: 1,
    topSpeed: 36.2,
    acceleration: 16.4,
    turnRate: 1.52,
    mass: 395,
    slidiness: 0.68,
  },
  {
    // Slower, heavier, glued down. Wins by never making a mistake.
    name: 'Violet Reach',
    colorIndex: 2,
    topSpeed: 32.6,
    acceleration: 14.2,
    turnRate: 1.74,
    mass: 470,
    slidiness: 0.36,
  },
  {
    // Light and darty. Brilliant in the chicane, unstable in the swell.
    name: 'Limewire',
    colorIndex: 3,
    topSpeed: 34.6,
    acceleration: 17.2,
    turnRate: 1.83,
    mass: 360,
    slidiness: 0.58,
  },
] as const;
