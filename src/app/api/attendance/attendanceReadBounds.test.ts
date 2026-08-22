/**
 * Every read of `attendance_records` is bounded.
 *
 * WHY THIS TABLE, SPECIFICALLY
 * ---------------------------
 * `attendance_records` grows by (employees x days). Fifty people over one month
 * is more than 1,500 rows, and PostgREST caps a response at 1000 on this
 * project — a CAP, not an error: no error field, no warning, a plausible-looking
 * array. src/lib/supabasePaging.ts records what that already cost once: 75% of
 * an activity log silently discarded, every employee scoring zero, and a page
 * that was internally consistent and comprehensively wrong.
 *
 * Here the consequences are worse than a short list, because pay is computed
 * from these rows:
 *
 *   monthly-summary     a month's attendance summary missing a third of the
 *                       month, presented as the month
 *   monthly-review      the PREVIEW OF A PAYROLL RUN — a short read under-counts
 *                       attended days and under-pays somebody, on the screen
 *                       whose entire purpose is to be checked before the run
 *   import / preview    the map deciding NEW versus CHANGED. Rows it loses look
 *                       BRAND NEW, so an import reports inserting days that
 *                       already exist and mis-states what it is about to change
 *   csv export          a file that leaves the building and is reconciled
 *                       against by somebody with no way to tell it is short
 *   employee-records    one employee's whole history, which passes a thousand
 *                       rows after about three years
 *
 * Every one of them now pages, and every one REFUSES a failed or capped read
 * rather than computing from part of one. For attendance that is the only
 * acceptable behaviour: a partial answer is indistinguishable from a complete
 * one, which is exactly what makes it dangerous.
 *
 * Run:
 *   npx tsx --test src/app/api/attendance/attendanceReadBounds.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/** Every route that reads a set of attendance rows large enough to be capped. */
const PAGED_READS = [
  { label: 'the monthly attendance summary', file: 'src/app/api/attendance/monthly-summary/route.ts' },
  { label: 'the payroll monthly review',     file: 'src/app/api/payroll/monthly-review/route.ts' },
  { label: 'the attendance import',          file: 'src/app/api/attendance/import/route.ts' },
  { label: 'the import preview',             file: 'src/app/api/attendance/preview/route.ts' },
  { label: 'the CSV export',                 file: 'src/app/api/attendance/records/route.ts' },
  { label: "one employee's history",         file: 'src/app/api/attendance/employee-records/route.ts' },
]

const source = (file: string) => readFileSync(file, 'utf8')

describe('every large attendance read is paged', () => {
  for (const { label, file } of PAGED_READS) {
    test(`${label} reads in pages`, () => {
      const code = source(file)
      assert.ok(code.includes('fetchAllRows'), `${file}: must page its read`)
      assert.ok(code.includes('.range(pageFrom, pageTo)'), `${file}: each page must be bounded`)
    })
  }

  test('no route still selects attendance_records without a range', () => {
    // The exact shape that was there. A select chain over attendance_records
    // that never reaches .range() is one PostgREST will silently clip.
    //
    // Only READS are examined. The import route also inserts into and updates
    // this table, and a write has nothing to page — so a chain is checked only
    // when `.select(` is the call that follows, and a `head: true` count is
    // exempt because it transfers no rows at all.
    for (const { file } of PAGED_READS) {
      const code = source(file)
      const chains = code.split(".from('attendance_records')").slice(1)
      for (const chain of chains) {
        const window = chain.slice(0, 700)
        const isRead = /^\s*\.select\(/.test(chain)
        if (!isRead) continue
        if (window.includes('head: true')) continue
        assert.ok(window.includes('.range('),
          `${file}: an attendance_records read has no range`)
      }
    }
  })
})

describe('paging is stable, so rows cannot repeat or vanish', () => {
  for (const { label, file } of PAGED_READS) {
    test(`${label} orders on a unique column`, () => {
      // range() maps to LIMIT/OFFSET, and Postgres promises nothing about row
      // order between two requests unless the ordering is deterministic. Every
      // employee shares an attendance_date with every other employee, so
      // ordering by date alone is emphatically not unique — a page boundary
      // could return one person's day twice and drop another's entirely.
      const code = source(file)
      assert.match(code, /\.order\('id', \{ ascending: (true|false) \}\)/,
        `${file}: a unique tiebreak is required`)
    })
  }
})

describe('a partial read is refused, never used', () => {
  for (const { label, file } of PAGED_READS) {
    test(`${label} refuses a failed or capped read`, () => {
      const code = source(file)
      // unwrapPagedRows rejects BOTH failure modes — a failed page and a capped
      // read — and throws rather than returning a sentinel, because every
      // caller's correct response is the same and a sentinel is one more thing
      // to forget to check.
      assert.ok(code.includes('unwrapPagedRows('),
        `${file}: rows must come out through the checked unwrap`)
      assert.ok(code.includes('PagedReadError'),
        `${file}: the refusal must be handled, not left to bubble as a 500`)
    })

    test(`${label} answers with a status rather than throwing`, () => {
      const code = source(file)
      assert.match(code, /catch \(err\)[\s\S]{0,400}NextResponse\.json/,
        `${file}: a refused read must produce a response`)
    })
  }

  test('none of them falls back to an empty set', () => {
    // `data ?? []` on a failed read is what makes a truncated month look like a
    // month in which nobody attended.
    for (const { file } of PAGED_READS) {
      const code = source(file)
      assert.ok(!/const rows = data \?\? \[\]/.test(code),
        `${file}: a failed read must not default to an empty array`)
    }
  })
})

describe('the importer is the one that must not guess', () => {
  for (const file of ['src/app/api/attendance/import/route.ts',
                      'src/app/api/attendance/preview/route.ts']) {
    test(`${file} refuses rather than classifying every unread day as new`, () => {
      const code = source(file)
      // The existing-record map decides INSERT versus UPDATE. A row missing from
      // it is not "unchanged" — it is invisible, and the classifier below reads
      // invisible as new.
      assert.ok(code.includes("unwrapPagedRows('existing attendance records'"),
        `${file}: the existing-record map must be complete or refused`)
      assert.ok(code.includes('Could not read existing attendance records'),
        `${file}: and must say so rather than importing`)
    })
  }
})
