/**
 * Collection-only guard for runMinopAttendanceProcessing.
 *
 * Minop data is stored for verification and must not create or update
 * attendance, employee mappings or payroll. The function that could do so is
 * the single choke point every caller goes through, so these tests drive it
 * with a VALID, MATCHED punch (an active employee whose fingerprint code equals
 * the punch's user ID, in an unlocked month) and prove it refuses before it
 * makes a single database call. The pure decision logic stays covered by
 * processDelivery.test.ts, attendanceMerge.test.ts and employeeMapping.test.ts.
 *
 * Run:
 *   npx tsx --test src/lib/minop/runProcessing.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runMinopAttendanceProcessing } from './runProcessing'
import { MINOP_COLLECTION_ONLY, MinopCollectionOnlyError } from './collectionMode'

/** A client that records every table touched and every write attempted. */
function recordingClient() {
  const calls: string[] = []
  const builder = (path: string): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop) => {
        if (prop === 'then') return undefined
        return builder(`${path}.${String(prop)}`)
      },
      apply: () => { calls.push(path); return builder(path) },
    })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = { from: (table: string) => { calls.push(`from(${table})`); return builder(`from(${table})`) } }
  return { client, calls }
}

const MATCHED_PUNCH = {
  RealTime: {
    OperationID: 'op-1',
    PunchLog: { UserId: '0014', LogTime: '2026-09-30T04:15:00Z', Type: 'CheckIn' },
  },
}

test('Minop is collection-only in this phase', () => {
  assert.equal(MINOP_COLLECTION_ONLY, true)
})

test('a valid, matched CheckIn is refused and the database is never touched', async () => {
  const { client, calls } = recordingClient()
  await assert.rejects(
    runMinopAttendanceProcessing(client, { id: 'delivery-1', payload: MATCHED_PUNCH }),
    MinopCollectionOnlyError,
  )
  assert.deepEqual(calls, [])
})

test('a valid, matched CheckOut and a malformed payload are refused the same way', async () => {
  for (const payload of [
    { RealTime: { PunchLog: { UserId: '0014', LogTime: '2026-09-30T12:15:00Z', Type: 'CheckOut' } } },
    { not: 'a punch' },
    null,
  ]) {
    const { client, calls } = recordingClient()
    await assert.rejects(runMinopAttendanceProcessing(client, { id: 'delivery-2', payload }), MinopCollectionOnlyError)
    assert.deepEqual(calls, [])
  }
})

test('the refusal says why, in plain words', async () => {
  const { client } = recordingClient()
  await assert.rejects(
    runMinopAttendanceProcessing(client, { id: 'delivery-3', payload: MATCHED_PUNCH }),
    /collection-only/,
  )
})
