/**
 * Media-only .xlsx optimisation.
 *
 * WHAT THESE TESTS DEFEND: that optimising an oversized Main PI changes the
 * embedded images and NOTHING ELSE. Every worksheet, style, drawing, chart,
 * relationship and metadata part must come out of the optimiser byte-identical
 * to the way it went in, sheet names and formula counts must match, and every
 * relationship must still resolve. If any of that cannot be proven, the workbook
 * is refused — the original oversized bytes are never uploaded as a fallback.
 *
 * WHAT IS AND IS NOT COVERED HERE. The archive layer — ZIP reading, structure
 * validation, media selection by magic bytes, the resource limits, the rebuild,
 * and the byte-identity comparison — is fully exercised, using real ZIP fixtures
 * built in-process with fflate and a deterministic FAKE encoder injected in place
 * of the browser canvas.
 *
 * The canvas encoder itself (createCanvasMediaEncoder) is NOT exercised: it needs
 * a DOM, createImageBitmap and canvas.toBlob, none of which exist under
 * `node --test`. So real EXIF-orientation handling, real PNG alpha preservation
 * and real JPEG quality stepping are BROWSER-ONLY checks and are listed as such
 * in the manual checklist — they are deliberately not claimed here. What IS
 * proven here is the contract around the encoder: an encoder result that changes
 * format, or fails to get smaller, is discarded and the original bytes are kept.
 *
 * Run:
 *   npx tsx --test src/lib/xlsxMediaOptimizer.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { File as NodeFile } from 'node:buffer'
import { zipSync, unzipSync } from 'fflate'
import {
  optimizeXlsxMedia,
  validateRebuiltArchive,
  validateArchiveStructure,
  listOptimizableMedia,
  sniffImageFormat,
  isUnsafeEntryName,
  resolveRelTarget,
  collectInternalRelTargets,
  readSheetNames,
  countFormulas,
  bytesEqual,
  createCanvasMediaEncoder,
  MAX_ENTRY_COUNT,
  MAX_OPTIMIZE_INPUT_BYTES,
  MIN_MEDIA_OPTIMIZE_BYTES,
  XLSX_TARGET_BYTES,
  MAX_OPTIMIZE_ROUNDS,
  type ArchiveEntries,
  type MediaEncoder,
  type XlsxOptimizeResult,
} from './xlsxMediaOptimizer'
import {
  prepareAttachment,
  plannedProcessing,
  planStageApplication,
  ORDER_REQ_ATTACHMENT_MAX_BYTES,
  PREPARE_STAGES,
  type PrepareStage,
} from './orderRequestAttachments'

const MB = 1024 * 1024
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const XLS_MIME  = 'application/vnd.ms-excel'

// ── Deterministic byte fixtures ───────────────────────────────────────────────
// Pseudo-random payloads (a fixed LCG, so runs are reproducible) because random
// bytes do not compress — that is what lets a fixture reach a chosen ZIPPED size
// predictably. Each carries the real magic bytes of the format it claims, since
// the optimiser selects media by sniffing, never by extension alone.

function noise(size: number, header: readonly number[], seed = 1): Uint8Array {
  const b = new Uint8Array(size)
  b.set(header, 0)
  let x = seed >>> 0
  for (let i = header.length; i < size; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    b[i] = x & 0xff
  }
  return b
}

const PNG_SIG  = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_SIG = [0xff, 0xd8, 0xff]
const GIF_SIG  = [0x47, 0x49, 0x46, 0x38]

const png  = (size: number, seed = 1) => noise(size, PNG_SIG, seed)
const jpeg = (size: number, seed = 2) => noise(size, JPEG_SIG, seed)
const gif  = (size: number, seed = 3) => noise(size, GIF_SIG, seed)
function webp(size: number, seed = 4): Uint8Array {
  const b = noise(size, [0x52, 0x49, 0x46, 0x46], seed)
  b.set([0x57, 0x45, 0x42, 0x50], 8) // "WEBP" at offset 8
  return b
}
/** An EMF: not a browser-decodable raster, so never optimisable. */
const emf = (size: number, seed = 5) => noise(size, [0x01, 0x00, 0x00, 0x00], seed)

const enc = new TextEncoder()
const xml = (s: string) => enc.encode(s)

// ── Workbook fixture ──────────────────────────────────────────────────────────

type WorkbookSpec = {
  media?: Record<string, Uint8Array>
  sheets?: string[]
  formulasPerSheet?: number
  extra?: Record<string, Uint8Array>
  omit?: string[]
}

