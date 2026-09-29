// THE ORDERS DASHBOARD, AS THE PAGE READS IT (20270221000000).
//
// The database decides what counts; supabase/tests/orders_dashboard_assertions.sql
// pins the rules (whose court an unaligned order is in, the 40% line, the 15-day
// line, the revenue windows, Factory Focus, the visibility scopes). These pin the
// other half: that the page turns the database's answer into words without
// inventing, dropping or softening anything, that a payload that would leak or
// contradict the viewer is refused, and that what this phase removed stays removed.
//
// Run with: npx tsx --test "src/lib/orders/orderDashboardSummary.test.ts"

/* eslint-disable @typescript-eslint/no-explicit-any -- the malformed-payload cases reach into an untyped fixture on purpose */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ALIGNMENT_STATE_LABEL,
  GROUP_COPY,
  UNRECORDED_RULE,
  UNRECORDED_TITLE,
  advanceLine,
  alignmentLine,
  alignmentSummary,
  describeFocusFailure,
  fabricFinishLine,
  focusSelectedLine,
  focusSlotsLabel,
  formatDate,
  formatInstantIst,
  formatMonth,
  formatPercent,
  formatRange,
  formatRupees,
  formatWaiting,
  groupGapNote,
  parseDashboardSummary,
  removedNoticeLine,
  revenueGapNotes,
  revenueTiles,
  unrecordedLine,
  waitingOnLabel,
  type DashboardSummary,
} from './orderDashboardSummary'
import { ORDER_EVENT_LABEL, describeOrderEvent, mergeOrderHistory } from './orderHistory'
import { ModulePageSkeleton } from '@/components/layout/ModulePageSkeleton'
import { skeletonVariantFor } from '@/components/layout/ModuleRouteFallback'

