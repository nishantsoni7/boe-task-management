// Database regression suite for 20270622000000 (Day Close). Runs the REAL migration in an in-memory Postgres
// (PGlite) against small stubs of the platform objects it depends on (users, tasks, attendance_requests,
// storage), with Supabase's default grants to anon and authenticated in place first, so the migration's own
// revokes are what close the tables. Run:
//   node supabase/tests/day_close_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all N checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node day_close_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const mig = f => readFileSync(`${REPO}/supabase/migrations/${f}`, 'utf8').replace(/\r/g, '')

const U = {
  owner: '00000000-0000-0000-0000-0000000000a1',
  dhruv: '00000000-0000-0000-0000-0000000000b2',
}
const PHOTO = `${U.dhruv}/11111111-2222-4333-8444-555555555555.jpg`

const db = new PGlite()
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth; create schema storage;
  grant usage on schema public, auth, storage to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;
  alter default privileges in schema public grant execute on functions to anon, authenticated;
  create function public.set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
  create table public.users (id uuid primary key, full_name text, role text not null default 'member',
    is_active boolean not null default true, is_deleted boolean default false);
  create table public.tasks (id uuid primary key default gen_random_uuid(), title text, status text, due_date date,
    assigned_to uuid, created_by uuid);
  create table public.attendance_requests (id uuid primary key default gen_random_uuid(), employee_id uuid,
    request_type text, status text default 'pending');
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  insert into public.users (id, full_name, role) values ('${U.owner}', 'Nishant', 'admin'), ('${U.dhruv}', 'Dhruv', 'member');
`)

await db.exec(mig('20270622000000_day_close.sql'))

let checks = 0
const ok = (name) => { checks++; console.log(`  ok - ${name}`) }
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0]
const rejects = (sql, params, pattern) => assert.rejects(() => db.query(sql, params), pattern)

// ── Registration ────────────────────────────────────────────────────────────
{
  const s = await one(`select reviewer_id, plan_due_minutes, close_opens_minutes from public.day_close_settings`)
  assert.equal(s.reviewer_id, null)
  assert.equal(s.plan_due_minutes, 630)
  assert.equal(s.close_opens_minutes, 1080)
  const b = await one(`select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'day-proof'`)
  assert.equal(b.public, false)
  assert.equal(Number(b.file_size_limit), 5242880)
  assert.deepEqual(b.allowed_mime_types, ['image/jpeg'])
  ok('one settings row (10:30 / 18:00, no reviewer yet); the proof bucket is private, JPEG only, 5 MB')
}

// ── Closed to the browser ──────────────────────────────────────────────────
for (const role of ['authenticated', 'anon']) {
  for (const t of ['day_close_settings', 'day_close_members', 'day_plans', 'day_plan_items', 'day_strikes', 'day_close_leave_locks']) {
    await db.exec(`set role ${role}`)
    await assert.rejects(() => db.query(`select count(*) from public.${t}`), /permission denied/, `${role} ${t}`)
    await db.exec('reset role')
  }
}
ok('every Day Close table refuses signed-in and anonymous clients alike')

// ── The day ─────────────────────────────────────────────────────────────────
const plan = (await one(`insert into public.day_plans (employee_id, work_date) values ($1, '2026-11-13') returning id`, [U.dhruv])).id
await rejects(`insert into public.day_plans (employee_id, work_date) values ($1, '2026-11-13')`, [U.dhruv], /day_plans_one_per_day/)
ok('one plan per person per day')

await rejects(`update public.day_plans set closed_at = now() where id = $1`, [plan], /day_plans_closed_after_filed/)
ok('a day cannot be closed before its plan is filed')

const task = (await one(`insert into public.tasks (title, status, due_date, assigned_to, created_by) values ('Vendor visit', 'started', '2026-11-13', $1, $2) returning id`, [U.dhruv, U.owner])).id
await rejects(`insert into public.day_plan_items (plan_id, employee_id, source, title) values ($1, $2, 'assigned', 'No task')`, [plan, U.dhruv], /day_plan_items_task_when_assigned/)
await rejects(`insert into public.day_plan_items (plan_id, employee_id, source, task_id, title) values ($1, $2, 'own', $3, 'Own with task')`, [plan, U.dhruv, task], /day_plan_items_task_when_assigned/)
await db.query(`insert into public.day_plan_items (plan_id, employee_id, source, task_id, title) values ($1, $2, 'assigned', $3, 'Vendor visit')`, [plan, U.dhruv, task])
await rejects(`insert into public.day_plan_items (plan_id, employee_id, source, task_id, title) values ($1, $2, 'assigned', $3, 'Vendor visit again')`, [plan, U.dhruv, task], /day_plan_items_one_task_per_plan/)
// The server's upsert (src/lib/dayClose/server.ts syncAssigned) names exactly this conflict target.
await db.query(`insert into public.day_plan_items (plan_id, employee_id, source, task_id, title) values ($1, $2, 'assigned', $3, 'Vendor visit') on conflict (plan_id, task_id) do nothing`, [plan, U.dhruv, task])
assert.equal((await one(`select count(*)::int n from public.day_plan_items where plan_id = $1`, [plan])).n, 1)
ok('an assigned item carries its task, an own item does not, and a task is in a plan once (on conflict (plan_id, task_id))')

const own = (await one(`insert into public.day_plan_items (plan_id, employee_id, source, title, expected_output) values ($1, $2, 'own', 'Post 1 reel', 'Reel live') returning id`, [plan, U.dhruv])).id
await rejects(`update public.day_plan_items set status = 'done', closed_at = now() where id = $1`, [own], /day_plan_items_done_has_proof/)
await rejects(`update public.day_plan_items set status = 'done', closed_at = now(), proof_url = 'javascript:alert(1)' where id = $1`, [own], /day_plan_items_proof_url_check/)
await rejects(`update public.day_plan_items set status = 'done', closed_at = now(), proof_photo_path = '../etc/passwd' where id = $1`, [own], /day_plan_items_proof_photo_path_check/)
await rejects(`update public.day_plan_items set status = 'done', proof_url = 'https://instagram.com/p/x' where id = $1`, [own], /day_plan_items_closed_when_resolved/)
await db.query(`update public.day_plan_items set status = 'done', closed_at = now(), proof_photo_path = $2 where id = $1`, [own, PHOTO])
ok('an own item is Done only with an http(s) link or a photo path in the proof shape, and a closing time')

const own2 = (await one(`insert into public.day_plan_items (plan_id, employee_id, source, title) values ($1, $2, 'own', 'SEO page') returning id`, [plan, U.dhruv])).id
await rejects(`update public.day_plan_items set status = 'not_done', closed_at = now(), reason = 'Busy' where id = $1`, [own2], /day_plan_items_not_done_has_reason/)
await rejects(`update public.day_plan_items set status = 'not_done', closed_at = now(), reason = 'x', next_date = '2026-11-14' where id = $1`, [own2], /day_plan_items_reason_check/)
await db.query(`update public.day_plan_items set status = 'not_done', closed_at = now(), reason = 'Waiting for content', next_date = '2026-11-14' where id = $1`, [own2])
ok('Not done needs a real reason and a new date')

await db.query(`update public.day_plans set submitted_at = '2026-11-13T04:50:00Z' where id = $1`, [plan])
await db.query(`update public.day_plans set closed_at = '2026-11-13T12:55:00Z', close_note = 'All good' where id = $1`, [plan])
await rejects(`update public.day_plans set close_note = 'changed later' where id = $1`, [plan], /DAY_CLOSED/)
await rejects(`update public.day_plan_items set proof_note = 'edited after' where id = $1`, [own], /DAY_CLOSED/)
await rejects(`insert into public.day_plan_items (plan_id, employee_id, source, title) values ($1, $2, 'own', 'Sneaked in')`, [plan, U.dhruv], /DAY_CLOSED/)
await rejects(`delete from public.day_plan_items where id = $1`, [own2], /DAY_CLOSED/)
await rejects(`delete from public.day_plans where id = $1`, [plan], /DAY_CLOSED/)
ok('a closed day is a record: its plan and items cannot be changed, added to or removed')

{
  const p2 = (await one(`insert into public.day_plans (employee_id, work_date) values ($1, '2026-11-14') returning id`, [U.dhruv])).id
  const i2 = (await one(`insert into public.day_plan_items (plan_id, employee_id, source, title) values ($1, $2, 'own', 'Draft') returning id`, [p2, U.dhruv])).id
  await db.query(`delete from public.day_plan_items where id = $1`, [i2])
  await rejects(`delete from public.day_plans where id = $1`, [p2], /DAY_PLAN_KEPT/)
  ok('an open day still takes changes and removals of items, but a plan is never deleted')
}

// ── Strikes ─────────────────────────────────────────────────────────────────
const strike = (await one(`insert into public.day_strikes (employee_id, work_date, kind, detail) values ($1, '2026-11-13', 'plan_late', '{"due":"10:30 am"}') returning id`, [U.dhruv])).id
await rejects(`insert into public.day_strikes (employee_id, work_date, kind) values ($1, '2026-11-13', 'plan_late')`, [U.dhruv], /day_strikes_once/)
await rejects(`insert into public.day_strikes (employee_id, work_date, kind) values ($1, '2026-11-13', 'watched_reels')`, [U.dhruv], /day_strikes_kind_check/)
ok('a strike is written once per person, day and kind, and only of the four kinds')

await rejects(`update public.day_strikes set status = 'upheld' where id = $1`, [strike], /day_strikes_decision_complete/)
await rejects(`update public.day_strikes set status = 'waived', decided_by = $2, decided_at = now() where id = $1`, [strike, U.owner], /day_strikes_waive_has_note/)
await db.query(`update public.day_strikes set status = 'waived', decided_by = $2, decided_at = now(), decision_note = 'Was at a client' where id = $1`, [strike, U.owner])
ok('a decision names who and when; waiving needs a note')

// ── Leave locks ─────────────────────────────────────────────────────────────
{
  const req = (await one(`insert into public.attendance_requests (employee_id, request_type) values ($1, 'full_day_leave') returning id`, [U.dhruv])).id
  await db.query(`insert into public.day_close_leave_locks (request_id, employee_id, overdue_tasks, unclosed_days, detail) values ($1, $2, 2, 1, '{"words":"2 overdue tasks, 1 day not closed"}')`, [req, U.dhruv])
  await rejects(`update public.day_close_leave_locks set released_at = now() where request_id = $1`, [req], /day_close_leave_locks_release_complete/)
  await rejects(`insert into public.day_close_leave_locks (request_id, employee_id, overdue_tasks, unclosed_days) values (gen_random_uuid(), $1, 0, 0)`, [U.dhruv], /foreign key/)
  ok('a leave lock belongs to a real request, and a release names who and when')
}

// ── Members ─────────────────────────────────────────────────────────────────
await db.query(`insert into public.day_close_members (employee_id, added_by) values ($1, $2)`, [U.dhruv, U.owner])
// The server's upsert of members and strikes names these conflict targets.
await db.query(`insert into public.day_close_members (employee_id, active) values ($1, true) on conflict (employee_id) do update set active = excluded.active`, [U.dhruv])
await db.query(`insert into public.day_strikes (employee_id, work_date, kind) values ($1, '2026-11-13', 'plan_late') on conflict (employee_id, work_date, kind) do nothing`, [U.dhruv])
await db.query(`insert into public.day_plans (employee_id, work_date) values ($1, '2026-11-13') on conflict (employee_id, work_date) do nothing`, [U.dhruv])
await rejects(`insert into public.day_close_members (employee_id) values ($1)`, [U.dhruv], /duplicate key/)
ok('a person is switched on once')

console.log(`all ${checks} checks passed`)
