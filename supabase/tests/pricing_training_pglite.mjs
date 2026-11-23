// Runs the REAL migration 20270720000000_pricing_training.sql in an in-memory Postgres (PGlite) and checks the rules.
// Run: node supabase/tests/pricing_training_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all N checks passed".
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node supabase/tests/pricing_training_pglite.mjs <dir with @electric-sql/pglite>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const mig = (f) => readFileSync(`${REPO}/supabase/migrations/${f}`, 'utf8').replace(/\r/g, '')

const U = {
  admin: '00000000-0000-0000-0000-0000000000a1',
  teacher: '00000000-0000-0000-0000-0000000000b2', // view + create
  checker: '00000000-0000-0000-0000-0000000000c3', // view + create + approve
  viewer: '00000000-0000-0000-0000-0000000000d4', // view only
  nobody: '00000000-0000-0000-0000-0000000000e5', // no grant
}

const db = new PGlite()
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth; create schema storage;
  grant usage on schema public, auth, storage to anon, authenticated;
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
  create table public.permission_modules (id uuid primary key default gen_random_uuid(), module_key text unique);
  create table public.permission_actions (id uuid primary key default gen_random_uuid(), action_key text unique);
  insert into public.permission_actions (action_key) values ('view'), ('create'), ('edit'), ('approve');
  insert into public.permission_modules (module_key) values ('pricing');
  create table public.module_permission_actions (module_id uuid, action_id uuid, default_allowed boolean, unique (module_id, action_id));
  create table public.role_permissions (role text, module_id uuid, action_id uuid, allowed boolean, unique (role, module_id, action_id));
  insert into public.module_permission_actions select pm.id, pa.id, false from public.permission_modules pm, public.permission_actions pa where pa.action_key = 'view';
  insert into public.role_permissions select 'admin', pm.id, pa.id, true from public.permission_modules pm, public.permission_actions pa where pa.action_key = 'view';
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner_id text);
  alter table storage.objects enable row level security;
  grant all on storage.objects to authenticated;
  insert into public.users (id, full_name, role) values
    ('${U.admin}', 'Admin Person', 'admin'), ('${U.teacher}', 'Teacher', 'employee'), ('${U.checker}', 'Checker', 'employee'),
    ('${U.viewer}', 'Viewer', 'employee'), ('${U.nobody}', 'No Access', 'employee');
  insert into public.grants values
    ('${U.teacher}', 'pricing', 'view'), ('${U.teacher}', 'pricing', 'create'),
    ('${U.checker}', 'pricing', 'view'), ('${U.checker}', 'pricing', 'create'), ('${U.checker}', 'pricing', 'approve'),
    ('${U.viewer}', 'pricing', 'view');
`)
await db.exec(mig('20270720000000_pricing_training.sql'))

let checks = 0
const ok = (name) => { checks++; console.log(`  ok - ${name}`) }
async function as(uid, sql, params = [], role = 'authenticated') {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false); set role ${role};`)
  try { return await db.query(sql, params) } finally { await db.exec('reset role;') }
}
const fails = (uid, sql, params, pattern, role) => assert.rejects(() => as(uid, sql, params, role), pattern)
const rpc = async (uid, fn, ...args) => (await as(uid, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args)).rows[0].r

const DOC = {
  name: 'Dining chair, teak, cane seat', variant: 'Dining chair, cane seat', width_in: 16, depth_in: 18, height_in: 33,
  image_path: `${U.teacher}/11111111-1111-1111-1111-111111111111.jpg`, ai_reading: { category: 'Dining chair' }, sold_price: 6260, notes: 'First small chair',
  lines: [
    { element: 'Frame wood', kind: 'material', material: 'Teak', quantity: 0.81, unit: 'cu ft', rate: 2900, amount: 2349, reasoning: 'With cutting waste', from_ai: true },
    { element: 'Carpenter', kind: 'labour', amount: 650, reasoning: 'Paid per chair' },
    { element: 'Margin', kind: 'margin', amount: 1253 },
  ],
}

