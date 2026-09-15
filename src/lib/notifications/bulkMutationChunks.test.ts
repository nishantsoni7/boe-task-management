/**
 * mutateInChunks — the engine behind the Task feed's Mark all read and Delete
 * all.
 *
 * Driven with a controllable fake mutation, so concurrency and the timing of a
 * failure are observed rather than assumed.
 *
 * Run:
 *   npx tsx --test src/lib/notifications/bulkMutationChunks.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MUTATION_CONCURRENCY, MUTATION_ID_CHUNK_SIZE, mutateInChunks } from './taskNotificationPolicy'

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id${i}`)
const tick = () => new Promise(resolve => setTimeout(resolve, 5))
const committed = (chunk: string[]) => ({ data: chunk.map(id => ({ id })), error: null })

test('every id is mutated exactly once and every changed row is returned', async () => {
  const seen: string[] = []
  const res = await mutateInChunks(ids(2 * MUTATION_ID_CHUNK_SIZE + 50), async chunk => {
    seen.push(...chunk)
    return committed(chunk)
  })
  assert.equal(res.error, null)
  assert.equal(res.totalChunks, 3)
  assert.equal(res.completedChunks, 3)
  assert.deepEqual([...seen].sort(), ids(2 * MUTATION_ID_CHUNK_SIZE + 50).sort())
  assert.equal(res.rows.length, 2 * MUTATION_ID_CHUNK_SIZE + 50)
  assert.ok(res.rows.length > 0)
})

test('chunks overlap in flight, never more than the bound at once', async () => {
  const chunkCount = MUTATION_CONCURRENCY * 2 + 1
  let inFlight = 0
  let peak = 0
  const res = await mutateInChunks(ids(chunkCount * MUTATION_ID_CHUNK_SIZE), async chunk => {
    inFlight++
    peak = Math.max(peak, inFlight)
    await tick()
    inFlight--
    return committed(chunk)
  })
  assert.equal(res.completedChunks, chunkCount)
  assert.equal(peak, MUTATION_CONCURRENCY, 'bounded, and actually concurrent')
})

test('a whole real inbox is sent in one wave: every chunk starts before any finishes', async () => {
  // 404 visible rows was the largest production inbox (September 2026).
  const chunkCount = Math.ceil(404 / MUTATION_ID_CHUNK_SIZE)
  assert.ok(chunkCount <= MUTATION_CONCURRENCY, 'the largest real inbox fits in one wave')
  const events: string[] = []
  await mutateInChunks(ids(404), async chunk => {
    events.push('start')
    await tick()
    events.push('end')
    return committed(chunk)
  })
  assert.deepEqual(events, [...Array(chunkCount).fill('start'), ...Array(chunkCount).fill('end')])
})

test('a failure part-way reports what committed and starts no further chunks', async () => {
  let n = 0
  const started: number[] = []
  const res = await mutateInChunks(ids(10 * MUTATION_ID_CHUNK_SIZE), async chunk => {
    const me = n++
    started.push(me)
    await tick()
    return me === 1 ? { data: null, error: { message: 'boom' } } : committed(chunk)
  }, { concurrency: 2 })

  assert.deepEqual(res.error, { message: 'boom' })
  assert.equal(res.totalChunks, 10)
  assert.ok(started.length < 10, 'no new chunk starts after the failure is seen')
  assert.equal(res.completedChunks, started.length - 1, 'every started chunk but the failed one committed')
  assert.equal(res.rows.length, res.completedChunks * MUTATION_ID_CHUNK_SIZE)
})

test('a thrown request is a failure, not a crash', async () => {
  const res = await mutateInChunks(ids(3), async () => { throw new Error('network down') })
  assert.deepEqual(res.error, { message: 'network down' })
  assert.equal(res.completedChunks, 0)
  assert.deepEqual(res.rows, [])
})

test('nothing to mutate sends nothing', async () => {
  let called = false
  const res = await mutateInChunks([], async chunk => { called = true; return committed(chunk) })
  assert.equal(called, false)
  assert.deepEqual(res, { rows: [], completedChunks: 0, totalChunks: 0, error: null })
})
