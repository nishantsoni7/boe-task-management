// Database regression suite for 20270431000000 (Orders: Fabric & Finish cost
// sheet per PI line).
//
// Applies the REAL migration on an in-memory Postgres (PGlite) over a small
// stand-in for what it depends on: users, PIs, PI lines, Orders. Stubbed:
// auth.uid() (a session setting), module_entry_open, can_view_order_submission,
// can_read_order_detail and can_record_order_approval (explicit rules over the
// stand-in rows). Everything the migration itself defines is the real thing.
//
// NOT part of npm test (PGlite is not a dependency of the app). Run it with a
// directory that has @electric-sql/pglite installed:
//   node supabase/tests/order_submission_fabric_finish_pglite.mjs <dir with node_modules/@electric-sql/pglite>
// Expected last line: "all N checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node order_submission_fabric_finish_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const migration = readFileSync(`${REPO}/supabase/migrations/20270431000000_order_submission_fabric_finish_lines.sql`, 'utf8')

const U = {
  admin:    '00000000-0000-0000-0000-0000000000a1',
  manager:  '00000000-0000-0000-0000-0000000000a2',
  creator:  '00000000-0000-0000-0000-0000000000b1',   // made the draft PI
  sales:    '00000000-0000-0000-0000-0000000000b2',   // the Order's salesperson
  ops:      '00000000-0000-0000-0000-0000000000b3',   // may read the Order, nothing more
  nobody:   '00000000-0000-0000-0000-0000000000b4',
}
const DRAFT = '00000000-0000-0000-0000-0000000000e1'     // a PI not yet an Order, by creator
const PI_ORDER = '00000000-0000-0000-0000-0000000000e2'  // the PI in force on ORDER
const PI_REJECTED = '00000000-0000-0000-0000-0000000000e3'
const PI_CANCELLED = '00000000-0000-0000-0000-0000000000e4'
const ORDER = '00000000-0000-0000-0000-0000000000f1'
const CANCELLED = '00000000-0000-0000-0000-0000000000f2'
const ITEM_NO_SEQ = '00000000-0000-0000-0000-0000000000c9'
const SHA = 'a'.repeat(64)

const db = new PGlite()
let checks = 0
const ok = (name) => { checks += 1; console.log(`  ok  ${name}`) }

