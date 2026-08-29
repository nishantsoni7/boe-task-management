// The Image Editor's live acceptance tool: one real run, without the app.
//
//   npx tsx scripts/image-editor-smoke.mjs "irvine chair.jpg" test-results/irvine/out.png
//
// TWO MODES
// ---------
//   (default)                 the ACCEPTED pipeline: ref_image_url drives the
//                             scene, no scene_description.
//   --lighting-prompt-test    the lighting EXPERIMENT: scene_description drives
//                             the scene, no ref_image_url. ONE difference; every
//                             other setting is imported from the accepted
//                             adapter so it cannot drift.
//
// Run both against the same photograph to compare A against B. The mode changes
// what stage one is asked for and nothing else — the reframe, the upscale, the
// gate and the normalisation are shared, so a difference in the output is a
// difference in the request.
//
// THIS COSTS MONEY. One run is TWO billable fal requests, and no more:
//
//   1. fal-ai/bria/product-shot        the studio photograph
//   2. fal-ai/seedvr/upscale/image     resolution only
//
// CONFIGURATION
// -------------
// FAL_KEY is read from .env.local, the same file the dev server reads, and the
// approved reference from assets/image-editor/studio-reference.png. Both are
// checked BEFORE anything is sent, so a misconfigured checkout costs nothing.
// Neither the key nor any base64 image data is ever printed.
//
// WHAT IT WRITES, and why each one is needed for the acceptance review:
//
//   <out>-0-original.png          the input, exactly as it was sent
//   <out>-1-shot.png              the raw Product Shot result
//   <out>-2-reframed.png          after the local crop to 53%
//   <out>-3-upscaled.png          the raw SeedVR2 result
//   <out>                         the delivered 1440 x 1440 PNG
//   <out>-underseat-original.png      the fan of spindles as photographed
//   <out>-underseat-shot.png          the same band after Product Shot
//   <out>-underseat-upscaled.png      the same band after SeedVR2
//   <out>-underseat-original-4x.png   the three above at 4x, nearest
//   <out>-underseat-shot-4x.png       neighbour, so no resampler can invent
//   <out>-underseat-upscaled-4x.png   detail that is not in the pixels
//
// And four regions of the DELIVERED image, at 100% and 4x, one per defect the
// lighting experiment is trying to fix:
//
//   <out>-region-underseat.png        thin members still separate and readable
//   <out>-region-darkest.png          the darkest part of THIS product, found
//                                     by sweeping the product box, with its
//                                     mean luminance printed
//   <out>-region-floor-shadow.png     contact shadows touching the feet, and
//                                     which way the cast shadow travels
//   <out>-region-upper-background.png the rear wall behind the upper product —
//                                     the shadow that should not be there
//
// The three under-seat crops are the review. Put them side by side: the
// rejected pipeline turned that fan of thin verticals into one opaque block,
// and that is the failure this experiment exists to test for.
//
// A WORD ON "MASTER". The delivered PNG is only called the master once it has
// passed the exact-size check and the preservation gate. Until then it is "the
// SeedVR2 result", because that is all it is.

import sharp from 'sharp'
import { config } from 'dotenv'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { prepareSourceImage } from '../src/lib/imageEditor/prepareSource.ts'
import { validateSourceImage } from '../src/lib/imageEditor/validation.ts'
import { generateProductShot, MODEL_ID as SHOT_MODEL } from '../src/lib/imageEditor/briaProductShot.ts'
import {
  generateLightingShot, LIGHTING_SCENE_DESCRIPTION,
} from '../src/lib/imageEditor/lightingPromptShot.ts'
import { upscaleImage, normaliseSquare, MODEL_ID as UPSCALE_MODEL } from '../src/lib/imageEditor/seedvrUpscale.ts'
import { loadStudioReference, REFERENCE_PATH } from '../src/lib/imageEditor/studioReference.ts'
import { findProduct, planReframe, reframe } from '../src/lib/imageEditor/generatedProduct.ts'
import {
  profile, comparePreservation, checkFraming, INCONCLUSIVE_MESSAGE,
  UNDERSEAT_FROM, UNDERSEAT_TO,
} from '../src/lib/imageEditor/preservationGate.ts'
import {
  MASTER_WIDTH, MASTER_HEIGHT, PRODUCT_HEIGHT_SHARE, PRODUCT_HEIGHT_MIN,
  PRODUCT_HEIGHT_MAX, SIDE_MARGIN_SHARE, ABOVE_SHARE_OF_LEFTOVER,
} from '../src/lib/imageEditor/studioMaster.ts'

