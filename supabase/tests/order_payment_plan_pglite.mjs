// Database regression suite for 20270428000000 (Orders Payment plan) and
// 20270430000000 (account and cash kept apart) and 20270503000000 (old orders
// kept as BDPI).
//
// Applies the REAL migration on an in-memory Postgres (PGlite) over a small
// stand-in for what it depends on: users, the permission tables, orders, PIs,
// PI lines, payments and allocations. Stubbed: auth.uid() (a session setting),
// actor_has_module_permission (a grants table + the admin role),
// module_entry_open, can_view_order_unscoped, assert_order_amender.
// finance_payment_status_is_verified is the real definition.
//
// NOT part of npm test (PGlite is not a dependency of the app). Run it with a
// directory that has @electric-sql/pglite installed:
//   node supabase/tests/order_payment_plan_pglite.mjs <dir with node_modules/@electric-sql/pglite>
// Expected last line: "all N checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node order_payment_plan_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const migration = readFileSync(`${REPO}/supabase/migrations/20270428000000_order_payment_plan.sql`, 'utf8')
const migration2 = readFileSync(`${REPO}/supabase/migrations/20270430000000_order_payment_plan_account_cash.sql`, 'utf8')
const migration3 = readFileSync(`${REPO}/supabase/migrations/20270503000000_order_payment_plan_bdpi.sql`, 'utf8')

const U = {
  admin:   '00000000-0000-0000-0000-0000000000a1',
  viewer:  '00000000-0000-0000-0000-0000000000b1',
  editor:  '00000000-0000-0000-0000-0000000000b2',
  nobody:  '00000000-0000-0000-0000-0000000000b3',
}
const ORDER = '00000000-0000-0000-0000-0000000000f1'
const CANCELLED = '00000000-0000-0000-0000-0000000000f2'
const PI = '00000000-0000-0000-0000-0000000000e1'

const db = new PGlite()
let checks = 0
const ok = (name) => { checks += 1; console.log(`  ok  ${name}`) }