await db.exec(`
create schema if not exists auth;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;

create table public.users (id uuid primary key, full_name text, role text not null default 'employee', is_active boolean not null default true, is_deleted boolean not null default false);
create table public.order_submissions (
  id uuid primary key, status text not null default 'draft', order_id uuid, created_by uuid, submitted_by uuid, salesperson_id uuid, assigned_to uuid,
  client_name text, source_workbook_name text,
  fabric_cost numeric, fabric_cost_meaning text not null default 'numeric', fabric_cost_text text,
  packing_cost numeric, packing_cost_meaning text not null default 'numeric', packing_cost_text text);
create table public.orders (id uuid primary key, display_number text, status text not null default 'running', source_order_submission_id uuid references public.order_submissions(id), assigned_to uuid, requested_by uuid);
create table public.order_submission_items (id uuid primary key default gen_random_uuid(), submission_id uuid references public.order_submissions(id) on delete cascade, item_sequence text, product_name text, source_product_code text, quantity numeric, sort_order int, source_row int);

create table public.test_grants (uid uuid, action text);
create function public.module_entry_open(m text) returns boolean language sql stable as $$ select auth.uid() is not null $$;
create function public.can_view_order_submission(p uuid) returns boolean language sql stable security definer as $$
  select exists (select 1 from public.order_submissions s where s.id = p
                  and (s.created_by = auth.uid() or s.submitted_by = auth.uid() or s.assigned_to = auth.uid()
                       or exists (select 1 from public.test_grants g where g.uid = auth.uid() and g.action = 'approve_order'))) $$;
create function public.can_read_order_detail(o uuid) returns boolean language sql stable security definer as $$
  select exists (select 1 from public.orders x where x.id = o
                  and (exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
                       or x.assigned_to = auth.uid() or x.requested_by = auth.uid()
                       or exists (select 1 from public.test_grants g where g.uid = auth.uid() and g.action = 'view_all'))) $$;
create function public.can_record_order_approval(o uuid) returns boolean language sql stable security definer as $$
  select exists (select 1 from public.orders x join public.users u on u.id = auth.uid() where x.id = o and u.is_active
                  and (u.role in ('admin','manager') or x.assigned_to = auth.uid())) $$;

insert into public.users (id, full_name, role) values
  ('${U.admin}', 'Admin', 'admin'), ('${U.manager}', 'Manager', 'manager'), ('${U.creator}', 'Creator', 'employee'),
  ('${U.sales}', 'Sales', 'employee'), ('${U.ops}', 'Ops', 'employee'), ('${U.nobody}', 'Nobody', 'employee');
insert into public.order_submissions (id, status, created_by, client_name, fabric_cost, fabric_cost_meaning, packing_cost, packing_cost_meaning)
  values ('${DRAFT}', 'draft', '${U.creator}', 'Draft client', 0, 'not_applicable', 1800, 'numeric');
insert into public.order_submissions (id, status, created_by, salesperson_id, client_name, fabric_cost, packing_cost)
  values ('${PI_ORDER}', 'approved', '${U.creator}', '${U.sales}', 'Order client', 12190, 16450);
insert into public.order_submissions (id, status, created_by) values ('${PI_REJECTED}', 'rejected', '${U.creator}');
insert into public.order_submissions (id, status, created_by) values ('${PI_CANCELLED}', 'approved', '${U.creator}');
insert into public.orders (id, display_number, source_order_submission_id, assigned_to, requested_by) values ('${ORDER}', '0539', '${PI_ORDER}', '${U.sales}', '${U.creator}');
insert into public.orders (id, display_number, status, source_order_submission_id, assigned_to) values ('${CANCELLED}', '0540', 'cancelled', '${PI_CANCELLED}', '${U.sales}');
update public.order_submissions set order_id = '${ORDER}' where id = '${PI_ORDER}';
update public.order_submissions set order_id = '${CANCELLED}' where id = '${PI_CANCELLED}';
insert into public.order_submission_items (submission_id, item_sequence, product_name, source_product_code, quantity, sort_order, source_row) values
  ('${DRAFT}', 'B001', 'Chair', '100-B001', 25, 0, 32), ('${DRAFT}', 'B002', 'Table', '100-B002', 4, 1, 33),
  ('${PI_ORDER}', 'B001', 'Chair', '100-B001', 25, 0, 32), ('${PI_ORDER}', 'B002', 'Table', '100-B002', 4, 1, 33),
  ('${PI_CANCELLED}', 'B001', 'Chair', null, 1, 0, 32);
insert into public.order_submission_items (id, submission_id, item_sequence, product_name, quantity, sort_order, source_row) values
  ('${ITEM_NO_SEQ}', '${DRAFT}', null, 'Unnumbered', 2, 2, 34);
insert into public.test_grants values ('${U.ops}', 'view_all');
`)

await db.exec(migration)
ok('the migration applies, self-checks included')

const as = async (uid) => { await db.query(`select set_config('test.uid', $1, false)`, [uid ?? '']) }
const rpc = async (sql, params = []) => (await db.query(sql, params)).rows[0]
const expectError = async (fn, pattern, name) => {
  try { await fn(); assert.fail(`${name}: expected a refusal`) }
  catch (e) { assert.match(String(e.message), pattern, `${name}: ${e.message}`); ok(name) }
}

// ── Reach ──
{
  const r = await rpc(`select relrowsecurity as rls, (select count(*) from pg_policies where tablename = 'order_submission_fabric_finish_lines') as policies
                        from pg_class where relname = 'order_submission_fabric_finish_lines'`)
  assert.equal(r.rls, true); assert.equal(Number(r.policies), 0)
  ok('RLS is on and the table has no policies')
  const g = await rpc(`select has_table_privilege('authenticated', 'public.order_submission_fabric_finish_lines', 'select') as sel,
                              has_function_privilege('authenticated', 'public.order_submission_fabric_finish_save_sheet(uuid, text, jsonb)', 'execute') as sheet,
                              has_function_privilege('service_role', 'public.order_submission_fabric_finish_save_sheet(uuid, text, jsonb)', 'execute') as sheet_service,
                              has_function_privilege('authenticated', 'public.order_submission_fabric_finish_save_typed(uuid, text, jsonb)', 'execute') as typed,
                              has_function_privilege('authenticated', 'public.order_submission_fabric_finish_read(uuid)', 'execute') as readf`)
  assert.equal(g.sel, false); assert.equal(g.sheet, false); assert.equal(g.sheet_service, true); assert.equal(g.typed, true); assert.equal(g.readf, true)
  ok('authenticated reaches the table only through read and save_typed; save_sheet is the service role’s')
}

