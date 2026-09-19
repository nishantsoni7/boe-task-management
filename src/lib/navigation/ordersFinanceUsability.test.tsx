/**
 * The Orders & Finance usability pass (2026-09-18) — what it promised, pinned.
 *
 *   1. The module shell stays on screen while a page loads (no full-screen
 *      spinner after the guard has admitted the reader), and route changes get
 *      an instant shell-and-skeleton from loading.tsx.
 *   2. Sidebar destinations are real links that say which one is current, and
 *      the module switch asks exactly the question each target's guard asks.
 *   3. List working context (tab, search, filters, page) survives opening a
 *      record and coming Back; records send their reader back to that view.
 *   4. Related-record links appear only where the current secure path already
 *      allows the reader to open the record.
 *   5. Nothing re-fetches on its own, and a refresh never throws away rows,
 *      forms or open modals.
 *
 * Source-level where the property is structural (which element, which gate),
 * rendered where it is visible.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ModulePageSkeleton } from '@/components/layout/ModulePageSkeleton'
import { ShellNavLink, ShellRefreshButton, ShellHomeLink } from '@/components/layout/ModuleShellControls'
import { skeletonVariantFor } from '@/components/layout/ModuleRouteFallback'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n')
/** Code without line comments and block comments, so prose cannot satisfy a check. */
const code = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

const ORDERS_LAYOUT = 'src/components/layout/OrdersLayout.tsx'
const FINANCE_LAYOUT = 'src/components/layout/FinanceLayout.tsx'
const SWITCH = 'src/components/layout/ModuleSwitchButton.tsx'
const FALLBACK = 'src/components/layout/ModuleRouteFallback.tsx'
const RECEIVED = 'src/app/finance/received/ReceivedPaymentsView.tsx'
const REQUESTS = 'src/app/finance/page.tsx'
const ALL_ORDERS = 'src/app/orders/all/page.tsx'
const ORDER_DETAIL = 'src/app/orders/[id]/page.tsx'
const PI_DETAIL = 'src/app/orders/drafts/[submissionId]/page.tsx'

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(join(process.cwd(), dir))) {
    const rel = `${dir}/${name}`
    if (statSync(join(process.cwd(), rel)).isDirectory()) out.push(...filesUnder(rel))
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(rel)
  }
  return out
}

// ══ 1. The shell stays up ═════════════════════════════════════════════════════

describe('no Orders or Finance screen hides the module shell behind a spinner', () => {
  test('only the two module GUARDS still render the full-screen LoadingScreen', () => {
    // The guards decide module entry before anything mounts; that is a security
    // gate and stays exactly as it was. Every page BELOW them now keeps the
    // shell and shows a skeleton — the full-screen spinner used to take the
    // sidebar and header away on every navigation inside a module.
    const offenders = [...filesUnder('src/app/orders'), ...filesUnder('src/app/finance')]
      .filter(path => /<LoadingScreen\b/.test(code(path)))
    assert.deepEqual(offenders, ['src/app/orders/layout.tsx'])
    assert.ok(code('src/components/layout/ModuleGuard.tsx').includes('if (!allowed) return <LoadingScreen />'),
      'the Finance guard still blocks its children until access is decided')
  })

  test('every route has a shell-and-skeleton loading boundary INSIDE its guard', () => {
    for (const [dir, fallback] of [['src/app/orders', 'OrdersRouteFallback'], ['src/app/finance', 'FinanceRouteFallback']] as const) {
      assert.ok(existsSync(join(process.cwd(), dir, 'loading.tsx')), `${dir}/loading.tsx`)
      assert.ok(code(`${dir}/loading.tsx`).includes(`<${fallback} />`))
      assert.ok(existsSync(join(process.cwd(), dir, 'layout.tsx')), 'nested inside the guard layout')
    }
  })

  test('the fallback reads NOTHING and offers NO action', () => {
    const src = code(FALLBACK)
    for (const call of ['.from(', '.rpc(', 'fetch(', 'getEffectivePermissions', 'hasPermission']) {
      assert.ok(!src.includes(call), `the loading shell must not ${call}`)
    }
    assert.ok(!src.includes('actions='), 'no action is drawn before the page has asked what is permitted')
  })

  test('the skeleton is announced as loading, and hides its blocks', () => {
    const html = renderToStaticMarkup(createElement(ModulePageSkeleton, { variant: 'list', label: 'Loading PI Drafts' }))
    assert.ok(html.includes('role="status"') && html.includes('aria-busy="true"'))
    assert.ok(html.includes('aria-label="Loading PI Drafts"'))
    assert.ok(!/<span class="boe-skel"(?![^>]*aria-hidden)/.test(html), 'every block is aria-hidden')
  })

  test('the skeleton takes the shape of what is coming', () => {
    assert.equal(skeletonVariantFor('/orders'), 'dashboard')
    assert.equal(skeletonVariantFor('/orders/all'), 'list')
    assert.equal(skeletonVariantFor('/orders/drafts'), 'list')
    assert.equal(skeletonVariantFor('/orders/drafts/abc'), 'record')
    assert.equal(skeletonVariantFor('/orders/4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f'), 'record')
    assert.equal(skeletonVariantFor('/finance/received'), 'list')
  })

  test('capabilities still land before any control can be drawn', () => {
    // The pages still clear their own loading gate only after the permission
    // resolver has answered; what changed is what is on screen meanwhile.
    for (const path of [REQUESTS, RECEIVED]) {
      const src = code(path)
      assert.ok(src.indexOf('setCaps(deriveFinanceCapabilities(') < src.indexOf('setPageLoading(false)'), path)
    }
  })
})

