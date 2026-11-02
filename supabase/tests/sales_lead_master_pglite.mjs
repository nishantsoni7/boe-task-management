// Database regression suite for 20270524000000 (Sales, Lead Master). Runs the REAL migration in an in-memory
// Postgres (PGlite) over small stubs of the platform objects it depends on (users, auth.uid(), module_entry_open,
// resolve_permission), plus the REAL phone normaliser (20270305000000) and the REAL sales-candidate rule
// (20260697000000), and the REAL registration of the Sales module (20270515000000). Run:
//   node supabase/tests/sales_lead_master_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all N checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node sales_lead_master_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const mig = f => readFileSync(`${REPO}/supabase/migrations/${f}`, 'utf8').replace(/\r/g, '')

// Lifts one function, as the real migration wrote it, out of an older migration.
function extract(text, fnName) {
  const lines = text.split('\n')
  const start = lines.findIndex(l => l.toLowerCase().startsWith(`create or replace function public.${fnName.toLowerCase()}(`))
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

const U = {
  admin:    '00000000-0000-0000-0000-0000000000a1', // role admin: holds everything with no grant
  viewer:   '00000000-0000-0000-0000-0000000000b1', // view
  creator:  '00000000-0000-0000-0000-0000000000b2', // view + create
  editor:   '00000000-0000-0000-0000-0000000000b3', // view + edit
  assigner: '00000000-0000-0000-0000-0000000000b4', // view + assign
  nobody:   '00000000-0000-0000-0000-0000000000b5', // no grant at all
  mohit:    '00000000-0000-0000-0000-0000000000c1', // sales team, active
  dhruv:    '00000000-0000-0000-0000-0000000000c2', // sales team, active
  ops:      '00000000-0000-0000-0000-0000000000c3', // not in the sales team, no sales-candidate grant
  gone:     '00000000-0000-0000-0000-0000000000c4', // sales team but inactive
}

const db = new PGlite()
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth;
  grant usage on schema public, auth to anon, authenticated;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

  create table public.users (id uuid primary key, full_name text, role text not null default 'employee',
    team text, is_active boolean not null default true);
  create table public.grants (user_id uuid, module_key text, action_key text);
  -- Like the real ones, these two read tables a browser role cannot, so they run with the owner's rights.
  create function public.resolve_permission(p_uid uuid, p_module text, p_action text) returns boolean
    language sql stable security definer as $$ select exists (select 1 from public.grants g where g.user_id = p_uid and g.module_key = p_module and g.action_key = p_action) $$;
  -- The real rule is "Admin, or effective <module>:view" (20260905000000).
  create function public.module_entry_open(p text) returns boolean language sql stable security definer as
    $$ select exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
          or public.resolve_permission(auth.uid(), p, 'view') $$;

  create table public.app_modules (module_key text primary key, module_name text, description text, route_path text,
    visibility_type text, allowed_department text, sort_order int);
  create table public.permission_modules (id uuid primary key default gen_random_uuid(), module_key text unique, display_name text, description text);
  create table public.permission_actions (id uuid primary key default gen_random_uuid(), action_key text unique);
  insert into public.permission_actions (action_key) values ('view'), ('create'), ('edit'), ('assign');
  create table public.module_permission_actions (module_id uuid, action_id uuid, default_allowed boolean, unique (module_id, action_id));
  create table public.role_permissions (role text, module_id uuid, action_id uuid, allowed boolean, unique (role, module_id, action_id));

  insert into public.users (id, full_name, role, team, is_active) values
    ('${U.admin}', 'Nishant Soni', 'admin', null, true),
    ('${U.viewer}', 'Vera Viewer', 'employee', null, true), ('${U.creator}', 'Chitra Creator', 'employee', null, true),
    ('${U.editor}', 'Esha Editor', 'employee', null, true), ('${U.assigner}', 'Anil Assigner', 'employee', null, true),
    ('${U.nobody}', 'No Access', 'employee', null, true),
    ('${U.mohit}', 'Mohit', 'employee', 'sales', true), ('${U.dhruv}', 'Dhruv', 'employee', 'sales', true),
    ('${U.ops}', 'Ops Person', 'employee', 'operations', true), ('${U.gone}', 'Gone Person', 'employee', 'sales', false);
  insert into public.grants values
    ('${U.viewer}', 'sales', 'view'),
    ('${U.creator}', 'sales', 'view'), ('${U.creator}', 'sales', 'create'),
    ('${U.editor}', 'sales', 'view'), ('${U.editor}', 'sales', 'edit'),
    ('${U.assigner}', 'sales', 'view'), ('${U.assigner}', 'sales', 'assign');
`)
await db.exec(extract(mig('20270305000000_exhibition_leads.sql'), 'normalize_lead_phone'))
await db.exec(extract(mig('20260697000000_order_request_assignee_eligibility.sql'), 'is_eligible_order_assignee'))
await db.exec(`
  grant execute on function public.normalize_lead_phone(text), public.is_eligible_order_assignee(uuid),
    public.module_entry_open(text), public.resolve_permission(uuid, text, text) to authenticated;
`)

// The registration the module was born with, then the migration under test, both whole.
await db.exec(mig('20270515000000_register_sales_marketing_pricing_modules.sql'))
await db.exec(mig('20270524000000_sales_lead_master.sql'))

let checks = 0
const ok = (name) => { checks++; console.log(`  ok - ${name}`) }

async function as(uid, sql, params = []) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false); set role authenticated;`)
  try { return await db.query(sql, params) } finally { await db.exec('reset role;') }
}
const rpc = async (uid, fn, ...args) => {
  const ph = args.map((_, i) => `$${i + 1}`).join(', ')
  const r = await as(uid, `select public.${fn}(${ph}) as r`, args)
  return r.rows[0].r
}
const refused = (uid, fn, ...args) => assert.rejects(() => rpc(uid, fn, ...args), /SALES_FORBIDDEN|permission denied/)
const create = (uid, phone, source = 'website', name = null, email = null, loc = null, req = null) =>
  rpc(uid, 'create_sales_lead', phone, source, name, email, loc, req)
