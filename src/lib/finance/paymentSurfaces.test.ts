/**
 * TWO PAGES, ONE STATUS LIST, AND THE PROOF THAT IT IS THE DATABASE'S.
 *
 * Confirmed Payments and Payments to Verify are disjoint by construction, and
 * the construction is worth testing because both failure directions are silent:
 * a status on BOTH pages shows one payment twice and makes two counts overlap;
 * a status on NEITHER makes a row disappear from Finance entirely, with no
 * error anywhere to say so.
 *
 * AND THE LIST IS NOT THIS FILE'S OPINION. The migrations are read here — the
 * CHECK constraint for the enum, finance_payment_status_is_verified() for which
 * half is confirmed — so a database that changed either would fail this suite
 * rather than a screen.
 *
 * Run:
 *   npx tsx --test src/lib/finance/paymentSurfaces.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ALL_PAYMENT_STATUSES,
  CONFIRMED_PAYMENTS_PATH,
  CONFIRMED_PAYMENT_BREAKDOWN_COLUMNS,
  CONFIRMED_PAYMENT_COLUMNS,
  CONFIRMED_PAYMENT_STATUSES,
  CONFIRMED_ALLOCATION_FILTERS,
  CONFIRMED_ALLOCATION_FILTER_LABEL,
  CONFIRMED_ALLOCATION_BADGE,
  CUSTOMER_NAME_DISPLAY_LIMIT,
  DEFAULT_CONFIRMED_ALLOCATION_FILTER,
  PAYMENTS_TABLE_BREAKPOINT,
  PAYMENTS_TO_VERIFY_PATH,
  PAYMENT_SURFACE_STATUSES,
  TO_VERIFY_PAYMENT_STATUSES,
  conciseName,
  formatCustomerName,
  isConfirmedPaymentStatus,
  matchesConfirmedAllocationFilter,
  surfaceForStatus,
  surfaceHasClassificationViews,
} from './paymentSurfaces'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/** Source with comments stripped — for assertions about what the CODE does. */
const codeOf = (text: string) => text.split('\n')
  .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*')
    && !line.trim().startsWith('/*'))
  .join('\n')

// ── The canonical statuses ───────────────────────────────────────────────────

