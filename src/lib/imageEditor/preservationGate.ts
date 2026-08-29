// Deciding whether a generated image may be served.
//
// SERVER ONLY. No network, no model: this only measures.
//
// WHAT THIS CAN AND CANNOT DO — READ THIS FIRST
// ---------------------------------------------
// It CANNOT prove the product was preserved. Two generative models render the
// final image and neither has a pass-through mode, so pixel identity is not
// available and no check here can manufacture it. What this does is refuse the
// failures that are actually measurable, so an obviously wrong image is not
// served silently.
//
// The ground truth it measures against is the UPLOADED PHOTOGRAPH, which costs
// nothing because it is already in memory. A segmentation mask would be better
// and would cost a third billable request; the pipeline is two, so this is the
// best available.
//
// AND IT IS NOT ALWAYS AVAILABLE. The product is located by edge energy, which
// works on a plain or near-plain background and does NOT work on a cluttered
// one: a textured factory wall has edges everywhere, so the located bounds
// become the whole frame. When that happens the upload cannot serve as ground
// truth, `profile` says so through `confident: false`, and the gate degrades to
// the checks that need no comparison — framing and extremities. It reports the
// degradation rather than passing quietly, because a check that silently stops
// checking is worse than no check.
//
// WHAT IT CHECKS
// --------------
//   * aspect ratio — a product that came back a different shape was redrawn;
//   * structure density in the under-seat band — the fan of thin spindles
//     under a chair seat is the regression subject, and "many separate
//     verticals became one opaque block" is exactly a collapse in edge
//     crossings. This is the check that would have caught the rejected result;
//   * structure density overall — cane, lattice and spindles anywhere;
//   * extremities — a product touching the frame edge may have been cropped;
//   * placement — the framing the crop was supposed to achieve.
//
// Every threshold is deliberately loose. A generative pass always moves these
// numbers a little; the gate is for obvious destruction, not for grading.

import { findProduct, structureDensity, type Bounds } from './generatedProduct'

/** Below this share of the original's structure, the product was flattened. */
export const STRUCTURE_FLOOR = 0.55

/**
 * The under-seat band, as shares of the product's own height.
 *
 * From just below where a seat sits to just above the feet. On the Irvine chair
 * the fan of thin verticals falls at roughly 0.45-0.65 and the legs below it,
 * so the band has to start at the seat rather than half way down — a band that
 * misses the fan cannot catch the fan being destroyed.
 */
export const UNDERSEAT_FROM = 0.42
export const UNDERSEAT_TO = 0.95

/** How far the aspect ratio may drift before the shape changed. */
export const ASPECT_TOLERANCE = 0.12

export type PreservationCheck = {
  name: string
  ok: boolean
  detail: string
}

export type PreservationReport = {
  ok: boolean
  /**
   * True when the comparison could not be made at all — the product was not
   * locatable in the upload, so structure and aspect were never verified.
   *
   * This is deliberately NOT folded into `ok`. An inconclusive result is not a
   * pass and must never be presented as one; the caller decides whether to
   * continue (a smoke run, so a person can look) or to refuse (the route, which
   * cannot ask anyone to look).
   */
  inconclusive: boolean
  checks: PreservationCheck[]
  /** For the log: what was measured, never image data. */
  summary: string
}

const REFUSAL =
  'The generated image did not preserve the product accurately. Please try again, ' +
  'or use a different photograph of the product.'

export const PRESERVATION_REFUSAL = REFUSAL

/** Said when the upload's background defeated the structural comparison. */
export const INCONCLUSIVE_MESSAGE =
  'Structural comparison inconclusive; manual review required.'

export type Profile = {
  bounds: Bounds
  aspect: number
  structureAll: number
  structureUnderseat: number
  canvas: { width: number; height: number }
  /**
   * Whether the product was located confidently enough for this profile to
   * serve as ground truth.
   *
   * False when the bounds fill nearly the whole frame, which is what a
   * cluttered background produces — the edges are everywhere, so "the product"
   * comes out as "the picture".
   */
  confident: boolean
}

/** Measure one image: where the product is, and how much structure it has. */
export async function profile(png: Buffer): Promise<Profile | null> {
  const found = await findProduct(png)
  if (!found) return null

  const { bounds, decoded, edges } = found

  // Bounds that fill most of the frame mean the BACKGROUND is carrying the
  // edges, not the product. Measured: a product on a plain sweep fills about
  // 23% of the frame's area; the same product on a textured factory wall
  // measures 83%, because the texture reaches every corner.
  //
  // The threshold sits between them, and it fails towards "unverified" rather
  // than towards "passed" — a tightly framed product photograph that trips it
  // loses the comparison checks, which is safe, where a cluttered one that
  // slipped through would compare against nonsense.
  const frameArea = decoded.width * decoded.height
  const fillsFrame = (bounds.width * bounds.height) / frameArea > 0.60

  return {
    bounds,
    aspect: bounds.width / bounds.height,
    structureAll: structureDensity(decoded, edges, bounds, 0, 1),
    structureUnderseat: structureDensity(decoded, edges, bounds, UNDERSEAT_FROM, UNDERSEAT_TO),
    canvas: { width: decoded.width, height: decoded.height },
    confident: !fillsFrame,
  }
}

