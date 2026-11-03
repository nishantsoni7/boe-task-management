// Database regression suite for 20270526000100 (Sales, going live). Runs the REAL migrations in an in-memory Postgres
// (PGlite) over small stubs of the platform objects they depend on, the same way sales_lead_board_pglite.mjs does. Run:
//   node supabase/tests/sales_go_live_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all N checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node sales_go_live_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const mig = f => readFileSync(`${REPO}/supabase/migrations/${f}`, 'utf8').replace(/\r/g, '')

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
  admin:   '00000000-0000-0000-0000-0000000000a1',
  ashok:   '00000000-0000-0000-0000-0000000000b1', // view: a salesperson
  mohit:   '00000000-0000-0000-0000-0000000000b2', // view: a salesperson
  manager: '00000000-0000-0000-0000-0000000000b4', // view + view_all
  allot:   '00000000-0000-0000-0000-0000000000b5', // view + assign
  adder:   '00000000-0000-0000-0000-0000000000b6', // view + create
}

const db = new PGlite()
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth;
  grant usage on schema public, auth to anon, authenticated, service_role;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create table public.users (id uuid primary key, full_name text, role text not null default 'employee',
    team text, is_active boolean not null default true, payroll_active boolean not null default true);
  create table public.grants (user_id uuid, module_key text, action_key text);
  create function public.resolve_permission(p_uid uuid, p_module text, p_action text) returns boolean
    language sql stable security definer as $$ select exists (select 1 from public.grants g where g.user_id = p_uid and g.module_key = p_module and g.action_key = p_action) $$;
  create function public.module_entry_open(p text) returns boolean language sql stable security definer as
    $$ select exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
          or public.resolve_permission(auth.uid(), p, 'view') $$;
  create table public.app_modules (module_key text primary key, module_name text, description text, route_path text,
    visibility_type text, allowed_department text, sort_order int);
  create table public.permission_modules (id uuid primary key default gen_random_uuid(), module_key text unique, display_name text, description text);
  create table public.permission_actions (id uuid primary key default gen_random_uuid(), action_key text unique);
  insert into public.permission_actions (action_key) values ('view'), ('create'), ('edit'), ('assign'), ('view_all');
  create table public.module_permission_actions (module_id uuid, action_id uuid, default_allowed boolean, unique (module_id, action_id));
  create table public.role_permissions (role text, module_id uuid, action_id uuid, allowed boolean, unique (role, module_id, action_id));
  create type notification_type as enum ('task_assigned');
  create table public.notifications (id uuid primary key default gen_random_uuid(), user_id uuid, task_id uuid, entity_id uuid,
    type notification_type, title text, body text, is_push_sent boolean, created_at timestamptz not null default now());
  create table public.attendance_records (user_id uuid, attendance_date date, check_in_at timestamptz);
  insert into public.users (id, full_name, role, team, is_active) values
    ('${U.admin}', 'Nishant Soni', 'admin', null, true),
    ('${U.ashok}', 'Ashok', 'employee', 'sales', true), ('${U.mohit}', 'Mohit', 'employee', 'sales', true),
    ('${U.manager}', 'Manager', 'employee', null, true), ('${U.allot}', 'Allotter', 'employee', null, true),
    ('${U.adder}', 'Adder', 'employee', null, true);
  insert into public.grants values
    ('${U.ashok}', 'sales', 'view'), ('${U.mohit}', 'sales', 'view'),
    ('${U.manager}', 'sales', 'view'), ('${U.manager}', 'sales', 'view_all'),
    ('${U.allot}', 'sales', 'view'), ('${U.allot}', 'sales', 'assign'),
    ('${U.adder}', 'sales', 'view'), ('${U.adder}', 'sales', 'create');
