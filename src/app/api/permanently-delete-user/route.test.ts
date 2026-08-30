/**
 * Permanent member deletion, actually executed, with one thing under the
 * microscope: an employee's Image Editor results must leave — object AND row —
 * before the employee does.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * `image_editor_results.storage_path` is the ONLY record of where a generated
 * master lives. If the member row goes first and a foreign key takes the result
 * rows with it, every one of those objects becomes unreachable: the nightly
 * sweep reads rows, the listing reads rows, the owner's Delete reads rows, and
 * there are no rows. The bytes then sit in a private bucket for ever.
 *
 * Nothing about that failure is visible — the route answers 200, the member is
 * gone, and the bill quietly stops falling. So it is proved here by ORDER: the
 * sequence of HTTP calls the route makes, with `fetch` stubbed so both Supabase
 * REST and Supabase Storage are observable. Same technique as
 * image-editor/studio/routeBehaviour.test.ts.
 *
 * Run:
 *   npx tsx --test src/app/api/permanently-delete-user/route.test.ts
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const SUPABASE_URL = 'https://stub.supabase.co'
const realFetch = globalThis.fetch
const realEnv = { ...process.env }

// Real uuids: the auth admin API validates the shape before it sends anything.
const ADMIN = '11111111-1111-4111-8111-111111111111'
const TARGET = '22222222-2222-4222-8222-222222222222'
const OTHER = '33333333-3333-4333-8333-333333333333'

/** One recorded request, reduced to what the assertions care about. */
type Call = { method: string; path: string; body: unknown }

type Scenario = {
  /** Rows the results table holds for the target. */
  rows: { id: string; user_id: string; storage_path: string }[]
  /** Object keys the bucket holds, including any with no row. */
  objects: string[]
  /** Make the results table answer as if the migration were not applied. */
  tableAbsent?: boolean
  /** Make every storage removal fail. */
  storageBroken?: boolean
  /** Make the removal of exactly this object key fail, so an earlier result is
   *  really deleted before a later one fails — the partial case. */
  failObject?: string
}

let scenario: Scenario
let calls: Call[]

/** Everything the route talks to, answered in place. */
function install() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = url.pathname
    const raw = typeof init?.body === 'string' ? init.body : undefined
    const body = raw ? JSON.parse(raw) : undefined
    calls.push({ method, path: path + url.search, body })

    const headers = new Headers(init?.headers as HeadersInit)
    const wantsOne = (headers.get('accept') ?? '').includes('vnd.pgrst.object')
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

    // ── Auth ────────────────────────────────────────────────────────────────
    if (path === '/auth/v1/user') return json({ id: ADMIN, aud: 'authenticated' })
    if (path.startsWith('/auth/v1/admin/users/')) return json({})

    // ── Storage ─────────────────────────────────────────────────────────────
    if (path.startsWith('/storage/v1/object/list/')) {
      const prefix = (body as { prefix?: string })?.prefix ?? ''
      const names = scenario.objects
        .filter(o => o.startsWith(`${prefix}/`))
        .map(o => o.slice(prefix.length + 1))
      return json(names.map(name => ({ name })))
    }
    if (path.startsWith('/storage/v1/object/') && method === 'DELETE') {
      const prefixes = (body as { prefixes?: string[] })?.prefixes ?? []
      if (scenario.storageBroken) return json({ message: 'storage is unavailable' }, 400)
      if (scenario.failObject && prefixes.includes(scenario.failObject)) {
        return json({ message: `object ${scenario.failObject} is locked` }, 400)
      }
      scenario.objects = scenario.objects.filter(o => !prefixes.includes(o))
      return json(prefixes.map(name => ({ name })))
    }

    // ── PostgREST ───────────────────────────────────────────────────────────
    if (path.startsWith('/rest/v1/image_editor_results')) {
      if (scenario.tableAbsent) {
        return json({
          code: 'PGRST205',
          message: "Could not find the table 'public.image_editor_results' in the schema cache",
        }, 404)
      }
      if (method === 'GET') return json(scenario.rows)
      if (method === 'DELETE') {
        const id = url.searchParams.get('id')?.replace('eq.', '')
        scenario.rows = scenario.rows.filter(r => r.id !== id)
        return json([])
      }
    }

    if (path.startsWith('/rest/v1/users')) {
      if (method === 'GET') {
        const id = url.searchParams.get('id')?.replace('eq.', '')
        const row = id === ADMIN
          ? { id: ADMIN, role: 'admin' }
          : { id: TARGET, is_deleted: true }
        return wantsOne ? json(row) : json([row])
      }
      return json([])                                   // update / delete
    }

    // notifications, password_reset_log, tasks, task_activity_log
    if (path.startsWith('/rest/v1/')) return json([])

    throw new Error(`unstubbed request: ${method} ${path}`)
  }) as typeof globalThis.fetch
}

before(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-stub'
  install()
})

after(() => {
  globalThis.fetch = realFetch
  process.env = { ...realEnv }
})

beforeEach(() => {
  calls = []
  scenario = {
    rows: [
      { id: 'r1', user_id: TARGET, storage_path: `${TARGET}/r1.png` },
      { id: 'r2', user_id: TARGET, storage_path: `${TARGET}/r2.png` },
    ],
    objects: [`${TARGET}/r1.png`, `${TARGET}/r2.png`, `${TARGET}/orphan.png`, `${OTHER}/kept.png`],
  }
})

