// THE SALESPERSON'S OWN ORDERS DASHBOARD, AS THE PAGE READS IT (20270226000000).
//
// The database decides what counts; supabase/tests/salesperson_orders_dashboard_assertions.sql
// pins the rules (ownership, confirmed orders, revenue windows, the 40% line, fabric/finish,
// ready for dispatch). These pin the other half: that the page validates the database's answer,
// draws EVERY row it was given (no preview cap), keeps card and panel in agreement, says a failed
// read is an error, and leaves the dashboard everybody else has exactly where it was.
//
// Run with: npx tsx --test "src/lib/orders/salespersonDashboard.test.tsx"

/* eslint-disable @typescript-eslint/no-explicit-any -- the malformed-payload cases reach into an untyped fixture on purpose */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  SP_EMPTY,
  advancePercentText,
  dispatchDateText,
  fabricUnrecordedNote,
  isDashboardFunctionMissing,
  parseSalespersonDashboard,
  pendingKindsText,
  pendingWaitText,
  revenueNotes,
  sinceConfirmationText,
  type SalespersonDashboard,
} from './salespersonDashboard'
import { SalespersonDashboardView } from '@/components/orders/dashboard/SalespersonDashboardView'

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8').replace(/\r/g, '')

// ── A payload shaped exactly as the RPC returns it ───────────────────────────

function rows<T>(n: number, make: (i: number) => T): T[] {
  return Array.from({ length: n }, (_, i) => make(i + 1))
}

function payload(over: Record<string, unknown> = {}): any {
  return {
    applicable: true,
    today: '2026-10-03',
    now: '2026-10-03T10:00:00Z',
    month_from: '2026-10-01',
    total_orders: 42,
    revenue: { amount: 1234567.5, orders: 3, no_product_value: 0, before_discount: 0 },
    pending_total: 2,
    pending: [
      { submission_id: 'sub-1', reference: 'PID-00006', client_name: 'Kalyan Interiors', since: '2026-09-28T10:00:00Z', waiting_seconds: 5 * 86400 + 60, can_open: true },
      { submission_id: 'sub-2', reference: 'PID-00007', client_name: 'Meera Textiles', since: '2026-10-03T08:00:00Z', waiting_seconds: 7200, can_open: false },
    ],
    advance: [
      { order_id: 'ord-a1', display_number: '0524', client_name: 'Sharma & Sons Furnishing Private Limited (Bandra West Showroom, Mumbai)', status: 'running', verified: 0, percent: 0, exception_approved: false, confirm_date: '2026-09-01' },
      { order_id: 'ord-a2', display_number: '0525', client_name: 'Iyer Homes', status: 'running', verified: 399999.99, percent: 39.99, exception_approved: true, confirm_date: '2026-09-02' },
    ],
    advance_unchecked: 0,
    fabric_finish: [
      { order_id: 'ord-f1', display_number: '0510', client_name: 'Patel Retail', status: 'running', confirm_date: '2026-09-01', days_since_confirmation: 32, over_15_days: true,
        pending: [{ kind: 'fabric', status: 'not_approved' }, { kind: 'finish', status: 'no_approval_recorded' }] },
      { order_id: 'ord-f2', display_number: '0530', client_name: 'Rao Studio', status: 'running', confirm_date: '2026-10-02', days_since_confirmation: 1, over_15_days: false,
        pending: [{ kind: 'finish', status: 'partially_approved' }] },
    ],
    fabric_finish_unrecorded: 0,
    ready_for_dispatch: [
      { order_id: 'ord-r1', display_number: '0501', client_name: 'Desai Group', status: 'ready_for_dispatch', planned_dispatch_date: '2026-10-12' },
      { order_id: 'ord-r2', display_number: '0502', client_name: 'Nair Exports', status: 'ready_for_dispatch', planned_dispatch_date: null },
    ],
    ...over,
  }
}

function parsed(raw: unknown): SalespersonDashboard {
  const r = parseSalespersonDashboard(raw)
  assert.ok(r.ok && r.applicable, 'expected an applicable, valid payload')
  return r.dashboard
}

