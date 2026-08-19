/**
 * Order Request attachment removal: what it did, not what it confirmed.
 *
 * WHY THIS FILE EXISTS. This helper is one half of a destructive sequence that
 * spans a database transaction it cannot join — Test Data Cleanup removes these
 * objects between taking a claim and deleting the rows. The caller has to decide,
 * from what this returns, whether it is safe to give the record back.
 *
 * `removed` cannot answer that. It is what storage CONFIRMED, and a remove
 * request can delete every key it was given and then lose its response to a
 * network or gateway failure — leaving `removed` empty while the files are gone.
 * A caller reading that as "nothing was removed" unfreezes a record whose
 * attachments no longer exist.
 *
 * So the helper reports `removalAttempted` — set before the request goes out —
 * and offers a callback for the case where it never returns at all.
 *
 * NO REAL NETWORK. The fake below records what was asked for.
 *
 * Run:
 *   npx tsx --test src/lib/orderRequestAttachmentsServer.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import { removeAllObjectsForRequest } from './orderRequestAttachmentsServer'

const REQUEST = '22222222-2222-4222-8222-222222222222'

type FakeOptions = {
  /** The storage_path rows the database holds for this request. */
  paths: string[]
  /** The metadata read fails. */
  selectFails?: boolean
  /** The remove request returns an error. */
  removeFails?: boolean
  /** The remove request THROWS — the lost-response case. */
  removeThrows?: boolean
  /** Keys the remove call should NOT report back. */
  unreported?: Set<string>
}

function fakeClient(options: FakeOptions) {
  const removeCalls: string[][] = []
  const client = {
    from() {
      return {
        select() {
          return {
            async eq() {
              if (options.selectFails) return { data: null, error: { message: 'boom' } }
              return { data: options.paths.map(storage_path => ({ storage_path })), error: null }
            },
          }
        },
      }
    },
    storage: {
      from() {
        return {
          async remove(paths: string[]) {
            removeCalls.push([...paths])
            await Promise.resolve()
            if (options.removeThrows) throw new Error('socket hang up')
            if (options.removeFails) return { data: null, error: { message: 'nope' } }
            const reported = paths.filter(p => !options.unreported?.has(p))
            return { data: reported.map(name => ({ name })), error: null }
          },
        }
      },
    },
  } as unknown as SupabaseClient
  return { client, removeCalls }
}

describe('the paths are the database’s, never the caller’s', () => {
  test('it reads storage_path rows and removes exactly those', async () => {
    const paths = ['requests/a.pdf', 'requests/b.pdf']
    const fake = fakeClient({ paths })
    const result = await removeAllObjectsForRequest(fake.client, REQUEST)
    assert.deepEqual(fake.removeCalls, [paths])
    assert.deepEqual(result.removed, paths)
    assert.equal(result.count, 2)
  })

  test('a metadata read failure throws before anything destructive', async () => {
    const fake = fakeClient({ paths: ['requests/a.pdf'], selectFails: true })
    await assert.rejects(() => removeAllObjectsForRequest(fake.client, REQUEST))
    assert.equal(fake.removeCalls.length, 0,
      'the caller may safely give the record back: nothing was issued')
  })
})

describe('it reports whether a destructive request was ISSUED', () => {
  test('no attachments means no request', async () => {
    const fake = fakeClient({ paths: [] })
    const result = await removeAllObjectsForRequest(fake.client, REQUEST)
    assert.equal(result.removalAttempted, false)
    assert.equal(fake.removeCalls.length, 0)
  })

  test('a metadata read failure leaves nothing attempted', async () => {
    const fake = fakeClient({ paths: ['requests/a.pdf'], selectFails: true })
    await assert.rejects(() => removeAllObjectsForRequest(fake.client, REQUEST))
    assert.equal(fake.removeCalls.length, 0)
  })

  test('a remove that THROWS still reports the attempt', async () => {
    // The objects may be gone; the response is not. This is the case that makes
    // "not confirmed removed" and "nothing removed" different facts.
    const fake = fakeClient({ paths: ['requests/a.pdf'], removeThrows: true })
    await assert.rejects(() => removeAllObjectsForRequest(fake.client, REQUEST))
    assert.equal(fake.removeCalls.length, 1, 'a destructive request went out')
  })

  test('the callback fires BEFORE the request, so a throw cannot hide it', async () => {
    const fake = fakeClient({ paths: ['requests/a.pdf'], removeThrows: true })
    let attemptedAt = -1
    await assert.rejects(() => removeAllObjectsForRequest(fake.client, REQUEST, {
      onRemoveAttempt: () => { attemptedAt = fake.removeCalls.length },
    }))
    assert.equal(attemptedAt, 0,
      'the callback ran while zero requests had been recorded — i.e. before the first')
  })

  test('a remove that returns an error still reports the attempt', async () => {
    const fake = fakeClient({ paths: ['requests/a.pdf'], removeFails: true })
    const result = await removeAllObjectsForRequest(fake.client, REQUEST)
    assert.equal(result.removalAttempted, true)
    assert.deepEqual(result.removed, [])
    assert.deepEqual(result.failed, ['requests/a.pdf'])
  })

  test('a response confirming NOTHING still reports the attempt', async () => {
    const fake = fakeClient({
      paths: ['requests/a.pdf'], unreported: new Set(['requests/a.pdf']),
    })
    const result = await removeAllObjectsForRequest(fake.client, REQUEST)
    assert.equal(result.removalAttempted, true, 'the request went out')
    assert.deepEqual(result.removed, [], 'and confirmed nothing')
    assert.deepEqual(result.failed, ['requests/a.pdf'])
  })

  test('a callback that throws does not abort the removal', async () => {
    const fake = fakeClient({ paths: ['requests/a.pdf'] })
    const result = await removeAllObjectsForRequest(fake.client, REQUEST, {
      onRemoveAttempt: () => { throw new Error('caller bookkeeping blew up') },
    })
    assert.equal(result.removalAttempted, true)
    assert.deepEqual(result.removed, ['requests/a.pdf'])
  })

  test('a successful removal reports the attempt too', async () => {
    const fake = fakeClient({ paths: ['requests/a.pdf'] })
    const result = await removeAllObjectsForRequest(fake.client, REQUEST)
    assert.equal(result.removalAttempted, true)
    assert.deepEqual(result.failed, [])
  })

  test('it is idempotent: a retry over already-gone keys converges', async () => {
    // Supabase reports an absent key as removed, so a second attempt after a
    // partial success completes rather than failing forever.
    const fake = fakeClient({ paths: ['requests/a.pdf', 'requests/b.pdf'] })
    const first = await removeAllObjectsForRequest(fake.client, REQUEST)
    const second = await removeAllObjectsForRequest(fake.client, REQUEST)
    assert.deepEqual(first.failed, [])
    assert.deepEqual(second.failed, [])
  })
})
