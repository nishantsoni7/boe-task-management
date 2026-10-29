// Database regression suite for 20270502000000 (Orders: change an Order number).
//
// Applies the REAL migration on an in-memory Postgres (PGlite) over a small
// stand-in for what it depends on. The pieces the rename must cooperate with
// are taken VERBATIM from the migrations that define them, not retyped:
//   format_confirmed_order_number, allocate_confirmed_order_number (20260704),
//   prevent_order_display_number_change + its trigger (20260703 §8),
//   order_pi_versions_pdf_order_number + its trigger (20270201),
//   order_operational_number (20261124),
//   order_number_cycle_respects_reservations (latest: 20270116).
// Stubbed: auth.uid() (a session setting) and the tables, reduced to the
// columns these functions read. assign_order_display_number is the 20260703
// form (always the cycle's next number): reservations are retired.
//
// NOT part of npm test (PGlite is not a dependency of the app). Run it with a
// directory that has @electric-sql/pglite installed:
//   node supabase/tests/order_number_rename_pglite.mjs <dir with node_modules/@electric-sql/pglite>
// Expected last line: "all N checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node order_number_rename_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (name) => readFileSync(`${REPO}/supabase/migrations/${name}`, 'utf8').replace(/\r\n/g, '\n')
const migration = read('20270502000000_order_number_rename.sql')

/** The real `create or replace function public.<name>(` … `$$;` block from a migration. */
function fnFrom(file, name) {
  const sql = read(file)
  const start = sql.lastIndexOf(`create or replace function public.${name}(`)
  assert.ok(start >= 0, `${name} not found in ${file}`)
  const end = sql.indexOf('\n$$;', sql.indexOf('as $$', start))
  assert.ok(end > start, `${name} has no end in ${file}`)
  return sql.slice(start, end + 4)
}

const U = {
  admin:    '00000000-0000-0000-0000-0000000000a1',
  inactive: '00000000-0000-0000-0000-0000000000a2',   // an admin who has left
  member:   '00000000-0000-0000-0000-0000000000b1',
}

const db = new PGlite()
let checks = 0
const ok = (name) => { checks += 1; console.log(`  ok  ${name}`) }
const as = async (uid) => db.exec(`select set_config('test.uid', '${uid ?? ''}', false)`)
const rename = (orderId, number) =>
  db.query('select public.change_confirmed_order_number($1, $2) as r', [orderId, number]).then(r => r.rows[0].r)
async function refused(promise, marker, name) {
  await assert.rejects(promise, (e) => { assert.match(String(e.message), new RegExp(marker)); return true })
  ok(name)
}
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0]

await db.exec(`
create schema if not exists auth;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;

create table public.users (id uuid primary key, role text not null default 'member',
  is_active boolean not null default true, is_deleted boolean not null default false);
create table public.order_number_cycle (id boolean primary key default true, next_number bigint not null,
  constraint order_number_cycle_singleton check (id), constraint order_number_cycle_positive check (next_number > 0));
create table public.orders (id uuid primary key default gen_random_uuid(),
  display_number text not null unique check (display_number ~ '^[0-9]{4}$' and display_number <> '0000'),
  client_name text, updated_at timestamptz not null default now());
create table public.order_reserved_number_ledger (number text primary key check (number ~ '^[0-9]+$'), submission_id uuid);
create table public.order_submissions (id uuid primary key default gen_random_uuid(), reserved_order_number text);
create table public.order_pi_versions (id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id), version_number int not null,
  status text not null default 'approved', pdf_order_number text not null);
create table public.order_activity_log (id uuid primary key default gen_random_uuid(), order_id uuid not null,
  actor_id uuid, event_type text not null, payload jsonb, created_at timestamptz not null default now());

insert into public.users (id, role, is_active) values
  ('${U.admin}', 'admin', true), ('${U.inactive}', 'admin', false), ('${U.member}', 'member', true);
`)

await db.exec(fnFrom('20260704000000_confirmed_order_four_digit_numbers.sql', 'format_confirmed_order_number'))
await db.exec(fnFrom('20260704000000_confirmed_order_four_digit_numbers.sql', 'allocate_confirmed_order_number'))
await db.exec(fnFrom('20261124000000_order_submission_reserved_number_gate_removed_and_boe_item_codes.sql', 'order_operational_number'))
await db.exec(fnFrom('20260703000000_confirmed_order_number_cycle.sql', 'prevent_order_display_number_change'))
await db.exec(fnFrom('20270201000000_order_pi_version_pdf_order_number.sql', 'order_pi_versions_pdf_order_number'))
await db.exec(fnFrom('20270116000000_order_pi_revision_in_force_at_admin_approval.sql', 'order_number_cycle_respects_reservations'))
await db.exec(`
create function public.assign_order_display_number() returns trigger language plpgsql security definer
set search_path = public as $$ begin new.display_number := public.allocate_confirmed_order_number(); return new; end; $$;
create trigger orders_assign_display_number before insert on public.orders
  for each row execute function public.assign_order_display_number();
create trigger orders_protect_display_number before update on public.orders
  for each row execute function public.prevent_order_display_number_change();
create trigger order_pi_versions_pdf_order_number before insert or update on public.order_pi_versions
  for each row execute function public.order_pi_versions_pdf_order_number();
create trigger order_number_cycle_respects_reservations before insert or update on public.order_number_cycle
  for each row execute function public.order_number_cycle_respects_reservations();
`)

