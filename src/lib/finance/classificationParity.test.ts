/**
 * SQL and TypeScript agree about what a payment is connected to.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The classification is implemented twice, and it has to be:
 *
 *   SQL  finance_received_payments decides which rows a narrowing returns and
 *        what the count beside it says — the list is paged, so the filter and
 *        the count must be the database's or they describe one page instead of
 *        a set
 *   TS   paymentClassification.ts decides what every row PRINTS
 *
 * Two implementations of one financial rule tested against two similar-looking
 * scenarios is exactly the arrangement that produced the defect PR #49 fixed:
 * the Cancel dialog and the Payment Summary disagreed for months because nothing
 * required them to agree. So this file requires it — the same worked examples,
 * the same expected figures, asserted against both sides.
 *
 * WHAT IT CAN AND CANNOT PROVE HERE. It cannot execute the SQL: the migration
 * set is not self-contained (docs/migrations-are-not-self-contained.md), so no
 * database can be built from this repository. What it CAN do — and does — is
 * require that the SQL assertion file carries every fixture with the same
 * figures the TypeScript side asserts, and that the migration's decision
 * structure is the canonical one. The behavioural proof is the assertion file
 * itself, run against a real database.
 *
 * Run:
 *   npx tsx --test src/lib/finance/classificationParity.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { CLASSIFICATION_FIXTURES, CLASSIFICATION_FIXTURE_ORDER } from './classificationFixtures'
import { ATTRIBUTION_FIXTURES } from './attributionFixtures'
import { PAYMENT_CLASSIFICATION_COLUMNS, PAYMENT_VIEWS, paymentViewClauses } from './paymentClassification'

const SQL_ASSERTIONS = 'supabase/tests/payment_classification_assertions.sql'
const MIGRATION = 'supabase/migrations/20261008000000_finance_payment_classification.sql'
const PROJECTION = 'supabase/migrations/20261004000000_finance_received_payments_allocation_state.sql'

const sqlAssertions = readFileSync(SQL_ASSERTIONS, 'utf8')
const migration = readFileSync(MIGRATION, 'utf8')

describe('the migration implements the canonical rule, in the canonical order', () => {
  test('the allocation branch is tested BEFORE the direct link, for the Order share', () => {
    // The ordering IS the rule. Test the link first and it wins again, which is
    // precisely the defect: a payment linked to X and allocated to Y credited
    // ₹10L to X on top of ₹4L to Y.
    const share = migration.slice(migration.indexOf('as order_attributed_total') - 400,
                                 migration.indexOf('as order_attributed_total'))
    const allocationBranch = share.indexOf('b.allocated_total > 0')
    const linkBranch = share.indexOf('b.order_id is not null')
    assert.ok(allocationBranch >= 0, 'the allocation branch must exist')
    assert.ok(linkBranch >= 0, 'the direct-link branch must exist')
    assert.ok(allocationBranch < linkBranch,
      'the allocation branch must come first, or the link wins and the defect returns')
  })

  test('the PI share has NO direct-link fallback', () => {
    const end = migration.indexOf('as pi_attributed_total')
    // From the CASE that produces it, not from a fixed window: the Order share
    // sits immediately above and carries the very branch this asserts is absent.
    const share = migration.slice(migration.lastIndexOf('case', end), end)
    assert.equal(share.includes('order_id is not null'), false,
      'a PI must never inherit the payment\'s Order linkage')
    assert.match(share, /when b\.allocated_total > 0 then b\.pi_allocated_total\s+else 0/,
      'the PI share is its own active allocations, and nothing else')
  })

  test('reversed allocations are excluded from every sum and from the count', () => {
    const totals = migration.slice(migration.indexOf('sum(a.allocated_amount)'))
    const scope = totals.slice(0, totals.indexOf(') totals on true'))
    assert.match(scope, /a\.status = 'active'/,
      'the aggregate must require an active allocation')
    assert.match(scope, /count\(\*\)\s+as active_allocation_count/,
      'the count must come from the same active-only scan')
  })

  test('the two kind totals are asserted to sum to attributed_total', () => {
    // The assertion that catches a second attribution formula creeping in.
    assert.ok(migration.includes('order_attributed_total, 0) + coalesce(pi_attributed_total, 0)'))
    assert.ok(migration.includes('the classification would disagree with the attribution rule'))
  })

  test('the balance is withheld, never guessed, when the caller cannot see everything', () => {
    assert.ok(migration.includes('when not b.attribution_complete then null::numeric'),
      'an incomplete reader must get NULL, not a remainder computed from a partial sum')
    // And completeness is the same two cases payment_active_allocation_totals
    // already treats as complete.
    assert.ok(migration.includes("actor_has_module_permission('finance', 'view_all')"))
    assert.ok(migration.includes('f.submitted_by = auth.uid()'))
  })

  test('completeness is a statement about the caller, not a definer sum', () => {
    // Making it SECURITY DEFINER would tell every reader how a payment is split
    // whether or not they may see the allocations that say so.
    assert.equal(/security\s+definer/i.test(migration), false,
      'nothing in this migration may bypass the caller\'s own RLS')
    assert.ok(migration.includes('security_invoker = true'))
  })

  test('rejected money is excluded in the DATABASE, not by asking clients to remember', () => {
    const rejectedGuards = migration.split("coalesce(b.status, '') <> 'rejected'").length - 1
    assert.equal(rejectedGuards, 3,
      'all three narrowing booleans must exclude a rejected payment')
  })

  test('the narrowing booleans can never be null', () => {
    // A null boolean fails `eq.true` AND `eq.false`, so a payment would vanish
    // from every view at once — the failure a classification exists to prevent.
    assert.ok(migration.includes('a classification boolean came back NULL'))
  })

  test('the balance is floored at zero rather than going negative', () => {
    assert.ok(migration.includes('greatest(b.amount - b.attributed_total, 0)'))
  })

  test('an over-allocated payment is never capped', () => {
    // attributed_total is carried through from 20261004000000 unchanged, which
    // is where the over state is preserved.
    const projection = readFileSync(PROJECTION, 'utf8')
    assert.ok(projection.includes("then 'over'"))
    assert.ok(migration.includes('b.attributed_total'),
      'the migration must re-export the canonical attributed figure, not recompute it')
  })
})

describe('the SQL assertion file carries every fixture the TypeScript side asserts', () => {
  for (const key of CLASSIFICATION_FIXTURE_ORDER) {
    const f = CLASSIFICATION_FIXTURES[key]

    test(`${f.label} is present with its payment id`, () => {
      assert.ok(sqlAssertions.includes(f.paymentId),
        `${SQL_ASSERTIONS} must insert fixture ${f.label} (${f.paymentId})`)
    })
  }

  test('every figure in the SQL expectation table matches the TypeScript fixture', () => {
    // The table in the assertion file is the SQL side's statement of the same
    // expectations. Parsing it — rather than trusting a comment — is what makes
    // this a parity check instead of a pair of similar files.
    const table = sqlAssertions.slice(
      sqlAssertions.indexOf('-- id                                       label  order_att'),
      sqlAssertions.indexOf(') as t(id, label, order_att, pi_att, available, alloc_count)'))
    assert.ok(table.length > 0, 'the figure table must be findable')

    const rows = [...table.matchAll(
      /\('([0-9a-f-]{36})',\s*'(\w+)',\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*(\d+)\)/g)]
    assert.ok(rows.length >= 13, `expected at least 13 SQL rows, found ${rows.length}`)

    for (const [, id, label, orderAtt, piAtt, available, count] of rows) {
      const fixture = Object.values(CLASSIFICATION_FIXTURES).find(f => f.paymentId === id)
      assert.ok(fixture, `SQL fixture ${label} (${id}) has no TypeScript counterpart`)
      // `sqlExpected` where the two sides deliberately differ — the projection
      // keeps the direct-link fallback the application dropped. Everywhere else
      // it is absent and this compares against the one shared expectation.
      const expect = fixture.sqlExpected ?? fixture.expected
      assert.equal(Number(orderAtt).toFixed(2), Number(expect.orderLinked).toFixed(2),
        `${label}: order attribution disagrees with the SQL's own documented answer`)
      assert.equal(Number(piAtt).toFixed(2), Number(expect.piLinked).toFixed(2),
        `${label}: PI attribution disagrees with the SQL's own documented answer`)
      assert.equal(Number(available).toFixed(2),
        Number(expect.available ?? '0').toFixed(2),
        `${label}: available balance disagrees with the SQL's own documented answer`)
      assert.equal(Number(count), fixture.expected.allocationCount,
        `${label}: allocation count disagrees between SQL and TypeScript`)
    }
  })

  test('every view membership in the SQL table matches the TypeScript fixture', () => {
    const table = sqlAssertions.slice(
      sqlAssertions.indexOf('-- id                                       label  orders  pi     available'),
      sqlAssertions.indexOf(') as t(id, label, in_orders, in_pi, in_available)'))
    assert.ok(table.length > 0, 'the view-membership table must be findable')

    const rows = [...table.matchAll(
      /\('([0-9a-f-]{36})',\s*'(\w+)',\s*(true|false)\s*,\s*(true|false)\s*,\s*(true|false)\s*\)/g)]
    assert.ok(rows.length >= 14, `expected at least 14 SQL rows, found ${rows.length}`)

    for (const [, id, label, inOrders, inPi, inAvailable] of rows) {
      const fixture = Object.values(CLASSIFICATION_FIXTURES).find(f => f.paymentId === id)
      assert.ok(fixture, `SQL view row ${label} (${id}) has no TypeScript counterpart`)
      const expect = fixture.sqlExpected ?? fixture.expected
      assert.equal(inOrders === 'true', expect.views.includes('orders'),
        `${label}: "Linked to Orders" disagrees with the SQL's own documented answer`)
      assert.equal(inPi === 'true', expect.views.includes('pi_drafts'),
        `${label}: "Linked to PI Drafts" disagrees with the SQL's own documented answer`)
      assert.equal(inAvailable === 'true', expect.views.includes('available'),
        `${label}: "Available to Allocate" disagrees with the SQL's own documented answer`)
    }
  })

  test('the divergence is bounded to the fallback fixtures, and the app claims LESS', () => {
    // Same bound as attributionParity.test.ts, restated over the classification
    // figures: only a payment with a dormant link and no active allocation may
    // differ, and where it differs the application must attribute less and
    // offer MORE as available — never the other way round.
    for (const key of CLASSIFICATION_FIXTURE_ORDER) {
      const f = CLASSIFICATION_FIXTURES[key]
      const hasActive = f.allocations.some(a => a.status === 'active')
      const shouldDiverge = f.directLinkTarget !== null && !hasActive
      assert.equal(Boolean(f.sqlExpected), shouldDiverge,
        `${f.label}: divergence must follow the rule, not be declared case by case`)
      if (!f.sqlExpected) continue
      assert.ok(Number(f.expected.orderLinked) < Number(f.sqlExpected.orderLinked),
        `${f.label}: the app must attribute strictly less to the Order`)
      assert.ok(Number(f.expected.available ?? '0') > Number(f.sqlExpected.available ?? '0'),
        `${f.label}: and must report the money as available instead`)
      assert.equal(f.expected.views.includes('orders'), false,
        `${f.label}: it is not an Order-linked payment for the application`)
    }
  })

  test('the classification fixtures A-H ARE the attribution fixtures', () => {
    // Not copies of them. If the canonical worked examples change, the
    // classification cannot keep asserting the old figures.
    for (const key of ['A', 'B', 'C', 'D', 'E', 'F', 'G_pi', 'H_replaced'] as const) {
      assert.equal(CLASSIFICATION_FIXTURES[key].paymentId, ATTRIBUTION_FIXTURES[key].paymentId,
        `${key} must be the same payment on both sides`)
      assert.equal(CLASSIFICATION_FIXTURES[key].amount, ATTRIBUTION_FIXTURES[key].amount)
      assert.equal(
        Number(CLASSIFICATION_FIXTURES[key].expected.available ?? '0').toFixed(2),
        Number(ATTRIBUTION_FIXTURES[key].expectedUnallocated).toFixed(2),
        `${key}: the available balance must be the attribution rule's own unallocated figure`)
    }
  })
})

describe('the SQL assertion file proves the properties the decision names', () => {
  test('the mixed Order/PI case is asserted on its own', () => {
    assert.ok(sqlAssertions.includes('a mixed payment appears in every applicable view'))
  })

  test('the over-allocated case is asserted to stay uncapped', () => {
    assert.ok(sqlAssertions.includes('silently capped'))
    assert.ok(sqlAssertions.includes('an over-allocated payment must not appear in Available'))
  })

  test('rejected money is asserted to be in no view', () => {
    assert.ok(sqlAssertions.includes('a rejected payment must appear in no view'))
  })

  test('awaiting money is asserted to classify AND stay marked awaiting', () => {
    assert.ok(sqlAssertions.includes("v_status <> 'pending_approval'"))
    assert.ok(sqlAssertions.includes('awaiting money is real money and must classify like any other'))
  })

  test('the kind split is asserted to sum to the canonical attributed total', () => {
    assert.ok(sqlAssertions.includes('there are now two attribution formulas'))
  })

  test('the incomplete reader is asserted to get NULL rather than a number', () => {
    assert.ok(sqlAssertions.includes('free money would be overstated'))
  })

  test('exact decimal arithmetic is asserted to the paisa', () => {
    assert.ok(sqlAssertions.includes('333.36'))
    assert.ok(sqlAssertions.includes('exact decimal arithmetic holds to the paisa'))
  })

  test('conservation is asserted across every payment, not only the fixtures', () => {
    assert.ok(sqlAssertions.includes('conservation holds on every payment whose balance is stated'))
  })

  test('the file rolls back and asserts the projection is still invoker-scoped', () => {
    assert.ok(sqlAssertions.trimEnd().endsWith('rollback;'))
    assert.ok(sqlAssertions.includes('must be security_invoker'))
    assert.ok(sqlAssertions.includes('authenticated must hold SELECT only'))
  })
})

describe('the two sides name the same columns', () => {
  test('every column the TypeScript narrowing reads exists in the migration', () => {
    for (const column of PAYMENT_CLASSIFICATION_COLUMNS) {
      assert.ok(migration.includes(column),
        `${column} is read by the client but never produced by the projection`)
    }
  })

  test('every predicate the client sends is over a column the migration defines', () => {
    for (const view of PAYMENT_VIEWS) {
      for (const clause of paymentViewClauses(view)) {
        if (clause.kind !== 'eq') continue
        assert.ok(migration.includes(`as ${clause.column}`),
          `${clause.column} must be an output column of finance_received_payments`)
      }
    }
  })
})
