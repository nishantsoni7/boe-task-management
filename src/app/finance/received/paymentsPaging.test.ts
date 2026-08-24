/**
 * The payments list is paged, and every narrowing survives the paging.
 *
 * WHY THIS IS A FILE OF ITS OWN
 * -----------------------------
 * A PostgREST response is capped at 1000 rows on this project, and the cap is
 * SILENT: no error field, no warning, a plausible-looking array. Ordered
 * newest-first, the 1001st payment starts pushing the OLDEST money out of
 * Finance with a confident row count beside it. That is the failure
 * src/lib/supabasePaging.ts documents costing the Performance module three
 * quarters of its data.
 *
 * Paging fixes that and creates a second, subtler failure in its place: a filter
 * applied AFTER the page has loaded narrows fifty rows and silently hides every
 * match on page two, while the count beside it describes a set nobody is looking
 * at. So the assertions here come in pairs — the list is bounded, AND every
 * narrowing is the database's.
 *
 * The four views make that sharper still. They are not a partition: a payment
 * split between an Order and a PI Draft with money left over is in three of
 * them, so the counts beside the tabs cannot be reconciled against each other
 * and each must be its own exact query.
 *
 * Reads repository files and pure helpers. No DB, no network.
 *
 * Run:
 *   npx tsx --test src/app/finance/received/paymentsPaging.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  RECEIVED_PAYMENTS_PAGE_SIZE,
  clampPage,
  pageCount,
  pageRange,
  resultSummary,
} from '../receivedPaymentsQuery'
import { PAYMENT_VIEWS, paymentViewClauses, readPaymentView } from '@/lib/finance/paymentClassification'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const VIEW = 'src/app/finance/received/ReceivedPaymentsView.tsx'
const COUNTS = 'src/hooks/queries/useReceivedPaymentsCounts.ts'
const ROUTE = 'src/app/finance/received/page.tsx'

const view = read(VIEW)
/** The loader alone — everything the list sends the database, and nothing else. */
const loader = view.slice(view.indexOf('const loadRequests'), view.indexOf('const loadAllocations'))

// ══ 1. Exact counts ═══════════════════════════════════════════════════════════

describe('exact counts', () => {
  test('the list asks for an exact count, not the length of what arrived', () => {
    assert.ok(loader.includes("{ count: 'exact' }"),
      'the toolbar states the size of the WHOLE narrowed set')
    assert.ok(view.includes('setTotal(count ?? null)'))
  })

  test('a count that could not be read is null, and the line says less rather than guessing', () => {
    assert.equal(
      resultSummary({ loading: false, shown: 12, total: null, narrowed: false, page: 1, pages: 1 }),
      '12 payments',
      'with no exact count it describes the page in hand and claims nothing more')
    assert.equal(
      resultSummary({ loading: false, shown: 50, total: 137, narrowed: false, page: 2, pages: 3 }),
      '137 payments · page 2 of 3')
  })

  test('a narrowed count is described AS narrowed, never as the whole set', () => {
    assert.equal(
      resultSummary({ loading: false, shown: 4, total: 4, narrowed: true, page: 1, pages: 1 }),
      '4 matching payments')
    assert.equal(
      resultSummary({ loading: false, shown: 0, total: 0, narrowed: true, page: 1, pages: 1 }),
      'No matches')
  })

  test('each tab gets its OWN exact count, because the four do not sum to All', () => {
    // A payment split between an Order and a PI with a balance left over is
    // counted in three of them, because it genuinely is in three. Deriving one
    // from the others would produce a number that describes nothing.
    const counts = read(COUNTS)
    assert.ok(counts.includes("{ count: 'exact', head: true }"))
    assert.ok(counts.includes('PAYMENT_VIEWS.map(view => scopedFor(view))'),
      'one query per view, all four issued together')
    assert.ok(counts.includes('paymentViewClauses(view)'),
      'and each narrowed by the SAME predicate the list uses')
    assert.match(counts, /THE FOUR ARE NOT A PARTITION/)
  })

  test('head: true — the counts pull no rows, however large the ledger grows', () => {
    assert.ok(read(COUNTS).includes('head: true'))
  })
})