const rows = async (sql, params = []) => (await db.query(sql, params)).rows
const one = async (sql, params = []) => (await rows(sql, params))[0]

// ── 1. Registration ──────────────────────────────────────────────────────────
{
  const r = await rows(`select pa.action_key, mpa.default_allowed,
      exists (select 1 from public.role_permissions rp where rp.module_id = mpa.module_id and rp.action_id = mpa.action_id and rp.role = 'admin' and rp.allowed) as admin_holds
    from public.module_permission_actions mpa join public.permission_modules pm on pm.id = mpa.module_id
    join public.permission_actions pa on pa.id = mpa.action_id where pm.module_key = 'sales' order by pa.action_key`)
  assert.deepEqual(r.map(x => x.action_key), ['assign', 'create', 'edit', 'view'])
  assert.ok(r.every(x => x.default_allowed === false && x.admin_holds === true))
  ok('Sales has view, create, edit and assign; the Admin role holds all four; none is on by default')
  const d = await one(`select description from public.permission_modules where module_key = 'sales'`)
  assert.equal(d.description, 'Sales: the Lead Master, every lead and who holds it.')
  assert.equal((await one(`select description from public.app_modules where module_key = 'sales'`)).description, d.description)
  ok('the module description says what it is for, in both tables')
}

// ── 2. A browser cannot write, and the gate holds ────────────────────────────
await assert.rejects(() => as(U.admin, `insert into public.sales_leads (phone_e164, source) values ('+919000000001', 'website')`), /permission denied/)
await assert.rejects(() => as(U.admin, `update public.sales_leads set name = 'x'`), /permission denied/)
await assert.rejects(() => as(U.admin, `insert into public.sales_lead_events (lead_id, kind) values (gen_random_uuid(), 'added')`), /permission denied/)
ok('no browser role can write either table directly, not even Admin')

await refused(U.nobody, 'sales_leads_page')
await refused(U.nobody, 'sales_lead_phone_check', '9876543210')
await refused(U.nobody, 'get_sales_lead', crypto.randomUUID())
await refused(null, 'sales_leads_page')
ok('somebody without Sales view, and somebody not signed in, can read nothing')

