// Quotations › Requests: Pending and Completed (owner, 18 Nov 2026).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { requestTabs } from './requestTabs'
import type { Task } from '@/lib/types'

const t = (id: string, status: string, created_at: string, last_update_at: string | null = null, extra: Partial<Task> = {}) =>
  ({ id, status, created_at, last_update_at, customer_name: id, company_name: null, city_project: null, title: `Quotation - ${id}`, note: null, ...extra }) as unknown as Task

describe('requestTabs', () => {
  const rows = [
    t('new', 'working', '2026-11-18T08:00:00Z'),
    t('old', 'waiting', '2026-11-10T08:00:00Z'),
    t('sent-early', 'completed', '2026-11-01T08:00:00Z', '2026-11-05T08:00:00Z'),
    t('sent-late', 'completed', '2026-11-02T08:00:00Z', '2026-11-17T08:00:00Z'),
    t('dropped', 'cancelled', '2026-11-03T08:00:00Z'),
  ]
  test('pending is longest-waiting first; completed is newest first; a cancelled request is in neither', () => {
    const tabs = requestTabs(rows, '')
    assert.deepEqual(tabs.pending.map(x => x.id), ['old', 'new'])
    assert.deepEqual(tabs.completed.map(x => x.id), ['sent-late', 'sent-early'])
  })
  test('the search covers the lead, company, project and note, in both tabs', () => {
    const more = [...rows, t('x', 'working', '2026-11-18T09:00:00Z', null, { company_name: 'Babylon Resort' })]
    assert.deepEqual(requestTabs(more, 'babylon').pending.map(x => x.id), ['x'])
    assert.deepEqual(requestTabs(more, 'sent-late').completed.map(x => x.id), ['sent-late'])
  })
})

describe('the screens', () => {
  const read = (p: string) => readFileSync(p, 'utf8')
  test('the Requests page reads the same list as Tasks, the owner every request, and opens a request in Tasks', () => {
    const screen = read('src/components/quotations/RequestsScreen.tsx')
    assert.ok(screen.includes('useQuotationRequests(userId, ready && caps.canViewQuotations, caps.canSeeAllQuotations)'))
    assert.ok(screen.includes('router.push(taskDetailHref(t.id, HERE))'))
    assert.ok(read('src/components/layout/QuotationsLayout.tsx').includes("label: 'Requests'"))
    assert.ok(read('src/app/quotations/requests/page.tsx').includes('<RequestsScreen />'))
  })
  test('the request form tells the person it was sent to, after the files', () => {
    const form = read('src/app/tasks/quotation-requests/new/page.tsx')
    const files = form.indexOf("from('task_attachments').insert(")
    const tell = form.indexOf('await requestAssignmentNotification(task.id)')
    assert.ok(files > 0 && tell > files)
  })
})