const ROOT = join(__dirname, '..', '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r/g, '')

const ref = (n: string) => ({ order_id: `id-${n}`, display_number: n, client_name: `Client ${n}`, status: 'running' })

/** A payload shaped exactly like orders_dashboard_summary()'s answer. */
function payload(over: Record<string, unknown> = {}) {
  return {
    today: '2026-09-29',
    now: '2026-09-29T10:00:00+00:00',
    viewer: { sees_all_orders: true, can_view_revenue: true, can_manage_focus: false },
    alignment_reviewer: { user_id: 'u-rev', name: 'Nitish Bansal' },
    groups: {
      not_aligned: [
        { ...ref('1024'), state: 'awaiting_reviewer', waiting_on: 'reviewer', rank: 1, since: '2026-09-26T09:02:00+00:00', waiting_seconds: 277200, detail: null, advance_blocks: true },
        { ...ref('1025'), state: 'clarification_needed', waiting_on: 'approver', rank: 4, since: '2026-09-27T09:00:00+00:00', waiting_seconds: 90000, detail: 'Sofa fabric not stocked', advance_blocks: false },
      ],
      advance_below_40: [{ ...ref('1021'), order_value: 1000000, verified: 399999.99, percent: 39.99, shortfall: 0.01, exception_approved: true, held: false }],
      fabric_finish_pending: [
        { ...ref('1023'), confirm_date: '2026-09-10', days_since_confirmation: 19,
          pending: [{ kind: 'fabric', status: 'not_approved' }], not_recorded: ['finish'] },
        // A NEW order: fabric approved, finish with no event at all — pending, not hidden.
        { ...ref('1031'), confirm_date: '2026-09-05', days_since_confirmation: 24,
          pending: [{ kind: 'finish', status: 'no_approval_recorded' }], not_recorded: [] },
      ],
      fabric_finish_unrecorded: [{ ...ref('1030'), confirm_date: '2026-07-01', days_since_confirmation: 90, not_recorded: ['fabric', 'finish'] }],
    },
    gaps: { open_orders: 40, advance_value_unknown: 2, advance_outside_scope: 0, no_confirm_date: 3 },
    revenue: {
      currency: 'INR', basis: 'product_value', date_basis: 'confirm_date',
      current_month: { from: '2026-09-01', to: '2026-09-29', amount: 1234567.5, orders: 3 },
      last_six_months: { from: '2026-03-01', to: '2026-08-31', amount: 9000000, orders: 20 },
      current_year: { from: '2026-01-01', to: '2026-09-29', amount: 15000000, orders: 41 },
      gaps: { no_confirm_date: 1, future_confirm_date: 0, no_product_value_in_year: 2, before_discount_in_year: 0 },
    },
    factory_focus: {
      active: [
        { selection_id: 's1', display_number: '1022', selected_month: '2026-09-01', selected_at: '2026-09-05T08:00:00+00:00', salesperson_name: 'Kavya Iyer',
          can_open: true, order_id: 'id-1022', client_name: 'Rivoli Interiors', status: 'running', note: 'Won from scratch' },
        { selection_id: 's2', display_number: '1040', selected_month: '2026-08-01', selected_at: '2026-08-05T08:00:00+00:00', salesperson_name: 'Meera Nair',
          can_open: false, order_id: null, client_name: null, status: null, note: null },
      ],
      removed_for_you: [],
      month_start: '2026-09-01', month_used: null as number | null, month_limit: 2, can_manage: false,
    },
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
    assert.equal(s.notAligned[0].state, 'awaiting_reviewer')
    assert.equal(s.notAligned[1].detail, 'Sofa fabric not stocked')
    assert.equal(s.advance[0].exceptionApproved, true)
    assert.deepEqual(s.fabricFinish[0].notRecorded, ['finish'])
    assert.equal(s.fabricFinish[1].pending[0].status, 'no_approval_recorded')
    assert.deepEqual(s.fabricUnrecorded[0].notRecorded, ['fabric', 'finish'])
    assert.equal(s.reviewer?.name, 'Nitish Bansal')
    assert.equal(s.revenue?.lastSixMonths.to, '2026-08-31')
    assert.equal(s.focus.active.length, 2)
  })

  test('numbers sent as strings (numeric columns) are read as numbers', () => {
    const p = payload()
    ;(p.groups.advance_below_40[0] as Record<string, unknown>).shortfall = '400000.00'
    assert.equal(parsed(p).advance[0].shortfall, 400000)
  })

  for (const [name, mutate] of [
    ['a missing groups object', (p: Record<string, unknown>) => { delete p.groups }],
    ['a group that is not a list', (p: Record<string, unknown>) => { (p.groups as Record<string, unknown>).not_aligned = null }],
    ['an unknown alignment state', (p: Record<string, unknown>) => { ((p.groups as any).not_aligned[0]).state = 'mystery' }],
    ['an unknown waiting-on', (p: Record<string, unknown>) => { ((p.groups as any).not_aligned[0]).waiting_on = 'nobody' }],
    ['an alignment row with no start time', (p: Record<string, unknown>) => { delete ((p.groups as any).not_aligned[0]).since }],
    ['a fabric row with nothing pending', (p: Record<string, unknown>) => { ((p.groups as any).fabric_finish_pending[0]).pending = [] }],
    ['an unrecorded row with nothing unrecorded', (p: Record<string, unknown>) => { ((p.groups as any).fabric_finish_unrecorded[0]).not_recorded = [] }],
    ['a non-numeric shortfall', (p: Record<string, unknown>) => { ((p.groups as any).advance_below_40[0]).shortfall = 'soon' }],
    ['a missing Factory Focus object', (p: Record<string, unknown>) => { delete p.factory_focus }],
    ['a null answer', (p: Record<string, unknown>) => { for (const k of Object.keys(p)) delete p[k] }],
  ] as const) {
    test(`${name} is an error, not an empty dashboard`, () => {
      const p = payload() as Record<string, unknown>
      mutate(p)
      assert.equal(parseDashboardSummary(p).ok, false)
    })
  }

  test('a reader told they may not see revenue is handed none, and vice versa', () => {
    const view = (rev: boolean) => ({ sees_all_orders: false, can_view_revenue: rev, can_manage_focus: false })
    assert.equal(parsed(payload({ revenue: null, viewer: view(false) })).revenue, null)
    assert.equal(parseDashboardSummary(payload({ viewer: view(false) })).ok, false)
    assert.equal(parseDashboardSummary(payload({ revenue: null })).ok, false)
  })

  test('a Factory Focus card for an order the reader cannot open must carry nothing more', () => {
    const p = payload()
    const leaky = (extra: Record<string, unknown>) => {
      const q = payload()
      Object.assign(q.factory_focus.active[1], extra)
      return parseDashboardSummary(q)
    }
    assert.equal(parsed(p).focus.active[1].clientName, null)
    for (const extra of [{ client_name: 'Rivoli' }, { note: 'a note' }, { order_id: 'id-x' }, { status: 'running' }]) {
      assert.equal(leaky(extra).ok, false, `${Object.keys(extra)[0]} must be refused`)
    }
    const q = payload(); (q.factory_focus.active[0] as Record<string, unknown>).order_id = null
    assert.equal(parseDashboardSummary(q).ok, false, 'an openable card needs its order')
  })

  test('the controls and slot counts match what the reader may do', () => {
    const own = payload()
    own.factory_focus.month_used = 1
    assert.equal(parseDashboardSummary(own).ok, false, 'slot counts sent to a reader who cannot manage')
    const mismatch = payload({ viewer: { sees_all_orders: true, can_view_revenue: true, can_manage_focus: true } })
    assert.equal(parseDashboardSummary(mismatch).ok, false, 'the controls flag must agree with the viewer')
    const owner = payload({ viewer: { sees_all_orders: true, can_view_revenue: true, can_manage_focus: true } })
    owner.factory_focus.can_manage = true; owner.factory_focus.month_used = 2
    assert.equal(parsed(owner).focus.monthUsed, 2)
  })
})