await refused(U.viewer, 'create_sales_lead', '9876543210', 'website', null, null, null, null)
await refused(U.viewer, 'update_sales_lead', crypto.randomUUID(), '9876543210', 'website', null, null, null, null)
await refused(U.viewer, 'allot_sales_lead', crypto.randomUUID(), U.mohit, null)
ok('a viewer can read but cannot add, edit or allot')

await assert.rejects(() => as(U.admin, `select public.sales_leads_require('view')`), /permission denied/)
ok('the internal gate is not callable from a browser')

// ── 3. Adding a lead ─────────────────────────────────────────────────────────
const today = (await one(`select (now() at time zone 'Asia/Kolkata')::date::text as d`)).d
let first
{
  first = await create(U.creator, '098765 43210', 'whatsapp', '  Rohan Mehta ', 'ROHAN@Example.com ', 'Jaipur', 'Six chairs')
  assert.equal(first.status, 'created')
  assert.equal(first.lead.phone, '+919876543210')
  assert.equal(first.lead.lead_no, 1)
  assert.equal(first.lead.received_on, today)
  assert.equal(first.lead.assigned_to, null)
  assert.equal(first.lead.holder_name, null)
  assert.equal(first.lead.name, 'Rohan Mehta')
  assert.equal(first.lead.email, 'rohan@example.com')
  ok('a new lead is saved in one number format, with today\'s India date, trimmed, and NOT allotted')
}
{
  const ev = await rows(`select kind, actor::text from public.sales_lead_events where lead_id = $1`, [first.lead.id])
  assert.deepEqual(ev.map(e => e.kind), ['added'])
  assert.equal(ev[0].actor, U.creator)
  ok('the history starts with "added", by the person who added it')
}
for (const same of ['9876543210', '+91 98765 43210', '+91-98765-43210', '0 98765 43210', '919876543210', '(098765) 43210']) {
  const r = await create(U.creator, same, 'website')
  assert.equal(r.status, 'duplicate', `${same} is the same number`)
  assert.equal(r.lead.lead_no, 1)
}
assert.equal((await one(`select count(*)::int as n from public.sales_leads`)).n, 1)
ok('the same number typed six different ways is always the one lead, and nothing extra is saved')
{
  const asAdmin = await create(U.admin, '+91 98765 43210', 'website')
  assert.equal(asAdmin.status, 'duplicate')
  ok('Admin gets the same refusal: the register has one lead per number')
}

for (const bad of ['12345', '5876543210', '+91 12345 67890', 'abcdefghij', '', '+0123456789']) {
  await assert.rejects(() => create(U.creator, bad, 'website'), /SALES_INVALID/, `${bad} must be refused`)
}
ok('a number that is not valid is refused (too short, an Indian number not starting 6-9, letters, empty, a leading +0)')
{
  const r = await create(U.creator, '+971 56 732 3638', 'website', 'Fatima')
  assert.equal(r.status, 'created')
  assert.equal(r.lead.phone, '+971567323638')
  const r2 = await create(U.creator, '00971567323638', 'website')
  assert.equal(r2.status, 'duplicate')
  ok('an international number is accepted as +<digits>, and 00 and + forms are the same number')
}
await assert.rejects(() => create(U.creator, '9000000001', 'telegram'), /SALES_INVALID/)
await assert.rejects(() => create(U.creator, '9000000001', 'website', null, 'not an email'), /SALES_INVALID/)
await assert.rejects(() => create(U.creator, '9000000001', 'website', 'x'.repeat(121)), /SALES_INVALID/)
await assert.rejects(() => create(U.creator, '9000000001', 'website', null, null, null, 'y'.repeat(4001)), /SALES_INVALID/)
assert.equal((await one(`select count(*)::int as n from public.sales_leads where phone_e164 = '+919000000001'`)).n, 0)
ok('an unknown source, a bad email and over-long text are refused with nothing saved')
{
  const r = await create(U.creator, '9000000002', 'insta_promo')
  assert.equal(r.status, 'created')
  assert.equal(r.lead.name, null); assert.equal(r.lead.email, null); assert.equal(r.lead.location, null); assert.equal(r.lead.requirement, null)
  const r3 = await create(U.creator, '9000000003', 'campaign', '   ', '  ', '', '  ')
  assert.equal(r3.lead.name, null); assert.equal(r3.lead.requirement, null)
  ok('only the number and the source are needed; blank optional fields are stored as nothing')
}

