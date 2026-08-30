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
import {
  saveResult, deleteResult, sweepExpired, toHistoryResult, purgeUserResults,
} from './history'

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

// ─── Removing an employee ─────────────────────────────────────────────────────
//
// The lifecycle the foreign key cannot perform on its own. A CASCADE would take
// these rows with the member and leave their objects in the bucket for ever,
// because the row is the only record of where the object is. So the history is
// emptied FIRST, and the caller is told plainly whether it worked.

/** A bucket, in memory. Objects are keyed exactly as they are in storage:
 *  '<user_id>/<result_id>.png'. `list` answers with names RELATIVE to the
 *  prefix, which is what Supabase does and what the prefix sweep must handle. */
function fakeBucket(objects: string[], log: (s: string) => void, opts: {
  removeError?: string
  listError?: string
  /** Reports success without actually removing anything, the way a storage
   *  that silently no-ops would. */
  removeIsALie?: boolean
} = {}) {
  const held = new Set(objects)
  return {
    held,
    async upload(path: string) { held.add(path); log(`upload:${path}`); return { error: null } },
    async remove(paths: string[]) {
      log(`remove:${paths.join(',')}`)
      if (opts.removeError) return { error: { message: opts.removeError } }
      if (!opts.removeIsALie) for (const p of paths) held.delete(p)
      return { error: null }
    },
    async list(prefix: string, options?: { limit?: number; offset?: number }) {
      log(`list:${prefix}`)
      if (opts.listError) return { data: null, error: { message: opts.listError } }
      const names = [...held]
        .filter(p => p.startsWith(`${prefix}/`))
        .map(p => p.slice(prefix.length + 1))
        .sort()
      const offset = options?.offset ?? 0
      const limit = options?.limit ?? 100
      return { data: names.slice(offset, offset + limit).map(name => ({ name })), error: null }
    },
  }
}

function fakeRows(
  rows: { id: string; user_id: string; storage_path: string }[],
  log: (s: string) => void,
  opts: { listError?: { message: string; code?: string }; deleteError?: string } = {},
) {
  const held = [...rows]
  return {
    held,
    async listRows(userId: string) {
      log(`listRows:${userId}`)
      if (opts.listError) return { data: null, error: opts.listError }
      return { data: held.filter(r => r.user_id === userId), error: null }
    },
    async deleteRow(id: string, userId: string) {
      log(`deleteRow:${id}`)
      if (opts.deleteError) return { error: { message: opts.deleteError } }
      const at = held.findIndex(r => r.id === id && r.user_id === userId)
      if (at >= 0) held.splice(at, 1)
      return { error: null }
    },
  }
}

