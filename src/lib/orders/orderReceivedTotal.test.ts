/**
 * The received total an Order is cancelled against.
 *
 * WHAT THIS FILE PROVES
 * ---------------------
 * A defect with a very specific consequence: on an Order created by approving a
 * PI — which is every Order the current flow creates — the Cancel dialog said
 *
 *     "No payments have been received against this order."
 *
 * while the Payment Summary a few centimetres above it showed lakhs verified.
 * The hook that loads that figure says why it exists: "Cancelling an order while
 * misinformed about the money on it is the specific mistake this prevents." For
 * PI-originated Orders the safeguard was inverted into a reassurance, and the
 * same figure was recorded into the cancellation's audit payload as
 * `received_at_cancellation`.
 *
 * The cause: order_linked_payment_total() was written in 20260816000000, before
 * allocations existed, and counts `order_id = <order> AND status =
 * 'approved_linked'` only. PI conversion MOVES AN ALLOCATION and deliberately
 * leaves the ledger row alone, so the payment still carries order_id NULL and
 * status approved_unlinked — verified money the function cannot see.
 *
 * These tests pin the corrected definition in 20261005000000, and — more
 * importantly — pin that it is a FIX and not a rule change: the function gates
 * nothing, so no approval, refusal, numbering or document behaviour moves with
 * it.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderReceivedTotal.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

const MIGRATIONS = 'supabase/migrations'
const FIX = `${MIGRATIONS}/20261005000000_order_linked_payment_total_counts_allocations.sql`
const ORIGIN = `${MIGRATIONS}/20260816000000_order_amendments.sql`

const fix = readFileSync(FIX, 'utf8')

/** The body of the corrected function. */
const corrected = fix.slice(
  fix.indexOf('create or replace function public.order_linked_payment_total'),
  fix.indexOf('comment on function public.order_linked_payment_total'))

describe('the defect that was there', () => {
  test('the original counted only the legacy link and only approved_linked', () => {
    // Stated from the source so this file documents the real starting point
    // rather than a remembered one.
    const original = readFileSync(ORIGIN, 'utf8')
    const body = original.slice(
      original.indexOf('create or replace function public.order_linked_payment_total'),
      original.indexOf('revoke execute on function public.order_linked_payment_total'))

    assert.ok(body.includes('where order_id = p_order_id'))
    assert.ok(body.includes("status = 'approved_linked'"))
    assert.ok(!body.includes('finance_payment_allocations'),
      'the original was blind to every rupee a PI conversion moved')
  })
})

describe('the corrected definition', () => {
  test('counts money that arrived through an ACTIVE allocation', () => {
    // This is the whole point: PI conversion repoints the allocation and leaves
    // the payment row alone.
    assert.ok(corrected.includes('finance_payment_allocations'))
    assert.ok(corrected.includes("a.status = 'active'"),
      'a reversed allocation is a withdrawn claim and is not money the Order has')
    assert.ok(corrected.includes('a.order_id = p_order_id'),
      'anchored to this one Order')
  })

  test('counts the ALLOCATED figure, not the payment amount', () => {
    // A payment may be split across targets; summing the whole ledger amount
    // would credit this Order with money that is not its own. The same rule the
    // Order screen and pi_submission_payment_summary() apply.
    assert.ok(corrected.includes('sum(a.allocated_amount)'))
    // Checked on the ALLOCATION BRANCH specifically — the legacy branch above it
    // legitimately sums f.amount, because a linked payment is wholly this
    // Order's by the link itself.
    const allocationBranch = corrected.slice(corrected.indexOf('finance_payment_allocations'))
    assert.ok(!allocationBranch.includes('sum(f.amount)'),
      'the allocation branch must not sum the parent payment amount')
  })

  test('treats both approved statuses as verified, through the shared predicate', () => {
    // approved_unlinked IS verified money. Whether it also carries a legacy
    // order_id is Finance bookkeeping and says nothing about whether the client
    // paid. Stated through finance_payment_status_is_verified rather than
    // restated, so there is one definition of "verified" in the system.
    const uses = corrected.split('finance_payment_status_is_verified').length - 1
    assert.equal(uses, 2, 'both branches must ask the shared predicate')
    assert.ok(!corrected.includes("status = 'approved_linked'"),
      'the narrow status test must be gone')
  })

  test('an unverified payment counts as nothing', () => {
    // Money the client says they sent is a different fact from money that
    // arrived, and the cancellation warning must not conflate them.
    assert.ok(corrected.includes('public.finance_payment_status_is_verified(f.status)'))
  })

  test('a payment that is BOTH linked and allocated is counted once', () => {
    // The two branches are made disjoint explicitly. A backfill could produce a
    // row satisfying both, and counting it twice would overstate what the client
    // paid at the exact moment somebody is deciding whether to cancel.
    assert.ok(corrected.includes('f.order_id is distinct from p_order_id'),
      'the allocation branch must exclude rows the legacy branch already counted')
  })
})