// ══ 2. Destinations, and the module switch ═══════════════════════════════════

describe('sidebar destinations are real links that say which one is current', () => {
  test('the shared nav link is an anchor with aria-current on the current page only', () => {
    const on = renderToStaticMarkup(createElement(ShellNavLink, { href: '/orders/all', label: 'Confirmed Orders', icon: null, active: true }))
    const off = renderToStaticMarkup(createElement(ShellNavLink, { href: '/orders', label: 'Dashboard', icon: null, active: false }))
    assert.match(on, /^<a [^>]*href="\/orders\/all"/)
    assert.ok(on.includes('aria-current="page"') && on.includes('boe-nav-item active'))
    assert.ok(!off.includes('aria-current'), 'only the current destination is announced as current')
  })

  test('Home is a named link; Refresh is a named button', () => {
    const home = renderToStaticMarkup(createElement(ShellHomeLink))
    assert.match(home, /^<a [^>]*href="\/modules"/)
    assert.ok(home.includes('aria-label="BOE OS Home"'))
    const refresh = renderToStaticMarkup(createElement(ShellRefreshButton, { refreshing: false, onRefresh: () => {} }))
    assert.ok(refresh.startsWith('<button') && refresh.includes('aria-label="Refresh"') && refresh.includes('type="button"'))
  })

  test('both layouts use the shared controls and the shared active rule', () => {
    for (const [path, rule] of [[ORDERS_LAYOUT, 'activeOrdersNav(pathname)'], [FINANCE_LAYOUT, 'activeFinanceNav(pathname)']] as const) {
      const src = code(path)
      assert.ok(src.includes('<ShellNavLink'), `${path} draws links`)
      assert.ok(src.includes(rule), `${path} lights the entry by the shared rule`)
      assert.ok(src.includes('<ShellHomeLink />') && src.includes('<ShellRefreshButton'))
      assert.ok(src.includes('<nav className="boe-sidebar-section"'), 'the entries are a navigation landmark')
      assert.ok(src.includes('<h1 className="boe-page-title">'), 'the page title is the page heading')
      assert.ok(!src.includes('onClick={() => navTo(item.path)}'), 'no destination is a button any more')
    }
  })
})

describe('the module switch asks exactly what each target\'s guard asks', () => {
  const src = code(SWITCH)

  test('it no longer reads the legacy module-visibility table the Finance guard stopped consulting', () => {
    for (const gone of ["from('app_modules')", 'resolveModuleAccess', 'hasPermission(', 'createClient(']) {
      assert.ok(!src.includes(gone), `${gone} must be gone`)
    }
  })

  test('Finance: the display subject through canAccessManagementModule — ModuleGuard\'s own question', () => {
    assert.ok(src.includes('canAccessManagementModule({'))
    assert.ok(src.includes('role: subject.subjectRole'))
    assert.ok(src.includes("subject.subjectPermissionsByModule.get('finance')"))
    assert.ok(code('src/components/layout/ModuleGuard.tsx').includes('canAccessManagementModule({'))
  })

  test('Orders: the signed-in user, admin by role or orders.view — OrdersGuard\'s own question', () => {
    assert.ok(src.includes("actor.role === 'admin'"))
    assert.ok(src.includes("(actor.permissionsByModule.get('orders') ?? []).some(p => p.actionKey === 'view' && p.allowed)"))
    assert.ok(code('src/app/orders/layout.tsx').includes("profile.role === 'admin' || viewAllowed"))
  })

  test('it fails closed until the answer is in, and is a link', () => {
    assert.ok(src.includes('actor.ready && actor.userId !== null'))
    assert.ok(src.includes('subject.ready && subject.actorUserId !== null'))
    assert.ok(src.includes('if (!visible) return null'))
    assert.ok(src.includes('<Link'), 'it opens in a new tab and prefetches its target')
    assert.ok(src.includes('aria-label={label}'), 'the full name at every width, including a phone')
  })
})

