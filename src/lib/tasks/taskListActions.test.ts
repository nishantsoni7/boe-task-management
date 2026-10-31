/**
 * Approve and Cancel from the Assigned By Me row: a refusal is shown, a lost answer
 * is read back and never re-sent, and nothing claims more than the saved row says.
 *
 * Run:
 *   npx tsx --test src/lib/tasks/taskListActions.test.ts
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import { approveTaskFromList, cancelTaskFromList } from './taskListActions'

const TASK = { id: 't1', status: 'pending_approval' as const, created_at: '2026-10-01T00:00:00Z', last_update_at: null }
const ME = 'me'

type RpcAnswer = { error: { message: string; code?: string | null } | null } | 'throw'

/** Only as wide as these two helpers use. `saved` is what a read-back finds. */
function stub(answer: RpcAnswer, saved: { status: string } | 'unreadable', ownRows = 1) {
  const calls = { rpc: 0 }
  const chain = (result: unknown) => {
    const c: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'gt', 'limit', 'abortSignal']) c[m] = () => c
    c.single = () => Promise.resolve(result)
    c.then = (ok: (v: unknown) => unknown) => Promise.resolve(result).then(ok)
    return c
  }
  const client = {
    rpc() {
      calls.rpc++
      return { abortSignal: () => answer === 'throw' ? Promise.reject(new Error('reset')) : Promise.resolve(answer) }
    },
    from(table: string) {
      if (saved === 'unreadable') return chain({ data: null, error: { message: 'no' } })
      return table === 'tasks'
        ? chain({ data: saved, error: null })
        : chain({ data: Array.from({ length: ownRows }, (_, i) => ({ id: `e${i}` })), error: null })
    },
  }
  return { client: client as unknown as SupabaseClient, calls }
}

const realError = console.error
console.error = () => {}
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })
process.on('exit', () => { console.error = realError })

describe('approveTaskFromList', () => {
  test('a clean answer is done', async () => {
    const { client } = stub({ error: null }, { status: 'completed' })
    assert.deepEqual(await approveTaskFromList(client, TASK, ME), { kind: 'done' })
  })

  test('a refusal shows the database\'s own words and changes nothing', async () => {
    const { client, calls } = stub({ error: { message: 'TASK_REVIEW_FORBIDDEN: Only the task creator can approve this task', code: 'P0001' } }, { status: 'pending_approval' })
    assert.deepEqual(await approveTaskFromList(client, TASK, ME), {
      kind: 'stopped', message: 'Only the task creator can approve this task', refresh: false,
    })
    assert.equal(calls.rpc, 1)
  })

  test('a lost answer is read back and never sent again', async () => {
    const { client, calls } = stub('throw', { status: 'pending_approval' }, 0)
    const result = await approveTaskFromList(client, TASK, ME)
    assert.equal(calls.rpc, 1)
    assert.equal(result.kind, 'stopped')
    assert.match((result as { message: string }).message, /Nothing was sent again/)
  })

  test('even a saved change found after a lost answer is not claimed as this request', async () => {
    const { client } = stub('throw', { status: 'completed' })
    const result = await approveTaskFromList(client, TASK, ME)
    assert.equal(result.kind, 'stopped')
    assert.equal((result as { refresh: boolean }).refresh, true)
    assert.match((result as { message: string }).message, /cannot match it to this exact request/)
  })

  test('an unreadable state says so and asks for a look at the task', async () => {
    const { client } = stub('throw', 'unreadable')
    const result = await approveTaskFromList(client, TASK, ME)
    assert.match((result as { message: string }).message, /could not confirm/)
  })

  test('"wrong state" may be a re-send of a write that landed, so it is read back too', async () => {
    const { client } = stub({ error: { message: 'TASK_REVIEW_INVALID_SOURCE: not pending', code: '55000' } }, { status: 'completed' })
    const result = await approveTaskFromList(client, TASK, ME)
    assert.equal((result as { refresh: boolean }).refresh, true)
  })
})

describe('cancelTaskFromList', () => {
  const answer = (status: number, body: unknown) => {
    globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch
  }

  test('a clean answer is done, and the reason goes to the route', async () => {
    let sent: unknown
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const { client } = stub({ error: null }, { status: 'cancelled' })
    assert.deepEqual(await cancelTaskFromList(client, TASK, ME, 'Duplicate task', 'Nishant'), { kind: 'done' })
    assert.deepEqual(sent, { taskId: 't1', reason: 'Duplicate task', actorName: 'Nishant' })
  })

  test('a refusal shows the route\'s words', async () => {
    answer(403, { error: 'Only the task creator or an admin can cancel a task' })
    const { client } = stub({ error: null }, { status: 'working' })
    assert.deepEqual(await cancelTaskFromList(client, TASK, ME, 'x', null), {
      kind: 'stopped', message: 'Failed to cancel task: Only the task creator or an admin can cancel a task', refresh: false,
    })
  })

  test('no answer is read back rather than inviting a second cancel', async () => {
    let sends = 0
    globalThis.fetch = (async () => { sends++; throw new Error('reset') }) as typeof fetch
    const { client } = stub({ error: null }, { status: 'pending_approval' }, 0)
    const result = await cancelTaskFromList(client, TASK, ME, 'x', null)
    assert.equal(sends, 1)
    assert.match((result as { message: string }).message, /Nothing was sent again/)
  })
})
