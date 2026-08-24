/**
 * The PI storage sweep: fast, bounded, complete, and confined.
 *
 * WHY THIS FILE EXISTS. The sweep recursed depth-first and awaited each child
 * folder inline, which turned a shallow tree into one long chain of network
 * round trips — 27 to 39 of them for an ordinary twelve-product PI, before the
 * single remove even started. The dialog sat on "Deleting…" for the whole of it.
 *
 * The fix is concurrency, and concurrency is exactly where a sweep stops being
 * obviously correct: a walk that exits early reports fewer files than exist, and
 * a short answer here means the record is deleted while its workbook stays in
 * the bucket. So these tests are mostly about COMPLETENESS and BOUNDS rather
 * than speed — every directory listed, every page read, every failure fatal,
 * nothing outside the prefix touched, and never more requests in flight than the
 * configured ceiling.
 *
 * NO REAL NETWORK AND NO REAL CLOCK. The fake below records what was asked for
 * and when, so "these two directories were listed concurrently" is asserted from
 * overlapping call windows rather than from elapsed internet time.
 *
 * Run:
 *   npx tsx --test src/lib/orders/submissionFilesServer.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  LIST_CONCURRENCY,
  MAX_DEPTH,
  PAGE,
  REMOVE_BATCH,
  REMOVE_CONCURRENCY,
  mapWithLimit,
  removeAllObjectsForSubmission,
} from './submissionFilesServer'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SUBMISSION = '11111111-1111-4111-8111-111111111111'
const PREFIX = `submissions/${SUBMISSION}`

/** One storage entry as .list() returns it: a folder has a null id. */
type Entry = { name: string; id: string | null }
const folder = (name: string): Entry => ({ name, id: null })
const file = (name: string): Entry => ({ name, id: `id-${name}` })

type FakeOptions = {
  /** prefix → its entries. A prefix that is absent lists as empty. */
  tree: Record<string, Entry[]>
  /** Prefixes whose listing must fail. */
  listFails?: Set<string>
  /** Batches (by first key) whose remove must fail. */
  removeFails?: (batch: string[]) => boolean
  /**
   * Batches whose remove request THROWS — the lost-response case.
   *
   * The server may have deleted every key in the batch before the connection
   * died. The client learns nothing, which is precisely why a caller may not
   * read an absent confirmation as "nothing was removed".
   */
  removeThrows?: (batch: string[]) => boolean
  /** Keys the remove call should NOT report back as removed. */
  unreported?: Set<string>
  /** Milliseconds each list call takes. */
  listDelayMs?: number
}

type Fake = {
  client: SupabaseClient
  listCalls: { prefix: string; offset: number }[]
  removeCalls: string[][]
  /** The greatest number of list calls that were ever in flight together. */
  peakConcurrency: number
  /** How many list calls are running right now. */
  inFlight: number
}

function fakeStorage(options: FakeOptions): Fake {
  const listCalls: { prefix: string; offset: number }[] = []
  const removeCalls: string[][] = []
  let inFlight = 0
  let peakConcurrency = 0

  const client = {
    storage: {
      from() {
        return {
          async list(prefix: string, opts: { limit: number; offset: number }) {
            inFlight += 1
            peakConcurrency = Math.max(peakConcurrency, inFlight)
            listCalls.push({ prefix, offset: opts.offset })
            try {
              if (options.listDelayMs) {
                await new Promise(resolve => setTimeout(resolve, options.listDelayMs))
              } else {
                await Promise.resolve()
              }
              if (options.listFails?.has(prefix)) {
                return { data: null, error: { message: 'boom' } }
              }
              const all = options.tree[prefix] ?? []
              return { data: all.slice(opts.offset, opts.offset + opts.limit), error: null }
            } finally {
              inFlight -= 1
            }
          },
          async remove(paths: string[]) {
            removeCalls.push([...paths])
            await Promise.resolve()
            if (options.removeThrows?.(paths)) {
              // The objects may well be gone; the response is not.
              throw new Error('socket hang up')
            }
            if (options.removeFails?.(paths)) return { data: null, error: { message: 'nope' } }
            const reported = paths.filter(p => !options.unreported?.has(p))
            return { data: reported.map(name => ({ name })), error: null }
          },
        }
      },
    },
  } as unknown as SupabaseClient

  return {
    client, listCalls, removeCalls,
    get peakConcurrency() { return peakConcurrency },
    get inFlight() { return inFlight },
  }
}

/** The real shape a PI makes: one workbook, and images nested per item and role. */
function piTree(items: number, customizationsPerItem = 1): Record<string, Entry[]> {
  const tree: Record<string, Entry[]> = {
    [PREFIX]: [folder('original'), folder('images')],
    [`${PREFIX}/original`]: [file('abcd-Client PI.xlsx')],
    [`${PREFIX}/images`]: [],
  }
  for (let i = 0; i < items; i += 1) {
    const item = `item-${i}`
    tree[`${PREFIX}/images`].push(folder(item))
    tree[`${PREFIX}/images/${item}`] = [folder('representative')]
    tree[`${PREFIX}/images/${item}/representative`] = [file(`0-${'a'.repeat(64)}.png`)]
    if (customizationsPerItem > 0) {
      tree[`${PREFIX}/images/${item}`].push(folder('customization'))
      tree[`${PREFIX}/images/${item}/customization`] =
        Array.from({ length: customizationsPerItem }, (_, c) => file(`${c}-${'b'.repeat(64)}.png`))
    }
  }
  return tree
}