{ // closed tables, and who may open the module
  await fails(U.teacher, 'select * from public.pricing_training_cases', [], /permission denied/)
  await fails(U.teacher, `insert into public.pricing_training_lines (case_id, position, element, amount) values (gen_random_uuid(), 1, 'x', 1)`, [], /permission denied/)
  await fails(null, 'select public.pricing_training_access()', [], /permission denied/, 'anon')
  await fails(U.nobody, 'select public.pricing_training_access()', [], /PRICING_TRAINING_FORBIDDEN/)
  await fails(U.teacher, 'select * from public.pricing_training_actor()', [], /permission denied/)
  assert.deepEqual(await rpc(U.teacher, 'pricing_training_access'), { uid: U.teacher, admin: false, create: true, approve: false })
  assert.deepEqual(await rpc(U.admin, 'pricing_training_access'), { uid: U.admin, admin: true, create: true, approve: true })
  ok('tables are closed; access says who may teach and check')
}

let id
{ // teach a case
  await fails(U.viewer, 'select public.pricing_training_save(null, $1)', [DOC], /PRICING_TRAINING_FORBIDDEN/)
  await fails(U.teacher, 'select public.pricing_training_save(null, $1)', [{ ...DOC, name: '  ' }], /PRICING_TRAINING_INVALID/)
  await fails(U.teacher, 'select public.pricing_training_save(null, $1)', [{ ...DOC, lines: [{ element: 'x', kind: 'gift', amount: 1 }] }], /PRICING_TRAINING_INVALID/)
  await fails(U.teacher, 'select public.pricing_training_save(null, $1)', [{ ...DOC, lines: [{ element: 'x', amount: -5 }] }], /PRICING_TRAINING_INVALID/)
  id = await rpc(U.teacher, 'pricing_training_save', null, DOC)
  const c = await rpc(U.teacher, 'pricing_training_get', id)
  assert.equal(c.status, 'draft'); assert.equal(c.lines.length, 3); assert.equal(c.lines[0].from_ai, true); assert.equal(c.lines[1].quantity, null)
  assert.equal(c.may_edit, true); assert.equal(c.may_decide, false); assert.equal(c.created_by_name, 'Teacher')
  assert.equal((await db.query('select count(*)::int n from public.pricing_training_cases')).rows[0].n, 1) // the refused saves left nothing
  ok('a teacher saves a case with free-form elements; bad cases are refused whole')
}

{ // edit rules
  await rpc(U.teacher, 'pricing_training_save', id, { ...DOC, lines: DOC.lines.slice(0, 2) })
  assert.equal((await rpc(U.teacher, 'pricing_training_get', id)).lines.length, 2)
  await fails(U.checker, 'select public.pricing_training_save($1, $2)', [id, DOC], /PRICING_TRAINING_LOCKED/)
  await fails(U.teacher, 'select public.pricing_training_save($1, $2)', ['00000000-0000-0000-0000-000000000000', DOC], /PRICING_TRAINING_NOT_FOUND/)
  const list = await rpc(U.viewer, 'pricing_training_list')
  assert.equal(list.length, 1); assert.equal(Number(list[0].total), 2999); assert.equal(Number(list[0].line_count), 2)
  ok('only the maker changes a draft; everyone with Pricing sees the list and its total')
}

{ // send and check
  const empty = await rpc(U.teacher, 'pricing_training_save', null, { name: 'Empty', lines: [] })
  await fails(U.teacher, 'select public.pricing_training_submit($1)', [empty], /at least one element/)
  await fails(U.checker, 'select public.pricing_training_submit($1)', [id], /PRICING_TRAINING_LOCKED/)
  await fails(U.checker, `select public.pricing_training_decide($1, 'approved', null)`, [id], /not waiting for a check/)
  await rpc(U.teacher, 'pricing_training_submit', id)
  await fails(U.teacher, 'select public.pricing_training_save($1, $2)', [id, DOC], /PRICING_TRAINING_LOCKED/)
  await fails(U.teacher, `select public.pricing_training_decide($1, 'approved', null)`, [id], /PRICING_TRAINING_FORBIDDEN/)
  await fails(U.viewer, `select public.pricing_training_decide($1, 'approved', null)`, [id], /PRICING_TRAINING_FORBIDDEN/)
  await fails(U.checker, `select public.pricing_training_decide($1, 'sent_back', '  ')`, [id], /say what should change/)
  await fails(U.checker, `select public.pricing_training_decide($1, 'deleted', 'x')`, [id], /unknown decision/)
  assert.equal((await rpc(U.checker, 'pricing_training_get', id)).may_decide, true)
  await rpc(U.checker, 'pricing_training_decide', id, 'sent_back', 'Wood quantity looks high')
  let c = await rpc(U.teacher, 'pricing_training_get', id)
  assert.equal(c.status, 'sent_back'); assert.equal(c.decision_note, 'Wood quantity looks high'); assert.equal(c.may_edit, true)
  await rpc(U.teacher, 'pricing_training_save', id, DOC); await rpc(U.teacher, 'pricing_training_submit', id)
  await rpc(U.checker, 'pricing_training_decide', id, 'approved', null)
  c = await rpc(U.teacher, 'pricing_training_get', id)
  assert.equal(c.status, 'approved'); assert.equal(c.decided_by_name, 'Checker'); assert.equal(c.may_edit, false)
  await fails(U.checker, `select public.pricing_training_decide($1, 'rejected', 'again')`, [id], /not waiting for a check/)
  ok('send, send back with a note, fix, send again, approve; an approved case is locked')
}

