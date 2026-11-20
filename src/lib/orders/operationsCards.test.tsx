// THE OPERATIONS TEAM'S DASHBOARD IN THE APPROVER'S DESIGN (owner-approved preview, 2026-11-20): which row sits where
// (lib/orders/operationsCards.ts) and what the real OperationsDashboardView draws from it.
//
// Run with: npm run test:file -- src/lib/orders/operationsCards.test.tsx

import '@/lib/testing/cssModuleStub'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { OperationsDashboardView, type OpsHandoffsState } from '@/components/orders/dashboard/OperationsDashboardView'
import {
  APPROVER_FALLBACK,
  changeRow,
  changeSummary,
  handoffInfoByOrder,
  operationsRows,
  type OpsHandoffInfo,
} from './operationsCards'
import { parseOperationsRead, type OperationsRead } from './operationsDashboard'
import type { AlignmentRow, DashboardSummary } from './orderDashboardSummary'
import type { DashboardHandoff } from './operationsHandoff'

const ROOT = join(__dirname, '..', '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r/g, '')
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el)

const period = { from: '2026-09-01', to: '2026-09-30', orders: { count: 1, value: 100 }, dispatches: { count: 1, value: 100 } }

const pendingChange = {
  handoff_id: 'h543', order_id: 'o543', display_number: '543', client_name: 'Hotel Vits Sampling',
  version_number: 2, approved_at: '2026-11-15T08:50:00Z', approved_by_name: 'Nishant Soni', revision_reason: 'Walnut instead of oak',
  changes: { available: true, lines: [
    { key: 'item:LC210', title: 'Lounge chair', kind: 'changed', changes: [{ label: 'Wood', old: 'Oak', new: 'Walnut' }, { label: 'Quantity', old: '40', new: '60' }] },
    { key: 'item:DT100', title: 'Dining table', kind: 'changed', changes: [{ label: 'Size', old: '90', new: '100' }] },
  ] },
}

const payload = (pending: unknown[]) => ({
  today: '2026-11-15',
  viewer: { is_reviewer: true, is_approver: false },
  pending_changes: pending,
  responses: [],
  order_details: [
    { order_id: 'o546', salesperson: 'Mohit Sharma', due_date: '2026-11-28', value: 485000 },
    { order_id: 'o541', salesperson: 'Prerna Singh', due_date: '2026-11-10', value: 660000 },
    { order_id: 'o549', salesperson: 'Ashok Choudhary', due_date: null, value: null },
  ],
  periods: { last_month: period, last_six_months: period, gaps: { dispatched_without_date: 0, orders_without_value: 0, no_confirm_date: 0 } },
})

function readOf(pending: unknown[] = []): OperationsRead {
  const parsed = parseOperationsRead(payload(pending))
  assert.ok(parsed.ok, 'the fixture is a valid read')
  return parsed.read
}

const align = (orderId: string, displayNumber: string, clientName: string, state: string, over: Record<string, unknown> = {}) => ({
  orderId, displayNumber, clientName, state, waitingOn: 'reviewer', since: '2026-11-14T08:00:00Z', waitingSeconds: 0, detail: null, advanceBlocks: false, ...over,
}) as unknown as AlignmentRow

const NOW = Date.parse('2026-11-15T14:00:00Z')

const handoff = (orderId: string, holder: 'sales' | 'coordinator' | 'operations' | null, approver: string | null): DashboardHandoff => ({
  id: `h-${orderId}`, order_id: orderId, status: 'awaiting', assigned_to: null, chain_holder: holder,
  approver: approver ? { full_name: approver } : null,
})
const info = (rows: DashboardHandoff[]): ReadonlyMap<string, OpsHandoffInfo> => handoffInfoByOrder(rows)