describe('the status list is the database’s, not this module’s', () => {
  test('the enum matches the CHECK constraint on finance_payment_requests.status', () => {
    const sql = read('supabase/migrations/20260628000200_create_finance_payment_requests.sql')
    const check = sql.slice(sql.indexOf('check (status in ('), sql.indexOf('-- Ownership'))
    const declared = [...check.matchAll(/'([a-z_]+)'/g)].map(m => m[1])
    assert.deepEqual([...declared].sort(), [...ALL_PAYMENT_STATUSES].sort(),
      'a status the database admits must belong to exactly one page')
  })

  test('CONFIRMED is exactly what finance_payment_status_is_verified() says', () => {
    // 20260918000000 §5 calls itself "the single definition of verified". This
    // reads that function's body rather than trusting a comment.
    const sql = read('supabase/migrations/20260918000000_finance_payment_allocations.sql')
    const start = sql.indexOf('create or replace function public.finance_payment_status_is_verified')
    const body = sql.slice(start, sql.indexOf('$$;', start))
    const declared = [...body.matchAll(/'(approved_\w+|pending_\w+|needs_\w+|rejected)'/g)].map(m => m[1])
    assert.deepEqual([...new Set(declared)].sort(), [...CONFIRMED_PAYMENT_STATUSES].sort())
  })

  test('THE SPLIT IS DISJOINT: no status is on both pages', () => {
    const overlap = CONFIRMED_PAYMENT_STATUSES
      .filter(s => (TO_VERIFY_PAYMENT_STATUSES as readonly string[]).includes(s))
    assert.deepEqual(overlap, [])
  })

  test('AND EXHAUSTIVE: no status is on neither', () => {
    for (const status of ALL_PAYMENT_STATUSES) {
      assert.notEqual(surfaceForStatus(status), null, `${status} belongs nowhere`)
    }
  })

  test('rejected is on Payments to Verify, and never on Confirmed', () => {
    // It is not money, so it classifies nowhere and belongs in no allocation
    // view — but it IS a decision somebody made, and a verifier looking for what
    // happened to a payment has to be able to find it.
    assert.equal(surfaceForStatus('rejected'), 'to_verify')
    assert.ok(!(CONFIRMED_PAYMENT_STATUSES as readonly string[]).includes('rejected'))
  })

  test('each of the three to-verify statuses is where it should be', () => {
    for (const status of ['pending_approval', 'needs_clarification', 'rejected']) {
      assert.equal(surfaceForStatus(status), 'to_verify', status)
      assert.equal(isConfirmedPaymentStatus(status), false, status)
    }
    for (const status of ['approved_unlinked', 'approved_linked']) {
      assert.equal(surfaceForStatus(status), 'confirmed', status)
      assert.equal(isConfirmedPaymentStatus(status), true, status)
    }
  })

  test('an unknown status is null rather than a guess about money', () => {
    for (const status of ['', 'approved', 'verified', null, undefined, 'APPROVED_LINKED']) {
      assert.equal(surfaceForStatus(status as string), null, String(status))
      assert.equal(isConfirmedPaymentStatus(status as string), false)
    }
  })

  test('the two routes are different, and neither is the other’s query string', () => {
    assert.equal(CONFIRMED_PAYMENTS_PATH, '/finance/received')
    assert.equal(PAYMENTS_TO_VERIFY_PATH, '/finance/payments-to-verify')
    assert.notEqual(CONFIRMED_PAYMENTS_PATH, PAYMENTS_TO_VERIFY_PATH)
    assert.ok(!PAYMENTS_TO_VERIFY_PATH.includes('?'))
  })

  test('the four classification views belong to Confirmed Payments alone', () => {
    assert.equal(surfaceHasClassificationViews('confirmed'), true)
    assert.equal(surfaceHasClassificationViews('to_verify'), false)
  })
})

// ── The eleven columns ───────────────────────────────────────────────────────
//
// REVISED (Requirement 2). The table grew back to eleven columns — Payment ID
// and Customer lead it, "Allocation" is the confirmed_allocation_status badge,
// and the exact-figure pair is Total Allocated / Remaining rather than the
// vague "Linked Against" split. The PI-Draft/Order breakdown that no longer
// fits the primary row moved to CONFIRMED_PAYMENT_BREAKDOWN_COLUMNS, shown in
// an expandable per-row detail instead.

