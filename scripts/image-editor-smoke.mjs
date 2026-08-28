// The Image Editor's verification tool: one real run of the studio pipeline,
// without running the app.
//
//   npx tsx scripts/image-editor-smoke.mjs chair.jpg [out.png]
//
// The key is read from .env.local, the same file the dev server reads. Nobody
// types it, and it is never printed.
//
// THIS COSTS MONEY. One run is TWO billable fal requests — the same two the
// route makes:
//
//   1. fal-ai/bria/background/remove, whose only purpose is to learn the
//      product's real pixel size, because `padding_values` cannot be computed
//      without it;
//   2. fal-ai/bria/product-shot with placement_type=manual_padding, which is
//      the picture.
//
// It reads one local file, writes three (the cut-out, the prepared cut-out that
// was actually sent, and the master), and stores nothing else. Neither the key
// nor fal's response body is ever printed.
//
// This is the developer's tool. The live check the product owner runs is the
// app itself — see the module doc.
//
// It needs the approved studio reference at assets/image-editor/studio-reference.png.
// Without it nothing is sent and nothing is billed.

import sharp from 'sharp'
import { config } from 'dotenv'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { prepareSourceImage } from '../src/lib/imageEditor/prepareSource.ts'
import { validateSourceImage } from '../src/lib/imageEditor/validation.ts'
import { removeBackground, MODEL_ID as CUTOUT_MODEL } from '../src/lib/imageEditor/briaBackgroundRemove.ts'
import { measureCutout, prepareCutoutForShot } from '../src/lib/imageEditor/prepareCutout.ts'
import { planPadding, checkEnlargement, PRODUCT_HEIGHT_MIN, PRODUCT_HEIGHT_MAX } from '../src/lib/imageEditor/studioMaster.ts'
import { generateStudioShot, MODEL_ID as STUDIO_MODEL } from '../src/lib/imageEditor/briaProductShot.ts'
import { loadStudioReference, REFERENCE_PATH } from '../src/lib/imageEditor/studioReference.ts'
import { measureComposition, describeMeasurement } from '../src/lib/imageEditor/composition.ts'

// The same file the dev server reads, so there is one place the key lives.
config({ path: '.env.local', quiet: true })
config({ quiet: true })

const [sourceFile, out = 'test-results/studio.png'] = process.argv.slice(2)
if (!sourceFile) {
  console.error('usage: npx tsx scripts/image-editor-smoke.mjs <photo.jpg> [out.png]')
  process.exit(1)
}

const apiKey = process.env.FAL_KEY
if (!apiKey) {
  console.error('FAL_KEY was not found in .env.local. Add it there; do not pass it on the command line.')
  process.exit(1)
}

// Checked before anything is billed.
const reference = await loadStudioReference()
if (!reference.ok) {
  console.error(`The approved studio reference is missing: ${reference.detail}`)
  console.error(`Copy the approved reference to ${REFERENCE_PATH} and run again.`)
  process.exit(1)
}
console.log(`reference ${REFERENCE_PATH}, ${(reference.bytes / 1e6).toFixed(2)} MB\n`)

mkdirSync(dirname(out), { recursive: true })

const bytes = readFileSync(sourceFile)
const validation = validateSourceImage({ name: basename(sourceFile), type: '', size: bytes.byteLength })
if (!validation.ok) { console.error(validation.error); process.exit(1) }

const prepared = await prepareSourceImage(bytes, validation.mimeType)
if (!prepared.ok) { console.error(prepared.error); process.exit(1) }

console.log(`source ${prepared.width}x${prepared.height}` +
  `${prepared.reencoded ? ' (re-encoded for EXIF/size)' : ' (original bytes)'}, ` +
  `${(prepared.bytes.length / 1e6).toFixed(2)} MB`)

// ── Request one: the cut-out ─────────────────────────────────────────────────
console.log(`\n[1/2] ${CUTOUT_MODEL} — one billable request`)
const cutout = await removeBackground({ bytes: prepared.bytes, mimeType: prepared.mimeType, apiKey })

if (!cutout.ok) {
  console.error(`failed: ${cutout.reason} — ${cutout.message}`)
  console.error(`status ${cutout.status ?? '-'}, request ${cutout.requestId || '-'}, ${cutout.durationMs} ms`)
  process.exit(1)
}