await db.exec(`
create schema if not exists auth;
create role anon nologin;
create role authenticated nologin;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;

create table public.users (id uuid primary key, role text not null default 'employee', is_active boolean not null default true, is_deleted boolean not null default false);
create table public.permission_modules (id uuid primary key default gen_random_uuid(), module_key text unique not null);
create table public.permission_actions (id uuid primary key default gen_random_uuid(), action_key text unique not null, display_name text, is_system boolean not null default false);
create table public.module_permission_actions (module_id uuid references public.permission_modules(id), action_id uuid references public.permission_actions(id), default_allowed boolean not null default false, unique (module_id, action_id));
insert into public.permission_modules (module_key) values ('orders');

create table public.order_submissions (
  id uuid primary key, client_name text, gross_product_amount numeric, discount_amount numeric, subtotal_after_discount numeric,
  fabric_cost numeric, packing_cost numeric, transportation_amount numeric, transportation_text text,
  total_before_gst numeric, gst_amount numeric, grand_total numeric, billing_percentage numeric);
create table public.orders (id uuid primary key, display_number text, status text not null default 'running', source_order_submission_id uuid references public.order_submissions(id), total_value numeric);
create table public.order_submission_items (id uuid primary key default gen_random_uuid(), submission_id uuid references public.order_submissions(id), item_sequence text, product_name text, quantity numeric, cost_per_piece numeric, total_amount numeric, sort_order int);
create table public.finance_payment_requests (id uuid primary key default gen_random_uuid(), status text, payment_mode text, deleted_at timestamptz);
create table public.finance_payment_allocations (id uuid primary key default gen_random_uuid(), payment_request_id uuid references public.finance_payment_requests(id), order_id uuid, allocated_amount numeric, status text default 'active', legacy_order_no text, legacy_client_name text);
create function public.normalize_legacy_order_no(p_value text) returns text language sql immutable as $$
  select nullif(upper(regexp_replace(btrim(coalesce(p_value, '')), '\\s+', ' ', 'g')), '') $$;

create table public.test_grants (uid uuid, action text);
create function public.actor_has_module_permission(m text, a text) returns boolean language sql stable security definer as $$
  select exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin' and u.is_active)
      or exists (select 1 from public.test_grants g where g.uid = auth.uid() and g.action = a) $$;
create function public.module_entry_open(m text) returns boolean language sql stable as $$ select true $$;
create function public.can_view_order_unscoped(o uuid) returns boolean language sql stable as $$ select exists (select 1 from public.orders where id = o) $$;
create function public.assert_order_amender() returns uuid language plpgsql stable security definer as $$
begin
  if not exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin' and u.is_active) then
    raise exception 'Only an active administrator may amend orders' using errcode = '42501';
  end if;
  return auth.uid();
end $$;
create function public.finance_payment_status_is_verified(p_status text) returns boolean language sql immutable as $$
  select coalesce(p_status in ('approved_unlinked', 'approved_linked'), false) $$;

insert into public.users (id, role) values ('${U.admin}', 'admin'), ('${U.viewer}', 'employee'), ('${U.editor}', 'employee'), ('${U.nobody}', 'employee');
insert into public.order_submissions values ('${PI}', 'Acme', 20000, 0, 20000, 2000, 1000, 1000, null, 24000, 4320, 28320, 50);
insert into public.orders values ('${ORDER}', '0539', 'running', '${PI}', 28320), ('${CANCELLED}', '0540', 'cancelled', '${PI}', 28320);
insert into public.order_submission_items (submission_id, item_sequence, product_name, quantity, cost_per_piece, total_amount, sort_order) values
  ('${PI}', '1', 'Table', 10, 1000, 10000, 1), ('${PI}', '2', 'Chair', 20, 500, 10000, 2);
-- Finance holds: 1000 verified, 600 awaiting; a rejected one, a deleted one and a legacy one that must not count.
insert into public.finance_payment_requests (id, status, payment_mode, deleted_at) values
  ('10000000-0000-0000-0000-000000000001', 'approved_linked', 'hdfc', null),
  ('10000000-0000-0000-0000-000000000002', 'pending_approval', 'canara', null),
  ('10000000-0000-0000-0000-000000000003', 'rejected', 'hdfc_sec', null),
  ('10000000-0000-0000-0000-000000000004', 'approved_linked', 'pnb', now());
insert into public.finance_payment_allocations (payment_request_id, order_id, allocated_amount, status) values
  ('10000000-0000-0000-0000-000000000001', '${ORDER}', 1000, 'active'),
  ('10000000-0000-0000-0000-000000000002', '${ORDER}', 600, 'active'),
  ('10000000-0000-0000-0000-000000000003', '${ORDER}', 5000, 'active'),
  ('10000000-0000-0000-0000-000000000004', '${ORDER}', 7000, 'active');
insert into public.test_grants values ('${U.viewer}', 'view_payment_plan'), ('${U.editor}', 'view_payment_plan'), ('${U.editor}', 'edit_payment_plan');
`)

// ── Apply the real migration (it asserts itself at the end) ──
await db.exec(migration)
ok('the migration applies and its own assertions pass')
await db.exec(migration2)
ok('the account / cash migration applies on top and its own assertions pass')

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
const read = async (uid = U.editor) => { await as(uid); const r = (await q(`select public.order_payment_plan_read('${ORDER}') as r`))[0].r; return r }
const lines = (...pairs) => JSON.stringify(pairs.map(([s, n]) => ({ item_sequence: s, quantity: n })))

// ── Permissions registered, denied by default ──
await asOwner()
const perms = await q(`select pa.action_key, mpa.default_allowed from public.module_permission_actions mpa join public.permission_actions pa on pa.id = mpa.action_id order by 1`)
assert.deepEqual(perms.map(p => [p.action_key, p.default_allowed]), [['edit_payment_plan', false], ['view_payment_plan', false]])
ok('both permissions are registered and denied by default')

