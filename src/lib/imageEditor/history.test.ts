/**
 * Saving, deleting and sweeping — the ORDER, and what happens when half of it
 * fails.
 *
 * The clients are injected, so this runs with no Supabase, no bucket and no
 * network: every case here is a partial failure, and partial failures are
 * exactly what you cannot arrange against a real service on demand.
 *
 * WHAT IS BEING PROTECTED
 * -----------------------
 * The object is deleted BEFORE the row. Get that backwards and a failed object
 * delete destroys the only record of where the object lives — bytes that are
 * paid for, private, unreachable and invisible to every sweep that follows.
 * There is no test that would catch that in production, so it is caught here.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/history.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { saveResult, deleteResult, sweepExpired, toHistoryResult } from './history'

const ROW = {
  id: 'result-1',
  user_id: 'user-1',
  storage_path: 'user-1/result-1.png',
}

/** Records the order of every call, so a test can assert on the sequence rather
 *  than only on the outcome. */
function recorder() {
  const calls: string[] = []
  return { calls, note: (s: string) => calls.push(s) }
}

function fakeStorage(log: (s: string) => void, opts: {
  uploadError?: string
  removeError?: string
} = {}) {
  return {
    async upload(path: string) {
      log(`upload:${path}`)
      return { error: opts.uploadError ? { message: opts.uploadError } : null }
    },
    async remove(paths: string[]) {
      log(`remove:${paths.join(',')}`)
      return { error: opts.removeError ? { message: opts.removeError } : null }
    },
  }
}

// ─── Deleting ─────────────────────────────────────────────────────────────────

describe('deleting one result', () => {
  test('removes the OBJECT first, then the row', async () => {
    const { calls, note } = recorder()

    const outcome = await deleteResult({
      storage: fakeStorage(note),
      async deleteRow(id) { note(`deleteRow:${id}`); return { error: null } },
    }, ROW)

    assert.deepEqual(outcome, { ok: true })
    assert.deepEqual(calls, ['remove:user-1/result-1.png', 'deleteRow:result-1'])
  })

  // THE case this file exists for.
  test('a failed object delete leaves the row ALONE', async () => {
    const { calls, note } = recorder()

    const outcome = await deleteResult({
      storage: fakeStorage(note, { removeError: 'storage unavailable' }),
      async deleteRow(id) { note(`deleteRow:${id}`); return { error: null } },
    }, ROW)

    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false && outcome.stage, 'object')
    assert.ok(
      !calls.some(c => c.startsWith('deleteRow')),
      'the row must survive so the next sweep can retry — deleting it would orphan the object for ever',
    )
  })

  test('a thrown storage error is caught, not propagated', async () => {
    const outcome = await deleteResult({
      storage: {
        async upload() { return { error: null } },
        async remove(): Promise<{ error: { message: string } | null }> { throw new Error('socket hang up') },
      },
      async deleteRow() { return { error: null } },
    }, ROW)

    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false && outcome.stage, 'object')
  })

  test('a failed row delete is reported, and the row stays due', async () => {
    const outcome = await deleteResult({
      storage: fakeStorage(() => {}),
      async deleteRow() { return { error: { message: 'deadlock' } } },
    }, ROW)

    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false && outcome.stage, 'row')
  })

  // The retry after the case above: the object is already gone, so `remove`
  // reports no error and the row delete finally lands. This is what makes
  // object-first safe to repeat, and it is why a failed row delete needs no
  // compensating action — only another pass.
  test('a retry over an already-removed object completes the deletion', async () => {
    const { calls, note } = recorder()
    const absent = new Set(['user-1/result-1.png'])

    const outcome = await deleteResult({
      storage: {
        async upload() { return { error: null } },
        async remove(paths: string[]) {
          note(absent.has(paths[0]) ? `remove:${paths[0]} (already gone)` : `remove:${paths[0]}`)
          return { error: null }
        },
      },
      async deleteRow(id) { note(`deleteRow:${id}`); return { error: null } },
    }, ROW)

    assert.deepEqual(outcome, { ok: true })
    assert.deepEqual(calls, ['remove:user-1/result-1.png (already gone)', 'deleteRow:result-1'])
  })
})

// ─── Sweeping ─────────────────────────────────────────────────────────────────

