// THE "NEW UPDATE" MARK ON THE OPERATIONS DASHBOARD, drawn by the REAL component (owner, 2026-11-15).
//
// backWithOperations.test.ts pins the rule and the wiring as source text; these render the real
// OperationsDashboardView / ChangesToReview with fixtures and look at the markup, so a row that is
// marked, a row that is not, and "nothing marked at all" are each shown to be what the screen draws.
//
// Run with: npm run test:file -- src/lib/orders/backWithOperations.render.test.tsx

import '@/lib/testing/cssModuleStub'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { ChangesToReview, OperationsDashboardView } from '@/components/orders/dashboard/OperationsDashboardView'
import { parseOperationsRead, type OperationsRead } from './operationsDashboard'
import type { DashboardSummary } from './orderDashboardSummary'

const period = { from: '2026-09-01', to: '2026-09-30', orders: { count: 1, value: 100 }, dispatches: { count: 1, value: 100 } }

const payload = (pending: unknown[]) => ({
  today: '2026-11-15',
  viewer: { is_reviewer: true, is_approver: false },
  pending_changes: pending,
  responses: [],
  order_details: [
    { order_id: 'o546', salesperson: 'Mohit Sharma', due_date: '2026-11-28', value: 485000 },
    { order_id: 'o541', salesperson: 'Prerna', due_date: '2026-11-20', value: 660000 },
  ],
  periods: { last_month: period, last_six_months: period, gaps: { dispatched_without_date: 0, orders_without_value: 0, no_confirm_date: 0 } },
})

const pendingChange = {
  handoff_id: 'h543', order_id: 'o543', display_number: '543', client_name: 'Hotel Vits Sampling',
  version_number: 2, approved_at: '2026-11-15T08:50:00Z', approved_by_name: 'Owner', revision_reason: 'Walnut instead of oak',
  changes: { available: true, lines: [{ key: 'item:LC210', title: 'Lounge chair', kind: 'changed', changes: [{ label: 'Wood', old: 'Oak', new: 'Walnut' }] }] },
}

function readOf(pending: unknown[]): OperationsRead {
  const parsed = parseOperationsRead(payload(pending))
  assert.ok(parsed.ok, 'the fixture is a valid read')
  return parsed.read
}

const row = (orderId: string, displayNumber: string, clientName: string, state = 'awaiting_reviewer') => ({
  orderId, displayNumber, clientName, state, waitingOn: 'reviewer', since: '2026-11-15T08:00:00Z', waitingSeconds: 6 * 3600, detail: null, advanceBlocks: false,
})

const summary = {
  today: '2026-11-15', now: '2026-11-15T14:00:00Z',
  viewer: { seesAllOrders: true, canViewRevenue: false, canManageFocus: false },
  reviewer: null,
  notAligned: [row('o541', '541', 'Antera Restro'), row('o546', '546', 'Dhawal Interiors')],
  advance: [], fabricFinish: [], fabricUnrecorded: [], overview: null, gaps: {}, revenue: null, focus: {},
} as unknown as DashboardSummary

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }
const supabase = {} as SupabaseClient

function dashboard(read: OperationsRead, back: string[]) {
  return renderToStaticMarkup(
    createElement(AppRouterContext.Provider, { value: router as never },
      createElement(OperationsDashboardView, { summary, read, backWithOps: new Set(back), supabase, onAnswered() {}, readOnlyReason: null })),
  )
}

/** The markup of the table row for one order number: from its <tr to the next </tr>. */
const rowOf = (html: string, number: string) => {
  const at = html.indexOf(`>${number}</a>`)
  assert.ok(at > 0, `row ${number} is drawn`)
  const start = html.lastIndexOf('<tr', at)
  return html.slice(start, html.indexOf('</tr>', at))
}

describe('Not aligned for manufacturing', () => {
  test('an order that came back is marked: blue row and the words "New update" under its status', () => {
    const out = dashboard(readOf([]), ['o546'])
    const marked = rowOf(out, '546')
    assert.match(marked, /class="ops-na-row" data-new="true"/)
    assert.match(marked, /class="ops-new"/)
    assert.match(marked, /New update/)
    assert.match(marked, /Awaiting review/, 'its own status is still said')
  })

  test('an order that did not come back is drawn exactly as before', () => {
    const out = dashboard(readOf([]), ['o546'])
    const plain = rowOf(out, '541')
    assert.equal(plain.includes('data-new'), false)
    assert.equal(plain.includes('New update'), false)
    assert.equal((out.match(/New update/g) ?? []).length, 1, 'one mark for one order')
  })

  test('nothing is marked for anybody who was given an empty set (not the Operations team, or a failed read)', () => {
    const out = dashboard(readOf([]), [])
    assert.equal(out.includes('data-new'), false)
    assert.equal(out.includes('New update'), false)
    assert.match(out, /Antera Restro/, 'the list itself is unchanged')
  })
})

describe('Changes to review', () => {
  const card = (back: string[]) => renderToStaticMarkup(
    createElement(AppRouterContext.Provider, { value: router as never },
      createElement(ChangesToReview, { items: readOf([pendingChange]).pending, backWithOps: new Set(back), supabase, onAnswered() {}, readOnlyReason: null })),
  )

  test('a revised PI that came back carries the tag right after its version', () => {
    const out = card(['o543'])
    assert.match(out, /PI V2<\/span><span class="ops-new">/)
    assert.match(out, /New update/)
  })

  test('without the mark the card is as before', () => {
    const out = card([])
    assert.equal(out.includes('New update'), false)
    assert.match(out, /PI V2/)
  })
})
