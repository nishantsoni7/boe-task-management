/**
 * The task archives are bounded reads.
 *
 * WHAT THIS FILE PROVES
 * ---------------------
 * PostgREST caps a response at 1000 rows on this project. It is a CAP, not an
 * error: no error field, no warning, and a plausible-looking array.
 * src/lib/supabasePaging.ts records what that cost the Performance module — 75%
 * of an activity log silently discarded, every employee scoring zero, and a page
 * that was internally consistent and comprehensively wrong.
 *
 * The four task archives are exactly the shape that hits it. They only ever
 * grow, and each is ordered newest-first, so past a thousand rows the OLDEST
 * records stop appearing — the ones somebody opens an archive specifically to
 * find. Nothing looks wrong; the list just quietly stops going back far enough.
 *
 * These tests pin, for every archive:
 *
 *   1. the read is PAGED, through the shared helper;
 *   2. the ordering is UNIQUE, so pages cannot overlap or leave gaps;
 *   3. a failed or truncated read is reported, not rendered as an empty archive.
 *
 * They are source-shape assertions because the alternative — proving the
 * truncation itself — needs a database with more than a thousand archived tasks
 * in it, which is exactly the situation nobody notices until it is too late.
 *
 * Run:
 *   npx tsx --test src/app/tasks/archiveListBounds.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/** Every list that shows finished work and therefore grows without limit. */
const ARCHIVES = [
  { label: 'my completed tasks',            file: 'src/app/tasks/my/completed/page.tsx' },
  { label: 'completed tasks I assigned',    file: 'src/app/tasks/assigned-by-me/completed/page.tsx' },
  { label: 'cancelled tasks',               file: 'src/app/tasks/cancelled/page.tsx' },
  { label: 'cancelled tasks I assigned',    file: 'src/app/tasks/assigned-by-me/cancelled/page.tsx' },
]

const source = (file: string) => readFileSync(file, 'utf8')

describe('every task archive is read in pages', () => {
  for (const { label, file } of ARCHIVES) {
    test(`${label} pages its read`, () => {
      const code = source(file)
      assert.ok(code.includes('fetchAllRows<Task>('),
        `${file}: the archive must be read through the shared paging helper`)
      assert.ok(code.includes('.range(from, to)'),
        `${file}: each page must be bounded`)
    })
  }

  test('none of them still issues a bare unbounded select over tasks', () => {
    // The exact shape that was there: a tasks select whose chain ends at
    // .order(...) with no range. Its return is what would be silently clipped.
    for (const { file } of ARCHIVES) {
      const code = source(file)
      const bare = /supabase\s*\.from\('tasks'\)\s*\.select\(TASK_COLUMNS\)(?:\s*\.\w+\([^)]*\))*\s*,/
      assert.ok(!bare.test(code), `${file}: an unbounded tasks select remains`)
    }
  })
})

describe('the ordering is unique, so pages cannot overlap or leave gaps', () => {
  for (const { label, file } of ARCHIVES) {
    test(`${label} breaks ties on a unique column`, () => {
      // range() maps to LIMIT/OFFSET, and Postgres promises nothing about row
      // order between two requests unless the ordering is deterministic. Two
      // tasks sharing a completion timestamp could otherwise swap across a page
      // boundary — returning one twice and losing the other entirely.
      const code = source(file)
      assert.ok(code.includes(".order('id', { ascending: false })"),
        `${file}: a unique tiebreak is required for stable paging`)
    })
  }
})

describe('a failed read is never rendered as an empty archive', () => {
  for (const { label, file } of ARCHIVES) {
    test(`${label} distinguishes "nothing here" from "could not load"`, () => {
      const code = source(file)

      // The result is inspected rather than defaulted. `taskResult.rows` is not
      // even reachable until `ok` has been narrowed — the helper's failure
      // branch carries no rows property at all — so a caller cannot quietly
      // compute from a partial read.
      assert.ok(code.includes('taskResult.ok && !taskResult.truncated ? null : ARCHIVE_LOAD_ERROR'),
        `${file}: truncation and failure must both raise the notice`)
      assert.ok(code.includes('setAllTasks(taskResult.ok ?'),
        `${file}: rows may only be read after ok is narrowed`)

      // And it reaches the screen.
      assert.ok(code.includes('{loadError && ('), `${file}: the notice must render`)
      assert.ok(code.includes('role="alert"'), `${file}: and be announced`)
    })

    test(`${label} shows the notice ALONGSIDE whatever loaded`, () => {
      // Replacing the list with an error throws away rows that arrived fine.
      // The banner sits above the list, and the list still renders.
      const code = source(file)
      const banner = code.indexOf('{loadError && (')
      const list = code.indexOf('{visibleTasks.length === 0 ? (')
      assert.ok(banner > 0 && list > banner,
        `${file}: the notice must precede the list, not replace it`)
    })
  }
})

describe('the shared helper is the one that reports rather than under-reports', () => {
  test('it caps a runaway loop and says when it did', () => {
    const helper = source('src/lib/supabasePaging.ts')
    assert.ok(helper.includes('PAGED_FETCH_ROW_CAP'))
    assert.ok(helper.includes('truncated'),
      'the helper must be able to say it did not read everything')
  })

  test('and its failure branch carries no rows at all', () => {
    // This is what makes "check ok first" a compile error rather than a
    // convention — the previous shape returned { rows, error } together, and a
    // caller who forgot to check would silently compute from a partial read.
    const helper = source('src/lib/supabasePaging.ts')
    assert.ok(helper.includes('no `rows` property at all'))
  })
})