// ══ 3. Working context survives a record ══════════════════════════════════════

describe('a list keeps its working context across opening a record and coming Back', () => {
  test('Confirmed Orders keeps every control in the URL and restores scroll', () => {
    const src = code(ALL_ORDERS)
    assert.ok(src.includes('useListUrlState(ORDERS_LIST_PARAMS)'))
    for (const key of ['status:', 'q:', 'assignee:', 'source:', 'date:', 'sort:']) {
      assert.ok(src.slice(src.indexOf('const ORDERS_LIST_PARAMS'), src.indexOf('function fmtAmount')).includes(key), key)
    }
    assert.ok(src.includes('useListScrollRestore()'))
    assert.ok(src.includes('withReturnTo(`/orders/${id}`, returnPath)'), 'each Order is told where to come back to')
    assert.ok(!/useState\('all'\)|useState<StatusFilter>/.test(src), 'no filter lives only in memory any more')
  })

  test('Payment Requests and Confirmed Payments mirror tab, search, dates and page to the URL', () => {
    const requests = code(REQUESTS)
    assert.ok(requests.includes('useMirrorToUrl({'))
    for (const key of ['tab:', 'q:', 'page:']) assert.ok(requests.slice(requests.indexOf('useMirrorToUrl({')).slice(0, 300).includes(key), key)
    assert.ok(requests.includes("initialSearchParams.get('q')"), 'and read it back on arrival')
    assert.ok(requests.includes('useListScrollRestore()'))

    const received = code(RECEIVED)
    assert.ok(received.includes('parseListState(RECEIVED_LIST_PARAMS, initialSearchParams)'))
    const mirror = received.slice(received.indexOf('useMirrorToUrl({')).slice(0, 500)
    for (const key of ['status:', 'q:', 'from:', 'to:', 'page:']) assert.ok(mirror.includes(key), key)
    assert.ok(mirror.includes('}, !pageLoading)'), 'held back until a deep link has been read')
    assert.ok(received.includes('useListScrollRestore()'))
  })

  test('the mirror uses replace, touches only its own keys, and never scrolls', () => {
    const hook = code('src/hooks/useMirrorToUrl.ts')
    assert.ok(hook.includes('router.replace('), 'narrowing a list is not a place to go Back to')
    assert.ok(!hook.includes('router.push('))
    assert.ok(hook.includes('{ scroll: false }'))
    assert.ok(hook.includes('mergeSearchParams(current,'))
  })

  test('the Order and PI records send their reader back by a named link, never out of the app', () => {
    for (const path of [ORDER_DETAIL, PI_DETAIL]) {
      const src = code(path)
      assert.ok(src.includes('<RecordBackLink'), path)
      assert.ok(!src.includes('router.back()'), `${path}: router.back() left the app from a fresh tab`)
    }
    const back = code('src/components/layout/RecordBackLink.tsx')
    assert.ok(back.includes('returnPathFrom(useSearchParams()) ?? fallbackHref'), 'validated returnTo, or the record\'s own list')
    assert.ok(back.includes('noteListReturn()'), 'and the list restores its scroll as it does on Back')
  })

  test('a quiet PI refresh that fails keeps the record on screen', () => {
    const src = code(PI_DETAIL)
    assert.ok(src.includes("if (quiet) { setRefreshFailed(true); return }"))
    assert.equal((src.match(/if \(quiet\) \{ setRefreshFailed\(true\); return \}/g) ?? []).length, 2,
      'both read failures on the quiet path')
    assert.ok(src.includes('{refreshFailed && ('), 'and says so, with a way to try again')
  })
})