// ── Who may see ──
{
  await as(null)
  await expectError(() => rpc(`select public.order_submission_fabric_finish_read($1)`, [DRAFT]), /Authentication required/, 'no session: refused')
  await as(U.nobody)
  await expectError(() => rpc(`select public.order_submission_fabric_finish_read($1)`, [DRAFT]), /FABRIC_FINISH_FORBIDDEN/, 'a stranger cannot read a draft’s sheet')
  await expectError(() => rpc(`select public.order_submission_fabric_finish_read($1)`, [PI_ORDER]), /FABRIC_FINISH_FORBIDDEN/, 'nor an Order’s')
  await as(U.creator)
  let r = (await rpc(`select public.order_submission_fabric_finish_read($1) as r`, [DRAFT])).r
  assert.equal(r.found, true); assert.equal(r.can_edit, true)
  assert.deepEqual(r.items.map(i => i.item_sequence), ['B001', 'B002', ITEM_NO_SEQ])
  assert.equal(r.submission.fabric_cost_meaning, 'not_applicable'); assert.equal(Number(r.submission.packing_cost), 1800)
  assert.deepEqual(r.lines, [])
  ok('the creator reads the draft: lines in order, an unnumbered line keyed by its id, the PI’s own cost lines, may type')
  await as(U.ops)
  r = (await rpc(`select public.order_submission_fabric_finish_read($1) as r`, [PI_ORDER])).r
  assert.equal(r.found, true); assert.equal(r.can_edit, false); assert.equal(r.submission.display_number, '0539'); assert.equal(r.submission.order_status, 'running')
  ok('anyone who may read the Order reads its PI’s sheet, and may not type')
  await expectError(() => rpc(`select public.order_submission_fabric_finish_read($1)`, [DRAFT]), /FABRIC_FINISH_FORBIDDEN/, 'but not a draft they have no part in')
  await as(U.sales)
  r = (await rpc(`select public.order_submission_fabric_finish_read($1) as r`, [PI_ORDER])).r
  assert.equal(r.can_edit, true)
  ok('the Order’s salesperson may type')
  await as(U.manager)
  await expectError(() => rpc(`select public.order_submission_fabric_finish_read($1)`, [DRAFT]), /FABRIC_FINISH_FORBIDDEN/, 'a manager with no part in a draft, and no approve_order, cannot open it either')
  await expectError(() => rpc(`select public.order_submission_fabric_finish_read($1)`, [PI_ORDER]), /FABRIC_FINISH_FORBIDDEN/, 'nor an Order they may not read')
  await db.query(`insert into public.test_grants values ($1, 'view_all')`, [U.manager])
  r = (await rpc(`select public.order_submission_fabric_finish_read($1) as r`, [PI_ORDER])).r
  assert.equal(r.found, true); assert.equal(r.can_edit, true)
  ok('a manager who may read the Order (view_all) reads its sheet and may type')
}

