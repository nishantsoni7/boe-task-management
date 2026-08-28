// The Image Editor's verification tool: one real fal.ai request, without
// running the app.
//
//   FAL_KEY=… npx tsx scripts/image-editor-smoke.mjs chair.jpg [out.png] [preset]
//
// `preset` is square (default), portrait or landscape.
//
// THIS COSTS MONEY. One run is one billable fal request for one result, the
// same request the route makes. It reads one local file, writes one local file,
// and stores nothing else. The key is read from the environment and never
// printed, and neither is fal's response body.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { prepareSourceImage } from '../src/lib/imageEditor/prepareSource.ts'
import { validateSourceImage } from '../src/lib/imageEditor/validation.ts'
import { generateProductShot, MODEL_ID } from '../src/lib/imageEditor/briaProductShot.ts'
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
console.log(`calling ${MODEL_ID} — one result, one charge, ${shape.label} ${shape.shotSize.join('x')}`)

const result = await generateProductShot({
  bytes: prepared.bytes,
  mimeType: prepared.mimeType,
  preset: shape.key,
  apiKey: process.env.FAL_KEY ?? '',
})

if (!result.ok) {
  console.error(`failed: ${result.reason} — ${result.message}`)
  console.error(`status ${result.status ?? '-'}, request ${result.requestId || '-'}, ${result.durationMs} ms`)
  process.exit(2)
}

const [, contentType, base64] = result.image.dataUrl.match(/^data:([^;]+);base64,(.*)$/s) ?? []
if (!base64) { console.error('the result was not a data URI'); process.exit(2) }

const png = Buffer.from(base64, 'base64')
writeFileSync(out, png)
console.log(`ok in ${result.durationMs} ms → ${out}`)
console.log(`   ${result.image.width ?? '?'}x${result.image.height ?? '?'} ${contentType}, ${(png.length / 1e6).toFixed(2)} MB`)
console.log(`   request id ${result.requestId || '-'} — check the dashboard shows ONE billed result\n`)

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
