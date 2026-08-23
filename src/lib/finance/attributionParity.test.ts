/**
 * SQL and TypeScript agree about who a payment's money belongs to.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The canonical attribution rule is implemented twice, and it has to be:
 *
 *   SQL  order_linked_payment_total() decides the cancellation warning and the
 *        `received_at_cancellation` audit value, for a caller whose own RLS does
 *        not show every payment on the Order
 *   TS   paymentAttribution.ts decides what every screen prints
 *
 * Two implementations of one financial rule is exactly the arrangement that
 * produced the defect being fixed: the Cancel dialog and the Payment Summary
 * disagreed for months because nothing required them to agree. So this file
 * requires it — the same worked examples, the same expected figures, asserted
 * against both sides.
 *
 * WHAT IT CAN AND CANNOT PROVE HERE. It cannot execute the SQL: the migration
 * set is not self-contained (see docs/migrations-are-not-self-contained.md), so
 * no database can be built from this repository. What it CAN do — and does — is
 * require that the SQL assertion file carries every fixture with the same
 * figures the TypeScript side asserts, and that the SQL's decision structure is
 * the canonical one. The behavioural proof is the assertion file itself, run
 * against a real database.
 *
 * Run:
 *   npx tsx --test src/lib/finance/attributionParity.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { ATTRIBUTION_FIXTURES, FIXTURE_ORDER } from './attributionFixtures'
import { attributeToTarget, paymentPosition } from './paymentAttribution'

const SQL_ASSERTIONS = 'supabase/tests/payment_attribution_assertions.sql'
const MIGRATION = 'supabase/migrations/20261005000000_order_linked_payment_total_counts_allocations.sql'
const PROJECTION = 'supabase/migrations/20261004000000_finance_received_payments_allocation_state.sql'

const sqlAssertions = readFileSync(SQL_ASSERTIONS, 'utf8')
const migration = readFileSync(MIGRATION, 'utf8')
const projection = readFileSync(PROJECTION, 'utf8')

describe('the SQL implements the canonical rule, in the canonical order', () => {
  test('allocations are tested BEFORE the direct link', () => {
    // The ordering IS the rule. Test the link first and it wins again, which is
    // precisely the defect: a payment linked to X and allocated to Y credited
    // ₹10L to X on top of ₹4L to Y.
    const allocationBranch = migration.indexOf('active_total > 0')
    const linkBranch = migration.indexOf('s.order_id = p_order_id   then s.amount')
    assert.ok(allocationBranch > 0, 'the allocation branch must exist')
    assert.ok(linkBranch > 0, 'the direct-link branch must exist')
    assert.ok(allocationBranch < linkBranch,
      'the allocation branch must come first, or the link wins and the defect returns')
  })

  test('the direct link is the FALLBACK, reached only when nothing is allocated', () => {
    // `when active_total > 0 then own_total` — so a payment with allocations
    // never reaches the link branch at all, whatever that link says.
    assert.match(migration, /when\s+s\.active_total > 0\s+then s\.own_total/)
  })

  test('reversed allocations are excluded from both totals', () => {
    const body = migration.slice(migration.indexOf('with candidates as'))
    const activeTests = body.split("a.status = 'active'").length - 1
    assert.ok(activeTests >= 3,
      'the candidate scan and both totals must each require an active allocation')
  })

  test('only verified money is attributed', () => {
    assert.ok(migration.includes('finance_payment_status_is_verified'))
  })

  test('the whole-payment helper is gated by RLS, not by a restatement of it', () => {
    // SECURITY INVOKER, so the payment table's own policies decide which ids are
    // answerable. See paymentTotalsRpcSecurity.test.ts for the full argument and
    // supabase/tests/payment_active_allocation_totals_security.sql for the
    // executable proof.
    assert.ok(migration.includes('payment_active_allocation_totals'))
    assert.ok(migration.includes('anon must not hold EXECUTE on payment_active_allocation_totals'))
  })

  test('the projection attributes by the same rule, not by allocations alone', () => {
    // Worked example A: a payment linked to an Order with no allocations is
    // counted in full by that Order, so calling it "unallocated" in Finance
    // would have the same rupees appearing as both committed and free.
    assert.ok(projection.includes('attributed_total'),
      'the projection must expose the attributed figure, not only the allocated one')
    assert.match(projection,
      /when coalesce\(totals\.allocated_total, 0\) > 0 then coalesce\(totals\.allocated_total, 0\)\s*\n\s*when f\.order_id is not null\s+then f\.amount/,
      'allocations first, direct link as fallback — the same order as the function')
  })
})

describe('every worked example appears in the SQL assertion file', () => {
  for (const key of FIXTURE_ORDER) {
    const fixture = ATTRIBUTION_FIXTURES[key]
    if (key.length > 1) continue // G and H are TS-side reachability cases
    test(`example ${fixture.label} is asserted in SQL`, () => {
      assert.ok(sqlAssertions.includes(`ASSERT ${fixture.label}`),
        `${SQL_ASSERTIONS} must carry a fixture for example ${fixture.label}`)
    })
  }

  test('the SQL asserts the same per-Order totals the TypeScript rule produces', () => {
    // The two Order totals in the SQL file are the sum of every fixture's share.
    // Computing them here from the TypeScript rule and requiring the SQL to
    // state the same numbers is what makes this a parity check rather than two
    // independent guesses.
    const lettered = FIXTURE_ORDER.filter(k => k.length === 1).map(k => ATTRIBUTION_FIXTURES[k])

    const totalFor = (target: string) => lettered.reduce((sum, f) => {
      const active = f.allocations.filter(a => a.status === 'active')
      const share = attributeToTarget({
        paymentId: f.paymentId,
        amount: f.amount,
        activeAllocationTotal: active.reduce((s, a) => s + Number(a.amount), 0).toFixed(2),
        ownActiveAllocations: active.filter(a => a.targetId === target).map(a => a.amount),
        directlyLinkedToTarget: f.directLinkTarget === target,
      })
      return sum + Number(share.share)
    }, 0)

    // A ₹10L + B ₹5L + C ₹0 + D ₹4L + E ₹10L + F ₹15L
    assert.equal(totalFor('ORDER_X'), 4400000)
    // C ₹4L + D ₹6L; E's reversed allocation contributes nothing
    assert.equal(totalFor('ORDER_Y'), 1000000)

    assert.ok(sqlAssertions.includes('4400000.00'),
      'the SQL must assert the same Order X total the rule produces')
    assert.ok(sqlAssertions.includes('1000000.00'),
      'the SQL must assert the same Order Y total the rule produces')
  })

  test('the SQL asserts the conservation law', () => {
    assert.ok(sqlAssertions.includes('conservation broken on'))
    assert.ok(sqlAssertions.includes('silently capped'),
      'and that an over-allocation is not rebalanced away')
  })

  test('the SQL isolates example C — the ₹14 lakh case', () => {
    // The one that must never come back: removing C must not change Order X,
    // because C contributed nothing to X.
    assert.ok(sqlAssertions.includes('the direct link is still being counted'))
  })

  test('the assertion file leaves nothing behind', () => {
    assert.ok(sqlAssertions.trimEnd().endsWith('rollback;'))
  })
})

describe('the TypeScript rule produces the documented figures', () => {
  for (const key of FIXTURE_ORDER) {
    const f = ATTRIBUTION_FIXTURES[key]
    test(`${f.label}: every target matches, and the position matches`, () => {
      const active = f.allocations.filter(a => a.status === 'active')
      const activeTotal = active.reduce((s, a) => s + Number(a.amount), 0).toFixed(2)

      for (const [target, expected] of Object.entries(f.expected)) {
        const got = attributeToTarget({
          paymentId: f.paymentId,
          amount: f.amount,
          activeAllocationTotal: activeTotal,
          ownActiveAllocations: active.filter(a => a.targetId === target).map(a => a.amount),
          directlyLinkedToTarget: f.directLinkTarget === target,
        })
        assert.equal(got.share, expected, `${f.label} / ${target}: ${f.note}`)
      }

      const position = paymentPosition({
        amount: f.amount,
        activeAllocationTotal: activeTotal,
        hasDirectLink: f.directLinkTarget !== null,
      })
      assert.equal(position.state, f.expectedState, `${f.label} state`)
      assert.equal(position.unallocated, f.expectedUnallocated, `${f.label} unallocated`)
    })
  }
})

describe('question 8: the reachable combinations', () => {
  test('a payment linked to an Order and allocated to a PI overrides the Order', () => {
    // The rule does not care what KIND of target an allocation names.
    const f = ATTRIBUTION_FIXTURES.G_pi
    assert.equal(f.expected.ORDER_X, '0')
    assert.equal(f.expected.SUBMISSION_P, '250000.00')
  })

  test('an inactive allocation coexisting with an active replacement', () => {
    // Exactly what correcting an allocation produces: reverse one, add another.
    // Only the active replacement counts, and the reversed row stays in the
    // trail with its reason.
    const f = ATTRIBUTION_FIXTURES.H_replaced
    assert.equal(f.expected.ORDER_X, '0')
    assert.equal(f.expected.ORDER_Y, '300000.00')
    assert.equal(f.expectedUnallocated, '700000.00')
  })

  test('a direct link surviving an allocation is the defect case itself', () => {
    // allocate_payment_to_target() does not refuse a payment that already
    // carries an order_id, which is why C is reachable and why the rule has to
    // decide between them rather than adding them.
    const f = ATTRIBUTION_FIXTURES.C
    assert.equal(f.directLinkTarget, 'ORDER_X')
    assert.equal(f.expected.ORDER_X, '0')
  })
})
