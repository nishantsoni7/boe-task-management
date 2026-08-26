/**
 * WHAT A PAYMENT IS FOR, ON A SCREEN — and the defect that made it lie.
 *
 * THE REPRODUCTION, in the product's own words:
 *
 *   A Payment Request targets a Confirmed Order. Finance approves it. Exactly
 *   one active allocation is created and the Order receives the full amount —
 *   and the screen then reads:
 *
 *       status           approved_unlinked
 *       badge            "Order No. Pending"
 *       Order Number     (blank)
 *       Payment Against  "New Order — no order created yet"
 *
 * The financial allocation was right. The display classification was wrong,
 * because every one of those four readers asked a column that stopped being the
 * answer at 20261012000000. This file pins the replacement: the destination is
 * derived from ACTIVE finance_payment_allocations first and PENDING
 * finance_payment_allocation_intents second, and from nothing else.
 *
 * Run:
 *   npx tsx --test src/lib/finance/paymentDestination.test.ts
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DESTINATION_KIND_LABEL,
  DESTINATION_LOADING,
  DESTINATION_NOT_VISIBLE,
  PAYMENT_DESTINATION_COLUMNS,
  PAYMENT_DESTINATIONS_SOURCE,
  PAYMENT_DISPLAY_STATE_META,
  destinationLabel,
  destinationReferenceLabel,
  orderNumberDisplay,
  paymentAgainstDisplay,
  paymentDisplayState,
  readPaymentDestination,
  type PaymentDestinationRow,
} from './paymentDestination'

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

const MIGRATION_114 = 'supabase/migrations/20261014000000_payment_destination_display_modes_and_custody.sql'
const REQUEST_PAGE  = 'src/app/finance/page.tsx'
const RECEIVED_VIEW = 'src/app/finance/received/ReceivedPaymentsView.tsx'

/** One projection row, as PostgREST would return it. */
const row = (over: Partial<PaymentDestinationRow> = {}): PaymentDestinationRow => ({
  payment_request_id: 'pay-1',
  destination_source: 'none',
  destination_kind: 'suspense',
  destination_order_count: 0,
  destination_submission_count: 0,
  destination_customer_count: 0,
  destination_order_id: null,
  destination_order_number: null,
  destination_submission_id: null,
  destination_reference: null,
  ...over,
})

const confirmedOrder = (over: Partial<PaymentDestinationRow> = {}) => readPaymentDestination(row({
  destination_source: 'allocation',
  destination_kind: 'confirmed_order',
  destination_order_count: 1,
  destination_customer_count: 1,
  destination_order_id: 'order-1',
  destination_order_number: 'ORD-A',
  destination_reference: 'ORD-A',
  ...over,
}))

const piDraft = (over: Partial<PaymentDestinationRow> = {}) => readPaymentDestination(row({
  destination_source: 'allocation',
  destination_kind: 'pi_draft',
  destination_submission_count: 1,
  destination_customer_count: 1,
  destination_submission_id: 'sub-1',
  destination_reference: 'PI-4471',
  ...over,
}))

const suspense = () => readPaymentDestination(row())

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE DEFECT
// ═══════════════════════════════════════════════════════════════════════════

