// THE SALESPERSON'S OWN ORDERS DASHBOARD, AS THE PAGE READS IT (20270228000000;
// layout A and last month since 20270508000000, owner 2026-10-30).
//
// The database decides what counts; supabase/tests/salesperson_orders_dashboard_assertions.sql
// and supabase/tests/sales_dashboard_returned_pis_pglite.mjs pin the rules (ownership, confirmed
// orders, revenue months, the 40% line, ready for dispatch). These pin the other half: that the
// page validates the database's answer, draws EVERY row it was given (no preview cap), draws each
// figure once, says a failed read is an error, and leaves the dashboard everybody else has exactly
// where it was.
//
// Run with: npm run test:file -- src/lib/orders/salespersonDashboard.test.tsx

/* eslint-disable @typescript-eslint/no-explicit-any -- the malformed-payload cases reach into an untyped fixture on purpose */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  SP_EMPTY,
  advanceCountText,
  advancePercentText,
  confirmedAgoText,
  isDashboardFunctionMissing,
  plannedDispatchText,
  readyForText,
  resolvePersonalRead,
  parseSalespersonDashboard,
  returnedTitle,
  revenueNotes,
  shortfallText,
  waitingText,
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
    today: '2026-10-30',
    now: '2026-10-30T10:00:00Z',
    month_from: '2026-10-01',
    total_orders: 42,
    revenue: { amount: 482500, orders: 3, no_product_value: 0, before_discount: 0 },
    revenue_last_month: { month_from: '2026-09-01', amount: 1136000, orders: 7, no_product_value: 0, before_discount: 0 },
    pending_total: 2,
    pending: [
      { submission_id: 'sub-1', reference: 'PID-00024', client_name: 'Nest Studio', since: '2026-10-28T10:00:00Z', waiting_seconds: 2 * 86400 + 60, can_open: true },
      { submission_id: 'sub-2', reference: 'PID-00026', client_name: 'Casa Bella', since: '2026-10-30T05:00:00Z', waiting_seconds: 5 * 3600, can_open: false },
    ],
    returned_total: 0,
    returned: [],
    rejected_total: 1,
    rejected: [
      { submission_id: 'sub-9', reference: 'PID-00019', client_name: 'Studio Arc', note: 'Client went elsewhere', by_name: 'Nishant Soni', since: '2026-10-29T10:00:00Z', waiting_seconds: 86400, can_open: true },
    ],
    advance: [
      { order_id: 'ord-a1', display_number: '0509', client_name: 'Sharma & Sons Furnishing Private Limited (Bandra West Showroom, Mumbai)', status: 'running', verified: 0, percent: 0, shortfall: 48000, exception_approved: true, confirm_date: '2026-09-26', days_since_confirmation: 34 },
      { order_id: 'ord-a2', display_number: '0518', client_name: 'Kapoor Interiors', status: 'running', verified: 79900, percent: 12, shortfall: 186400.5, exception_approved: false, confirm_date: '2026-10-09', days_since_confirmation: 21 },
    ],
    advance_unchecked: [],
    fabric_finish: [
      { order_id: 'ord-f1', display_number: '0510', client_name: 'Patel Retail', status: 'running', confirm_date: '2026-09-01', days_since_confirmation: 32, over_15_days: true,
        pending: [{ kind: 'fabric', status: 'not_approved' }], unknown: [] },
    ],
    fabric_finish_unknown: [],
    ready_for_dispatch: [
      { order_id: 'ord-r1', display_number: '0497', client_name: 'Sharma Villa', status: 'ready_for_dispatch', planned_dispatch_date: '2026-10-28', ready_since: '2026-10-19T08:00:00Z', ready_days: 11 },
      { order_id: 'ord-r2', display_number: '0501', client_name: 'Meraki Cafe', status: 'ready_for_dispatch', planned_dispatch_date: '2026-11-02', ready_since: '2026-10-24T08:00:00Z', ready_days: 6 },
      { order_id: 'ord-r3', display_number: '0512', client_name: 'The Oak Room', status: 'ready_for_dispatch', planned_dispatch_date: null, ready_since: null, ready_days: null },
    ],
    ...over,
  }
}