{
  // The numbers people say aloud must not have a gap for every duplicate that was refused.
  const a = await create(U.creator, '9444444441', 'website')
  for (let i = 0; i < 3; i++) assert.equal((await create(U.creator, '+91 94444 44441', 'website')).status, 'duplicate')
  const b = await create(U.creator, '9444444442', 'website')
  assert.equal(b.lead.lead_no, a.lead.lead_no + 1)
  ok('a refused duplicate does not use up a lead number: the next lead is the next number')
}

// ── 4. The live check on the form ────────────────────────────────────────────
{
  assert.deepEqual(await rpc(U.viewer, 'sales_lead_phone_check', 'nonsense'), { state: 'invalid' })
  assert.deepEqual(await rpc(U.viewer, 'sales_lead_phone_check', '9111122222'), { state: 'free', phone: '+919111122222' })
  const hit = await rpc(U.viewer, 'sales_lead_phone_check', '+91 98765 43210')
  assert.equal(hit.state, 'exists')
  assert.equal(hit.lead.lead_no, 1)
  assert.equal(hit.lead.received_on, today)
  assert.equal(hit.lead.holder_name, null)
  ok('the live check says invalid, free, or exists with the lead, its date and who holds it (nobody yet)')
}

// ── 5. Allotting ─────────────────────────────────────────────────────────────
{
  const r = await rpc(U.assigner, 'allot_sales_lead', first.lead.id, U.mohit, null)
  assert.equal(r.status, 'saved')
  assert.equal(r.lead.assigned_to, U.mohit)
  assert.equal(r.lead.holder_name, 'Mohit')
  ok('the first allotment needs only the assign right and saves at once')
  const ev = await rows(`select kind, from_user::text, to_user::text, actor::text from public.sales_lead_events where lead_id = $1 order by at, kind`, [first.lead.id])
  const allotted = ev.find(e => e.kind === 'allotted')
  assert.ok(allotted); assert.equal(allotted.from_user, null); assert.equal(allotted.to_user, U.mohit); assert.equal(allotted.actor, U.assigner)
  ok('the history records "allotted", to whom, and by whom')
  const dup = await create(U.creator, '9876543210', 'website')
  assert.equal(dup.status, 'duplicate'); assert.equal(dup.lead.holder_name, 'Mohit'); assert.equal(dup.lead.assigned_at !== null, true)
  ok('a duplicate now names who holds the lead and when it was given to them')
}
{
  await assert.rejects(() => rpc(U.assigner, 'allot_sales_lead', first.lead.id, U.dhruv, null), /SALES_CHANGED/)
  assert.equal((await one(`select assigned_to::text as a from public.sales_leads where id = $1`, [first.lead.id])).a, U.mohit)
  ok('a stale screen cannot change a name: it said "not allotted" but Mohit already held it, so nothing changed')
  const r = await rpc(U.assigner, 'allot_sales_lead', first.lead.id, U.dhruv, U.mohit)
  assert.equal(r.status, 'saved'); assert.equal(r.lead.holder_name, 'Dhruv')
  const ev = await one(`select kind, from_user::text as f, to_user::text as t from public.sales_lead_events where lead_id = $1 order by at desc, kind limit 1`, [first.lead.id])
  assert.equal(ev.kind, 'reassigned'); assert.equal(ev.f, U.mohit); assert.equal(ev.t, U.dhruv)
  ok('a change made with the right "who I saw" is saved as "reassigned", from Mohit to Dhruv')
  const same = await rpc(U.assigner, 'allot_sales_lead', first.lead.id, U.dhruv, U.dhruv)
  assert.equal(same.status, 'unchanged')
  const n = (await one(`select count(*)::int as n from public.sales_lead_events where lead_id = $1`, [first.lead.id])).n
  assert.equal(n, 3)
  ok('choosing the person who already holds it changes nothing and adds nothing to the history')
}
await assert.rejects(() => rpc(U.assigner, 'allot_sales_lead', first.lead.id, U.ops, U.dhruv), /SALES_INVALID/)
await assert.rejects(() => rpc(U.assigner, 'allot_sales_lead', first.lead.id, U.gone, U.dhruv), /SALES_INVALID/)
await assert.rejects(() => rpc(U.assigner, 'allot_sales_lead', first.lead.id, null, U.dhruv), /SALES_INVALID/)
await assert.rejects(() => rpc(U.assigner, 'allot_sales_lead', first.lead.id, crypto.randomUUID(), U.dhruv), /SALES_INVALID/)
ok('only a sales candidate can be chosen: not someone outside Sales, not an inactive person, not nobody, not a stranger')
await assert.rejects(() => rpc(U.assigner, 'allot_sales_lead', crypto.randomUUID(), U.mohit, null), /SALES_NOT_FOUND/)
await refused(U.creator, 'allot_sales_lead', first.lead.id, U.mohit, U.dhruv)
await refused(U.editor, 'allot_sales_lead', first.lead.id, U.mohit, U.dhruv)
ok('creating or editing does not carry the right to allot')
{
  const second = (await create(U.creator, '9000000010', 'reference')).lead
  const r = await rpc(U.admin, 'allot_sales_lead', second.id, U.mohit, null)
  assert.equal(r.lead.holder_name, 'Mohit')
  ok('Admin can allot without any grant')
}

