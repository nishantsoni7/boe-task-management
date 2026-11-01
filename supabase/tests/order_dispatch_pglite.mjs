// Database regression suite for 20270520000000 (Orders Dispatch records).
//
// Applies the REAL Payment plan migrations and then the real dispatch migration
// on an in-memory Postgres (PGlite) over a small stand-in for what they depend
// on. Stubbed: auth.uid() (a session setting), actor_has_module_permission (a
// grants table + the admin role), module_entry_open, can_view_order_unscoped
// (a table of who may open which Order), assert_order_amender, storage.objects.
//
// NOT part of npm test (PGlite is not a dependency of the app). Run it with a
// directory that has @electric-sql/pglite installed:
//   node supabase/tests/order_dispatch_pglite.mjs <dir with node_modules/@electric-sql/pglite>
// Expected last line: "all N checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node order_dispatch_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const migrations = [
  '20270428000000_order_payment_plan.sql',
  '20270430000000_order_payment_plan_account_cash.sql',
  '20270503000000_order_payment_plan_bdpi.sql',
  '20270504000000_order_payment_plan_line_costs.sql',
  '20270520000000_order_dispatch_records.sql',
].map(name => readFileSync(`${REPO}/supabase/migrations/${name}`, 'utf8'))

const U = {
  admin:  '00000000-0000-0000-0000-0000000000a1',
  sales:  '00000000-0000-0000-0000-0000000000b1', // holds record_dispatch, opens ORDER only
  ops:    '00000000-0000-0000-0000-0000000000b2', // opens ORDER, does not hold record_dispatch
  scoped: '00000000-0000-0000-0000-0000000000b3', // holds record_dispatch, cannot open ORDER unscoped
}
const ORDER = '00000000-0000-0000-0000-0000000000f1'
const OTHER = '00000000-0000-0000-0000-0000000000f2'
const CANCELLED = '00000000-0000-0000-0000-0000000000f3'
const PLANNED = '00000000-0000-0000-0000-0000000000f4'
const PI = '00000000-0000-0000-0000-0000000000e1'
const k = (n) => `20000000-0000-0000-0000-00000000000${n}`
const file = (order, key, n) => `orders/${order}/dispatch/${key}/30000000-0000-0000-0000-00000000000${n}.pdf`

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

create table public.users (id uuid primary key, role text not null default 'employee', full_name text, is_active boolean not null default true, is_deleted boolean not null default false);
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
create table public.finance_payment_requests (id uuid primary key default gen_random_uuid(), status text, payment_mode text, deleted_at timestamptz);
create table public.finance_payment_allocations (id uuid primary key default gen_random_uuid(), payment_request_id uuid references public.finance_payment_requests(id), order_id uuid, allocated_amount numeric, status text default 'active', legacy_order_no text, legacy_client_name text);
create function public.normalize_legacy_order_no(p_value text) returns text language sql immutable as $$
  select nullif(upper(regexp_replace(btrim(coalesce(p_value, '')), '\\s+', ' ', 'g')), '') $$;

create table public.test_grants (uid uuid, action text);
create table public.test_can_open (uid uuid, order_id uuid);
grant select on public.test_can_open to authenticated;
create function public.actor_has_module_permission(m text, a text) returns boolean language sql stable security definer as $$
  select exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin' and u.is_active)
      or exists (select 1 from public.test_grants g where g.uid = auth.uid() and g.action = a) $$;
create function public.module_entry_open(m text) returns boolean language sql stable as $$ select true $$;
create function public.can_view_order_unscoped(o uuid) returns boolean language sql stable security definer as $$
  select exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
      or exists (select 1 from public.test_can_open c where c.uid = auth.uid() and c.order_id = o) $$;
create function public.assert_order_amender() returns uuid language plpgsql stable security definer as $$
begin
  if not exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin' and u.is_active) then
    raise exception 'Only an active administrator may amend orders' using errcode = '42501';
  end if;
  return auth.uid();
end $$;
create function public.finance_payment_status_is_verified(p_status text) returns boolean language sql immutable as $$
  select coalesce(p_status in ('approved_unlinked', 'approved_linked'), false) $$;

insert into public.users (id, role, full_name) values ('${U.admin}', 'admin', 'Owner'), ('${U.sales}', 'employee', 'Sales One'), ('${U.ops}', 'employee', 'Ops One'), ('${U.scoped}', 'employee', 'Scoped One');
insert into public.order_submissions values ('${PI}', 'Acme', 20000, 0, 20000, 2000, 1000, 1000, null, 24000, 4320, 28320, 50);
insert into public.orders values ('${ORDER}', '0548', 'running', '${PI}', 28320), ('${OTHER}', '0549', 'running', '${PI}', 28320),
  ('${CANCELLED}', '0550', 'cancelled', '${PI}', 28320), ('${PLANNED}', '0551', 'running', '${PI}', 28320);
