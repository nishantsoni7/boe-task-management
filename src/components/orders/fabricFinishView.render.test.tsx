/**
 * The Fabric & finish cost page's content, rendered.
 *
 * Offline. Drawing only: the sheets are handed in as the route returns them.
 *
 * Run:
 *   npx tsx --test src/components/orders/fabricFinishView.render.test.tsx
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  FF_EMPTY,
  FF_NO_COST_SHEET,
  FF_NO_FINISH_SHEET,
  FabricFinishView,
  formatMetres,
  type FabricFinishPiFacts,
} from './FabricFinishView'
import type { FabricFinishSheets } from '@/lib/pi/fabricFinishSheets'

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, '’').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

const sheets: FabricFinishSheets = {
  costSheet: { present: true },
  finishSheet: { present: true, approvalColumns: ['Fabric Approval', 'Wood Finish Approval', 'Metal Finish', 'Marble/Rope Approval'] },
  lines: [
    {
      masterRow: 32, sheetRow: 2, code: '539-B001', name: 'Sofa, 3-seater', quantity: 12, material: 'Oak frame, upholstery',
      fabric: { perPiece: 12.5, total: 150, pricePerMetre: 800, amount: 120000 },
      packing: { perPiece: 1500, total: 18000, type: 'BCF' },
      approvals: [
        { column: 'Fabric Approval', value: 'PENDING' }, { column: 'Wood Finish Approval', value: 'PENDING' },
        { column: 'Metal Finish', value: 'NA' }, { column: 'Marble/Rope Approval', value: null },
      ],
    },
    {
      masterRow: 33, sheetRow: 3, code: '539-B002', name: 'Lounge chair', quantity: 20, material: 'Oak, brass',
      fabric: { perPiece: 6, total: 120, pricePerMetre: 800, amount: 96000 },
      packing: { perPiece: 950, total: 19000, type: 'BCF' },
      approvals: [
        { column: 'Fabric Approval', value: 'PENDING' }, { column: 'Wood Finish Approval', value: 'Approved 12 Oct' },
        { column: 'Metal Finish', value: 'Complete brass finish on base' }, { column: 'Marble/Rope Approval', value: 'NA' },
      ],
    },
    {
      masterRow: 34, sheetRow: 4, code: '539-B003', name: 'Dining table', quantity: 2, material: 'Oak, terrazzo',
      fabric: { perPiece: 0, total: 0, pricePerMetre: null, amount: 0 },
      packing: { perPiece: 1250, total: 2500, type: 'Carton & crate' },
      approvals: [
        { column: 'Fabric Approval', value: 'NA' }, { column: 'Wood Finish Approval', value: 'PENDING' },
        { column: 'Metal Finish', value: 'PENDING' }, { column: 'Marble/Rope Approval', value: 'PENDING' },
      ],
    },
  ],
  totals: { totalFabricMetres: 270, fabricAmount: 216000, packingTotal: 39500, linesWithFabric: 2, linesWithPacking: 3 },
}

const facts = (over: Partial<FabricFinishPiFacts> = {}): FabricFinishPiFacts => ({
  fabricCost: 216000, fabricCostText: null, packingCost: 39500, packingCostText: null,
  piQuantityByRow: new Map([[32, 12], [33, 20], [34, 2]]),
  ...over,
})

const render = (over: Partial<FabricFinishPiFacts> = {}, s: FabricFinishSheets = sheets) =>
  renderToStaticMarkup(<FabricFinishView sheets={s} pi={facts(over)} />)

describe('the tiles and the reconciliation', () => {
  test('total fabric, fabric amount, packing cost and pending approvals, from the sheets', () => {
    const t = text(render())
    assert.ok(t.includes('Total fabric') && t.includes('270 m') && t.includes('2 of 3 lines use fabric'))
    assert.ok(t.includes('Fabric amount') && t.includes('₹2,16,000'))
    assert.ok(t.includes('Packing cost') && t.includes('₹39,500'))
    assert.ok(t.includes('Approvals pending') && t.includes('3 of 3 lines'))
  })

  test('both figures match the PI, and say so', () => {
    const t = text(render())
    assert.ok(t.includes('Fabric amount matches the PI’s Commercial breakdown.'))
    assert.ok(t.includes('Packing cost matches the PI’s Commercial breakdown.'))
    assert.equal((render().match(/pi-ff-recon-line--green/g) ?? []).length, 2)
  })

  test('a figure that differs names both numbers; a worded PI figure is quoted', () => {
    const t = text(render({ fabricCost: 401600, packingCost: null, packingCostText: 'Included' }))
    assert.ok(t.includes('Fabric amount differs from the PI: the sheet adds up to ₹2,16,000, the PI states ₹4,01,600.'))
    assert.ok(t.includes('Packing cost: the PI states it as “Included”.'))
  })

  test('metres are written without trailing zeros', () => {
    assert.equal(formatMetres(502), '502 m')
    assert.equal(formatMetres(0.7), '0.7 m')
    assert.equal(formatMetres(5.6), '5.6 m')
    assert.equal(formatMetres(1234.5), '1,234.5 m')
    assert.equal(formatMetres(null), '—')
  })
})

describe('the per-product table', () => {
  test('one row per line, with the code, the product and its quantity, and every figure', () => {
    const html = render()
    assert.equal((html.match(/<tbody>[\s\S]*<\/tbody>/)?.[0].match(/<tr>/g) ?? []).length, 3)
    const t = text(html)
    assert.ok(t.includes('539-B001') && t.includes('Sofa, 3-seater · 12 pcs') && t.includes('Oak frame, upholstery'))
    assert.ok(t.includes('12.5') && t.includes('150') && t.includes('800') && t.includes('₹1,20,000'))
    assert.ok(t.includes('1,500') && t.includes('₹18,000') && t.includes('BCF'))
    assert.ok(t.includes('Carton & crate'))
  })

  test('PENDING and NA are pills; a person’s words are shown as they are; a blank is a dash', () => {
    const html = render()
    assert.ok((html.match(/pi-ff-pill--amber/g) ?? []).length >= 6, 'every PENDING')
    assert.ok(html.includes('pi-ff-pill--grey">NA'))
    assert.ok(html.includes('pi-ff-pill--grey">—'))
    assert.ok(html.includes('Complete brass finish on base'))
    assert.ok(html.includes('pi-ff-pill--green">Approved 12 Oct'))
  })

  test('the totals row carries the three sums', () => {
    const foot = render().match(/<tfoot>[\s\S]*<\/tfoot>/)?.[0] ?? ''
    const t = text(foot)
    assert.ok(t.includes('Total · 3 lines') && t.includes('270 m') && t.includes('₹2,16,000') && t.includes('₹39,500'))
  })

  test('a line whose PI quantity has moved, or that is no longer on the PI, is flagged', () => {
    const html = render({ piQuantityByRow: new Map([[32, 12], [33, 22]]) })
    assert.ok(html.includes('PI line now 22 pcs'))
    assert.ok(html.includes('Not on the PI now'))
    assert.equal((html.match(/pi-ff-warn/g) ?? []).length, 2)
    assert.equal((render().match(/pi-ff-warn/g) ?? []).length, 0, 'nothing is flagged when nothing moved')
  })

  test('the approval columns are the sheet’s, grouped under one heading', () => {
    const html = render()
    assert.ok(html.includes('Approvals (Fabric and Finish sheet)'))
    for (const col of sheets.finishSheet.approvalColumns) assert.ok(html.includes(`<th`) && text(html).includes(col))
  })
})

describe('a sheet that is missing', () => {
  test('no cost sheet: no figures, no reconciliation, and it is said', () => {
    const html = render({}, { ...sheets, costSheet: { present: false }, lines: sheets.lines.map(l => ({ ...l, fabric: null, packing: null })) })
    const t = text(html)
    assert.ok(t.includes(FF_NO_COST_SHEET))
    assert.ok(!html.includes('pi-ff-recon-line'))
    assert.ok(!t.includes('Per pc (m)'))
    assert.ok(t.includes('Approvals (Fabric and Finish sheet)'), 'the approvals still show')
  })

  test('no finish sheet: no approval columns, and it is said', () => {
    const html = render({}, { ...sheets, finishSheet: { present: false, approvalColumns: [] }, lines: sheets.lines.map(l => ({ ...l, approvals: [] })) })
    const t = text(html)
    assert.ok(t.includes(FF_NO_FINISH_SHEET))
    assert.ok(!t.includes('Approvals (Fabric and Finish sheet)'))
    assert.ok(t.includes('Per pc (m)'), 'the figures still show')
  })

  test('no lines at all is said rather than drawn as an empty table', () => {
    const t = text(render({}, { ...sheets, lines: [], totals: { totalFabricMetres: 0, fabricAmount: 0, packingTotal: 0, linesWithFabric: 0, linesWithPacking: 0 } }))
    assert.ok(t.includes(FF_EMPTY))
    assert.ok(!t.includes('Total · 0 lines'))
  })
})
