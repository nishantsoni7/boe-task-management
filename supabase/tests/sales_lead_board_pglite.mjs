// Database regression suite for 20270525000000 (Sales, Lead Board). Runs the REAL migrations in an in-memory Postgres
// (PGlite) over small stubs of the platform objects they depend on, the same way sales_lead_master_pglite.mjs does. Run:
//   node supabase/tests/sales_lead_board_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all N checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node sales_lead_board_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
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
  senior:  '00000000-0000-0000-0000-0000000000b3', // view + named access to Ashok
  manager: '00000000-0000-0000-0000-0000000000b4', // view + view_all
  allot:   '00000000-0000-0000-0000-0000000000b5', // view + assign
  adder:   '00000000-0000-0000-0000-0000000000b6', // view + create
  nobody:  '00000000-0000-0000-0000-0000000000b7', // no grant
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
  insert into public.users (id, full_name, role, team, is_active) values
    ('${U.admin}', 'Nishant Soni', 'admin', null, true),
    ('${U.ashok}', 'Ashok', 'employee', 'sales', true), ('${U.mohit}', 'Mohit', 'employee', 'sales', true),
    ('${U.senior}', 'Senior', 'employee', 'sales', true), ('${U.manager}', 'Manager', 'employee', null, true),
    ('${U.allot}', 'Allotter', 'employee', null, true), ('${U.adder}', 'Adder', 'employee', null, true),
    ('${U.nobody}', 'No Access', 'employee', null, true);
  insert into public.grants values
    ('${U.ashok}', 'sales', 'view'), ('${U.mohit}', 'sales', 'view'), ('${U.senior}', 'sales', 'view'),
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

// A lead allotted BEFORE this migration arrives, the way production may hold some.
const early = await one(U.adder, `select public.create_sales_lead('+919000000001', 'website', 'Early')`)
await one(U.allot, `select public.allot_sales_lead($1, $2, null)`, [early.lead.id, U.ashok])

await db.exec(mig('20270525000000_sales_lead_board.sql'))
ok('the migration applies over a live register, self-checks included')

{
  const { rows } = await db.query(`select stage, next_step, next_due_on is not null as dated, market from public.sales_leads where id = $1`, [early.lead.id])
  assert.deepEqual(rows[0], { stage: 'new', next_step: 'First call', dated: true, market: 'domestic' })
  ok('a lead allotted before the migration gets its first step')
}

const add = async (phone, name, extra = {}) => {
  const r = await one(U.adder, `select public.create_sales_lead($1, 'website', $2)`, [phone, name])
  if (extra.to) await one(U.allot, `select public.allot_sales_lead($1, $2, null)`, [r.lead.id, extra.to])
  return r.lead.id
}
const aL = await add('+919000000002', 'Ashok Lead', { to: U.ashok })
const mL = await add('+971500000003', 'Mohit Export', { to: U.mohit })
const fresh = await add('+919000000004', 'Not allotted yet')

// ── Who sees what ──────────────────────────────────────────────────────────
{
  const ids = async (uid) => (await one(uid, `select public.sales_board()`)).rows.map(r => r.id).sort()
  assert.deepEqual(await ids(U.ashok), [early.lead.id, aL].sort())
  assert.deepEqual(await ids(U.mohit), [mL])
  ok('a salesperson sees only their own leads on the board')
  await db.exec(`insert into public.sales_lead_access (viewer_id, subject_id) values ('${U.senior}', '${U.ashok}')`)
  assert.deepEqual(await ids(U.senior), [early.lead.id, aL].sort())
  ok('a senior sees the juniors named for them, and nobody else')
  assert.equal((await ids(U.manager)).length, 3)
  assert.equal((await ids(U.allot)).length, 3)
  assert.equal((await ids(U.admin)).length, 3)
  ok('view_all, assign and Admin see every allotted lead')
  const page = await one(U.ashok, `select public.sales_leads_page('all')`)
  assert.deepEqual(page.rows.map(r => r.id).sort(), [early.lead.id, aL].sort())
  assert.equal(page.periods.all, 2)
  ok('the Lead Master list and its counts follow the same rule')
  const adderPage = await one(U.adder, `select public.sales_leads_page('all')`)
  assert.deepEqual(adderPage.rows.map(r => r.id), [fresh])
  ok('a person who adds leads sees what they added until it is allotted')
  assert.equal((await as(U.ashok, `select id from public.sales_leads`)).rows.length, 2)
  assert.equal((await as(U.nobody, `select id from public.sales_leads`)).rows.length, 0)
  ok('reading the table directly is limited in the same way')
  await refused(U.ashok, `select public.get_sales_lead($1)`, /SALES_NOT_FOUND/, [mL])
  ok('a lead somebody else holds cannot be opened by its id')
  const check = await one(U.ashok, `select public.sales_lead_phone_check('+971500000003')`)
  assert.equal(check.state, 'exists')
  assert.equal(check.lead.holder_name, 'Mohit')
  assert.equal(check.lead.requirement, undefined)
  assert.equal(check.lead.name, undefined)
  ok('the duplicate check names the holder and shows nothing else')
  await refused(U.nobody, `select public.sales_my_day()`, /SALES_FORBIDDEN/)
  ok('no Sales access, no My day')
}