insert into public.order_submission_items (submission_id, item_sequence, product_name, quantity, cost_per_piece, total_amount, sort_order) values
  ('${PI}', '1', 'Table', 10, 1000, 10000, 1), ('${PI}', '2', 'Chair', 20, 500, 10000, 2);
insert into public.test_grants values ('${U.sales}', 'record_dispatch'), ('${U.scoped}', 'record_dispatch');
insert into public.test_can_open values ('${U.sales}', '${ORDER}'), ('${U.sales}', '${CANCELLED}'), ('${U.sales}', '${PLANNED}'), ('${U.ops}', '${ORDER}');
`)

for (const sql of migrations) await db.exec(sql)
ok('every migration applies and the assertions inside them pass')

const as = async (uid) => { await db.exec(`reset role; select set_config('test.uid', '${uid}', false); set role authenticated;`) }
const asOwner = async () => { await db.exec(`reset role; select set_config('test.uid', '', false);`) }
const q = async (sql, params = []) => (await db.query(sql, params)).rows
const refuses = async (sql, code, label) => {
  try { await db.query(sql); } catch (e) {
    assert.match(String(e.message), code, `${label}: wrong refusal ${e.message}`)
    ok(label); return
  }
  assert.fail(`${label}: expected a refusal`)
}
const lines = (...pairs) => JSON.stringify(pairs.map(([s, n]) => ({ item_sequence: s, quantity: n })))
const details = JSON.stringify({ vehicle_number: 'rj14 ga 4821', invoice_number: 'BOE/26-27/0187', invoice_date: '2026-10-14', invoice_taxable: 1000, invoice_gst: 180, invoice_total: 1180, packages: 6 })
const paper = (order, key, n, kind = 'invoice') => ({ path: file(order, key, n), kind, file_name: `paper-${n}.pdf`, mime_type: 'application/pdf', size_bytes: 2048 })
const record = (key, order, day, ls, d = details, files = '[]') =>
  `select public.order_dispatch_record('${key}', '${order}', '${day}', '${ls}'::jsonb, '${d}'::jsonb, '${files}'::jsonb) as id`
const read = async (uid = U.sales, order = ORDER) => { await as(uid); return (await q(`select public.order_dispatch_read('${order}') as r`))[0].r }

// ── Permission and table privileges ──
await asOwner()
assert.equal((await q(`select mpa.default_allowed from public.module_permission_actions mpa join public.permission_actions pa on pa.id = mpa.action_id where pa.action_key = 'record_dispatch'`))[0].default_allowed, false)
ok('record_dispatch is registered, denied by default')

await as(U.sales)
await refuses(`select * from public.order_dispatch_details`, /permission denied/, 'the details table is not readable directly')
await refuses(`select * from public.order_dispatch_files`, /permission denied/, 'the files table is not readable directly')
await refuses(`select public.order_dispatch_assert('${ORDER}', true)`, /permission denied/, 'the internal assert is not callable')
await refuses(`select public.order_dispatch_details_put('${ORDER}', '${k(9)}', '{}'::jsonb)`, /permission denied/, 'the internal details writer is not callable')

// ── Who may record ──
await as(U.ops)
await refuses(record(k(1), ORDER, '2026-10-14', lines(['1', 4])), /ORDER_DISPATCH_FORBIDDEN/, 'opening the Order is not enough to record')
await as(U.scoped)
await refuses(record(k(1), ORDER, '2026-10-14', lines(['1', 4])), /ORDER_DISPATCH_FORBIDDEN/, 'the permission without the right to open the Order is refused')
await refuses(`select public.order_dispatch_read('${ORDER}')`, /ORDER_DISPATCH_FORBIDDEN/, 'a reader without the unscoped right cannot read, because invoices show money')
await as(U.sales)
await refuses(record(k(1), CANCELLED, '2026-10-14', lines(['1', 4])), /ORDER_DISPATCH_ORDER_CANCELLED/, 'a cancelled Order takes no dispatch')
await refuses(record(k(1), OTHER, '2026-10-14', lines(['1', 4])), /ORDER_DISPATCH_FORBIDDEN/, 'another salesperson\'s Order is refused')

// ── What a dispatch must have ──
await refuses(`select public.order_dispatch_record('${k(1)}', '${ORDER}', null, '${lines(['1', 4])}'::jsonb, '{}'::jsonb, '[]'::jsonb)`, /DISPATCH_DATE_REQUIRED/, 'the date is required')
await refuses(record(k(1), ORDER, '2099-01-01', lines(['1', 4])), /DISPATCH_DATE_IN_FUTURE/, 'a future date is refused')
await refuses(record(k(1), ORDER, '2026-10-14', '[]'), /ORDER_DISPATCH_GOODS_REQUIRED/, 'at least one product is required')
await refuses(record(k(1), ORDER, '2026-10-14', lines(['1', 11])), /DISPATCH_QUANTITY_EXCEEDS_ORDER/, 'quantities cannot exceed the Order')
await refuses(record(k(1), ORDER, '2026-10-14', lines(['9', 1])), /DISPATCH_LINE_NOT_ON_PI/, 'a line not on the PI is refused')
await refuses(record(k(1), ORDER, '2026-10-14', lines(['1', 4]), details, JSON.stringify([paper(OTHER, k(1), 1)])), /ORDER_DISPATCH_FILE_PATH_INVALID/, 'a paper from another Order is refused')
await refuses(record(k(1), ORDER, '2026-10-14', lines(['1', 4]), details, JSON.stringify([{ ...paper(ORDER, k(1), 1), kind: 'photo' }])), /order_dispatch_files_kind_check/, 'an unknown kind of paper is refused')
await asOwner()
assert.equal((await q(`select count(*)::int as n from public.order_dispatch_lots where order_id = '${ORDER}'`))[0].n, 0)
ok('a refused dispatch leaves nothing behind')

// ── Recording ──
await as(U.sales)
const first = (await q(record(k(1), ORDER, '2026-10-14', lines(['1', 4], ['2', 6]), details, JSON.stringify([paper(ORDER, k(1), 1), paper(ORDER, k(1), 2, 'eway_bill')]))))[0].id
assert.ok(first)
ok('a salesperson with the permission records a dispatch on their Order')
const again = (await q(record(k(1), ORDER, '2026-10-14', lines(['1', 4], ['2', 6]), details, JSON.stringify([paper(ORDER, k(1), 1)]))))[0].id
assert.equal(again, first)
ok('pressing Save twice records one dispatch')

let r = await read()
assert.equal(r.can_record, true)
assert.equal(r.lots.length, 1)
assert.equal(r.lots[0].status, 'dispatched')
assert.equal(r.lots[0].lot_no, 1)
assert.equal(r.lots[0].details.vehicle_number, 'RJ14 GA 4821')
assert.equal(Number(r.lots[0].details.invoice_total), 1180)
assert.equal(r.lots[0].details.packages, 6)
assert.equal(r.lots[0].recorded_by_name, 'Sales One')
assert.equal(r.lots[0].files.length, 2)
assert.equal(r.items.length, 2)
assert.ok(r.items.every(i => /^[0-9a-f-]{36}$/.test(i.item_id)), 'each line carries its id: the Order page matches on it')
ok('the read returns goods, details, papers and who recorded it')
assert.equal((await read(U.ops)).can_record, false)
ok('a reader without the permission sees it and is told they cannot record')

await asOwner()
assert.deepEqual((await q(`select event from public.order_dispatch_lot_events where order_id = '${ORDER}'`)).map(e => e.event), ['recorded'])
const log = await q(`select event_type, payload from public.order_activity_log where order_id = '${ORDER}'`)
assert.equal(log.length, 1)
assert.equal(log[0].event_type, 'order_dispatch_recorded')
assert.equal(Number(log[0].payload.pieces), 10)
ok('one trail entry and one Activity entry')

await as(U.sales)
await refuses(record(k(2), ORDER, '2026-10-28', lines(['1', 7])), /DISPATCH_QUANTITY_EXCEEDS_ORDER/, 'earlier dispatches count towards the limit')
await q(record(k(2), ORDER, '2026-10-28', lines(['1', 6]), '{}'))
r = await read()
assert.deepEqual(r.lots.map(l => l.lot_no), [1, 2])
ok('a later dispatch takes the next number, with no details yet')

// ── The Payment plan sees the same lots ──
await as(U.admin)
const plan = (await q(`select public.order_payment_plan_read('${ORDER}') as r`))[0].r
assert.equal(plan.lots.filter(l => l.status === 'dispatched').length, 2)
ok('the Payment plan counts a recorded dispatch as sent, with no second entry')

// ── The planned lot is taken over ──
await as(U.admin)
await q(`select public.order_dispatch_lot_save('${PLANNED}', '${lines(['1', 8])}'::jsonb, null)`)
await as(U.sales)
await q(record(k(3), PLANNED, '2026-10-20', lines(['1', 9])))
r = await read(U.sales, PLANNED)
assert.equal(r.lots.length, 1)
assert.equal(r.lots[0].status, 'dispatched')
assert.equal(Number(r.lots[0].lines[0].quantity), 9)
ok('the planned lot becomes the dispatch, and is not counted twice')
await as(U.admin)
await q(`select public.order_dispatch_lot_save('${PLANNED}', '${lines(['2', 1])}'::jsonb, null)`)
ok('a new plan can follow')

// ── Papers and details afterwards ──
await as(U.sales)
const second = (await read()).lots[1]
await q(`select public.order_dispatch_update('${second.id}', '${k(4)}', '${JSON.stringify({ eway_bill_number: '3410 5582 7716' })}'::jsonb, '${JSON.stringify([paper(ORDER, k(2), 3, 'eway_bill')])}'::jsonb)`)
r = await read()
assert.equal(r.lots[1].details.eway_bill_number, '3410 5582 7716')
assert.equal(r.lots[1].details.record_key, k(2))
assert.equal(r.lots[1].files.length, 1)
ok('a paper and a missing detail are added afterwards, under the dispatch\'s own key')
await as(U.ops)
await refuses(`select public.order_dispatch_update('${second.id}', null, '{}'::jsonb, '[]'::jsonb)`, /ORDER_DISPATCH_FORBIDDEN/, 'adding papers needs the permission')

await as(U.admin)
await q(`select public.order_dispatch_lot_mark_dispatched('${PLANNED}', '2026-10-25')`)
let late = (await read(U.admin, PLANNED)).lots.find(l => l.details === null)
assert.ok(late)
await refuses(`select public.order_dispatch_update('${late.id}', null, '{}'::jsonb, '[]'::jsonb)`, /ORDER_DISPATCH_KEY_REQUIRED/, 'a lot with no paperwork needs a key from the browser')
await q(`select public.order_dispatch_update('${late.id}', '${k(5)}', '${JSON.stringify({ invoice_number: 'INV-9' })}'::jsonb, '[]'::jsonb)`)
late = (await read(U.admin, PLANNED)).lots.find(l => l.id === late.id)
assert.equal(late.details.record_key, k(5))
ok('a lot marked dispatched in the Payment plan can take paperwork')

// ── Storage rules ──
await as(U.sales)
const allowed = async (fn, name) => (await q(`select public.${fn}('${name}') as ok`))[0].ok
assert.equal(await allowed('can_upload_order_dispatch_file', file(ORDER, k(7), 1)), true)
assert.equal(await allowed('can_read_order_dispatch_file', file(ORDER, k(7), 1)), true)
assert.equal(await allowed('can_upload_order_dispatch_file', file(OTHER, k(7), 1)), false)
assert.equal(await allowed('can_read_order_dispatch_file', file(OTHER, k(7), 1)), false)
assert.equal(await allowed('can_upload_order_dispatch_file', file(CANCELLED, k(7), 1)), false)
assert.equal(await allowed('can_upload_order_dispatch_file', `orders/${ORDER}/versions/x.pdf`), false)
assert.equal(await allowed('can_upload_order_dispatch_file', `orders/${ORDER}/dispatch/${k(7)}/../evil.pdf`), false)
ok('papers upload and read only on an Order the person may work on, only under the dispatch folder')
await as(U.ops)
assert.equal(await allowed('can_upload_order_dispatch_file', file(ORDER, k(7), 1)), false)
assert.equal(await allowed('can_read_order_dispatch_file', file(ORDER, k(7), 1)), true)
ok('a reader without the permission can open a paper but not upload one')

// ── An administrator deleting a lot keeps the paperwork in the trail ──
await as(U.admin)
await q(`select public.order_dispatch_lot_admin_change('${first}', 'Recorded against the wrong Order', '[]'::jsonb, null)`)
await asOwner()
const trail = await q(`select event, detail from public.order_dispatch_lot_events where lot_id = '${first}' order by created_at, event`)
const removed = trail.find(e => e.event === 'papers_removed')
assert.ok(removed, 'no papers_removed event')
assert.equal(removed.detail.details.invoice_number, 'BOE/26-27/0187')
assert.equal(removed.detail.files.length, 2)
assert.ok(trail.some(e => e.event === 'admin_deleted'))
ok('deleting a lot leaves a copy of its paperwork in the trail')
assert.equal((await q(`select count(*)::int as n from public.order_dispatch_details where lot_id = '${first}'`))[0].n, 0)
ok('the paperwork rows went with the lot')

// ── Deleting the whole Order ──
await db.exec(`delete from public.orders where id = '${ORDER}'`)
assert.equal((await q(`select count(*)::int as n from public.order_dispatch_lots where order_id = '${ORDER}'`))[0].n, 0)
assert.equal((await q(`select count(*)::int as n from public.order_dispatch_lot_events where order_id = '${ORDER}'`))[0].n, 0)
ok('deleting an Order takes its dispatches and trail with it, without a stray trail row')

console.log(`all ${checks} checks passed`)
