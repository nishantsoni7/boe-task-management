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
import { join } from 'node:path'

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
    // ONE COMPUTATION, REQUIRED OF BOTH SIDES. Until 20261012000000 this test
    // had to compute two figures — the app's and the SQL's — because the two
    // implementations disagreed about a payment with a dormant link and no
    // active allocation. They no longer do, so there is one total, derived from
    // the rule, and the SQL file must state it.
    const lettered = FIXTURE_ORDER.filter(k => k.length === 1).map(k => ATTRIBUTION_FIXTURES[k])
    const totalFor = (target: string) => lettered.reduce((sum, f) => {
      const active = f.allocations.filter(a => a.status === 'active')
      return sum + Number(attributeToTarget({
        paymentId: f.paymentId,
        ownActiveAllocations: active.filter(a => a.targetId === target).map(a => a.amount),
      }).share)
    }, 0)

    // A ₹0 + B ₹5L + C ₹0 + D ₹4L + E ₹0 + F ₹15L. The ₹20L that used to sit
    // here was A and E, attributed by a fallback rather than by an allocation.
    assert.equal(totalFor('ORDER_X'), 2400000)
    // C ₹4L + D ₹6L; E's reversed allocation contributes nothing.
    assert.equal(totalFor('ORDER_Y'), 1000000)

    assert.ok(sqlAssertions.includes('2400000.00'),
      'the SQL must assert the same Order X total the rule produces')
    assert.ok(sqlAssertions.includes('1000000.00'),
      'the SQL must assert the same Order Y total the rule produces')
    assert.equal(sqlAssertions.includes('4400000.00'), false,
      'the fallback-era Order X total must not survive in the SQL assertions')
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
          ownActiveAllocations: active.filter(a => a.targetId === target).map(a => a.amount),
        })
        assert.equal(got.share, expected, `${f.label} / ${target}: ${f.note}`)
      }

      const position = paymentPosition({
        amount: f.amount,
        activeAllocationTotal: activeTotal,
      })
      assert.equal(position.state, f.expectedState, `${f.label} state`)
      assert.equal(position.unallocated, f.expectedUnallocated, `${f.label} unallocated`)
    })
  }
})

// ══ The two sides agree, and a returning fallback must break this file ══════
//
// PR #55 left one release in which the application and the database scored a
// payment with a dormant link and no active allocation differently. This suite
// used to PIN that divergence — which fixtures could differ, and by how much.
// 20261012000000 closed it, so the suite's job inverts: prove the fallback is
// absent from the SQL, and that nothing feeds a legacy field back into an
// allocation figure.

describe('the direct-link fallback is gone from the database too', () => {
  const MIGRATION_112 = 'supabase/migrations/20261012000000_allocation_ledger_as_single_source.sql'
  const migration112 = readFileSync(join(process.cwd(), MIGRATION_112), 'utf8')

  test('order_linked_payment_total no longer attributes by the payment\'s own order_id', () => {
    const fn = migration112.slice(migration112.indexOf('create or replace function public.order_linked_payment_total'))
    const body = fn.slice(0, fn.indexOf('$$;'))
    assert.equal(/order_id\s*=\s*p_order_id\s+then\s+\S*amount/.test(body), false,
      'the fallback branch must not come back')
    assert.ok(body.includes('finance_payment_allocations'), 'it reads the allocation ledger')
    assert.ok(body.includes("a.status = 'active'"), 'active rows only')
    assert.ok(body.includes('finance_payment_status_is_verified'),
      'and still only Finance-verified payments')
  })

  test('the view no longer substitutes the amount for a missing allocation', () => {
    const view = migration112.slice(migration112.indexOf('create or replace view public.finance_received_payments'))
    const body = view.slice(0, view.indexOf('\n) b;'))
    assert.equal(/order_id\s+is\s+not\s+null\s+then\s+f\.amount/.test(body), false,
      'no derived column may fall back to the ledger amount')
    // The columns that carried it, each now reading the allocation figure.
    assert.ok(body.includes('coalesce(totals.allocated_total, 0) as attributed_total'))
    assert.ok(body.includes('coalesce(totals.order_allocated_total, 0) as order_attributed_total'))
    assert.ok(body.includes('greatest(f.amount - coalesce(totals.allocated_total, 0), 0)'),
      'available_balance is amount minus the ACTIVE allocation total')
  })

  test('the migration asserts its own result at apply time', () => {
    // A migration that silently half-applied would be worse than one that
    // failed, so it checks the catalogue rather than trusting its own text.
    assert.ok(migration112.includes('pg_get_functiondef'), 'it reads the function back')
    assert.ok(migration112.includes('pg_get_viewdef'), 'and the view')
    assert.ok(migration112.includes('security_invoker'), 'and re-checks the security mode')
  })

  test('the legacy COLUMNS survive — this removes their meaning, not the data', () => {
    assert.ok(migration112.includes("array['order_id', 'order_request_id', 'payment_against']"),
      'the migration must assert the provenance columns are still present')
    assert.equal(/alter table[\s\S]{0,120}drop column/i.test(migration112), false,
      'migration 112 must not drop a column')
  })

  test('no application code reads the SQL total as an allocation figure', () => {
    // The two callers use it for the Order's OWN received total, which is what
    // it is for. Neither feeds it into an allocation state or an allocated
    // total — that is what would let a legacy figure back into the ledger.
    for (const path of [
      'src/app/orders/[id]/OrderAmendmentModals.tsx',
      'src/app/finance/received/AllocatePaymentModal.tsx',
    ]) {
      const src = readFileSync(join(process.cwd(), path), 'utf8')
      const at = src.indexOf('order_linked_payment_total')
      assert.ok(at > -1, `${path} still calls it`)
      const near = src.slice(at, at + 600)
      assert.equal(near.includes('summarizePaymentAllocations'), false,
        `${path} must not feed the SQL total into the allocation summary`)
      assert.equal(near.includes('confirmed_allocation_status'), false,
        `${path} must not derive an allocation state from it`)
    }
  })

  test('no fixture carries a separate SQL expectation any more', () => {
    // The mechanism that recorded the divergence is gone with the divergence.
    // One expectation per fixture, for both implementations.
    // Comments may still RECORD that the divergence once existed — that is
    // history worth keeping. What must be gone is the field itself.
    const strip = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    for (const path of [
      'src/lib/finance/attributionFixtures.ts',
      'src/lib/finance/classificationFixtures.ts',
    ]) {
      const code = strip(readFileSync(join(process.cwd(), path), 'utf8'))
      assert.equal(/sqlExpected/.test(code), false,
        `${path} must not carry a separate SQL answer`)
    }
  })
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
