/**
 * Measuring a studio reference PNG against the properties BOE requires of it.
 *
 * SCRIPTS-SIDE ONLY. Nothing in src/ imports this, no production module
 * changes because of it, and it makes no network call of any kind. It reads a
 * PNG and returns numbers.
 *
 * WHY THIS EXISTS
 * ---------------
 * The reference image is the one thing driving the scene, and until now the
 * only way to judge a candidate was to spend two billable requests and look at
 * the result. Every property BOE asked for -- warm-neutral, seamless, matte
 * floor, floor-only shadow, restrained contrast -- is a property of the
 * REFERENCE FILE, measurable before a single request is made. A candidate that
 * fails here would have failed the live run too, and finding that out costs
 * nothing.
 *
 * THE HARD PART: THE REFERENCE CONTAINS FURNITURE
 * -----------------------------------------------
 * The approved reference is the accepted chair RESULT, not an empty room, and
 * V2 is to be furnished the same way. So "how warm is the sweep" cannot be
 * "the mean of the image" -- dark wood would drag it. Every background metric
 * therefore excludes a dilated box around the located product, and the metrics
 * that describe the sweep additionally exclude the darkest tenth of what is
 * left, because a cast shadow is not the sweep either.
 *
 * RESOLUTION INDEPENDENCE
 * -----------------------
 * Everything is measured after resizing the longest side to 1000px with the
 * aspect ratio preserved, so a 1000px reference and a 1456px one produce
 * comparable numbers and one set of thresholds serves both.
 */

import sharp from 'sharp'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { findProduct } from '../../src/lib/imageEditor/generatedProduct.ts'

/** Longest side, after which every measurement is taken. */
export const ANALYSIS_SIZE = 1000

/** Rec.601 luminance. Written out rather than left to a library so the number
 *  behind every threshold below is unambiguous. */
export const luminance = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b

/** How far outside the located product box background sampling starts, as a
 *  share of the product's width. Keeps edge pixels and rim light out. */
export const PRODUCT_DILATE = 0.04

/** Share of the background, darkest first, excluded from "the sweep". This is
 *  what stops the cast shadow dragging the warmth and contrast figures. */
export const SWEEP_DARK_EXCLUDE = 0.10

/** Extra clearance either side of the product before a column may be used for
 *  seam detection, as a share of image width. */
export const SEAM_COLUMN_MARGIN = 0.02

