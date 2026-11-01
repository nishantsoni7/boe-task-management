import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  EMPTY_DISPATCH_FORM,
  amountIsValid,
  buildDispatchLedger,
  checkGoods,
  describeDispatchError,
  detailsPayload,
  formFromLot,
  invoiceAddsUp,
  lineShows,
  missingPapers,
  papersText,
  parseDispatchData,
  piecesText,
  plannedLot,
  type DispatchData,
} from './dispatch'

const lot = (no: number, lines: [string, number][], over: Record<string, unknown> = {}) => ({
  id: `lot-${no}`, lot_no: no, status: 'dispatched', planned_on: null, dispatched_on: `2026-10-${10 + no}`,
  lines: lines.map(([item_sequence, quantity]) => ({ item_sequence, quantity })),
  details: null, recorded_by_name: null, files: [], ...over,
})

const raw = (lots: unknown[]) => ({
  found: true,
  can_record: true,
  order: { id: 'order-1', display_number: '0548', status: 'running' },
  items: [
    { item_id: 'a', item_sequence: '1', product_name: 'Lounge chair', quantity: 16, boe_sequence: 1 },
    { item_id: 'b', item_sequence: '2', product_name: 'Dining table', quantity: '6', boe_sequence: 2 },
    { item_id: 'c', item_sequence: '3', product_name: 'Bench', quantity: 6, boe_sequence: null },
    { item_id: 'd', item_sequence: '4', product_name: 'Side table', quantity: 4, boe_sequence: 4 },
  ],
  lots,
})

const parsed = (lots: unknown[]): DispatchData => {
  const data = parseDispatchData(raw(lots))
  assert.ok(data)
  return data
}

describe('reading what the database returned', () => {
  it('turns numbers held as text into numbers, and composes the product code', () => {
    const data = parsed([])
    assert.equal(data.items[1].quantity, 6)
    assert.equal(data.items[0].code, '548-BE0001')
    assert.equal(data.items[2].code, null)
  })
  it('answers null for no Order and for rubbish', () => {
    assert.equal(parseDispatchData({ found: false }), null)
    assert.equal(parseDispatchData(null), null)
    assert.equal(parseDispatchData('nope'), null)
  })
})

describe('dispatched and pending', () => {
  const ledger = buildDispatchLedger(parsed([
    lot(1, [['1', 6], ['2', 4], ['4', 4]]),
    lot(2, [['1', 6]]),
    lot(3, [['1', 1]], { status: 'planned', dispatched_on: null }),
  ]))

  it('counts what left, per product, and leaves a planned lot out', () => {
    assert.deepEqual(
      [...ledger.lines.values()].map(l => [l.dispatched, l.pending, l.state]),
      [[12, 4, 'part'], [4, 2, 'part'], [0, 6, 'none'], [4, 0, 'all']],
    )
  })
  it('totals the pieces', () => {
    assert.equal(ledger.ordered, 32)
    assert.equal(ledger.dispatched, 20)
    assert.equal(ledger.pending, 12)
    assert.equal(ledger.percent, 63)
    assert.equal(ledger.dispatches.length, 2)
  })
  it('finds each line by its id too, which is what the Order page holds', () => {
    assert.equal(ledger.byItemId.get('a'), ledger.lines.get('1'))
    assert.equal(ledger.byItemId.get('d')?.state, 'all')
  })
  it('says which dispatches took each product', () => {
    assert.deepEqual(ledger.lines.get('1')?.chips.map(c => [c.lotNo, c.quantity]), [[1, 6], [2, 6]])
    assert.deepEqual(ledger.lines.get('3')?.chips, [])
  })
  it('counts products for the filters', () => {
    assert.deepEqual(ledger.counts, { all: 4, pending: 3, done: 1 })
    assert.equal(lineShows(ledger.lines.get('4'), 'pending'), false)
    assert.equal(lineShows(ledger.lines.get('4'), 'done'), true)
    assert.equal(lineShows(ledger.lines.get('3'), 'pending'), true)
    assert.equal(lineShows(undefined, 'all'), true)
  })
  it('never shows a negative when a revised PI lowers a quantity below what left', () => {
    const over = buildDispatchLedger(parsed([lot(1, [['4', 6]])]))
    assert.equal(over.lines.get('4')?.pending, 0)
    assert.equal(over.lines.get('4')?.state, 'all')
    assert.equal(over.lines.get('4')?.percent, 100)
  })
  it('keeps fractions of a piece exact', () => {
    const fractions = buildDispatchLedger(parsed([lot(1, [['1', 0.1]]), lot(2, [['1', 0.2]])]))
    assert.equal(fractions.lines.get('1')?.dispatched, 0.3)
  })
  it('counts a line no longer on the PI on no product', () => {
    const gone = buildDispatchLedger(parsed([lot(1, [['99', 3]])]))
    assert.equal(gone.dispatched, 0)
    assert.equal(gone.dispatches.length, 1)
  })
  it('handles an Order with no products', () => {
    const empty = buildDispatchLedger({ ...parsed([]), items: [] })
    assert.equal(empty.percent, 0)
    assert.equal(empty.pending, 0)
  })
  it('finds the planned lot', () => {
    assert.equal(plannedLot(parsed([lot(1, [['1', 1]], { status: 'planned', dispatched_on: null })]))?.lotNo, 1)
    assert.equal(plannedLot(parsed([lot(1, [['1', 1]])])), null)
  })
})

