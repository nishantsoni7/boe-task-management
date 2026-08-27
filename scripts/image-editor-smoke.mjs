// The Image Editor's verification tool. Three jobs, one file:
//
//   1. One real PhotoRoom round trip, saving the transparent cut-out so the
//      credit is spent once:
//        PHOTOROOM_API_KEY=… npx tsx scripts/image-editor-smoke.mjs chair.jpg out/
//
//   2. Re-compose from a cut-out already saved, spending nothing, which is how
//      the local composition is tuned:
//        npx tsx scripts/image-editor-smoke.mjs --from-cutout out/chair-cutout.png out/
//
//   3. Report the measurements behind a result — the numbers to bring to any
//      argument about why an image came out the way it did:
//        npx tsx scripts/image-editor-smoke.mjs --measure chair.jpg out/chair-cutout.png
//
// It reads local files, writes into the output directory, and stores nothing
// else. The key is read from the environment and never printed. PhotoRoom's own
// error text IS printed on failure — it is the detail the route sends to the
// server log — so run this in your own terminal, not a shared one.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import sharp from 'sharp'
import { prepareSourceImage } from '../src/lib/imageEditor/prepareSource.ts'
import { removeBackground } from '../src/lib/imageEditor/photoroomCutout.ts'
import { composeStudioImage, CANVAS_PX, MARGIN_RATIO, MAX_ENLARGEMENT } from '../src/lib/imageEditor/composeStudioImage.ts'
import { alphaBounds, detailScore, toneStats } from '../src/lib/imageEditor/productMetrics.ts'

const args = process.argv.slice(2)
const mode = args[0]?.startsWith('--') ? args[0] : '--photoroom'
const rest = args[0]?.startsWith('--') ? args.slice(1) : args

const stem = f => basename(f, extname(f))
const out = (dir, name) => { mkdirSync(dir, { recursive: true }); return join(dir, name) }

/** Everything measurable about one cut-out, printed as the numbered list. */
async function report(cutoutPng, sourceFile) {
  const meta = await sharp(cutoutPng).metadata()
  const alpha = await sharp(cutoutPng).ensureAlpha().extractChannel(3).raw().toBuffer()
  const bounds = alphaBounds(alpha, meta.width, meta.height)
  if (!bounds) { console.log('No product found in the cut-out.'); return null }

  const box = CANVAS_PX - Math.round(CANVAS_PX * MARGIN_RATIO) * 2
  const enlargement = Math.min(box / bounds.width, box / bounds.height)

  const cropped = await sharp(cutoutPng).ensureAlpha().extract(bounds).raw()
    .toBuffer({ resolveWithObject: true })
  const n = bounds.width * bounds.height
  const grey = Buffer.allocUnsafe(n)
  const a = Buffer.allocUnsafe(n)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    grey[i] = Math.round(0.299 * cropped.data[o] + 0.587 * cropped.data[o + 1] + 0.114 * cropped.data[o + 2])
    a[i] = cropped.data[o + 3]
  }

  if (sourceFile) {
    const src = await sharp(readFileSync(sourceFile)).metadata()
    console.log(`1. original image           ${src.width}x${src.height} (EXIF orientation ${src.orientation ?? 1})`)
    const prepared = await prepareSourceImage(readFileSync(sourceFile), 'image/jpeg')
    if (prepared.ok) {
      console.log(`2. sent to PhotoRoom        ${prepared.width}x${prepared.height}` +
        `${prepared.reencoded ? ' (re-encoded for EXIF/size)' : ' (original bytes, no recompression)'}`)
    }
  }
  console.log(`3. PhotoRoom cut-out        ${meta.width}x${meta.height}`)
  console.log(`4. product bounding box     ${bounds.width}x${bounds.height} at (${bounds.left},${bounds.top})`)
  console.log(`5. effective product px     longest edge ${Math.max(bounds.width, bounds.height)}`)
  console.log(`6. enlargement required     ${enlargement.toFixed(2)}x  (cap ${MAX_ENLARGEMENT}) → ${enlargement > MAX_ENLARGEMENT ? 'REJECTED' : 'accepted'}`)
  console.log(`7. resampling               lanczos3, one resize, sharpening confined to the alpha interior`)
  console.log(`8. detail score (source)    ${detailScore(grey, a, bounds.width, bounds.height).toFixed(2)}`)
  console.log(`9. product luminance        median ${toneStats(cropped.data, n).median}, p99 ${toneStats(cropped.data, n).p99}`)
  return bounds
}

async function compose(cutoutPng, dir, name) {
  const t = Date.now()
  const result = await composeStudioImage(cutoutPng)
  if (!result.ok) {
    console.error(`\ncompose refused: ${result.quality ? result.quality.message : result.error}`)
    if (result.quality) console.error(`measured: ${result.quality.detail}`)
    process.exitCode = 2
    return
  }
  const file = out(dir, `${name}-studio.png`)
  writeFileSync(file, result.png)
  const m = result.metrics
  console.log(`\ncomposed in ${Date.now() - t} ms → ${file}`)
  console.log(`   placed ${m.placement.width}x${m.placement.height} at (${m.placement.left},${m.placement.top})`)
  console.log(`   enlargement ${m.enlargement.toFixed(2)}x, detail ${m.detail.toFixed(1)}, contact columns ${m.contactColumns}`)
  console.log(`   tone: ${m.tone.reason}, gain ${m.tone.gain.toFixed(2)}, median ${m.tone.stats.median} → target`)
}

if (mode === '--from-cutout') {
  const [cutoutFile, dir = '.'] = rest
  await compose(readFileSync(cutoutFile), dir, stem(cutoutFile).replace(/-cutout$/, ''))
} else if (mode === '--measure') {
  const [sourceFile, cutoutFile] = rest
  await report(readFileSync(cutoutFile), sourceFile)
} else {
  const [sourceFile, dir = '.'] = rest
  const name = stem(sourceFile)
  const bytes = readFileSync(sourceFile)
  const prepared = await prepareSourceImage(bytes, sourceFile.endsWith('.png') ? 'image/png' : 'image/jpeg')
  if (!prepared.ok) { console.error(prepared.error); process.exit(1) }

  const t = Date.now()
  const cutout = await removeBackground({
    bytes: prepared.bytes, mimeType: prepared.mimeType, fileName: basename(sourceFile),
    apiKey: process.env.PHOTOROOM_API_KEY ?? '',
  })
  if (!cutout.ok) {
    console.error('PhotoRoom failed:', cutout.reason, '—', cutout.message)
    if (cutout.detail) console.error('detail (server-log only):', cutout.detail)
    process.exit(1)
  }
  const cutFile = out(dir, `${name}-cutout.png`)
  writeFileSync(cutFile, cutout.png)
  writeFileSync(out(dir, `${name}-original${extname(sourceFile)}`), bytes)
  console.log(`PhotoRoom ok in ${Date.now() - t} ms → ${cutFile} (${(cutout.png.length / 1e6).toFixed(2)} MB)`)
  console.log('   one Remove Background credit spent; re-run with --from-cutout to iterate for free\n')

  await report(cutout.png, sourceFile)
  await compose(cutout.png, dir, name)
}