// ─────────────────────────────────────────────────────────────────────────────
// THRESHOLDS
//
// Every one is a number, and every one is falsifiable. They were calibrated on
// synthetic references built to have, and to lack, each property -- see
// referenceReport.test.mjs, which asserts a compliant reference passes and that
// each defect is caught by the metric meant for it.
//
// THE BASELINE RULE
// -----------------
// V1 is the accepted production baseline. It is NOT a pass mark, and its
// measurements are NOT a reason to move a threshold.
//
// V1 has known limitations -- a rear-wall shadow, and dark areas that do not
// read -- so V1 is EXPECTED to fail the checks aimed at those. Widening a
// threshold until V1 passes would delete the very defect V2 exists to fix, and
// the experiment would then be unable to detect its own success.
//
// So every check below is classified:
//
//   accepted-quality    V1 is expected to pass, and V2 must not regress. A V1
//                       failure here is a FINDING to report and discuss, not a
//                       licence to widen anything.
//   improvement-target  V1 may fail. V2 must pass. These are the defects.
//
// A threshold may be changed ONLY for a demonstrated detector error, resolution
// error, or false positive -- and only with a test proving the reason. Two such
// changes have already been made and both carry tests: the wall-shadow metric
// reported a vignette as shadow, and then reported an off-centre product as
// shadow. Neither was moved because a reference failed it.
// ─────────────────────────────────────────────────────────────────────────────
export const THRESHOLDS = {
  /** Warm-neutral: red must lead blue by at least this many levels on the
   *  sweep. A cold blue room measures NEGATIVE, so this separates the two cases
   *  by a wide margin rather than splitting hairs. */
  warmthMin: 4.0,
  /** And not orange: beyond this the sweep is no longer neutral. */
  warmthMax: 22.0,
  /** Red above green above blue, in that order, on the sweep. */
  requireWarmOrdering: true,

  /** Seamless: the largest row-to-row luminance step anywhere in the
   *  background. A cyclorama gradient spanning ~70 levels over 1000 rows is
   *  0.07 levels/row; a skirting board or wall-floor line is a cliff. */
  seamStepMax: 2.0,

  /** Matte floor: horizontal high-frequency energy in the floor directly
   *  beneath the feet. A soft shadow on matte concrete is smooth across x; a
   *  polished floor repeats the legs as vertical stripes. */
  floorStructureMax: 0.35,

  /** Floor-only shadow: how much darker the background IMMEDIATELY beside the
   *  product is than the background far from it, at the same height, above the
   *  foot line. This is the defect in words: "a strong shadow begins
   *  immediately behind the upper product". Levels of luminance. */
  wallShadowStrengthMax: 6.0,

  /** There must still BE a contact shadow. A product with no floor darkening
   *  at all is the floating-feet look. Levels, measured just below the feet. */
  floorShadowStrengthMin: 4.0,

  /** Short shadow: how far the floor darkening reaches below the feet, as a
   *  multiple of the product's own height.
   *
   *  Measured conservatively: the sweep's horizontal falloff makes the outer
   *  reference columns darker, which shortens the figure. A synthetic shadow
   *  reaching 0.79 of the product height measures 0.35 here. So 0.30 measured
   *  corresponds to roughly 0.6-0.7 in reality — which is the point, since the
   *  same understatement applies to both arms of an A/B. */
  shadowLengthMax: 0.30,

  /** Restrained contrast, measured on the SWEEP rather than the whole frame —
   *  a dark chair otherwise dominates p1..p99 and the number stops describing
   *  the scene. Too narrow is flat and lifeless; too wide is the crushed look
   *  that made the under-seat structure unreadable. */
  contrastSpreadMin: 40,
  contrastSpreadMax: 95,
}

/** A background pixel this many levels below its comparison band counts as
 *  shadow when measuring how far a shadow reaches. */
export const SHADOW_REACH_DELTA = 5

/** Bands used for the near/far shadow comparison, as shares of product width. */
export const NEAR_BAND = 0.18
export const FAR_BAND_FROM = 0.55
export const FAR_BAND_TO = 1.25

/** Outer share of the frame ignored in shadow comparisons, so the sweep's own
 *  edge falloff is never mistaken for a cast shadow. */
export const EDGE_IGNORE = 0.08

/** The floor window used for structure and contact shadow, as a share of the
 *  product's height below the true (undilated) foot line. */
export const FLOOR_WINDOW = 0.35

/** Percentile of a Float64Array/Array of numbers, p in [0,1]. Sorts a copy. */
export function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = Float64Array.from(values).sort()
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))
  return sorted[i]
}

/**
 * Decode to raw RGB at the analysis size, aspect preserved.
 */
export async function decode(png) {
  const { data, info } = await sharp(png)
    .resize(ANALYSIS_SIZE, ANALYSIS_SIZE, { fit: 'inside', withoutEnlargement: false })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const { width, height } = info
  const lum = new Float64Array(width * height)
  for (let i = 0, p = 0; p < width * height; p++, i += 3) {
    lum[p] = luminance(data[i], data[i + 1], data[i + 2])
  }
  return { data, width, height, lum, channels: info.channels }
}

/**
 * Everything measurable about one reference PNG.
 *
 * Returns `{ ok: false, error }` when the product cannot be located, because
 * every background metric depends on knowing where the product is not. That is
 * a refusal to guess, not a defect in the reference.
 */