// ══ 2. Server-side filtering ══════════════════════════════════════════════════

describe('every narrowing is the database\'s', () => {
  test('search, the view, the dates and the allocation state are all sent', () => {
    for (const applied of [
      'if (filters.search) scoped = scoped.or(filters.search)',
      'paymentViewFilterClauses(filters.view)',
      "scoped.gte('payment_date', filters.dateFrom)",
      "scoped.lte('payment_date', filters.dateTo)",
      'allocationFilterClauses(filters.allocation)',
    ]) {
      assert.ok(loader.includes(applied), applied)
    }
  })

  test('and the page range is applied to the SAME query', () => {
    // So it is the narrowing that is paged, not the page that is narrowed.
    assert.ok(loader.includes('.range(range.from, range.to)'))
    const filterAt = loader.indexOf('paymentViewFilterClauses')
    const rangeAt = loader.indexOf('.range(range.from, range.to)')
    assert.ok(filterAt > 0 && rangeAt > filterAt,
      'the range must be applied after the filters, to the same builder')
  })

  test('nothing is filtered in the browser after the rows arrive', () => {
    // THE DEFECT THIS PINS. A `.filter()` over `requests` would narrow the fifty
    // rows in hand and hide every match on page two, while the exact count
    // beside it described the whole set — two numbers that cannot both be right.
    assert.ok(view.includes('const visible = requests'),
      'the rows ARE the answer, not a starting point to filter')
    assert.equal(/const visible = requests\s*\.\s*filter/.test(view), false)
  })

  test('THE SURFACE\'S OWN STATUS SCOPE is sent too, so the two pages are disjoint', () => {
    // This used to be CLASSIFIED_PAYMENT_STATUSES — everything except rejected —
    // which put money that had arrived and money nobody had looked at yet in one
    // list, and computed every count, search result and page number over the
    // mixture. Each page now asks for exactly its half.
    assert.ok(loader.includes("in('status', PAYMENT_SURFACE_STATUSES[surface]"))
    const code = loader.split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
    assert.ok(!code.includes('CLASSIFIED_PAYMENT_STATUSES'),
      'the old mixed scope is gone from the code; the comment records why')
  })

  test('a search term is a LITERAL before it reaches a filter group', () => {
    // A comma or a bracket would otherwise be parsed as MORE FILTER, and the
    // query would come back describing a question nobody asked.
    assert.ok(view.includes('receivedPaymentsSearchFilter(search)'))
  })
})

// ══ 3. Deterministic ordering ═════════════════════════════════════════════════

describe('deterministic ordering', () => {
  test('the list orders by created_at AND THEN by id', () => {
    // range() maps to LIMIT/OFFSET, which makes no promise about row order
    // unless the ordering is total. Two payments recorded in the same instant
    // could otherwise swap between pages — showing one twice and hiding the
    // other, which is the paging bug that looks like data loss.
    assert.ok(loader.includes(".order('created_at', { ascending: false })"))
    assert.ok(loader.includes(".order('id', { ascending: false })"))
    const createdAt = loader.indexOf(".order('created_at'")
    const id = loader.indexOf(".order('id'")
    assert.ok(createdAt < id, 'created_at is the primary key of the ordering, id breaks its ties')
  })
})

// ══ 4. More than 1,000 records ════════════════════════════════════════════════