`)
await db.exec(extract(mig('20270305000000_exhibition_leads.sql'), 'normalize_lead_phone'))
await db.exec(extract(mig('20260697000000_order_request_assignee_eligibility.sql'), 'is_eligible_order_assignee'))
await db.exec(`
  grant execute on function public.normalize_lead_phone(text), public.is_eligible_order_assignee(uuid),
    public.module_entry_open(text), public.resolve_permission(uuid, text, text) to authenticated;
`)
await db.exec(mig('20270515000000_register_sales_marketing_pricing_modules.sql'))
await db.exec(mig('20270524000000_sales_lead_master.sql'))
await db.exec(mig('20270525000000_sales_lead_board.sql'))

let checks = 0
const ok = (name) => { checks++; console.log(`  ok - ${name}`) }

async function as(uid, sql, params = []) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false); set role authenticated;`)
  try { return await db.query(sql, params) } finally { await db.exec('reset role;') }
}
const one = async (uid, sql, params = []) => Object.values((await as(uid, sql, params)).rows[0])[0]
const refused = async (uid, sql, re, params = []) => {
  await assert.rejects(() => as(uid, sql, params), e => re.test(e.message), `expected ${re} from ${sql}`)
}
const add = async (phone, name, to) => {
  const r = await one(U.adder, `select public.create_sales_lead($1, 'website', $2)`, [phone, name])
  if (to) await one(U.allot, `select public.allot_sales_lead($1, $2, null)`, [r.lead.id, to])
  return r.lead.id
}
const scalar = async (sql, params = []) => Object.values((await db.query(sql, params)).rows[0])[0]

// A lead worked BEFORE this migration arrives.
const early = await add('+919000000001', 'Early', U.ashok)
await one(U.ashok, `select public.log_sales_lead_activity($1, 'call', 'interested', 'Good call', 'Call back', current_date + 1)`, [early])

await db.exec(mig('20270526000000_sales_notification_types.sql'))
await db.exec(mig('20270526000100_sales_go_live.sql'))
ok('both migrations apply over a live register, self-checks included')

assert.equal(await scalar(`select furthest_rank from public.sales_leads where id = $1`, [early]), 2)
ok('a lead already under way gets its furthest stage')

const today = await scalar(`select ((now() at time zone 'Asia/Kolkata')::date)::text`)
const addDays = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10)
const row = (over = {}) => ({
  task_id: 't1', phone: '+91 98000 00001', name: 'Hotel One', email: 'A@One.test', location: 'Goa', requirement: 'Chairs', source: 'website',
  stage: 'under_process', temperature: 'warm', segment: 'bulk', client_type: null, dead_reason: null, dead_note: null, holder_id: U.ashok,
  next_step: 'Call back', next_due_on: addDays(2), created_at: '2025-07-30T16:55:41+05:30', updated_at: '2026-09-15T17:56:45+05:30',
  comment_count: 3, latest_comment: 'Will call next week', clickup_status: 'important bulk (ak)', raw: { Status: 'important bulk (ak)', Folder: 'Ashok' }, ...over,
})
const run = (rows, uid = U.allot) => one(uid, `select public.import_sales_leads($1::jsonb)`, [JSON.stringify(rows)])
const lead = async (phone) => (await db.query(`select * from public.sales_leads where phone_e164 = $1`, [phone])).rows[0]

await refused(U.ashok, `select public.import_sales_leads('[]'::jsonb)`, /SALES_FORBIDDEN/)
await refused(U.manager, `select public.import_sales_leads('[]'::jsonb)`, /SALES_FORBIDDEN/)
ok('only somebody who allots leads can import')