const returnedRow = (over: Record<string, unknown> = {}) => ({
  submission_id: 'sub-21', reference: 'PID-00021', client_name: 'IBC',
  note: 'In 003 and 004 (20 mm will be quartz and 20mm will be wood) … nine paragraphs', by_name: 'Nishant Soni',
  since: '2026-10-27T10:00:00Z', waiting_seconds: 3 * 86400, can_open: true, ...over,
})

function parsed(raw: unknown): SalespersonDashboard {
  const r = parseSalespersonDashboard(raw)
  assert.ok(r.ok && r.applicable, 'expected an applicable, valid payload')
  return r.dashboard
}

function html(d: SalespersonDashboard) {
  return renderToStaticMarkup(createElement(SalespersonDashboardView, { data: d }))
}

const listOf = (out: string, area: string) => out.split(`data-area="${area}"`)[1].split('</section>')[0]

// ── Validation ────────────────────────────────────────────────────────────────

describe('the answer is validated, never trusted', () => {
  test('a non-salesperson gets applicable:false and no data', () => {
    assert.deepEqual(parseSalespersonDashboard({ applicable: false }), { ok: true, applicable: false })
  })

  test('a valid payload parses to the page model, with last month, the shortfall and ready since', () => {
    const d = parsed(payload())
    assert.equal(d.revenue.amount, 482500)
    assert.deepEqual(d.revenueLastMonth, { monthFrom: '2026-09-01', amount: 1136000, orders: 7, noProductValue: 0, beforeDiscount: 0 })
    assert.equal(d.today, '2026-10-30')
    assert.equal(d.pending.length, 2)
    assert.equal(d.advance[1].shortfall, 186400.5)
    assert.equal(d.advance[1].daysSinceConfirmation, 21)
    assert.equal(d.readyForDispatch[0].readyDays, 11)
    assert.equal(d.readyForDispatch[2].readyDays, null)
  })

  test('a database without 20270508000000 is "not sent", never an error and never zero', () => {
    const p = payload()
    delete p.revenue_last_month
    for (const a of p.advance) { delete a.shortfall; delete a.days_since_confirmation }
    for (const r of p.ready_for_dispatch) { delete r.ready_since; delete r.ready_days }
    const d = parsed(p)
    assert.equal(d.revenueLastMonth, null)
    assert.equal(d.advance[0].shortfall, null)
    assert.equal('readyDays' in d.readyForDispatch[0], false)
    const out = html(d)
    assert.match(out, /Last month<\/h2><p class="spd-fig-value">–<\/p><p class="spd-fig-sub">Not available yet</)
    assert.doesNotMatch(out, /₹0</)
    assert.doesNotMatch(out, /Ready date not recorded|Ready for \d|Ready today/)
  })

  test('numeric strings from the database are accepted; anything else is refused, never zeroed', () => {
    assert.equal(parsed(payload({ revenue: { amount: '99.5', orders: 1, no_product_value: 0, before_discount: 0 } })).revenue.amount, 99.5)
    for (const bad of [
      payload({ total_orders: 'many' }),
      payload({ total_orders: -1 }),
      payload({ total_orders: null }),
      payload({ revenue: null }),
      payload({ revenue: { amount: 'NaN', orders: 0, no_product_value: 0, before_discount: 0 } }),
      payload({ revenue_last_month: { month_from: '2026-09-01', amount: 'lots', orders: 1, no_product_value: 0, before_discount: 0 } }),
      payload({ revenue_last_month: { amount: 1, orders: 1, no_product_value: 0, before_discount: 0 } }),
      payload({ pending: null }),
      payload({ advance: [{ order_id: 'x', display_number: '1', client_name: 'c', percent: 'abc' }] }),
      payload({ advance: [{ order_id: 'x', display_number: '1', client_name: 'c', percent: 10, shortfall: 'abc' }] }),
      payload({ ready_for_dispatch: [{ order_id: 'x', display_number: '1', client_name: 'c', planned_dispatch_date: null, ready_days: 'soon' }] }),
      payload({ month_from: 'October' }),
      payload({ applicable: undefined }),
      'a string', null, [], {},
    ]) {
      const r = parseSalespersonDashboard(bad)
      assert.equal(r.ok, false, JSON.stringify(bad)?.slice(0, 80))
    }
  })

  test('the pending number and its list are one number: a mismatch is refused', () => {
    assert.equal(parseSalespersonDashboard(payload({ pending_total: 3 })).ok, false)
    assert.equal(parseSalespersonDashboard(payload({ pending_total: 1 })).ok, false)
  })

  test('a fabric row with nothing pending is still refused (the database still sends the list)', () => {
    const p = payload()
    p.fabric_finish[0].pending = []
    assert.equal(parseSalespersonDashboard(p).ok, false)
  })

  test('a missing function falls back to the existing dashboard; a genuine failure is an error, never zeros', () => {
    const missing = { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.salesperson_orders_dashboard without parameters in the schema cache' } }
    assert.deepEqual(resolvePersonalRead(missing), { kind: 'other' })
    for (const error of [
      { code: '42501', message: 'permission denied for function salesperson_orders_dashboard' },
      { code: '57014', message: 'canceling statement due to statement timeout' },
      { code: '', message: 'Failed to fetch' },
      { code: 'XX000', message: 'internal error' },
    ]) assert.deepEqual(resolvePersonalRead({ data: null, error }), { kind: 'error' }, error.message)
    assert.deepEqual(resolvePersonalRead({ data: null, error: null }), { kind: 'error' }, 'no data and no error is unreadable, not an empty dashboard')
    assert.deepEqual(resolvePersonalRead({ data: { applicable: true }, error: null }), { kind: 'error' }, 'a malformed answer is an error')
    assert.deepEqual(resolvePersonalRead({ data: { applicable: false }, error: null }), { kind: 'other' })
    assert.equal(resolvePersonalRead({ data: payload(), error: null }).kind, 'ready')
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
  test('waiting', () => {
    assert.equal(waitingText(3 * 86400 + 100), 'Waiting 3 days')
    assert.equal(waitingText(86400), 'Waiting 1 day')
    assert.equal(waitingText(5 * 3600), 'Waiting 5 h')
    assert.equal(waitingText(30), 'Waiting <1 h')
    assert.equal(waitingText(-5), 'Waiting <1 h')
  })

  test('the returned strip names how many', () => {
    assert.equal(returnedTitle(1), '1 PI returned to you')
    assert.equal(returnedTitle(3), '3 PIs returned to you')
  })

  test('advance percent: never NaN, never Infinity, no false precision', () => {
    assert.equal(advancePercentText(0), '0% verified')
    assert.equal(advancePercentText(39.99), '39.99% verified')
    assert.equal(advancePercentText(12.5), '12.5% verified')
    assert.doesNotMatch(advancePercentText(0), /NaN|Infinity/)
  })

  test('the shortfall is rupees to ask for; not sent is a dash, never ₹0', () => {
    assert.equal(shortfallText(186400), '₹1,86,400 short')
    assert.equal(shortfallText(6300.5), '₹6,300.50 short')
    assert.equal(shortfallText(null), '–')
  })

  test('time since confirmation, including no date', () => {
    assert.equal(confirmedAgoText(21), 'Confirmed 21 days ago')
    assert.equal(confirmedAgoText(1), 'Confirmed 1 day ago')
    assert.equal(confirmedAgoText(0), 'Confirmed today')
    assert.equal(confirmedAgoText(null), 'Confirmation date not recorded')
  })

  test('ready since: days, today, not recorded, or nothing when not sent', () => {
    assert.equal(readyForText(6), 'Ready for 6 days')
    assert.equal(readyForText(1), 'Ready for 1 day')
    assert.equal(readyForText(0), 'Ready today')
    assert.equal(readyForText(null), 'Ready date not recorded')
    assert.equal(readyForText(undefined), null)
  })

  test('planned dispatch: a passed date is said, by India\'s today', () => {
    assert.deepEqual(plannedDispatchText('2026-10-28', '2026-10-30'), { text: 'Planned 28 Oct 2026 · passed', tone: 'alert' })
    assert.deepEqual(plannedDispatchText('2026-10-30', '2026-10-30'), { text: 'Planned 30 Oct 2026', tone: 'good' })
    assert.deepEqual(plannedDispatchText('2026-11-02', '2026-10-30'), { text: 'Planned 2 Nov 2026', tone: 'good' })
    assert.deepEqual(plannedDispatchText(null, '2026-10-30'), { text: 'No dispatch date', tone: 'muted' })
    assert.deepEqual(plannedDispatchText('2026-10-28', null), { text: 'Planned 28 Oct 2026', tone: 'good' }, 'no today: nothing is called passed')
  })

  test('what could not be assessed is said under its own month', () => {
    assert.deepEqual(revenueNotes({ amount: 1, orders: 1, noProductValue: 0, beforeDiscount: 0 }), [])
    assert.match(revenueNotes({ amount: 1, orders: 1, noProductValue: 2, beforeDiscount: 1 }).join(' '), /2 orders.*are not counted.*1 order this month carries/)
    assert.match(revenueNotes({ amount: 1, orders: 1, noProductValue: 1, beforeDiscount: 0 }, 'last month').join(' '), /1 order last month with no product value on record is not counted/)
  })
})

// ── What is drawn ─────────────────────────────────────────────────────────────

describe('the page body: returned strip, two sales figures, three lists', () => {
  test('nothing returned: no strip at all', () => {
    const out = html(parsed(payload()))
    assert.doesNotMatch(out, /spd-returned|returned to you/)
  })

  test('the sales figures: this month so far beside last month, each once', () => {
    const out = html(parsed(payload()))
    const figs = [...out.matchAll(/<h2 class="spd-fig-label">([^<]+)<\/h2><p class="spd-fig-value">([^<]*)<\/p><p class="spd-fig-sub">([^<]*)<\/p>/g)]
    assert.deepEqual(figs.map(f => [f[1], f[2], f[3]]), [
      ['This month so far', '₹4,82,500', 'October 2026 · 3 orders'],
      ['Last month', '₹11,36,000', 'September 2026 · 7 orders'],
    ])
    assert.match(out, /product value after discount, excluding GST/)
  })

  test('what was removed by the owner (2026-10-30) is not drawn', () => {
    const out = html(parsed(payload()))
    for (const gone of ['Total Orders', 'All-time', 'Current Month Revenue', 'Orders Pending Approval', 'Returned to Sales',
      'Closed', 'Studio Arc', 'Fabric', 'Finish', 'Patel Retail', 'Needs your attention']) {
      assert.ok(!out.includes(gone), gone)
    }
  })

  test('three lists with the stated titles and full counts, wide column first', () => {
    const out = html(parsed(payload()))
    const lists = [...out.matchAll(/data-area="(\w+)"[^>]*><header class="spd-list-head"><h2[^>]*>([^<]+)<\/h2><span[^>]*>([^<]+)<\/span>/g)]
    assert.deepEqual(lists.map(l => [l[1], l[2], l[3]]), [
      ['advance', 'Advance below 40%', '2'],
      ['ready', 'Ready for dispatch', '3'],
      ['pending', 'Waiting for approval', '2'],
    ])
    const cols = out.split('<div class="spd-col').slice(1)
    assert.equal(cols.length, 2)
    assert.match(cols[0], /data-area="advance"/)
    assert.doesNotMatch(cols[0], /data-area="(ready|pending)"/)
    assert.match(cols[1], /data-area="ready"[\s\S]*data-area="pending"/)
  })

  test('the phone chips jump to each list and carry the same counts', () => {
    const out = html(parsed(payload()))
    assert.match(out, /href="#spd-advance">Below 40% <span>2<\/span>/)
    assert.match(out, /href="#spd-ready">Ready to dispatch <span>3<\/span>/)
    assert.match(out, /href="#spd-pending">Waiting approval <span>2<\/span>/)
    for (const id of ['spd-advance', 'spd-ready', 'spd-pending']) assert.match(out, new RegExp(`id="${id}"`))
  })

  test('advance rows: order, client, verified, rupees short, confirmed — and the exception said', () => {
    const list = listOf(html(parsed(payload())), 'advance')
    assert.match(list, /Order<\/span><span>Client<\/span><span>Verified<\/span><span>Short of 40%<\/span><span>Confirmed/)
    assert.match(list, />0509<[\s\S]*Sharma &amp; Sons Furnishing Private Limited \(Bandra West Showroom, Mumbai\)[\s\S]*Exception approved[\s\S]*0% verified[\s\S]*₹48,000 short[\s\S]*Confirmed 34 days ago/)
    assert.match(list, />0518<[\s\S]*Kapoor Interiors[\s\S]*12% verified[\s\S]*₹1,86,400.50 short[\s\S]*Confirmed 21 days ago/)
    assert.equal(list.match(/Exception approved/g)?.length, 1)
  })

  test('ready rows: how long it has been ready, and a passed planned date in red', () => {
    const list = listOf(html(parsed(payload())), 'ready')
    assert.match(list, />0497<[\s\S]*Ready for 11 days[\s\S]*data-tone="alert">Planned 28 Oct 2026 · passed</)
    assert.match(list, />0501<[\s\S]*Ready for 6 days[\s\S]*data-tone="good">Planned 2 Nov 2026</)
    assert.match(list, />0512<[\s\S]*Ready date not recorded[\s\S]*data-tone="muted">No dispatch date</)
  })

  test('waiting-for-approval rows: PI reference (no invented order number), client, how long', () => {
    const list = listOf(html(parsed(payload())), 'pending')
    assert.match(list, /PID-00024[\s\S]*Nest Studio[\s\S]*Waiting 2 days/)
    assert.match(list, /PID-00026[\s\S]*Casa Bella[\s\S]*Waiting 5 h/)
  })

  test('order numbers keep their leading zeros', () => {
    const out = html(parsed(payload()))
    for (const n of ['0509', '0518', '0497', '0501', '0512']) assert.match(out, new RegExp(`>${n}<`))
  })

  test('rows open the existing detail pages, keeping the way back to the dashboard', () => {
    const out = html(parsed(payload()))
    assert.match(out, /href="\/orders\/ord-a1\?returnTo=%2Forders"/)
    assert.match(out, /href="\/orders\/ord-r1\?returnTo=%2Forders"/)
    assert.match(out, /href="\/orders\/drafts\/sub-1\?returnTo=%2Forders"/)
  })

  test('a PI the existing rules would not let this reader open is text, not a dead link, and says why on screen', () => {
    const out = html(parsed(payload()))
    assert.doesNotMatch(out, /href="\/orders\/drafts\/sub-2/)
    assert.match(out, /data-static="true"[^>]*title="Only the person who filed this PI, its reviewer or an approver can open it"/)
    assert.match(out, /Casa Bella[\s\S]*Opens only for whoever filed it/)
    assert.equal(out.match(/Opens only for whoever filed it/g)?.length, 1)
  })

  test('each row is one link, so there is one keyboard stop per record', () => {
    const out = html(parsed(payload()))
    // 2 advance + 3 ready + 1 openable pending
    assert.equal(out.match(/<a [^>]*class="spd-row[ "]/g)?.length, 6)
  })
})

describe('a PI returned to you: one line, never the note', () => {
  const withReturned = (...r: Record<string, unknown>[]) => parsed(payload({ returned_total: r.length, returned: r }))

  test('the strip leads the page, names the PI, who returned it, how long, and opens the PI', () => {
    const out = html(withReturned(returnedRow()))
    assert.ok(out.indexOf('1 PI returned to you') < out.indexOf('This month so far'))
    assert.match(out, /Open it to see what to change, then submit it again\./)
    assert.match(out, /href="\/orders\/drafts\/sub-21\?returnTo=%2Forders"[^>]*>[\s\S]*PID-00021[\s\S]*IBC[\s\S]*Returned by Nishant Soni[\s\S]*Waiting 3 days[\s\S]*Open PI/)
  })

  test('the approver\'s note is not drawn: it is on the PI page', () => {
    const out = html(withReturned(returnedRow()))
    assert.doesNotMatch(out, /nine paragraphs|quartz/)
  })

  test('red from the third day (two full days waited), amber before', () => {
    const urgent = html(withReturned(returnedRow({ waiting_seconds: 2 * 86400 })))
    assert.match(urgent, /data-tone="alert">Waiting 2 days</)
    const fresh = html(withReturned(returnedRow({ waiting_seconds: 2 * 86400 - 1 })))
    assert.match(fresh, /data-tone="warn">Waiting 1 day</)
  })

  test('several: one line each, oldest first as the database sent them', () => {
    const out = html(withReturned(returnedRow(), returnedRow({ submission_id: 'sub-22', reference: 'PID-00022', client_name: 'Made By A' })))
    assert.match(out, /2 PIs returned to you/)
    assert.match(out, /Open each one to see what to change/)
    assert.ok(out.indexOf('PID-00021') < out.indexOf('PID-00022'))
  })

  test('a PI the reader cannot open is plain text, never a link', () => {
    const out = html(withReturned(returnedRow({ can_open: false })))
    assert.doesNotMatch(out, /\/orders\/drafts\/sub-21/)
    assert.match(out, /PID-00021[\s\S]*Opens only for whoever filed it/)
  })

  test('the returned total and its list are one number', () => {
    assert.equal(parseSalespersonDashboard(payload({ returned_total: 2, returned: [returnedRow()] })).ok, false)
  })
})

describe('EVERY matching order is drawn: 0, 1, 5, 6 and 25 rows', () => {
  for (const n of [0, 1, 5, 6, 25]) {
    test(`${n} orders in a list: heading says ${n}, ${n} rows drawn, nothing hidden`, () => {
      const d = parsed(payload({
        ready_for_dispatch: rows(n, i => ({ order_id: `r${i}`, display_number: String(1000 + i), client_name: `Client ${i}`, status: 'ready_for_dispatch', planned_dispatch_date: null, ready_days: null })),
      }))
      const list = listOf(html(d), 'ready')
      assert.match(list, new RegExp(`class="spd-count"[^>]*>${n}<`))
      assert.equal(list.match(/<li>/g)?.length ?? 0, n)
      assert.doesNotMatch(list, /Show all|View all|Show more|\+\d+ more/i)
      if (n === 0) assert.match(list, new RegExp(SP_EMPTY.ready))
    })
  }

  test('every list has its own specific empty state', () => {
    const out = html(parsed(payload({ pending_total: 0, pending: [], advance: [], ready_for_dispatch: [] })))
    for (const text of Object.values(SP_EMPTY)) assert.ok(out.includes(text), text)
    assert.equal(new Set(Object.values(SP_EMPTY)).size, 3)
  })

  describe('orders whose advance cannot be checked are LISTED, never just counted', () => {
    const unchecked = [
      { order_id: 'ord-u1', display_number: '0441', client_name: 'Old Record House', status: 'running', confirm_date: '2026-06-01' },
      { order_id: 'ord-u2', display_number: '0442', client_name: 'Amended Away Traders', status: 'running', confirm_date: null },
    ]
    const withUnchecked = (advance: unknown[] = payload().advance) => html(parsed(payload({ advance_unchecked: unchecked, advance })))

    test('the heading counts the two groups separately', () => {
      assert.match(withUnchecked(), /Advance below 40%<\/h2><span class="spd-count"[^>]*>2 below 40% · 2 not checked</)
      assert.equal(advanceCountText(0, 3), '0 below 40% · 3 not checked')
      assert.equal(advanceCountText(5, 0), '5')
    })

    test('each unchecked order has its own row, the "Advance not checked" label and a link', () => {
      const section = withUnchecked().split('spd-unchecked')[1].split('</section>')[0]
      assert.match(section, /Advance not checked <span>2<\/span>/)
      assert.match(section, /<a [^>]*href="\/orders\/ord-u1\?returnTo=%2Forders"/)
      assert.match(section, /<a [^>]*href="\/orders\/ord-u2\?returnTo=%2Forders"/)
      assert.match(section, />0441<[\s\S]*Old Record House[\s\S]*Advance not checked</)
      assert.match(section, /not cleared/)
      assert.equal(section.match(/<a /g)?.length, 2, 'one keyboard stop per order')
    })

    test('with nothing below 40% but unchecked orders, the list does NOT say everything is fine', () => {
      const list = listOf(withUnchecked([]), 'advance')
      assert.match(list, /No checked order is below 40%/)
      assert.doesNotMatch(list, /Every active order has at least 40% verified advance/)
      assert.match(list, />0441</)
    })

    test('no unchecked orders: nothing about them is drawn', () => {
      assert.doesNotMatch(html(parsed(payload())), /not checked|Advance not checked/)
    })

    test('a payload whose unchecked list is not a list is refused, never read as none', () => {
      assert.equal(parseSalespersonDashboard(payload({ advance_unchecked: 2 })).ok, false)
      assert.equal(parseSalespersonDashboard(payload({ advance_unchecked: [{ order_id: 'x' }] })).ok, false)
    })
  })

  test('revenue gaps are said under their own month', () => {
    const out = html(parsed(payload({
      revenue: { amount: 10, orders: 1, no_product_value: 1, before_discount: 0 },
      revenue_last_month: { month_from: '2026-09-01', amount: 10, orders: 1, no_product_value: 2, before_discount: 0 },
    })))
    assert.match(out, /1 order this month with no product value on record is not counted/)
    assert.match(out, /2 orders last month with no product value on record are not counted/)
  })
})

// ── The source: what must stay true of the code itself ───────────────────────

describe('the code', () => {
  const noComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const view = noComments(read('src/components/orders/dashboard/SalespersonDashboardView.tsx'))
  const lib = noComments(read('src/lib/orders/salespersonDashboard.ts'))
  const page = read('src/app/orders/page.tsx')
  const css = read('src/app/globals.css')

  test('the advance list follows the shared helper: it takes ITS percentage and shortfall and divides by nothing of its own', () => {
    const sql = read('supabase/migrations/20270508000000_salesperson_dashboard_last_month.sql')
    const stripped = sql.replace(/^\s*--.*$/gm, '')
    const advance = /advance as \([\s\S]*?\n  \),/.exec(stripped)?.[0] ?? ''
    assert.ok(advance.length > 100, 'found the advance CTE')
    assert.match(advance, /\(p\.pos ->> 'percent'\)::numeric as percent/)
    assert.match(advance, /\(p\.pos ->> 'shortfall'\)::numeric as shortfall/)
    assert.doesNotMatch(advance, /total_value|order_value|total_before_gst|\/\s*\(?p\.pos|trunc\(100|\* ?0?\.4/, 'no denominator, no arithmetic: the rule has one definition')
  })

  test('last month is the same revenue rule, one month earlier, split at the first in India time', () => {
    const sql = read('supabase/migrations/20270508000000_salesperson_dashboard_last_month.sql')
    assert.match(sql, /v_prev_from  date := \(date_trunc\('month', timezone\('Asia\/Kolkata', now\(\)\)\) - interval '1 month'\)::date;/)
    assert.match(sql, /where c\.confirm_date >= v_prev_from and c\.confirm_date < v_month_to/)
    assert.match(sql, /'amount', coalesce\(\(select sum\(pv\) from rev where this_month\), 0\)/)
    assert.match(sql, /'amount', coalesce\(\(select sum\(pv\) from rev where not this_month\), 0\)/)
  })

  test('no row cap anywhere in the personal dashboard', () => {
    assert.doesNotMatch(view, /\.slice\(/)
    assert.doesNotMatch(view, /VISIBLE_ROWS|show all|view all|max-height|overflow-y/i)
    // (the one `.slice(0, 10)` in the parser trims a date string, not a list)
    assert.doesNotMatch(lib, /(pending|advance|returned|readyForDispatch|rows)\b[^\n]*\.slice\(/)
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
    assert.doesNotMatch(view + lib, /\.eq\(\s*['"](assigned_to|salesperson_id|requested_by|created_by)['"]/)
  })

  test('a failed or unreadable read is an error state, never zeros', () => {
    assert.match(page, /setPersonal\(resolvePersonalRead\(personalRes\)\)/)
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

  test('below 900px the columns dissolve and the chips appear; phone rules sit after the tablet rule', () => {
    const tablet = css.indexOf('@media (max-width: 899px) {\n  .spd-lists')
    const phone = css.indexOf('@media (max-width: 559px) {\n  .spd-fig')
    assert.ok(tablet > 0 && phone > tablet)
    const block = css.slice(tablet, phone)
    assert.match(block, /\.spd-col \{ display: contents; \}/)
    assert.match(block, /\.spd-chips \{ display: flex; \}/)
    assert.match(css, /\.spd-chips \{ display: none;/)
  })
})
