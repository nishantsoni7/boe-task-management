// THE ORDERS DASHBOARD, AS THE PAGE READS IT (20270221000000).
//
// The database decides what counts; supabase/tests/orders_dashboard_assertions.sql
// pins the boundaries (the 40% line, 15 days, overdue, the revenue periods, the
// PANIC MODE limit). These pin the other half: that the page turns the database's
// answer into words without inventing, dropping or softening anything, and that
// the parts the redesign removed stay removed.
//
// Run with: npx tsx --test "src/lib/orders/orderDashboardSummary.test.ts"

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ALIGNMENT_REASON_LABEL,
  GROUP_COPY,
  advanceLine,
  alignmentLine,
  describePanicFailure,
  fabricFinishLine,
  formatDate,
  formatPercent,
  formatRange,
  formatRupees,
  groupGapNote,
  groupRows,
  listsNote,
  overdueLine,
  panicSlotsLabel,
  parseDashboardSummary,
  revenueGapNotes,
  revenueTiles,
  type DashboardSummary,
} from './orderDashboardSummary'

const ROOT = join(__dirname, '..', '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r/g, '')

const ref = (n: string) => ({ order_id: `id-${n}`, display_number: n, client_name: `Client ${n}`, status: 'running' })

/** A payload shaped exactly like orders_dashboard_summary()'s answer. */
function payload(over: Record<string, unknown> = {}) {
  return {
    today: '2026-09-29',
    viewer: { sees_all_orders: true, can_view_revenue: true, can_view_panic: true, can_manage_panic: false },
    groups: {
      advance_below_40: [{ ...ref('1021'), order_value: 1000000, verified: 399999.99, percent: 39.99, shortfall: 0.01, exception_approved: false, held: false }],
      overdue: [{ ...ref('1022'), due_date: '2026-09-28', days_overdue: 1 }],
      fabric_finish_pending: [{ ...ref('1023'), confirm_date: '2026-09-10', days_since_confirmation: 19, pending: [{ kind: 'fabric', status: 'not_approved' }, { kind: 'finish', status: 'partially_approved' }] }],
      not_aligned: [{ ...ref('1024'), reason: 'clarification_needed', detail: 'Sofa fabric not stocked', advance_blocks: false }],
    },
    gaps: { open_orders: 40, advance_value_unknown: 2, no_due_date: 31, no_confirm_date: 0 },
    revenue: {
      currency: 'INR', basis: 'product_value', date_basis: 'confirm_date',
      current_month: { from: '2026-09-01', to: '2026-09-29', amount: 1234567.5, orders: 3 },
      last_six_months: { from: '2026-03-30', to: '2026-09-29', amount: 9000000, orders: 20 },
      current_year: { from: '2026-01-01', to: '2026-09-29', amount: 15000000, orders: 41 },
      gaps: { no_confirm_date: 1, future_confirm_date: 0, no_product_value_in_year: 2, before_discount_in_year: 0 },
    },
    panic: { active: [], month_start: '2026-09-01', month_used: 1, month_limit: 2, can_manage: false },
    ...over,
  }
}

const parsed = (raw: unknown): DashboardSummary => {
  const r = parseDashboardSummary(raw)
  assert.ok(r.ok, r.ok ? '' : r.message)
  return r.summary
}

describe('the summary is read as sent, and a bad answer is an error — never zeros', () => {
  test('a well-formed answer maps every group and figure', () => {
    const s = parsed(payload())
    assert.equal(s.advance[0].percent, 39.99)
    assert.equal(s.advance[0].shortfall, 0.01)
    assert.equal(s.overdue[0].daysOverdue, 1)
    assert.deepEqual(s.fabricFinish[0].pending.map(p => p.kind), ['fabric', 'finish'])
    assert.equal(s.notAligned[0].detail, 'Sofa fabric not stocked')
    assert.equal(s.gaps.noDueDate, 31)
    assert.equal(s.revenue?.currentYear.amount, 15000000)
  })

  test('numbers sent as strings (numeric columns) are read as numbers', () => {
    const p = payload()
    ;(p.groups.advance_below_40[0] as Record<string, unknown>).shortfall = '400000.00'
    assert.equal(parsed(p).advance[0].shortfall, 400000)
  })

  for (const [name, mutate] of [
    ['a missing groups object', (p: Record<string, unknown>) => { delete p.groups }],
    ['a group that is not a list', (p: Record<string, unknown>) => { (p.groups as Record<string, unknown>).overdue = null }],
    ['an unknown alignment reason', (p: Record<string, unknown>) => { ((p.groups as any).not_aligned[0]).reason = 'mystery' }],
    ['a fabric row with nothing pending', (p: Record<string, unknown>) => { ((p.groups as any).fabric_finish_pending[0]).pending = [] }],
    ['a non-numeric shortfall', (p: Record<string, unknown>) => { ((p.groups as any).advance_below_40[0]).shortfall = 'soon' }],
    ['a null answer', (p: Record<string, unknown>) => { for (const k of Object.keys(p)) delete p[k] }],
  ] as const) {
    test(`${name} is an error, not an empty dashboard`, () => {
      const p = payload() as Record<string, unknown>
      mutate(p)
      const r = parseDashboardSummary(p)
      assert.equal(r.ok, false)
    })
  }

  test('a reader told they may not see revenue is handed none, and vice versa', () => {
    const noRevenue = payload({ revenue: null, viewer: { sees_all_orders: false, can_view_revenue: false, can_view_panic: true, can_manage_panic: false } })
    assert.equal(parsed(noRevenue).revenue, null)
    // The database said "no revenue" for you but sent some: refuse rather than draw it.
    assert.equal(parseDashboardSummary(payload({ viewer: { sees_all_orders: false, can_view_revenue: false, can_view_panic: true, can_manage_panic: false } })).ok, false)
    // …or said "yes" and sent none: that is a failed read, not a zero.
    assert.equal(parseDashboardSummary(payload({ revenue: null })).ok, false)
  })

  test('PANIC data is present exactly when the reader may see it', () => {
    const none = payload({ panic: null, viewer: { sees_all_orders: true, can_view_revenue: true, can_view_panic: false, can_manage_panic: false } })
    assert.equal(parsed(none).panic, null)
    assert.equal(parseDashboardSummary(payload({ viewer: { sees_all_orders: true, can_view_revenue: true, can_view_panic: false, can_manage_panic: false } })).ok, false,
      'panic data sent to a reader who is not allowed it must not be drawn')
    assert.equal(parseDashboardSummary(payload({ panic: null })).ok, false)
  })
})

describe('the four groups, in reading order, with alignment the one prominent', () => {
  test('order and emphasis', () => {
    assert.deepEqual(GROUP_COPY.map(g => g.key), ['not_aligned', 'advance_below_40', 'overdue', 'fabric_finish_pending'])
    assert.deepEqual(GROUP_COPY.filter(g => g.prominent).map(g => g.key), ['not_aligned'])
    assert.equal(GROUP_COPY[0].label, 'Not aligned for manufacturing')
  })

  test('every count leads to rows: the group rows are exactly what the count is', () => {
    const s = parsed(payload())
    for (const g of GROUP_COPY) assert.ok(groupRows(s, g.key).length > 0, g.key)
    assert.equal(groupRows(s, 'overdue')[0].displayNumber, '1022')
  })

  test('one order in several groups stays in each (nothing is de-duplicated)', () => {
    const p = payload()
    ;(p.groups as any).overdue = [{ ...ref('1021'), due_date: '2026-09-01', days_overdue: 28 }]
    const s = parsed(p)
    assert.equal(groupRows(s, 'advance_below_40')[0].displayNumber, '1021')
    assert.equal(groupRows(s, 'overdue')[0].displayNumber, '1021')
  })
})

describe('the line above the lists', () => {
  test('says the scope only when it is narrower than the company, and always says the overlap', () => {
    assert.equal(listsNote(true), 'An order can appear under more than one heading.')
    assert.equal(listsNote(false), 'Counts cover the orders you can open. An order can appear under more than one heading.')
  })
})

describe('row wording says what the database said', () => {
  test('advance: the percentage and the shortfall', () => {
    const s = parsed(payload())
    assert.equal(advanceLine(s.advance[0]), '39.99% verified · ₹0.01 short of 40%')
    assert.equal(advanceLine({ ...s.advance[0], percent: 0, shortfall: 400000 }), '0% verified · ₹4,00,000 short of 40%')
  })
  test('overdue: singular and plural days, and the due date', () => {
    const s = parsed(payload())
    assert.equal(overdueLine(s.overdue[0]), '1 day overdue · due 28 Sep 2026')
    assert.equal(overdueLine({ ...s.overdue[0], daysOverdue: 30, dueDate: '2026-08-30' }), '30 days overdue · due 30 Aug 2026')
  })
  test('fabric and finish: which item, its status, and the elapsed days', () => {
    const s = parsed(payload())
    assert.equal(fabricFinishLine(s.fabricFinish[0]), 'Fabric not approved · Finish partially approved · 19 days since confirmation')
  })
  test('alignment: the reason, and operations’ own words when it flagged one', () => {
    const s = parsed(payload())
    assert.equal(alignmentLine(s.notAligned[0]), 'Operations needs clarification: Sofa fabric not stocked')
    assert.equal(alignmentLine({ ...s.notAligned[0], reason: 'no_handoff', detail: null }), ALIGNMENT_REASON_LABEL.no_handoff)
    assert.match(ALIGNMENT_REASON_LABEL.no_handoff, /No operations handoff recorded/, 'a legacy order is not given an invented reason')
  })
})

describe('what could not be assessed is said, never folded into "all clear"', () => {
  test('each group names the orders it could not check', () => {
    const s = parsed(payload())
    assert.equal(groupGapNote('overdue', s.gaps), '31 open orders with no due date could not be checked.')
    assert.equal(groupGapNote('advance_below_40', s.gaps), '2 open orders with no order value could not be checked.')
    assert.equal(groupGapNote('fabric_finish_pending', s.gaps), null, 'no gap, no sentence')
    assert.equal(groupGapNote('not_aligned', s.gaps), null)
    assert.equal(groupGapNote('overdue', { ...s.gaps, noDueDate: 1 }), '1 open order with no due date could not be checked.')
  })
})

describe('revenue', () => {
  test('three figures with their ranges, in the order the brief names them', () => {
    const tiles = revenueTiles(parsed(payload()).revenue!)
    assert.deepEqual(tiles.map(t => t.label), ['Current month', 'Last 6 months', 'Current year'])
    assert.equal(formatRange(tiles[0].period.from, tiles[0].period.to), '1 Sep – 29 Sep 2026')
    assert.equal(formatRange(tiles[1].period.from, tiles[1].period.to), '30 Mar – 29 Sep 2026')
    assert.equal(formatRange('2025-12-15', '2026-01-04'), '15 Dec 2025 – 4 Jan 2026')
  })
  test('rupees use Indian grouping and keep paise only when they exist', () => {
    assert.equal(formatRupees(15000000), '₹1,50,00,000')
    assert.equal(formatRupees(1234567.5), '₹12,34,567.50')
  })
  test('every reason a figure may fall short is a sentence', () => {
    const r = parsed(payload()).revenue!
    assert.deepEqual(revenueGapNotes(r), [
      '1 order with no confirmation date is not in any figure.',
      '2 orders this year with no product value on record are not counted.',
    ])
    assert.deepEqual(revenueGapNotes({ ...r, gaps: { noConfirmDate: 0, futureConfirmDate: 0, noProductValueInYear: 0, beforeDiscountInYear: 0 } }), [])
  })
})

describe('formatting', () => {
  test('dates are read as written — no time zone can move the day', () => {
    assert.equal(formatDate('2026-01-01'), '1 Jan 2026')
    assert.equal(formatDate('2026-12-31T23:59:59+00:00'), '31 Dec 2026')
  })
  test('percent drops trailing zeros only', () => {
    assert.equal(formatPercent(40), '40%')
    assert.equal(formatPercent(39.99), '39.99%')
    assert.equal(formatPercent(12.5), '12.5%')
    assert.equal(formatPercent(0), '0%')
  })
})

describe('PANIC MODE wording', () => {
  test('every refusal the database can give has its own sentence', () => {
    for (const code of ['PANIC_MODE_MONTH_LIMIT', 'PANIC_MODE_ALREADY_ACTIVE', 'PANIC_MODE_ORDER_CLOSED', 'PANIC_MODE_NOT_OWNER', 'PANIC_MODE_NOT_ACTIVE', 'PANIC_MODE_REASON_TOO_LONG']) {
      const msg = describePanicFailure({ message: `${code}: x` })
      assert.ok(!/could not be changed just now/.test(msg), `${code} fell through to the generic sentence`)
    }
    assert.match(describePanicFailure({ message: 'PANIC_MODE_MONTH_LIMIT: two' }), /does not free a slot/)
    assert.match(describePanicFailure({ message: 'boom' }), /could not be changed just now/)
  })
  test('the slot count reads plainly', () => {
    assert.equal(panicSlotsLabel({ active: [], monthStart: '2026-09-01', monthUsed: 1, monthLimit: 2, canManage: true }), '1 of 2 designations used this month')
    assert.equal(panicSlotsLabel({ active: [], monthStart: '2026-09-01', monthUsed: 2, monthLimit: 2, canManage: true }), '2 of 2 designations used this month — none left')
  })
})

describe('the page, and what the redesign removed', () => {
  const page = read('src/app/orders/page.tsx')
  const cards = read('src/lib/orders/orderDashboard.ts')

  test('one summary read, and no client-side aggregate of running orders', () => {
    assert.ok(page.includes("supabase.rpc('orders_dashboard_summary')"))
    assert.equal(page.includes('runningValue'), false, 'Running Value is gone')
    assert.equal(page.includes(".eq('status', 'running')"), false, 'the running-orders list is gone')
    assert.equal(page.includes('Running Orders'), false)
    assert.equal(page.includes('<table'), false, 'no table to scroll sideways on a phone')
  })

  test('the five removed cards are gone from the dashboard', () => {
    for (const gone of ['Payments', 'Awaiting Verification', 'Available Funds', 'Running Value', 'Review Queue']) {
      assert.equal(cards.includes(`label: '${gone}'`), false, `${gone} card`)
      assert.equal(page.includes(`label="${gone}"`), false, `${gone} card`)
    }
    for (const gone of ['finance_payment_requests', 'RECEIVED_PAYMENTS_SOURCE', 'financeCaps', 'FinanceCapabilities']) {
      assert.equal(page.includes(gone), false, `${gone} is no longer read by the dashboard`)
    }
  })

  test('PANIC MODE draws first, revenue last, and a failed read is an error state', () => {
    const at = (s: string) => page.indexOf(s)
    assert.ok(at('<PanicModeSection') > 0 && at('<PanicModeSection') < at('<AttentionCounts'), 'PANIC MODE is above every metric')
    assert.ok(at('<AttentionGroups') < at('<RevenueSection'), 'revenue comes after the urgent work')
    assert.ok(page.includes("summary.kind === 'error'") && page.includes('role="alert"'))
    assert.ok(page.includes('parseDashboardSummary'))
  })

  test('nothing here animates', () => {
    const css = read('src/app/globals.css')
    const block = css.slice(css.indexOf('ORDERS DASHBOARD (20270221000000)'))
    assert.equal(/@keyframes|animation\s*:/.test(block), false)
  })
})
