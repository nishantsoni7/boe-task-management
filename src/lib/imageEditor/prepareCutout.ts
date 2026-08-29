// From the raw cut-out to the exact image Product Shot is sent.
//
// SERVER ONLY (sharp is a native module). Two operations, both necessary and
// neither creative:
//
//   1. crop to the product's own bounding box, because padding is measured from
//      the product and background/remove returns the ORIGINAL frame with
//      everything but the product made transparent — pad that and the padding
//      is measured from the old photograph's edges, not the chair;
//   2. take the factory background's colour out of the soft edge, because
//      background removal assigns alpha without repainting and the leftover mix
//      composites to a thin dark rim (see decontaminateEdges.ts);
//   3. resize by one factor so the product lands at the planned size;
//   4. restore, inside the product only, the acutance a resample costs.
//
// Nothing else. NO TONE CORRECTION: the product's colour is the photograph's,
// and the only things permitted to change a pixel here are the edge repair, the
// interpolation of one proportional resize, and the bounded sharpening below.
// Nothing invents detail and nothing repaints anything.
//
// The edge is repaired BEFORE the resize, and that order matters. Repairing
// first means the downscale averages clean product colour; repairing after
// means every boundary pixel has already had contaminated neighbours averaged
// into it, and the rim is baked in before anything can reach it.
//
// The resize is proportional and it is the only one: one scale factor applied
// to both axes, so nothing is stretched, rotated or reshaped. In the ordinary
// case it is a reduction — a megapixel photograph's chair is taller than 530px
// — and an enlargement past the cap is refused upstream rather than blurred.

import sharp from 'sharp'
import { alphaBounds, type Bounds } from './cutoutGeometry'
import { decontaminateEdges, type EdgeReport } from './decontaminateEdges'

/**
 * Restrained unsharp settings.
 *
 * A resample costs acutance; this gives back roughly that much and no more.
 * `m2` is the ceiling on how far a high-contrast edge may be pushed, and it is
 * deliberately low — a large value is what turns a chair leg into a cartoon and
 * puts a bright line beside every dark rail.
 */
const SHARPEN = { sigma: 0.8, m1: 0.4, m2: 1.2 } as const

/** How far in from the cut-out's edge sharpening may reach. Sharpening across
 *  an alpha boundary traces a pale outline around the product, which reads
 *  instantly as "cut out". */
const EDGE_GUARD_SIGMA = 2

/**
 * Sharpen the product's RGB and leave its alpha edge alone.
 *
 * The sharpened result is confined to an INTERIOR mask — the alpha, blurred and
 * hard-thresholded, which excludes a few pixels all the way round. Outside that
 * mask the original, unsharpened colour is kept, so no halo can form and the
 * decontaminated edge is not undone.
 *
 * Alpha is copied through untouched.
 */
async function sharpenInterior(rgba: Buffer, width: number, height: number): Promise<Buffer> {
  const pixels = width * height

  const rgb = Buffer.allocUnsafe(pixels * 3)
  const alpha = Buffer.allocUnsafe(pixels)
  for (let i = 0; i < pixels; i++) {
    rgb[i * 3] = rgba[i * 4]; rgb[i * 3 + 1] = rgba[i * 4 + 1]; rgb[i * 3 + 2] = rgba[i * 4 + 2]
    alpha[i] = rgba[i * 4 + 3]
  }

  const sharpened = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .sharpen(SHARPEN).raw().toBuffer()

  const interior = await sharp(alpha, { raw: { width, height, channels: 1 } })
    .blur(EDGE_GUARD_SIGMA).toColourspace('b-w').raw().toBuffer()

  const out = Buffer.allocUnsafe(pixels * 4)
  for (let i = 0; i < pixels; i++) {
    const inside = interior[i] >= 252
    for (let c = 0; c < 3; c++) {
      out[i * 4 + c] = inside ? sharpened[i * 3 + c] : rgb[i * 3 + c]
    }
    out[i * 4 + 3] = alpha[i]
  }
  return out
}