// ── My day ─────────────────────────────────────────────────────────────────
{
  const day = await one(U.ashok, `select public.sales_my_day()`)
  assert.equal(day.rows.length, 2)
  assert.equal(day.done_today, 0)
  assert.ok(day.rows.every(r => r.next_step === 'First call'))
  ok('an allotted lead appears on My day with its first step')
}

// ── Working a lead ─────────────────────────────────────────────────────────
const tomorrow = `(now() at time zone 'Asia/Kolkata')::date + 1`
{
  await refused(U.mohit, `select public.log_sales_lead_activity($1, 'call', 'interested', 'x', 'Call', ${tomorrow})`, /SALES_NOT_FOUND/, [aL])
  await refused(U.senior, `select public.log_sales_lead_activity($1, 'call', 'interested', 'x', 'Call', ${tomorrow})`, /SALES_FORBIDDEN/, [aL])
  await refused(U.manager, `select public.sales_lead_no_answer($1)`, /SALES_FORBIDDEN/, [aL])
  ok('only the holder, Admin or assign can work a lead: a senior and a manager read it')
  await refused(U.ashok, `select public.log_sales_lead_activity($1, 'call', 'interested', 'x', '', ${tomorrow})`, /Choose the next step/, [aL])
  await refused(U.ashok, `select public.log_sales_lead_activity($1, 'call', 'interested', 'x', 'Call', null)`, /Choose the next step/, [aL])
  await refused(U.ashok, `select public.log_sales_lead_activity($1, 'call', 'interested', 'x', 'Call', current_date - 5)`, /in the past/, [aL])
  ok('an entry cannot be posted without a next step and a date that has not passed')
  await assert.rejects(() => db.exec(`update public.sales_leads set next_step = null where id = '${aL}'`), /sales_leads_open_has_next_step/)
  ok('the database itself refuses an open lead with no next step')

  const no1 = await one(U.ashok, `select public.sales_lead_no_answer($1)`, [aL])
  assert.equal(no1.streak, 1)
  assert.equal(no1.lead.stage, 'new')
  assert.equal(no1.lead.next_step, 'First call')
  assert.ok(no1.lead.first_attempt_at)
  assert.equal(no1.lead.first_contact_at, null)
  ok('No answer counts as a try, not as contact, and comes back tomorrow')
  const undone = await one(U.ashok, `select public.undo_sales_lead_activity($1)`, [no1.activity_id])
  assert.equal(undone.lead.no_answer_streak, 0)
  assert.equal(undone.lead.first_attempt_at, null)
  const detail = await one(U.ashok, `select public.get_sales_lead($1)`, [aL])
  assert.equal(detail.activities.length, 0)
  ok('Undo puts everything back, and the entry leaves the history shown')
  await refused(U.ashok, `select public.undo_sales_lead_activity($1)`, /SALES_NOT_FOUND/, [no1.activity_id])
  ok('an entry cannot be undone twice')
  await assert.rejects(() => db.exec(`update public.sales_lead_activities set note = 'changed' where id = '${no1.activity_id}'`), /APPEND_ONLY/)
  await assert.rejects(() => db.exec(`delete from public.sales_lead_activities where id = '${no1.activity_id}'`), /APPEND_ONLY/)
  ok('a logged entry can never be edited or deleted')

  for (let i = 0; i < 3; i++) await one(U.ashok, `select public.sales_lead_no_answer($1)`, [aL])
  assert.equal((await one(U.ashok, `select public.get_sales_lead($1)`, [aL])).lead.no_answer_streak, 3)
  ok('three unanswered calls are counted')

  const moved = await one(U.ashok, `select public.move_sales_lead($1, 'under_process', 'new')`, [aL])
  assert.deepEqual(moved.missing, ['contact'])
  assert.equal(moved.status, 'needs')
  ok('a lead cannot leave New on unanswered calls alone')

  const log = await one(U.ashok, `select public.log_sales_lead_activity($1, 'call', 'interested', 'Spoke to the owner', 'Send quotation', ${tomorrow})`, [aL])
  assert.equal(log.lead.stage, 'under_process')
  assert.equal(log.lead.no_answer_streak, 0)
  assert.equal(log.lead.next_step, 'Send quotation')
  assert.equal(log.lead.last_kind, 'call')
  ok('a real reply moves a New lead on, clears the count, and sets the next step')
  const u2 = await one(U.ashok, `select public.undo_sales_lead_activity($1)`, [log.activity_id])
  assert.equal(u2.lead.stage, 'new')
  assert.equal(u2.lead.no_answer_streak, 3)
  ok('Undo takes that automatic move back too')
  const log2 = await one(U.ashok, `select public.log_sales_lead_activity($1, 'call', 'interested', 'Spoke to the owner', 'Send quotation', ${tomorrow})`, [aL])
  assert.equal(log2.lead.stage, 'under_process')
  await one(U.ashok, `select public.log_sales_lead_activity($1, 'whatsapp', 'still_deciding', null, 'Call back', ${tomorrow})`, [aL])
  await refused(U.ashok, `select public.undo_sales_lead_activity($1)`, /can no longer be undone/, [log2.activity_id])
  ok('only the latest entry can be undone')
  await refused(U.admin, `select public.undo_sales_lead_activity($1)`, /SALES_NOT_FOUND/, [log2.activity_id])
  ok('only the person who logged it can undo it')
}

