// One lead's whole life through the REAL Sales migrations, as every role: added in Lead Master, allotted, worked through
// every stage to Converted, parked, Dead, enquired again; then the manager, the lead manager and Admin; then the alerts,
// the fixes of 20270527000000, ClickUp's full history, "Can be given leads" (20270529000000), the two old Google Sheets (20270530000000), the website capture (20270531000000/100), the automatic allotment (20270602000000), the Lead Master date range (20270606000000), the WhatsApp chats (20270609000000) and their judging (20270613000000). Runs in an in-memory Postgres (PGlite) over small stubs, like
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
  '20270531000000_sales_lead_waiting_type.sql', '20270531000100_sales_website_capture.sql', '20270601000000_sales_board_page.sql', '20270602000000_sales_auto_allot.sql',
  '20270606000000_sales_lead_master_date_range.sql', '20270609000000_sales_whatsapp_capture.sql', '20270613000000_sales_whatsapp_classify.sql',
  '20270703000000_sales_admin_can_be_given_leads.sql']) {
  await db.exec(mig(f))
}
// Off until its own checks at the end, so everything before reads exactly as it did before 20270602000000.
await db.exec('update public.sales_auto_allot set is_on = false')

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

// ── Board paging (20270601000000): the next leads of one column ─────────────
{
  const ids = rows => rows.map(r => r.id)
  const PAGE = `select public.sales_board_page($1, $2, $3, $4, $5, $6, $7, $8, $9)`
  const pageFull = (uid, stage, offset, limit, f = {}) =>
    one(uid, PAGE, [stage, offset, limit, f.holder ?? 'all', f.market ?? null, f.segment ?? null, f.temperature ?? null, f.source ?? null, f.q ?? null])
  const page = async (...args) => (await pageFull(...args)).rows
  const board = (uid, f = {}) =>
    one(uid, `select public.sales_board($1, $2, $3, $4, $5, $6)`, [f.holder ?? 'all', f.market ?? null, f.segment ?? null, f.temperature ?? null, f.source ?? null, f.q ?? null])
  const column = (b, stage) => ids(b.rows.filter(r => r.stage === stage))

  await step('Paging: 150 leads for the columns to page through', async () => {
    let n = 0
    for (const [to, count] of [[U.ashok, 130], [U.mohit, 20]]) {
      for (let i = 0; i < count; i++) {
        const phone = `+91 982${String(2000000 + n++).padStart(7, '0')}`
        const r = await one(U.leadmgr, `select public.create_sales_lead($1, 'website', $2)`, [phone, `Paging ${n}`])
        await one(U.leadmgr, `select public.allot_sales_lead($1, $2, null)`, [r.lead.id, to])
      }
    }
    // Mixed temperature, value and due date, so the order has something to decide.
    await db.query(`update public.sales_leads set temperature = (array['hot','warm','cold'])[1 + (lead_no % 3)],
      expected_value_paise = case when lead_no % 4 = 0 then lead_no * 100000 else null end, next_due_on = current_date + ((lead_no % 9)::int - 3)
      where phone_e164 like '+919822%'`)
    return `${n} leads`
  })
  await step('Paging: the first 60 are exactly the 60 the board shows, for every role', async () => {
    for (const [name, uid] of [['ashok', U.ashok], ['mohit', U.mohit], ['senior', U.senior], ['manager', U.manager], ['leadmgr', U.leadmgr], ['admin', U.admin]]) {
      const b = await board(uid)
      for (const stage of ['new', 'under_process', 'potential', 'negotiation', 'follow_up_later', 'converted', 'dead']) {
        const want = column(b, stage), got = ids(await page(uid, stage, 0, 60))
        must(JSON.stringify(want) === JSON.stringify(got), `${name}/${stage}: board ${want.length} rows, page ${got.length}`)
      }
    }
  })
  await step('Paging: the pages cover the whole column once, in the board order', async () => {
    const b = await board(U.ashok), total = b.stages.new.n
    must(total >= 130, `only ${total} New leads for Ashok`)
    const all = []
    for (let offset = 0; ; offset += 40) {
      const rows = await page(U.ashok, 'new', offset, 40)
      if (rows.length === 0) break
      must(rows.length <= 40, 'a page is longer than asked')
      all.push(...ids(rows))
    }
    must(all.length === total, `pages hold ${all.length}, the column has ${total}`)
    must(new Set(all).size === total, 'a lead came twice')
    must(JSON.stringify(all.slice(0, 60)) === JSON.stringify(column(b, 'new')), 'the first 60 are not the board order')
    return `${total} leads in ${Math.ceil(total / 40)} pages`
  })
  await step('Paging: the order is overdue, today, later, then Hot, Warm, Cold, then bigger value', async () => {
    const rows = await page(U.ashok, 'new', 0, 100)
    const today_ = await scalar(`select ((now() at time zone 'Asia/Kolkata')::date)::text`)
    const bucket = r => (r.next_due_on < today_ ? 0 : r.next_due_on === today_ ? 1 : 2)
    const heat = r => ({ hot: 0, warm: 1, cold: 2 })[r.temperature]
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1], c = rows[i]
      must(bucket(a) <= bucket(c), `row ${i}: a later day came before an earlier one`)
      if (bucket(a) === bucket(c)) must(heat(a) <= heat(c), `row ${i}: ${c.temperature} came after ${a.temperature}`)
    }
  })
  await step('Paging: each column says how many it holds, how many are overdue and due today, as the board totals do', async () => {
    for (const uid of [U.ashok, U.leadmgr, U.admin]) {
      const b = await board(uid)
      let overdue = 0, dueToday = 0
      for (const stage of ['new', 'under_process', 'potential', 'negotiation', 'follow_up_later']) {
        const p = await pageFull(uid, stage, 0, 1)
        must(p.n === (b.stages[stage]?.n ?? 0), `${stage}: n ${p.n}, board ${b.stages[stage]?.n}`)
        overdue += p.overdue; dueToday += p.due_today
      }
      must(overdue === b.stats.overdue && dueToday === b.stats.due_today, `overdue ${overdue}/${b.stats.overdue}, today ${dueToday}/${b.stats.due_today}`)
      const parked = await pageFull(uid, 'follow_up_later', 0, 1)
      must(parked.overdue === 0 && parked.due_today === 0, 'a parked lead counted as late')
    }
  })
  await step('Paging: the filters and the search narrow it the same way the board does', async () => {
    for (const f of [{ temperature: 'hot' }, { holder: U.mohit }, { q: 'Paging 7' }, { q: '9822000' }]) {
      const b = await board(U.leadmgr, f)
      const want = column(b, 'new'), got = ids(await page(U.leadmgr, 'new', 0, 60, f))
      must(JSON.stringify(want) === JSON.stringify(got), `${JSON.stringify(f)}: board ${want.length}, page ${got.length}`)
      must(want.length > 0, `${JSON.stringify(f)} found nothing`)
    }
  })
  await step('Paging: a lead closed more than 30 days ago is left out, as on the board', async () => {
    const id = (await one(U.leadmgr, `select public.create_sales_lead($1, 'website', 'Paging dead')`, ['+91 9822999001'])).lead.id
    await one(U.leadmgr, `select public.allot_sales_lead($1, $2, null)`, [id, U.ashok])
    await move(U.ashok, id, 'dead', 'new', 'wrong_number')
    const before = ids(await page(U.leadmgr, 'dead', 0, 100)).length
    await db.query(`update public.sales_leads set closed_at = now() - interval '45 days' where id = $1`, [id])
    const after = ids(await page(U.leadmgr, 'dead', 0, 100))
    must(after.length === before - 1 && !after.includes(id), `before ${before}, after ${after.length}`)
    must(JSON.stringify(column(await board(U.leadmgr), 'dead')) === JSON.stringify(after), 'the board disagrees')
  })
  await step('Paging: a salesperson never gets another salesperson’s leads', async () => {
    const mine = new Set(ids(await page(U.mohit, 'new', 0, 100)))
    const theirs = new Set(ids(await page(U.ashok, 'new', 0, 100)))
    const count = (await board(U.mohit)).stages.new.n
    must(mine.size === count && mine.size >= 20 && [...mine].every(id => !theirs.has(id)), `Mohit sees ${mine.size} of ${count}`)
  })
  await step('Paging: a bad stage, no Sales access and the page size limit', async () => {
    await expectErr(U.ashok, PAGE, /SALES_INVALID/, ['mystery', 0, 40, 'all', null, null, null, null, null])
    await expectErr(U.nobody, PAGE, /SALES_FORBIDDEN/, ['new', 0, 40, 'all', null, null, null, null, null])
    must((await page(U.ashok, 'new', 0, 1000)).length === 100, 'the page size is not capped at 100')
    must((await page(U.ashok, 'new', -5, 0)).length === 1, 'a negative offset or a zero limit is not clamped')
    const anon = await scalar(`select has_function_privilege('anon', 'public.sales_board_page(text, integer, integer, text, text, text, text, text, text)', 'EXECUTE')`)
    must(anon === false, 'open to anon')
  })
}