function html(d: SalespersonDashboard) {
  return renderToStaticMarkup(createElement(SalespersonDashboardView, { data: d }))
}

// ── Validation ────────────────────────────────────────────────────────────────

describe('the answer is validated, never trusted', () => {
  test('a non-salesperson gets applicable:false and no data', () => {
    assert.deepEqual(parseSalespersonDashboard({ applicable: false }), { ok: true, applicable: false })
  })

  test('a valid payload parses to the page model', () => {
    const d = parsed(payload())
    assert.equal(d.totalOrders, 42)
    assert.equal(d.revenue.amount, 1234567.5)
    assert.equal(d.pending.length, 2)
    assert.equal(d.advance[1].percent, 39.99)
    assert.deepEqual(d.fabricFinish[0].pending, ['fabric', 'finish'])
    assert.equal(d.readyForDispatch[1].plannedDispatchDate, null)
  })

  test('numeric strings from the database are accepted; anything else is refused, never zeroed', () => {
    assert.equal(parsed(payload({ revenue: { amount: '99.5', orders: 1, no_product_value: 0, before_discount: 0 } })).revenue.amount, 99.5)
    for (const bad of [
      payload({ total_orders: 'many' }),
      payload({ total_orders: -1 }),
      payload({ total_orders: null }),
      payload({ revenue: null }),
      payload({ revenue: { amount: 'NaN', orders: 0, no_product_value: 0, before_discount: 0 } }),
      payload({ pending: null }),
      payload({ advance: [{ order_id: 'x', display_number: '1', client_name: 'c', percent: 'abc' }] }),
      payload({ month_from: 'October' }),
      payload({ applicable: undefined }),
      'a string', null, [], {},
    ]) {
      const r = parseSalespersonDashboard(bad)
      assert.equal(r.ok, false, JSON.stringify(bad)?.slice(0, 80))
    }
  })

  test('the card and the panel are one number: a mismatch is refused', () => {
    assert.equal(parseSalespersonDashboard(payload({ pending_total: 3 })).ok, false)
    assert.equal(parseSalespersonDashboard(payload({ pending_total: 1 })).ok, false)
  })

  test('a fabric row with nothing pending is refused', () => {
    const p = payload()
    p.fabric_finish[0].pending = []
    assert.equal(parseSalespersonDashboard(p).ok, false)
  })

  test('only a MISSING function falls back; every other failure is an error', () => {
    assert.equal(isDashboardFunctionMissing({ code: 'PGRST202', message: 'Could not find the function public.salesperson_orders_dashboard' }), true)
    assert.equal(isDashboardFunctionMissing({ code: '42883' }), true)
    assert.equal(isDashboardFunctionMissing({ code: '42501', message: 'permission denied' }), false)
    assert.equal(isDashboardFunctionMissing({ code: '57014', message: 'canceling statement due to statement timeout' }), false)
    assert.equal(isDashboardFunctionMissing(null), false)
  })
})

// ── Words ─────────────────────────────────────────────────────────────────────