// ── Closed tables ──
await as(U.editor)
await refuses(`select * from public.order_dispatch_lots`, /permission denied/i, 'a client role cannot read the lots table')
await refuses(`insert into public.order_payment_plans (order_id) values ('${ORDER}')`, /permission denied/i, 'a client role cannot write the plans table')
await refuses(`select public.order_payment_plan_check_lines('${ORDER}', '[]'::jsonb, null)`, /permission denied/i, 'internal helpers are not callable')

// ── Reading ──
await as(U.nobody)
await refuses(`select public.order_payment_plan_read('${ORDER}')`, /PAYMENT_PLAN_FORBIDDEN/, 'someone without the permission cannot read')
const r = await read(U.viewer)
assert.equal(r.found, true)
assert.equal(r.items.length, 2)
assert.equal(Number(r.pi.total_before_gst), 24000)
assert.equal(Number(r.pi.billing_percentage), 50)
assert.equal(r.plan, null)
assert.deepEqual(r.lots, [])
ok('a viewer reads the PI, its lines and no plan yet')
assert.equal(Number(r.finance.verified), 1000)
assert.equal(Number(r.finance.awaiting), 600)
assert.equal(r.finance.payment_count, 2)
ok('Finance comes back as totals only: rejected and deleted payments do not count')
assert.equal(Number(r.finance.account_verified), 1000)
assert.equal(Number(r.finance.cash_verified), 0)
assert.equal(Number(r.finance.account_awaiting), 0)
assert.equal(Number(r.finance.cash_awaiting), 600)
ok('the same money is split into account (HDFC) and cash (Canara counts as cash)')
assert.doesNotMatch(JSON.stringify(r), /10000000-0000-0000-0000-00000000000/)
ok('no payment id leaves the database')
await refuses(`select public.order_payment_plan_save('${ORDER}', 50, null, null, null, null)`, /PAYMENT_PLAN_FORBIDDEN/, 'a viewer cannot save')
await refuses(`select public.order_dispatch_lot_save('${ORDER}', '${lines(['1', 4])}'::jsonb, null)`, /PAYMENT_PLAN_FORBIDDEN/, 'a viewer cannot plan a lot')

// ── Saving the inputs ──
await as(U.editor)
await refuses(`select public.order_payment_plan_save('${ORDER}', 101, null, null, null, null)`, /PAYMENT_PLAN_PERCENT_INVALID/, 'pending percentage above 100 is refused')
await refuses(`select public.order_payment_plan_save('${ORDER}', 50.123, null, null, null, null)`, /PAYMENT_PLAN_PERCENT_INVALID/, 'a third decimal is refused, never rounded')
await refuses(`select public.order_payment_plan_save('${ORDER}', 50, null, 10.005, null, null)`, /PAYMENT_PLAN_ADVANCE_INVALID/, 'an advance with a third decimal is refused')
await q(`select public.order_payment_plan_save('${ORDER}', 60, 100, 15000.5, 250, '  hello  ')`)
let p = (await read()).plan
assert.equal(Number(p.pending_percent), 60)
assert.equal(Number(p.billing_percent), 100)
assert.equal(Number(p.advance_account_override), 15000.5)
assert.equal(Number(p.advance_cash_override), 250)
assert.equal(p.note, 'hello')
ok('the inputs save, are trimmed, and read back')
await q(`select public.order_payment_plan_save('${ORDER}', 50, null, null, null, null)`)
p = (await read()).plan
assert.equal(p.billing_percent, null)
assert.equal(p.advance_account_override, null)
assert.equal(p.advance_cash_override, null)
ok('clearing the billing percentage and the typed advance saves as null')

