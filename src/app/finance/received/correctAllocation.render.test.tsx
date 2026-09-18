/**
 * CORRECT ALLOCATION, ACTUALLY RENDERED.
 *
 * Every screen of the flow is drawn from props by CorrectAllocationBody, so
 * each one is asserted against real markup: the list a person chooses from,
 * the confirmation, the server-confirmed result, a refusal, and the reversed
 * history. The Received Payment detail is rendered too, to pin that the
 * action appears for a holder of finance.allocate_correct and for nobody else.
 *
 * Run:
 *   npx tsx --test src/app/finance/received/correctAllocation.render.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

import { CorrectAllocationBody, CorrectAllocationModal, type CorrectionStep } from './CorrectAllocationModal'
import { DetailsModal } from './ReceivedPaymentsView'
import { buildAllocationLedger, type AllocationLedgerEntry } from '@/lib/finance/allocationCorrection'
import { summarizePaymentAllocations } from '@/lib/finance/paymentAllocations'

const ORDER_524 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PI_019    = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const PAYMENT   = { id: 'pppppppp-pppp-4ppp-8ppp-pppppppppppp', human_payment_id: 'PAY-0042', amount: 750000.55 }

// Rows exactly as payment_allocation_ledger_for_correction() returns them.
const LEDGER: AllocationLedgerEntry[] = buildAllocationLedger([
  { allocation_id: 'alloc-1', status: 'active', allocated_amount: '600000.45', order_id: ORDER_524, order_submission_id: null,
    target_reference: '0524', client_name: 'Hotel Aurum', created_at: '2026-09-10T05:00:00Z',
    reversed_at: null, reversal_reason: null, reversed_by_name: null },
  { allocation_id: 'alloc-2', status: 'active', allocated_amount: '150000.10', order_id: null, order_submission_id: PI_019,
    target_reference: '019', client_name: 'Cafe Verde', created_at: '2026-09-10T06:00:00Z',
    reversed_at: null, reversal_reason: null, reversed_by_name: null },
  { allocation_id: 'alloc-0', status: 'reversed', allocated_amount: '50000.00', order_id: ORDER_524, order_submission_id: null,
    target_reference: '0524', client_name: 'Hotel Aurum', created_at: '2026-09-09T05:00:00Z',
    reversed_at: '2026-09-11T09:30:00Z', reversal_reason: 'Duplicate entry', reversed_by_name: 'Asha Finance' },
])

const noop = () => {}

function body(over: Partial<Parameters<typeof CorrectAllocationBody>[0]> = {}): string {
  return renderToStaticMarkup(createElement(CorrectAllocationBody, {
    payment: PAYMENT,
    entries: LEDGER,
    readable: true,
    selectedId: null,
    reason: '',
    step: 'choose' as CorrectionStep,
    saving: false,
    notice: null,
    result: null,
    canAllocate: true,
    onSelect: noop, onReasonChange: noop, onReview: noop, onBack: noop,
    onConfirm: noop, onAnother: noop, onAllocateFunds: noop, onClose: noop,
    ...over,
  }))
}

describe('choosing the allocation that is wrong', () => {
  const html = body()

  test('shows the Payment ID, the payment amount and the unallocated balance', () => {
    assert.ok(html.includes('PAY-0042'))
    assert.ok(html.includes('₹7,50,000.55'))
    assert.ok(html.includes('Unallocated'))
    assert.ok(html.includes('₹0.00'), 'a fully allocated payment reads zero unallocated')
  })

  test('lists each active allocation with its target, customer and amount', () => {
    for (const text of ['Order 0524', 'Hotel Aurum', '₹6,00,000.45', 'PI Draft 019', 'Cafe Verde', '₹1,50,000.10']) {
      assert.ok(html.includes(text), `missing ${text}`)
    }
  })

  test('says the WHOLE allocation is released, and points on to Allocate Funds', () => {
    assert.ok(html.includes('whole amount'))
    assert.ok(html.includes('part of an allocation cannot be moved on its own'))
    assert.ok(html.includes('Allocate Funds'))
  })

  test('each allocation is a labelled radio in one group — reachable by keyboard', () => {
    const radios = [...html.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map(m => m[0])
    assert.equal(radios.length, 2, 'one radio per ACTIVE allocation; reversed ones are not choosable')
    for (const r of radios) {
      assert.ok(r.includes('name="correct-allocation"'))
      const id = /id="([^"]+)"/.exec(r)?.[1]
      assert.ok(id && html.includes(`for="${id}"`), 'every radio has a label')
    }
    assert.ok(html.includes('<fieldset') && html.includes('<legend'), 'grouped for assistive technology')
  })

  test('the reason box is present and bounded; the review button waits for it', () => {
    assert.ok(/<textarea[^>]*maxLength="500"/i.test(html) || /<textarea[^>]*maxlength="500"/.test(html))
    assert.ok(/<button[^>]*disabled=""[^>]*>Review reversal<\/button>/.test(html), 'disabled until chosen + reason')
  })

  test('reversed history stays visible with actor, time and reason', () => {
    assert.ok(html.includes('Reversed allocations'))
    assert.ok(html.includes('Asha Finance'))
    assert.ok(html.includes('Duplicate entry'))
    assert.ok(html.includes('₹50,000.00'))
  })

  test('mobile: nothing forces a horizontal scroll', () => {
    assert.ok(html.includes('repeat(auto-fit, minmax(120px, 1fr))'), 'the figures wrap')
    assert.ok(html.includes('flex-wrap:wrap'), 'rows and the footer wrap')
    assert.ok(!/width:\s*\d{3,}px/.test(html), 'no fixed pixel widths in the body')
  })

  test('with everything filled in, the review button is enabled', () => {
    const ready = body({ selectedId: 'alloc-1', reason: 'Wrong Order' })
    assert.ok(/<button[^>]*>Review reversal<\/button>/.test(ready))
    assert.ok(!/<button[^>]*disabled=""[^>]*>Review reversal<\/button>/.test(ready))
  })
})

describe('the confirmation', () => {
  const html = body({ step: 'confirm', selectedId: 'alloc-2', reason: 'Belongs to Order 0529' })

  test('names the allocation, the amount released, the balance after, and the reason', () => {
    assert.ok(html.includes('Confirm the reversal'))
    assert.ok(html.includes('PI Draft 019 · Cafe Verde'))
    assert.ok(html.includes('₹1,50,000.10 — the whole allocation'))
    assert.ok(html.includes('Unallocated after'))
    assert.ok(html.includes('Belongs to Order 0529'))
  })

  test('says the payment does not change and history is kept', () => {
    assert.ok(html.includes('The payment itself does not change'))
    assert.ok(html.includes('kept as reversed history'))
  })

  test('offers Back and the reversal itself', () => {
    assert.ok(html.includes('>Back</button>'))
    assert.ok(html.includes('>Reverse allocation</button>'))
  })

  test('while sending, both buttons are disabled and the label says so', () => {
    const sending = body({ step: 'confirm', selectedId: 'alloc-2', reason: 'x', saving: true })
    assert.ok(sending.includes('Reversing…'))
    assert.ok(/<button[^>]*disabled=""[^>]*>Back<\/button>/.test(sending))
  })
})

describe('the result — only after the server answered', () => {
  const result = { amount: '150000.10', target: 'PI Draft 019', balance: '150000.10' }

  test('states what was released, where from, and the new balance', () => {
    const html = body({ step: 'done', result })
    assert.ok(html.includes('role="status"'))
    assert.ok(html.includes('Allocation reversed.'))
    assert.ok(html.includes('₹1,50,000.10'))
    assert.ok(html.includes('PI Draft 019'))
  })

  test('offers Allocate Funds to a holder of finance.allocate', () => {
    assert.ok(/<button[^>]*>Allocate Funds<\/button>/.test(body({ step: 'done', result, canAllocate: true })))
  })

  test('without finance.allocate it explains who can, and offers no button', () => {
    const html = body({ step: 'done', result, canAllocate: false })
    assert.ok(!/<button[^>]*>Allocate Funds<\/button>/.test(html))
    assert.ok(html.includes('ask someone with the Finance permission to allocate payments to use Allocate Funds'))
  })
})

describe('refusals and stale data', () => {
  test('a stale notice is shown on the chooser, as an alert', () => {
    const html = body({ notice: { tone: 'warning', text: 'Someone else has already reversed this allocation. Nothing was changed by you.' } })
    assert.ok(html.includes('role="alert"'))
    assert.ok(html.includes('Nothing was changed by you'))
  })

  test('an incomplete or refused ledger shows NO figures and offers no correction', () => {
    const message = 'You do not have permission to correct payment allocations, so the full allocation list cannot be shown. Nothing was changed.'
    const html = body({ readable: false, entries: [], readError: message })
    assert.ok(html.includes(message), 'the reason is stated')
    assert.ok(!html.includes('type="radio"'), 'nothing can be chosen')
    assert.ok(!html.includes('Unallocated') && !html.includes('Payment amount') && !html.includes('₹'),
      'no calculated total is drawn from a ledger that could not be read whole')
    assert.ok(!html.includes('Review reversal'))
  })

  test('without a specific reason, the unreadable state still says nothing changed', () => {
    const html = body({ readable: false, entries: [] })
    assert.ok(html.includes('Nothing was changed'))
  })

  test('a payment with no active allocation offers nothing to reverse', () => {
    const html = body({ entries: LEDGER.filter(e => e.status === 'reversed') })
    assert.ok(html.includes('no active allocations'))
    assert.ok(!html.includes('Review reversal'))
  })

  test('while loading, it says so', () => {
    assert.ok(body({ entries: null }).includes('Loading'))
  })
})

describe('the modal frame', () => {
  test('is a labelled modal dialog that fits a phone', () => {
    const html = renderToStaticMarkup(createElement(CorrectAllocationModal, {
      payment: PAYMENT,
      // Effects do not run in a static render, so the client is never used.
      supabase: {} as never,
      canAllocate: true,
      onClose: noop, onChanged: noop, onAllocateFunds: noop,
    }))
    assert.ok(html.includes('role="dialog"'))
    assert.ok(html.includes('aria-modal="true"'))
    assert.ok(html.includes('aria-label="Correct Allocation"'))
    assert.ok(html.includes('max-width:calc(100vw - 32px)'))
    assert.ok(html.includes('tabindex="-1"'), 'the dialog takes focus on open')
  })
})

// ── The Received Payment detail ──────────────────────────────────────────────

describe('Correct Allocation on the payment detail', () => {
  const request = {
    id: PAYMENT.id, request_number: 'PR-1', human_payment_id: 'PAY-0042', client_name: 'Hotel Aurum',
    amount: 750000.55, payment_date: '2026-09-10', payment_mode: 'hdfc', received_in: null,
    proof_note: null, order_number: null, order_id: null, order_request_id: null,
    order_request_number: null, sales_note: null, status: 'approved_unlinked', payment_against: null,
    submitted_by: 'u', admin_note: null, created_at: '2026-09-10T05:00:00Z',
  }
  const summary = summarizePaymentAllocations(
    [{ id: PAYMENT.id, amount: '750000.55' }],
    [{ id: 'alloc-1', payment_request_id: PAYMENT.id, allocated_amount: '750000.55', status: 'active', order_id: ORDER_524, order_submission_id: null }],
    { emptyIsConclusive: true, labels: new Map([[ORDER_524, '0524']]) },
  ).get(PAYMENT.id)!

  const render = (onCorrectAllocation?: () => void, allocation = summary) => renderToStaticMarkup(createElement(DetailsModal, {
    request: request as never,
    onClose: noop,
    allocation,
    canOpenLinkedRecord: false,
    onOpenLinked: noop,
    onCorrectAllocation,
  }))

  test('drawn for a holder of finance.allocate_correct — including on a fully allocated payment', () => {
    assert.ok(/<button[^>]*>Correct Allocation<\/button>/.test(render(noop)))
  })

  test('not drawn for anybody else', () => {
    assert.ok(!render(undefined).includes('Correct Allocation'))
  })

  test('not drawn when there is no allocation the reader can see', () => {
    const empty = summarizePaymentAllocations([{ id: PAYMENT.id, amount: '10' }], [], { emptyIsConclusive: true }).get(PAYMENT.id)!
    assert.ok(!render(noop, empty).includes('Correct Allocation'))
  })
})
