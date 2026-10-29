// Database regression suite for 20270501000000 (Finance: Founders' payouts).
//
// Applies the REAL migration on an in-memory Postgres (PGlite) over a small
// stand-in for what it depends on: users, the permission registry tables and
// employee_permission_overrides. Stubbed: auth.uid() (a session setting),
// module_entry_open (admin, or a 'view' row in test_grants) and
// actor_has_permission (an active, unrevoked, allowed override — the engine's
// highest-priority level, and the only one that can hold this action, since no
// role row exists for it). Everything the migration defines is the real thing.
//
// NOT part of npm test (PGlite is not a dependency of the app). Run it with a
// directory that has @electric-sql/pglite installed:
//   node supabase/tests/founder_payouts_pglite.mjs <dir with node_modules/@electric-sql/pglite>
// Expected last line: "all N checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node founder_payouts_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const migration = readFileSync(`${REPO}/supabase/migrations/20270501000000_finance_founder_payouts.sql`, 'utf8')

const U = {
  owner:    '00000000-0000-0000-0000-0000000000a1',   // admin, employee_code TEST-001
  admin2:   '00000000-0000-0000-0000-0000000000a2',   // another admin, never granted
  finance:  '00000000-0000-0000-0000-0000000000b1',   // in Finance, not granted
  granted:  '00000000-0000-0000-0000-0000000000b2',   // granted later, then revoked
}
const FINANCE = '00000000-0000-0000-0000-00000000f001'

const db = new PGlite()
let checks = 0
const ok = (name) => { checks += 1; console.log(`  ok  ${name}`) }

await db.exec(`
create schema if not exists auth;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;

create table public.users (id uuid primary key, full_name text, role text not null default 'member',
  is_active boolean not null default true, is_deleted boolean not null default false, employee_code text unique);
create table public.permission_modules (id uuid primary key default gen_random_uuid(), module_key text unique not null);
create table public.permission_actions (id uuid primary key default gen_random_uuid(), action_key text unique not null,
  display_name text not null, is_system boolean not null default false);
create table public.module_permission_actions (module_id uuid references public.permission_modules(id),
  action_id uuid references public.permission_actions(id), default_allowed boolean not null default false,
  unique (module_id, action_id));
create table public.employee_permission_overrides (id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id), module_id uuid not null references public.permission_modules(id),
  action_id uuid not null references public.permission_actions(id), allowed boolean not null,
  granted_by uuid references public.users(id), granted_at timestamptz, revoked_by uuid, revoked_at timestamptz,
  unique (user_id, module_id, action_id));

create table public.test_grants (uid uuid, action text);
create function public.module_entry_open(m text) returns boolean language sql stable security definer as $$
  select exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
      or exists (select 1 from public.test_grants g where g.uid = auth.uid() and g.action = 'view') $$;
create function public.actor_has_permission(m text, a text) returns boolean language sql stable security definer as $$
  select exists (
    select 1 from public.employee_permission_overrides o
      join public.users u on u.id = o.user_id and u.is_active and not u.is_deleted
      join public.permission_modules pm on pm.id = o.module_id and pm.module_key = m
      join public.permission_actions pa on pa.id = o.action_id and pa.action_key = a
     where o.user_id = auth.uid() and o.allowed and o.revoked_at is null) $$;

insert into public.permission_modules (id, module_key) values ('${FINANCE}', 'finance');
insert into public.users (id, full_name, role, employee_code) values
  ('${U.owner}', 'Owner', 'admin', 'TEST-001'), ('${U.admin2}', 'Second admin', 'admin', 'ADM-2'),
  ('${U.finance}', 'Finance person', 'member', null), ('${U.granted}', 'Granted person', 'member', null);
insert into public.test_grants values ('${U.finance}', 'view'), ('${U.granted}', 'view');
`)

await db.exec(migration)
ok('the migration applies, self-checks included')

