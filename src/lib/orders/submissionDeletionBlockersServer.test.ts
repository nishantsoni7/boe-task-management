/**
 * WHAT STILL REFERS TO A PI, AND WHY THE ANSWER HAS TO COME FIRST.
 *
 * A PI Draft would not delete. The dialog said "This PI is already being
 * deleted", the record stayed, and the workbook and every product image were
 * already gone.
 *
 * The reservation protocol was not at fault. It froze the submission and the
 * three child tables that belong to it alone, exactly as designed. What refused
 * the deletion was a foreign key belonging to another module —
 * finance_payment_allocations names the PI a payment was allocated to, with the
 * default NO ACTION rule — and finalize_order_submission_deletion() neither
 * deletes such a row nor should. The refusal arrived as a raw constraint error,
 * after the storage sweep had already succeeded.
 *
 * So these tests are about a question asked at the right moment. Not "can the
 * blockers be found" — that is one query per table — but that the list is
 * derived from the schema rather than remembered, that a record which must
 * survive is never miscounted as absent, and that nothing about those records is
 * read beyond how many there are.
 *
 * NO REAL NETWORK. The fake below answers a PostgREST head-count and records
 * exactly what was asked of it.
 *
 * Run:
 *   npx tsx --test src/lib/orders/submissionDeletionBlockersServer.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DELETION_BLOCKER_SOURCES,
  readDeletionBlockers,
} from './submissionDeletionBlockersServer'
import { DELETION_BLOCKER_KINDS } from './submissionDeletion'

const SUBMISSION = '11111111-1111-4111-8111-111111111111'
const OTHER      = '22222222-2222-4222-8222-222222222222'

type Query = { table: string; columns: string; head: boolean; count?: string; column: string; value: unknown }

type FakeOptions = {
  /** table → how many rows name the submission. Absent reads as none. */
  counts?: Record<string, number>
  /** Tables whose query must come back with an error. */
  fails?: Set<string>
  /** Tables whose count comes back null, as PostgREST does without an exact count. */
  nullCount?: Set<string>
}

function fakeService(options: FakeOptions = {}) {
  const queries: Query[] = []
  const client = {
    from(table: string) {
      return {
        select(columns: string, opts?: { count?: string; head?: boolean }) {
          return {
            eq(column: string, value: unknown) {
              queries.push({
                table, columns, head: opts?.head === true, count: opts?.count, column, value,
              })
              if (options.fails?.has(table)) {
                return Promise.resolve({ count: null, error: { message: 'nope' } })
              }
              if (options.nullCount?.has(table)) {
                return Promise.resolve({ count: null, error: null })
              }
              return Promise.resolve({ count: options.counts?.[table] ?? 0, error: null })
            },
          }
        },
      }
    },
  } as unknown as SupabaseClient
  return { client, queries }
}

const ALLOCATIONS = 'finance_payment_allocations'
const CORRECTIONS = 'order_submission_correction_requests'
const ORDERS      = 'orders'

// ── The list is the schema's, not a memory of it ──────────────────────────────

describe('every NO ACTION reference to a PI submission is on the list', () => {
  const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')

  /**
   * Every foreign key in the repository that points at public.order_submissions,
   * with the delete rule it was declared with.
   *
   * READ OUT OF THE MIGRATIONS THEMSELVES, so a later phase that adds a fourth
   * reference and forgets this module fails here rather than in production after
   * a workbook has been destroyed.
   */
  const references = readdirSync(MIGRATIONS)
    .filter(file => file.endsWith('.sql'))
    .flatMap(file => {
      const lines = readFileSync(join(MIGRATIONS, file), 'utf8')
        .split('\n')
        .filter(line => !line.trim().startsWith('--'))
      return lines
        .map((line, index) => ({ line, index }))
        .filter(entry => /references\s+public\.order_submissions\s*\(\s*id\s*\)/.test(entry.line))
        // A declaration is not always one line: the allocations table puts the
        // column, its named constraint and the reference on three. The window is
        // the declaration, so the column name is in it wherever it was written.
        .map(entry => ({
          file,
          declaration: lines.slice(Math.max(0, entry.index - 3), entry.index + 1)
            .map(line => line.trim()).join(' '),
          cascades: /on delete cascade/i.test(entry.line),
        }))
    })

  test('the migrations really do declare references to order_submissions', () => {
    assert.ok(references.length >= 4, 'the scan found nothing, so it proves nothing')
  })

  test('every reference that does NOT cascade is one this module counts', () => {
    // The cascading three are the submission's own children, and finalization
    // deletes them explicitly. Everything else belongs to another module, has
    // the default NO ACTION rule, and will refuse the final DELETE.
    const columnsChecked = new Set(DELETION_BLOCKER_SOURCES.map(source => source.column))
    for (const reference of references) {
      if (reference.cascades) continue
      const named = [...columnsChecked].some(column => reference.declaration.includes(column))
      assert.ok(named,
        `${reference.file} declares a NO ACTION reference this module does not count:`
        + ` ${reference.declaration}`)
    }
  })

  test('the cascading children are deliberately NOT counted as blockers', () => {
    const cascading = references.filter(reference => reference.cascades)
    assert.ok(cascading.length >= 3)
    for (const source of DELETION_BLOCKER_SOURCES) {
      assert.ok(!/order_submission_items|order_submission_item_images|order_submission_activity/
        .test(source.table), `${source.table} is finalization's own work, not a blocker`)
    }
  })

  test('finalization deletes the children it is meant to, and none of the three', () => {
    const finalize = readFileSync(
      join(MIGRATIONS, '20260914000000_order_submission_permanent_deletion.sql'), 'utf8')
      .slice(readFileSync(
        join(MIGRATIONS, '20260914000000_order_submission_permanent_deletion.sql'), 'utf8')
        .indexOf('create or replace function public.finalize_order_submission_deletion'))
    for (const child of ['order_submission_item_images', 'order_submission_items',
                         'order_submission_activity']) {
      assert.ok(finalize.includes(`delete from public.${child}`), `${child} must be purged`)
    }
    for (const source of DELETION_BLOCKER_SOURCES) {
      assert.ok(!finalize.includes(`delete from public.${source.table} `),
        `${source.table} must never be deleted to make a PI deletion succeed`)
    }
  })

  test('one kind per source, and every declared kind has a source', () => {
    const kinds = DELETION_BLOCKER_SOURCES.map(source => source.kind)
    assert.deepEqual([...kinds].sort(), [...DELETION_BLOCKER_KINDS].sort())
    assert.equal(new Set(kinds).size, kinds.length)
  })
})

