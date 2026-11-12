import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { computeTotals, gstModeForState, lineQty, sizeInInches, validUntil, whatsappLink, type QuoteArea, type QuoteLine } from './math'

const areas: QuoteArea[] = [
  { key: 'a', name: 'Corporate room', style: 'Contemporary', multiplier: 18, unit_label: 'rooms' },
  { key: 'b', name: 'Boho room', style: 'Boho', multiplier: 56, unit_label: 'rooms' },
]
const L = (over: Partial<QuoteLine>): QuoteLine => ({
  key: Math.random().toString(36).slice(2), area_key: 'a', name: 'X', size_text: '', spec: '', material: '', finish: '', category: '',
  qty_mode: 'per_unit', qty: 1, unit_price: 0, tax_rate: 18, image_path: null, is_optional: false, client_note: '', internal_note: '', ...over,
})

// The real Resort Shamshabad quote (Base44 QT-MVTPTT9W, 29 Oct 2026): 16 lines, 2 room types.
const REAL: QuoteLine[] = [
  L({ area_key: 'a', unit_price: 64000 }), L({ area_key: 'a', unit_price: 10800 }), L({ area_key: 'a', unit_price: 18000 }),
  L({ area_key: 'a', unit_price: 8200 }), L({ area_key: 'a', unit_price: 46000 }), L({ area_key: 'a', unit_price: 14500 }),
  L({ area_key: 'a', unit_price: 102000 }),
  L({ area_key: 'b', unit_price: 56000 }), L({ area_key: 'b', qty: 2, unit_price: 11900 }), L({ area_key: 'b', unit_price: 21000 }),
  L({ area_key: 'b', unit_price: 7800 }), L({ area_key: 'b', unit_price: 43000 }), L({ area_key: 'b', unit_price: 15000 }),
  L({ area_key: 'b', qty_mode: 'fixed', qty: 39, unit_price: 96000 }), L({ area_key: 'b', unit_price: 23200 }), L({ area_key: 'b', unit_price: 19000 }),
]

describe('quotation totals', () => {
  test('the real Shamshabad quote adds up to the PDF to the rupee, CGST + SGST as Base44 printed it', () => {
    const t = computeTotals({ gst_mode: 'cgst_sgst', discount_pct: 0, fabric_amount: 0, packing_amount: 0 }, areas, REAL)
    assert.equal(t.subtotal, 20179800)
    assert.equal(t.areaTotal.a, 4743000)
    assert.equal(t.areaTotal.b, 15436800)
    assert.deepEqual(t.gst, [{ rate: 18, base: 20179800, igst: 0, cgst: 1816182, sgst: 1816182 }])
    assert.equal(t.grand, 23812164)
    assert.equal(t.pieces, 669)
  })

  test('IGST gives the same total under one head', () => {
    const t = computeTotals({ gst_mode: 'igst', discount_pct: 0, fabric_amount: 0, packing_amount: 0 }, areas, REAL)
    assert.deepEqual(t.gst, [{ rate: 18, base: 20179800, igst: 3632364, cgst: 0, sgst: 0 }])
    assert.equal(t.grand, 23812164)
  })

  test('optional lines are shown with a total but not counted', () => {
    const lines = [L({ unit_price: 1000 }), L({ unit_price: 500, is_optional: true })]
    const t = computeTotals({ gst_mode: 'igst', discount_pct: 0, fabric_amount: 0, packing_amount: 0 }, areas, lines)
    assert.equal(t.lineTotal[lines[1].key], 9000)
    assert.equal(t.subtotal, 18000)
  })

  test('discount, fabric and packing: value before GST, decor at 12% keeps its own rate', () => {
    const lines = [L({ qty_mode: 'fixed', qty: 10, unit_price: 10000 }), L({ qty_mode: 'fixed', qty: 10, unit_price: 2000, tax_rate: 12 })]
    const t = computeTotals({ gst_mode: 'igst', discount_pct: 10, fabric_amount: 5000, packing_amount: 3000 }, areas, lines)
    assert.equal(t.subtotal, 120000)
    assert.equal(t.discount, 12000)
    assert.equal(t.taxable, 116000)
    assert.deepEqual(t.gst, [
      { rate: 18, base: 98000, igst: 17640, cgst: 0, sgst: 0 },
      { rate: 12, base: 18000, igst: 2160, cgst: 0, sgst: 0 },
    ])
    assert.equal(t.grand, 116000 + 17640 + 2160)
  })

  test('quantity: per room × rooms, fixed, or a line with no room type', () => {
    assert.equal(lineQty({ qty_mode: 'per_unit', qty: 2, area_key: 'b' }, areas), 112)
    assert.equal(lineQty({ qty_mode: 'fixed', qty: 39, area_key: 'b' }, areas), 39)
    assert.equal(lineQty({ qty_mode: 'per_unit', qty: 3, area_key: null }, areas), 3)
    assert.equal(lineQty({ qty_mode: 'per_unit', qty: null, area_key: 'a' }, areas), 0)
  })
})

describe('sizes as clients write them', () => {
  test('feet and inches', () => {
    assert.deepEqual(sizeInInches(`6'0"×6'6"×1'6"`), [72, 78, 18])
    assert.deepEqual(sizeInInches(`7' x 2' x 8'3"`), [84, 24, 99])
    assert.deepEqual(sizeInInches(`4'6" x 1'6"`), [54, 18])
    assert.deepEqual(sizeInInches(`4'0" x 6'6" x 1'6" QTY-2`), [48, 78, 18])
  })
  test('inches with labels, or "inches" at the end', () => {
    assert.deepEqual(sizeInInches(`48"(Length) x 56"(Height)`), [48, 56])
    assert.deepEqual(sizeInInches('30x18x16 inches'), [30, 18, 16])
  })
  test('a bare number is not trusted', () => {
    assert.equal(sizeInInches('30 x 18'), null)
    assert.equal(sizeInInches(''), null)
    assert.equal(sizeInInches('As per drawing'), null)
  })
})

describe('small rules', () => {
  test('GST type from the place of supply', () => {
    assert.equal(gstModeForState('Rajasthan'), 'cgst_sgst')
    assert.equal(gstModeForState(' rajasthan '), 'cgst_sgst')
    assert.equal(gstModeForState('Telangana'), 'igst')
    assert.equal(gstModeForState(null), 'igst')
  })
  test('WhatsApp link adds India to a 10-digit number and encodes the text', () => {
    assert.equal(whatsappLink('98290 12345', 'Hi & bye'), 'https://wa.me/919829012345?text=Hi%20%26%20bye')
    assert.equal(whatsappLink(null, 'x'), 'https://wa.me/?text=x')
  })
  test('valid until counts days from the issue date', () => {
    assert.equal(validUntil('2026-11-12', 7), '2026-11-19')
    assert.equal(validUntil('2026-12-28', 7), '2027-01-04')
  })
})