describe('the words', () => {
  test('pending wait', () => {
    assert.equal(pendingWaitText(3 * 86400 + 100), 'Pending 3 days')
    assert.equal(pendingWaitText(86400), 'Pending 1 day')
    assert.equal(pendingWaitText(5 * 3600), 'Pending 5 h')
    assert.equal(pendingWaitText(30), 'Pending <1 h')
    assert.equal(pendingWaitText(-5), 'Pending <1 h')
  })

  test('what is pending, in the three combinations', () => {
    assert.equal(pendingKindsText(['fabric']), 'Fabric')
    assert.equal(pendingKindsText(['finish']), 'Finish')
    assert.equal(pendingKindsText(['fabric', 'finish']), 'Fabric + Finish')
  })

  test('time since confirmation, including no date', () => {
    assert.equal(sinceConfirmationText(32), '32 days since confirmation')
    assert.equal(sinceConfirmationText(1), '1 day since confirmation')
    assert.equal(sinceConfirmationText(0), 'Confirmed today')
    assert.equal(sinceConfirmationText(null), 'Confirmation date not recorded')
  })

  test('advance percent: never NaN, never Infinity, no false precision', () => {
    assert.equal(advancePercentText(0), '0% verified')
    assert.equal(advancePercentText(39.99), '39.99% verified')
    assert.equal(advancePercentText(12.5), '12.5% verified')
    assert.doesNotMatch(advancePercentText(0), /NaN|Infinity/)
  })

  test('dispatch date, with and without one', () => {
    assert.equal(dispatchDateText('2026-10-12'), 'Dispatch 12 Oct 2026')
    assert.equal(dispatchDateText(null), 'No dispatch date')
  })

  test('what could not be assessed is said, not folded into a clean list', () => {
    assert.equal(fabricUnrecordedNote(0), null)
    assert.match(fabricUnrecordedNote(2) ?? '', /2 older orders .* not listed/)
    assert.deepEqual(revenueNotes({ amount: 1, orders: 1, noProductValue: 0, beforeDiscount: 0 }), [])
    assert.match(revenueNotes({ amount: 1, orders: 1, noProductValue: 2, beforeDiscount: 1 }).join(' '), /2 orders.*are not counted.*1 order this month carries/)
  })
})

// ── What is drawn ─────────────────────────────────────────────────────────────

