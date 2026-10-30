/**
 * Reading a stored Minop delivery into punches kept once, and the guarantees
 * around it. Pure logic plus source pins — no database is touched. The table
 * itself is exercised by supabase/tests/minop_punches_pglite.mjs.
 *
 * Run:
 *   npm run test:file -- src/lib/minop/punches.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  MINOP_DEVICE_UTC_OFFSET_MINUTES,
  deviceTimeToUtcIso,
  extractMinopPunches,
  isPlausiblePunchTime,
  recordMinopPunches,
} from './punches'
import { summariseUnmapped } from './unmapped'
import { handleMinopPathTokenWebhook } from './pathTokenWebhook'

// Production shape, 2026-10: punchId is a JSON number, the rest are strings.
const real = {
  trans: [{ txnId: '41', dvcId: '1', dvcIP: '127.0.0.2', punchId: 1, txnDateTime: '2026-09-24 15:23:14', mode: '8' }],
}

const MIGRATION = 'supabase/migrations/20270510000000_minop_punches.sql'
const USERS_MIGRATION = 'supabase/migrations/20270510000100_users_minop_user_id.sql'

test('the machine clock is read as IST (+05:30)', () => {
  assert.equal(MINOP_DEVICE_UTC_OFFSET_MINUTES, 330)
  assert.equal(deviceTimeToUtcIso('2026-09-24 15:23:14'), '2026-09-24T09:53:14.000Z')
})

test('machine time just after midnight maps to the previous UTC day', () => {
  assert.equal(deviceTimeToUtcIso('2026-10-01 00:10:00'), '2026-09-30T18:40:00.000Z')
})

test('impossible or malformed machine times are refused, never rolled over', () => {
  assert.equal(deviceTimeToUtcIso('2026-02-31 10:00:00'), null)
  assert.equal(deviceTimeToUtcIso('2026-09-24 25:00:00'), null)
  assert.equal(deviceTimeToUtcIso('24/09/2026 10:00'), null)
  assert.equal(deviceTimeToUtcIso(''), null)
})

test('a real trans[] punch becomes one row; numeric punchId is stringified', () => {
  assert.deepEqual(extractMinopPunches(real), [{
    dvc_id: '1',
    minop_user_id: '1',
    punch_local: '2026-09-24 15:23:14',
    punch_at: '2026-09-24T09:53:14.000Z',
    txn_id: '41',
    mode: '8',
  }])
})

test('a reused transaction id does not merge two people: production txn 21 carried both of these', () => {
  const rows = extractMinopPunches({
    trans: [
      { txnId: 21, dvcId: 1, punchId: 1000, txnDateTime: '2018-05-11 18:05:36', mode: 'IN' },
      { txnId: '21', dvcId: '1', punchId: '4', txnDateTime: '2026-10-28 16:48:11', mode: 'IN' },
    ],
  })
  const keys = rows.map(r => `${r.dvc_id}|${r.minop_user_id}|${r.punch_local}`)
  assert.equal(new Set(keys).size, 2)
})

test('a replay yields an identical key, so the unique constraint collapses it', () => {
  const key = (rows: ReturnType<typeof extractMinopPunches>) => rows.map(r => [r.dvc_id, r.minop_user_id, r.punch_local])
  assert.deepEqual(key(extractMinopPunches(real)), key(extractMinopPunches(JSON.parse(JSON.stringify(real)))))
})

test('a punch with no txnId is still a punch', () => {
  const { txnId: _txnId, ...noTxn } = real.trans[0]
  void _txnId
  const [row] = extractMinopPunches({ trans: [noTxn] })
  assert.equal(row.txn_id, null)
  assert.equal(row.minop_user_id, '1')
})

test('unreadable entries are skipped, readable ones kept, nothing guessed', () => {
  const rows = extractMinopPunches({
    trans: [null, 'x', { punchId: '', txnDateTime: '2026-09-24 10:00:00' }, { punchId: 5, txnDateTime: 'nope' }, real.trans[0]],
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].minop_user_id, '1')
})

test('other shapes and empty deliveries produce no punches', () => {
  assert.deepEqual(extractMinopPunches({ trans: [] }), [])
  assert.deepEqual(extractMinopPunches({ RealTime: { PunchLog: { UserId: '7' } } }), [])
  assert.deepEqual(extractMinopPunches(null), [])
  assert.deepEqual(extractMinopPunches([real]), [])
})

test('a punch sent days late is plausible; Minop\'s 2018 sample and a clock far ahead are not', () => {
  const received = '2026-10-30T07:36:17.000Z'
  assert.equal(isPlausiblePunchTime('2026-10-30T07:29:24.000Z', received), true, '7 minutes late, production')
  assert.equal(isPlausiblePunchTime('2026-10-24T07:36:17.000Z', received), true, '6 days late, the longest production delay')
  assert.equal(isPlausiblePunchTime('2018-05-11T12:35:36.000Z', received), false, 'the sample message')
  assert.equal(isPlausiblePunchTime('2026-10-30T09:36:18.000Z', received), false, 'two hours in the future')
  assert.equal(isPlausiblePunchTime('not a time', received), false)
})

function fakeWriter(result: { error: { message: string } | null } | 'throw' = { error: null }) {
  const calls: { table: string; rows: Record<string, unknown>[]; options: Record<string, unknown> }[] = []
  return {
    calls,
    from: (table: string) => ({
      upsert: async (rows: Record<string, unknown>[], options: Record<string, unknown>) => {
        calls.push({ table, rows, options })
        if (result === 'throw') throw new Error('network')
        return result
      },
    }),
  }
}

test('recording writes one table, stamps the receipt time, and leaves a punch already held alone', async () => {
  const svc = fakeWriter()
  await recordMinopPunches(svc, '2026-10-30T07:36:17.000Z', real)
  assert.equal(svc.calls.length, 1)
  assert.equal(svc.calls[0].table, 'minop_punches')
  assert.equal(svc.calls[0].rows[0].first_seen_at, '2026-10-30T07:36:17.000Z')
  assert.deepEqual(svc.calls[0].options, { onConflict: 'dvc_id,minop_user_id,punch_local', ignoreDuplicates: true })
})

test('a database error or a throw never escapes; no punches means no write', async () => {
  await recordMinopPunches(fakeWriter({ error: { message: 'boom' } }), 'r', real)
  await recordMinopPunches(fakeWriter('throw'), 'r', real)
  const none = fakeWriter()
  await recordMinopPunches(none, 'r', { trans: [] })
  assert.equal(none.calls.length, 0)
})

const TOKEN = '0123456789abcdef'.repeat(4)
const post = (body: string) => new Request('https://boe.example/x', { method: 'POST', body })

test('the webhook still acknowledges Minop when recording the punches throws', async () => {
  const recorded: unknown[][] = []
  const res = await handleMinopPathTokenWebhook(post(JSON.stringify(real)), TOKEN, {
    configuredToken: TOKEN,
    insertDelivery: async () => ({ ok: true, receivedAt: '2026-10-30T07:36:17.000Z' }),
    recordPunches: async (receivedAt, payload) => { recorded.push([receivedAt, payload]); throw new Error('table down') },
  })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { transStatus: [{ txnId: '41', status: 1 }] })
  assert.deepEqual(recorded, [['2026-10-30T07:36:17.000Z', real]])
})

test('punches are not recorded for a delivery that was not stored, or was invalid JSON', async () => {
  const recorded: string[] = []
  const deps = (ok: boolean) => ({
    configuredToken: TOKEN,
    insertDelivery: async () => ({ ok, receivedAt: ok ? 'r' : undefined }),
    recordPunches: async (receivedAt: string) => { recorded.push(receivedAt) },
  })
  assert.equal((await handleMinopPathTokenWebhook(post(JSON.stringify(real)), TOKEN, deps(false))).status, 500)
  assert.equal((await handleMinopPathTokenWebhook(post('not json'), TOKEN, deps(true))).status, 400)
  assert.deepEqual(recorded, [])
})

const seen = '2026-10-30T07:36:17.000Z'
const lite = (minop_user_id: string, punch_local: string) => ({
  minop_user_id, punch_local, punch_at: deviceTimeToUtcIso(punch_local) ?? '', first_seen_at: seen,
})

test('unlinked IDs: linked ones are excluded, exact-text match, newest first', () => {
  const result = summariseUnmapped([
    lite('1', '2026-10-24 10:00:00'),
    lite('2', '2026-10-24 11:00:00'),
    lite('2', '2026-10-25 09:00:00'),
    lite('01', '2026-10-26 09:00:00'),
  ], new Set(['1']))
  assert.deepEqual(result, [
    { minopUserId: '01', punchCount: 1, lastPunchLocal: '2026-10-26 09:00:00' },
    { minopUserId: '2', punchCount: 2, lastPunchLocal: '2026-10-25 09:00:00' },
  ])
})

test('unlinked IDs: Minop\'s 2018 sample punches are not people to link', () => {
  assert.deepEqual(summariseUnmapped([lite('1000', '2018-05-11 18:05:36'), lite('1001', '2018-05-11 18:05:52')], new Set()), [])
})

test('the backfill in the migration reads the same fields and the same key as the live path', () => {
  const sql = readFileSync(MIGRATION, 'utf8').replace(/--.*$/gm, '')
  assert.match(sql, /unique \(dvc_id, minop_user_id, punch_local\)/)
  assert.match(sql, /on conflict \(dvc_id, minop_user_id, punch_local\) do nothing/)
  assert.match(sql, /select distinct on \(dvc_id, minop_user_id, punch_local\)/)
  assert.match(sql, /order by dvc_id, minop_user_id, punch_local, received_at/)
  for (const field of ['dvcId', 'punchId', 'txnDateTime', 'txnId', 'mode']) assert.match(sql, new RegExp(`'${field}'`))
  assert.match(sql, /at time zone 'Asia\/Kolkata'/)
})

test('source pins: punches.ts writes only minop_punches; the migrations never touch attendance or payroll', () => {
  const punches = readFileSync('src/lib/minop/punches.ts', 'utf8')
  assert.deepEqual(punches.match(/\.from\('[a-z_]+'\)/g), [".from('minop_punches')"])
  assert.doesNotMatch(punches, /attendance_records|payroll_|\.rpc\(|\.update\(|\.delete\(/)

  const sql = readFileSync(MIGRATION, 'utf8').replace(/--.*$/gm, '')
  assert.doesNotMatch(sql, /attendance_records|payroll_/)
  assert.match(sql, /enable row level security/)
  assert.match(sql, /revoke all on public\.minop_punches from anon, authenticated/)

  const users = readFileSync(USERS_MIGRATION, 'utf8').replace(/--.*$/gm, '')
  assert.match(users, /create unique index users_minop_user_id_key/)
  assert.doesNotMatch(users, /grant /i)
})

test('the Machine ID stays out of every browser-readable path', () => {
  assert.doesNotMatch(readFileSync('src/lib/users/safeColumns.ts', 'utf8'), /minop_user_id/)
  const list = readFileSync('src/app/api/employee-list/route.ts', 'utf8')
  assert.match(list, /const ADMIN_COLUMNS = FULL_COLUMNS \+ ', monthly_salary, minop_user_id'/)
  assert.doesNotMatch(list.match(/const FULL_COLUMNS[^\n]*/)?.[0] ?? '', /minop_user_id/)
})

test('the unlinked-IDs route is admin-only', () => {
  assert.match(readFileSync('src/app/api/attendance/minop-unmapped/route.ts', 'utf8'), /requireAdmin\(req\)/)
})

test('the collection-only guard is still on', () => {
  assert.match(readFileSync('src/lib/minop/collectionMode.ts', 'utf8'), /export const MINOP_COLLECTION_ONLY = true/)
})