const alignment = [
  align('o541', '541', 'Antera Restro', 'awaiting_reviewer'),
  align('o546', '546', 'Dhawal Interiors', 'awaiting_reviewer'),
  align('o549', '549', 'Lotus Lounge', 'clarification_needed', { detail: 'The table top finish is not specified.', since: '2026-11-10T08:00:00Z' }),
  align('o551', '551', 'Cedar Hotel', 'held_advance'),
  align('o552', '552', 'Old Mill', 'no_handoff'),
  align('o553', '553', 'Sunrise Villas', 'accepted_not_aligned'),
  align('o554', '554', 'Nobody Assigned', 'awaiting_unassigned'),
]

describe('which row sits where on the Operations dashboard', () => {
  const rows = (over: Partial<Parameters<typeof operationsRows>[0]> = {}) => operationsRows({
    alignment, pending: readOf([pendingChange]).pending, details: readOf().orderDetails, today: '2026-11-15',
    backWithOps: new Set(['o546']), handoffs: info([handoff('o546', 'operations', 'Nishant Soni'), handoff('o549', 'coordinator', 'Nishant Soni')]), ...over,
  }, NOW)

  test('a first look is a new order; one that came back is a change with "New update"; a flag is watched', () => {
    const r = rows()
    assert.deepEqual(r.groups.new_orders.map(x => x.key), ['new-o541'])
    assert.deepEqual(r.groups.changes.map(x => x.key).sort(), ['back-o546', 'chg-h543'])
    assert.deepEqual(r.watching?.map(x => x.key), ['wait-o549'])
  })

  test('orders waiting on payment, older orders, accepted-not-aligned and unassigned are not on this page', () => {
    const r = rows()
    const all = [...r.groups.new_orders, ...r.groups.changes, ...(r.watching ?? [])].map(x => x.key)
    for (const gone of ['o551', 'o552', 'o553', 'o554']) assert.equal(all.some(k => k.endsWith(gone)), false, gone)
  })

  test('an order is one row: a pending change wins over a reply that came back, which wins over a new order', () => {
    const dup = [...alignment, align('o543', '543', 'Hotel Vits Sampling', 'awaiting_reviewer')]
    const r = rows({ alignment: dup, backWithOps: new Set(['o546', 'o543']) })
    const keys = [...r.groups.new_orders, ...r.groups.changes, ...(r.watching ?? [])].map(x => x.key)
    assert.equal(keys.filter(k => k.endsWith('543')).length, 1)
    assert.ok(keys.includes('chg-h543'))
    assert.equal(new Set(keys).size, keys.length, 'no row twice')
  })

  test('a new order says the due date and how late, and is from its salesperson', () => {
    const [n] = rows().groups.new_orders
    assert.equal(n.order, '#541')
    assert.equal(n.chip?.label, 'Awaiting your review')
    assert.equal(n.chip?.sub, 'Due 10 Nov 2026 · 5 days late')
    assert.deepEqual(n.who, { name: 'Prerna Singh', team: 'sales', caption: 'Sales' })
    assert.equal(n.next, 'Review')
    assert.match(n.href, /^\/orders\/o541\?/)
  })

  test('a reply that came back names who approved the version, and says it is a decision', () => {
    const back = rows().groups.changes.find(x => x.key === 'back-o546')
    assert.equal(back?.chip?.label, 'New update')
    assert.equal(back?.chip?.sub, 'Back after your flag')
    assert.deepEqual(back?.who, { name: 'Nishant Soni', team: 'approver', caption: 'Approver' })
    assert.equal(back?.next, 'Decide')
    const noName = rows({ handoffs: info([handoff('o546', 'operations', null)]) }).groups.changes.find(x => x.key === 'back-o546')
    assert.equal(noName?.who.name, APPROVER_FALLBACK, 'a name that is not on record falls back to the role, never blank')
  })

  test('a revised PI is answered on its row: what changed, the approver who approved it, and how many lines', () => {
    const c = rows().groups.changes.find(x => x.key === 'chg-h543')
    assert.equal(c?.chip?.label, 'Revised PI V2')
    assert.equal(c?.chip?.sub, '2 lines changed · Wood Oak → Walnut, and 2 more')
    assert.deepEqual(c?.who, { name: 'Nishant Soni', team: 'approver', caption: 'Approver' })
    assert.equal(c?.next, 'Answer 2 lines')
    assert.equal(c?.order, '#543')
  })

  test('a flagged PI is with the approver, or with the salesperson once it was sent to Sales, and the ask is Operations\' own words', () => {
    const withApprover = rows().watching?.[0]
    assert.deepEqual(withApprover?.who, { name: 'Nishant Soni', team: 'approver', caption: 'Approver' })
    assert.equal(withApprover?.chip?.sub, '“The table top finish is not specified.”')
    const withSales = rows({ handoffs: info([handoff('o549', 'sales', 'Nishant Soni')]) }).watching?.[0]
    assert.deepEqual(withSales?.who, { name: 'Ashok Choudhary', team: 'sales', caption: 'Sales' })
  })

  test('until it is known who holds the flagged PIs the watching list is null, never an empty list', () => {
    assert.equal(rows({ handoffs: null }).watching, null)
    assert.deepEqual(rows({ handoffs: info([]) }).watching?.map(x => x.key), ['wait-o549'], 'known, but no record: still listed, with the role')
  })

  test('the longest wait is first in each group', () => {
    const two = [align('o1', '1', 'A', 'awaiting_reviewer', { since: '2026-11-15T10:00:00Z' }), align('o2', '2', 'B', 'awaiting_reviewer', { since: '2026-11-13T10:00:00Z' })]
    assert.deepEqual(rows({ alignment: two, pending: [], backWithOps: new Set() }).groups.new_orders.map(x => x.order), ['#2', '#1'])
  })

  test('what changed: the first difference and how many more; a change whose content was not kept says nothing invented', () => {
    assert.equal(changeSummary(readOf([pendingChange]).pending[0]), '2 lines changed · Wood Oak → Walnut, and 2 more')
    assert.equal(changeSummary({ available: false, lines: [] }), null)
    const unavailable = changeRow({ ...readOf([pendingChange]).pending[0], available: false, lines: [] })
    assert.equal(unavailable.next, 'Open')
    assert.equal(unavailable.chip?.sub, 'Walnut instead of oak', 'the approver\'s reason stands in')
  })
})

