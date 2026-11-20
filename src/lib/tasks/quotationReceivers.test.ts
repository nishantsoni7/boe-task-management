// A quotation request goes to the owner or Nitish, picked on the form and remembered (owner, 18 Nov 2026; 20270804000000).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initialReceiver, receiverRefusal, type Receiver } from './quotationReceivers'
import { applyQuotationFilters, EMPTY_FILTERS, filtersActive, sentToOptions } from '@/app/tasks/quotation-requests/filters'
import type { Task } from '@/lib/types'

const OWNER: Receiver = { id: 'owner', full_name: 'Nishant Soni' }
const NITISH: Receiver = { id: 'nitish', full_name: 'Nitish Bansal' }

describe('who the form starts on', () => {
  test('the remembered person while they still receive requests', () => {
    assert.equal(initialReceiver([OWNER, NITISH], 'nitish'), 'nitish')
  })
  test('nobody when nothing is remembered, or the remembered person no longer receives requests: the salesperson must pick', () => {
    assert.equal(initialReceiver([OWNER, NITISH], null), '')
    assert.equal(initialReceiver([OWNER, NITISH], 'somebody-else'), '')
  })
  test('the only receiver when there is one', () => {
    assert.equal(initialReceiver([OWNER], null), 'owner')
  })
  test("the database's refusal is said in words; any other error is left alone", () => {
    assert.match(receiverRefusal('QUOTATION_REQUEST_RECEIVER: a quotation request can only be sent to …') ?? '', /no longer receives/)
    assert.equal(receiverRefusal('network down'), null)
  })
})

describe('the owner filters by who a request was sent to', () => {
  const t = (id: string, assigned_to: string) => ({ id, assigned_to, created_by: 'sales', priority: 'medium', created_at: '2026-11-18T00:00:00Z', customer_name: id, title: id, note: null }) as unknown as Task
  const tasks = [t('a', 'owner'), t('b', 'nitish'), t('c', 'nitish')]
  test('Sent to narrows to that person; Everyone keeps all', () => {
    assert.deepEqual(applyQuotationFilters(tasks, { ...EMPTY_FILTERS, sentTo: 'nitish' }).map(x => x.id), ['b', 'c'])
    assert.equal(applyQuotationFilters(tasks, EMPTY_FILTERS).length, 3)
    assert.equal(filtersActive({ ...EMPTY_FILTERS, sentTo: 'nitish' }), true)
  })
  test('the options are the people in the tab, by name', () => {
    assert.deepEqual(sentToOptions(tasks, { owner: 'Nishant Soni', nitish: 'Nitish Bansal' }), [
      { id: 'owner', name: 'Nishant Soni' }, { id: 'nitish', name: 'Nitish Bansal' },
    ])
  })
})

describe('the screens and the database agree', () => {
  const read = (p: string) => readFileSync(p, 'utf8')
  test('the old form is gone: it redirects, and the receiver helpers remain', () => {
    assert.ok(read('src/app/tasks/quotation-requests/new/page.tsx').includes("redirect('/quotations?new=1')"))
    const helpers = read('src/lib/tasks/quotationReceivers.ts')
    assert.ok(helpers.includes('export function rememberReceiver('))
    assert.ok(!/@[a-z0-9.-]+\.(com|in)'/i.test(helpers), 'no email address in the helpers')
  })
  test('the owner reads every request; everybody else their own', () => {
    const page = read('src/components/quotations/RequestsScreen.tsx')
    const hook = read('src/hooks/queries/useQuotationRequests.ts')
    assert.ok(page.includes("useQuotationRequests(userId, ready && caps.canViewQuotations && tab === 'earlier', caps.canSeeAllQuotations)"))
    assert.ok(hook.includes('(seeAll ? base : base.or(`assigned_to.eq.${userId},created_by.eq.${userId}`))'))
  })
  test('the migration: protected action, receivers, guard, admin read on the three tables, Nitish\'s six grants, self-checks', () => {
    const sql = read('supabase/migrations/20270804000000_quotation_request_receivers.sql')
    assert.match(sql, /values \('receive_quotations', 'Receive Quotation Requests', false\)/)
    assert.match(sql, /select pm\.id, pa\.id, false\s+from public\.permission_modules pm\s+join public\.permission_actions pa on pa\.action_key = 'receive_quotations'/)
    assert.ok(!/insert into public\.role_permissions/.test(sql), 'no role default')
    assert.match(sql, /before insert or update of assigned_to, task_type on public\.tasks/)
    for (const table of ['tasks', 'task_activity_log', 'task_attachments']) {
      assert.match(sql, new RegExp(`create policy ${table}_quotation_requests_admin_read on public\\.${table}\\s+for select to authenticated`))
    }
    for (const grant of ["'task_management', 'view_quotations'", "'task_management', 'receive_quotations'", "'quotations',      'view'", "'quotations',      'create'", "'quotations',      'edit'", "'quotations',      'view_all'"]) {
      assert.ok(sql.includes(grant), grant)
    }
    assert.match(sql, /revoke all on function public\.quotation_request_receivers\(\) from public, anon;/)
    assert.match(sql, /open request\(s\) are assigned to a non-receiver/)
  })
})