{
  // ── The automatic allotment (20270602000000) ─────────────────────────────
  const capture = async rows => {
    await db.exec('reset role; set role service_role;')
    try { return (await db.query('select public.capture_sales_leads($1::jsonb) as r', [JSON.stringify(rows)])).rows[0].r } finally { await db.exec('reset role;') }
  }
  const waiting = async () => Number(await scalar(`select count(*) from public.notifications where type::text = 'sales_lead_waiting'`))
  const waitingFor = async phone => (await db.query(`select n.body from public.notifications n join public.sales_leads l on l.id = n.entity_id
    where n.type::text = 'sales_lead_waiting' and l.phone_e164 = $1`, [phone])).rows
  const lead = async phone => (await db.query(`select * from public.sales_leads where phone_e164 = $1`, [phone])).rows[0]
  const lastAllot = async id => (await one(U.leadmgr, `select public.get_sales_lead($1)`, [id])).events.find(e => e.kind === 'allotted' || e.kind === 'reassigned')
  const punch = async (...who) => {
    await db.exec('delete from public.attendance_records')
    for (const u of who) await db.query(`insert into public.attendance_records values ($1, (now() at time zone 'Asia/Kolkata')::date, now())`, [u])
  }
  // A limit of 200 by default: the paging checks above gave Ashok 130 leads and Mohit 20 today, past the real 25.
  const person = (uid, level, exp = false, limit = 200) => one(U.admin, `select public.set_sales_allot_person($1, $2, $3, $4)`, [uid, level, exp, limit])
  const hours = (on, days = '{1,2,3,4,5,6,7}') => one(U.admin, `select public.set_sales_auto_allot($1, $2::integer[], '00:00', '24:00')`, [on, days])

  await step('Only Admin reads and sets the switch and the hours; a bad day or hour is refused', async () => {
    await expectErr(U.leadmgr, `select public.get_sales_auto_allot()`, /SALES_FORBIDDEN/)
    await expectErr(U.leadmgr, `select public.set_sales_auto_allot(true, '{1}', '09:30', '19:00')`, /SALES_FORBIDDEN/)
    await expectErr(U.admin, `select public.set_sales_auto_allot(true, '{}', '09:30', '19:00')`, /at least one working day/)
    await expectErr(U.admin, `select public.set_sales_auto_allot(true, '{1,8}', '09:30', '19:00')`, /at least one working day/)
    await expectErr(U.admin, `select public.set_sales_auto_allot(true, '{1}', '19:00', '09:30')`, /start before it ends/)
    const s = await hours(true, '{7,1,2,3,4,5,6,1}')
    must(s.is_on && s.days.join() === '1,2,3,4,5,6,7' && s.open_now === true && s.ends === '24:00', JSON.stringify(s))
  })
  await step('The owner\'s levels arrive by first name, everybody else is Manual only, and only Admin changes them', async () => {
    const team = await one(U.admin, `select public.list_sales_team()`)
    const of = id => team.find(m => m.id === id)
    must(of(U.ashok).level === 'senior' && of(U.mohit).level === 'senior' && of(U.manager).level === 'manual' && of(U.senior).level === 'manual'
      && of(U.dummy).level === 'manual', JSON.stringify(team.map(m => [m.name, m.level])))
    must(of(U.ashok).daily_limit === 25 && of(U.ashok).takes_export === false, 'defaults')
    await expectErr(U.leadmgr, `select public.set_sales_allot_person($1, 'senior', false, 25)`, /SALES_FORBIDDEN/, [U.senior])
    await expectErr(U.admin, `select public.set_sales_allot_person($1, 'boss', false, 25)`, /Choose a level/, [U.senior])
    await expectErr(U.admin, `select public.set_sales_allot_person($1, 'junior', false, 500)`, /0 to 200/, [U.senior])
    await person(U.ashok, 'senior')
    await person(U.mohit, 'mid')
    await person(U.senior, 'junior')
    const again = await one(U.admin, `select public.list_sales_team()`)
    must(again.find(m => m.id === U.mohit).level === 'mid' && again.find(m => m.id === U.senior).level === 'junior', 'not saved')
  })
  await step('Before anybody punches in, a Premium website lead goes to the Senior by itself, and its history says why', async () => {
    await punch()
    const waitBefore = await waiting()
    const toldBefore = await notesFor(U.ashok, 'sales_lead_allotted')
    const r = await capture([{ key: 'a1', name: 'Grand Restaurant', phone: '98111 00060', message: 'New restaurant, 250 seats' }])
    must(r.created === 1 && r.allotted === 1, JSON.stringify(r))
    const l = await lead('+919811100060')
    must(l.assigned_to === U.ashok && l.next_step === 'First call' && l.next_due_on && !l.assigned_by, JSON.stringify({ to: l.assigned_to, step: l.next_step }))
    const ev = await lastAllot(l.id)
    must(ev.kind === 'allotted' && ev.actor_name === null && /^Premium \(250 seats\) to a Senior, before anyone punched in, \d+ fresh leads?$/.test(ev.detail), JSON.stringify(ev))
    must(await notesFor(U.ashok, 'sales_lead_allotted') === toldBefore + 1, 'the Senior was not told')
    must(await waiting() === waitBefore, 'the allotters were told about a lead that was given')
    must((await one(U.leadmgr, `select public.get_sales_lead($1)`, [l.id])).lead.premium === '250 seats', 'Premium is not on the lead')
  })
  await step('Once somebody punches in, only people who are in are given leads, Premium or not', async () => {
    await punch(U.mohit)
    await capture([{ key: 'a2', phone: '98111 00061', message: 'Hotel, 40 rooms' }, { key: 'a3', phone: '98111 00062', message: 'Need 30 chairs' }])
    const p = await lead('+919811100061'), q = await lead('+919811100062')
    must(p.assigned_to === U.mohit && q.assigned_to === U.mohit, JSON.stringify([p.assigned_to, q.assigned_to]))
    must(/^Premium \(40 rooms\) to a Mid, in today, /.test((await lastAllot(p.id)).detail), 'Premium line')
    must(/^in today, \d+ fresh leads?$/.test((await lastAllot(q.id)).detail), 'plain line')
  })
  await step('Somebody at their daily limit takes no more; with nobody else in, the lead waits and the allotters hear why', async () => {
    await person(U.mohit, 'mid', false, 0)
    const r = await capture([{ key: 'a4', name: 'Late Cafe', phone: '98111 00063', message: 'Need 20 chairs' }])
    must(r.created === 1 && r.allotted === 0 && !(await lead('+919811100063')).assigned_to, JSON.stringify(r))
    const told = await waitingFor('+919811100063')
    must(told.length === 2 && told[0].body.startsWith('Late Cafe. Nobody is free to take it now'), JSON.stringify(told))
  })
  await step('A Backup only when the others are full; Premium tries Senior, Mid, Junior in turn', async () => {
    await punch()
    await person(U.ashok, 'senior', false, 0)
    await person(U.mohit, 'mid')
    await person(U.senior, 'backup')
    await capture([{ key: 'a5', phone: '98111 00064', message: 'Need 10 tables' }])
    must((await lead('+919811100064')).assigned_to === U.mohit, 'a Mid before a Backup, however many fresh leads')
    await person(U.mohit, 'mid', false, 0)
    await capture([{ key: 'a6', phone: '98111 00065', message: 'Need 10 stools' }])
    must((await lead('+919811100065')).assigned_to === U.senior, 'the Backup takes it once everybody else is full')
    await person(U.senior, 'junior')
    await capture([{ key: 'a7', phone: '98111 00069', message: 'Banquet for 300 guests' }])
    const l = await lead('+919811100069')
    must(l.assigned_to === U.senior && /^Premium \(300 guests\) to a Junior, /.test((await lastAllot(l.id)).detail), 'the Junior after a full Senior and Mid')
  })
  await step('An export number goes to somebody with the Export tick', async () => {
    await person(U.ashok, 'senior')
    await person(U.mohit, 'mid')
    await person(U.senior, 'junior', true)
    await capture([{ key: 'a8', phone: '+44 7700 900123', message: 'Chairs for a pub' }])
    const l = await lead('+447700900123')
    must(l.assigned_to === U.senior && /takes export leads/.test((await lastAllot(l.id)).detail), 'not the Export tick')
  })
  await step('Manual only people, and anybody who cannot be given leads, are never given one automatically', async () => {
    const n = Number(await scalar(`select count(*) from public.sales_lead_events where actor is null and kind in ('allotted', 'reassigned')
      and detail is not null and to_user in ('${U.manager}', '${U.dummy}', '${U.leadmgr}', '${U.admin}')`))
    must(n === 0, n + ' given to Manual only people')
  })
  await step('Outside the working days a lead waits for the morning; switched off it waits for a person', async () => {
    const today = Number(await scalar(`select extract(isodow from now() at time zone 'Asia/Kolkata')::int`))
    await hours(true, `{${today === 1 ? 2 : 1}}`)
    await capture([{ key: 'a9', name: 'Night Hotel', phone: '98111 00066', message: 'Need 50 chairs' }])
    must(!(await lead('+919811100066')).assigned_to, 'given outside the working days')
    must((await waitingFor('+919811100066'))[0].body.startsWith('Night Hotel. It will be allotted automatically next working morning.'), 'morning note')
    await hours(false)
    await capture([{ key: 'a10', name: 'Off Hotel', phone: '98111 00067' }])
    must(!(await lead('+919811100067')).assigned_to && (await waitingFor('+919811100067'))[0].body === 'Off Hotel. Allot it in Lead Master.', 'switched-off note')
  })
  await step('"Allot waiting leads now" gives what waits, for whoever allots; old ClickUp and sheet leads stay put', async () => {
    await expectErr(U.ashok, `select public.allot_waiting_sales_leads()`, /SALES_FORBIDDEN/)
    const r = await one(U.leadmgr, `select public.allot_waiting_sales_leads()`)
    must(r.allotted >= 3, JSON.stringify(r))
    for (const p of ['+919811100063', '+919811100066', '+919811100067']) must((await lead(p)).assigned_to, p + ' still waiting')
    const old = Number(await scalar(`select count(*) from public.sales_leads l where l.imported_at is not null
      and (l.enquired_again_at is null or l.enquired_again_at <= l.imported_at)
      and exists (select 1 from public.sales_lead_events e where e.lead_id = l.id and e.actor is null and e.kind = 'allotted' and e.detail is not null)`))
    const sheetLead = await lead('+919811100043')
    must(old === 0 && sheetLead.is_history && !sheetLead.assigned_to, `${old} old ClickUp leads given, or an old sheet lead`)
  })
  await step('The morning run gives what waits before its alerts (it rests on Sundays)', async () => {
    await hours(false)
    await capture([{ key: 'a11', phone: '98111 00068', message: 'Need 12 stools' }])
    await hours(true)
    await db.query(`select public.sales_lead_send_alerts('morning')`)
    const sunday = Number(await scalar(`select extract(dow from (now() at time zone 'Asia/Kolkata')::date)::int`)) === 0
    must(Boolean((await lead('+919811100068')).assigned_to) === !sunday, 'the morning run')
    return sunday ? 'Sunday: the run rests' : ''
  })
  await step('A returning customer stays with their holder; once that holder can no longer be given leads, the rule picks again', async () => {
    const id = (await lead('+919811100060')).id
    await capture([{ key: 'a12', phone: '98111 00060', message: 'Any update?' }])
    must((await lead('+919811100060')).assigned_to === U.ashok, 'moved while Ashok can still be given leads')
    await one(U.admin, `select public.set_sales_lead_holding($1, false)`, [U.ashok])
    const before = await notesFor(U.ashok, 'sales_lead_enquired_again')
    const r = await capture([{ key: 'a13', phone: '98111 00060', message: 'Hello?' }])
    const now_ = await lead('+919811100060')
    must(r.repeat === 1 && r.allotted === 1 && now_.assigned_to && now_.assigned_to !== U.ashok, JSON.stringify(r))
    const ev = await lastAllot(id)
    must(ev.kind === 'reassigned' && ev.from_name === 'Ashok' && ev.actor_name === null && ev.detail.startsWith('Premium (250 seats)'), JSON.stringify(ev))
    must(await notesFor(U.ashok, 'sales_lead_enquired_again') === before, 'Ashok was told although the lead left him')
    await one(U.admin, `select public.set_sales_lead_holding($1, null)`, [U.ashok])
  })
  await step('The Team page lists a Premium lead a Junior or Backup was given this week, for managers only', async () => {
    await expectErr(U.ashok, `select public.sales_premium_misplaced()`, /SALES_FORBIDDEN/)
    const rows = await one(U.manager, `select public.sales_premium_misplaced()`)
    must(rows.some(r => r.phone === '+919811100069' && r.level === 'junior' && r.premium === '300 guests'), JSON.stringify(rows.map(r => [r.phone, r.level, r.premium])))
    must(!rows.some(r => r.phone === '+919811100061'), 'a Mid holding a Premium lead is fine')
  })
}