describe('a ledger larger than the silent cap', () => {
  test('a page is comfortably under the 1000-row ceiling', () => {
    assert.ok(RECEIVED_PAYMENTS_PAGE_SIZE > 0)
    assert.ok(RECEIVED_PAYMENTS_PAGE_SIZE < 1000,
      'a page must never be the thing that gets clipped')
  })

  test('4,137 payments page correctly, from the first row to the last', () => {
    const total = 4137
    const pages = pageCount(total)
    assert.equal(pages, Math.ceil(total / RECEIVED_PAYMENTS_PAGE_SIZE))

    // EVERY row is reachable, exactly once. This is the assertion that would
    // have caught the silent truncation: with no paging at all, rows 1000..4136
    // are unreachable and nothing says so.
    let covered = 0
    let previousTo = -1
    for (let page = 1; page <= pages; page++) {
      const range = pageRange(page)
      assert.equal(range.from, previousTo + 1, `page ${page} must start where page ${page - 1} ended`)
      previousTo = range.to
      covered += Math.min(range.to, total - 1) - range.from + 1
    }
    assert.equal(covered, total, 'every payment is on exactly one page')
    assert.ok(previousTo >= total - 1, 'and the last page reaches the last row')
  })

  test('the page far past 1000 is a real offset, not a clipped one', () => {
    const range = pageRange(41)
    assert.equal(range.from, 40 * RECEIVED_PAYMENTS_PAGE_SIZE)
    assert.equal(range.to, 41 * RECEIVED_PAYMENTS_PAGE_SIZE - 1)
    assert.ok(range.from > 1000, 'the offset must go past the cap the old list died at')
  })

  test('a page number below 1 is read as the first page, never as a negative offset', () => {
    // PostgREST refuses a negative range outright, which blanks the list instead
    // of showing it. A page number is a URL somebody can type.
    for (const page of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(pageRange(page).from, 0, `page ${page}`)
    }
  })

  test('a page past the end is clamped rather than left showing an empty table', () => {
    assert.equal(clampPage(400, 137), pageCount(137))
    assert.equal(clampPage(2, 137), 2)
    // An empty set is "Page 1 of 1", not "Page 1 of 0".
    assert.equal(pageCount(0), 1)
    assert.equal(pageCount(null), 1)
  })
})

// ══ 5. Stale response suppression ═════════════════════════════════════════════

describe('a stale answer never repaints a newer page', () => {
  test('every load claims a token, and only the newest may write to state', () => {
    // THE DEFECT: a slow query for "REQ" landing after a fast one for
    // "REQ-2026" repaints the wider result under a narrower search box.
    assert.ok(view.includes('const loadToken = useRef(0)'))
    assert.ok(loader.includes('const token = ++loadToken.current'))
    assert.ok(loader.includes('if (token !== loadToken.current) return'),
      'a superseded load must return before it touches state')
  })

  test('the follow-up reads are token-guarded too', () => {
    // The allocation read and the target-label read both land AFTER the list,
    // and both would otherwise paint one page's allocations over another's rows.
    const after = view.slice(view.indexOf('const loadAllocations'))
    const guards = after.split('if (token !== loadToken.current) return').length - 1
    assert.ok(guards >= 2, 'each follow-up read checks the token before writing')
  })

  test('the search box is debounced, so a fast typist issues one query, not eight', () => {
    assert.ok(view.includes('SEARCH_DEBOUNCE_MS'))
    assert.ok(view.includes('setTimeout(() => { loadRequests() }, SEARCH_DEBOUNCE_MS)'))
    assert.ok(view.includes('return () => clearTimeout(timer)'),
      'and an abandoned keystroke cancels its own query')
  })

  test('changing a narrowing returns the reader to page one', () => {
    // Staying on page four of a set that now has one page shows an empty table
    // over a filter that matches plenty.
    assert.ok(view.includes('const narrowBy = <T,>(set: (value: T) => void) => (value: T) => { set(value); setPage(1) }'))
    for (const control of ['applySearch', 'applyDateFrom', 'applyDateTo', 'applyAllocation']) {
      // Aligned assignments in the source, so the spacing is not part of the
      // contract being asserted.
      assert.match(view, new RegExp(`const ${control}\\s*= narrowBy\\(`), control)
    }
  })

  test('changing the VIEW returns to page one too, without an effect that re-renders', () => {
    // The view arrives as a PROP from the route, so there is no click to hang a
    // reset on. Deriving it is what keeps this out of an effect that would set
    // state during a render it also caused.
    assert.ok(view.includes('const [pageState, setPageState] = useState<{ view: PaymentView; page: number }>'))
    assert.ok(view.includes('const page = pageState.view === view ? pageState.page : 1'))
  })
})

