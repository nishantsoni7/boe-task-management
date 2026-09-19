/**
 * PR #171 correction pass (2026-09-19): three verified defects, pinned.
 *
 *   1. Confirmed Payments: an empty allocation-status tab said "No payments
 *      received yet" — a false business statement while payments sat in other
 *      tabs. The empty state now tells loading, a read failure, no payments at
 *      all and "nothing matches" apart, and offers one way out of all
 *      constraints at once.
 *   2. Confirmed Orders: the pending search is flushed on blur, and an Order
 *      opened straight after typing carries the typed term in its returnTo.
 *   3. The shared Notifications sidebar entry is a real link.
 */
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  confirmedListEmptyKind,
  confirmedListUrlPatch,
  SHOW_ALL_PAYMENTS_STATE,
  type ConfirmedListEmptyKind,
} from '@/app/finance/receivedPaymentsQuery'
import { ConfirmedListEmptyState } from '@/app/finance/received/ReceivedPaymentsView'
import { mergeSearchParams } from './urlMirror'
import { listReturnPathWithSearch, returnPathFrom, withReturnTo } from './recordReturn'
import { NotificationsNavItem } from '@/components/layout/NotificationsNavItem'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n')
const code = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
const noop = () => {}

const NONE_TEXT = 'No payments received yet.'

function emptyState(input: {
  loading?: boolean; error?: string | null; searchOrDate?: boolean; status?: string | null
  onRetry?: () => void; onShowAll?: () => void
}) {
  const kind: ConfirmedListEmptyKind = confirmedListEmptyKind({
    loading: input.loading ?? false,
    error: (input.error ?? null) !== null,
    searchOrDateNarrowed: input.searchOrDate ?? false,
    statusNarrowed: (input.status ?? null) !== null,
  })
  const props = {
    kind, noneText: NONE_TEXT, errorMessage: input.error ?? null,
    statusLabel: input.status ?? null, searchOrDateNarrowed: input.searchOrDate ?? false,
    onRetry: input.onRetry ?? noop, onShowAll: input.onShowAll ?? noop,
  }
  return { kind, props, html: renderToStaticMarkup(createElement(ConfirmedListEmptyState, props)) }
}

/** Every button in a hook-free component's rendered element tree. */
function buttonsOf(node: ReactNode): ReactElement<{ onClick?: () => void; children?: ReactNode }>[] {
  if (!isValidElement(node)) return Array.isArray(node) ? node.flatMap(buttonsOf) : []
  const el = node as ReactElement<{ children?: ReactNode; onClick?: () => void }>
  if (typeof el.type === 'function') {
    return buttonsOf((el.type as (p: unknown) => ReactNode)(el.props))
  }
  const own = el.type === 'button' ? [el] : []
  const kids = el.props.children
  return [...own, ...(Array.isArray(kids) ? kids.flatMap(buttonsOf) : buttonsOf(kids))]
}

// ══ 1. Confirmed Payments: the four empties ═══════════════════════════════════