const as = async (uid) => { await db.query(`select set_config('test.uid', $1, false)`, [uid ?? '']) }
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0]
const expectError = async (fn, pattern, name) => {
  try { await fn(); assert.fail(`${name}: expected a refusal`) }
  catch (e) { assert.match(String(e.message), pattern, `${name}: ${e.message}`); ok(name) }
}
const read = async () => (await one(`select public.founder_payouts_read() as r`)).r
const savePayout = (id, paidOn, from, lines, key = null, note = null) =>
  one(`select public.founder_payout_save($1, $2::date, $3, $4, null, $5::jsonb, $6) as id`,
      [id, paidOn, from, note, JSON.stringify(lines), key]).then(r => r.id)
const saveAccount = (id, name, side, role, bank) =>
  one(`select public.founder_payout_account_save($1, $2, $3, $4, $5, true) as id`, [id, name, side, role, bank]).then(r => r.id)
const today = (await one(`select (now() at time zone 'Asia/Kolkata')::date::text as d`)).d

// ── Reach ──
{
  for (const t of ['founder_payout_accounts', 'founder_payouts', 'founder_payout_lines', 'founder_payout_account_years', 'founder_payout_firm_years']) {
    const r = await one(`select c.relrowsecurity as rls, (select count(*) from pg_policies where tablename = $1) as policies,
                                has_table_privilege('authenticated', 'public.' || $1, 'select') as sel,
                                has_table_privilege('authenticated', 'public.' || $1, 'insert') as ins
                           from pg_class c where c.relname = $1`, [t])
    assert.equal(r.rls, true); assert.equal(Number(r.policies), 0); assert.equal(r.sel, false); assert.equal(r.ins, false)
  }
  ok('all five tables: RLS on, no policies, no direct select or insert for authenticated')
  const g = await one(`select has_function_privilege('anon', 'public.founder_payouts_read()', 'execute') as anon_read,
                              has_function_privilege('authenticated', 'public.founder_payouts_read()', 'execute') as auth_read`)
  assert.equal(g.anon_read, false); assert.equal(g.auth_read, true)
  ok('anon cannot call the read; authenticated can (and meets the door)')
  const p = await one(`select mpa.default_allowed as d from public.module_permission_actions mpa
                         join public.permission_actions pa on pa.id = mpa.action_id where pa.action_key = 'founder_payouts'`)
  assert.equal(p.d, false)
  ok('finance.founder_payouts is registered deny-by-default')
  const o = await one(`select count(*) as n from public.employee_permission_overrides o
                         join public.permission_actions pa on pa.id = o.action_id and pa.action_key = 'founder_payouts'`)
  assert.equal(Number(o.n), 1)
  ok('exactly one grant was seeded: the owner account')
}

// ── Who may come in ──
{
  await as(null)
  await expectError(() => read(), /FOUNDERS_UNAUTHENTICATED/, 'no session: refused')
  await as(U.admin2)
  await expectError(() => read(), /FOUNDERS_FORBIDDEN/, 'another administrator, never granted: refused (no admin branch)')
  await as(U.finance)
  await expectError(() => read(), /FOUNDERS_FORBIDDEN/, 'a Finance user without the grant: refused')
  await expectError(() => saveAccount(null, 'Sneak', 'Nobody', 'unset', null), /FOUNDERS_FORBIDDEN/, 'and cannot write either')
  await as(U.owner)
  const r = await read()
  assert.deepEqual(r, { accounts: [], payouts: [], account_years: [], firm_years: [] })
  ok('the owner reads an empty book')
}

// ── Accounts ──
let NAMRATA, JAISHREE, NITISH
{
  await as(U.owner)
  NAMRATA = await saveAccount(null, 'Namrata', 'Nishant', 'working_partner', 'HDFC ··1123')
  JAISHREE = await saveAccount(null, 'Jaishree', 'Nishant', 'family', 'SBI ··8840')
  NITISH = await saveAccount(null, '  Nitish ', 'Nitish', 'working_partner', null)
  const r = await read()
  assert.deepEqual(r.accounts.map(a => [a.display_name, a.side, a.tax_role]),
    [['Jaishree', 'Nishant', 'family'], ['Namrata', 'Nishant', 'working_partner'], ['Nitish', 'Nitish', 'working_partner']])
  ok('accounts are saved trimmed and read back by side, then name')
  await expectError(() => saveAccount(null, 'Rekha', 'Nitish', 'unset', 'SBI 50100234567'), /only the last 4 digits/, 'a full account number is refused')
  await expectError(() => db.query(`insert into public.founder_payout_accounts (display_name, side, bank_label, created_by) values ('X', 'Y', '123456', $1)`, [U.owner]),
    /check constraint/, 'and the table itself refuses five digits in a row')
  await expectError(() => saveAccount(null, 'namrata', 'Nitish', 'unset', null), /already exists/, 'a second account with the same name is refused')
  await expectError(() => saveAccount(null, 'Rekha', 'Nitish', 'boss', null), /role in BOE/, 'an unknown role is refused')
  const same = await saveAccount(JAISHREE, 'Jaishree', 'Nishant', 'family', 'SBI ··8841')
  assert.equal(same, JAISHREE)
  assert.equal((await read()).accounts.find(a => a.id === JAISHREE).bank_label, 'SBI ··8841')
  ok('an account can be changed, keeping its own name')
}