function sheetXml(formulas: number): Uint8Array {
  const cells = Array.from({ length: formulas }, (_, i) =>
    `<c r="A${i + 1}"><f>SUM(B${i + 1}:C${i + 1})</f><v>${i}</v></c>`).join('')
  return xml(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData><row r="1">${cells}</row></sheetData>` +
    `<pageSetup orientation="landscape" paperSize="9"/>` +
    `</worksheet>`)
}

/** A structurally valid .xlsx package: content types, package + workbook rels,
 *  one worksheet per sheet name, styles, a drawing, and a drawing rels file that
 *  actually points at the media entries. */
function buildWorkbook(spec: WorkbookSpec = {}): {
  bytes: Uint8Array; entries: ArchiveEntries; names: string[]
} {
  const sheets = spec.sheets ?? ['PI']
  const media = spec.media ?? {}
  const mediaNames = Object.keys(media)

  const entries: ArchiveEntries = {}
  entries['[Content_Types].xml'] = xml(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Default Extension="png" ContentType="image/png"/>` +
    `<Default Extension="jpeg" ContentType="image/jpeg"/>` +
    `<Default Extension="webp" ContentType="image/webp"/>` +
    `<Default Extension="emf" ContentType="image/x-emf"/>` +
    `<Default Extension="gif" ContentType="image/gif"/>` +
    `</Types>`)
  entries['_rels/.rels'] = xml(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`)
  entries['xl/workbook.xml'] = xml(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets>` +
    sheets.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
    `</sheets></workbook>`)
  entries['xl/_rels/workbook.xml.rels'] = xml(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    sheets.map((_, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`)
  sheets.forEach((_, i) => {
    entries[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(spec.formulasPerSheet ?? 3)
  })
  entries['xl/styles.xml'] = xml(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/></font></fonts></styleSheet>`)

  if (mediaNames.length > 0) {
    entries['xl/drawings/drawing1.xml'] = xml(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing">` +
      mediaNames.map((_, i) => `<xdr:pic><xdr:blipFill><a:blip r:embed="rIdImg${i + 1}"/></xdr:blipFill></xdr:pic>`).join('') +
      `</xdr:wsDr>`)
    entries['xl/drawings/_rels/drawing1.xml.rels'] = xml(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      mediaNames.map((n, i) =>
        `<Relationship Id="rIdImg${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${n}"/>`).join('') +
      `</Relationships>`)
    for (const n of mediaNames) entries[`xl/media/${n}`] = media[n]
  }

  Object.assign(entries, spec.extra ?? {})
  for (const name of spec.omit ?? []) delete entries[name]

  const names = Object.keys(entries)
  const zippable: Record<string, [Uint8Array, { level: 0 | 6 }]> = {}
  for (const n of names) zippable[n] = [entries[n], { level: n.startsWith('xl/media/') ? 0 : 6 }]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bytes = zipSync(zippable as any)
  return { bytes, entries, names }
}

// ── Encoders ──────────────────────────────────────────────────────────────────

/** Shrinks to `factor` of the input while keeping the format's magic bytes. */
function shrinkingEncoder(factor = 0.25): MediaEncoder {
  return async (req) => {
    const size = Math.max(16, Math.floor(req.bytes.length * factor))
    if (req.format === 'png')  return png(size, 11)
    if (req.format === 'jpeg') return jpeg(size, 12)
    return webp(size, 13)
  }
}
const refusingEncoder: MediaEncoder = async () => null
/** Barely shrinks — used to prove the round cap and the still-over-limit path. */
const stubbornEncoder: MediaEncoder = async (req) => {
  const size = Math.max(16, req.bytes.length - 8)
  return req.format === 'png' ? png(size, 21) : jpeg(size, 22)
}
/** Violates the contract: returns a JPEG when asked for a PNG. */
const formatSwappingEncoder: MediaEncoder = async (req) =>
  req.format === 'png' ? jpeg(Math.floor(req.bytes.length / 4), 31) : null
/** Violates the contract the other way: returns something bigger. */
const growingEncoder: MediaEncoder = async (req) =>
  req.format === 'png' ? png(req.bytes.length * 2, 41) : jpeg(req.bytes.length * 2, 42)

const ok = (r: XlsxOptimizeResult) => { assert.equal(r.ok, true, `expected ok, got ${r.ok ? '' : r.reason}`); return r as Extract<XlsxOptimizeResult, { ok: true }> }

/** Small scaled-down limits keep most cases instant; the real 10 MB boundary is
 *  exercised separately so the production number is genuinely tested too. */
const SMALL = { limitBytes: 400_000, targetBytes: 300_000 }

function reopen(bytes: Uint8Array): { entries: ArchiveEntries; names: string[] } {
  const names: string[] = []
  const entries = unzipSync(bytes, { filter: (f) => { names.push(f.name); return true } })
  return { entries, names }
}

// ══════════════════════════════════════════════════════════════════════════════
// A. Pass-through
// ══════════════════════════════════════════════════════════════════════════════

describe('A. in-limit workbooks are never touched', () => {
  test('1. an .xlsx below 10 MB comes back as the identical File object', async () => {
    const { bytes } = buildWorkbook({ media: { 'image1.png': png(200_000) } })
    const file = new NodeFile([bytes], 'pi.xlsx', { type: XLSX_MIME }) as unknown as File
    assert.ok(file.size < ORDER_REQ_ATTACHMENT_MAX_BYTES)

    const r = await prepareAttachment(file, 'main_pi')
    assert.equal(r.ok, true)
    assert.equal(r.ok && r.file, file, 'identity — nothing rebuilt the workbook')
    assert.equal(r.ok && r.compressed, false)
    assert.equal(r.ok && r.contentType, XLSX_MIME)
  })

  test('2. no ZIP processing is even planned for an in-limit workbook', async () => {
    const { bytes } = buildWorkbook({ media: { 'image1.png': png(200_000) } })
    const file = new NodeFile([bytes], 'pi.xlsx', { type: XLSX_MIME }) as unknown as File
    assert.equal(plannedProcessing(file, 'main_pi'), null)

    // And the proof it did no work: no stage was ever reported.
    const stages: PrepareStage[] = []
    await prepareAttachment(file, 'main_pi', (s) => stages.push(s))
    assert.deepEqual(stages, ['checking'], 'only the cheap validation ran')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// B. Safe optimisation
// ══════════════════════════════════════════════════════════════════════════════

describe('B. safe optimisation preserves everything except xl/media', () => {
  const bigJpeg = () => buildWorkbook({ media: { 'image1.jpeg': jpeg(500_000) }, sheets: ['PI', 'Terms'], formulasPerSheet: 4 })

  test('3. an oversized workbook with a large JPEG is brought under the limit', async () => {
    const wb = bigJpeg()
    assert.ok(wb.bytes.length > SMALL.limitBytes, 'fixture must start over the limit')
    const r = ok(await optimizeXlsxMedia(wb.bytes, { encoder: shrinkingEncoder(0.2), ...SMALL }))
    assert.ok(r.finalSize <= SMALL.limitBytes)
    assert.ok(r.finalSize < r.originalSize)
    assert.equal(r.optimizedImages, 1)
  })

  test('3b. the REAL 10 MB ceiling, with a genuinely oversized workbook', async () => {
    const wb = buildWorkbook({ media: { 'photo.jpeg': jpeg(11 * MB) } })
    assert.ok(wb.bytes.length > ORDER_REQ_ATTACHMENT_MAX_BYTES, 'fixture is over 10 MB')
    const r = ok(await optimizeXlsxMedia(wb.bytes, {
      encoder: shrinkingEncoder(0.3), limitBytes: ORDER_REQ_ATTACHMENT_MAX_BYTES,
    }))
    assert.ok(r.finalSize <= ORDER_REQ_ATTACHMENT_MAX_BYTES, 'must land inside the real ceiling')
    assert.ok(r.finalSize <= XLSX_TARGET_BYTES, 'and inside the working target')
  })

  test('4. a PNG entry is re-encoded as PNG — never converted to another format', async () => {
    // Real alpha preservation is a canvas behaviour and is a BROWSER-ONLY check.
    // What is proven here: the entry keeps its name, its extension and its PNG
    // magic bytes, so transparency is never lost to a format switch.
    const wb = buildWorkbook({ media: { 'logo.png': png(500_000) } })
    const r = ok(await optimizeXlsxMedia(wb.bytes, { encoder: shrinkingEncoder(0.2), ...SMALL }))
    const out = reopen(r.bytes)
    assert.ok('xl/media/logo.png' in out.entries, 'name and extension unchanged')
    assert.equal(sniffImageFormat(out.entries['xl/media/logo.png']), 'png')
  })

  test('5. the original filename and canonical MIME survive the round trip', async () => {
    const wb = buildWorkbook({ media: { 'image1.jpeg': jpeg(500_000) } })
    const file = new NodeFile([wb.bytes], 'BOE Proforma Invoice.xlsx', { type: XLSX_MIME }) as unknown as File
    // prepareAttachment uses the canvas encoder, which is unavailable here, so
    // drive the optimiser directly and rebuild the File the way it does.
    const r = ok(await optimizeXlsxMedia(wb.bytes, { encoder: shrinkingEncoder(0.2), ...SMALL }))
    const out = new NodeFile([r.bytes], file.name, { type: XLSX_MIME }) as unknown as File
    assert.equal(out.name, 'BOE Proforma Invoice.xlsx')
    assert.equal(out.type, XLSX_MIME)
  })

  test('6. the output reopens as a ZIP with the same entries in the same order', async () => {
    const wb = bigJpeg()
    const r = ok(await optimizeXlsxMedia(wb.bytes, { encoder: shrinkingEncoder(0.2), ...SMALL }))
    const out = reopen(r.bytes)
    assert.deepEqual(out.names, wb.names)
  })

  test('7. every non-media entry is byte-identical', async () => {
    const wb = bigJpeg()
    const r = ok(await optimizeXlsxMedia(wb.bytes, { encoder: shrinkingEncoder(0.2), ...SMALL }))
    const out = reopen(r.bytes)
    for (const name of wb.names) {
      if (name.startsWith('xl/media/')) continue
      assert.ok(bytesEqual(wb.entries[name], out.entries[name]), `${name} must be untouched`)
    }
  })

  test('8-11. worksheets, workbook, styles, drawings and rels are byte-identical', async () => {
    const wb = bigJpeg()
    const r = ok(await optimizeXlsxMedia(wb.bytes, { encoder: shrinkingEncoder(0.2), ...SMALL }))
    const out = reopen(r.bytes)
    for (const name of [
      'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/workbook.xml',
      'xl/styles.xml', 'xl/drawings/drawing1.xml', 'xl/drawings/_rels/drawing1.xml.rels',
      '[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels',
    ]) {
      assert.ok(bytesEqual(wb.entries[name], out.entries[name]), `${name} must be byte-identical`)
    }
  })

  test('12. sheet count and sheet names are unchanged', async () => {
    const wb = bigJpeg()
    const r = ok(await optimizeXlsxMedia(wb.bytes, { encoder: shrinkingEncoder(0.2), ...SMALL }))
    const out = reopen(r.bytes)
    assert.deepEqual(readSheetNames(out.entries), ['PI', 'Terms'])
    assert.deepEqual(readSheetNames(out.entries), readSheetNames(wb.entries))
  })

  test('13. the formula count is unchanged', async () => {
    const wb = bigJpeg()
    assert.equal(countFormulas(wb.entries), 8, 'two sheets x four formulas')
    const r = ok(await optimizeXlsxMedia(wb.bytes, { encoder: shrinkingEncoder(0.2), ...SMALL }))
    assert.equal(countFormulas(reopen(r.bytes).entries), 8)
  })

  test('14. every media relationship target still resolves', async () => {
    const wb = buildWorkbook({ media: { 'image1.png': png(300_000), 'image2.jpeg': jpeg(300_000) } })
    const r = ok(await optimizeXlsxMedia(wb.bytes, { encoder: shrinkingEncoder(0.2), ...SMALL }))
    const out = reopen(r.bytes)
    const targets = collectInternalRelTargets(out.entries)
    assert.ok(targets.some(t => t.resolved === 'xl/media/image1.png'))
    assert.ok(targets.some(t => t.resolved === 'xl/media/image2.jpeg'))
    for (const { resolved } of targets) assert.ok(resolved in out.entries, `${resolved} must exist`)
  })

  test('15. the accepted output is at or below the limit it was given', async () => {
    const wb = bigJpeg()
    const r = ok(await optimizeXlsxMedia(wb.bytes, { encoder: shrinkingEncoder(0.2), ...SMALL }))
    assert.ok(r.finalSize <= SMALL.limitBytes)
    assert.equal(r.bytes.length, r.finalSize, 'the reported size is the real byte length')
  })

  test('the largest media is optimised first', async () => {
    const seen: number[] = []
    const spy: MediaEncoder = async (req) => { seen.push(req.bytes.length); return png(Math.floor(req.bytes.length * 0.1), 51) }
    const wb = buildWorkbook({ media: { 'small.png': png(120_000), 'huge.png': png(600_000) } })
    await optimizeXlsxMedia(wb.bytes, { encoder: spy, ...SMALL })
    assert.equal(seen[0], 600_000, 'the biggest picture is where the bytes are')
  })

  test('media below the minimum is never re-encoded', async () => {
    const seen: string[] = []
    const spy: MediaEncoder = async (req) => { seen.push(String(req.bytes.length)); return png(Math.floor(req.bytes.length * 0.1), 61) }
    const wb = buildWorkbook({ media: { 'tiny.png': png(20_000), 'big.png': png(600_000) } })
    assert.ok(20_000 < MIN_MEDIA_OPTIMIZE_BYTES)
    await optimizeXlsxMedia(wb.bytes, { encoder: spy, ...SMALL })
    assert.ok(!seen.includes('20000'), 'a 20 KB logo is left alone')
  })

  test('unsupported media alongside supported media stays byte-identical', async () => {
    const wb = buildWorkbook({ media: { 'diagram.emf': emf(150_000), 'photo.jpeg': jpeg(500_000) } })
    const r = ok(await optimizeXlsxMedia(wb.bytes, { encoder: shrinkingEncoder(0.15), ...SMALL }))
    const out = reopen(r.bytes)
    assert.ok(bytesEqual(wb.entries['xl/media/diagram.emf'], out.entries['xl/media/diagram.emf']),
      'the EMF must be carried through untouched')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// C. Refusal
// ══════════════════════════════════════════════════════════════════════════════

describe('C. anything unsafe is refused, never passed through', () => {
  const fail = (r: XlsxOptimizeResult) => { assert.equal(r.ok, false); return r as Extract<XlsxOptimizeResult, { ok: false }> }

  test('16. a workbook with no optimisable media is refused', async () => {
    const wb = buildWorkbook({ extra: { 'xl/bulk.bin': noise(500_000, [0x00]) } })
    const r = fail(await optimizeXlsxMedia(wb.bytes, { encoder: shrinkingEncoder(), ...SMALL }))
    assert.equal(r.reason, 'no_optimizable_media')
  })

  test('17. a workbook whose media is entirely unsupported is refused', async () => {
    const wb = buildWorkbook({ media: { 'a.emf': emf(300_000), 'b.gif': gif(300_000) } })
    const r = fail(await optimizeXlsxMedia(wb.bytes, { encoder: shrinkingEncoder(), ...SMALL }))
    assert.equal(r.reason, 'no_optimizable_media', 'EMF and animated-capable GIF are never rasterised')
  })

  test('18. a workbook that cannot reach the limit within the round budget is refused', async () => {
    const wb = buildWorkbook({ media: { 'photo.jpeg': jpeg(600_000) } })
    const r = fail(await optimizeXlsxMedia(wb.bytes, { encoder: stubbornEncoder, ...SMALL }))
    assert.equal(r.reason, 'still_over_limit')
  })

  test('the round budget is bounded', async () => {
    let rounds = 0
    const counting: MediaEncoder = async (req) => { rounds++; return jpeg(Math.max(16, req.bytes.length - 8), 71) }
    const wb = buildWorkbook({ media: { 'photo.jpeg': jpeg(600_000) } })
    await optimizeXlsxMedia(wb.bytes, { encoder: counting, ...SMALL })
    assert.ok(rounds <= MAX_OPTIMIZE_ROUNDS, `at most ${MAX_OPTIMIZE_ROUNDS} attempts, saw ${rounds}`)
  })

  test('19. an invalid ZIP is refused', async () => {
    const r = fail(await optimizeXlsxMedia(noise(600_000, [0x00]), { encoder: shrinkingEncoder(), ...SMALL }))
    assert.equal(r.reason, 'invalid_zip')
  })

  test('20. a ZIP missing required workbook parts is refused', async () => {
    for (const missing of ['xl/workbook.xml', '[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels']) {
      const wb = buildWorkbook({ media: { 'photo.jpeg': jpeg(500_000) }, omit: [missing] })
      const r = fail(await optimizeXlsxMedia(wb.bytes, { encoder: shrinkingEncoder(0.2), ...SMALL }))
      assert.equal(r.reason, 'missing_workbook_parts', `omitting ${missing} must refuse`)
    }
  })

  test('20b. a ZIP with no worksheet at all is refused', async () => {
    const wb = buildWorkbook({ media: { 'photo.jpeg': jpeg(500_000) }, omit: ['xl/worksheets/sheet1.xml'] })
    const r = fail(await optimizeXlsxMedia(wb.bytes, { encoder: shrinkingEncoder(0.2), ...SMALL }))
    assert.equal(r.reason, 'missing_workbook_parts')
  })

  test('21. a zip bomb (absurd compression ratio) is refused', async () => {
    // 8 MB of zeros deflates to a few KB — the classic shape of a decompression
    // bomb, and exactly what the RATIO guard exists to stop.
    const wb = buildWorkbook({ extra: { 'xl/bomb.bin': new Uint8Array(8 * MB) } })
    assert.ok(wb.bytes.length < 100_000, 'the bomb really is tiny on disk')
    const r = fail(await optimizeXlsxMedia(wb.bytes, { encoder: shrinkingEncoder(0.2), ...SMALL }))
    assert.equal(r.reason, 'decompressed_too_large')
  })

  test('21b. the ABSOLUTE decompressed ceiling stops a bomb that hides behind a low ratio', async () => {
    // A crafted archive can keep its ratio innocent by padding with
    // incompressible data. The absolute budget is what catches that, and it is
    // enforced from the central directory — before the bytes are ever inflated.
    const wb = buildWorkbook({
      media: { 'p.jpeg': jpeg(300_000) },
      extra: { 'xl/pad.bin': noise(2 * MB, [0x00], 7), 'xl/zeros.bin': new Uint8Array(2 * MB) },
    })
    const r = fail(await optimizeXlsxMedia(wb.bytes, {
      encoder: shrinkingEncoder(0.2), ...SMALL, maxDecompressedBytes: 1 * MB,
    }))
    assert.equal(r.reason, 'decompressed_too_large')
  })

  test('22. an excessive entry count is refused', async () => {
    const extra: Record<string, Uint8Array> = {}
    for (let i = 0; i < MAX_ENTRY_COUNT + 10; i++) extra[`xl/junk/f${i}.xml`] = xml('<a/>')
    const wb = buildWorkbook({ media: { 'p.jpeg': jpeg(200_000) }, extra })
    const r = fail(await optimizeXlsxMedia(wb.bytes, { encoder: shrinkingEncoder(0.2), ...SMALL }))
    assert.equal(r.reason, 'too_many_entries')
  })

  test('22b. the entry-count guard trips at whatever budget it is given', async () => {
    const wb = buildWorkbook({ media: { 'p.jpeg': jpeg(300_000) } })
    const r = fail(await optimizeXlsxMedia(wb.bytes, { encoder: shrinkingEncoder(0.2), ...SMALL, maxEntryCount: 3 }))
    assert.equal(r.reason, 'too_many_entries')
  })

  test('23. a path-traversal entry name is refused', async () => {
    const wb = buildWorkbook({ media: { 'p.jpeg': jpeg(400_000) }, extra: { '../../evil.xml': xml('<a/>') } })
    const r = fail(await optimizeXlsxMedia(wb.bytes, { encoder: shrinkingEncoder(0.2), ...SMALL }))
    assert.equal(r.reason, 'unsafe_entry_name')
  })

  test('24. a corrupted rebuild is caught by the reopen-and-compare gate', () => {
    // Drive the gate directly: it is the last line of defence, so it must reject
    // a mutated part even when everything else about the archive looks right.
    const wb = buildWorkbook({ media: { 'p.jpeg': jpeg(100_000) } })
    const rebuilt: ArchiveEntries = { ...wb.entries }
    rebuilt['xl/worksheets/sheet1.xml'] = xml('<worksheet/>')
    assert.equal(
      validateRebuiltArchive(wb.entries, wb.names, rebuilt, wb.names, new Set(['xl/media/p.jpeg'])),
      'critical_part_modified')
  })

  test('24b. the gate catches every other way the archive could drift', () => {
    const wb = buildWorkbook({ media: { 'p.jpeg': jpeg(100_000), 'q.emf': emf(50_000) } })
    const changed = new Set(['xl/media/p.jpeg'])
    const clone = (): ArchiveEntries => ({ ...wb.entries })

    const dropped = clone(); delete dropped['xl/styles.xml']
    assert.equal(validateRebuiltArchive(wb.entries, wb.names, dropped, wb.names.filter(n => n !== 'xl/styles.xml'), changed),
      'entry_count_changed')

    const untouchedMedia = clone(); untouchedMedia['xl/media/q.emf'] = emf(40_000, 99)
    assert.equal(validateRebuiltArchive(wb.entries, wb.names, untouchedMedia, wb.names, changed),
      'untouched_media_modified')

    const reordered = [...wb.names].reverse()
    assert.equal(validateRebuiltArchive(wb.entries, wb.names, clone(), reordered, changed), 'entry_names_changed')

    const dupes = [...wb.names, wb.names[0]]
    assert.equal(validateRebuiltArchive(wb.entries, wb.names, clone(), dupes, changed), 'duplicate_entry')

    const brokenRel = clone()
    brokenRel['xl/drawings/_rels/drawing1.xml.rels'] = xml(
      `<Relationships xmlns="x"><Relationship Id="r1" Type="t" Target="../media/missing.png"/></Relationships>`)
    // A modified rels file is caught as a critical part before the link check,
    // which is the stricter and safer of the two failures.
    assert.equal(validateRebuiltArchive(wb.entries, wb.names, brokenRel, wb.names, changed), 'critical_part_modified')
  })

  test('24c. a broken relationship in an otherwise-clean archive is caught', () => {
    const wb = buildWorkbook({ media: { 'p.jpeg': jpeg(100_000) } })
    const rebuilt: ArchiveEntries = { ...wb.entries }
    const names = [...wb.names]
    // Same rels bytes on both sides, but the media it points at is gone from the
    // rebuild's name list AND both maps, so only the link check can catch it.
    delete rebuilt['xl/media/p.jpeg']
    const original: ArchiveEntries = { ...wb.entries }
    delete original['xl/media/p.jpeg']
    const trimmed = names.filter(n => n !== 'xl/media/p.jpeg')
    assert.equal(validateRebuiltArchive(original, trimmed, rebuilt, trimmed, new Set()), 'broken_relationship')
  })

  test('25. an encoder that changes format is ignored — the original bytes are kept', async () => {
    const wb = buildWorkbook({ media: { 'logo.png': png(500_000) } })
    const r = await optimizeXlsxMedia(wb.bytes, { encoder: formatSwappingEncoder, ...SMALL })
    assert.equal(r.ok, false, 'a format swap must never be accepted')
    assert.equal(!r.ok && r.reason, 'nothing_optimized')
  })

  test('25b. an encoder that returns LARGER bytes is ignored', async () => {
    const wb = buildWorkbook({ media: { 'logo.png': png(500_000) } })
    const r = await optimizeXlsxMedia(wb.bytes, { encoder: growingEncoder, ...SMALL })
    assert.equal(!r.ok && r.reason, 'nothing_optimized')
  })

  test('25c. an encoder that throws is contained, and refuses rather than corrupts', async () => {
    const wb = buildWorkbook({ media: { 'logo.png': png(500_000) } })
    const throwing: MediaEncoder = async () => { throw new Error('canvas exploded') }
    const r = await optimizeXlsxMedia(wb.bytes, { encoder: throwing, ...SMALL })
    assert.equal(!r.ok && r.reason, 'nothing_optimized')
  })

  test('25d. an encoder that refuses everything refuses the workbook', async () => {
    const wb = buildWorkbook({ media: { 'logo.png': png(500_000) } })
    const r = await optimizeXlsxMedia(wb.bytes, { encoder: refusingEncoder, ...SMALL })
    assert.equal(!r.ok && r.reason, 'nothing_optimized')
  })

  test('25e. an input beyond the processing ceiling is refused without unzipping', async () => {
    const huge = new Uint8Array(16)
    Object.defineProperty(huge, 'length', { value: MAX_OPTIMIZE_INPUT_BYTES + 1 })
    const r = await optimizeXlsxMedia(huge, { encoder: shrinkingEncoder(), ...SMALL })
    assert.equal(!r.ok && r.reason, 'input_too_large')
  })

  test('25f. a timeout refuses instead of running forever', async () => {
    const wb = buildWorkbook({ media: { 'photo.jpeg': jpeg(600_000) } })
    let clock = 0
    const r = await optimizeXlsxMedia(wb.bytes, {
      encoder: stubbornEncoder, ...SMALL,
      now: () => (clock += 120_000), // every check jumps two minutes
    })
    assert.equal(!r.ok && r.reason, 'timeout')
  })

  test('25g. THE INVARIANT — a refused workbook never yields uploadable bytes', async () => {
    const wb = buildWorkbook({ media: { 'logo.png': png(500_000) } })
    for (const encoder of [refusingEncoder, growingEncoder, formatSwappingEncoder, stubbornEncoder]) {
      const r = await optimizeXlsxMedia(wb.bytes, { encoder, ...SMALL })
      assert.equal(r.ok, false)
      assert.ok(!('bytes' in r), 'a refusal carries no bytes at all')
    }
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// D. Legacy Excel
// ══════════════════════════════════════════════════════════════════════════════

describe('D. legacy .xls', () => {
  function xlsFile(size: number): File {
    const f = new NodeFile(['x'], 'legacy.xls', { type: XLS_MIME })
    Object.defineProperty(f, 'size', { value: size, configurable: true })
    return f as unknown as File
  }

  test('26. an .xls below 10 MB is accepted unchanged', async () => {
    const f = xlsFile(6 * MB)
    const r = await prepareAttachment(f, 'main_pi')
    assert.equal(r.ok, true)
    assert.equal(r.ok && r.file, f, 'identity — a legacy workbook is never rewritten')
    assert.equal(r.ok && r.compressed, false)
  })

  test('27. an .xls above 10 MB is refused', async () => {
    const r = await prepareAttachment(xlsFile(18 * MB), 'main_pi')
    assert.equal(r.ok, false)
    assert.match(!r.ok ? r.error : '', /legacy Excel/i)
  })

  test('28. an .xls is never routed through the .xlsx optimiser', async () => {
    assert.equal(plannedProcessing(xlsFile(18 * MB), 'main_pi'), null, 'no xlsx plan for a BIFF8 file')
    const stages: PrepareStage[] = []
    await prepareAttachment(xlsFile(18 * MB), 'main_pi', (s) => stages.push(s))
    assert.deepEqual(stages, ['checking'], 'no reading/optimizing/rebuilding stage ever ran')
  })

  test('an oversized .xlsx IS planned for optimisation — the two formats diverge', () => {
    const f = new NodeFile(['x'], 'pi.xlsx', { type: XLSX_MIME })
    Object.defineProperty(f, 'size', { value: 18 * MB, configurable: true })
    assert.equal(plannedProcessing(f as unknown as File, 'main_pi'), 'xlsx')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// E. Processing state
// ══════════════════════════════════════════════════════════════════════════════

describe('E. processing state and stale results', () => {
  test('29. every stage the optimiser reports is a declared processing stage', async () => {
    // The submit button is disabled for exactly the statuses these stages map to,
    // so a stage that escaped the list would be a stage the button ignored.
    const wb = buildWorkbook({ media: { 'photo.jpeg': jpeg(500_000) } })
    const seen: string[] = []
    await optimizeXlsxMedia(wb.bytes, {
      encoder: shrinkingEncoder(0.2), ...SMALL, onStage: (s) => seen.push(s),
    })
    assert.ok(seen.includes('reading') && seen.includes('optimizing') &&
      seen.includes('rebuilding') && seen.includes('validating'), `saw ${seen.join(',')}`)
    for (const stage of seen) {
      assert.ok((PREPARE_STAGES as readonly string[]).includes(stage), `${stage} must be a declared stage`)
    }
  })

  test('29b. prepareAttachment reports the workbook stages end to end', async () => {
    const wb = buildWorkbook({ media: { 'photo.jpeg': jpeg(500_000) } })
    const file = new NodeFile([wb.bytes], 'pi.xlsx', { type: XLSX_MIME }) as unknown as File
    Object.defineProperty(file, 'size', { value: 18 * MB, configurable: true })
    const stages: PrepareStage[] = []
    await prepareAttachment(file, 'main_pi', (s) => stages.push(s))
    assert.deepEqual(stages.slice(0, 2), ['checking', 'reading'])
  })

  test('30. a stale result is discarded after the file is replaced', () => {
    assert.equal(planStageApplication({ slotId: 'gen-2', resultId: 'gen-1', aborted: false }), 'discard-stale')
    assert.equal(planStageApplication({ slotId: 'gen-1', resultId: 'gen-1', aborted: false }), 'apply')
  })

  test('30b. a result for a slot that was cleared is discarded', () => {
    assert.equal(planStageApplication({ slotId: null, resultId: 'gen-1', aborted: false }), 'discard-stale')
  })

  test('31. a torn-down modal discards results even for the matching slot', () => {
    assert.equal(planStageApplication({ slotId: 'gen-1', resultId: 'gen-1', aborted: true }), 'discard-aborted')
  })

  test('32. a successful result exposes both the original and the optimised size', async () => {
    const wb = buildWorkbook({ media: { 'photo.jpeg': jpeg(500_000) } })
    const r = ok(await optimizeXlsxMedia(wb.bytes, { encoder: shrinkingEncoder(0.2), ...SMALL }))
    assert.equal(r.originalSize, wb.bytes.length)
    assert.ok(r.finalSize > 0 && r.finalSize < r.originalSize)
    assert.ok(r.optimizedImages >= 1, 'and says how many images it actually touched')
  })

  test('33. a retry is a fresh generation — the previous one can no longer apply', () => {
    const first = 'staged-1', retry = 'staged-2'
    assert.equal(planStageApplication({ slotId: retry, resultId: first, aborted: false }), 'discard-stale')
    assert.equal(planStageApplication({ slotId: retry, resultId: retry, aborted: false }), 'apply')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// Pure helpers
// ══════════════════════════════════════════════════════════════════════════════

describe('pure helpers', () => {
  test('format sniffing reads magic bytes, not names', () => {
    assert.equal(sniffImageFormat(png(64)), 'png')
    assert.equal(sniffImageFormat(jpeg(64)), 'jpeg')
    assert.equal(sniffImageFormat(webp(64)), 'webp')
    assert.equal(sniffImageFormat(gif(64)), 'gif')
    assert.equal(sniffImageFormat(emf(64)), 'unknown')
    assert.equal(sniffImageFormat(new Uint8Array(2)), 'unknown')
  })

  test('media whose bytes contradict its extension is left alone', () => {
    const entries: ArchiveEntries = { 'xl/media/logo.png': jpeg(200_000) }
    assert.deepEqual(listOptimizableMedia(entries), [], 'a JPEG named .png is not re-encoded')
  })

  test('only xl/media is ever considered', () => {
    const entries: ArchiveEntries = {
      'xl/media/a.png': png(200_000),
      'xl/drawings/b.png': png(200_000),
      'docProps/thumbnail.jpeg': jpeg(200_000),
    }
    assert.deepEqual(listOptimizableMedia(entries), ['xl/media/a.png'])
  })

  test('unsafe entry names are recognised', () => {
    for (const bad of ['../x', 'a/../../b', '/abs/x', 'C:\\x', 'a\\b', '', 'a\0b']) {
      assert.equal(isUnsafeEntryName(bad), true, bad)
    }
    for (const good of ['xl/media/image1.png', '[Content_Types].xml', '_rels/.rels']) {
      assert.equal(isUnsafeEntryName(good), false, good)
    }
  })

  test('relationship targets resolve the way OOXML says they do', () => {
    assert.equal(resolveRelTarget('xl/drawings/_rels/drawing1.xml.rels', '../media/image1.png'), 'xl/media/image1.png')
    assert.equal(resolveRelTarget('xl/_rels/workbook.xml.rels', 'worksheets/sheet1.xml'), 'xl/worksheets/sheet1.xml')
    assert.equal(resolveRelTarget('_rels/.rels', 'xl/workbook.xml'), 'xl/workbook.xml')
    assert.equal(resolveRelTarget('_rels/.rels', '/xl/workbook.xml'), 'xl/workbook.xml')
    assert.equal(resolveRelTarget('xl/_rels/workbook.xml.rels', 'http://example.com/x'), null)
  })

  test('external relationships are not policed as internal links', () => {
    const entries: ArchiveEntries = {
      'xl/worksheets/_rels/sheet1.xml.rels': xml(
        `<Relationships><Relationship Id="r1" Target="https://boe.example/x" TargetMode="External"/>` +
        `<Relationship Id="r2" Target="../media/image1.png"/></Relationships>`),
    }
    const targets = collectInternalRelTargets(entries)
    assert.deepEqual(targets.map(t => t.resolved), ['xl/media/image1.png'])
  })

  test('structure validation rejects duplicates that a name map would hide', () => {
    const wb = buildWorkbook({ media: { 'p.jpeg': jpeg(1000) } })
    const withDupe = [...wb.names, 'xl/workbook.xml']
    assert.deepEqual(validateArchiveStructure(withDupe, wb.entries), { ok: false, reason: 'duplicate_entry' })
    assert.deepEqual(validateArchiveStructure(wb.names, wb.entries), { ok: true })
  })

  test('the canvas encoder fails closed without a DOM', async () => {
    const encoder = createCanvasMediaEncoder()
    const out = await encoder({
      bytes: png(1000), format: 'png', mime: 'image/png',
      maxEdge: 2000, quality: 0.8, maxPixels: 1_000_000,
    })
    assert.equal(out, null, 'no DOM means no encoding — never a silent pass-through')
  })

  test('bytesEqual compares content, not identity', () => {
    assert.equal(bytesEqual(png(100), png(100)), true)
    assert.equal(bytesEqual(png(100), png(101)), false)
    assert.equal(bytesEqual(png(100, 1), png(100, 2)), false)
  })
})