// ── 6. Correcting a lead ─────────────────────────────────────────────────────
{
  await refused(U.creator, 'update_sales_lead', first.lead.id, '9876543210', 'whatsapp', 'x', null, null, null)
  ok('adding a lead does not carry the right to edit one')
  const r = await rpc(U.editor, 'update_sales_lead', first.lead.id, '+91 98765 43210', 'whatsapp', 'Rohan M. Mehta', 'rohan@example.com', 'Jaipur', 'Six chairs')
  assert.equal(r.status, 'saved'); assert.equal(r.lead.name, 'Rohan M. Mehta')
  assert.equal(r.lead.holder_name, 'Dhruv', 'editing does not touch who holds the lead')
  const ev = await one(`select kind, detail from public.sales_lead_events where lead_id = $1 and kind = 'edited'`, [first.lead.id])
  assert.equal(ev.detail, 'name')
  ok('an edit saves, says which fields changed (not their values), and leaves the holder alone')
  const n0 = (await one(`select count(*)::int as n from public.sales_lead_events where lead_id = $1`, [first.lead.id])).n
  await rpc(U.editor, 'update_sales_lead', first.lead.id, '9876543210', 'whatsapp', 'Rohan M. Mehta', 'rohan@example.com', 'Jaipur', 'Six chairs')
  assert.equal((await one(`select count(*)::int as n from public.sales_lead_events where lead_id = $1`, [first.lead.id])).n, n0)
  ok('saving with nothing changed adds nothing to the history')
}
{
  const intl = (await rows(`select id::text from public.sales_leads where phone_e164 = '+971567323638'`))[0].id
  const dup = await rpc(U.editor, 'update_sales_lead', intl, '98765 43210', 'website', 'Fatima', null, null, null)
  assert.equal(dup.status, 'duplicate'); assert.equal(dup.lead.lead_no, 1)
  assert.equal((await one(`select phone_e164 from public.sales_leads where id = $1`, [intl])).phone_e164, '+971567323638')
  ok('changing a number to one that is already a lead saves nothing and returns that lead')
  const moved = await rpc(U.editor, 'update_sales_lead', intl, '9222233333', 'website', 'Fatima', null, null, null)
  assert.equal(moved.status, 'saved'); assert.equal(moved.lead.phone, '+919222233333')
  const ev = await one(`select detail from public.sales_lead_events where lead_id = $1 and kind = 'edited'`, [intl])
  assert.equal(ev.detail, 'phone')
  ok('a corrected number is saved in the one format and the number it freed can be used again')
  assert.equal((await create(U.creator, '+971 56 732 3638', 'website')).status, 'created')
}
{
  // Edits made from an older version are refused, so one person's edit never silently undoes another's.
  const id = first.lead.id
  const started = (await rpc(U.viewer, 'get_sales_lead', id)).lead.updated_at
  assert.ok(started, 'the lead carries the version an edit starts from')
  const mine = await rpc(U.editor, 'update_sales_lead', id, '9876543210', 'whatsapp', 'Rohan M. Mehta', 'rohan@example.com', 'Jaipur', 'Six chairs, eight in all', started)
  assert.equal(mine.status, 'saved'); assert.equal(mine.lead.requirement, 'Six chairs, eight in all')
  await assert.rejects(
    () => rpc(U.editor, 'update_sales_lead', id, '9876543210', 'whatsapp', 'Rohan M. Mehta', 'other@example.com', 'Jaipur', 'Six chairs, eight in all', started),
    /SALES_CHANGED/)
  assert.equal((await one(`select email from public.sales_leads where id = $1`, [id])).email, 'rohan@example.com')
  ok('an edit started from an older version is refused and changes nothing')
  const fresh = (await rpc(U.viewer, 'get_sales_lead', id)).lead.updated_at
  await rpc(U.assigner, 'allot_sales_lead', id, U.mohit, U.dhruv)
  await assert.rejects(
    () => rpc(U.editor, 'update_sales_lead', id, '9876543210', 'whatsapp', 'Rohan M. Mehta', 'rohan@example.com', 'Jaipur', 'Six chairs, eight in all', fresh),
    /SALES_CHANGED/)
  await rpc(U.assigner, 'allot_sales_lead', id, U.dhruv, U.mohit)
  ok('allotting a lead also counts as a change, so an edit that did not see it is refused')
  const unguarded = await rpc(U.editor, 'update_sales_lead', id, '9876543210', 'whatsapp', 'Rohan M. Mehta', 'rohan@example.com', 'Jaipur', 'Six chairs, eight in all', null)
  assert.equal(unguarded.status, 'saved')
  ok('an edit that names no version still works (nothing to compare)')
}
await assert.rejects(() => rpc(U.editor, 'update_sales_lead', crypto.randomUUID(), '9333344444', 'website', null, null, null, null), /SALES_NOT_FOUND/)
await assert.rejects(() => rpc(U.editor, 'update_sales_lead', first.lead.id, 'bad', 'website', null, null, null, null), /SALES_INVALID/)
await assert.rejects(() => rpc(U.editor, 'update_sales_lead', first.lead.id, '9876543210', 'nope', null, null, null, null), /SALES_INVALID/)
ok('an edit of a lead that does not exist, with a bad number or an unknown source, is refused')