// ── Reading them ──────────────────────────────────────────────────────────────

describe('a PI nothing refers to reports nothing', () => {
  test('all three tables are asked, and the answer is empty', async () => {
    const { client, queries } = fakeService()
    assert.deepEqual(await readDeletionBlockers(client, SUBMISSION), [])
    assert.deepEqual(queries.map(query => query.table).sort(),
      [ALLOCATIONS, ORDERS, CORRECTIONS].sort())
  })

  test('each table is asked about THIS submission, by its own column', async () => {
    const { client, queries } = fakeService()
    await readDeletionBlockers(client, SUBMISSION)
    for (const source of DELETION_BLOCKER_SOURCES) {
      const query = queries.find(entry => entry.table === source.table)
      assert.ok(query, `${source.table} must be asked`)
      assert.equal(query.column, source.column)
      assert.equal(query.value, SUBMISSION)
    }
  })
})

describe('what is in the way is counted, and only counted', () => {
  test('an allocated payment blocks the deletion', async () => {
    const { client } = fakeService({ counts: { [ALLOCATIONS]: 1 } })
    assert.deepEqual(await readDeletionBlockers(client, SUBMISSION),
      [{ kind: 'payment_allocation', count: 1 }])
  })

  test('a correction request blocks it too', async () => {
    const { client } = fakeService({ counts: { [CORRECTIONS]: 3 } })
    assert.deepEqual(await readDeletionBlockers(client, SUBMISSION),
      [{ kind: 'correction_request', count: 3 }])
  })

  test('and a Confirmed Order that names the PI as its source', async () => {
    const { client } = fakeService({ counts: { [ORDERS]: 1 } })
    assert.deepEqual(await readDeletionBlockers(client, SUBMISSION),
      [{ kind: 'confirmed_order', count: 1 }])
  })

  test('more than one kind comes back whole, not first-wins', async () => {
    const { client } = fakeService({ counts: { [ALLOCATIONS]: 2, [CORRECTIONS]: 1 } })
    const blockers = await readDeletionBlockers(client, SUBMISSION)
    assert.equal(blockers.length, 2)
    assert.ok(blockers.some(blocker => blocker.kind === 'payment_allocation' && blocker.count === 2))
    assert.ok(blockers.some(blocker => blocker.kind === 'correction_request' && blocker.count === 1))
  })

  test('NOTHING but the count is read: head requests, no columns', async () => {
    // A payment allocation is a record the person deleting the PI may well not
    // be permitted to read. The refusal needs to know it exists; it does not
    // need — and must not carry — its id, its amount or its payment.
    const { client, queries } = fakeService({ counts: { [ALLOCATIONS]: 1 } })
    await readDeletionBlockers(client, SUBMISSION)
    for (const query of queries) {
      assert.equal(query.head, true, `${query.table} must be a head request`)
      assert.equal(query.count, 'exact')
      assert.equal(query.columns, 'id')
    }
  })

  test('a REVERSED allocation still counts, because it is still there', async () => {
    // 20260918000000: 'reversed' is how an allocation ends, and it is never
    // deleted. The foreign key does not care about the status column, so a check
    // that filtered reversed rows out would report a clear path immediately
    // before Postgres refused one.
    const { client, queries } = fakeService({ counts: { [ALLOCATIONS]: 1 } })
    await readDeletionBlockers(client, SUBMISSION)
    const query = queries.find(entry => entry.table === ALLOCATIONS)
    assert.equal(query?.column, 'order_submission_id',
      'the only filter is the submission; status is not consulted')
    assert.deepEqual(await readDeletionBlockers(client, SUBMISSION),
      [{ kind: 'payment_allocation', count: 1 }])
  })

  test('the source file names no status filter at all', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/lib/orders/submissionDeletionBlockersServer.ts'), 'utf8')
    const code = source.split('\n')
      .filter(line => !line.trim().startsWith('*') && !line.trim().startsWith('//')).join('\n')
    assert.ok(!code.includes("'active'"))
    assert.ok(!code.includes("'reversed'"))
  })
})