{
  const notes = await scalar(`select count(*)::int from public.notifications`)
  const r = await run([row()])
  assert.deepEqual([r.created, r.merged, r.already], [1, 0, 0])
  const l = await lead('+919800000001')
  assert.equal(l.assigned_to, U.ashok)
  assert.equal(l.stage, 'under_process')
  assert.equal(new Date(l.received_on).toISOString().slice(0, 10), '2025-07-30')
  assert.equal(l.email, 'a@one.test')
  assert.equal(l.market, 'domestic')
  assert.ok(l.first_attempt_at && l.first_contact_at && l.imported_at)
  assert.equal(l.last_kind, 'update')
  assert.equal(await scalar(`select count(*)::int from public.notifications`), notes)
  ok('a task becomes a lead with its own dates, holder and step, and nobody is notified')
  const d = await one(U.ashok, `select public.get_sales_lead($1)`, [l.id])
  assert.equal(d.activities[0].note, 'Will call next week')
  assert.equal(d.activities[0].kind, 'imported')
  assert.equal(d.clickup[0].Folder, 'Ashok')
  assert.equal(d.events[0].kind, 'imported')
  ok('its latest comment is in the history, and the ClickUp original comes back with it')
  const again = await run([row()])
  assert.deepEqual([again.created, again.merged, again.already], [0, 0, 1])
  ok('a second run changes nothing')
}

{
  const r = await run([row({ task_id: 't2', phone: '+919800000001', clickup_status: 'dead leads (ak)', latest_comment: 'Old enquiry' })])
  assert.equal(r.merged, 1)
  assert.equal(await scalar(`select count(*)::int from public.sales_leads where phone_e164 = '+919800000001'`), 1)
  const l = await lead('+919800000001')
  const notes = await db.query(`select note from public.sales_lead_activities where lead_id = $1 order by note`, [l.id])
  assert.ok(notes.rows.some(n => n.note === 'Also in ClickUp as dead leads (ak): Old enquiry'))
  ok('a second task on the same number becomes a note, never a second lead')
}

{
  const r = await run([
    row({ task_id: 't3', phone: 'none' }),
    row({ task_id: 't4', phone: '+919800000004', stage: 'nonsense' }),
    row({ task_id: 't5', phone: '+919800000005', updated_at: 'not a date' }),
    row({ task_id: 't6', phone: '+919800000006', holder_id: U.manager }),
    row({ task_id: 't7', phone: '+919800000007' }),
  ])
  assert.equal(r.created, 1)
  assert.deepEqual(r.failed.map(f => f.task_id).sort(), ['t3', 't4', 't5', 't6'])
  assert.equal(await scalar(`select count(*)::int from public.sales_lead_imports where task_id in ('t4', 't5', 't6')`), 0)
  ok('a row the database refuses is reported and the rest carry on')
}

{
  await run([row({ task_id: 't8', phone: '+919800000008', stage: 'dead', dead_reason: 'no_requirement', next_step: null, next_due_on: null, temperature: 'warm' })])
  const l = await lead('+919800000008')
  assert.equal(l.dead_reason, 'no_requirement')
  assert.equal(l.next_step, null)
  assert.ok(l.closed_at)
  assert.equal(l.furthest_rank, 2)
  await run([row({ task_id: 't9', phone: '+919800000009', stage: 'dead', dead_reason: 'other', dead_note: 'No reason recorded in ClickUp', comment_count: 0, latest_comment: null, next_step: null, next_due_on: null })])
  assert.equal((await lead('+919800000009')).furthest_rank, 1)
  ok('a dead lead keeps its reason and how far it got')
}

{
  await run([row({ task_id: 't10', phone: '+919800000010', stage: 'new', comment_count: 0, latest_comment: null, updated_at: '2026-01-01T10:00:00+05:30' })])
  const l = await lead('+919800000010')
  assert.equal(l.first_attempt_at, null)
  assert.ok(Date.now() - new Date(l.assigned_at).getTime() < 60_000, 'the Waiting clock starts at the import')
  const day = await one(U.ashok, `select public.sales_my_day()`)
  assert.ok(day.rows.some(r => r.id === l.id), 'a lead nobody has called comes up on My day')
  await run([row({ task_id: 't11', phone: '+919800000011', holder_id: null, next_step: null, next_due_on: null })])
  const free = await lead('+919800000011')
  assert.equal(free.assigned_to, null)
  ok('a lead nobody ever called waits at the top of the day; a lead with no holder goes to the queue')
}

