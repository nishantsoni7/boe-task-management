// Database regression suite for 20270614000000 (Quotations, phase 1) and 20270615000000 (phase 2, Confirm -> PI draft). Runs the REAL migration in an in-memory
// Postgres (PGlite) against small stubs of the platform objects it depends on (users, auth.uid(),
// module_entry_open, resolve_permission, storage), with Supabase's default grants to anon and authenticated
// in place first, so the migration's own revokes are what close the tables. Run:
//   node supabase/tests/quotations_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all N checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node quotations_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const mig = f => readFileSync(`${REPO}/supabase/migrations/${f}`, 'utf8').replace(/\r/g, '')

const U = {
  admin:   '00000000-0000-0000-0000-0000000000a1', // Admin Person (role admin)
  sales:   '00000000-0000-0000-0000-0000000000b2', // Mohit Sharma: view + create
  sales2:  '00000000-0000-0000-0000-0000000000b3', // Prerna Purohit: view + create
  manager: '00000000-0000-0000-0000-0000000000c3', // view + view_all (reads everyone, edits nothing)
  editor:  '00000000-0000-0000-0000-0000000000c4', // view + edit + view_all (pricing desk)
  nobody:  '00000000-0000-0000-0000-0000000000d4', // no grant
}

const db = new PGlite()
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth; create schema storage;
  grant usage on schema public, auth, storage to anon, authenticated;
  -- Supabase's defaults: new objects in public are open to the client roles unless a migration closes them.
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;
  alter default privileges in schema public grant execute on functions to anon, authenticated;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

  create table public.users (id uuid primary key, full_name text, phone text, email text, role text not null default 'employee',
    is_active boolean not null default true, is_deleted boolean default false);
  create table public.grants (user_id uuid, module_key text, action_key text);
  create function public.resolve_permission(p_uid uuid, p_module text, p_action text) returns boolean
    language sql stable as $$ select exists (select 1 from public.grants g where g.user_id = p_uid and g.module_key = p_module and g.action_key = p_action) $$;
  create function public.module_entry_open(p text) returns boolean language sql stable security definer as
    $$ select exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin') or public.resolve_permission(auth.uid(), p, 'view') $$;
  create function public.set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

  create table public.app_modules (module_key text primary key, module_name text, description text, route_path text,
    visibility_type text, allowed_department text, sort_order int);
  create table public.permission_modules (id uuid primary key default gen_random_uuid(), module_key text unique, display_name text, description text);
  create table public.permission_actions (id uuid primary key default gen_random_uuid(), action_key text unique);
  insert into public.permission_actions (action_key) values ('view'), ('create'), ('edit'), ('view_all'), ('delete');
  create table public.module_permission_actions (module_id uuid, action_id uuid, default_allowed boolean, unique (module_id, action_id));
  create table public.role_permissions (role text, module_id uuid, action_id uuid, allowed boolean, unique (role, module_id, action_id));

  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner_id text);
  alter table storage.objects enable row level security;
  grant all on storage.objects to authenticated;

  insert into public.users (id, full_name, role) values
    ('${U.admin}', 'Admin Person', 'admin'), ('${U.sales}', 'Mohit Sharma', 'employee'), ('${U.sales2}', 'Prerna Purohit', 'employee'),
    ('${U.manager}', 'Manager', 'manager'), ('${U.editor}', 'Pricing Desk', 'employee'), ('${U.nobody}', 'No Access', 'employee');
  update public.users set phone = ' +91 90000 00001 ', email = 'mohit@boe.example' where id = '${U.sales}';
  insert into public.grants values
    ('${U.sales}', 'quotations', 'view'), ('${U.sales}', 'quotations', 'create'),
    ('${U.sales2}', 'quotations', 'view'), ('${U.sales2}', 'quotations', 'create'),
    ('${U.manager}', 'quotations', 'view'), ('${U.manager}', 'quotations', 'view_all'),
    ('${U.editor}', 'quotations', 'view'), ('${U.editor}', 'quotations', 'edit'), ('${U.editor}', 'quotations', 'view_all');
`)

// The migrations under test, whole. Phase 2 (20270615000000) only references order_submissions, so a stub of the
// columns it reads stands in for the Orders table; every phase 1 check below runs on the phase 2 schema.
await db.exec(mig('20270614000000_quotations_module.sql'))
await db.exec(`create table public.order_submissions (id uuid primary key default gen_random_uuid(), created_by uuid,
  status text not null default 'draft', draft_reference text, approved_at timestamptz);
  create table public.order_submission_items (id uuid primary key default gen_random_uuid(), submission_id uuid references public.order_submissions(id) on delete cascade,
  product_name text, cost_per_piece numeric(12,2) not null, quantity numeric(12,2) not null default 1,
  dimensions text, material text, customization text);`)
await db.exec(mig('20270615000000_quotation_pi_link.sql'))
await db.exec(mig('20270617000000_quotation_pricing_desk.sql'))
await db.exec(mig('20270618000000_quotation_reports.sql'))
await db.exec(mig('20270620000000_pricing_price_book.sql'))
await db.exec(mig('20270621000000_pricing_model_v2.sql'))
await db.exec(mig('20270623000000_quotation_versions.sql'))
await db.exec(`create table public.tasks (id uuid primary key default gen_random_uuid(), title text, note text, created_by uuid, assigned_to uuid,
  status text not null default 'pending', task_type text not null default 'general', customer_name text, contact_number text, company_name text,
  city_project text, created_at timestamptz not null default now(), last_update_at timestamptz);`)
await db.exec(mig('20270629000000_quotation_links.sql'))

// Rows written the way phase 1 wrote them (a note for the client on the line), BEFORE 20270714000000 runs: the migration
// must copy each note to the end of its Remarks text. The fixture is checked and deleted right after the helpers below.
const FOLD = '00000000-0000-0000-0000-00000000f001'
await db.exec(`insert into public.quotations (id, quote_no, client_name, owner_id, created_by) values ('${FOLD}', 'QT-ZZ-99001', 'Note Copy Test', '${U.sales}', '${U.sales}');
  insert into public.quotation_lines (quotation_id, position, name, spec, qty_fixed, tax_rate, client_note) values
    ('${FOLD}', 0, 'Both', 'Teak, walnut finish', 1, 18, 'Deliver in two lots'),
    ('${FOLD}', 1, 'Note only', null, 1, 18, 'Matching the sample'),
    ('${FOLD}', 2, 'Spec only', 'Plain', 1, 18, null),
    ('${FOLD}', 3, 'Longest', '${'x'.repeat(1000)}', 1, 18, '${'y'.repeat(500)}');`)
await db.exec(mig('20270714000000_quotation_builder_fields.sql'))
await db.exec(mig('20270717000000_quotation_document_fields.sql'))

let checks = 0
const ok = (name) => { checks++; console.log(`  ok - ${name}`) }
async function as(uid, sql, params = [], role = 'authenticated') {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false); set role ${role};`)
  try { return await db.query(sql, params) } finally { await db.exec('reset role;') }
}
const fails = (uid, sql, params, pattern, role) => assert.rejects(() => as(uid, sql, params, role), pattern)
const rpc = async (uid, fn, ...args) => {
  const ph = args.map((_, i) => `$${i + 1}`).join(', ')
  const r = await as(uid, `select public.${fn}(${ph}) as r`, args)
  return r.rows[0].r
}

// ── 20270714000000: the note for the client was copied into Remarks, nothing lost ──
{
  const r = await db.query(`select name, spec, client_note from public.quotation_lines where quotation_id = '${FOLD}' order by position`)
  assert.deepEqual(r.rows.map(x => [x.name, x.spec, x.client_note]), [
    ['Both', 'Teak, walnut finish\nDeliver in two lots', null], ['Note only', 'Matching the sample', null], ['Spec only', 'Plain', null],
    ['Longest', 'x'.repeat(1000) + '\n' + 'y'.repeat(500), null]])
  await db.query(`delete from public.quotations where id = '${FOLD}'`)
  ok('every note for the client was copied to the end of its Remarks text (the longest too) and cleared')
}

// The real Resort Shamshabad quote (Base44 QT-MVTPTT9W): two room types and four of its sixteen lines.
const doc = (over = {}) => ({
  header: { client_name: 'Babylon Resort', project_name: 'Resort, Shamshabad', supply_state: 'Telangana', gst_mode: 'igst',
            discount_pct: 0, fabric_amount: 0, packing_amount: 0, valid_days: 7, notes: 'Prices are ex-factory.',
            internal_notes: 'Wardrobe count to be confirmed on site.' },
  areas: [{ key: 'a', name: 'Corporate room', style: 'Contemporary', multiplier: 18, unit_label: 'rooms' },
          { key: 'b', name: 'Boho room', style: 'Boho', multiplier: 56, unit_label: 'rooms' }],
  lines: [
    { area_key: 'a', name: 'Twin beds with back panel', size_text: "4'x6'6\"x1'6\" x2", qty_per_unit: 1, unit_price: 64000, tax_rate: 18 },
    { area_key: 'b', name: 'Bedside table', size_text: "1'6\"x1'6\"x1'6\"", qty_per_unit: 2, unit_price: 11900, tax_rate: 18 },
    { area_key: 'b', name: 'Wardrobe with luggage rack', qty_fixed: 39, unit_price: 96000, tax_rate: 18, internal_note: '39 of 56 rooms' },
    { area_key: 'b', name: 'Mirror', qty_per_unit: 1, unit_price: 5000, tax_rate: 12, is_optional: true },
  ],
  ...over,
})
// 18×64,000 + 112×11,900 + 39×96,000 = 11,52,000 + 13,32,800 + 37,44,000 (the optional mirror is not counted)
const EXPECTED_VALUE = 1152000 + 1332800 + 3744000

// ── Registration and structure ─────────────────────────────────────────────
{
  const a = await db.query(`select count(*)::int n from public.role_permissions r join public.permission_modules p on p.id = r.module_id where p.module_key = 'quotations' and r.role = 'admin' and r.allowed`)
  assert.equal(a.rows[0].n, 4)
  const b = await db.query(`select public, file_size_limit from storage.buckets where id = 'quotation-images'`)
  assert.equal(b.rows[0].public, true)
  ok('module registered with four Admin rows; picture bucket is public and capped at 3 MB')
}

// ── Access ─────────────────────────────────────────────────────────────────
await fails(U.nobody, `select public.quotation_list('mine')`, [], /QUOTATIONS_FORBIDDEN/)
await fails(null, `select public.quotation_list('mine')`, [], /QUOTATIONS_FORBIDDEN/)
await fails(U.nobody, `select public.quotation_create($1::jsonb)`, [{ client_name: 'X' }], /QUOTATIONS_FORBIDDEN/)
ok('a person without the grant (or signed out) can neither read nor write')

await fails(U.sales, `select count(*) from public.quotations`, [], /permission denied/)
await fails(U.sales, `insert into public.quotation_events (quotation_id, kind) values (gen_random_uuid(), 'opened')`, [], /permission denied/)
await fails(null, `select count(*) from public.quotation_lines`, [], /permission denied/, 'anon')
ok('the tables are closed to signed-in and anonymous clients alike')

assert.deepEqual(await rpc(U.sales, 'quotation_my_access'), { create: true, edit: false, view_all: false, admin: false })
assert.deepEqual(await rpc(U.manager, 'quotation_my_access'), { create: false, edit: false, view_all: true, admin: false })
assert.deepEqual(await rpc(U.admin, 'quotation_my_access'), { create: true, edit: true, view_all: true, admin: true })
ok('my_access reports exactly the grants')

// ── Create and number ──────────────────────────────────────────────────────
const qa = await rpc(U.sales, 'quotation_create', { client_name: '  Babylon Resort ', project_name: 'Resort, Shamshabad', supply_state: 'Telangana' })
const qb = await rpc(U.sales2, 'quotation_create', { client_name: 'Roop Cafe', supply_state: 'Rajasthan' })
const ga = await rpc(U.sales, 'quotation_get', qa)
assert.equal(ga.quotation.quote_no, 'QT-MS-01001')
assert.equal(ga.quotation.client_name, 'Babylon Resort')
assert.equal(ga.quotation.gst_mode, 'igst')
assert.equal(ga.quotation.status, 'draft')
assert.equal(ga.may_edit, true)
const gb = await rpc(U.sales2, 'quotation_get', qb)
assert.equal(gb.quotation.quote_no, 'QT-PP-01002')
assert.equal(gb.quotation.gst_mode, 'cgst_sgst')
ok('numbers are QT-<initials>-<5 digits> from 01001; a Rajasthan client starts on CGST + SGST, others on IGST')

await fails(U.sales, `select public.quotation_create($1::jsonb)`, [{ client_name: '   ' }], /QUOTATION_INVALID/)
await fails(U.manager, `select public.quotation_create($1::jsonb)`, [{ client_name: 'X' }], /QUOTATIONS_FORBIDDEN/)
ok('a blank client is refused; view_all without create cannot start one')

// ── Who sees what ──────────────────────────────────────────────────────────
await fails(U.sales2, `select public.quotation_get($1::uuid)`, [qa], /QUOTATION_NOT_FOUND/)
assert.equal((await rpc(U.sales, 'quotation_list', 'mine')).length, 1)
assert.equal((await rpc(U.sales, 'quotation_list', 'all')).length, 1)
assert.equal((await rpc(U.manager, 'quotation_list', 'all')).length, 2)
assert.equal((await rpc(U.manager, 'quotation_list', 'mine')).length, 0)
ok('a salesperson sees only their own, even when asking for all; view_all sees everyone')

// ── Save ───────────────────────────────────────────────────────────────────
const saved = await rpc(U.sales, 'quotation_save', qa, { ...doc(), expected_updated_at: ga.quotation.updated_at })
assert.equal(Number(saved.value_before_gst), EXPECTED_VALUE)
const g2 = await rpc(U.sales, 'quotation_get', qa)
assert.equal(g2.areas.length, 2)
assert.equal(g2.lines.length, 4)
assert.equal(g2.lines[0].area_id, g2.areas[0].id)
assert.equal(g2.lines[2].area_id, g2.areas[1].id)
assert.equal(g2.quotation.internal_notes, 'Wardrobe count to be confirmed on site.')
const listed = (await rpc(U.sales, 'quotation_list', 'mine'))[0]
assert.equal(Number(listed.value_before_gst), EXPECTED_VALUE)
assert.equal(Number(listed.line_count), 4)
ok('save writes room types and lines in order, linked; the list value is quantity × price without optional lines')

await rpc(U.sales, 'quotation_save', qa, { ...doc({ header: { ...doc().header, discount_pct: 2.5, fabric_amount: 25000, packing_amount: 12000 } }) })
const withExtras = (await rpc(U.sales, 'quotation_list', 'mine'))[0]
assert.equal(Number(withExtras.value_before_gst), EXPECTED_VALUE - Math.round(EXPECTED_VALUE * 2.5 / 100) + 25000 + 12000)
ok('discount, fabric and packing move the value before GST the same way the screen does')

await fails(U.sales, `select public.quotation_save($1::uuid, $2::jsonb)`, [qa, { ...doc(), expected_updated_at: ga.quotation.updated_at }], /QUOTATION_STALE/)
ok('a save based on an older copy is refused as stale')

for (const [bad, why] of [
  [{ lines: [{ area_key: 'a', name: 'Bed', qty_per_unit: 1, unit_price: -5 }] }, 'negative price'],
  [{ lines: [{ area_key: 'a', name: 'Bed', qty_per_unit: 1, qty_fixed: 3, unit_price: 5 }] }, 'two quantities'],
  [{ lines: [{ area_key: 'a', name: 'Bed', unit_price: 5 }] }, 'no quantity'],
  [{ lines: [{ area_key: 'zz', name: 'Bed', qty_per_unit: 1 }] }, 'unknown room type'],
  [{ lines: [{ area_key: 'a', name: 'Bed', qty_per_unit: 1, tax_rate: 7 }] }, 'odd tax rate'],
  [{ lines: [{ area_key: 'a', name: 'Bed', qty_per_unit: 1, image_path: '../../etc/passwd' }] }, 'bad picture path'],
  [{ areas: [{ key: 'a', name: 'Room', multiplier: 0 }] }, 'zero rooms'],
]) {
  await fails(U.sales, `select public.quotation_save($1::uuid, $2::jsonb)`, [qa, doc(bad)], /QUOTATION_INVALID/, undefined)
  void why
}
const still = await rpc(U.sales, 'quotation_get', qa)
assert.equal(still.lines.length, 4)
ok('bad input is refused as QUOTATION_INVALID and leaves the saved quotation untouched')

await fails(U.sales2, `select public.quotation_save($1::uuid, $2::jsonb)`, [qa, doc()], /QUOTATION_NOT_FOUND/)
await fails(U.manager, `select public.quotation_save($1::uuid, $2::jsonb)`, [qa, doc()], /QUOTATIONS_FORBIDDEN/)
assert.equal((await rpc(U.manager, 'quotation_get', qa)).may_edit, false)
await rpc(U.editor, 'quotation_save', qa, doc())
ok('another salesperson cannot touch it; view_all alone reads but cannot save; edit + view_all (pricing desk) can')

// ── Share and the client link ──────────────────────────────────────────────
await fails(U.sales2, `select public.quotation_share($1::uuid, true)`, [qb], /QUOTATION_INVALID: add at least one product/)
const token = await rpc(U.sales, 'quotation_share', qa, true)
assert.match(token, /^[0-9a-f]{32}$/)
assert.equal(await rpc(U.sales, 'quotation_share', qa, true), token)
const afterShare = await rpc(U.sales, 'quotation_get', qa)
assert.equal(afterShare.quotation.status, 'sent')
assert.ok(afterShare.quotation.sent_at)
ok('sharing gives one 32-character link (the same one again), and a draft becomes Sent')