// ── Concurrency ───────────────────────────────────────────────────────────────

describe('independent directories are listed concurrently', () => {
  test('sibling folders overlap instead of queueing behind one another', async () => {
    const fake = fakeStorage({ tree: piTree(12), listDelayMs: 5 })
    await removeAllObjectsForSubmission(fake.client, SUBMISSION, [])
    assert.ok(fake.peakConcurrency > 1,
      'the whole defect was that this was always exactly 1')
  })

  test('with more siblings than the ceiling, the ceiling is actually reached', async () => {
    // Proves genuine parallelism rather than an accidental two. 12 products make
    // 12 item folders and ~24 role folders, both well past the limit.
    const fake = fakeStorage({ tree: piTree(12), listDelayMs: 5 })
    await removeAllObjectsForSubmission(fake.client, SUBMISSION, [])
    assert.equal(fake.peakConcurrency, LIST_CONCURRENCY)
  })

  test('and the ceiling is never exceeded', async () => {
    // 24 sibling role folders at the deepest level, far more than the limit.
    const fake = fakeStorage({ tree: piTree(12), listDelayMs: 5 })
    await removeAllObjectsForSubmission(fake.client, SUBMISSION, [])
    assert.ok(fake.peakConcurrency <= LIST_CONCURRENCY,
      `peak ${fake.peakConcurrency} exceeded the limit of ${LIST_CONCURRENCY}`)
  })

  test('the limit is small and fixed, not derived from the number of products', async () => {
    assert.equal(LIST_CONCURRENCY, 8)
    const small = fakeStorage({ tree: piTree(2), listDelayMs: 5 })
    await removeAllObjectsForSubmission(small.client, SUBMISSION, [])
    const large = fakeStorage({ tree: piTree(40), listDelayMs: 1 })
    await removeAllObjectsForSubmission(large.client, SUBMISSION, [])
    assert.ok(large.peakConcurrency <= LIST_CONCURRENCY)
    assert.ok(small.peakConcurrency <= LIST_CONCURRENCY)
  })

  test('mapWithLimit never runs more than the ceiling, and returns in order', async () => {
    let inFlight = 0
    let peak = 0
    const items = Array.from({ length: 50 }, (_, i) => i)
    const result = await mapWithLimit(items, 6, async n => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise(resolve => setTimeout(resolve, 2))
      inFlight -= 1
      return n * 2
    })
    assert.equal(peak, 6)
    assert.deepEqual(result, items.map(n => n * 2),
      'results keep their input order however they interleave')
  })

  test('mapWithLimit on an empty list does nothing at all', async () => {
    let calls = 0
    const result = await mapWithLimit([], 8, async () => { calls += 1; return 1 })
    assert.deepEqual(result, [])
    assert.equal(calls, 0)
  })
})

// ── Completeness ──────────────────────────────────────────────────────────────

describe('the sweep is complete, which matters more than it is fast', () => {
  test('every file in a real twelve-product tree is found', async () => {
    const fake = fakeStorage({ tree: piTree(12) })
    const result = await removeAllObjectsForSubmission(fake.client, SUBMISSION, [])
    // 1 workbook + 12 representative + 12 customization
    assert.equal(result.found.length, 25)
    assert.equal(result.removed.length, 25)
    assert.deepEqual(result.failed, [])
  })

  test('nested folders are traversed to the leaves', async () => {
    const fake = fakeStorage({ tree: piTree(3) })
    const result = await removeAllObjectsForSubmission(fake.client, SUBMISSION, [])
    assert.ok(result.found.some(p => p.includes('/images/item-0/representative/')))
    assert.ok(result.found.some(p => p.includes('/images/item-2/customization/')))
    assert.ok(result.found.some(p => p.includes('/original/')))
  })

  test('a directory of exactly one page is still read to its end', async () => {
    // PAGE entries means a full first page, so the pager must ask for a second.
    const tree: Record<string, Entry[]> = {
      [PREFIX]: [folder('images')],
      [`${PREFIX}/images`]: Array.from({ length: PAGE }, (_, i) => file(`f${i}.png`)),
    }
    const fake = fakeStorage({ tree })
    const result = await removeAllObjectsForSubmission(fake.client, SUBMISSION, [])
    assert.equal(result.found.length, PAGE)
    const offsets = fake.listCalls
      .filter(call => call.prefix === `${PREFIX}/images`).map(call => call.offset)
    assert.deepEqual(offsets, [0, PAGE], 'a full page must be followed by another request')
  })

  test('pagination reads every page of a directory larger than one page', async () => {
    const total = PAGE * 2 + 7
    const tree: Record<string, Entry[]> = {
      [PREFIX]: [folder('images')],
      [`${PREFIX}/images`]: Array.from({ length: total }, (_, i) => file(`f${i}.png`)),
    }
    const fake = fakeStorage({ tree })
    const result = await removeAllObjectsForSubmission(fake.client, SUBMISSION, [])
    assert.equal(result.found.length, total, 'not one object may be missed')
    const offsets = fake.listCalls
      .filter(call => call.prefix === `${PREFIX}/images`).map(call => call.offset)
    assert.deepEqual(offsets, [0, PAGE, PAGE * 2])
  })

  test('the depth guard is preserved', async () => {
    // A pathological tree that nests past the limit.
    const tree: Record<string, Entry[]> = {}
    let path = PREFIX
    for (let depth = 0; depth < MAX_DEPTH + 3; depth += 1) {
      tree[path] = [folder('deeper')]
      path = `${path}/deeper`
    }
    tree[path] = [file('buried.png')]

    const fake = fakeStorage({ tree })
    const result = await removeAllObjectsForSubmission(fake.client, SUBMISSION, [])
    assert.ok(result.stats.directories <= MAX_DEPTH + 1,
      'it stops descending rather than following a tree forever')
    assert.ok(!result.found.some(p => p.endsWith('buried.png')))
  })

  test('an empty prefix is a clean no-op, not an error', async () => {
    const fake = fakeStorage({ tree: {} })
    const result = await removeAllObjectsForSubmission(fake.client, SUBMISSION, [])
    assert.deepEqual(result.found, [])
    assert.deepEqual(result.removed, [])
    assert.deepEqual(result.failed, [])
    assert.equal(fake.removeCalls.length, 0, 'nothing to remove means no remove request')
  })

  test('output ordering is deterministic', async () => {
    const fake = fakeStorage({ tree: piTree(5) })
    const first = await removeAllObjectsForSubmission(fake.client, SUBMISSION, [])
    const second = await removeAllObjectsForSubmission(
      fakeStorage({ tree: piTree(5) }).client, SUBMISSION, [])
    assert.deepEqual(first.found, second.found)
    assert.deepEqual([...first.found].sort(), first.found, 'and it is sorted')
  })
})