// ── The planned lot ──
await refuses(`select public.order_dispatch_lot_save('${ORDER}', '${lines(['9', 1])}'::jsonb, null)`, /DISPATCH_LINE_NOT_ON_PI/, 'a line not on the PI is refused')
await refuses(`select public.order_dispatch_lot_save('${ORDER}', '${lines(['1', 11])}'::jsonb, null)`, /DISPATCH_QUANTITY_EXCEEDS_ORDER/, 'more than ordered is refused')
await refuses(`select public.order_dispatch_lot_save('${ORDER}', '${lines(['1', 0])}'::jsonb, null)`, /DISPATCH_QUANTITY_INVALID/, 'zero is refused')
await refuses(`select public.order_dispatch_lot_save('${ORDER}', '${lines(['1', 1.234])}'::jsonb, null)`, /DISPATCH_QUANTITY_INVALID/, 'three decimals are refused')
await refuses(`select public.order_dispatch_lot_save('${ORDER}', '${lines(['1', 1], ['1', 2])}'::jsonb, null)`, /DISPATCH_LINE_DUPLICATED/, 'the same line twice is refused')
await refuses(`select public.order_dispatch_lot_save('${ORDER}', '{"a":1}'::jsonb, null)`, /DISPATCH_LINES_INVALID/, 'a non-array is refused')
const lot1 = (await q(`select public.order_dispatch_lot_save('${ORDER}', '${lines(['1', 10], ['2', 5])}'::jsonb, '2026-11-01') as id`))[0].id
let d = await read()
assert.equal(d.lots.length, 1)
assert.equal(d.lots[0].status, 'planned')
assert.equal(d.lots[0].lot_no, 1)
assert.equal(d.lots[0].lines.length, 2)
ok('a planned lot is created with lot number 1')
const again = (await q(`select public.order_dispatch_lot_save('${ORDER}', '${lines(['1', 4])}'::jsonb, null) as id`))[0].id
assert.equal(again, lot1)
d = await read()
assert.equal(d.lots.length, 1)
assert.deepEqual(d.lots[0].lines.map(l => [l.item_sequence, Number(l.quantity)]), [['1', 4]])
ok('saving again replaces the planned lot instead of adding another')
await q(`select public.order_dispatch_lot_save('${ORDER}', '[]'::jsonb, null)`)
assert.equal((await read()).lots.length, 0)
ok('an empty plan discards the planned lot')
assert.equal((await q(`select public.order_dispatch_lot_save('${ORDER}', '[]'::jsonb, null) as id`))[0].id, null)
ok('discarding when there is nothing is quietly nothing')

// ── Mark dispatched, history, cumulative limit ──
await refuses(`select public.order_dispatch_lot_mark_dispatched('${ORDER}', current_date)`, /DISPATCH_NO_PLANNED_LOT/, 'nothing planned, nothing to dispatch')
await q(`select public.order_dispatch_lot_save('${ORDER}', '${lines(['1', 10], ['2', 5])}'::jsonb, null)`)
await refuses(`select public.order_dispatch_lot_mark_dispatched('${ORDER}', null)`, /DISPATCH_DATE_REQUIRED/, 'a dispatch date is required')
await refuses(`select public.order_dispatch_lot_mark_dispatched('${ORDER}', current_date + 30)`, /DISPATCH_DATE_IN_FUTURE/, 'a far-future date is refused')
await q(`select public.order_dispatch_lot_mark_dispatched('${ORDER}', '2026-10-20')`)
d = await read()
assert.equal(d.lots[0].status, 'dispatched')
assert.equal(d.lots[0].dispatched_on, '2026-10-20')
ok('the planned lot becomes dispatched history')
await refuses(`select public.order_dispatch_lot_save('${ORDER}', '${lines(['1', 1])}'::jsonb, null)`, /DISPATCH_QUANTITY_EXCEEDS_ORDER/, 'quantities already dispatched count against the order')
await q(`select public.order_dispatch_lot_save('${ORDER}', '${lines(['2', 15])}'::jsonb, null)`)
d = await read()
assert.deepEqual(d.lots.map(l => [l.lot_no, l.status]), [[1, 'dispatched'], [2, 'planned']])
ok('the next lot starts as lot 2, and may take exactly what is left')
await refuses(`select public.order_dispatch_lot_save('${ORDER}', '${lines(['2', 15.01])}'::jsonb, null)`, /DISPATCH_QUANTITY_EXCEEDS_ORDER/, 'one hundredth too many is refused')