describe('this phase has three lists, and no overdue list', () => {
  test('the groups, in order', () => {
    assert.deepEqual(Object.keys(GROUP_COPY), ['not_aligned', 'advance_below_40', 'fabric_finish_pending'])
    assert.equal(GROUP_COPY.not_aligned.label, 'Not aligned for manufacturing')
  })

  test('overdue is gone from the read, the page and the words', () => {
    for (const file of [
      'src/lib/orders/orderDashboardSummary.ts',
      'src/components/orders/dashboard/AttentionSections.tsx',
      'src/components/orders/dashboard/FactoryFocusSection.tsx',
      'src/app/orders/page.tsx',
    ]) {
      const src = read(file)
      assert.equal(/overdue|days_overdue|no_due_date|Past due/i.test(src), false, `${file} still mentions overdue`)
    }
    const sql = read('supabase/migrations/20270221000000_orders_dashboard_factory_focus.sql')
    assert.equal(/'overdue'|days_overdue|no_due_date/.test(sql), false, 'the read no longer computes it')
  })
})

describe('alignment says whose court it is in, and since when', () => {
  test('every state has words, and the court is named', () => {
    const s = parsed(payload())
    assert.equal(ALIGNMENT_STATE_LABEL.no_handoff, 'Older order — no operations handoff recorded')
    assert.equal(waitingOnLabel('reviewer', 'Nitish Bansal'), 'Waiting on Nitish Bansal')
    assert.equal(waitingOnLabel('reviewer', null), 'Waiting on the operations reviewer')
    assert.equal(waitingOnLabel('approver', 'Nitish Bansal'), 'Waiting on the approver to answer')
    assert.equal(waitingOnLabel('administrator', null), 'Waiting on an administrator to assign a reviewer')
    assert.equal(waitingOnLabel('payment', null), 'Waiting on the verified advance')
    assert.equal(alignmentLine(s.notAligned[1]), 'Flagged by operations — needs clarification: Sofa fabric not stocked')
  })

  test('a flagged order is never described as waiting on the reviewer', () => {
    const s = parsed(payload())
    const flagged = s.notAligned.find(r => r.state === 'clarification_needed')!
    assert.doesNotMatch(waitingOnLabel(flagged.waitingOn, 'Nitish Bansal'), /Nitish/)
  })

  test('the summary counts who is waiting on the reviewer and who on others', () => {
    const s = parsed(payload())
    assert.equal(alignmentSummary(s.notAligned, s.reviewer?.name ?? null), '1 waiting on Nitish Bansal · 1 waiting on others')
  })

  test('the start timestamp is Indian time, whatever the device says', () => {
    assert.equal(formatInstantIst('2026-09-26T09:02:00+00:00'), '26 Sep 2026, 14:32 IST')
    assert.equal(formatInstantIst('2026-12-31T20:00:00+00:00'), '1 Jan 2027, 01:30 IST')
  })

  test('elapsed time is coarse where it can be', () => {
    assert.equal(formatWaiting(3 * 86400 + 4 * 3600 + 59), '3 d 4 h')
    assert.equal(formatWaiting(5 * 3600 + 12 * 60), '5 h 12 m')
    assert.equal(formatWaiting(12 * 60 + 30), '12 m')
    assert.equal(formatWaiting(-5), '0 m')
  })
})

