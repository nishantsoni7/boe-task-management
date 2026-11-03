// One lead's whole life through the REAL Sales migrations, as every role: added in Lead Master, allotted, worked through
// every stage to Converted, parked, Dead, enquired again; then the manager, the lead manager and Admin; then the alerts,
// the fixes of 20270527000000, ClickUp's full history, "Can be given leads" (20270529000000), the two old Google Sheets (20270530000000), and the website capture (20270531000000/100). Runs in an in-memory Postgres (PGlite) over small stubs, like
// sales_go_live_pglite.mjs. Run:
//   node supabase/tests/sales_full_flow_pglite.mjs <dir with @electric-sql/pglite installed>
// Prints every step, keeps going after a failure, and ends with "all N checks passed" or exits 1.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node sales_full_flow_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
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
  admin:   '00000000-0000-0000-0000-0000000000a1', // role admin, no grants
  leadmgr: '00000000-0000-0000-0000-0000000000a2', // Control Center job "Lead manager": view create edit assign
  manager: '00000000-0000-0000-0000-0000000000a3', // job "Manager": view view_all (also holds own leads)
  senior:  '00000000-0000-0000-0000-0000000000a4', // job "Salesperson" + juniors [ashok]
  ashok:   '00000000-0000-0000-0000-0000000000b1', // job "Salesperson"
  mohit:   '00000000-0000-0000-0000-0000000000b2', // job "Salesperson"
  nobody:  '00000000-0000-0000-0000-0000000000c1', // job "No access"
  dummy:   '00000000-0000-0000-0000-0000000000c2', // job "Salesperson", a test account the owner keeps out of the lists
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
  insert into public.users (id, full_name, role, team) values
    ('${U.admin}', 'Nishant', 'admin', null), ('${U.leadmgr}', 'LeadMgr', 'employee', null),
    ('${U.manager}', 'Dhruv', 'employee', 'sales'), ('${U.senior}', 'Senior', 'employee', 'sales'),
    ('${U.ashok}', 'Ashok', 'employee', 'sales'), ('${U.mohit}', 'Mohit', 'employee', 'sales'),
    ('${U.nobody}', 'Accounts', 'employee', null), ('${U.dummy}', 'Test Sales User (DUMMY)', 'employee', 'sales');
  insert into public.grants values
    ('${U.leadmgr}', 'sales', 'view'), ('${U.leadmgr}', 'sales', 'create'), ('${U.leadmgr}', 'sales', 'edit'), ('${U.leadmgr}', 'sales', 'assign'),
    ('${U.manager}', 'sales', 'view'), ('${U.manager}', 'sales', 'view_all'),
    ('${U.senior}', 'sales', 'view'), ('${U.ashok}', 'sales', 'view'), ('${U.mohit}', 'sales', 'view'), ('${U.dummy}', 'sales', 'view');