{
  // ── Chats on WhatsApp become leads (20270609000000) ──────────────────────
  const asService = async (sql, rows) => {
    await db.exec('reset role; set role service_role;')
    try { return (await db.query(sql, [JSON.stringify(rows)])).rows[0].r } finally { await db.exec('reset role;') }
  }
  const chat = rows => asService('select public.capture_sales_chats($1::jsonb) as r', rows)
  const web = rows => asService('select public.capture_sales_leads($1::jsonb) as r', rows)
  const lead = async phone => (await db.query(`select * from public.sales_leads where phone_e164 = $1`, [phone])).rows[0]
  const events = async id => (await db.query(`select kind, detail, actor from public.sales_lead_events where lead_id = $1 order by at, id`, [id])).rows
  const clicks = async id => (await db.query(`select ad_id, headline, source_url, ctwa_clid from public.sales_lead_ad_clicks where lead_id = $1 order by at`, [id])).rows
  const waitingFor = async phone => (await db.query(`select n.title, n.body from public.notifications n join public.sales_leads l on l.id = n.entity_id
    where n.type::text = 'sales_lead_waiting' and l.phone_e164 = $1`, [phone])).rows
  // Make a lead's last word from the client N days old: its creation, its last enquiry and every chat message it remembers.
  // created_at never changes in real life (a trigger refuses it), so the test switches triggers off to age a lead.
  const age = async (id, days) => {
    await db.exec('set session_replication_role = replica;')
    try { await db.query(`update public.sales_leads set created_at = now() - make_interval(days => $2), enquired_again_at = null where id = $1`, [id, days]) }
    finally { await db.exec('set session_replication_role = default;') }
    await db.query(`update public.sales_lead_import_refs set at = now() - make_interval(days => $2) where lead_id = $1 and ref like 'wa:%'`, [id, days])
  }
  const punch = async (...who) => {
    await db.exec('delete from public.attendance_records')
    for (const u of who) await db.query(`insert into public.attendance_records values ($1, (now() at time zone 'Asia/Kolkata')::date, now())`, [u])
  }
  const person = (uid, level, exp = false, limit = 200) => one(U.admin, `select public.set_sales_allot_person($1, $2, $3, $4)`, [uid, level, exp, limit])
  const hours = (on) => one(U.admin, `select public.set_sales_auto_allot($1, '{1,2,3,4,5,6,7}'::integer[], '00:00', '24:00')`, [on])
  const P1 = '+919811100070', P2 = '+919811100071'

  await step('Only the service role can capture a chat, and a browser cannot read the ad clicks', async () => {
    await expectErr(U.admin, `select public.capture_sales_chats('[]'::jsonb)`, /permission denied/)
    await expectErr(U.leadmgr, `select count(*) from public.sales_lead_ad_clicks`, /permission denied/)
    await db.exec('reset role; set role service_role;')
    try { await db.query(`select public.capture_sales_chats('[]'::jsonb)`) } finally { await db.exec('reset role;') }
  })
  await step('A new number that writes in becomes a WhatsApp lead, given by the same rule as a website lead, and the history says so', async () => {
    await person(U.ashok, 'senior'); await person(U.mohit, 'mid'); await person(U.senior, 'junior')
    await hours(true)
    await punch()
    const before = await notesFor(U.ashok, 'sales_lead_allotted')
    const r = await chat([{ key: 'wamid.1', phone: P1, name: 'Chat Hotel', message: 'Need 250 seats for a new restaurant' }])
    must(r.created === 1 && r.allotted === 1 && r.ignored === 0 && r.failed.length === 0, JSON.stringify(r))
    const l = await lead(P1)
    must(l.source === 'whatsapp' && l.name === 'Chat Hotel' && l.requirement === 'Need 250 seats for a new restaurant', JSON.stringify([l.source, l.name, l.requirement]))
    must(l.assigned_to === U.ashok && l.assigned_by === null && l.next_step === 'First call', 'Premium to the Senior, first call')
    must(await notesFor(U.ashok, 'sales_lead_allotted') === before + 1, 'the holder was not told')
    const ev = await events(l.id)
    must(ev[0].kind === 'added' && ev[0].detail === 'WhatsApp chat' && ev[0].actor === null, JSON.stringify(ev[0]))
    must(ev.some(e => e.kind === 'allotted' && /^Premium \(250 seats\) to a Senior/.test(e.detail)), JSON.stringify(ev))
    must((await clicks(l.id)).length === 0, 'an ad that is not there')
  })
  await step('A message Meta sends twice counts once', async () => {
    const r = await chat([{ key: 'wamid.1', phone: P1, name: 'Chat Hotel', message: 'Need 250 seats for a new restaurant' }])
    must(r.created === 0 && r.already === 1 && r.ignored === 0 && r.repeat === 0, JSON.stringify(r))
    must(Number(await scalar(`select count(*) from public.sales_leads where phone_e164 = $1`, [P1])) === 1, 'two leads')
  })
  await step('The same client writing again the same day goes on in WhatsApp: remembered, not a new enquiry, nobody pinged', async () => {
    const l = await lead(P1)
    const evBefore = (await events(l.id)).length
    const told = await notesFor(U.ashok, 'sales_lead_enquired_again')
    const r = await chat([{ key: 'wamid.2', phone: P1, message: 'ok thanks, call me' }, { key: 'wamid.2b', phone: P1, message: 'hello?' }])
    must(r.ignored === 2 && r.repeat === 0 && r.created === 0, JSON.stringify(r))
    const now_ = await lead(P1)
    must(now_.requirement === l.requirement && (await events(l.id)).length === evBefore, 'the lead changed')
    must(await notesFor(U.ashok, 'sales_lead_enquired_again') === told, 'the holder was pinged')
    must(Number(await scalar(`select count(*) from public.sales_lead_import_refs where ref in ('wa:wamid.2', 'wa:wamid.2b')`)) === 2, 'not remembered')
  })
  await step('A chat from an ad is a new enquiry at once: the holder is told, the ad is kept, and the history names it', async () => {
    const l = await lead(P1)
    const told = await notesFor(U.ashok, 'sales_lead_enquired_again')
    const r = await chat([{ key: 'wamid.3', phone: P1, message: 'Saw your ad', ad_id: '120226305854810726', ad_headline: 'Hotel furniture',
      ad_url: 'https://fb.example/ad', ctwa_clid: 'AbC123' }])
    must(r.repeat === 1 && r.ignored === 0 && r.created === 0, JSON.stringify(r))
    must(await notesFor(U.ashok, 'sales_lead_enquired_again') === told + 1, 'the holder was not told')
    const ev = await events(l.id)
    must(ev[ev.length - 1].kind === 'enquired_again' && ev[ev.length - 1].detail === 'WhatsApp ad: Hotel furniture' && ev[ev.length - 1].actor === null, JSON.stringify(ev[ev.length - 1]))
    must(JSON.stringify(await clicks(l.id)) === JSON.stringify([{ ad_id: '120226305854810726', headline: 'Hotel furniture', source_url: 'https://fb.example/ad', ctwa_clid: 'AbC123' }]), 'the ad')
    must((await lead(P1)).requirement.includes('Saw your ad'), 'the words were not added')
    must((await lead(P1)).assigned_to === U.ashok, 'the holder changed')
  })
  await step('A new number that comes from an ad keeps the ad from the first message', async () => {
    const r = await chat([{ key: 'wamid.4', phone: P2, name: 'Ad Cafe', message: 'Price for 30 chairs?', ad_id: '99', ad_headline: null }])
    must(r.created === 1, JSON.stringify(r))
    const l = await lead(P2)
    must(JSON.stringify(await clicks(l.id)) === JSON.stringify([{ ad_id: '99', headline: null, source_url: null, ctwa_clid: null }]), 'the ad')
    must((await events(l.id))[0].detail === 'WhatsApp ad: 99', 'the history names the ad id when there is no headline')
  })
  await step('Quiet for 3 days: a client who writes after 2 days is still the same conversation, after 4 days an enquiry again', async () => {
    const l = await lead(P2)
    await age(l.id, 2)
    must((await chat([{ key: 'wamid.5', phone: P2, message: 'any news' }])).ignored === 1, 'two days is still talking')
    await age(l.id, 4)
    const told = await notesFor(l.assigned_to, 'sales_lead_enquired_again')
    const r = await chat([{ key: 'wamid.6', phone: P2, message: 'Are you there? I need 30 chairs by March' }])
    must(r.repeat === 1 && r.ignored === 0, JSON.stringify(r))
    must(await notesFor(l.assigned_to, 'sales_lead_enquired_again') === told + 1, 'the holder was not told')
    const ev = await events(l.id)
    must(ev[ev.length - 1].kind === 'enquired_again' && ev[ev.length - 1].detail === 'WhatsApp chat', JSON.stringify(ev[ev.length - 1]))
    must((await lead(P2)).requirement.endsWith('I need 30 chairs by March'), 'the words were not added')
    must((await chat([{ key: 'wamid.7', phone: P2, message: 'thanks' }])).ignored === 1, 'the enquiry just now is talking again')
  })
  await step('A Dead lead whose client writes after a quiet spell comes back as New, with a call today', async () => {
    const l = await lead(P2)
    await db.query(`update public.sales_leads set stage = 'dead', dead_reason = 'not_relevant', closed_at = now() where id = $1`, [l.id])
    await age(l.id, 5)
    const r = await chat([{ key: 'wamid.8', phone: P2, message: 'Sorry, I still need them' }])
    const back = await lead(P2)
    must(r.repeat === 1 && back.stage === 'new' && back.dead_reason === null && back.closed_at === null, JSON.stringify([r, back.stage]))
    must(back.next_step && String(back.next_due_on).length > 0, 'no next step')
  })
  await step('With nobody free, or after hours, a new chat waits and the allotters hear it was a WhatsApp lead', async () => {
    await hours(false)
    const r = await chat([{ key: 'wamid.9', phone: '+919811100072', name: 'Night Chat', message: 'Need 20 tables' }])
    must(r.created === 1 && r.allotted === 0, JSON.stringify(r))
    const l = await lead('+919811100072')
    must(!l.assigned_to && l.source === 'whatsapp', 'given although switched off')
    const told = await waitingFor('+919811100072')
    must(told.length >= 2 && told.every(t => t.title === 'New lead from WhatsApp' && t.body === 'Night Chat. Allot it in Lead Master. Need 20 tables'), JSON.stringify(told))
    await hours(true)
  })
  await step('A number the database cannot use is reported, the other messages in the batch still land, and a batch of more than 100 is refused', async () => {
    const r = await chat([{ key: 'wamid.10', phone: '12', message: 'x' }, { key: 'wamid.11', phone: '+919811100073', message: 'Need 8 stools' }])
    must(r.failed.length === 1 && r.failed[0].why === 'no valid number' && r.created === 1, JSON.stringify(r))
    await db.exec('reset role; set role service_role;')
    try {
      const rows = Array.from({ length: 101 }, (_, i) => ({ key: 'big' + i, phone: '+919811100074' }))
      let m = null
      try { await db.query('select public.capture_sales_chats($1::jsonb)', [JSON.stringify(rows)]) } catch (e) { m = e.message }
      must(m && /up to 100 rows/.test(m), 'not refused: ' + m)
    } finally { await db.exec('reset role;') }
  })
  await step('The website capture is untouched: a form still becomes a Website lead, and the same number writing in WhatsApp later is ignored that day', async () => {
    const r = await web([{ key: 'wk1', name: 'Form Hotel', phone: '98111 00075', message: 'Need 40 chairs' }])
    must(r.created === 1, JSON.stringify(r))
    const l = await lead('+919811100075')
    must(l.source === 'website', l.source)
    const c = await chat([{ key: 'wamid.12', phone: '+919811100075', message: 'I just filled your form' }])
    must(c.ignored === 1 && c.repeat === 0, JSON.stringify(c))
    must((await events(l.id)).filter(e => e.kind === 'enquired_again').length === 0, 'a form then a chat is one enquiry')
  })

  // ── Is it a lead? The route's verdict (20270613000000). Every check above ran on the new capture with no verdict. ──
  const lead_ = (key, phone, message, kind, extra = {}) =>
    ({ key, phone, name: extra.name ?? null, message, ...extra, verdict: { kind, category: extra.category ?? null, reason: extra.reason ?? null, via: 'ai' } })
  const held = async phone => (await db.query(`select * from public.sales_whatsapp_held where phone_e164 = $1`, [phone])).rows[0]
  const context = phones => asService('select public.sales_chat_context($1::jsonb) as r', phones)
  const J1 = '+919811100081', J2 = '+919811100082', J3 = '+919811100083', J4 = '+919811100084', J5 = '+919811100085', J6 = '+919811100086'

  await step('Judged a lead: the same lead as before, tagged Auto-detected with the reason, given by the same rule', async () => {
    const r = await chat([lead_('wj.1', J1, 'Need 40 chairs for my cafe', 'lead', { name: 'Cafe One', reason: 'Asks for 40 chairs for a cafe' })])
    must(r.created === 1 && r.held === 0, JSON.stringify(r))
    const l = await lead(J1)
    must(l.wa_tag === 'detected' && l.wa_reason === 'Asks for 40 chairs for a cafe' && l.source === 'whatsapp', JSON.stringify([l.wa_tag, l.wa_reason]))
    must(r.allotted === 1 ? !!l.assigned_to : (await waitingFor(J1)).some(t => t.title === 'New lead from WhatsApp'), 'neither given nor told')
    must((await events(l.id))[0].detail === 'WhatsApp chat', 'the history line changed')
    const row = (await one(U.leadmgr, `select public.get_sales_lead($1)`, [l.id])).lead
    must(row.wa_tag === 'detected' && row.wa_reason === 'Asks for 40 chairs for a cafe' && 'premium' in row, 'the screens do not see the tag')
  })
  await step('Judged not a lead: no lead, nobody told, the words held with the reason; a resend counts once', async () => {
    const notes = Number(await scalar(`select count(*) from public.notifications`))
    const r = await chat([lead_('wj.2', J2, 'I want a job in your factory', 'other', { name: 'Ravi', category: 'job_seeker', reason: 'Asks for a job' })])
    must(r.held === 1 && r.created === 0, JSON.stringify(r))
    must(!(await lead(J2)), 'a job seeker became a lead')
    const h = await held(J2)
    must(h.category === 'job_seeker' && h.reason === 'Asks for a job' && h.name === 'Ravi' && h.status === 'held', JSON.stringify(h))
    must(h.messages.length === 1 && h.messages[0].text === 'I want a job in your factory' && h.messages[0].key === 'wj.2', JSON.stringify(h.messages))
    must(Number(await scalar(`select count(*) from public.notifications`)) === notes, 'somebody was told about a job seeker')
    const again = await chat([lead_('wj.2', J2, 'I want a job in your factory', 'other', { category: 'job_seeker' })])
    must(again.already === 1 && again.held === 0 && (await held(J2)).messages.length === 1, JSON.stringify(again))
  })
  await step('A held number keeps only its last 5 messages, and its next message is judged with them: "Hi" then a real ask is a lead with every word', async () => {
    for (let i = 3; i <= 8; i++) await chat([lead_(`wj.${i}`, J3, `msg ${i}`, 'other', { category: 'personal' })])
    must((await held(J3)).messages.map(m => m.text).join(',') === 'msg 4,msg 5,msg 6,msg 7,msg 8', JSON.stringify((await held(J3)).messages))
    const ctx = await context([J3, J1, '+919811100099'])
    // jsonb keeps its keys sorted: compare sorted.
    const same_ = (a, b) => JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort())
    must(same_(ctx[J3], { known: false, held: ['msg 4', 'msg 5', 'msg 6', 'msg 7', 'msg 8'] }), JSON.stringify(ctx[J3]))
    must(same_(ctx[J1], { known: true }), 'a known lead must say nothing more: ' + JSON.stringify(ctx[J1]))
    must(same_(ctx['+919811100099'], { known: false, held: [] }), JSON.stringify(ctx['+919811100099']))
    const r = await chat([lead_('wj.9', J3, 'Actually I need 12 dining chairs', 'lead', { reason: 'Asks for 12 dining chairs' })])
    must(r.created === 1, JSON.stringify(r))
    const l = await lead(J3)
    must(l.requirement === 'msg 4\nmsg 5\nmsg 6\nmsg 7\nmsg 8\nActually I need 12 dining chairs', JSON.stringify(l.requirement))
    must(!(await held(J3)), 'the held words stayed after the number became a lead')
  })
  await step('Unclear ("Hi"): a lead tagged Check that nobody is given, and the allotters hear "WhatsApp chat to check"', async () => {
    await hours(true)
    const r = await chat([lead_('wj.10', J4, 'Hi', 'unclear', { name: 'Someone', reason: 'Only says hi' })])
    must(r.created === 1 && r.allotted === 0, JSON.stringify(r))
    const l = await lead(J4)
    must(l.wa_tag === 'check' && !l.assigned_to, JSON.stringify([l.wa_tag, l.assigned_to]))
    const told = await waitingFor(J4)
    must(told.length >= 2 && told.every(t => t.title === 'WhatsApp chat to check' && t.body.startsWith('Someone. Could not tell if this is a lead')), JSON.stringify(told))
    const ctx = await context([J4])
    must(ctx[J4].known === true && ctx[J4].check === true && ctx[J4].words === 'Hi', JSON.stringify(ctx[J4]))
  })
  await step('A Check lead nobody holds keeps listening: a next message that is not a lead only adds its words, a lead verdict makes it a lead given by the rule', async () => {
    const r1 = await chat([lead_('wj.11', J4, 'what are you', 'unclear')])
    must(r1.ignored === 1 && (await lead(J4)).wa_tag === 'check' && (await lead(J4)).requirement === 'Hi\n\nwhat are you', JSON.stringify([r1, (await lead(J4)).requirement]))
    const r2 = await chat([lead_('wj.12', J4, 'I need a sofa set for my hotel lobby', 'lead', { reason: 'Asks for a sofa set for a hotel' })])
    must(r2.promoted === 1 && r2.created === 0, JSON.stringify(r2))
    const l = await lead(J4)
    must(l.wa_tag === 'detected' && l.wa_reason === 'Asks for a sofa set for a hotel' && l.requirement.endsWith('I need a sofa set for my hotel lobby'), JSON.stringify([l.wa_tag, l.wa_reason, l.requirement]))
    must(r2.allotted === 1 ? !!l.assigned_to : (await waitingFor(J4)).some(t => t.title === 'New lead from WhatsApp'), 'neither given nor told')
    // Now an ordinary lead: its next message the same day is the conversation going on, not judged, not added.
    const r3 = await chat([{ key: 'wj.13', phone: J4, message: 'ok' }])
    must(r3.ignored === 1 && !(await lead(J4)).requirement.endsWith('ok'), JSON.stringify(r3))
  })
  await step('A chat from an ad is a lead whatever the verdict says', async () => {
    const r = await chat([lead_('wj.14', J5, 'We supply plywood', 'other', { category: 'supplier', ad_id: 'AD7', ad_headline: 'Chairs' })])
    must(r.created === 1 && r.held === 0 && (await lead(J5)).wa_tag === 'detected', JSON.stringify(r))
    // A Check lead whose client then opens the chat from an ad: a lead at once, and the ad is kept.
    const J7 = '+919811100090'
    await chat([lead_('wj.18', J7, 'Hello', 'unclear')])
    const r2 = await chat([lead_('wj.19', J7, 'Saw this chair in your ad', 'lead', { ad_id: 'AD8', ad_headline: 'Cafe chairs', reason: 'Opened the chat from an ad' })])
    const l = await lead(J7)
    must(r2.promoted === 1 && l.wa_tag === 'detected', JSON.stringify([r2, l.wa_tag]))
    must(JSON.stringify(await clicks(l.id)) === JSON.stringify([{ ad_id: 'AD8', headline: 'Cafe chairs', source_url: null, ctwa_clid: null }]), 'the ad was not kept')
  })
  await step('Merged messages: every id is remembered, so a resend of any of them counts once', async () => {
    const r = await chat([{ ...lead_('wj.15', J6, 'Hello\nNeed 6 bar stools', 'lead'), keys: ['wj.16', 'wj.17'] }])
    must(r.created === 1, JSON.stringify(r))
    must(Number(await scalar(`select count(*) from public.sales_lead_import_refs where ref in ('wa:wj.15', 'wa:wj.16', 'wa:wj.17')`)) === 3, 'not all remembered')
    must((await chat([{ key: 'wj.16', phone: J6, message: 'Need 6 bar stools' }])).already === 1, 'a resend of a merged message counted again')
  })

  // ── Filtered chats: people who allot ──
  const P_JOB = '+919811100087', P_TRUCK = '+919811100088'
  await chat([lead_('wj.20', P_JOB, 'Sending my CV for the carpenter post', 'other', { name: 'Job Hunter', category: 'job_seeker', reason: 'Sends a CV' })])
  await chat([lead_('wj.21', P_TRUCK, 'We give trucks pan India', 'other', { category: 'transport', reason: 'Offers trucks' })])
  const heldId = async phone => (await held(phone)).id

  await step('Only people with Sales assign (and Admin) read Filtered chats; nobody reads the table directly', async () => {
    const list = await one(U.leadmgr, `select public.list_whatsapp_held_chats()`)
    const job = list.rows.find(x => x.phone === P_JOB)
    must(job && job.category === 'job_seeker' && job.reason === 'Sends a CV' && JSON.stringify(job.messages) === JSON.stringify(['Sending my CV for the carpenter post']), JSON.stringify(job))
    must(list.rows.length >= 3 && list.rows[0].last_at >= list.rows[list.rows.length - 1].last_at, 'newest first')
    must((await one(U.admin, `select public.list_whatsapp_held_chats()`)).rows.length === list.rows.length, 'admin sees a different list')
    await expectErr(U.ashok, `select public.list_whatsapp_held_chats()`, /SALES_FORBIDDEN/)
    await expectErr(U.manager, `select public.list_whatsapp_held_chats()`, /SALES_FORBIDDEN/)
    await expectErr(U.leadmgr, `select count(*) from public.sales_whatsapp_held`, /permission denied/)
    await expectErr(U.leadmgr, `select public.sales_chat_context('[]'::jsonb)`, /permission denied/)
    await expectErr(U.ashok, `select public.make_whatsapp_chat_a_lead($1)`, /SALES_FORBIDDEN/, [await heldId(P_JOB)])
    await expectErr(U.ashok, `select public.clear_whatsapp_held_chat($1)`, /SALES_FORBIDDEN/, [await heldId(P_JOB)])
  })
  await step('"This is a lead": a WhatsApp lead tagged From Filtered chats, by that person, NOT allotted, and gone from the list', async () => {
    const id = await heldId(P_JOB)
    const r = await one(U.leadmgr, `select public.make_whatsapp_chat_a_lead($1)`, [id])
    must(r.status === 'created' && r.lead.wa_tag === 'hand' && r.lead.source === 'whatsapp' && r.lead.name === 'Job Hunter', JSON.stringify(r))
    const l = await lead(P_JOB)
    must(!l.assigned_to && l.created_by === U.leadmgr && l.requirement === 'Sending my CV for the carpenter post', JSON.stringify(l))
    const ev = await events(l.id)
    must(ev.length === 1 && ev[0].kind === 'added' && ev[0].detail === 'WhatsApp chat' && ev[0].actor === U.leadmgr, JSON.stringify(ev))
    must(!(await held(P_JOB)), 'still held')
    await expectErr(U.leadmgr, `select public.make_whatsapp_chat_a_lead($1)`, /SALES_NOT_FOUND/, [id])
  })
  await step('"Clear": out of the list for good; the number writing again is still judged, and a real ask still becomes a lead', async () => {
    await one(U.leadmgr, `select public.clear_whatsapp_held_chat($1)`, [await heldId(P_TRUCK)])
    const listed = async () => (await one(U.leadmgr, `select public.list_whatsapp_held_chats()`)).rows.some(x => x.phone === P_TRUCK)
    must(!(await listed()), 'still listed')
    await chat([lead_('wj.22', P_TRUCK, 'Special rates this week', 'other', { category: 'transport' })])
    must(!(await listed()) && (await held(P_TRUCK)).status === 'cleared' && (await held(P_TRUCK)).messages.length === 2, 'came back after Clear')
    const r = await chat([lead_('wj.23', P_TRUCK, 'Also we need 10 office chairs', 'lead')])
    must(r.created === 1 && !(await held(P_TRUCK)), JSON.stringify(r))
  })
  await step('Held words are gone 30 days after their last message', async () => {
    const OLD = '+919811100089'
    await chat([lead_('wj.24', OLD, 'Bulk SMS offer', 'other', { category: 'service_seller' })])
    await db.query(`update public.sales_whatsapp_held set last_at = now() - interval '31 days' where phone_e164 = $1`, [OLD])
    must((await one(U.leadmgr, `select public.list_whatsapp_held_chats()`)).rows.every(x => x.phone !== OLD), 'listed after 30 days')
    await chat([lead_('wj.25', J1, 'thanks', 'lead')])
    must(!(await held(OLD)), 'kept after 30 days')
  })
}