describe('advance, and fabric/finish, say what the database said', () => {
  test('advance: the percentage and the shortfall, with the exception flag carried separately', () => {
    const s = parsed(payload())
    assert.equal(advanceLine(s.advance[0]), '39.99% verified · ₹0.01 short of 40%')
    assert.equal(s.advance[0].exceptionApproved, true)
    assert.equal(advanceLine({ ...s.advance[0], percent: 0, shortfall: 400000 }), '0% verified · ₹4,00,000 short of 40%')
  })

  test('a new order with no approval event reads "no approval recorded" — pending, and the other item is not concealed', () => {
    const s = parsed(payload())
    assert.equal(fabricFinishLine(s.fabricFinish[1]), 'Finish no approval recorded · 24 days since confirmation')
    assert.equal(fabricFinishLine({ ...s.fabricFinish[1], pending: [{ kind: 'fabric', status: 'no_approval_recorded' }, { kind: 'finish', status: 'no_approval_recorded' }] }),
      'Fabric no approval recorded · Finish no approval recorded · 24 days since confirmation')
  })

  test('fabric and finish: the pending item, the elapsed days, and a gap on the other item said on the row', () => {
    const s = parsed(payload())
    assert.equal(fabricFinishLine(s.fabricFinish[0]), 'Fabric not approved · Finish status not recorded · 19 days since confirmation')
    assert.equal(fabricFinishLine({ ...s.fabricFinish[0], pending: [{ kind: 'finish', status: 'partially_approved' }, { kind: 'fabric', status: 'not_approved' }], notRecorded: [] }),
      'Finish partially approved · Fabric not approved · 19 days since confirmation')
  })

  test('a status nobody recorded is its own line, and says so', () => {
    const s = parsed(payload())
    assert.equal(unrecordedLine(s.fabricUnrecorded[0]), 'Fabric and Finish status not recorded · 90 days since confirmation')
  })

  test('what could not be assessed is said under its group, never folded into "all clear"', () => {
    const s = parsed(payload())
    assert.equal(groupGapNote('advance_below_40', s.gaps), '2 open orders with no order value could not be checked.')
    assert.equal(groupGapNote('fabric_finish_pending', s.gaps), '3 open orders with no confirmation date could not be checked.')
    assert.equal(groupGapNote('not_aligned', s.gaps), null)
    assert.equal(groupGapNote('advance_below_40', { ...s.gaps, advanceValueUnknown: 0, advanceOutsideScope: 3 }), 'Payment figures are not shown for 3 orders you can see only through your visibility scope.')
    assert.equal(groupGapNote('fabric_finish_pending', { ...s.gaps, noConfirmDate: 1 }), '1 open order with no confirmation date could not be checked.')
  })
})