export async function measureReference(png) {
  const sha256 = createHash('sha256').update(png).digest('hex')
  const meta = await sharp(png).metadata()
  const d = await decode(png)
  const { width, height, lum, data } = d

  const located = await findProduct(await sharp(png).removeAlpha().png().toBuffer())
  if (!located) {
    return { ok: false, error: 'no product could be located in the reference', sha256 }
  }

  // Bounds arrive in the ORIGINAL image's coordinates; scale to analysis space.
  const sx = width / (meta.width ?? width)
  const sy = height / (meta.height ?? height)
  const raw = located.bounds
  const productWidth = (raw.right - raw.left) * sx
  const dilate = Math.round(productWidth * PRODUCT_DILATE)

  const box = {
    left: Math.max(0, Math.round(raw.left * sx) - dilate),
    right: Math.min(width - 1, Math.round(raw.right * sx) + dilate),
    top: Math.max(0, Math.round(raw.top * sy) - dilate),
    bottom: Math.min(height - 1, Math.round(raw.bottom * sy) + dilate),
  }
  // The DILATED box excludes product pixels from background statistics. Every
  // measurement anchored on the feet uses the TRUE bounds instead: a foot line
  // 15px low would put the contact shadow in the "wall" region.
  const trueBox = {
    left: Math.round(raw.left * sx), right: Math.round(raw.right * sx),
    top: Math.round(raw.top * sy), bottom: Math.round(raw.bottom * sy),
  }
  const productHeight = trueBox.bottom - trueBox.top
  const trueWidth = trueBox.right - trueBox.left

  const inBox = (x, y) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom

  // ── The sweep: background, minus its own darkest tenth ─────────────────────
  const backgroundLum = []
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!inBox(x, y)) backgroundLum.push(lum[y * width + x])
    }
  }
  const sweepFloor = percentile(backgroundLum, SWEEP_DARK_EXCLUDE)

  let rs = 0, gs = 0, bs = 0, n = 0
  const sweepLum = []
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (inBox(x, y)) continue
      const p = y * width + x
      if (lum[p] < sweepFloor) continue
      const i = p * 3
      rs += data[i]; gs += data[i + 1]; bs += data[i + 2]; n++
      sweepLum.push(lum[p])
    }
  }
  const sweep = { r: rs / n, g: gs / n, b: bs / n, pixels: n }
  const warmth = sweep.r - sweep.b
  const warmOrdering = sweep.r > sweep.g && sweep.g > sweep.b
  const sweepMedian = percentile(sweepLum, 0.5)

  // ── Seams: one FIXED column set, so row-to-row steps are comparable ────────
  //
  // Using "all background columns in this row" would change the sample set at
  // the product's top and bottom edges and manufacture a step there — a seam
  // detector that fires on the product is useless.
  const margin = Math.round(width * SEAM_COLUMN_MARGIN)
  const columns = []
  for (let x = 0; x < width; x++) {
    if (x < box.left - margin || x > box.right + margin) columns.push(x)
  }
  const seamColumnsUsable = columns.length >= width * 0.05

  const rowMeans = new Float64Array(height)
  for (let y = 0; y < height; y++) {
    let s = 0
    for (const x of columns) s += lum[y * width + x]
    rowMeans[y] = columns.length ? s / columns.length : 0
  }
  const steps = []
  for (let y = 1; y < height; y++) steps.push(Math.abs(rowMeans[y] - rowMeans[y - 1]))
  const seamStepMax = steps.length ? Math.max(...steps) : 0
  const seamStepP99 = percentile(steps, 0.99)
  const seamRow = steps.indexOf(seamStepMax) + 1

  // ── Floor structure: horizontal high frequency just beneath the feet ──────
  //
  // A reflection repeats the legs as vertical stripes, which is horizontal
  // high-frequency energy. A soft shadow on matte concrete has almost none.
  // The window is deliberately SHORT and starts at the true foot line: measured
  // over the whole floor, a reflection occupying the top fifth of the band is
  // diluted by four fifths of empty floor until it stops being detectable.
  const floorTop = Math.min(height - 1, trueBox.bottom + 1)
  const floorBottom = Math.min(height, floorTop + Math.round(productHeight * FLOOR_WINDOW))
  let floorSum = 0, floorN = 0
  for (let y = floorTop; y < floorBottom; y++) {
    for (let x = trueBox.left; x <= trueBox.right - 2; x++) {
      floorSum += Math.abs(lum[y * width + x] - lum[y * width + x + 2])
      floorN++
    }
  }
  const floorStructure = floorN ? floorSum / floorN : 0
  const floorBandRows = floorBottom - floorTop

  // ── Shadow ────────────────────────────────────────────────────────────────
  //
  // The naive test — "darker than the sweep median" — does not work, and it is
  // worth saying why, because it looked reasonable and reported every fixture
  // as 100% wall shadow. A studio sweep has an edge falloff of tens of levels,
  // so the whole outer frame is "darker than the median" and the vignette
  // drowns the thing being measured. Comparing a near band against a far band
  // fails the same way: with a product 38% of the frame wide, "far" lands in
  // the falloff and reads as darker than the shadow.
  //
  // Both measures below are therefore built so the vignette CANCELS rather than
  // being thresholded around.

  const eIgnore = Math.round(width * EDGE_IGNORE)
  const nearW = Math.max(4, Math.round(trueWidth * NEAR_BAND))

  // WALL: left-versus-right asymmetry beside the product, MINUS the same
  // asymmetry measured well above it.
  //
  // A cast shadow is directional — that is the whole premise of the lighting
  // rule — so one landing on the rear wall darkens one side and not the other.
  // Raw asymmetry would find it. But raw asymmetry also finds a product that is
  // not perfectly centred, because the sweep's edge falloff is then unequal
  // either side: a 1456px fixture with an off-centre chair measured 15.66
  // levels of "wall shadow" where the identical centred scene measured 0.08.
  //
  // Subtracting the asymmetry of the band ABOVE the product removes that. The
  // geometry is the same up there; a shadow cast by a floor-standing product
  // is not. What survives the subtraction is shadow.
  const asymmetryOver = (fromY, toY) => {
    let sum = 0, n = 0
    for (let y = Math.max(0, fromY); y < Math.min(height, toY); y++) {
      for (let d = 1; d <= nearW; d++) {
        const xl = trueBox.left - d
        const xr = trueBox.right + d
        if (xl < eIgnore || xr >= width - eIgnore) continue
        sum += Math.abs(lum[y * width + xl] - lum[y * width + xr])
        n++
      }
    }
    return { value: n ? sum / n : 0, samples: n }
  }

  const beside = asymmetryOver(trueBox.top, trueBox.bottom)
  // Clear of the product, so a contact or cast shadow cannot reach it.
  const above = asymmetryOver(0, Math.max(1, trueBox.top - Math.round(productHeight * 0.10)))
  const wallShadowStrength = Math.max(0, beside.value - above.value)
  const asymN = beside.samples

  // FLOOR: is the floor right under the feet darker than the sweep gradient
  // alone would make it?
  //
  // Measured as a vertical difference at FIXED x — so the horizontal falloff
  // cancels exactly — and then corrected by the same vertical difference in
  // columns beside the product, which removes the sweep's own vertical
  // gradient. What is left is the contact shadow.
  const footLine = trueBox.bottom
  const nearRows = [footLine + 2, footLine + Math.round(productHeight * 0.12)]
  const farRows = [footLine + Math.round(productHeight * 0.35), footLine + Math.round(productHeight * 0.55)]

  const meanOver = (xs, [y0, y1]) => {
    let sum = 0, n = 0
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) {
      for (const x of xs) { sum += lum[y * width + x]; n++ }
    }
    return n ? sum / n : null
  }
  const insideX = []
  for (let x = trueBox.left; x <= trueBox.right; x++) if (x >= 0 && x < width) insideX.push(x)
  const outsideX = []
  for (let x = eIgnore; x < width - eIgnore; x++) {
    if (x < trueBox.left - nearW || x > trueBox.right + nearW) outsideX.push(x)
  }

  const vDelta = (xs) => {
    const near = meanOver(xs, nearRows)
    const far = meanOver(xs, farRows)
    return near === null || far === null ? null : far - near
  }
  const insideDelta = vDelta(insideX)
  const outsideDelta = vDelta(outsideX)
  const floorShadowStrength =
    insideDelta === null || outsideDelta === null ? 0 : insideDelta - outsideDelta

  // REACH: the deepest floor row where the product's own column span is still
  // darker than the frame's outer columns at that same height.
  //
  // Same-row, so the vertical gradient cancels; the horizontal falloff makes
  // the outer columns darker, which biases this DOWNWARDS. It is therefore a
  // conservative lower bound on shadow length, which is the safe direction for
  // a limit.
  const referenceX = []
  for (let x = eIgnore; x < eIgnore + Math.round(width * 0.10); x++) referenceX.push(x)
  for (let x = width - eIgnore - Math.round(width * 0.10); x < width - eIgnore; x++) referenceX.push(x)

  let deepest = footLine
  for (let y = footLine + 1; y < height; y++) {
    const inside = meanOver(insideX, [y, y + 1])
    const ref = meanOver(referenceX, [y, y + 1])
    if (inside !== null && ref !== null && ref - inside >= SHADOW_REACH_DELTA) deepest = y
  }
  const shadowLength = productHeight ? (deepest - footLine) / productHeight : 0

  // ── Contrast, on the SWEEP ────────────────────────────────────────────────
  //
  // Over the whole frame a dark chair sets p1 and the number stops describing
  // the scene: a deliberately flat background and a normal one measured 129 and
  // 132 that way, which is no signal at all.
  const contrastSpread = percentile(sweepLum, 0.99) - percentile(sweepLum, 0.01)
  const p1 = percentile(sweepLum, 0.01)
  const p99 = percentile(sweepLum, 0.99)
  const frameSpread = percentile(lum, 0.99) - percentile(lum, 0.01)

  return {
    ok: true,
    sha256,
    file: { width: meta.width, height: meta.height, bytes: png.byteLength, format: meta.format },
    analysis: { width, height },
    product: { ...trueBox, width: trueWidth, height: productHeight, dilated: box },
    sweep: {
      r: sweep.r, g: sweep.g, b: sweep.b, median: sweepMedian,
      pixels: sweep.pixels, share: sweep.pixels / (width * height),
    },
    metrics: {
      warmth, warmOrdering,
      seamStepMax, seamStepP99, seamRow, seamColumnsUsable, seamColumns: columns.length,
      floorStructure, floorBandRows,
      wallShadowStrength, floorShadowStrength, shadowLength,
      wallAsymmetryPixels: asymN, wallAsymmetryRaw: beside.value,
      wallAsymmetryBaseline: above.value, insideDelta, outsideDelta,
      contrastSpread, p1, p99, frameSpread,
    },
  }
}