/**
 * Compare a generated image against the photograph it came from.
 *
 * `stage` only labels the report, so a failure after Product Shot and a failure
 * after the upscale are told apart in the log and in the response.
 */
export function comparePreservation(original: Profile, generated: Profile, stage: string): PreservationReport {
  const checks: PreservationCheck[] = []

  // Without a locatable product in the upload there is nothing to compare
  // against. The generated-image checks still run; the comparison ones are
  // reported as not performed rather than passed.
  if (!original.confident) {
    const b = generated.bounds
    const EDGE_MARGIN = 2
    const touches = b.left <= EDGE_MARGIN || b.top <= EDGE_MARGIN
      || b.right >= generated.canvas.width - 1 - EDGE_MARGIN
      || b.bottom >= generated.canvas.height - 1 - EDGE_MARGIN

    checks.push({
      name: 'comparison',
      ok: true,
      detail: 'INCONCLUSIVE — the product could not be located in the upload ' +
        '(cluttered background), so structure and aspect were not verified',
    })
    checks.push({
      name: 'extremities',
      ok: !touches,
      detail: touches ? 'the product touches a frame edge and may be cropped' : 'clear of every edge',
    })

    return {
      ok: checks.every(c => c.ok),
      inconclusive: true,
      checks,
      summary: `${stage}: ${INCONCLUSIVE_MESSAGE} ` +
        checks.map(c => `${c.name} ${c.ok ? 'ok' : 'FAILED'} [${c.detail}]`).join('; '),
    }
  }

  const aspectDrift = Math.abs(generated.aspect - original.aspect) / original.aspect
  checks.push({
    name: 'aspect ratio',
    ok: aspectDrift <= ASPECT_TOLERANCE,
    detail: `${original.aspect.toFixed(3)} -> ${generated.aspect.toFixed(3)} (${(aspectDrift * 100).toFixed(1)}% drift)`,
  })

  const allRatio = original.structureAll === 0 ? 1 : generated.structureAll / original.structureAll
  checks.push({
    name: 'structure overall',
    ok: allRatio >= STRUCTURE_FLOOR,
    detail: `${original.structureAll.toFixed(1)} -> ${generated.structureAll.toFixed(1)} (${(allRatio * 100).toFixed(0)}% kept)`,
  })

  // The regression subject. A fan of separate verticals that came back as one
  // block loses most of its edge crossings, and nothing else in the pipeline
  // would notice.
  const underRatio = original.structureUnderseat === 0 ? 1 : generated.structureUnderseat / original.structureUnderseat
  checks.push({
    name: 'under-seat structure',
    ok: underRatio >= STRUCTURE_FLOOR,
    detail: `${original.structureUnderseat.toFixed(1)} -> ${generated.structureUnderseat.toFixed(1)} (${(underRatio * 100).toFixed(0)}% kept)`,
  })

  const b = generated.bounds
  // Two pixels of margin: the gradient map cannot compute an edge on the outer
  // row, so a product genuinely flush with the frame reports a bound of 1.
  const EDGE_MARGIN = 2
  const touches = b.left <= EDGE_MARGIN || b.top <= EDGE_MARGIN
    || b.right >= generated.canvas.width - 1 - EDGE_MARGIN
    || b.bottom >= generated.canvas.height - 1 - EDGE_MARGIN
  checks.push({
    name: 'extremities',
    ok: !touches,
    detail: touches ? 'the product touches a frame edge and may be cropped' : 'clear of every edge',
  })

  const failed = checks.filter(c => !c.ok)
  return {
    ok: failed.length === 0,
    inconclusive: false,
    checks,
    summary: `${stage}: ${checks.map(c => `${c.name} ${c.ok ? 'ok' : 'FAILED'} [${c.detail}]`).join('; ')}`,
  }
}

/** The framing the reframe was supposed to achieve, checked on the result. */
export function checkFraming(
  generated: Profile,
  target: { min: number; max: number },
  widthLimited: boolean,
): PreservationCheck {
  const share = generated.bounds.height / generated.canvas.height
  // A width-limited product is shorter than the target on purpose.
  const ok = widthLimited ? share <= target.max : share >= target.min && share <= target.max
  return {
    name: 'framing',
    ok,
    detail: `product is ${(share * 100).toFixed(1)}% of the height` +
      (widthLimited ? ' (width-limited)' : `, want ${(target.min * 100).toFixed(0)}-${(target.max * 100).toFixed(0)}%`),
  }
}
