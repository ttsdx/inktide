/**
 * Render layers.
 *
 * The frame is drawn in four ordered slices rather than one, for two reasons.
 *
 * First, the water needs to read the depth of everything behind it (for the
 * waterline foam) and a single MRT pass cannot sample the attachment it is
 * writing to, so the opaque geometry has to finish and be copied before the
 * ocean draws.
 *
 * Second, the sky has to be quarantined. Its clouds and sun are transparent
 * and used to be drawn with depth testing off, so three.js sorted them after
 * opaque geometry: a cloud painted over a boat and, worse, the cloud's MRT
 * write erased view normals and killed the interior-line pass.
 *
 * The sky slice now runs *after* the ocean, with depth testing on, so it only
 * fills pixels the water and hulls did not occupy. That is the same picture
 * (the ocean always overwrote sky on the water) without a wasted full-screen
 * sky fill on a 2× retina framebuffer.
 *
 *   LAYER_OPAQUE  -> hulls, riders, gates, buoys
 *   (copy the packed normal/depth attachment to a sampleable texture)
 *   LAYER_OCEAN   -> the water surface, which samples that copy
 *   LAYER_SKY     -> dome, clouds, sun. Depth-tested into leftover far pixels.
 *   LAYER_OVERLAY -> spray, splashes, glowing ribbons, anything that must sit
 *                    on top of the water and blend with it
 */
export const LAYER_OPAQUE = 0;
export const LAYER_OCEAN = 1;
export const LAYER_OVERLAY = 2;
/** Objects only the minimap camera should see. */
export const LAYER_MINIMAP = 3;
export const LAYER_SKY = 4;
