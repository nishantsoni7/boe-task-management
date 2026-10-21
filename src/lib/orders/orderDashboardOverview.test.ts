// THE ORDERS DASHBOARD'S AT-A-GLANCE CARDS AND ACTION BOARD (20270328000000).
//
// The database decides what is running, aligned, delayed, due soon or short of money
// (supabase/migrations/20270328000000_orders_dashboard_overview.sql). These pin the
// other half: the page validates that answer, words it, and draws a zero as a zero —
// never as a problem and never as an error — and does no arithmetic over orders itself.
//
// Run with: npx tsx --test "src/lib/orders/orderDashboardOverview.test.ts"

/* eslint-disable @typescript-eslint/no-explicit-any -- the malformed-payload cases reach into an untyped fixture on purpose */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BOARD_COPY,
  dueLine,
  overviewCards,
  parseDashboardSummary,
  type DashboardSummary,
} from './orderDashboardSummary'
import { BOARD_ORDER, boardRows, firstBoardWithRows } from '@/components/orders/dashboard/OverviewSection'

const ROOT = join(__dirname, '..', '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r/g, '')

const ref = (n: string) => ({ order_id: `id-${n}`, display_number: n, client_name: `Client ${n}`, status: 'running' })

const overview = (over: Record<string, unknown> = {}) => ({
  running: { orders: 5, value: 2500000 },
  aligned: { orders: 3, value: 1500000 },
  delayed: { orders: 2, value: 900000, max_days_late: 12 },
  due_soon: { orders: 1, value: 300000 },
  no_due_date: 1,
  payments_awaiting_verification: { orders: 1, amount: 120000 },
  advance_short: { orders: 2, amount: 350000 },
  delayed_list: [
    { ...ref('1010'), salesperson: 'Asha', due_date: '2026-10-09', days_late: 12, value: 500000 },
    { ...ref('1011'), salesperson: null, due_date: '2026-10-15', days_late: 6, value: 400000 },
  ],
  due_soon_list: [{ ...ref('1012'), salesperson: 'Ravi', due_date: '2026-10-22', days_left: 1, value: 300000, aligned: true }],
  aligned_list: [{ ...ref('1012'), salesperson: 'Ravi', due_date: '2026-10-22', value: 300000 }],
  ...over,
})

function payload(over: Record<string, unknown> = {}) {
  return {
    today: '2026-10-21',
    now: '2026-10-21T10:00:00+00:00',
    viewer: { sees_all_orders: true, can_view_revenue: false, can_manage_focus: false },
    alignment_reviewer: null,
    groups: {
      not_aligned: [
        { ...ref('1024'), state: 'awaiting_reviewer', waiting_on: 'reviewer', rank: 1, since: '2026-10-19T09:02:00+00:00', waiting_seconds: 90000, detail: null, advance_blocks: false },
      ],
      advance_below_40: [
        { ...ref('1021'), order_value: 1000000, verified: 100000, percent: 10, shortfall: 300000, exception_approved: false, held: false },
        { ...ref('1022'), order_value: 500000, verified: 150000, percent: 30, shortfall: 50000, exception_approved: false, held: false },
      ],
      fabric_finish_pending: [],
      fabric_finish_unrecorded: [],
    },
    overview: overview(),
    gaps: { open_orders: 5, advance_value_unknown: 0, advance_outside_scope: 0, no_confirm_date: 0 },
    revenue: null,
    factory_focus: { active: [], removed_for_you: [], month_start: '2026-10-01', month_used: null, month_limit: 2, can_manage: false },
    ...over,
  }
}

function parsed(raw: unknown): DashboardSummary {
  const r = parseDashboardSummary(raw)
  assert.equal(r.ok, true, r.ok ? '' : r.message)
  return (r as { ok: true; summary: DashboardSummary }).summary
}

describe('the overview is read, validated and optional', () => {
  test('a full overview parses into the page model', () => {
    const ov = parsed(payload()).overview!
    assert.equal(ov.running.orders, 5)
    assert.equal(ov.delayed.maxDaysLate, 12)
    assert.equal(ov.paymentsAwaiting.amount, 120000)
    assert.equal(ov.delayedList[1].salesperson, null)
    assert.equal(ov.dueSoonList[0].aligned, true)
  })

  test('a database without the overview still draws the old dashboard', () => {
    const raw: any = payload()
    delete raw.overview
    assert.equal(parsed(raw).overview, null)
    assert.deepEqual(overviewCards(parsed(raw)), [])
  })

  test('a malformed overview is an error, never zeros', () => {
    const raw: any = payload()
    raw.overview.delayed.orders = 'many'
    assert.equal(parseDashboardSummary(raw).ok, false)
    const raw2: any = payload()
    raw2.overview.delayed_list = [{ display_number: '1' }]
    assert.equal(parseDashboardSummary(raw2).ok, false)
  })
})

describe('the six cards', () => {
  test('are the six questions, in order', () => {
    assert.deepEqual(overviewCards(parsed(payload())).map(c => c.key),
      ['running', 'aligned', 'delayed', 'payments', 'fabric', 'due_soon'])
  })

  test('say the figures the database sent', () => {
    const cards = Object.fromEntries(overviewCards(parsed(payload())).map(c => [c.key, c]))
    assert.equal(cards.running.count, 5)
    assert.match(cards.running.sub, /₹25,00,000 product value/)
    assert.match(cards.running.detail, /1 order with no due date/)
    assert.equal(cards.aligned.count, 3)
    assert.match(cards.aligned.detail, /1 still not aligned/)
    assert.equal(cards.delayed.count, 2)
    assert.equal(cards.delayed.tone, 'danger')
    assert.match(cards.delayed.detail, /Longest: 12 days late/)
    // The payments card counts the advance list and sums its shortfall, in rupees.
    assert.equal(cards.payments.count, 2)
    assert.match(cards.payments.sub, /₹3,50,000 short of the 40% advance/)
    assert.match(cards.payments.detail, /₹1,20,000 awaiting verification on 1 order/)
    assert.equal(cards.due_soon.count, 1)
  })

  test('a zero is drawn as a zero: neutral tone, no alarm, no board link', () => {
    const raw: any = payload()
    raw.overview = overview({
      running: { orders: 0, value: 0 }, aligned: { orders: 0, value: 0 },
      delayed: { orders: 0, value: 0, max_days_late: 0 }, due_soon: { orders: 0, value: 0 },
      no_due_date: 0, payments_awaiting_verification: { orders: 0, amount: 0 }, advance_short: { orders: 0, amount: 0 },
      delayed_list: [], due_soon_list: [], aligned_list: [],
    })
    raw.groups.not_aligned = []
    raw.groups.advance_below_40 = []
    const cards = overviewCards(parsed(raw))
    for (const c of cards) {
      assert.equal(c.count, 0, c.key)
      assert.equal(c.tone === 'danger' || c.tone === 'attention', false, `${c.key} must not alarm at zero`)
    }
    assert.match(cards.find(c => c.key === 'delayed')!.detail, /Nothing past its due date/)
    // No "₹0 product value": an absent figure is said without a number.
    assert.equal(cards.find(c => c.key === 'running')!.sub, 'product value')
  })
})

describe('the action board', () => {
  test('every tab has words, and the tabs are in urgency order', () => {
    assert.deepEqual([...BOARD_ORDER], ['delayed', 'payments', 'not_aligned', 'fabric', 'due_soon', 'aligned'])
    for (const k of BOARD_ORDER) {
      assert.ok(BOARD_COPY[k].label && BOARD_COPY[k].empty, k)
    }
  })

  test('rows come from the database lists, most late first, with the salesperson said', () => {
    const s = parsed(payload())
    const delayed = boardRows(s, 'delayed')
    assert.deepEqual(delayed.map(r => r.displayNumber), ['1010', '1011'])
    assert.match(delayed[0].headline, /12 days late/)
    assert.match(delayed[0].sub, /Salesperson: Asha/)
    assert.match(delayed[1].sub, /No salesperson recorded/)
    assert.equal(boardRows(s, 'payments')[0].figure, '₹3,00,000')
    assert.match(boardRows(s, 'not_aligned')[0].headline, /Awaiting operations review/)
  })

  test('opens on the first tab that has rows', () => {
    assert.equal(firstBoardWithRows(parsed(payload())), 'delayed')
    const raw: any = payload()
    raw.overview.delayed_list = []
    assert.equal(firstBoardWithRows(parsed(raw)), 'payments')
  })

  test('due lines read plainly', () => {
    const base = { orderId: 'x', displayNumber: '1', clientName: '', status: 'running', salesperson: null, value: null, aligned: false }
    assert.equal(dueLine({ ...base, dueDate: '2026-10-20', daysLate: 1, daysLeft: null }), '1 day late')
    assert.equal(dueLine({ ...base, dueDate: '2026-10-21', daysLate: null, daysLeft: 0 }), 'Due today')
    assert.equal(dueLine({ ...base, dueDate: '2026-10-23', daysLate: null, daysLeft: 2 }), 'Due in 2 days')
    assert.equal(dueLine({ ...base, dueDate: null, daysLate: null, daysLeft: null }), 'No due date')
  })
})

describe('the database does the work', () => {
  test('the overview is one more key on the same single read, and the page adds no query', () => {
    const sql = read('supabase/migrations/20270328000000_orders_dashboard_overview.sql')
    assert.match(sql, /'overview', \(select j from overview\)/)
    assert.match(sql, /can_read_order_detail\(o\.id\)/, 'still only the orders the caller may open')
    assert.match(sql, /coalesce\(o\.is_test_data, false\) = false/, 'test data stays out')
    assert.match(sql, /full_view and awaiting_amount > 0/, 'payment figures follow the unscoped rule')
    const page = read('src/app/orders/page.tsx')
    assert.equal((page.match(/supabase\.rpc\('orders_dashboard_summary'\)/g) ?? []).length, 1)
  })

  test('the component does no date or money arithmetic over orders', () => {
    const src = read('src/components/orders/dashboard/OverviewSection.tsx')
    assert.equal(/Date\.now|new Date\(|\.reduce\(|Math\./.test(src), false)
  })
})