config({ path: '.env.local', quiet: true })
config({ quiet: true })

// ── Two modes ────────────────────────────────────────────────────────────────
//
// Default: the ACCEPTED reference-driven pipeline. Unchanged.
//
// --lighting-prompt-test: the lighting EXPERIMENT. One difference and one only
// — `scene_description` replaces `ref_image_url` as the scene source. Every
// other setting is imported from the accepted adapter, so the comparison cannot
// accidentally be measuring two changes at once.
//
// Run both against the same photograph and compare the artefacts side by side.
const LIGHTING_FLAG = '--lighting-prompt-test'
const argv = process.argv.slice(2)
const lightingMode = argv.includes(LIGHTING_FLAG)
const [sourceFile, out = lightingMode ? 'test-results/lighting.png' : 'test-results/studio.png'] =
  argv.filter(a => a !== LIGHTING_FLAG)

if (!sourceFile) {
  console.error('usage: npx tsx scripts/image-editor-smoke.mjs <photo.jpg> [out.png] [--lighting-prompt-test]')
  process.exit(1)
}

// ── Configuration, checked before a single byte is sent ──────────────────────

const apiKey = process.env.FAL_KEY
if (!apiKey) {
  console.error('FAL_KEY was not found in .env.local. Add it there; do not pass it on the command line.')
  console.error('Nothing was billed.')
  process.exit(1)
}

// The key's presence, never its value.
console.log(`FAL_KEY loaded from .env.local (${apiKey.length} characters, not shown)`)

if (lightingMode) {
  // The experiment sends no reference image, so there is nothing to check: the
  // prompt is a constant and cannot be missing from a checkout.
  console.log('MODE: lighting prompt experiment')
  console.log('  scene source: scene_description (a server-only constant)')
  console.log('  ref_image_url: ABSENT — the schema allows one scene source, not both')
  console.log(`  prompt: ${LIGHTING_SCENE_DESCRIPTION.length} characters,` +
    ` ${LIGHTING_SCENE_DESCRIPTION.split('\n\n').length} paragraphs (not printed — server-only)`)
  console.log('')
} else {
  const reference = await loadStudioReference()
  if (!reference.ok) {
    console.error(`The approved studio reference is missing: ${reference.detail}`)
    console.error(`Copy it to ${REFERENCE_PATH} and run again. Nothing was billed.`)
    process.exit(1)
  }
  // The reference's size, never its bytes.
  console.log('MODE: accepted reference-driven pipeline')
  console.log(`  reference ${REFERENCE_PATH}, ${(reference.bytes / 1e6).toFixed(2)} MB\n`)
}

mkdirSync(dirname(out), { recursive: true })
const stem = out.replace(/\.png$/, '')

/** Every artefact written, so the run ends with a list the reviewer can follow. */
const written = []
const write = (path, buffer) => { writeFileSync(path, buffer); written.push(path); return path }

/**
 * The under-seat band, at 100% and at 4x nearest neighbour.
 *
 * The band is the SAME one the gate measures — 0.42 to 0.95 of the product's
 * own height — so what the reviewer looks at is what the numbers describe.
 * Nearest neighbour on the enlargement because a smooth kernel would invent
 * edges between the spindles, which is precisely the thing under examination.
 */
