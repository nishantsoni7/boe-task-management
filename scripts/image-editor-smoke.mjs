// The Image Editor's verification tool: one real run of the studio pipeline,
// without running the app.
//
//   npx tsx scripts/image-editor-smoke.mjs chair.jpg [out.png]
//
// The key is read from .env.local, the same file the dev server reads. Nobody
// types it, and it is never printed.
//
// THIS COSTS MONEY. One run is ONE billable fal request:
// fal-ai/bria/background/remove. Everything after it is local.
//
// It reads one local file, writes three (the raw cut-out, the prepared cut-out
// that is composited, and the master), and stores nothing else. Neither the key
// nor fal's response body is ever printed.
//
// This is the developer's tool. The live check the product owner runs is the
// app itself — see the module doc.

import sharp from 'sharp'
import { config } from 'dotenv'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { prepareSourceImage } from '../src/lib/imageEditor/prepareSource.ts'
import { validateSourceImage } from '../src/lib/imageEditor/validation.ts'
import { removeBackground, MODEL_ID as CUTOUT_MODEL } from '../src/lib/imageEditor/briaBackgroundRemove.ts'
import { measureCutout, prepareCutoutForShot } from '../src/lib/imageEditor/prepareCutout.ts'
import { planPadding, checkEnlargement, PRODUCT_HEIGHT_MIN, PRODUCT_HEIGHT_MAX } from '../src/lib/imageEditor/studioMaster.ts'
import { composeStudioScene } from '../src/lib/imageEditor/studioScene.ts'
import { measurePlacement, describeMeasurement } from '../src/lib/imageEditor/composition.ts'

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

mkdirSync(dirname(out), { recursive: true })

const bytes = readFileSync(sourceFile)
const validation = validateSourceImage({ name: basename(sourceFile), type: '', size: bytes.byteLength })
if (!validation.ok) { console.error(validation.error); process.exit(1) }

const prepared = await prepareSourceImage(bytes, validation.mimeType)
if (!prepared.ok) { console.error(prepared.error); process.exit(1) }

console.log(`source ${prepared.width}x${prepared.height}` +
  `${prepared.reencoded ? ' (re-encoded for EXIF/size)' : ' (original bytes)'}, ` +
  `${(prepared.bytes.length / 1e6).toFixed(2)} MB`)

// ── The one billable request ─────────────────────────────────────────────────
console.log(`\n${CUTOUT_MODEL} — one billable request`)
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

const sentPath = out.replace(/\.png$/, '-prepared.png')
writeFileSync(sentPath, shaped.png)
console.log(`prepared cut-out → ${sentPath}`)
console.log(`enlargement ${shaped.scale.toFixed(3)}x, edges repaired ${shaped.edges.repaired}`)

// ── Local: the studio scene ──────────────────────────────────────────────────
console.log('\ncompositing locally — no further provider call')
const scene = await composeStudioScene(shaped.png, plan)
if (!scene.ok) { console.error(scene.error); process.exit(1) }

writeFileSync(out, scene.png)
const meta = await sharp(scene.png).metadata()
console.log(`      ${meta.width}x${meta.height} ${meta.format}, ${(scene.png.length / 1e6).toFixed(2)} MB -> ${out}`)
console.log(`      feet ${scene.metrics.contactColumns} columns, cast shadow ${scene.metrics.castDrawn ? 'drawn' : 'none'}`)
console.log('\nThe fal dashboard should show exactly ONE request for this run.')

// ── What came back, measured ─────────────────────────────────────────────────
// From the cut-out's alpha and the placement plan, so the background and the
// shadows cannot affect it.

const check = await measurePlacement(shaped.png, plan)
if (!check.ok) {
  console.log(`\ncould not measure the result: ${check.error}`)
} else {
  console.log('\nmeasured:')
  for (const line of describeMeasurement(check.measurement)) console.log(`  ${line}`)

  const share = check.measurement.heightShare
  const within = share >= PRODUCT_HEIGHT_MIN - 0.01 && share <= PRODUCT_HEIGHT_MAX + 0.01
  console.log(`\nproduct height ${(share * 100).toFixed(1)}% — ` +
    (plan.widthLimited
      ? 'width-limited, so shorter than the target by design'
      : `${within ? 'within' : 'OUTSIDE'} the ${PRODUCT_HEIGHT_MIN * 100}-${PRODUCT_HEIGHT_MAX * 100}% target`))
  console.log('This checks the framing only. It never looks at the background,')
  console.log('so the scene still has to be looked at.')
}