describe('the confirmed-order display defect', () => {
  test('an APPROVED Confirmed-Order payment reads "Received Payment", not "Order No. Pending"', () => {
    // The database status is still approved_unlinked — submit_payment_request
    // leaves order_id NULL for every destination, so the derive_target trigger
    // classifies it 'unallocated' and approval takes the else-branch. What
    // changed is that the badge no longer reads that column.
    const state = paymentDisplayState('approved_unlinked', confirmedOrder())
    assert.equal(state, 'received')
    assert.equal(PAYMENT_DISPLAY_STATE_META[state].label, 'Received Payment')
  })

  test('the Order Number is the allocated Order\'s, never blank', () => {
    assert.deepEqual(orderNumberDisplay(confirmedOrder()), { value: 'ORD-A', muted: false })
  })

  test('"Payment Against" names the Order, and never says "New Order"', () => {
    const against = paymentAgainstDisplay(confirmedOrder())
    assert.equal(against, 'Confirmed Order · ORD-A')
    assert.equal(/New Order/.test(against), false)
  })

  test('the phrase itself is gone from every surface that printed it', () => {
    for (const file of [REQUEST_PAGE, RECEIVED_VIEW]) {
      const src = read(file)
      assert.equal(src.includes('New Order — no order created yet'), false,
        `${file} must not be able to print "New Order — no order created yet"`)
      assert.equal(src.includes("label: 'Order No. Pending'"), false,
        `${file} must not define an "Order No. Pending" badge`)
    }
    // And no label anywhere in the shared palette says it.
    for (const meta of Object.values(PAYMENT_DISPLAY_STATE_META)) {
      assert.equal(/Order No\. Pending/.test(meta.label), false)
    }
  })

  test('a PENDING Confirmed-Order request shows the Order BEFORE approval', () => {
    // Its destination comes from the pending INTENT — which is exactly what the
    // form promised when somebody picked the Order.
    const pending = confirmedOrder({ destination_source: 'intent' })
    assert.equal(paymentDisplayState('pending_approval', pending), 'pending')
    assert.equal(paymentAgainstDisplay(pending), 'Confirmed Order · ORD-A')
    assert.deepEqual(orderNumberDisplay(pending), { value: 'ORD-A', muted: false })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. EVERY DESTINATION, SAID CORRECTLY
// ═══════════════════════════════════════════════════════════════════════════

describe('the four destination kinds', () => {
  test('a PI Draft names itself by its own reference and carries no Order', () => {
    assert.equal(destinationLabel(piDraft()), 'PI Draft')
    assert.equal(destinationReferenceLabel(piDraft()), 'PI-4471')
    assert.deepEqual(orderNumberDisplay(piDraft()), { value: 'No Order yet — PI Draft', muted: true })
  })

  test('Suspense is a real answer, not a missing one', () => {
    assert.equal(destinationLabel(suspense()), 'Suspense / Unallocated')
    assert.equal(destinationReferenceLabel(suspense()), null)
    assert.equal(paymentAgainstDisplay(suspense()), 'Suspense / Unallocated')
    assert.deepEqual(orderNumberDisplay(suspense()), { value: 'Not allocated', muted: true })
  })

  test('a VERIFIED payment with no allocation reads unallocated, not linked', () => {
    const state = paymentDisplayState('approved_linked', suspense())
    assert.equal(state, 'received_unallocated')
    assert.equal(PAYMENT_DISPLAY_STATE_META[state].label, 'Received — Unallocated')
  })

  test('a MIXED destination is summarised, never sampled', () => {
    // THE MISLEADING SINGLE ORDER NUMBER. A payment split across two Orders has
    // no single Order Number, and printing whichever one sorted first would be a
    // statement about one part of it presented as the whole.
    const mixed = readPaymentDestination(row({
      destination_source: 'allocation',
      destination_kind: 'mixed',
      destination_order_count: 2,
      destination_submission_count: 1,
      destination_customer_count: 3,
    }))
    assert.equal(destinationLabel(mixed), 'Multiple destinations')
    assert.equal(destinationReferenceLabel(mixed), '2 Orders · 1 PI Draft')
    assert.deepEqual(orderNumberDisplay(mixed), { value: '2 Orders', muted: true })
    assert.equal(mixed.orderNumber, null, 'the projection must withhold the identifier')
    assert.equal(mixed.orderId, null)
  })

  test('a mixed destination that is one Order plus one PI says so', () => {
    const mixed = readPaymentDestination(row({
      destination_source: 'allocation',
      destination_kind: 'mixed',
      destination_order_count: 1,
      destination_submission_count: 1,
    }))
    assert.equal(destinationReferenceLabel(mixed), '1 Order · 1 PI Draft')
    assert.deepEqual(orderNumberDisplay(mixed), { value: '1 Order (split payment)', muted: true })
  })

  test('a record the reader may not open says so, and is not read as "no destination"', () => {
    const hidden = confirmedOrder({ destination_order_number: null, destination_reference: null })
    assert.equal(destinationReferenceLabel(hidden), DESTINATION_NOT_VISIBLE)
    assert.deepEqual(orderNumberDisplay(hidden), { value: DESTINATION_NOT_VISIBLE, muted: true })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. UNDEFINED IS NOT NULL
// ═══════════════════════════════════════════════════════════════════════════

describe('not-read-back-yet is not the same as no destination', () => {
  test('undefined reads as loading, everywhere', () => {
    assert.equal(destinationLabel(undefined), DESTINATION_LOADING)
    assert.equal(paymentAgainstDisplay(undefined), DESTINATION_LOADING)
    assert.deepEqual(orderNumberDisplay(undefined), { value: DESTINATION_LOADING, muted: true })
  })

  test('and a verified payment defaults to unallocated rather than claiming a link', () => {
    // The conservative direction: never tell somebody money is attached to an
    // Order before anything has confirmed that it is.
    assert.equal(paymentDisplayState('approved_linked', undefined), 'received_unallocated')
  })

  test('null means the projection answered and there is nothing attached', () => {
    assert.equal(destinationLabel(null), DESTINATION_KIND_LABEL.suspense)
    assert.equal(paymentDisplayState('approved_unlinked', null), 'received_unallocated')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. THE THREE REQUEST-STAGE STATES ARE UNCHANGED
// ═══════════════════════════════════════════════════════════════════════════

describe('verification and attribution stay two axes', () => {
  test('a rejected or unverified payment is classified by its status alone', () => {
    assert.equal(paymentDisplayState('rejected', confirmedOrder()), 'rejected')
    assert.equal(paymentDisplayState('needs_clarification', confirmedOrder()), 'needs_clarification')
    assert.equal(paymentDisplayState('pending_approval', confirmedOrder()), 'pending')
    assert.equal(paymentDisplayState(null, confirmedOrder()), 'pending')
  })

  test('a pending payment with a real allocation is still pending', () => {
    // record_payment_with_allocations allocates as it records. The money is
    // attached; Finance has not yet said it arrived. Two facts, two axes.
    assert.equal(paymentDisplayState('pending_approval', confirmedOrder()), 'pending')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. THE PROJECTION, AND WHAT IT MAY NOT BE
// ═══════════════════════════════════════════════════════════════════════════

describe('the destination projection', () => {
  test('the application selects exactly the columns the view exposes', () => {
    const sql = read(MIGRATION_114)
    for (const column of PAYMENT_DESTINATION_COLUMNS) {
      assert.ok(sql.includes(column), `the view must expose ${column}`)
    }
    assert.ok(sql.includes(`create or replace view public.${PAYMENT_DESTINATIONS_SOURCE}`),
      'the view name the application reads must be the one the migration creates')
  })

  test('it derives from the two ledgers and from NO provenance column', () => {
    const sql = read(MIGRATION_114)
    const from = sql.indexOf(`create or replace view public.${PAYMENT_DESTINATIONS_SOURCE}`)
    const to   = sql.indexOf('comment on view public.finance_payment_destinations')
    assert.ok(from > -1 && to > from, 'the view definition could not be located')
    const view = sql.slice(from, to)

    assert.ok(view.includes('finance_payment_allocations'), 'active allocations decide an approved payment')
    assert.ok(view.includes('finance_payment_allocation_intents'), 'pending intents decide an unapproved one')
    for (const retired of ['payment_target_type', 'payment_against', 'order_request_id']) {
      assert.equal(new RegExp(`\\b${retired}\\b`).test(view), false,
        `the view must not read ${retired} — that column is the source of the defect`)
    }
    // ALLOCATIONS WIN. The intent branch is excluded whenever anything is
    // allocated, so a converted intent can never resurrect a destination the
    // ledger has withdrawn.
    assert.ok(/not exists \(\s*select 1\s*from public\.finance_payment_allocations/.test(view),
      'pending intents must count only while nothing is allocated')
  })

  test('it carries no money, and the migration refuses a version that does', () => {
    for (const column of PAYMENT_DESTINATION_COLUMNS) {
      assert.equal(/(amount|total|balance|sum|value|rupee|percent)/.test(column), false,
        `${column} names a figure — the ledger decides money, this names records`)
    }
    assert.ok(read(MIGRATION_114).includes('grew a money column'),
      'the migration must assert at apply time that no money column appeared')
  })

  test('finance_received_payments is NOT redefined, so its financial columns are provably untouched', () => {
    const sql = read(MIGRATION_114)
    assert.equal(/create or replace view public\.finance_received_payments/.test(sql), false,
      '20261014000000 must not touch the financial projection at all')
    assert.ok(sql.includes('must not read a display object'),
      'and must assert that nothing else started making it read one')
  })

  test('approval is not redefined either — provenance is never written from an allocation', () => {
    const sql = read(MIGRATION_114)
    assert.equal(/create or replace function public\.approve_finance_payment_request/.test(sql), false,
      'approval keeps 20261013000000\'s body: it converts intents and writes no linkage from the ledger')
    assert.ok(sql.includes('WHY PROVENANCE IS NOT WRITTEN AT APPROVAL'),
      'the decision must be recorded where the next person will look for it')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. THE SURFACES READ THE PROJECTION, NOT THE COLUMNS
// ═══════════════════════════════════════════════════════════════════════════

describe('every surface reads one definition', () => {
  test('the Payment Requests list reads destinations once per PAGE, not once per row', () => {
    const src = read(REQUEST_PAGE)
    assert.ok(src.includes('loadPaymentDestinations(supabase, mapped.map(m => m.id))'),
      'the list must fill in the whole page in one request')
    assert.equal(/rows\.map\([^)]*loadPaymentDestination/.test(src), false,
      'and never per row')
  })

  test('no surface derives an Order Number from the payment row any more', () => {
    for (const file of [REQUEST_PAGE, RECEIVED_VIEW]) {
      const src = read(file)
      assert.equal(/label="Order Number"\s+value=\{r\.order_number/.test(src), false,
        `${file} must read the Order Number from the allocation ledger`)
    }
  })

  test('both pages resolve their badge through the shared function', () => {
    for (const file of [REQUEST_PAGE, RECEIVED_VIEW]) {
      assert.ok(read(file).includes('paymentDisplayStateMeta(status, destination)'),
        `${file} must decide its badge from the status AND the destination`)
    }
  })
})
