/**
 * fetchAllRows — the guard against PostgREST's silent 1000-row cap.
 *
 * This is the highest-value test file in the Performance set, because the bug it
 * covers produced a page that was internally consistent and completely wrong:
 * every score, every rate, every ranking and every trend was computed from 25% of
 * the activity log, with no error anywhere. Fixtures never caught it because
 * fixtures are never 1000 rows long.
 *
 * Run:
 *   npx tsx --test src/lib/supabasePaging.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { fetchAllRows, POSTGREST_MAX_ROWS, PAGED_FETCH_ROW_CAP } from './supabasePaging'

/**
 * A fake PostgREST that enforces a hard per-response cap, exactly as the real one
 * does: it silently returns fewer rows than asked for, with no error.
 */
function fakeTable(totalRows: number, serverCap = POSTGREST_MAX_ROWS) {
  const all = Array.from({ length: totalRows }, (_, i) => ({ id: i }))
  const calls: [number, number][] = []
  const page = async (from: number, to: number) => {
    calls.push([from, to])
    const requested = to - from + 1
    const capped = Math.min(requested, serverCap)
    return { data: all.slice(from, from + capped), error: null }
  }
  return { page, calls, all }
}

describe('fetchAllRows', () => {
  test('a small table costs exactly one request', async () => {
    const t = fakeTable(42)
    const r = await fetchAllRows(t.page)
    assert.equal(r.rows.length, 42)
    assert.equal(r.requests, 1)
    assert.equal(r.error, null)
    assert.equal(r.truncated, false)
  })

  test('an empty table costs one request and yields nothing', async () => {
    const t = fakeTable(0)
    const r = await fetchAllRows(t.page)
    assert.deepEqual(r.rows, [])
    assert.equal(r.requests, 1)
  })

  // The actual bug: 4100 rows behind a 1000-row cap.
  test('reads every row past the server cap', async () => {
    const t = fakeTable(4100)
    const r = await fetchAllRows(t.page)
    assert.equal(r.rows.length, 4100)
    assert.equal(r.requests, 5)          // 1000 ×4 + a final short page of 100
    assert.equal(r.truncated, false)
    // No row skipped and none duplicated.
    assert.deepEqual(r.rows.map(x => x.id), t.all.map(x => x.id))
    assert.equal(new Set(r.rows.map(x => x.id)).size, 4100)
  })

  test('a single un-paged read would have lost 75% of that table', async () => {
    // What the route used to do: ask for 100000, receive 1000, notice nothing.
    const t = fakeTable(4100)
    const { data } = await t.page(0, 99_999)
    assert.equal(data.length, 1000)
    assert.equal(data.length / 4100 < 0.25, true)
  })

  test('an exact multiple of the page size still terminates', async () => {
    // The boundary case: 2000 rows means a full second page, so the loop must make
    // a third request to discover the data has run out.
    const t = fakeTable(2000)
    const r = await fetchAllRows(t.page)
    assert.equal(r.rows.length, 2000)
    assert.equal(r.requests, 3)
    assert.equal(r.truncated, false)
  })

  test('page windows are contiguous and non-overlapping', async () => {
    const t = fakeTable(2500)
    await fetchAllRows(t.page)
    assert.deepEqual(t.calls, [[0, 999], [1000, 1999], [2000, 2999]])
  })

  test('an error stops the read and is returned, not thrown', async () => {
    let n = 0
    const r = await fetchAllRows<{ id: number }>(async (from, to) => {
      n++
      if (n === 2) return { data: null, error: { message: 'connection reset' } }
      return { data: Array.from({ length: to - from + 1 }, (_, i) => ({ id: from + i })), error: null }
    })
    assert.equal(r.error, 'connection reset')
    assert.equal(r.requests, 2)
    // Partial rows are still returned so a caller can log how far it got, but the
    // error is what the route acts on.
    assert.equal(r.rows.length, 1000)
  })

  test('the row cap reports truncated rather than under-reporting silently', async () => {
    const t = fakeTable(5000)
    const r = await fetchAllRows(t.page, 1000, 2000)
    assert.equal(r.truncated, true)
    assert.equal(r.rows.length, 2000)
    // The whole point: the caller can tell, so it can refuse instead of misleading.
    assert.notEqual(r.rows.length, 5000)
  })

  test('a null data page is treated as empty, not as a crash', async () => {
    const r = await fetchAllRows<{ id: number }>(async () => ({ data: null, error: null }))
    assert.deepEqual(r.rows, [])
    assert.equal(r.error, null)
  })

  test('the documented constants match what the server actually enforces', () => {
    // Measured against the live project on 2026-07-30: `.limit(50000)` returned
    // exactly 1000 rows.
    assert.equal(POSTGREST_MAX_ROWS, 1000)
    assert.ok(PAGED_FETCH_ROW_CAP > POSTGREST_MAX_ROWS)
  })

  // ── Transient-failure retry ──────────────────────────────────────────────────
  // Paging multiplied the request count, and a `TypeError: terminated` was observed
  // live on roughly one page load in six.
  test('a transient connection abort is retried once and then succeeds', async () => {
    let n = 0
    const r = await fetchAllRows<{ id: number }>(async () => {
      n++
      if (n === 1) return { data: null, error: { message: 'TypeError: terminated' } }
      return { data: [{ id: 1 }], error: null }
    })
    assert.equal(r.error, null)
    assert.deepEqual(r.rows, [{ id: 1 }])
    assert.equal(r.requests, 2)
  })

  test('a thrown fetch failure is caught and retried, not propagated', async () => {
    let n = 0
    const r = await fetchAllRows<{ id: number }>(async () => {
      n++
      if (n === 1) throw new TypeError('fetch failed')
      return { data: [{ id: 7 }], error: null }
    })
    assert.equal(r.error, null)
    assert.deepEqual(r.rows, [{ id: 7 }])
  })

  test('a persistent transient error gives up after one retry', async () => {
    let n = 0
    const r = await fetchAllRows<{ id: number }>(async () => {
      n++
      return { data: null, error: { message: 'terminated' } }
    })
    assert.equal(r.error, 'terminated')
    assert.equal(n, 2, 'exactly one retry, not an unbounded loop')
  })

  test('a schema or permission error is NOT retried', async () => {
    let n = 0
    const r = await fetchAllRows<{ id: number }>(async () => {
      n++
      return { data: null, error: { message: 'column users.nope does not exist' } }
    })
    assert.equal(n, 1, 'a deterministic error must fail fast, not burn a retry')
    assert.match(r.error ?? '', /does not exist/)
  })

  test('a custom page size is honoured', async () => {
    const t = fakeTable(250, 100)
    const r = await fetchAllRows(t.page, 100)
    assert.equal(r.rows.length, 250)
    assert.equal(r.requests, 3)
  })
})