const pub = (await as(null, `select public.quotation_public($1) as r`, [token], 'anon')).rows[0].r
assert.equal(pub.quote_no, 'QT-MS-01001')
assert.equal(pub.lines.length, 4)
assert.equal(pub.areas.length, 2)
assert.equal(pub.salesperson, 'Mohit Sharma')
for (const k of ['internal_notes', 'share_token', 'owner_id', 'created_by', 'contact_phone', 'source']) assert.ok(!(k in pub), `client view must not carry ${k}`)
assert.ok(pub.lines.every(l => !('internal_note' in l)))
assert.equal((await as(null, `select public.quotation_public($1) as r`, ['0'.repeat(32)], 'anon')).rows[0].r, null)
assert.equal((await as(null, `select public.quotation_public($1) as r`, ["' or 1=1 --"], 'anon')).rows[0].r, null)
ok('the client link works without signing in, shows only client-safe fields, and a wrong token shows nothing')

await as(null, `select public.quotation_public($1) as r`, [token], 'anon')
const opened = await db.query(`select count(*)::int n from public.quotation_events where quotation_id = $1 and kind = 'opened'`, [qa])
assert.equal(opened.rows[0].n, 1)
assert.ok((await rpc(U.sales, 'quotation_list', 'mine'))[0].last_opened_at)
ok('an open is recorded once per 30 minutes and shows on the list')

await rpc(U.sales, 'quotation_share', qa, false)
assert.equal((await as(null, `select public.quotation_public($1) as r`, [token], 'anon')).rows[0].r, null)
ok('turning the link off closes it at once')

// ── Status ─────────────────────────────────────────────────────────────────
await fails(U.sales, `select public.quotation_set_status($1::uuid, 'lost', $2)`, [qa, ''], /say why it was lost/)
await fails(U.sales, `select public.quotation_set_status($1::uuid, 'won', null)`, [qa], /QUOTATION_INVALID/)
assert.equal(await rpc(U.sales, 'quotation_set_status', qa, 'confirmed', null), 'confirmed')
await fails(U.sales, `select public.quotation_save($1::uuid, $2::jsonb)`, [qa, doc()], /QUOTATION_LOCKED/)
await fails(U.sales, `select public.quotation_set_status($1::uuid, 'draft', null)`, [qa], /only an administrator can reopen/)
assert.equal(await rpc(U.admin, 'quotation_set_status', qa, 'negotiating', 'Client changed the wardrobe count'), 'negotiating')
await rpc(U.sales, 'quotation_save', qa, doc())
ok('lost needs a reason; a confirmed quotation is locked and only an administrator reopens it')

const hist = (await rpc(U.sales, 'quotation_get', qa)).events.map(e => e.kind)
for (const k of ['created', 'saved', 'shared', 'opened', 'unshared', 'status']) assert.ok(hist.includes(k), `history has ${k}`)
await assert.rejects(() => db.query(`update public.quotation_events set kind = 'saved' where quotation_id = $1`, [qa]), /APPEND_ONLY/)
await assert.rejects(() => db.query(`delete from public.quotation_events where quotation_id = $1`, [qa]), /APPEND_ONLY/)
ok('the history records every step and cannot be edited or deleted, even by the table owner')

// ── Pictures ───────────────────────────────────────────────────────────────
const mine = `${U.sales}/${crypto.randomUUID()}.jpg`
assert.equal(await rpc(U.sales, 'quotation_can_upload', mine), true)
assert.equal(await rpc(U.sales, 'quotation_can_upload', `${U.sales2}/${crypto.randomUUID()}.jpg`), false)
assert.equal(await rpc(U.sales, 'quotation_can_upload', `${U.sales}/x.png`), false)
assert.equal(await rpc(U.manager, 'quotation_can_upload', `${U.manager}/${crypto.randomUUID()}.jpg`), false)
assert.equal(await rpc(U.nobody, 'quotation_can_upload', `${U.nobody}/${crypto.randomUUID()}.jpg`), false)
await as(U.sales, `insert into storage.objects (bucket_id, name, owner_id) values ('quotation-images', $1, $2)`, [mine, U.sales])
await fails(U.sales, `insert into storage.objects (bucket_id, name, owner_id) values ('quotation-images', $1, $2)`, [`${U.sales2}/${crypto.randomUUID()}.jpg`, U.sales], /row-level security/)
ok('pictures go only into the uploader\'s own folder, as .jpg, and only for people who may create or edit')

// ── Grants on functions ────────────────────────────────────────────────────
for (const fn of ['quotation_actor()', 'quotation_initials(uuid)', 'quotation_value_before_gst(uuid)']) {
  const r = await db.query(`select has_function_privilege('authenticated', 'public.${fn}', 'execute') a, has_function_privilege('anon', 'public.${fn}', 'execute') b`)
  assert.equal(r.rows[0].a, false, fn); assert.equal(r.rows[0].b, false, fn)
}
for (const fn of ['quotation_list(text)', 'quotation_save(uuid,jsonb)', 'quotation_create(jsonb)', 'quotation_share(uuid,boolean)']) {
  const r = await db.query(`select has_function_privilege('anon', 'public.${fn}', 'execute') b`)
  assert.equal(r.rows[0].b, false, fn)
}
const pubGrant = await db.query(`select has_function_privilege('anon', 'public.quotation_public(text)', 'execute') b`)
assert.equal(pubGrant.rows[0].b, true)
ok('internal helpers are closed to clients; only quotation_public is open to anon')

// ── Phase 2: Confirm → PI draft (20270615000000) ───────────────────────────
const draft = async (by, status = 'draft') => (await db.query(
  `insert into public.order_submissions (created_by, status, draft_reference) values ($1, $2, 'PID-' || lpad((floor(random() * 99999))::int::text, 5, '0')) returning id, draft_reference`,
  [by, status])).rows[0]
const link = (uid, q, s) => as(uid, `select public.quotation_link_pi($1::uuid, $2::uuid) as r`, [q, s])
const linkFails = (uid, q, s, pattern) => assert.rejects(() => link(uid, q, s), pattern)

const salesDraft = await draft(U.sales)
const otherDraft = await draft(U.sales2)
await linkFails(U.sales, qa, otherDraft.id, /QUOTATION_INVALID: that PI draft is not yours/)
await linkFails(U.sales, qa, crypto.randomUUID(), /QUOTATION_INVALID: that PI draft is not yours/)
await linkFails(U.manager, qa, salesDraft.id, /QUOTATIONS_FORBIDDEN/)
await linkFails(U.sales2, qa, otherDraft.id, /QUOTATION_NOT_FOUND/)
await linkFails(U.sales2, qb, otherDraft.id, /only a Sent or Negotiating quotation/)
await linkFails(U.sales, qa, (await draft(U.sales, 'submitted')).id, /no longer a draft/)
await linkFails(null, qa, salesDraft.id, /QUOTATIONS_FORBIDDEN/)
ok('a link is refused for somebody else\'s PI draft, a PI that is no longer a draft, a Draft quotation, or a person who may not edit it')

const linked = (await link(U.sales, qa, salesDraft.id)).rows[0].r
assert.deepEqual(linked, { status: 'confirmed', pi_submission_id: salesDraft.id, draft_reference: salesDraft.draft_reference })
const gl = await rpc(U.sales, 'quotation_get', qa)
assert.equal(gl.quotation.status, 'confirmed')
assert.equal(gl.quotation.pi_submission_id, salesDraft.id)
assert.deepEqual(gl.pi, { id: salesDraft.id, draft_reference: salesDraft.draft_reference, status: 'draft' })
assert.equal(gl.events[0].kind, 'converted')
assert.equal(gl.events[0].detail.from, 'negotiating')
assert.deepEqual((await link(U.sales, qa, salesDraft.id)).rows[0].r, linked)
await linkFails(U.sales, qa, (await draft(U.sales)).id, /already linked to a PI/)
await fails(U.sales, `select public.quotation_save($1::uuid, $2::jsonb)`, [qa, doc()], /QUOTATION_LOCKED/)
assert.equal((await rpc(U.manager, 'quotation_get', qa)).pi.draft_reference, salesDraft.draft_reference)
ok('confirming links the quotation to its PI draft, marks it Confirmed and records it; asking again returns the same; it is then locked')

const qc = await rpc(U.sales, 'quotation_create', { client_name: 'Another Hotel' })
await rpc(U.sales, 'quotation_save', qc, doc())
await rpc(U.sales, 'quotation_share', qc, true)
await linkFails(U.sales, qc, salesDraft.id, /already belongs to another quotation/)
ok('one PI draft belongs to one quotation')

await db.query(`delete from public.order_submissions where id = $1`, [salesDraft.id])
const gone = await rpc(U.sales, 'quotation_get', qa)
assert.equal(gone.quotation.pi_submission_id, null)
assert.equal(gone.pi, null)
assert.equal(gone.quotation.status, 'confirmed')
ok('a PI draft that is deleted clears the link; the quotation stays Confirmed for an administrator to reopen')

const linkGrant = await db.query(`select has_function_privilege('anon', 'public.quotation_link_pi(uuid,uuid)', 'execute') b, has_function_privilege('authenticated', 'public.quotation_link_pi(uuid,uuid)', 'execute') a`)
assert.equal(linkGrant.rows[0].b, false)
assert.equal(linkGrant.rows[0].a, true)
const tokC = await rpc(U.sales, 'quotation_share', qc, true)
const pubC = (await as(null, `select public.quotation_public($1) as r`, [tokC], 'anon')).rows[0].r
for (const k of ['pi_submission_id', 'pi_linked_at', 'pi']) assert.ok(!(k in pubC), `client view must not carry ${k}`)
ok('the link function is closed to anon, and the client link never shows the PI')

// ── Phase 5: the pricing desk (20270617000000) ─────────────────────────────
const approvedPi = async (daysAgo, items, status = 'approved') => {
  const sub = (await db.query(`insert into public.order_submissions (created_by, status, draft_reference, approved_at) values ($1, $2, 'PID-T', $3) returning id`,
    [U.sales2, status, status === 'approved' ? new Date(Date.now() - daysAgo * 86400000).toISOString() : null])).rows[0].id
  for (const [name, price] of items) await db.query(`insert into public.order_submission_items (submission_id, product_name, cost_per_piece) values ($1, $2, $3)`, [sub, name, price])
}
await approvedPi(10, [['Boho room · King bed', 56000], ['Bedside table', 9000]])
await approvedPi(5, [['King bed with storage', 60000]])
await approvedPi(1, [['King bed', 1000]], 'draft')
await approvedPi(2000, [['King bed', 99999]])
const hints = await rpc(U.sales, 'quotation_price_hints', ['King bed', 'Teapoy'], null)
const kb = hints.find(h => h.name === 'King bed')
assert.deepEqual([Number(kb.ordered.last), Number(kb.ordered.min), Number(kb.ordered.max), kb.ordered.count], [60000, 56000, 60000, 2])
assert.equal(hints.find(h => h.name === 'Teapoy').ordered, null)
await fails(U.nobody, `select public.quotation_price_hints($1::text[], null)`, [['King bed']], /QUOTATIONS_FORBIDDEN/)
ok('price hints: approved PIs of the last three years with a similar name (drafts and old PIs left out), prices only')

const qp = await rpc(U.sales, 'quotation_create', { client_name: 'Pricing Hotel' })
const priced = (price, discount = 0) => ({ header: { ...doc().header, client_name: 'Pricing Hotel', discount_pct: discount }, areas: [],
  lines: [{ area_key: null, name: 'King bed', qty_fixed: 10, unit_price: price, tax_rate: 18 }] })
await rpc(U.sales, 'quotation_save', qp, priced(50000))
let g = await rpc(U.sales, 'quotation_get', qp)
assert.equal(g.price.state, 'to_ask'); assert.equal(g.price.blocked, true)
assert.deepEqual(g.price.reasons.map(r => [r.kind, Number(r.last), Number(r.limit)]), [['below', 60000, 90]])
await fails(U.sales, `select public.quotation_share($1::uuid, true)`, [qp], /approval before the client link/)
ok('a price under 90% of the last ordered price needs approval, and the client link stays off until then')

await fails(U.sales, `select public.quotation_price_queue()`, [], /only the pricing desk/)
assert.equal((await rpc(U.sales, 'quotation_price_request', qp)).state, 'requested')
const queue = await rpc(U.editor, 'quotation_price_queue')
assert.deepEqual(queue.map(x => x.quote_no), [g.quotation.quote_no])
await fails(U.sales, `select public.quotation_price_decide($1::uuid, true, null)`, [qp], /only the pricing desk approves/)
await fails(U.editor, `select public.quotation_price_decide($1::uuid, false, $2)`, [qp, ''], /say what to change/)
const back = await rpc(U.editor, 'quotation_price_decide', qp, false, 'Hold at 55,000 at least')
assert.deepEqual([back.state, back.blocked, back.note, back.by], ['returned', true, 'Hold at 55,000 at least', 'Pricing Desk'])
assert.equal((await rpc(U.editor, 'quotation_price_queue')).length, 0)
ok('the salesperson asks; the desk sees it in its list and sends it back with a note; only the desk decides')

await rpc(U.sales, 'quotation_save', qp, priced(55000))
assert.equal((await rpc(U.sales, 'quotation_get', qp)).price.state, 'not_needed')
await rpc(U.sales, 'quotation_save', qp, priced(55000, 10))
g = await rpc(U.sales, 'quotation_get', qp)
assert.deepEqual([g.price.state, g.price.reasons[0].kind], ['to_ask', 'discount'])
await rpc(U.sales, 'quotation_price_request', qp)
assert.equal((await rpc(U.admin, 'quotation_price_decide', qp, true, null)).state, 'approved')
assert.match(await rpc(U.sales, 'quotation_share', qp, true), /^[0-9a-f]{32}$/)
ok('changing the prices asks again; a discount above 5% needs approval; once approved the link turns on')

await rpc(U.sales, 'quotation_save', qp, priced(55000, 12))
assert.equal((await rpc(U.sales, 'quotation_get', qp)).price.state, 'to_ask')
await rpc(U.sales, 'quotation_set_status', qp, 'negotiating', null)
const pd = await draft(U.sales)
await linkFails(U.sales, qp, pd.id, /approval before a PI is made/)
ok('an approval belongs to the prices it was given for: a new discount needs asking again, and Confirm -> PI waits')

await fails(U.sales, `select public.quotation_price_settings_set(10, 80)`, [], /only an administrator/)
await fails(U.admin, `select public.quotation_price_settings_set(5, 0)`, [], /QUOTATION_INVALID/)
const off = await rpc(U.admin, 'quotation_price_settings_set', null, null)
assert.deepEqual([off.max_discount_pct, off.min_price_pct], [null, null])
assert.equal((await rpc(U.sales, 'quotation_get', qp)).price.state, 'not_needed')
assert.equal((await rpc(U.sales, 'quotation_get', qp)).price.blocked, false)
await rpc(U.admin, 'quotation_price_settings_set', 5, 90)
ok('only an administrator sets the limits; empty limits switch approval off')

await assert.rejects(() => db.query(`delete from public.quotation_price_reviews`), /APPEND_ONLY/)
await fails(U.sales, `select count(*) from public.quotation_price_reviews`, [], /permission denied/)
for (const fn of ['quotation_price_history(text[],uuid)', 'quotation_price_check(uuid)', 'quotation_price_state(uuid)', 'quotation_price_fingerprint(uuid)']) {
  const r = await db.query(`select has_function_privilege('authenticated', 'public.${fn}', 'execute') a`)
  assert.equal(r.rows[0].a, false, fn)
}
ok('the review log cannot be changed; the pricing tables and internal functions are closed to clients')

// ── Phase 6: reports (20270618000000) ──────────────────────────────────────
const today = (await db.query(`select (now() at time zone 'Asia/Kolkata')::date::text d`)).rows[0].d
const report = (uid, scope) => rpc(uid, 'quotation_report', today, today, scope)
await fails(U.nobody, `select public.quotation_report($1::date, $1::date, 'all')`, [today], /QUOTATIONS_FORBIDDEN/)
await fails(U.sales, `select public.quotation_report($1::date, ($1::date - 1), 'mine')`, [today], /up to two years/)
const countWhere = async (where, params = []) => Number((await db.query(`select count(*)::int n from public.quotations q where ${where}`, params)).rows[0].n)
const mineAsked = await report(U.sales, 'all')
assert.equal(mineAsked.scope, 'mine')
assert.equal(mineAsked.funnel.made.n, await countWhere('q.owner_id = $1 or q.created_by = $1', [U.sales]))
const team = await report(U.manager, 'all')
assert.equal(team.scope, 'all')
assert.equal(team.funnel.made.n, await countWhere('true'))
assert.equal(team.funnel.confirmed.n, await countWhere(`q.status = 'confirmed'`))
ok('a salesperson always gets their own numbers; a manager gets the whole team; the funnel matches the quotations')

await rpc(U.sales2, 'quotation_set_status', qb, 'lost', 'Price too high')
const afterLoss = await report(U.manager, 'all')
assert.ok(afterLoss.lost_reasons.some(r => r.reason === 'Price too high' && r.n === 1))
assert.equal(afterLoss.funnel.lost.n, await countWhere(`q.status = 'lost'`))
const decided = afterLoss.discount.reduce((t, b) => t + b.decided, 0)
assert.equal(decided, await countWhere(`q.status in ('confirmed', 'lost')`))
assert.equal(afterLoss.ageing.reduce((t, b) => t + b.n, 0), await countWhere(`q.status in ('draft', 'sent', 'negotiating')`))
ok('lost reasons, the discount buckets and open-by-age add up to the quotations they come from')

const old = (await db.query(`insert into public.quotations (quote_no, status, client_name, owner_id, created_by, sent_at, created_at, share_token)
  values ('QT-MS-09999', 'sent', 'Quiet Client', $1, $1, now() - interval '6 days', now() - interval '7 days', $2) returning id`, [U.sales, 'a'.repeat(32)])).rows[0].id