{ // anyone holding Approve checks any submitted case, their own included
  const own = await rpc(U.checker, 'pricing_training_save', null, DOC); await rpc(U.checker, 'pricing_training_submit', own)
  assert.equal((await rpc(U.checker, 'pricing_training_get', own)).may_decide, true)
  assert.equal((await rpc(U.teacher, 'pricing_training_get', own)).may_decide, false)
  const adm = await rpc(U.admin, 'pricing_training_save', null, DOC); await rpc(U.admin, 'pricing_training_submit', adm)
  await fails(U.teacher, `select public.pricing_training_decide($1, 'approved', null)`, [adm], /PRICING_TRAINING_FORBIDDEN/)
  await rpc(U.admin, 'pricing_training_decide', adm, 'approved', null)
  assert.equal((await rpc(U.admin, 'pricing_training_get', adm)).status, 'approved')
  await rpc(U.checker, 'pricing_training_decide', own, 'approved', null)
  assert.equal((await rpc(U.checker, 'pricing_training_get', own)).status, 'approved')
  ok('Admin approves their own case and the checker approves theirs; a person without Approve approves nobody')
}

{ // conversation
  await fails(U.viewer, 'select public.pricing_training_message($1, $2)', [id, 'hello'], /PRICING_TRAINING_FORBIDDEN/)
  await fails(U.teacher, 'select public.pricing_training_message($1, $2)', [id, '   '], /PRICING_TRAINING_INVALID/)
  await rpc(U.checker, 'pricing_training_message', id, 'Is the finish area the frame only?')
  await rpc(U.teacher, 'pricing_training_message', id, 'Yes, two coats.')
  const m = (await rpc(U.viewer, 'pricing_training_get', id)).messages
  assert.deepEqual(m.map((x) => x.created_by_name), ['Checker', 'Teacher'])
  ok('teachers and checkers can write on a case; viewers read')
}

{ // photos
  const good = `${U.teacher}/22222222-2222-2222-2222-222222222222.jpg`
  await as(U.teacher, `insert into storage.objects (bucket_id, name, owner_id) values ('pricing-training', $1, $2)`, [good, U.teacher])
  await fails(U.teacher, `insert into storage.objects (bucket_id, name, owner_id) values ('pricing-training', $1, $2)`, [`${U.checker}/22222222-2222-2222-2222-222222222222.jpg`, U.teacher], /row-level security/)
  await fails(U.teacher, `insert into storage.objects (bucket_id, name, owner_id) values ('pricing-training', $1, $2)`, [`${U.teacher}/evil.png`, U.teacher], /row-level security/)
  await fails(U.viewer, `insert into storage.objects (bucket_id, name, owner_id) values ('pricing-training', $1, $2)`, [`${U.viewer}/22222222-2222-2222-2222-222222222222.jpg`, U.viewer], /row-level security/)
  const b = (await db.query(`select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'pricing-training'`)).rows[0]
  assert.equal(b.file_size_limit, 4194304); assert.deepEqual(b.allowed_mime_types, ['image/jpeg'])
  ok('a teacher uploads only into their own folder, JPEG only')
}

{ // registration
  const r = await db.query(`select pa.action_key from public.role_permissions rp join public.permission_actions pa on pa.id = rp.action_id
    join public.permission_modules pm on pm.id = rp.module_id where pm.module_key = 'pricing' and rp.role = 'admin' and rp.allowed order by 1`)
  assert.deepEqual(r.rows.map((x) => x.action_key), ['approve', 'create', 'view'])
  await db.exec(mig('20270720000000_pricing_training.sql').replace(/create table public\./g, 'create table if not exists public.').replace(/create index /g, 'create index if not exists '))
  ok('Admin holds view, create and approve; the functions and grants can be applied again')
}

