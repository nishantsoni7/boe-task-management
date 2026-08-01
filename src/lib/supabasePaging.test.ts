/**
 * fetchAllRows / unwrapPagedRows — the guard against PostgREST's silent 1000-row cap.
 *
 * This is the highest-value test file in the Performance set, because the bug it
 * covers produced a page that was internally consistent and completely wrong:
 * every score, every rate, every ranking and every trend was computed from 25% of
 * the activity log, with no error anywhere. Fixtures never caught it because
 * fixtures are never 1000 rows long.
 *
 * The second thing it locks down is the *contract*: a failed read must not be
 * usable. `PagedFetchResult` is a discriminated union whose failure branch has no
 * `rows` property, so partial data cannot reach a calculation even by accident.
 *
 * Run:
 *   npx tsx --test src/lib/supabasePaging.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  fetchAllRows, unwrapPagedRows, PagedReadError,
  POSTGREST_MAX_ROWS, PAGED_FETCH_ROW_CAP,
  type PagedFetchResult,
} from './supabasePaging'

type Row = { id: number }

/**
 * A fake PostgREST that enforces a hard per-response cap, exactly as the real one
 * does: it silently returns fewer rows than asked for, with no error.
 */
function fakeTable(totalRows: number, serverCap = POSTGREST_MAX_ROWS) {
  const all: Row[] = Array.from({ length: totalRows }, (_, i) => ({ id: i }))
  const calls: [number, number][] = []
  const page = async (from: number, to: number) => {
    calls.push([from, to])
    const capped = Math.min(to - from + 1, serverCap)
    return { data: all.slice(from, from + capped), error: null }
  }
  return { page, calls, all }
}

/** Narrow to the success branch, failing the test with the error if it is not. */
function expectOk<T>(r: PagedFetchResult<T>) {
  assert.equal(r.ok, true, r.ok ? '' : `unexpected failure: ${r.error}`)
  if (!r.ok) throw new Error('unreachable')
  return r
}

// ── 1, 10. Multi-page read, and the original defect ───────────────────────────

describe('reading past the server cap', () => {
  test('1. reads every row across multiple pages, in order, with no gaps', async () => {
    const t = fakeTable(4100)
    const r = expectOk(await fetchAllRows<Row>(t.page))

    assert.equal(r.rows.length, 4100)
    assert.equal(r.truncated, false)
    assert.deepEqual(r.rows.map(x => x.id), t.all.map(x => x.id))
    assert.equal(new Set(r.rows.map(x => x.id)).size, 4100, 'no duplicated rows')
  })

  test('10. REGRESSION: a single un-paged read loses 75% of that same table', async () => {
    // Exactly what the route used to do — ask for 100000, receive 1000, notice
    // nothing. This is the defect the whole file exists to prevent; if this ever
    // stops being true the cap has changed and the page size must be revisited.
    const t = fakeTable(4100)
    const { data } = await t.page(0, 99_999)
    assert.equal(data.length, POSTGREST_MAX_ROWS)
    assert.ok(data.length / 4100 < 0.25)

    // And the paged read recovers all of it.
    assert.equal(expectOk(await fetchAllRows<Row>(t.page)).rows.length, 4100)
  })

  test('a small table costs exactly one page', async () => {
    const r = expectOk(await fetchAllRows<Row>(fakeTable(42).page))
    assert.equal(r.rows.length, 42)
    assert.equal(r.pages, 1)
    assert.equal(r.attempts, 1)
  })

  test('an empty table yields no rows and does not loop', async () => {
    const r = expectOk(await fetchAllRows<Row>(fakeTable(0).page))
    assert.deepEqual(r.rows, [])
    assert.equal(r.pages, 1)
  })

  test('page windows are contiguous and non-overlapping', async () => {
    const t = fakeTable(2500)
    await fetchAllRows<Row>(t.page)
    assert.deepEqual(t.calls, [[0, 999], [1000, 1999], [2000, 2999]])
  })

  test('a custom page size is honoured', async () => {
    const r = expectOk(await fetchAllRows<Row>(fakeTable(250, 100).page, 100))
    assert.equal(r.rows.length, 250)
    assert.equal(r.pages, 3)
  })
})

// ── 2. Exact page-size multiple ───────────────────────────────────────────────

describe('page-boundary arithmetic', () => {
  test('2. an exact multiple of the page size still terminates', async () => {
    // 2000 rows means a full second page, so a third request is needed to discover
    // the data has run out. Getting this wrong either loops forever or drops rows.
    const t = fakeTable(2000)
    const r = expectOk(await fetchAllRows<Row>(t.page))
    assert.equal(r.rows.length, 2000)
    assert.equal(r.pages, 3)
    assert.equal(r.truncated, false)
    assert.deepEqual(t.calls[2], [2000, 2999])
  })

  test('one row over a page boundary is not lost', async () => {
    const r = expectOk(await fetchAllRows<Row>(fakeTable(1001).page))
    assert.equal(r.rows.length, 1001)
    assert.equal(r.pages, 2)
  })

  test('exactly one page of rows costs two pages to confirm', async () => {
    const r = expectOk(await fetchAllRows<Row>(fakeTable(1000).page))
    assert.equal(r.rows.length, 1000)
    assert.equal(r.pages, 2)
  })
})

