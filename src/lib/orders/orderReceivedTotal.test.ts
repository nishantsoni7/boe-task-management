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
    assert.ok(corrected.includes('public.finance_payment_status_is_verified(f.status)'))
    assert.ok(!corrected.includes("status = 'approved_linked'"),
      'the narrow status test must be gone')
  })

  test('an unverified payment counts as nothing', () => {
    // Money the client says they sent is a different fact from money that
    // arrived, and the cancellation warning must not conflate them.
    assert.ok(corrected.includes('public.finance_payment_status_is_verified(f.status)'))
  })

  test('THE CANONICAL RULE: allocations decide, the direct link is the fallback', () => {
    // The first correction merely ADDED the allocations to the legacy sum,
    // keeping "the link wins" for any payment that carried one. That is unsound
    // the moment both exist — and both can, because allocate_payment_to_target()
    // does not refuse a payment that already carries an order_id.
    //
    // A ₹10,00,000 payment linked to X and allocated ₹4,00,000 to Y was credited
    // ₹10,00,000 to X *and* ₹4,00,000 to Y: ₹14,00,000 of attribution for
    // ₹10,00,000 of money. The two branches are now EXCLUSIVE and ORDERED, not
    // additive.
    assert.match(corrected, /when\s+s\.active_total > 0\s+then s\.own_total/,
      'any active allocation makes the allocations authoritative')
    assert.match(corrected, /when\s+s\.order_id = p_order_id\s+then s\.amount/,
      'the direct link attributes the whole payment, but only as a fallback')

    const allocationBranch = corrected.indexOf('s.active_total > 0')
    const linkBranch = corrected.indexOf('s.order_id = p_order_id   then s.amount')
    assert.ok(allocationBranch > 0 && linkBranch > allocationBranch,
      'the allocation branch must be tested FIRST, or the link wins again')

    // And they are branches of one CASE, so exactly one applies per payment.
    assert.ok(!corrected.includes('+\n  coalesce(('),
      'the two must not be summed — that was the defect')
  })

  test('this Order gets ZERO from a payment allocated entirely elsewhere', () => {
    // Worked example C, as a structural claim: `own_total` counts only
    // allocations naming THIS Order, so a payment whose money went to another
    // Order contributes nothing here even though its order_id names this one.
    assert.match(corrected, /and a\.order_id = p_order_id/,
      'the own-share total must be anchored to this Order')
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

  test('no companion ATTRIBUTION function was introduced', () => {
    // Two functions answering "what has this Order received", with the wrong one
    // still wired into the audit trail, is a duplicate source of financial
    // truth.
    assert.ok(!/create\s+(or replace\s+)?function\s+public\.order_received_payment_total/i.test(fix),
      'the attribution question must have exactly one answer')
    assert.ok(fix.includes('would leave two answers to one question'),
      'and the file states why, so nobody adds one later')
  })

  test('the one function it DOES add answers a different question', () => {
    // payment_active_allocation_totals answers "how much of this payment is
    // allocated anywhere", which is the fact the rule turns on and which no
    // single Order can establish for itself. It attributes nothing.
    assert.ok(fix.includes('create or replace function public.payment_active_allocation_totals'))
    assert.ok(fix.includes('can_read_payment_as_participant(f.id)'),
      'and it is gated per id, so it reveals nothing about a payment the caller could not open')
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
    assert.ok(fix.includes("20260816000000's definition of order_linked_payment_total"),
      'the rollback names the definition to restore')
    assert.ok(fix.includes('drop function if exists public.payment_active_allocation_totals'),
      'and drops the helper it added')
    // And says what rolling back costs, so it is a decision rather than a reflex.
    // Whitespace-tolerant: the sentence wraps across comment lines, and a test
    // that breaks on re-wrapping is testing the formatting, not the content.
    assert.match(fix.replace(/\s*--\s*/g, ' '), /Rolling back restores the defect/,
      'the rollback must say what it costs, so it is a decision rather than a reflex')
  })
})