{ // 20270723000000: the wooden structure as one priced row, with an optional wood share
  await db.exec(mig('20270723000000_pricing_training_structure.sql'))
  const S = { name: 'Arm chair, cane back', lines: [
    { element: 'Wooden structure', kind: 'structure', material: 'Teak', amount: 4200, wood_amount: 1600, reasoning: 'Frame, arms and legs made in one go' },
    { element: 'Cane back', kind: 'material', amount: 650 },
  ] }
  const sid = await rpc(U.teacher, 'pricing_training_save', null, S)
  const got = await rpc(U.teacher, 'pricing_training_get', sid)
  assert.equal(got.lines[0].kind, 'structure'); assert.equal(Number(got.lines[0].wood_amount), 1600); assert.equal(got.lines[1].wood_amount, null)
  await fails(U.teacher, 'select public.pricing_training_save(null, $1)', [{ name: 'x', lines: [{ element: 'Wooden structure', kind: 'structure', amount: 4200, wood_amount: 5000 }] }], /PRICING_TRAINING_INVALID/)
  await fails(U.teacher, 'select public.pricing_training_save(null, $1)', [{ name: 'x', lines: [{ element: 'y', kind: 'gift', amount: 1 }] }], /PRICING_TRAINING_INVALID/)
  await rpc(U.teacher, 'pricing_training_save', sid, { name: 'Arm chair, cane back', lines: [{ element: 'Wooden structure', kind: 'structure', amount: 4200 }] })
  assert.equal((await rpc(U.teacher, 'pricing_training_get', sid)).lines[0].wood_amount, null)
  await fails(U.viewer, 'select public.pricing_training_save(null, $1)', [S], /PRICING_TRAINING_FORBIDDEN/)
  await fails(U.teacher, 'select wood_amount from public.pricing_training_lines', [], /permission denied/)
  ok('a wooden structure is one priced row; the wood share is optional and never more than the price')
}

{ // 20270724000000: submitting is what counts, any teacher may change any case, with a history
  await db.exec(`create table public.employee_permission_overrides (user_id uuid, module_id uuid, action_id uuid, allowed boolean);
    insert into public.employee_permission_overrides select '${U.checker}', pm.id, pa.id, true from public.permission_modules pm, public.permission_actions pa where pm.module_key = 'pricing' and pa.action_key = 'approve';`)
  const before = (await db.query(`select status, count(*)::int n from public.pricing_training_cases group by 1`)).rows
  assert.ok(before.some((r) => r.status === 'approved'), 'the old statuses are there to convert')
  await db.exec(mig('20270724000000_pricing_training_submit_counts.sql'))
  const after = (await db.query(`select status, submit_count, count(*)::int n from public.pricing_training_cases group by 1, 2 order by 1, 2`)).rows
  assert.deepEqual([...new Set(after.map((r) => r.status))].sort(), ['draft', 'submitted'])
  assert.ok(after.every((r) => (r.status === 'submitted' ? r.submit_count === 1 : true)))
  assert.equal((await rpc(U.teacher, 'pricing_training_get', id)).status, 'submitted') // it was approved
  assert.deepEqual(await rpc(U.checker, 'pricing_training_access'), { uid: U.checker, admin: false, create: true })
  await fails(U.checker, `select public.pricing_training_decide($1, 'approved', null)`, [id], /does not exist/)
  assert.equal((await db.query(`select count(*)::int n from public.employee_permission_overrides`)).rows[0].n, 0)
  assert.equal((await db.query(`select count(*)::int n from public.module_permission_actions mpa join public.permission_actions pa on pa.id = mpa.action_id where pa.action_key = 'approve'`)).rows[0].n, 0)

  // a new case: saved, submitted, nothing to resubmit, changed by somebody else, resubmitted
  const nid = await rpc(U.teacher, 'pricing_training_save', null, DOC)
  let c = await rpc(U.teacher, 'pricing_training_get', nid)
  assert.equal(c.status, 'draft'); assert.equal(c.submit_count, 0); assert.equal(c.may_edit, true)
  await rpc(U.teacher, 'pricing_training_submit', nid)
  c = await rpc(U.viewer, 'pricing_training_get', nid)
  assert.equal(c.status, 'submitted'); assert.equal(c.submit_count, 1); assert.equal(c.submitted_by_name, 'Teacher'); assert.equal(c.may_edit, false)
  await fails(U.teacher, 'select public.pricing_training_submit($1)', [nid], /nothing has changed/)
  await rpc(U.checker, 'pricing_training_save', nid, { ...DOC, lines: [{ element: 'Wooden structure', kind: 'structure', amount: 4500, wood_amount: 1700 }] })
  c = await rpc(U.teacher, 'pricing_training_get', nid)
  assert.equal(c.status, 'draft'); assert.equal(c.submit_count, 1); assert.equal(c.updated_by_name, 'Checker'); assert.ok(c.submitted_at)
  await rpc(U.checker, 'pricing_training_submit', nid)
  c = await rpc(U.teacher, 'pricing_training_get', nid)
  assert.equal(c.status, 'submitted'); assert.equal(c.submit_count, 2); assert.equal(c.submitted_by_name, 'Checker')
  assert.deepEqual(c.events.map((e) => e.what).sort(), ['saved', 'saved', 'submitted', 'submitted'])
  assert.ok(c.events.some((e) => e.what === 'submitted' && Number(e.total) === 4500 && e.created_by_name === 'Checker'))
  const row = (await rpc(U.viewer, 'pricing_training_list')).find((r) => r.id === nid)
  assert.equal(row.submit_count, 2); assert.equal(row.submitted_by_name, 'Checker')
  await fails(U.viewer, 'select public.pricing_training_save($1, $2)', [nid, DOC], /PRICING_TRAINING_FORBIDDEN/)
  await fails(U.viewer, 'select public.pricing_training_submit($1)', [nid], /PRICING_TRAINING_FORBIDDEN/)
  await fails(U.viewer, 'select public.pricing_training_message($1, $2)', [nid, 'hello'], /PRICING_TRAINING_FORBIDDEN/)
  const blank = await rpc(U.teacher, 'pricing_training_save', null, { name: 'Empty', lines: [] })
  await fails(U.teacher, 'select public.pricing_training_submit($1)', [blank], /at least one element/)
  await fails(U.teacher, 'select * from public.pricing_training_events', [], /permission denied/)
  ok('submit is what counts: old statuses converted, anyone who teaches may change and resubmit any case, with a history')
}