describe('an empty Confirmed Payments list says what is actually true', () => {
  test('no payments at all, nothing constraining the list → the business statement', () => {
    const { kind, html } = emptyState({})
    assert.equal(kind, 'none')
    assert.ok(html.includes(NONE_TEXT))
    assert.ok(!html.includes('Show all payments'), 'there is nothing to clear')
  })

  test('an EMPTY non-All status tab is a statement about the tab, never "No payments received yet"', () => {
    for (const status of ['Zero Allocated', 'Partially Allocated', 'Fully Allocated', 'Over-allocated']) {
      const { kind, html } = emptyState({ status })
      assert.equal(kind, 'no-match', status)
      assert.ok(!html.includes(NONE_TEXT), `${status}: the false business statement is gone`)
      assert.ok(html.includes(`No payments are ${status} right now.`), status)
      assert.ok(html.includes('Show all payments'), `${status}: one obvious way out`)
    }
  })

  test('a search or date range that matches nothing', () => {
    const { kind, html } = emptyState({ searchOrDate: true })
    assert.equal(kind, 'no-match')
    assert.ok(html.includes('No payments match the current search or dates.'))
    assert.ok(!html.includes(NONE_TEXT))
    assert.ok(html.includes('Show all payments'))
  })

  test('a status tab AND a search or date range together', () => {
    const { kind, html } = emptyState({ status: 'Partially Allocated', searchOrDate: true })
    assert.equal(kind, 'no-match')
    assert.ok(html.includes('No Partially Allocated payments match the current search or dates.'))
    assert.equal((html.match(/<button/g) ?? []).length, 1, 'ONE recovery action, not one per constraint')
  })

  test('a failed read takes precedence over every empty statement', () => {
    for (const input of [{}, { status: 'Zero Allocated' }, { searchOrDate: true }, { status: 'Fully Allocated', searchOrDate: true }]) {
      const { kind, html } = emptyState({ ...input, error: 'network down' })
      assert.equal(kind, 'error', JSON.stringify(input))
      assert.ok(html.includes('Could not load payments: network down'))
      assert.ok(!html.includes(NONE_TEXT) && !html.includes('No payments are') && !html.includes('match the current'),
        'a read that never happened makes no claim about payments or filters')
      assert.ok(html.includes('Retry') && !html.includes('Show all payments'))
    }
  })

  test('while the read is in flight nothing is claimed', () => {
    const { kind, html } = emptyState({ loading: true, status: 'Zero Allocated', error: 'stale' })
    assert.equal(kind, 'loading')
    assert.ok(html.includes('Loading…') && !html.includes(NONE_TEXT) && !html.includes('Could not load'))
  })

  test('the recovery action runs the page\'s "show all" handler, and Retry runs the reload', () => {
    let shown = 0, retried = 0
    const filtered = emptyState({ status: 'Zero Allocated', searchOrDate: true, onShowAll: () => { shown++ } })
    const [showAll] = buttonsOf(createElement(ConfirmedListEmptyState, filtered.props))
    showAll.props.onClick?.()
    assert.equal(shown, 1)
    const failed = emptyState({ error: 'x', onRetry: () => { retried++ } })
    const [retry] = buttonsOf(createElement(ConfirmedListEmptyState, failed.props))
    retry.props.onClick?.()
    assert.equal(retried, 1)
  })

  test('"Show all payments" clears search, dates and status, returns to page one, and cleans the URL', () => {
    assert.deepEqual(SHOW_ALL_PAYMENTS_STATE, { confirmedFilter: 'all', search: '', dateFrom: '', dateTo: '', page: 1 })
    const before = 'status=zero&q=acme&from=2026-01-01&to=2026-02-01&page=3&view=all'
    const cleaned = mergeSearchParams(before, confirmedListUrlPatch(SHOW_ALL_PAYMENTS_STATE, 'confirmed'))
    assert.equal(cleaned, 'view=all', 'every list parameter is gone; an unrelated one is untouched')

    const view = code('src/app/finance/received/ReceivedPaymentsView.tsx')
    const handler = view.slice(view.indexOf('const showAllPayments = () => {'), view.indexOf('const emptyKind'))
    for (const setter of ['setSearch(SHOW_ALL_PAYMENTS_STATE.search)', 'setDateFrom(SHOW_ALL_PAYMENTS_STATE.dateFrom)',
      'setDateTo(SHOW_ALL_PAYMENTS_STATE.dateTo)', 'setConfirmedFilter(SHOW_ALL_PAYMENTS_STATE.confirmedFilter',
      'setPage(SHOW_ALL_PAYMENTS_STATE.page)']) {
      assert.ok(handler.includes(setter), setter)
    }
    assert.ok(view.includes('onShowAll={showAllPayments}'))
    assert.ok(view.includes('confirmedListUrlPatch({ confirmedFilter, search, dateFrom, dateTo, page }, surface)'),
      'the page mirrors to the URL through the same patch this test drives')
  })

  test('the toolbar\'s Clear filters still clears search and dates only — the tab is navigation', () => {
    const view = code('src/app/finance/received/ReceivedPaymentsView.tsx')
    const clear = view.slice(view.indexOf('const clearFilters = () => {'), view.indexOf('const showAllPayments'))
    assert.ok(!clear.includes('setConfirmedFilter'))
    assert.ok(view.includes('{narrowed && ('), 'offered only when search or dates narrow the list')
  })

  test('Payments to Verify has no status tab, so a status can never narrow it', () => {
    assert.equal(confirmedListUrlPatch({ ...SHOW_ALL_PAYMENTS_STATE, confirmedFilter: 'zero' }, 'to_verify').status, null)
    const view = code('src/app/finance/received/ReceivedPaymentsView.tsx')
    assert.ok(view.includes("const statusNarrowed = surface === 'confirmed' && confirmedFilter !== DEFAULT_CONFIRMED_ALLOCATION_FILTER"))
  })

  test('the database-side narrowing is untouched', () => {
    const view = code('src/app/finance/received/ReceivedPaymentsView.tsx')
    assert.ok(view.includes("scoped.eq('complete_allocation_status', filters.confirmedFilter)"))
  })
})