// ══ 6. Deep links ═════════════════════════════════════════════════════════════

describe('deep links', () => {
  test('the view is a route parameter, so a tab is shareable and survives a refresh', () => {
    assert.ok(read(ROUTE).includes("readPaymentView(searchParams.get('view'))"))
    for (const value of PAYMENT_VIEWS) {
      assert.equal(readPaymentView(value), value)
    }
  })

  test('an unrecognised view resolves to All rather than to an empty list', () => {
    assert.equal(readPaymentView('linked'), 'all')
    assert.equal(readPaymentView(null), 'all')
    assert.equal(readPaymentView('ORDERS'), 'all')
  })

  test('a ?payment= link opens the record even when it is on another page', () => {
    // THE DEFECT PAGING CREATED. Before the list was paged it held every
    // approved payment, so a deep link's target was always among the loaded
    // rows. Now it is one page of fifty, and a link into a payment recorded
    // months ago would silently do nothing.
    const resolver = view.slice(view.indexOf('const resolveDeepLink'))
    assert.ok(resolver.includes('let match = requests.find(r => r.id === paymentId) ?? null'))
    assert.ok(resolver.includes('const onThisPage = match !== null'))
    assert.ok(resolver.includes('.eq(\'id\', paymentId)'),
      'a miss is followed by one read for that one payment')
    assert.ok(resolver.includes('.maybeSingle()'))
  })

  test('a payment the reader may not see resolves to nothing, not to an error', () => {
    // The same security_invoker projection the list reads, so RLS decides
    // exactly as it does for the list.
    const resolver = view.slice(view.indexOf('const resolveDeepLink'))
    assert.ok(resolver.includes('RECEIVED_PAYMENTS_SOURCE'))
    assert.ok(resolver.includes('if (match) {'), 'a miss simply shows the first page')
  })

  test('the deep-link parameters are dropped once handled', () => {
    // So a refresh or a back-navigation cannot reopen a modal the reader closed.
    assert.ok(view.includes('router.replace(viewHref(view))'))
  })

  test('the resolution runs exactly once', () => {
    assert.ok(view.includes('const deepLinkHandled = useRef(false)'))
    assert.ok(view.includes('if (pageLoading || deepLinkHandled.current) return'))
    assert.ok(view.includes('deepLinkHandled.current = true'))
  })

  test('the two retired child routes forward the whole query string', () => {
    const forward = read('src/app/finance/received/RetiredReceivedRoute.tsx')
    assert.ok(forward.includes('new URLSearchParams(searchParams.toString())'))
    assert.ok(forward.includes("params.set('view', view)"))
    assert.ok(forward.includes('router.replace('),
      'a forward, not a push — Back must still return where the reader came from')
  })
})

// ══ 7. The narrowing and the count cannot disagree ════════════════════════════

describe('the list and the badge beside it are one predicate', () => {
  test('both build their filters from paymentViewClauses, not from a copy', () => {
    assert.ok(view.includes('paymentViewFilterClauses(filters.view)'))
    assert.ok(read(COUNTS).includes('paymentViewClauses(view)'))
  })

  test('and from the same status scope — the confirmed half, on both', () => {
    // The four badges sit beside the four Confirmed Payments views, so they
    // count what that page shows. A badge measuring a wider set than its own
    // list is a number nobody can reconcile against the rows under it.
    assert.ok(loader.includes('PAYMENT_SURFACE_STATUSES[surface]'))
    assert.ok(read(COUNTS).includes('CONFIRMED_PAYMENT_STATUSES'))
  })

  test('every view is a single equality on a column the projection computes', () => {
    for (const value of PAYMENT_VIEWS) {
      const clauses = paymentViewClauses(value)
      assert.ok(clauses.length <= 1, `${value} must narrow with at most one clause`)
      for (const clause of clauses) {
        assert.equal(clause.kind, 'eq')
        assert.equal(clause.value, 'true')
      }
    }
  })
})