{ // 20270725000000: the wood list
  await db.exec(mig('20270725000000_pricing_woods.sql'))
  await fails(U.teacher, 'select * from public.pricing_woods', [], /permission denied/)
  await fails(U.nobody, 'select public.pricing_woods_list()', [], /PRICING_TRAINING_FORBIDDEN/)
  await fails(U.viewer, 'select public.pricing_wood_save($1, $2)', ['Teak', 2900], /PRICING_WOODS_FORBIDDEN/)
  await rpc(U.teacher, 'pricing_wood_save', 'Teak', 2900)
  await rpc(U.teacher, 'pricing_wood_save', 'Sheesham', null)          // a name with no rate yet
  await rpc(U.checker, 'pricing_wood_save', ' teak ', null)            // the same wood again, no rate given: nothing changes
  let w = await rpc(U.viewer, 'pricing_woods_list')
  assert.deepEqual(w.map((x) => [x.name, x.rate === null ? null : Number(x.rate)]), [['Sheesham', null], ['Teak', 2900]])
  await rpc(U.checker, 'pricing_wood_save', 'TEAK', 3100)              // a new rate, by somebody else
  await rpc(U.teacher, 'pricing_wood_save', 'Sheesham', 2300)
  w = await rpc(U.viewer, 'pricing_woods_list')
  assert.deepEqual(w.map((x) => [x.name, Number(x.rate), x.updated_by_name]), [['Sheesham', 2300, 'Teacher'], ['Teak', 3100, 'Checker']])
  await fails(U.teacher, 'select public.pricing_wood_save($1, $2)', ['T', 100], /PRICING_WOODS_INVALID/)
  await fails(U.teacher, 'select public.pricing_wood_save($1, $2)', ['Oak', 0], /PRICING_WOODS_INVALID/)
  await fails(U.viewer, 'select public.pricing_wood_remove($1)', ['Teak'], /PRICING_WOODS_FORBIDDEN/)
  await rpc(U.teacher, 'pricing_wood_remove', 'teak')
  assert.deepEqual((await rpc(U.viewer, 'pricing_woods_list')).map((x) => x.name), ['Sheesham'])
  ok('the wood list: anyone with Pricing reads it, teachers add, change and remove; one row per wood whatever its capitals')
}

