/**
 * Row-to-image mapping, reverified across the two reference PI shapes.
 *
 * WHAT THIS IS FOR. The preview claims "7 of 7 images matched" and lets a
 * reviewer open each picture full size. That claim spans two modules —
 * harvestProductImages decides which picture belongs to which row, and
 * createPiImageUrls turns those rows into openable URLs — and the seam between
 * them is where a product could quietly acquire its neighbour's photograph.
 * Neither module's own tests cover the join, so these do.
 *
 * WHAT IT IS NOT. Not a re-run of Phase 1. The anchor grammar, the column and
 * row band rules, the unsafe-path and unreadable-target handling and the
 * byte-sharing guarantee are all asserted in masterSheetParser.test.ts and
 * workbookReader.test.ts; those 161 tests still run. What is added here is the
 * end-to-end shape: N products in, N correctly attributed URLs out, and nothing
 * of the previous PI surviving a replacement.
 *
 * SAMPLE A and SAMPLE B are shapes, not files: a 7-product order and a
 * 12-product one, built from invented bytes. No client, description, price,
 * filename or real image appears here or in any fixture.
 *
 * Offline and pure. No archive is written, no network is touched.
 *
 * Run:
 *   npx tsx --test src/lib/pi/sampleImageMapping.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { harvestProductImages } from './drawingAnchors'
import {
  createPiImageUrls,
  describeImageCoverage,
  describeCustomizationImageCount,
  buildImageViewerItems,
  type PiObjectUrlFactory,
} from './previewView'
import type { ArchiveEntries } from '../xlsxMediaOptimizer'
import type { PiProductImage } from './types'

const enc = new TextEncoder()
const bytesOf = (s: string) => enc.encode(s)

/** Column E, 0-based — where a BOE PI anchors the representative picture. */
const IMAGE_COL = 4
/** Column K — customization pictures, and the customization text. */
const CUSTOMIZATION_COL = 10
const FIRST_ROW = 32
const LAST_ROW = 111

/**
 * The URL bag, from a flat representative list plus an optional customization
 * list. Most cases below are about representative mapping, so the second list
 * defaults to empty.
 */
const urlsFor = (
  representativeImages: readonly PiProductImage[],
  factory: PiObjectUrlFactory,
  customizationImages: readonly PiProductImage[] = [],
) => createPiImageUrls({ representativeImages, customizationImages }, factory)

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Deterministic bytes with a real PNG signature, so sniffing has something
 *  honest to read. Invented, and different per seed. */
function fakePng(seed: number): Uint8Array {
  const b = new Uint8Array(48)
  b.set(PNG_SIG, 0)
  let x = (seed + 1) >>> 0
  for (let i = PNG_SIG.length; i < b.length; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    b[i] = x & 0xff
  }
  return b
}

type AnchorSpec = {
  kind: 'one' | 'two'
  /** 0-based column. */
  col: number
  /** 1-based worksheet row. */
  row: number
  /** Media leaf name under xl/media/. */
  media: string
}

/**
 * The three archive parts the harvest walks, and nothing else: a drawing, its
 * relationships, and the media. Built by hand so each case states exactly the
 * anchors it is about.
 */
