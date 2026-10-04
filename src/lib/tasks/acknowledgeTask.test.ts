import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  acknowledgeTask, acknowledgeMessage, adoptableAck, shouldAnnounceAck, postAcknowledgedNotice,
  ACK_WRITE_TIMEOUT_MS, type AcknowledgeOutcome,
} from './acknowledgeTask'

const TASK = { id: 'task-1', status: 'pending', created_at: '2027-03-01T08:00:00Z', last_update_at: '2027-03-01T09:00:00Z' }
const REQ = { task: TASK, actorId: 'user-a' }

type Answer = { data: unknown; error: { message: string; code?: string | null } | null }

/** A Supabase stand-in that records every call. `rpc` is what the mutation answers; `taskRow`/`logRows` are the read-back. */
function fake(opts: {
  rpc: () => Promise<Answer>
  taskRow?: Answer
  logRows?: Answer
}) {
  const calls = { rpc: [] as { name: string; args: unknown }[], signals: [] as AbortSignal[], reads: [] as string[], writes: 0 }
  const builder = (table: string, answer: Answer) => {
    const b: Record<string, unknown> = {
      select: () => b, eq: () => b, gt: () => b, limit: () => b,
      abortSignal: (s: AbortSignal) => { calls.signals.push(s); return b },
      single: () => { calls.reads.push(table); return Promise.resolve(answer) },
      then: (ok: (v: Answer) => unknown, bad: (e: unknown) => unknown) => { calls.reads.push(table); return Promise.resolve(answer).then(ok, bad) },
    }
    return b
  }
  const client = {
    rpc: (name: string, args: unknown) => {
      calls.rpc.push({ name, args })
      return { abortSignal: (s: AbortSignal) => { calls.signals.push(s); return opts.rpc() } }
    },
    from: (table: string) => {
      if (table === 'tasks') return builder(table, opts.taskRow ?? { data: null, error: { message: 'no read' } })
      return builder(table, opts.logRows ?? { data: null, error: { message: 'no read' } })
    },
  }
  return { client: client as unknown as SupabaseClient, calls }
}

const answered = (data: unknown): Answer => ({ data, error: null })
const failed = (message: string, code: string | null = null): Answer => ({ data: null, error: { message, code } })
const NO_WAIT = { recheckMs: 0 }

test('an answered call is the only success, and it carries the database\'s state and both history ids', async () => {
  const { client, calls } = fake({
    rpc: async () => answered({
      id: 'task-1', status: 'working', from_status: 'pending',
      acknowledged_at: '2027-03-02T10:00:00Z', last_update_at: '2027-03-02T10:00:00Z',
      acknowledged_log_id: 'log-ack', status_changed_log_id: 'log-status',
    }),
  })
  const out = await acknowledgeTask(client, REQ, NO_WAIT)
  assert.equal(out.kind, 'saved')
  if (out.kind !== 'saved') return
  assert.deepEqual(out.change.state, { acknowledged_at: '2027-03-02T10:00:00Z', status: 'working', last_update_at: '2027-03-02T10:00:00Z' })
  assert.equal(out.change.fromStatus, 'pending')
  assert.equal(out.change.acknowledgedLogId, 'log-ack')
  assert.equal(out.change.statusChangedLogId, 'log-status')
  assert.deepEqual(calls.rpc, [{ name: 'acknowledge_task', args: { p_task_id: 'task-1' } }])
  assert.equal(acknowledgeMessage(out), null)
  assert.equal(shouldAnnounceAck(out), true)
  assert.ok(adoptableAck(out))
  assert.equal(calls.reads.length, 0, 'a clean answer needs no read-back')
})

test('the task id is the ONLY thing sent: no actor, time or status comes from the browser', async () => {
  const { client, calls } = fake({ rpc: async () => answered({}) })
  await acknowledgeTask(client, { task: TASK, actorId: 'user-a' }, NO_WAIT)
  assert.deepEqual(Object.keys(calls.rpc[0].args as object), ['p_task_id'])
})

test('the mutation runs under exactly one 30 s abort', async () => {
  const { client, calls } = fake({ rpc: async () => answered({}) })
  await acknowledgeTask(client, REQ, NO_WAIT)
  assert.equal(ACK_WRITE_TIMEOUT_MS, 30_000)
  assert.equal(calls.signals.length, 1)
  assert.equal(calls.signals[0].aborted, false)
})