/**
 * One metric judged against its threshold.
 *
 * `kind` is what stops a V1 measurement being read as a verdict on V1. See THE
 * BASELINE RULE above.
 */
function check(name, kind, ok, detail) { return { name, kind, ok, detail } }

/** V1 is expected to pass these, and V2 must not regress. */
export const ACCEPTED_QUALITY = 'accepted-quality'
/** V1 may fail these. They are the defects V2 exists to fix. */
export const IMPROVEMENT_TARGET = 'improvement-target'

/** Every threshold applied to one measurement. */
export function judge(report) {
  if (!report.ok) {
    return { ok: false, checks: [check('measurable', ACCEPTED_QUALITY, false, report.error)] }
  }
  const m = report.metrics
  const T = THRESHOLDS

  const checks = [
    check('warm-neutral', ACCEPTED_QUALITY,
      m.warmth >= T.warmthMin && m.warmth <= T.warmthMax
        && (!T.requireWarmOrdering || m.warmOrdering),
      `R-B ${m.warmth.toFixed(2)} (want ${T.warmthMin}..${T.warmthMax}), ` +
      `R>G>B ${m.warmOrdering ? 'yes' : 'NO'}`),

    check('seamless', ACCEPTED_QUALITY,
      m.seamColumnsUsable && m.seamStepMax <= T.seamStepMax,
      `largest row step ${m.seamStepMax.toFixed(3)} at row ${m.seamRow} ` +
      `(want <= ${T.seamStepMax}), p99 ${m.seamStepP99.toFixed(3)}` +
      (m.seamColumnsUsable ? '' : ' — TOO FEW BACKGROUND COLUMNS TO JUDGE')),

    check('matte floor', ACCEPTED_QUALITY,
      m.floorStructure <= T.floorStructureMax,
      `floor structure ${m.floorStructure.toFixed(3)} (want <= ${T.floorStructureMax}) ` +
      `over ${m.floorBandRows} rows`),

    check('no wall shadow', IMPROVEMENT_TARGET,
      m.wallShadowStrength <= T.wallShadowStrengthMax,
      `left/right asymmetry beside the product ${m.wallShadowStrength.toFixed(2)} levels ` +
      `above the frame's own baseline (want <= ${T.wallShadowStrengthMax}); ` +
      `raw ${m.wallAsymmetryRaw.toFixed(2)} minus baseline ${m.wallAsymmetryBaseline.toFixed(2)}, ` +
      `${m.wallAsymmetryPixels} sample pairs`),

    check('contact shadow present', ACCEPTED_QUALITY,
      m.floorShadowStrength >= T.floorShadowStrengthMin,
      `floor beside the feet is ${m.floorShadowStrength.toFixed(2)} levels darker ` +
      `than floor far from them (want >= ${T.floorShadowStrengthMin})`),

    check('short shadow', ACCEPTED_QUALITY,
      m.shadowLength <= T.shadowLengthMax,
      `reaches ${m.shadowLength.toFixed(2)} of the product height below the feet ` +
      `(want <= ${T.shadowLengthMax})`),

    check('restrained contrast', ACCEPTED_QUALITY,
      m.contrastSpread >= T.contrastSpreadMin && m.contrastSpread <= T.contrastSpreadMax,
      `sweep p1..p99 spread ${m.contrastSpread.toFixed(1)} ` +
      `(want ${T.contrastSpreadMin}..${T.contrastSpreadMax}), p1 ${m.p1.toFixed(0)} p99 ${m.p99.toFixed(0)}` +
      `; whole frame ${m.frameSpread.toFixed(1)} for reference`),
  ]

  const failedQuality = checks.filter(c => !c.ok && c.kind === ACCEPTED_QUALITY)
  const failedTargets = checks.filter(c => !c.ok && c.kind === IMPROVEMENT_TARGET)
  return {
    ok: checks.every(c => c.ok),
    /** No accepted quality was lost. The bar V2 must clear as well as its own. */
    qualityHeld: failedQuality.length === 0,
    failedQuality: failedQuality.map(c => c.name),
    failedTargets: failedTargets.map(c => c.name),
    checks,
  }
}