describe('the page body: three cards and four panels, in order', () => {
  test('exactly three summary cards, in order, with the stated figures and labels', () => {
    const out = html(parsed(payload()))
    const cards = [...out.matchAll(/<section class="spd-card"[^>]*><h2[^>]*>([^<]+)<\/h2><p class="spd-card-value">([^<]*)<\/p><p class="spd-card-sub">([^<]*)<\/p>/g)]
    assert.deepEqual(cards.map(c => c[1]), ['Total Orders', 'Current Month Revenue', 'Orders Pending Approval'])
    assert.equal(cards[0][2], '42')
    assert.equal(cards[0][3], 'All-time confirmed orders')
    assert.equal(cards[1][2], '₹12,34,567.50')
    assert.match(cards[1][3], /^October 2026/)
    assert.equal(cards[2][2], '2')
  })

  test('four panels with the stated titles, each carrying its full count', () => {
    const out = html(parsed(payload()))
    const panels = [...out.matchAll(/data-area="(\w+)"[^>]*><header class="spd-panel-head"><h2[^>]*>([^<]+)<\/h2><span[^>]*>(\d+)<\/span>/g)]
    assert.deepEqual(panels.map(p => [p[1], p[2], p[3]]), [
      ['pending', 'Orders Pending Approval', '2'],
      ['fabric', 'Fabric / Finish Pending Approval', '2'],
      ['advance', 'Advance Below 40%', '2'],
      ['ready', 'Ready for Dispatch', '2'],
    ])
    assert.equal(out.match(/<section class="spd-card"/g)?.length, 3)
    assert.equal(out.match(/<section class="spd-panel"/g)?.length, 4)
  })

  test('left column holds Pending + Fabric/Finish, right holds Advance + Ready, so no panel waits on another', () => {
    const out = html(parsed(payload()))
    const cols = out.split('<div class="spd-col">').slice(1)
    assert.equal(cols.length, 2)
    assert.match(cols[0], /data-area="pending"[\s\S]*data-area="fabric"/)
    assert.doesNotMatch(cols[0], /data-area="(advance|ready)"/)
    assert.match(cols[1], /data-area="advance"[\s\S]*data-area="ready"/)
  })

  test('the card total and the panel count agree', () => {
    const d = parsed(payload())
    assert.equal(d.pendingTotal, d.pending.length)
  })

  test('rows carry what the brief asks for', () => {
    const out = html(parsed(payload()))
    // Pending: PI reference (no invented order number), client, status, wait.
    assert.match(out, /PID-00006[\s\S]*Kalyan Interiors[\s\S]*Pending approval[\s\S]*Pending 5 days/)
    // Advance: number, client, ACTUAL percentage, indicator.
    assert.match(out, /0524[\s\S]*Sharma &amp; Sons[\s\S]*0% verified[\s\S]*Below 40%/)
    assert.match(out, /0525[\s\S]*39\.99% verified[\s\S]*Below 40%[\s\S]*Exception approved/)
    // Fabric/Finish: what is pending, time since confirmation, the urgency flag only where it applies.
    assert.match(out, /0510[\s\S]*Fabric \+ Finish[\s\S]*32 days since confirmation[\s\S]*Over 15 days/)
    assert.match(out, /0530[\s\S]*>Finish<[\s\S]*1 day since confirmation/)
    assert.equal(out.match(/Over 15 days/g)?.length, 1)
    // Ready: status, planned date or its absence.
    assert.match(out, /0501[\s\S]*Ready for dispatch[\s\S]*Dispatch 12 Oct 2026/)
    assert.match(out, /0502[\s\S]*No dispatch date/)
  })

  test('order numbers keep their leading zeros', () => {
    const out = html(parsed(payload()))
    for (const n of ['0524', '0525', '0510', '0530', '0501', '0502']) assert.match(out, new RegExp(`>${n}<`))
  })

  test('a long client name is drawn whole', () => {
    const out = html(parsed(payload()))
    assert.match(out, /Sharma &amp; Sons Furnishing Private Limited \(Bandra West Showroom, Mumbai\)/)
  })

  test('rows open the existing detail pages, keeping the way back to the dashboard', () => {
    const out = html(parsed(payload()))
    assert.match(out, /href="\/orders\/ord-a1\?returnTo=%2Forders"/)
    assert.match(out, /href="\/orders\/ord-r1\?returnTo=%2Forders"/)
    assert.match(out, /href="\/orders\/drafts\/sub-1\?returnTo=%2Forders"/)
  })

  test('a PI the existing rules would not let this reader open is text, not a dead link', () => {
    const out = html(parsed(payload()))
    assert.doesNotMatch(out, /href="\/orders\/drafts\/sub-2/)
    assert.match(out, /data-static="true"[^>]*title="You cannot open this PI"/)
    assert.match(out, /Meera Textiles/)
  })

  test('each row is one link, so there is one keyboard stop per order', () => {
    const out = html(parsed(payload()))
    // 2 pending (1 openable) + 2 advance + 2 fabric + 2 ready
    assert.equal(out.match(/<a [^>]*class="spd-row"/g)?.length, 7)
  })
})

describe('EVERY matching order is drawn: 0, 1, 5, 6 and 25 rows', () => {
  for (const n of [0, 1, 5, 6, 25]) {
    test(`${n} orders in a panel: heading says ${n}, ${n} rows drawn, nothing hidden`, () => {
      const d = parsed(payload({
        ready_for_dispatch: rows(n, i => ({ order_id: `r${i}`, display_number: String(1000 + i), client_name: `Client ${i}`, status: 'ready_for_dispatch', planned_dispatch_date: null })),
      }))
      const out = html(d)
      const panel = out.split('data-area="ready"')[1].split('</section>')[0]
      assert.match(panel, new RegExp(`class="spd-panel-count"[^>]*>${n}<`))
      assert.equal(panel.match(/<li>/g)?.length ?? 0, n)
      assert.doesNotMatch(panel, /Show all|View all|Show more|\+\d+ more/i)
      if (n === 0) assert.match(panel, new RegExp(SP_EMPTY.ready))
    })
  }

  test('every panel has its own specific empty state', () => {
    const out = html(parsed(payload({
      pending_total: 0, pending: [], advance: [], fabric_finish: [], ready_for_dispatch: [],
    })))
    for (const text of Object.values(SP_EMPTY)) assert.ok(out.includes(text), text)
    assert.equal(new Set(Object.values(SP_EMPTY)).size, 4)
  })

  test('gaps are said under the list they affect', () => {
    const out = html(parsed(payload({ advance_unchecked: 2, fabric_finish_unrecorded: 3 })))
    assert.match(out, /2 active orders with no order value could not be checked/)
    assert.match(out, /3 older orders with no fabric or finish record are not listed/)
  })

  test('revenue gaps are said under the revenue card', () => {
    const out = html(parsed(payload({ revenue: { amount: 10, orders: 1, no_product_value: 1, before_discount: 0 } })))
    assert.match(out, /1 order this month with no product value on record is not counted/)
  })
})

// ── The source: what must stay true of the code itself ───────────────────────

describe('the code', () => {
  const noComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const view = noComments(read('src/components/orders/dashboard/SalespersonDashboardView.tsx'))
  const lib = noComments(read('src/lib/orders/salespersonDashboard.ts'))
  const page = read('src/app/orders/page.tsx')
  const css = read('src/app/globals.css')

  test('no row cap anywhere in the personal dashboard', () => {
    assert.doesNotMatch(view, /\.slice\(/)
    assert.doesNotMatch(view, /VISIBLE_ROWS|show all|view all|max-height|overflow-y/i)
    // (the one `.slice(0, 10)` in the parser trims a date string, not a list)
    assert.doesNotMatch(lib, /(pending|advance|fabricFinish|readyForDispatch|rows)\b[^\n]*\.slice\(/)
    const start = css.indexOf('.spd {')
    const spd = css.slice(start, css.indexOf('/* Wide screens', start))
    assert.ok(spd.length > 500, 'found the personal dashboard CSS')
    assert.doesNotMatch(spd, /max-height|overflow-y|overflow:\s*(auto|scroll)/)
    assert.doesNotMatch(spd, /grid-template-rows|align-items:\s*stretch|min-height/)
  })

  test('the personal dashboard does no business arithmetic', () => {
    assert.doesNotMatch(lib, /\b(sum|reduce)\(/)
    assert.doesNotMatch(view, /\.reduce\(/)
  })

  test('the personal read is the database function, scoped there, with no client-side owner filter', () => {
    assert.match(page, /supabase\.rpc\('salesperson_orders_dashboard'\)/)
    assert.doesNotMatch(view + lib,/\.eq\(\s*['"](assigned_to|salesperson_id|requested_by|created_by)['"]/)
  })

  test('a failed or unreadable read is an error state, never zeros', () => {
    assert.match(page, /setPersonal\(isDashboardFunctionMissing\(personalRes\.error\) \? \{ kind: 'other' \} : \{ kind: 'error' \}\)/)
    assert.match(page, /!parsedPersonal\.ok \? \{ kind: 'error' \}/)
    assert.match(page, /role="alert"/)
  })

  test('the dashboard everybody else has is still there, unchanged in what it draws', () => {
    for (const keep of ['<RevenueSection', '<StatusStrip', '<AlignmentSection', '<AdvanceSection', '<FabricFinishSection',
      '<FactoryFocusSection', '<DocumentActionQueue', 'orderDashboardCards(', "supabase.rpc('orders_dashboard_summary')"]) {
      assert.ok(page.includes(keep), keep)
    }
    // …and the personal body is chosen only when the database said this reader is a salesperson.
    assert.match(page, /const personalView = personal\.kind === 'ready' \|\| personal\.kind === 'error'/)
  })

  test('the Orders header actions survive in the personal view (Upload PI is not gated by it)', () => {
    assert.match(page, /ordersCaps\.canCreateOrder \? \(/)
    assert.match(page, /NEW_ORDER_ACTION\.href/)
  })

  test('phone rules sit after the tablet rule and stack the panels in the stated order', () => {
    const tablet = css.indexOf('@media (max-width: 899px) {\n  .spd-panels')
    const phone = css.indexOf('@media (max-width: 559px) {\n  .spd-cards')
    assert.ok(tablet > 0 && phone > tablet)
    const block = css.slice(tablet, phone)
    const orders = ['pending', 'advance', 'fabric', 'ready'].map(a => Number(new RegExp(`data-area='${a}'\\]\\s*\\{ order: (\\d); \\}`).exec(block)?.[1]))
    assert.deepEqual(orders, [1, 2, 3, 4])
  })
})