const cutoutPath = out.replace(/\.png$/, '-cutout.png')
writeFileSync(cutoutPath, cutout.png)
const cutMeta = await sharp(cutout.png).metadata()
console.log(`      ${cutout.durationMs} ms → ${cutoutPath}`)
console.log(`      ${cutMeta.width}x${cutMeta.height}, alpha ${cutMeta.hasAlpha ? 'yes' : 'NO — not a cut-out'}`)
console.log(`      request id ${cutout.requestId || '-'}`)

// ── Local: measure, gate, plan the padding ───────────────────────────────────
const measured = await measureCutout(cutout.png)
if (!measured.ok) { console.error(measured.error); process.exit(1) }

const product = { width: measured.bounds.width, height: measured.bounds.height }
const verdict = checkEnlargement(product)
if (!verdict.ok) {
  console.error(`\nrefused on quality: product ${product.width}x${product.height} ` +
    `would need ${verdict.scale.toFixed(2)}x enlargement; needs about ${verdict.needed}px tall`)
  console.error('Nothing further was billed.')
  process.exit(1)
}

const plan = planPadding(product)
console.log(`\nproduct ${product.width}x${product.height} in the cut-out`)
console.log(`scaled ${plan.scale.toFixed(3)}x → ${plan.product.width}x${plan.product.height}` +
  `${plan.widthLimited ? ' (width-limited: a wide product, contained rather than cropped)' : ''}`)
console.log(`padding [left ${plan.padding.left}, right ${plan.padding.right}, ` +
  `top ${plan.padding.top}, bottom ${plan.padding.bottom}]`)
console.log(`master ${plan.canvas.width}x${plan.canvas.height}, ` +
  `product planned at ${(plan.heightShare * 100).toFixed(1)}% of the height`)

const shaped = await prepareCutoutForShot(cutout.png, measured.bounds, plan.product)
if (!shaped.ok) { console.error(shaped.error); process.exit(1) }

const sentPath = out.replace(/\.png$/, '-sent.png')
writeFileSync(sentPath, shaped.png)
console.log(`prepared cut-out → ${sentPath}`)

// ── Request two: the studio scene ────────────────────────────────────────────
console.log(`\n[2/2] ${STUDIO_MODEL} — one billable request`)
const studio = await generateStudioShot({ cutoutPng: shaped.png, plan, apiKey })

if (!studio.ok) {
  console.error(`failed: ${studio.reason} — ${studio.message}`)
  console.error(`status ${studio.status ?? '-'}, request ${studio.requestId || '-'}, ${studio.durationMs} ms`)
  if (studio.detail) console.error(studio.detail)
  process.exit(1)
}

writeFileSync(out, studio.image)
const meta = await sharp(studio.image).metadata()
console.log(`      ${studio.durationMs} ms → ${out}`)
console.log(`      ${meta.width}x${meta.height} ${meta.format}, ${(studio.image.length / 1e6).toFixed(2)} MB`)
console.log(`      request id ${studio.requestId || '-'}`)

console.log('\nThe fal dashboard should show exactly TWO requests for this run,')
console.log('both with their results, because sync_mode is not sent.')

// ── What came back, measured ─────────────────────────────────────────────────
const check = await measureComposition(studio.image)
if (!check.ok) {
  console.log(`\ncould not measure the result: ${check.error}`)
} else {
  console.log('\nmeasured:')
  for (const line of describeMeasurement(check.measurement)) console.log(`  ${line}`)

  const share = check.measurement.heightShare
  const withinTarget = share >= PRODUCT_HEIGHT_MIN - 0.03 && share <= PRODUCT_HEIGHT_MAX + 0.03
  console.log(`\nproduct height ${(share * 100).toFixed(1)}% — ` +
    `${withinTarget ? 'within' : 'OUTSIDE'} the ${(PRODUCT_HEIGHT_MIN * 100)}-${(PRODUCT_HEIGHT_MAX * 100)}% target` +
    `${withinTarget ? '' : ' — this is the defect the padding change was meant to fix'}`)
  console.log('The measurement finds the product by contrast, so a strong contact')
  console.log('shadow reads a point or two tall. Look at the image as well.')
}