// Production's shape on 2026-10-29: Orders 0536-0541, the cycle at 542, one
// gap (0535). 0541 has one PI version that prints "541".
await db.exec(`insert into public.order_number_cycle (id, next_number) values (true, 536)`)
const ids = {}
for (const client of ['A', 'B', 'C', 'D', 'E', 'F']) {
  const r = await one(`insert into public.orders (client_name) values ($1) returning id, display_number`, [client])
  ids[r.display_number] = r.id
}
assert.deepEqual(Object.keys(ids), ['0536', '0537', '0538', '0539', '0540', '0541'])
assert.equal((await one(`select next_number from public.order_number_cycle`)).next_number, 542)
await db.query(`insert into public.order_pi_versions (order_id, version_number) values ($1, 1)`, [ids['0541']])
await db.query(`insert into public.order_pi_versions (order_id, version_number) values ($1, 1)`, [ids['0538']])
assert.equal((await one(`select pdf_order_number from public.order_pi_versions where order_id = $1`, [ids['0541']])).pdf_order_number, '541')
// A PI version stamped in the stored four-digit form (the 20270202 switch).
await db.exec(`alter table public.order_pi_versions disable trigger order_pi_versions_pdf_order_number`)
await db.query(`insert into public.order_pi_versions (order_id, version_number, status, pdf_order_number) values ($1, 2, 'pending', '0541')`, [ids['0541']])
await db.exec(`alter table public.order_pi_versions enable trigger order_pi_versions_pdf_order_number`)
ok('stand-in schema built: Orders 0536-0541, cycle at 542')

// ── The migration applies, self-assertions included ──
await db.exec(migration)
ok('migration applies and its self-assertions pass')

// ── Who ──
await as(null)
await refused(rename(ids['0541'], '508'), 'ORDER_NUMBER_CHANGE_DENIED', 'no session: refused')
await as(U.member)
await refused(rename(ids['0541'], '508'), 'ORDER_NUMBER_CHANGE_DENIED', 'a non-admin: refused')
await as(U.inactive)
await refused(rename(ids['0541'], '508'), 'ORDER_NUMBER_CHANGE_DENIED', 'an inactive admin: refused')
assert.equal((await one(`select has_function_privilege('anon', 'public.change_confirmed_order_number(uuid, text)', 'execute') as x`)).x, false)
assert.equal((await one(`select has_function_privilege('authenticated', 'public.change_confirmed_order_number(uuid, text)', 'execute') as x`)).x, true)
ok('anon cannot execute it; authenticated can')

// ── What ──
await as(U.admin)
for (const bad of ['', 'abc', '0', '0000', '12345', '50 8', '-5', '5.0']) {
  await refused(rename(ids['0541'], bad), 'ORDER_NUMBER_CHANGE_INVALID', `"${bad}" is not an Order number`)
}
await refused(rename(ids['0541'], '541'), 'ORDER_NUMBER_CHANGE_SAME', 'its own number: refused')
await refused(rename(ids['0541'], '0539'), 'ORDER_NUMBER_CHANGE_IN_USE', 'another Order\'s number: refused')
await refused(rename(ids['0541'], '542'), 'ORDER_NUMBER_CHANGE_TOO_HIGH', 'the next number: refused')
await refused(rename(ids['0541'], '9000'), 'ORDER_NUMBER_CHANGE_TOO_HIGH', 'above the next number: refused')
await db.exec(`insert into public.order_reserved_number_ledger (number) values ('0456')`)
await refused(rename(ids['0541'], '456'), 'ORDER_NUMBER_CHANGE_RESERVED', 'a number in the reservation ledger: refused')
await db.exec(`insert into public.order_submissions (reserved_order_number) values ('0457')`)
await refused(rename(ids['0541'], '457'), 'ORDER_NUMBER_CHANGE_RESERVED', 'a number still reserved on a draft: refused')
await refused(rename('00000000-0000-0000-0000-00000000dead', '508'), 'ORDER_NUMBER_CHANGE_MISSING', 'an Order that does not exist: refused')
assert.equal((await one(`select display_number from public.orders where id = $1`, [ids['0541']])).display_number, '0541')
assert.equal((await one(`select next_number from public.order_number_cycle`)).next_number, 542)
assert.equal((await one(`select count(*)::int as n from public.order_activity_log`)).n, 0)
ok('every refusal left the Order, the cycle and the Activity trail untouched')

