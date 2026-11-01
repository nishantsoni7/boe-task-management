import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ProductViewRow } from '@/components/orders/ProductViews'
import { buildDispatchLedger, parseDispatchData, type DispatchData } from '@/lib/orders/dispatch'
import { OrderDispatchLedger, OrderDispatchRecords } from './OrderDispatch'

const row = (seq: string, name: string, quantity: number): ProductViewRow => ({
  // The page's itemSequence is reformatted for display (B001 → BE0001): rows match by id.
  id: `item-${seq}`, itemSequence: `BE000${seq}`, label: name, code: `548-BE000${seq}`,
  image: () => <span>picture</span>, product: name, quantity,
})
const rows = [row('1', 'Lounge chair', 16), row('2', 'Bench', 6)]

const data = (over: Record<string, unknown> = {}, lots?: unknown[]): DispatchData => {
  const parsed = parseDispatchData({
    found: true, can_record: true, order: { id: 'order-1', display_number: '0548', status: 'running' },
    items: [
      { item_id: 'item-1', item_sequence: 'B001', product_name: 'Lounge chair', quantity: 16, boe_sequence: 1 },
      { item_id: 'item-2', item_sequence: 'B002', product_name: 'Bench', quantity: 6, boe_sequence: 2 },
    ],
    lots: lots ?? [{
      id: 'lot-1', lot_no: 1, status: 'dispatched', dispatched_on: '2026-10-14',
      lines: [{ item_sequence: 'B001', quantity: 6 }],
      details: { record_key: 'k', vehicle_number: 'RJ14 GA 4821', invoice_number: 'BOE/26-27/0187', invoice_total: 246000, recorded_at: '2026-10-14T12:00:00Z' },
      recorded_by_name: 'Dhruv',
      files: [{ id: 'f', kind: 'invoice', storage_path: 'p', file_name: 'Invoice.pdf', mime_type: 'application/pdf', size_bytes: 2048 }],
    }],
    ...over,
  })
  assert.ok(parsed)
  return parsed
}

const ledgerHtml = (d: DispatchData, isMobile = false, openLot: string | null = null) => renderToStaticMarkup(
  <OrderDispatchLedger
    rows={rows} ledger={buildDispatchLedger(d)} isMobile={isMobile} animate={false}
    openLot={openLot} onOpen={() => {}} canRecord={d.canRecord} onRecord={() => {}}
  />,
)
const recordsHtml = (d: DispatchData, openLot: string | null = null, isMobile = false, canChangeGoods = false) => renderToStaticMarkup(
  <OrderDispatchRecords
    data={d} ledger={buildDispatchLedger(d)} isMobile={isMobile} openLot={openLot} onToggle={() => {}}
    onRecord={() => {}} onEdit={() => {}} canChangeGoods={canChangeGoods} onChangeGoods={() => {}}
  />,
)

describe('the Dispatch tab', () => {
  it('shows dispatched, pending and status for each product', () => {
    const html = ledgerHtml(data())
    for (const word of ['Dispatched', 'Pending', 'Part dispatched', 'Not dispatched', 'Nothing sent yet', 'Total pieces', '27% dispatched']) {
      assert.ok(html.includes(word), word)
    }
  })
  it('keeps the frozen columns the other tabs keep', () => {
    assert.ok(ledgerHtml(data()).includes('pv-table pv-table--order'))
  })
  it('says which dispatch took a product, in words a screen reader can use', () => {
    const html = ledgerHtml(data())
    assert.ok(html.includes('aria-label="Dispatch 1, 14 Oct, 6 pcs of Lounge chair"'))
    assert.ok(html.includes('14 Oct · 6 pcs'))
  })
  it('marks the products on the open dispatch', () => {
    const html = ledgerHtml(data(), false, 'lot-1')
    assert.ok(html.includes('od-in-open'))
    assert.ok(html.includes('aria-pressed="true"'))
  })
  it('offers the three filters', () => {
    const html = ledgerHtml(data())
    for (const label of ['All', 'Pending', 'All dispatched']) assert.ok(html.includes(label), label)
  })
  it('on a phone, leads with the total and a full-width Record dispatch', () => {
    const html = ledgerHtml(data(), true)
    assert.ok(html.includes('pieces dispatched'))
    assert.ok(html.includes('Record dispatch'))
    assert.ok(html.includes('16 pending') || html.includes('pending'))
  })
  it('offers no Record dispatch to a reader without the permission', () => {
    assert.equal(ledgerHtml(data({ can_record: false }), true).includes('Record dispatch'), false)
  })
  it('finds a product whose code the page shows differently from the workbook', () => {
    assert.ok(ledgerHtml(data()).includes('Part dispatched'), 'BE0001 on the page is B001 in the lot')
  })
})

describe('the Dispatches card', () => {
  it('lists vehicle, invoice, e-way bill, goods and papers', () => {
    const html = recordsHtml(data())
    for (const word of ['RJ14 GA 4821', 'BOE/26-27/0187', '6 pcs', 'E-way bill missing', '1 needs a paper']) {
      assert.ok(html.includes(word), word)
    }
  })
  it('opens to the goods, transport, invoice and papers', () => {
    const html = recordsHtml(data(), 'lot-1')
    for (const word of ['Goods in this dispatch', 'Lounge chair', 'Taxable value', 'View Invoice', 'E-way bill not added', 'Recorded by Dhruv']) {
      assert.ok(html.includes(word), word)
    }
  })
  it('offers adding papers only to someone who may record', () => {
    assert.ok(recordsHtml(data(), 'lot-1').includes('Add papers or details'))
    const readOnly = recordsHtml(data({ can_record: false }), 'lot-1')
    assert.equal(readOnly.includes('Add papers or details'), false)
    assert.equal(readOnly.includes('>Add<'), false)
  })
  it('offers changing goods or the date only to the administrator', () => {
    assert.equal(recordsHtml(data(), 'lot-1').includes('Change goods or date'), false)
    assert.ok(recordsHtml(data(), 'lot-1', false, true).includes('Change goods or date'))
  })
  it('has an empty state that invites the first dispatch', () => {
    const html = recordsHtml(data({}, []))
    assert.ok(html.includes('No dispatch recorded yet'))
    assert.ok(html.includes('All 22 pieces are pending.'))
    assert.ok(html.includes('Record dispatch'))
  })
  it('names a lot marked dispatched in the Payment plan', () => {
    const html = recordsHtml(data({}, [{ id: 'lot-9', lot_no: 1, status: 'dispatched', dispatched_on: '2026-10-14', lines: [{ item_sequence: 'B001', quantity: 1 }], details: null, files: [] }]), 'lot-9')
    assert.ok(html.includes('Marked dispatched in the Payment plan'))
  })
  it('names a line no longer on the PI rather than dropping it', () => {
    const html = recordsHtml(data({}, [{ id: 'lot-9', lot_no: 1, status: 'dispatched', dispatched_on: '2026-10-14', lines: [{ item_sequence: '99', quantity: 1 }], details: null, files: [] }]), 'lot-9')
    assert.ok(html.includes('No longer on the PI'))
  })
  it('on a phone, draws a card with an open button of a good size', () => {
    const html = recordsHtml(data(), null, true)
    assert.ok(html.includes('od-dcard'))
    assert.ok(html.includes('Open dispatch 1'))
  })
})