describe('papers', () => {
  const paper = (kind: string) => ({ id: kind, kind, storage_path: `p/${kind}`, file_name: `${kind}.pdf`, mime_type: 'application/pdf', size_bytes: 1 })
  const one = (over: Record<string, unknown>) => parsed([lot(1, [['1', 1]], over)]).lots[0]

  it('flags a missing invoice and e-way bill', () => {
    assert.deepEqual(missingPapers(one({})), ['invoice', 'eway_bill'])
    assert.equal(papersText(one({})).text, 'Invoice and e-way bill missing')
    assert.equal(papersText(one({ files: [paper('invoice')] })).text, 'E-way bill missing')
  })
  it('accepts a typed number, so a paper can follow', () => {
    const typed = one({ details: { record_key: 'k', invoice_number: 'INV-1', eway_bill_number: '3410' } })
    assert.deepEqual(missingPapers(typed), [])
    assert.deepEqual(papersText(typed), { text: 'Details typed, no papers', complete: true })
  })
  it('does not ask for an LR', () => {
    const both = one({ files: [paper('invoice'), paper('eway_bill')] })
    assert.deepEqual(papersText(both), { text: 'All 2 added', complete: true })
  })
  it('counts the dispatches that still need one', () => {
    const data = parsed([lot(1, [['1', 1]]), lot(2, [['1', 1]], { files: [paper('invoice'), paper('eway_bill')] })])
    assert.equal(buildDispatchLedger(data).needPapers, 1)
  })
  it('an unknown kind of paper reads as other', () => {
    assert.equal(one({ files: [paper('photo')] }).files[0].kind, 'other')
  })
})

describe('the form', () => {
  const pendingFour = buildDispatchLedger(parsed([lot(1, [['1', 12]])]))

  it('takes quantities up to what is pending', () => {
    const ok = checkGoods({ 1: '4', 2: '', 3: '0' }, pendingFour)
    assert.deepEqual(ok.lines, [{ item_sequence: '1', quantity: 4 }])
    assert.deepEqual(ok.problems, {})
    assert.equal(ok.pieces, 4)
  })
  it('refuses more than is pending, and what is not a number', () => {
    assert.equal(checkGoods({ 1: '5' }, pendingFour).problems['1'], 'Only 4 pending.')
    assert.equal(checkGoods({ 1: 'six' }, pendingFour).problems['1'], 'Type a number.')
    assert.equal(checkGoods({ 1: '-1' }, pendingFour).problems['1'], 'Type a number.')
    assert.equal(checkGoods({ 1: '1.234' }, pendingFour).problems['1'], 'Type a number.')
  })
  it('accepts amounts with commas, and blank', () => {
    assert.equal(amountIsValid(''), true)
    assert.equal(amountIsValid('1,54,237.50'), true)
    assert.equal(amountIsValid('12.345'), false)
    assert.equal(amountIsValid('ten'), false)
  })
  it('checks the invoice adds up, allowing a rupee of rounding', () => {
    const f = (t: string, g: string, x: string) => ({ ...EMPTY_DISPATCH_FORM, invoiceTaxable: t, invoiceGst: g, invoiceTotal: x })
    assert.equal(invoiceAddsUp(f('1,54,237', '27,763', '1,82,000')), true)
    assert.equal(invoiceAddsUp(f('154237.40', '27763.40', '182000')), true)
    assert.equal(invoiceAddsUp(f('154237', '27763', '190000')), false)
    assert.equal(invoiceAddsUp(f('154237', '', '182000')), null)
  })
  it('sends amounts without commas, and never the dispatch date', () => {
    const payload = detailsPayload({ ...EMPTY_DISPATCH_FORM, dispatchedOn: '2026-11-01', invoiceTotal: '1,82,000', vehicleNumber: 'RJ14' })
    assert.equal(payload.invoice_total, '182000')
    assert.equal(payload.vehicle_number, 'RJ14')
    assert.equal('dispatched_on' in payload, false)
  })
  it('opens an existing dispatch with what it holds', () => {
    const data = parsed([lot(1, [['1', 1]], { details: { record_key: 'k', packages: 6, invoice_total: 100.5 } })])
    const form = formFromLot(data.lots[0])
    assert.equal(form.dispatchedOn, '2026-10-11')
    assert.equal(form.packages, '6')
    assert.equal(form.invoiceTotal, '100.5')
    assert.equal(form.vehicleNumber, '')
  })
  it('says pieces in words', () => {
    assert.equal(piecesText(1), '1 pc')
    assert.equal(piecesText(14), '14 pcs')
  })
  it('puts database refusals in plain words', () => {
    assert.match(describeDispatchError('DISPATCH_QUANTITY_EXCEEDS_ORDER: line 1'), /above what is pending/)
    assert.match(describeDispatchError('ORDER_DISPATCH_FORBIDDEN'), /do not have access/)
    assert.match(describeDispatchError('invalid input syntax for type date'), /Check the dates and amounts/)
  })
})
