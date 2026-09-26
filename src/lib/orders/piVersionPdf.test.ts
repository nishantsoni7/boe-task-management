/**
 * ONE PI VERSION'S PDF, FROM ITS OWN CONTENT (20270116000000) — the pure half.
 *
 * Offline. The route (src/app/api/orders/[id]/pi-versions/[versionId]/pdf)
 * reads and renders; this proves WHAT it renders for each kind of version.
 *
 * Run:
 *   npx tsx --test src/lib/orders/piVersionPdf.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  PI_VERSION_PDF_VIEW_LABEL,
  VERSION_CONTENT_NOT_RECORDED,
  piVersionPdfFilename,
  piVersionPdfHref,
  piVersionPdfSource,
} from './piVersionPdf'

const SUB = '11111111-1111-4111-8111-111111111111'
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
// A canonical key (src/lib/orders/piImageKey.ts): the whole shape, hash included.
const pic = (id: string) => `submissions/${SUB}/images/${id}/representative/0-${'a'.repeat(64)}.png`

describe('a REPLACED version prints what was in force, with its own codes', () => {
  const detail = {
    source: 'captured',
    content: {
      submission: { client_name: 'Meridian', grand_total: 60000, source_workbook_name: 'PI.xlsx' },
      items: [
        { id: B, source_row: 33, item_sequence: 'B002', product_name: 'Stool', quantity: 2, cost_per_piece: 10000, total_amount: 20000, sort_order: 1 },
        { id: A, source_row: 32, item_sequence: 'B001', product_name: 'Chair', quantity: 2, cost_per_piece: 10000, total_amount: 20000, sort_order: 0 },
      ],
      images: [
        { item_id: A, role: 'representative', storage_path: pic(A) },
        { item_id: B, role: 'representative', storage_path: 'submissions/someone-else/images/x.png' },
        // A key that STARTS with this PI's folder and climbs out of it (review H1).
        { item_id: C, role: 'representative', storage_path: `submissions/${SUB}/images/../../../finance-proofs/other-client.png` },
      ],
      codes: { [A]: 1, [B]: 2 },
    },
  }
  const src = piVersionPdfSource({ detail, submissionId: SUB, orderDisplayNumber: '0524', liveCodes: new Map() })

  test('its lines, in their own order', () => {
    assert.ok(src.ok)
    if (!src.ok) return
    assert.deepEqual(src.items.map(i => i.product_name), ['Chair', 'Stool'])
    assert.equal(src.submission.client_name, 'Meridian')
  })
  test('the codes it held then — the removed stool keeps BE002 on V1\'s PDF', () => {
    if (!src.ok) return
    assert.equal(src.productCodes.get(A), '524-BE001')
    assert.equal(src.productCodes.get(B), '524-BE002')
  })
  test('only pictures inside this PI\'s own folder are read', () => {
    if (!src.ok) return
    assert.equal(src.pictureByItem.get(A), pic(A))
    assert.equal(src.pictureByItem.has(B), false)
    assert.equal(src.pictureByItem.has(C), false, 'a traversal key is never read')
  })
})

describe('an EDITED version never borrows V1\'s workbook', () => {
  test('its details come from its proposal, and no workbook is named', () => {
    const src = piVersionPdfSource({
      detail: {
        source: 'proposal',
        content: {
          payload: {
            header: { client_name: 'Meridian' },
            commercial: { grand_total: 59000 },
            items: [{ id: C, source_row: 34, item_sequence: 'B004', product_name: 'Bench', quantity: 1, cost_per_piece: 15000, total_amount: 15000, sort_order: 0 }],
            item_images: [{ item_id: C, role: 'representative', storage_path: pic(C) }],
            source: { workbook_path: `submissions/${SUB}/original/v1.xlsx`, workbook_name: 'V1.xlsx' },
          },
          terms: { fabric_responsibility: 'boe' },
        },
      },
      submissionId: SUB, orderDisplayNumber: '0524', liveCodes: new Map([[C, '524-BE004']]),
    })
    assert.ok(src.ok)
    if (!src.ok) return
    assert.equal(src.submission.source_workbook_name, null)
    assert.equal(src.submission.source_workbook_path, null)
    assert.equal(src.submission.fabric_responsibility, 'boe')
    assert.equal(src.productCodes.get(C), '524-BE004')
    assert.equal(src.pictureByItem.get(C), pic(C))
  })
})

describe('a version replaced before content was recorded is refused, in words', () => {
  for (const source of ['snapshot', 'none']) {
    test(source, () => {
      const src = piVersionPdfSource({ detail: { source, content: { items: [] } }, submissionId: SUB, orderDisplayNumber: '0524', liveCodes: new Map() })
      assert.equal(src.ok, false)
      if (src.ok) return
      assert.equal(src.message, VERSION_CONTENT_NOT_RECORDED)
    })
  }
})

describe('the actions and the file', () => {
  test('labels say what they open', () => {
    assert.equal(PI_VERSION_PDF_VIEW_LABEL(2), 'View PI V2 (PDF)')
  })
  test('the route, and a filename a person recognises', () => {
    assert.equal(piVersionPdfHref('o', 'v', false), '/api/orders/o/pi-versions/v/pdf')
    assert.equal(piVersionPdfHref('o', 'v', true), '/api/orders/o/pi-versions/v/pdf?download=1')
    assert.equal(piVersionPdfFilename('524', 2), 'Order-524-PI-V2.pdf')
    assert.equal(piVersionPdfFilename('5"2;4', 1), 'Order-524-PI-V1.pdf', 'nothing can break out of the header')
  })
})

describe('the route asks as the reader, and renders from rows', () => {
  const route = readFileSync('src/app/api/orders/[id]/pi-versions/[versionId]/pdf/route.ts', 'utf8')
  test('the Order and the version are read as the caller before the service role reads anything', () => {
    const asCaller = route.indexOf("authClient.rpc('order_pi_version_detail'")
    const orderRead = route.search(/authClient\s*\.from\('orders'\)/)
    assert.ok(asCaller > 0 && orderRead > 0 && orderRead < asCaller)
    assert.ok(route.indexOf('adminClient()') > asCaller)
  })
  test('the version must belong to the Order in the URL', () => {
    assert.ok(route.includes('version.order_id !== orderId'))
  })
  test('the PDF comes from the Confirmed PDF model, never from the workbook', () => {
    assert.ok(route.includes('buildConfirmedPdfModel(') && route.includes('renderConfirmedPdf('))
    assert.equal(/loadApprovedWorkbook|buildConfirmedWorkbook|source_workbook_path/.test(route), false)
  })
})

describe('a product code is never clipped (found in the walkthrough)', () => {
  test('a row without a photo is tall enough for a two-line code', async () => {
    const { measureRowHeight } = await import('./confirmedPdf')
    const row = { code: '5-BE004', hasImage: false, name: 'Bar stool', dimensions: '', material: '', customization: '' }
    const oneLine = measureRowHeight({ ...row, code: 'B001' } as never, 9)
    assert.ok(measureRowHeight(row as never, 9) > oneLine, '"5-BE004" wraps to two lines, and the row makes room')
  })
})