/** Read a PNG, measure it, judge it, and print. Returns the report. */
export async function reportOnFile(path) {
  const png = readFileSync(path)
  const report = await measureReference(png)

  console.log(`reference ${path}`)
  console.log(`  sha256 ${report.sha256}`)
  if (!report.ok) {
    console.log(`  UNMEASURABLE: ${report.error}`)
    return report
  }

  const f = report.file
  console.log(`  ${f.format} ${f.width}x${f.height}, ${(f.bytes / 1e6).toFixed(2)} MB` +
    `  (measured at ${report.analysis.width}x${report.analysis.height})`)
  console.log(`  product box ${report.product.width}x${report.product.height} ` +
    `at ${report.product.left},${report.product.top}`)
  console.log(`  sweep RGB ${report.sweep.r.toFixed(1)} / ${report.sweep.g.toFixed(1)} / ` +
    `${report.sweep.b.toFixed(1)}, median ${report.sweep.median.toFixed(1)}, ` +
    `${(report.sweep.share * 100).toFixed(1)}% of the frame`)

  const verdict = judge(report)
  for (const kind of [ACCEPTED_QUALITY, IMPROVEMENT_TARGET]) {
    const group = verdict.checks.filter(c => c.kind === kind)
    if (group.length === 0) continue
    console.log(`\n  ${kind === ACCEPTED_QUALITY
      ? 'ACCEPTED QUALITIES  (the baseline must hold these; a new reference must not regress)'
      : 'IMPROVEMENT TARGETS (the baseline may fail these; a new reference must fix them)'}`)
    for (const c of group) console.log(`    ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`)
  }

  console.log('')
  if (verdict.ok) console.log('  every check passes')
  else {
    if (verdict.failedQuality.length) {
      console.log(`  accepted quality NOT held: ${verdict.failedQuality.join(', ')}`)
    }
    if (verdict.failedTargets.length) {
      console.log(`  improvement targets not met: ${verdict.failedTargets.join(', ')}`)
      console.log('    On the accepted baseline this is the EXPECTED result and is the')
      console.log('    measurement to record. It is not a reason to change a threshold.')
    }
  }
  return { ...report, verdict }
}

