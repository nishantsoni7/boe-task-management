// Database regression suite for 20270701000000 (Confirmed Payments: search by any order
// number, the confirmed total of an order, and correcting an old order's client).
//
// Applies the REAL migration on an in-memory Postgres (PGlite), together with the REAL
// functions it relies on, extracted from their latest migrations and never retyped:
// finance_payment_status_is_verified + the reversal deriver (20260918000000),
// received_payment_visible_to_actor (20261216000000), normalize_legacy_order_no and the
// allocation transition guard as it stood before this migration (20270407000000).
// Stubbed, and said so: auth.uid(), users, permissions (a grants table), module_entry_open,
// can_read_payment_as_participant (a participants table), in_pi_submission_approval, the
// tables (only the columns these functions read), and finance_received_payments (a plain
// view over the payments, where the real one is security_invoker).
//
// NOT part of npm test (PGlite is not an app dependency). Run:
//   node supabase/tests/confirmed_payments_order_search_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all N checks passed". MUTATE=<name> breaks the migration on purpose
// (see MUTATIONS) and the run must then FAIL.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node confirmed_payments_order_search_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const mig = f => readFileSync(`${REPO}/supabase/migrations/${f}`, 'utf8')
const MIGRATION = '20270701000000_finance_confirmed_payments_order_search.sql'

function extract(text, fnName) {
  const lines = text.replace(/\r/g, '').split('\n')
  const head = l => { const s = l.toLowerCase(); return s.startsWith(`create or replace function public.${fnName.toLowerCase()}(`) || s.startsWith(`create function public.${fnName.toLowerCase()}(`) }
  const start = lines.findIndex(head)
  if (start < 0) throw new Error('cannot extract ' + fnName)
  const out = []
  let tag = null
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    out.push(line)
    if (!tag) {
      const m = /(\$[a-z_]*\$)/i.exec(line)
      if (m) { tag = m[1]; if (line.slice(m.index + tag.length).includes(tag) && /;\s*$/.test(line)) break }
      continue
    }
    if (line.includes(tag) && /;\s*$/.test(line)) break
  }
  return out.join('\n')
}

// Deliberate breaks of the migration text: each must make this suite fail.
const MUTATIONS = {
  no_manage_check: s => s.replace("actor_has_module_permission('finance', 'manage')", "actor_has_module_permission('finance', 'view')"),
  no_marker_needed: s => s.replace('(new.legacy_client_name is distinct from old.legacy_client_name and not v_client_marker)', 'false'),
  marker_any_row: s => s.replace("coalesce(current_setting('boe.legacy_client_correction', true), '') = old.id::text", "coalesce(current_setting('boe.legacy_client_correction', true), '') <> ''"),
  amount_unfrozen: s => s.replace('       or new.allocated_amount    is distinct from old.allocated_amount\n', ''),
  totals_sum_payment_amounts: s => s.replace('sum(h.amount)', 'sum(f.amount)'),
  totals_not_verified_only: s => s.replace('where public.finance_payment_status_is_verified(f.status)\n    and public.received_payment_visible_to_actor(f.id)', 'where public.received_payment_visible_to_actor(f.id)'),
  totals_ignore_visibility: s => s.replace('where public.finance_payment_status_is_verified(f.status)\n    and public.received_payment_visible_to_actor(f.id)', 'where public.finance_payment_status_is_verified(f.status)'),
  totals_count_reversed: s => s.replace("    where a.status = 'active'\n  ),\n  hits as (", '  ),\n  hits as ('),
  term_is_a_pattern: s => s.replace("v_like := '%' || replace(replace(replace(v_term, E'\\\\', E'\\\\\\\\'), '%', E'\\\\%'), '_', E'\\\\_') || '%';", "v_like := '%' || v_term || '%';"),
  short_term_answers: s => s.replace('if length(v_term) < 3 or length(v_term) > 60 then', 'if length(v_term) > 60 then'),
  search_text_ignores_visibility: s => s.replace('     or not public.received_payment_visible_to_actor(p_row.id) then\n    return null;', '     or false then\n    return null;'),
  search_text_reads_reversed: s => s.replace("    where a.payment_request_id = p_row.id\n      and a.status = 'active'", '    where a.payment_request_id = p_row.id'),
  wrong_history_event: s => s.replace("v_alloc.payment_request_id, v_actor, 'allocation_legacy_client_corrected',", "v_alloc.payment_request_id, v_actor, 'allocation_created',"),
  anon_may_correct: s => s.replace('revoke all on function public.correct_legacy_order_client(uuid, text) from anon;', 'grant execute on function public.correct_legacy_order_client(uuid, text) to anon;'),
}