// ── Failure is total ──────────────────────────────────────────────────────────

describe('a listing that did not finish fails the whole sweep', () => {
  test('one failed directory rejects everything', async () => {
    const fake = fakeStorage({
      tree: piTree(6),
      listFails: new Set([`${PREFIX}/images/item-3/representative`]),
    })
    await assert.rejects(
      () => removeAllObjectsForSubmission(fake.client, SUBMISSION, []),
      /Could not list/)
  })

  test('and nothing is removed when the sweep failed', async () => {
    const fake = fakeStorage({
      tree: piTree(6),
      listFails: new Set([`${PREFIX}/images`]),
    })
    await assert.rejects(() => removeAllObjectsForSubmission(fake.client, SUBMISSION, []))
    assert.equal(fake.removeCalls.length, 0,
      'a partial listing must never be treated as complete')
  })

  test('a failure at the root fails immediately', async () => {
    const fake = fakeStorage({ tree: piTree(3), listFails: new Set([PREFIX]) })
    await assert.rejects(() => removeAllObjectsForSubmission(fake.client, SUBMISSION, []))
    assert.equal(fake.removeCalls.length, 0)
  })
})

// ── Confinement and deduplication ─────────────────────────────────────────────

describe('only this submission’s own objects are ever named', () => {
  test('a recorded path outside the prefix is never removed', async () => {
    const fake = fakeStorage({ tree: piTree(1) })
    const result = await removeAllObjectsForSubmission(fake.client, SUBMISSION, [
      'submissions/22222222-2222-4222-8222-222222222222/original/other.xlsx',
      'orders/99/versions/1/approved.xlsx',
      '../../etc/passwd',
      `${PREFIX}-lookalike/original/x.xlsx`,
    ])
    for (const batch of fake.removeCalls) {
      for (const path of batch) {
        assert.ok(path.startsWith(`${PREFIX}/`), `${path} is not this submission's`)
      }
    }
    assert.ok(!result.found.some(p => !p.startsWith(`${PREFIX}/`)))
  })

  test('a recorded path and the same swept path are one entry, not two', async () => {
    const tree = piTree(1)
    const workbook = `${PREFIX}/original/abcd-Client PI.xlsx`
    const fake = fakeStorage({ tree })
    const result = await removeAllObjectsForSubmission(
      fake.client, SUBMISSION, [workbook, workbook])
    assert.equal(result.found.filter(p => p === workbook).length, 1)
    const submitted = fake.removeCalls.flat()
    assert.equal(new Set(submitted).size, submitted.length, 'no key is submitted twice')
  })

  test('a recorded path the sweep did not see is still attempted', async () => {
    // Belt and braces: the record named it, so it is asked for even though the
    // bucket did not list it.
    const stale = `${PREFIX}/original/older-workbook.xlsx`
    const fake = fakeStorage({ tree: piTree(1) })
    const result = await removeAllObjectsForSubmission(fake.client, SUBMISSION, [stale])
    assert.ok(result.found.includes(stale))
    assert.ok(fake.removeCalls.flat().includes(stale))
  })
})

// ── Batched removal ───────────────────────────────────────────────────────────

