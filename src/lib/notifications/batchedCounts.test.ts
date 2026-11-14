// THE LAUNCHER'S BADGE COUNTS TRAVEL AS ONE REQUEST (2026-11-14, page speed part 7), the browser's half.
// Callers that ask in the same moment share one request, each still gets exactly the status and body its own
// route would have sent, and every way the batch can fail ends with each caller answered by its own route.
// Run with: npx tsx --test src/lib/notifications/batchedCounts.test.ts

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { COUNTS_ROUTE, batchedCountGet, countPartOf, type CountDeps } from './batchedCounts'

const TASK = '/api/notifications?count=1&category=task'
const FINANCE = '/api/notifications?count=1&category=finance'
const ORDER = '/api/notifications?count=1&category=order'
const SAMPLE = '/api/samples/notifications?count=1'
const SUBJECT = '0b9c6c0e-6a58-4f4d-8f5b-1d0f3a6a7a11'

function rig(answer: (url: string) => Response | Promise<Response>) {
  const calls: string[] = []
  const timers: Array<() => void> = []
  const deps: CountDeps = {
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

describe('which URLs are batched', () => {
  test('exactly the two count routes with their known parameters', () => {
    assert.deepEqual(countPartOf(TASK), { part: 'task', subject: null })
    assert.deepEqual(countPartOf(SAMPLE), { part: 'sample', subject: null })
    assert.deepEqual(countPartOf(`${FINANCE}&subjectUserId=${SUBJECT}`), { part: 'finance', subject: SUBJECT })
  })

  test('anything else is fetched as it is: a list, another route, an unknown parameter, no category', () => {
    for (const url of [
      '/api/notifications?category=task&limit=20',
      '/api/notifications?count=1',
      '/api/notifications?count=1&category=task&limit=5',
      '/api/samples/notifications?count=1&x=1',
      '/api/samples/notifications',
      '/api/notifications/counts?parts=task',
      '/api/tasks?count=1',
      'not a url at all %%',
    ]) assert.equal(countPartOf(url), null, url)
  })
})

describe('counts that ask together share one request', () => {
  test('four counts in the window make ONE request to the batch route, and each gets its own part', async () => {
    const { deps, calls, flush } = rig(() => batchAnswer({
      task: { status: 200, body: { unreadCount: 3 } },
      finance: { status: 200, body: { unreadCount: 0 } },
      order: { status: 200, body: { unreadCount: 7 } },
      sample: { status: 200, body: { unreadCount: 1 } },
    }))
    const all = [TASK, FINANCE, ORDER, SAMPLE].map(u => batchedCountGet(u, deps))
    await flush()
    const [task, finance, order, sample] = await Promise.all(all)
    assert.deepEqual(calls, [`${COUNTS_ROUTE}?parts=task,finance,order,sample`])
    assert.deepEqual(task, { status: 200, body: { unreadCount: 3 } })
    assert.deepEqual(finance, { status: 200, body: { unreadCount: 0 } })
    assert.deepEqual(order, { status: 200, body: { unreadCount: 7 } })
    assert.deepEqual(sample, { status: 200, body: { unreadCount: 1 } })
  })

  test('a part its own route would have refused keeps its status; the others are unaffected', async () => {
    const { deps, flush } = rig(() => batchAnswer({
      finance: { status: 403, body: { error: 'Forbidden' } },
      task: { status: 200, body: { unreadCount: 2 } },
    }))
    const a = batchedCountGet(FINANCE, deps)
    const b = batchedCountGet(TASK, deps)
    await flush()
    assert.deepEqual(await a, { status: 403, body: { error: 'Forbidden' } })
    assert.deepEqual(await b, { status: 200, body: { unreadCount: 2 } })
  })

  test('one count alone goes straight to its OWN url, exactly as it always was', async () => {
    const { deps, calls, flush } = rig(() => json({ unreadCount: 4 }))
    const only = batchedCountGet(ORDER, deps)
    await flush()
    assert.deepEqual(await only, { status: 200, body: { unreadCount: 4 } })
    assert.deepEqual(calls, [ORDER])
  })

  test('the same count asked twice is fetched once and both callers are answered', async () => {
    const { deps, calls, flush } = rig(() => json({ unreadCount: 9 }))
    const a = batchedCountGet(TASK, deps)
    const b = batchedCountGet(TASK, deps)
    await flush()
    assert.deepEqual(await a, await b)
    assert.deepEqual(calls, [TASK])
  })

  test('while an administrator previews somebody the subject travels with the batch, and a different subject is its own group', async () => {
    const { deps, calls, flush } = rig(url => (url.startsWith(COUNTS_ROUTE)
      ? batchAnswer({ task: { status: 200, body: { unreadCount: 1 } }, finance: { status: 200, body: { unreadCount: 2 } } })
      : json({ unreadCount: 5 })))
    const a = batchedCountGet(`${TASK}&subjectUserId=${SUBJECT}`, deps)
    const b = batchedCountGet(`${FINANCE}&subjectUserId=${SUBJECT}`, deps)
    const c = batchedCountGet(ORDER, deps) // the administrator's own, no subject
    await flush()
    assert.deepEqual(await a, { status: 200, body: { unreadCount: 1 } })
    assert.deepEqual(await b, { status: 200, body: { unreadCount: 2 } })
    assert.deepEqual(await c, { status: 200, body: { unreadCount: 5 } })
    assert.deepEqual([...calls].sort(), [ORDER, `${COUNTS_ROUTE}?parts=task,finance&subjectUserId=${SUBJECT}`].sort())
  })

  test('a caller after the window has closed opens the next batch', async () => {
    const { deps, calls, flush } = rig(() => json({ unreadCount: 1 }))
    const first = batchedCountGet(TASK, deps)
    await flush()
    await first
    const second = batchedCountGet(FINANCE, deps)
    await flush()
    await second
    assert.deepEqual(calls, [TASK, FINANCE])
  })

  test('a URL that is not a batchable count is fetched at once, not held for the window', async () => {
    const { deps, calls } = rig(() => json({ notifications: [] }))
    const r = await batchedCountGet('/api/notifications?category=task&limit=20', deps)
    assert.deepEqual(r, { status: 200, body: { notifications: [] } })
    assert.deepEqual(calls, ['/api/notifications?category=task&limit=20'])
  })
})

describe('every way the batch can fail ends with each caller answered by its own route', () => {
  const own = (url: string) => json({ from: url })

  test('the batch route answers an error status', async () => {
    const { deps, calls, flush } = rig(url => (url.startsWith(COUNTS_ROUTE) ? json({ error: 'boom' }, 500) : own(url)))
    const all = [TASK, FINANCE].map(u => batchedCountGet(u, deps))
    await flush()
    assert.deepEqual(await Promise.all(all), [{ status: 200, body: { from: TASK } }, { status: 200, body: { from: FINANCE } }])
    assert.deepEqual([...calls].sort(), [FINANCE, TASK, `${COUNTS_ROUTE}?parts=task,finance`].sort())
  })

  test('the batch request never reaches the server', async () => {
    const { deps, flush } = rig(url => { if (url.startsWith(COUNTS_ROUTE)) throw new Error('offline'); return own(url) })
    const all = [ORDER, SAMPLE].map(u => batchedCountGet(u, deps))
    await flush()
    assert.deepEqual(await Promise.all(all), [{ status: 200, body: { from: ORDER } }, { status: 200, body: { from: SAMPLE } }])
  })

  test('an answer that is not JSON, or does not name the parts, is not trusted', async () => {
    for (const bad of [new Response('<html>', { status: 200 }), json({ nope: true }), json({ parts: 'x' })]) {
      const { deps, flush } = rig(url => (url.startsWith(COUNTS_ROUTE) ? bad.clone() : own(url)))
      const all = [TASK, ORDER].map(u => batchedCountGet(u, deps))
      await flush()
      assert.deepEqual(await Promise.all(all), [{ status: 200, body: { from: TASK } }, { status: 200, body: { from: ORDER } }])
    }
  })

  test('a part the batch left out is asked of its own route; the parts it answered are kept', async () => {
    const { deps, calls, flush } = rig(url => (url.startsWith(COUNTS_ROUTE)
      ? batchAnswer({ task: { status: 200, body: { unreadCount: 6 } } })
      : own(url)))
    const a = batchedCountGet(TASK, deps)
    const b = batchedCountGet(FINANCE, deps)
    await flush()
    assert.deepEqual(await a, { status: 200, body: { unreadCount: 6 } })
    assert.deepEqual(await b, { status: 200, body: { from: FINANCE } })
    assert.deepEqual(calls, [`${COUNTS_ROUTE}?parts=task,finance`, FINANCE])
  })

  test('a route that cannot be reached at all is status 0, and a refusal keeps its status and body', async () => {
    const { deps, flush } = rig(url => { if (url === TASK) throw new Error('offline'); return json({ error: 'Forbidden' }, 403) })
    const a = batchedCountGet(TASK, deps)
    await flush()
    assert.deepEqual(await a, { status: 0, body: {} })
    const b = batchedCountGet(FINANCE, deps)
    await flush()
    assert.deepEqual(await b, { status: 403, body: { error: 'Forbidden' } })
  })
})