test('a refusal the database meant is shown as written, changes nothing, and is not reconciled', async () => {
  for (const [code, text] of [
    ['42501', 'TASK_ACK_FORBIDDEN: Only the person this task is assigned to can acknowledge it'],
    ['42501', 'TASK_ACK_NOT_APPLICABLE: A quotation request is not acknowledged'],
    ['P0002', 'TASK_NOT_FOUND: That task no longer exists'],
    ['28000', 'Authentication required to acknowledge a task'],
  ] as const) {
    const { client, calls } = fake({ rpc: async () => failed(text, code) })
    const out = await acknowledgeTask(client, REQ, NO_WAIT)
    assert.equal(out.kind, 'refused')
    if (out.kind !== 'refused') return
    assert.equal(out.code, code)
    assert.ok(!out.message.includes('TASK_ACK_') && !out.message.includes('TASK_NOT_FOUND'), 'the code prefix is not shown')
    assert.equal(calls.reads.length, 0)
    assert.equal(adoptableAck(out), null)
    assert.equal(shouldAnnounceAck(out), false)
    assert.equal(acknowledgeMessage(out), out.message)
  }
})

test('a wrong-state refusal (already acknowledged) is reconciled first: our own row means the earlier send landed', async () => {
  const { client, calls } = fake({
    rpc: async () => failed('TASK_ALREADY_ACKNOWLEDGED: This task has already been acknowledged', '55000'),
    taskRow: answered({ acknowledged_at: '2027-03-02T10:00:00Z', status: 'working', last_update_at: '2027-03-02T10:00:00Z' }),
    logRows: answered([{ id: 'log-ack' }]),
  })
  const out = await acknowledgeTask(client, REQ, NO_WAIT)
  assert.equal(out.kind, 'own_action_found')
  assert.equal(calls.rpc.length, 1, 'the mutation is never sent a second time')
  assert.equal(shouldAnnounceAck(out), true)
  assert.ok(adoptableAck(out))
  assert.match(acknowledgeMessage(out) ?? '', /not treated as confirmed/)
})

test('a wrong-state refusal with no row of ours is state_changed: adopted, reported, never claimed, never announced', async () => {
  for (const logRows of [answered([]), answered([{ id: 'a' }, { id: 'b' }])]) {
    const { client } = fake({
      rpc: async () => failed('TASK_ALREADY_ACKNOWLEDGED: This task has already been acknowledged', '55000'),
      taskRow: answered({ acknowledged_at: '2027-03-02T10:00:00Z', status: 'working', last_update_at: '2027-03-02T10:00:00Z' }),
      logRows,
    })
    const out = await acknowledgeTask(client, REQ, NO_WAIT)
    assert.equal(out.kind, 'state_changed')
    assert.equal(shouldAnnounceAck(out), false)
    assert.ok(adoptableAck(out))
    assert.ok(acknowledgeMessage(out))
  }
})

test('a wrong-state refusal on a task that is still unacknowledged (finished / in review) is shown as the refusal it is', async () => {
  const { client, calls } = fake({
    rpc: async () => failed('TASK_ACK_WRONG_STATUS: A completed task cannot be acknowledged', '55000'),
    taskRow: answered({ acknowledged_at: null, status: 'completed', last_update_at: '2027-03-01T09:00:00Z' }),
    logRows: answered([]),
  })
  const out = await acknowledgeTask(client, REQ, NO_WAIT)
  assert.equal(out.kind, 'refused')
  if (out.kind === 'refused') assert.equal(out.message, 'A completed task cannot be acknowledged')
  assert.equal(calls.rpc.length, 1)
})

test('a lost answer (no database code) is read back: our row means own_action_found, never "saved"', async () => {
  const { client, calls } = fake({
    rpc: async () => { throw new Error('network down') },
    taskRow: answered({ acknowledged_at: '2027-03-02T10:00:00Z', status: 'working', last_update_at: '2027-03-02T10:00:00Z' }),
    logRows: answered([{ id: 'log-ack' }]),
  })
  const out = await acknowledgeTask(client, REQ, NO_WAIT)
  assert.equal(out.kind, 'own_action_found')
  assert.notEqual(out.kind, 'saved')
  assert.equal(calls.rpc.length, 1, 'never auto-resent')
  assert.deepEqual(calls.reads.sort(), ['task_activity_log', 'tasks'])
})