// ══ 4. Related records, where the secure path already allows ══════════════════

describe('related-record links follow the reader\'s own access', () => {
  test('Confirmed Payments links a target only with Orders entry AND an own-RLS read, and says where to come back to', () => {
    const src = code(RECEIVED)
    const fn = src.slice(src.indexOf('const allocationTargetHref'), src.indexOf('const allocationTargetHref') + 600)
    assert.ok(fn.includes('if (!canOpenOrderRecord(ordersCaps.canAccessOrdersModule)) return null'))
    assert.ok(fn.includes('if (!targetLabels.has(targetId)) return null'))
    assert.ok(fn.includes('withReturnTo('))
  })

  test('the target link is a real link: a modified click opens a new tab, a plain one stays in the app', () => {
    const src = code(RECEIVED)
    const cell = src.slice(src.indexOf('export function AllocatedAgainstCell'), src.indexOf('export function ReceivedPaymentsTable'))
    assert.ok(cell.includes('if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return'))
  })

  test('Payment Requests names its target as a link only through the shared rule', () => {
    const src = code(REQUESTS)
    assert.ok(src.includes('const href = destinationRecordHref(destination, canOpenOrders)'))
    assert.ok(src.includes("getEffectivePermissions(supabase, uid, 'orders').catch(() => [])"),
      'Orders entry is resolved in the same parallel group — no extra wait')
    assert.ok(src.includes('useState(false)') && src.includes('setCanOpenOrders(deriveOrdersCapabilities(me?.role, ordersPerms).canAccessOrdersModule)'),
      'starts closed, and a failed read offers no link')
  })

  test('the Order records its Finance payment and its approved PI as real links, still gated', () => {
    const order = code(ORDER_DETAIL)
    assert.ok(/financeCaps\.canAccessFinanceModule && \(\s*<Link\s+href=\{financePaymentHref\(p\.id\)\}/.test(order))
    const sections = code('src/app/orders/drafts/[submissionId]/piDetailSections.tsx')
    assert.ok(sections.includes('{href && !acting ? ('), 'the approved Order is a link when the reader can see it')
    assert.ok(!sections.includes('ExternalLink'), 'and no longer promises a new tab it never opened')
  })
})

// ══ 5. Nothing reloads on its own; a refresh keeps what is on screen ══════════

describe('a re-read never throws away what the reader has', () => {
  test('the lists keep their rows while a refresh is in flight', () => {
    assert.ok(code(REQUESTS).includes('{listLoading && visible.length === 0 ? ('))
    assert.ok(code(RECEIVED).includes('{listLoading && visible.length === 0 ? ('))
    assert.ok(code(ALL_ORDERS).includes('{listLoading && orders.length === 0 ? ('))
  })

  test('no screen touched here listens for focus or visibility, or polls', () => {
    for (const path of [ORDERS_LAYOUT, FINANCE_LAYOUT, SWITCH, FALLBACK, REQUESTS, RECEIVED, ALL_ORDERS,
                        'src/hooks/useMirrorToUrl.ts', 'src/components/layout/RecordBackLink.tsx']) {
      const src = code(path)
      for (const trigger of ['visibilitychange', "addEventListener('focus'", 'setInterval(', 'refetchInterval']) {
        assert.ok(!src.includes(trigger), `${path} added ${trigger}`)
      }
    }
  })

  test('Payment Requests draws before its destination read, not after', () => {
    const src = code(REQUESTS)
    assert.ok(src.includes('void loadPaymentDestinations(supabase, mapped.map(m => m.id)).then(found => {'))
    assert.ok(!src.includes('const found = await loadPaymentDestinations('))
  })

  test('the sidebar counts only the one badge it draws', () => {
    assert.ok(code(FINANCE_LAYOUT).includes('useReceivedPaymentsCounts(SIDEBAR_COUNTED_VIEWS)'))
  })

  test('Delete all notifications asks first, like the per-task delete beside it', () => {
    const view = code('src/components/notifications/NotificationsView.tsx')
    const fn = view.slice(view.indexOf('const handleDeleteAll = () => {'), view.indexOf('const handleDeleteAll = () => {') + 500)
    assert.ok(fn.indexOf('window.confirm(') > -1 && fn.indexOf('window.confirm(') < fn.indexOf('deleteAll()'))
    assert.ok(fn.includes('if (!ok) return'))
  })
})