const U = {
  owner:    '00000000-0000-0000-0000-0000000000a1', // finance.view + view_all
  manager:  '00000000-0000-0000-0000-0000000000a2', // finance.view + manage
  viewer:   '00000000-0000-0000-0000-0000000000a3', // finance.view only
  sales:    '00000000-0000-0000-0000-0000000000b2', // finance.view; a participant of one payment only
  admin:    '00000000-0000-0000-0000-0000000000d4', // role admin
  outsider: '00000000-0000-0000-0000-0000000000e5', // nothing
}

const db = new PGlite()
await db.exec(`
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create table users (id uuid primary key, role text not null default 'member', full_name text, is_active boolean not null default true);
create table grants (user_id uuid, module text, action text);
create function module_entry_open(text) returns boolean language sql as $$ select true $$;
create function actor_has_module_permission(p_module text, p_action text) returns boolean language sql stable as $$
  select exists (select 1 from users u where u.id = auth.uid() and u.role = 'admin')
      or exists (select 1 from grants g where g.user_id = auth.uid() and g.module = p_module and g.action = p_action) $$;
create function resolve_permission(p_user uuid, p_module text, p_action text) returns boolean language sql stable as $$
  select exists (select 1 from users u where u.id = p_user and u.role = 'admin')
      or exists (select 1 from grants g where g.user_id = p_user and g.module = p_module and g.action = p_action) $$;
create table participants (user_id uuid, payment_id uuid);
create function can_read_payment_as_participant(p uuid) returns boolean language sql stable as $$
  select exists (select 1 from participants x where x.payment_id = p and x.user_id = auth.uid()) $$;
create function in_pi_submission_approval(p uuid) returns boolean language sql stable as $$ select false $$;

create table order_requests (id uuid primary key default gen_random_uuid(), created_by uuid, requested_by uuid, assigned_to uuid, converted_order_id uuid);
create table order_submissions (
  id uuid primary key default gen_random_uuid(),
  draft_reference text, reserved_order_number text, source_workbook_name text, client_name text);
create table orders (id uuid primary key default gen_random_uuid(), client_name text, display_number text,
  source_order_submission_id uuid references order_submissions(id));
create table finance_payment_requests (
  id uuid primary key default gen_random_uuid(), request_number text, human_payment_id text,
  amount numeric not null, client_name text, status text not null, payment_date date not null default '2026-11-05',
  submitted_by uuid, order_request_id uuid, order_id uuid, updated_at timestamptz);
create view finance_received_payments as
  select id, request_number, human_payment_id, client_name, amount, status, payment_date, submitted_by from finance_payment_requests;
create table finance_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  payment_request_id uuid not null references finance_payment_requests(id),
  order_submission_id uuid references order_submissions(id), order_id uuid references orders(id),
  legacy_order_no text, legacy_client_name text,
  allocated_amount numeric not null, status text not null default 'active', origin_target_type text,
  created_by uuid, created_at timestamptz not null default clock_timestamp(),
  reversed_by uuid, reversed_at timestamptz, reversal_reason text);
create table finance_payment_request_activity_log (
  id uuid primary key default gen_random_uuid(),
  payment_request_id uuid not null references finance_payment_requests(id) on delete cascade,
  actor_id uuid, event_type text not null, payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint finance_payment_request_activity_log_event_type_check check (event_type in (
    'request_submitted','order_linked','order_unlinked','order_link_changed','order_request_linked',
    'order_request_unlinked','target_changed','status_changed','collection_details_updated',
    'cash_handover_recorded','allocation_created','allocation_reversed','allocation_moved','request_deleted',
    'request_merged','request_merged_in')));
`)