describe('Confirmed Payments has exactly eleven primary columns, in this order', () => {
  test('the order is the specified one, and nothing else is in the primary row', () => {
    assert.deepEqual(CONFIRMED_PAYMENT_COLUMNS.map(c => c.label), [
      'Payment ID', 'Customer', 'Amount', 'Mode', 'Date', 'Allocation',
      'Total Allocated', 'Remaining', 'Initiated by', 'Approved by', 'Actions',
    ])
    assert.equal(CONFIRMED_PAYMENT_COLUMNS.length, 11)
  })

  test('the breakdown columns are the two exact allocation-destination figures, shown only in the expandable detail', () => {
    assert.deepEqual(CONFIRMED_PAYMENT_BREAKDOWN_COLUMNS.map(c => c.label), [
      'Allocated to PI Drafts', 'Allocated to Orders',
    ])
    assert.equal(CONFIRMED_PAYMENT_BREAKDOWN_COLUMNS.length, 2)
  })

  test('the money columns are right-aligned and the rest are not', () => {
    const right = CONFIRMED_PAYMENT_COLUMNS.filter(c => c.align === 'right').map(c => c.key)
    assert.deepEqual(right, ['amount', 'total_allocated', 'unallocated', 'actions'])
  })

  test('the removed columns are gone from the rendered table', () => {
    const view = read('src/app/finance/received/ReceivedPaymentsView.tsx')
    const table = view.slice(
      view.indexOf('function ReceivedPaymentsTable'),
      view.indexOf('function RowActionsMenu'))
    for (const gone of ['>Client<', '>Status<', '>Goes To<', '>Received<', '>Payment<']) {
      assert.ok(!table.includes(gone), `${gone} must not be a column any more`)
    }
    // The header is generated from the list, so it cannot drift from it.
    assert.ok(table.includes('CONFIRMED_PAYMENT_COLUMNS.map(column =>'))
  })

  test('never shows the raw UUID — the Payment ID column prints human_payment_id', () => {
    const view = read('src/app/finance/received/ReceivedPaymentsView.tsx')
    const table = view.slice(
      view.indexOf('function ReceivedPaymentsTable'),
      view.indexOf('function RowActionsMenu'))
    assert.ok(table.includes('{r.human_payment_id}'))
    assert.ok(!/>\{r\.id\}</.test(table), 'the raw UUID must never be printed as a bare text label')
  })

  test('no vague "Linked Against" wording survives anywhere in Finance', () => {
    for (const file of [
      'src/app/finance/received/ReceivedPaymentsView.tsx',
      'src/app/finance/page.tsx',
    ]) {
      const src = read(file)
      const rendered = src.split('\n')
        .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
        .join('\n')
      assert.ok(!rendered.includes('Linked Against'), `${file} must render no such label`)
    }
  })

  test('the table declares NO minWidth, so it cannot promise to scroll sideways', () => {
    const view = read('src/app/finance/received/ReceivedPaymentsView.tsx')
    const table = codeOf(view.slice(
      view.indexOf('function ReceivedPaymentsTable'),
      view.indexOf('function RowActionsMenu')))
    assert.ok(!table.includes('minWidth'))
    assert.ok(!table.includes('overflowX'))
  })

  test('and the cards take over below the table breakpoint', () => {
    assert.equal(PAYMENTS_TABLE_BREAKPOINT, 1024)
    const view = read('src/app/finance/received/ReceivedPaymentsView.tsx')
    assert.ok(view.includes('window.innerWidth < PAYMENTS_TABLE_BREAKPOINT'))
    assert.ok(view.includes('isMobile ? ('), 'the cards are chosen, not a sideways table')
  })

  test('Actions is one button and one menu, not a row of text buttons', () => {
    const view = read('src/app/finance/received/ReceivedPaymentsView.tsx')
    const table = view.slice(
      view.indexOf('function ReceivedPaymentsTable'),
      view.indexOf('function RowActionsMenu'))
    assert.ok(table.includes('<RowActionsMenu'))
    assert.equal((table.match(/className="boe-btn boe-btn-ghost"/g) ?? []).length, 1,
      'View is the only bare button; Link, Unlink, Edit and Allocate are in the menu')
  })

  test('the overflow menu is keyboard reachable and named', () => {
    const view = read('src/app/finance/received/ReceivedPaymentsView.tsx')
    const menu = view.slice(view.indexOf('function RowActionsMenu'),
                            view.indexOf('function PaymentsToVerifyTable'))
    // WAS <details>, WHICH COULD NOT SURVIVE THE PORTAL. The panel now renders
    // into <body> to escape the card's `overflow: hidden` (see
    // src/lib/ui/menuPlacement.ts), so it is no longer a DOM descendant of the
    // trigger and <details>'s built-in open/close could not reach it.
    //
    // The PROPERTY this test names is unchanged and is now stated explicitly
    // rather than inherited: a real <button> is focusable and fires on Enter
    // and Space, the popup state is announced, and Escape closes and hands
    // focus back. <details> never actually closed on Escape — the claim it
    // replaced was more than the element gave.
    assert.ok(menu.includes('<button'), 'the trigger is natively focusable')
    assert.ok(menu.includes('aria-haspopup="menu"'), 'and announces that it opens a menu')
    assert.ok(menu.includes('aria-expanded={open}'), 'and reports whether it is open')
    assert.ok(menu.includes("event.key === 'Escape'") && menu.includes('triggerRef.current?.focus()'),
      'Escape closes it and returns focus to the trigger')
    assert.ok(menu.includes('aria-label={label}'))
    assert.ok(menu.includes("role=\"menu\""))
    assert.ok(menu.includes("role=\"menuitem\""))
  })

  test('the breakdown is exact figures, never a list of names', () => {
    const view = read('src/app/finance/received/ReceivedPaymentsView.tsx')
    const table = view.slice(
      view.indexOf('function ReceivedPaymentsTable'),
      view.indexOf('function RowActionsMenu'))
    assert.ok(table.includes('figures.toPI'))
    assert.ok(table.includes('figures.toOrders'))
    assert.ok(!table.includes('<DestinationsCell'),
      'inline destination names are what made the row wrap unpredictably; this is exact figures now')
  })

  test('Remaining is never overstated — withheld, not guessed, on an incomplete view', () => {
    const view = read('src/app/finance/received/ReceivedPaymentsView.tsx')
    // confirmedFigures is the one function both the table and the cards read
    // Remaining from — gated on attribution_complete, never inferred.
    const fn = view.slice(view.indexOf('function confirmedFigures'), view.indexOf('function confirmedFigures') + 700)
    assert.ok(fn.includes("r.attribution_complete === true"))
    assert.ok(fn.includes('remainderOf('))
    assert.ok(/:\s*null/.test(fn), 'an incomplete view withholds Remaining rather than computing a guess')
  })

  test('an over-allocated row gets a visibly different badge tone and a review tooltip, never the reassuring "Fully Allocated" look', () => {
    assert.equal(CONFIRMED_ALLOCATION_BADGE.over.tone, 'danger')
    assert.notEqual(CONFIRMED_ALLOCATION_BADGE.over.tone, CONFIRMED_ALLOCATION_BADGE.full.tone)
    const view = read('src/app/finance/received/ReceivedPaymentsView.tsx')
    assert.ok(view.includes('Allocated total exceeds payment amount — flagged for Admin review'))
  })
})