// ── The stage checklist ────────────────────────────────────────────────────
{
  const needs1 = await one(U.ashok, `select public.move_sales_lead($1, 'potential', 'under_process')`, [aL])
  assert.deepEqual(needs1.missing, ['requirement', 'quantity'])
  await one(U.ashok, `select public.update_sales_lead_facts($1, '{"requirement":"Hotel chairs","quantity":"80 chairs","name":"Hotel Sai"}'::jsonb)`, [aL])
  const up = await one(U.ashok, `select public.move_sales_lead($1, 'potential', 'under_process')`, [aL])
  assert.equal(up.status, 'moved')
  assert.equal(up.lead.name, 'Hotel Sai')
  ok('Potential client needs the requirement and the quantity, and the salesperson can add them')

  const needs2 = await one(U.ashok, `select public.move_sales_lead($1, 'negotiation', 'potential')`, [aL])
  assert.deepEqual(needs2.missing, ['quotation', 'value', 'timeline'])
  await one(U.ashok, `select public.log_sales_lead_activity($1, 'quotation', 'interested', null, 'Call back', ${tomorrow})`, [aL])
  await one(U.ashok, `select public.update_sales_lead_facts($1, '{"expected_value_paise":140000000,"timeline":"By March","temperature":"hot"}'::jsonb)`, [aL])
  const neg = await one(U.ashok, `select public.move_sales_lead($1, 'negotiation', 'potential')`, [aL])
  assert.equal(neg.status, 'moved')
  assert.equal(neg.lead.temperature, 'hot')
  ok('Negotiation needs the quotation, the expected value and the timeline')

  const back = await one(U.ashok, `select public.move_sales_lead($1, 'under_process', 'negotiation')`, [aL])
  assert.equal(back.status, 'moved')
  ok('moving back is never checked')
  await refused(U.ashok, `select public.move_sales_lead($1, 'potential', 'negotiation')`, /SALES_CHANGED/, [aL])
  ok('a stale board cannot move a lead')
  await one(U.ashok, `select public.move_sales_lead($1, 'negotiation', 'under_process')`, [aL])

  await refused(U.ashok, `select public.move_sales_lead($1, 'dead', 'negotiation')`, /Choose why/, [aL])
  await refused(U.ashok, `select public.move_sales_lead($1, 'dead', 'negotiation', 'other')`, /Say why/, [aL])
  await refused(U.ashok, `select public.move_sales_lead($1, 'dead', 'negotiation', 'because')`, /Check the details/, [aL])
  const dead = await one(U.ashok, `select public.move_sales_lead($1, 'dead', 'negotiation', 'price_too_high')`, [aL])
  assert.equal(dead.lead.stage, 'dead')
  assert.equal(dead.lead.dead_reason, 'price_too_high')
  assert.equal(dead.lead.next_step, null)
  assert.ok(dead.lead.closed_at)
  assert.equal(dead.lead.quantity, '80 chairs')
  ok('Dead asks for a reason from the list, "Other" needs a note, and every detail stays')
  await refused(U.ashok, `select public.log_sales_lead_activity($1, 'call', 'interested', 'x', 'Call', ${tomorrow})`, /Reopen this lead/, [aL])
  ok('a closed lead takes no entries until it is reopened')

  const again = await one(U.adder, `select public.record_sales_lead_enquiry($1, 'whatsapp', 'Asked again')`, [aL])
  assert.equal(again.status, 'saved')
  const reopened = await one(U.ashok, `select public.get_sales_lead($1)`, [aL])
  assert.equal(reopened.lead.stage, 'new')
  assert.equal(reopened.lead.next_step, 'Call back')
  assert.equal(reopened.lead.dead_reason, null)
  assert.ok(reopened.lead.enquired_again_at)
  assert.ok((await one(U.ashok, `select public.sales_my_day()`)).rows.some(r => r.id === aL))
  ok('a repeat enquiry reopens a dead lead and puts it back on its holder\'s day')
  await refused(U.ashok, `select public.record_sales_lead_enquiry($1, 'whatsapp')`, /SALES_FORBIDDEN/, [mL])
  ok('recording a repeat enquiry needs the right to add leads')

  await refused(U.ashok, `select public.move_sales_lead($1, 'follow_up_later', 'new')`, /Choose the day/, [aL])
  const parked = await one(U.ashok, `select public.move_sales_lead($1, 'follow_up_later', 'new', null, null, 'Call after Diwali', current_date + 30)`, [aL])
  assert.equal(parked.lead.next_step, 'Call after Diwali')
  const parkedDay = await one(U.ashok, `select public.sales_my_day()`)
  assert.ok(!parkedDay.rows.some(r => r.id === aL))
  ok('Follow up later needs a date, and the lead leaves My day until then')
  await db.exec(`update public.sales_leads set next_due_on = current_date where id = '${aL}'`)
  assert.ok((await one(U.ashok, `select public.sales_my_day()`)).rows.some(r => r.id === aL))
  ok('a parked lead wakes by itself when its date comes')

  const won = await one(U.ashok, `select public.move_sales_lead($1, 'converted', 'follow_up_later')`, [aL])
  assert.equal(won.lead.stage, 'converted')
  assert.equal(won.lead.quantity, '80 chairs')
  ok('Converted needs nothing more, and every detail stays')
}

