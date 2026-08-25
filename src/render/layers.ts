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
 * quads with depth testing disabled, so three.js sorts them into the
 * transparent queue and draws them *after* the opaque geometry. Two things then
 * go wrong: a cloud paints over a boat, and — much less obviously — the cloud's
 * write to MRT attachment 1 blends with alpha 1 and erases the view normals of
 * every object already in the buffer, silently disabling the entire interior
 * line pass. Giving the sky its own slice fixes both.
 *
 *   LAYER_SKY     -> dome, clouds, sun. Drawn first, writes no depth.
 *   LAYER_OPAQUE  -> hulls, riders, gates, buoys
 *   (copy the packed normal/depth attachment to a sampleable texture)
 *   LAYER_OCEAN   -> the water surface, which samples that copy
 *   LAYER_OVERLAY -> spray, splashes, glowing ribbons, anything that must sit
 *                    on top of the water and blend with it
 */
export const LAYER_OPAQUE = 0;
export const LAYER_OCEAN = 1;
export const LAYER_OVERLAY = 2;
/** Objects only the minimap camera should see. */
export const LAYER_MINIMAP = 3;
export const LAYER_SKY = 4;
