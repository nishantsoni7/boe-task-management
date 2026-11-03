// Database regression suite for 20270528000000 (dispatch drives the Order's status).
//
// Applies the REAL Payment plan, Dispatch records and status roll-up migrations
// on an in-memory Postgres (PGlite) over a small stand-in for what they depend
// on. Stubbed: auth.uid() (a session setting), actor_has_module_permission,
// module_entry_open, can_view_order_unscoped / can_view_order_as_actor (a table
// of who may open which Order), assert_order_amender, in_order_cancellation,
// storage.objects, and a placeholder orders_enforce_status_transition that the
// real migration replaces (20260819000000 created the trigger in production).
//
// NOT part of npm test (PGlite is not a dependency of the app). Run it with a
// directory that has @electric-sql/pglite installed:
//   node supabase/tests/order_dispatch_status_pglite.mjs <dir with node_modules/@electric-sql/pglite>
// Expected last line: "all N checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node order_dispatch_status_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const migrations = [
  '20270428000000_order_payment_plan.sql',
  '20270430000000_order_payment_plan_account_cash.sql',
  '20270503000000_order_payment_plan_bdpi.sql',
  '20270504000000_order_payment_plan_line_costs.sql',
  '20270520000000_order_dispatch_records.sql',
  '20270528000000_order_dispatch_status_rollup.sql',
].map(name => readFileSync(`${REPO}/supabase/migrations/${name}`, 'utf8'))

const U = {
  admin: '00000000-0000-0000-0000-0000000000a1',
  sales: '00000000-0000-0000-0000-0000000000b1', // holds record_dispatch, opens every test Order
  ops:   '00000000-0000-0000-0000-0000000000b2', // operations team
  plain: '00000000-0000-0000-0000-0000000000b3', // an ordinary employee, no record_dispatch
  other: '00000000-0000-0000-0000-0000000000b4', // holds record_dispatch, opens NOTHING
}
const O = (n) => `00000000-0000-0000-0000-0000000000f${n}`
const P = (n) => `00000000-0000-0000-0000-0000000000e${n}`
const k = (n) => `20000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`
const ORDERS = { RUN: O(1), READY: O(2), HOLD: O(3), REV: O(4), HAND: O(5), CAN: O(6), PLAN: O(7), EMPTY: O(8), GONE: O(9) }

const db = new PGlite()
let checks = 0
const ok = (name) => { checks += 1; console.log(`  ok  ${name}`) }

