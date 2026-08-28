// From the raw cut-out to the exact image Product Shot is sent.
//
// SERVER ONLY (sharp is a native module). Two operations, both necessary and
// neither creative:
//
//   1. crop to the product's own bounding box, because padding is measured from
//      the product and background/remove returns the ORIGINAL frame with
//      everything but the product made transparent — pad that and the padding
//      is measured from the old photograph's edges, not the chair;
//   2. resize by one factor so the product lands at the planned size, because
//      padding is pixels and the master is 1000 x 1000.
//
// Nothing else. No tone, no sharpening, no shadow, no background — the accepted
// result's lighting and scene come from Bria and must not be pre-empted here.
//
// The resize is proportional and it is the only one: one scale factor applied
// to both axes, so nothing is stretched, rotated or reshaped. In the ordinary
// case it is a reduction — a megapixel photograph's chair is taller than 530px
// — and an enlargement past the cap is refused upstream rather than blurred.

import sharp from 'sharp'
import { alphaBounds, type Bounds } from './cutoutGeometry'

export type PreparedCutout =
  | { ok: true; png: Buffer; source: { width: number; height: number }; bounds: Bounds }
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
    const png = await sharp(cutoutPng)
      .ensureAlpha()
      .extract({ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height })
      .resize(target.width, target.height, { kernel: 'lanczos3', fit: 'fill' })
      .png({ compressionLevel: 9 })
      .toBuffer()

    return { ok: true, png, source: { width: bounds.width, height: bounds.height }, bounds }
  } catch {
    return { ok: false, error: 'That photograph could not be prepared for the studio. Please try again.' }
  }
}
