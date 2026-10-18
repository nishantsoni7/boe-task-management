/**
 * ALLOCATED AGAINST, ACTUALLY RENDERED — desktop row, mobile card, detail.
 *
 * The owner's review of the live Confirmed Payments screen (2026-09-18):
 * Initiated By and Approved By leave the list (they stay in the payment's
 * details and Activity), and every payment says, in the row, which Orders and
 * PI Drafts its money went to and how much went to each.
 *
 * Asserted against real markup from the exported table, cards, cell and
 * details modal, with rows shaped exactly as received_payment_allocation_
 * targets() returns them.
 *
 * Run:
 *   npx tsx --test src/app/finance/received/allocatedAgainst.render.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'

import {
  AllocatedAgainstCell,
  ConfirmedPaymentsList,
  DetailsModal,
  ReceivedPaymentsCards,
  ReceivedPaymentsTable,
} from './ReceivedPaymentsView'
import {
  buildAllocatedAgainst,
  type AllocatedAgainstView,
  type AllocationTargetRow,
} from '@/lib/finance/allocatedAgainst'
import { summarizePaymentAllocations } from '@/lib/finance/paymentAllocations'
import { AllocationDetailsPopup } from './receivedPaymentsAllocationPopup'

const noop = () => {}

const ORDER_425 = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000425'
const ORDER_431 = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000431'
const PI_HOTEL  = 'cccccccc-cccc-4ccc-8ccc-000000000001'
const LONG_WORKBOOK = 'Grand Palace Hotel & Resorts Banquet Wing Renovation Phase II Final Revised.xlsx'

function payment(id: string, amount: number, status: 'zero' | 'partial' | 'full' | 'over') {
  return {
    id, request_number: `PR-${id}`, human_payment_id: `P-AA-${id}`, client_name: 'Hotel ABC',
    amount, payment_date: '2026-09-10', payment_mode: 'hdfc', received_in: null,
    collected_by_user_id: null, collected_from_text: null, handed_over_to_user_id: null,
    handed_over_at: null, collection_handover_note: null,
    proof_note: null, order_number: '0999', order_id: null, order_request_id: null,
    order_request_number: null,
    // The obsolete single-Order field: set to a WRONG number on purpose, so a
    // cell that read it would be caught.
    allocated_order_id: ORDER_431, allocated_order_number: '0999', is_order_allocated: true,
    order_allocated_total: null, pi_allocated_total: null, allocated_total: null, attributed_total: null,
    available_balance: null, active_allocation_count: null, attribution_complete: null,
    is_linked_to_order: null, is_linked_to_pi: null, is_available_to_allocate: null,
    sales_note: null, status: 'approved_unlinked', payment_against: 'order',
    submitted_by: 'u-1', submitted_by_name: 'Initiator Ishaan Kumar',
    approved_by_name: 'Approver Asha Verma',
    admin_note: null, created_at: '2026-09-10T05:00:00Z',
    // THE RLS-LIMITED STATUS, deliberately WRONG on every row: the badge must
    // come from the complete read, never from this field.
    confirmed_allocation_status: status === 'zero' ? 'full' : 'zero',
    // The complete computed status the filter and Allocate Funds use.
    complete_allocation_status: status,
  }
}

const target = (pay: string, id: string, type: 'order' | 'pi_draft', ref: string | null, amount: string,
  reserved: string | null = null): AllocationTargetRow => ({
  payment_request_id: pay, allocation_id: `${pay}-${id}-${amount}`, target_type: type, target_id: id,
  target_reference: ref, reserved_order_number: reserved, allocated_amount: amount,
})

// Five payments covering the list's cases.
const ROWS = [
  payment('0001', 500000, 'zero'),                // not allocated
  payment('0002', 500000, 'full'),                // one Order
  payment('0003', 400000, 'full'),                // mixed, three destinations
  payment('0004', 750000, 'partial'),             // partial
  payment('0005', 100000, 'over'),                // over-allocated
]
const TARGETS: AllocationTargetRow[] = [
  target('0002', ORDER_425, 'order', '0425', '500000.00'),
  target('0003', ORDER_425, 'order', '0425', '150000.00'),
  target('0003', ORDER_425, 'order', '0425', '50000.00'),  // duplicate → combined 2,00,000
  target('0003', ORDER_431, 'order', '0431', '150000.00'),
  target('0003', PI_HOTEL, 'pi_draft', 'Hotel ABC.xlsx', '50000.00'),
  target('0004', PI_HOTEL, 'pi_draft', LONG_WORKBOOK, '650000.00', null),
  target('0005', ORDER_425, 'order', '0425', '80000.00'),
  target('0005', ORDER_431, 'order', '0431', '30000.00'),
]

const viewFor = (r: { id: string; amount: number }): AllocatedAgainstView =>
  buildAllocatedAgainst(r, TARGETS, { covered: true })

/** Only Order 0425 is openable for this reader. */
const hrefFor = (type: 'order' | 'pi_draft', id: string) =>
  type === 'order' && id === ORDER_425 ? `/orders/${id}` : null