{
  await run([row({ task_id: 't12', phone: '+919800000012', updated_at: '2026-01-01T10:00:00+05:30', next_due_on: addDays(9) })])
  const id = (await lead('+919800000012')).id
  const stuck = async () => (await db.query(`select public.sales_lead_stuck(l) as s from public.sales_leads l where id = $1`, [id])).rows[0].s
  assert.equal(await stuck(), false)
  await db.query(`update public.sales_leads set next_due_on = current_date - 1, imported_at = now() - interval '8 days' where id = $1`, [id])
  assert.equal(await stuck(), true)
  ok('an imported lead stays calm until the day it was given, then the usual rule applies')
}

{
  const before = await scalar(`select count(*)::int from public.notifications where type::text = 'sales_lead_allotted'`)
  await add('+919000000002', 'Fresh', U.ashok)
  assert.equal(await scalar(`select count(*)::int from public.notifications where type::text = 'sales_lead_allotted'`), before + 1)
  const n = (await db.query(`select * from public.notifications where type::text = 'sales_lead_allotted' order by created_at desc limit 1`)).rows[0]
  assert.equal(n.user_id, U.ashok)
  assert.ok(n.entity_id)
  ok('allotting a lead tells the salesperson')
  const id = (await lead('+919000000002')).id
  await one(U.adder, `select public.record_sales_lead_enquiry($1, 'website', null)`, [id])
  assert.equal(await scalar(`select count(*)::int from public.notifications where type::text = 'sales_lead_enquired_again' and user_id = $1`, [U.ashok]), 1)
  ok('a repeat enquiry tells whoever holds the lead')

  await refused(U.ashok, `select public.sales_lead_remind($1)`, /SALES_FORBIDDEN/, [id])
  assert.equal((await one(U.manager, `select public.sales_lead_remind($1)`, [id])).status, 'sent')
  assert.equal((await one(U.manager, `select public.sales_lead_remind($1)`, [id])).status, 'already')
  ok('a manager can chase a lead once a day; a salesperson cannot')
}

{
  await refused(U.ashok, `select public.sales_team_overview(current_date - 30)`, /SALES_FORBIDDEN/)
  const t = await one(U.manager, `select public.sales_team_overview('2025-01-01'::date)`)
  assert.ok(t.tiles.leads >= 6)
  assert.equal(t.funnel.length, 5)
  assert.ok(t.funnel[0].n >= t.funnel[1].n && t.funnel[1].n >= t.funnel[2].n)
  assert.ok(t.reasons.some(r => r.reason === 'no_requirement'))
  const ashok = t.people.find(p => p.id === U.ashok)
  assert.ok(ashok.open >= 3)
  assert.ok(ashok.first_call_total >= 1, 'a lead allotted in BOE One counts')
  assert.ok(ashok.followups_total >= 1, 'a logged follow-up counts')
  assert.ok(t.at_risk_total >= 1)
  assert.ok(t.at_risk[0].problem && t.at_risk[0].id)
  const export_ = await one(U.manager, `select public.sales_team_overview('2025-01-01'::date, 'export')`)
  assert.equal(export_.tiles.leads, 0)
  ok('the Team page adds up, and only somebody who sees everyone can read it')

  await db.exec(`insert into public.attendance_records values ('${U.mohit}', (now() at time zone 'Asia/Kolkata')::date, now())`)
  const def = await scalar(`select pg_get_functiondef('public.sales_team_overview(date, text, uuid)'::regprocedure)`)
  await db.exec(def.replace(`'11:00:00'::time without time zone`, `'00:00:00'::time without time zone`).replace(`time '11:00'`, `time '00:00'`))
  const later = await one(U.manager, `select public.sales_team_overview('2025-01-01'::date)`)
  assert.deepEqual(later.absent.map(a => a.id), [U.ashok])
  await db.exec(`delete from public.attendance_records`)
  const dark = await one(U.manager, `select public.sales_team_overview('2025-01-01'::date)`)
  assert.deepEqual(dark.absent, [])
  await db.exec(def)
  ok('somebody with no punch and work due shows as absent; on a day with no punches at all, nobody does')
}

