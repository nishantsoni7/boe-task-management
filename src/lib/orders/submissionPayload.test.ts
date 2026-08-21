/**
 * What the server persists, derived from a server-side parse.
 *
 * WHAT THESE TESTS DEFEND. buildSubmissionPlan sits between the parser and the
 * only function that may write a price. Everything that could go wrong here is
 * silent:
 *
 *   * an item id that is not stable, so a retry uploads a second set of images
 *     nobody points at;
 *   * an image path that names the wrong item or the wrong submission, which
 *     would attach one product's photograph to another;
 *   * a customization position with a gap, so "image 2 of 3" points elsewhere;
 *   * "Inclusive" persisted as "not applicable", which reverses what the client
 *     was told about a charge;
 *   * a workbook path accepted for somebody else's draft.
 *
 * Offline and pure. No database, no network, no storage. Every fixture is
 * synthetic — invented names, invented figures, three invented bytes per image.
 *
 * Run:
 *   npx tsx --test src/lib/orders/submissionPayload.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  buildSubmissionPlan,
  buildImagePath,
  buildWorkbookPath,
  deterministicItemId,
  isUuid,
  isWorkbookPathFor,
  persistedCost,
  sha256Hex,
  storableImageMime,
  verifyStoredImageBytes,
  hashFromImagePath,
  MAX_IMAGE_OBJECT_BYTES,
  WORKBOOK_PATH_PATTERN,
} from './submissionPayload'
import { sniffImageFormat } from '../xlsxMediaOptimizer'
import { storableImageMime as storableImageMimeRule } from '../pi/imageFormats'
import type {
  PiAmountOrText,
  PiCommercialSummary,
  PiHeader,
  PiImageRole,
  PiProduct,
  PiProductImage,
  PiTemplateInfo,
  PiWorkbook,
} from '../pi/types'

// ── Synthetic fixtures ────────────────────────────────────────────────────────

const SUBMISSION = '11111111-2222-4333-8444-555555555555'
const OTHER_SUBMISSION = '99999999-8888-4777-8666-555555555555'

const amount = (n: number, cell = 'I122'): PiAmountOrText =>
  ({ amount: n, text: null, zeroMeaning: null, cell })
const nilValue = (cell = 'I117'): PiAmountOrText =>
  ({ amount: 0, text: null, zeroMeaning: 'notApplicable', cell })
const includedValue = (cell = 'I118', text = 'Inclusive'): PiAmountOrText =>
  ({ amount: 0, text, zeroMeaning: 'included', cell })
const textValue = (t: string, cell = 'I119'): PiAmountOrText =>
  ({ amount: null, text: t, zeroMeaning: null, cell })
const emptyValue = (cell = 'I120'): PiAmountOrText =>
  ({ amount: null, text: null, zeroMeaning: null, cell })

const image = (over: Partial<PiProductImage> = {}): PiProductImage => ({
  role: 'representative',
  row: 32,
  part: 'xl/media/image1.png',
  bytes: new Uint8Array([1, 2, 3]),
  byteLength: 3,
  format: 'png',
  mimeType: 'image/png',
  extension: 'png',
  anchorKind: 'twoCellAnchor',
  anchorFromCol: 4,
  anchorFromRow: 31,
  ...over,
})

const customization = (over: Partial<PiProductImage> = {}): PiProductImage =>
  image({ role: 'customization', anchorFromCol: 10, part: 'xl/media/cust1.png', ...over })

const product = (over: Partial<PiProduct> = {}): PiProduct => ({
  row: 32,
  sourceProductCode: 'SRC-1',
  productName: 'Item One',
  quantity: 2,
  dimensions: 'W40 x H30',
  material: 'Invented Material',
  costPerPiece: 1000,
  lineTotal: 2000,
  itemSequence: 'B001',
  customization: null,
  representativeImage: image(),
  customizationImages: [],
  ...over,
})

const header = (over: Partial<PiHeader> = {}): PiHeader => ({
  sourceOrderNumber: 'SRC-407',
  creationDate: { iso: '2026-08-16', text: '16/08/2026', source: 'serial' },
  createdBy: 'Sample Employee',
  boeGst: '00AAAAA0000A0Z0',
  contactNumber: '9000000001',
  billToName: 'Sample Buyer Ltd',
  billToPhone: '9000000002',
  billToGst: '11BBBBB1111B1Z1',
  billingAddress: '1 Invented Road',
  shipToName: 'Sample Site',
  shipToPhone: '9000000003',
  shipToGst: '22CCCCC2222C2Z2',
  shippingAddress: '2 Fictional Lane',
  orderConfirmationDate: { iso: '2026-08-20', text: '20/08/2026', source: 'serial' },
  dispatchCommitment: { iso: null, text: '6 weeks from date of confirmation', source: 'text' },
  ...over,
})

const commercial = (over: Partial<PiCommercialSummary> = {}): PiCommercialSummary => ({
  discount: 0,
  discountLabel: 'Design Fees',
  subtotalAfterDiscount: amount(2000, 'I116'),
  fabricCost: nilValue('I117'),
  packingCost: nilValue('I118'),
  transportation: textValue('as applicable'),
  totalBeforeGst: amount(2000, 'I120'),
  gst: amount(360, 'I121'),
  grandTotal: amount(2360, 'I122'),
  grossProductAmount: 2000,
  expectedSubtotal: 2000,
  ...over,
})

const template: PiTemplateInfo = {
  sheetName: 'Master',
  sheetPart: 'xl/worksheets/sheet3.xml',
  workbookSheetNames: ['Cover', 'Master'],
  drawingPart: 'xl/drawings/drawing1.xml',
  headerRow: 31,
  firstProductRow: 32,
  lastProductRow: 111,
  fingerprint: [],
  hiddenProductRows: [],
  genuineProductRows: [32],
  workbookByteLength: 1024,
}

const workbook = (products: PiProduct[], over: Partial<PiWorkbook> = {}): PiWorkbook => ({
  template,
  header: header(),
  products,
  commercial: commercial(),
  representativeImages: products.flatMap(p => (p.representativeImage ? [p.representativeImage] : [])),
  customizationImages: products.flatMap(p => [...p.customizationImages]),
  ...over,
})

const source = {
  workbookPath: buildWorkbookPath(SUBMISSION, '66666666-7777-4888-8999-aaaaaaaaaaaa'),
  workbookName: null,
  workbookSizeBytes: 1024,
  workbookSha256: 'a'.repeat(64),
  templateVersion: 'Master',
}

const plan = (products: PiProduct[]) =>
  buildSubmissionPlan({
    submissionId: SUBMISSION,
    workbook: workbook(products),
    warnings: [],
    blockingIssues: [],
    source,
  })

type PayloadItem = Record<string, unknown>
const itemsOf = (p: ReturnType<typeof plan>) => p.payload.items as PayloadItem[]
const imagesOf = (p: ReturnType<typeof plan>) => p.payload.item_images as PayloadItem[]
const commercialOf = (p: ReturnType<typeof plan>) => p.payload.commercial as Record<string, unknown>
const headerOf = (p: ReturnType<typeof plan>) => p.payload.header as Record<string, unknown>

// ── Deterministic identity ────────────────────────────────────────────────────

describe('deterministicItemId', () => {
  test('is stable for the same submission and row', () => {
    assert.equal(deterministicItemId(SUBMISSION, 32), deterministicItemId(SUBMISSION, 32))
  })

  test('differs per row and per submission', () => {
    assert.notEqual(deterministicItemId(SUBMISSION, 32), deterministicItemId(SUBMISSION, 33))
    assert.notEqual(deterministicItemId(SUBMISSION, 32), deterministicItemId(OTHER_SUBMISSION, 32))
  })

  test('is a well-formed UUID with a version and a variant', () => {
    const id = deterministicItemId(SUBMISSION, 32)
    assert.ok(isUuid(id), id)
    assert.equal(id[14], '8', 'version nibble')
    assert.ok(['8', '9', 'a', 'b'].includes(id[19]), 'RFC 4122 variant')
  })

  test('a re-run produces an identical plan, which is what makes retry safe', () => {
    const first = plan([product()])
    const second = plan([product()])
    assert.deepEqual(itemsOf(first), itemsOf(second))
    assert.deepEqual(imagesOf(first), imagesOf(second))
  })
})

describe('sha256Hex', () => {
  test('is the standard hex digest the schema expects', () => {
    const bytes = new Uint8Array([1, 2, 3])
    assert.equal(sha256Hex(bytes), createHash('sha256').update(bytes).digest('hex'))
    assert.match(sha256Hex(bytes), /^[0-9a-f]{64}$/)
  })
})

// ── Workbook paths ────────────────────────────────────────────────────────────

describe('isWorkbookPathFor', () => {
  const valid = buildWorkbookPath(SUBMISSION, '66666666-7777-4888-8999-aaaaaaaaaaaa')

  test('accepts this submission’s own workbook key', () => {
    assert.equal(isWorkbookPathFor(valid, SUBMISSION), true)
    assert.ok(WORKBOOK_PATH_PATTERN.test(valid))
  })

  test('refuses a well-formed key belonging to another draft', () => {
    const other = buildWorkbookPath(OTHER_SUBMISSION, '66666666-7777-4888-8999-aaaaaaaaaaaa')
    assert.equal(isWorkbookPathFor(other, SUBMISSION), false, 'the IDOR case')
  })

  test('refuses traversal, absolute and backslash keys', () => {
    for (const bad of [
      `submissions/${SUBMISSION}/original/../../etc/passwd.xlsx`,
      `/submissions/${SUBMISSION}/original/x.xlsx`,
      `submissions\\${SUBMISSION}\\original\\x.xlsx`,
      `submissions/${SUBMISSION}/original/sub/dir.xlsx`,
    ]) {
      assert.equal(isWorkbookPathFor(bad, SUBMISSION), false, bad)
    }
  })

  test('refuses anything outside original/, including the images prefix', () => {
    assert.equal(isWorkbookPathFor(`submissions/${SUBMISSION}/images/x.xlsx`, SUBMISSION), false)
    assert.equal(isWorkbookPathFor(`orders/${SUBMISSION}/versions/1/approved.xlsx`, SUBMISSION), false)
  })

  test('refuses a non-xlsx extension and a non-uuid object name', () => {
    assert.equal(isWorkbookPathFor(`submissions/${SUBMISSION}/original/x.png`, SUBMISSION), false)
    assert.equal(isWorkbookPathFor(`submissions/${SUBMISSION}/original/report.xlsx`, SUBMISSION), false)
  })

  test('refuses an invalid submission id outright', () => {
    assert.equal(isWorkbookPathFor(valid, 'not-a-uuid'), false)
  })

  test('the key carries no filename, so no client name reaches an object key', () => {
    assert.ok(!valid.includes('.xlsx.xlsx'))
    assert.match(valid, /original\/[0-9a-f-]{36}\.xlsx$/)
  })
})

// ── Image paths ───────────────────────────────────────────────────────────────

describe('buildImagePath', () => {
  const itemId = deterministicItemId(SUBMISSION, 32)
  const HASH = 'b'.repeat(64)
  const OTHER_HASH = 'c'.repeat(64)

  test('names the submission, the item, the role, the position AND the bytes', () => {
    assert.equal(
      buildImagePath({ submissionId: SUBMISSION, itemId, role: 'representative', position: 0, mimeType: 'image/png', sha256: HASH }),
      `submissions/${SUBMISSION}/images/${itemId}/representative/0-${HASH}.png`,
    )
    assert.equal(
      buildImagePath({ submissionId: SUBMISSION, itemId, role: 'customization', position: 2, mimeType: 'image/jpeg', sha256: HASH }),
      `submissions/${SUBMISSION}/images/${itemId}/customization/2-${HASH}.jpg`,
    )
  })

  test('the key contains the hash of the bytes it holds', () => {
    const bytes = new Uint8Array([1, 2, 3])
    const path = buildImagePath({
      submissionId: SUBMISSION, itemId, role: 'representative', position: 0,
      mimeType: 'image/png', sha256: sha256Hex(bytes),
    })
    assert.ok(path.includes(sha256Hex(bytes)))
  })

  test('DIFFERENT bytes are a DIFFERENT key, so nothing live is overwritten', () => {
    const a = buildImagePath({ submissionId: SUBMISSION, itemId, role: 'representative', position: 0, mimeType: 'image/png', sha256: HASH })
    const b = buildImagePath({ submissionId: SUBMISSION, itemId, role: 'representative', position: 0, mimeType: 'image/png', sha256: OTHER_HASH })
    assert.notEqual(a, b, 'a changed picture cannot land on the old object')
  })

  test('IDENTICAL bytes are the SAME key, so a retry reuses the object', () => {
    const args = { submissionId: SUBMISSION, itemId, role: 'representative' as const, position: 0, mimeType: 'image/png', sha256: HASH }
    assert.equal(buildImagePath(args), buildImagePath(args))
  })

  test('the extension comes from the sniffed type, not from a filename', () => {
    for (const [mime, ext] of [['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp']]) {
      const path = buildImagePath({
        submissionId: SUBMISSION, itemId, role: 'representative', position: 0, mimeType: mime, sha256: HASH,
      })
      assert.ok(path.endsWith(`.${ext}`), `${mime} → .${ext}`)
    }
  })

  test('an unsupported type is refused rather than guessed at', () => {
    assert.equal(storableImageMime('image/gif'), null)
    assert.equal(storableImageMime('image/tiff'), null)
    assert.equal(storableImageMime(null), null)
    assert.throws(() => buildImagePath({
      submissionId: SUBMISSION, itemId, role: 'representative', position: 0, mimeType: 'image/gif', sha256: HASH,
    }))
  })

  test('a malformed hash is refused, so a key can never carry a bad claim', () => {
    for (const bad of ['', 'not-a-hash', 'B'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
      assert.throws(() => buildImagePath({
        submissionId: SUBMISSION, itemId, role: 'representative', position: 0, mimeType: 'image/png', sha256: bad,
      }), `hash ${JSON.stringify(bad)} must be refused`)
    }
  })

  test('the built path matches the shape the database CHECK rebuilds', () => {
    // The same expression as order_submission_item_images_path_shape, hash and
    // all: a row whose key names a different hash than the row records is
    // refused by the database.
    const role: PiImageRole = 'customization'
    const path = buildImagePath({ submissionId: SUBMISSION, itemId, role, position: 1, mimeType: 'image/webp', sha256: HASH })
    const dbPattern = new RegExp(
      `^submissions/${SUBMISSION}/images/${itemId}/${role}/1-${HASH}\\.(png|jpg|jpeg|webp)$`,
    )
    assert.ok(dbPattern.test(path))

    // …and the same key with the row claiming another hash does NOT match.
    const mismatched = new RegExp(
      `^submissions/${SUBMISSION}/images/${itemId}/${role}/1-${OTHER_HASH}\\.(png|jpg|jpeg|webp)$`,
    )
    assert.ok(!mismatched.test(path), 'the constraint rejects a hash/key mismatch')
  })
})

// ── Immutability and replay ───────────────────────────────────────────────────

describe('content addressing across attempts', () => {
  test('every planned path carries its own row’s hash', () => {
    const built = plan([product({ customizationImages: [customization()] })])
    for (const img of imagesOf(built)) {
      assert.ok(String(img.storage_path).includes(String(img.sha256)))
    }
  })

  test('re-processing the same workbook plans the identical keys', () => {
    assert.deepEqual(
      imagesOf(plan([product()])).map(i => i.storage_path),
      imagesOf(plan([product()])).map(i => i.storage_path),
    )
  })

  test('a changed picture plans a NEW key, leaving the old one untouched', () => {
    const before = plan([product({ representativeImage: image({ bytes: new Uint8Array([1, 1, 1]) }) })])
    const after = plan([product({ representativeImage: image({ bytes: new Uint8Array([2, 2, 2]) }) })])

    const oldPath = imagesOf(before)[0].storage_path
    const newPath = imagesOf(after)[0].storage_path
    assert.notEqual(oldPath, newPath)
    // Same product, same slot — only the bytes moved.
    assert.equal(imagesOf(before)[0].item_id, imagesOf(after)[0].item_id)
    assert.equal(imagesOf(before)[0].position, imagesOf(after)[0].position)
  })

  test('two products sharing bytes still get distinct keys, via their item ids', () => {
    const shared = new Uint8Array([5, 5, 5])
    const built = plan([
      product({ row: 32, representativeImage: image({ bytes: shared }) }),
      product({ row: 33, itemSequence: 'B002', representativeImage: image({ row: 33, bytes: shared }) }),
    ])
    const paths = imagesOf(built).map(i => i.storage_path)
    assert.equal(new Set(paths).size, 2)
    // …and the hash segment is the same in both, because the bytes are.
    assert.equal(imagesOf(built)[0].sha256, imagesOf(built)[1].sha256)
  })

  test('one photograph in both roles yields two keys that differ only by role', () => {
    const bytes = new Uint8Array([6, 6, 6])
    const built = plan([product({
      representativeImage: image({ bytes }),
      customizationImages: [customization({ bytes })],
    })])
    const [rep, cust] = imagesOf(built)
    assert.equal(rep.sha256, cust.sha256)
    assert.notEqual(rep.storage_path, cust.storage_path)
    assert.ok(String(rep.storage_path).includes('/representative/0-'))
    assert.ok(String(cust.storage_path).includes('/customization/0-'))
  })
})

// ── Verifying an object that is already there ─────────────────────────────────
//
// Real behavioural tests: the function is pure, so the whole rule is exercised
// with actual bytes rather than asserted against source text.

describe('verifyStoredImageBytes', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 9, 9, 9, 9, 9, 9, 9, 9])
  const itemId = deterministicItemId(SUBMISSION, 32)

  const pathFor = (bytes: Uint8Array, mime = 'image/png') =>
    buildImagePath({
      submissionId: SUBMISSION, itemId, role: 'representative', position: 0,
      mimeType: mime, sha256: sha256Hex(bytes),
    })

  const verify = (over: Partial<Parameters<typeof verifyStoredImageBytes>[0]> = {}) =>
    verifyStoredImageBytes({
      bytes: PNG,
      expectedSha256: sha256Hex(PNG),
      expectedMimeType: 'image/png',
      expectedLength: PNG.byteLength,
      storagePath: pathFor(PNG),
      sniff: sniffImageFormat,
      ...over,
    })

  test('the correct existing bytes are reused', () => {
    const result = verify()
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.sha256, sha256Hex(PNG))
  })

  test('SAME SIZE and SAME MIME but different bytes are rejected', () => {
    // The exact case metadata cannot catch: identical length, identical
    // declared type, different picture.
    const impostor = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9])
    assert.equal(impostor.byteLength, PNG.byteLength)

    const result = verify({ bytes: impostor })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'HASH_MISMATCH')
  })

  test('a path hash that disagrees with the bytes is rejected', () => {
    const other = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7])
    const result = verifyStoredImageBytes({
      bytes: PNG,
      expectedSha256: sha256Hex(PNG),
      expectedMimeType: 'image/png',
      storagePath: pathFor(other),
      sniff: sniffImageFormat,
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'PATH_HASH_MISMATCH')
  })

  test('MIME claiming PNG while the bytes are JPEG is rejected', () => {
    // The key and the expectation both say png; the magic bytes say jpeg.
    const result = verifyStoredImageBytes({
      bytes: JPEG,
      expectedSha256: sha256Hex(JPEG),
      expectedMimeType: 'image/png',
      storagePath: pathFor(JPEG, 'image/png'),
      sniff: sniffImageFormat,
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'FORMAT_MISMATCH')
  })

  test('an unrecognisable format is rejected rather than trusted', () => {
    const junk = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])
    const result = verifyStoredImageBytes({
      bytes: junk,
      expectedSha256: sha256Hex(junk),
      expectedMimeType: 'image/png',
      storagePath: pathFor(junk, 'image/png'),
      sniff: sniffImageFormat,
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'FORMAT_MISMATCH')
  })

  test('the extension in the key must agree with the sniffed type', () => {
    // Real JPEG bytes, honest hash — but stored under a .png key.
    const key = `submissions/${SUBMISSION}/images/${itemId}/representative/0-${sha256Hex(JPEG)}.png`
    const result = verifyStoredImageBytes({
      bytes: JPEG,
      expectedSha256: sha256Hex(JPEG),
      expectedMimeType: 'image/jpeg',
      storagePath: key,
      sniff: sniffImageFormat,
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'FORMAT_MISMATCH')
  })

  test('a length that differs from the parsed picture is refused before hashing', () => {
    const result = verify({ expectedLength: PNG.byteLength + 1 })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'SIZE_MISMATCH')
  })

  test('an oversized object is refused by the ceiling', () => {
    const result = verify({ maxBytes: 4 })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'TOO_LARGE')
  })

  test('the ceiling is the bucket’s own 10 MiB limit', () => {
    assert.equal(MAX_IMAGE_OBJECT_BYTES, 10 * 1024 * 1024)
  })

  test('a truncated object is caught even with a plausible type', () => {
    const truncated = PNG.slice(0, 8)
    const result = verify({ bytes: truncated })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'SIZE_MISMATCH')
  })

  test('hashFromImagePath reads the hash a key claims', () => {
    assert.equal(hashFromImagePath(pathFor(PNG)), sha256Hex(PNG))
    assert.equal(hashFromImagePath('submissions/x/images/y/representative/0.png'), null)
    assert.equal(hashFromImagePath('not-a-path'), null)
  })

  test('a jpeg verifies cleanly under its own type and key', () => {
    const result = verifyStoredImageBytes({
      bytes: JPEG,
      expectedSha256: sha256Hex(JPEG),
      expectedMimeType: 'image/jpeg',
      expectedLength: JPEG.byteLength,
      storagePath: pathFor(JPEG, 'image/jpeg'),
      sniff: sniffImageFormat,
    })
    assert.equal(result.ok, true)
  })
})

describe('the replay fingerprint', () => {
  test('is a sha256 over the whole payload', () => {
    const fingerprint = plan([product()]).payload.fingerprint
    assert.match(String(fingerprint), /^[0-9a-f]{64}$/)
  })

  test('is identical for an identical re-run — the retry case', () => {
    assert.equal(plan([product()]).payload.fingerprint, plan([product()]).payload.fingerprint)
  })

  test('changes when a figure changes', () => {
    const a = plan([product({ costPerPiece: 1000, lineTotal: 2000 })]).payload.fingerprint
    const b = plan([product({ costPerPiece: 1100, lineTotal: 2200 })]).payload.fingerprint
    assert.notEqual(a, b)
  })

  test('changes when a picture changes', () => {
    const a = plan([product({ representativeImage: image({ bytes: new Uint8Array([1]) }) })]).payload.fingerprint
    const b = plan([product({ representativeImage: image({ bytes: new Uint8Array([2]) }) })]).payload.fingerprint
    assert.notEqual(a, b)
  })

  test('changes when a different workbook is uploaded', () => {
    const other = { ...source, workbookSha256: 'f'.repeat(64) }
    const a = plan([product()]).payload.fingerprint
    const b = buildSubmissionPlan({
      submissionId: SUBMISSION, workbook: workbook([product()]),
      warnings: [], blockingIssues: [], source: other,
    }).payload.fingerprint
    assert.notEqual(a, b)
  })

  test('does not cover itself', () => {
    // Computed after the payload is complete and then attached, so it is not
    // part of its own input.
    const built = plan([product()])
    const { fingerprint, ...rest } = built.payload as Record<string, unknown>
    assert.ok(fingerprint)
    assert.ok(!JSON.stringify(rest).includes(String(fingerprint)))
  })
})

// ── Commercial meaning ────────────────────────────────────────────────────────

describe('persistedCost', () => {
  test('a figure is numeric, with no wording', () => {
    assert.deepEqual(persistedCost(amount(5200, 'I117')), { meaning: 'numeric', amount: 5200, text: null })
  })

  test('a dash or blank is not_applicable, at zero, with no wording', () => {
    assert.deepEqual(persistedCost(nilValue()), { meaning: 'not_applicable', amount: 0, text: null })
  })

  test('"Inclusive" is included, at zero, and KEEPS its wording', () => {
    assert.deepEqual(persistedCost(includedValue('I118', 'Inclusive')), {
      meaning: 'included', amount: 0, text: 'Inclusive',
    })
    assert.deepEqual(persistedCost(includedValue('I117', 'Included')), {
      meaning: 'included', amount: 0, text: 'Included',
    })
  })

  test('included is never stored as not_applicable', () => {
    const included = persistedCost(includedValue())
    const nil = persistedCost(nilValue())
    assert.equal(included.amount, nil.amount, 'both add zero')
    assert.notEqual(included.meaning, nil.meaning, 'and mean opposite things')
  })

  test('unexpected wording keeps the words and stores no amount', () => {
    assert.deepEqual(persistedCost(textValue('to be confirmed', 'I117')), {
      meaning: 'text', amount: null, text: 'to be confirmed',
    })
  })

  test('an unparsed cell is numeric with no amount, which the schema allows', () => {
    assert.deepEqual(persistedCost(emptyValue('I117')), { meaning: 'numeric', amount: null, text: null })
    assert.deepEqual(persistedCost(null), { meaning: 'numeric', amount: null, text: null })
  })

  test('every result satisfies the database consistency constraint', () => {
    const cases = [amount(10), nilValue(), includedValue(), textValue('tbc'), emptyValue(), null]
    for (const value of cases) {
      const { meaning, amount: n, text } = persistedCost(value)
      if (meaning === 'numeric')        assert.equal(text, null)
      if (meaning === 'not_applicable') { assert.equal(n, 0); assert.equal(text, null) }
      if (meaning === 'included')       { assert.equal(n, 0); assert.ok(text && text.trim() !== '') }
      if (meaning === 'text')           { assert.equal(n, null); assert.ok(text && text.trim() !== '') }
    }
  })
})

describe('the commercial payload', () => {
  test('carries both cost amounts, meanings and wordings', () => {
    const built = buildSubmissionPlan({
      submissionId: SUBMISSION,
      workbook: workbook([product()], {
        commercial: commercial({ fabricCost: amount(1500, 'I117'), packingCost: includedValue('I118') }),
      }),
      warnings: [], blockingIssues: [], source,
    })
    const c = built.payload.commercial as Record<string, unknown>

    assert.equal(c.fabric_cost, 1500)
    assert.equal(c.fabric_cost_meaning, 'numeric')
    assert.equal(c.fabric_cost_text, null)
    assert.equal(c.packing_cost, 0)
    assert.equal(c.packing_cost_meaning, 'included')
    assert.equal(c.packing_cost_text, 'Inclusive')
  })

  test('only the two cost cells get a meaning', () => {
    const c = commercialOf(plan([product()]))
    for (const key of Object.keys(c)) {
      if (key.endsWith('_meaning')) {
        assert.ok(['fabric_cost_meaning', 'packing_cost_meaning'].includes(key), key)
      }
    }
  })

  test('transportation keeps its amount/text pair', () => {
    const c = commercialOf(plan([product()]))
    assert.equal(c.transportation_amount, null)
    assert.equal(c.transportation_text, 'as applicable')
  })

  test('the discount is the position, not the workbook label', () => {
    const c = commercialOf(plan([product()]))
    assert.equal(c.discount_amount, 0)
    assert.ok(!('discount_label' in c), 'the label is not persisted as a figure')
  })
})

// ── Items ─────────────────────────────────────────────────────────────────────

describe('items', () => {
  test('carry the parser values unchanged, and keep material apart from customization', () => {
    const [item] = itemsOf(plan([product({ customization: 'Brass handles' })]))
    assert.equal(item.source_row, 32)
    assert.equal(item.item_sequence, 'B001')
    assert.equal(item.product_name, 'Item One')
    assert.equal(item.quantity, 2)
    assert.equal(item.cost_per_piece, 1000)
    assert.equal(item.total_amount, 2000)
    assert.equal(item.material, 'Invented Material')
    assert.equal(item.customization, 'Brass handles')
    assert.notEqual(item.material, item.customization)
  })

  test('the workbook’s own line total is never recomputed', () => {
    // Deliberately inconsistent: 2 × 1000 ≠ 4321. The stored figure is the
    // workbook's, exactly as the parser returned it.
    const [item] = itemsOf(plan([product({ lineTotal: 4321 })]))
    assert.equal(item.total_amount, 4321)
  })

  test('a line total the workbook never stored is derived, and only then', () => {
    const [item] = itemsOf(plan([product({ lineTotal: null, quantity: 3, costPerPiece: 250 })]))
    assert.equal(item.total_amount, 750, 'the column is NOT NULL; the warning travels with it')
  })

  test('sort order follows the workbook', () => {
    const items = itemsOf(plan([
      product({ row: 32, itemSequence: 'B001' }),
      product({ row: 40, itemSequence: 'B002' }),
      product({ row: 55, itemSequence: 'B003' }),
    ]))
    assert.deepEqual(items.map(i => i.sort_order), [0, 1, 2])
    assert.deepEqual(items.map(i => i.source_row), [32, 40, 55])
  })

  test('the legacy image columns are written from the representative image', () => {
    const built = plan([product()])
    const [item] = itemsOf(built)
    const representative = built.images.find(i => i.role === 'representative')!
    assert.equal(item.image_storage_path, representative.storagePath)
    assert.equal(item.image_mime_type, 'image/png')
    assert.equal(item.image_sha256, representative.sha256)
    assert.equal(item.image_anchor_row, 32)
  })

  test('a product without a representative image leaves the legacy columns null', () => {
    const [item] = itemsOf(plan([product({ representativeImage: null })]))
    assert.equal(item.image_storage_path, null)
    assert.equal(item.image_mime_type, null)
  })
})

// ── Images ────────────────────────────────────────────────────────────────────

describe('planned images', () => {
  test('a representative image is one row at position 0', () => {
    const built = plan([product()])
    assert.equal(built.counts.representativeImages, 1)
    assert.equal(built.counts.customizationImages, 0)
    const [img] = imagesOf(built)
    assert.equal(img.role, 'representative')
    assert.equal(img.position, 0)
  })

  test('customization images are numbered from zero, in workbook order', () => {
    const built = plan([product({
      customizationImages: [
        customization({ part: 'xl/media/c1.png' }),
        customization({ part: 'xl/media/c2.png' }),
        customization({ part: 'xl/media/c3.png' }),
      ],
    })])
    const custom = imagesOf(built).filter(i => i.role === 'customization')
    assert.deepEqual(custom.map(i => i.position), [0, 1, 2])
    assert.deepEqual(custom.map(i => i.source_media_path), [
      'xl/media/c1.png', 'xl/media/c2.png', 'xl/media/c3.png',
    ])
    assert.equal(built.counts.customizationImages, 3)
  })

  test('every image path names its own item and its own slot', () => {
    const built = plan([
      product({ row: 32, customizationImages: [customization()] }),
      product({ row: 33, itemSequence: 'B002', customizationImages: [] }),
    ])
    for (const img of imagesOf(built)) {
      const expected = `submissions/${SUBMISSION}/images/${img.item_id}/${img.role}/${img.position}-${img.sha256}.`
      assert.ok(String(img.storage_path).startsWith(expected), String(img.storage_path))
    }
  })

  test('two products never share an image path, even with identical bytes', () => {
    const shared = new Uint8Array([9, 9, 9])
    const built = plan([
      product({ row: 32, representativeImage: image({ bytes: shared, part: 'xl/media/shared.png' }) }),
      product({ row: 33, itemSequence: 'B002', representativeImage: image({ row: 33, bytes: shared, part: 'xl/media/shared.png' }) }),
    ])
    const paths = imagesOf(built).map(i => i.storage_path)
    assert.equal(new Set(paths).size, 2, 'one relationship, one object')
    // …and the same bytes hash the same, which is how a reader knows they match.
    const hashes = imagesOf(built).map(i => i.sha256)
    assert.equal(hashes[0], hashes[1])
  })

  test('one photograph used as both roles yields two rows and two paths', () => {
    const bytes = new Uint8Array([7, 7, 7])
    const built = plan([product({
      representativeImage: image({ bytes, part: 'xl/media/shared.png' }),
      customizationImages: [customization({ bytes, part: 'xl/media/shared.png' })],
    })])
    const images = imagesOf(built)
    assert.equal(images.length, 2)
    assert.notEqual(images[0].storage_path, images[1].storage_path)
    assert.equal(images[0].sha256, images[1].sha256)
    assert.deepEqual(images.map(i => i.role), ['representative', 'customization'])
  })

  test('an unsniffable image is skipped and counted, never stored under a guess', () => {
    const built = plan([product({
      representativeImage: image({ format: 'unknown', mimeType: null }),
      customizationImages: [customization({ format: 'unknown', mimeType: null }), customization()],
    })])
    assert.equal(built.counts.representativeImages, 0)
    assert.equal(built.counts.customizationImages, 1)
    assert.equal(built.counts.skippedImages, 2)
  })

  test('skipping never leaves a gap in the customization positions', () => {
    const built = plan([product({
      customizationImages: [
        customization({ part: 'a.png' }),
        customization({ part: 'b.bin', format: 'unknown', mimeType: null }),
        customization({ part: 'c.png' }),
      ],
    })])
    const custom = imagesOf(built).filter(i => i.role === 'customization')
    assert.deepEqual(custom.map(i => i.position), [0, 1], '"image 2 of 2", not "1 and 3"')
    assert.deepEqual(custom.map(i => i.source_media_path), ['a.png', 'c.png'])
  })

  test('the bytes are carried by reference for upload, and not into the payload', () => {
    const built = plan([product({ customizationImages: [customization()] })])
    // The uploader gets the buffer…
    assert.ok(built.images[0].bytes instanceof Uint8Array)
    // …and the database gets a hash and a path, never the image itself.
    for (const img of imagesOf(built)) {
      assert.ok(!('bytes' in img), 'no image bytes reach the RPC payload')
      assert.ok(!('data' in img))
      assert.deepEqual(Object.keys(img).sort(), [
        'anchor_row', 'item_id', 'mime_type', 'position', 'role', 'sha256',
        'source_media_path', 'storage_path',
      ])
    }
  })

  test('the anchor row travels, so any picture can be traced to its cell', () => {
    const built = plan([product({ row: 40, representativeImage: image({ row: 40 }) })])
    assert.equal(imagesOf(built)[0].anchor_row, 40)
  })
})

// ── The whole payload ─────────────────────────────────────────────────────────

describe('the RPC payload', () => {
  test('has exactly the sections the function reads', () => {
    const keys = Object.keys(plan([product()]).payload).sort()
    assert.deepEqual(keys, ['commercial', 'fingerprint', 'header', 'item_images', 'items', 'parse', 'source'])
  })

  test('the client name is the bill-to name', () => {
    const h = headerOf(plan([product()]))
    assert.equal(h.client_name, 'Sample Buyer Ltd')
    assert.equal(h.bill_to_name, 'Sample Buyer Ltd')
  })

  test('dates are ISO, and a worded commitment stays words with no due date', () => {
    const h = headerOf(plan([product()]))
    assert.equal(h.creation_date, '2026-08-16')
    assert.equal(h.order_confirmation_date, '2026-08-20')
    assert.equal(h.dispatch_commitment, '6 weeks from date of confirmation')
    // The prose is stored verbatim and yields NO due date. Nothing adds six
    // weeks to anything: a lead time is not a delivery date until somebody says
    // which day it lands on.
    assert.equal(h.due_date, null)
  })

  test('a real Excel date in the dispatch cell becomes the due date', () => {
    // What the parser hands over for a cell that held a date serial: `.iso` set,
    // and `.text` the same string. Both the date and the original text are kept.
    const built = buildSubmissionPlan({
      submissionId: SUBMISSION,
      workbook: workbook([product()], {
        header: header({
          dispatchCommitment: { iso: '2026-09-30', text: '2026-09-30', source: 'serial' },
        }),
      }),
      warnings: [], blockingIssues: [], source,
    })
    const h = built.payload.header as Record<string, unknown>
    assert.equal(h.due_date, '2026-09-30')
    assert.equal(h.dispatch_commitment, '2026-09-30', 'the source text is still stored')
  })

  test('an Excel duration in the dispatch cell never becomes a due date', () => {
    // 90 typed as a lead time is converted by excelSerialToIso to 1900-03-30 —
    // ISO-shaped, and refused. See src/lib/orders/dueDate.test.ts for the
    // mechanism and every boundary.
    for (const iso of ['1900-03-01', '1900-03-30', '1900-04-29', '1900-12-30']) {
      const built = buildSubmissionPlan({
        submissionId: SUBMISSION,
        workbook: workbook([product()], {
          header: header({ dispatchCommitment: { iso, text: iso, source: 'serial' } }),
        }),
        warnings: [], blockingIssues: [], source,
      })
      const h = built.payload.header as Record<string, unknown>
      assert.equal(h.due_date, null, `${iso} is a duration, not a due date`)
      assert.equal(h.dispatch_commitment, iso, 'and the stored text is left alone')
    }
  })

  test('a worded confirmation date is not forced into a date column', () => {
    const built = buildSubmissionPlan({
      submissionId: SUBMISSION,
      workbook: workbook([product()], {
        header: header({ orderConfirmationDate: { iso: null, text: 'on confirmation', source: 'text' } }),
      }),
      warnings: [], blockingIssues: [], source,
    })
    assert.equal((built.payload.header as Record<string, unknown>).order_confirmation_date, null)
  })

  test('the source order number is carried as provenance only', () => {
    const h = headerOf(plan([product()]))
    assert.equal(h.source_order_number, 'SRC-407')
    // Nothing in the payload presents it as an order number.
    assert.ok(!('order_number' in h))
    assert.ok(!('display_number' in h))
  })

  test('the workbook reference is the path, size and hash', () => {
    const s = plan([product()]).payload.source as Record<string, unknown>
    assert.equal(s.workbook_path, source.workbookPath)
    assert.equal(s.workbook_size_bytes, 1024)
    assert.equal(s.workbook_sha256, 'a'.repeat(64))
    assert.equal(s.workbook_name, null, 'the client-named filename is not persisted from the key')
  })

  test('warnings and blocking issues are passed through verbatim', () => {
    const built = buildSubmissionPlan({
      submissionId: SUBMISSION,
      workbook: workbook([product()]),
      warnings: [{ code: 'LINE_TOTAL_MISMATCH', message: 'x', row: 32 }],
      blockingIssues: [],
      source,
    })
    const parse = built.payload.parse as Record<string, unknown>
    assert.equal((parse.warnings as unknown[]).length, 1)
    assert.deepEqual(parse.blocking_issues, [])
  })

  test('counts describe what was planned', () => {
    const built = plan([
      product({ row: 32, customizationImages: [customization(), customization()] }),
      product({ row: 33, itemSequence: 'B002' }),
    ])
    assert.deepEqual(built.counts, {
      items: 2, representativeImages: 2, customizationImages: 2, skippedImages: 0,
    })
  })

  test('an empty workbook plans nothing rather than failing', () => {
    const built = plan([])
    assert.deepEqual(itemsOf(built), [])
    assert.deepEqual(imagesOf(built), [])
    assert.equal(built.counts.items, 0)
  })
})

// ── One accepted set, shared with the parser ──────────────────────────────────

describe('storable image formats', () => {
  test('exactly PNG, JPEG and WebP are storable', () => {
    assert.equal(storableImageMime('image/png'), 'image/png')
    assert.equal(storableImageMime('image/jpeg'), 'image/jpeg')
    assert.equal(storableImageMime('image/webp'), 'image/webp')
  })

  test('GIF, BMP and TIFF are refused rather than guessed at', () => {
    for (const mime of ['image/gif', 'image/bmp', 'image/tiff', 'image/svg+xml', null]) {
      assert.equal(storableImageMime(mime), null, String(mime))
    }
  })

  test('the payload builder reads the SAME rule as the parser', () => {
    // One source of truth: src/lib/pi/imageFormats.ts. Two copies disagreeing is
    // how a GIF product photograph once reached this module already accepted.
    assert.equal(storableImageMime, storableImageMimeRule)
  })

  test('an unstorable image is counted, never silently dropped', () => {
    // Unreachable in practice — the parser blocks or warns first — but the
    // counter is what lets the route refuse rather than save a partial draft.
    const built = plan([product({
      representativeImage: image({ format: 'gif', mimeType: 'image/gif' }),
    })])
    assert.equal(built.counts.skippedImages, 1)
    assert.equal(built.counts.representativeImages, 0)
  })
})