// ─────────────────────────────────────────────────────────────────────────────
// DARK-AREA READABILITY, ON A DELIVERED IMAGE
//
// These are FIXED geometric bands expressed as fractions of the located product
// box -- not detected dark spots. That matters: a "find the darkest window"
// rule would measure a different physical part of the chair in each arm, and a
// comparison between two different places is not a comparison. Anchoring to the
// product box instead of to absolute pixels absorbs the few pixels of placement
// difference between two runs while still landing on the same rails and legs.
//
// The same source photograph and the same 53% framing are used in both arms, so
// identical fractions address identical furniture.
// ─────────────────────────────────────────────────────────────────────────────

/** left, right, top, bottom as fractions of the product box. */
export const READABILITY_REGIONS = [
  { name: 'under-seat rails', left: 0.15, right: 0.85, top: 0.46, bottom: 0.62 },
  { name: 'rear legs',        left: 0.55, right: 1.00, top: 0.62, bottom: 0.98 },
  { name: 'lower frame',      left: 0.00, right: 1.00, top: 0.82, bottom: 0.98 },
  { name: 'seat shadow',      left: 0.20, right: 0.80, top: 0.34, bottom: 0.46 },
]

/**
 * Mean, spread and deep-shadow floor for each fixed region.
 *
 * Three numbers rather than one, because "readable" and "washed out" both raise
 * the mean and only the spread tells them apart:
 *
 *   mean    how open the area is overall;
 *   stdDev  whether detail survived -- a region lifted by flattening it has a
 *           higher mean and a COLLAPSED spread, which is the washed-out look;
 *   p5      the deep-shadow floor, where crushed blacks show up first.
 */
export async function measureReadability(png, bounds) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height } = info
  const bw = bounds.right - bounds.left
  const bh = bounds.bottom - bounds.top

  return READABILITY_REGIONS.map(r => {
    const x0 = Math.max(0, Math.round(bounds.left + bw * r.left))
    const x1 = Math.min(width, Math.round(bounds.left + bw * r.right))
    const y0 = Math.max(0, Math.round(bounds.top + bh * r.top))
    const y1 = Math.min(height, Math.round(bounds.top + bh * r.bottom))

    const values = []
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * info.channels
        values.push(luminance(data[i], data[i + 1], data[i + 2]))
      }
    }
    if (values.length === 0) {
      return { ...r, box: { x0, y0, x1, y1 }, pixels: 0, mean: 0, stdDev: 0, p5: 0 }
    }
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length
    return {
      ...r,
      box: { x0, y0, x1, y1 },
      pixels: values.length,
      mean,
      stdDev: Math.sqrt(variance),
      p5: percentile(values, 0.05),
    }
  })
}