const common = {
  rows: ROWS as never,
  canAllocate: true,
  highlightId: null,
  onView: noop,
  onAllocateFunds: noop,
  canDeleteRow: () => true,
  onDelete: noop,
  allocatedAgainst: viewFor as never,
  targetHref: hrefFor,
  onOpenTarget: noop,
  onShowAllocation: noop,
}

const desktop = renderToStaticMarkup(createElement(ReceivedPaymentsTable, { ...common, canManage: true, onEdit: noop }))
const mobile = renderToStaticMarkup(createElement(ReceivedPaymentsCards, { ...common, canManage: true, onEdit: noop }))
const cell = (view: AllocatedAgainstView, fill = false) =>
  renderToStaticMarkup(createElement(AllocatedAgainstCell, { view, hrefFor, onOpen: noop, fill }))
/** The allocation popup the Allocation status pill opens, for one payment. */
const popup = (id: string, onAllocate?: () => void) => {
  const r = ROWS.find(p => p.id === id)!
  return renderToStaticMarkup(createElement(AllocationDetailsPopup, {
    payment: r as never, view: viewFor(r), hrefFor, onOpenTarget: noop, onAllocate, onClose: noop,
  }))
}

/** The markup of one desktop row / mobile card, by its Payment ID. */
function rowOf(html: string, id: string): string {
  const start = html.indexOf(`id="payment-row-${id}"`)
  assert.ok(start >= 0, `row ${id} rendered`)
  const next = html.indexOf('id="payment-row-', start + 1)
  return html.slice(start, next < 0 ? undefined : next)
}

// ── The table ────────────────────────────────────────────────────────────────