await db.query(`insert into public.quotation_events (quotation_id, actor_id, kind, at) values ($1, $2, 'shared', now() - interval '6 days'), ($1, null, 'opened', now() - interval '3 days')`, [old, U.sales])
const quiet = await report(U.sales, 'mine')
assert.deepEqual(quiet.opened_no_followup.map(x => x.quote_no), ['QT-MS-09999'])
await rpc(U.sales, 'quotation_set_status', old, 'negotiating', null)
assert.equal((await report(U.sales, 'mine')).opened_no_followup.length, 0)
ok('a quotation the client opened over two days ago with nothing done since is listed, and leaves the list once followed up')

// ── Phase 7A: the price book (20270620000000) ──────────────────────────────
const hints7 = await rpc(U.sales, 'quotation_price_hints', ['King bed'], null)
const kinds = hints7[0].points.map(x => x.k)
assert.ok(kinds.includes('order'), 'approved PI prices are points')
assert.ok(hints7[0].points.every(x => Number(x.p) > 0 && x.at), 'every point has a price and a date')
assert.ok(!hints7[0].points.some(x => Number(x.p) === 1000 || Number(x.p) === 99999), 'draft PIs and PIs older than three years are not points')
assert.ok(hints7[0].points.length <= 30)
ok('price hints now carry the points the suggestion learns from: approved PIs and quotations, newest first')

await fails(U.sales, `select public.pricing_price_book(null, 50)`, [], /PRICING_FORBIDDEN/)
await fails(null, `select public.pricing_price_book(null, 50)`, [], /PRICING_FORBIDDEN/)
await db.query(`insert into public.grants values ($1, 'pricing', 'view')`, [U.manager])
const book = await rpc(U.manager, 'pricing_price_book', null, 50)
const kingBed = book.find(f => f.key === 'bed king')
assert.ok(kingBed, 'King bed is a family')
assert.equal(kingBed.orders, 1) // "King bed with storage" is a family of its own (exact words); the draft and the old PI are not counted
assert.ok(book.find(f => f.key === 'bed king storage'))
assert.ok(book.every((f, i) => i === 0 || f.last_at <= book[i - 1].last_at), 'newest activity first')
const searched = await rpc(U.admin, 'pricing_price_book', 'king', 50)
assert.ok(searched.length > 0 && searched.every(f => f.key.split(' ').includes('king')))
ok('the price book opens for Admin and people granted Pricing only, one row per product family, searchable')

for (const fn of ['pricing_all_points(uuid)', 'pricing_points_for(text[],uuid)']) {
  const r = await db.query(`select has_function_privilege('authenticated', 'public.${fn}', 'execute') a`)
  assert.equal(r.rows[0].a, false, fn)
}
ok('the point functions are internal; nothing in the price book names a client')

// ── Pricing model v2: the price pool (20270621000000) ───────────────────────
await fails(U.nobody, `select public.pricing_pool($1::text[], null)`, [['bed']], /PRICING_FORBIDDEN/)
await fails(null, `select public.pricing_pool($1::text[], null)`, [['bed']], /PRICING_FORBIDDEN/)
await fails(U.sales, `select public.pricing_pool($1::text[], null)`, [[]], /PRICING_INVALID/)
const pool = await rpc(U.sales, 'pricing_pool', ['bed', 'cot'], null)
assert.ok(pool.length > 0)
assert.ok(pool.some(x => x.k === 'order' && x.name === 'King bed with storage' && 'dims' in x && 'material' in x), 'approved PI lines come with their parameters')
assert.ok(pool.every(x => !('client_name' in x) && !('quote_no' in x)), 'no client names or numbers')
assert.ok(!pool.some(x => Number(x.p) === 1000 || Number(x.p) === 99999), 'drafts and PIs older than three years are left out')
assert.ok(pool.every((x, i) => i === 0 || x.at <= pool[i - 1].at), 'newest first')
const qline = pool.find(x => x.k !== 'order')
assert.ok(qline && 'client_type' in qline, 'quotation lines carry the client type')
assert.ok((await rpc(U.manager, 'pricing_pool', ['bed'], null)).length > 0, 'a person with Pricing (and no Quotations edit) may read it')
ok('the price pool gives every price of a product type with its parameters, to people who may open Quotations or Pricing, never client names')

// ── Quotation versions (20270623000000) ────────────────────────────────────
const qv = await rpc(U.sales, 'quotation_create', { client_name: 'Version Hotel' })
const vdoc = (price, discount = 0) => ({ header: { ...doc().header, client_name: 'Version Hotel', discount_pct: discount, internal_notes: 'secret margin note' },
  areas: [{ key: 'a', name: 'Deluxe room', style: '', multiplier: 10, unit_label: 'rooms' }],
  lines: [{ area_key: 'a', name: 'Queen bed', qty_per_unit: 1, unit_price: price, tax_rate: 18, internal_note: 'cost 30k' }] })
await rpc(U.sales, 'quotation_save', qv, vdoc(70000))
await fails(U.sales, `select public.quotation_version_create($1::uuid, 'early')`, [qv], /turn the client link on first/)
const tokV = await rpc(U.sales, 'quotation_share', qv, true)
let vs = await rpc(U.sales, 'quotation_versions', qv)
assert.deepEqual(vs.map(v => [v.version_no, v.note, Number(v.value_before_gst)]), [[1, 'First sent', 700000]])
ok('turning the client link on freezes v1, with its value')

await rpc(U.sales, 'quotation_save', qv, vdoc(65000, 5))
let pubV = (await as(null, `select public.quotation_public($1) as r`, [tokV], 'anon')).rows[0].r
assert.equal(pubV.version_no, 1)
assert.equal(Number(pubV.lines[0].unit_price), 70000, 'the client still sees v1 while the salesperson edits')
assert.equal(Number(pubV.discount_pct), 0)
for (const k of ['internal_notes', 'share_token', 'owner_id']) assert.ok(!(k in pubV), `client view must not carry ${k}`)
assert.ok(!('internal_note' in pubV.lines[0]))
ok('the client link shows the latest SENT version, never a half-finished edit or an internal note')

assert.equal(await rpc(U.sales, 'quotation_version_create', qv, 'Client asked for 5% off'), 2)
pubV = (await as(null, `select public.quotation_public($1) as r`, [tokV], 'anon')).rows[0].r
assert.deepEqual([pubV.version_no, Number(pubV.lines[0].unit_price), Number(pubV.discount_pct)], [2, 65000, 5])
await fails(U.sales, `select public.quotation_version_create($1::uuid, 'again')`, [qv], /nothing has changed since v2/)
vs = await rpc(U.sales, 'quotation_versions', qv)
assert.deepEqual(vs.map(v => v.version_no), [2, 1])
const v1 = await rpc(U.sales, 'quotation_version_get', qv, 1)
const now0 = await rpc(U.sales, 'quotation_version_get', qv, 0)
assert.equal(Number(v1.lines[0].unit_price), 70000)
assert.equal(Number(now0.lines[0].unit_price), 65000)
assert.equal((await rpc(U.sales, 'quotation_get', qv)).events[0].kind, 'version')
ok('sending a new version moves the link to it; nothing-changed is refused; every version can be read back and compared')

await fails(U.sales2, `select public.quotation_version_create($1::uuid, null)`, [qv], /QUOTATION_NOT_FOUND/)
await fails(U.manager, `select public.quotation_version_create($1::uuid, null)`, [qv], /QUOTATIONS_FORBIDDEN/)
assert.equal((await rpc(U.manager, 'quotation_versions', qv)).length, 2, 'see-all reads the versions')
await rpc(U.sales, 'quotation_save', qv, vdoc(65000, 10)) // a 10% discount needs the desk (limit 5%)
await fails(U.sales, `select public.quotation_version_create($1::uuid, null)`, [qv], /approval before they are sent/)
await assert.rejects(() => db.query(`update public.quotation_versions set note = 'x' where quotation_id = $1`, [qv]), /APPEND_ONLY/)
await assert.rejects(() => db.query(`delete from public.quotation_versions where quotation_id = $1`, [qv]), /APPEND_ONLY/)
await fails(U.sales, `select count(*) from public.quotation_versions`, [], /permission denied/)
ok('only the people who may edit send versions; prices waiting for the desk cannot be sent; versions cannot be changed or deleted')

// ── Links back (20270629000000) ─────────────────────────────────────────────
const task = async (over = {}) => (await db.query(
  `insert into public.tasks (title, note, created_by, assigned_to, status, task_type, customer_name, contact_number, company_name, city_project)
   values ($1, $2, $3, $4, $5, 'quotation_request', 'Ravi Kumar', '+91 90000 00009', $6, 'Goa resort, phase 2') returning id`,
  [over.title ?? 'Quote for 40 rooms', over.note ?? 'Beds, side tables, wardrobes. Teak.', U.sales, over.assigned ?? U.editor, over.status ?? 'in_progress', over.company ?? 'Sea Breeze Hotels'])).rows[0].id
const r1 = await task()
await fails(U.sales, `select public.quotation_create_from_request($1::uuid)`, [r1], /only the person the request is assigned to/)
await fails(U.manager, `select public.quotation_create_from_request($1::uuid)`, [r1], /QUOTATIONS_FORBIDDEN/)
const fromReq = await rpc(U.editor, 'quotation_create_from_request', r1)
assert.equal(await rpc(U.editor, 'quotation_create_from_request', r1), fromReq, 'asking again opens the same quotation')
const gr = await rpc(U.sales, 'quotation_get', fromReq)
assert.match(gr.quotation.quote_no, /^QT-MS-\d{5}$/)
assert.deepEqual([gr.quotation.client_name, gr.quotation.contact_name, gr.quotation.contact_phone, gr.quotation.project_name, gr.quotation.owner_id, gr.quotation.created_by],
  ['Sea Breeze Hotels', 'Ravi Kumar', '+91 90000 00009', 'Goa resort, phase 2', U.sales, U.editor])
assert.match(gr.quotation.internal_notes, /From the quotation request: Quote for 40 rooms\nBeds, side tables, wardrobes\. Teak\./)
assert.equal(gr.request.id, r1)
assert.equal(gr.request.asked_by, 'Mohit Sharma')
assert.equal(gr.request.may_send, false, 'the salesperson does not send it to themselves')
assert.equal((await rpc(U.editor, 'quotation_get', fromReq)).request.may_send, true)
assert.ok((await rpc(U.sales, 'quotation_list', 'mine')).some(x => x.id === fromReq), 'it is in the salesperson\'s own list')
const done = await task({ status: 'completed' })
await fails(U.editor, `select public.quotation_create_from_request($1::uuid)`, [done], /already completed/)
await fails(U.editor, `select public.quotation_create_from_request($1::uuid)`, [crypto.randomUUID()], /does not exist/)
ok('a quotation request becomes a quotation owned by the salesperson who asked, made by the person it is assigned to, linked both ways')

const piDraft = await draft(U.sales)
await db.query(`update public.quotations set pi_submission_id = $1 where id = $2`, [piDraft.id, fromReq])
const mark = await rpc(U.sales, 'quotation_for_pi', piDraft.id)
assert.deepEqual([mark.id, mark.quote_no, mark.version_no], [fromReq, gr.quotation.quote_no, null])
assert.equal(await rpc(U.sales2, 'quotation_for_pi', piDraft.id), null, 'not to someone who may not see the quotation')
assert.equal((await as(U.nobody, `select public.quotation_for_pi($1::uuid) as r`, [piDraft.id])).rows[0].r, null)
assert.equal(await rpc(U.sales, 'quotation_for_pi', crypto.randomUUID()), null)
ok('a PI draft tells only the people who may see its quotation where it came from')

const rev = await rpc(U.manager, 'quotation_report_revisions', today, today, 'all')
assert.equal(Number(rev.confirmed), await countWhere(`q.status = 'confirmed'`))
assert.equal(rev.buckets.reduce((t, b) => t + Number(b.n), 0), Number(rev.confirmed))
await fails(U.nobody, `select public.quotation_report_revisions($1::date, $1::date, 'all')`, [today], /QUOTATIONS_FORBIDDEN/)
ok('revisions to win counts the versions of every confirmed quotation in the period')

// ── 20270714000000: client email, company name, GSTIN and the dimensions unit ──
{
  const id = await rpc(U.sales, 'quotation_create', { client_name: 'Fields Hotel' })
  const g0 = await rpc(U.sales, 'quotation_get', id)
  assert.deepEqual([g0.quotation.dimension_unit, g0.quotation.client_email, g0.quotation.company_name, g0.quotation.client_gstin], ['in', null, null, null])
  const line = { name: 'Zebra stool', size_text: '83 x 68', qty_fixed: 1, unit_price: 40000, tax_rate: 18 }
  const header = { client_name: 'Fields Hotel', valid_days: 7, gst_mode: 'igst', supply_state: 'Telangana' }
  await rpc(U.sales, 'quotation_save', id, { expected_updated_at: g0.quotation.updated_at, header: { ...header, client_email: '  buyer@fields.example ', company_name: 'Fields Hospitality Pvt Ltd', client_gstin: '36aaaaa0000a1z5', dimension_unit: 'cm' }, areas: [], lines: [line] })
  const g1 = await rpc(U.sales, 'quotation_get', id)
  assert.deepEqual([g1.quotation.client_email, g1.quotation.company_name, g1.quotation.client_gstin, g1.quotation.dimension_unit],
    ['buyer@fields.example', 'Fields Hospitality Pvt Ltd', '36AAAAA0000A1Z5', 'cm'])
  ok('save stores the email, company name, GSTIN (upper case) and the unit, and quotation_get returns them')

  // A browser tab opened before the migration sends none of the four: what is stored must stay.
  await rpc(U.sales, 'quotation_save', id, { header, areas: [], lines: [line] })
  const g2 = await rpc(U.sales, 'quotation_get', id)
  assert.deepEqual([g2.quotation.client_email, g2.quotation.company_name, g2.quotation.client_gstin, g2.quotation.dimension_unit],
    ['buyer@fields.example', 'Fields Hospitality Pvt Ltd', '36AAAAA0000A1Z5', 'cm'])
  await rpc(U.sales, 'quotation_save', id, { header: { ...header, client_email: '', company_name: '' }, areas: [], lines: [line] })
  assert.equal((await rpc(U.sales, 'quotation_get', id)).quotation.client_email, null, 'an empty box clears the field')
  ok('a save that does not send the new fields keeps them; an empty box clears one')

  await fails(U.sales, `select public.quotation_save($1::uuid, $2::jsonb)`, [id, { header: { ...header, dimension_unit: 'm' }, areas: [], lines: [line] }], /QUOTATION_INVALID/)
  await fails(U.sales, `select public.quotation_save($1::uuid, $2::jsonb)`, [id, { header: { ...header, client_gstin: 'G'.repeat(21) }, areas: [], lines: [line] }], /QUOTATION_INVALID/)
  await rpc(U.sales, 'quotation_save', id, { header, areas: [], lines: [{ ...line, spec: 's'.repeat(1600) }] })
  await fails(U.sales, `select public.quotation_save($1::uuid, $2::jsonb)`, [id, { header, areas: [], lines: [{ ...line, spec: 's'.repeat(1601) }] }], /QUOTATION_INVALID/)
  ok('the unit is inches or centimetres only; Remarks may be 1,600 characters, not 1,601')

  await rpc(U.sales, 'quotation_save', id, { header: { ...header, company_name: 'Fields Hospitality Pvt Ltd' }, areas: [], lines: [line] })
  const tok = await rpc(U.sales, 'quotation_share', id, true)
  const p = (await as(null, `select public.quotation_public($1) as r`, [tok], 'anon')).rows[0].r
  assert.deepEqual([p.company_name, p.client_gstin, p.dimension_unit], ['Fields Hospitality Pvt Ltd', '36AAAAA0000A1Z5', 'cm'])
  for (const k of ['client_email', 'contact_phone', 'internal_notes']) assert.ok(!(k in p), `client view must not carry ${k}`)
  ok('the client link shows company name, GSTIN and the unit, never the email or the phone')

  // An inches quotation without a company freezes the same copy as before the migration: no new keys, so a missing unit reads as inches.
  const id2 = await rpc(U.sales, 'quotation_create', { client_name: 'Plain Hotel' })
  await rpc(U.sales, 'quotation_save', id2, { header: { client_name: 'Plain Hotel', valid_days: 7, gst_mode: 'igst' }, areas: [], lines: [line] })
  const tok2 = await rpc(U.sales, 'quotation_share', id2, true)
  const p2 = (await as(null, `select public.quotation_public($1) as r`, [tok2], 'anon')).rows[0].r
  for (const k of ['company_name', 'client_gstin', 'dimension_unit']) assert.ok(!(k in p2), `${k} is left out when it is not set`)
  await fails(U.sales, `select public.quotation_version_create($1::uuid, null)`, [id2], /nothing has changed/)
  await rpc(U.sales, 'quotation_save', id2, { header: { client_name: 'Plain Hotel', valid_days: 7, gst_mode: 'igst', dimension_unit: 'cm' }, areas: [], lines: [line] })
  assert.equal(await rpc(U.sales, 'quotation_version_create', id2, null), 2, 'switching the unit is a change that can be sent')
  ok('an inches quotation without a company sends the same copy as before; switching the unit counts as a change')
}

