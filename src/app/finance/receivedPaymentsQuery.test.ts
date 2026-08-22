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
 *   2. THE LINKAGE FILTER SEES AN ALLOCATED PAYMENT. Money that reached a
 *      Confirmed Order through an ACTIVE ALLOCATION — the way PI conversion
 *      moves it — is found by the "Confirmed Order" filter, and is NOT also
 *      found by "Order Request". It used to be found by neither.
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
  LINKAGE_FILTER_OPTIONS,
  RECEIVED_PAYMENTS_PAGE_SIZE,
  RECEIVED_PAYMENTS_SEARCH_COLUMNS,
  dateBound,
  dateRange,
  isLinkageFilter,
  isNarrowed,
  linkageFilterClauses,
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

// ── 2. The linkage filter sees an allocated payment ──────────────────────────

describe('the linkage filter and the badge answer the same question', () => {
  test('THE DEFECT: an allocation-linked payment is found by "Confirmed Order"', () => {
    // A PI's money reaches its Order by the allocation MOVING — the payment row
    // keeps order_id NULL. The old filter tested order_id alone, so this money
    // showed "Order ORD-…" in its row and then matched neither narrowing.
    const clauses = linkageFilterClauses('order')
    assert.equal(clauses.length, 1)
    assert.deepEqual(clauses[0], {
      kind: 'or',
      filters: 'order_id.not.is.null,allocated_order_id.not.is.null',
    })
  })

  test('and is NOT also found by "Order Request" — the two are exclusive', () => {
    // resolveLinkedAgainst gives a Confirmed Order priority over an Order
    // Request, so the request branch must exclude BOTH Order attachments or a
    // row would satisfy both filters and be counted twice by a reader.
    const clauses = linkageFilterClauses('request')
    assert.deepEqual(clauses, [
      { kind: 'isNull',  column: 'order_id' },
      { kind: 'isNull',  column: 'allocated_order_id' },
      { kind: 'notNull', column: 'order_request_id' },
    ])
  })

  test('"all" narrows nothing', () => {
    assert.deepEqual(linkageFilterClauses('all'), [])
  })

  test('every offered option is a filter the module implements', () => {
    for (const option of LINKAGE_FILTER_OPTIONS) {
      assert.ok(isLinkageFilter(option.value), option.value)
    }
    assert.ok(!isLinkageFilter('something-else'))
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
    const none = { search: '', linkage: 'all' as const, dateFrom: null, dateTo: null }
    assert.equal(isNarrowed(none), false)
    assert.equal(isNarrowed({ ...none, search: 'REQ-1' }), true)
    assert.equal(isNarrowed({ ...none, linkage: 'order' }), true)
    assert.equal(isNarrowed({ ...none, dateFrom: '2026-08-01' }), true)
    assert.equal(isNarrowed({ ...none, dateTo: '2026-08-31' }), true)
  })

  test('a term of only stripped characters is not a narrowing', () => {
    // It matches nothing and filters nothing; offering "Clear filters" for it
    // would be describing a state the page is not in.
    assert.equal(isNarrowed({ search: '%%%', linkage: 'all', dateFrom: null, dateTo: null }), false)
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