const A = mig('20260918000000_finance_payment_allocations.sql')
await db.exec(extract(A, 'finance_payment_status_is_verified'))
await db.exec(extract(A, 'finance_payment_allocations_derive_reversal'))
await db.exec(`create trigger derive_reversal before update on finance_payment_allocations
  for each row execute function finance_payment_allocations_derive_reversal();`)
await db.exec(extract(mig('20261216000000_received_payment_allocation_targets.sql'), 'received_payment_visible_to_actor'))
const OLD = mig('20270407000000_finance_allocate_to_old_order.sql')
await db.exec(extract(OLD, 'normalize_legacy_order_no'))
// The guard as it stood BEFORE this migration; the migration must replace it.
await db.exec(extract(OLD, 'finance_payment_allocations_guard_transition'))
await db.exec(`create trigger guard_transition before update on finance_payment_allocations
  for each row execute function finance_payment_allocations_guard_transition();`)

// A stand-in for the cash-handover lock (20270415000000): a payment in a handover refuses ANY update.
const LOCKED_PAYMENT_NOTE = 'PAYMENT_LOCKED_BY_CASH_HANDOVER'

// THE MIGRATION UNDER TEST, whole, including its own assertions (optionally broken on purpose).
let text = mig(MIGRATION).replace(/\r/g, '')
const MUTATE = process.env.MUTATE
if (MUTATE) {
  if (!MUTATIONS[MUTATE]) throw new Error('unknown mutation ' + MUTATE)
  const broken = MUTATIONS[MUTATE](text)
  if (broken === text) throw new Error('mutation ' + MUTATE + ' changed nothing')
  text = broken
}
await db.exec(text)

let checks = 0
const pass = name => { checks++; console.log('ok', checks, name) }
const as = async (user, sql, params = []) => {
  await db.exec(`select set_config('request.jwt.claim.sub', '${user ?? ''}', false)`)
  return (await db.query(sql, params)).rows
}
const refuses = async (user, sql, params, code) => {
  try { await as(user, sql, params) } catch (e) {
    assert.ok(String(e.message).includes(code), `expected ${code}, got: ${e.message}`)
    return
  }
  assert.fail(`expected ${code}, but it succeeded`)
}
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0]
const totals = (user, term) => as(user, `select * from finance_order_confirmed_totals($1) order by target_type, target_reference`, [term])
const textOf = async (user, id) => (await as(user, `select f.order_search_text as t from finance_received_payments f where f.id = $1`, [id]))[0]?.t ?? null
// A transaction that is always rolled back unless it succeeds: returns the error message or null.
const tx = async sql => {
  await db.exec('begin')
  try { await db.exec(sql); await db.exec('rollback'); return null } catch (e) { await db.exec('rollback'); return String(e.message) }
}

await db.exec(`
insert into users (id, role, full_name) values ('${U.owner}', 'member', 'Owner'), ('${U.manager}', 'member', 'Manager'),
  ('${U.viewer}', 'member', 'Viewer'), ('${U.sales}', 'member', 'Sales'), ('${U.admin}', 'admin', 'Admin'), ('${U.outsider}', 'member', 'Outsider');
insert into grants values ('${U.owner}', 'finance', 'view'), ('${U.owner}', 'finance', 'view_all'),
  ('${U.manager}', 'finance', 'view'), ('${U.manager}', 'finance', 'manage'),
  ('${U.manager}', 'finance', 'view_all'),
  ('${U.viewer}', 'finance', 'view'), ('${U.sales}', 'finance', 'view');
`)

let seq = 0
const pay = async (o) => (await one(
  `insert into finance_payment_requests (amount, status, submitted_by, request_number, human_payment_id)
   values ($1, $2, $3, $4, $4) returning id`,
  [o.amount, o.status ?? 'approved_unlinked', o.by ?? U.owner, `P-AA-${String(100 + ++seq).padStart(4, '0')}`])).id
