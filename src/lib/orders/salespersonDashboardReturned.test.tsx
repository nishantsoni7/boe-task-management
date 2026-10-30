// PIs RETURNED TO SALES / CLOSED: what the page parses, the one definition the
// dashboard and the Modules card share (20270507000000), the short notice
// (20270509000000) and the badge that tells its outcomes apart.
//
// The database half is executed SQL, proven on PGlite by
// supabase/tests/sales_dashboard_returned_pis_pglite.mjs (old and new answers on
// the same rows) and on real rows by sales_dashboard_rehearsal_footer.sql.

/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures stand in for an untyped RPC payload and a notification row */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSalespersonDashboard, type SalespersonDashboard } from './salespersonDashboard'
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

describe('parsing', () => {
  test('an answer from a database without the lists means none, not an error', () => {
    const d = parsed(base())
    assert.equal(d.returnedTotal, 0)
    assert.equal(d.rejectedTotal, 0)
  })

  test('returned and rejected are read with reviewer and age', () => {
    const d = parsed(base({ returned_total: 1, returned: [row()], rejected_total: 1, rejected: [row({ submission_id: 'sub-10' })] }))
    assert.equal(d.returned[0].byName, 'Nishant Soni')
    assert.equal(d.returned[0].sinceSeconds, 7200)
    assert.equal(d.rejected[0].submissionId, 'sub-10')
  })

  test('a total that disagrees with its list is refused', () => {
    assert.equal(parseSalespersonDashboard(base({ returned_total: 2, returned: [row()] })).ok, false)
    assert.equal(parseSalespersonDashboard(base({ rejected_total: 0, rejected: [row()] })).ok, false)
  })

  test('the pending number is not touched by returned or rejected', () => {
    assert.equal(parsed(base({ returned_total: 1, returned: [row()] })).pendingTotal, 0)
  })
})

describe('the notification badge', () => {
  const n = (title: string) => ({ id: 'n1', type: 'pi_review_decided', title, entity_id: 'sub-9', task_id: null } as any)

  test('the one-line notice since 20270509000000: amber "Returned to Sales" and red "Closed: deal lost"', () => {
    const returned = getNotificationMeta(n('PID-00021 · IBC was returned to you by Nishant Soni.'))
    assert.equal(returned.badge.label, 'Returned to Sales')
    assert.equal(returned.href, '/orders/drafts/sub-9')
    assert.equal(getNotificationMeta(n('The PI for IBC was returned to you.')).badge.label, 'Returned to Sales')
    assert.equal(getNotificationMeta(n('PID-00019 · Studio Arc was closed (deal lost) by Nishant Soni.')).badge.label, 'Closed: deal lost')
  })

  test('notices written before keep their badges: amber "Changes requested", red "Rejected"', () => {
    assert.equal(getNotificationMeta(n('Changes were requested on the PI for Hotel Surya Garden by Nishant.')).badge.label, 'Changes requested')
    assert.equal(getNotificationMeta(n('The PI for Hotel Surya Garden was rejected by Nishant.')).badge.label, 'Rejected')
  })

  test('a client whose name contains "returned" does not change the badge of a closed PI', () => {
    assert.equal(getNotificationMeta(n('PID-00030 · Returned Goods Co was closed (deal lost) by Nishant Soni.')).badge.label, 'Closed: deal lost')
  })
})

describe('the migrations', () => {
  const dir = join(process.cwd(), 'supabase', 'migrations')
  const sql = (f: string) => readFileSync(join(dir, f), 'utf8').replace(/\r/g, '')
  const rule = sql('20270507000000_returned_pis_for_sales.sql')
  const dash = sql('20270508000000_salesperson_dashboard_last_month.sql')
  const notify = sql('20270509000000_pi_review_notice_short.sql')
  const code = (s: string) => s.replace(/^\s*--.*$/gm, '')

  test('one definition of "returned to you": salesperson, creator or submitter; needs_changes; not being deleted', () => {
    assert.match(rule, /\(s\.salesperson_id = p_user or s\.submitted_by = p_user or s\.created_by = p_user\)/)
    assert.match(rule, /and s\.status = 'needs_changes'\s+and s\.deletion_claim_token is null/)
    assert.match(rule, /revoke all on function public\.order_submissions_returned_to\(uuid\) from public, anon, authenticated;/)
  })

  test('the dashboard and the Modules card both read it; the card never sends the note', () => {
    assert.match(code(dash), /from public\.order_submissions_returned_to\(v_actor\) t/)
    assert.doesNotMatch(code(dash), /s\.status = 'needs_changes'/, 'the dashboard no longer states the rule itself')
    const card = /create or replace function public\.my_returned_pis\(\)[\s\S]*?\n\$\$;/.exec(rule)?.[0] ?? ''
    assert.match(card, /from public\.order_submissions_returned_to\(v_actor\) r/)
    assert.doesNotMatch(card, /review_note|'note'/)
    assert.match(card, /if not public\.module_entry_open\('orders'\) then\s+return '\[\]'::jsonb;/)
  })

  test('the notice: same people, same type, one line, no note', () => {
    assert.match(notify, /array\[new\.submitted_by, new\.created_by, new\.salesperson_id\], v_actor, new\.id, 'pi_review_decided'/)
    assert.match(notify, /'%s was returned to you%s\.'/)
    assert.match(notify, /'%s was closed \(deal lost\)%s\.'/)
    assert.doesNotMatch(code(notify), /new\.review_note/)
  })

  test('the badge reads the words the notice writes', () => {
    const meta = readFileSync(join(process.cwd(), 'src/lib/notificationMeta.ts'), 'utf8')
    assert.match(meta, /was returned to you/)
    assert.match(meta, /was closed \\\(deal lost\\\)/)
  })

  test('"pending" keeps its original rule', () => {
    assert.match(dash, /where s\.salesperson_id = v_actor\s+and s\.status = 'submitted'/)
  })
})
