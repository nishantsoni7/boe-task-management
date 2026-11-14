// THE LAUNCHER'S FOUR DAY-CLOSE / SCOREBOARD GETS TRAVEL AS ONE REQUEST (2026-11-14, page speed part 6).
//
// Pins the browser's half: callers that ask in the same moment share one request, each still gets exactly
// the status and body its own route would have sent, and every way the batch can fail ends with each caller
// answered by its own route, as before. Run with: npx tsx --test src/components/dayClose/batchedGet.test.ts

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { BATCH_ROUTE, batchedGet, isBatchable, type Deps } from './batchedGet'

const PROMPT = '/api/day-close/prompt'
const ME = '/api/scoreboard/me'
const VOTE = '/api/scoreboard/vote'
const STAR = '/api/scoreboard/star-seller'

type Call = { url: string; token: string }

function rig(answer: (url: string) => Response | Promise<Response>, token: string | null = 'tok') {
  const calls: Call[] = []
  const timers: Array<() => void> = []
  const deps: Deps = {
    getToken: async () => token,
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, token: String((init?.headers as Record<string, string> | undefined)?.authorization) })
      return answer(url)
    }) as typeof fetch,
    windowMs: 10,
    schedule: run => { timers.push(run) },
  }
  /** The batch window closing: everything asked so far is sent. */
  const flush = async () => {
    while (timers.length) timers.shift()!()
    await new Promise(r => setTimeout(r, 5))
  }
  return { deps, calls, flush }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const batchAnswer = (parts: Record<string, { status: number; body: unknown }>) => json({ parts })

describe('which gets are batched', () => {
  test('exactly the four launcher routes, by their exact path', () => {
    for (const p of [PROMPT, ME, VOTE, STAR]) assert.equal(isBatchable(p), true, p)
    for (const p of ['/api/scoreboard/targets', '/api/day-close/me', '/api/day-close/prompt?x=1', '/api/notifications', BATCH_ROUTE]) {
      assert.equal(isBatchable(p), false, p)
    }
  })
})

describe('callers that ask together share one request', () => {
  test('four callers in the window make ONE request, and each gets its own part (status and body)', async () => {
    const { deps, calls, flush } = rig(() => batchAnswer({
      prompt: { status: 200, body: { today: '2026-11-14', prompt: { kind: 'none' } } },
      me: { status: 200, body: { scored: false } },
      vote: { status: 200, body: { open: false } },
      starSeller: { status: 200, body: { seller: null } },
    }))
    const all = [PROMPT, ME, VOTE, STAR].map(p => batchedGet(p, deps))
    await flush()
    const [prompt, me, vote, star] = await Promise.all(all)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, `${BATCH_ROUTE}?parts=prompt,me,vote,starSeller`)
    assert.equal(calls[0].token, 'Bearer tok')
    assert.deepEqual(prompt, { status: 200, body: { today: '2026-11-14', prompt: { kind: 'none' } } })
    assert.deepEqual(me, { status: 200, body: { scored: false } })
    assert.deepEqual(vote, { status: 200, body: { open: false } })
    assert.deepEqual(star, { status: 200, body: { seller: null } })
  })

  test('a part that its own route would have refused keeps its status (the others are unaffected)', async () => {
    const { deps, flush } = rig(() => batchAnswer({
      prompt: { status: 403, body: { error: 'Day Close is not switched on for you.' } },
      me: { status: 200, body: { scored: true, score: 91 } },
    }))
    const a = batchedGet(PROMPT, deps)
    const b = batchedGet(ME, deps)
    await flush()
    assert.deepEqual(await a, { status: 403, body: { error: 'Day Close is not switched on for you.' } })
    assert.deepEqual(await b, { status: 200, body: { scored: true, score: 91 } })
  })

  test('the same route asked twice in the window is fetched once and both callers are answered', async () => {
    const { deps, calls, flush } = rig(() => json({ scored: false }))
    const a = batchedGet(ME, deps)
    const b = batchedGet(ME, deps)
    await flush()
    assert.deepEqual(await a, await b)
    assert.deepEqual(calls.map(c => c.url), [ME], 'one caller of one route goes to that route directly')
  })

  test('one caller alone goes straight to its own route, not the batch', async () => {
    const { deps, calls, flush } = rig(() => json({ open: true }))
    const only = batchedGet(VOTE, deps)
    await flush()
    assert.deepEqual(await only, { status: 200, body: { open: true } })
    assert.deepEqual(calls.map(c => c.url), [VOTE])
  })

  test('a caller after the window has closed opens the next batch', async () => {
    const { deps, calls, flush } = rig(url => (url === VOTE || url === ME ? json({ ok: 1 }) : batchAnswer({})))
    const first = batchedGet(ME, deps)
    await flush()
    await first
    const second = batchedGet(VOTE, deps)
    await flush()
    await second
    assert.deepEqual(calls.map(c => c.url), [ME, VOTE])
  })
})