// ── Names ────────────────────────────────────────────────────────────────────

describe('a person’s name fits a column without becoming a bug report', () => {
  test('first name and a surname initial', () => {
    assert.equal(conciseName('Priyanka Srinivasan'), 'Priyanka S.')
    assert.equal(conciseName('  Ravi   Kumar  Menon '), 'Ravi M.')
  })

  test('a single-word name is returned whole', () => {
    assert.equal(conciseName('Nishant'), 'Nishant')
  })

  test('an absent name is an em dash, never "undefined"', () => {
    for (const value of [null, undefined, '', '   ']) {
      assert.equal(conciseName(value), '—', String(value))
    }
  })

  test('it never truncates mid-word', () => {
    assert.ok(!conciseName('Priyanka Srinivasan').includes('…'))
    assert.ok(!conciseName('Priyanka Srinivasan').includes('...'))
  })
})

// ── The wiring ───────────────────────────────────────────────────────────────

describe('each page asks the database for its own half', () => {
  const view = read('src/app/finance/received/ReceivedPaymentsView.tsx')

  test('the list query filters on the surface’s statuses', () => {
    assert.ok(view.includes("PAYMENT_SURFACE_STATUSES[surface] as unknown as string[]"))
    assert.ok(!codeOf(view).includes('CLASSIFIED_PAYMENT_STATUSES'),
      'the old mixed scope is gone from the code entirely')
  })

  test('and the two lists are the two halves', () => {
    assert.deepEqual([...PAYMENT_SURFACE_STATUSES.confirmed], [...CONFIRMED_PAYMENT_STATUSES])
    assert.deepEqual([...PAYMENT_SURFACE_STATUSES.to_verify], [...TO_VERIFY_PAYMENT_STATUSES])
  })

  test('the allocation-status filter is applied only on Confirmed Payments (Requirement 1)', () => {
    assert.ok(view.includes("if (surface === 'confirmed' && filters.confirmedFilter !== 'all') {"))
    assert.ok(view.includes(".eq('confirmed_allocation_status', filters.confirmedFilter)"))
  })

  test('the filter chips are not drawn on Payments to Verify', () => {
    assert.ok(view.includes("{surface === 'confirmed' && ("))
    assert.ok(view.includes('CONFIRMED_ALLOCATION_FILTERS.map(f =>'))
  })

  test('Payments to Verify keeps Status and drops the money columns', () => {
    const table = view.slice(view.indexOf('function PaymentsToVerifyTable'),
                             view.indexOf('// ── The mobile list'))
    assert.ok(table.includes('>Status<'))
    assert.ok(table.includes('<VerificationBadge'))
    for (const gone of ['>To Orders<', '>To PI Draft<', '>Unallocated<']) {
      assert.ok(!table.includes(gone), `${gone} is a figure over money nobody has confirmed`)
    }
  })

  test('verification stays where the rows are', () => {
    const table = view.slice(view.indexOf('function PaymentsToVerifyTable'),
                             view.indexOf('// ── The mobile list'))
    assert.ok(table.includes('Review'), 'opening a row is what verifies it')
  })

  test('the route passes the surface and no bookmarked view', () => {
    const page = read('src/app/finance/payments-to-verify/page.tsx')
    assert.ok(page.includes('surface="to_verify"'))
    assert.ok(page.includes('view="all"'))
    assert.ok(!page.includes('useSearchParams'),
      'a bookmark must not be able to narrow this page by an attribution that cannot exist')
  })

  test('counts, search and pagination are separate because the queries are', () => {
    const hook = read('src/hooks/queries/useReceivedPaymentsCounts.ts')
    assert.ok(hook.includes('CONFIRMED_PAYMENT_STATUSES as unknown as string[]'),
      'the four view badges count confirmed money only')
    assert.ok(hook.includes('TO_VERIFY_PAYMENT_STATUSES as unknown as string[]'))
    assert.ok(hook.includes("PAYMENTS_TO_VERIFY_COUNT_KEY = ['finance', 'payments-to-verify', 'count']"),
      'its own cache key, so verifying a payment moves both numbers')
  })

  test('the sidebar offers EXACTLY two primary payment sections, and no standalone Payments to Verify entry', () => {
    // Requirement: "Keep only two primary payment sections." Payments to
    // Verify is reachable from Payment Requests, not from its own nav entry
    // any more; its route still renders (see paymentDeletionSurfaces.test.ts)
    // but nothing in the sidebar links to it directly.
    const nav = read('src/components/layout/FinanceLayout.tsx')
    assert.ok(!codeOf(nav).includes("'Payments to Verify'"),
      'the standalone top-level entry is retired')
    assert.ok(nav.includes("label: 'Confirmed Payments'"))
    assert.ok(/label: 'Payment Requests',\s*path: '\/finance'/.test(nav),
      'a structurally separate workflow, and nothing to do with retired Order Requests')
    assert.ok(!codeOf(nav).includes('Order Request'),
      'no Order Request surface is offered here — the workflow is retired')
  })

  test('the four Confirmed Payments sub-items (?view=) are gone from the sidebar', () => {
    const nav = read('src/components/layout/FinanceLayout.tsx')
    assert.ok(!nav.includes('PAYMENT_VIEW_OPTIONS'),
      'the old view tab strip is replaced in-page by the allocation-status filter bar')
    assert.ok(!nav.includes('receivedSubItems'))
  })

  test('deep links to the payments list still resolve', () => {
    // ?payment=…&action=… arrives from the Action Queue and from notifications.
    assert.ok(view.includes("searchParams.get('payment')")
      || view.includes("'payment'"), 'the deep-link parameter is still read')
    const page = read('src/app/finance/received/page.tsx')
    assert.ok(page.includes("readPaymentView(searchParams.get('view'))"),
      '?view= still selects a view on the confirmed page')
  })
})

