// One real PhotoRoom round trip plus the local composition, without running the
// app. This is the verification step for the Image Editor prototype: it is the
// only way to see what PhotoRoom actually returns for a given photograph.
//
//   PHOTOROOM_API_KEY=… npx tsx scripts/image-editor-smoke.mjs chair.jpg out.png
//
// It reads one local file, writes one local file, and stores nothing else. The
// key is read from the environment and never printed. PhotoRoom's own error
// text IS printed on failure — it is the detail the route would send to the
// server log — so run this in your own terminal, not in a shared log.
//
// Costs one Remove Background credit per run.
import { readFileSync, writeFileSync } from 'node:fs'
import { prepareSourceImage } from '../src/lib/imageEditor/prepareSource.ts'
import { removeBackground } from '../src/lib/imageEditor/photoroomCutout.ts'
import { composeStudioImage } from '../src/lib/imageEditor/composeStudioImage.ts'
import sharp from 'sharp'

const [src, out = 'studio.png'] = process.argv.slice(2)
const bytes = readFileSync(src)
const prepared = await prepareSourceImage(bytes, src.endsWith('.png') ? 'image/png' : 'image/jpeg')
if (!prepared.ok) { console.error(prepared.error); process.exit(1) }

const t0 = Date.now()
const cutout = await removeBackground({
  bytes: prepared.bytes, mimeType: prepared.mimeType, fileName: src,
  apiKey: process.env.PHOTOROOM_API_KEY ?? '',
})
const providerMs = Date.now() - t0
if (!cutout.ok) {
  console.error('PhotoRoom failed:', cutout.reason, '—', cutout.message)
  if (cutout.detail) console.error('detail (server-log only):', cutout.detail)
  process.exit(1)
}
console.log('PhotoRoom ok in', providerMs, 'ms; cut-out bytes', cutout.png.length)

const t1 = Date.now()
const composed = await composeStudioImage(cutout.png)
if (!composed.ok) { console.error(composed.error); process.exit(1) }
writeFileSync(out, composed.png)
const meta = await sharp(composed.png).metadata()
console.log('composed in', Date.now() - t1, 'ms →', out, meta.width + 'x' + meta.height, 'channels', meta.channels)
console.log('placement', JSON.stringify(composed.placement))
