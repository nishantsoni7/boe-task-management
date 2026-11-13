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

  create table public.users (id uuid primary key, full_name text, role text not null default 'employee',
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

console.log(`all ${checks} checks passed`)