{ // 20270726000000: the library a quotation line picks from
  await db.exec(mig('20270726000000_pricing_training_library.sql'))
  await fails(U.nobody, 'select public.pricing_training_library()', [], /PRICING_FORBIDDEN/)
  await fails(null, 'select public.pricing_training_library()', [], /permission denied/, 'anon')
  await rpc(U.teacher, 'pricing_wood_save', 'Teak', 4600)              // Sheesham is 2300 from the block above
  await rpc(U.teacher, 'pricing_wood_save', 'Mango', null)             // no rate: no price in it
  const doc = { name: 'Library chair', lines: [
    { element: 'Wooden structure', kind: 'structure', material: 'sheesham', amount: 4500, wood_amount: 2300 },
    { element: 'Cane back', kind: 'material', amount: 1000 }] }
  const draft = await rpc(U.teacher, 'pricing_training_save', null, doc)
  const before = (await rpc(U.viewer, 'pricing_training_library')).cases
  assert.ok(!before.some((c) => c.id === draft), 'a case that is only saved is not in the library')
  await rpc(U.teacher, 'pricing_training_submit', draft)
  const lib = await rpc(U.viewer, 'pricing_training_library')
  assert.deepEqual(lib.woods, ['Mango', 'Sheesham', 'Teak'])
  const c = lib.cases.find((x) => x.id === draft)
  assert.equal(Number(c.total), 5500)
  assert.deepEqual(c.in_wood, { teak: 7800 })                          // 5500 - 2300 + 2300 x 4600 / 2300
  assert.equal(c.lines.length, 2)
  await db.exec(`insert into public.grants values ('${U.nobody}', 'quotations', 'view')`)
  const sales = (await rpc(U.nobody, 'pricing_training_library')).cases.find((x) => x.id === draft)
  assert.equal(Number(sales.total), 5500)
  assert.equal(sales.lines, undefined)                                 // no Pricing access: the price, never its elements
  assert.ok(!JSON.stringify(sales).includes('4600'), 'no wood rate leaves the database')
  ok('the library: submitted cases only, the price in another wood, elements only for people with Pricing')
}

{ // 20270727000000: the elements a line may leave out or borrow
  await db.exec(mig('20270727000000_pricing_training_library_parts.sql'))
  const sales = (await rpc(U.nobody, 'pricing_training_library')).cases.find((x) => x.name === 'Library chair')
  assert.deepEqual(sales.parts.map((p) => [p.element, p.kind, Number(p.amount)]), [['Cane back', 'material', 1000]])   // never the structure
  assert.equal(sales.lines, undefined)
  assert.deepEqual(sales.in_wood, { teak: 7800 })
  assert.equal((await rpc(U.viewer, 'pricing_training_library')).cases.find((x) => x.name === 'Library chair').lines.length, 2)
  ok('the library sends the elements a line may leave out: material, labour and other, never structure, overhead or margin')
}

{ // 20270729000000: the watcher. The tables it touches belong to other migrations, so the least of each stands in here.
  await db.exec(`
    create table public.quotations (id uuid primary key default gen_random_uuid(), quote_no text, status text, owner_id uuid, updated_at timestamptz default now());
    create table public.quotation_lines (id uuid primary key default gen_random_uuid(), quotation_id uuid references public.quotations(id), name text, material text, spec text, finish text, unit_price bigint, internal_note text);
    create table public.pricing_feedback (id uuid primary key default gen_random_uuid(), kind text not null check (kind in ('too_high', 'too_low', 'wrong_type', 'misread', 'other', 'correction')));
    alter table public.quotations enable row level security; alter table public.quotation_lines enable row level security; alter table public.pricing_feedback enable row level security;
    revoke all on public.quotations, public.quotation_lines, public.pricing_feedback from anon, authenticated;
    insert into public.quotations (id, quote_no, status, owner_id) values ('00000000-0000-0000-0000-00000000aaaa', 'Q-1', 'sent', '${U.teacher}');
    insert into public.quotation_lines (quotation_id, name, unit_price, internal_note) values
      ('00000000-0000-0000-0000-00000000aaaa', 'Chair C - 1', 5000, 'Darker [Taught case #7; without Cane back; why Quantity discount]'),
      ('00000000-0000-0000-0000-00000000aaaa', 'Chair C - 2', 0, '[Taught case #7]'),
      ('00000000-0000-0000-0000-00000000aaaa', 'Table', 9000, 'no pick here');
  `)
  await assert.rejects(() => db.exec("insert into public.pricing_feedback (kind) values ('differs_taught')"), /pricing_feedback_kind_check/)
  await db.exec(mig('20270729000000_pricing_taught_watcher.sql'))
  await db.exec("insert into public.pricing_feedback (kind) values ('differs_taught'), ('too_high')")
  await assert.rejects(() => db.exec("insert into public.pricing_feedback (kind) values ('gift')"), /pricing_feedback_kind_check/)
  await fails(U.nobody, 'select public.pricing_taught_quotes()', [], /PRICING_TRAINING_FORBIDDEN/)
  await fails(null, 'select public.pricing_taught_quotes()', [], /permission denied/, 'anon')
  const q = await rpc(U.viewer, 'pricing_taught_quotes')
  assert.deepEqual(q.map((x) => [x.quote_no, x.name, Number(x.unit_price), x.owner_name]), [['Q-1', 'Chair C - 1', 5000, 'Teacher']])   // priced lines with a pick only
  ok('the watcher: feedback accepts differs_taught, and Pricing people read the priced lines that picked a taught product')
}

