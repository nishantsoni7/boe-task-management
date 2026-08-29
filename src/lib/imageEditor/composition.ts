// Measuring a finished master against the composition BOE approved.
//
// SERVER ONLY (sharp is a native module). Nothing in the request path uses this:
// it is how a result is CHECKED, by tests and by the smoke script, rather than
// how one is made.
//
// It exists because "the product looks about the right size" is not a review.
// The approved composition is a set of numbers — 53% of the canvas height,
// centred, on a 60:40 split — and a master either meets them or does not.
//
// HOW THE PRODUCT IS FOUND, AND WHY IT CHANGED
// --------------------------------------------
// From the CUT-OUT'S ALPHA and the placement plan, not from colour.
//
// The previous version found the product by contrast: it sampled the four
// corners for a background colour and called anything far enough from it
// product. That worked while the background was near-flat. It stopped working
// the moment the background became a real studio sweep — corners at 148 and
// floor at 214 — because most of the sweep then differs from the corners by
// more than the threshold. It reported a 53.0% placement as 71.8%: it was
// measuring the gradient.
//
// Alpha has none of that trouble. It says exactly which pixels are product,
// it says nothing about the background whatever the background is doing, it
// excludes shadows because a shadow is not in the cut-out, and it excludes the
// gaps between spindles because those are transparent. A background change
// cannot move these numbers, which is the property a verification tool needs.
//
// WHAT IT CAN AND CANNOT TELL YOU
// -------------------------------
// It answers "is the framing right". It cannot answer "is the scene clean" —
// it never looks at the background at all. A master still has to be looked at.

import sharp from 'sharp'
import { alphaBounds, ALPHA_THRESHOLD } from './cutoutGeometry'
import { MASTER_WIDTH, MASTER_HEIGHT, type PaddingPlan } from './studioMaster'

export type Measurement = {
  canvas: { width: number; height: number }
  /** The product's real extent on the master, in canvas coordinates. */
  product: { left: number; top: number; right: number; bottom: number; width: number; height: number }
  /** Product height as a share of the canvas height. */
  heightShare: number
  /** Clear space above the product, as a share of the canvas height. */
  aboveShare: number
  /** Clear space below the lowest foot, as a share of the canvas height. */
  belowShare: number
  /** Where the feet sit, as a share of the canvas height from the top. */
  feetBaselineShare: number
  /** Product centre minus canvas centre, in pixels. Negative is left. */
  centreOffsetPx: number
  /** The narrower side margin divided by the wider; 1 is perfectly even. */
  sideBalance: number
  /** True when the product touches any edge — i.e. it may be cropped. */
  touchesEdge: boolean
  /** How many of the product's own pixels are opaque, and how many transparent.
   *  The second number is the openings a generative pass would have filled. */
  opaquePixels: number
  transparentPixels: number
}

export type MeasureResult =
  | { ok: true; measurement: Measurement }
  | { ok: false; error: string }

/**
 * Measure where the product actually landed.
 *
 * `preparedPng` is the cut-out as it was composited — already cropped,
 * decontaminated, resized and sharpened — and `plan` is where it was placed.
 * Together those are the master's product layer exactly, so this reports what
 * is really in the picture rather than what was intended: if the crop or the
 * resize went wrong, the alpha's extent says so.
 */
export async function measurePlacement(
  preparedPng: Buffer,
  plan: PaddingPlan,
): Promise<MeasureResult> {
  let width = 0
  let height = 0
  let alpha: Buffer
  try {
    const meta = await sharp(preparedPng, { failOn: 'error' }).metadata()
    width = meta.width ?? 0
    height = meta.height ?? 0
    if (!width || !height) return { ok: false, error: 'The prepared cut-out could not be read.' }
    alpha = await sharp(preparedPng).ensureAlpha().extractChannel(3).raw().toBuffer()
  } catch {
    return { ok: false, error: 'The prepared cut-out could not be read.' }
  }

  const bounds = alphaBounds(alpha, width, height)
  if (!bounds) return { ok: false, error: 'The prepared cut-out has no product in it.' }

  let opaquePixels = 0
  for (let y = bounds.top; y <= bounds.bottom; y++) {
    for (let x = bounds.left; x <= bounds.right; x++) {
      if (alpha[y * width + x] >= ALPHA_THRESHOLD) opaquePixels++
    }
  }

  // Alpha coordinates are relative to the prepared cut-out; the plan says where
  // that sits on the canvas.
  const left = plan.padding.left + bounds.left
  const top = plan.padding.top + bounds.top
  const right = left + bounds.width - 1
  const bottom = top + bounds.height - 1

  const canvasWidth = plan.canvas.width
  const canvasHeight = plan.canvas.height

  const leftMargin = left
  const rightMargin = canvasWidth - 1 - right
  const wider = Math.max(leftMargin, rightMargin)

  return {
    ok: true,
    measurement: {
      canvas: { width: canvasWidth, height: canvasHeight },
      product: { left, top, right, bottom, width: bounds.width, height: bounds.height },
      heightShare: bounds.height / canvasHeight,
      aboveShare: top / canvasHeight,
      belowShare: (canvasHeight - 1 - bottom) / canvasHeight,
      feetBaselineShare: (bottom + 1) / canvasHeight,
      centreOffsetPx: (left + right + 1) / 2 - canvasWidth / 2,
      sideBalance: wider === 0 ? 1 : Math.min(leftMargin, rightMargin) / wider,
      touchesEdge: left <= 0 || top <= 0 || right >= canvasWidth - 1 || bottom >= canvasHeight - 1,
      opaquePixels,
      transparentPixels: bounds.width * bounds.height - opaquePixels,
    },
  }
}

/** The measurement in words, for a smoke run's output. */
export function describeMeasurement(m: Measurement): string[] {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`
  return [
    `canvas          ${m.canvas.width} x ${m.canvas.height}`,
    `product         ${m.product.width} x ${m.product.height} at ${m.product.left},${m.product.top}`,
    `height share    ${pct(m.heightShare)}`,
    `space above     ${pct(m.aboveShare)}`,
    `space below     ${pct(m.belowShare)}`,
    `feet baseline   ${pct(m.feetBaselineShare)}`,
    `centre offset   ${m.centreOffsetPx.toFixed(1)}px`,
    `side balance    ${m.sideBalance.toFixed(3)}`,
    `touches edge    ${m.touchesEdge ? 'YES — the product may be cropped' : 'no'}`,
    `openings        ${m.transparentPixels} transparent pixels inside the product box`,
  ]
}

/** The canvas this module expects, so a caller cannot quietly measure against
 *  a different master than the one that is built. */
export const EXPECTED_CANVAS = { width: MASTER_WIDTH, height: MASTER_HEIGHT } as const