// ── The Lead Master date range (20270606000000) ─────────────────────────────
{
  // Six leads on known days: today, two yesterday, 3 days ago, 10 and 40 days ago. All found by the digits "98111900".
  const days = [0, -1, -1, -3, -10, -40]
  const ids = []
  for (const [i, n] of days.entries()) {
    ids.push(await scalar(`insert into public.sales_leads (phone_e164, source, received_on) values ($1, 'website', $2::date) returning id`,
      [`+91981119000${i + 1}`, day(n)]))
  }
  const [TODAY, YEST_A, YEST_B, THREE, TEN, FORTY] = ids.map((_, i) => `+91981119000${i + 1}`)
  const pageR = (uid, from, to, period = 'all') =>
    one(uid, `select public.sales_leads_page($1, 'all', null, '98111900', 50, 0, $2::date, $3::date)`, [period, from, to])
  const phonesOf = p => p.rows.map(r => r.phone).sort()
  const same = (got, want) => must(JSON.stringify(got) === JSON.stringify([...want].sort()), `got ${JSON.stringify(got)}, wanted ${JSON.stringify([...want].sort())}`)

  await step('Yesterday: only the leads received the day before, and the Yesterday count says the same', async () => {
    const p = await pageR(U.leadmgr, null, null, 'yesterday')
    same(phonesOf(p), [YEST_A, YEST_B])
    must(p.total === 2, 'total ' + p.total)
    const all = await one(U.leadmgr, `select public.sales_leads_page('all')`)
    const direct = Number(await scalar(`select count(*) from public.sales_leads where received_on = $1::date`, [day(-1)]))
    must(all.periods.yesterday === direct, `periods.yesterday ${all.periods.yesterday}, counted ${direct}`)
  })
  await step('A range: both days included, either bound alone is open-ended, a pair the wrong way round is the range between', async () => {
    same(phonesOf(await pageR(U.leadmgr, day(-3), day(-1))), [THREE, YEST_A, YEST_B])
    same(phonesOf(await pageR(U.leadmgr, day(-1), day(-3))), [THREE, YEST_A, YEST_B])
    same(phonesOf(await pageR(U.leadmgr, day(-1), day(-1))), [YEST_A, YEST_B])
    same(phonesOf(await pageR(U.leadmgr, day(-3), null)), [TODAY, YEST_A, YEST_B, THREE])
    same(phonesOf(await pageR(U.leadmgr, null, day(-3))), [THREE, TEN, FORTY])
    same(phonesOf(await pageR(U.leadmgr, day(-30), day(-5))), [TEN])
    same(phonesOf(await pageR(U.leadmgr, day(-400), day(-300))), [])
  })
  await step('Chosen days win over the period; the period cards still count the whole register', async () => {
    const p = await pageR(U.leadmgr, day(-3), day(-1), 'today')
    same(phonesOf(p), [THREE, YEST_A, YEST_B])
    must(p.periods.all >= 6 && p.periods.today >= 1, JSON.stringify(p.periods))
  })
  await step('The screen that is live now (six arguments, no dates) still gets the same answers', async () => {
    const six = async period => phonesOf(await one(U.leadmgr, `select public.sales_leads_page($1, 'all', null, '98111900', 50, 0)`, [period]))
    same(await six('today'), [TODAY])
    same(await six('week'), [TODAY, YEST_A, YEST_B, THREE])
    same(await six('month'), [TODAY, YEST_A, YEST_B, THREE, TEN])
    same(await six('all'), [TODAY, YEST_A, YEST_B, THREE, TEN, FORTY])
  })
  await step('Who holds how many follows the chosen days', async () => {
    await one(U.leadmgr, `select public.allot_sales_lead($1, $2, null)`, [ids[1], U.ashok])
    await one(U.leadmgr, `select public.allot_sales_lead($1, $2, null)`, [ids[3], U.ashok])
    const heldBy = async (from, to) => (await pageR(U.leadmgr, from, to)).holders.find(h => h.id === U.ashok)?.n ?? 0
    must(await heldBy(day(-1), day(-1)) === 1, 'yesterday only')
    must(await heldBy(day(-3), day(-1)) === 2, 'three days')
    must(await heldBy(day(-300), day(-200)) === 0, 'no leads in that range')
    const p = await pageR(U.leadmgr, day(-3), day(-1))
    must(p.everyone === 3 && p.unallotted === 1, `everyone ${p.everyone}, unallotted ${p.unallotted}`)
    const mine = await one(U.leadmgr, `select public.sales_leads_page('all', $1, null, '98111900', 50, 0, $2::date, $3::date)`, [U.ashok, day(-3), day(-1)])
    same(phonesOf(mine), [THREE, YEST_A])
  })
  await step('A date range does not widen what anyone sees: a salesperson reads only their own leads, and a stranger is refused', async () => {
    same(phonesOf(await pageR(U.ashok, day(-3), day(-1))), [THREE, YEST_A])
    same(phonesOf(await pageR(U.mohit, day(-3), day(-1))), [])
    await expectErr(U.nobody, `select public.sales_leads_page('all', 'all', null, null, 50, 0, $1::date, $2::date)`, /SALES_FORBIDDEN/, [day(-3), day(-1)])
  })
  await step('The old six-argument function is gone and the new one is closed to anon', async () => {
    must(await scalar(`select to_regprocedure('public.sales_leads_page(text, text, text, text, integer, integer)') is null`), 'old function still there')
    must(await scalar(`select not has_function_privilege('anon', 'public.sales_leads_page(text, text, text, text, integer, integer, date, date)', 'EXECUTE')`), 'open to anon')
    must(await scalar(`select has_function_privilege('authenticated', 'public.sales_leads_page(text, text, text, text, integer, integer, date, date)', 'EXECUTE')`), 'authenticated lost it')
  })
}