// ── Failing closed ────────────────────────────────────────────────────────────

describe('an unanswered question is never read as "nothing is in the way"', () => {
  test('a query that errors throws rather than returning an empty list', async () => {
    const { client } = fakeService({ fails: new Set([ALLOCATIONS]) })
    await assert.rejects(() => readDeletionBlockers(client, SUBMISSION))
  })

  test('a failure in ANY of the three throws', async () => {
    for (const table of [ALLOCATIONS, CORRECTIONS, ORDERS]) {
      const { client } = fakeService({ fails: new Set([table]) })
      await assert.rejects(() => readDeletionBlockers(client, SUBMISSION),
        `${table} failing must not pass silently`)
    }
  })

  test('the thrown message carries no database text', async () => {
    const { client } = fakeService({ fails: new Set([ORDERS]) })
    await assert.rejects(() => readDeletionBlockers(client, SUBMISSION), (error: Error) => {
      assert.ok(!/nope|sqlstate|pg_|relation/i.test(error.message))
      return true
    })
  })

  test('a null count is no rows, which is the honest reading of a head request', async () => {
    const { client } = fakeService({ nullCount: new Set([ALLOCATIONS, CORRECTIONS, ORDERS]) })
    assert.deepEqual(await readDeletionBlockers(client, SUBMISSION), [])
  })

  test('a malformed submission id is refused before a single table is read', async () => {
    const { client, queries } = fakeService()
    for (const bad of ['', 'not-a-uuid', `${SUBMISSION}'--`, '../../etc', `${SUBMISSION} or 1=1`]) {
      await assert.rejects(() => readDeletionBlockers(client, bad), `${bad} must be refused`)
    }
    assert.equal(queries.length, 0, 'nothing may be read on the strength of an unvalidated id')
  })

  test('the id is the only thing that reaches a query, and it is the one given', async () => {
    const { client, queries } = fakeService()
    await readDeletionBlockers(client, OTHER)
    assert.ok(queries.every(query => query.value === OTHER))
    assert.ok(queries.every(query => !String(query.value).includes(SUBMISSION)))
  })
})

// ── The reader answers from the database every time it is asked ───────────────

/**
 * THE ROUTE ASKS THIS QUESTION TWICE, and the second answer has to be able to
 * differ from the first — that is the entire point of asking again once the
 * record is frozen. A reader that memoised its answer, per submission or per
 * client, would turn the second call into a restatement of the first and hand
 * back exactly the stale "nothing is in the way" the re-read exists to catch.
 *
 * So this asserts the absence of a cache directly: the same reader, the same
 * client and the same submission id, with the underlying rows changing in
 * between, must return the new answer and must have gone back to the database
 * to get it.
 */
describe('a second read is a second question, not a remembered answer', () => {
  test('the same reader called twice sees rows that appeared in between', async () => {
    const counts: Record<string, number> = {}
    const { client, queries } = fakeService({ counts })

    const before = await readDeletionBlockers(client, SUBMISSION)
    assert.deepEqual(before, [], 'nothing refers to this PI yet')

    // An allocation lands in the window the route's step 5b exists to close.
    counts[ALLOCATIONS] = 1

    const after = await readDeletionBlockers(client, SUBMISSION)
    assert.deepEqual(after, [{ kind: 'payment_allocation', count: 1 }],
      'the second read must report what the first could not have seen')

    assert.equal(queries.length, DELETION_BLOCKER_SOURCES.length * 2,
      'every source is queried again on the second call; nothing is served from memory')
  })

  test('a blocker that has been dealt with stops being reported', async () => {
    const counts: Record<string, number> = { [CORRECTIONS]: 2 }
    const { client } = fakeService({ counts })

    assert.deepEqual(await readDeletionBlockers(client, SUBMISSION),
      [{ kind: 'correction_request', count: 2 }])

    delete counts[CORRECTIONS]

    assert.deepEqual(await readDeletionBlockers(client, SUBMISSION), [],
      'the answer follows the database in both directions, so a cleared PI is deletable')
  })
})