await db.exec(`
create schema if not exists auth;
create schema if not exists storage;
create role anon nologin;
create role authenticated nologin;
grant usage on schema public, auth, storage to anon, authenticated;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;

create table public.users (id uuid primary key, role text not null default 'employee', team text, full_name text, is_active boolean not null default true, is_deleted boolean not null default false);
create table public.permission_modules (id uuid primary key default gen_random_uuid(), module_key text unique not null);
create table public.permission_actions (id uuid primary key default gen_random_uuid(), action_key text unique not null, display_name text, is_system boolean not null default false);
create table public.module_permission_actions (module_id uuid references public.permission_modules(id), action_id uuid references public.permission_actions(id), default_allowed boolean not null default false, unique (module_id, action_id));
insert into public.permission_modules (module_key) values ('orders');

create table public.order_submissions (
  id uuid primary key, client_name text, gross_product_amount numeric, discount_amount numeric, subtotal_after_discount numeric,
  fabric_cost numeric, packing_cost numeric, transportation_amount numeric, transportation_text text,
  total_before_gst numeric, gst_amount numeric, grand_total numeric, billing_percentage numeric);
create table public.orders (id uuid primary key, display_number text, status text not null default 'running', source_order_submission_id uuid references public.order_submissions(id), total_value numeric);
create table public.order_submission_items (id uuid primary key default gen_random_uuid(), submission_id uuid references public.order_submissions(id), item_sequence text, product_name text, quantity numeric, cost_per_piece numeric, total_amount numeric, sort_order int, dimensions text, material text);
create table public.order_submission_fabric_finish_lines (submission_id uuid, item_sequence text,
  sheet_fabric_metres_per_piece numeric, sheet_fabric_price_per_metre numeric, sheet_packing_cost_per_piece numeric, sheet_packing_type text,
  sheet_finish jsonb not null default '[]'::jsonb,
  typed_fabric_metres_per_piece numeric, typed_fabric_price_per_metre numeric, typed_packing_cost_per_piece numeric, typed_packing_type text,
  typed_finish jsonb not null default '[]'::jsonb, primary key (submission_id, item_sequence));
create table public.order_product_codes (id uuid primary key default gen_random_uuid(), order_id uuid references public.orders(id) on delete cascade, submission_item_id uuid, boe_sequence integer not null);
create table public.order_activity_log (id uuid primary key default gen_random_uuid(), order_id uuid not null references public.orders(id) on delete cascade, actor_id uuid, event_type text not null, payload jsonb not null default '{}'::jsonb, created_at timestamptz not null default now());
create table public.order_pi_versions (id uuid primary key default gen_random_uuid(), order_id uuid not null references public.orders(id) on delete cascade, status text not null check (status in ('pending','approved','rejected','superseded')));
create table public.finance_payment_requests (id uuid primary key default gen_random_uuid(), status text, payment_mode text, deleted_at timestamptz);
create table public.finance_payment_allocations (id uuid primary key default gen_random_uuid(), payment_request_id uuid references public.finance_payment_requests(id), order_id uuid, allocated_amount numeric, status text default 'active', legacy_order_no text, legacy_client_name text);
create function public.normalize_legacy_order_no(p_value text) returns text language sql immutable as $$
  select nullif(upper(regexp_replace(btrim(coalesce(p_value, '')), '\\s+', ' ', 'g')), '') $$;

create table public.test_grants (uid uuid, action text);
create table public.test_can_open (uid uuid, order_id uuid);
grant select on public.test_can_open to authenticated;
grant select on public.orders to authenticated;
grant update (status) on public.orders to authenticated;
create function public.actor_has_module_permission(m text, a text) returns boolean language sql stable security definer as $$
  select exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin' and u.is_active)
      or exists (select 1 from public.test_grants g where g.uid = auth.uid() and g.action = a) $$;
create function public.module_entry_open(m text) returns boolean language sql stable as $$ select true $$;
create function public.can_view_order_unscoped(o uuid) returns boolean language sql stable security definer as $$
  select exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
      or exists (select 1 from public.test_can_open c where c.uid = auth.uid() and c.order_id = o) $$;
create function public.can_view_order_as_actor(o uuid) returns boolean language sql stable security definer as $$
  select public.can_view_order_unscoped(o) $$;
create function public.assert_order_amender() returns uuid language plpgsql stable security definer as $$
begin
  if not exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin' and u.is_active) then
    raise exception 'Only an active administrator may amend orders' using errcode = '42501';
  end if;
  return auth.uid();
end $$;
create function public.finance_payment_status_is_verified(p_status text) returns boolean language sql immutable as $$
  select coalesce(p_status in ('approved_unlinked', 'approved_linked'), false) $$;
create function public.in_order_cancellation() returns boolean language sql stable as $$
  select coalesce(current_setting('boe.cancellation_context', true), '') = 'order_cancellation' $$;

-- Production already has this trigger (20260819000000); the migration replaces the body.
create function public.orders_enforce_status_transition() returns trigger language plpgsql as $$ begin return new; end $$;
create trigger orders_enforce_status_transition before update on public.orders for each row execute function public.orders_enforce_status_transition();

insert into public.users (id, role, team, full_name) values
  ('${U.admin}', 'admin', null, 'Owner'), ('${U.sales}', 'employee', 'sales', 'Sales One'),
  ('${U.ops}', 'employee', 'operations', 'Ops One'), ('${U.plain}', 'employee', 'sales', 'Plain One'), ('${U.other}', 'employee', 'sales', 'Other One');
insert into public.test_grants values ('${U.sales}', 'record_dispatch'), ('${U.other}', 'record_dispatch');
`)