const alloc = async (payment, o) => (await one(
  `insert into finance_payment_allocations (payment_request_id, order_id, order_submission_id, legacy_order_no, legacy_client_name,
     allocated_amount, status, origin_target_type, created_by)
   values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
  [payment, o.order ?? null, o.sub ?? null, o.legacy ?? null, o.client ?? null, o.amount, o.status ?? 'active',
    o.legacy ? 'legacy_order' : o.order ? 'confirmed_order' : 'order_submission', U.owner])).id

// ── The data: an Order that came from a PI, a second Order, PI Drafts, an old order ──
const S1 = (await one(`insert into order_submissions (draft_reference) values ('PID-00012') returning id`)).id
const O425 = (await one(`insert into orders (display_number, client_name, source_order_submission_id) values ('0425', 'Northbliss', $1) returning id`, [S1])).id
const O431 = (await one(`insert into orders (display_number, client_name) values ('0431', 'Yuva') returning id`)).id
const S2 = (await one(`insert into order_submissions (draft_reference, reserved_order_number) values ('PID-00020', '0440') returning id`)).id
const S3 = (await one(`insert into order_submissions (source_workbook_name) values ('C:\\files\\Hotel ABC.xlsx') returning id`)).id

const P1 = await pay({ amount: 500000 })                       // split across two Orders
const a1o425 = await alloc(P1, { order: O425, amount: 400000 })
await alloc(P1, { order: O431, amount: 100000 })
const P2 = await pay({ amount: 300000, by: U.sales })          // one Order; Sales is its participant
await alloc(P2, { order: O425, amount: 300000 })
await db.query(`insert into participants values ($1, $2)`, [U.sales, P2])
const P3 = await pay({ amount: 200000 })                       // an old order
const a3 = await alloc(P3, { legacy: 'AB-12', client: 'Hotel Sunrise', amount: 200000 })
const P4 = await pay({ amount: 50000, status: 'pending_approval' })   // NOT confirmed
await alloc(P4, { order: O425, amount: 50000 })
const P5 = await pay({ amount: 1000000 })                      // a PI Draft with a reserved number
await alloc(P5, { sub: S2, amount: 1000000 })
const P6 = await pay({ amount: 70000 })                        // an allocation that was reversed
await alloc(P6, { order: O431, amount: 70000, status: 'reversed' })
const P7 = await pay({ amount: 60000 })                        // a PI Draft named by its workbook file
await alloc(P7, { sub: S3, amount: 60000 })

// ═══ §2 The totals ═══
{
  const r = await totals(U.owner, '0425')
  assert.equal(r.length, 1)
  assert.equal(r[0].target_type, 'order'); assert.equal(r[0].target_reference, '0425')
  assert.equal(Number(r[0].confirmed_total), 700000)
  assert.equal(r[0].payments_count, 2)
  pass('Order 0425: 2 confirmed payments, 7,00,000 allocated (pending money and the payments\' other halves are not in it)')
}
{
  const r = await totals(U.owner, '0431')
  assert.equal(r.length, 1)
  assert.equal(Number(r[0].confirmed_total), 100000)
  assert.equal(r[0].payments_count, 1)
  pass('Order 0431: only the ACTIVE 1,00,000 of the split payment; the reversed allocation is not counted')
}
{
  const r = await totals(U.owner, 'PID-00012')
  assert.equal(r.length, 1)
  assert.equal(r[0].target_reference, '0425'); assert.equal(Number(r[0].confirmed_total), 700000)
  pass('the PI an Order came from finds that Order')
}
{
  const r = await totals(U.owner, '044')
  assert.equal(r.length, 1)
  assert.equal(r[0].target_type, 'pi_draft'); assert.equal(r[0].target_reference, 'PID-00020'); assert.equal(r[0].reserved_order_number, '0440')
  assert.equal(Number(r[0].confirmed_total), 1000000)
  pass('a PI Draft is found by its reserved Order number and named by its reference')
}
{
  const r = await totals(U.owner, 'hotel abc')
  assert.equal(r.length, 1); assert.equal(r[0].target_type, 'pi_draft'); assert.equal(r[0].target_reference, 'Hotel ABC.xlsx')
  assert.equal(Number(r[0].confirmed_total), 60000)
  pass('a PI Draft with no reference is found by its workbook file name, as the list names it')
}
{
  const r = await totals(U.owner, 'ab-12')
  assert.equal(r.length, 1); assert.equal(r[0].target_type, 'legacy_order'); assert.equal(r[0].target_reference, 'AB-12')
  assert.equal(r[0].target_client_name, 'Hotel Sunrise'); assert.equal(Number(r[0].confirmed_total), 200000)
  pass('an old order is found ignoring case, with its client')
}
assert.equal((await totals(U.owner, '04')).length, 0)
assert.equal((await totals(U.owner, '  ')).length, 0)
assert.equal((await totals(U.owner, null)).length, 0)
assert.equal((await totals(U.owner, '0'.repeat(61))).length, 0)
pass('a term under 3 characters, blank, null or over 60 answers nothing')
assert.equal((await totals(U.owner, '_25')).length, 0)
assert.equal((await totals(U.owner, '%%%')).length, 0)
assert.equal((await totals(U.owner, '\\')).length, 0)
pass('a % _ or \\ in the term is text to find, never a pattern')
assert.equal((await totals(U.owner, 'Northbliss')).length, 0)
pass('a client name is not an order number: it shows no total')
{
  const r = await totals(U.sales, '0425')
  assert.equal(r.length, 1); assert.equal(r[0].payments_count, 1); assert.equal(Number(r[0].confirmed_total), 300000)
  pass('a participant is told only the money of the payments they may read')
}
await refuses(U.outsider, `select * from finance_order_confirmed_totals($1)`, ['0425'], 'ORDER_TOTALS_NOT_PERMITTED')
await refuses(null, `select * from finance_order_confirmed_totals($1)`, ['0425'], 'ORDER_TOTALS_AUTH_REQUIRED')
pass('no Finance view permission, or no sign-in, is refused')
assert.equal((await totals(U.admin, '0425'))[0].payments_count, 2)
pass('an admin reads the totals through the admin branch')

// ═══ §1 The search text ═══
{
  const t1 = await textOf(U.owner, P1)
  for (const w of ['0425', '0431', 'PID-00012']) assert.ok(t1.split(' ').includes(w), `P1 text has ${w}: ${t1}`)
  pass('a split payment is found by BOTH its Orders and by the PI the first came from')
  const t3 = await textOf(U.owner, P3)
  assert.ok(t3.includes('AB-12') && t3.includes('Hotel') && t3.includes('Sunrise'))
  pass('an old-order payment is found by its old order number and client')
  const t5 = await textOf(U.owner, P5)
  assert.ok(t5.includes('PID-00020') && t5.includes('0440'))
  pass('a PI Draft payment is found by its reference and its reserved Order number')
  assert.ok((await textOf(U.owner, P7)).includes('Hotel ABC.xlsx'))
  pass('a draft with no reference is found by its file name')
}
assert.equal(await textOf(U.owner, P4), null)
pass('a payment nobody has confirmed has no search text')
assert.equal(await textOf(U.owner, P6), null)
pass('a reversed allocation is not searchable')
assert.equal(await textOf(U.outsider, P1), null)
pass('someone without Finance view gets no search text at all')
assert.equal(await textOf(U.sales, P1), null)
assert.ok((await textOf(U.sales, P2)).includes('0425'))
pass('a participant gets the text of the payments they may read, and nothing for the others')
{
  const rows = await as(U.owner, `select f.id from finance_received_payments f where f.order_search_text ilike '%0431%' order by f.id`)
  assert.deepEqual(rows.map(r => r.id).sort(), [P1].sort())
  pass('filtering the projection by the field finds exactly the payment on that Order')
}

// ═══ §3 §4 §5 Correcting an old order's client ═══
const paymentFingerprint = id => one(`select md5(f::text) as h from finance_payment_requests f where f.id = $1`, [id]).then(r => r.h)
const correct = (user, id, name) => as(user, `select correct_legacy_order_client($1, $2) as r`, [id, name]).then(r => r[0].r)

await refuses(U.viewer, `select correct_legacy_order_client($1, $2)`, [a3, 'X'], 'LEGACY_CLIENT_NOT_PERMITTED')
await refuses(U.outsider, `select correct_legacy_order_client($1, $2)`, [a3, 'X'], 'LEGACY_CLIENT_NOT_PERMITTED')
await refuses(null, `select correct_legacy_order_client($1, $2)`, [a3, 'X'], 'Authentication required')
pass('only finance.manage (or an admin) may correct a client; a viewer, an outsider and a signed-out caller may not')
await refuses(U.manager, `select correct_legacy_order_client($1, $2)`, [a3, '   '], 'ALLOCATION_LEGACY_CLIENT_REQUIRED')
await refuses(U.manager, `select correct_legacy_order_client($1, $2)`, [a3, 'x'.repeat(121)], 'ALLOCATION_LEGACY_CLIENT_TOO_LONG')
pass('a blank or over-long client is refused')
await refuses(U.manager, `select correct_legacy_order_client($1, $2)`, [a1o425, 'X'], 'LEGACY_ALLOCATION_NOT_FOUND')
await refuses(U.manager, `select correct_legacy_order_client(gen_random_uuid(), $1)`, ['X'], 'LEGACY_ALLOCATION_NOT_FOUND')
pass('an Order allocation or an unknown id is not an old-order allocation')
const a8 = await alloc(await pay({ amount: 5000 }), { legacy: 'OLD-REV', client: 'Gone Client', amount: 5000, status: 'reversed' })
await refuses(U.manager, `select correct_legacy_order_client($1, $2)`, [a8, 'X'], 'LEGACY_ALLOCATION_REVERSED')
pass('a reversed allocation is history and is not changed')

// A payment in a cash handover refuses any update of its own row.
await db.exec(`
create function lock_test() returns trigger language plpgsql as $f$
begin
  if old.id = '${P3}' then raise exception '${LOCKED_PAYMENT_NOTE}' using errcode = '42501'; end if;
  return new;
end $f$;
create trigger lock_test before update on finance_payment_requests for each row execute function lock_test();`)
assert.ok((await tx(`update finance_payment_requests set client_name = 'x' where id = '${P3}'`))?.includes(LOCKED_PAYMENT_NOTE))

const before = await paymentFingerprint(P3)
const done = await correct(U.manager, a3, '  Hotel   Sunrise Pvt   Ltd ')
assert.equal(done.changed, true); assert.equal(done.legacy_client_name, 'Hotel Sunrise Pvt Ltd')
assert.equal((await one(`select legacy_client_name as c from finance_payment_allocations where id = $1`, [a3])).c, 'Hotel Sunrise Pvt Ltd')
pass('the client is corrected (spaces tidied) on the old-order allocation')
assert.equal(await paymentFingerprint(P3), before)
pass('the PAYMENT row is untouched, so a payment locked by a cash handover can still be corrected')
{
  const log = await db.query(`select actor_id, event_type, payload from finance_payment_request_activity_log where payment_request_id = $1`, [P3])
  assert.equal(log.rows.length, 1)
  assert.equal(log.rows[0].event_type, 'allocation_legacy_client_corrected'); assert.equal(log.rows[0].actor_id, U.manager)
  assert.equal(log.rows[0].payload.previous_client_name, 'Hotel Sunrise'); assert.equal(log.rows[0].payload.legacy_client_name, 'Hotel Sunrise Pvt Ltd')
  assert.equal(log.rows[0].payload.legacy_order_no, 'AB-12')
  pass('the payment\'s history says who changed which old order\'s client, from what, to what')
}
{
  const again = await correct(U.manager, a3, 'hotel sunrise pvt ltd')
  assert.equal(again.changed, true) // a different spelling is a change
  const same = await correct(U.manager, a3, 'hotel sunrise pvt ltd')
  assert.equal(same.changed, false)
  assert.equal((await db.query(`select 1 from finance_payment_request_activity_log where payment_request_id = $1`, [P3])).rows.length, 2)
  pass('saving the same name again changes nothing and writes no history')
}
assert.ok((await textOf(U.owner, P3)).includes('pvt'))
assert.equal((await totals(U.owner, 'ab-12'))[0].target_client_name, 'hotel sunrise pvt ltd')
pass('search and totals follow the corrected client')
assert.equal((await correct(U.admin, a3, 'Admin Fixed')).changed, true)
pass('an admin may correct too')

// The guard: the marker is the only way, and only for the client name of that allocation.
assert.ok((await tx(`update finance_payment_allocations set legacy_client_name = 'Direct' where id = '${a3}'`))?.includes('ALLOCATION_IMMUTABLE'))
pass('a direct update of the client, without the marker, is still refused')
assert.ok((await tx(`select set_config('boe.legacy_client_correction', '${a3}', true);
  update finance_payment_allocations set legacy_client_name = 'Y', allocated_amount = 1 where id = '${a3}'`))?.includes('ALLOCATION_IMMUTABLE'))
assert.ok((await tx(`select set_config('boe.legacy_client_correction', '${a3}', true);
  update finance_payment_allocations set legacy_order_no = 'ZZ-1' where id = '${a3}'`))?.includes('ALLOCATION_IMMUTABLE'))
assert.ok((await tx(`select set_config('boe.legacy_client_correction', '${a3}', true);
  update finance_payment_allocations set payment_request_id = '${P1}' where id = '${a3}'`))?.includes('ALLOCATION_IMMUTABLE'))
pass('even with the marker, the amount, the order number and the payment stay frozen')
const a9 = await alloc(await pay({ amount: 9000 }), { legacy: 'OLD-9', client: 'Nine', amount: 9000 })
assert.ok((await tx(`select set_config('boe.legacy_client_correction', '${a9}', true);
  update finance_payment_allocations set legacy_client_name = 'Other' where id = '${a3}'`))?.includes('ALLOCATION_IMMUTABLE'))
pass('the marker names ONE allocation: it does not open another')
assert.equal(await tx(`select set_config('boe.legacy_client_correction', '${a9}', true);
  update finance_payment_allocations set legacy_client_name = 'Nine Co' where id = '${a9}'`), null)
pass('with the marker for that allocation, the client name alone may change')
assert.equal((await one(`select legacy_client_name as c from finance_payment_allocations where id = $1`, [a9])).c, 'Nine')
pass('(and that rehearsal was rolled back)')

// An earlier event is still allowed, and the check is not widened to anything.
await db.query(`insert into finance_payment_request_activity_log (payment_request_id, event_type) values ($1, 'request_merged_in')`, [P1])
await db.query(`insert into finance_payment_request_activity_log (payment_request_id, event_type) values ($1, 'allocation_created')`, [P1])
assert.ok((await tx(`insert into finance_payment_request_activity_log (payment_request_id, event_type) values ('${P1}', 'made_up_event')`))?.includes('event_type_check'))
pass('the history still accepts every earlier event and still refuses an unknown one')

// ── Not callable by anon ──
for (const fn of ['public.order_search_text(public.finance_received_payments)', 'public.finance_order_confirmed_totals(text)', 'public.correct_legacy_order_client(uuid, text)']) {
  assert.equal((await one(`select has_function_privilege('anon', '${fn}', 'execute') as ok`)).ok, false, fn)
  assert.equal((await one(`select has_function_privilege('service_role', '${fn}', 'execute') as ok`)).ok, false, fn)
  assert.equal((await one(`select has_function_privilege('authenticated', '${fn}', 'execute') as ok`)).ok, true, fn)
}
pass('only signed-in users may call the three functions; anon and service_role may not')

console.log(`all ${checks} checks passed`)
