import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyDiscountWording,
  clientDeductionRows,
  hasDeduction,
  isDesignFeeWording,
  isDiscountWording,
} from './discountWording'
import { buildCommercialRows } from '@/lib/pi/previewView'

const fmt = (n: number) => `₹${n.toLocaleString('en-IN')}`

const commercial = (discount: number) => ({
  grossProductAmount: 3494400,
  discount,
  discountLabel: 'Design Fees',
  subtotalAfterDiscount: { amount: 3494400 - discount, text: null },
  fabricCost: { amount: 0, text: null },
  packingCost: { amount: 169960, text: null },
  transportation: { amount: null, text: 'as applicable' },
  totalBeforeGst: { amount: 3570060, text: null },
  gst: { amount: 642610.8, text: null },
  grandTotal: { amount: 4212670.8, text: null },
}) as unknown as Parameters<typeof buildCommercialRows>[0]

describe('the generated PI\'s deduction row', () => {
  test('non-zero (₹94,300): "Discount", every figure and every other row identical', () => {
    const rows = buildCommercialRows(commercial(94300))
    const out = clientDeductionRows(rows, { amount: 94300 })
    assert.deepEqual(out.map(r => r.key), rows.map(r => r.key))
    assert.deepEqual(out.map(r => r.value), rows.map(r => r.value), 'no figure moves')
    assert.equal(out.find(r => r.key === 'discount')?.label, 'Discount')
    assert.equal(out.find(r => r.key === 'subtotal')?.label, 'Subtotal after discount')
    assert.ok(!out.some(r => /design fee/i.test(r.label)))
    // The discount is taken off: gross − discount is the subtotal shown.
    assert.equal(out.find(r => r.key === 'gross')?.value, fmt(3494400))
    assert.equal(out.find(r => r.key === 'discount')?.value, fmt(94300))
    assert.equal(out.find(r => r.key === 'subtotal')?.value, fmt(3494400 - 94300))
  })

  test('zero or blank: the row is left off, and the next line is plain "Subtotal"', () => {
    const rows = buildCommercialRows(commercial(0))
    for (const amount of [0, '0', '0.00', null, undefined, '']) {
      const out = clientDeductionRows(rows, { amount })
      assert.ok(!out.some(r => r.key === 'discount'), `amount ${String(amount)} drops the row`)
      assert.equal(out.find(r => r.key === 'subtotal')?.label, 'Subtotal', `amount ${String(amount)}: "Subtotal"`)
      assert.ok(!out.some(r => /after discount/i.test(r.label)), `amount ${String(amount)}: no "after discount"`)
      assert.deepEqual(out.map(r => r.value), rows.filter(r => r.key !== 'discount').map(r => r.value), 'no figure moves')
    }
    assert.equal(hasDeduction('94300.00'), true)
    assert.equal(hasDeduction(0), false)
  })

  test('there is no way to ask for another word — the function takes none', () => {
    // A stray label argument is ignored by the type and at run time.
    const rows = buildCommercialRows(commercial(94300))
    const out = clientDeductionRows(rows, { amount: 94300, label: 'design_fee' } as never)
    assert.equal(out.find(r => r.key === 'discount')?.label, 'Discount')
  })
})

describe('warnings about the UPLOADED workbook\'s wording', () => {
  test('zero: nothing to say', () => {
    assert.deepEqual(classifyDiscountWording({ amount: 0, label: 'Design Fee', formatAmount: fmt }), { kind: 'none', notice: null })
  })

  test('the workbook already says Discount: nothing to say', () => {
    assert.equal(classifyDiscountWording({ amount: 94300, label: 'Discount', formatAmount: fmt }).kind, 'consistent')
  })

  test('the workbook says Design Fee for a non-zero deduction: correct the workbook before sharing it', () => {
    const w = classifyDiscountWording({ amount: 94300, label: 'Design Fees', formatAmount: fmt })
    assert.equal(w.kind, 'design_fee')
    assert.match(w.notice ?? '', /"Design Fees"\. The generated PI prints it as "Discount"/)
    assert.match(w.notice ?? '', /before sharing the original file/)
  })

  test('no wording on record (PID-00002\'s case): ask for the workbook to be checked, never guess', () => {
    const w = classifyDiscountWording({ amount: 94300, label: null, formatAmount: fmt })
    assert.equal(w.kind, 'unknown')
    assert.match(w.notice ?? '', /not on record/)
  })

  test('unrecognised wording is quoted back', () => {
    const w = classifyDiscountWording({ amount: 500, label: 'Special price', formatAmount: fmt })
    assert.equal(w.kind, 'other')
    assert.match(w.notice ?? '', /"Special price"/)
  })

  test('the matchers', () => {
    assert.ok(isDesignFeeWording('Design Fee') && isDesignFeeWording(' design fees :'))
    assert.ok(!isDesignFeeWording('Discount'))
    assert.ok(isDiscountWording('DISCOUNT') && !isDiscountWording('Design Fee'))
  })
})