// One PI and one Order each, so a quantity can change on one without touching another.
const pi = async (n, items) => {
  await db.exec(`insert into public.order_submissions values ('${P(n)}', 'Client ${n}', 1000, 0, 1000, 0, 0, 0, null, 1000, 180, 1180, 100)`)
  for (const [seq, qty] of items) {
    await db.exec(`insert into public.order_submission_items (submission_id, item_sequence, product_name, quantity, cost_per_piece, total_amount, sort_order) values ('${P(n)}', '${seq}', 'Item ${seq}', ${qty}, 10, ${qty * 10}, ${Number(seq) || 1})`)
  }
}
const order = async (key, n, status, items) => {
  await pi(n, items)
  await db.exec(`insert into public.orders values ('${ORDERS[key]}', '05${60 + n}', '${status}', '${P(n)}', 1180)`)
  await db.exec(`insert into public.test_can_open values ('${U.sales}', '${ORDERS[key]}'), ('${U.ops}', '${ORDERS[key]}')`)
}
await order('RUN', 1, 'running', [['1', 10], ['2', 20]])
await order('READY', 2, 'ready_for_dispatch', [['1', 5]])
await order('HOLD', 3, 'on_hold', [['1', 4]])
await order('REV', 4, 'running', [['1', 6], ['2', 2]])
await order('HAND', 5, 'ready_for_dispatch', [['1', 8]])
await order('CAN', 6, 'running', [['1', 3]])
await order('PLAN', 7, 'running', [['1', 5]])
await order('EMPTY', 8, 'running', [])
await order('GONE', 9, 'running', [['1', 2]])

for (const sql of migrations) await db.exec(sql)
ok('every migration applies and the assertions inside them pass')

const as = async (uid) => { await db.exec(`reset role; select set_config('test.uid', '${uid}', false); set role authenticated;`) }
const asOwner = async () => { await db.exec(`reset role; select set_config('test.uid', '', false);`) }
const q = async (sql) => (await db.query(sql)).rows
const refuses = async (sql, code, label) => {
  try { await db.exec(sql) } catch (e) {
    assert.match(String(e.message), code, `${label}: wrong refusal ${e.message}`)
    ok(label); return
  }
  assert.fail(`${label}: expected a refusal`)
}
const status = async (key) => { await asOwner(); return (await q(`select status from public.orders where id = '${ORDERS[key]}'`))[0].status }
const events = async (key) => { await asOwner(); return (await q(`select payload from public.order_activity_log where order_id = '${ORDERS[key]}' and event_type = 'status_changed' order by created_at, id`)).map(r => r.payload) }
const lines = (...pairs) => JSON.stringify(pairs.map(([s, n]) => ({ item_sequence: s, quantity: n })))
let keyN = 0
const record = async (key, day, ls) => {
  keyN += 1
  const id = (await q(`select public.order_dispatch_record('${k(keyN)}', '${ORDERS[key]}', '${day}', '${ls}'::jsonb, '{}'::jsonb, '[]'::jsonb) as id`))[0].id
  return id
}
// What the Order page does for a hand-made status change: update, then log a row with no source.
const byHand = async (key, to, uid) => {
  await as(uid)
  await db.exec(`update public.orders set status = '${to}' where id = '${ORDERS[key]}'`)
  await asOwner()
  await db.exec(`insert into public.order_activity_log (order_id, actor_id, event_type, payload) values ('${ORDERS[key]}', '${uid}', 'status_changed', '{"from":"x","to":"${to}"}'::jsonb)`)
}
// The lot tables have no client grant: read them as the owner, then go back to the admin.
const lotRows = async (key, tail = 'order by lot_no') => { await asOwner(); const r = await q(`select id, lot_no from public.order_dispatch_lots where order_id = '${ORDERS[key]}' ${tail}`); await as(U.admin); return r }
const progress = async (uid) => { await as(uid); return q(`select order_id, ordered::float, dispatched::float, last_dispatched_on::text from public.orders_dispatch_progress()`) }