describe('objects are removed in bounded batches', () => {
  test('a small PI is one request, not one per file', async () => {
    const fake = fakeStorage({ tree: piTree(12) })
    const result = await removeAllObjectsForSubmission(fake.client, SUBMISSION, [])
    assert.equal(fake.removeCalls.length, 1)
    assert.equal(result.stats.batches, 1)
    assert.ok(result.found.length > 1, 'and there really were several files')
  })

  test('a large PI is split into batches of the configured size', async () => {
    const tree: Record<string, Entry[]> = {
      [PREFIX]: [folder('images')],
      [`${PREFIX}/images`]: Array.from({ length: 250 }, (_, i) => file(`f${i}.png`)),
    }
    const fake = fakeStorage({ tree })
    const result = await removeAllObjectsForSubmission(fake.client, SUBMISSION, [])
    assert.equal(result.found.length, 250)
    assert.equal(result.stats.batches, 3)
    assert.deepEqual(fake.removeCalls.map(b => b.length), [REMOVE_BATCH, REMOVE_BATCH, 50])
    for (const batch of fake.removeCalls) {
      assert.ok(batch.length <= REMOVE_BATCH)
    }
  })

  test('the batches themselves are bounded, not all fired at once', async () => {
    assert.equal(REMOVE_BATCH, 100)
    assert.equal(REMOVE_CONCURRENCY, 4)
    assert.ok(REMOVE_CONCURRENCY < REMOVE_BATCH)
  })

  test('every batch is accounted for across the whole set', async () => {
    const tree: Record<string, Entry[]> = {
      [PREFIX]: [folder('images')],
      [`${PREFIX}/images`]: Array.from({ length: 250 }, (_, i) => file(`f${i}.png`)),
    }
    const fake = fakeStorage({ tree })
    const result = await removeAllObjectsForSubmission(fake.client, SUBMISSION, [])
    assert.equal(result.removed.length, 250)
    assert.deepEqual(result.failed, [])
    assert.deepEqual(fake.removeCalls.flat().sort(), result.found)
  })
})

describe('a partial removal is reported accurately, and stays retryable', () => {
  test('only the failed batch’s keys are failures', async () => {
    const tree: Record<string, Entry[]> = {
      [PREFIX]: [folder('images')],
      [`${PREFIX}/images`]: Array.from({ length: 250 }, (_, i) => file(`f${String(i).padStart(3, '0')}.png`)),
    }
    // The batch containing the very last key fails; the other two succeed.
    const fake = fakeStorage({
      tree,
      removeFails: batch => batch.some(p => p.endsWith('f249.png')),
    })
    const result = await removeAllObjectsForSubmission(fake.client, SUBMISSION, [])
    assert.equal(result.failed.length, 50, 'exactly the failed batch')
    assert.equal(result.removed.length, 200, 'and the rest really did go')
    assert.equal(result.found.length, 250)
    for (const path of result.failed) assert.ok(!result.removed.includes(path))
  })

  test('a key the API did not report is a failure while it is still in the bucket', async () => {
    const tree = piTree(2)
    const missed = `${PREFIX}/images/item-0/representative/0-${'a'.repeat(64)}.png`
    const fake = fakeStorage({ tree, unreported: new Set([missed]) })
    const result = await removeAllObjectsForSubmission(fake.client, SUBMISSION, [])
    assert.deepEqual(result.failed, [missed])
  })

  test('A RETRY CONVERGES: a recorded key already gone is not a failure', async () => {
    // THE BUG THIS PINS DOWN. The record always names its workbook, so the
    // workbook path is always submitted. On the second attempt at a
    // partly-completed deletion the object is already gone, the storage API
    // therefore does not list it as removed, and counting that as a failure
    // meant the retry could never succeed — the deletion would fail forever.
    const gone = `${PREFIX}/original/already-deleted.xlsx`
    const tree: Record<string, Entry[]> = {
      [PREFIX]: [folder('images')],
      [`${PREFIX}/images`]: [file('still-here.png')],
    }
    const fake = fakeStorage({ tree, unreported: new Set([gone]) })
    const result = await removeAllObjectsForSubmission(fake.client, SUBMISSION, [gone])

    assert.ok(result.found.includes(gone), 'it is still reported as one of the keys')
    assert.deepEqual(result.failed, [],
      'but an object that is already absent is the outcome being asked for')
    assert.ok(result.removed.includes(`${PREFIX}/images/still-here.png`))
  })
})

// ── Resuming an interrupted deletion ──────────────────────────────────────────

/**
 * THE STATE A CRASHED, CANCELLED OR REFUSED DELETION LEAVES BEHIND.
 *
 * The whole recovery design rests on one property of this sweep: run it again
 * over a PI it has already partly cleaned and it converges instead of failing.
 * The tests above prove the rule in the abstract — a recorded key the sweep did
 * not find is already gone, not a failure. These prove it in the shapes a real
 * interrupted deletion actually leaves: the workbook removed and the pictures
 * not, one picture removed and the rest not, and everything already gone.
 *
 * "ALREADY REMOVED" IS CONCLUDED FROM THE EXACT KEY, never from the prefix. Each
 * case below asks for the precise path the database recorded and asserts that
 * the conclusion was drawn about that path alone.
 */