// ── The workbook’s values ──
{
  await as(null)
  const n = (await rpc(`select public.order_submission_fabric_finish_save_sheet($1, $2, $3::jsonb) as n`, [PI_ORDER, SHA, JSON.stringify([
    { item_sequence: 'B001', fabric_metres_per_piece: 0.75, fabric_price_per_metre: 650, packing_cost_per_piece: 550, packing_type: 'BCF',
      finish: [{ heading: 'Fabric Approval', value: 'PENDING' }, { heading: 'Wood Finish Approval', value: 'Acacia natural' }] },
    { item_sequence: 'B002', fabric_metres_per_piece: 0, packing_cost_per_piece: 450, finish: [] },
  ])])).n
  assert.equal(Number(n), 2)
  await as(U.sales)
  let r = (await rpc(`select public.order_submission_fabric_finish_read($1) as r`, [PI_ORDER])).r
  assert.equal(r.lines.length, 2)
  const b1 = r.lines.find(l => l.item_sequence === 'B001')
  assert.equal(Number(b1.sheet.fabric_metres_per_piece), 0.75); assert.equal(Number(b1.sheet.fabric_price_per_metre), 650)
  assert.equal(b1.sheet.packing_type, 'BCF'); assert.equal(b1.sheet.finish.length, 2); assert.equal(b1.typed, null)
  assert.ok(r.submission.sheet_read_at)
  ok('the import route’s save_sheet stores every line with its finish, and the read says when')
  // A workbook's own pictures need no new door: the sheet's entries already
  // carry them, under the same key check typed ones pass (owner, 2026-10-30).
  const pictureSha = 'b'.repeat(64)
  const pictureKey = `submissions/${PI_ORDER}/fabric-finish/B002/${pictureSha}.png`
  const sheetWith = finish => JSON.stringify([
    { item_sequence: 'B001', fabric_metres_per_piece: 0.75, fabric_price_per_metre: 650, packing_cost_per_piece: 550, packing_type: 'BCF',
      finish: [{ heading: 'Fabric Approval', value: 'PENDING' }, { heading: 'Wood Finish Approval', value: 'Acacia natural' }] },
    { item_sequence: 'B002', fabric_metres_per_piece: 0, packing_cost_per_piece: 450, finish },
  ])
  await as(null)
  await rpc(`select public.order_submission_fabric_finish_save_sheet($1, $2, $3::jsonb)`, [PI_ORDER, SHA,
    sheetWith([{ heading: 'Metal Finish', value: '', image_path: pictureKey, image_sha256: pictureSha }])])
  await as(U.sales)
  r = (await rpc(`select public.order_submission_fabric_finish_read($1) as r`, [PI_ORDER])).r
  assert.deepEqual(r.lines.find(l => l.item_sequence === 'B002').sheet.finish.map(f => [f.heading, f.value, f.image_path]), [['Metal Finish', '', pictureKey]])
  ok('a picture read from a workbook is stored on the sheet entry and comes back from the read, with or without text')
  await as(null)
  await expectError(() => rpc(`select public.order_submission_fabric_finish_save_sheet($1, $2, $3::jsonb)`, [PI_ORDER, SHA,
    sheetWith([{ heading: 'Metal Finish', value: 'VW-011', image_path: `submissions/other/fabric-finish/B002/${pictureSha}.png`, image_sha256: pictureSha }])]),
    /FABRIC_FINISH_IMAGE_INVALID/, 'a sheet picture outside this PI’s own key is refused')
  await rpc(`select public.order_submission_fabric_finish_save_sheet($1, $2, $3::jsonb)`, [PI_ORDER, SHA, sheetWith([])])
  await expectError(() => rpc(`select public.order_submission_fabric_finish_save_sheet($1, $2, $3::jsonb)`, [PI_ORDER, SHA, JSON.stringify([{ item_sequence: 'B001', fabric_metres_per_piece: -1 }])]),
    /FABRIC_FINISH_VALUE_INVALID/, 'a negative figure from a sheet is refused')
  await expectError(() => rpc(`select public.order_submission_fabric_finish_save_sheet($1, $2, $3::jsonb)`, [PI_ORDER, SHA, JSON.stringify([{ item_sequence: 'B001' }, { item_sequence: 'B001' }])]),
    /FABRIC_FINISH_LINE_DUPLICATED/, 'a line twice is refused')
}

