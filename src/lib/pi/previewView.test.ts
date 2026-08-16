/**
 * The rules the PI preview screen promises, tested away from the screen.
 *
 * WHAT THESE TESTS DEFEND. Phase 3A shows an employee a workbook and saves
 * nothing. The things that can still go wrong are all statements the UI makes
 * about the document: that ₹ figures are grouped the Indian way, that "as
 * applicable" survives as words, that a dash in the fabric row is a deliberate
 * nil and not an unknown, that 40% is a requirement rather than a payment, that
 * a blank customization reads as "none" rather than "missing", that a blocking
 * issue is never quietly demoted to a warning, that a failed parse says
 * something a person can act on, that the number printed on the supplied
 * workbook is NEVER presented as a BOE order number, and that every object URL
 * this module hands out can be released again.
 *
 * These do NOT re-test the parser. masterSheetParser.test.ts and
 * workbookReader.test.ts already cover reading a workbook; everything here is
 * fed hand-built values and asserts only the presentation layer.
 *
 * Offline and pure. No file is written, no network is touched, no database
 * client exists in this module's import graph, and no browser is required — the
 * one impure dependency, URL.createObjectURL, is injected.
 *
 * Run:
 *   npx tsx --test src/lib/pi/previewView.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkPiFile,
  formatByteLimit,
  formatInr,
  formatPiValue,
  INCLUDED_TEXT,
  NOT_APPLICABLE_TEXT,
  formatPiDate,
  formatCustomization,
  NO_CUSTOMIZATION_TEXT,
  orDash,
  buildHeaderRows,
  buildCommercialRows,
  computeRequiredAdvance,
  PI_ADVANCE_PERCENT,
  ADVANCE_NOT_A_PAYMENT_NOTE,
  groupPiDiagnostics,
  describePiFailure,
  describeFileRejection,
  createPiImageUrls,
  describeImageCoverage,
  describeCustomizationImageCount,
  buildImageViewerItems,
  viewerNav,
  PI_ACCEPTED_EXTENSION,
  PI_FILE_INPUT_ACCEPT,
  type PiObjectUrlFactory,
} from './previewView'
import { PI_MAX_WORKBOOK_BYTES } from './workbookReader'
import type {
  PiAmountOrText,
  PiBlockingIssue,
  PiCommercialSummary,
  PiHeader,
  PiProductImage,
  PiWarning,
} from './types'

// ── Builders ──────────────────────────────────────────────────────────────────

const amount = (n: number, cell = 'I122'): PiAmountOrText =>
  ({ amount: n, text: null, zeroMeaning: null, cell })

const textValue = (t: string, cell = 'I119'): PiAmountOrText =>
  ({ amount: null, text: t, zeroMeaning: null, cell })

const nilValue = (cell = 'I117'): PiAmountOrText =>
  ({ amount: 0, text: null, zeroMeaning: 'notApplicable', cell })

const includedValue = (cell = 'I118'): PiAmountOrText =>
  ({ amount: 0, text: 'Inclusive', zeroMeaning: 'included', cell })

const emptyValue = (cell = 'I118'): PiAmountOrText =>
  ({ amount: null, text: null, zeroMeaning: null, cell })

const commercial = (over: Partial<PiCommercialSummary> = {}): PiCommercialSummary => ({
  discount: 0,
  discountLabel: null,
  subtotalAfterDiscount: amount(250000, 'I116'),
  fabricCost: nilValue('I117'),
  packingCost: nilValue('I118'),
  transportation: textValue('as applicable'),
  totalBeforeGst: amount(250000, 'I120'),
  gst: amount(45000, 'I121'),
  grandTotal: amount(295000, 'I122'),
  grossProductAmount: 250000,
  expectedSubtotal: 250000,
  ...over,
})

const header = (over: Partial<PiHeader> = {}): PiHeader => ({
  sourceOrderNumber: null,
  creationDate: null,
  createdBy: null,
  boeGst: null,
  contactNumber: null,
  billToName: null,
  billToPhone: null,
  billToGst: null,
  billingAddress: null,
  shipToName: null,
  shipToPhone: null,
  shipToGst: null,
  shippingAddress: null,
  orderConfirmationDate: null,
  dispatchCommitment: null,
  ...over,
})

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

const customizationImage = (over: Partial<PiProductImage> = {}): PiProductImage =>
  image({ role: 'customization', anchorFromCol: 10, part: 'xl/media/cust1.png', ...over })

/**
 * The URL bag from a flat representative list plus an optional customization
 * list. Most cases below are about representative images, so the second list
 * defaults to empty.
 */
const urlsFor = (
  representativeImages: readonly PiProductImage[],
  factory: PiObjectUrlFactory,
  customizationImages: readonly PiProductImage[] = [],
) => createPiImageUrls({ representativeImages, customizationImages }, factory)

/** Records every create/revoke so leaks and double-frees are both visible. */
function fakeUrlFactory() {
  const created: string[] = []
  const revoked: string[] = []
  const factory: PiObjectUrlFactory = {
    create: () => {
      const url = `blob:fake/${created.length}`
      created.push(url)
      return url
    },
    revoke: url => { revoked.push(url) },
  }
  return { factory, created, revoked }
}

// ── File acceptance ───────────────────────────────────────────────────────────

describe('checkPiFile', () => {
  test('accepts a .xlsx inside the size limit', () => {
    assert.deepEqual(checkPiFile({ name: 'PI.xlsx', size: 1024 }), { ok: true })
  })

  test('accepts regardless of letter case in the extension', () => {
    assert.equal(checkPiFile({ name: 'PI.XLSX', size: 1024 }).ok, true)
    assert.equal(checkPiFile({ name: 'PI.XlsX', size: 1024 }).ok, true)
  })

  test('rejects every other spreadsheet-shaped extension', () => {
    for (const name of ['PI.xls', 'PI.xlsm', 'PI.csv', 'PI.pdf', 'PI.xlsx.pdf', 'PI', 'PI.numbers']) {
      const result = checkPiFile({ name, size: 1024 })
      assert.equal(result.ok, false, `${name} must be rejected`)
      if (!result.ok) assert.equal(result.reason, 'NOT_XLSX')
    }
  })

  test('a name that merely contains .xlsx is not accepted', () => {
    const result = checkPiFile({ name: 'PI.xlsx.zip', size: 1024 })
    assert.equal(result.ok, false)
  })

  test('accepts exactly the limit and rejects one byte more', () => {
    assert.equal(checkPiFile({ name: 'PI.xlsx', size: PI_MAX_WORKBOOK_BYTES }).ok, true)
    const over = checkPiFile({ name: 'PI.xlsx', size: PI_MAX_WORKBOOK_BYTES + 1 })
    assert.equal(over.ok, false)
    if (!over.ok) assert.equal(over.reason, 'TOO_LARGE')
  })

  test('the limit is the parser limit, stated as 10 MB', () => {
    assert.equal(PI_MAX_WORKBOOK_BYTES, 10 * 1024 * 1024)
    assert.equal(formatByteLimit(PI_MAX_WORKBOOK_BYTES), '10 MB')
    const over = checkPiFile({ name: 'PI.xlsx', size: PI_MAX_WORKBOOK_BYTES + 1 })
    if (!over.ok) assert.ok(over.message.includes('10 MB'))
  })

  test('rejects an empty file before anything tries to read it', () => {
    const result = checkPiFile({ name: 'PI.xlsx', size: 0 })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'EMPTY')
  })

  test('size is checked after type, so a huge PDF is reported as a PDF', () => {
    const result = checkPiFile({ name: 'PI.pdf', size: PI_MAX_WORKBOOK_BYTES * 4 })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'NOT_XLSX')
  })

  test('the file input offers the extension and the OOXML type', () => {
    assert.ok(PI_FILE_INPUT_ACCEPT.includes(PI_ACCEPTED_EXTENSION))
    assert.ok(PI_FILE_INPUT_ACCEPT.includes('spreadsheetml.sheet'))
  })
})