// ── Part dispatched: the Order stays where it was ───────────────────────────
await as(U.sales)
await record('RUN', '2026-10-28', lines(['1', 4], ['2', 6]))
assert.equal(await status('RUN'), 'running')
assert.equal((await events('RUN')).length, 0)
ok('part of an Order sent: it stays Running, nothing is logged')

let rows = await progress(U.sales)
assert.equal(rows.length, 1)
assert.deepEqual(rows[0], { order_id: ORDERS.RUN, ordered: 30, dispatched: 10, last_dispatched_on: '2026-10-28' })
ok('the list read says 10 of 30 pieces, last sent on 28 Oct')

// ── Part sent, rest ready: Operations moves it to Ready for Dispatch ────────
await byHand('RUN', 'ready_for_dispatch', U.ops)
assert.equal(await status('RUN'), 'ready_for_dispatch')
ok('part sent and the rest ready: Operations sets Ready for Dispatch and it stays there')

// ── The last piece closes it, from Ready ────────────────────────────────────
await as(U.sales)
await record('RUN', '2026-10-30', lines(['1', 6], ['2', 14]))
assert.equal(await status('RUN'), 'dispatched')
let ev = await events('RUN')
assert.equal(ev.at(-1).from, 'ready_for_dispatch')
assert.equal(ev.at(-1).to, 'dispatched')
assert.equal(ev.at(-1).source, 'dispatch')
assert.equal(ev.at(-1).dispatched_on, '2026-10-30')
ok('the last piece sent by a salesperson closes the Order as Dispatched and logs a status_changed row')

// ── Dispatched leaves the running view: it is a real status ─────────────────
rows = await progress(U.sales)
assert.deepEqual(rows[0], { order_id: ORDERS.RUN, ordered: 30, dispatched: 30, last_dispatched_on: '2026-10-30' })
ok('the list read now says 30 of 30')

// ── An administrator removes a dispatch: the close is undone, to where it was ─
await as(U.admin)
const lots = await lotRows('RUN')
await q(`select public.order_dispatch_lot_admin_change('${lots[1].id}', 'recorded on the wrong Order', '[]'::jsonb, null)`)
assert.equal(await status('RUN'), 'ready_for_dispatch')
ev = await events('RUN')
assert.equal(ev.at(-1).from, 'dispatched')
assert.equal(ev.at(-1).to, 'ready_for_dispatch')
ok('an admin deleting the last dispatch reopens the Order to the status it had')

await as(U.sales)
await record('RUN', '2026-10-31', lines(['1', 6], ['2', 14]))
assert.equal(await status('RUN'), 'dispatched')
await as(U.admin)
const newest = (await lotRows('RUN', 'order by lot_no desc limit 1'))[0].id
await q(`select public.order_dispatch_lot_admin_change('${newest}', 'two pieces stayed behind', '${lines(['1', 6], ['2', 12])}'::jsonb, null)`)
assert.equal(await status('RUN'), 'ready_for_dispatch')
ok('an admin lowering a dispatch below the Order reopens it')

// ── On Hold: the last piece closes it, undo restores On Hold ────────────────
await as(U.sales)
await record('HOLD', '2026-10-29', lines(['1', 4]))
assert.equal(await status('HOLD'), 'dispatched')
assert.equal((await events('HOLD')).at(-1).from, 'on_hold')
ok('a held Order whose last piece goes is closed (a dispatch records a fact that happened)')
await as(U.admin)
await q(`select public.order_dispatch_lot_admin_change('${(await lotRows('HOLD'))[0].id}', 'recorded by mistake', '[]'::jsonb, null)`)
assert.equal(await status('HOLD'), 'on_hold')
ok('and removing that dispatch puts it back On Hold')

