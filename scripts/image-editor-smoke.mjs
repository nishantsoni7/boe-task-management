// The Image Editor's verification tool: one real fal.ai request, without
// running the app.
//
//   FAL_KEY=… npx tsx scripts/image-editor-smoke.mjs chair.jpg [out.png] [preset]
//
// `preset` is square (default), portrait or landscape.
//
// THIS COSTS MONEY. One run is one billable fal request — the background
// removal, the same one the route makes. The studio image is then composed
// locally and costs nothing. It reads one local file, writes one local file,
// and stores nothing else. The key is read from the environment and never
// printed, and neither is fal's response body.

import sharp from 'sharp'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { prepareSourceImage } from '../src/lib/imageEditor/prepareSource.ts'
import { validateSourceImage } from '../src/lib/imageEditor/validation.ts'
import { removeBackground, MODEL_ID } from '../src/lib/imageEditor/briaBackgroundRemove.ts'
import { composeStudioImage } from '../src/lib/imageEditor/composeStudioImage.ts'
import { resolveOutputPreset } from '../src/lib/imageEditor/outputPresets.ts'
import { measureComposition, describeMeasurement } from '../src/lib/imageEditor/composition.ts'

const [sourceFile, out = 'test-results/studio.png', preset = 'landscape'] = process.argv.slice(2)
if (!sourceFile) {
  console.error('usage: FAL_KEY=… npx tsx scripts/image-editor-smoke.mjs <photo.jpg> [out.png] [square|portrait|landscape]')
  process.exit(1)
}
mkdirSync(dirname(out), { recursive: true })

const bytes = readFileSync(sourceFile)
const validation = validateSourceImage({
  name: basename(sourceFile), type: '', size: bytes.byteLength,
})
if (!validation.ok) { console.error(validation.error); process.exit(1) }

const prepared = await prepareSourceImage(bytes, validation.mimeType)
if (!prepared.ok) { console.error(prepared.error); process.exit(1) }

console.log(`source ${prepared.width}x${prepared.height}` +
  `${prepared.reencoded ? ' (re-encoded for EXIF/size)' : ' (original bytes)'}, ` +
  `${(prepared.bytes.length / 1e6).toFixed(2)} MB`)
const shape = resolveOutputPreset(preset)
console.log(`calling ${MODEL_ID} — one request, ${shape.label} ${shape.shotSize.join('x')} composed locally`)

const cutout = await removeBackground({
  bytes: prepared.bytes,
  mimeType: prepared.mimeType,
  apiKey: process.env.FAL_KEY ?? '',
})

if (!cutout.ok) {
  console.error(`failed: ${cutout.reason} — ${cutout.message}`)
  console.error(`status ${cutout.status ?? '-'}, request ${cutout.requestId || '-'}, ${cutout.durationMs} ms`)
  process.exit(2)
}

// The cut-out is kept for review: if segmentation damaged a leg or a cane
// panel, this is where it shows.
const cutoutPath = out.replace(/\.png$/, '-cutout.png')
writeFileSync(cutoutPath, cutout.png)
const cutMeta = await sharp(cutout.png).metadata()
console.log(`cutout in ${cutout.durationMs} ms → ${cutoutPath}`)
console.log(`   ${cutMeta.width}x${cutMeta.height}, alpha ${cutMeta.hasAlpha ? 'yes' : 'NO — not a cut-out'}, ${(cutout.png.length / 1e6).toFixed(2)} MB`)
console.log(`   request id ${cutout.requestId || '-'} — the dashboard should show ONE request\n`)

const composed = await composeStudioImage(cutout.png, shape.key)
if (!composed.ok) {
  console.error(`compose refused: ${composed.quality ? composed.quality.message : composed.error}`)
  if (composed.quality) console.error(`measured: ${composed.quality.detail}`)
  process.exit(3)
}

const png = composed.png
writeFileSync(out, png)
console.log(`composed → ${out}`)
console.log(`   product ${composed.metrics.bounds.width}x${composed.metrics.bounds.height} scaled ${composed.metrics.scale.toFixed(2)}x`)
console.log(`   tone ${composed.metrics.tone.reason}, gain ${composed.metrics.tone.gain.toFixed(2)}, contact columns ${composed.metrics.contactColumns}\n`)

// The composition, measured rather than eyeballed.
const measured = await measureComposition(png)
if (!measured.ok) {
  console.log(`composition: ${measured.error}`)
} else {
  console.log('composition, against the approved reference:')
  for (const line of describeMeasurement(measured.measurement)) console.log(`   ${line}`)

  const m = measured.measurement
  const t = shape.target
  const within = (actual, target, tolerance) => Math.abs(actual - target) <= tolerance
  const verdict = [
    ['product height', within(m.product.height, t.productHeight, t.productHeight * 0.06)],
    ['space above',    within(m.product.top, t.productTop, t.productTop * 0.15)],
    ['feet baseline',  within(m.product.bottom, t.feetBaseline, t.feetBaseline * 0.05)],
    ['centred',        Math.abs(m.centreOffsetPx) <= m.canvas.width * 0.04],
    ['not cropped',    !m.touchesEdge],
  ]
  console.log('\n   ' + verdict.map(([name, ok]) => `${ok ? 'MEETS' : 'MISSES'} ${name}`).join('\n   '))
}