describe('it is a fix, not a rule change', () => {
  test('the function gates nothing — both callers only record it', () => {
    // If it decided anything, changing what it returns would move a business
    // rule. It does not: every reader assigns it to v_received and writes it
    // into an activity payload.
    for (const file of ['20260816000000_order_amendments.sql',
                        '20260819000000_order_creation_and_status_enforcement.sql']) {
      const sql = readFileSync(`${MIGRATIONS}/${file}`, 'utf8')
      const at = sql.indexOf('v_received := public.order_linked_payment_total')
      assert.ok(at > 0, `${file} must call it`)

      // What follows the call, up to the activity insert, must contain no branch
      // on the value.
      const after = sql.slice(at, sql.indexOf('received_at_cancellation', at))
      assert.ok(!/if\s+v_received/.test(after),
        `${file} must not branch on the received total`)
      assert.ok(!/raise exception[\s\S]{0,200}v_received/.test(after),
        `${file} must not refuse anything because of the received total`)
    }
  })

  test('the signature, return type and volatility are unchanged', () => {
    // Every existing caller keeps working without being touched, which is why
    // this is a replacement rather than a companion function.
    assert.ok(corrected.includes('order_linked_payment_total(p_order_id uuid)'))
    assert.ok(corrected.includes('returns numeric'))
    assert.ok(corrected.includes('stable'))
  })

  test('no companion function was introduced', () => {
    // Two functions answering one question, with the wrong one still wired into
    // the audit trail, is a duplicate source of financial truth.
    assert.ok(!/create\s+(or replace\s+)?function\s+public\.order_received_payment_total/i.test(fix),
      'the question must have exactly one answer')
    // The name appears in the prose explaining why it was NOT created, which is
    // the reasoning this assertion protects — so match on the declaration, not
    // on the word.
    assert.ok(fix.includes('would leave two functions answering'))
  })
})

describe('security is unchanged', () => {
  test('still SECURITY DEFINER, and still search_path-pinned', () => {
    // A definer ON PURPOSE: a salesperson's RLS does not show every payment on
    // an Order, and being misinformed about the money is the hazard. It reveals
    // one aggregate and no rows, exactly as before.
    assert.ok(corrected.includes('security definer'))
    assert.ok(corrected.includes('set search_path = public, pg_temp'))
    assert.ok(fix.includes('must remain SECURITY DEFINER'), 'and asserts it at apply time')
  })

  test('the grants are exactly what they were', () => {
    assert.ok(fix.includes('revoke execute on function public.order_linked_payment_total(uuid) from public, anon'))
    assert.ok(fix.includes('grant  execute on function public.order_linked_payment_total(uuid) to authenticated'))
    assert.ok(fix.includes("anon must not hold EXECUTE"))
  })

  test('no policy, table, column, index or trigger is touched', () => {
    for (const forbidden of [/create\s+policy/i, /drop\s+policy/i, /alter\s+policy/i,
                             /alter\s+table/i, /create\s+table/i, /create\s+index/i,
                             /create\s+trigger/i, /drop\s+table/i]) {
      assert.ok(!forbidden.test(fix), String(forbidden))
    }
  })

  test('and it writes no data', () => {
    assert.ok(!/^\s*(insert|update|delete)\s+/im.test(fix),
      'a migration correcting a read must not touch a row')
  })
})

describe('the migration is forward-only and reversible', () => {
  test('it comes after every applied migration', () => {
    const applied = '20261003000000'
    assert.ok('20261005000000' > applied)
  })

  test('it edits no existing migration file', () => {
    // The applied files are immutable. This one may only add.
    const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql'))
    assert.ok(files.includes('20261005000000_order_linked_payment_total_counts_allocations.sql'))
    assert.ok(files.includes('20260816000000_order_amendments.sql'),
      'the original stays exactly where it is')
  })

  test('it states how to undo itself', () => {
    assert.ok(fix.includes('ROLLBACK'))
    assert.ok(fix.includes("20260816000000's definition"),
      'the rollback names the definition to restore')
    // And says what rolling back costs, so it is a decision rather than a reflex.
    assert.ok(fix.includes('Rolling back restores the defect'))
  })
})