// ── A Dispatched set by hand is never undone ────────────────────────────────
await as(U.sales)
await record('HAND', '2026-10-20', lines(['1', 3]))
assert.equal(await status('HAND'), 'ready_for_dispatch')
await byHand('HAND', 'dispatched', U.admin)
assert.equal(await status('HAND'), 'dispatched')
await as(U.admin)
await q(`select public.order_dispatch_lot_admin_change('${(await lotRows('HAND'))[0].id}', 'client took the rest elsewhere', '[]'::jsonb, null)`)
assert.equal(await status('HAND'), 'dispatched')
ok('a Dispatched an admin set by hand stays, whatever happens to the lots')

// ── A planned lot counts for nothing until it is marked dispatched ──────────
await as(U.admin)
await q(`select public.order_dispatch_lot_save('${ORDERS.PLAN}', '${lines(['1', 5])}'::jsonb, null)`)
assert.equal(await status('PLAN'), 'running')
await as(U.admin)
await q(`select public.order_dispatch_lot_mark_dispatched('${ORDERS.PLAN}', '2026-10-25')`)
assert.equal(await status('PLAN'), 'dispatched')
ok('a planned dispatch changes nothing; marking it dispatched in the Payment plan closes the Order')

// ── Revised PI: lower a quantity to what left (closes), raise it again (reopens) ─
await as(U.sales)
await record('REV', '2026-10-22', lines(['1', 6], ['2', 1]))
assert.equal(await status('REV'), 'running')
await asOwner()
await db.exec(`insert into public.order_pi_versions (order_id, status) values ('${ORDERS.REV}', 'pending')`)
await db.exec(`update public.order_submission_items set quantity = 1 where submission_id = '${P(4)}' and item_sequence = '2';
               update public.order_pi_versions set status = 'approved' where order_id = '${ORDERS.REV}'`)
assert.equal(await status('REV'), 'dispatched')
assert.equal((await events('REV')).at(-1).source, 'dispatch')
ok('a revised PI that lowers a line to what already left closes the Order')
await db.exec(`insert into public.order_pi_versions (order_id, status) values ('${ORDERS.REV}', 'pending')`)
await db.exec(`update public.order_submission_items set quantity = 3 where submission_id = '${P(4)}' and item_sequence = '2';
               update public.order_pi_versions set status = 'approved' where order_id = '${ORDERS.REV}' and status = 'pending'`)
assert.equal(await status('REV'), 'running')
ok('a later revision that raises it again reopens the automatic close')

rows = await progress(U.sales)
assert.equal(rows.find(r => r.order_id === ORDERS.REV).dispatched, 7)
await asOwner()
await db.exec(`update public.order_submission_items set quantity = 0.5 where submission_id = '${P(4)}' and item_sequence = '2'`)
assert.equal((await progress(U.sales)).find(r => r.order_id === ORDERS.REV).dispatched, 6.5)
ok('a quantity lowered below what left is clamped: never "7 of 6.5"')

// ── Cancelling after anything has left is refused ───────────────────────────
const cancel = (key) => `select set_config('boe.cancellation_context', 'order_cancellation', true); update public.orders set status = 'cancelled' where id = '${ORDERS[key]}'`
await as(U.sales)
await record('CAN', '2026-10-26', lines(['1', 1]))
await as(U.admin)
await refuses(cancel('CAN'), /ORDER_PART_DISPATCHED/, 'an Order with a dispatch cannot be cancelled, even by an admin through the audited door')
assert.equal(await status('CAN'), 'running')
await as(U.admin)
await db.exec(cancel('GONE'))
assert.equal(await status('GONE'), 'cancelled')
ok('an Order nothing has left can still be cancelled')
await asOwner()
await db.exec(`insert into public.order_dispatch_lots (order_id, lot_no, status, dispatched_on) values ('${ORDERS.GONE}', 1, 'dispatched', '2026-10-01');
               insert into public.order_dispatch_lot_lines (lot_id, item_sequence, quantity) select id, '1', 2 from public.order_dispatch_lots where order_id = '${ORDERS.GONE}'`)
assert.equal(await status('GONE'), 'cancelled')
ok('a cancelled Order is never moved by the roll-up, even if a dispatch is written to it')