export type PreparedCutout =
  | {
      ok: true
      png: Buffer
      source: { width: number; height: number }
      bounds: Bounds
      /** Counts only — how many edge pixels were repaired, and how many were
       *  too thin to repair safely. Never image data. */
      edges: EdgeReport
      /** What the product was scaled by. Below 1 is a reduction; above 1 is an
       *  enlargement, and is gated upstream. */
      scale: number
    }
  | { ok: false; error: string }

/** Below this share of transparent pixels the image is not a cut-out at all. */
const MIN_TRANSPARENT_SHARE = 0.01

const NOT_A_CUTOUT =
  'The product could not be separated from that photograph. Try a photograph with the product clearly visible.'

/**
 * Find the product in a cut-out and report its bounding box.
 *
 * Separate from the resize because the padding plan needs these numbers BEFORE
 * anything is resized: the plan is computed from the product's real dimensions,
 * which is what makes it right for a wardrobe and a footstool alike.
 */
export async function measureCutout(
  cutoutPng: Buffer,
): Promise<{ ok: true; width: number; height: number; bounds: Bounds } | { ok: false; error: string }> {
  let width = 0
  let height = 0
  try {
    const meta = await sharp(cutoutPng, { failOn: 'error' }).metadata()
    width = meta.width ?? 0
    height = meta.height ?? 0
  } catch {
    return { ok: false, error: 'The cut-out could not be read. Please try again.' }
  }
  if (!width || !height) return { ok: false, error: 'The cut-out could not be read. Please try again.' }

  try {
    const alpha = await sharp(cutoutPng).ensureAlpha().extractChannel(3).raw().toBuffer()

    // An opaque image is not a cut-out: sending it to Product Shot would hand
    // Bria a rectangle of factory floor and ask it to light it.
    let transparent = 0
    for (let i = 0; i < alpha.length; i++) if (alpha[i] < 8) transparent++
    if (transparent < alpha.length * MIN_TRANSPARENT_SHARE) return { ok: false, error: NOT_A_CUTOUT }

    const bounds = alphaBounds(alpha, width, height)
    if (!bounds) return { ok: false, error: NOT_A_CUTOUT }

    return { ok: true, width, height, bounds }
  } catch {
    return { ok: false, error: 'The cut-out could not be read. Please try again.' }
  }
}

/**
 * Crop to the product and scale it to the planned size.
 *
 * Transparency is preserved: Product Shot is being given a product on nothing,
 * and the alpha is how it knows where the product ends. Lanczos because a
 * reduction is what this almost always is, and it is the kernel that keeps a
 * cane lattice and a thin metal leg readable through one.
 */
export async function prepareCutoutForShot(
  cutoutPng: Buffer,
  bounds: Bounds,
  target: { width: number; height: number },
): Promise<PreparedCutout> {
  try {
    // Cropped to raw so the edge repair can work on the pixels directly. Each
    // step is its own pipeline: sharp orders its operations internally rather
    // than by call order, and chaining a resize onto this would let it run
    // before the recolouring it is supposed to follow.
    const cropped = await sharp(cutoutPng)
      .ensureAlpha()
      .extract({ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height })
      .raw()
      .toBuffer()

    const edges = await decontaminateEdges(cropped, bounds.width, bounds.height)

    // One resize, one factor, both axes: scaled as a whole, never stretched,
    // rotated, warped or cropped. sharp premultiplies alpha through this, so a
    // transparent pixel's colour cannot bleed into an opaque neighbour.
    const resized = await sharp(cropped, {
      raw: { width: bounds.width, height: bounds.height, channels: 4 },
    })
      .resize(target.width, target.height, { kernel: 'lanczos3', fit: 'fill' })
      .raw()
      .toBuffer()

    // Its own pipeline: sharp reorders chained operations, and a sharpen written
    // after a resize is not guaranteed to run after it.
    const sharpened = await sharpenInterior(resized, target.width, target.height)

    const png = await sharp(sharpened, {
      raw: { width: target.width, height: target.height, channels: 4 },
    }).png({ compressionLevel: 9 }).toBuffer()

    return {
      ok: true,
      png,
      source: { width: bounds.width, height: bounds.height },
      bounds,
      edges,
      scale: target.height / bounds.height,
    }
  } catch {
    return { ok: false, error: 'That photograph could not be prepared for the studio. Please try again.' }
  }
}