describe('revenue', () => {
  test('three figures, the exact period beneath each, and the six months are COMPLETED months', () => {
    const tiles = revenueTiles(parsed(payload()).revenue!)
    assert.deepEqual(tiles.map(t => t.label), ['Current month', 'Last 6 completed months', 'Current year'])
    assert.equal(formatRange(tiles[0].period.from, tiles[0].period.to), '1 Sep – 29 Sep 2026')
    assert.equal(formatRange(tiles[1].period.from, tiles[1].period.to), '1 Mar – 31 Aug 2026')
    assert.equal(formatRange(tiles[2].period.from, tiles[2].period.to), '1 Jan – 29 Sep 2026')
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

describe('the older-orders list is about history, and says new orders never land in it', () => {
  test('the words', () => {
    assert.match(UNRECORDED_TITLE, /Older orders/)
    assert.match(UNRECORDED_RULE, /created before fabric and finish approvals were tracked/)
    assert.match(UNRECORDED_RULE, /New orders never appear here/)
  })
})

describe('Factory Focus lives in the Order’s permanent history, not only on the dashboard', () => {
  const removed = { id: 'e1', event_type: 'factory_focus_removed', created_at: '2026-09-29T10:00:00+00:00', actor_name: 'Nishant',
    payload: { selected_month: '2026-08-01', reason: 'Client paused the order' } }
  const selected = { id: 'e0', event_type: 'factory_focus_selected', created_at: '2026-08-05T10:00:00+00:00', actor_name: 'Nishant',
    payload: { selected_month: '2026-08-01', note: 'Won from scratch' } }

  test('both events have words, and the reason is the detail line', () => {
    assert.equal(ORDER_EVENT_LABEL.factory_focus_selected, 'Selected for Factory Focus')
    assert.equal(ORDER_EVENT_LABEL.factory_focus_removed, 'Removed from Factory Focus')
    assert.equal(describeOrderEvent(removed as never), 'Selected August 2026 · Client paused the order')
    assert.equal(describeOrderEvent(selected as never), 'Selected August 2026 · Won from scratch')
  })

  test('the merged history carries them, newest first, with who did it', () => {
    const merged = mergeOrderHistory({
      orderRows: [selected, removed] as never, orderLabel: () => null, orderDetail: () => null,
      piRows: [], namesById: new Map(), formatWhen: iso => iso ?? '',
    })
    assert.deepEqual(merged.map(m => m.label), ['Removed from Factory Focus', 'Selected for Factory Focus'])
    assert.equal(merged[0].detail, 'Selected August 2026 · Client paused the order')
    assert.equal(merged[0].actor, 'Nishant')
  })

  test('the Order page reads its whole activity log, so nothing filters these events out', () => {
    const page = read('src/app/orders/[id]/page.tsx')
    const q = page.slice(page.indexOf("const activityQuery = () =>"), page.indexOf('const mapActivityRows'))
    assert.ok(q.includes(".from('order_activity_log')") && q.includes(".eq('order_id', id)"))
    assert.equal(/\.in\('event_type'/.test(q), false)
  })

  test('the migration writes both events for every writer, with the reason, in the same transaction', () => {
    const sql = read('supabase/migrations/20270221000000_orders_dashboard_factory_focus.sql')
    assert.match(sql, /create trigger order_factory_focus_history\s+after insert or update on public\.order_factory_focus_selections/)
    assert.match(sql, /'factory_focus_removed'[\s\S]{0,200}'reason', new\.removal_reason/)
    assert.match(sql, /'factory_focus_selected'/)
  })

  test('the dashboard notice is only a convenience: it still says it expires, the record does not', () => {
    const sql = read('supabase/migrations/20270221000000_orders_dashboard_factory_focus.sql')
    assert.match(sql, /interval '30 days'/)
    assert.match(sql, /The 30-day\s+-- dashboard notice is a convenience/)
  })
})

describe('formatting', () => {
  test('dates are read as written — no time zone can move the day', () => {
    assert.equal(formatDate('2026-01-01'), '1 Jan 2026')
    assert.equal(formatDate('2026-12-31T23:59:59+00:00'), '31 Dec 2026')
    assert.equal(formatMonth('2026-09-01'), 'September 2026')
  })
  test('percent drops trailing zeros only', () => {
    assert.equal(formatPercent(40), '40%')
    assert.equal(formatPercent(39.99), '39.99%')
    assert.equal(formatPercent(0), '0%')
  })
})

describe('Factory Focus wording', () => {
  test('the salesperson and the selection month are always said', () => {
    const s = parsed(payload())
    assert.equal(focusSelectedLine(s.focus.active[0]), 'Salesperson: Kavya Iyer · Selected September 2026')
    assert.equal(focusSelectedLine(s.focus.active[1]), 'Salesperson: Meera Nair · Selected August 2026')
    assert.equal(focusSelectedLine({ ...s.focus.active[0], salespersonName: null }), 'Salesperson not recorded · Selected September 2026')
  })
  test('the removal reason is shown to the salesperson', () => {
    assert.equal(removedNoticeLine({ displayNumber: '1027', selectedMonth: '2026-08-01', removedAt: '2026-09-20T10:00:00+00:00', removalReason: 'Client paused the order' }),
      'Factory Focus was removed from order 1027 (selected August 2026, removed 20 Sep 2026): Client paused the order')
  })
  test('the slot count is the owner’s, and says when none is left', () => {
    const f = parsed(payload()).focus
    assert.equal(focusSlotsLabel(f), '')
    assert.equal(focusSlotsLabel({ ...f, monthUsed: 1, canManage: true }), '1 of 2 selections used in September 2026')
    assert.equal(focusSlotsLabel({ ...f, monthUsed: 2, canManage: true }), '2 of 2 selections used in September 2026 — none left')
  })
  test('every refusal the database can give has its own sentence, and a reason is asked for', () => {
    for (const code of ['FACTORY_FOCUS_MONTH_LIMIT', 'FACTORY_FOCUS_ALREADY_ACTIVE', 'FACTORY_FOCUS_ORDER_CLOSED', 'FACTORY_FOCUS_NO_SALESPERSON',
      'FACTORY_FOCUS_NOT_OWNER', 'FACTORY_FOCUS_NOT_ACTIVE', 'FACTORY_FOCUS_REASON_REQUIRED', 'FACTORY_FOCUS_REASON_TOO_LONG', 'FACTORY_FOCUS_NOTE_TOO_LONG']) {
      assert.doesNotMatch(describeFocusFailure({ message: `${code}: x` }), /could not be changed just now/, code)
    }
    assert.match(describeFocusFailure({ message: 'FACTORY_FOCUS_MONTH_LIMIT: two' }), /does not free a selection/)
    assert.match(describeFocusFailure({ message: 'FACTORY_FOCUS_REASON_REQUIRED: x' }), /Say why/)
    assert.match(describeFocusFailure({ message: 'boom' }), /could not be changed just now/)
  })
})

describe('the page, and what this phase changed', () => {
  const page = read('src/app/orders/page.tsx')
  const cards = read('src/lib/orders/orderDashboard.ts')

  test('one summary read, and no client-side aggregate of running orders', () => {
    assert.ok(page.includes("supabase.rpc('orders_dashboard_summary')"))
    assert.equal(page.includes('runningValue'), false)
    assert.equal(page.includes(".eq('status', 'running')"), false)
    assert.equal(page.includes('<table'), false, 'no table to scroll sideways on a phone')
  })

  test('the five removed cards stay gone from the dashboard', () => {
    for (const gone of ['Payments', 'Awaiting Verification', 'Available Funds', 'Running Value', 'Review Queue']) {
      assert.equal(cards.includes(`label: '${gone}'`), false, `${gone} card`)
    }
    for (const gone of ['finance_payment_requests', 'RECEIVED_PAYMENTS_SOURCE', 'financeCaps', 'FinanceCapabilities']) {
      assert.equal(page.includes(gone), false, `${gone} is no longer read by the dashboard`)
    }
  })

  test('reading order: revenue, the status strip, Factory Focus, then the lists', () => {
    const at = (s: string) => page.indexOf(s)
    assert.ok(at('<RevenueSection') > 0)
    assert.ok(at('<RevenueSection') < at('<StatusStrip'), 'revenue is the headline')
    assert.ok(at('<StatusStrip') < at('<FactoryFocusSection'), 'the strip is one glance, before the detail')
    assert.ok(at('<FactoryFocusSection') < at('<AlignmentSection'), 'Factory Focus is first')
    assert.ok(at('<AlignmentSection') < at('<AdvanceSection'), 'alignment comes straight after it')
    assert.ok(at('<AdvanceSection') < at('<FabricFinishSection'))
    assert.ok(page.includes("summary.kind === 'error'") && page.includes('role="alert"'))
  })

  test('Factory Focus needs no special grant: no view action is registered or asked for', () => {
    for (const file of ['src/lib/permissions/modules.ts', 'src/lib/permissions/levels.ts', 'src/lib/permissions/accessControlChanges.ts']) {
      assert.equal(/view_panic_mode|view_factory_focus/.test(read(file)), false, `${file} carries a view grant`)
    }
    const sql = read('supabase/migrations/20270221000000_orders_dashboard_factory_focus.sql')
    assert.equal(/view_panic_mode|can_view_panic_mode/.test(sql), false)
    assert.equal(/panic/i.test(sql), false, 'the migration no longer speaks of PANIC MODE')
  })

  test('PANIC MODE is renamed everywhere a person can read it', () => {
    for (const file of [
      'src/lib/orders/orderDashboardSummary.ts', 'src/components/orders/dashboard/FactoryFocusSection.tsx',
      'src/components/orders/dashboard/AttentionSections.tsx', 'src/components/orders/dashboard/RevenueSection.tsx',
      'src/app/orders/page.tsx', 'src/components/controlCenter/OrderVisibilityTab.tsx', 'src/lib/orders/orderVisibilityScopes.ts',
    ]) {
      assert.equal(/panic/i.test(read(file)), false, `${file} still says PANIC`)
    }
  })

  test('the owner’s controls are behind the database’s flag and View As, and removal asks for a reason', () => {
    const section = read('src/components/orders/dashboard/FactoryFocusSection.tsx')
    assert.ok(page.includes('canManageFocus && !viewAsUserId'))
    assert.ok(section.includes('focus.canManage && !readOnlyReason'))
    assert.ok(section.includes("supabase.rpc('remove_order_factory_focus'"))
    assert.ok(/required/.test(section) && section.includes('Say why Factory Focus is being removed.'))
    assert.ok(section.includes('The salesperson will see this.'))
  })

  test('nothing here animates', () => {
    const css = read('src/app/globals.css')
    const block = css.slice(css.indexOf('ORDERS DASHBOARD (20270221000000)'))
    assert.equal(/@keyframes|animation\s*:/.test(block), false)
  })
})

describe('the Orders loading state matches the new layout — and Finance keeps its own', () => {
  const html = (variant: 'dashboard' | 'list' | 'record' | 'orders-dashboard') =>
    renderToStaticMarkup(createElement(ModulePageSkeleton, { variant, label: 'Loading' }))

  test('the Orders dashboard has its own shape, with the two side-by-side lists', () => {
    assert.match(html('orders-dashboard'), /od-pair/)
  })
  test('the existing skeletons are byte-for-byte what they were: no od- class, same grid', () => {
    assert.doesNotMatch(html('dashboard'), /od-pair/)
    assert.match(html('dashboard'), /repeat\(auto-fill, minmax\(160px, 1fr\)\)/)
  })
  test('only the Orders fallback asks for the new shape; Finance is untouched', () => {
    const fallback = read('src/components/layout/ModuleRouteFallback.tsx')
    const orders = fallback.slice(fallback.indexOf('export function OrdersRouteFallback'), fallback.indexOf('export function FinanceRouteFallback'))
    const finance = fallback.slice(fallback.indexOf('export function FinanceRouteFallback'))
    assert.match(orders, /orders-dashboard/)
    assert.doesNotMatch(finance, /orders-dashboard/)
    assert.equal(skeletonVariantFor('/orders'), 'dashboard', 'the shared chooser is unchanged')
    assert.equal(skeletonVariantFor('/finance'), 'list')
  })
})
