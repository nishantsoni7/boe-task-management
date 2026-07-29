/**
 * mapWithConcurrency — behavioural tests
 *
 * This helper replaced the sequential `for (const f of files) await upload(f)`
 * loops in the three task-creation paths and the task-detail comment box. The
 * properties that make that swap safe are: results stay in input order (so the
 * UI still lists attachments as the user picked them), no more than `limit`
 * run at once (so a dozen files cannot saturate the connection pool), and
 * every item is processed exactly once.
 *
 * Run:
 *   npx tsx --test src/lib/attachmentConcurrency.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mapWithConcurrency, ATTACHMENT_UPLOAD_CONCURRENCY } from './attachment-utils'

const tick = (n = 0) => new Promise<void>(r => setTimeout(r, n))

describe('mapWithConcurrency', () => {
  test('returns results in INPUT order regardless of completion order', async () => {
    // Deliberately inverted delays: the last item finishes first.
    const items = [30, 20, 10, 0]
    const out = await mapWithConcurrency(items, 4, async (ms) => { await tick(ms); return ms })
    assert.deepEqual(out, [30, 20, 10, 0])
  })

  test('never exceeds the concurrency limit', async () => {
    let inFlight = 0
    let peak = 0
    const items = Array.from({ length: 9 }, (_, i) => i)

    await mapWithConcurrency(items, 3, async (i) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await tick(5)
      inFlight--
      return i
    })

    assert.equal(peak, 3, `peak concurrency was ${peak}, expected 3`)
  })

  test('processes every item exactly once', async () => {
    const items = Array.from({ length: 25 }, (_, i) => i)
    const seen: number[] = []
    const out = await mapWithConcurrency(items, 4, async (i) => { await tick(1); seen.push(i); return i * 2 })

    assert.equal(seen.length, 25)
    assert.deepEqual([...seen].sort((a, b) => a - b), items)
    assert.deepEqual(out, items.map(i => i * 2))
  })

  test('an empty input does no work and returns an empty array', async () => {
    let called = false
    assert.deepEqual(await mapWithConcurrency([], 3, async () => { called = true; return 1 }), [])
    assert.equal(called, false)
  })

  test('a limit larger than the input does not spawn idle runners', async () => {
    let peak = 0
    let inFlight = 0
    await mapWithConcurrency([1, 2], 10, async (n) => {
      inFlight++; peak = Math.max(peak, inFlight); await tick(2); inFlight--; return n
    })
    assert.equal(peak, 2)
  })

  test('a limit below 1 is clamped to serial rather than deadlocking', async () => {
    const out = await mapWithConcurrency([1, 2, 3], 0, async (n) => n)
    assert.deepEqual(out, [1, 2, 3])
  })

  test('a thrown worker error propagates instead of becoming a silent partial success', async () => {
    // The upload callers return {ok:false} for expected failures; a genuine
    // throw must still surface, not be swallowed into a "succeeded" result.
    await assert.rejects(
      () => mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('upload exploded')
        return n
      }),
      /upload exploded/,
    )
  })

  test('the shared upload concurrency is a small positive window', async () => {
    assert.equal(Number.isInteger(ATTACHMENT_UPLOAD_CONCURRENCY), true)
    assert.equal(ATTACHMENT_UPLOAD_CONCURRENCY >= 2, true)
    // Kept well under the browser's ~6 connections per host so uploads cannot
    // starve the rest of the page.
    assert.equal(ATTACHMENT_UPLOAD_CONCURRENCY <= 4, true)
  })

  test('is genuinely faster than serial for slow work', async () => {
    const items = Array.from({ length: 6 }, (_, i) => i)
    const started = Date.now()
    await mapWithConcurrency(items, 3, async () => { await tick(20); return 0 })
    const elapsed = Date.now() - started
    // 6 items × 20ms serial = 120ms; at width 3 it is ~40ms. A generous bound
    // keeps this from flaking on a loaded machine while still failing if the
    // helper silently degraded to serial.
    assert.equal(elapsed < 110, true, `took ${elapsed}ms — looks serial`)
  })
})