function buildDrawing(anchors: readonly AnchorSpec[]): ArchiveEntries {
  const mediaNames = [...new Set(anchors.map(a => a.media))]
  const relIdOf = (media: string) => `rId${mediaNames.indexOf(media) + 1}`

  const anchorXml = anchors.map((a, i) => {
    const tag = a.kind === 'one' ? 'xdr:oneCellAnchor' : 'xdr:twoCellAnchor'
    // The drawing stores 0-based rows; the harvest reports 1-based.
    const from = `<xdr:from><xdr:col>${a.col}</xdr:col><xdr:colOff>0</xdr:colOff>`
      + `<xdr:row>${a.row - 1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>`
    const to = a.kind === 'two'
      ? `<xdr:to><xdr:col>${a.col + 1}</xdr:col><xdr:colOff>0</xdr:colOff>`
        + `<xdr:row>${a.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>`
      : `<xdr:ext cx="900000" cy="900000"/>`
    return `<${tag}>${from}${to}`
      + `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${i + 1}" name="Picture ${i + 1}"/></xdr:nvPicPr>`
      + `<xdr:blipFill><a:blip r:embed="${relIdOf(a.media)}"/></xdr:blipFill></xdr:pic>`
      + `</${tag}>`
  }).join('')

  const entries: ArchiveEntries = {
    'xl/drawings/drawing1.xml':
      bytesOf(`<?xml version="1.0"?><xdr:wsDr xmlns:xdr="x" xmlns:a="y" xmlns:r="z">${anchorXml}</xdr:wsDr>`),
    'xl/drawings/_rels/drawing1.xml.rels':
      bytesOf(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
        + mediaNames.map((m, i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${m}"/>`)
          .join('')
        + `</Relationships>`),
  }
  mediaNames.forEach((m, i) => { entries[`xl/media/${m}`] = fakePng(i) })
  return entries
}

/**
 * The harvest, flattened the way masterSheetParser flattens it.
 *
 * REPRESENTATIVE: a row keeps its picture only when EXACTLY one is anchored
 * there; two is an ambiguity the parser blocks on, and this mirrors that rather
 * than silently picking one.
 *
 * CUSTOMIZATION: every picture is kept, however many a row carries. There is no
 * ambiguity rule here because nothing has to be chosen between them.
 */
function mapRows(anchors: readonly AnchorSpec[]): {
  images: PiProductImage[]
  customizationImages: PiProductImage[]
  ambiguousRows: number[]
} {
  const harvest = harvestProductImages({
    entries: buildDrawing(anchors),
    drawingPart: 'xl/drawings/drawing1.xml',
    representativeColumn: IMAGE_COL,
    customizationColumn: CUSTOMIZATION_COL,
    firstRow: FIRST_ROW,
    lastRow: LAST_ROW,
  })

  const images: PiProductImage[] = []
  const ambiguousRows: number[] = []
  for (const [row, found] of harvest.representativeByRow) {
    if (found.length === 1) images.push(found[0])
    else ambiguousRows.push(row)
  }
  images.sort((a, b) => a.row - b.row)

  const customizationImages: PiProductImage[] = []
  for (const found of harvest.customizationByRow.values()) customizationImages.push(...found)
  customizationImages.sort((a, b) => a.row - b.row)

  return { images, customizationImages, ambiguousRows }
}

function fakeUrlFactory() {
  const created: string[] = []
  const revoked: string[] = []
  const factory: PiObjectUrlFactory = {
    create: () => { const url = `blob:sample/${created.length}`; created.push(url); return url },
    revoke: url => { revoked.push(url) },
  }
  return { factory, created, revoked }
}

const productsFor = (count: number) =>
  Array.from({ length: count }, (_v, i) => ({
    row: FIRST_ROW + i,
    itemSequence: `B${String(i + 1).padStart(3, '0')}`,
    productName: `Item ${i + 1}`,
  }))

/** Sample A: 7 products, each with its own picture, both anchor kinds present. */
const SAMPLE_A: AnchorSpec[] = productsFor(7).map((p, i) => ({
  kind: i % 2 === 0 ? 'two' : 'one',
  col: IMAGE_COL,
  row: p.row,
  media: `image${i + 1}.png`,
}))

/** Sample B: 12 products, both anchor kinds, and one photograph shared by three
 *  consecutive lines — the "set of chairs" case a real PI carries. */
const SAMPLE_B: AnchorSpec[] = productsFor(12).map((p, i) => ({
  kind: i % 3 === 0 ? 'one' : 'two',
  col: IMAGE_COL,
  row: p.row,
  media: i >= 4 && i <= 6 ? 'shared.png' : `image${i + 1}.png`,
}))

/**
 * Sample C: the customization shape — 12 products, 12 representative images and
 * 4 customization images, with column K using BOTH anchor kinds.
 *
 * The four are deliberately uneven: two on one product, one each on two others,
 * and nine products with none. That is what a real PI looks like, and it is the
 * arrangement most likely to expose an off-by-one that shifts a picture onto the
 * neighbouring line.
 */
const SAMPLE_C_CUSTOMIZATION: AnchorSpec[] = [
  { kind: 'two', col: CUSTOMIZATION_COL, row: FIRST_ROW + 1, media: 'cust1.png' },
  { kind: 'one', col: CUSTOMIZATION_COL, row: FIRST_ROW + 1, media: 'cust2.png' },
  { kind: 'two', col: CUSTOMIZATION_COL, row: FIRST_ROW + 5, media: 'cust3.png' },
  { kind: 'one', col: CUSTOMIZATION_COL, row: FIRST_ROW + 9, media: 'cust4.png' },
]

const SAMPLE_C: AnchorSpec[] = [
  ...productsFor(12).map((p, i) => ({
    kind: (i % 2 === 0 ? 'two' : 'one') as 'one' | 'two',
    col: IMAGE_COL,
    row: p.row,
    media: `image${i + 1}.png`,
  })),
  ...SAMPLE_C_CUSTOMIZATION,
]

// ── Mapping ───────────────────────────────────────────────────────────────────

describe('Sample A — 7 products', () => {
  test('every product row keeps its own picture', () => {
    const { images, ambiguousRows } = mapRows(SAMPLE_A)
    assert.equal(ambiguousRows.length, 0)
    assert.deepEqual(images.map(i => i.row), productsFor(7).map(p => p.row))
    // Each row resolved to a DIFFERENT media part, in order.
    assert.deepEqual(
      images.map(i => i.part),
      Array.from({ length: 7 }, (_v, i) => `xl/media/image${i + 1}.png`),
    )
  })

  test('both anchor kinds survive the mapping', () => {
    const kinds = new Set(mapRows(SAMPLE_A).images.map(i => i.anchorKind))
    assert.deepEqual([...kinds].sort(), ['oneCellAnchor', 'twoCellAnchor'])
  })

  test('7 of 7 images matched, and 7 are openable', () => {
    const { factory } = fakeUrlFactory()
    const bag = urlsFor(mapRows(SAMPLE_A).images, factory)

    assert.equal(describeImageCoverage(productsFor(7), bag.representativeByRow).label, '7 of 7 representative images matched')
    assert.equal(buildImageViewerItems(productsFor(7), bag).length, 7)
  })

  test('each product opens ITS OWN picture, not a neighbour’s', () => {
    const { factory } = fakeUrlFactory()
    const images = mapRows(SAMPLE_A).images
    const bag = urlsFor(images, factory)
    const items = buildImageViewerItems(productsFor(7), bag)

    // Distinct media → distinct URLs, one per product, none repeated.
    assert.equal(new Set(items.map(i => i.url)).size, 7)
    for (const item of items) {
      assert.equal(item.url, bag.representativeByRow.get(item.row))
    }
  })
})

describe('Sample B — 12 products', () => {
  test('every product row keeps its own picture, including the shared ones', () => {
    const { images, ambiguousRows } = mapRows(SAMPLE_B)
    assert.equal(ambiguousRows.length, 0)
    assert.deepEqual(images.map(i => i.row), productsFor(12).map(p => p.row))

    const shared = images.filter(i => i.part === 'xl/media/shared.png')
    assert.equal(shared.length, 3, 'three products reference the one photograph')
  })

  test('reused bytes are shared by reference, never copied', () => {
    const shared = mapRows(SAMPLE_B).images.filter(i => i.part === 'xl/media/shared.png')
    assert.equal(shared[0].bytes, shared[1].bytes)
    assert.equal(shared[1].bytes, shared[2].bytes)
  })

  test('12 of 12 images matched, from 10 distinct media parts', () => {
    const { factory, created } = fakeUrlFactory()
    const images = mapRows(SAMPLE_B).images
    const bag = urlsFor(images, factory)

    assert.equal(created.length, 10, 'one blob per distinct media part')
    assert.equal(describeImageCoverage(productsFor(12), bag.representativeByRow).label, '12 of 12 representative images matched')
    assert.equal(describeImageCoverage(productsFor(12), bag.representativeByRow).complete, true)
  })

  test('the three products sharing a picture are each independently openable', () => {
    const { factory } = fakeUrlFactory()
    const bag = urlsFor(mapRows(SAMPLE_B).images, factory)
    const items = buildImageViewerItems(productsFor(12), bag)

    const sharing = items.filter(i => i.row >= FIRST_ROW + 4 && i.row <= FIRST_ROW + 6)
    assert.equal(sharing.length, 3)
    assert.equal(new Set(sharing.map(i => i.url)).size, 1, 'one blob')
    assert.equal(new Set(sharing.map(i => i.row)).size, 3, 'three products')
    assert.deepEqual(sharing.map(i => i.sequence), ['B005', 'B006', 'B007'])
  })
})

describe('Sample C — 12 products with customization images', () => {
  test('12 representative and 4 customization images, kept apart', () => {
    const { images, customizationImages, ambiguousRows } = mapRows(SAMPLE_C)

    assert.equal(ambiguousRows.length, 0, 'column-K pictures never make a row ambiguous')
    assert.equal(images.length, 12)
    assert.equal(customizationImages.length, 4)
    assert.ok(images.every(i => i.role === 'representative'))
    assert.ok(customizationImages.every(i => i.role === 'customization'))
  })

  test('both anchor kinds are supported in column K', () => {
    const kinds = new Set(mapRows(SAMPLE_C).customizationImages.map(i => i.anchorKind))
    assert.deepEqual([...kinds].sort(), ['oneCellAnchor', 'twoCellAnchor'])
  })

  test('each customization image stays on its own product row', () => {
    const { customizationImages } = mapRows(SAMPLE_C)
    assert.deepEqual(customizationImages.map(i => i.row), [
      FIRST_ROW + 1, FIRST_ROW + 1, FIRST_ROW + 5, FIRST_ROW + 9,
    ])
  })

  test('the two counts are separate and shaped differently', () => {
    const { factory } = fakeUrlFactory()
    const { images, customizationImages } = mapRows(SAMPLE_C)
    const bag = urlsFor(images, factory, customizationImages)

    assert.equal(
      describeImageCoverage(productsFor(12), bag.representativeByRow).label,
      '12 of 12 representative images matched',
    )
    // A plain total, with no "of": customization images are optional.
    assert.equal(describeCustomizationImageCount(customizationImages).label, '4 customization images')
  })

  test('the viewer sequence interleaves roles in table order', () => {
    const { factory } = fakeUrlFactory()
    const { images, customizationImages } = mapRows(SAMPLE_C)
    const bag = urlsFor(images, factory, customizationImages)
    const items = buildImageViewerItems(productsFor(12), bag)

    assert.equal(items.length, 16, '12 representative + 4 customization')

    // The second product owns three pictures: its own, then two changes.
    const second = items.filter(i => i.row === FIRST_ROW + 1)
    assert.deepEqual(second.map(i => i.roleLabel), [
      'Representative image',
      'Customization image 1 of 2',
      'Customization image 2 of 2',
    ])

    // A product with exactly one change is not numbered "1 of 1".
    const sixth = items.filter(i => i.row === FIRST_ROW + 5)
    assert.deepEqual(sixth.map(i => i.roleLabel), ['Representative image', 'Customization image'])
  })

  test('a product with no customization contributes one item, not a placeholder', () => {
    const { factory } = fakeUrlFactory()
    const { images, customizationImages } = mapRows(SAMPLE_C)
    const bag = urlsFor(images, factory, customizationImages)
    const items = buildImageViewerItems(productsFor(12), bag)

    const first = items.filter(i => i.row === FIRST_ROW)
    assert.deepEqual(first.map(i => i.role), ['representative'])
  })

  test('replacing Sample C releases every URL of both roles', () => {
    const { factory, created, revoked } = fakeUrlFactory()
    const { images, customizationImages } = mapRows(SAMPLE_C)
    const bag = urlsFor(images, factory, customizationImages)

    assert.equal(created.length, 16, 'sixteen distinct media parts')
    bag.revokeAll()
    assert.deepEqual(revoked.slice().sort(), created.slice().sort())

    // And nothing of Sample C survives into the next PI.
    const next = urlsFor(mapRows(SAMPLE_A).images, factory)
    for (const url of next.representativeByRow.values()) {
      assert.ok(!revoked.includes(url), 'a revoked URL must not be shown again')
    }
    assert.equal(next.customizationByRow.size, 0, 'Sample A has no customization images')
  })

  test('a media part used by both roles yields ONE url and two placements', () => {
    const { factory, created } = fakeUrlFactory()
    const shared: AnchorSpec[] = [
      { kind: 'two', col: IMAGE_COL, row: FIRST_ROW, media: 'shared.png' },
      { kind: 'one', col: CUSTOMIZATION_COL, row: FIRST_ROW, media: 'shared.png' },
    ]
    const { images, customizationImages } = mapRows(shared)
    const bag = urlsFor(images, factory, customizationImages)

    assert.equal(created.length, 1, 'one blob for one media part')
    assert.equal(bag.representativeByRow.get(FIRST_ROW), bag.customizationByRow.get(FIRST_ROW)?.[0])

    const items = buildImageViewerItems(productsFor(1), bag)
    assert.deepEqual(items.map(i => i.role), ['representative', 'customization'])
    assert.equal(items[0].url, items[1].url, 'same bytes')
    assert.notEqual(items[0].roleLabel, items[1].roleLabel, 'different meaning, always stated')
  })
})

// ── What must NOT be mapped ───────────────────────────────────────────────────

describe('decoration is not product data', () => {
  test('a logo above the product band is not counted', () => {
    const withLogo: AnchorSpec[] = [
      { kind: 'two', col: 1, row: 1, media: 'logo.png' },
      { kind: 'one', col: IMAGE_COL, row: 7, media: 'signature.png' },
      ...SAMPLE_A,
    ]
    const { images } = mapRows(withLogo)
    assert.equal(images.length, 7, 'the logo and the signature block stay out')
    assert.ok(!images.some(i => i.part.includes('logo')))
    assert.ok(!images.some(i => i.part.includes('signature')))
  })

  test('footer artwork below the product band is not counted', () => {
    const withFooter: AnchorSpec[] = [
      ...SAMPLE_A,
      { kind: 'two', col: IMAGE_COL, row: LAST_ROW + 13, media: 'footer.png' },
    ]
    assert.equal(mapRows(withFooter).images.length, 7)
  })

  test('a picture in another column is not the representative image', () => {
    const wrongColumn: AnchorSpec[] = [
      ...SAMPLE_A,
      { kind: 'two', col: IMAGE_COL + 3, row: FIRST_ROW, media: 'stray.png' },
    ]
    const { images, ambiguousRows } = mapRows(wrongColumn)
    assert.equal(ambiguousRows.length, 0, 'a picture outside column E cannot make a row ambiguous')
    assert.equal(images.length, 7)
  })

  test('two pictures on one row stay ambiguous — nothing is chosen silently', () => {
    const doubled: AnchorSpec[] = [
      ...SAMPLE_A,
      { kind: 'one', col: IMAGE_COL, row: FIRST_ROW, media: 'second.png' },
    ]
    const { images, ambiguousRows } = mapRows(doubled)
    assert.deepEqual(ambiguousRows, [FIRST_ROW])
    assert.equal(images.length, 6, 'the ambiguous row contributes no picture')
    assert.ok(!images.some(i => i.row === FIRST_ROW))
  })

  test('an ambiguous row is reported as unmatched, not quietly filled', () => {
    const doubled: AnchorSpec[] = [
      ...SAMPLE_A,
      { kind: 'one', col: IMAGE_COL, row: FIRST_ROW, media: 'second.png' },
    ]
    const { factory } = fakeUrlFactory()
    const bag = urlsFor(mapRows(doubled).images, factory)
    const coverage = describeImageCoverage(productsFor(7), bag.representativeByRow)

    assert.equal(coverage.label, '6 of 7 representative images matched')
    assert.equal(coverage.complete, false)
  })
})

// ── Replacement ───────────────────────────────────────────────────────────────

describe('changing the PI clears the previous mapping', () => {
  test('Sample A → Sample B: no Sample A URL survives', () => {
    const { factory, created, revoked } = fakeUrlFactory()

    const bagA = urlsFor(mapRows(SAMPLE_A).images, factory)
    const urlsA = [...bagA.urls]
    bagA.revokeAll()

    const bagB = urlsFor(mapRows(SAMPLE_B).images, factory)

    assert.deepEqual(revoked.slice().sort(), urlsA.slice().sort(), 'every Sample A URL is released')
    for (const url of bagB.representativeByRow.values()) {
      assert.ok(!urlsA.includes(url), 'no revoked URL is shown again')
    }
    assert.equal(created.length, urlsA.length + bagB.urls.length)
    assert.equal(describeImageCoverage(productsFor(12), bagB.representativeByRow).label, '12 of 12 representative images matched')
  })

  test('Sample B → Sample A: rows that no longer exist map to nothing', () => {
    const { factory } = fakeUrlFactory()

    const bagB = urlsFor(mapRows(SAMPLE_B).images, factory)
    assert.equal(bagB.representativeByRow.has(FIRST_ROW + 11), true)
    bagB.revokeAll()

    const bagA = urlsFor(mapRows(SAMPLE_A).images, factory)

    for (let i = 7; i < 12; i++) {
      assert.equal(bagA.representativeByRow.has(FIRST_ROW + i), false,
        `row ${FIRST_ROW + i} belonged to Sample B and must not survive`)
    }
    assert.equal(describeImageCoverage(productsFor(7), bagA.representativeByRow).label, '7 of 7 representative images matched')
    assert.equal(buildImageViewerItems(productsFor(7), bagA).length, 7)
  })

  test('a replacement releases exactly the old URLs, once each', () => {
    const { factory, revoked } = fakeUrlFactory()
    const bagB = urlsFor(mapRows(SAMPLE_B).images, factory)

    bagB.revokeAll()
    bagB.revokeAll()

    assert.equal(revoked.length, 10, 'ten distinct media parts, released once each')
    assert.equal(new Set(revoked).size, 10)
  })
})