describe('a second attempt at a partly-completed deletion converges', () => {
  const WORKBOOK = `${PREFIX}/original/abcd-Client PI.xlsx`
  const IMAGE = (item: number) =>
    `${PREFIX}/images/item-${item}/representative/0-${'a'.repeat(64)}.png`

  /** The tree a PI leaves once some of its objects have gone. */
  const partial = (keep: string[]): Record<string, Entry[]> => {
    const tree: Record<string, Entry[]> = { [PREFIX]: [] }
    const folders = new Set<string>()
    for (const key of keep) {
      const parts = key.slice(PREFIX.length + 1).split('/')
      let prefix = PREFIX
      for (const part of parts.slice(0, -1)) {
        if (!tree[prefix]) tree[prefix] = []
        if (!folders.has(`${prefix}/${part}`)) {
          folders.add(`${prefix}/${part}`)
          tree[prefix].push(folder(part))
        }
        prefix = `${prefix}/${part}`
      }
      if (!tree[prefix]) tree[prefix] = []
      tree[prefix].push(file(parts[parts.length - 1]))
    }
    return tree
  }

  const recorded = [WORKBOOK, IMAGE(0), IMAGE(1)]

  test('THE WORKBOOK IS ALREADY ABSENT: it is asked for, and it is not a failure', async () => {
    // `unreported` is how the fake models an object that is not there: the
    // storage API lists what it actually deleted, and a key that was already
    // gone is simply missing from the reply.
    const fake = fakeStorage({
      tree: partial([IMAGE(0), IMAGE(1)]), unreported: new Set([WORKBOOK]),
    })
    const result = await removeAllObjectsForSubmission(fake.client, SUBMISSION, recorded)

    assert.ok(fake.removeCalls.flat().includes(WORKBOOK),
      'the exact recorded key is submitted, so absence is established rather than assumed')
    assert.deepEqual(result.failed, [])
    assert.deepEqual(result.removed.sort(), [IMAGE(0), IMAGE(1)].sort())
  })

  test('ONE PRODUCT IMAGE IS ALREADY ABSENT: the rest still go', async () => {
    const fake = fakeStorage({
      tree: partial([WORKBOOK, IMAGE(1)]), unreported: new Set([IMAGE(0)]),
    })
    const result = await removeAllObjectsForSubmission(fake.client, SUBMISSION, recorded)

    assert.ok(fake.removeCalls.flat().includes(IMAGE(0)))
    assert.deepEqual(result.failed, [])
    assert.deepEqual(result.removed.sort(), [WORKBOOK, IMAGE(1)].sort())
  })

  test('EVERYTHING IS ALREADY ABSENT: a clean, complete no-op', async () => {
    // The state the stranded PI is in: the sweep succeeded, finalization was
    // refused, and the retry must reach finalization rather than stop here.
    const fake = fakeStorage({ tree: {}, unreported: new Set(recorded) })
    const result = await removeAllObjectsForSubmission(fake.client, SUBMISSION, recorded)

    assert.deepEqual(result.failed, [], 'nothing survives, which is the outcome asked for')
    assert.deepEqual(result.removed, [])
    assert.ok(result.removalAttempted, 'the keys were still asked for')
    assert.deepEqual(result.found.sort(), [...recorded].sort(),
      'and each exact recorded key was named, so absence is established, not assumed')
  })

  test('A GENUINE FAILURE IS STILL A FAILURE, and the retry is preserved', async () => {
    // The distinction the whole rule turns on: this object is in the bucket and
    // the remove did not take it, so finalization must not follow.
    const fake = fakeStorage({
      tree: partial([WORKBOOK, IMAGE(0)]),
      removeFails: () => true,
    })
    const result = await removeAllObjectsForSubmission(fake.client, SUBMISSION, recorded)

    for (const key of [WORKBOOK, IMAGE(0)]) {
      assert.ok(result.failed.includes(key), `${key} is still in the bucket and must be reported`)
    }
    assert.deepEqual(result.removed, [], 'nothing is claimed to have gone')
    assert.ok(result.removalAttempted,
      'so the reservation is kept and one more attempt finishes it')
  })

  test('NOTHING ORPHANED AFTER A SUCCESSFUL SWEEP: no key of this PI is left', async () => {
    const fake = fakeStorage({ tree: piTree(3, 2) })
    const result = await removeAllObjectsForSubmission(fake.client, SUBMISSION, [WORKBOOK])
    const every = Object.values(piTree(3, 2)).flat().length > 0
    assert.ok(every)

    const swept = new Set(result.removed)
    for (const [prefix, entries] of Object.entries(piTree(3, 2))) {
      for (const entry of entries) {
        if (entry.id === null) continue
        assert.ok(swept.has(`${prefix}/${entry.name}`),
          `${prefix}/${entry.name} would have been orphaned`)
      }
    }
    assert.deepEqual(result.failed, [])
  })

  test('AND NOTHING ELSE: a neighbouring submission’s objects are never listed or removed',
    async () => {
      const neighbour = 'submissions/22222222-2222-4222-8222-222222222222'
      const fake = fakeStorage({
        tree: {
          ...piTree(2),
          [neighbour]: [folder('original')],
          [`${neighbour}/original`]: [file('their-workbook.xlsx')],
          [`${PREFIX}-lookalike`]: [file('not-ours.xlsx')],
        },
      })
      const result = await removeAllObjectsForSubmission(
        fake.client, SUBMISSION, [WORKBOOK, `${neighbour}/original/their-workbook.xlsx`])

      for (const path of fake.removeCalls.flat()) {
        assert.ok(path.startsWith(`${PREFIX}/`), `${path} is not this submission's`)
      }
      assert.ok(!result.found.some(path => path.includes(neighbour)))
      assert.ok(fake.listCalls.every(call => call.prefix.startsWith(PREFIX)),
        'and no neighbouring prefix was so much as listed')
    })
})