{
  // ── An Admin can be given leads (20270703000000) ──────────────────────────
  await step('An Admin is never given a lead by default: not listed, not in Control Center as holding, and an allot is refused', async () => {
    const ids = (await one(U.ashok, `select public.list_sales_lead_holders()`)).map(p => p.id)
    must(!ids.includes(U.admin), 'the Admin is listed without a tick')
    const row = (await one(U.admin, `select public.list_sales_team()`)).find(m => m.id === U.admin)
    must(row && row.is_admin && row.can_hold === false && row.hold_set === null, JSON.stringify(row))
    const L = await one(U.leadmgr, `select public.create_sales_lead($1, 'website')`, ['+91 97111 00940'])
    await expectErr(U.leadmgr, `select public.allot_sales_lead($1, $2, null)`, /Sales job/, [L.lead.id, U.admin])
  })
  await step('Ticked, the Admin is listed, can be allotted a lead, and works it; only Admin can tick', async () => {
    await expectErr(U.leadmgr, `select public.set_sales_lead_holding($1, true)`, /SALES_FORBIDDEN/, [U.admin])
    const r = await one(U.admin, `select public.set_sales_lead_holding($1, true)`, [U.admin])
    must(r.can_hold === true, JSON.stringify(r))
    const ids = (await one(U.leadmgr, `select public.list_sales_lead_holders()`)).map(p => p.id)
    must(ids.includes(U.admin), 'the ticked Admin is not listed')
    const row = (await one(U.admin, `select public.list_sales_team()`)).find(m => m.id === U.admin)
    must(row.can_hold === true && row.hold_set === true && row.level === 'manual', JSON.stringify(row))
    const L = await one(U.leadmgr, `select public.create_sales_lead($1, 'website')`, ['+91 97111 00941'])
    await one(U.leadmgr, `select public.allot_sales_lead($1, $2, null)`, [L.lead.id, U.admin])
    must(await scalar(`select assigned_to = $2 from public.sales_leads where id = $1`, [L.lead.id, U.admin]), 'not held by the Admin')
    const w = await one(U.admin, `select public.sales_lead_no_answer($1)`, [L.lead.id])
    must(w.status === 'saved', JSON.stringify(w))
    // A salesperson still reads only their own leads: the Admin holding one does not widen anything.
    await expectErr(U.mohit, `select public.sales_lead_no_answer($1)`, /SALES_NOT_FOUND|SALES_FORBIDDEN/, [L.lead.id])
  })
  await step('Taking the tick off (null) removes the Admin from every list; the lead they hold stays with them', async () => {
    const held = Number(await scalar(`select count(*) from public.sales_leads where assigned_to = $1`, [U.admin]))
    const r = await one(U.admin, `select public.set_sales_lead_holding($1, null)`, [U.admin])
    must(r.can_hold === false, JSON.stringify(r))
    const ids = (await one(U.leadmgr, `select public.list_sales_lead_holders()`)).map(p => p.id)
    must(!ids.includes(U.admin), 'still listed after the tick came off')
    must(Number(await scalar(`select count(*) from public.sales_leads where assigned_to = $1`, [U.admin])) === held && held > 0, 'the lead moved')
  })
  await step('Everybody who is not an Admin is decided exactly as before', async () => {
    const team = await one(U.admin, `select public.list_sales_team()`)
    const by = id => team.find(m => m.id === id)
    must(by(U.ashok).can_hold === true && by(U.ashok).hold_set === null, 'salesperson')
    must(by(U.leadmgr).can_hold === false && by(U.leadmgr).hold_set === null, 'lead manager')
    must(by(U.nobody).can_hold === false, 'no Sales job')
  })
  await step('sales_lead_can_hold is still internal: a browser cannot call it', async () => {
    must(await scalar(`select not has_function_privilege('authenticated', 'public.sales_lead_can_hold(uuid)', 'EXECUTE')`), 'open to authenticated')
  })
}

