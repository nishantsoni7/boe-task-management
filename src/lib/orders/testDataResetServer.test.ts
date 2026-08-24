/**
 * THE STORAGE HALF OF A MODULE RESET, and the two ways it can go wrong.
 *
 * A module reset removes objects from four buckets. Two of the failures that
 * matter are silent:
 *
 *   * SWEEPING TOO MUCH. `submissions/{id}` is a prefix, and a bucket contains
 *     other submissions whose ids start with the same characters. A sweep that
 *     matched on string prefix rather than on the exact folder would take a
 *     neighbouring PI's workbook with it, and nothing would say so.
 *   * REPORTING TOO MUCH. A `.remove()` can delete objects and then lose its
 *     response. Reading "nothing was confirmed removed" as "nothing was
 *     removed" is what unfreezes a module whose files are already gone.
 *
 * So these tests are mostly about CONFINEMENT and about the difference between
 * attempted and confirmed, rather than about the happy path.
 *
 * NO REAL NETWORK. The fake below records what was asked of it.
 *
 * Run:
 *   npx tsx --test src/lib/orders/testDataResetServer.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import { parseResetManifest, removeResetStorage } from './testDataResetServer'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const ORDER = '33333333-3333-4333-8333-333333333333'
const REQUEST = '44444444-4444-4444-8444-444444444444'

type Entry = { name: string; id: string | null }
const folder = (name: string): Entry => ({ name, id: null })
const file = (name: string): Entry => ({ name, id: `id-${name}` })

type FakeOptions = {
  tree?: Record<string, Entry[]>
  attachments?: Record<string, string[]>
  removeFails?: (bucket: string, batch: string[]) => boolean
  unreported?: Set<string>
}

function fake(options: FakeOptions = {}) {
  const listed: { bucket: string; prefix: string }[] = []
  const removed: { bucket: string; batch: string[] }[] = []
  const tree = options.tree ?? {}

  const client = {
    from(table: string) {
      return {
        select() {
          return {
            eq(_column: string, value: string) {
              const paths = options.attachments?.[value] ?? []
              return Promise.resolve({
                data: paths.map(storage_path => ({ storage_path })),
                error: table === '__fail__' ? { message: 'no' } : null,
              })
            },
          }
        },
      }
    },
    storage: {
      from(bucket: string) {
        return {
          async list(prefix: string, opts: { limit: number; offset: number }) {
            listed.push({ bucket, prefix })
            const entries = tree[prefix] ?? []
            return { data: entries.slice(opts.offset, opts.offset + opts.limit), error: null }
          },
          async remove(batch: string[]) {
            removed.push({ bucket, batch })
            if (options.removeFails?.(bucket, batch)) {
              return { data: null, error: { message: 'denied' } }
            }
            return {
              data: batch
                .filter(name => !options.unreported?.has(name))
                .map(name => ({ name })),
              error: null,
            }
          },
        }
      },
    },
  } as unknown as SupabaseClient

  return { client, listed, removed }
}

// ── The manifest cannot be enlarged ──────────────────────────────────────────

describe('the manifest is the database’s, and nothing can add to it', () => {
  test('an id that is not a uuid never becomes a prefix', () => {
    const manifest = parseResetManifest({
      submissions: [A, 'not-a-uuid', '', '../../etc', `${A} or 1=1`, null, 7],
      orders: [ORDER, 'orders/*'],
      order_requests: [REQUEST, {}],
    })
    assert.deepEqual(manifest.submissions, [A])
    assert.deepEqual(manifest.orders, [ORDER])
    assert.deepEqual(manifest.order_requests, [REQUEST])
  })

  test('a proof key that climbs out of its bucket is dropped', () => {
    const manifest = parseResetManifest({
      payment_proofs: [
        `${A}/proof.pdf`,
        '../payment-proofs/someone-else.pdf',
        '/absolute/key.pdf',
        'a/../../b.pdf',
        '',
        42,
      ],
    })
    assert.deepEqual(manifest.payment_proofs, [`${A}/proof.pdf`])
  })

  test('duplicates are collapsed, so no key is submitted twice', () => {
    const manifest = parseResetManifest({
      submissions: [A, A, B],
      payment_proofs: ['k/1.pdf', 'k/1.pdf'],
    })
    assert.deepEqual(manifest.submissions, [A, B])
    assert.deepEqual(manifest.payment_proofs, ['k/1.pdf'])
  })

  test('a manifest that is absent, null or the wrong shape sweeps nothing', () => {
    for (const value of [undefined, null, 'everything', 42, [], { submissions: 'all' }]) {
      const manifest = parseResetManifest(value)
      assert.deepEqual(manifest.submissions, [])
      assert.deepEqual(manifest.orders, [])
      assert.deepEqual(manifest.order_requests, [])
      assert.deepEqual(manifest.payment_proofs, [])
    }
  })
})

// ── Confinement ──────────────────────────────────────────────────────────────

describe('only the objects the manifest names are ever removed', () => {
  /** Two PI folders whose ids share a leading run of characters. */
  const collidingTree = (): Record<string, Entry[]> => ({
    [`submissions/${A}`]: [folder('original')],
    [`submissions/${A}/original`]: [file('mine.xlsx')],
    // A NEIGHBOUR. Its key starts with the same prefix string plus a suffix, and
    // a sweep that matched on `startsWith` alone would take it.
    [`submissions/${A}-copy`]: [folder('original')],
    [`submissions/${A}-copy/original`]: [file('theirs.xlsx')],
    [`submissions/${B}`]: [folder('original')],
    [`submissions/${B}/original`]: [file('other.xlsx')],
  })

  test('A PREFIX COLLISION IS NOT A MATCH: the look-alike folder survives', async () => {
    const f = fake({ tree: collidingTree() })
    const outcome = await removeResetStorage(f.client, parseResetManifest({ submissions: [A] }))

    const keys = f.removed.flatMap(call => call.batch)
    assert.ok(keys.includes(`submissions/${A}/original/mine.xlsx`))
    for (const key of keys) {
      assert.ok(key.startsWith(`submissions/${A}/`), `${key} is not this submission's`)
    }
    assert.equal(outcome.failed.length, 0)
  })

  test('and a neighbouring submission is never even listed', async () => {
    const f = fake({ tree: collidingTree() })
    await removeResetStorage(f.client, parseResetManifest({ submissions: [A] }))
    for (const call of f.listed) {
      assert.ok(call.prefix.startsWith(`submissions/${A}`), `${call.prefix} was listed`)
      assert.ok(!call.prefix.startsWith(`submissions/${A}-copy`))
      assert.ok(!call.prefix.startsWith(`submissions/${B}`))
    }
  })

  test('an Order prefix never reaches into a PI prefix, or the other way', async () => {
    const f = fake({
      tree: {
        [`orders/${ORDER}`]: [folder('versions')],
        [`orders/${ORDER}/versions`]: [file('confirmed.pdf')],
        [`submissions/${A}`]: [folder('original')],
        [`submissions/${A}/original`]: [file('mine.xlsx')],
      },
    })
    await removeResetStorage(f.client, parseResetManifest({ orders: [ORDER] }))
    for (const key of f.removed.flatMap(call => call.batch)) {
      assert.ok(key.startsWith(`orders/${ORDER}/`), `${key} is outside the Order prefix`)
    }
  })

  test('every bucket the reset touches is one of its own four', async () => {
    const f = fake({
      tree: {
        [`submissions/${A}`]: [file('w.xlsx')],
        [`orders/${ORDER}`]: [file('o.pdf')],
      },
      attachments: { [REQUEST]: [`${REQUEST}/a.pdf`] },
    })
    await removeResetStorage(f.client, parseResetManifest({
      submissions: [A], orders: [ORDER], order_requests: [REQUEST],
      payment_proofs: ['pay-1/proof.pdf'],
    }))
    const buckets = new Set([...f.removed, ...f.listed].map(call => call.bucket))
    for (const bucket of buckets) {
      assert.ok(
        ['order-files', 'order-request-attachments', 'payment-proofs'].includes(bucket),
        `${bucket} is not a bucket this reset owns`)
    }
  })

  test('payment proofs are removed by EXACT KEY, never by prefix sweep', async () => {
    const f = fake({})
    await removeResetStorage(f.client, parseResetManifest({
      payment_proofs: ['pay-1/proof.pdf', 'pay-2/receipt.pdf'],
    }))
    const proofCalls = f.removed.filter(call => call.bucket === 'payment-proofs')
    assert.equal(proofCalls.length, 1, 'one batch, not one call per key')
    assert.deepEqual(proofCalls[0].batch, ['pay-1/proof.pdf', 'pay-2/receipt.pdf'])
    // The bucket is shared with payments this reset does not own, so it must
    // never be listed — listing is how a prefix sweep starts.
    assert.ok(!f.listed.some(call => call.bucket === 'payment-proofs'),
      'payment-proofs is never enumerated')
  })
})