describe('every way the batch can fail ends with each caller answered by its own route', () => {
  const own = (url: string) => json({ from: url })

  test('the batch route answers an error status', async () => {
    const { deps, calls, flush } = rig(url => (url.startsWith(BATCH_ROUTE) ? json({ error: 'boom' }, 500) : own(url)))
    const all = [PROMPT, ME].map(p => batchedGet(p, deps))
    await flush()
    const answers = await Promise.all(all)
    assert.deepEqual(answers, [{ status: 200, body: { from: PROMPT } }, { status: 200, body: { from: ME } }])
    assert.deepEqual(calls.map(c => c.url).sort(), [ME, PROMPT, `${BATCH_ROUTE}?parts=prompt,me`].sort())
  })

  test('the batch request never reaches the server', async () => {
    const { deps, flush } = rig(url => { if (url.startsWith(BATCH_ROUTE)) throw new Error('offline'); return own(url) })
    const all = [VOTE, STAR].map(p => batchedGet(p, deps))
    await flush()
    assert.deepEqual(await Promise.all(all), [{ status: 200, body: { from: VOTE } }, { status: 200, body: { from: STAR } }])
  })

  test('an answer that is not JSON, or does not name the parts, is not trusted', async () => {
    for (const bad of [new Response('<html>', { status: 200 }), json({ nope: true }), json({ parts: 'x' })]) {
      const { deps, flush } = rig(url => (url.startsWith(BATCH_ROUTE) ? bad.clone() : own(url)))
      const all = [PROMPT, ME].map(p => batchedGet(p, deps))
      await flush()
      assert.deepEqual(await Promise.all(all), [{ status: 200, body: { from: PROMPT } }, { status: 200, body: { from: ME } }])
    }
  })

  test('a part the batch left out is asked of its own route; the parts it answered are kept', async () => {
    const { deps, calls, flush } = rig(url => (url.startsWith(BATCH_ROUTE)
      ? batchAnswer({ prompt: { status: 200, body: { kind: 'none' } } })
      : own(url)))
    const a = batchedGet(PROMPT, deps)
    const b = batchedGet(ME, deps)
    await flush()
    assert.deepEqual(await a, { status: 200, body: { kind: 'none' } })
    assert.deepEqual(await b, { status: 200, body: { from: ME } })
    assert.deepEqual(calls.map(c => c.url), [`${BATCH_ROUTE}?parts=prompt,me`, ME])
  })

  test('a route that cannot be reached at all is status 0, and a refusal keeps its status and body', async () => {
    const { deps, flush } = rig(url => { if (url === PROMPT) throw new Error('offline'); return json({ error: 'Day Close is not switched on for you.' }, 403) })
    const a = batchedGet(PROMPT, deps)
    await flush()
    assert.deepEqual(await a, { status: 0, body: {} })
    const b = batchedGet(VOTE, deps)
    await flush()
    assert.deepEqual(await b, { status: 403, body: { error: 'Day Close is not switched on for you.' } })
  })

  test('no signed-in session: every caller gets the same expired-session answer and nothing is sent', async () => {
    const { deps, calls, flush } = rig(() => json({}), null)
    const all = [PROMPT, ME, VOTE].map(p => batchedGet(p, deps))
    await flush()
    for (const r of await Promise.all(all)) {
      assert.deepEqual(r, { status: 401, body: { error: 'Your session has expired. Sign in again.' } })
    }
    assert.equal(calls.length, 0)
  })
})
