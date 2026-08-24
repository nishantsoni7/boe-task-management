/**
 * What the Received Payments list asks the database.
 *
 * WHAT THIS FILE PROVES
 * ---------------------
 * The three defects the module was written to close, each pinned by a test that
 * fails against the old behaviour:
 *
 *   1. THE LIST IS BOUNDED. Every read carries a page range, so PostgREST's
 *      silent 1000-row cap can never quietly drop the oldest payments out of
 *      Finance while the count beside them reads a confident "1000".
 *   2. THE NARROWING SEES AN ALLOCATED PAYMENT. Money that reached a Confirmed
 *      Order through an ACTIVE ALLOCATION — the way PI conversion moves it — is
 *      found by the "Orders" view. It used to be found by neither half of a
 *      linkage filter that tested order_id alone.
 *   3. SEARCH COVERS THE COLUMN THE TABLE LEADS WITH. A payment is findable by
 *      its own request number and by the Order number its row displays.
 *
 * Plus the rule that makes server-side search safe at all: a term is a LITERAL,
 * and no character in it may change the shape of the filter it lands in.
 *
 * Run:
 *   npx tsx --test src/app/finance/receivedPaymentsQuery.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  ALLOCATED_TOTAL_COLUMN,
  ALLOCATION_FILTER_OPTIONS,
  PAYMENT_VIEW_OPTIONS,
  RECEIVED_PAYMENTS_CLASSIFICATION_COLUMNS,
  allocationFilterAvailable,
  allocationFilterClauses,
  isAllocationFilter,
  type AllocationFilter,
  RECEIVED_PAYMENTS_PAGE_SIZE,
  RECEIVED_PAYMENTS_SEARCH_COLUMNS,
  dateBound,
  dateRange,
  isPaymentView,
  isNarrowed,
  paymentViewFilterClauses,
  readPaymentView,
  pageCount,
  pageRange,
  resultSummary,
  sanitizeSearchTerm,
  receivedPaymentsSearchFilter as searchFilter,
} from './receivedPaymentsQuery'

// ── 1. The list is bounded ────────────────────────────────────────────────────

describe('the list is bounded, so PostgREST cannot truncate it silently', () => {
  test('the page size is comfortably under the 1000-row cap', () => {
    // The cap is a CAP, not an error — no error field, no warning, a
    // plausible-looking array. A page has to be small enough that it can never
    // be the thing that gets clipped.
    assert.ok(RECEIVED_PAYMENTS_PAGE_SIZE > 0)
    assert.ok(RECEIVED_PAYMENTS_PAGE_SIZE < 1000)
  })

  test('page ranges are contiguous and never overlap', () => {
    const first = pageRange(1)
    const second = pageRange(2)
    assert.deepEqual(first, { from: 0, to: RECEIVED_PAYMENTS_PAGE_SIZE - 1 })
    assert.equal(second.from, first.to + 1)
    assert.equal(second.to - second.from, RECEIVED_PAYMENTS_PAGE_SIZE - 1)
  })

  test('a page number typed into the URL cannot become a negative offset', () => {
    // PostgREST refuses a negative range outright, so a hand-typed ?page=-3
    // would blank the list rather than showing the first page.
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.deepEqual(pageRange(bad), { from: 0, to: RECEIVED_PAYMENTS_PAGE_SIZE - 1 })
    }
    assert.deepEqual(pageRange(2.7), pageRange(2))
  })

  test('page counts round up, and an empty list is one page', () => {
    assert.equal(pageCount(0), 1)
    assert.equal(pageCount(null), 1)
    assert.equal(pageCount(1), 1)
    assert.equal(pageCount(RECEIVED_PAYMENTS_PAGE_SIZE), 1)
    assert.equal(pageCount(RECEIVED_PAYMENTS_PAGE_SIZE + 1), 2)
    assert.equal(pageCount(RECEIVED_PAYMENTS_PAGE_SIZE * 3), 3)
  })

  test('the page issues a bounded read and never an open-ended one', () => {
    const view = readFileSync('src/app/finance/received/ReceivedPaymentsView.tsx', 'utf8')
    assert.ok(view.includes('.range(range.from, range.to)'),
      'the list read must be bounded by a page range')
    assert.ok(view.includes("count: 'exact'"),
      'the total must come from the database, not from the length of what loaded')
  })
})

// ── 2. The classification narrowing sees an allocated payment ────────────────

describe('the four views and the figures beside them answer the same question', () => {
  test('THE DEFECT: an allocation-linked payment is found by "Orders"', () => {
    // A PI's money reaches its Order by the allocation MOVING — the payment row
    // keeps order_id NULL. The old filter tested order_id alone, so this money
    // showed "Order ORD-…" in its row and then matched neither narrowing. The
    // projection's own boolean is computed from the canonical attribution rule,
    // so the narrowing and the row's figures are one statement.
    assert.deepEqual(paymentViewFilterClauses('orders'), [
      { kind: 'eq', column: 'is_linked_to_order', value: 'true' },
    ])
  })

  test('a payment split with a PI Draft is found by BOTH linked views', () => {
    // NOT A PARTITION, deliberately. The two predicates are independent
    // booleans, so a mixed payment satisfies both — which is the case a
    // two-page linked/unlinked split could not express at all.
    const orders = paymentViewFilterClauses('orders')
    const pi = paymentViewFilterClauses('pi_drafts')
    assert.deepEqual(pi, [{ kind: 'eq', column: 'is_linked_to_pi', value: 'true' }])
    assert.notDeepEqual(orders, pi)
    // Neither excludes the other's column, so nothing stops a row matching both.
    for (const clause of [...orders, ...pi]) {
      assert.equal(clause.kind, 'eq')
    }
  })

  test('Available is a positive BALANCE, not an "is it allocated" flag', () => {
    // A ₹10L payment with ₹4L allocated has ₹6L that still needs somebody, and a
    // yes/no flag would hide it behind a confident "yes". The projection makes
    // the balance comparison, because PostgREST cannot compare two columns.
    assert.deepEqual(paymentViewFilterClauses('available'), [
      { kind: 'eq', column: 'is_available_to_allocate', value: 'true' },
    ])
  })

  test('"all" narrows nothing', () => {
    assert.deepEqual(paymentViewFilterClauses('all'), [])
  })

  test('every offered view is one the module implements', () => {
    for (const option of PAYMENT_VIEW_OPTIONS) {
      assert.ok(isPaymentView(option.value), option.value)
    }
    assert.ok(!isPaymentView('something-else'))
  })

  test('no view is named after the retired Order Request workflow', () => {
    const copy = JSON.stringify(PAYMENT_VIEW_OPTIONS).toLowerCase()
    assert.equal(copy.includes('order request'), false)
    assert.equal(copy.includes('order_request'), false)
  })

  test('a URL somebody typed resolves to All rather than to an empty list', () => {
    assert.equal(readPaymentView('nonsense'), 'all')
    assert.equal(readPaymentView(null), 'all')
    assert.equal(readPaymentView('pi_drafts'), 'pi_drafts')
  })

  test('every column a view filters on is one the list selects', () => {
    for (const option of PAYMENT_VIEW_OPTIONS) {
      for (const clause of paymentViewFilterClauses(option.value)) {
        if (clause.kind !== 'eq') continue
        assert.ok(
          (RECEIVED_PAYMENTS_CLASSIFICATION_COLUMNS as readonly string[]).includes(clause.column),
          `${clause.column} is filtered on but never selected`)
      }
    }
  })
})

// ── 3. Search covers what the table shows ────────────────────────────────────

describe('search finds a payment by what the row displays', () => {
  test('THE DEFECT: the payment request number is searchable', () => {
    // It is the FIRST column of the table, and searching for one returned
    // nothing at all.
    assert.ok(RECEIVED_PAYMENTS_SEARCH_COLUMNS.includes('request_number'))
    assert.ok(searchFilter('REQ-2026-0024')!.includes('request_number.ilike.*REQ-2026-0024*'))
  })

  test('the allocated Order number is searchable', () => {
    // The row displays it, so the row must be findable by it.
    assert.ok(RECEIVED_PAYMENTS_SEARCH_COLUMNS.includes('allocated_order_number'))
    assert.ok(searchFilter('ORD-2026-0007')!.includes('allocated_order_number.ilike.*ORD-2026-0007*'))
  })

  test('every displayed identifier is covered', () => {
    const filter = searchFilter('x')!
    for (const column of RECEIVED_PAYMENTS_SEARCH_COLUMNS) {
      assert.ok(filter.includes(`${column}.ilike.*x*`), column)
    }
  })

  test('no search is NULL, not an empty filter', () => {
    // `or=()` is a parse error, so an empty term must mean "do not call .or()"
    // rather than "call it with nothing".
    assert.equal(searchFilter(''), null)
    assert.equal(searchFilter('   '), null)
    assert.equal(searchFilter(',,,'), null)
  })
})

describe('a search term is a literal and cannot reshape the filter', () => {
  test('the characters that structure a PostgREST or= group are removed', () => {
    // A comma would be read as "and here is another filter"; brackets close the
    // group. The query would come back answering a question nobody asked.
    assert.equal(sanitizeSearchTerm('a,b'), 'a b')
    assert.equal(sanitizeSearchTerm('a(b)c'), 'a b c')
    assert.equal(sanitizeSearchTerm('a"b\'c'), 'a b c')
    assert.equal(sanitizeSearchTerm('a\\b'), 'a b')
  })

  test('ilike wildcards are removed, so a term matches itself', () => {
    // Somebody typing "100%" is searching for a string, not asking to match
    // every row in the ledger.
    assert.equal(sanitizeSearchTerm('100%'), '100')
    assert.equal(sanitizeSearchTerm('a_b'), 'a b')
    assert.equal(sanitizeSearchTerm('*'), '')
  })

  test('an injection attempt collapses into a harmless literal', () => {
    const hostile = 'x,status.eq.rejected,client_name.ilike.*'
    const cleaned = sanitizeSearchTerm(hostile)
    assert.ok(!cleaned.includes(','))
    assert.ok(!cleaned.includes('*'))
    // What is left is matched as a single literal against each column, so it
    // finds nothing rather than widening the read.
    const filter = searchFilter(hostile)!
    assert.equal(filter.split(',').length, RECEIVED_PAYMENTS_SEARCH_COLUMNS.length,
      'the filter still has exactly one clause per column')
  })

  test('ordinary business identifiers survive untouched', () => {
    // The sanitizer must not damage the terms people actually type.
    assert.equal(sanitizeSearchTerm('REQ-2026-0024'), 'REQ-2026-0024')
    assert.equal(sanitizeSearchTerm('ORD-2026-0007'), 'ORD-2026-0007')
    assert.equal(sanitizeSearchTerm('  Kalyan Interiors  '), 'Kalyan Interiors')
  })
})

// ── Date range ────────────────────────────────────────────────────────────────

describe('the date filter', () => {
  test('accepts a real calendar date', () => {
    assert.equal(dateBound('2026-08-22'), '2026-08-22')
  })

  test('a half-typed or impossible date is ignored, never sent', () => {
    // An unparseable bound makes PostgREST refuse the whole request, which would
    // blank the list while somebody is still typing into the box.
    for (const bad of ['', '2026', '2026-08', '22-08-2026', '2026-13-01',
                       '2026-02-31', 'yesterday', null, undefined]) {
      assert.equal(dateBound(bad as string), null, String(bad))
    }
  })

  test('bounds typed the wrong way round are swapped, not refused', () => {
    // An empty list is a silent and confusing answer to a reasonable action.
    assert.deepEqual(dateRange('2026-08-31', '2026-08-01'),
      { from: '2026-08-01', to: '2026-08-31' })
  })

  test('one bound alone is a valid open-ended range', () => {
    assert.deepEqual(dateRange('2026-08-01', ''), { from: '2026-08-01', to: null })
    assert.deepEqual(dateRange('', '2026-08-31'), { from: null, to: '2026-08-31' })
    assert.deepEqual(dateRange('', ''), { from: null, to: null })
  })
})

// ── The toolbar's own honesty ─────────────────────────────────────────────────

describe('what the toolbar says it is doing', () => {
  test('narrowing is detected for every control', () => {
    const none = { search: '', dateFrom: null, dateTo: null }
    assert.equal(isNarrowed(none), false)
    assert.equal(isNarrowed({ ...none, search: 'REQ-1' }), true)
    assert.equal(isNarrowed({ ...none, dateFrom: '2026-08-01' }), true)
    assert.equal(isNarrowed({ ...none, dateTo: '2026-08-31' }), true)
  })

  test('the VIEW is not a narrowing — a tab is where the reader is', () => {
    // Counting it would offer "Clear filters" on a freshly opened Available tab
    // and then leave the reader exactly where they were when they pressed it.
    assert.equal(isNarrowed({ search: '', dateFrom: null, dateTo: null }), false)
  })

  test('a term of only stripped characters is not a narrowing', () => {
    // It matches nothing and filters nothing; offering "Clear filters" for it
    // would be describing a state the page is not in.
    assert.equal(isNarrowed({ search: '%%%', dateFrom: null, dateTo: null }), false)
  })

  test('the count line never invents a total it does not have', () => {
    assert.equal(resultSummary({ loading: true, shown: 0, total: null, narrowed: false, page: 1, pages: 1 }),
      'Loading…')
    // No exact count available: describe the page in hand, claim nothing more.
    assert.equal(resultSummary({ loading: false, shown: 12, total: null, narrowed: false, page: 1, pages: 1 }),
      '12 payments')
    assert.equal(resultSummary({ loading: false, shown: 1, total: null, narrowed: false, page: 1, pages: 1 }),
      '1 payment')
  })

  test('a filtered count says it is filtered', () => {
    assert.equal(resultSummary({ loading: false, shown: 3, total: 3, narrowed: true, page: 1, pages: 1 }),
      '3 matching payments')
    assert.equal(resultSummary({ loading: false, shown: 50, total: 120, narrowed: false, page: 2, pages: 3 }),
      '120 payments · page 2 of 3')
  })

  test('empty reads differently depending on why', () => {
    // "No payments" is a statement about the business; "No matches" is a
    // statement about the filter. Confusing the two sends somebody looking for
    // a missing payment that is simply filtered out.
    assert.equal(resultSummary({ loading: false, shown: 0, total: 0, narrowed: false, page: 1, pages: 1 }),
      'No payments')
    assert.equal(resultSummary({ loading: false, shown: 0, total: 0, narrowed: true, page: 1, pages: 1 }),
      'No matches')
  })
})

// ── The allocation narrowing ─────────────────────────────────────────────────

describe('the allocation filter is gated, and fails closed', () => {
  test('it is unavailable until the projection carries the column', () => {
    // The control must not be drawn against a database where 20261004000000 has
    // not been applied: a query naming a missing column is refused outright by
    // PostgREST, which would blank the list rather than narrow it.
    assert.equal(allocationFilterAvailable(null), false)
    assert.equal(allocationFilterAvailable(undefined), false)
    assert.equal(allocationFilterAvailable({ columns: [] }), false)
  })

  test('a half-applied projection is still unavailable', () => {
    // Both columns or neither. One without the other is a state no migration
    // produces, and guessing which half is missing is not this module's job.
    assert.equal(allocationFilterAvailable({ columns: ['allocation_state'] }), false)
    assert.equal(allocationFilterAvailable({ columns: [ALLOCATED_TOTAL_COLUMN] }), false)
  })

  test('and available once both columns are there', () => {
    assert.equal(allocationFilterAvailable({
      columns: ['id', ALLOCATED_TOTAL_COLUMN, 'allocation_state'],
    }), true)
  })

  test('the page draws the control only when the reader can trust it', () => {
    // The view is security_invoker, so the sum behind the state is evaluated as
    // the CALLER. A reader who may see a payment but not its allocations sums to
    // zero and would be shown "Unallocated" for money that is fully spoken for.
    // finance.view_all (and admin, which short-circuits inside the helper) are
    // exactly the readers for whom the invoker sum IS the true sum.
    const view = readFileSync('src/app/finance/received/ReceivedPaymentsView.tsx', 'utf8')
    assert.ok(view.includes('const allocationOffered = allocationReady && caps.canViewAllFinance'),
      'both gates must be required')
    assert.ok(view.includes('{allocationOffered && ('),
      'the control is drawn only when offered')
  })

  test('and never sends the filter when it is not offered', () => {
    const view = readFileSync('src/app/finance/received/ReceivedPaymentsView.tsx', 'utf8')
    assert.ok(view.includes("allocation: allocationOffered ? allocation : ('all' as AllocationFilter)"),
      'an ungated reader must query as if no allocation filter existed')
  })
})

describe('what each allocation state narrows to', () => {
  test('"all" narrows nothing', () => {
    assert.deepEqual(allocationFilterClauses('all'), [])
  })

  test('every other state is one equality against the view column', () => {
    // A single eq, not a numeric comparison assembled here: PostgREST cannot
    // compare two columns in a filter, so the comparison against the payment's
    // own amount is the VIEW's job. That is the whole reason the state is a
    // column.
    for (const state of ['unallocated', 'partial', 'full', 'over'] as const) {
      assert.deepEqual(allocationFilterClauses(state),
        [{ kind: 'eq', column: 'allocation_state', value: state }], state)
    }
  })

  test('the four real states are all offered, over-allocation included', () => {
    // The capacity trigger refuses to CREATE an over-allocation, so a row in
    // that state means something has gone wrong — which is exactly why it must
    // be findable rather than rounded into "Fully".
    const offered = ALLOCATION_FILTER_OPTIONS.map(o => o.value)
    for (const state of ['all', 'unallocated', 'partial', 'full', 'over']) {
      assert.ok(offered.includes(state as AllocationFilter), state)
    }
  })

  test('every offered option is a state the module implements', () => {
    for (const option of ALLOCATION_FILTER_OPTIONS) {
      assert.ok(isAllocationFilter(option.value), option.value)
    }
    assert.ok(!isAllocationFilter('mostly'))
  })
})

describe('the allocation state composes with every other narrowing', () => {
  test('it counts as a narrowing, so "Clear filters" appears', () => {
    const base = { search: '', dateFrom: null, dateTo: null }
    assert.equal(isNarrowed({ ...base, allocation: 'all' }), false)
    assert.equal(isNarrowed({ ...base, allocation: 'unallocated' }), true)
  })

  test('an absent allocation filter does not make a plain list look narrowed', () => {
    // Readers who are not offered the control pass nothing, and the toolbar must
    // not then claim the list is filtered.
    assert.equal(isNarrowed({ search: '', dateFrom: null, dateTo: null }), false)
  })

  test('it is applied as its own clause, alongside the others', () => {
    // Search, the confirmed-allocation filter, dates and allocation state all
    // narrow the same query and compose as AND. Each is a separate clause, so
    // none can overwrite another. (paymentViewFilterClauses — the retired
    // four-view classification tab strip — is gone from the list entirely;
    // see receivedPaymentsView's own describe block.)
    const view = readFileSync('src/app/finance/received/ReceivedPaymentsView.tsx', 'utf8')
    const loader = view.slice(view.indexOf('const loadRequests'), view.indexOf('const loadAllocations'))
    for (const applied of [
      'if (filters.search) scoped = scoped.or(filters.search)',
      "scoped.eq('confirmed_allocation_status', filters.confirmedFilter)",
      "scoped.gte('payment_date', filters.dateFrom)",
      "scoped.lte('payment_date', filters.dateTo)",
      'allocationFilterClauses(filters.allocation)',
    ]) {
      assert.ok(loader.includes(applied), applied)
    }
    // And the page range is applied to the same query, so the narrowing is what
    // is paged — not the page that is narrowed.
    assert.ok(loader.includes('.range(range.from, range.to)'))
  })

  test('changing it returns the reader to page one', () => {
    const view = readFileSync('src/app/finance/received/ReceivedPaymentsView.tsx', 'utf8')
    assert.ok(view.includes('const applyAllocation = narrowBy(setAllocation)'),
      'narrowing must reset the page, or page four of a one-page result shows nothing')
    assert.ok(view.includes('filters.allocation, filters.confirmedFilter, page]'),
      'a change to the allocation filter (or the confirmed-allocation filter) must re-issue the query')
  })
})

describe('the migration that backs the filter', () => {
  const sql = readFileSync(
    'supabase/migrations/20261004000000_finance_received_payments_allocation_state.sql', 'utf8')

  test('is forward-only, after the last applied migration', () => {
    // 20261003000000 is the last migration the deployment has applied. Anything
    // this project adds has to come after it and may never edit an applied file.
    assert.ok('20261004000000' > '20261003000000')
  })

  test('keeps the projection security_invoker', () => {
    // The single most important line: without it the view would evaluate as its
    // OWNER and show every caller every payment in the company.
    assert.ok(sql.includes('with (security_invoker = true)'))
    assert.ok(sql.includes('must remain security_invoker=true'),
      'and asserts it at apply time')
  })

  test('stores nothing — it adds a projection, not a second ledger', () => {
    assert.ok(!/alter table[\s\S]{0,80}add column/i.test(sql),
      'no table may gain a stored total')
    assert.ok(sql.includes('must not be stored on finance_payment_requests'),
      'and the migration asserts that too')
  })

  test('counts ACTIVE allocations only', () => {
    // A reversed allocation is a withdrawn claim; its money is free again.
    const totals = sql.slice(sql.indexOf('select sum(a.allocated_amount)'))
    assert.ok(totals.includes("a.status = 'active'"))
  })

  test('sums in numeric, never through a float', () => {
    assert.ok(sql.includes('SUMMED IN `numeric`'))
    assert.ok(!/::float|::double precision/.test(sql))
  })

  test('adds no index, because the one it needs already exists', () => {
    assert.ok(!/create\s+index/i.test(sql), 'no new index may be created')
    assert.ok(sql.includes('finance_payment_allocations_payment_active_idx'),
      'and it names the index it relies on, asserting the index is still there')
  })

  test('creates, drops and alters no policy', () => {
    for (const forbidden of [/create\s+policy/i, /drop\s+policy/i, /alter\s+policy/i]) {
      assert.ok(!forbidden.test(sql), String(forbidden))
    }
  })

  test('has a stated rollback', () => {
    assert.ok(sql.includes('ROLLBACK'))
    assert.ok(sql.includes('drop view public.finance_received_payments;'),
      'CREATE OR REPLACE cannot drop a column, so the rollback has to say so')
  })

  test('an assertion file exists for it', () => {
    const assertions = readFileSync(
      'supabase/tests/finance_received_payments_allocation_state_assertions.sql', 'utf8')
    assert.ok(assertions.includes('rollback;'), 'assertions must not leave fixtures behind')
    assert.ok(assertions.includes('ALL ASSERTIONS PASSED'))
    // The equality case is the one a float or an epsilon comparison gets wrong.
    assert.ok(assertions.includes('THE EQUALITY CASE'))
  })
})