// ── What a person types ──
{
  await as(U.sales)
  let r = (await rpc(`select public.order_submission_fabric_finish_save_typed($1, $2, $3::jsonb) as r`, [PI_ORDER, 'B001', JSON.stringify({
    fabric_price_per_metre: 700, packing_type: 'Carton',
    finish: [{ heading: 'Fabric Approval', value: 'Tony 115', image_path: `submissions/${PI_ORDER}/fabric-finish/B001/${SHA}.jpg`, image_sha256: SHA }],
  })])).r
  assert.equal(r.ok, true); assert.ok(r.typed_at)
  r = (await rpc(`select public.order_submission_fabric_finish_read($1) as r`, [PI_ORDER])).r
  const b1 = r.lines.find(l => l.item_sequence === 'B001')
  assert.equal(Number(b1.typed.fabric_price_per_metre), 700); assert.equal(b1.typed.fabric_metres_per_piece, null)
  assert.equal(b1.typed.packing_type, 'Carton'); assert.equal(b1.typed_by_name, 'Sales')
  assert.equal(b1.typed.finish[0].image_path, `submissions/${PI_ORDER}/fabric-finish/B001/${SHA}.jpg`)
  assert.equal(Number(b1.sheet.fabric_price_per_metre), 650, 'the sheet’s value is still there underneath')
  ok('typed values are kept beside the sheet’s, with who typed them and a picture under its own key')

  await expectError(() => rpc(`select public.order_submission_fabric_finish_save_typed($1, $2, $3::jsonb)`, [PI_ORDER, 'B001', JSON.stringify({
    finish: [{ heading: 'Fabric Approval', value: 'x', image_path: `submissions/${DRAFT}/fabric-finish/B001/${SHA}.jpg`, image_sha256: SHA }] })]),
    /FABRIC_FINISH_IMAGE_INVALID/, 'a picture under another PI’s key is refused')
  await expectError(() => rpc(`select public.order_submission_fabric_finish_save_typed($1, $2, $3::jsonb)`, [PI_ORDER, 'B001', JSON.stringify({
    finish: [{ heading: 'Fabric Approval', value: 'x', image_path: `submissions/${PI_ORDER}/fabric-finish/B001/${SHA}.jpg` }] })]),
    /FABRIC_FINISH_IMAGE_INVALID/, 'a picture without its sha256 is refused')
  await expectError(() => rpc(`select public.order_submission_fabric_finish_save_typed($1, $2, $3::jsonb)`, [PI_ORDER, 'B009', JSON.stringify({ packing_cost_per_piece: 1 })]),
    /FABRIC_FINISH_LINE_NOT_ON_PI/, 'a line that is not on the PI is refused')
  await expectError(() => rpc(`select public.order_submission_fabric_finish_save_typed($1, $2, $3::jsonb)`, [PI_ORDER, 'B001', JSON.stringify({ packing_cost_per_piece: 1.005 })]),
    /FABRIC_FINISH_VALUE_INVALID/, 'a third decimal on rupees is refused')

  // A re-read workbook replaces the sheet’s values and keeps the typed ones; a line it dropped keeps only the typed.
  await as(null)
  await rpc(`select public.order_submission_fabric_finish_save_sheet($1, $2, $3::jsonb)`, [PI_ORDER, SHA, JSON.stringify([
    { item_sequence: 'B002', fabric_metres_per_piece: 1, fabric_price_per_metre: 500, packing_cost_per_piece: 450 },
  ])])
  await as(U.sales)
  r = (await rpc(`select public.order_submission_fabric_finish_read($1) as r`, [PI_ORDER])).r
  const again = r.lines.find(l => l.item_sequence === 'B001')
  assert.equal(again.sheet, null, 'B001 is no longer on the sheet'); assert.equal(Number(again.typed.fabric_price_per_metre), 700)
  assert.equal(Number(r.lines.find(l => l.item_sequence === 'B002').sheet.fabric_price_per_metre), 500)
  ok('a re-read workbook replaces sheet values and keeps typed ones; a dropped line keeps only what was typed')

  // Clearing every typed value on a line the sheet dropped removes the row.
  await rpc(`select public.order_submission_fabric_finish_save_typed($1, $2, $3::jsonb)`, [PI_ORDER, 'B001', JSON.stringify({ finish: [] })])
  r = (await rpc(`select public.order_submission_fabric_finish_read($1) as r`, [PI_ORDER])).r
  assert.equal(r.lines.some(l => l.item_sequence === 'B001'), false)
  ok('nothing typed and nothing from the sheet leaves no row')

  // The unnumbered draft line is keyed by its id.
  await as(U.creator)
  await rpc(`select public.order_submission_fabric_finish_save_typed($1, $2, $3::jsonb)`, [DRAFT, ITEM_NO_SEQ, JSON.stringify({ packing_cost_per_piece: 300 })])
  r = (await rpc(`select public.order_submission_fabric_finish_read($1) as r`, [DRAFT])).r
  assert.equal(Number(r.lines.find(l => l.item_sequence === ITEM_NO_SEQ).typed.packing_cost_per_piece), 300)
  ok('a line without an item number is keyed by its row id, on both sides')
}

// ── Who may not type ──
{
  await as(U.ops)
  await expectError(() => rpc(`select public.order_submission_fabric_finish_save_typed($1, $2, $3::jsonb)`, [PI_ORDER, 'B002', JSON.stringify({ packing_cost_per_piece: 1 })]),
    /FABRIC_FINISH_FORBIDDEN/, 'an Order reader who is not its salesperson, an admin or a manager may not type')
  await as(U.creator)
  await expectError(() => rpc(`select public.order_submission_fabric_finish_save_typed($1, $2, $3::jsonb)`, [PI_REJECTED, 'B001', JSON.stringify({ packing_cost_per_piece: 1 })]),
    /FABRIC_FINISH_FORBIDDEN/, 'a rejected PI takes no typing, even from its creator')
  await as(U.sales)
  await expectError(() => rpc(`select public.order_submission_fabric_finish_save_typed($1, $2, $3::jsonb)`, [PI_CANCELLED, 'B001', JSON.stringify({ packing_cost_per_piece: 1 })]),
    /FABRIC_FINISH_FORBIDDEN/, 'a cancelled Order’s PI takes no typing')
  await as(U.admin)
  const r = (await rpc(`select public.order_submission_fabric_finish_save_typed($1, $2, $3::jsonb) as r`, [PI_ORDER, 'B002', JSON.stringify({ packing_cost_per_piece: 475 })])).r
  assert.equal(r.ok, true)
  ok('an admin types on any live PI')
}

console.log(`all ${checks} checks passed`)
await db.close()