// ── Changing a dispatched lot: administrators only ──
const lotId = d.lots[0].id
await refuses(`select public.order_dispatch_lot_admin_change('${lotId}', 'Entered the wrong quantity', '${lines(['1', 8])}'::jsonb, null)`, /administrator/i, 'an editor cannot change a dispatched lot')
await as(U.admin)
await refuses(`select public.order_dispatch_lot_admin_change('${lotId}', 'short', '${lines(['1', 8])}'::jsonb, null)`, /DISPATCH_REASON_REQUIRED/, 'a reason of at least 10 characters is needed')
await refuses(`select public.order_dispatch_lot_admin_change('${d.lots[1].id}', 'Entered the wrong quantity', '${lines(['2', 1])}'::jsonb, null)`, /DISPATCH_LOT_NOT_FOUND/, 'a planned lot is not changed this way')
await q(`select public.order_dispatch_lot_admin_change('${lotId}', 'Entered the wrong quantity', '${lines(['1', 8], ['2', 5])}'::jsonb, '2026-10-21')`)
d = await read(U.admin)
assert.deepEqual(d.lots[0].lines.map(l => [l.item_sequence, Number(l.quantity)]), [['1', 8], ['2', 5]])
assert.equal(d.lots[0].dispatched_on, '2026-10-21')
ok('an administrator corrects a dispatched lot with a reason')
await q(`select public.order_dispatch_lot_admin_change('${lotId}', 'Lot was never sent out', '[]'::jsonb, null)`)
d = await read(U.admin)
assert.deepEqual(d.lots.map(l => l.lot_no), [2])
ok('an administrator can delete a dispatched lot')
await asOwner()
const events = await q(`select event, reason from public.order_dispatch_lot_events order by created_at, id`)
assert.ok(events.some(e => e.event === 'admin_changed' && e.reason === 'Entered the wrong quantity'))
assert.ok(events.some(e => e.event === 'admin_deleted' && e.reason === 'Lot was never sent out'))
assert.ok(events.some(e => e.event === 'dispatched') && events.some(e => e.event === 'planned') && events.some(e => e.event === 'discarded'))
ok('every change left a trail, including the reasons')

// ── A cancelled Order cannot be edited; deleting an Order takes its plan with it ──
await as(U.editor)
await refuses(`select public.order_payment_plan_save('${CANCELLED}', 50, null, null, null, null)`, /PAYMENT_PLAN_ORDER_CANCELLED/, 'a cancelled Order cannot be edited')
await asOwner()
await db.exec(`delete from public.order_dispatch_lot_events; delete from public.orders where id = '${ORDER}'`)
assert.equal((await q(`select count(*)::int as n from public.order_dispatch_lots`))[0].n, 0)
assert.equal((await q(`select count(*)::int as n from public.order_payment_plans`))[0].n, 0)
ok('deleting an Order removes its plan and lots')

// ══ Old orders kept as BDPI (20270503000000) ═════════════════════════════════
await asOwner()
await db.exec(migration3)
ok('the BDPI migration applies on top and its own assertions pass')

const bdpiPayload = (old, extra = {}) => JSON.stringify({
  old_order_no: old, client_name: 'Rivoli Hotels', workbook_name: 'Old 412.xlsx', fabric_responsibility: 'client',
  commercial_terms_note: 'Ex-works',
  commercial: { gross_product_amount: 20000, total_before_gst: 24000, gst_amount: 4320, grand_total: 28320, packing_cost: 1000, fabric_cost_text: 'as per selection' },
  items: [
    { item_sequence: 'B1', product_name: 'Sofa', quantity: 10, rate: 1000, line_total: 10000, dimensions: '80 in', material: 'Teak',
      fabric_metres_per_piece: 6.5, fabric_price_per_metre: 450, packing_cost_per_piece: 100, packing_type: 'BCF',
      finish_specs: [{ heading: 'Fabric', value: 'Velvet Blue' }] },
    { item_sequence: 'B2', product_name: 'Chair', quantity: 20, rate: 500, line_total: 10000 },
  ],
  ...extra,
})