// ── Diagnostics ───────────────────────────────────────────────────────────────

describe('the sweep reports what it did, in counts only', () => {
  test('directories, batches and durations come back', async () => {
    const fake = fakeStorage({ tree: piTree(4) })
    const result = await removeAllObjectsForSubmission(fake.client, SUBMISSION, [])
    // root + original + images + 4 items + 8 role folders
    assert.equal(result.stats.directories, fake.listCalls.length -
      fake.listCalls.filter((c, i, all) =>
        all.findIndex(o => o.prefix === c.prefix) !== i).length)
    assert.equal(result.stats.batches, 1)
    assert.ok(result.stats.listMs >= 0)
    assert.ok(result.stats.removeMs >= 0)
  })

  test('the stats carry no key, no id and no secret', async () => {
    const fake = fakeStorage({ tree: piTree(2) })
    const result = await removeAllObjectsForSubmission(fake.client, SUBMISSION, [])
    const serialized = JSON.stringify(result.stats)
    assert.ok(!serialized.includes(SUBMISSION))
    assert.ok(!serialized.includes('submissions/'))
    assert.ok(!/png|xlsx/.test(serialized))
  })
})

// ── The guard rails ───────────────────────────────────────────────────────────

describe('the submission id is validated before anything is listed', () => {
  test('a malformed id is refused outright', async () => {
    const fake = fakeStorage({ tree: piTree(1) })
    for (const bad of ['', 'not-a-uuid', '../..', `${SUBMISSION}/x`]) {
      await assert.rejects(
        () => removeAllObjectsForSubmission(fake.client, bad, []),
        /valid submissionId/)
    }
    assert.equal(fake.listCalls.length, 0)
  })
})