// ── The newest Order takes an older number; its number goes to the next Order ──
const r1 = await rename(ids['0541'], ' 508 ')
assert.deepEqual(
  { prev: r1.previous_number, now: r1.display_number, next: r1.next_number, freed: r1.old_number_is_next, v: r1.pi_versions },
  { prev: '0541', now: '0508', next: '0541', freed: true, v: 2 })
ok('0541 → 0508: the result says 541 is the next number')
assert.equal((await one(`select display_number from public.orders where id = $1`, [ids['0541']])).display_number, '0508')
assert.equal((await one(`select next_number from public.order_number_cycle`)).next_number, 541)
ok('the Order is 0508 and the cycle stepped back to 541')
const pdf = (await db.query(`select version_number, pdf_order_number from public.order_pi_versions where order_id = $1 order by 1`, [ids['0541']])).rows
assert.deepEqual(pdf.map(v => v.pdf_order_number), ['508', '0508'])
ok('its PI versions print the new number, each in the form it printed before')
assert.equal((await one(`select pdf_order_number from public.order_pi_versions where order_id = $1`, [ids['0538']])).pdf_order_number, '538')
ok('another Order\'s PI version is untouched')
const act = await one(`select actor_id, event_type, payload from public.order_activity_log where order_id = $1`, [ids['0541']])
assert.equal(act.actor_id, U.admin)
assert.equal(act.event_type, 'order_number_changed')
assert.deepEqual(act.payload, { from: '0541', to: '0508', old_number_is_next: true, next_number: '0541' })
ok('the Activity trail records who changed it, from and to')
assert.equal((await one(`select coalesce(current_setting('boe.order_number_rename', true), '') as s`)).s, '')
ok('the rename context is cleared when the call returns')

const next = await one(`insert into public.orders (client_name) values ('G') returning display_number`)
assert.equal(next.display_number, '0541')
assert.equal((await one(`select next_number from public.order_number_cycle`)).next_number, 542)
ok('the next approved Order is given 0541')

// ── An Order that is not the newest: its old number is left unused ──
const r2 = await rename(ids['0538'], '535')
assert.equal(r2.display_number, '0535')
assert.equal(r2.old_number_is_next, false)
assert.equal(r2.next_number, '0542')
assert.equal((await one(`select next_number from public.order_number_cycle`)).next_number, 542)
ok('0538 → 0535: the cycle stays at 542 and 538 is left unused')
await refused(rename(ids['0537'], '508'), 'ORDER_NUMBER_CHANGE_IN_USE', 'the number just taken is now unique to its Order')

// ── A reserved number at or above the old one is never handed out again ──
await db.exec(`insert into public.order_reserved_number_ledger (number) values ('0542')`)
const r3 = await one(`insert into public.orders (client_name) values ('H') returning id, display_number`)
assert.equal(r3.display_number, '0542')
const r4 = await rename(r3.id, '509')
assert.equal(r4.old_number_is_next, false)
assert.equal((await one(`select next_number from public.order_number_cycle`)).next_number, 543)
ok('a newest number that a PI Draft once reserved is not given back')

// ── The lock still holds everywhere else ──
await refused(db.query(`update public.orders set display_number = '0600' where id = $1`, [ids['0536']]),
  'ORDER_NUMBER_IMMUTABLE', 'a direct update of an Order number is still refused')
await db.query(`select set_config('boe.order_number_rename', $1, false)`, [ids['0537']])
await refused(db.query(`update public.orders set display_number = '0600' where id = $1`, [ids['0536']]),
  'ORDER_NUMBER_IMMUTABLE', 'the rename context for ONE Order does not open another')
await refused(db.query(`update public.order_pi_versions set pdf_order_number = '999' where order_id = $1`, [ids['0541']]),
  'PI_PDF_ORDER_NUMBER_IMMUTABLE', 'the rename context for one Order does not open another Order\'s PI PDF')
await db.query(`select set_config('boe.order_number_rename', '', false)`)
await refused(db.query(`update public.order_pi_versions set pdf_order_number = '999' where order_id = $1`, [ids['0541']]),
  'PI_PDF_ORDER_NUMBER_IMMUTABLE', 'a direct update of the number a PI PDF prints is still refused')
await db.exec('begin')
await rename(ids['0536'], '510')
await refused(db.query(`update public.orders set display_number = '0601' where id = $1`, [ids['0536']]),
  'ORDER_NUMBER_IMMUTABLE', 'later in the same transaction the renamed Order is locked again')
await db.exec('rollback')
assert.equal((await one(`select display_number from public.orders where id = $1`, [ids['0536']])).display_number, '0536')
ok('a rolled-back rename leaves the Order as it was')

console.log(`all ${checks} checks passed`)