await as(U.viewer)
await refuses(`select public.create_bdpi('${bdpiPayload('412')}'::jsonb)`, /PAYMENT_PLAN_FORBIDDEN/, 'a viewer cannot create a BDPI')
await as(U.editor)
const created = (await q(`select public.create_bdpi('${bdpiPayload(' 412 ')}'::jsonb) as r`))[0].r
assert.equal(created.bdpi_no, 'BDPI-0001')
ok('an editor creates BDPI-0001')
await refuses(`select public.create_bdpi('${bdpiPayload('412')}'::jsonb)`, /BDPI_OLD_ORDER_EXISTS/, 'the same old order number twice is refused')
await refuses(`select public.create_bdpi('${bdpiPayload('413', { items: [{ item_sequence: 'X', quantity: 1.234, rate: 1 }] })}'::jsonb)`, /BDPI_ITEM_INVALID/, 'three decimals on a line are refused')
await refuses(`select public.create_bdpi('${bdpiPayload('', {})}'::jsonb)`, /BDPI_OLD_ORDER_REQUIRED/, 'an old order number is required')
const B = created.id

await as(U.editor)
await refuses(`select public.bdpi_attach_files('${B}', 'submissions/x/y.xlsx', 'x', '[]'::jsonb)`, /BDPI_PATH_INVALID/, 'files outside bdpi/<id>/ are refused')
await q(`select public.bdpi_attach_files('${B}', 'bdpi/${B}/workbook.xlsx', 'Old 412.xlsx', '[{"item_sequence":"B1","path":"bdpi/${B}/items/B1.png"}]'::jsonb)`)

// Finance money allocated to OLD order 412: 3000 HDFC verified, 2000 PNB verified, 700 Canara awaiting
await asOwner()
await db.exec(`
insert into public.finance_payment_requests (id, status, payment_mode) values
  ('20000000-0000-0000-0000-000000000001', 'approved_linked', 'hdfc'),
  ('20000000-0000-0000-0000-000000000002', 'approved_unlinked', 'pnb'),
  ('20000000-0000-0000-0000-000000000003', 'pending_approval', 'canara');
insert into public.finance_payment_allocations (payment_request_id, legacy_order_no, legacy_client_name, allocated_amount) values
  ('20000000-0000-0000-0000-000000000001', '412', 'Rivoli', 3000),
  ('20000000-0000-0000-0000-000000000002', '412', 'Rivoli', 2000),
  ('20000000-0000-0000-0000-000000000003', '412', 'Rivoli', 700);`)

let b = (await (async () => { await as(U.viewer); return q(`select public.bdpi_payment_plan_read('${B}') as r`) })())[0].r
assert.equal(b.kind, 'bdpi')
assert.equal(b.order.display_number, 'BDPI-0001')
assert.equal(b.order.old_order_no, '412')
assert.equal(b.order.fabric_responsibility, 'client')
assert.equal(Number(b.pi.total_before_gst), 24000)
assert.equal(b.pi.fabric_cost_text, 'as per selection')
assert.equal(b.items.length, 2)
assert.equal(b.items[0].has_image, true)
assert.equal(b.items[0].material, 'Teak')
assert.deepEqual(b.items[0].finish_specs, [{ heading: 'Fabric', value: 'Velvet Blue' }])
assert.equal(Number(b.items[0].fabric_metres_per_piece), 6.5)
ok('the BDPI reads in the same shape as an Order, with the complete PI details')
assert.equal(Number(b.finance.account_verified), 3000)
assert.equal(Number(b.finance.cash_verified), 2000)
assert.equal(Number(b.finance.cash_awaiting), 700)
ok('payments Finance allocated to the old order number are split into account and cash')
assert.doesNotMatch(JSON.stringify(b), /bdpi\/|20000000-/)
ok('no storage path or payment id leaves the database')

