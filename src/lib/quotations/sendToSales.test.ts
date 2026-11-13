import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import { QUOTATION_SENT_MARKER, isQuotationSentEntry } from '@/lib/tasks/quotationSend'
import { sendToSales, sentNote } from './sendToSales'

const TASK = { id: 't1', status: 'in_progress', created_by: 'sales-1', assigned_to: 'team-1', created_at: '2026-11-13T04:00:00Z', last_update_at: null }

/** A stand-in for the browser client: records every call, answers like the database. */
function fakeClient(opts: { insertError?: boolean; rpcError?: boolean } = {}) {
  const calls: { kind: string; table?: string; fn?: string; body: Record<string, unknown> }[] = []
  const client = {
    from: (table: string) => ({ insert: async (body: Record<string, unknown>) => { calls.push({ kind: 'insert', table, body }); return { error: opts.insertError ? { message: 'denied' } : null } } }),
    rpc: (fn: string, body: Record<string, unknown>) => {
      calls.push({ kind: 'rpc', fn, body })
      const answer = opts.rpcError ? { data: null, error: { message: 'TASK_STATUS_FORBIDDEN: no', code: '42501' } }
        : { data: { status: 'completed', completed_at: '2026-11-13T05:00:00Z', activity_log_id: 'ev-1' }, error: null }
      return { abortSignal: () => Promise.resolve(answer) }
    },
  }
  return { client: client as unknown as SupabaseClient, calls }
}

describe('Send to sales', () => {
  test('the update reads like the request page\'s and links the quotation', () => {
    assert.equal(sentNote('QT-MS-01042', 2, 'https://boeone.vercel.app/quotations/abc', ' Teak as asked '),
      'Quotation QT-MS-01042 v2 is ready in BOE One: https://boeone.vercel.app/quotations/abc\nTeak as asked')
    assert.equal(sentNote('QT-MS-01042', null, 'u', null), 'Quotation QT-MS-01042 is ready in BOE One: u')
  })

  test('posts the sent-quotation update, completes the request through change_task_status, then tells the salesperson', async () => {
    const { client, calls } = fakeClient()
    const notices: Record<string, unknown>[] = []
    const res = await sendToSales(client, { task: TASK, actorId: 'team-1', quoteNo: 'QT-MS-01042', versionNo: null, url: 'u', note: null, post: async b => { notices.push(b); return { status: 200, json: {} } } })
    assert.deepEqual(res, { ok: true })
    assert.deepEqual(calls.map(c => c.kind === 'insert' ? `insert ${c.table}` : `rpc ${c.fn}`), ['insert task_activity_log', 'rpc change_task_status'])
    const update = calls[0].body
    assert.equal(update.new_val, QUOTATION_SENT_MARKER)
    assert.ok(isQuotationSentEntry({ action: String(update.action), new_val: String(update.new_val) }), 'the request page sees it as the sent quotation')
    assert.equal(calls[1].body.p_status, 'completed')
    assert.deepEqual(notices, [{ taskId: 't1', recipientId: 'sales-1', action: 'completed', activityLogId: 'ev-1' }])
  })

  test('nothing more happens when the update cannot be posted; a refused completion is said plainly', async () => {
    const a = fakeClient({ insertError: true })
    assert.equal((await sendToSales(a.client, { task: TASK, actorId: 'team-1', quoteNo: 'Q', versionNo: null, url: 'u', note: null })).ok, false)
    assert.equal(a.calls.length, 1)
    const b = fakeClient({ rpcError: true })
    const res = await sendToSales(b.client, { task: TASK, actorId: 'team-1', quoteNo: 'Q', versionNo: null, url: 'u', note: null, post: async () => ({ status: 200, json: {} }) })
    assert.equal(res.ok, false)
    assert.match((res as { error: string }).error, /could not be marked complete/)
  })
})