// ── Attempted is not confirmed ───────────────────────────────────────────────

describe('a destructive request that was ISSUED is never reported as none', () => {
  test('nothing to remove means no request, and nothing to be uncertain about', async () => {
    const f = fake({})
    const outcome = await removeResetStorage(f.client, parseResetManifest({}))
    assert.equal(outcome.removalAttempted, false, 'so the claim can safely be released')
    assert.equal(outcome.removed, 0)
    assert.deepEqual(outcome.failed, [])
  })

  test('a remove that returns an error still counts as attempted', async () => {
    const f = fake({
      tree: { [`submissions/${A}`]: [file('w.xlsx')] },
      removeFails: () => true,
    })
    const outcome = await removeResetStorage(f.client, parseResetManifest({ submissions: [A] }))
    assert.equal(outcome.removalAttempted, true, 'the objects may already be gone')
    assert.ok(outcome.failed.length > 0)
  })

  test('a proof batch that fails is reported, and does not stop the others', async () => {
    const f = fake({
      removeFails: (_bucket, batch) => batch.includes('bad/1.pdf'),
    })
    const outcome = await removeResetStorage(f.client, parseResetManifest({
      payment_proofs: ['bad/1.pdf'],
    }))
    assert.deepEqual(outcome.failed, ['bad/1.pdf'])
    assert.equal(outcome.removalAttempted, true)
  })

  test('the callback fires for every bucket, so a throw cannot hide the attempt', async () => {
    let calls = 0
    const f = fake({
      tree: { [`submissions/${A}`]: [file('w.xlsx')], [`orders/${ORDER}`]: [file('o.pdf')] },
      attachments: { [REQUEST]: [`${REQUEST}/a.pdf`] },
    })
    await removeResetStorage(
      f.client,
      parseResetManifest({
        submissions: [A], orders: [ORDER], order_requests: [REQUEST],
        payment_proofs: ['p/1.pdf'],
      }),
      { onRemoveAttempt: () => { calls += 1 } })
    assert.ok(calls >= 4, `expected an attempt marked in each bucket, saw ${calls}`)
  })

  test('a callback that throws does not abort the sweep', async () => {
    const f = fake({ tree: { [`submissions/${A}`]: [file('w.xlsx')] } })
    const outcome = await removeResetStorage(
      f.client, parseResetManifest({ submissions: [A] }),
      { onRemoveAttempt: () => { throw new Error('bookkeeping') } })
    assert.equal(outcome.failed.length, 0)
    assert.equal(outcome.removalAttempted, true)
  })
})