// ── 7. The list ──────────────────────────────────────────────────────────────
const before = (await one(`select count(*)::int as n from public.sales_leads`)).n
await db.exec(`
  insert into public.sales_leads (phone_e164, source, received_on, assigned_to, name)
  select '+9198000' || lpad(g::text, 5, '0'), case when g % 2 = 0 then 'website' else 'whatsapp' end,
    ((now() at time zone 'Asia/Kolkata')::date - case when g <= 20 then 0 when g <= 50 then 3 when g <= 90 then 10 else 40 end),
    case when g % 4 = 0 then '${U.dhruv}'::uuid when g % 4 = 1 then '${U.mohit}'::uuid else null end,
    'Bulk ' || g
  from generate_series(1, 120) g;
`)
{
  const p = await rpc(U.viewer, 'sales_leads_page', 'today', 'all', null, null, 50, 0)
  assert.deepEqual(p.periods, { today: before + 20, week: before + 50, month: before + 90, all: before + 120 })
  ok('the four period counts are today, the last 7 days, the last 30 days and everything, whatever else is filtered')
  assert.equal(p.total, before + 20); assert.equal(p.rows.length, before + 20)
  assert.ok(p.rows.every((r, i, a) => i === 0 || a[i - 1].received_on > r.received_on || (a[i - 1].received_on === r.received_on && a[i - 1].lead_no > r.lead_no)))
  ok('the list is newest first, ties broken by lead number')
  assert.equal(p.everyone, p.unallotted + p.holders.reduce((s, h) => s + h.n, 0))
  assert.ok(p.holders.every(h => h.name))
  ok('the "Allotted to" chips add up: not allotted plus every person is everyone')
}
{
  const none = await rpc(U.viewer, 'sales_leads_page', 'all', 'none', null, null, 100, 0)
  assert.ok(none.rows.every(r => r.assigned_to === null)); assert.equal(none.total, none.unallotted)
  const mine = await rpc(U.viewer, 'sales_leads_page', 'all', U.mohit, null, null, 100, 0)
  assert.ok(mine.rows.length > 0 && mine.rows.every(r => r.assigned_to === U.mohit))
  assert.equal(mine.everyone, none.everyone, 'choosing a person does not change the counts on the chips')
  const stranger = await rpc(U.viewer, 'sales_leads_page', 'all', crypto.randomUUID(), null, null, 100, 0)
  assert.equal(stranger.total, 0)
  const junk = await rpc(U.viewer, 'sales_leads_page', 'all', 'not-a-uuid', null, null, 100, 0)
  assert.equal(junk.total, 0)
  ok('filtering by not allotted, by a person, by a person who holds nothing, or by junk all behave')
  const web = await rpc(U.viewer, 'sales_leads_page', 'all', 'all', 'website', null, 100, 0)
  assert.ok(web.rows.every(r => r.source === 'website') && web.total > 0)
  ok('the source filter works')
}
{
  const byDigits = await rpc(U.viewer, 'sales_leads_page', 'all', 'all', null, '98765 43210', 50, 0)
  assert.equal(byDigits.total, 1); assert.equal(byDigits.rows[0].lead_no, 1)
  const partial = await rpc(U.viewer, 'sales_leads_page', 'all', 'all', null, '9800000', 200, 0)
  assert.ok(partial.total >= 100)
  for (const typed of ['098765 43210', '+91 98765-43210', '919876543210', '(098765) 43210']) {
    const r = await rpc(U.viewer, 'sales_leads_page', 'all', 'all', null, typed, 50, 0)
    assert.equal(r.total, 1, `${typed} finds the one lead`)
    assert.equal(r.rows[0].lead_no, 1)
  }
  ok('a number typed in any form (with the leading 0, the +91, brackets) finds the lead in search')
  const byName = await rpc(U.viewer, 'sales_leads_page', 'all', 'all', null, 'rohan m', 50, 0)
  assert.equal(byName.total, 1)
  const byEmail = await rpc(U.viewer, 'sales_leads_page', 'all', 'all', null, 'ROHAN@EXAMPLE', 50, 0)
  assert.equal(byEmail.total, 1)
  const byText = await rpc(U.viewer, 'sales_leads_page', 'all', 'all', null, 'jaipur', 50, 0)
  assert.equal(byText.total, 1)
  const percent = await rpc(U.viewer, 'sales_leads_page', 'all', 'all', null, '%', 50, 0)
  assert.equal(percent.total, 0, 'a % in the search is a character, not a wildcard')
  const underscore = await rpc(U.viewer, 'sales_leads_page', 'all', 'all', null, 'R_han', 50, 0)
  assert.equal(underscore.total, 0, 'an _ in the search is a character, not a wildcard')
  ok('search finds a number however it is typed, part of a number, a name, an email or a place, and treats % and _ literally')
}
{
  const all = await rpc(U.viewer, 'sales_leads_page', 'all', 'all', null, null, 50, 0)
  const next = await rpc(U.viewer, 'sales_leads_page', 'all', 'all', null, null, 50, 50)
  assert.equal(all.rows.length, 50); assert.equal(next.rows.length, 50)
  assert.equal(new Set([...all.rows, ...next.rows].map(r => r.id)).size, 100)
  assert.equal(all.total, before + 120)
  const huge = await rpc(U.viewer, 'sales_leads_page', 'all', 'all', null, null, 5000, 0)
  assert.equal(huge.rows.length, 100)
  const zero = await rpc(U.viewer, 'sales_leads_page', 'all', 'all', null, null, 0, -5)
  assert.equal(zero.rows.length, 1)
  ok('pages do not overlap, the total is the whole match, and a silly limit or offset is clamped')
}