// ── 20270717000000: project type, seats, lead time, and the salesperson's contact on the client's document ──
{
  const id = await rpc(U.sales, 'quotation_create', { client_name: 'Document Hotel' })
  const g0 = await rpc(U.sales, 'quotation_get', id)
  assert.deepEqual([g0.quotation.project_type, g0.quotation.seats, g0.quotation.lead_time_weeks, g0.quotation.lead_time_reason], [null, null, null, null])
  assert.equal(g0.owner_phone, '+91 90000 00001', 'the print page gets the salesperson mobile (trimmed)')
  assert.equal(g0.owner_email, 'mohit@boe.example')
  const line = { name: 'Zebra stool', size_text: '83 x 68', qty_fixed: 10, unit_price: 40000, tax_rate: 18 }
  const header = { client_name: 'Document Hotel', valid_days: 7, gst_mode: 'igst', supply_state: 'Goa' }
  await rpc(U.sales, 'quotation_save', id, { expected_updated_at: g0.quotation.updated_at, header: { ...header, project_type: 'resort', seats: '', lead_time_weeks: 14, lead_time_reason: ' Client needs it before the season ' }, areas: [], lines: [line] })
  const g1 = await rpc(U.sales, 'quotation_get', id)
  assert.deepEqual([g1.quotation.project_type, g1.quotation.seats, g1.quotation.lead_time_weeks, g1.quotation.lead_time_reason], ['resort', null, 14, 'Client needs it before the season'])
  ok('save stores the project type, the lead time and its reason, and quotation_get returns them')

  // A tab opened before the migration sends none of the four: what is stored must stay. An empty value clears one.
  await rpc(U.sales, 'quotation_save', id, { header, areas: [], lines: [line] })
  const g2 = await rpc(U.sales, 'quotation_get', id)
  assert.deepEqual([g2.quotation.project_type, g2.quotation.lead_time_weeks, g2.quotation.lead_time_reason], ['resort', 14, 'Client needs it before the season'])
  await rpc(U.sales, 'quotation_save', id, { header: { ...header, project_type: 'restaurant', seats: 220, lead_time_weeks: 10, lead_time_reason: '' }, areas: [], lines: [line] })
  const g3 = await rpc(U.sales, 'quotation_get', id)
  assert.deepEqual([g3.quotation.project_type, g3.quotation.seats, g3.quotation.lead_time_weeks, g3.quotation.lead_time_reason], ['restaurant', 220, 10, null])
  ok('a save that sends no new keys keeps them; an empty reason clears the override')

  for (const bad of [{ project_type: 'castle' }, { seats: 0 }, { seats: 100001 }, { lead_time_weeks: 0 }, { lead_time_weeks: 105 }, { lead_time_weeks: '', lead_time_reason: 'no weeks' }]) {
    await fails(U.sales, `select public.quotation_save($1::uuid, $2::jsonb)`, [id, { header: { ...header, ...bad }, areas: [], lines: [line] }], /QUOTATION_INVALID/)
  }
  ok('an unknown project type, seats outside 1 to 100,000, weeks outside 1 to 104 and a reason without weeks are refused')

  // The client's copy: the latest SENT version freezes project type, seats and weeks; the reason and live edits stay out.
  const tok = await rpc(U.sales, 'quotation_share', id, true)
  const pub = async t => (await as(null, `select public.quotation_public($1) as r`, [t], 'anon')).rows[0].r
  const p1 = await pub(tok)
  assert.deepEqual([p1.project_type, p1.seats, p1.lead_time_weeks], ['restaurant', 220, 10])
  assert.ok(!('lead_time_reason' in p1), 'the reason is internal')
  assert.deepEqual([p1.salesperson, p1.salesperson_phone, p1.salesperson_email], ['Mohit Sharma', '+91 90000 00001', 'mohit@boe.example'])
  for (const k of ['client_email', 'contact_phone', 'internal_notes', 'owner_id', 'owner_phone', 'owner_email', 'share_token']) assert.ok(!(k in p1), `client view must not carry ${k}`)
  await rpc(U.sales, 'quotation_save', id, { header: { ...header, project_type: 'restaurant', seats: 220, lead_time_weeks: 12, lead_time_reason: 'Rush order' }, areas: [], lines: [line] })
  assert.equal((await pub(tok)).lead_time_weeks, 10, 'a saved but unsent change does not reach the client')
  assert.equal(await rpc(U.sales, 'quotation_version_create', id, null), 2, 'a changed lead time is a change that can be sent')
  assert.equal((await pub(tok)).lead_time_weeks, 12)
  ok('the client link shows project type, seats and lead time from the latest sent version, never the reason, and the salesperson contact')

  // A salesperson with no phone or e-mail: the keys are simply absent, nothing prints "null".
  const id2 = await rpc(U.sales2, 'quotation_create', { client_name: 'No Contact Hotel' })
  await rpc(U.sales2, 'quotation_save', id2, { header: { client_name: 'No Contact Hotel', valid_days: 7, gst_mode: 'igst' }, areas: [], lines: [line] })
  const p2 = await pub(await rpc(U.sales2, 'quotation_share', id2, true))
  for (const k of ['project_type', 'seats', 'lead_time_weeks', 'salesperson_phone', 'salesperson_email']) assert.ok(!(k in p2), `${k} is left out when it is not set`)
  assert.equal(p2.salesperson, 'Prerna Purohit')
  ok('nothing is set: the new keys are absent from the client copy (so an untouched quotation freezes the same copy as before)')
}

// ── the check the owner runs after applying 20270717000000 (the same text as in temporary/20270717000000-apply.sql) ──
{
  const r = await db.query(`select
    (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'quotations' and column_name in ('project_type', 'seats', 'lead_time_weeks', 'lead_time_reason')) as new_columns,
    (select count(*) from public.quotations where project_type is not null or seats is not null or lead_time_weeks is not null or lead_time_reason is not null) as quotations_with_new_values,
    (select count(*) from public.quotations) as quotations_total,
    (select bool_and(public.quotation_client_doc(id) ?& array['client_name', 'areas', 'lines'] and not (public.quotation_client_doc(id) ? 'lead_time_reason')) from public.quotations) as client_copy_ok`)
  assert.equal(Number(r.rows[0].new_columns), 4); assert.equal(r.rows[0].client_copy_ok, true)
  assert.ok(Number(r.rows[0].quotations_total) > 0)
  ok('the owner\'s after-apply query runs: four columns, every client copy has its keys and never the lead-time reason')
}

// ── 20270721000000: extra pictures on a line (swatch, drawing, reference) ──
await db.exec(mig('20270721000000_quotation_line_reference_images.sql'))
{
  const P = n => `00000000-0000-0000-0000-0000000000b2/${String(n).repeat(8)}-1111-1111-1111-111111111111.jpg`
  const refs = [{ path: P(1), kind: 'swatch', note: 'Green velvet' }, { path: P(2), kind: 'drawing' }]
  const id = await rpc(U.sales, 'quotation_create', { client_name: 'Scan Hotel' })
  const header = { client_name: 'Scan Hotel', valid_days: 7, gst_mode: 'igst' }
  const chair = { name: 'C1 Dining chair', qty_fixed: 20, tax_rate: 18, reference_images: refs }
  const table = { name: 'T1 Table', qty_fixed: 5, tax_rate: 18 }
  await rpc(U.sales, 'quotation_save', id, { header, areas: [], lines: [chair, { ...table, reference_images: [] }] })
  const g1 = await rpc(U.sales, 'quotation_get', id)
  assert.deepEqual(g1.lines.map(l => l.reference_images), [refs, []])
  ok('save stores the extra pictures of each line and quotation_get returns them')

  // A tab opened before the migration sends no reference_images: the line at the same place with the same name keeps its own.
  const { reference_images: _drop, ...oldChair } = chair
  await rpc(U.sales, 'quotation_save', id, { header, areas: [], lines: [oldChair, table] })
  assert.deepEqual((await rpc(U.sales, 'quotation_get', id)).lines.map(l => l.reference_images), [refs, []])
  // Renamed or moved without the key: nothing to match, so no pictures (never somebody else's).
  await rpc(U.sales, 'quotation_save', id, { header, areas: [], lines: [table, oldChair] })
  assert.deepEqual((await rpc(U.sales, 'quotation_get', id)).lines.map(l => l.reference_images), [[], []])
  ok('a save without the key keeps a line\'s pictures only when the same line sits in the same place')

  for (const bad of [[{ path: '../../etc.jpg', kind: 'swatch' }], [{ path: P(1), kind: 'logo' }], [{ path: P(1), kind: 'swatch', url: 'x' }],
    [{ path: P(1), kind: 'swatch', note: 'n'.repeat(201) }], Array.from({ length: 9 }, () => ({ path: P(3), kind: 'reference' })), { path: P(1) }]) {
    await fails(U.sales, `select public.quotation_save($1::uuid, $2::jsonb)`, [id, { header, areas: [], lines: [{ ...chair, reference_images: bad }] }], /QUOTATION_INVALID/)
  }
  ok('a foreign path, an unknown kind, an extra key, a long note, more than 8 pictures or a non-list are refused')

  await rpc(U.sales, 'quotation_save', id, { header, areas: [], lines: [chair] })
  const tok = await rpc(U.sales, 'quotation_share', id, true)
  const pub = (await as(null, `select public.quotation_public($1) as r`, [tok], 'anon')).rows[0].r
  assert.ok(pub.lines.every(l => !('reference_images' in l)), 'the client copy never carries them')
  ok('the client link and the frozen version do not carry the extra pictures')
}

// ── 20270801000000: the salesperson's own details, filled in once ──
await db.exec(mig('20270801000000_quotation_salesperson_card.sql'))
{
  const save = (uid, card) => as(uid, 'select public.quotation_my_card_save($1::jsonb) as r', [JSON.stringify(card)]).then(r => r.rows[0].r)
  const c0 = await rpc(U.sales, 'quotation_my_card')
  assert.deepEqual([c0.saved, c0.name, c0.phone, c0.email], [false, 'Mohit Sharma', '+91 90000 00001', 'mohit@boe.example'])
  const g0 = await rpc(U.sales, 'quotation_get', qa)
  assert.deepEqual([g0.owner_card_saved, g0.owner_phone, g0.owner_email, g0.owner_display_name], [false, '+91 90000 00001', 'mohit@boe.example', null])
  ok('before anything is saved: the form starts from the profile, and the document prints what it printed before')

  await assert.rejects(() => save(U.sales, { name: 'M' }), /write your name/)
  await assert.rejects(() => save(U.sales, { name: 'Mohit', phone: 'call me' }), /mobile number is not valid/)
  await assert.rejects(() => save(U.sales, { name: 'Mohit', phone: '12345' }), /mobile number is not valid/)
  await assert.rejects(() => save(U.sales, { name: 'Mohit', email: 'mohit@' }), /e-mail is not valid/)
  await assert.rejects(() => save(U.nobody, { name: 'No Access' }), /QUOTATIONS_FORBIDDEN/)
  ok('a short name, a wrong mobile or e-mail, and a person without Quotations are refused')

  const c1 = await save(U.sales, { name: ' Mohit Sharma ', title: 'Sales Manager', phone: '+91 98290-12345', email: '' })
  assert.deepEqual([c1.saved, c1.name, c1.title, c1.phone, c1.email], [true, 'Mohit Sharma', 'Sales Manager', '+91 98290-12345', ''])
  const g1 = await rpc(U.sales, 'quotation_get', qa)
  assert.deepEqual([g1.owner_card_saved, g1.owner_display_name, g1.owner_title, g1.owner_phone, g1.owner_email], [true, 'Mohit Sharma', 'Sales Manager', '+91 98290-12345', null])
  const c2 = await save(U.sales, { name: 'Mohit S.', title: '', phone: '', email: 'MOHIT@boe.example' })
  assert.deepEqual([c2.name, c2.title, c2.phone, c2.email], ['Mohit S.', '', '', 'mohit@boe.example'], 'saved again: it is editable')
  assert.equal((await rpc(U.sales2, 'quotation_my_card')).saved, false, 'one person saving does not fill in anyone else')
  ok('saved details print on the print page; a blank mobile prints nothing once saved; saving again changes them')

  const tok = (await db.query("update public.quotations set share_token = repeat('c', 31) || 'd', status = 'sent' where id = $1 returning share_token", [qa])).rows[0].share_token
  const pub2 = (await as(null, 'select public.quotation_public($1) as r', [tok], 'anon')).rows[0].r
  assert.deepEqual([pub2.salesperson, pub2.salesperson_email, 'salesperson_title' in pub2, 'salesperson_phone' in pub2], ['Mohit S.', 'mohit@boe.example', false, false])
  for (const k of ['owner_id', 'share_token', 'internal_notes', 'contact_phone']) assert.ok(!(k in pub2), k)
  ok('the client link prints the saved name and e-mail, and nothing the salesperson left blank')

  await assert.rejects(() => as(U.sales, 'select * from public.quotation_salesperson_cards'), /permission denied/)
  await assert.rejects(() => as(null, 'select public.quotation_my_card()', [], 'anon'), /permission denied/)
  ok('the table is closed to direct reads, and the details functions to anyone signed out')
}

// ── 20270806000100: the delivery city (takes the Delivery state box's place on the Client card; the state stays under Advanced) ──
await db.exec(mig('20270806000100_quotation_delivery_city.sql'))
{
  const id = await rpc(U.sales, 'quotation_create', { client_name: 'City Hotel' })
  const g0 = await rpc(U.sales, 'quotation_get', id)
  assert.equal(g0.quotation.delivery_city, null, 'an existing quotation starts with no city')
  const header = { client_name: 'City Hotel', valid_days: 7, gst_mode: 'igst', supply_state: 'Telangana' }
  const line = { name: 'C1 Chair', qty_fixed: 2, tax_rate: 18, unit_price: 1000 }
  const city = async () => (await rpc(U.sales, 'quotation_get', id)).quotation.delivery_city
  await rpc(U.sales, 'quotation_save', id, { expected_updated_at: g0.quotation.updated_at, header: { ...header, delivery_city: '  Hyderabad ' }, areas: [], lines: [line] })
  assert.equal(await city(), 'Hyderabad')
  assert.equal((await rpc(U.sales, 'quotation_get', id)).quotation.supply_state, 'Telangana', 'the state is saved beside it')
  ok('save stores the city (trimmed) next to the state, and quotation_get returns it')

  await rpc(U.sales, 'quotation_save', id, { header, areas: [], lines: [line] })
  assert.equal(await city(), 'Hyderabad')
  ok('a save from a tab opened before the change (no delivery_city key) keeps the city')

  await rpc(U.sales, 'quotation_save', id, { header: { ...header, delivery_city: '   ' }, areas: [], lines: [line] })
  assert.equal(await city(), null)
  ok('a blank city clears it')

  await fails(U.sales, `select public.quotation_save($1::uuid, $2::jsonb)`, [id, { header: { ...header, delivery_city: 'x'.repeat(81) }, areas: [], lines: [line] }], /QUOTATION_INVALID/)
  ok('a city longer than 80 characters is refused')

  await rpc(U.sales, 'quotation_save', id, { header: { ...header, delivery_city: 'Jaipur' }, areas: [], lines: [line] })
  const tok = await rpc(U.sales, 'quotation_share', id, true)
  const pub = (await as(null, `select public.quotation_public($1) as r`, [tok], 'anon')).rows[0].r
  assert.ok(!('delivery_city' in pub), 'the client copy does not carry the city')
  ok('the client link and the frozen version do not carry the city')
}

// ── 20270731 + 20270807: price suggestions for the pricing desk, no gate on price approval, payment details ──
await db.exec(mig('20270731000000_quotation_suggestions_switch.sql'))
await db.exec(mig('20270807000000_quotation_payment_and_desk.sql'))
{
  // qp is the "Pricing Hotel" quotation priced under 90% of the last order: it needed approval above and the link was refused
  let g2 = await rpc(U.sales, 'quotation_get', qp)
  assert.equal(g2.price.state, 'to_ask'); assert.equal(g2.price.blocked, false)
  const tok = await rpc(U.sales, 'quotation_share', qp, true)
  assert.match(tok, /^[0-9a-f]{32}$/)
  ok('a price outside the limits still shows the optional ask, but the client link is no longer held back')

  const sg = async uid => await rpc(uid, 'quotation_suggestions_get')
  const s0 = await sg(U.admin)
  assert.deepEqual([s0.everyone, s0.desk], [false, true])
  assert.equal((await sg(U.admin)).for_me, true); assert.equal((await sg(U.editor)).for_me, true)
  assert.equal((await sg(U.sales)).for_me, false); assert.equal((await sg(U.manager)).for_me, false)
  ok('suggestions start as the pricing desk: the administrator and an editor with view all see them, a salesperson and a viewer do not')
  assert.equal((await rpc(U.admin, 'quotation_suggestions_set', true)).everyone, true)
  assert.equal((await sg(U.sales)).for_me, true)
  assert.equal((await rpc(U.admin, 'quotation_suggestions_set', false)).desk, true)
  await fails(U.editor, `select public.quotation_suggestions_set(true)`, [], /only an administrator/)
  ok('only an administrator widens or narrows who sees suggestions')

  const det = async (uid, token, role) => (await as(uid, `select public.quotation_payment_details($1) as r`, [token], role)).rows[0].r
  const d1 = await det(U.sales, null)
  assert.equal(d1.account_no, '99982000009999'); assert.equal(d1.upi_id, '9829383706@hdfc'); assert.ok(!('customer_id' in d1))
  assert.equal(await det(null, null, 'anon'), null)
  assert.equal((await det(null, tok, 'anon')).ifsc, 'HDFC0004204')
  assert.equal(await det(null, 'f'.repeat(32), 'anon'), null)
  assert.equal(await det(U.nobody, null), null)
  ok('payment details: staff with Quotations access or a valid client link read them (no Customer ID); anyone else gets nothing')

  assert.equal((await rpc(U.admin, 'quotation_payment_get')).customer_id, '271662686')
  await fails(U.editor, `select public.quotation_payment_get()`, [], /only an administrator/)
  await fails(U.sales, `select public.quotation_payment_set($1::jsonb)`, [{ bank: 'x' }], /only an administrator/)
  await assert.rejects(() => as(null, `select public.quotation_payment_get()`, [], 'anon'), /permission denied/)
  await assert.rejects(() => as(U.sales, 'select * from public.quotation_payment_details'), /permission denied/)
  await fails(U.admin, `select public.quotation_payment_set($1::jsonb)`, [{ nonsense: 1 }], /unknown field/)
  const upd = await rpc(U.admin, 'quotation_payment_set', { ifsc: ' hdfc0004204 ', qr_image: 'data:image/png;base64,AAAA' })
  assert.deepEqual([upd.ifsc, upd.bank, upd.qr_image], ['HDFC0004204', 'HDFC Bank', 'data:image/png;base64,AAAA'])
  assert.equal((await rpc(U.admin, 'quotation_payment_set', { qr_image: '' })).qr_image, null)
  await fails(U.admin, `select public.quotation_payment_set($1::jsonb)`, [{ qr_image: 'javascript:alert(1)' }], /check constraint/)
  ok('only an administrator changes the payment settings; a key left out keeps its value; the QR must be a PNG or JPG data URL')
}

