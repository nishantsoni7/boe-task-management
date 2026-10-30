// Database regression suite for 20270510000000 (minop_punches) and
// 20270510000100 (users.minop_user_id).
//
// Applies the REAL migrations on an in-memory Postgres (PGlite). Stubbed, and
// said so: minop_webhook_deliveries (only the columns the backfill reads), users
// (id only).
//
// NOT part of npm test (PGlite is not an app dependency). Run:
//   node supabase/tests/minop_punches_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all 10 checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node minop_punches_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PUNCHES = readFileSync(`${REPO}/supabase/migrations/20270510000000_minop_punches.sql`, 'utf8')
const USERS = readFileSync(`${REPO}/supabase/migrations/20270510000100_users_minop_user_id.sql`, 'utf8')

// The production cases, in the shapes production holds them.
const earlier = { trans: [
  { txnId: '41', dvcId: '1', dvcIP: '127.0.0.2', punchId: 1, txnDateTime: '2026-10-28 13:20:53', mode: '8' },
  { txnId: 21, dvcId: 1, dvcIP: '192.168.1.1', punchId: 1000, txnDateTime: '2018-05-11 18:05:36', mode: 'IN' },
] }
const replay = earlier
const reusedTxn = { trans: [
  { txnId: '21', dvcId: '1', punchId: 4, txnDateTime: '2026-10-28 16:48:11', mode: 'IN' },
  { txnId: '50', dvcId: '1', punchId: '', txnDateTime: '2026-10-28 16:50:00', mode: '8' },
  { txnId: '51', dvcId: '1', punchId: 5, txnDateTime: '2026-10-28', mode: '8' },
] }

const db = new PGlite()
await db.exec(`
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create table public.users (id uuid primary key default gen_random_uuid());
create table public.minop_webhook_deliveries (
  id uuid primary key default gen_random_uuid(), received_at timestamptz not null,
  processing_status text not null, payload jsonb
);
grant usage on schema public to anon, authenticated, service_role;
-- As on Supabase: new tables are granted to anon and authenticated unless the migration revokes them.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
`)
const deliver = (at, status, payload) => db.query(
  'insert into public.minop_webhook_deliveries (received_at, processing_status, payload) values ($1, $2, $3)',
  [at, status, payload === null ? null : JSON.stringify(payload)],
)
await deliver('2026-10-28 08:00:00+00', 'received', replay)
await deliver('2026-10-28 07:55:00+00', 'received', earlier)
await deliver('2026-10-28 11:30:00+00', 'received', reusedTxn)
await deliver('2026-10-28 12:00:00+00', 'received', { dvcSrNo: '911', dvcTime: 'say hello' })
await deliver('2026-10-28 12:30:00+00', 'quarantined_invalid_json', null)
await db.exec(PUNCHES)
await db.exec(USERS)

let passed = 0
const check = async (name, fn) => { await fn(); passed += 1; console.log('ok', passed, '-', name) }
const as = async (role, sql, params) => {
  await db.exec(`set role ${role};`)
  try { return await db.query(sql, params) } finally { await db.exec('reset role;') }
}
const rejects = async (fn, pattern) => {
  let err = null
  try { await fn() } catch (e) { err = e }
  assert.ok(err, 'expected an error')
  if (pattern) assert.match(String(err.message), pattern)
}
const rows = () => db.query(`select minop_user_id, txn_id, mode, to_char(punch_local, 'YYYY-MM-DD HH24:MI:SS') as local,
  to_char(punch_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') as utc, to_char(first_seen_at at time zone 'UTC', 'HH24:MI') as seen
  from public.minop_punches order by punch_local`)

await check('the backfill keeps each punch once, skipping what it cannot read', async () => {
  const r = await rows()
  assert.deepEqual(r.rows.map(x => x.minop_user_id), ['1000', '1', '4'])
})

await check('a punch delivered twice takes the earliest receipt time', async () => {
  const r = await rows()
  assert.equal(r.rows.find(x => x.minop_user_id === '1').seen, '07:55')
})

await check('a reused transaction id does not lose a real punch', async () => {
  const r = await rows()
  assert.deepEqual(r.rows.filter(x => x.txn_id === '21').map(x => x.minop_user_id).sort(), ['1000', '4'])
})

await check('punch_local is kept as sent and punch_at is that time in IST', async () => {
  const one = (await rows()).rows.find(x => x.minop_user_id === '1')
  assert.equal(one.local, '2026-10-28 13:20:53')
  assert.equal(one.utc, '2026-10-28 07:50:53')
})

const LIVE = `insert into public.minop_punches (dvc_id, minop_user_id, punch_local, punch_at, txn_id, mode, first_seen_at)
  values ('1', '1', '2026-10-28 13:20:53', '2026-10-28T07:50:53.000Z', '999', '8', '2026-10-30 09:00:00+00')
  on conflict (dvc_id, minop_user_id, punch_local) do nothing`

await check('the live write of a punch already held changes nothing', async () => {
  const before = (await rows()).rows
  await as('service_role', LIVE)
  assert.deepEqual((await rows()).rows, before)
})

await check('a different person at the same second is a separate punch', async () => {
  await as('service_role', LIVE.replace("'1', '1'", "'1', '2'"))
  const r = await rows()
  assert.deepEqual(r.rows.filter(x => x.local === '2026-10-28 13:20:53').map(x => x.minop_user_id).sort(), ['1', '2'])
})

await check('anon and authenticated can read and write nothing', async () => {
  for (const role of ['anon', 'authenticated']) {
    await rejects(() => as(role, 'select * from public.minop_punches'), /permission denied/)
    await rejects(() => as(role, LIVE), /permission denied/)
  }
})

await check('a blank machine ID is refused by the table', async () => {
  await rejects(() => as('service_role', LIVE.replace("'1', '1'", "'1', '  '")), /minop_punches_user_not_blank|violates check/)
})

await check('users.minop_user_id: two employees cannot share an ID; blanks are refused; NULLs repeat freely', async () => {
  await db.exec("insert into public.users (minop_user_id) values ('1'), (null), (null)")
  await rejects(() => db.exec("insert into public.users (minop_user_id) values ('1')"), /users_minop_user_id_key|duplicate key/)
  await rejects(() => db.exec("insert into public.users (minop_user_id) values ('  ')"), /users_minop_user_id_not_blank|violates check/)
})

await check('the migrations touch no attendance or payroll object', async () => {
  const sql = (PUNCHES + USERS).replace(/--.*$/gm, '')
  assert.doesNotMatch(sql, /attendance_records|payroll_/)
})

console.log(`all ${passed} checks passed`)