describe('the sweep', () => {
  const rows = [
    { id: 'a', user_id: 'u', storage_path: 'u/a.png' },
    { id: 'b', user_id: 'u', storage_path: 'u/b.png' },
    { id: 'c', user_id: 'u', storage_path: 'u/c.png' },
  ]

  test('deletes every row and counts them', async () => {
    const report = await sweepExpired({
      storage: fakeStorage(() => {}),
      async deleteRow() { return { error: null } },
    }, rows)

    assert.deepEqual(report, { scanned: 3, deleted: 3, failed: 0 })
  })

  test('ONE failure never stops the rest', async () => {
    const seen: string[] = []
    const failures: string[] = []

    const report = await sweepExpired({
      storage: {
        async upload() { return { error: null } },
        async remove(paths: string[]) {
          seen.push(paths[0])
          return { error: paths[0] === 'u/b.png' ? { message: 'gone wrong' } : null }
        },
      },
      async deleteRow() { return { error: null } },
    }, rows, id => failures.push(id))

    assert.deepEqual(report, { scanned: 3, deleted: 2, failed: 1 })
    assert.deepEqual(failures, ['b'], 'the failure is named for the log')
    assert.deepEqual(seen, ['u/a.png', 'u/b.png', 'u/c.png'], 'c was still attempted after b failed')
  })

  test('is sequential, not a burst', async () => {
    let inFlight = 0
    let peak = 0

    await sweepExpired({
      storage: {
        async upload() { return { error: null } },
        async remove() {
          inFlight += 1
          peak = Math.max(peak, inFlight)
          await new Promise(r => setTimeout(r, 1))
          inFlight -= 1
          return { error: null }
        },
      },
      async deleteRow() { return { error: null } },
    }, rows)

    assert.equal(peak, 1, 'a serverless function must not open a storage call per row at once')
  })

  test('an empty due list is not an error', async () => {
    const report = await sweepExpired({
      storage: fakeStorage(() => {}),
      async deleteRow() { return { error: null } },
    }, [])
    assert.deepEqual(report, { scanned: 0, deleted: 0, failed: 0 })
  })
})

// ─── Saving ───────────────────────────────────────────────────────────────────

describe('saving a generated master', () => {
  test('uploads the object, then inserts the row', async () => {
    const { calls, note } = recorder()

    const outcome = await saveResult({
      storage: fakeStorage(note),
      async insertRow(row) { note(`insert:${row.storage_path}`); return { error: null } },
      newId: () => 'new-id',
    }, {
      userId: 'user-1',
      master: Buffer.from('png'),
      sourceFileName: 'chair.jpg',
      verification: 'passed',
    })

    assert.deepEqual(outcome, { ok: true, id: 'new-id' })
    assert.deepEqual(calls, ['upload:user-1/new-id.png', 'insert:user-1/new-id.png'])
  })

  test('never throws — a storage fault is an outcome, not an exception', async () => {
    const outcome = await saveResult({
      storage: {
        async upload(): Promise<{ error: { message: string } | null }> { throw new Error('boom') },
        async remove() { return { error: null } },
      },
      async insertRow() { return { error: null } },
      newId: () => 'new-id',
    }, {
      userId: 'u', master: Buffer.from('x'), sourceFileName: 'a.jpg', verification: 'passed',
    })

    assert.equal(outcome.ok, false)
  })

  // An object nothing references is invisible to the sweep, which only ever
  // looks at rows. Cleaning it up here keeps the orphan window inside this
  // function.
  test('a failed insert removes the object it had just uploaded', async () => {
    const { calls, note } = recorder()

    const outcome = await saveResult({
      storage: fakeStorage(note),
      async insertRow() { note('insert'); return { error: { message: 'constraint' } } },
      newId: () => 'new-id',
    }, {
      userId: 'u', master: Buffer.from('x'), sourceFileName: 'a.jpg', verification: 'passed',
    })

    assert.equal(outcome.ok, false)
    assert.deepEqual(calls, ['upload:u/new-id.png', 'insert', 'remove:u/new-id.png'])
  })

  test('the verification verdict is carried through, never invented', async () => {
    let stored: string | undefined

    await saveResult({
      storage: fakeStorage(() => {}),
      async insertRow(row) { stored = row.verification; return { error: null } },
      newId: () => 'id',
    }, {
      userId: 'u', master: Buffer.from('x'), sourceFileName: 'a.jpg',
      verification: 'manual_review_required',
    })

    assert.equal(stored, 'manual_review_required')
  })
})

// ─── The wire shape ───────────────────────────────────────────────────────────

describe('what reaches the browser', () => {
  test('the storage path is stripped', () => {
    const wire = toHistoryResult({
      id: 'r', user_id: 'u', storage_path: 'u/r.png',
      source_file_name: 'chair.jpg', verification: 'passed',
      kept: false, created_at: 'c', expires_at: 'e',
    }, 'https://signed')

    assert.equal('storage_path' in wire, false, 'the object key is never sent to a browser')
    assert.equal('user_id' in wire, false)
    assert.equal(wire.url, 'https://signed')
  })

  test('a failed signing yields a null url rather than a broken row', () => {
    const wire = toHistoryResult({
      id: 'r', user_id: 'u', storage_path: 'u/r.png',
      source_file_name: 'chair.jpg', verification: 'passed',
      kept: true, created_at: 'c', expires_at: 'e',
    }, null)

    assert.equal(wire.url, null)
    assert.equal(wire.kept, true)
  })
})