// ── 8. One lead with its history ─────────────────────────────────────────────
{
  const g = await rpc(U.viewer, 'get_sales_lead', first.lead.id)
  assert.equal(g.lead.lead_no, 1)
  // Newest first: the two reassignments of the version check, the two edits, the first change of name, the allotment, the add.
  assert.deepEqual(g.events.map(e => e.kind), ['reassigned', 'reassigned', 'edited', 'edited', 'reassigned', 'allotted', 'added'])
  const re = g.events.find(e => e.kind === 'reassigned')
  assert.equal(re.from_name, 'Mohit'); assert.equal(re.to_name, 'Dhruv'); assert.equal(re.actor_name, 'Anil Assigner')
  assert.equal(g.events.find(e => e.kind === 'added').actor_name, 'Chitra Creator')
  ok('a lead comes with its history, newest first, with names')
  await assert.rejects(() => rpc(U.viewer, 'get_sales_lead', crypto.randomUUID()), /SALES_NOT_FOUND/)
}

// ── 9. What can never change ─────────────────────────────────────────────────
await assert.rejects(() => db.query(`update public.sales_leads set received_on = received_on - 1 where lead_no = 1`), /SALES_LEAD_FIXED/)
await assert.rejects(() => db.query(`update public.sales_leads set lead_no = 999 where lead_no = 1`), /can only be updated to DEFAULT|SALES_LEAD_FIXED/i)
await assert.rejects(() => db.query(`update public.sales_lead_events set kind = 'added'`), /APPEND_ONLY/)
await assert.rejects(() => db.query(`delete from public.sales_lead_events`), /APPEND_ONLY/)
await assert.rejects(() => db.query(`insert into public.sales_leads (phone_e164, source) values ('+919876543210', 'website')`), /unique|duplicate/i)
ok('the received date and lead number cannot be changed, the history cannot be edited or deleted, and the index itself refuses a second lead for a number')

