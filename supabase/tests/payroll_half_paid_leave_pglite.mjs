// Database regression suite for 20270604000000 (payroll_results.paid_leave_available and
// paid_leave_used become numeric(3,1) so a payslip can hold half a paid leave).
//
// Applies the REAL migrations on an in-memory Postgres (PGlite): 20260612000000, which creates
// payroll_results with the smallint columns, then 20270604000000. Stubbed, and said so: auth.uid(),
// the three roles, public.users (id, role) and public.payroll_periods (id).
//
// NOT part of npm test (PGlite is not an app dependency). Run:
//   node supabase/tests/payroll_half_paid_leave_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all 8 checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node payroll_half_paid_leave_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const TABLES = readFileSync(`${REPO}/supabase/migrations/20260612000000_create_payroll_generation_tables.sql`, 'utf8')
const HALF = readFileSync(`${REPO}/supabase/migrations/20270604000000_payroll_results_half_paid_leave.sql`, 'utf8')

const db = new PGlite()
await db.exec(`
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create table public.users (id uuid primary key default gen_random_uuid(), role text);
create table public.payroll_periods (id uuid primary key default gen_random_uuid());
grant usage on schema public to anon, authenticated, service_role;
`)
await db.exec(TABLES)

const EMP_A = '00000000-0000-0000-0000-0000000000a1'
const EMP_B = '00000000-0000-0000-0000-0000000000b2'
const EMP_C = '00000000-0000-0000-0000-0000000000c3'
const PERIOD = '10000000-0000-0000-0000-000000000001'
await db.exec(`
insert into public.users (id, role) values ('${EMP_A}', 'employee'), ('${EMP_B}', 'employee'), ('${EMP_C}', 'employee');
insert into public.payroll_periods (id) values ('${PERIOD}');
`)

const save = (employee, available, used) => db.query(
  `insert into public.payroll_results (payroll_period_id, employee_id, monthly_salary, paid_leave_available, paid_leave_used)
   values ($1, $2, 26000, $3, $4)`,
  [PERIOD, employee, available, used],
)
const read = async employee => (await db.query(
  `select paid_leave_available::text as available, paid_leave_used::text as used
     from public.payroll_results where employee_id = $1`, [employee])).rows[0]
const columns = async () => (await db.query(
  `select column_name, data_type, numeric_precision, numeric_scale from information_schema.columns
    where table_schema = 'public' and table_name = 'payroll_results'
      and column_name in ('paid_leave_available', 'paid_leave_used') order by column_name`)).rows
const rejects = async (fn, pattern) => {
  let err = null
  try { await fn() } catch (e) { err = e }
  assert.ok(err, 'expected an error')
  assert.match(String(err.message), pattern)
}

let passed = 0
const check = async (name, fn) => { await fn(); passed += 1; console.log('ok', passed, '-', name) }

// Whole values stored the way production holds them today: a full leave and none.
await save(EMP_A, 1, 1)
await save(EMP_B, 0, 0)

await check('before: the original column refuses 0.5 (the October 2026 failure)', async () => {
  await rejects(() => save(EMP_C, 0.5, 0), /invalid input syntax for type smallint/)
})

await db.exec(HALF)

await check('after: both columns are numeric(3,1)', async () => {
  assert.deepEqual(await columns(), [
    { column_name: 'paid_leave_available', data_type: 'numeric', numeric_precision: 3, numeric_scale: 1 },
    { column_name: 'paid_leave_used',      data_type: 'numeric', numeric_precision: 3, numeric_scale: 1 },
  ])
})

await check('existing whole values are kept exactly', async () => {
  assert.deepEqual(await read(EMP_A), { available: '1.0', used: '1.0' })
  assert.deepEqual(await read(EMP_B), { available: '0.0', used: '0.0' })
})

await check('a payslip with 0.5 available and 0.5 used now saves and reads back', async () => {
  await save(EMP_C, 0.5, 0.5)
  assert.deepEqual(await read(EMP_C), { available: '0.5', used: '0.5' })
})

await check('0.5 available with none used saves too (15 days present, nothing to absorb)', async () => {
  await db.query('delete from public.payroll_results where employee_id = $1', [EMP_C])
  await save(EMP_C, 0.5, 0)
  assert.deepEqual(await read(EMP_C), { available: '0.5', used: '0.0' })
})

await check('the migration can be applied again without error (it changes nothing the second time)', async () => {
  await db.exec(HALF)
  assert.deepEqual(await read(EMP_A), { available: '1.0', used: '1.0' })
})

await check('the self-assertion is live: with a column put back to smallint it aborts the apply', async () => {
  const assertion = HALF.slice(HALF.indexOf('do $$'))
  assert.ok(assertion.startsWith('do $$'), 'could not find the assertion block')
  await db.exec('delete from public.payroll_results where employee_id = ' + `'${EMP_C}'`)
  await db.exec('alter table public.payroll_results alter column paid_leave_used type smallint using round(paid_leave_used)::smallint')
  await rejects(() => db.exec(assertion), /PAID_LEAVE_HALF: payroll_results\.paid_leave_used is smallint/)
})

await check('and the apply put back leaves it right again', async () => {
  await db.exec(HALF)
  assert.deepEqual((await columns()).map(c => `${c.data_type}(${c.numeric_precision},${c.numeric_scale})`), ['numeric(3,1)', 'numeric(3,1)'])
})

console.log(`all ${passed} checks passed`)