// ── 20270808: client choices on a line (fabric, finish, stone, rope weave) ──
await db.exec(mig('20270808000100_quotation_client_choices.sql'))
{
  const P = n => `00000000-0000-0000-0000-0000000000b2/${String(n).repeat(8)}-1111-1111-1111-111111111111.jpg`
  const choices = {
    fabric: { source: 'catalog', name: 'Berlin velvet', code: 'F18', supplier: 'V2 Homes', used_for: 'seat', photo: P(3), status: 'confirmed', confirmed_on: '2026-11-18' },
    stone: { source: 'client', name: 'Their own slate', status: 'to_confirm' },
  }
  const id = await rpc(U.sales, 'quotation_create', { client_name: 'Choices Hotel' })
  const header = { client_name: 'Choices Hotel', valid_days: 7, gst_mode: 'igst' }
  const chair = { name: 'C1 Arm chair', qty_fixed: 6, unit_price: 20000, tax_rate: 18, client_choices: choices }
  const table = { name: 'T1 Table', qty_fixed: 2, unit_price: 9000, tax_rate: 18 }
  const lines = async () => (await rpc(U.sales, 'quotation_get', id)).lines.map(l => l.client_choices)
  const price = async () => (await rpc(U.sales, 'quotation_get', id)).quotation.value_before_gst ?? null
  await rpc(U.sales, 'quotation_save', id, { header, areas: [], lines: [chair, { ...table, client_choices: {} }] })
  assert.deepEqual(await lines(), [choices, {}])
  ok('save stores the choices of each line and quotation_get returns them')

  const { client_choices: _drop, ...oldChair } = chair
  await rpc(U.sales, 'quotation_save', id, { header, areas: [], lines: [oldChair, table] })
  assert.deepEqual(await lines(), [choices, {}])
  await rpc(U.sales, 'quotation_save', id, { header, areas: [], lines: [table, oldChair] })
  assert.deepEqual(await lines(), [{}, {}])
  ok('a save without the key (an old tab) keeps a line\'s choices only when the same line sits in the same place, never another line\'s')

  await rpc(U.sales, 'quotation_save', id, { header, areas: [], lines: [{ ...chair, client_choices: {} }, table] })
  assert.deepEqual(await lines(), [{}, {}])
  ok('an empty object clears the choices')

  const bad = [
    { leather: { source: 'catalog', status: 'to_confirm' } },
    { fabric: { source: 'shop', status: 'to_confirm' } },
    { fabric: { source: 'catalog', status: 'locked' } },
    { fabric: { source: 'catalog', status: 'to_confirm', price: '5' } },
    { fabric: { source: 'catalog', status: 'to_confirm', name: 'x'.repeat(201) } },
    { fabric: { source: 'catalog', status: 'to_confirm', photo: '../../etc.jpg' } },
    { fabric: { source: 'catalog', status: 'to_confirm', confirmed_on: '2026-11-18' } },
    { fabric: { source: 'catalog', status: 'confirmed', confirmed_on: '18 Nov' } },
    { fabric: { source: 'catalog', status: 'to_confirm', name: 5 } },
    [{ source: 'catalog', status: 'to_confirm' }],
  ]
  for (const b of bad) await fails(U.sales, `select public.quotation_save($1::uuid, $2::jsonb)`, [id, { header, areas: [], lines: [{ ...table, client_choices: b }] }], /QUOTATION_INVALID/)
  ok('unknown kinds, sources or statuses, extra fields (a price), over-long text, a bad photo path or date, and a date on an unconfirmed choice are refused')

  // never a price: the same lines with and without choices give the same value before GST, and the client copy has no choices
  await rpc(U.sales, 'quotation_save', id, { header, areas: [], lines: [chair, table] })
  const withC = (await rpc(U.sales, 'quotation_save', id, { header, areas: [], lines: [chair, table] })).value_before_gst
  const without = (await rpc(U.sales, 'quotation_save', id, { header, areas: [], lines: [{ ...chair, client_choices: {} }, table] })).value_before_gst
  assert.equal(String(withC), String(without))
  await rpc(U.sales, 'quotation_save', id, { header, areas: [], lines: [chair, table] })
  const tok = await rpc(U.sales, 'quotation_share', id, true)
  const pub = (await as(null, `select public.quotation_public($1) as r`, [tok], 'anon')).rows[0].r
  assert.ok(!JSON.stringify(pub).includes('Berlin velvet') && !JSON.stringify(pub).includes('client_choices'), 'the client link does not carry the choices')
  const ver = (await db.query(`select doc from public.quotation_versions where quotation_id = $1`, [id])).rows
  assert.ok(ver.every(r => !JSON.stringify(r.doc).includes('client_choices')), 'a frozen version does not carry the choices')
  ok('choices never change the value, and neither the client link nor a frozen version carries them')

  await assert.rejects(() => as(null, `select public.quotation_line_choices_ok('{}'::jsonb)`, [], 'anon'), /permission denied/)
  ok('the checker function is closed to anyone signed out')
}

// ── 20270809: the client's copy carries the choices (never the note); sent versions stay as they were ──
{
  const P = n => `00000000-0000-0000-0000-0000000000b2/${String(n).repeat(8)}-1111-1111-1111-111111111111.jpg`
  const choices = {
    fabric: { source: 'catalog', name: 'Berlin velvet', code: 'F18', supplier: 'V2 Homes', used_for: 'seat', note: 'FACTORY-ONLY-NOTE', photo: P(4), status: 'confirmed', confirmed_on: '2026-11-18' },
    stone: { source: 'client', name: 'Their own slate', status: 'to_confirm' },
  }
  const id = await rpc(U.sales, 'quotation_create', { client_name: 'Output Hotel' })
  const header = { client_name: 'Output Hotel', valid_days: 7, gst_mode: 'igst' }
  const chair = { name: 'O1 Arm chair', qty_fixed: 6, unit_price: 20000, tax_rate: 18, client_choices: choices, internal_note: 'INTERNAL-NOTE-NEVER' }
  const table = { name: 'O2 Table', qty_fixed: 2, unit_price: 9000, tax_rate: 18 }
  await rpc(U.sales, 'quotation_save', id, { header, areas: [], lines: [chair, table] })
  const tok = await rpc(U.sales, 'quotation_share', id, true) // v1 is frozen BEFORE the new migration
  await db.exec(mig('20270809000000_quotation_client_choices_output.sql'))
  const pub = async () => (await as(null, `select public.quotation_public($1) as r`, [tok], 'anon')).rows[0].r
  assert.ok(!JSON.stringify(await pub()).includes('client_choices'), 'a version sent before the migration is untouched')
  ok('a version sent before the change still shows no choices to the client')

  assert.equal(await rpc(U.sales, 'quotation_version_create', id, 'choices added'), 2)
  const p2 = await pub()
  const c = p2.lines[0].client_choices
  assert.deepEqual(c.fabric, { source: 'catalog', name: 'Berlin velvet', code: 'F18', supplier: 'V2 Homes', used_for: 'seat', photo: P(4), status: 'confirmed', confirmed_on: '2026-11-18' })
  assert.deepEqual(c.stone, { source: 'client', name: 'Their own slate', status: 'to_confirm' })
  assert.ok(!('client_choices' in p2.lines[1]), 'a line without choices carries no key')
  ok('the next version carries each line\'s choices (both confirmed and to-confirm), and no key on a line without any')

  const text = JSON.stringify(p2)
  for (const secret of ['FACTORY-ONLY-NOTE', 'INTERNAL-NOTE-NEVER']) assert.ok(!text.includes(secret), secret)
  assert.ok(!/"note"/.test(JSON.stringify(p2.lines.map(l => l.client_choices ?? {}))), 'the choice note is not in the client copy')
  ok('the client copy never carries the choice note or the internal note')

  // a quotation with no choices produces the very same client document as before
  const plain = await rpc(U.sales, 'quotation_create', { client_name: 'Plain Hotel' })
  await rpc(U.sales, 'quotation_save', plain, { header: { ...header, client_name: 'Plain Hotel' }, areas: [], lines: [table] })
  const ptok = await rpc(U.sales, 'quotation_share', plain, true)
  const pp = (await as(null, `select public.quotation_public($1) as r`, [ptok], 'anon')).rows[0].r
  assert.ok(!JSON.stringify(pp).includes('client_choices'))
  ok('a quotation without choices gets exactly the document it got before')

  await assert.rejects(() => as(U.sales, `select public.quotation_client_doc($1::uuid)`, [id]), /permission denied/)
  await assert.rejects(() => as(null, `select public.quotation_client_doc($1::uuid)`, [id], 'anon'), /permission denied/)
  ok('quotation_client_doc stays closed to signed-in and signed-out callers')
}

// ── 20270811000000: a quotation can point at the Sales lead it came from ──
// The lead side is a small stand-in (tables) with the REAL visibility functions and phone rule taken from their migrations,
// so "who sees a lead" and "the same phone" are the production rules, not a copy.
{
  const grab = (text, name) => {
    const lines = text.split('\n')
    const i = lines.findIndex(l => new RegExp(`^create (or replace )?function public\\.${name}\\(`).test(l))
    assert.ok(i >= 0, `cannot find ${name}`)
    let j = i
    while (!/^\$\$;/.test(lines[j])) j++
    return lines.slice(i, j + 1).join('\n')
  }
  const QONLY = '00000000-0000-0000-0000-0000000000e5' // quotations view + create, no Sales at all
  const L1 = '00000000-0000-0000-0000-0000000001a1', L2 = '00000000-0000-0000-0000-0000000001a2', L3 = '00000000-0000-0000-0000-0000000001a3'
  await db.exec(`
    create table public.sales_leads (id uuid primary key default gen_random_uuid(), lead_no bigint generated always as identity, name text,
      phone_e164 text unique, stage text not null default 'new', assigned_to uuid, created_by uuid, next_step text, next_due_on date, dead_reason text);
    create table public.sales_lead_access (viewer_id uuid, subject_id uuid);
    create table public.sales_lead_activities (id uuid primary key default gen_random_uuid(), lead_id uuid references public.sales_leads (id),
      kind text, note text, at timestamptz not null default now(), undone_at timestamptz);
    insert into public.users (id, full_name, role) values ('${QONLY}', 'Quotes Only', 'employee');
    insert into public.grants values
      ('${QONLY}', 'quotations', 'view'), ('${QONLY}', 'quotations', 'create'),
      ('${U.sales}', 'sales', 'view'), ('${U.sales2}', 'sales', 'view'),
      ('${U.editor}', 'sales', 'view'), ('${U.editor}', 'sales', 'assign');
    insert into public.sales_leads (id, name, phone_e164, stage, assigned_to, created_by, dead_reason) values
      ('${L1}', 'Hotel Aravali', '+919876543210', 'potential', '${U.sales}', '${U.sales}', null),
      ('${L2}', 'Cafe Lake', '+919812345678', 'new', '${U.sales2}', '${U.sales2}', null),
      ('${L3}', 'Closed Resort', '+919700000001', 'dead', '${U.sales}', '${U.sales}', 'price_too_high');`)
  await db.exec(grab(mig('20270305000000_exhibition_leads.sql'), 'normalize_lead_phone'))
  await db.exec(grab(mig('20270525000000_sales_lead_board.sql'), 'sales_lead_sees_all'))
  await db.exec(grab(mig('20270525000000_sales_lead_board.sql'), 'sales_lead_visible'))
  await db.exec(mig('20270811000000_quotation_lead_link.sql'))

  const link = (uid, q, l) => as(uid, 'select public.quotation_link_lead($1::uuid, $2::uuid)', [q, l])
  const info = async (uid, q) => (await as(uid, 'select public.quotation_lead_info($1::uuid) as r', [q])).rows[0].r
  const leadOf = async q => (await db.query('select lead_id from public.quotations where id = $1', [q])).rows[0].lead_id

  const old = await db.query('select count(*)::int as n from public.quotations where lead_id is not null')
  assert.equal(old.rows[0].n, 0)
  ok('every quotation that existed before the link starts with no lead')

  const q1 = await rpc(U.sales, 'quotation_create', { client_name: 'Aravali Hotel', contact_phone: '98765 43210' })

  let r = await info(U.sales, q1)
  assert.equal(r.linked, false); assert.equal(r.lead, null)
  assert.equal(r.suggest.id, L1); assert.equal(r.suggest.name, 'Hotel Aravali'); assert.equal(r.suggest.holder_name, 'Mohit Sharma')
  ok('an unlinked quotation suggests the lead whose phone is its contact phone (written any way the shared phone rule accepts)')

  const q2 = await rpc(U.sales2, 'quotation_create', { client_name: 'Lake Cafe', contact_phone: '98123 45678' })
  assert.equal((await info(U.sales2, q2)).suggest.id, L2)
  const q3 = await rpc(U.sales, 'quotation_create', { client_name: 'Mohit sees no Prerna lead', contact_phone: '98123 45678' })
  assert.equal((await info(U.sales, q3)).suggest, null)
  const q4 = await rpc(U.sales, 'quotation_create', { client_name: 'No phone at all' })
  assert.equal((await info(U.sales, q4)).suggest, null)
  ok('no suggestion for a lead the caller cannot see, nor for a quotation with no usable phone')

  await link(U.sales, q1, L1)
  assert.equal(await leadOf(q1), L1)
  r = await info(U.sales, q1)
  assert.equal(r.linked, true); assert.equal(r.suggest, null); assert.equal(r.sales_open, true)
  assert.deepEqual([r.lead.id, r.lead.lead_no > 0, r.lead.name, r.lead.stage, r.lead.holder_name, r.lead.may_work, r.lead.last_logged_at],
                   [L1, true, 'Hotel Aravali', 'potential', 'Mohit Sharma', true, null])
  await link(U.sales, q1, L1) // the same lead again is a no-op
  ok('linking shows the lead (number, name, stage, holder, may work it) and stops suggesting')

  await fails(U.sales, 'select public.quotation_link_lead($1::uuid, $2::uuid)', [q1, L2], /SALES_NOT_FOUND/)
  await fails(U.sales, 'select public.quotation_link_lead($1::uuid, $2::uuid)', [q1, '00000000-0000-0000-0000-00000000dead'], /SALES_NOT_FOUND/)
  assert.equal(await leadOf(q1), L1)
  ok('a lead the caller cannot see, and a lead that does not exist, cannot be linked (same answer for both)')

  await fails(U.sales2, 'select public.quotation_link_lead($1::uuid, $2::uuid)', [q1, L2], /QUOTATION_NOT_FOUND/)
  await fails(U.manager, 'select public.quotation_link_lead($1::uuid, $2::uuid)', [q1, null], /QUOTATIONS_FORBIDDEN/)
  await fails(U.nobody, 'select public.quotation_lead_info($1::uuid)', [q1], /QUOTATIONS_FORBIDDEN/)
  await fails(U.sales2, 'select public.quotation_lead_info($1::uuid)', [q1], /QUOTATION_NOT_FOUND/)
  assert.equal(await leadOf(q1), L1)
  ok('somebody who cannot see the quotation, or can only read it, can neither link nor read its lead')

  const qq = await rpc(QONLY, 'quotation_create', { client_name: 'No Sales Access' })
  await fails(QONLY, 'select public.quotation_link_lead($1::uuid, $2::uuid)', [qq, L1], /SALES_FORBIDDEN/)
  ok('a person with no Sales access cannot link a quotation to a lead')

  r = await info(U.manager, q1)
  assert.equal(r.linked, true); assert.equal(r.sales_open, false); assert.equal(r.lead, null)
  assert.ok(!JSON.stringify(r).includes('Hotel Aravali'))
  ok('somebody who sees the quotation but not Sales learns only that it is linked, never the lead\'s name')

  r = await info(U.editor, q1)
  assert.equal(r.lead.name, 'Hotel Aravali'); assert.equal(r.lead.may_work, true)
  await link(U.editor, q1, L2)
  assert.equal(await leadOf(q1), L2)
  await link(U.editor, q1, L1)
  ok('the pricing desk with Sales `assign` sees every lead, may work it, and may link any quotation it can edit')

  await db.query(`update public.sales_leads set assigned_to = $1 where id = $2`, [U.sales2, L1])
  r = await info(U.sales, q1)
  assert.equal(r.linked, true); assert.equal(r.lead, null)
  r = await info(U.admin, q1)
  assert.equal(r.lead.holder_name, 'Prerna Purohit'); assert.equal(r.lead.may_work, true)
  await db.query(`update public.sales_leads set assigned_to = $1 where id = $2`, [U.sales, L1])
  ok('when the lead moves to somebody else the owner stops seeing it, Admin still does and may work it')

  await db.query(`update public.sales_leads set assigned_to = null where id = $1`, [L1])
  r = await info(U.editor, q1)
  assert.equal(r.lead.may_work, false)
  await db.query(`update public.sales_leads set assigned_to = $1 where id = $2`, [U.sales, L1])
  ok('a lead nobody holds cannot be worked, even by someone with `assign` (the lead\'s own rule)')

  const log = (note, undone) => db.query(
    `insert into public.sales_lead_activities (lead_id, kind, note, undone_at) values ($1, 'quotation', $2, ${undone ? 'now()' : 'null'})`, [L1, note])
  const no = (await db.query('select quote_no from public.quotations where id = $1', [q1])).rows[0].quote_no
  await log('QT-ZZ-00001 v1 sent')
  await db.query(`insert into public.sales_lead_activities (lead_id, kind, note) values ($1, 'call', $2)`, [L1, `${no} was mentioned on a call`])
  await log(`${no} v1 sent`, true)
  assert.equal((await info(U.sales, q1)).lead.last_logged_at, null)
  await log(`${no} v2 sent, Rs 1,000 before GST`)
  assert.notEqual((await info(U.sales, q1)).lead.last_logged_at, null)
  ok('"last logged" counts only a live quotation update that names THIS quotation (not another number, a call, or an undone one)')

  assert.equal((await info(U.sales, q1)).version_no, null)
  await rpc(U.sales, 'quotation_save', q1, { header: { client_name: 'Aravali Hotel', contact_phone: '98765 43210', valid_days: 7, gst_mode: 'igst' }, areas: [], lines: [{ name: 'Table', qty_fixed: 5, unit_price: 10000, tax_rate: 18 }] })
  const token = await rpc(U.sales, 'quotation_share', q1, true)
  r = await info(U.sales, q1)
  assert.equal(r.version_no, 1); assert.equal(Number(r.value), 50000)
  const pub = (await as(null, `select public.quotation_public($1) as r`, [token], 'anon')).rows[0].r
  assert.ok(!JSON.stringify(pub).includes('lead_id') && !JSON.stringify(pub).includes(L1) && !JSON.stringify(pub).includes('Hotel Aravali'))
  ok('the card gets the latest sent version and its value; the client link never carries the lead')

  await link(U.sales, q1, null)
  assert.equal(await leadOf(q1), null)
  await link(U.sales, q1, null)
  r = await info(U.sales, q1)
  assert.equal(r.linked, false); assert.equal(r.suggest.id, L1)
  ok('unlinking (twice is fine) needs the quotation right only, and the suggestion comes back')

  await link(U.sales, q1, L3)
  assert.equal((await info(U.sales, q1)).lead.stage, 'dead')
  assert.equal((await info(U.sales, q1)).lead.dead_reason, 'price_too_high')
  await db.query('delete from public.sales_leads where id = $1', [L3])
  assert.equal(await leadOf(q1), null)
  ok('a closed lead can still be linked, and if a lead is ever deleted the quotation is simply left unlinked')

  for (const fn of ['quotation_link_lead(uuid, uuid)', 'quotation_lead_info(uuid)']) {
    const g = (await db.query(`select has_function_privilege('anon', 'public.${fn}', 'EXECUTE') as a, has_function_privilege('authenticated', 'public.${fn}', 'EXECUTE') as b`)).rows[0]
    assert.deepEqual([g.a, g.b], [false, true])
  }
  await assert.rejects(() => as(null, 'select public.quotation_lead_info($1::uuid)', [q1], 'anon'), /permission denied/)
  await assert.rejects(() => as(U.sales, 'select lead_id from public.quotations'), /permission denied/)
  ok('both functions are closed to signed-out callers and the table itself stays closed to the browser')
}