describe('NOTHING IS STILL RUNNING WHEN THE SWEEP HANDS BACK CONTROL', () => {
  // THE DEFECT THIS REPLACES. The sweep used to race a 20-second timer and, on
  // losing, let the caller release the deletion reservation while `.remove()`
  // calls were still in flight. A promise race is not cancellation: those
  // requests keep going, and one landing after the release deletes the workbook
  // of a PI that has since been unfrozen and resubmitted. The reservation exists
  // to make exactly that impossible.

  test('mapWithLimit waits for in-flight work even when a sibling has failed', async () => {
    let slowSettled = false
    let resolveSlow: (() => void) | undefined

    const items = ['slow', 'boom']
    const run = mapWithLimit(items, 2, async item => {
      if (item === 'boom') throw new Error('boom')
      await new Promise<void>(resolve => { resolveSlow = () => { slowSettled = true; resolve() } })
      return item
    })

    // Let the failure happen and any microtasks drain.
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(slowSettled, false, 'the slow task is still running, by construction')

    let finished = false
    const watched = run.then(
      () => { finished = true },
      () => { finished = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(finished, false,
      'THE MAP MUST NOT HAVE RESOLVED — a failure while work is in flight is not a result')

    resolveSlow?.()
    await watched
    assert.equal(slowSettled, true)
    assert.equal(finished, true, 'only now, with everything settled, does it report')
  })

  test('it rethrows the first failure once everything has stopped', async () => {
    let running = 0
    await assert.rejects(
      () => mapWithLimit([1, 2, 3, 4, 5, 6], 3, async n => {
        running += 1
        try {
          await new Promise(resolve => setTimeout(resolve, 5))
          if (n === 2) throw new Error('second one fails')
          return n
        } finally {
          running -= 1
        }
      }),
      /second one fails/)
    assert.equal(running, 0, 'no task is left running behind the rejection')
  })

  test('after a failure no NEW work is started', async () => {
    const started: number[] = []
    await assert.rejects(() => mapWithLimit(
      Array.from({ length: 40 }, (_, i) => i), 2, async n => {
        started.push(n)
        await new Promise(resolve => setTimeout(resolve, 2))
        if (n === 0) throw new Error('first one fails')
        return n
      }))
    assert.ok(started.length < 40,
      'the remaining items are abandoned rather than run against a doomed sweep')
  })

  test('a REMOVE that throws is settled, not abandoned', async () => {
    // A batch never rejects, so the map never short-circuits over a sibling
    // remove that is still talking to the network.
    const tree: Record<string, Entry[]> = {
      [PREFIX]: [folder('images')],
      [`${PREFIX}/images`]: Array.from({ length: 250 }, (_, i) => file(`f${i}.png`)),
    }
    let inFlight = 0
    const client = {
      storage: {
        from() {
          return {
            async list(prefix: string, opts: { limit: number; offset: number }) {
              await Promise.resolve()
              const all = tree[prefix] ?? []
              return { data: all.slice(opts.offset, opts.offset + opts.limit), error: null }
            },
            async remove(paths: string[]) {
              inFlight += 1
              try {
                await new Promise(resolve => setTimeout(resolve, 5))
                if (paths.some(p => p.endsWith('f0.png'))) throw new Error('socket hang up')
                return { data: paths.map(name => ({ name })), error: null }
              } finally {
                inFlight -= 1
              }
            },
          }
        },
      },
    } as unknown as SupabaseClient

    const result = await removeAllObjectsForSubmission(
      client as SupabaseClient, SUBMISSION, [])
    assert.equal(inFlight, 0, 'every remove request has settled before this returns')
    assert.equal(result.failed.length, 100, 'the thrown batch is reported as failed')
    assert.equal(result.removed.length, 150, 'and the others really did go')
  })

  test('the sweep returns only once every list has settled', async () => {
    const fake = fakeStorage({ tree: piTree(10), listDelayMs: 3 })
    assert.equal(fake.inFlight, 0)
    const result = await removeAllObjectsForSubmission(fake.client, SUBMISSION, [])
    assert.equal(fake.inFlight, 0, 'no list request outlives the call that started it')
    assert.ok(result.found.length > 0)
    assert.ok(fake.peakConcurrency > 1, 'and they really did overlap while running')
  })

  test('and once every list has settled EVEN WHEN ONE OF THEM FAILED', async () => {
    // The failure path is the one that matters: it is what makes the caller
    // release the reservation.
    const fake = fakeStorage({
      tree: piTree(10),
      listDelayMs: 3,
      listFails: new Set([`${PREFIX}/images/item-4/representative`]),
    })
    await assert.rejects(() => removeAllObjectsForSubmission(fake.client, SUBMISSION, []))
    assert.equal(fake.inFlight, 0,
      'nothing is still talking to storage when the caller is told it failed')
  })
})

describe('there is no timeout, and no timer-triggered release', () => {
  const root = process.cwd()
  const helper = readFileSync(
    join(root, 'src', 'lib', 'orders', 'submissionFilesServer.ts'), 'utf8')
  const route = readFileSync(
    join(root, 'src', 'app', 'api', 'orders', 'submissions', 'delete', 'route.ts'), 'utf8')

  /** Comments are stripped: both files DESCRIBE the removed timeout at length. */
  const code = (source: string) => source.split('\n')
    .filter(line => !line.trim().startsWith('*') && !line.trim().startsWith('//')
      && !line.trim().startsWith('/*'))
    .join('\n')

  test('no promise race guards the storage cleanup', () => {
    assert.ok(!code(helper).includes('Promise.race'))
    assert.ok(!code(route).includes('Promise.race'))
  })

  test('no timeout wrapper survives anywhere', () => {
    for (const source of [helper, route]) {
      assert.ok(!code(source).includes('withTimeout'))
      assert.ok(!code(source).includes('STORAGE_CLEANUP_TIMEOUT_MS'))
      assert.ok(!code(source).includes('StorageCleanupTimeout'))
    }
  })

  test('the sweep is awaited directly, with nothing racing it', () => {
    assert.ok(code(route).includes(
      'removal = await removeAllObjectsForSubmission(\n      service, submissionId'))
  })

  test('no setTimeout can reach a release', () => {
    assert.ok(!code(route).includes('setTimeout'))
    assert.ok(!code(helper).includes('setTimeout'))
  })

  test('release is only ever reached from a settled outcome', () => {
    const body = code(route)
    // FIVE release sites now, in two groups that are safe for different reasons.
    //
    // Downstream of the awaited sweep: a settled sweep failure and surviving
    // objects. A release there may be overtaken by a remove request that already
    // went out, so each one must be guarded by !removalAttempted — unchanged,
    // and still asserted exactly as strictly.
    //
    // Upstream of it: step 5b's two refusals, taken under the reservation before
    // the sweep call site is reached at all. No remove request can have been
    // issued on those paths because the code that issues them has not run, so
    // the record is provably whole and handing it straight back is correct.
    const sweep = body.indexOf('await removeAllObjectsForSubmission(')
    assert.ok(sweep > 0)
    for (const match of [...body.matchAll(/await release\(\)/g)]) {
      const at = match.index
      assert.ok(at !== undefined)
      if (at! > sweep) {
        const line = body.slice(body.lastIndexOf('\n', at!) + 1, at! + 15)
        assert.ok(/if \(!removalAttempted\)/.test(line),
          'a release downstream of the sweep must be guarded by !removalAttempted')
      }
    }
  })

  test('an abandoned request leaves the reservation in place', () => {
    // Nothing in the route releases on a path that does not first await the
    // sweep, so a killed process simply never releases — and the stale-claim
    // takeover recovers it later.
    assert.ok(!code(route).includes('finally'),
      'a finally-block release would run on paths where storage never settled')
  })
})

// ── Destructive uncertainty ───────────────────────────────────────────────────
//
// THE DISTINCTION THESE TESTS DEFEND. `removed` is what storage CONFIRMED. It is
// not what storage DID. A remove request can delete every key it was given and
// then lose its response to a network or gateway failure, and the client sees a
// throw — or a reply naming nothing at all.
//
// A caller that reads an absent confirmation as "nothing was removed" will give
// back a record whose files are already gone. So the helper reports a separate
// fact, `removalAttempted`, set immediately BEFORE the first request goes out,
// and offers a callback so the caller knows even if this function never returns.

describe('the helper reports whether a destructive request was ISSUED', () => {
  test('a listing failure before any remove leaves it false — safe to release', async () => {
    const tree = piTree(2)
    const fake = fakeStorage({ tree, listFails: new Set([`${PREFIX}/images`]) })
    await assert.rejects(() => removeAllObjectsForSubmission(fake.client, SUBMISSION, []))
    assert.equal(fake.removeCalls.length, 0,
      'nothing destructive was issued, so the caller may safely give the record back')
  })

  test('no keys at all means no request, and nothing to be uncertain about', async () => {
    const fake = fakeStorage({ tree: { [PREFIX]: [] } })
    const result = await removeAllObjectsForSubmission(fake.client, SUBMISSION, [])
    assert.equal(result.removalAttempted, false)
    assert.equal(fake.removeCalls.length, 0)
  })

  test('a remove that THROWS still reports the attempt', async () => {
    // The server deleted the objects; the response was lost. `removed` is empty
    // and that must not be read as "nothing happened".
    const tree = piTree(1, 0)
    const fake = fakeStorage({ tree, removeThrows: () => true })
    const result = await removeAllObjectsForSubmission(fake.client, SUBMISSION, [])
    assert.equal(result.removalAttempted, true, 'THE fact the caller must branch on')
    assert.deepEqual(result.removed, [], 'and nothing was confirmed')
    assert.ok(result.failed.length > 0)
  })

  test('a remove that returns an error still reports the attempt', async () => {
    const tree = piTree(1, 0)
    const fake = fakeStorage({ tree, removeFails: () => true })
    const result = await removeAllObjectsForSubmission(fake.client, SUBMISSION, [])
    assert.equal(result.removalAttempted, true)
    assert.deepEqual(result.removed, [])
  })

  test('a response confirming NOTHING still reports the attempt', async () => {
    // The request went out and came back naming no keys — the gateway truncated
    // it, or the API answered oddly. The objects may be gone.
    const tree = piTree(1, 0)
    const all = [`${PREFIX}/original/abcd-Client PI.xlsx`,
                 `${PREFIX}/images/item-0/representative/0-${'a'.repeat(64)}.png`]
    const fake = fakeStorage({ tree, unreported: new Set(all) })
    const result = await removeAllObjectsForSubmission(fake.client, SUBMISSION, [])
    assert.equal(result.removalAttempted, true)
    assert.deepEqual(result.removed, [], 'nothing confirmed')
    assert.ok(result.failed.length > 0, 'and the keys are still reported as unremoved')
  })

  test('one batch succeeds while another loses its response', async () => {
    // The mixed case, and the one an "any confirmed removals?" test would pass
    // while still being wrong: some keys are provably gone, others are unknown.
    const tree: Record<string, Entry[]> = {
      [PREFIX]: [folder('original')],
      [`${PREFIX}/original`]: Array.from({ length: REMOVE_BATCH + 10 },
        (_, i) => file(`f${i}.xlsx`)),
    }
    let seen = 0
    const fake = fakeStorage({ tree, removeThrows: () => { seen += 1; return seen === 2 } })
    const result = await removeAllObjectsForSubmission(fake.client, SUBMISSION, [])
    assert.equal(result.removalAttempted, true)
    assert.ok(result.removed.length > 0, 'the first batch is confirmed')
    assert.ok(result.failed.length > 0, 'the second is not, and may or may not be gone')
    assert.equal(fake.removeCalls.length, 2)
  })

  test('the callback fires BEFORE each request, so a throw cannot hide it', async () => {
    const tree = piTree(1, 0)
    const attempts: number[] = []
    const fake = fakeStorage({ tree, removeThrows: () => true })
    await removeAllObjectsForSubmission(fake.client, SUBMISSION, [],
      { onRemoveAttempt: () => attempts.push(fake.removeCalls.length) })
    assert.deepEqual(attempts, [0],
      'the callback ran while zero requests had yet been recorded — i.e. before the first')
  })

  test('a callback that throws does not abort the sweep', async () => {
    const tree = piTree(1, 0)
    const fake = fakeStorage({ tree })
    const result = await removeAllObjectsForSubmission(fake.client, SUBMISSION, [],
      { onRemoveAttempt: () => { throw new Error('caller bookkeeping blew up') } })
    assert.equal(result.removalAttempted, true)
    assert.ok(result.removed.length > 0, 'the removal still completed')
  })

  test('a successful sweep reports the attempt too', async () => {
    const fake = fakeStorage({ tree: piTree(2) })
    const result = await removeAllObjectsForSubmission(fake.client, SUBMISSION, [])
    assert.equal(result.removalAttempted, true)
    assert.deepEqual(result.failed, [])
  })
})