{
  const id = await add('+919000000003', 'Due today', U.ashok)
  const later = await add('+919000000004', 'Later', U.ashok)
  await db.query(`update public.sales_leads set next_due_on = current_date + 20 where id = $1`, [later])
  await refused(U.manager, `select public.reassign_due_sales_leads($1, $2)`, /SALES_FORBIDDEN/, [U.ashok, U.mohit])
  const r = await one(U.allot, `select public.reassign_due_sales_leads($1, $2)`, [U.ashok, U.mohit])
  assert.ok(r.moved >= 1)
  assert.equal((await lead('+919000000003')).assigned_to, U.mohit)
  assert.equal((await lead('+919000000004')).assigned_to, U.ashok)
  assert.equal(await scalar(`select count(*)::int from public.sales_lead_events where lead_id = $1 and kind = 'reassigned'`, [id]), 1)
  ok('what is due from an absent person moves, and the rest stays with them')
}

{
  await refused(U.manager, `select public.list_sales_team()`, /SALES_FORBIDDEN/)
  await refused(U.manager, `select public.set_sales_lead_juniors($1, $2::uuid[])`, /SALES_FORBIDDEN/, [U.ashok, [U.mohit]])
  await one(U.admin, `select public.set_sales_lead_juniors($1, $2::uuid[])`, [U.ashok, [U.mohit]])
  const team = await one(U.admin, `select public.list_sales_team()`)
  const a = team.find(p => p.id === U.ashok)
  assert.deepEqual([a.view, a.assign, a.juniors], [true, false, [U.mohit]])
  assert.ok((await one(U.ashok, `select public.sales_board()`)).holders.length >= 2, 'a senior now sees a junior on the board')
  await one(U.admin, `select public.set_sales_lead_juniors($1, $2::uuid[])`, [U.ashok, []])
  assert.equal(await scalar(`select count(*)::int from public.sales_lead_access`), 0)
  ok('Control Center names a senior\'s juniors, and only an Admin can')
}

{
  const page = await one(U.admin, `select public.sales_leads_page('all', 'none')`)
  await run([row({ task_id: 't13', phone: '+919800000013', holder_id: null, stage: 'dead', dead_reason: 'other', dead_note: 'x', next_step: null, next_due_on: null })])
  const after = await one(U.admin, `select public.sales_leads_page('all', 'none')`)
  assert.equal(after.unallotted, page.unallotted)
  const board = await one(U.admin, `select public.sales_board()`)
  assert.equal(board.waiting_allotment, page.unallotted)
  ok('a dead lead nobody holds is history, not a lead waiting to be allotted')
}

{
  await refused(U.admin, `select public.sales_lead_send_alerts('morning')`, /permission denied/)
  await db.exec(`reset role; set role service_role;`)
  const sunday = new Date(`${today}T00:00:00Z`).getUTCDay() === 0
  const morning = (await db.query(`select public.sales_lead_send_alerts('morning') as n`)).rows[0].n
  const twice = (await db.query(`select public.sales_lead_send_alerts('morning') as n`)).rows[0].n
  const evening = (await db.query(`select public.sales_lead_send_alerts('evening') as n`)).rows[0].n
  await db.exec('reset role;')
  if (sunday) {
    assert.equal(morning + twice + evening, 0)
  } else {
    assert.ok(morning >= 1)
    assert.equal(twice, 0)
    assert.equal(await scalar(`select count(*)::int from public.notifications where type::text = 'sales_followups_due' and user_id = $1`, [U.mohit]), 1)
    assert.ok(evening >= 1, 'a lead nobody has called')
  }
  ok('the two daily alerts run for the service role only, once a day, never on a Sunday')
}

console.log(`all ${checks} checks passed`)