// ── 20270812000000: the quotations of a lead, for the lead popup ──
{
  const L1 = '00000000-0000-0000-0000-0000000001a1' // Hotel Aravali, held by Mohit (sales)
  const L2 = '00000000-0000-0000-0000-0000000001a2' // Cafe Lake, held by Prerna (sales2)
  await db.exec(mig('20270812000000_quotation_for_lead.sql'))
  const forLead = async (uid, lead) => (await as(uid, 'select public.quotation_for_lead($1::uuid) as r', [lead])).rows[0].r
  const link = (uid, q, l) => as(uid, 'select public.quotation_link_lead($1::uuid, $2::uuid)', [q, l])
  const ids = r => r.quotations.map(x => x.id)

  assert.deepEqual(await forLead(U.sales, L1), { open: true, may_create: true, quotations: [] })
  ok('a lead with no quotation answers an empty list and says the caller may make one')

  const qa = await rpc(U.sales, 'quotation_create', { client_name: 'Aravali A' })
  const qb = await rpc(U.sales, 'quotation_create', { client_name: 'Aravali B' })
  const qadmin = await rpc(U.admin, 'quotation_create', { client_name: 'Aravali by Admin' })
  const qother = await rpc(U.sales, 'quotation_create', { client_name: 'Not linked' })
  await rpc(U.sales, 'quotation_save', qa, { header: { client_name: 'Aravali A', valid_days: 7, gst_mode: 'igst' }, areas: [], lines: [{ name: 'Table', qty_fixed: 5, unit_price: 10000, tax_rate: 18 }] })
  await rpc(U.sales, 'quotation_share', qa, true)
  for (const q of [qa, qb]) await link(U.sales, q, L1)
  await link(U.admin, qadmin, L1)

  let r = await forLead(U.sales, L1)
  assert.deepEqual(ids(r).sort(), [qa, qb].sort())
  const a = r.quotations.find(x => x.id === qa), b = r.quotations.find(x => x.id === qb)
  assert.deepEqual([a.quote_no.startsWith('QT-'), a.status, a.version_no, Number(a.value), a.owner_name], [true, 'sent', 1, 50000, 'Mohit Sharma'])
  assert.deepEqual([b.status, b.version_no, Number(b.value)], ['draft', null, 0])
  ok('the owner sees their linked quotations only (not an Admin\'s, not an unlinked one), with the sent version\'s number and value')

  await db.query('update public.quotations set updated_at = now() + interval \'1 minute\' where id = $1', [qb])
  assert.equal((await forLead(U.sales, L1)).quotations[0].id, qb)
  ok('the most recently changed quotation comes first')

  r = await forLead(U.editor, L1)
  assert.deepEqual(ids(r).sort(), [qa, qb, qadmin].sort()); assert.equal(r.may_create, false)
  r = await forLead(U.admin, L1)
  assert.equal(r.quotations.length, 3); assert.equal(r.may_create, true)
  ok('the pricing desk and Admin see every quotation of the lead; the desk (no create right) is not offered "make one"')

  r = await forLead(U.sales2, L1)
  assert.deepEqual(r, { open: true, may_create: false, quotations: [] })
  r = await forLead(U.manager, L1)
  assert.deepEqual(r, { open: true, may_create: false, quotations: [] })
  r = await forLead(U.sales, '00000000-0000-0000-0000-00000000dead')
  assert.deepEqual(r, { open: true, may_create: false, quotations: [] })
  ok('a lead the caller cannot see (or that does not exist) answers nothing and offers nothing, however many quotations it has')

  assert.deepEqual(await forLead(U.nobody, L1), { open: false, may_create: false, quotations: [] })
  ok('somebody with no Quotations access gets open: false (the popup shows no section)')

  await link(U.sales, qa, null)
  assert.deepEqual(ids(await forLead(U.sales, L1)), [qb])
  await link(U.sales2, qother, L2).catch(() => null)
  ok('an unlinked quotation drops off the lead\'s list')

  const g = (await db.query(`select has_function_privilege('anon', 'public.quotation_for_lead(uuid)', 'EXECUTE') as a, has_function_privilege('authenticated', 'public.quotation_for_lead(uuid)', 'EXECUTE') as b`)).rows[0]
  assert.deepEqual([g.a, g.b], [false, true])
  await assert.rejects(() => as(null, 'select public.quotation_for_lead($1::uuid)', [L1], 'anon'), /permission denied/)
  ok('quotation_for_lead is closed to signed-out callers')
}

// ── 20270813000000: a lost quotation carries one of the lead's eleven reasons; the report counts reasons ──
{
  await db.exec(mig('20270813000000_quotation_lost_reasons.sql'))
  const mk = name => rpc(U.sales, 'quotation_create', { client_name: name })
  const lastStatus = async q => (await db.query(`select detail from public.quotation_events where quotation_id = $1 and kind = 'status' order by at desc limit 1`, [q])).rows[0].detail
  const setLost = (q, note, reason) => as(U.sales, `select public.quotation_set_status($1::uuid, 'lost', $2, $3)`, [q, note, reason])

  const l1 = await mk('Lost one'), l2 = await mk('Lost two'), l3 = await mk('Lost three'), l4 = await mk('Lost four'), l5 = await mk('Lost old style')
  await setLost(l1, '12% above the other quote', 'price_too_high')
  assert.deepEqual(await lastStatus(l1), { from: 'draft', to: 'lost', note: '12% above the other quote', reason: 'price_too_high' })
  await setLost(l2, null, 'price_too_high')
  assert.deepEqual(await lastStatus(l2), { from: 'draft', to: 'lost', note: null, reason: 'price_too_high' })
  ok('a reason of the lead\'s eleven is kept in the history entry beside the note, and needs no note')

  await fails(U.sales, `select public.quotation_set_status($1::uuid, 'lost', $2, $3)`, [l3, 'x', 'too_expensive'], /QUOTATION_INVALID: reason/)
  await fails(U.sales, `select public.quotation_set_status($1::uuid, 'lost', $2, $3)`, [l3, '', 'other'], /say why it was lost/)
  await setLost(l3, 'Client sold the hotel', 'other')
  assert.equal((await lastStatus(l3)).reason, 'other')
  ok('an unknown reason is refused, and "other" needs words')

  await fails(U.sales, `select public.quotation_set_status($1::uuid, 'lost', $2)`, [l4, ''], /say why it was lost/)
  await as(U.sales, `select public.quotation_set_status($1::uuid, 'lost', $2)`, [l5, 'Went with a cheaper vendor'])
  assert.deepEqual(await lastStatus(l5), { from: 'draft', to: 'lost', note: 'Went with a cheaper vendor' })
  ok('a call with no reason works as before: the note is the reason, and three characters are needed')

  const l6 = await mk('Not lost')
  await as(U.sales, `select public.quotation_set_status($1::uuid, 'sent', null, $2)`, [l6, 'price_too_high'])
  assert.ok(!('reason' in await lastStatus(l6)))
  ok('a reason sent with any other status is not kept')

  const rep = (await as(U.admin, `select public.quotation_report(current_date - 30, current_date + 1, 'all') as r`)).rows[0].r
  const by = Object.fromEntries(rep.lost_reasons.map(x => [x.reason, x]))
  assert.deepEqual([by.price_too_high.keyed, by.price_too_high.n], [true, 2])
  assert.deepEqual([by.other.keyed, by.other.n], [true, 1])
  assert.deepEqual([by['Went with a cheaper vendor'].keyed, by['Went with a cheaper vendor'].n], [false, 1])
  ok('the report counts reasons by key (two price_too_high), and still counts an older free-text reason as its own line')

  await assert.rejects(() => as(null, `select public.quotation_set_status($1::uuid, 'lost', 'abc', null)`, [l6], 'anon'), /permission denied/)
  assert.equal((await db.query(`select count(*)::int as n from pg_proc where proname = 'quotation_set_status'`)).rows[0].n, 1)
  ok('quotation_set_status stays closed to signed-out callers, and only the four-argument function exists')
}

// ── 20270814000000 + 20270814000100: a quotation STARTS FROM a Sales lead (details copied from it) ──
{
  const L1 = '00000000-0000-0000-0000-0000000001a1' // Hotel Aravali, held by Mohit (sales)
  const L2 = '00000000-0000-0000-0000-0000000001a2' // Cafe Lake, held by Prerna (sales2)
  const L3 = '00000000-0000-0000-0000-0000000001a3' // Closed Resort, Dead
  const L4 = '00000000-0000-0000-0000-0000000001a4' // a lead with no name
  const DESK = '00000000-0000-0000-0000-0000000000f6' // like Nitish: quotations view + create + edit + view_all, Sales view + assign
  await db.exec(`
    alter table public.sales_leads add column email text, add column location text, add column requirement text, add column client_type text;
    update public.sales_leads set email = 'aravali@example.invalid', location = 'Udaipur', requirement = '80 rooms, teak, ready in 12 weeks', client_type = 'hotel' where id = '${L1}';
    insert into public.sales_leads (id, name, phone_e164, stage, assigned_to, created_by, dead_reason) values ('${L4}', null, '+919700000004', 'new', '${U.sales}', '${U.sales}', null), ('${L3}', 'Closed Resort', '+919700000003', 'dead', '${U.sales}', '${U.sales}', 'price_too_high');
    insert into public.users (id, full_name, role) values ('${DESK}', 'Desk Person', 'employee');
    insert into public.grants values ('${DESK}', 'quotations', 'view'), ('${DESK}', 'quotations', 'create'), ('${DESK}', 'quotations', 'edit'), ('${DESK}', 'quotations', 'view_all'),
      ('${DESK}', 'sales', 'view'), ('${DESK}', 'sales', 'assign');`)
  await db.exec(mig('20270814000000_quotation_start_from_lead.sql'))
  const start = (uid, lead, data = {}) => rpc(uid, 'quotation_start', lead, data)
  const row = async id => (await db.query('select * from public.quotations where id = $1', [id])).rows[0]

  const q = await start(U.sales, L1)
  let r = await row(q)
  assert.deepEqual([r.client_name, r.contact_name, r.contact_phone, r.client_email, r.delivery_city, r.project_type, r.lead_id, r.owner_id, r.created_by, r.source],
    ['Hotel Aravali', 'Hotel Aravali', '+919876543210', 'aravali@example.invalid', 'Udaipur', 'hotel', L1, U.sales, U.sales, 'Sales lead'])
  assert.match(r.quote_no, /^QT-MS-\d{5}$/); assert.match(r.internal_notes, /^From lead \d+ · 80 rooms, teak, ready in 12 weeks$/); assert.equal(r.status, 'draft')
  const ev = (await db.query(`select detail from public.quotation_events where quotation_id = $1 and kind = 'created'`, [q])).rows[0].detail
  assert.equal(ev.lead_id, L1); assert.ok(ev.lead_no > 0)
  ok('starting from a lead writes a linked draft with the lead\'s name, phone, e-mail, city, venue and requirement copied in, and the lead on its history')

  r = await row(await start(U.sales, L4))
  assert.match(r.client_name, /^Lead \d+$/); assert.equal(r.contact_name, null); assert.equal(r.lead_id, L4)
  ok('a lead with no name still starts a quotation (named "Lead N"; the Client card stays editable)')

  await fails(U.sales, 'select public.quotation_start($1::uuid)', [L3], /QUOTATION_LEAD_CLOSED/)
  await fails(U.sales, 'select public.quotation_start($1::uuid)', [L2], /SALES_NOT_FOUND/)
  await fails(U.sales, 'select public.quotation_start($1::uuid)', ['00000000-0000-0000-0000-00000000dead'], /SALES_NOT_FOUND/)
  ok('a Dead lead, another person\'s lead and a lead that does not exist are refused (the last two give the same answer)')

  await fails(U.nobody, 'select public.quotation_start($1::uuid)', [L1], /QUOTATIONS_FORBIDDEN/)
  await fails(U.manager, 'select public.quotation_start($1::uuid)', [L1], /QUOTATIONS_FORBIDDEN/)
  await fails('00000000-0000-0000-0000-0000000000e5', 'select public.quotation_start($1::uuid)', [L1], /SALES_FORBIDDEN/)
  await fails(null, 'select public.quotation_start($1::uuid)', [L1], /permission denied/, 'anon')
  ok('no Quotations access, no create right, or no Sales access is refused; a signed-out caller cannot call it at all')

  await fails(U.sales, 'select public.quotation_start($1::uuid, $2::jsonb)', [L1, { owner_id: U.sales2 }], /only an administrator or the pricing desk/)
  const forSales = await start(DESK, L1, { owner_id: U.sales, source: 'Excel from the client' })
  r = await row(forSales)
  assert.deepEqual([r.owner_id, r.created_by, r.source], [U.sales, DESK, 'Excel from the client']); assert.match(r.quote_no, /^QT-MS-/)
  const forSales2 = await start(U.admin, L1, { owner_id: U.sales })
  assert.equal((await row(forSales2)).owner_id, U.sales)
  const mine = await rpc(U.sales, 'quotation_list', 'mine')
  assert.ok(mine.some(x => x.id === forSales) && mine.some(x => x.id === forSales2))
  ok('the pricing desk or an administrator can put a quotation on a salesperson\'s page (their initials in the number, their "My quotations"); a salesperson cannot')

  await fails(U.admin, 'select public.quotation_start($1::uuid, $2::jsonb)', [L1, { owner_id: U.nobody }], /cannot own quotations/)
  await fails(U.admin, 'select public.quotation_start($1::uuid, $2::jsonb)', [L1, { owner_id: U.manager }], /cannot own quotations/)
  ok('a quotation cannot be put on somebody who cannot make quotations (no grant, or view-only)')

  const names = async uid => (await as(uid, 'select full_name from public.quotation_makers()')).rows.map(x => x.full_name)
  const list = await names(U.admin)
  for (const n of ['Mohit Sharma', 'Prerna Purohit', 'Desk Person', 'Quotes Only']) assert.ok(list.includes(n), n)
  assert.ok(!list.includes('Quotes Only X') && !list.includes('No Grant'))
  assert.equal((await names(DESK)).includes('Mohit Sharma'), true)
  await fails(U.sales, 'select * from public.quotation_makers()', [], /only an administrator or the pricing desk/)
  await fails(U.nobody, 'select * from public.quotation_makers()', [], /QUOTATIONS_FORBIDDEN/)
  assert.equal((await db.query(`select public.quotation_can_own('${U.manager}') as a, public.quotation_can_own('${U.nobody}') as b`)).rows[0].a, false)
  ok('quotation_makers lists the people who can make quotations, for the desk and Admin only')

  // quotation_create now needs a lead and is the same code path
  await db.exec(mig('20270814000100_quotation_lead_required.sql'))
  await fails(U.sales, 'select public.quotation_create($1::jsonb)', [{ client_name: 'Typed by hand' }], /QUOTATION_LEAD_REQUIRED/)
  await fails(U.sales, 'select public.quotation_create($1::jsonb)', [{ lead_id: 'not-a-uuid' }], /QUOTATION_INVALID/)
  await fails(U.nobody, 'select public.quotation_create($1::jsonb)', [{ client_name: 'X' }], /QUOTATIONS_FORBIDDEN/)
  const viaCreate = await rpc(U.sales, 'quotation_create', { lead_id: L1, client_name: 'IGNORED typed name' })
  r = await row(viaCreate)
  assert.deepEqual([r.client_name, r.lead_id], ['Hotel Aravali', L1])
  ok('quotation_create without a lead is refused; with one it is quotation_start (typed details are ignored, the lead\'s are used)')

  const g = (await db.query(`select has_function_privilege('anon', 'public.quotation_create(jsonb)', 'EXECUTE') as a, has_function_privilege('authenticated', 'public.quotation_create(jsonb)', 'EXECUTE') as b`)).rows[0]
  assert.deepEqual([g.a, g.b], [false, true])
  ok('quotation_create is still closed to signed-out callers')
}