{ // 20270823000000: elements worked out by calculators, what a price is, metals and dated rates
  await db.exec(mig('20270823000000_pricing_calculators.sql'))
  const old = await rpc(U.teacher, 'pricing_training_get', id)
  assert.equal(old.price_level, 'selling'); assert.deepEqual(old.includes, []); assert.equal(old.per_set, null)
  assert.ok(old.lines.every((l) => l.calc === null))
  let h = await rpc(U.viewer, 'pricing_rate_history_list')
  assert.deepEqual(h.map((x) => [x.kind, x.name, Number(x.rate)]).sort(), [['wood', 'Sheesham', 2300], ['wood', 'Teak', 4600]]) // today's rates are the first entries
  const m = await rpc(U.viewer, 'pricing_metals_list')
  assert.deepEqual(m.map((x) => [x.name, Number(x.density), x.rate]), [['MS bar and flat', 7850, null], ['MS sheet', 7850, null], ['MS tube and pipe', 7850, null]])
  ok('existing cases read as a selling price per piece; the rate history starts with today\'s wood rates; three MS metals without rates')
}

{ // metals and the rate history
  await fails(U.viewer, 'select public.pricing_metal_save($1, $2, $3)', ['MS tube and pipe', null, 75], /PRICING_METALS_FORBIDDEN/)
  await fails(U.viewer, 'select public.pricing_metal_remove($1)', ['MS sheet'], /PRICING_METALS_FORBIDDEN/)
  await rpc(U.teacher, 'pricing_metal_save', 'ms tube and pipe', null, 75)
  await rpc(U.checker, 'pricing_metal_save', 'MS TUBE AND PIPE', null, 78)
  await rpc(U.teacher, 'pricing_metal_save', 'MS tube and pipe', 7850, null)   // the density again, the rate untouched: no history row
  await rpc(U.teacher, 'pricing_metal_save', 'SS 304 tube', 7900, null)        // a new metal without a rate: no history row
  await fails(U.teacher, 'select public.pricing_metal_save($1, $2, $3)', ['S', 7900, 10], /PRICING_METALS_INVALID/)
  await fails(U.teacher, 'select public.pricing_metal_save($1, $2, $3)', ['Gold leaf', 100, 10], /PRICING_METALS_INVALID/)
  await fails(U.teacher, 'select public.pricing_metal_save($1, $2, $3)', ['MS sheet', null, 0], /PRICING_METALS_INVALID/)
  await rpc(U.teacher, 'pricing_wood_save', 'Teak', 4800)
  await rpc(U.teacher, 'pricing_wood_save', 'teak', 4800)                     // the same rate again: no history row
  const h = await rpc(U.viewer, 'pricing_rate_history_list')
  assert.deepEqual(h.slice(0, 3).map((x) => [x.kind, x.name, Number(x.rate), x.set_by_name]),
    [['wood', 'Teak', 4800, 'Teacher'], ['metal', 'MS tube and pipe', 78, 'Checker'], ['metal', 'MS tube and pipe', 75, 'Teacher']])
  assert.equal(h.length, 5)
  const tube = (await rpc(U.viewer, 'pricing_metals_list')).find((x) => x.name === 'MS tube and pipe')
  assert.deepEqual([Number(tube.density), Number(tube.rate), tube.updated_by_name], [7850, 78, 'Teacher'])
  await rpc(U.teacher, 'pricing_metal_remove', 'ss 304 TUBE')
  assert.ok(!(await rpc(U.viewer, 'pricing_metals_list')).some((x) => x.name === 'SS 304 tube'))
  await fails(U.teacher, 'select * from public.pricing_metals', [], /permission denied/)
  await fails(U.teacher, 'select * from public.pricing_rate_history', [], /permission denied/)
  await fails(U.teacher, `insert into public.pricing_rate_history (kind, name, rate) values ('wood', 'x', 1)`, [], /permission denied/)
  await fails(null, 'select public.pricing_metals_list()', [], /permission denied/, 'anon')
  await fails(null, 'select public.pricing_rate_history_list()', [], /permission denied/, 'anon')
  await fails(U.nobody, 'select public.pricing_rate_history_list()', [], /PRICING_TRAINING_FORBIDDEN/)
  ok('metals: Pricing reads, teachers change; every new or different rate is kept with who and when; nothing else writes the history')
}

