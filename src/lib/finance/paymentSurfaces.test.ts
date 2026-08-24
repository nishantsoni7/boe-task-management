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
  CONFIRMED_PAYMENT_COLUMNS,
  CONFIRMED_PAYMENT_STATUSES,
  PAYMENTS_TABLE_BREAKPOINT,
  PAYMENTS_TO_VERIFY_PATH,
  PAYMENT_SURFACE_STATUSES,
  TO_VERIFY_PAYMENT_STATUSES,
  conciseName,
  isConfirmedPaymentStatus,
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

// ── The nine columns ─────────────────────────────────────────────────────────

describe('Confirmed Payments has exactly nine columns, in this order', () => {
  test('the order is the specified one, and nothing else is in the table', () => {
    assert.deepEqual(CONFIRMED_PAYMENT_COLUMNS.map(c => c.label), [
      'Amount', 'Mode', 'Date', 'To Orders', 'To PI Draft',
      'Unallocated', 'Initiated by', 'Approved by', 'Actions',
    ])
    assert.equal(CONFIRMED_PAYMENT_COLUMNS.length, 9)
  })

  test('the money columns are right-aligned and the rest are not', () => {
    const right = CONFIRMED_PAYMENT_COLUMNS.filter(c => c.align === 'right').map(c => c.key)
    assert.deepEqual(right, ['amount', 'to_orders', 'to_pi_draft', 'unallocated', 'actions'])
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
    assert.ok(menu.includes('<details'), 'focus, Enter and Escape come free with details')
    assert.ok(menu.includes('aria-label={label}'))
    assert.ok(menu.includes("role=\"menu\""))
    assert.ok(menu.includes("role=\"menuitem\""))
  })

  test('the two money columns carry a COUNT, never a list of names', () => {
    const view = read('src/app/finance/received/ReceivedPaymentsView.tsx')
    const table = view.slice(
      view.indexOf('function ReceivedPaymentsTable'),
      view.indexOf('function RowActionsMenu'))
    assert.ok(table.includes('view.counts.orders > 1'))
    assert.ok(table.includes('view.counts.submissions > 1'))
    assert.ok(!table.includes('<DestinationsCell'),
      'inline destination names are what made the row wrap unpredictably')
  })

  test('Unallocated is never overstated', () => {
    const view = read('src/app/finance/received/ReceivedPaymentsView.tsx')
    const table = view.slice(
      view.indexOf('function ReceivedPaymentsTable'),
      view.indexOf('function RowActionsMenu'))
    // MoneyCell draws an em dash for null, and the projection returns null when
    // the reader cannot see every allocation.
    assert.ok(table.includes('<MoneyCell value={view.figures.available} />'))
    assert.ok(table.includes('view.figures.overAllocated'),
      'an over-allocated row is marked rather than capped')
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

  test('the classification views are applied only on Confirmed Payments', () => {
    assert.ok(view.includes('if (surfaceHasClassificationViews(surface)) {'))
  })

  test('the four tabs are not drawn on Payments to Verify', () => {
    assert.ok(view.includes('classificationReady && surfaceHasClassificationViews(surface)'))
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

  test('the nav offers both, and Payment Requests is untouched', () => {
    const nav = read('src/components/layout/FinanceLayout.tsx')
    assert.ok(nav.includes('Payments to Verify'))
    assert.ok(nav.includes('Confirmed Payments'))
    assert.ok(nav.includes("{ label: 'Payment Requests', path: '/finance'"),
      'a structurally separate workflow, and nothing to do with retired Order Requests')
    assert.ok(!codeOf(nav).includes('Order Request'),
      'no Order Request surface is offered here — the workflow is retired')
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
    assert.ok(finance.includes('RECEIVED_PAYMENTS_COUNTS_KEY'))
    assert.ok(finance.includes('PAYMENTS_TO_VERIFY_COUNT_KEY'),
      'both counts, because verifying a payment moves it between them')
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