describe('the Operations dashboard, drawn', () => {
  const summary = { today: '2026-11-15', now: '2026-11-15T14:00:00Z', reviewer: null, notAligned: alignment } as unknown as DashboardSummary
  const supabase = {} as SupabaseClient
  const ready = (rows: DashboardHandoff[]): OpsHandoffsState => ({ kind: 'ready', byOrder: info(rows) })
  const view = (opts: { read?: OperationsRead; back?: string[]; handoffs?: OpsHandoffsState; notAligned?: AlignmentRow[] } = {}) => html(createElement(OperationsDashboardView, {
    summary: { ...summary, notAligned: opts.notAligned ?? alignment } as DashboardSummary,
    read: opts.read ?? readOf([pendingChange]), backWithOps: new Set(opts.back ?? ['o546']),
    handoffs: opts.handoffs ?? ready([handoff('o546', 'operations', 'Nishant Soni'), handoff('o549', 'coordinator', 'Nishant Soni')]),
    supabase, onAnswered() {}, readOnlyReason: null,
  }))

  test('needs your action: new orders, then changes, each with its number and button; watching below', () => {
    const out = view()
    assert.match(out, />Needs your action</)
    assert.ok(out.indexOf('New orders to accept') < out.indexOf('Changes on running orders'))
    assert.match(out, />#541</)
    assert.match(out, /Antera Restro/)
    assert.match(out, /Due 10 Nov 2026 · 5 days late/)
    assert.match(out, /Revised PI V2/)
    assert.match(out, /Answer 2 lines/)
    assert.match(out, /New update/)
    assert.match(out, />Watching</)
    assert.match(out, /Lotus Lounge/)
    assert.match(out, /Held by the approver or Sales/)
  })

  test('a revised-PI row is a button that opens its answer form; the form is closed until it is pressed', () => {
    const out = view()
    assert.match(out, /<button type="button" class="row[^"]*" aria-label="Hotel Vits Sampling[^"]*" aria-expanded="false"/)
    assert.equal(/Send answers/.test(out), false, 'closed: no form')
    assert.equal((out.match(/aria-expanded/g) ?? []).length, 1, 'only the revised PI row opens something; the others are links')
  })

  test('the old page is gone: no tabs, no table, no dispatches, no revenue, no recent answers', () => {
    const out = view()
    for (const gone of ['role="tablist"', 'ops-na-', 'Orders and dispatches', 'Revenue', 'Your recent answers', 'Not aligned for manufacturing', 'Held for advance']) {
      assert.equal(out.includes(gone), false, gone)
    }
  })

  test('empty things are not drawn: no flagged PIs means no Watching heading; nothing at all is one line', () => {
    const calm = view({ read: readOf([]), notAligned: [align('o541', '541', 'Antera Restro', 'awaiting_reviewer')], back: [], handoffs: ready([]) })
    assert.equal(calm.includes('Watching'), false)
    assert.equal(calm.includes('Changes on running orders'), false)
    const none = view({ read: readOf([]), notAligned: [], back: [], handoffs: ready([]) })
    assert.match(none, /Nothing is waiting on you, and nobody is holding anything for you\./)
    assert.equal(/<h2/.test(none), false)
  })

  test('while it is not known who holds the flagged PIs nothing claims "nothing is held"; a failed read says so', () => {
    const loading = view({ handoffs: { kind: 'loading' }, notAligned: [align('o549', '549', 'Lotus Lounge', 'clarification_needed')], read: readOf([]), back: [] })
    assert.equal(/Nothing is waiting/.test(loading), false)
    assert.equal(loading.includes('Watching'), false)
    const failed = view({ handoffs: { kind: 'failed' }, notAligned: [], read: readOf([]), back: [] })
    assert.match(failed, /role="alert"[^>]*>Who holds the PIs you flagged could not be loaded/)
    assert.equal(/Nothing is waiting/.test(failed), false)
  })

  test('the "New update" mark is on the orders that came back, once each, and on nothing else', () => {
    const marked = view({ read: readOf([]), back: ['o546'] })
    assert.equal((marked.match(/New update/g) ?? []).length, 2, 'one order is marked once in its status and once in the text a screen reader hears')
    const none = view({ read: readOf([]), back: [] })
    assert.equal(none.includes('New update'), false)
    assert.match(none, /Dhawal Interiors/, 'without the mark it is a new order, listed all the same')
  })
})

describe('the page and the view are wired the way the owner approved', () => {
  const page = read('src/app/orders/page.tsx')
  const src = read('src/components/orders/dashboard/OperationsDashboardView.tsx')

  test('the approver and the salesperson are named from the read the page already makes, with no new request', () => {
    assert.ok(page.includes('.select(DASHBOARD_HANDOFF_COLUMNS)'))
    assert.ok(page.includes('handoffs={opsHandoffs}'))
    assert.equal((page.match(/from\('order_operations_handoffs'\)/g) ?? []).length, 1, 'still one handoff read')
    assert.match(read('src/lib/orders/operationsHandoff.ts'), /DASHBOARD_HANDOFF_COLUMNS = `\$\{QUEUE_HANDOFF_COLUMNS\}, approver:users!approved_by\(full_name\)`/)
  })

  test('the view uses the approver\'s own pieces and keeps the line-by-line answer form as it was', () => {
    assert.match(src, /import \{ ActionSheet, DecisionRowLink, WatchingSection \} from '\.\/DecisionCards'/)
    assert.match(src, /<PendingChangeCard item=\{item\}/)
    assert.match(src, /supabase\.rpc\('answer_order_pi_changes'/)
    assert.equal(src.includes('RevenueSection'), false)
    assert.equal(src.includes('role="tablist"'), false)
  })
})