async function underSeat(image, bounds, canvas, label) {
  const pad = Math.round(bounds.width * 0.04)
  const left = Math.max(0, bounds.left - pad)
  const top = Math.max(0, Math.round(bounds.top + bounds.height * UNDERSEAT_FROM))
  const width = Math.min(canvas.width - left, bounds.width + pad * 2)
  const height = Math.min(canvas.height - top, Math.round(bounds.height * (UNDERSEAT_TO - UNDERSEAT_FROM)))
  if (width < 8 || height < 8) {
    console.log(`  under-seat crop for ${label}: band too small to be useful, skipped`)
    return
  }

  const region = { left, top, width, height }
  const crop = await sharp(image).extract(region).png({ compressionLevel: 9 }).toBuffer()
  write(`${stem}-underseat-${label}.png`, crop)
  const big = await sharp(crop)
    .resize(width * 4, height * 4, { kernel: 'nearest' })
    .png({ compressionLevel: 9 }).toBuffer()
  write(`${stem}-underseat-${label}-4x.png`, big)
  console.log(`  under-seat ${label}: ${width}x${height} at ${left},${top}  (and 4x)`)
}

/**
 * One named region of the delivered image, at 100% and at 4x nearest neighbour.
 *
 * Nearest neighbour on purpose: a smooth kernel invents gradients between
 * pixels, and every one of these crops exists to judge exactly the thing a
 * gradient would fake — whether the spindles are separate, whether the dark
 * wood has readable grain, whether the shadow has an edge.
 */
async function crop(image, canvas, region, label) {
  const left = Math.max(0, Math.min(canvas.width - 1, Math.round(region.left)))
  const top = Math.max(0, Math.min(canvas.height - 1, Math.round(region.top)))
  const width = Math.max(0, Math.min(canvas.width - left, Math.round(region.width)))
  const height = Math.max(0, Math.min(canvas.height - top, Math.round(region.height)))
  if (width < 8 || height < 8) {
    console.log(`  ${label}: region too small to be useful, skipped`)
    return
  }

  const box = { left, top, width, height }
  const small = await sharp(image).extract(box).png({ compressionLevel: 9 }).toBuffer()
  write(`${stem}-${label}.png`, small)
  write(`${stem}-${label}-4x.png`, await sharp(small)
    .resize(width * 4, height * 4, { kernel: 'nearest' })
    .png({ compressionLevel: 9 }).toBuffer())
  console.log(`  ${label}: ${width}x${height} at ${left},${top}  (and 4x)`)
}

/**
 * The darkest part of the product, found rather than guessed.
 *
 * The fill-lighting instruction in the prompt is about deep shadow becoming
 * readable, and the only honest way to judge that is to look at whichever part
 * of THIS product is actually darkest — which differs per photograph. The
 * product box is swept with a window a fifth of its width and the darkest mean
 * wins. Its mean luminance is printed alongside so A and B can be compared as a
 * number as well as by eye.
 */
async function darkestRegion(image, bounds) {
  const w = Math.max(16, Math.round(bounds.width / 5))
  const h = Math.max(16, Math.round(bounds.height / 5))
  const { data, info } = await sharp(image).greyscale().raw().toBuffer({ resolveWithObject: true })

  let best = null
  const step = Math.max(4, Math.round(Math.min(w, h) / 4))
  for (let top = bounds.top; top + h <= bounds.bottom; top += step) {
    for (let left = bounds.left; left + w <= bounds.right; left += step) {
      let sum = 0
      for (let y = top; y < top + h; y += 2) {
        const row = y * info.width
        for (let x = left; x < left + w; x += 2) sum += data[row + x]
      }
      const mean = sum / (Math.ceil(h / 2) * Math.ceil(w / 2))
      if (!best || mean < best.mean) best = { left, top, width: w, height: h, mean }
    }
  }
  return best
}