`)
await db.exec(extract(mig('20270305000000_exhibition_leads.sql'), 'normalize_lead_phone'))
await db.exec(extract(mig('20260697000000_order_request_assignee_eligibility.sql'), 'is_eligible_order_assignee'))
await db.exec(`grant execute on function public.normalize_lead_phone(text), public.is_eligible_order_assignee(uuid),
  public.module_entry_open(text), public.resolve_permission(uuid, text, text) to authenticated;`)
for (const f of ['20270515000000_register_sales_marketing_pricing_modules.sql', '20270524000000_sales_lead_master.sql',
  '20270525000000_sales_lead_board.sql', '20270526000000_sales_notification_types.sql', '20270526000100_sales_go_live.sql',
  '20270527000000_sales_review_fixes.sql', '20270529000000_sales_can_be_given_leads.sql', '20270530000000_sales_sheet_import.sql',
  '20270531000000_sales_lead_waiting_type.sql', '20270531000100_sales_website_capture.sql']) {
  await db.exec(mig(f))
}

let pass = 0, fail = 0
const results = []
async function step(name, fn) {
  try { const note = await fn(); pass++; results.push(`PASS  ${name}${note ? '  (' + note + ')' : ''}`) }
  catch (e) { fail++; results.push(`FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`) }
}
async function as(uid, sql, params = []) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false); set role authenticated;`)
  try { return await db.query(sql, params) } finally { await db.exec('reset role;') }
}
const one = async (uid, sql, params = []) => Object.values((await as(uid, sql, params)).rows[0])[0]
const err = async (uid, sql, params = []) => { try { await as(uid, sql, params); return null } catch (e) { return e.message } }
const expectErr = async (uid, sql, re, params = []) => {
  const m = await err(uid, sql, params)
  if (!m) throw new Error(`expected refusal ${re}, but it succeeded`)
  if (!re.test(m)) throw new Error(`expected ${re}, got: ${m}`)
}
const must = (c, msg) => { if (!c) throw new Error(msg) }
const scalar = async (sql, params = []) => Object.values((await db.query(sql, params)).rows[0])[0]
const leadRow = async id => (await db.query(`select * from public.sales_leads where id = $1`, [id])).rows[0]
const notesFor = async (uid, type) => Number(await scalar(`select count(*) from public.notifications where user_id = $1 and type::text = $2`, [uid, type]))
const sees = async (uid, id) => Number(await one(uid, `select count(*) from public.sales_leads where id = $1`, [id])) === 1
const today = await scalar(`select ((now() at time zone 'Asia/Kolkata')::date)::text`)
const day = n => new Date(Date.parse(`${today}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10)
const move = (uid, id, to, from, reason = null, note = null, step_ = null, due = null) =>
  one(uid, `select public.move_sales_lead($1, $2, $3, $4, $5, $6, $7)`, [id, to, from, reason, note, step_, due])
const log = (uid, id, kind, outcome, note = null, step_ = 'Call back', due = day(1)) =>
  one(uid, `select public.log_sales_lead_activity($1, $2, $3, $4, $5, $6)`, [id, kind, outcome, note, step_, due])
const facts = (uid, id, f) => one(uid, `select public.update_sales_lead_facts($1, $2::jsonb)`, [id, JSON.stringify(f)])

const sheet = (over = {}) => ({ phone: '+91 98111 00040', received_on: '2025-03-14', source: 'website', name: 'Sheet Hotel', email: 'Sheet@Hotel.test',
  location: 'Goa', requirement: 'Wants 50 chairs', detail: 'Leads Master 2025, given to Monika', ...over })
const importSheet = (rows, uid = U.leadmgr) => one(uid, `select public.import_sales_lead_sheet($1::jsonb)`, [JSON.stringify(rows)])

await step('The old sheets are refused before the ClickUp import, and by anybody without the allot right', async () => {
  await expectErr(U.leadmgr, `select public.import_sales_lead_sheet('[]'::jsonb)`, /Import the ClickUp files first/)
  await expectErr(U.ashok, `select public.import_sales_lead_sheet('[]'::jsonb)`, /SALES_FORBIDDEN/)
})

// ── Admin side: a lead arrives ─────────────────────────────────────────────
let L1
await step('Lead manager adds a lead in Lead Master (not allotted)', async () => {
  const r = await one(U.leadmgr, `select public.create_sales_lead($1, 'website', $2, null, 'Goa', 'Restaurant chairs')`, ['+91 98111 00001', 'Hotel Sea'])
  L1 = r.lead.id
  must(r.lead.assigned_to === null, 'should start not allotted')
  return `status ${r.status}, lead_no ${r.lead.lead_no}`
})
await step('Salesperson cannot add a lead (no create right)', () =>
  expectErr(U.ashok, `select public.create_sales_lead('+91 98111 00009', 'website')`, /SALES_FORBIDDEN/))
await step('Unallotted lead waits in the Lead Master queue and the board waiting count', async () => {
  const page = await one(U.leadmgr, `select public.sales_leads_page('all', 'none')`)
  must(JSON.stringify(page).includes(L1), 'not in the Not allotted list')
  const b = await one(U.leadmgr, `select public.sales_board()`)
  return `board waiting_allotment = ${b.waiting_allotment ?? JSON.stringify(Object.keys(b))}`
})
await step('Salesperson and senior cannot see an unallotted lead', async () => {
  must(!(await sees(U.ashok, L1)), 'Ashok sees it'); must(!(await sees(U.senior, L1)), 'Senior sees it')
})
await step('Lead manager allots it to Ashok; Ashok is notified', async () => {
  const before = await notesFor(U.ashok, 'sales_lead_allotted')
  const r = await one(U.leadmgr, `select public.allot_sales_lead($1, $2, null)`, [L1, U.ashok])
  must(await notesFor(U.ashok, 'sales_lead_allotted') === before + 1, 'no allotted notification')
  const l = await leadRow(L1)
  must(l.stage === 'new' && l.next_step && l.next_due_on, `stage ${l.stage}, next ${l.next_step} ${l.next_due_on}`)
  return `status ${r.status}, next step "${l.next_step}" due ${l.next_due_on.toISOString?.().slice(0, 10) ?? l.next_due_on}`
})
await step('Manager (Dhruv) cannot allot or change holder', () =>
  expectErr(U.manager, `select public.allot_sales_lead($1, $2, $3)`, /SALES_FORBIDDEN/, [L1, U.mohit, U.ashok]))

// ── Visibility ──────────────────────────────────────────────────────────────
await step('Ashok sees it; Mohit does not; No-access user cannot open Sales', async () => {
  must(await sees(U.ashok, L1), 'Ashok cannot see'); must(!(await sees(U.mohit, L1)), 'Mohit sees it')
  must(!(await sees(U.nobody, L1)), 'No-access sees it')
  await expectErr(U.nobody, `select public.sales_my_day()`, /SALES_FORBIDDEN/)
})
await step('Ashok\'s My day lists it for today', async () => {
  const d = await one(U.ashok, `select public.sales_my_day()`)
  must(JSON.stringify(d).includes(L1), 'not in My day')
  return `keys: ${Object.keys(d).join(', ')}`
})
await step('Admin sets Senior to see Ashok\'s leads; Senior reads but cannot work', async () => {
  await one(U.admin, `select public.set_sales_lead_juniors($1, $2::uuid[])`, [U.senior, [U.ashok]])
  must(await sees(U.senior, L1), 'senior cannot see')
  await expectErr(U.senior, `select public.sales_lead_no_answer($1)`, /SALES_FORBIDDEN/, [L1])
})
await step('Manager reads every lead but cannot work Ashok\'s lead', async () => {
  must(await sees(U.manager, L1), 'manager cannot see')
  await expectErr(U.manager, `select public.sales_lead_no_answer($1)`, /SALES_FORBIDDEN/, [L1])
  await expectErr(U.manager, `select public.move_sales_lead($1, 'dead', 'new', 'other', 'x')`, /SALES_FORBIDDEN/, [L1])
})

// ── Salesperson works the lead ──────────────────────────────────────────────
await step('Ashok taps No answer: stays New, streak 1, first attempt stamped', async () => {
  await one(U.ashok, `select public.sales_lead_no_answer($1)`, [L1])
  const l = await leadRow(L1)
  must(l.stage === 'new' && l.no_answer_streak === 1 && l.first_attempt_at && !l.first_contact_at, JSON.stringify({ s: l.stage, n: l.no_answer_streak, c: l.first_contact_at }))
})
await step('New → Under process is blocked until a real contact', async () => {
  const r = await move(U.ashok, L1, 'under_process', 'new')
  must(r.status === 'needs' && r.missing.includes('contact'), JSON.stringify(r).slice(0, 160))
  return `missing ${r.missing.join(', ')}`
})
await step('Ashok logs a real call (interested): lead moves itself to Under process', async () => {
  await log(U.ashok, L1, 'call', 'interested', 'Wants 120 chairs', 'Send catalogue', day(1))
  const l = await leadRow(L1)
  must(l.first_contact_at && l.no_answer_streak === 0, 'contact not stamped or streak not reset')
  return `stage now ${l.stage}`
})
await step('Under process → Potential asks for requirement and quantity', async () => {
  const from = (await leadRow(L1)).stage
  const r = await move(U.ashok, L1, 'potential', from)
  must(r.status === 'needs', `status ${r.status}`)
  return `missing ${r.missing.join(', ')}`
})
await step('Ashok fills quantity, then Potential works', async () => {
  await facts(U.ashok, L1, { quantity: '120 chairs', segment: 'bulk', client_type: 'hotel' })
  const r = await move(U.ashok, L1, 'potential', (await leadRow(L1)).stage)
  must(r.status === 'moved', JSON.stringify(r).slice(0, 160))
})
await step('Potential → Negotiation asks for quotation, value and timeline', async () => {
  const r = await move(U.ashok, L1, 'negotiation', 'potential')
  must(r.status === 'needs' && ['quotation', 'value', 'timeline'].every(k => r.missing.includes(k)), JSON.stringify(r.missing))
  return `missing ${r.missing.join(', ')}`
})
await step('Ashok logs the quotation, value and timeline; Negotiation works', async () => {
  await log(U.ashok, L1, 'quotation', 'sent', 'Quote Q-1', 'Follow up on quote', day(2))
  await facts(U.ashok, L1, { expected_value_paise: 45000000, timeline: 'December' })
  const r = await move(U.ashok, L1, 'negotiation', 'potential')
  must(r.status === 'moved', JSON.stringify(r).slice(0, 160))
})
await step('Undo removes a wrong log entry', async () => {
  const r = await log(U.ashok, L1, 'whatsapp', 'still_deciding', 'oops', 'Call back', day(1))
  const actId = r.activity?.id ?? r.activity_id
  must(actId, 'log returned no activity id: ' + JSON.stringify(r).slice(0, 200))
  await one(U.ashok, `select public.undo_sales_lead_activity($1)`, [actId])
  const undone = await scalar(`select undone_at is not null from public.sales_lead_activities where id = $1`, [actId])
  must(undone, 'not undone')
})
await step('WhatsApp quick message is logged', async () => {
  const r = await one(U.ashok, `select public.sales_lead_message_sent($1, 'Catalogue')`, [L1])
  return `status ${r.status}`
})
await step('Negotiation → Converted closes the lead, clears the next step', async () => {
  const r = await move(U.ashok, L1, 'converted', 'negotiation')
  const l = await leadRow(L1)
  must(r.status === 'moved' && l.stage === 'converted' && l.closed_at && !l.next_step && !l.next_due_on, JSON.stringify({ s: l.stage, c: l.closed_at }))
})
await step('A converted lead leaves My day and cannot be logged on', async () => {
  const d = await one(U.ashok, `select public.sales_my_day()`)
  must(!JSON.stringify(d.rows ?? d).includes(L1), 'still in My day')
  await expectErr(U.ashok, `select public.sales_lead_no_answer($1)`, /SALES_INVALID/, [L1])
})
await step('Converted lead is on the board under Converted', async () => {
  const b = await one(U.ashok, `select public.sales_board()`)
  must(JSON.stringify(b).includes(L1), 'not on the board')
})

// ── Follow up later and Dead ────────────────────────────────────────────────
const addAllot = async (phone, name, to) => {
  const r = await one(U.leadmgr, `select public.create_sales_lead($1, 'instagram', $2)`, [phone, name])
  await one(U.leadmgr, `select public.allot_sales_lead($1, $2, null)`, [r.lead.id, to])
  return r.lead.id
}
let L2, L3
await step('Follow up later needs a future date; then parks the lead', async () => {
  L2 = await addAllot('+91 98111 00002', 'Cafe Two', U.ashok)
  await expectErr(U.ashok, `select public.move_sales_lead($1, 'follow_up_later', 'new', null, null, 'Call in Jan', $2)`, /SALES_INVALID/, [L2, today])
  const r = await move(U.ashok, L2, 'follow_up_later', 'new', null, null, 'Call in Jan', day(30))
  must(r.status === 'moved', JSON.stringify(r).slice(0, 160))
})
await step('Parked lead is not stuck and leaves today\'s list', async () => {
  const l = await leadRow(L2)
  await db.exec(`update public.sales_leads set stage_changed_at = now() - interval '40 days', assigned_at = now() - interval '40 days' where id = '${L2}'`)
  const stuck = await scalar(`select public.sales_lead_stuck(l) from public.sales_leads l where id = $1`, [L2])
  must(!stuck, 'parked lead shows as stuck')
  const d = await one(U.ashok, `select public.sales_my_day()`)
  return `in My day today: ${JSON.stringify(d).includes(L2)} (due ${l.next_due_on.toISOString().slice(0, 10)})`
})
await step('Parked lead comes back to Under process', async () => {
  const r = await move(U.ashok, L2, 'under_process', 'follow_up_later')
  return `status ${r.status}${r.missing ? ' missing ' + r.missing : ''}`
})
await step('Dead needs a reason; "other" needs a note; then it closes', async () => {
  L3 = await addAllot('+91 98111 00003', 'Resort Three', U.ashok)
  await expectErr(U.ashok, `select public.move_sales_lead($1, 'dead', 'new')`, /SALES_INVALID/, [L3])
  await expectErr(U.ashok, `select public.move_sales_lead($1, 'dead', 'new', 'other')`, /SALES_INVALID/, [L3])
  await expectErr(U.ashok, `select public.move_sales_lead($1, 'dead', 'new', 'made_up_reason')`, /SALES_INVALID/, [L3])
  const r = await move(U.ashok, L3, 'dead', 'new', 'no_requirement')
  const l = await leadRow(L3)
  must(r.status === 'moved' && l.stage === 'dead' && l.dead_reason === 'no_requirement', JSON.stringify({ s: l.stage, r: l.dead_reason }))
})
await step('Two people move the same lead: the second is told it changed', async () => {
  await expectErr(U.ashok, `select public.move_sales_lead($1, 'under_process', 'new')`, /SALES_CHANGED/, [L3])
})

// ── Repeat enquiry ──────────────────────────────────────────────────────────
await step('Same number added again: Lead Master shows the existing lead', async () => {
  const chk = await one(U.leadmgr, `select public.sales_lead_phone_check($1)`, ['98111 00003'])
  const r = await one(U.leadmgr, `select public.create_sales_lead($1, 'website')`, ['+91 98111 00003'])
  must(r.status !== 'created' || r.lead.id === L3, 'created a second lead for the same number')
  return `check ${JSON.stringify(chk).slice(0, 80)} / create status ${r.status}`
})
await step('Recording the repeat enquiry reopens the dead lead as New and tells Ashok', async () => {
  const before = await notesFor(U.ashok, 'sales_lead_enquired_again')
  await one(U.leadmgr, `select public.record_sales_lead_enquiry($1, 'website', 'Called again')`, [L3])
  const l = await leadRow(L3)
  must(l.stage === 'new' && !l.dead_reason, `stage ${l.stage}`)
  must(await notesFor(U.ashok, 'sales_lead_enquired_again') === before + 1, 'no notification')
})

// ── Shortcut checks the owner's rules imply ─────────────────────────────────
await step('Converted straight from New asks for the missing facts instead of closing', async () => {
  const L4 = await addAllot('+91 98111 00004', 'Skip', U.mohit)
  const r = await move(U.mohit, L4, 'converted', 'new')
  must(r.status !== 'moved', 'a New lead with no contact and no value was marked Converted')
})
await step('Converted from Potential without a value asks for it', async () => {
  const L5 = await addAllot('+91 98111 00005', 'Skip2', U.mohit)
  await log(U.mohit, L5, 'call', 'interested', 'ok', 'Call back', day(1))
  await facts(U.mohit, L5, { requirement: 'Tables', quantity: '10' })
  await move(U.mohit, L5, 'potential', (await leadRow(L5)).stage)
  const r = await move(U.mohit, L5, 'converted', 'potential')
  must(r.status !== 'moved', 'converted with no expected value')
})

// ── Manager and lead manager side ───────────────────────────────────────────
await step('Manager opens the Team page data', async () => {
  const t = await one(U.manager, `select public.sales_team_overview($1::date)`, [day(-30)])
  return `keys: ${Object.keys(t).join(', ')}`
})
await step('Senior (juniors only) cannot open the Team page data', async () => {
  const m = await err(U.senior, `select public.sales_team_overview($1::date)`, [day(-30)])
  return m ? 'refused' : 'ALLOWED'
})
await step('Stuck New lead (2 days, no call) shows At risk for the manager', async () => {
  const L6 = await addAllot('+91 98111 00006', 'Late', U.mohit)
  await db.exec(`update public.sales_leads set assigned_at = now() - interval '2 days', stage_changed_at = now() - interval '2 days' where id = '${L6}'`)
  const t = await one(U.manager, `select public.sales_team_overview($1::date)`, [day(-30)])
  must(JSON.stringify(t).includes(L6), 'not in At risk')
})
await step('Manager can Remind the holder (once a day)', async () => {
  const L7 = (await db.query(`select id from public.sales_leads where name = 'Late'`)).rows[0].id
  const a = await one(U.manager, `select public.sales_lead_remind($1)`, [L7])
  const b = await one(U.manager, `select public.sales_lead_remind($1)`, [L7])
  return `${a.status}, then ${b.status}`
})
await step('Lead manager changes holder Ashok → Mohit (needs the old holder to match)', async () => {
  await expectErr(U.leadmgr, `select public.allot_sales_lead($1, $2, $3)`, /SALES_CHANGED/, [L2, U.mohit, U.senior])
  await one(U.leadmgr, `select public.allot_sales_lead($1, $2, $3)`, [L2, U.mohit, U.ashok])
  must(!(await sees(U.ashok, L2)) && (await sees(U.mohit, L2)), 'visibility did not follow the new holder')
})
await step('Lead manager moves all of Ashok\'s due leads to Mohit; manager cannot', async () => {
  await expectErr(U.manager, `select public.reassign_due_sales_leads($1, $2)`, /SALES_FORBIDDEN/, [U.ashok, U.mohit])
  const r = await one(U.leadmgr, `select public.reassign_due_sales_leads($1, $2)`, [U.ashok, U.mohit])
  return JSON.stringify(r).slice(0, 80)
})
await step('A Manager is not given leads by default; ticked "Can be given leads", he is, and works his own', async () => {
  await expectErr(U.leadmgr, `select public.allot_sales_lead($1, $2, null)`, /Sales job/,
    [(await one(U.leadmgr, `select public.create_sales_lead($1, 'website')`, ['+91 98111 00007'])).lead.id, U.manager])
  await one(U.admin, `select public.set_sales_lead_holding($1, true)`, [U.manager])
  const L8 = await addAllot('+91 98111 00008', 'Own', U.manager)
  await one(U.manager, `select public.sales_lead_no_answer($1)`, [L8])
  return 'he can work his own'
})
await step('Admin can do everything a lead manager can', async () => {
  const r = await one(U.admin, `select public.create_sales_lead($1, 'website')`, ['+91 98111 00010'])
  await one(U.admin, `select public.allot_sales_lead($1, $2, null)`, [r.lead.id, U.ashok])
  await one(U.admin, `select public.sales_lead_no_answer($1)`, [r.lead.id])
  await one(U.admin, `select public.sales_team_overview($1::date)`, [day(-30)])
  await one(U.admin, `select public.list_sales_team()`)
})

// ── Alerts ──────────────────────────────────────────────────────────────────
await step('Morning alert job sends follow-ups due, once a day; evening sends missed first calls', async () => {
  await db.exec(`reset role; set role service_role;`)
  try {
    const m1 = (await db.query(`select public.sales_lead_send_alerts('morning') as n`)).rows[0].n
    const m2 = (await db.query(`select public.sales_lead_send_alerts('morning') as n`)).rows[0].n
    const e1 = (await db.query(`select public.sales_lead_send_alerts('evening') as n`)).rows[0].n
    const dow = new Date().getUTCDay()
    return `morning ${m1}, again ${m2}, evening ${e1}${dow === 0 ? ' (Sunday: skipped by design)' : ''}`
  } finally { await db.exec('reset role;') }
})
await step('Browser users cannot fire the alert job', () =>
  expectErr(U.admin, `select public.sales_lead_send_alerts('morning')`, /permission denied/))

{
  // ── The review fixes ──────────────────────────────────────────────────────
  await step('FIX 1: the holder list: Salespeople and whoever is ticked; no Admin, no "No access", no Lead manager by default', async () => {
    const list = await one(U.ashok, `select public.list_sales_lead_holders()`)
    const ids = list.map(p => p.id)
    must([U.manager, U.senior, U.ashok, U.mohit, U.dummy].every(id => ids.includes(id)), 'somebody who can hold leads is missing')
    must(!ids.includes(U.admin) && !ids.includes(U.nobody) && !ids.includes(U.leadmgr), 'admin, no-access or the lead manager is listed')
    await expectErr(U.nobody, `select public.list_sales_lead_holders()`, /SALES_FORBIDDEN/)
  })
  await step('FIX 1: a lead cannot be given to somebody without a Sales job', async () => {
    const r = await one(U.leadmgr, `select public.create_sales_lead($1, 'website')`, ['+91 98111 00020'])
    await expectErr(U.leadmgr, `select public.allot_sales_lead($1, $2, null)`, /Sales job/, [r.lead.id, U.nobody])
  })
  let G
  await step('FIX 2: Converted from New asks for contact, requirement, quantity and value', async () => {
    G = await addAllot('+91 98111 00021', 'Gate', U.mohit)
    const r = await move(U.mohit, G, 'converted', 'new')
    must(r.status === 'needs', `status ${r.status}`)
    must(['contact', 'requirement', 'quantity', 'value'].every(k => r.missing.includes(k)) && !r.missing.includes('quotation'), r.missing.join(','))
    return `missing ${r.missing.join(', ')}`
  })
  await step('FIX 2: with those facts it converts', async () => {
    await log(U.mohit, G, 'call', 'interested', 'Ordered on the call', 'Send PI', day(1))
    await facts(U.mohit, G, { requirement: 'Chairs', quantity: '40', expected_value_paise: 1500000 })
    const r = await move(U.mohit, G, 'converted', (await leadRow(G)).stage)
    must(r.status === 'moved', JSON.stringify(r).slice(0, 160))
  })
  await step('FIX 2: the value cannot be cleared on a Negotiation lead', async () => {
    const N = (await db.query(`select id from public.sales_leads where stage = 'converted' and assigned_to = $1 limit 1`, [U.mohit])).rows[0].id
    const reopened = await move(U.mohit, N, 'negotiation', 'converted')
    must(reopened.status === 'moved', 'could not reopen to Negotiation')
    await expectErr(U.mohit, `select public.update_sales_lead_facts($1, '{"expected_value_paise": ""}'::jsonb)`, /keeps its expected value/, [N])
  })
  await step('FIX 5: Not interested is logged as a call, the lead stays New, then goes Dead', async () => {
    const L = await addAllot('+91 98111 00022', 'Nope', U.mohit)
    await log(U.mohit, L, 'call', 'not_interested', 'Buys elsewhere', 'Close as dead', day(0))
    const l = await leadRow(L)
    must(l.stage === 'new' && l.first_attempt_at && l.first_contact_at, JSON.stringify({ s: l.stage, a: !!l.first_attempt_at }))
    const r = await move(U.mohit, L, 'dead', 'new', 'chose_another_supplier')
    must(r.status === 'moved', 'dead refused')
    must((await leadRow(L)).furthest_rank === 1, 'counted as reaching Under process')
  })
  await step('FIX 7: back out of Follow up later to where it was asks nothing', async () => {
    const r = await one(U.leadmgr, `select public.import_sales_leads($1::jsonb)`, [JSON.stringify([{
      task_id: 'tP', phone: '+91 98111 00023', name: 'Imported potential', source: 'website', stage: 'potential', temperature: 'warm',
      holder_id: U.mohit, next_step: 'Call back', next_due_on: day(3), created_at: '2025-07-30T16:55:41+05:30',
      updated_at: '2026-09-15T17:56:45+05:30', comment_count: 2, latest_comment: 'Wants a quote', clickup_status: 'potential clients', raw: {} }])])
    must(r.created === 1, JSON.stringify(r))
    const P = (await db.query(`select id from public.sales_leads where phone_e164 = '+919811100023'`)).rows[0].id
    await move(U.mohit, P, 'follow_up_later', 'potential', null, null, 'Later', day(10))
    const back = await move(U.mohit, P, 'potential', 'follow_up_later')
    must(back.status === 'moved', `status ${back.status} ${back.missing ?? ''}`)
  })
  await step('FIX 3: an imported lead nobody tried waits for its day in My day and on the Team page', async () => {
    const rows = [
      { task_id: 'tF', phone: '+91 98111 00024', name: 'Future', next_due_on: day(5) },
      { task_id: 'tT', phone: '+91 98111 00025', name: 'Today', next_due_on: day(0) },
    ].map(x => ({ ...x, source: 'website', stage: 'new', temperature: 'warm', holder_id: U.senior, next_step: 'First call',
      created_at: '2026-10-01T10:00:00+05:30', updated_at: '2026-10-01T10:00:00+05:30', comment_count: 0, latest_comment: '', clickup_status: 'new leads', raw: {} }))
    await one(U.leadmgr, `select public.import_sales_leads($1::jsonb)`, [JSON.stringify(rows)])
    await db.exec(`update public.sales_leads set assigned_at = now() - interval '2 days' where phone_e164 in ('+919811100024', '+919811100025')`)
    const d = await one(U.senior, `select public.sales_my_day()`)
    const names = d.rows.map(x => x.name)
    must(!names.includes('Future') && names.includes('Today'), names.join(','))
    must(d.coming_up >= 1, 'future lead not counted in coming up')
    const t = await one(U.manager, `select public.sales_team_overview($1::date)`, [day(-30)])
    const risky = t.at_risk.filter(x => x.problem === 'not_called').map(x => x.name)
    must(!risky.includes('Future'), 'future imported lead is At risk')
  })
  await step('History: the full ClickUp history comes in with its own dates and authors', async () => {
    await one(U.leadmgr, `select public.import_sales_leads($1::jsonb)`, [JSON.stringify([{
      task_id: 'tH', phone: '+91 98111 00026', name: 'History', source: 'website', stage: 'under_process', temperature: 'warm',
      holder_id: U.ashok, next_step: 'Call back', next_due_on: day(2), created_at: '2025-01-10T10:00:00+05:30',
      updated_at: '2026-10-20T18:00:00+05:30', comment_count: 3, latest_comment: 'Will order in December', clickup_status: 'under process', raw: {} }])])
    const H = (await db.query(`select id from public.sales_leads where phone_e164 = '+919811100026'`)).rows[0].id
    const hist = [{ task_id: 'tH', comments: [
      { id: 'c3', at: '2026-10-18T12:30:00+05:30', author: 'Ashok', text: 'Will order in December' },
      { id: 'c2', at: '2025-06-02T15:00:00+05:30', author: 'Ashok', text: 'Sent catalogue' },
      { id: 'c1', at: '2025-01-11T11:00:00+05:30', author: 'Prerna', text: 'First call, wants 200 chairs' },
    ], statuses: [
      { status: 'new leads', at: '2025-01-10T10:00:00+05:30' },
      { status: 'under process', at: '2025-01-11T11:05:00+05:30', current: true },
    ] }, { task_id: 'nope', comments: [{ id: 'cx', at: '2025-01-01T00:00:00Z', author: 'X', text: 'lost' }] }]
    const r = await one(U.leadmgr, `select public.import_sales_lead_history($1::jsonb)`, [JSON.stringify(hist)])
    must(r.comments === 3 && r.statuses === 2 && r.not_imported === 1, JSON.stringify(r))
    const again = await one(U.leadmgr, `select public.import_sales_lead_history($1::jsonb)`, [JSON.stringify(hist)])
    must(again.comments === 0 && again.statuses === 0 && again.already === 5, 'second run added: ' + JSON.stringify(again))
    const detail = await one(U.ashok, `select public.get_sales_lead($1)`, [H])
    const acts = detail.activities.map(a => `${a.at.slice(0, 10)} ${a.note}`)
    must(acts.length === 3, 'expected 3 visible entries, got ' + acts.length + ': ' + acts.join(' | '))
    must(acts[2].startsWith('2025-01-11') && acts[2].includes('Prerna: First call'), acts[2])
    const st = detail.events.filter(e => e.kind === 'clickup_status').map(e => `${e.at.slice(0, 10)} ${e.detail}`)
    const l = await leadRow(H)
    const iso = d => new Date(d).toISOString()
    must(iso(l.first_attempt_at) === iso('2025-01-11T11:00:00+05:30') && iso(l.last_activity_at) === iso('2026-10-18T12:30:00+05:30'), 'clocks not moved')
    must(iso(l.stage_changed_at) === iso('2025-01-11T11:05:00+05:30'), 'stage date not moved')
    await expectErr(U.ashok, `select public.import_sales_lead_history('[]'::jsonb)`, /SALES_FORBIDDEN/)
    return `entries: ${acts.join(' | ')}; statuses: ${st.join(' | ')}`
  })
}

{
  // ── Can be given leads (20270529000000) ───────────────────────────────────
  await step('Unticking the dummy Salesperson takes it out of every list, and an allot to it is refused', async () => {
    const r = await one(U.admin, `select public.set_sales_lead_holding($1, false)`, [U.dummy])
    must(r.can_hold === false, JSON.stringify(r))
    const ids = (await one(U.ashok, `select public.list_sales_lead_holders()`)).map(p => p.id)
    must(!ids.includes(U.dummy), 'the dummy is still listed')
    const L = await one(U.leadmgr, `select public.create_sales_lead($1, 'website')`, ['+91 98111 00030'])
    await expectErr(U.leadmgr, `select public.allot_sales_lead($1, $2, null)`, /Sales job/, [L.lead.id, U.dummy])
  })
  await step('Only Admin sets it; Control Center sees the choice and the result', async () => {
    await expectErr(U.leadmgr, `select public.set_sales_lead_holding($1, true)`, /SALES_FORBIDDEN/, [U.dummy])
    const team = await one(U.admin, `select public.list_sales_team()`)
    const by = id => team.find(m => m.id === id)
    must(by(U.dummy).can_hold === false && by(U.dummy).hold_set === false, 'dummy row')
    must(by(U.manager).can_hold === true && by(U.manager).hold_set === true, 'manager row')
    must(by(U.leadmgr).can_hold === false && by(U.leadmgr).hold_set === null, 'lead manager row')
    must(by(U.ashok).can_hold === true && by(U.ashok).hold_set === null, 'salesperson row')
  })
  await step('Back to what the job means: null removes the choice', async () => {
    await one(U.admin, `select public.set_sales_lead_holding($1, null)`, [U.dummy])
    const ids = (await one(U.ashok, `select public.list_sales_lead_holders()`)).map(p => p.id)
    must(ids.includes(U.dummy), 'a Salesperson with no choice made should be listed again')
    await one(U.admin, `select public.set_sales_lead_holding($1, false)`, [U.dummy])
  })
  await step('Leads already held stay with their holder when the tick is taken off', async () => {
    const held = Number(await scalar(`select count(*) from public.sales_leads where assigned_to = $1`, [U.manager]))
    await one(U.admin, `select public.set_sales_lead_holding($1, false)`, [U.manager])
    must(Number(await scalar(`select count(*) from public.sales_leads where assigned_to = $1`, [U.manager])) === held && held > 0, 'leads moved')
    const own = (await db.query(`select id from public.sales_leads where assigned_to = $1 and stage not in ('converted', 'dead') limit 1`, [U.manager])).rows[0]
    if (own) await one(U.manager, `select public.sales_lead_no_answer($1)`, [own.id])
  })
}

{
  // ── The old Google Sheets (20270530000000) ─────────────────────────────────
  await step('A number only in the sheets becomes an old lead: dated, on nobody\'s board, not in the Not allotted queue', async () => {
    const before = await one(U.leadmgr, `select public.sales_leads_page('all', 'none')`)
    const waiting = (await one(U.leadmgr, `select public.sales_board()`)).waiting_allotment
    const r = await importSheet([sheet(), sheet({ phone: '+91 98111 00041', source: 'bni', received_on: '2024-06-01', detail: 'Leads Master 2024, given to Munmun' })])
    must(r.history === 2 && r.filled === 0, JSON.stringify(r))
    const l = (await db.query(`select * from public.sales_leads where phone_e164 = '+919811100040'`)).rows[0]
    must(l.is_history && !l.assigned_to && l.received_on.toISOString().slice(0, 10) === '2025-03-14' && l.email === 'sheet@hotel.test', 'old lead row')
    const after = await one(U.leadmgr, `select public.sales_leads_page('all', 'none')`)
    must(after.unallotted === before.unallotted && after.total === before.total, 'old leads entered the Not allotted queue')
    must((await one(U.leadmgr, `select public.sales_board()`)).waiting_allotment === waiting, 'old leads counted as waiting')
    const all = await one(U.leadmgr, `select public.sales_leads_page('all', 'all', null, '98111 00040')`)
    must(all.rows.length === 1 && all.rows[0].is_history === true, 'not found in the register')
    const ev = (await one(U.leadmgr, `select public.get_sales_lead($1)`, [l.id])).events.find(e => e.kind === 'imported')
    must(ev && ev.detail === 'Leads Master 2025, given to Monika' && ev.at.startsWith('2025-03-14'), JSON.stringify(ev))
  })
  await step('A number already in BOE One keeps its stage and holder and gains what the sheet knows', async () => {
    const before = await leadRow(L1)
    const r = await importSheet([sheet({ phone: '+91 98111 00001', name: 'Other Name', location: 'Pune', requirement: 'Also wants tables', detail: 'Website form (all_leads), given to Ashok' })])
    must(r.filled === 1 && r.history === 0, JSON.stringify(r))
    const l = await leadRow(L1)
    must(l.stage === before.stage && l.assigned_to === before.assigned_to && l.name === before.name, 'stage, holder or name changed')
    must(l.requirement.includes('Restaurant chairs') && l.requirement.includes('Also wants tables'), 'requirement not added to: ' + l.requirement)
  })
  await step('Twice adds nothing; a new number with no date is not saved; a bad email is dropped', async () => {
    const again = await importSheet([sheet()])
    must(again.already === 1 && again.history === 0, JSON.stringify(again))
    const r = await importSheet([sheet({ phone: '+91 98111 00042', received_on: null }), sheet({ phone: '+91 98111 00043', email: 'not an email' })])
    must(r.failed.length === 1 && r.failed[0].why === 'no date' && r.history === 1, JSON.stringify(r))
    must((await db.query(`select email from public.sales_leads where phone_e164 = '+919811100043'`)).rows[0].email === null, 'bad email kept')
  })
  await step('An old lead that enquires again comes back as a live lead in the queue', async () => {
    const id = (await db.query(`select id from public.sales_leads where phone_e164 = '+919811100040'`)).rows[0].id
    await one(U.leadmgr, `select public.record_sales_lead_enquiry($1, 'website', 'Called again')`, [id])
    must(!(await leadRow(id)).is_history, 'still an old lead')
    const q = await one(U.leadmgr, `select public.sales_leads_page('all', 'none', null, '98111 00040')`)
    must(q.rows.length === 1, 'not in the Not allotted queue')
  })
  await step('Allotting an old lead by hand brings it back too', async () => {
    const id = (await db.query(`select id from public.sales_leads where phone_e164 = '+919811100041'`)).rows[0].id
    await one(U.leadmgr, `select public.allot_sales_lead($1, $2, null)`, [id, U.ashok])
    const l = await leadRow(id)
    must(!l.is_history && l.assigned_to === U.ashok && l.source === 'bni', JSON.stringify({ h: l.is_history, s: l.source }))
  })
}

{
  // ── The website capture (20270531000100) ─────────────────────────────────
  const capture = async rows => {
    await db.exec('reset role; set role service_role;')
    try { return (await db.query('select public.capture_sales_leads($1::jsonb) as r', [JSON.stringify(rows)])).rows[0].r } finally { await db.exec('reset role;') }
  }
  const waiting = async () => Number(await scalar(`select count(*) from public.notifications where type::text = 'sales_lead_waiting'`))
  await step('Only the service role can capture; a signed-in user cannot', async () => {
    await expectErr(U.admin, `select public.capture_sales_leads('[]'::jsonb)`, /permission denied/)
  })
  await step('A new website number becomes a lead waiting to be allotted, and whoever allots is told', async () => {
    const before = await waiting()
    const r = await capture([{ key: 'w1', form_type: 'Google Ads', name: 'Web Hotel', email: 'Web@Hotel.test', phone: '98111 00050', location: 'Goa', message: 'Need 40 chairs' }])
    must(r.created === 1, JSON.stringify(r))
    const l = (await db.query(`select * from public.sales_leads where phone_e164 = '+919811100050'`)).rows[0]
    must(!l.assigned_to && !l.is_history && l.source === 'google_ads' && l.requirement === 'Need 40 chairs' && l.email === 'web@hotel.test', 'lead row')
    must(await waiting() === before + 2, 'Admin and the lead manager should both be told')
    const q = await one(U.leadmgr, `select public.sales_leads_page('all', 'none', null, '98111 00050')`)
    must(q.rows.length === 1, 'not in the Not allotted queue')
  })
  await step('The same form row sent twice counts once; a row without a valid number is reported', async () => {
    const r = await capture([{ key: 'w1', phone: '98111 00050' }, { key: 'w2', phone: '12' }])
    must(r.already === 1 && r.failed.length === 1 && r.failed[0].why === 'no valid number', JSON.stringify(r))
  })
  await step('A known number held by somebody: a repeat, the message added, the holder told to call today', async () => {
    const id = (await db.query(`select id from public.sales_leads where phone_e164 = '+919811100026'`)).rows[0].id
    const before = await notesFor(U.ashok, 'sales_lead_enquired_again')
    const r = await capture([{ key: 'w3', phone: '+91 98111 00026', message: 'Price for 100 chairs?' }])
    must(r.repeat === 1, JSON.stringify(r))
    const l = await leadRow(id)
    must(l.requirement.includes('Price for 100 chairs?') && l.enquired_again_at, 'message or enquiry not recorded')
    must(await notesFor(U.ashok, 'sales_lead_enquired_again') === before + 1, 'holder not told')
  })
  await step('A dead lead that fills the form again comes back as New with its holder', async () => {
    const id = (await db.query(`select id from public.sales_leads where stage = 'dead' and assigned_to is not null limit 1`)).rows[0].id
    const phone = (await leadRow(id)).phone_e164
    await capture([{ key: 'w4', phone, message: 'Back again' }])
    const l = await leadRow(id)
    must(l.stage === 'new' && !l.dead_reason && l.next_step && l.next_due_on, JSON.stringify({ s: l.stage, r: l.dead_reason }))
  })
  await step('An old lead from the sheets that fills the form again goes back to the Not allotted queue', async () => {
    await importSheet([sheet({ phone: '+91 98111 00051', detail: 'Leads Master 2024, given to Monika' })])
    const before = await waiting()
    await capture([{ key: 'w5', phone: '98111 00051', message: 'Hello again' }])
    const l = (await db.query(`select * from public.sales_leads where phone_e164 = '+919811100051'`)).rows[0]
    must(!l.is_history && !l.assigned_to, 'still an old lead')
    must(await waiting() === before + 2, 'allotters not told')
  })
}

console.log(results.join('\n'))
if (fail) { console.log(`\n${fail} of ${pass + fail} checks FAILED`); process.exit(1) }
console.log(`\nall ${pass} checks passed`)