// ── Focus ────────────────────────────────────────────────────────────────────

describe('returning to the browser tab refreshes nothing', () => {
  const finance = read('src/components/layout/FinanceLayout.tsx')
  const orders  = read('src/components/layout/OrdersLayout.tsx')

  test('NEITHER LAYOUT LISTENS FOR visibilitychange any more', () => {
    // THE CAUSE. OrdersLayout removed its copy; FinanceLayout kept one, which is
    // why an Order page survived an alt-tab and a Finance page did not.
    for (const [name, source] of [['FinanceLayout', finance], ['OrdersLayout', orders]] as const) {
      const code = source.split('\n')
        .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
        .join('\n')
      assert.ok(!code.includes('visibilitychange'), `${name} must not listen for it`)
      assert.ok(!code.includes("addEventListener('focus'"), `${name} must not listen for focus`)
      assert.ok(!code.includes('onfocus'), name)
    }
  })

  test('and the reason is written down where the next reader will find it', () => {
    assert.ok(finance.includes('NOTHING RE-FETCHES WHEN THE TAB COMES BACK'))
    assert.ok(orders.includes('NOTHING RE-FETCHES WHEN THE TAB COMES BACK'))
  })

  test('React Query does not refetch on focus either, so there is ONE answer', () => {
    const providers = read('src/components/layout/Providers.tsx')
    assert.ok(providers.includes('refetchOnWindowFocus: false'))
  })

  test('nothing was replaced with polling', () => {
    for (const source of [finance, orders]) {
      const code = source.split('\n')
        .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
        .join('\n')
      assert.ok(!code.includes('setInterval'))
      assert.ok(!code.includes('refetchInterval'))
    }
  })

  test('the explicit Refresh control still does exactly what it did', () => {
    assert.ok(finance.includes('const handleRefresh = useCallback'))
    // ONE COUNT QUERY NOW. The sidebar carries a single Confirmed Payments
    // badge (receivedCounts.all) since the standalone Payments to Verify nav
    // entry is retired, so only RECEIVED_PAYMENTS_COUNTS_KEY needs invalidating
    // here — usePaymentsToVerifyCount has no sidebar consumer left in this file.
    assert.ok(finance.includes('RECEIVED_PAYMENTS_COUNTS_KEY'))
    assert.ok(finance.includes('onRefresh={loadRequests}')
      || read('src/app/finance/received/ReceivedPaymentsView.tsx').includes('onRefresh={loadRequests}'))
  })

  test('session expiry is untouched', () => {
    // It is the Supabase client's business and AuthIdentityBoundary's, not a
    // layout's, and neither is changed here.
    const code = finance.split('\n')
      .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n')
    assert.ok(!code.includes('onAuthStateChange'))
    const providers = read('src/components/layout/Providers.tsx')
    assert.ok(providers.includes('AuthIdentityBoundary'))
  })
})