// ── Money ─────────────────────────────────────────────────────────────────────

describe('formatInr', () => {
  test('groups the Indian way: last three digits, then pairs', () => {
    assert.equal(formatInr(100), '₹100')
    assert.equal(formatInr(1000), '₹1,000')
    assert.equal(formatInr(5200), '₹5,200')
    assert.equal(formatInr(110000), '₹1,10,000')
    assert.equal(formatInr(250000), '₹2,50,000')
    assert.equal(formatInr(1234567), '₹12,34,567')
    assert.equal(formatInr(100000000), '₹10,00,00,000')
  })

  test('a whole-rupee amount carries no decimals', () => {
    assert.equal(formatInr(0), '₹0')
    assert.equal(formatInr(5200), '₹5,200')
    assert.equal(formatInr(5200.0), '₹5,200')
    assert.ok(!formatInr(110000).includes('.'), 'no forced .00')
  })

  test('paise are shown when there are paise', () => {
    assert.equal(formatInr(350625.2), '₹3,50,625.20')
    assert.equal(formatInr(1500.5), '₹1,500.50')
    assert.equal(formatInr(1500.55), '₹1,500.55')
    assert.equal(formatInr(0.05), '₹0.05')
  })

  test('rounds to paise before deciding, so a float artefact stays whole', () => {
    assert.equal(formatInr(1500.555), '₹1,500.56')
    assert.equal(formatInr(40000.000000001), '₹40,000')
    assert.equal(formatInr(99999.999), '₹1,00,000')
  })

  test('negatives carry a minus and keep the grouping', () => {
    assert.equal(formatInr(-250000), '−₹2,50,000')
    assert.equal(formatInr(-1500.5), '−₹1,500.50')
  })

  test('nothing is not zero', () => {
    assert.equal(formatInr(null), '—')
    assert.equal(formatInr(undefined), '—')
    assert.equal(formatInr(Number.NaN), '—')
    assert.equal(formatInr(Number.POSITIVE_INFINITY), '—')
  })
})

describe('formatPiValue', () => {
  test('a figure is a figure', () => {
    const shown = formatPiValue(amount(45000))
    assert.equal(shown.kind, 'amount')
    assert.equal(shown.display, '₹45,000')
    assert.equal(shown.amount, 45000)
  })

  test('textual transportation survives verbatim', () => {
    const shown = formatPiValue(textValue('as applicable'))
    assert.equal(shown.kind, 'text')
    assert.equal(shown.display, 'as applicable')
    assert.equal(shown.amount, null)
  })

  test('a dash or blank in a nil-able cell reads as Not applicable, not ₹0.00', () => {
    const shown = formatPiValue(nilValue())
    assert.equal(shown.kind, 'notApplicable')
    assert.equal(shown.display, 'Not applicable')
    // The parser resolved it to a real zero so callers can still add it up.
    assert.equal(shown.amount, 0)
  })

  test('"Inclusive" reads as Included — a charge, not an absence', () => {
    const shown = formatPiValue(includedValue('I118'))
    assert.equal(shown.kind, 'included')
    assert.equal(shown.display, INCLUDED_TEXT)
    assert.equal(shown.display, 'Included')
    // Zero for the arithmetic, like the dash — but never the same words.
    assert.equal(shown.amount, 0)
    assert.notEqual(shown.display, NOT_APPLICABLE_TEXT)
  })

  test('Included and Not applicable are never rendered alike', () => {
    const included = formatPiValue(includedValue('I118'))
    const nil = formatPiValue(nilValue('I118'))

    assert.equal(included.amount, nil.amount, 'both add nothing to the total')
    assert.notEqual(included.kind, nil.kind, 'but they are different facts')
    assert.notEqual(included.display, nil.display)
  })

  test('the source wording is kept on the value but not shown in its place', () => {
    const value = includedValue('I117')
    assert.equal(value.text, 'Inclusive', 'available for audit')
    assert.equal(formatPiValue(value).display, 'Included', 'normalized on screen')
  })

  test('neither worded zero is shown as ₹0', () => {
    assert.notEqual(formatPiValue(includedValue()).display, '₹0')
    assert.notEqual(formatPiValue(nilValue()).display, '₹0')
  })

  test('an empty cell with no agreed meaning is an em dash', () => {
    assert.equal(formatPiValue(emptyValue()).display, '—')
    assert.equal(formatPiValue(null).display, '—')
    assert.equal(formatPiValue(undefined).kind, 'missing')
  })
})

// ── Dates and optional text ───────────────────────────────────────────────────

describe('formatPiDate', () => {
  test('an Excel serial date is spelled out without a timezone shift', () => {
    assert.equal(formatPiDate({ iso: '2026-08-16', text: '16/08/2026', source: 'serial' }), '16 Aug 2026')
    assert.equal(formatPiDate({ iso: '2026-01-01', text: '01/01/2026', source: 'serial' }), '1 Jan 2026')
    assert.equal(formatPiDate({ iso: '2026-12-31', text: '31/12/2026', source: 'serial' }), '31 Dec 2026')
  })

  test('a commitment written in words keeps its words', () => {
    const commitment = { iso: null, text: '6 weeks from date of confirmation', source: 'text' as const }
    assert.equal(formatPiDate(commitment), '6 weeks from date of confirmation')
  })

  test('an absent date is an em dash', () => {
    assert.equal(formatPiDate(null), '—')
    assert.equal(formatPiDate(undefined), '—')
    assert.equal(formatPiDate({ iso: null, text: '', source: 'text' }), '—')
  })

  test('an unparseable iso falls back to the text rather than inventing a date', () => {
    assert.equal(formatPiDate({ iso: 'not-a-date', text: 'next month', source: 'serial' }), 'next month')
  })
})

