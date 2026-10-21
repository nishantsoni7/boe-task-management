// PIs SENT BACK FOR CHANGES / REJECTED on the salesperson's dashboard (20270328000200),
// and the notification badge that tells the two apart.
//
// The database half (the lists, the 7-day rejected window, ownership) is executed SQL and
// is proved by the migration's own rehearsal; these tests pin the page's half: parsing,
// the counts being separate from "pending", and what the salesperson reads.

/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures stand in for an untyped RPC payload and a notification row */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseSalespersonDashboard, decidedAgoText, type SalespersonDashboard } from './salespersonDashboard'
import { SalespersonDashboardView } from '@/components/orders/dashboard/SalespersonDashboardView'
import { getNotificationMeta } from '@/lib/notificationMeta'

const row = (over: Record<string, unknown> = {}) => ({
  submission_id: 'sub-9', reference: 'PID-00017', client_name: 'Hotel Surya Garden',
  note: 'Discount line wording does not match the workbook.', by_name: 'Nishant Soni',
  since: '2026-10-21T08:00:00Z', waiting_seconds: 2 * 3600, can_open: true, ...over,
})

function base(over: Record<string, unknown> = {}): any {
  return {
    applicable: true, today: '2026-10-21', now: '2026-10-21T10:00:00Z', month_from: '2026-10-01',
    total_orders: 3, revenue: { amount: 0, orders: 0, no_product_value: 0, before_discount: 0 },
    pending_total: 0, pending: [], advance: [], advance_unchecked: [], fabric_finish: [],
    fabric_finish_unknown: [], ready_for_dispatch: [], ...over,
  }
}

function parsed(raw: unknown): SalespersonDashboard {
  const r = parseSalespersonDashboard(raw)
  assert.ok(r.ok && r.applicable)
  return r.dashboard
}
const html = (d: SalespersonDashboard) => renderToStaticMarkup(createElement(SalespersonDashboardView, { data: d }))

describe('parsing', () => {
  test('an answer from a database without the new lists means none, not an error', () => {
    const d = parsed(base())
    assert.equal(d.returnedTotal, 0)
    assert.equal(d.rejectedTotal, 0)
  })

  test('returned and rejected are read with note, reviewer and age', () => {
    const d = parsed(base({ returned_total: 1, returned: [row()], rejected_total: 1, rejected: [row({ submission_id: 'sub-10' })] }))
    assert.equal(d.returned[0].note, 'Discount line wording does not match the workbook.')
    assert.equal(d.returned[0].byName, 'Nishant Soni')
    assert.equal(d.returned[0].sinceSeconds, 7200)
    assert.equal(d.rejected[0].submissionId, 'sub-10')
  })

  test('a total that disagrees with its list is refused', () => {
    assert.equal(parseSalespersonDashboard(base({ returned_total: 2, returned: [row()] })).ok, false)
    assert.equal(parseSalespersonDashboard(base({ rejected_total: 0, rejected: [row()] })).ok, false)
  })

  test('the pending number is not touched by returned or rejected', () => {
    const d = parsed(base({ returned_total: 1, returned: [row()] }))
    assert.equal(d.pendingTotal, 0)
  })
})

describe('the page', () => {
  test('nothing sent back or rejected: no attention block, both counts still shown as 0', () => {
    const out = html(parsed(base()))
    assert.ok(!out.includes('Needs your attention'))
    assert.ok(out.includes('Sent Back for Changes'))
    assert.ok(out.includes('Orders Pending Approval'))
  })

  test('a sent-back PI leads the page with the reviewer note and a link to the PI', () => {
    const out = html(parsed(base({ returned_total: 1, returned: [row()] })))
    assert.ok(out.indexOf('Needs your attention') < out.indexOf('Total Orders'))
    assert.ok(out.includes('Changes requested'))
    assert.ok(out.includes('Discount line wording does not match the workbook.'))
    assert.ok(out.includes('Sent back by Nishant Soni 2 h ago'))
    assert.ok(out.includes('/orders/drafts/sub-9'))
  })

  test('a rejected PI is its own group, drawn as rejected', () => {
    const out = html(parsed(base({ rejected_total: 1, rejected: [row({ note: null })] })))
    assert.ok(out.includes('Rejected'))
    assert.ok(out.includes('No note was left.'))
    assert.ok(!out.includes('Edit and resubmit</p>') || out.includes('Sent Back for Changes'))
  })

  test('a PI the reader cannot open is plain text, never a link', () => {
    const out = html(parsed(base({ returned_total: 1, returned: [row({ can_open: false })] })))
    assert.ok(!out.includes('/orders/drafts/sub-9'))
  })

  test('elapsed text', () => {
    assert.equal(decidedAgoText('Sent back', 30, null), 'Sent back just now')
    assert.equal(decidedAgoText('Rejected', 3 * 86400 + 5, 'A'), 'Rejected by A 3 days ago')
  })
})

describe('the notification badge', () => {
  const n = (title: string) => ({ id: 'n1', type: 'pi_review_decided', title, entity_id: 'sub-9', task_id: null } as any)

  test('sent back is amber "Changes requested"', () => {
    const m = getNotificationMeta(n('Changes were requested on the PI for Hotel Surya Garden by Nishant.'))
    assert.equal(m.badge.label, 'Changes requested')
    assert.equal(m.href, '/orders/drafts/sub-9')
  })

  test('rejected is red "Rejected"', () => {
    const m = getNotificationMeta(n('The PI for Hotel Surya Garden was rejected by Nishant.'))
    assert.equal(m.badge.label, 'Rejected')
  })
})

describe('the migrations', () => {
  const dir = join(process.cwd(), 'supabase', 'migrations')
  const notify = readFileSync(join(dir, '20270328000100_order_submission_review_notify_salesperson.sql'), 'utf8')
  const dash = readFileSync(join(dir, '20270328000200_order_submission_returned_rejected_dashboard.sql'), 'utf8')

  test('the notice also reaches the salesperson named on the PI', () => {
    assert.match(notify, /array\[new\.submitted_by, new\.created_by, new\.salesperson_id\]/)
  })

  test('the dashboard lists returned PIs and rejected PIs of the last 7 days', () => {
    assert.match(dash, /s\.status = 'needs_changes'/)
    assert.match(dash, /s\.status = 'rejected'/)
    assert.match(dash, /interval '7 days'/)
  })

  test('"pending" keeps its original rule', () => {
    assert.match(dash, /where s\.salesperson_id = v_actor\s+and s\.status = 'submitted'/)
  })
})