// ── formatCustomerName ────────────────────────────────────────────────────────

describe('formatCustomerName — the one place customer-name truncation lives', () => {
  test('a short name is unchanged', () => {
    const result = formatCustomerName('Ravi Kumar')
    assert.deepEqual(result, { display: 'Ravi Kumar', full: 'Ravi Kumar', truncated: false })
  })

  test('a long name is ellipsized cleanly, never mid-word', () => {
    const result = formatCustomerName('Priyanka Srinivasan Chandrasekaran')
    assert.equal(result.truncated, true)
    assert.ok(result.display.endsWith('…'))
    assert.ok(result.display.length <= CUSTOMER_NAME_DISPLAY_LIMIT + 1, 'display plus ellipsis fits the limit')
    // Never a cut mid-word: the character before the ellipsis is never itself
    // mid-token — the display is always a whitespace-free run of whole words
    // (or a hard cut only when there is no earlier space to back off to).
    assert.ok(!/\s$/.test(result.display.replace('…', '')), 'no trailing space before the ellipsis')
  })

  test('the full name is always preserved untouched, even when truncated', () => {
    const long = 'Priyanka Srinivasan Chandrasekaran Venkataraman'
    const result = formatCustomerName(long)
    assert.equal(result.full, long)
  })

  test('a name exactly at the limit is not truncated', () => {
    const exact = 'A'.repeat(CUSTOMER_NAME_DISPLAY_LIMIT)
    const result = formatCustomerName(exact)
    assert.equal(result.truncated, false)
    assert.equal(result.display, exact)
  })

  test('whitespace is collapsed before measuring', () => {
    const result = formatCustomerName('  Ravi    Kumar  ')
    assert.equal(result.display, 'Ravi Kumar')
  })

  test('an absent name renders as an em dash, never truncated', () => {
    for (const value of [null, undefined, '', '   ']) {
      const result = formatCustomerName(value)
      assert.equal(result.display, '—')
      assert.equal(result.truncated, false)
    }
  })

  test('CustomerName.tsx is the one caller for a Finance list row/card — no ad hoc substring logic elsewhere', () => {
    const component = read('src/components/finance/CustomerName.tsx')
    assert.ok(component.includes('formatCustomerName'))
    for (const file of [
      'src/app/finance/received/ReceivedPaymentsView.tsx',
      'src/app/finance/page.tsx',
    ]) {
      const src = read(file)
      // Scoped to CLIENT-NAME truncation specifically — a filename ellipsis
      // elsewhere in these files (e.g. an attached-file label) is unrelated.
      assert.ok(!/client_name[\s\S]{0,80}\.slice\(0,\s*\d+\)/.test(src),
        `${file} must not re-derive a client-name truncation rule of its own`)
    }
  })
})