// ── 3, 9. Retry policy ────────────────────────────────────────────────────────

describe('transient-failure retry', () => {
  test('3. one transient abort is retried and then succeeds', async () => {
    let n = 0
    const r = expectOk(await fetchAllRows<Row>(async () => {
      n++
      if (n === 1) return { data: null, error: { message: 'TypeError: terminated' } }
      return { data: [{ id: 1 }], error: null }
    }))
    assert.deepEqual(r.rows, [{ id: 1 }])
    assert.equal(r.pages, 1, 'the retry is the same logical page')
    assert.equal(r.attempts, 2, 'but it cost two attempts')
  })

  test('3b. a thrown fetch failure is caught and retried, not propagated', async () => {
    let n = 0
    const r = expectOk(await fetchAllRows<Row>(async () => {
      n++
      if (n === 1) throw new TypeError('fetch failed')
      return { data: [{ id: 7 }], error: null }
    }))
    assert.deepEqual(r.rows, [{ id: 7 }])
    assert.equal(r.attempts, 2)
  })

  test('a persistent transient error gives up after one retry', async () => {
    let n = 0
    const r = await fetchAllRows<Row>(async () => {
      n++
      return { data: null, error: { message: 'terminated' } }
    })
    assert.equal(r.ok, false)
    assert.equal(n, 2, 'exactly one retry, not an unbounded loop')
  })

  test('9. a schema or permission error is NOT retried', async () => {
    let n = 0
    const r = await fetchAllRows<Row>(async () => {
      n++
      return { data: null, error: { message: 'column users.nope does not exist' } }
    })
    assert.equal(n, 1, 'a deterministic error must fail fast, not burn a retry')
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /does not exist/)
  })

  test('9b. other deterministic failures are not retried either', async () => {
    for (const msg of [
      'permission denied for table tasks',
      'JWT expired',
      'invalid input syntax for type uuid',
    ]) {
      let n = 0
      await fetchAllRows<Row>(async () => { n++; return { data: null, error: { message: msg } } })
      assert.equal(n, 1, `"${msg}" should not be retried`)
    }
  })
})

// ── 4. A permanent failure yields nothing usable ──────────────────────────────

describe('failure returns no usable rows', () => {
  test('4. a permanent page failure exposes no rows at all', async () => {
    // Page 1 succeeds with 1000 rows, page 2 fails permanently. Those 1000 rows are
    // deliberately discarded: computing from them is the exact defect this guards.
    let n = 0
    const r = await fetchAllRows<Row>(async (from, to) => {
      n++
      if (n === 1) return { data: Array.from({ length: to - from + 1 }, (_, i) => ({ id: from + i })), error: null }
      return { data: null, error: { message: 'permission denied for table tasks' } }
    })

    assert.equal(r.ok, false)
    if (r.ok) throw new Error('unreachable')
    assert.match(r.error, /permission denied/)
    assert.equal(r.pages, 2)
    assert.equal(r.attempts, 2)

    // The failure branch has no `rows` property at compile time; confirm at runtime
    // that no partial data is smuggled through either.
    assert.equal('rows' in r, false, 'a failed result must not carry rows')
    assert.equal('truncated' in r, false)
  })

  test('4b. unwrapPagedRows refuses a failed result', () => {
    const failed = { ok: false as const, error: 'connection reset', pages: 2, attempts: 3 }
    assert.throws(
      () => unwrapPagedRows('activity log', failed),
      (e: unknown) => {
        assert.ok(e instanceof PagedReadError)
        assert.equal(e.label, 'activity log')
        assert.equal(e.reason, 'read_failed')
        assert.equal(e.detail, 'connection reset')
        return true
      },
    )
  })

  test('a null data page is treated as empty, not as a crash', async () => {
    const r = expectOk(await fetchAllRows<Row>(async () => ({ data: null, error: null })))
    assert.deepEqual(r.rows, [])
  })
})

// ── 5, 6, 7. Truncation ceiling and route rejection ───────────────────────────