// ── 20270814000200: quotation requests inside Quotations (sent to a senior, answered, withdrawn) ──
{
  const DESK = '00000000-0000-0000-0000-0000000000f6'
  const L1 = '00000000-0000-0000-0000-0000000001a1'
  await db.exec(mig('20270814000200_quotation_requests.sql'))
  const q = await rpc(U.sales, 'quotation_start', L1, {})
  const state = async (uid, id) => (await as(uid, 'select public.quotation_ask_state($1::uuid) as r', [id])).rows[0].r
  const send = (uid, id, to, kind, note) => as(uid, 'select public.quotation_request_send($1::uuid, $2::uuid, $3, $4) as r', [id, to, kind, note ?? null])

  const people = (await as(U.sales, 'select full_name from public.quotation_desk_people()')).rows.map(x => x.full_name)
  assert.ok(people.includes('Desk Person') && people.includes('Admin Person') && !people.includes('Mohit Sharma') && !people.includes('Prerna Purohit'))
  ok('the people who can be asked are the administrator and the pricing desk, never a plain salesperson')

  let s = await state(U.sales, q)
  assert.deepEqual([s.open, s.may_ask, s.may_answer], [null, true, false])
  await fails(U.sales, 'select public.quotation_request_send($1::uuid, $2::uuid, $3, null)', [q, U.sales2, 'price'], /choose a senior/)
  await fails(U.sales, 'select public.quotation_request_send($1::uuid, $2::uuid, $3, null)', [q, U.sales, 'price'], /choose a senior/)
  await fails(U.sales, 'select public.quotation_request_send($1::uuid, $2::uuid, $3, null)', [q, DESK, 'cheap'], /what you need/)
  await fails(U.sales2, 'select public.quotation_request_send($1::uuid, $2::uuid, $3, null)', [q, DESK, 'price'], /QUOTATION_NOT_FOUND/)
  ok('only a senior can be asked, for price or verify, and only by someone who may edit that quotation')

  const rid = (await send(U.sales, q, DESK, 'price', 'Teak, 56 rooms')).rows[0].r
  s = await state(U.sales, q)
  assert.equal(s.open.to_name, 'Desk Person'); assert.equal(s.open.kind, 'price'); assert.equal(s.open.note, 'Teak, 56 rooms')
  assert.deepEqual([s.may_ask, s.may_answer, s.may_withdraw], [false, false, true])
  await fails(U.sales, 'select public.quotation_request_send($1::uuid, $2::uuid, $3, null)', [q, U.admin, 'verify'], /already with a senior/)
  s = await state(DESK, q)
  assert.deepEqual([s.may_answer, s.may_withdraw], [true, false])
  ok('one open request per quotation; the person asked can answer it, the asker can withdraw it')

  assert.equal((await as(DESK, 'select public.quotation_requests_count() as n')).rows[0].n, 1)
  assert.equal((await as(U.sales, 'select public.quotation_requests_count() as n')).rows[0].n, 0)
  const mine = (await as(U.sales, 'select public.quotation_requests_list() as r')).rows[0].r
  assert.equal(mine.length, 1); assert.equal(mine[0].quote_no.startsWith('QT-MS-'), true); assert.equal(mine[0].client_name, 'Hotel Aravali'); assert.ok(mine[0].lead_no > 0)
  assert.equal((await as(U.sales2, 'select public.quotation_requests_list() as r')).rows[0].r.length, 0)
  assert.equal((await as(U.admin, 'select public.quotation_requests_list() as r')).rows[0].r.length, 1)
  ok('the senior\'s pending count, the asker\'s and the senior\'s lists show it; another salesperson sees nothing; the administrator sees all')

  await fails(U.sales, 'select public.quotation_request_answer($1::uuid, null)', [rid], /QUOTATION_NOT_FOUND/)
  await as(DESK, 'select public.quotation_request_answer($1::uuid, $2)', [rid, 'Priced at the usual teak rate'])
  s = await state(U.sales, q)
  assert.equal(s.open, null); assert.equal(s.last.answer_note, 'Priced at the usual teak rate'); assert.equal(s.last.answered_by_name, 'Desk Person'); assert.equal(s.may_ask, true)
  await fails(DESK, 'select public.quotation_request_answer($1::uuid, null)', [rid], /already closed/)
  const kinds = (await db.query(`select kind from public.quotation_events where quotation_id = $1 and kind in ('asked','answered') order by at`, [q])).rows.map(x => x.kind)
  assert.deepEqual(kinds, ['asked', 'answered'])
  ok('answering closes it, the note comes back to the asker, who may ask again; both steps are on the quotation\'s history')

  const rid2 = (await send(U.sales, q, U.admin, 'verify')).rows[0].r
  await fails(U.sales2, 'select public.quotation_request_withdraw($1::uuid)', [rid2], /QUOTATION_NOT_FOUND/)
  await as(U.sales, 'select public.quotation_request_withdraw($1::uuid)', [rid2])
  assert.equal((await state(U.sales, q)).open, null)
  assert.equal((await as(U.admin, 'select public.quotation_requests_count() as n')).rows[0].n, 0)
  ok('the asker can withdraw; a withdrawn request no longer counts for the senior')

  await rpc(U.sales, 'quotation_set_status', q, 'archived')
  await fails(U.sales, 'select public.quotation_request_send($1::uuid, $2::uuid, $3, null)', [q, DESK, 'price'], /cannot be sent to a senior/)
  await fails(U.nobody, 'select public.quotation_requests_list()', [], /QUOTATIONS_FORBIDDEN/)
  await fails(null, 'select public.quotation_requests_count()', [], /permission denied/, 'anon')
  const direct = await db.query(`select has_table_privilege('authenticated', 'public.quotation_requests', 'SELECT') as t`)
  assert.equal(direct.rows[0].t, false)
  ok('a closed quotation cannot be sent; no access, no answer; signed-out callers and the table itself are closed')
}

// ── 20270814000300: report cards and the price brief ──
{
  const DESK = '00000000-0000-0000-0000-0000000000f6'
  const L1 = '00000000-0000-0000-0000-0000000001a1'
  await db.exec(`
    create table public.pricing_feedback (id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(), created_by uuid,
      source text not null, kind text not null, comment text check (char_length(comment) <= 1000), expected_price numeric(12,2) check (expected_price is null or expected_price > 0),
      line_name text, line_size text, line_material text, line_finish text, line_qty numeric(12,2), client_type text, suggestion jsonb, quotation_id uuid references public.quotations(id) on delete set null,
      status text not null default 'new', handled_by uuid, handled_at timestamptz, handled_note text,
      constraint pricing_feedback_kind_check check (kind in ('too_high', 'too_low', 'wrong_type', 'misread', 'other', 'correction', 'differs_taught')));`)
  await db.exec(mig('20270814000300_quotation_cards_and_briefs.sql'))
  const cards = (uid, person) => as(uid, 'select public.quotation_cards($1::date, $2::date, $3::uuid) as r', ['2020-01-01', '2099-12-31', person ?? null]).then(r => r.rows[0].r)

  const q1 = await rpc(U.sales, 'quotation_start', L1, {})
  await rpc(U.sales, 'quotation_save', q1, { header: { client_name: 'Hotel Aravali', valid_days: 7, gst_mode: 'igst' }, areas: [], lines: [{ name: 'Table', qty_fixed: 5, unit_price: 10000, tax_rate: 18 }] })
  await rpc(U.sales, 'quotation_share', q1, true)
  await as(U.sales, 'select public.quotation_request_send($1::uuid, $2::uuid, $3, $4)', [(await rpc(U.sales, 'quotation_start', L1, {})), DESK, 'price', null])

  let c = await cards(U.sales)
  assert.equal(c.me.person, U.sales); assert.ok(c.me.open_count >= 2); assert.equal(c.me.waiting_senior, 1); assert.ok(c.me.sent >= 1); assert.ok(Number(c.me.value_made) >= 50000)
  assert.equal(c.desk, null); assert.equal(c.team, null)
  ok('a salesperson\'s cards: open, waiting on a senior, made / sent / value for the period; no desk or team block')

  c = await cards(DESK)
  assert.equal(c.desk.waiting, 1); assert.ok(c.desk.oldest_at); assert.ok(c.team.people.length >= 1)
  assert.equal(c.team.top.name, c.team.people[0].name)
  ok('the desk sees its waiting requests and the team block; the top maker is the first of the people')

  c = await cards(U.admin)
  assert.ok(c.team.made >= 2 && Number(c.team.value_made) >= 50000)
  const one = await cards(U.admin, U.sales)
  assert.equal(one.me.person, U.sales); assert.equal(one.me.waiting_senior, 1)
  await fails(U.sales, 'select public.quotation_cards($1::date, $2::date, $3::uuid)', ['2020-01-01', '2099-12-31', U.sales2], /only see your own/)
  await fails(U.nobody, 'select public.quotation_cards($1::date, $2::date, null)', ['2020-01-01', '2099-12-31'], /QUOTATIONS_FORBIDDEN/)
  const none = await as(U.admin, 'select public.quotation_cards($1::date, $2::date, null) as r', ['1999-01-01', '1999-01-02'])
  assert.equal(none.rows[0].r.team.made, 0); assert.equal(none.rows[0].r.team.top, null)
  ok('Admin sees any candidate\'s cards; a salesperson only their own; an empty period gives zeros and no top maker')

  const brief = (uid, id, items) => as(uid, 'select public.quotation_price_briefs_save($1::uuid, $2::jsonb) as r', [id, JSON.stringify(items)]).then(r => r.rows[0].r)
  assert.equal(await brief(DESK, q1, [{ name: 'Table', price: 10000, size: '72x36', material: 'Teak', qty: 5, reason: 'Teak rate 4,200 per cft plus labour' }, { name: 'Chair', price: 5000, reason: '  ' }]), 1)
  const got = (await as(DESK, 'select public.quotation_price_briefs_get($1::uuid) as r', [q1])).rows[0].r
  assert.deepEqual(got, { Table: 'Teak rate 4,200 per cft plus labour' })
  const fb = (await db.query(`select kind, status, source, expected_price::int as p, quotation_id from public.pricing_feedback`)).rows
  assert.deepEqual(fb.map(x => [x.kind, x.status, x.source, x.p, x.quotation_id]), [['price_reason', 'done', 'quotation', 10000, q1]])
  await brief(DESK, q1, [{ name: 'Table', price: 10000, reason: 'Revised: teak at 4,400' }])
  assert.equal((await as(DESK, 'select public.quotation_price_briefs_get($1::uuid) as r', [q1])).rows[0].r.Table, 'Revised: teak at 4,400')
  ok('a brief stores only the products that were explained (as done feedback) and the latest one is read back to pre-fill')

  await fails(U.sales, 'select public.quotation_price_briefs_save($1::uuid, $2::jsonb)', [q1, '[]'], /only the pricing desk/)
  await fails(U.sales, 'select public.quotation_price_briefs_get($1::uuid)', [q1], /only the pricing desk/)
  await fails(DESK, 'select public.quotation_price_briefs_save($1::uuid, $2::jsonb)', [q1, JSON.stringify([{ name: 'Table', price: -5, reason: 'x' }])], /check the brief/)
  await fails(null, 'select public.quotation_cards($1::date, $2::date, null)', ['2020-01-01', '2020-01-02'], /permission denied/, 'anon')
  ok('only the desk can brief a price; a bad price is refused; signed-out callers cannot call any of it')
}

// ── 20270816000000: starting from a lead also copies its contact role into the client type ──
{
  const L1 = '00000000-0000-0000-0000-0000000001a1', L4 = '00000000-0000-0000-0000-0000000001a4'
  await db.exec(`alter table public.sales_leads add column contact_role text; update public.sales_leads set contact_role = 'architect' where id = '${L1}';`)
  await db.exec(mig('20270816000000_quotation_start_contact_role.sql'))
  const type = async lead => (await db.query('select client_type from public.quotations where id = $1', [await rpc(U.sales, 'quotation_start', lead, {})])).rows[0].client_type
  assert.equal(await type(L1), 'architect')
  assert.equal(await type(L4), null)
  const viaCreate = await rpc(U.sales, 'quotation_create', { lead_id: L1 })
  assert.equal((await db.query('select client_type, client_name from public.quotations where id = $1', [viaCreate])).rows[0].client_type, 'architect')
  ok('a quotation started from a lead takes its contact role as the client type (none stays none), also through quotation_create')
}

