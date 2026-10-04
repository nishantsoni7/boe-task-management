/**
 * changeTaskStatus / sendStatusNotice: what each outcome lets a caller conclude, and that the mutation is sent exactly once.
 * The database side (rollback, permissions, resets, double press) is pinned against real Postgres by
 * supabase/tests/task_change_status_assertions.sql in the change_task_status migration PR.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  changeTaskStatus, statusChangeMessage, adoptableState, sendStatusNotice,
  type NoticePost, type StatusChangeTask,
} from './statusChange'

type Rpc = { data?: unknown; error?: { message: string; code?: string | null } | null; throws?: Error }
type Answer = { data?: unknown; error?: unknown }

function client(rpc: Rpc, reads: Record<string, Answer[]> = {}, counter = { rpc: 0 }): SupabaseClient {
  const next = (table: string): Answer => { const q = reads[table] ?? [{ data: null }]; return (q.length > 1 ? q.shift() : q[0]) as Answer }
  const from = (table: string) => {
    const q: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'gt', 'order', 'limit', 'abortSignal', 'single']) q[m] = () => q
    q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve().then(() => { const a = next(table); return { data: a.data ?? null, error: a.error ?? null } }).then(res, rej)
    return q
  }
  const rpcFn = () => ({
    abortSignal: async () => { counter.rpc++; if (rpc.throws) throw rpc.throws; return { data: rpc.data ?? null, error: rpc.error ?? null } },
  })
  return { from, rpc: rpcFn } as unknown as SupabaseClient
}

const task: StatusChangeTask = { id: 't1', status: 'working', created_by: 'boss', assigned_to: 'me', created_at: '2026-01-01T00:00:00Z', last_update_at: '2026-01-02T00:00:00Z' }
const req = { task, actorId: 'me', status: 'completed' }
const answer = { status: 'completed', completed_at: 'T', last_update_at: 'T2', blocker_reason: null, waiting_on_type: null, waiting_on_user_id: null, waiting_on_text: null, activity_log_id: 'evt-1', from_status: 'working' }

describe('changeTaskStatus outcomes', () => {
  test('an answer is the only success, and it carries the history event the same transaction wrote', async () => {
    const o = await changeTaskStatus(client({ data: answer }), req)
    assert.equal(o.kind, 'saved')
    if (o.kind !== 'saved') return
    assert.equal(o.change.eventId, 'evt-1')
    assert.equal(o.change.saved.status, 'completed')
    assert.equal(statusChangeMessage(o, 'working'), null)
  })

  test('a refusal changes nothing, shows the readable part, and is not reconciled', async () => {
    const calls = { rpc: 0 }
    const o = await changeTaskStatus(client({ error: { message: 'TASK_STATUS_FORBIDDEN: Only the assignee may do this', code: '42501' } }, {}, calls), req)
    assert.equal(o.kind, 'refused')
    if (o.kind === 'refused') assert.equal(o.message, 'Only the assignee may do this')
    assert.equal(adoptableState(o), null)
    assert.equal(calls.rpc, 1)
  })

  test('a lost answer with our row found is own_action_found: state adopted, success NOT claimed', async () => {
    const calls = { rpc: 0 }
    const c = client({ throws: new Error('Failed to fetch') }, { tasks: [{ data: { status: 'completed' } }], task_activity_log: [{ data: [{ id: 'evt-9' }] }] }, calls)
    const o = await changeTaskStatus(c, req)
    assert.equal(o.kind, 'own_action_found')
    if (o.kind === 'own_action_found') assert.equal(o.eventId, 'evt-9')
    assert.equal(calls.rpc, 1, 'the mutation is never resent')
    assert.match(statusChangeMessage(o, 'working') ?? '', /not treated as confirmed/)
  })

  test('a lost answer with nothing saved is not_saved, and says nothing was sent again', async () => {
    const c = client({ throws: new Error('Failed to fetch') }, { tasks: [{ data: { status: 'working' } }], task_activity_log: [{ data: [] }] })
    const o = await changeTaskStatus(c, req)
    assert.equal(o.kind, 'not_saved')
    assert.match(statusChangeMessage(o, 'working') ?? '', /Nothing was sent again/)
  })

  test('a wrong-state refusal (55000) is reconciled before it is shown: our row exists, so it is own_action_found', async () => {
    const c = client({ error: { message: 'TASK_STATUS_INVALID: already completed', code: '55000' } },
      { tasks: [{ data: { status: 'completed' } }], task_activity_log: [{ data: [{ id: 'evt-2' }] }] })
    const o = await changeTaskStatus(c, req)
    assert.equal(o.kind, 'own_action_found')
  })

  test('an unreadable state after a lost answer is unknown and claims nothing', async () => {
    const c = client({ throws: new Error('Failed to fetch') }, { tasks: [{ error: { message: 'offline' } }], task_activity_log: [{ error: { message: 'offline' } }] })
    const o = await changeTaskStatus(c, req)
    assert.ok(o.kind === 'unknown' || o.kind === 'not_saved', o.kind)
    assert.notEqual(o.kind, 'saved')
    assert.equal(adoptableState(o), null)
  })
})

describe('sendStatusNotice', () => {
  const ok = (json: Record<string, unknown> = {}) => async () => ({ status: 200, json })
  const t = { id: 't1', created_by: 'boss', assigned_to: 'me' }

  test('no event, nothing sent — there is never an unlinked status notice', async () => {
    let n = 0
    const post: NoticePost = async () => { n++; return { status: 200, json: {} } }
    assert.equal(await sendStatusNotice(post, { task: t, actorId: 'me', status: 'completed', eventId: null }), 'no_event')
    assert.equal(n, 0)
  })

  test('the body names the OTHER party and the event; a self task announces nothing', async () => {
    let body: Record<string, unknown> = {}
    await sendStatusNotice(async b => { body = b; return { status: 200, json: {} } }, { task: t, actorId: 'me', status: 'completed', eventId: 'e1' })
    assert.deepEqual(body, { taskId: 't1', recipientId: 'boss', action: 'completed', activityLogId: 'e1' })
    assert.equal(await sendStatusNotice(ok(), { task: { id: 't', created_by: 'me', assigned_to: 'me' }, actorId: 'me', status: 'completed', eventId: 'e1' }), 'not_announced')
  })

  test('duplicate and skipped answers are reported as such, not as sent', async () => {
    assert.equal(await sendStatusNotice(ok({ duplicate: true }), { task: t, actorId: 'me', status: 'completed', eventId: 'e1' }), 'already_announced')
    assert.equal(await sendStatusNotice(ok({ skipped: true }), { task: t, actorId: 'me', status: 'completed', eventId: 'e1' }), 'not_announced')
  })

  test('a transport failure is retried once (safe: one notice per event); a 4xx is not retried; two failures report failed', async () => {
    let n = 0
    const flaky: NoticePost = async () => { n++; if (n === 1) throw new Error('reset'); return { status: 200, json: {} } }
    assert.equal(await sendStatusNotice(flaky, { task: t, actorId: 'me', status: 'completed', eventId: 'e1' }, 1), 'sent')
    assert.equal(n, 2)
    n = 0
    assert.equal(await sendStatusNotice(async () => { n++; return { status: 422, json: null } }, { task: t, actorId: 'me', status: 'completed', eventId: 'e1' }, 1), 'refused')
    assert.equal(n, 1)
    n = 0
    assert.equal(await sendStatusNotice(async () => { n++; return { status: 503, json: null } }, { task: t, actorId: 'me', status: 'completed', eventId: 'e1' }, 1), 'failed')
    assert.equal(n, 2)
  })
})

describe('every status caller uses it', () => {
  const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
  test('no status caller writes tasks + history separately any more', () => {
    const detail = read('src/app/tasks/[id]/page.tsx')
    const apply = detail.slice(detail.indexOf('const applyStatusChange = async'), detail.indexOf('const applySavedState'))
    assert.ok(apply.includes('changeTaskStatus('))
    const modal = detail.slice(detail.indexOf("if (modalStatus === 'waiting') {"))
    assert.ok(modal.slice(0, 1500).includes('applyStatusChange('))
    const my = read('src/app/tasks/my/page.tsx')
    const quick = my.slice(my.indexOf('const handleQuickComplete'), my.indexOf('const handleQuickSubmit'))
    assert.ok(quick.includes('changeTaskStatus('))
    for (const body of [apply, quick]) {
      assert.equal(/from\('task_activity_log'\)\.insert/.test(body), false)
      assert.equal(/from\('tasks'\)\.update/.test(body), false)
    }
  })
  test('the mutation is sent once and never auto-resent', () => {
    const src = read('src/lib/tasks/statusChange.ts')
    assert.equal((src.match(/supabase\.rpc\(/g) ?? []).length, 1)
    assert.ok(src.includes('.abortSignal(AbortSignal.timeout(WRITE_TIMEOUT_MS))'))
  })
})