// ── The graph: Ready -> Running is new; the rest is as 20260819 left it ─────
await byHand('READY', 'running', U.ops)
assert.equal(await status('READY'), 'running')
ok('Operations can send an Order back from Ready for Dispatch to Running')
await as(U.plain)
await refuses(`update public.orders set status = 'ready_for_dispatch' where id = '${ORDERS.READY}'`, /ORDER_STATUS_FORBIDDEN/, 'an ordinary employee still cannot change a status')
await as(U.ops)
await refuses(`update public.orders set status = 'dispatched' where id = '${ORDERS.READY}'`, /ORDER_STATUS_TRANSITION_INVALID/, 'Running -> Dispatched by hand is still not a legal move')
await db.exec(`update public.orders set status = 'ready_for_dispatch' where id = '${ORDERS.READY}'`)
await refuses(`update public.orders set status = 'dispatched' where id = '${ORDERS.READY}'`, /ORDER_STATUS_FORBIDDEN/, 'Operations still cannot mark Dispatched by hand')
await as(U.admin)
await db.exec(`update public.orders set status = 'dispatched' where id = '${ORDERS.READY}'`)
ok('an admin still marks Ready -> Dispatched by hand (older Orders have no dispatch records)')
await refuses(`update public.orders set status = 'running' where id = '${ORDERS.READY}'`, /ORDER_STATUS_TRANSITION_INVALID/, 'Dispatched is still terminal for a hand-made change')

// ── Nothing to send, nothing to close ───────────────────────────────────────
await asOwner()
assert.equal((await q(`select all_sent from public.order_dispatch_pieces('${ORDERS.EMPTY}')`))[0].all_sent, false)
ok('an Order with no sendable line is never "all sent"')

// ── Reads and privileges ────────────────────────────────────────────────────
rows = await progress(U.other)
assert.equal(rows.length, 0)
ok('the list read returns only Orders the caller may open')
assert.equal((await progress(U.sales)).some(r => r.order_id === ORDERS.EMPTY), false)
ok('an Order with no dispatch has no row at all')
await as(U.sales)
await refuses(`select public.order_dispatch_sync_status('${ORDERS.RUN}')`, /permission denied/, 'the roll-up is not callable by a client')
await refuses(`select * from public.order_dispatch_pieces('${ORDERS.RUN}')`, /permission denied/, 'the pieces helper is not callable by a client')
await db.exec(`reset role; set role anon;`)
await refuses(`select * from public.orders_dispatch_progress()`, /permission denied/, 'anon cannot read the list progress')

// ── Deleting an Order after it was closed leaves no error behind ────────────
await asOwner()
await db.exec(`delete from public.orders where id = '${ORDERS.PLAN}'`)
assert.equal((await q(`select count(*)::int as n from public.order_dispatch_lots where order_id = '${ORDERS.PLAN}'`))[0].n, 0)
ok('deleting a closed Order takes its dispatches with it, and the deferred roll-up finds nothing to do')

// ── The backfill statement from the migration closes only what is fully sent ─
await db.exec(`update public.orders set status = 'running' where id = '${ORDERS.REV}'`)
await db.exec(`update public.order_submission_items set quantity = 1 where submission_id = '${P(4)}' and item_sequence = '2'`)
assert.equal(await status('REV'), 'running')
const would = await q(`select o.display_number from public.orders o cross join lateral public.order_dispatch_pieces(o.id) p where p.all_sent and o.status in ('running','on_hold','ready_for_dispatch')`)
assert.equal(would.length, 1)
await db.exec(`select public.order_dispatch_sync_status(o.id) from public.orders o cross join lateral public.order_dispatch_pieces(o.id) p where p.all_sent and o.status in ('running','on_hold','ready_for_dispatch')`)
assert.equal(await status('REV'), 'dispatched')
ok('the backfill query lists, and the backfill statement closes, exactly the Orders fully covered')

console.log(`all ${checks} checks passed`)