describe('row-cap truncation', () => {
  test('5. hitting the ceiling reports truncated rather than under-reporting silently', async () => {
    const r = expectOk(await fetchAllRows<Row>(fakeTable(5000).page, 1000, 2000))
    assert.equal(r.truncated, true)
    assert.equal(r.rows.length, 2000)
    assert.notEqual(r.rows.length, 5000, 'the caller must be able to tell it is short')
  })

  test('a read that fits under the ceiling is not marked truncated', async () => {
    const r = expectOk(await fetchAllRows<Row>(fakeTable(1500).page, 1000, 2000))
    assert.equal(r.truncated, false)
    assert.equal(r.rows.length, 1500)
  })

  // 6 and 7 are the same assertion by construction: both routes reject truncation
  // through this one function, so there is no way for them to diverge. The
  // structural guard in teamPerformanceQueries.test.ts asserts that each route
  // actually calls it.
  test('6+7. unwrapPagedRows refuses a truncated result, for either route', () => {
    const capped = { ok: true as const, rows: [{ id: 1 }], truncated: true, pages: 100, attempts: 100 }

    for (const label of ['activity log', 'open tasks']) {
      assert.throws(
        () => unwrapPagedRows(label, capped),
        (e: unknown) => {
          assert.ok(e instanceof PagedReadError)
          assert.equal(e.label, label)
          assert.equal(e.reason, 'row_cap_exceeded')
          assert.match(e.detail, new RegExp(`${PAGED_FETCH_ROW_CAP}-row read cap`))
          return true
        },
        `${label} must be refused when truncated`,
      )
    }
  })

  test('unwrapPagedRows returns the rows when the read is complete', () => {
    const good = { ok: true as const, rows: [{ id: 1 }, { id: 2 }], truncated: false, pages: 1, attempts: 1 }
    assert.deepEqual(unwrapPagedRows('tasks', good), [{ id: 1 }, { id: 2 }])
  })

  test('the error message never carries a raw database string for a capped read', () => {
    const capped = { ok: true as const, rows: [], truncated: true, pages: 100, attempts: 100 }
    try {
      unwrapPagedRows('EOD logs', capped)
      assert.fail('should have thrown')
    } catch (e) {
      assert.ok(e instanceof PagedReadError)
      // Truncation is our own condition, not the database's, so the detail is safe
      // to surface. A read_failed detail is not, and routes must not echo it.
      assert.doesNotMatch(e.detail, /postgres|sqlstate|column|relation/i)
    }
  })
})

// ── 8. Counter semantics ──────────────────────────────────────────────────────

describe('counters mean exactly what they are named', () => {
  test('8. pages counts logical windows; attempts counts calls including retries', async () => {
    // Four pages of data. Page 2 fails transiently once, page 3 twice (so page 3
    // fails permanently after its single retry).
    const failuresByPage = new Map([[1, 1]])   // page index (0-based) → transient failures
    let calls = 0
    const seen: number[] = []

    const r = await fetchAllRows<Row>(async (from, to) => {
      calls++
      const pageIndex = from / 1000
      seen.push(pageIndex)
      const remaining = failuresByPage.get(pageIndex) ?? 0
      if (remaining > 0) {
        failuresByPage.set(pageIndex, remaining - 1)
        return { data: null, error: { message: 'terminated' } }
      }
      const total = 3500
      const start = from
      const end = Math.min(to + 1, total)
      return { data: Array.from({ length: Math.max(0, end - start) }, (_, i) => ({ id: start + i })), error: null }
    })

    const ok = expectOk(r)
    assert.equal(ok.rows.length, 3500)
    assert.equal(ok.pages, 4, '4 logical windows: 0-999, 1000-1999, 2000-2999, 3000-3999')
    assert.equal(ok.attempts, 5, '4 windows + 1 retry of window 2')
    assert.equal(calls, 5)
    assert.ok(ok.attempts >= ok.pages, 'attempts can never be fewer than pages')
  })

  test('with no retries, attempts equals pages', async () => {
    const r = expectOk(await fetchAllRows<Row>(fakeTable(2500).page))
    assert.equal(r.pages, 3)
    assert.equal(r.attempts, 3)
  })

  test('counters are reported on the failure branch too', async () => {
    const r = await fetchAllRows<Row>(async () => ({ data: null, error: { message: 'JWT expired' } }))
    assert.equal(r.ok, false)
    assert.equal(r.pages, 1)
    assert.equal(r.attempts, 1)
  })

  test('there is no field called "requests"', async () => {
    // It used to exist and counted attempts while reading like round trips.
    const r = expectOk(await fetchAllRows<Row>(fakeTable(10).page))
    assert.equal('requests' in r, false)
  })
})

// ── Documented constants ──────────────────────────────────────────────────────

describe('documented constants', () => {
  test('match what the server actually enforces', () => {
    // Measured against the live project on 2026-07-30: `.limit(50000)` returned
    // exactly 1000 rows.
    assert.equal(POSTGREST_MAX_ROWS, 1000)
    assert.ok(PAGED_FETCH_ROW_CAP > POSTGREST_MAX_ROWS)
  })

  test('the row cap bounds the worst-case request count', () => {
    const maxPages = Math.ceil(PAGED_FETCH_ROW_CAP / POSTGREST_MAX_ROWS)
    assert.equal(maxPages, 100)
    assert.ok(maxPages * 2 <= 200, 'with one retry per page, at most 200 attempts')
  })
})