{ // a case with worked-out elements, a metal frame, and what its price is
  const C = { name: 'Set of 2 coffee tables', price_level: 'cost', includes: ['packing', 'delivery', 'packing'], per_set: 2, width_in: 36, depth_in: 36, height_in: 24, lines: [
    { element: 'Top and sides', kind: 'material', quantity: 33, unit: 'sq ft', rate: 200, amount: 6600, calc: { type: 'area', faces: 'top_sides', rate: 200 } },
    { element: 'Frame', kind: 'metal', amount: 553, calc: { type: 'metal', metal: 'MS tube and pipe', density: 7850, rate: 75, parts: [{ profile: 'sqtube', a: 25, t: 1.6, length: 0.75, length_unit: 'm', qty: 4 }] } },
    { element: 'Margin', kind: 'margin', amount: 2146, calc: { type: 'percent', pct: 30, of: 'cost' } },
  ] }
  const save = 'select public.pricing_training_save(null, $1)'
  await fails(U.teacher, save, [{ ...C, price_level: 'wholesale' }], /PRICING_TRAINING_INVALID/)
  await fails(U.teacher, save, [{ ...C, includes: ['gst'] }], /PRICING_TRAINING_INVALID/)
  await fails(U.teacher, save, [{ ...C, per_set: 1 }], /PRICING_TRAINING_INVALID/)
  await fails(U.teacher, save, [{ ...C, per_set: '2.5' }], /PRICING_TRAINING_INVALID/)
  await fails(U.teacher, save, [{ ...C, lines: [{ element: 'x', amount: 1, calc: { type: 'magic' } }] }], /PRICING_TRAINING_INVALID/)
  await fails(U.teacher, save, [{ ...C, lines: [{ element: 'x', amount: 1, calc: { type: 'wood', parts: Array.from({ length: 41 }, () => ({})) } }] }], /PRICING_TRAINING_INVALID/)
  await fails(U.teacher, save, [{ ...C, lines: [{ element: 'x', kind: 'steel', amount: 1 }] }], /PRICING_TRAINING_INVALID/)
  const before = (await db.query('select count(*)::int n from public.pricing_training_cases')).rows[0].n
  const cid = await rpc(U.teacher, 'pricing_training_save', null, C)
  assert.equal((await db.query('select count(*)::int n from public.pricing_training_cases')).rows[0].n, before + 1) // the refused saves left nothing
  let got = await rpc(U.viewer, 'pricing_training_get', cid)
  assert.equal(got.price_level, 'cost'); assert.deepEqual(got.includes, ['delivery', 'packing']); assert.equal(got.per_set, 2)
  assert.deepEqual(got.lines.map((l) => [l.kind, l.calc?.type ?? null]), [['material', 'area'], ['metal', 'metal'], ['margin', 'percent']])
  assert.equal(got.lines[1].calc.parts[0].profile, 'sqtube')
  await rpc(U.teacher, 'pricing_training_submit', cid)
  const lib = (await rpc(U.nobody, 'pricing_training_library')).cases.find((x) => x.id === cid)
  assert.equal(Number(lib.total), 9299)
  assert.deepEqual(lib.parts.map((p) => p.element), ['Top and sides'])                // never the frame or the margin
  assert.equal(lib.lines, undefined)
  // a screen that does not send the new fields saves a selling price per piece, with no calc
  await rpc(U.teacher, 'pricing_training_save', cid, { name: 'Plain', lines: [{ element: 'x', amount: 5, calc: 'wood' }] })
  got = await rpc(U.teacher, 'pricing_training_get', cid)
  assert.equal(got.price_level, 'selling'); assert.deepEqual(got.includes, []); assert.equal(got.per_set, null); assert.equal(got.lines[0].calc, null)
  ok('a case keeps how each element was worked out and what its price is; bad cases are refused whole; the library is unchanged for a metal frame')
}

console.log(`all ${checks} checks passed`)
