// The Image Editor's verification tool: one real fal.ai request, without
// running the app.
//
//   FAL_KEY=… npx tsx scripts/image-editor-smoke.mjs chair.jpg studio.png
//
// THIS COSTS MONEY. One run is one billable fal request for one result, the
// same request the route makes. It reads one local file, writes one local file,
// and stores nothing else. The key is read from the environment and never
// printed, and neither is fal's response body.

import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { prepareSourceImage } from '../src/lib/imageEditor/prepareSource.ts'
import { validateSourceImage } from '../src/lib/imageEditor/validation.ts'
import { generateProductShot, MODEL_ID } from '../src/lib/imageEditor/briaProductShot.ts'

const [sourceFile, out = 'studio.png'] = process.argv.slice(2)
if (!sourceFile) {
  console.error('usage: FAL_KEY=… npx tsx scripts/image-editor-smoke.mjs <photo.jpg> [out.png]')
  process.exit(1)
}

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
console.log(`calling ${MODEL_ID} — one result, one charge`)

const result = await generateProductShot({
  bytes: prepared.bytes,
  mimeType: prepared.mimeType,
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
console.log(`   fal request id ${result.requestId || '-'} — check the dashboard shows ONE billed result`)