// ── Payouts ──
let P1
{
  await as(U.owner)
  const KEY = '11111111-1111-1111-1111-111111111111'
  P1 = await savePayout(null, '2026-10-28', 'hdfc', [
    { account_id: NAMRATA, kind: 'partner_remuneration', amount: 75000 },
    { account_id: JAISHREE, kind: 'drawings', amount: 75000 },
  ], KEY, 'Matched Nitish')
  const again = await savePayout(null, '2026-10-28', 'hdfc', [{ account_id: NAMRATA, kind: 'partner_remuneration', amount: 1 }], KEY)
  assert.equal(again, P1)
  let r = await read()
  assert.equal(r.payouts.length, 1)
  assert.deepEqual(r.payouts[0].lines.map(l => [l.account_id, l.kind, Number(l.amount)]),
    [[NAMRATA, 'partner_remuneration', 75000], [JAISHREE, 'drawings', 75000]])
  assert.equal(r.payouts[0].note, 'Matched Nitish'); assert.equal(r.payouts[0].paid_on, '2026-10-28')
  ok('a payout is saved with its lines in order; the same idempotency key returns it instead of a second one')

  await savePayout(null, '2026-09-29', 'hdfc_sec', [
    { account_id: NAMRATA, kind: 'partner_remuneration', amount: 50000 },
    { account_id: NAMRATA, kind: 'incentive', amount: 80000.5 },
  ])
  r = await read()
  assert.equal(r.payouts.length, 2); assert.equal(r.payouts[0].id, P1)
  assert.deepEqual(r.payouts[1].lines.map(l => [l.kind, Number(l.amount)]), [['partner_remuneration', 50000], ['incentive', 80000.5]])
  ok('one account may take remuneration and incentive in the same payout; newest payout reads first')

  const before = (await read()).payouts.length
  await expectError(() => savePayout(null, '2099-01-01', 'hdfc', [{ account_id: NAMRATA, kind: 'incentive', amount: 10 }]), /today or earlier/, 'a future date is refused')
  await expectError(() => savePayout(null, today, 'sbi', [{ account_id: NAMRATA, kind: 'incentive', amount: 10 }]), /company account/, 'an unknown company account is refused')
  await expectError(() => savePayout(null, today, 'hdfc', []), /at least one account/, 'a payout with no lines is refused')
  await expectError(() => savePayout(null, today, 'hdfc', [{ account_id: NAMRATA, kind: 'incentive', amount: 0 }]), /more than zero/, 'a zero amount is refused')
  await expectError(() => savePayout(null, today, 'hdfc', [{ account_id: NAMRATA, kind: 'incentive', amount: 10.005 }]), /rupees and paise/, 'an amount with three decimals is refused')
  await expectError(() => savePayout(null, today, 'hdfc', [{ account_id: NAMRATA, kind: 'bonus', amount: 10 }]), /what kind/, 'an unknown kind is refused')
  await expectError(() => savePayout(null, today, 'hdfc', [{ account_id: '22222222-2222-2222-2222-222222222222', kind: 'incentive', amount: 10 }]), /does not exist/, 'an unknown account is refused')
  await expectError(() => savePayout(null, today, 'hdfc', [{ account_id: 'not-a-uuid', kind: 'incentive', amount: 10 }]), /not readable/, 'an unreadable line is refused')
  await expectError(() => savePayout(null, today, 'hdfc', [
    { account_id: NAMRATA, kind: 'incentive', amount: 10 }, { account_id: NAMRATA, kind: 'incentive', amount: 20 },
  ]), /appears twice/, 'the same account and kind twice is refused')
  assert.equal((await read()).payouts.length, before)
  ok('a refused payout leaves nothing behind, not even its header')
}