/** One preservation report, printed in full — warnings included. */
function printReport(report, framing) {
  if (report.inconclusive) {
    console.log(`\nWARNING — ${INCONCLUSIVE_MESSAGE}`)
    console.log('  The route DELIVERS this, marked manual_review_required, because')
    console.log('  a textured factory background defeats the comparison on most real')
    console.log('  uploads. It is not a pass. Look at the under-seat crops.')
  } else {
    console.log(`\n${report.ok ? 'PRESERVATION OK' : 'PRESERVATION FAILED'}`)
  }
  for (const c of report.checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`)
  if (framing) console.log(`  ${framing.ok ? 'ok  ' : 'FAIL'} ${framing.name}: ${framing.detail}`)
  return report
}

// ── The input, kept exactly as it is sent ────────────────────────────────────

const bytes = readFileSync(sourceFile)
const validation = validateSourceImage({ name: basename(sourceFile), type: '', size: bytes.byteLength })
if (!validation.ok) { console.error(validation.error); process.exit(1) }

const prepared = await prepareSourceImage(bytes, validation.mimeType)
if (!prepared.ok) { console.error(prepared.error); process.exit(1) }
console.log(`source ${prepared.width}x${prepared.height}, ${(prepared.bytes.length / 1e6).toFixed(2)} MB`)

// The bytes that actually go to the provider, not the file on disk — if
// preparation rotated or re-encoded anything, this is what was compared.
write(`${stem}-0-original.png`, await sharp(prepared.bytes).png({ compressionLevel: 9 }).toBuffer())

const originalProfile = await profile(prepared.bytes)
console.log(originalProfile
  ? `upload: product ${originalProfile.bounds.width}x${originalProfile.bounds.height}, ` +
    `ground truth ${originalProfile.confident ? 'USABLE' : 'NOT usable (cluttered background)'}`
  : 'upload: no product locatable')

if (originalProfile) {
  await underSeat(prepared.bytes, originalProfile.bounds, originalProfile.canvas, 'original')
}

// ── [1/2] Product Shot ───────────────────────────────────────────────────────
console.log(`\n[1/2] ${SHOT_MODEL} — one billable request` +
  (lightingMode ? '  (scene_description, no ref_image_url)' : '  (ref_image_url, no scene_description)'))
const startedAt = Date.now()
const shot = lightingMode
  ? await generateLightingShot({ photograph: prepared.bytes, mimeType: prepared.mimeType, apiKey })
  : await generateProductShot({ photograph: prepared.bytes, mimeType: prepared.mimeType, apiKey })
if (!shot.ok) {
  console.error(`failed: ${shot.reason} — ${shot.message}`)
  console.error(`phase ${shot.phase ?? '-'}, status ${shot.status ?? '-'}, request ${shot.requestId || '-'}, ${shot.durationMs} ms`)
  process.exit(1)
}
write(`${stem}-1-shot.png`, shot.image)
const shotMeta = await sharp(shot.image).metadata()
console.log(`      ${shot.durationMs} ms  returned ${shotMeta.width}x${shotMeta.height}  request ${shot.requestId || '-'}`)

// ── Local: locate, check, reframe ────────────────────────────────────────────
const found = await findProduct(shot.image)
if (!found) { console.error('no product could be located in the generated image'); process.exit(1) }
console.log(`\nproduct in the shot: ${found.bounds.width}x${found.bounds.height} at ${found.bounds.left},${found.bounds.top}`)
console.log(`  share before reframe: ${(found.bounds.height / (shotMeta.height ?? 1) * 100).toFixed(1)}%`)
await underSeat(shot.image, found.bounds, { width: shotMeta.width, height: shotMeta.height }, 'shot')

const shotProfile = await profile(shot.image)
let shotOk = null
if (originalProfile && shotProfile) {
  shotOk = printReport(comparePreservation(originalProfile, shotProfile, 'after product shot'))
} else {
  console.log('\nWARNING — preservation could not be measured at this stage')
}

const plan = planReframe(found.bounds, { width: shotMeta.width, height: shotMeta.height }, {
  heightShare: PRODUCT_HEIGHT_SHARE,
  aboveSplit: ABOVE_SHARE_OF_LEFTOVER,
  maxWidthShare: 1 - 2 * SIDE_MARGIN_SHARE,
})
const reframed = await reframe(shot.image, plan)
write(`${stem}-2-reframed.png`, reframed)
console.log(`\nreframed: ${plan.crop.size}px square at ${plan.crop.left},${plan.crop.top}`)
console.log(`  share after reframe: ${(plan.productHeightShare * 100).toFixed(1)}%` +
  `${plan.widthLimited ? '  (width-limited)' : ''}${plan.clamped ? '  (clamped to canvas)' : ''}`)

// ── [2/2] SeedVR2 ────────────────────────────────────────────────────────────
console.log(`\n[2/2] ${UPSCALE_MODEL} — one billable request`)
const upscaled = await upscaleImage({
  image: reframed, mimeType: 'image/png',
  sourceSide: plan.crop.size, targetSide: MASTER_WIDTH, apiKey,
})
if (!upscaled.ok) {
  console.error(`failed: ${upscaled.reason} — ${upscaled.message}`)
  console.error(`phase ${upscaled.phase ?? '-'}, status ${upscaled.status ?? '-'}, request ${upscaled.requestId || '-'}, ${upscaled.durationMs} ms`)
  process.exit(1)
}
write(`${stem}-3-upscaled.png`, upscaled.image)
const upMeta = await sharp(upscaled.image).metadata()
console.log(`      ${upscaled.durationMs} ms  returned ${upMeta.width}x${upMeta.height}  factor ${upscaled.factor}x  request ${upscaled.requestId || '-'}`)

const upscaledFound = await findProduct(upscaled.image)
if (upscaledFound) {
  await underSeat(upscaled.image, upscaledFound.bounds, { width: upMeta.width, height: upMeta.height }, 'upscaled')
}

const finalProfile = await profile(upscaled.image)
let finalReport = null
if (originalProfile && finalProfile) {
  finalReport = printReport(
    comparePreservation(originalProfile, finalProfile, 'after upscale'),
    checkFraming(finalProfile, { min: PRODUCT_HEIGHT_MIN, max: PRODUCT_HEIGHT_MAX }, plan.widthLimited),
  )
} else {
  console.log('\nWARNING — preservation could not be measured at this stage')
}

// ── Exactly the delivered size, inspected rather than assumed ────────────────
const normalised = await normaliseSquare(upscaled.image, MASTER_WIDTH)
if (!normalised.ok) {
  console.error(`\nThe upscaled image is unusable: ${normalised.error}`)
  if (normalised.returned) console.error(`returned ${normalised.returned.width}x${normalised.returned.height}`)
  console.error(`\nWrote ${written.length} artefacts for inspection:`)
  for (const p of written) console.error(`  ${p}`)
  process.exit(1)
}
write(out, normalised.image)

console.log(`\nseedvr returned ${normalised.returned.width}x${normalised.returned.height}`)
console.log(`delivered ${normalised.delivered.width}x${normalised.delivered.height}` +
  ` (${normalised.resized ? 'normalised locally' : 'exact from the model'})`)

// ── The four lighting regions, from the DELIVERED image ──────────────────────
//
// One per defect the experiment is trying to fix, so a reviewer can answer each
// acceptance question by looking at one picture rather than squinting at a
// whole frame. Written in BOTH modes, at the same coordinates for the same
// product, so the accepted output and the prompt-driven one line up.
const deliveredCanvas = { width: normalised.delivered.width, height: normalised.delivered.height }
const deliveredFound = await findProduct(normalised.image)

if (!deliveredFound) {
  console.log('\nNo product locatable in the delivered image; the region crops were skipped.')
} else {
  const b = deliveredFound.bounds
  const share = b.height / deliveredCanvas.height
  console.log(`\nproduct in the delivered image: ${b.width}x${b.height} at ${b.left},${b.top}`)
  console.log(`  product height share: ${(share * 100).toFixed(1)}% of the frame`)
  console.log('\nlighting regions:')

  // 1. Under-seat structure — readability of the thin members, and preservation.
  await crop(normalised.image, deliveredCanvas, {
    left: b.left - b.width * 0.04,
    top: b.top + b.height * UNDERSEAT_FROM,
    width: b.width * 1.08,
    height: b.height * (UNDERSEAT_TO - UNDERSEAT_FROM),
  }, 'region-underseat')

  // 2. The darkest part of THIS product — did the fill light open it up?
  const darkest = await darkestRegion(normalised.image, b)
  if (darkest) {
    console.log(`  darkest product area: mean luminance ${darkest.mean.toFixed(1)} of 255`)
    await crop(normalised.image, deliveredCanvas, darkest, 'region-darkest')
  }

  // 3. Floor and feet — contact shadows touching, cast shadow direction, and
  //    whether the feet float. Wider than the product on both sides, because a
  //    cast shadow that leans is the whole point and it leans outward.
  await crop(normalised.image, deliveredCanvas, {
    left: b.left - b.width * 0.35,
    top: b.bottom - b.height * 0.10,
    width: b.width * 1.70,
    height: (deliveredCanvas.height - b.bottom) + b.height * 0.10,
  }, 'region-floor-shadow')

  // 4. Upper product and the rear background — the defect this experiment is
  //    chiefly about: a strong shadow starting immediately behind the product
  //    and falling onto the vertical background instead of the floor.
  await crop(normalised.image, deliveredCanvas, {
    left: b.left - b.width * 0.35,
    top: 0,
    width: b.width * 1.70,
    height: b.top + b.height * 0.30,
  }, 'region-upper-background')
}

// ── What it may be called ────────────────────────────────────────────────────
const exactSize = normalised.delivered.width === MASTER_WIDTH && normalised.delivered.height === MASTER_HEIGHT
const verified = exactSize && finalReport !== null && finalReport.ok && !finalReport.inconclusive
console.log(verified
  ? `\nMASTER — exact size and preservation verified: ${out}`
  : `\nNOT a master — the SeedVR2 result at the delivered size. ${
      !exactSize ? 'The size check did not pass.'
      : finalReport === null ? 'Preservation was never measured.'
      : finalReport.inconclusive ? INCONCLUSIVE_MESSAGE
      : 'Preservation FAILED.'} Inspect it: ${out}`)
if (shotOk && !shotOk.ok) console.log('The stage-one check had already failed; the route would have stopped there.')

console.log(`\nWrote ${written.length} artefacts:`)
for (const p of written) console.log(`  ${p}`)

console.log(`\nTotal ${((Date.now() - startedAt) / 1000).toFixed(1)}s. The fal dashboard must show exactly TWO requests.`)

if (lightingMode) {
  console.log('\nThis was the EXPERIMENT. Run the accepted pipeline on the same photograph:')
  console.log(`  npx tsx scripts/image-editor-smoke.mjs "${sourceFile}" test-results/accepted/out.png`)
  console.log('\nThen compare, region by region:')
  console.log('  region-upper-background  is the rear-wall shadow materially reduced?')
  console.log('                           does the chair feel forward from the background?')
  console.log('  region-floor-shadow      does the shadow travel AWAY from the bright side?')
  console.log('                           does a contact shadow still touch every foot?')
  console.log('  region-darkest           readable now, without looking washed out or grey?')
  console.log('  region-underseat         every member still separate; nothing merged or redrawn.')
  console.log('\nApprove only if all of those improve AND no product component changed.')
  console.log('If it is worse or less consistent, keep the reference-driven pipeline.')
} else {
  console.log('The review is the three under-seat 4x crops side by side:')
  console.log('  original -> shot -> upscaled. The spindles must stay individually visible.')
}