describe('emptying one employee\'s history before they are deleted', () => {
  test('every object goes before its own row, and nothing is left behind', async () => {
    const { calls, note } = recorder()
    const rows = [
      { id: 'r1', user_id: 'user-1', storage_path: 'user-1/r1.png' },
      { id: 'r2', user_id: 'user-1', storage_path: 'user-1/r2.png' },
    ]
    const bucket = fakeBucket(['user-1/r1.png', 'user-1/r2.png'], note)
    const table = fakeRows(rows, note)

    const report = await purgeUserResults(
      { storage: bucket, listRows: table.listRows, deleteRow: table.deleteRow },
      'user-1',
    )

    assert.equal(report.ok, true)
    assert.equal(report.rows, 2)
    assert.equal(report.rowsDeleted, 2)
    assert.deepEqual(report.reasons, [])

    // Object then row, per result, in that order — the whole point.
    assert.deepEqual(calls.slice(0, 5), [
      'listRows:user-1',
      'remove:user-1/r1.png', 'deleteRow:r1',
      'remove:user-1/r2.png', 'deleteRow:r2',
    ])

    // The bucket and the table are both actually empty for this employee.
    assert.equal([...bucket.held].filter(p => p.startsWith('user-1/')).length, 0)
    assert.equal(table.held.filter(r => r.user_id === 'user-1').length, 0)
  })

  test('an object with no row — the save that died between upload and insert — is collected too', async () => {
    const { note } = recorder()
    const bucket = fakeBucket(['user-1/r1.png', 'user-1/orphan.png'], note)
    const table = fakeRows([{ id: 'r1', user_id: 'user-1', storage_path: 'user-1/r1.png' }], note)

    const report = await purgeUserResults(
      { storage: bucket, listRows: table.listRows, deleteRow: table.deleteRow },
      'user-1',
    )

    assert.equal(report.ok, true)
    assert.equal(report.rowsDeleted, 1)
    assert.equal(report.orphanObjects, 1, 'the row-less object is the reason the prefix is swept')
    assert.equal(bucket.held.has('user-1/orphan.png'), false)
  })

  test('nobody else\'s objects or rows are touched', async () => {
    const { note } = recorder()
    const bucket = fakeBucket(['user-1/r1.png', 'user-2/r9.png'], note)
    const table = fakeRows([
      { id: 'r1', user_id: 'user-1', storage_path: 'user-1/r1.png' },
      { id: 'r9', user_id: 'user-2', storage_path: 'user-2/r9.png' },
    ], note)

    const report = await purgeUserResults(
      { storage: bucket, listRows: table.listRows, deleteRow: table.deleteRow },
      'user-1',
    )

    assert.equal(report.ok, true)
    assert.equal(bucket.held.has('user-2/r9.png'), true)
    assert.deepEqual(table.held.map(r => r.id), ['r9'])
  })

  test('a failed object delete KEEPS the row, so the path survives for a retry', async () => {
    const { calls, note } = recorder()
    const bucket = fakeBucket(['user-1/r1.png'], note, { removeError: 'storage is down' })
    const table = fakeRows([{ id: 'r1', user_id: 'user-1', storage_path: 'user-1/r1.png' }], note)

    const report = await purgeUserResults(
      { storage: bucket, listRows: table.listRows, deleteRow: table.deleteRow },
      'user-1',
    )

    assert.equal(report.ok, false, 'the caller must not go on to delete the employee')
    assert.equal(report.rowsDeleted, 0)
    assert.ok(report.reasons.some(r => r.includes('storage is down')))
    // The row is still there, which is what makes a retry possible at all.
    assert.deepEqual(table.held.map(r => r.id), ['r1'])
    assert.ok(!calls.includes('deleteRow:r1'), 'the row must never go while its object is still there')
  })

  test('a failure partway leaves the EARLIER results deleted, and a retry finishes', async () => {
    // The purge spans Storage and Postgres with no transaction between them and
    // works one result at a time, so it cannot be atomic. What it can be is
    // repeatable: this proves both halves of that, because the route's wording
    // to an administrator depends on them.
    const { note } = recorder()
    const rows = [
      { id: 'r1', user_id: 'user-1', storage_path: 'user-1/r1.png' },
      { id: 'r2', user_id: 'user-1', storage_path: 'user-1/r2.png' },
    ]
    const held = new Set(['user-1/r1.png', 'user-1/r2.png'])
    let locked: string | null = 'user-1/r2.png'
    const table = fakeRows(rows, note)
    const storage = {
      async upload() { return { error: null } },
      async remove(paths: string[]) {
        if (locked && paths.includes(locked)) return { error: { message: 'object is locked' } }
        for (const p of paths) held.delete(p)
        return { error: null }
      },
      async list(prefix: string) {
        return {
          data: [...held].filter(p => p.startsWith(`${prefix}/`)).map(p => ({ name: p.slice(prefix.length + 1) })),
          error: null,
        }
      },
    }
    const deps = { storage, listRows: table.listRows, deleteRow: table.deleteRow }

    const first = await purgeUserResults(deps, 'user-1')
    assert.equal(first.ok, false)
    assert.equal(first.rowsDeleted, 1, 'the first result really was deleted')
    assert.equal(held.has('user-1/r1.png'), false, 'and nothing can put it back')
    assert.deepEqual(table.held.map(r => r.id), ['r2'], 'only the failed one is still listed')

    // Repeatable: the second run re-lists what is actually left and finishes.
    locked = null
    const second = await purgeUserResults(deps, 'user-1')
    assert.equal(second.ok, true)
    assert.equal(second.rows, 1, 'it works from what remains, not from what there was')
    assert.equal(second.rowsDeleted, 1)
    assert.deepEqual(table.held, [])
    assert.equal(held.size, 0)
  })

  test('a failed row delete is reported rather than swallowed', async () => {
    const { note } = recorder()
    const bucket = fakeBucket(['user-1/r1.png'], note)
    const table = fakeRows(
      [{ id: 'r1', user_id: 'user-1', storage_path: 'user-1/r1.png' }],
      note,
      { deleteError: 'row locked' },
    )

    const report = await purgeUserResults(
      { storage: bucket, listRows: table.listRows, deleteRow: table.deleteRow },
      'user-1',
    )

    assert.equal(report.ok, false)
    assert.ok(report.reasons.some(r => r.includes('row locked')))
  })

  test('a failed listing stops before anything is removed', async () => {
    const { calls, note } = recorder()
    const bucket = fakeBucket(['user-1/r1.png'], note)
    const table = fakeRows([], note, { listError: { message: 'connection reset', code: '08006' } })

    const report = await purgeUserResults(
      { storage: bucket, listRows: table.listRows, deleteRow: table.deleteRow },
      'user-1',
    )

    assert.equal(report.ok, false)
    assert.equal(calls.filter(c => c.startsWith('remove:')).length, 0)
    assert.equal(bucket.held.has('user-1/r1.png'), true)
  })

  test('a table that is not there yet is nothing to purge, not a failure', async () => {
    // The migration is not applied on every deployment at once. A member
    // deletion must not be blocked by a table that does not exist — nothing is
    // stored, so nothing can be orphaned.
    for (const error of [
      { message: 'relation "public.image_editor_results" does not exist', code: '42P01' },
      { message: "Could not find the table 'public.image_editor_results' in the schema cache", code: 'PGRST205' },
    ]) {
      const { calls, note } = recorder()
      const bucket = fakeBucket([], note)
      const table = fakeRows([], note, { listError: error })

      const report = await purgeUserResults(
        { storage: bucket, listRows: table.listRows, deleteRow: table.deleteRow },
        'user-1',
      )

      assert.equal(report.ok, true, `${error.code} must not block a deletion`)
      assert.equal(report.rows, 0)
      assert.equal(calls.filter(c => c.startsWith('remove:')).length, 0)
    }
  })

  test('a storage that reports removals it did not perform is bounded, not a spin', async () => {
    const { note } = recorder()
    const bucket = fakeBucket(
      Array.from({ length: 100 }, (_, i) => `user-1/o${i}.png`),
      note,
      { removeIsALie: true },
    )
    const table = fakeRows([], note)

    const report = await purgeUserResults(
      { storage: bucket, listRows: table.listRows, deleteRow: table.deleteRow },
      'user-1',
    )

    assert.equal(report.ok, false)
    assert.ok(report.reasons.some(r => r.includes('more than')))
  })

  test('an employee with no history is a clean no-op', async () => {
    const { calls, note } = recorder()
    const bucket = fakeBucket([], note)
    const table = fakeRows([], note)

    const report = await purgeUserResults(
      { storage: bucket, listRows: table.listRows, deleteRow: table.deleteRow },
      'user-1',
    )

    assert.deepEqual(report, { ok: true, rows: 0, rowsDeleted: 0, orphanObjects: 0, reasons: [] })
    assert.equal(calls.filter(c => c.startsWith('remove:')).length, 0)
  })
})