describe('formatCustomization', () => {
  test('a blank customization says there is none', () => {
    assert.equal(formatCustomization(null), NO_CUSTOMIZATION_TEXT)
    assert.equal(formatCustomization(''), NO_CUSTOMIZATION_TEXT)
    assert.equal(formatCustomization('   '), NO_CUSTOMIZATION_TEXT)
    assert.equal(NO_CUSTOMIZATION_TEXT, 'No customization')
  })

  test('a real customization is shown as written, line breaks and all', () => {
    assert.equal(formatCustomization('Brass handles\nMatte finish'), 'Brass handles\nMatte finish')
  })

  test('customization is never confused with a missing field', () => {
    // orDash is what an unknown looks like; customization must not use it.
    assert.equal(orDash(null), '—')
    assert.notEqual(formatCustomization(null), orDash(null))
  })
})

// ── The source number is not shown at all ─────────────────────────────────────

describe('the number printed on the supplied workbook', () => {
  const withSourceNumber = header({
    sourceOrderNumber: 'BOE-2026-0912',
    billToName: 'Sample Client',
    createdBy: 'Sample Employee',
  })

  test('never reaches the visible summary', () => {
    const rows = buildHeaderRows(withSourceNumber)
    const rendered = rows.map(r => `${r.key} ${r.label} ${r.value}`).join(' | ')
    assert.ok(!rendered.includes('BOE-2026-0912'),
      'B20 must not appear anywhere in the preview summary')
    assert.ok(!/order\s*(number|no\.?|#)/i.test(rendered),
      'and no row may be labelled as an order number')
  })

  test('no summary row is derived from it', () => {
    const withNumber = buildHeaderRows(withSourceNumber)
    const withoutNumber = buildHeaderRows(header({
      sourceOrderNumber: null,
      billToName: 'Sample Client',
      createdBy: 'Sample Employee',
    }))
    assert.deepEqual(withNumber, withoutNumber,
      'the visible summary must be identical whether or not the workbook carried a number')
  })

  test('the parser still keeps it, for audit', () => {
    // Removing it from the SCREEN must not remove it from the record. The
    // header type carries it, and Phase 3B will store it as provenance.
    assert.equal(withSourceNumber.sourceOrderNumber, 'BOE-2026-0912')
  })
})

// ── Header summary ────────────────────────────────────────────────────────────

describe('buildHeaderRows', () => {
  test('carries the fields a reviewer checks, and no personal contact details', () => {
    const rows = buildHeaderRows(header({
      billToName: 'Vishal Interiors',
      shipToName: 'Vishal Interiors — Site',
      createdBy: 'Santosh',
      billToPhone: '9876543210',
      billToGst: '08AABCU9603R1ZM',
      billingAddress: '12 Station Road, Jaipur',
      creationDate: { iso: '2026-08-16', text: '16/08/2026', source: 'serial' },
      dispatchCommitment: { iso: null, text: '6 weeks from date of confirmation', source: 'text' },
    }))

    const byKey = Object.fromEntries(rows.map(r => [r.key, r.value]))
    assert.equal(byKey.client, 'Vishal Interiors')
    assert.equal(byKey.billTo, 'Vishal Interiors')
    assert.equal(byKey.shipTo, 'Vishal Interiors — Site')
    assert.equal(byKey.createdBy, 'Santosh')
    assert.equal(byKey.created, '16 Aug 2026')
    assert.equal(byKey.dispatch, '6 weeks from date of confirmation')

    const rendered = rows.map(r => r.value).join(' | ')
    assert.ok(!rendered.includes('9876543210'), 'phone numbers stay off the preview')
    assert.ok(!rendered.includes('08AABCU9603R1ZM'), 'GST registrations stay off the preview')
    assert.ok(!rendered.includes('Station Road'), 'postal addresses stay off the preview')
  })

  test('an empty header renders em dashes rather than blanks or "null"', () => {
    for (const row of buildHeaderRows(header())) {
      assert.equal(row.value, '—', `${row.key} should be an em dash`)
    }
  })
})

// ── Commercial summary ────────────────────────────────────────────────────────

describe('buildCommercialRows', () => {
  test('lays out every commercial line the PI carries', () => {
    const keys = buildCommercialRows(commercial()).map(r => r.key)
    assert.deepEqual(keys, [
      'gross', 'discount', 'subtotal', 'fabric', 'packing',
      'transportation', 'beforeGst', 'gst', 'grandTotal', 'advance',
    ])
  })

  test('formats each line in rupees, keeping text and nil cells as they are', () => {
    const rows = buildCommercialRows(commercial())
    const byKey = Object.fromEntries(rows.map(r => [r.key, r.value]))
    assert.equal(byKey.gross, '₹2,50,000')
    assert.equal(byKey.subtotal, '₹2,50,000')
    assert.equal(byKey.fabric, 'Not applicable')
    assert.equal(byKey.packing, 'Not applicable')
    assert.equal(byKey.transportation, 'as applicable')
    assert.equal(byKey.gst, '₹45,000')
    assert.equal(byKey.grandTotal, '₹2,95,000')
  })

  test('the discount line is always labelled exactly "Discount"', () => {
    // The template calls this cell "Design Fees" in some files and "Discount"
    // in others. Echoing it produced "Discount (Discount)" and
    // "Discount (Design Fees)"; neither is what the row means.
    for (const label of ['Design Fees', 'Discount', 'DISCOUNT', '  Discount  ', '', null]) {
      const rows = buildCommercialRows(commercial({ discount: 15000, discountLabel: label }))
      const discount = rows.find(r => r.key === 'discount')
      assert.equal(discount?.label, 'Discount', `workbook label ${JSON.stringify(label)}`)
    }
  })

  test('the workbook label is never echoed into any row label', () => {
    const rows = buildCommercialRows(commercial({ discountLabel: 'Design Fees' }))
    const labels = rows.map(r => r.label).join(' | ')
    assert.ok(!labels.includes('Design Fees'))
    assert.ok(!labels.includes('Discount (' ), 'no parenthesised restatement')
  })

  test('the workbook label survives on the parsed record, for audit', () => {
    const summary = commercial({ discountLabel: 'Design Fees' })
    assert.equal(summary.discountLabel, 'Design Fees')
  })

  test('a discount is shown as a figure', () => {
    const rows = buildCommercialRows(commercial({ discount: 15000, discountLabel: 'Design Fees' }))
    assert.equal(rows.find(r => r.key === 'discount')?.value, '₹15,000')
  })

  test('a PI with no discount shows zero rather than hiding the line', () => {
    const discount = buildCommercialRows(commercial()).find(r => r.key === 'discount')
    assert.equal(discount?.value, '₹0')
    assert.equal(discount?.label, 'Discount')
  })

  test('the discount is not subtracted again — the subtotal is the workbook figure', () => {
    const summary = commercial({
      discount: 15000,
      grossProductAmount: 250000,
      expectedSubtotal: 235000,
      subtotalAfterDiscount: amount(235000, 'I116'),
    })
    const byKey = Object.fromEntries(buildCommercialRows(summary).map(r => [r.key, r.value]))
    assert.equal(byKey.gross, '₹2,50,000')
    assert.equal(byKey.subtotal, '₹2,35,000')
  })

  test('an included fabric or packing cost shows "Included" in the summary', () => {
    const rows = buildCommercialRows(commercial({
      fabricCost: includedValue('I117'),
      packingCost: nilValue('I118'),
    }))
    const byKey = Object.fromEntries(rows.map(r => [r.key, r]))

    assert.equal(byKey.fabric.value, 'Included')
    assert.equal(byKey.fabric.kind, 'included')
    assert.equal(byKey.packing.value, 'Not applicable')
    assert.equal(byKey.packing.kind, 'notApplicable')
  })

  test('an included cost adds nothing to the advance, and never says ₹0', () => {
    const rows = buildCommercialRows(commercial({ packingCost: includedValue('I118') }))
    assert.equal(rows.find(r => r.key === 'packing')?.value, 'Included')
    // The grand total is the workbook's own figure and is untouched by this.
    assert.equal(rows.find(r => r.key === 'advance')?.value, '₹1,18,000')
  })

  test('the grand total and the advance are the two emphasised lines', () => {
    const rows = buildCommercialRows(commercial())
    assert.equal(rows.find(r => r.key === 'grandTotal')?.emphasis, 'total')
    assert.equal(rows.find(r => r.key === 'advance')?.emphasis, 'advance')
  })
})

describe('the 40% advance', () => {
  test('is 40% of the grand total, rounded to paise', () => {
    assert.equal(PI_ADVANCE_PERCENT, 40)
    assert.equal(computeRequiredAdvance(amount(295000)), 118000)
    assert.equal(computeRequiredAdvance(amount(100000)), 40000)
    assert.equal(computeRequiredAdvance(amount(12345.67)), 4938.27)
  })

  test('is displayed as a requirement, never as a payment', () => {
    const advance = buildCommercialRows(commercial()).find(r => r.key === 'advance')
    assert.equal(advance?.value, '₹1,18,000')
    assert.equal(advance?.label, 'Required advance (40%)')
    assert.equal(advance?.note, ADVANCE_NOT_A_PAYMENT_NOTE)
    assert.ok(/no payment has been recorded/i.test(ADVANCE_NOT_A_PAYMENT_NOTE))
  })

  test('is not computed when the grand total is text or missing', () => {
    assert.equal(computeRequiredAdvance(textValue('to be confirmed')), null)
    assert.equal(computeRequiredAdvance(emptyValue()), null)
    assert.equal(computeRequiredAdvance(null), null)

    const rows = buildCommercialRows(commercial({ grandTotal: textValue('to be confirmed', 'I122') }))
    const advance = rows.find(r => r.key === 'advance')
    assert.equal(advance?.value, '—')
    assert.equal(advance?.kind, 'missing')
  })

  test('a "not applicable" marker is not an advance base', () => {
    // The grand total cell is read with the strict policy, so the parser never
    // marks it notApplicable. If one ever arrived, 40% of "nothing to charge"
    // is not a requirement to state — it is a signal that the PI is wrong.
    assert.equal(computeRequiredAdvance(nilValue('I122')), null)
  })
})

// ── Diagnostics ───────────────────────────────────────────────────────────────

const blockingIssue = (over: Partial<PiBlockingIssue> = {}): PiBlockingIssue => ({
  code: 'PRODUCT_IMAGE_REQUIRED',
  message: 'Row 34: no product picture was found.',
  row: 34,
  ...over,
})

const warning = (over: Partial<PiWarning> = {}): PiWarning => ({
  code: 'PRODUCT_MATERIAL_MISSING',
  message: 'Row 33: no material given.',
  row: 33,
  ...over,
})

describe('groupPiDiagnostics', () => {
  test('keeps blocking issues and warnings in separate lists', () => {
    const groups = groupPiDiagnostics({
      blockingIssues: [blockingIssue()],
      warnings: [warning()],
    })
    assert.equal(groups.blocking.length, 1)
    assert.equal(groups.warnings.length, 1)
    assert.equal(groups.blocking[0].code, 'PRODUCT_IMAGE_REQUIRED')
    assert.equal(groups.warnings[0].code, 'PRODUCT_MATERIAL_MISSING')
  })

  test('a warning is never promoted into the blocking panel', () => {
    const groups = groupPiDiagnostics({
      blockingIssues: [],
      warnings: [
        warning({ code: 'LINE_TOTAL_MISMATCH', message: 'Row 33: line total disagrees.' }),
        warning({ code: 'SUBTOTAL_MISMATCH', message: 'The subtotal disagrees.', row: undefined, cell: 'I116' }),
      ],
    })
    assert.equal(groups.blocking.length, 0)
    assert.equal(groups.warnings.length, 2)
    assert.equal(groups.readyToSubmit, true, 'warnings alone do not stop a submission')
  })

  test('a blocking issue is never demoted into the warning panel', () => {
    const groups = groupPiDiagnostics({
      blockingIssues: [
        blockingIssue({ code: 'PRODUCT_QUANTITY_INVALID', row: 35, cell: 'C35' }),
        blockingIssue({ code: 'PRODUCT_NAME_MISSING', row: 32, cell: 'B32' }),
      ],
      warnings: [],
    })
    assert.equal(groups.warnings.length, 0)
    assert.equal(groups.blocking.length, 2)
    assert.equal(groups.readyToSubmit, false)
  })

  test('ready only when there is nothing blocking', () => {
    assert.equal(groupPiDiagnostics({ blockingIssues: [], warnings: [] }).readyToSubmit, true)
    assert.equal(groupPiDiagnostics({ blockingIssues: [blockingIssue()], warnings: [] }).readyToSubmit, false)
  })

  test('each entry names the row a reviewer must go and fix', () => {
    const groups = groupPiDiagnostics({
      blockingIssues: [blockingIssue({ row: 34, cell: 'C34' }), blockingIssue({ row: 36, cell: undefined })],
      warnings: [warning({ row: undefined, cell: 'I117' }), warning({ row: undefined, cell: undefined })],
    })
    assert.equal(groups.blocking[0].location, 'Row 34 · C34')
    assert.equal(groups.blocking[1].location, 'Row 36')
    assert.equal(groups.warnings[0].location, 'Cell I117')
    assert.equal(groups.warnings[1].location, null)
  })

  test('entries follow the product table: row order first, then whole-file notes', () => {
    const groups = groupPiDiagnostics({
      blockingIssues: [
        blockingIssue({ row: 40, code: 'PRODUCT_NAME_MISSING' }),
        blockingIssue({ row: 32, code: 'PRODUCT_COST_INVALID' }),
        blockingIssue({ row: 32, code: 'PRODUCT_IMAGE_AMBIGUOUS' }),
      ],
      warnings: [
        warning({ row: undefined, code: 'DRAWING_PART_MISSING' }),
        warning({ row: 33, code: 'PRODUCT_DIMENSIONS_MISSING' }),
      ],
    })
    assert.deepEqual(groups.blocking.map(b => [b.row, b.code]), [
      [32, 'PRODUCT_COST_INVALID'],
      [32, 'PRODUCT_IMAGE_AMBIGUOUS'],
      [40, 'PRODUCT_NAME_MISSING'],
    ])
    assert.deepEqual(groups.warnings.map(w => w.row), [33, null])
  })

  test('the parser message is passed through, not rewritten', () => {
    const groups = groupPiDiagnostics({
      blockingIssues: [blockingIssue({ message: 'Row 34: two pictures are anchored here.' })],
      warnings: [],
    })
    assert.equal(groups.blocking[0].message, 'Row 34: two pictures are anchored here.')
  })
})

// ── Parse failures ────────────────────────────────────────────────────────────

describe('describePiFailure', () => {
  test('distinguishes the five kinds of failure a person can act on', () => {
    const cases: [string, string][] = [
      ['INPUT_TOO_LARGE', 'file_size'],
      ['INVALID_ZIP', 'file_type'],
      ['MISSING_WORKBOOK_PARTS', 'unreadable'],
      ['MASTER_SHEET_MISSING', 'master_sheet'],
      ['TEMPLATE_FINGERPRINT_MISMATCH', 'template'],
      ['NO_PRODUCT_ROWS', 'content'],
    ]
    for (const [code, category] of cases) {
      const shown = describePiFailure([{ code: code as never, message: 'raw parser detail' }])
      assert.equal(shown.category, category, `${code} → ${category}`)
      assert.ok(shown.title.length > 0)
      assert.ok(shown.message.length > 0)
    }
  })

  test('every fatal parser code maps to a message written for a human', () => {
    const codes = [
      'INPUT_TOO_LARGE', 'INVALID_ZIP', 'UNSAFE_ENTRY_NAME', 'DUPLICATE_ENTRY',
      'TOO_MANY_ENTRIES', 'DECOMPRESSED_TOO_LARGE', 'MISSING_WORKBOOK_PARTS',
      'MASTER_SHEET_MISSING', 'MASTER_SHEET_UNREADABLE',
      'TEMPLATE_FINGERPRINT_MISMATCH', 'NO_PRODUCT_ROWS',
    ]
    for (const code of codes) {
      const shown = describePiFailure([{ code: code as never, message: 'x' }])
      assert.notEqual(shown.title, 'This PI could not be read', `${code} needs its own wording`)
      assert.ok(!shown.title.includes('_'), `${code} title must not leak the code`)
    }
  })

  test('an unrecognised code still produces something safe to show', () => {
    const shown = describePiFailure([{ code: 'SOMETHING_NEW' as never, message: 'x' }])
    assert.equal(shown.title, 'This PI could not be read')
    assert.equal(shown.category, 'unreadable')
  })

  test('an empty error list does not crash the screen', () => {
    const shown = describePiFailure([])
    assert.equal(shown.title, 'This PI could not be read')
    assert.deepEqual(shown.technical, [])
  })

  test('the first error decides the message; the rest stay as technical detail', () => {
    const shown = describePiFailure([
      { code: 'MASTER_SHEET_MISSING' as never, message: 'no Master sheet' },
      { code: 'NO_PRODUCT_ROWS' as never, message: 'and no rows' },
    ])
    assert.equal(shown.category, 'master_sheet')
    assert.equal(shown.technical.length, 2)
    assert.ok(shown.technical[0].startsWith('MASTER_SHEET_MISSING'))
  })

  test('technical detail keeps the code and the cell so a template gap is fixable', () => {
    const shown = describePiFailure([{
      code: 'TEMPLATE_FINGERPRINT_MISMATCH' as never,
      message: 'B31 expected "Product", found "Item"',
      cell: 'B31',
    }])
    assert.ok(shown.technical[0].includes('TEMPLATE_FINGERPRINT_MISMATCH'))
    assert.ok(shown.technical[0].includes('B31'))
  })

  test('a rejected file is described in the same shape as a parse failure', () => {
    const rejection = checkPiFile({ name: 'PI.pdf', size: 10 })
    assert.equal(rejection.ok, false)
    if (rejection.ok) return
    const shown = describeFileRejection(rejection)
    assert.equal(shown.category, 'file_type')
    assert.equal(shown.title, rejection.title)
    assert.deepEqual(shown.technical, ['NOT_XLSX'])

    const tooBig = checkPiFile({ name: 'PI.xlsx', size: PI_MAX_WORKBOOK_BYTES + 1 })
    if (tooBig.ok) return
    assert.equal(describeFileRejection(tooBig).category, 'file_size')
  })
})

// ── Object URLs ───────────────────────────────────────────────────────────────

describe('createPiImageUrls', () => {
  test('maps one URL to each product row', () => {
    const { factory, created } = fakeUrlFactory()
    const bag = urlsFor([
      image({ row: 32, part: 'xl/media/image1.png' }),
      image({ row: 33, part: 'xl/media/image2.jpeg', format: 'jpeg', mimeType: 'image/jpeg' }),
    ], factory)

    assert.equal(created.length, 2)
    assert.equal(bag.representativeByRow.get(32), created[0])
    assert.equal(bag.representativeByRow.get(33), created[1])
  })

  test('a picture reused on several rows allocates ONE blob, not one per row', () => {
    const { factory, created } = fakeUrlFactory()
    const bag = urlsFor([
      image({ row: 32, part: 'xl/media/image1.png' }),
      image({ row: 33, part: 'xl/media/image1.png' }),
      image({ row: 34, part: 'xl/media/image1.png' }),
    ], factory)

    assert.equal(created.length, 1, 'the shared byte buffer must not be copied per row')
    assert.equal(bag.urls.length, 1)
    assert.equal(bag.representativeByRow.get(32), bag.representativeByRow.get(34))
  })

  test('revokeAll releases every URL exactly once', () => {
    const { factory, created, revoked } = fakeUrlFactory()
    const bag = urlsFor([
      image({ row: 32, part: 'xl/media/image1.png' }),
      image({ row: 33, part: 'xl/media/image2.png' }),
      image({ row: 34, part: 'xl/media/image2.png' }),
    ], factory)

    bag.revokeAll()
    assert.deepEqual(revoked.slice().sort(), created.slice().sort())
    assert.equal(revoked.length, 2)
  })

  test('revokeAll is idempotent, so unmount after a file replacement is safe', () => {
    const { factory, revoked } = fakeUrlFactory()
    const bag = urlsFor([image()], factory)
    bag.revokeAll()
    bag.revokeAll()
    bag.revokeAll()
    assert.equal(revoked.length, 1)
  })

  test('no URL leaks: everything created is in urls, and urls is what is revoked', () => {
    const { factory, created, revoked } = fakeUrlFactory()
    const bag = urlsFor([
      image({ row: 32, part: 'a.png' }),
      image({ row: 33, part: 'b.png' }),
      image({ row: 34, part: 'c.png' }),
    ], factory)

    assert.deepEqual([...bag.urls].sort(), created.slice().sort())
    bag.revokeAll()
    assert.deepEqual(revoked.slice().sort(), created.slice().sort())
  })

  test('a picture with no recognisable format gets no URL and no invented MIME type', () => {
    const { factory, created } = fakeUrlFactory()
    const bag = urlsFor([
      image({ row: 32, format: 'unknown', mimeType: null }),
      image({ row: 33, part: 'xl/media/image2.png' }),
    ], factory)

    assert.equal(created.length, 1)
    assert.equal(bag.representativeByRow.has(32), false, 'the table shows a placeholder instead')
    assert.equal(bag.representativeByRow.get(33), created[0])
  })

  test('no images at all is an empty bag, not a crash', () => {
    const { factory, revoked } = fakeUrlFactory()
    const bag = urlsFor([], factory)
    assert.equal(bag.urls.length, 0)
    assert.equal(bag.representativeByRow.size, 0)
    bag.revokeAll()
    assert.equal(revoked.length, 0)
  })

  test('the blob carries the sniffed MIME type, not the file extension', async () => {
    const types: string[] = []
    const factory: PiObjectUrlFactory = {
      create: blob => { types.push(blob.type); return `blob:${types.length}` },
      revoke: () => {},
    }
    urlsFor([
      image({ row: 32, extension: 'png', format: 'jpeg', mimeType: 'image/jpeg' }),
    ], factory)
    assert.deepEqual(types, ['image/jpeg'])
  })

  test('a tall picture and a wide one are both kept', () => {
    // Nothing here inspects pixel dimensions, and that is the point: shape is a
    // rendering concern (the thumbnail uses object-fit: contain) and must never
    // decide whether a product HAS an image.
    const { factory } = fakeUrlFactory()
    const bag = urlsFor([
      image({ row: 32, part: 'tall.png', bytes: new Uint8Array([137, 80, 78, 71, 1]), byteLength: 5 }),
      image({ row: 33, part: 'wide.png', bytes: new Uint8Array([137, 80, 78, 71, 2, 2, 2]), byteLength: 7 }),
    ], factory)
    assert.equal(bag.representativeByRow.size, 2)
  })

  test('the blob holds the picture bytes unchanged', async () => {
    const blobs: Blob[] = []
    const factory: PiObjectUrlFactory = {
      create: blob => { blobs.push(blob); return 'blob:1' },
      revoke: () => {},
    }
    urlsFor([image({ bytes: new Uint8Array([137, 80, 78, 71]) })], factory)
    assert.equal(blobs.length, 1)
    assert.deepEqual(new Uint8Array(await blobs[0].arrayBuffer()), new Uint8Array([137, 80, 78, 71]))
  })
})

// ── Image coverage ────────────────────────────────────────────────────────────
//
// Sample A and Sample B are the two reference PI shapes: a 7-product order and
// a 12-product one. Only their SHAPE is modelled here — row numbers, how many
// products, which media part each row resolves to. No client, no description,
// no price and no bytes from a real workbook appear anywhere.

/** N product rows starting at the template's first product row. */
const sampleProducts = (count: number) =>
  Array.from({ length: count }, (_v, i) => ({
    row: 32 + i,
    itemSequence: `B${String(i + 1).padStart(3, '0')}`,
    productName: `Item ${i + 1}`,
  }))

/** N rows, each with its own media part. */
const sampleImages = (count: number, startRow = 32) =>
  Array.from({ length: count }, (_v, i) =>
    image({ row: startRow + i, part: `xl/media/image${i + 1}.png` }))

describe('describeImageCoverage', () => {
  test('Sample A: 7 products, 7 pictures → 7 of 7', () => {
    const { factory } = fakeUrlFactory()
    const bag = urlsFor(sampleImages(7), factory)
    const coverage = describeImageCoverage(sampleProducts(7), bag.representativeByRow)

    assert.equal(coverage.matched, 7)
    assert.equal(coverage.total, 7)
    assert.equal(coverage.label, '7 of 7 representative images matched')
    assert.equal(coverage.complete, true)
  })

  test('Sample B: 12 products, 12 pictures → 12 of 12', () => {
    const { factory } = fakeUrlFactory()
    const bag = urlsFor(sampleImages(12), factory)
    const coverage = describeImageCoverage(sampleProducts(12), bag.representativeByRow)

    assert.equal(coverage.matched, 12)
    assert.equal(coverage.total, 12)
    assert.equal(coverage.label, '12 of 12 representative images matched')
    assert.equal(coverage.complete, true)
  })

  test('one picture reused across products counts once PER PRODUCT ROW', () => {
    // Four chairs, one photograph. Counting distinct media files would report
    // "1 of 4" for a workbook that is completely correct.
    const { factory, created } = fakeUrlFactory()
    const bag = urlsFor([
      image({ row: 32, part: 'xl/media/shared.png' }),
      image({ row: 33, part: 'xl/media/shared.png' }),
      image({ row: 34, part: 'xl/media/shared.png' }),
      image({ row: 35, part: 'xl/media/shared.png' }),
    ], factory)

    assert.equal(created.length, 1, 'one blob for the shared bytes')
    const coverage = describeImageCoverage(sampleProducts(4), bag.representativeByRow)
    assert.equal(coverage.matched, 4, 'but four matched products')
    assert.equal(coverage.label, '4 of 4 representative images matched')
    assert.equal(coverage.complete, true)
  })

  test('a missing picture is reported with the real count, not rounded up', () => {
    const { factory } = fakeUrlFactory()
    // Rows 32, 33 and 35 have pictures; row 34 has none.
    const bag = urlsFor([
      image({ row: 32, part: 'a.png' }),
      image({ row: 33, part: 'b.png' }),
      image({ row: 35, part: 'c.png' }),
    ], factory)

    const coverage = describeImageCoverage(sampleProducts(4), bag.representativeByRow)
    assert.equal(coverage.matched, 3)
    assert.equal(coverage.total, 4)
    assert.equal(coverage.label, '3 of 4 representative images matched')
    assert.equal(coverage.complete, false, 'an incomplete PI must not read as complete')
  })

  test('an unreadable picture format counts as unmatched, matching the placeholder', () => {
    const { factory } = fakeUrlFactory()
    const bag = urlsFor([
      image({ row: 32, part: 'a.png' }),
      image({ row: 33, part: 'b.bin', format: 'unknown', mimeType: null }),
    ], factory)

    const coverage = describeImageCoverage(sampleProducts(2), bag.representativeByRow)
    assert.equal(coverage.matched, 1)
    assert.equal(coverage.label, '1 of 2 representative images matched')
  })

  test('no products at all is not "complete"', () => {
    const coverage = describeImageCoverage([], new Map())
    assert.equal(coverage.label, '0 of 0 representative images matched')
    assert.equal(coverage.complete, false)
  })

  test('the singular reads correctly', () => {
    const { factory } = fakeUrlFactory()
    const bag = urlsFor([image({ row: 32 })], factory)
    assert.equal(describeImageCoverage(sampleProducts(1), bag.representativeByRow).label, '1 of 1 representative image matched')
  })

  test('replacing Sample A with Sample B leaves no trace of the old mapping', () => {
    const { factory, created, revoked } = fakeUrlFactory()
    const sampleA = urlsFor(sampleImages(7), factory)
    assert.equal(describeImageCoverage(sampleProducts(7), sampleA.representativeByRow).matched, 7)

    sampleA.revokeAll()
    const sampleB = urlsFor(sampleImages(12), factory)

    assert.equal(describeImageCoverage(sampleProducts(12), sampleB.representativeByRow).matched, 12)
    // Every Sample A URL is revoked, and none survives into Sample B.
    assert.deepEqual(revoked.slice().sort(), created.slice(0, 7).sort())
    for (const url of revoked) {
      assert.ok(![...sampleB.representativeByRow.values()].includes(url), 'a revoked URL must not be reused')
    }
  })

  test('replacing Sample B with Sample A drops the rows that no longer exist', () => {
    const { factory } = fakeUrlFactory()
    const sampleB = urlsFor(sampleImages(12), factory)
    sampleB.revokeAll()
    const sampleA = urlsFor(sampleImages(7), factory)

    // Rows 39–43 belonged to Sample B only. Nothing may still map them.
    for (let row = 39; row <= 43; row++) {
      assert.equal(sampleA.representativeByRow.has(row), false, `row ${row} must not survive the replacement`)
    }
    assert.equal(describeImageCoverage(sampleProducts(7), sampleA.representativeByRow).label, '7 of 7 representative images matched')
  })
})

// ── The full-image viewer ─────────────────────────────────────────────────────

describe('buildImageViewerItems', () => {
  test('offers every product that has a picture, in table order', () => {
    const { factory } = fakeUrlFactory()
    const bag = urlsFor(sampleImages(3), factory)
    const items = buildImageViewerItems(sampleProducts(3), bag)

    assert.deepEqual(items.map(i => i.row), [32, 33, 34])
    assert.deepEqual(items.map(i => i.sequence), ['B001', 'B002', 'B003'])
    assert.deepEqual(items.map(i => i.name), ['Item 1', 'Item 2', 'Item 3'])
  })

  test('each item points at the SAME url the thumbnail uses', () => {
    const { factory } = fakeUrlFactory()
    const bag = urlsFor(sampleImages(3), factory)
    const items = buildImageViewerItems(sampleProducts(3), bag)
    for (const item of items) {
      assert.equal(item.url, bag.representativeByRow.get(item.row), 'the viewer reuses, never re-creates')
    }
  })

  test('the thumbnail label names the product a reviewer clicked', () => {
    const { factory } = fakeUrlFactory()
    const bag = urlsFor([image({ row: 34, part: 'c.png' })], factory)
    const items = buildImageViewerItems(
      [{ row: 34, itemSequence: 'B003', productName: 'Chair' }],
      bag,
    )
    assert.equal(items[0].label, 'View full image for B003 Chair')
  })

  test('a product with no picture is not openable', () => {
    const { factory } = fakeUrlFactory()
    const bag = urlsFor([
      image({ row: 32, part: 'a.png' }),
      image({ row: 34, part: 'c.png' }),
    ], factory)
    const items = buildImageViewerItems(sampleProducts(4), bag)

    assert.deepEqual(items.map(i => i.row), [32, 34], 'stepping never lands on a placeholder')
  })

  test('a nameless product still gets a usable label and no blank fields', () => {
    const { factory } = fakeUrlFactory()
    const bag = urlsFor([image({ row: 40, part: 'x.png' })], factory)
    const items = buildImageViewerItems(
      [{ row: 40, itemSequence: null, productName: null }],
      bag,
    )
    assert.equal(items[0].label, 'View full image for the product on row 40')
    assert.equal(items[0].sequence, '—')
    assert.equal(items[0].name, '—')
  })

  test('a shared picture is openable from each product that uses it', () => {
    const { factory } = fakeUrlFactory()
    const bag = urlsFor([
      image({ row: 32, part: 'shared.png' }),
      image({ row: 33, part: 'shared.png' }),
    ], factory)
    const items = buildImageViewerItems(sampleProducts(2), bag)

    assert.equal(items.length, 2)
    assert.equal(items[0].url, items[1].url, 'one blob')
    assert.notEqual(items[0].row, items[1].row, 'two products')
  })
})

describe('viewerNav', () => {
  test('the first image cannot step back', () => {
    const nav = viewerNav(0, 7)
    assert.equal(nav.canPrev, false)
    assert.equal(nav.prevIndex, null)
    assert.equal(nav.canNext, true)
    assert.equal(nav.nextIndex, 1)
    assert.equal(nav.position, '1 of 7')
  })

  test('the last image cannot step forward', () => {
    const nav = viewerNav(6, 7)
    assert.equal(nav.canPrev, true)
    assert.equal(nav.prevIndex, 5)
    assert.equal(nav.canNext, false)
    assert.equal(nav.nextIndex, null)
    assert.equal(nav.position, '7 of 7')
  })

  test('a middle image steps both ways', () => {
    const nav = viewerNav(5, 12)
    assert.equal(nav.prevIndex, 4)
    assert.equal(nav.nextIndex, 6)
    assert.equal(nav.position, '6 of 12')
  })

  test('a single image steps nowhere', () => {
    const nav = viewerNav(0, 1)
    assert.equal(nav.canPrev, false)
    assert.equal(nav.canNext, false)
    assert.equal(nav.position, '1 of 1')
  })

  test('navigation never wraps around', () => {
    assert.equal(viewerNav(0, 7).prevIndex, null, 'first must not jump to last')
    assert.equal(viewerNav(6, 7).nextIndex, null, 'last must not jump to first')
  })

  test('an out-of-range index permits nothing', () => {
    for (const index of [-1, 7, 99]) {
      const nav = viewerNav(index, 7)
      assert.equal(nav.canPrev, false)
      assert.equal(nav.canNext, false)
      assert.equal(nav.position, '')
    }
    const empty = viewerNav(0, 0)
    assert.equal(empty.canNext, false)
    assert.equal(empty.canPrev, false)
  })
})

// ── Customization images ──────────────────────────────────────────────────────
//
// Column E is the product; column K is what should differ from it. Everything
// here defends the boundary between them at the presentation layer: the two
// never share a map key, never share a count, and never appear in the viewer
// without saying which they are.

describe('customization image URLs', () => {
  test('representative and customization pictures do not overwrite each other', () => {
    const { factory, created } = fakeUrlFactory()
    const bag = urlsFor(
      [image({ row: 32, part: 'rep.png' })],
      factory,
      [customizationImage({ row: 32, part: 'cust.png' })],
    )

    assert.equal(created.length, 2)
    assert.equal(bag.representativeByRow.get(32), created[0])
    assert.deepEqual(bag.customizationByRow.get(32), [created[1]])
    assert.notEqual(bag.representativeByRow.get(32), bag.customizationByRow.get(32)?.[0])
  })

  test('several customization pictures on one row keep their order', () => {
    const { factory, created } = fakeUrlFactory()
    const bag = urlsFor([], factory, [
      customizationImage({ row: 33, part: 'c1.png' }),
      customizationImage({ row: 33, part: 'c2.png' }),
      customizationImage({ row: 33, part: 'c3.png' }),
    ])

    assert.deepEqual(bag.customizationByRow.get(33), created)
    assert.equal(bag.customizationByRow.get(33)?.length, 3)
  })

  test('one photograph used as both roles is a single blob', () => {
    const { factory, created } = fakeUrlFactory()
    const bag = urlsFor(
      [image({ row: 32, part: 'shared.png' })],
      factory,
      [customizationImage({ row: 32, part: 'shared.png' })],
    )

    assert.equal(created.length, 1, 'identity is the media part, not the role')
    assert.equal(bag.representativeByRow.get(32), bag.customizationByRow.get(32)?.[0])
    assert.equal(bag.urls.length, 1)
  })

  test('one photograph illustrating two changes appears twice, from one blob', () => {
    const { factory, created } = fakeUrlFactory()
    const bag = urlsFor([], factory, [
      customizationImage({ row: 32, part: 'same.png' }),
      customizationImage({ row: 32, part: 'same.png' }),
    ])

    assert.equal(created.length, 1)
    assert.deepEqual(bag.customizationByRow.get(32), [created[0], created[0]])
  })

  test('revokeAll releases both roles, exactly once each', () => {
    const { factory, created, revoked } = fakeUrlFactory()
    const bag = urlsFor(
      [image({ row: 32, part: 'rep.png' }), image({ row: 33, part: 'rep2.png' })],
      factory,
      [customizationImage({ row: 32, part: 'c1.png' }), customizationImage({ row: 33, part: 'c2.png' })],
    )

    bag.revokeAll()
    assert.deepEqual(revoked.slice().sort(), created.slice().sort())
    assert.equal(revoked.length, 4)
    assert.equal(new Set(revoked).size, 4)
  })

  test('an unreadable customization format is skipped without disturbing the rest', () => {
    const { factory } = fakeUrlFactory()
    const bag = urlsFor([], factory, [
      customizationImage({ row: 32, part: 'good.png' }),
      customizationImage({ row: 32, part: 'bad.bin', format: 'unknown', mimeType: null }),
    ])

    assert.equal(bag.customizationByRow.get(32)?.length, 1, 'only the readable one gets a URL')
  })

  test('no customization images at all is an empty map, not a crash', () => {
    const { factory } = fakeUrlFactory()
    const bag = urlsFor([image({ row: 32 })], factory)
    assert.equal(bag.customizationByRow.size, 0)
  })
})

describe('describeCustomizationImageCount', () => {
  test('is a plain total, never "x of y"', () => {
    const four = describeCustomizationImageCount([
      customizationImage({ row: 33 }), customizationImage({ row: 33 }),
      customizationImage({ row: 37 }), customizationImage({ row: 41 }),
    ])
    assert.equal(four.count, 4)
    assert.equal(four.label, '4 customization images')
    assert.ok(!four.label.includes(' of '), 'optional images have nothing to be "of"')
  })

  test('counts per IMAGE, not per product and not per media part', () => {
    // Two changes on one product, both illustrated by the same photograph.
    const count = describeCustomizationImageCount([
      customizationImage({ row: 33, part: 'same.png' }),
      customizationImage({ row: 33, part: 'same.png' }),
    ])
    assert.equal(count.count, 2)
    assert.equal(count.label, '2 customization images')
  })

  test('the singular reads correctly', () => {
    assert.equal(describeCustomizationImageCount([customizationImage()]).label, '1 customization image')
  })

  test('none is zero, and the screen decides whether to show it', () => {
    const none = describeCustomizationImageCount([])
    assert.equal(none.count, 0)
    assert.equal(none.label, '0 customization images')
  })

  test('the representative coverage is unaffected by customization images', () => {
    const { factory } = fakeUrlFactory()
    const bag = urlsFor(sampleImages(12), factory, [
      customizationImage({ row: 33, part: 'c1.png' }),
      customizationImage({ row: 37, part: 'c2.png' }),
    ])

    assert.equal(
      describeImageCoverage(sampleProducts(12), bag.representativeByRow).label,
      '12 of 12 representative images matched',
    )
    assert.equal(describeCustomizationImageCount([
      customizationImage({ row: 33 }), customizationImage({ row: 37 }),
    ]).label, '2 customization images')
  })
})

describe('the viewer sequence with both roles', () => {
  const build = () => {
    const { factory } = fakeUrlFactory()
    const bag = urlsFor(sampleImages(3), factory, [
      customizationImage({ row: 33, part: 'c1.png' }),
      customizationImage({ row: 33, part: 'c2.png' }),
      customizationImage({ row: 34, part: 'c3.png' }),
    ])
    return buildImageViewerItems(sampleProducts(3), bag)
  }

  test('a product’s own picture comes first, then its changes', () => {
    assert.deepEqual(build().map(i => [i.row, i.role]), [
      [32, 'representative'],
      [33, 'representative'],
      [33, 'customization'],
      [33, 'customization'],
      [34, 'representative'],
      [34, 'customization'],
    ])
  })

  test('every frame says what it is', () => {
    assert.deepEqual(build().map(i => i.roleLabel), [
      'Representative image',
      'Representative image',
      'Customization image 1 of 2',
      'Customization image 2 of 2',
      'Representative image',
      'Customization image',
    ])
  })

  test('a lone customization image is not numbered "1 of 1"', () => {
    const lone = build().find(i => i.row === 34 && i.role === 'customization')
    assert.equal(lone?.roleLabel, 'Customization image')
  })

  test('the thumbnail names carry the role and the product', () => {
    const items = build()
    assert.equal(items[0].label, 'View full image for B001 Item 1')
    assert.equal(items[2].label, 'View customization image 1 of 2 for B002 Item 2')
    assert.equal(items[5].label, 'View customization image for B003 Item 3')
  })

  test('every item has a distinct key, so a row with several is addressable', () => {
    const keys = build().map(i => i.key)
    assert.equal(new Set(keys).size, keys.length)
    assert.deepEqual(keys.slice(1, 4), [
      'representative-33', 'customization-33-0', 'customization-33-1',
    ])
  })

  test('the sequence and name follow the product, not the role', () => {
    for (const item of build().filter(i => i.row === 33)) {
      assert.equal(item.sequence, 'B002')
      assert.equal(item.name, 'Item 2')
    }
  })

  test('stepping runs across roles without wrapping', () => {
    const items = build()
    assert.equal(items.length, 6)
    assert.equal(viewerNav(0, items.length).canPrev, false)
    assert.equal(viewerNav(2, items.length).prevIndex, 1, 'back into the representative image')
    assert.equal(viewerNav(5, items.length).canNext, false)
  })

  test('a product with a customization image but no representative one still opens', () => {
    // The row is blocking, and the reviewer still needs to see what was asked
    // for in order to fix it.
    const { factory } = fakeUrlFactory()
    const bag = urlsFor([], factory, [customizationImage({ row: 32, part: 'c1.png' })])
    const items = buildImageViewerItems(sampleProducts(1), bag)

    assert.deepEqual(items.map(i => i.role), ['customization'])
    assert.equal(items[0].roleLabel, 'Customization image')
  })
})