// ── 10. Reading directly follows the same gate ───────────────────────────────
{
  const viewerSees = (await as(U.viewer, `select count(*)::int as n from public.sales_leads`)).rows[0].n
  assert.equal(viewerSees, before + 120)
  const nobodySees = (await as(U.nobody, `select count(*)::int as n from public.sales_leads`)).rows[0].n
  assert.equal(nobodySees, 0)
  ok('a direct read is allowed only through the module gate: a viewer sees the register, somebody without view sees nothing')
}

// ── 11. A person who is deleted does not take the history with them ──────────
{
  const held = (await one(`select count(*)::int as n from public.sales_leads where assigned_to = $1`, [U.mohit])).n
  const unallottedBefore = (await one(`select count(*)::int as n from public.sales_leads where assigned_to is null`)).n
  assert.ok(held > 0, 'the check needs Mohit to hold leads')
  const eventsBefore = (await one(`select count(*)::int as n from public.sales_lead_events`)).n
  await db.query(`delete from public.users where id = $1`, [U.mohit])
  assert.equal((await one(`select count(*)::int as n from public.sales_leads where assigned_to is null`)).n, unallottedBefore + held)
  assert.equal((await one(`select count(*)::int as n from public.sales_lead_events`)).n, eventsBefore)
  const g = await rpc(U.viewer, 'get_sales_lead', first.lead.id)
  assert.equal(g.events.find(e => e.kind === 'allotted').to_name, null, 'a removed person reads as nobody, the event stays')
  ok('removing a person leaves their leads unallotted and keeps every history entry')
}

console.log(`all ${checks} checks passed`)
await db.close()
