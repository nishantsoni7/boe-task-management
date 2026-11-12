import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { compareDocs, type VersionDoc } from './versions'

// Two versions of an invented resort quotation. Area and line ids differ between them, as they do after every save.
const v1: VersionDoc = {
  client_name: 'Example Resort', project_name: null, gst_mode: 'igst', discount_pct: 0, fabric_amount: 0, packing_amount: 10000,
  transport_note: null, valid_days: 7, notes: null,
  areas: [{ id: 'a1', name: 'Deluxe room', style: null, multiplier: 10, unit_label: 'rooms' }],
  lines: [
    { area_id: 'a1', name: 'Queen bed', size_text: '60 x 78', material: 'Mango', finish: 'PU', qty_per_unit: 1, qty_fixed: null, unit_price: 50000, tax_rate: 18, image_path: null, is_optional: false, client_note: null },
    { area_id: 'a1', name: 'Bedside table', size_text: '18 x 18', material: 'Mango', finish: 'PU', qty_per_unit: 2, qty_fixed: null, unit_price: 9000, tax_rate: 18, image_path: null, is_optional: false, client_note: null },
    { area_id: 'a1', name: 'Mirror', size_text: null, material: null, finish: null, qty_per_unit: 1, qty_fixed: null, unit_price: 5000, tax_rate: 18, image_path: null, is_optional: false, client_note: null },
  ],
}
const v2: VersionDoc = {
  ...v1, discount_pct: 5,
  areas: [{ id: 'b1', name: 'Deluxe room', style: null, multiplier: 12, unit_label: 'rooms' }],
  lines: [
    { area_id: 'b1', name: 'Queen bed', size_text: '60 x 78', material: 'Walnut', finish: 'PU', qty_per_unit: 1, qty_fixed: null, unit_price: 56000, tax_rate: 18, image_path: null, is_optional: false, client_note: null },
    { area_id: 'b1', name: 'Bedside table', size_text: '18 x 18', material: 'Mango', finish: 'PU', qty_per_unit: 2, qty_fixed: null, unit_price: 9000, tax_rate: 18, image_path: null, is_optional: false, client_note: null },
    { area_id: 'b1', name: 'Luggage rack', size_text: '36 x 18', material: 'Mango', finish: 'PU', qty_per_unit: 1, qty_fixed: null, unit_price: 7000, tax_rate: 18, image_path: null, is_optional: false, client_note: null },
  ],
}

describe('comparing two versions', () => {
  const c = compareDocs(v1, v2)
  test('discount and extras', () => {
    assert.deepEqual(c.header, [{ label: 'Discount', from: '0%', to: '5%' }])
  })
  test('products matched by room type and name although their ids changed: added, removed, changed', () => {
    assert.deepEqual(c.added.map(a => [a.name, a.qty, a.price]), [['Luggage rack', 12, 7000]])
    assert.deepEqual(c.removed.map(r => r.name), ['Mirror'])
    const bed = c.changed.find(x => x.name === 'Queen bed')!
    assert.deepEqual(bed.changes.map(x => [x.label, x.from, x.to]), [['Quantity', '10', '12'], ['Price', '₹50,000', '₹56,000'], ['Material', 'Mango', 'Walnut']])
    // 10 → 12 rooms changes every per-room quantity, the bedside tables included.
    assert.deepEqual(c.changed.find(x => x.name === 'Bedside table')!.changes.map(x => x.label), ['Quantity'])
  })
  test('totals before GST and grand total, from the same arithmetic as the screen', () => {
    // v1: 10×50,000 + 20×9,000 + 10×5,000 + packing 10,000 = 7,40,000
    // v2: 12×56,000 + 24×9,000 + 12×7,000 = 9,72,000 − 5% (48,600) + 10,000 = 9,33,400
    assert.deepEqual([c.before.from, c.before.to], [740000, 933400])
    assert.equal(c.grand.to, Math.round(933400 * 1.18))
  })
  test('the same document compares as no change', () => {
    const same = compareDocs(v1, { ...v1, areas: [{ ...v1.areas[0], id: 'zz' }], lines: v1.lines.map(l => ({ ...l, area_id: 'zz' })) })
    assert.deepEqual([same.header.length, same.added.length, same.removed.length, same.changed.length], [0, 0, 0, 0])
  })
})