// ── Red cards ──────────────────────────────────────────────────────────────
{
  const stuckOf = async id => (await one(U.admin, `select public.get_sales_lead($1)`, [id])).lead.stuck
  assert.equal(await stuckOf(early.lead.id), false)
  await db.exec(`update public.sales_leads set assigned_at = now() - interval '2 days', stage_changed_at = now() - interval '2 days', created_at = created_at where id = '${early.lead.id}'`)
  assert.equal(await stuckOf(early.lead.id), true)
  ok('a New lead nobody touched for a day goes red')
  await db.exec(`update public.sales_leads set stage = 'follow_up_later', next_due_on = current_date + 90 where id = '${early.lead.id}'`)
  assert.equal(await stuckOf(early.lead.id), false)
  ok('a parked lead never goes red')
  const stats = (await one(U.admin, `select public.sales_board()`)).stats
  assert.equal(stats.open, 2)
  ok('the board counts every open lead')
}

// ── Doors ──────────────────────────────────────────────────────────────────
{
  for (const fn of ['public.sales_lead_for_work(uuid)', 'public.sales_lead_row(public.sales_leads)', 'public.sales_lead_sees_all(uuid)']) {
    const { rows } = await db.query(`select has_function_privilege('authenticated', '${fn}'::regprocedure, 'EXECUTE') as can`)
    assert.equal(rows[0].can, false)
  }
  await assert.rejects(() => as(U.ashok, `insert into public.sales_lead_activities (lead_id, kind, outcome, prior) values ('${mL}', 'call', 'sent', '{}')`), /permission denied/)
  await assert.rejects(() => as(U.admin, `update public.sales_leads set stage = 'dead'`), /permission denied/)
  await assert.rejects(() => as(U.ashok, `insert into public.sales_lead_access (viewer_id, subject_id) values ('${U.ashok}', '${U.mohit}')`), /permission denied/)
  ok('a browser cannot write around the functions, or give itself a junior')
  const { rows } = await db.query(`select count(*)::int as n from public.role_permissions rp join public.permission_modules pm on pm.id = rp.module_id where pm.module_key = 'sales' and rp.role = 'admin'`)
  assert.equal(rows[0].n, 5)
  ok('the Admin role holds the five Sales rights')
}

console.log(`all ${checks} checks passed`)
await db.close()