{
  // ── Comments, follow-up dates and the next working day (20270703000100) ──
  // Applied here, so every check above reads exactly as it did before.
  await db.exec(mig('20270703000100_sales_comments_and_due_dates.sql'))
  const isSun = d => new Date(`${d}T00:00:00Z`).getUTCDay() === 0
  const nwd = isSun(day(1)) ? day(2) : day(1)
  const fresh = async phone => {
    const L = await one(U.leadmgr, `select public.create_sales_lead($1, 'website')`, [phone])
    await one(U.leadmgr, `select public.allot_sales_lead($1, $2, null)`, [L.lead.id, U.ashok])
    return L.lead.id
  }
  const lead = id => db.query(`select * from public.sales_leads where id = $1`, [id]).then(r => r.rows[0])
  const comment = (uid, id, note, tag = null, due = null) =>
    one(uid, `select public.add_sales_lead_comment($1, $2, $3, $4::date)`, [id, note, tag, due])

  await step('The next working day skips a Sunday and nothing else', async () => {
    must(await scalar(`select public.sales_next_working_day('2026-11-13') = '2026-11-14'`), 'Fri to Sat')
    must(await scalar(`select public.sales_next_working_day('2026-11-14') = '2026-11-16'`), 'Sat to Mon')
    must(await scalar(`select public.sales_next_working_day('2026-11-15') = '2026-11-16'`), 'Sun to Mon')
  })
  await step('A plain comment on a New lead: a note, a contact, Under process, follow-up the next working day', async () => {
    const id = await fresh('+91 97111 00950')
    const r = await comment(U.ashok, id, 'Spoke to him, wants 60 chairs')
    must(r.status === 'saved' && r.streak === 0, JSON.stringify(r))
    const l = await lead(id)
    must(l.stage === 'under_process' && l.first_contact_at && l.next_step === 'Follow up', `stage ${l.stage}`)
    must(await scalar(`select next_due_on::text = $2 from public.sales_leads where id = $1`, [id, nwd]), 'due')
    const a = (await db.query(`select kind, outcome, note from public.sales_lead_activities where lead_id = $1 and undone_at is null`, [id])).rows
    must(a.length === 1 && a[0].kind === 'note' && a[0].outcome === 'note' && a[0].note === 'Spoke to him, wants 60 chairs', JSON.stringify(a))
    must(Number(await scalar(`select count(*) from public.sales_lead_events where lead_id = $1 and kind = 'moved' and detail = 'new>under_process'`, [id])) === 1, 'no move line')
  })
  await step('"Client not responding" on a New lead: a try, not a contact; Under process; the streak counts', async () => {
    const id = await fresh('+91 97111 00951')
    const r = await comment(U.ashok, id, 'Client not responding.', 'not_responding')
    must(r.streak === 1, JSON.stringify(r))
    const l = await lead(id)
    must(l.stage === 'under_process' && !l.first_contact_at && l.first_attempt_at, `stage ${l.stage}, contact ${l.first_contact_at}`)
    must(await scalar(`select outcome = 'no_answer' from public.sales_lead_activities where lead_id = $1`, [id]), 'outcome')
    const r2 = await comment(U.ashok, id, 'Still not responding.', 'not_responding', day(3))
    must(r2.streak === 2 && await scalar(`select next_due_on::text = $2 from public.sales_leads where id = $1`, [id, day(3)]), 'chosen date')
  })
  await step('The No answer button on a New lead moves it to Under process, back on the next working day', async () => {
    const id = await fresh('+91 97111 00952')
    const r = await one(U.ashok, `select public.sales_lead_no_answer($1)`, [id])
    must(r.streak === 1 && r.lead.stage === 'under_process', JSON.stringify(r.lead?.stage))
    must(await scalar(`select next_due_on::text = $2 from public.sales_leads where id = $1`, [id, nwd]), 'not the next working day')
  })
  await step('Undo of the comment puts the lead back in New, with its old date', async () => {
    const id = await fresh('+91 97111 00953')
    const before = await scalar(`select next_due_on::text from public.sales_leads where id = $1`, [id])
    const r = await comment(U.ashok, id, 'Called, he picked up')
    await one(U.ashok, `select public.undo_sales_lead_activity($1)`, [r.activity_id])
    const l = await lead(id)
    must(l.stage === 'new' && !l.first_contact_at, `stage ${l.stage}`)
    must(await scalar(`select next_due_on::text = $2 from public.sales_leads where id = $1`, [id, before]), 'date not put back')
  })
  await step('"Shared quotation" is a logged quotation, so the lead shows one sent', async () => {
    const id = await fresh('+91 97111 00954')
    await comment(U.ashok, id, 'Shared the quotation.', 'quotation')
    must(await scalar(`select kind = 'quotation' and outcome = 'sent' from public.sales_lead_activities where lead_id = $1`, [id]), 'kind')
    const d = await one(U.ashok, `select public.get_sales_lead($1)`, [id])
    must(d.quotation_sent === true, JSON.stringify(d.quotation_sent))
  })
  await step('A comment is refused when empty, in the past, with an unknown note, on a closed lead, or by somebody else', async () => {
    const id = await fresh('+91 97111 00955')
    await expectErr(U.ashok, `select public.add_sales_lead_comment($1, '   ')`, /Write what happened/, [id])
    await expectErr(U.ashok, `select public.add_sales_lead_comment($1, 'x', null, $2::date)`, /past/, [id, day(-1)])
    await expectErr(U.ashok, `select public.add_sales_lead_comment($1, 'x', 'meeting')`, /Unknown quick note/, [id])
    await expectErr(U.mohit, `select public.add_sales_lead_comment($1, 'x')`, /SALES_NOT_FOUND|SALES_FORBIDDEN/, [id])
    await move(U.ashok, id, 'dead', 'new', 'wrong_number')
    await expectErr(U.ashok, `select public.add_sales_lead_comment($1, 'x')`, /Reopen/, [id])
  })
  await step('The follow-up date changes in any open stage, with a history line; past, closed and strangers are refused', async () => {
    const id = await fresh('+91 97111 00956')
    const was = await scalar(`select next_due_on::text from public.sales_leads where id = $1`, [id])
    const r = await one(U.ashok, `select public.change_sales_lead_due($1, $2::date)`, [id, day(5)])
    must(r.status === 'saved' && await scalar(`select next_due_on::text = $2 from public.sales_leads where id = $1`, [id, day(5)]), JSON.stringify(r.status))
    must(await scalar(`select detail = $2 from public.sales_lead_events where lead_id = $1 and kind = 'due_changed'`, [id, `${was}>${day(5)}`]), 'history line')
    must((await one(U.ashok, `select public.change_sales_lead_due($1, $2::date)`, [id, day(5)])).status === 'unchanged', 'same date')
    await expectErr(U.ashok, `select public.change_sales_lead_due($1, $2::date)`, /past/, [id, day(-2)])
    await expectErr(U.mohit, `select public.change_sales_lead_due($1, $2::date)`, /SALES_NOT_FOUND|SALES_FORBIDDEN/, [id, day(4)])
    await move(U.ashok, id, 'follow_up_later', 'new', null, null, 'Call back', day(20))
    must((await one(U.ashok, `select public.change_sales_lead_due($1, $2::date)`, [id, day(9)])).status === 'saved', 'follow up later')
    await move(U.ashok, id, 'dead', 'follow_up_later', 'wrong_number')
    await expectErr(U.ashok, `select public.change_sales_lead_due($1, $2::date)`, /closed lead/, [id, day(4)])
  })
  await step('The two writes are for signed-in people only; the helpers are internal', async () => {
    must(await scalar(`select not has_function_privilege('anon', 'public.add_sales_lead_comment(uuid, text, text, date)', 'EXECUTE')`), 'anon comment')
    must(await scalar(`select not has_function_privilege('anon', 'public.change_sales_lead_due(uuid, date)', 'EXECUTE')`), 'anon due')
    must(await scalar(`select not has_function_privilege('authenticated', 'public.sales_next_working_day(date)', 'EXECUTE')`), 'helper open')
  })
}

console.log(results.join('\n'))
if (fail) { console.log(`\n${fail} of ${pass + fail} checks FAILED`); process.exit(1) }
console.log(`\nall ${pass} checks passed`)