// ── Change and delete ──
{
  await as(U.owner)
  await savePayout(P1, '2026-10-27', 'hdfc_sec', [
    { account_id: NAMRATA, kind: 'partner_remuneration', amount: 50000 },
    { account_id: JAISHREE, kind: 'drawings', amount: 50000 },
    { account_id: NITISH, kind: 'partner_remuneration', amount: 50000 },
  ])
  let p = (await read()).payouts.find(x => x.id === P1)
  assert.equal(p.paid_on, '2026-10-27'); assert.equal(p.paid_from, 'hdfc_sec'); assert.equal(p.note, null)
  assert.equal(p.lines.length, 3)
  const n = await one(`select count(*) as n from public.founder_payout_lines where payout_id = $1`, [P1])
  assert.equal(Number(n.n), 3)
  ok('changing a payout replaces its lines (no orphan from the first version)')

  await as(U.finance)
  await expectError(() => one(`select public.founder_payout_delete($1, null)`, [P1]), /FOUNDERS_FORBIDDEN/, 'nobody else can delete it')
  await as(U.owner)
  await one(`select public.founder_payout_delete($1, 'typed twice')`, [P1])
  assert.equal((await read()).payouts.some(x => x.id === P1), false)
  const row = await one(`select deleted_at is not null as gone, delete_reason from public.founder_payouts where id = $1`, [P1])
  assert.equal(row.gone, true); assert.equal(row.delete_reason, 'typed twice')
  ok('deleting is soft: the payout leaves the read, the row keeps who, when and why')
  await expectError(() => one(`select public.founder_payout_delete($1, null)`, [P1]), /FOUNDERS_NOT_FOUND/, 'a second delete says it is gone')
  await expectError(() => savePayout(P1, today, 'hdfc', [{ account_id: NAMRATA, kind: 'incentive', amount: 10 }]), /FOUNDERS_NOT_FOUND/, 'and a deleted payout cannot be changed')
}

// ── The planner's inputs ──
{
  await as(U.owner)
  await one(`select public.founder_payout_account_year_save(2026, $1, 40000)`, [NAMRATA])
  await one(`select public.founder_payout_account_year_save(2026, $1, 45000)`, [NAMRATA])
  await one(`select public.founder_payout_firm_year_save(2026, -250000)`)
  await one(`select public.founder_payout_firm_year_save(2025, 3600000)`)
  const r = await read()
  assert.deepEqual(r.account_years.map(y => [y.tax_year, y.account_id, Number(y.other_income)]), [[2026, NAMRATA, 45000]])
  assert.deepEqual(r.firm_years.map(f => [f.tax_year, Number(f.expected_book_profit)]).sort(), [[2025, 3600000], [2026, -250000]])
  ok('other income and book profit are kept once per year (the last value wins; a loss is allowed)')
  await expectError(() => one(`select public.founder_payout_account_year_save(2026, $1, -1)`, [NAMRATA]), /zero or more/, 'negative other income is refused')
  await expectError(() => one(`select public.founder_payout_account_year_save(1999, $1, 0)`, [NAMRATA]), /financial year/, 'an impossible year is refused')
}

// ── A grant given and taken back ──
{
  await db.query(`insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by, granted_at)
                  select $1, '${FINANCE}', pa.id, true, $2, now() from public.permission_actions pa where pa.action_key = 'founder_payouts'`,
                 [U.granted, U.owner])
  await as(U.granted)
  assert.equal((await read()).accounts.length, 3)
  ok('a person granted the action in Control Center reads the book')
  await db.query(`update public.employee_permission_overrides set revoked_at = now(), revoked_by = $2 where user_id = $1`, [U.granted, U.owner])
  await expectError(() => read(), /FOUNDERS_FORBIDDEN/, 'and is refused again once it is revoked')
}

console.log(`all ${checks} checks passed`)
