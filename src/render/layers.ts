/**
 * Render layers.
 *
 * The frame is drawn in three ordered slices rather than one, because the water
 * needs to read the depth of everything behind it (for the waterline foam) and
 * a single MRT pass cannot sample the attachment it is writing to.
 *
 *   LAYER_OPAQUE  -> sky, hulls, riders, gates, buoys
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