test('a lost answer with nothing saved is not_saved; an unreadable read-back is unknown — neither claims anything or resends', async () => {
  const none = fake({
    rpc: async () => failed('fetch failed'),
    taskRow: answered({ acknowledged_at: null, status: 'pending', last_update_at: '2027-03-01T09:00:00Z' }),
    logRows: answered([]),
  })
  const a = await acknowledgeTask(none.client, REQ, NO_WAIT)
  assert.equal(a.kind, 'not_saved')
  assert.equal(none.calls.rpc.length, 1)
  assert.equal(adoptableAck(a), null)
  assert.equal(shouldAnnounceAck(a), false)

  const blind = fake({ rpc: async () => failed('fetch failed') })
  const b = await acknowledgeTask(blind.client, REQ, NO_WAIT)
  assert.equal(b.kind, 'unknown')
  assert.equal(blind.calls.rpc.length, 1)
  assert.equal(adoptableAck(b), null)
  assert.equal(shouldAnnounceAck(b), false)
  assert.match(acknowledgeMessage(b) ?? '', /could not confirm/)
})

test('a read-back that finds nothing looks once more before saying so (reads only)', async () => {
  let reads = 0
  const { client, calls } = fake({
    rpc: async () => failed('fetch failed'),
    taskRow: answered({ acknowledged_at: null, status: 'pending', last_update_at: null }),
    logRows: answered([]),
  })
  const origFrom = (client as unknown as { from: (t: string) => unknown }).from
  ;(client as unknown as { from: (t: string) => unknown }).from = (t: string) => { reads++; return origFrom(t) }
  const out = await acknowledgeTask(client, REQ, { recheckMs: 1 })
  assert.equal(out.kind, 'not_saved')
  assert.equal(reads, 4, 'two reads, twice')
  assert.equal(calls.rpc.length, 1)
})

test('every outcome has an honest message; only saved has none', () => {
  const outcomes: AcknowledgeOutcome[] = [
    { kind: 'refused', message: '', code: '42501' },
    { kind: 'own_action_found', state: { acknowledged_at: 'x', status: 'working', last_update_at: 'x' } },
    { kind: 'state_changed', state: { acknowledged_at: 'x', status: 'working', last_update_at: 'x' } },
    { kind: 'not_saved' },
    { kind: 'unknown' },
  ]
  for (const o of outcomes) assert.ok(acknowledgeMessage(o), o.kind)
  // Nothing short of an answer is ever phrased as a success.
  for (const o of outcomes) assert.doesNotMatch(acknowledgeMessage(o) ?? '', /\b(success|succeeded|acknowledged successfully)\b/i)
})

test('the creator\'s notice is sent exactly as before: acknowledged, to the creator, never to yourself, failures only logged', async () => {
  const sent: { url: string; init: RequestInit }[] = []
  const post = (async (url: string, init: RequestInit) => { sent.push({ url, init }); return { ok: true, json: async () => ({}) } }) as unknown as typeof fetch
  postAcknowledgedNotice({ taskId: 't', taskTitle: 'Title', createdBy: 'boss', actorId: 'me', actorName: 'Me' }, 'tag', post)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].url, '/api/notify-status-update')
  assert.equal(sent[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(String(sent[0].init.body)), { taskId: 't', taskTitle: 'Title', createdBy: 'boss', action: 'acknowledged', actorName: 'Me' })

  postAcknowledgedNotice({ taskId: 't', taskTitle: 'Title', createdBy: 'me', actorId: 'me' }, 'tag', post)
  postAcknowledgedNotice({ taskId: 't', taskTitle: 'Title', createdBy: null, actorId: 'me' }, 'tag', post)
  assert.equal(sent.length, 1, 'no notice for a self task or a task with no creator')

  const boom = (async () => { throw new Error('offline') }) as unknown as typeof fetch
  assert.doesNotThrow(() => postAcknowledgedNotice({ taskId: 't', taskTitle: 'T', createdBy: 'boss', actorId: 'me' }, 'tag', boom))
  await new Promise(r => setTimeout(r, 5))
})