// ══ 2. Confirmed Orders: the pending search ═══════════════════════════════════

describe('a search typed into Confirmed Orders is never dropped', () => {
  const page = code('src/app/orders/all/page.tsx')

  test('the pending term is flushed on blur, as on the Task lists', () => {
    assert.ok(page.includes('const [searchInput, setSearchInput, flushSearch] = useUrlSearchInput(listState.q, next => setListState({ q: next }))'))
    assert.ok(page.includes('onBlur={flushSearch}'))
  })

  test('the debounce and replace-history behaviour are unchanged', () => {
    const hook = code('src/hooks/useListUrlState.ts')
    assert.ok(hook.includes('export const SEARCH_DEBOUNCE_MS = 250'))
    assert.ok(hook.includes("history: 'replace' | 'push' = 'replace'"), 'a committed search replaces, never pushes')
    assert.ok(!/useUrlSearchInput\([^)]*,[^)]*,\s*\d/.test(page), 'no custom delay overrides the shared 250ms')
  })

  test('typing and IMMEDIATELY opening an Order carries the latest trimmed term back', () => {
    // mousedown → blur → flush (schedules a replace) → click: the click reads
    // the list address from BEFORE the flush, so returnTo is built from the
    // term as typed instead.
    const returnPath = listReturnPathWithSearch('/orders/all', 'status=running', '  hotel lobby  ')
    const href = withReturnTo('/orders/4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f', returnPath)
    assert.equal(returnPathFrom(new URLSearchParams(href.split('?')[1])), '/orders/all?status=running&q=hotel+lobby')
    assert.ok(page.includes('listReturnPathWithSearch(pathname, useSearchParams().toString(), searchInput)'))
  })

  test('clearing the box clears the term from returnTo too, and other filters survive', () => {
    assert.equal(listReturnPathWithSearch('/orders/all', 'q=old&sort=oldest', '   '), '/orders/all?sort=oldest')
    assert.equal(listReturnPathWithSearch('/orders/all', '', ''), '/orders/all')
  })
})

// ══ 3. Notifications is a real sidebar link ═══════════════════════════════════

describe('the Notifications sidebar entry is a real link', () => {
  // ONE client, cleared when the suite ends: each client's cache keeps gc timers
  // alive, and node:test has no timeout — a leaked handle hangs the run silently.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  after(() => client.clear())
  const render = (props: Parameters<typeof NotificationsNavItem>[0]) =>
    renderToStaticMarkup(createElement(QueryClientProvider, { client },
      createElement(NotificationsNavItem, props)))

  test('an anchor to the module\'s own notifications page', () => {
    const html = render({ href: '/finance/notifications', count: 0 })
    assert.match(html, /^<a [^>]*href="\/finance\/notifications"/)
    assert.ok(html.includes('class="boe-nav-item"'))
    assert.ok(html.includes('aria-label="Notifications"'))
    assert.ok(!html.includes('<button'), 'no button standing in for a destination')
  })

  test('the default destination is still the shared page', () => {
    assert.match(render({ count: 0 }), /href="\/notifications"/)
  })

  test('an unread count keeps its badge and its accessible label', () => {
    const html = render({ href: '/orders/notifications', count: 3 })
    assert.ok(html.includes('aria-label="Notifications, 3 unread"'))
    assert.match(html, /aria-hidden="true"[^>]*>3<\/span>/)
    assert.ok(render({ count: 150 }).includes('>99+</span>'))
  })

  test('active styling and aria-current follow the path, and the mobile sidebar still closes', () => {
    const src = code('src/components/layout/NotificationsNavItem.tsx')
    assert.ok(src.includes("className={`boe-nav-item${active ? ' active' : ''}`}"))
    assert.ok(src.includes("aria-current={active ? 'page' : undefined}"))
    assert.ok(src.includes('const active   = pathname === href'))
    assert.ok(src.includes('onClick={() => onNavigate?.()}'))
    assert.ok(!src.includes('router.push(') && !src.includes('router.prefetch(') && !src.includes('useRouter'),
      'the Link navigates and prefetches; nothing does it by hand')
  })
})