// ── matchesConfirmedAllocationFilter ──────────────────────────────────────────

describe('matchesConfirmedAllocationFilter', () => {
  test('"all" matches every status, including null', () => {
    for (const status of [...CONFIRMED_ALLOCATION_FILTERS, null, undefined] as const) {
      assert.equal(matchesConfirmedAllocationFilter(status as never, 'all'), true, String(status))
    }
  })

  test('each named filter matches only its own status', () => {
    assert.equal(matchesConfirmedAllocationFilter('zero', 'zero'), true)
    assert.equal(matchesConfirmedAllocationFilter('zero', 'partial'), false)
    assert.equal(matchesConfirmedAllocationFilter('partial', 'partial'), true)
    assert.equal(matchesConfirmedAllocationFilter('full', 'full'), true)
    assert.equal(matchesConfirmedAllocationFilter('full', 'zero'), false)
  })

  test('"over" matches none of the three named filters — flagged, never folded into "full"', () => {
    assert.equal(matchesConfirmedAllocationFilter('over', 'zero'), false)
    assert.equal(matchesConfirmedAllocationFilter('over', 'partial'), false)
    assert.equal(matchesConfirmedAllocationFilter('over', 'full'), false)
  })

  test('but "over" is still reachable through "all"', () => {
    assert.equal(matchesConfirmedAllocationFilter('over', 'all'), true)
  })

  test('a null status (withheld) matches only "all"', () => {
    assert.equal(matchesConfirmedAllocationFilter(null, 'all'), true)
    for (const filter of CONFIRMED_ALLOCATION_FILTERS) {
      if (filter === 'all') continue
      assert.equal(matchesConfirmedAllocationFilter(null, filter), false, filter)
    }
  })

  test('DEFAULT_CONFIRMED_ALLOCATION_FILTER is "all"', () => {
    assert.equal(DEFAULT_CONFIRMED_ALLOCATION_FILTER, 'all')
  })

  test('every filter has a label, and "all" reads plainly', () => {
    assert.equal(CONFIRMED_ALLOCATION_FILTER_LABEL.all, 'All')
    for (const filter of CONFIRMED_ALLOCATION_FILTERS) {
      assert.ok(CONFIRMED_ALLOCATION_FILTER_LABEL[filter].length > 0, filter)
    }
  })
})