// ── 20270817000000: deleting a quotation (an unsent draft by its maker, or anything by an administrator) ──
{
  const L1 = '00000000-0000-0000-0000-0000000001a1'
  const DESK = '00000000-0000-0000-0000-0000000000f6'
  const FP = '0123456789abcdef0123456789abcdef'
  // Before the migration: the price history refuses even the cascade from deleting its quotation (why the migration changes the trigger).
  const before = await rpc(U.sales, 'quotation_start', L1, {})
  await db.query(`insert into public.quotation_price_reviews (quotation_id, decision, fingerprint, actor_id) values ($1, 'requested', $2, $3)`, [before, FP, U.sales])
  await assert.rejects(() => db.query('delete from public.quotations where id = $1', [before]), /QUOTATION_PRICE_REVIEWS_APPEND_ONLY/)
  await db.exec(mig('20270817000000_quotation_delete.sql'))
  await db.query('delete from public.quotations where id = $1', [before])
  assert.equal((await db.query('select 1 from public.quotation_price_reviews where quotation_id = $1', [before])).rows.length, 0)
  const start = (uid, owner) => rpc(uid, 'quotation_start', L1, owner ? { owner_id: owner } : {})
  const del = (uid, id) => as(uid, 'select public.quotation_delete($1::uuid)', [id])
  const check = (uid, id) => rpc(uid, 'quotation_delete_check', id)
  const gone = async id => (await db.query('select 1 from public.quotations where id = $1', [id])).rows.length === 0
  const rows = async (t, id) => (await db.query(`select count(*)::int as n from public.${t} where quotation_id = $1`, [id])).rows[0].n
  const addLine = id => db.query(`insert into public.quotation_lines (quotation_id, position, name, qty_fixed, unit_price) values ($1, 0, 'Chair', 4, 5000)`, [id])

  // The maker deletes their own draft: it, its lines and its history go, one record stays, the lead stays.
  const mine = await start(U.sales)
  await addLine(mine)
  assert.deepEqual(await check(U.sales, mine), { may: true, reason: null })
  assert.equal(await rows('quotation_events', mine) > 0, true)
  await del(U.sales, mine)
  assert.equal(await gone(mine), true)
  assert.deepEqual([await rows('quotation_lines', mine), await rows('quotation_events', mine)], [0, 0])
  const log = (await db.query('select * from public.quotation_deletions where quotation_id = $1', [mine])).rows
  assert.equal(log.length, 1)
  assert.deepEqual([log[0].deleted_by, log[0].owner_id, log[0].lead_id, log[0].status, Number(log[0].value_before_gst)], [U.sales, U.sales, L1, 'draft', 20000])
  assert.match(log[0].quote_no, /^QT-MS-\d{5}$/)
  assert.equal((await db.query('select 1 from public.sales_leads where id = $1', [L1])).rows.length, 1)
  ok('the maker deletes their own draft: its lines and history go, one record of who and when stays, the Sales lead is untouched')

  // Somebody else's draft: a plain salesperson cannot see it; a reader and the pricing desk see it and are told no.
  const other = await start(U.sales)
  await fails(U.sales2, 'select public.quotation_delete($1::uuid)', [other], /QUOTATION_NOT_FOUND/)
  await fails(U.manager, 'select public.quotation_delete($1::uuid)', [other], /Only the person who made this quotation/)
  await fails(DESK, 'select public.quotation_delete($1::uuid)', [other], /Only the person who made this quotation/)
  await fails(U.nobody, 'select public.quotation_delete($1::uuid)', [other], /QUOTATIONS_FORBIDDEN/)
  await fails(null, 'select public.quotation_delete($1::uuid)', [other], /permission denied/, 'anon')
  assert.deepEqual(await check(DESK, other), { may: false, reason: 'Only the person who made this quotation, or an administrator, can delete it.' })
  assert.equal(await gone(other), false)
  ok('only the maker (or an administrator) deletes: another salesperson, a reader, the pricing desk, a person with no access and a signed-out caller cannot')

  // Once submitted or shared, the maker can change it but not delete it; the administrator still can.
  const sent = await start(U.sales)
  await rpc(U.sales, 'quotation_set_status', sent, 'sent')
  await fails(U.sales, 'select public.quotation_delete($1::uuid)', [sent], /no longer a draft/)
  const shared = await start(U.sales)
  await db.query(`update public.quotations set share_token = $2, shared_at = now() where id = $1`, [shared, FP])
  await fails(U.sales, 'select public.quotation_delete($1::uuid)', [shared], /shared with the client/)
  await db.query(`update public.quotations set share_token = null where id = $1`, [shared])
  await fails(U.sales, 'select public.quotation_delete($1::uuid)', [shared], /shared with the client/)
  const asked = await start(U.sales)
  const reqId = (await as(U.sales, 'select public.quotation_request_send($1::uuid, $2::uuid, $3, null) as r', [asked, DESK, 'price'])).rows[0].r
  await fails(U.sales, 'select public.quotation_delete($1::uuid)', [asked], /sent to a senior/)
  await as(U.sales, 'select public.quotation_request_withdraw($1::uuid)', [reqId])
  await fails(U.sales, 'select public.quotation_delete($1::uuid)', [asked], /sent to a senior/)
  const priced = await start(U.sales)
  await db.query(`insert into public.quotation_price_reviews (quotation_id, decision, fingerprint, actor_id) values ($1, 'requested', $2, $3)`, [priced, FP, U.sales])
  await fails(U.sales, 'select public.quotation_delete($1::uuid)', [priced], /Price approval was asked/)
  for (const id of [sent, shared, asked, priced]) assert.equal((await check(U.sales, id)).may, false)
  ok('a quotation that was marked sent, shared (even if the link was turned off), sent to a senior (even if taken back) or put to price approval can be changed but not deleted by its maker')

  // The administrator deletes any of them, including one that went through price approval (its history cascades through the append-only trigger).
  await db.query(`insert into public.quotation_price_reviews (quotation_id, decision, fingerprint, actor_id) values ($1, 'approved', $2, $3)`, [priced, FP, U.admin])
  await as(DESK, 'select public.quotation_price_briefs_save($1::uuid, $2::jsonb)', [priced, JSON.stringify([{ name: 'Chair', price: 5000, reason: 'Test reason for the delete check' }])])
  assert.equal((await db.query('select count(*)::int as n from public.pricing_feedback where quotation_id = $1', [priced])).rows[0].n, 1)
  assert.deepEqual(await check(U.admin, priced), { may: true, reason: null })
  for (const id of [sent, shared, asked, priced, other]) { await del(U.admin, id); assert.equal(await gone(id), true) }
  assert.deepEqual([await rows('quotation_price_reviews', priced), await rows('quotation_requests', asked), await rows('quotation_events', sent)], [0, 0, 0])
  assert.equal((await db.query('select count(*)::int as n from public.pricing_feedback where quotation_id = $1', [priced])).rows[0].n, 0)
  assert.equal((await db.query('select count(*)::int as n from public.quotation_deletions')).rows[0].n, 6)
  ok('an administrator deletes a sent, shared, asked, price-approved and someone else\'s quotation too; its requests and price history go; the log holds all six')

  // Still refused: a quotation that became a PI draft, by anybody; a direct change to the price history; anything from a client role.
  const pi = await start(U.sales)
  const sub = (await db.query(`insert into public.order_submissions (created_by) values ($1) returning id`, [U.sales])).rows[0].id
  await db.query(`update public.quotations set pi_submission_id = $2 where id = $1`, [pi, sub])
  await fails(U.admin, 'select public.quotation_delete($1::uuid)', [pi], /confirmed into a PI draft/)
  await fails(U.sales, 'select public.quotation_delete($1::uuid)', [pi], /confirmed into a PI draft/)
  assert.equal((await check(U.admin, pi)).may, false)
  const keep = await start(U.sales)
  await db.query(`insert into public.quotation_price_reviews (quotation_id, decision, fingerprint, actor_id) values ($1, 'requested', $2, $3)`, [keep, FP, U.sales])
  await assert.rejects(() => db.query(`delete from public.quotation_price_reviews where quotation_id = $1`, [keep]), /QUOTATION_PRICE_REVIEWS_APPEND_ONLY/)
  await assert.rejects(() => db.query(`update public.quotation_price_reviews set note = 'x' where quotation_id = $1`, [keep]), /QUOTATION_PRICE_REVIEWS_APPEND_ONLY/)
  await fails(U.sales, 'select * from public.quotation_deletions', [], /permission denied/)
  await fails(U.admin, 'select * from public.quotation_deletions', [], /permission denied/)
  await fails(null, 'select public.quotation_delete_check($1::uuid)', [keep], /permission denied/, 'anon')
  await fails(U.sales2, 'select public.quotation_delete_check($1::uuid)', [keep], /QUOTATION_NOT_FOUND/)
  ok('a PI-linked quotation is never deleted, the price history still refuses a direct change, the deletion record is closed to every client role, and the check hides other people\'s quotations')

  // The list says which rows may be deleted, with the same rule.
  const listFor = async uid => Object.fromEntries((await rpc(uid, 'quotation_list', 'all')).map(r => [r.id, r.may_delete]))
  await rpc(U.sales, 'quotation_set_status', keep, 'sent')
  const draft2 = await start(U.sales)
  const mineList = await listFor(U.sales)
  assert.deepEqual([mineList[pi], mineList[keep], mineList[draft2]], [false, false, true])
  const adminList = await listFor(U.admin)
  assert.deepEqual([adminList[pi], adminList[keep], adminList[draft2]], [false, true, true])
  assert.equal((await listFor(DESK))[draft2], false)
  ok('the list marks may_delete the same way: the maker only for an unsent draft, the administrator for all but a PI-linked one, the pricing desk for none of other people\'s')
}

// ── 20270819000000: fabric and packing costed per product (price per piece; finish stays a code and a picture, no price) ──
await db.exec(mig('20270819000000_quotation_line_costing.sql'))
{
  const L1 = '00000000-0000-0000-0000-0000000001a1'
  const PIC = '00000000-0000-0000-0000-0000000000b2/55555555-1111-1111-1111-111111111111.jpg'
  const id = await rpc(U.sales, 'quotation_start', L1, {})
  const header = { client_name: 'Costing Hotel', valid_days: 7, gst_mode: 'igst', fabric_amount: 4080, packing_amount: 1950 }
  const costing = { fabric: { metres: 1.6, rate: 850 }, packing: { type: 'Carton with foam corners', per_piece: 650 } }
  const choices = { fabric: { source: 'code', status: 'to_confirm', code: 'F-2210' }, finish: { source: 'catalog', status: 'to_confirm', code: 'W-04', photo: PIC } }
  const chair = { name: 'K1 Rocking chair', qty_fixed: 3, unit_price: 22300, tax_rate: 18, costing, client_choices: choices }
  const table = { name: 'K2 Table', qty_fixed: 1, unit_price: 10400, tax_rate: 18 }
  const get = () => rpc(U.sales, 'quotation_get', id)
  const costings = async () => (await get()).lines.map(l => l.costing)

  const saved = await rpc(U.sales, 'quotation_save', id, { header, areas: [], lines: [chair, table] })
  const g = await get()
  assert.deepEqual(g.lines.map(l => l.costing), [costing, {}])
  assert.deepEqual([Number(g.quotation.fabric_amount), Number(g.quotation.packing_amount)], [4080, 1950])
  assert.equal(g.lines[0].client_choices.fabric.source, 'code', 'the new source "client\'s code, we source it" is accepted')
  assert.equal(g.lines[0].client_choices.finish.photo, PIC, 'the finish keeps its code and picture, with no price field')
  assert.equal(Number(saved.value_before_gst), 3 * 22300 + 10400 + 4080 + 1950, 'the two amounts the browser wrote are in the list value, as always')
  ok('save stores each line\'s costing, quotation_get returns it, the browser\'s two sums are in the value before GST, and the fabric source "code" is accepted')

  const { costing: _drop, ...oldChair } = chair
  await rpc(U.sales, 'quotation_save', id, { header, areas: [], lines: [oldChair, table] })
  assert.deepEqual(await costings(), [costing, {}])
  await rpc(U.sales, 'quotation_save', id, { header, areas: [], lines: [table, oldChair] })
  assert.deepEqual(await costings(), [{}, {}])
  ok('a save without the key (an old tab) keeps a line\'s costing only when the same line sits in the same place, never another line\'s')

  await rpc(U.sales, 'quotation_save', id, { header, areas: [], lines: [{ ...chair, costing: {} }, table] })
  assert.deepEqual(await costings(), [{}, {}])
  ok('an empty object clears the costing')

  const bad = [
    { finish: { rate: 5 } },
    { fabric: { metres: '1.6' } },
    { fabric: { metres: 1.666 } },
    { fabric: { metres: 1000 } },
    { fabric: { rate: 850.5 } },
    { fabric: { rate: -1 } },
    { fabric: { rate: 10000001 } },
    { fabric: { cost: 5 } },
    { packing: { per_piece: '600' } },
    { packing: { per_piece: 99999999999 } },
    { packing: { type: 'x'.repeat(81) } },
    { packing: { type: 5 } },
    { packing: { colour: 'red' } },
    [{ fabric: { rate: 1 } }],
  ]
  for (const b of bad) await fails(U.sales, `select public.quotation_save($1::uuid, $2::jsonb)`, [id, { header, areas: [], lines: [{ ...table, costing: b }] }], /QUOTATION_INVALID/)
  await rpc(U.sales, 'quotation_save', id, { header, areas: [], lines: [{ ...table, costing: { fabric: { rate: 0 }, packing: { type: 'x'.repeat(80), per_piece: 0 } } }] })
  ok('unknown keys (a finish price), text where a number belongs, fractions of a rupee, too many decimals of a metre, negative or huge amounts, over-long types are refused; a price of 0 is allowed')

  // the rates never reach the client: the client link and a frozen version list their line fields by name
  await rpc(U.sales, 'quotation_save', id, { header, areas: [], lines: [chair, table] })
  const tok = await rpc(U.sales, 'quotation_share', id, true)
  const pub = JSON.stringify((await as(null, `select public.quotation_public($1) as r`, [tok], 'anon')).rows[0].r)
  for (const leak of ['costing', 'Carton with foam corners', '"rate"', 'per_piece', '"metres"']) assert.ok(!pub.includes(leak), `the client link does not carry ${leak}`)
  const ver = (await db.query(`select doc from public.quotation_versions where quotation_id = $1`, [id])).rows
  assert.ok(ver.length > 0 && ver.every(r => !['costing', 'Carton with foam corners', '"rate"', 'per_piece'].some(w => JSON.stringify(r.doc).includes(w))), 'a frozen version does not carry the costing')
  ok('neither the client link nor a frozen version carries the costing or a rate; only the two sums travel, as they always did')

  await assert.rejects(() => as(null, `select public.quotation_line_costing_ok('{}'::jsonb)`, [], 'anon'), /permission denied/)
  await assert.rejects(() => as(null, `select public.quotation_costing_num_ok('5'::jsonb, 10, 0)`, [], 'anon'), /permission denied/)
  ok('the two checker functions are closed to anyone signed out')
}

// ── 20270820: the client sees the per-piece fabric and packing figures and the packing type, never metres or a rate ──
{
  const L1 = '00000000-0000-0000-0000-0000000001a1'
  const header = { client_name: 'View Hotel', valid_days: 7, gst_mode: 'igst', fabric_amount: 4080, packing_amount: 1950 }
  const costing = { fabric: { metres: 1.6, rate: 850 }, packing: { type: 'Carton with foam corners', per_piece: 650 } }
  const choices = { fabric: { source: 'catalog', status: 'to_confirm', name: 'Berlin velvet' } }
  const chair = { name: 'V1 Rocking chair', qty_fixed: 3, unit_price: 22300, tax_rate: 18, costing, client_choices: choices }
  const table = { name: 'V2 Table', qty_fixed: 1, unit_price: 10400, tax_rate: 18 }
  const make = async (lines) => {
    const id = await rpc(U.sales, 'quotation_start', L1, {})
    await rpc(U.sales, 'quotation_save', id, { header, areas: [], lines })
    return { id, tok: await rpc(U.sales, 'quotation_share', id, true) }
  }
  const pub = async tok => (await as(null, `select public.quotation_public($1) as r`, [tok], 'anon')).rows[0].r
  const before = await make([chair, table]) // v1 is frozen BEFORE the new migration
  await db.exec(mig('20270820000000_quotation_client_costing_view.sql'))
  assert.ok(!JSON.stringify(await pub(before.tok)).includes('costing_view'), 'a version sent before the migration is untouched')
  ok('a version sent before the change still shows no per-piece figures to the client')

  const now = await make([chair, table])
  const doc = await pub(now.tok)
  const [l1, l2] = doc.lines
  assert.deepEqual(l1.costing_view, { fabric: { per: 1360 }, packing: { per: 650, type: 'Carton with foam corners' } })
  assert.equal(l2.costing_view, undefined, 'a product with no costing has no key at all')
  for (const leak of ['"metres"', '"rate"', '"costing"', 'per_piece']) assert.ok(!JSON.stringify(doc).includes(leak), `the client copy does not carry ${leak}`)
  assert.deepEqual([Number(doc.fabric_amount), Number(doc.packing_amount)], [4080, 1950], 'the totals travel as before')
  ok('the next version carries per-piece figures and the packing type, nothing else of the costing, and a line without costing has no key')

  const states = await make([
    { name: 'S1 Own fabric', qty_fixed: 2, unit_price: 1000, tax_rate: 18, client_choices: { fabric: { source: 'client', status: 'to_confirm', name: 'Own linen' } }, costing: { packing: { per_piece: 0 } } },
    { name: 'S2 Code fabric', qty_fixed: 2, unit_price: 1000, tax_rate: 18, client_choices: { fabric: { source: 'code', status: 'to_confirm', code: 'F-2210' } }, costing: { packing: { type: 'Crate' } } },
    { name: 'S3 Rate only', qty_fixed: 2, unit_price: 1000, tax_rate: 18, costing: { fabric: { rate: 700 } } },
    { name: 'S4 Fractions', qty_fixed: 3, unit_price: 1000, tax_rate: 18, client_choices: { fabric: { source: 'catalog', status: 'to_confirm', name: 'V' } }, costing: { fabric: { metres: 1.25, rate: 333 } } },
  ])
  const v = (await pub(states.tok)).lines.map(l => l.costing_view)
  assert.deepEqual(v, [
    { fabric: { free: true }, packing: { per: 0 } },
    { fabric: { wait: true }, packing: { type: 'Crate', wait: true } },
    { fabric: { wait: true } },
    { fabric: { per: 416.25 } },
  ])
  ok('the client\'s own fabric is no charge, a code or a rate without metres waits, packing with a type and no price waits, fractions of a rupee are kept to two decimals')

  await assert.rejects(() => as(null, `select public.quotation_costing_view('{}'::jsonb, '{}'::jsonb)`, [], 'anon'), /permission denied/)
  await assert.rejects(() => as(null, `select public.quotation_client_doc($1::uuid)`, [now.id], 'anon'), /permission denied/)
  ok('the view function and the client document function are closed to anyone signed out')
}

// ── 20270822000000: the Open card counts what the list counts (owner OR maker) ──
{
  const L1 = '00000000-0000-0000-0000-0000000001a1'
  const cards = (uid, person) => as(uid, 'select public.quotation_cards($1::date, $2::date, $3::uuid) as r', ['2020-01-01', '2099-12-31', person ?? null]).then(r => r.rows[0].r)
  const listOpen = async uid => {
    const rows = (await as(uid, `select public.quotation_list('mine') as r`)).rows[0].r.filter(x => ['draft', 'sent', 'negotiating'].includes(x.status))
    return { n: rows.length, v: rows.reduce((t, x) => t + Number(x.value_before_gst || 0), 0) }
  }
  // The owner's real case: an Admin makes a quotation FOR a salesperson (owner = the salesperson, maker = the Admin).
  const forPrerna = await rpc(U.admin, 'quotation_start', L1, { owner_id: U.sales2 })
  await rpc(U.admin, 'quotation_save', forPrerna, { header: { client_name: 'Made for Prerna', valid_days: 7, gst_mode: 'igst' }, areas: [], lines: [{ name: 'Bed', qty_fixed: 2, unit_price: 25000, tax_rate: 18 }] })
  const listed = await listOpen(U.admin)
  const before = await cards(U.admin), beforeTeam = JSON.stringify([before.team, before.desk])
  assert.ok(before.me.open_count < listed.n, 'the old function misses the quotation the Admin made for someone else (the owner\'s 0 beside 3 open)')

  await db.exec(mig('20270822000000_quotation_cards_open_owned_or_made.sql'))
  const after = await cards(U.admin)
  assert.equal(after.me.open_count, listed.n); assert.equal(Number(after.me.open_value), listed.v); assert.ok(Number(after.me.open_value) >= 50000)
  ok('the Open card now equals the list header: quotations the person owns OR made, same open statuses, same value')

  assert.deepEqual({ ...after.me, open_count: 0, open_value: 0 }, { ...before.me, open_count: 0, open_value: 0 })
  assert.equal(JSON.stringify([after.team, after.desk]), beforeTeam)
  ok('nothing else changed: the period numbers, the desk block and the team block still count by owner')

  assert.ok((await cards(U.sales2)).me.open_count >= 1)
  const theirs = await cards(U.admin, U.sales2)
  assert.equal(theirs.me.person, U.sales2); assert.ok(theirs.me.open_count >= 1)
  await rpc(U.admin, 'quotation_set_status', forPrerna, 'archived', null)
  assert.equal((await cards(U.admin)).me.open_count, listed.n - 1)
  ok('the owner still counts it, a drilled-in candidate counts their own, and an archived quotation leaves the card as it leaves the list')

  await fails(U.sales, 'select public.quotation_cards($1::date, $2::date, $3::uuid)', ['2020-01-01', '2099-12-31', U.sales2], /only see your own/)
  await fails(null, 'select public.quotation_cards($1::date, $2::date, null)', ['2020-01-01', '2020-01-02'], /permission denied/, 'anon')
  ok('a salesperson still sees only their own card and a signed-out caller still cannot call it')
}

console.log(`all ${checks} checks passed`)