describe('desktop: the owner\'s columns (2026-10)', () => {
  test('headers in the required order', () => {
    // Payment ID, Amount, Client, Received on, Payment mode, Added by,
    // Allocation status, Actions (named for screen readers only).
    const headers = [...desktop.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map(m => m[1].replace(/<[^>]+>/g, ''))
    assert.deepEqual(headers, ['Payment ID', 'Amount', 'Client', 'Received on', 'Payment mode', 'Added by', 'Allocation status', 'Actions'])
  })

  test('Added by names who recorded it; Approved By stays out of the row', () => {
    const r = rowOf(desktop, '0002')
    assert.ok(r.includes('Initiator Ishaan Kumar'), 'the recorder is the Added by column')
    for (const gone of ['Approver', 'Asha']) assert.ok(!desktop.includes(gone), `${gone} must not be in the table`)
  })

  test('every row keeps its Payment ID, amount, client, date, mode, status pill and icon actions', () => {
    const r = rowOf(desktop, '0002')
    for (const text of ['P-AA-0002', '₹5,00,000.00', 'Hotel ABC', '10 Sept 2026', 'HDFC', 'Fully Allocated',
      'aria-label="View details for P-AA-0002"', 'aria-label="Edit P-AA-0002"']) {
      assert.ok(r.includes(text), text)
    }
    assert.ok(!r.includes('More actions'), 'no menu: every action is its own icon')
  })

  test('where the money went is no longer a row column', () => {
    const r = rowOf(desktop, '0003')
    assert.ok(!r.includes('Order 0425'), 'the targets live in the allocation popup')
    assert.ok(!r.includes('0999'), 'the obsolete single-Order field is not read')
  })

  test('fixed widths sized to the data; Client takes the rest; no sideways scroll', () => {
    assert.ok(!/<table[^>]*min-width/.test(desktop), 'the table sets no minWidth')
    const widths = [...desktop.matchAll(/<th style="([^"]*)"[^>]*>(.*?)<\/th>/g)]
      .map(m => [m[2].replace(/<[^>]+>/g, ''), /(?:^|;)width:([^;"]+)/.exec(m[1])?.[1] ?? 'auto'])
    assert.deepEqual(widths, [
      ['Payment ID', '100px'], ['Amount', '128px'], ['Client', 'auto'], ['Received on', '100px'],
      ['Payment mode', '104px'], ['Added by', '132px'], ['Allocation status', '156px'], ['Actions', '140px'],
    ])
    assert.ok(desktop.includes('class="fin-table"'), 'and the table lays out by them (.fin-table is table-layout: fixed)')
  })
})

describe('every allocation case, in the allocation popup', () => {
  test('no active allocation → not allocated, and the whole amount is left', () => {
    const p = popup('0001')
    assert.ok(p.includes('Not allocated to any Order or PI Draft yet.'))
    assert.ok(/Left to allocate<\/div><div[^>]*>₹5,00,000\.00/.test(p))
    assert.ok(!p.includes('0999'), 'the obsolete single-Order field is not read')
  })

  test('one Order, with its amount', () => {
    const p = popup('0002')
    assert.ok(/Order 0425<\/a>.*₹5,00,000\.00/.test(p))
    assert.ok(/Left to allocate<\/div><div[^>]*>₹0\.00/.test(p), 'fully allocated: nothing left')
  })

  test('mixed Orders and a PI Draft: each target on its own line with its own amount, duplicates combined', () => {
    const p = popup('0003')
    assert.equal([...p.matchAll(/<li /g)].length, 3, 'one line per destination')
    assert.ok(/Order 0425<\/a>.*?₹2,00,000\.00/.test(p), 'the two 0425 rows summed')
    assert.ok(/Order 0431<\/span>.*?₹1,50,000\.00/.test(p))
    assert.ok(/PI Draft · Hotel ABC\.xlsx<\/span>.*?₹50,000\.00/.test(p))
    assert.ok(/Allocated<\/div><div[^>]*>₹4,00,000\.00/.test(p))
  })

  test('partial: what is left is stated; the Partially Allocated pill stays', () => {
    const p = popup('0004')
    assert.ok(/Left to allocate<\/div><div[^>]*>₹1,00,000\.00/.test(p))
    assert.ok(p.includes('Partially Allocated'))
  })

  test('over-allocated: every target shown, the flag and the red pill kept', () => {
    const p = popup('0005')
    assert.ok(p.includes('Order 0425') && p.includes('Order 0431'))
    assert.ok(p.includes('₹80,000.00') && p.includes('₹30,000.00'))
    assert.ok(p.includes('flagged for Admin review'))
    assert.ok(p.includes('fin-pill--over'))
  })

  test('Allocate is offered only when the caller passes it (permission and money left)', () => {
    assert.ok(popup('0004', noop).includes('Allocate Funds'))
    assert.ok(!popup('0002').includes('Allocate Funds'))
  })
})

describe('links: only where the reader may already open the record', () => {
  test('an openable Order is a link; the others are text, not broken links', () => {
    const p = popup('0003')
    assert.ok(p.includes(`href="/orders/${ORDER_425}"`))
    assert.ok(!p.includes(ORDER_431), 'no href, id or door for an Order this reader cannot open')
    assert.ok(!p.includes(PI_HOTEL))
  })

  test('nothing in the popup edits or reverses an allocation', () => {
    const p = popup('0003', noop)
    assert.ok(!/Reverse|Correct Allocation|>Edit</.test(p))
  })
})

// ── The cards ────────────────────────────────────────────────────────────────

describe('mobile cards', () => {
  test('Approved by is not on the card', () => {
    for (const gone of ['Approved by', 'Asha']) {
      assert.ok(!mobile.includes(gone), gone)
    }
  })

  test('Allocated Against is shown, stacked, with each amount', () => {
    const c = rowOf(mobile, '0003')
    assert.ok(c.includes('Allocated Against'))
    assert.ok(c.includes('3 allocations'))
    assert.equal([...c.matchAll(/role="listitem"/g)].length, 3)
    for (const amount of ['₹2,00,000.00', '₹1,50,000.00', '₹50,000.00']) assert.ok(c.includes(amount), amount)
  })

  test('Payment ID, amount, date, mode, status and permitted actions remain', () => {
    const c = rowOf(mobile, '0004')
    // The card offers the SAME actions as the table row, from the same
    // component: every action an icon with its own name.
    for (const text of ['P-AA-0004', '₹7,50,000.00', 'Partially Allocated',
      'aria-label="Allocate Funds for P-AA-0004"', 'aria-label="Edit P-AA-0004"']) {
      assert.ok(c.includes(text), text)
    }
  })

  test('a long workbook name truncates visually and keeps its full text for assistive tech and hover', () => {
    const c = rowOf(mobile, '0004')
    assert.ok(c.includes(`title="PI Draft · ${LONG_WORKBOOK.replace('&', '&amp;')}"`), 'tooltip carries the full name')
    assert.ok(c.includes(`aria-label="Allocated Against: PI Draft · ${LONG_WORKBOOK.replace('&', '&amp;')}`), 'accessible name carries it too')
    assert.ok(c.includes('text-overflow:ellipsis'))
    assert.ok(c.includes('max-width:100%'), 'the card cell takes the card width, never more')
    assert.ok(!/width:\s*\d{3,}px/.test(c.slice(c.indexOf('role="list"'))), 'no fixed pixel width inside the card cell')
  })
})

// ── The states that must never read as "Not allocated" ───────────────────────

describe('the Allocation Status badge is the complete answer, desktop and mobile alike', () => {
  const badgeOf = (html: string, id: string) => {
    const r = rowOf(html, id)
    return ['Zero Allocated', 'Partially Allocated', 'Fully Allocated', 'Over-allocated'].find(l => r.includes(l)) ?? null
  }

  test('each row’s badge matches its complete destinations, not the RLS-limited field', () => {
    const expected: Record<string, string> = {
      '0001': 'Zero Allocated', '0002': 'Fully Allocated', '0003': 'Fully Allocated',
      '0004': 'Partially Allocated', '0005': 'Over-allocated',
    }
    for (const [id, label] of Object.entries(expected)) {
      assert.equal(badgeOf(desktop, id), label, `desktop ${id}`)
      assert.equal(badgeOf(mobile, id), label, `mobile ${id}`)
    }
  })

  test('no confident status while the complete read is loading or failed', () => {
    const loading = renderToStaticMarkup(createElement(ReceivedPaymentsTable, {
      ...common, canManage: true, onEdit: noop,
      allocatedAgainst: (() => ({ kind: 'loading' })) as never,
    }))
    const failed = renderToStaticMarkup(createElement(ReceivedPaymentsCards, {
      ...common, canManage: true, onEdit: noop, allocatedAgainst: (() => ({ kind: 'unavailable' })) as never,
    }))
    for (const label of ['Zero Allocated', 'Partially Allocated', 'Fully Allocated', 'Over-allocated']) {
      assert.ok(!loading.includes(label) && !failed.includes(label), label)
    }
    assert.ok(loading.includes('aria-label="Loading allocation status"'))
    assert.ok(failed.includes('Status unavailable'))
  })

  test('before its container is measured, the list draws the cards, which fit any width', () => {
    const html = renderToStaticMarkup(createElement(ConfirmedPaymentsList, { ...common, canManage: true, onEdit: noop }))
    assert.ok(html.includes('data-confirmed-list="cards"'))
    assert.ok(!html.includes('<table'))
  })
})

describe('the cell states', () => {
  test('unavailable says so, and is not Not allocated', () => {
    const html = cell({ kind: 'unavailable' })
    assert.ok(html.includes('Allocation details unavailable'))
    assert.ok(!html.includes('Not allocated') && !html.includes('₹0'))
  })

  test('loading draws no figure and no Not allocated', () => {
    const html = cell({ kind: 'loading' })
    assert.ok(!html.includes('Not allocated') && !html.includes('₹'))
  })

  test('the link stops the row click from also opening the payment', () => {
    // Asserted on source: a static render carries no handlers.
    const src = readFileSync('src/app/finance/received/ReceivedPaymentsView.tsx', 'utf8')
    const body = src.slice(src.indexOf('export function AllocatedAgainstCell'), src.indexOf('// THE ROW FIGURES ARE GONE'))
    assert.ok(/onClick=\{event => \{[\s\S]{0,200}?event\.stopPropagation\(\)[\s\S]{0,400}?event\.preventDefault\(\)[\s\S]{0,40}?onOpen\(href\)/.test(body))
    // A modified click (new tab / window) is left to the browser: it is a real link.
    assert.ok(/if \(event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey \|\| event\.button !== 0\) return/.test(body))
    for (const call of ['.from(', '.rpc(', 'fetch(']) assert.ok(!body.includes(call), `the cell issues no ${call}`)
  })
})

// ── Both audit facts are still available in the payment ──────────────────────

describe('Initiated By and Approved By remain in the payment details', () => {
  const r = payment('0002', 500000, 'full')
  const allocation = summarizePaymentAllocations([{ id: r.id, amount: '500000' }], [], { emptyIsConclusive: true }).get(r.id)!
  const html = renderToStaticMarkup(createElement(DetailsModal, {
    request: r as never, onClose: noop, allocation, canOpenLinkedRecord: false, onOpenLinked: noop,
  }))

  test('Approved By is in Payment Details', () => {
    assert.ok(html.includes('Approved By'))
    assert.ok(html.includes('Approver Asha Verma'))
  })

  test('the initiator is in Activity, which the modal still mounts', () => {
    const src = readFileSync('src/app/finance/received/ReceivedPaymentsView.tsx', 'utf8')
    const modal = src.slice(src.indexOf('export function DetailsModal'), src.indexOf('function EditPaymentModal'))
    assert.ok(modal.includes('<PaymentRequestActivity'), 'Activity — whose submission event names the initiator — is mounted')
    assert.ok(src.includes('submitted_by_name, approved_by_name,'), 'both are still selected by the list query')
  })
})