async function run() {
  const { POST } = await import('./route')
  return POST(new NextRequest('https://app.test/api/permanently-delete-user', {
    method: 'POST',
    headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
    body: JSON.stringify({ userId: TARGET }),
  }))
}

/** Index of the first call matching, or -1. */
const at = (pred: (c: Call) => boolean) => calls.findIndex(pred)
const isStorageRemove = (c: Call) => c.method === 'DELETE' && c.path.startsWith('/storage/v1/object/image-editor-results')
const isResultRowDelete = (c: Call) => c.method === 'DELETE' && c.path.startsWith('/rest/v1/image_editor_results')
const isMemberDelete = (c: Call) => c.method === 'DELETE' && c.path.startsWith('/rest/v1/users')

describe('a deleted member takes their Image Editor results with them', () => {
  test('both objects and both rows are gone, and the member row goes LAST', async () => {
    const res = await run()
    assert.equal(res.status, 200)
    const payload = await res.json()
    assert.equal(payload.success, true)
    assert.equal(payload.deleted.imageEditorResults, 2)

    // Nothing of this employee's is left in either place.
    assert.deepEqual(scenario.rows, [])
    assert.deepEqual(scenario.objects, [`${OTHER}/kept.png`], 'and nobody else\'s object was touched')

    // The ordering that makes the whole thing safe.
    assert.ok(at(isStorageRemove) >= 0, 'objects are removed')
    assert.ok(at(isResultRowDelete) >= 0, 'rows are removed')
    assert.ok(
      at(isStorageRemove) < at(isResultRowDelete),
      'the object goes before the row that names it',
    )
    assert.ok(
      at(isResultRowDelete) < at(isMemberDelete),
      'the results go before the member — a cascade here would orphan every object',
    )
  })

  test('an object whose row never landed is collected by the prefix sweep', async () => {
    await run()
    assert.ok(!scenario.objects.includes(`${TARGET}/orphan.png`),
      'a save that died between upload and insert leaves bytes nothing else would ever find')
  })

  test('the report counts what actually left', async () => {
    const payload = await (await run()).json()
    assert.equal(payload.deleted.imageEditorResults, 2)
    assert.equal(payload.deleted.imageEditorOrphanObjects, 1)
  })
})

describe('when the history cannot be emptied, the MEMBER is not deleted', () => {
  test('a storage failure stops the deletion before the member row', async () => {
    scenario.storageBroken = true

    const res = await run()
    assert.equal(res.status, 500)
    const payload = await res.json()

    assert.equal(at(isMemberDelete), -1, 'the member must survive a failed purge')
    assert.equal(at(isResultRowDelete), -1, 'and so must the rows that carry the storage paths')
    assert.equal(scenario.rows.length, 2, 'so an administrator can simply try again')

    // The wording is part of the contract. The purge is not atomic across
    // Storage and Postgres, so "nothing was deleted" would be a claim this
    // route cannot make — see the partial-failure test below.
    assert.match(payload.error, /The member and their other records were NOT deleted/)
    assert.match(payload.error, /may already have been removed/)
    assert.match(payload.error, /safe to repeat/)
    assert.ok(!/nothing was deleted/i.test(payload.error))
  })

  test('nothing else is destroyed either — the purge is the FIRST step', async () => {
    scenario.storageBroken = true
    await run()
    const collateral = calls.filter(c =>
      c.method === 'DELETE' &&
      /\/rest\/v1\/(notifications|tasks|task_activity_log|password_reset_log)/.test(c.path))
    assert.deepEqual(collateral, [], 'a member half-deleted is worse than one not deleted')
  })

  test('a PARTIAL failure says so, and a retry finishes the job', async () => {
    // The honest case: the first result really is deleted, the second fails.
    // Nothing can put the first one back — the bytes are gone — so the route
    // must not pretend the history is untouched.
    scenario.failObject = `${TARGET}/r2.png`

    const first = await run()
    assert.equal(first.status, 500)
    const payload = await first.json()
    assert.equal(payload.imageEditorResultsRemoved, 1, 'one result really did go')
    assert.match(payload.error, /part of their Image Editor history may already have been removed/)
    assert.match(payload.error, /cannot be restored/)

    assert.deepEqual(scenario.rows.map(r => r.id), ['r2'], 'r1 is gone and stays gone')
    assert.equal(at(isMemberDelete), -1, 'the member is untouched')

    // The promise the message makes: pressing Delete again continues from here.
    calls = []
    scenario.failObject = undefined
    const second = await run()
    assert.equal(second.status, 200, 'a retry is safe and completes')
    const done = await second.json()
    assert.equal(done.deleted.imageEditorResults, 1, 'only what was left is removed again')
    assert.deepEqual(scenario.rows, [])
    assert.deepEqual(scenario.objects, [`${OTHER}/kept.png`])
    assert.ok(at(isMemberDelete) >= 0, 'and the member finally goes')
  })
})

describe('a deployment without the migration', () => {
  test('deletes the member normally — nothing is stored, so nothing can be orphaned', async () => {
    scenario.tableAbsent = true
    scenario.objects = []

    const res = await run()
    assert.equal(res.status, 200, 'an unapplied migration must not block member deletion')
    const payload = await res.json()
    assert.equal(payload.deleted.imageEditorResults, 0)
    assert.ok(at(isMemberDelete) >= 0, 'the member is still removed')
  })
})