await as(U.viewer)
await refuses(`select public.bdpi_payment_plan_save('${B}', 50, null, null, null, null)`, /PAYMENT_PLAN_FORBIDDEN/, 'a viewer cannot save a BDPI plan')
await as(U.editor)
await q(`select public.bdpi_payment_plan_save('${B}', 60, 50, null, 500, 'old order')`)
await refuses(`select public.bdpi_dispatch_lot_save('${B}', '${lines(['B1', 11])}'::jsonb, null)`, /DISPATCH_QUANTITY_EXCEEDS_ORDER/, 'a BDPI lot cannot exceed what was ordered')
await refuses(`select public.bdpi_dispatch_lot_save('${B}', '${lines(['1', 1])}'::jsonb, null)`, /DISPATCH_LINE_NOT_ON_PI/, 'an Order line is not a BDPI line')
await q(`select public.bdpi_dispatch_lot_save('${B}', '${lines(['B1', 10], ['B2', 5])}'::jsonb, null)`)
await q(`select public.bdpi_dispatch_lot_mark_dispatched('${B}', current_date)`)
await q(`select public.bdpi_dispatch_lot_save('${B}', '${lines(['B2', 15])}'::jsonb, null)`)
b = (await q(`select public.bdpi_payment_plan_read('${B}') as r`))[0].r
assert.deepEqual(b.lots.map(l => [l.lot_no, l.status]), [[1, 'dispatched'], [2, 'planned']])
assert.equal(Number(b.plan.pending_percent), 60)
assert.equal(Number(b.plan.advance_cash_override), 500)
ok('a BDPI remembers what was dispatched; the next load shows lot 1 sent and lot 2 planned')

const list = (await q(`select public.bdpi_list() as r`))[0].r
assert.equal(list.length, 1)
assert.equal(Number(list[0].dispatched_qty), 15)
assert.equal(Number(list[0].ordered_qty), 30)
assert.equal(list[0].has_planned, true)
ok('the list shows pieces sent of pieces ordered')

// admin change of a BDPI lot, and delete rules
const bLot = b.lots[0].id
await refuses(`select public.order_dispatch_lot_admin_change('${bLot}', 'Entered the wrong quantity', '${lines(['B1', 9])}'::jsonb, null)`, /administrator/i, 'an editor cannot change a dispatched BDPI lot')
await as(U.admin)
await q(`select public.order_dispatch_lot_admin_change('${bLot}', 'Entered the wrong quantity', '${lines(['B1', 9], ['B2', 5])}'::jsonb, null)`)
ok('an administrator corrects a dispatched BDPI lot through the shared door')
await refuses(`select public.delete_bdpi('${B}', 'Uploaded the wrong file')`, /BDPI_HAS_DISPATCHES/, 'a BDPI with dispatches cannot be deleted')
const second = (await (async () => { await as(U.editor); return q(`select public.create_bdpi('${bdpiPayload('OLD 9')}'::jsonb) as r`) })())[0].r
assert.equal(second.bdpi_no, 'BDPI-0002')
await refuses(`select public.delete_bdpi('${second.id}', 'Uploaded the wrong file')`, /administrator/i, 'only an administrator deletes a BDPI')
await as(U.admin)
await refuses(`select public.delete_bdpi('${second.id}', 'short')`, /DISPATCH_REASON_REQUIRED/, 'deleting a BDPI needs a reason')
await q(`select public.delete_bdpi('${second.id}', 'Uploaded the wrong file')`)
await asOwner()
assert.equal((await q(`select count(*)::int as n from public.bdpi_records`))[0].n, 1)
ok('an administrator deletes a BDPI with nothing dispatched')
await as(U.editor)
await refuses(`select * from public.bdpi_records`, /permission denied/i, 'a client role cannot read the BDPI tables')
await asOwner()
const owners = await q(`select count(*)::int as n from public.order_dispatch_lots where num_nonnulls(order_id, bdpi_id) <> 1`)
assert.equal(owners[0].n, 0)
ok('every lot belongs to exactly one Order or BDPI')

console.log(`all ${checks} checks passed`)
