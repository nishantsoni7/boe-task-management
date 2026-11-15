// THE LAUNCHER'S ATTENDANCE ANSWERS JOIN THE ONE REQUEST (2026-11-14, page speed part 8), the browser's half.
// The punch-in strip, and for an administrator the machine's health and the pending requests, travel in the same
// request as the Day Close and Scoreboard answers; each caller still gets what its own route would have sent,
// and every way the batch can fail ends with each caller answered by its own route.
// Run with: npx tsx --test src/components/dayClose/batchedGetAttendance.test.ts

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { BATCH_ROUTE, batchedGet, isBatchable, type Deps } from './batchedGet'

const PROMPT = '/api/day-close/prompt'
const ME = '/api/scoreboard/me'
const VOTE = '/api/scoreboard/vote'
const STAR = '/api/scoreboard/star-seller'
const PUNCH = '/api/attendance/my-punch'
const MACHINE = '/api/attendance/machine-status'
const QUEUE = '/api/attendance-requests?scope=queue&status=pending'

function rig(answer: (url: string) => Response | Promise<Response>) {
  const calls: string[] = []
  const timers: Array<() => void> = []
  const deps: Deps = {
    getToken: async () => 'tok',
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      return answer(url)
    }) as typeof fetch,
    windowMs: 10,
    schedule: run => { timers.push(run) },
  }
  const flush = async () => {
    while (timers.length) timers.shift()!()
    await new Promise(r => setTimeout(r, 5))
  }
  return { deps, calls, flush }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const batchAnswer = (parts: Record<string, { status: number; body: unknown }>) => json({ parts })

describe('which gets are batched now', () => {
  test('the three attendance answers, by their exact address (the queue only as pending)', () => {
    for (const p of [PUNCH, MACHINE, QUEUE]) assert.equal(isBatchable(p), true, p)
    for (const p of [
      '/api/attendance-requests',
      '/api/attendance-requests?scope=queue&status=approved',
      '/api/attendance-requests?scope=queue',
      '/api/attendance-requests?scope=queue&status=pending&x=1',
      '/api/attendance/my-punch?employee=1',
      '/api/attendance/monthly-summary',
    ]) assert.equal(isBatchable(p), false, p)
  })
})

describe('the launcher\'s answers share one request', () => {
  test('an administrator\'s seven answers make ONE request, and each caller gets its own part', async () => {
    const { deps, calls, flush } = rig(() => batchAnswer({
      prompt: { status: 200, body: { prompt: { kind: 'none' } } },
      me: { status: 200, body: { scored: false } },
      vote: { status: 200, body: { open: false } },
      starSeller: { status: 200, body: { seller: null } },
      punch: { status: 200, body: { state: 'in' } },
      machine: { status: 200, body: { sending: true } },
      queue: { status: 200, body: { requests: [], viewer_id: 'a1' } },
    }))
    const all = [PROMPT, ME, VOTE, STAR, PUNCH, MACHINE, QUEUE].map(p => batchedGet(p, deps))
    await flush()
    const [, , , , punch, machine, queue] = await Promise.all(all)
    assert.deepEqual(calls, [`${BATCH_ROUTE}?parts=prompt,me,vote,starSeller,punch,machine,queue`])
    assert.deepEqual(punch, { status: 200, body: { state: 'in' } })
    assert.deepEqual(machine, { status: 200, body: { sending: true } })
    assert.deepEqual(queue, { status: 200, body: { requests: [], viewer_id: 'a1' } })
  })

  test('anybody else\'s answers (no machine, no queue) travel together too', async () => {
    const { deps, calls, flush } = rig(() => batchAnswer({
      prompt: { status: 200, body: {} }, me: { status: 200, body: {} }, vote: { status: 200, body: {} },
      starSeller: { status: 200, body: {} }, punch: { status: 200, body: { state: 'none' } },
    }))
    const all = [PROMPT, ME, VOTE, STAR, PUNCH].map(p => batchedGet(p, deps))
    await flush()
    await Promise.all(all)
    assert.deepEqual(calls, [`${BATCH_ROUTE}?parts=prompt,me,vote,starSeller,punch`])
  })

  test('the punch strip alone goes straight to its OWN route, as before', async () => {
    const { deps, calls, flush } = rig(() => json({ state: 'in' }))
    const only = batchedGet(PUNCH, deps)
    await flush()
    assert.deepEqual(await only, { status: 200, body: { state: 'in' } })
    assert.deepEqual(calls, [PUNCH])
  })

  test('an administrator-only part refused for somebody keeps its status; the others are unaffected', async () => {
    const { deps, flush } = rig(() => batchAnswer({
      punch: { status: 200, body: { state: 'in' } },
      machine: { status: 403, body: { error: 'Forbidden' } },
    }))
    const a = batchedGet(PUNCH, deps)
    const b = batchedGet(MACHINE, deps)
    await flush()
    assert.deepEqual(await a, { status: 200, body: { state: 'in' } })
    assert.deepEqual(await b, { status: 403, body: { error: 'Forbidden' } })
  })
})

describe('every way the batch can fail ends with each caller answered by its own route', () => {
  test('the batch answers an error: each attendance route is asked at its own full address, the queue with its query', async () => {
    const { deps, calls, flush } = rig(url => (url.startsWith(BATCH_ROUTE) ? json({ error: 'boom' }, 500) : json({ from: url })))
    const all = [PUNCH, MACHINE, QUEUE].map(p => batchedGet(p, deps))
    await flush()
    assert.deepEqual(await Promise.all(all), [
      { status: 200, body: { from: PUNCH } },
      { status: 200, body: { from: MACHINE } },
      { status: 200, body: { from: QUEUE } },
    ])
    assert.deepEqual([...calls].sort(), [MACHINE, PUNCH, QUEUE, `${BATCH_ROUTE}?parts=punch,machine,queue`].sort())
  })

  test('a part the batch left out is asked of its own route; the parts it answered are kept', async () => {
    const { deps, calls, flush } = rig(url => (url.startsWith(BATCH_ROUTE)
      ? batchAnswer({ punch: { status: 200, body: { state: 'in' } } })
      : json({ from: url })))
    const a = batchedGet(PUNCH, deps)
    const b = batchedGet(QUEUE, deps)
    await flush()
    assert.deepEqual(await a, { status: 200, body: { state: 'in' } })
    assert.deepEqual(await b, { status: 200, body: { from: QUEUE } })
    assert.deepEqual(calls, [`${BATCH_ROUTE}?parts=punch,queue`, QUEUE])
  })
})