// ── A missing object is the outcome being asked for ──────────────────────────

describe('a retry over a partly-cleared module converges', () => {
  test('an object already gone is not a failure', async () => {
    // The second attempt at an interrupted reset: the bucket is empty, the
    // recorded proof key is submitted anyway, and storage reports nothing back.
    const f = fake({ unreported: new Set(['p/1.pdf']) })
    const outcome = await removeResetStorage(f.client, parseResetManifest({
      payment_proofs: ['p/1.pdf'],
    }))
    assert.deepEqual(outcome.failed, [], 'absent is the outcome being asked for')
    assert.equal(outcome.removed, 0, 'and nothing is claimed to have gone')
  })

  test('an empty prefix is a clean no-op rather than an error', async () => {
    const f = fake({ tree: {} })
    const outcome = await removeResetStorage(f.client, parseResetManifest({
      submissions: [A], orders: [ORDER],
    }))
    assert.deepEqual(outcome.failed, [])
    assert.equal(outcome.removed, 0)
  })

  test('a partly-swept module finishes on the second pass', async () => {
    const tree = {
      [`submissions/${A}`]: [folder('original')],
      [`submissions/${A}/original`]: [file('left.xlsx')],
    }
    const first = fake({ tree })
    const outcome = await removeResetStorage(first.client, parseResetManifest({
      submissions: [A, B], payment_proofs: ['p/1.pdf'],
    }))
    assert.deepEqual(outcome.failed, [])
    assert.equal(outcome.removed, 2, 'the surviving workbook and the proof')
  })
})
