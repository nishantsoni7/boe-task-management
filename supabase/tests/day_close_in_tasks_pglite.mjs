// Database regression suite for 20270623000000 (Day Close moves into Task Management). Runs the REAL migrations
// 20270622000000 then 20270623000000 in an in-memory Postgres (PGlite) over small stubs of tasks, the task
// activity log and attachments. Run:
//   node supabase/tests/day_close_in_tasks_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all N checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node day_close_in_tasks_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const mig = f => readFileSync(`${REPO}/supabase/migrations/${f}`, 'utf8').replace(/\r/g, '')

const U = {
  owner: '00000000-0000-0000-0000-0000000000a1',
  rakesh: '00000000-0000-0000-0000-0000000000b2', // switched on
  asha: '00000000-0000-0000-0000-0000000000c3',   // not switched on
}

const PLATFORM = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth; create schema storage;
  grant usage on schema public, auth, storage to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant execute on functions to anon, authenticated;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function public.set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
  create table public.users (id uuid primary key, full_name text, role text not null default 'member',
    is_active boolean not null default true, is_deleted boolean default false);
  create table public.tasks (id uuid primary key default gen_random_uuid(), title text, status text not null default 'pending',
    due_date date, assigned_to uuid, created_by uuid, created_at timestamptz default now());
  create table public.task_activity_log (id uuid primary key default gen_random_uuid(), task_id uuid references public.tasks(id),
    actor_id uuid, action text, from_status text, to_status text, note text, attachment_url text, created_at timestamptz default now());
  create table public.task_attachments (id uuid primary key default gen_random_uuid(), task_id uuid, activity_log_id uuid
    references public.task_activity_log(id), url text not null default 'x', created_by uuid);
  create table public.attendance_requests (id uuid primary key default gen_random_uuid(), employee_id uuid, request_type text);
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  insert into public.users (id, full_name, role) values
    ('${U.owner}', 'Nishant', 'admin'), ('${U.rakesh}', 'Rakesh', 'member'), ('${U.asha}', 'Asha', 'member');
`

let checks = 0
const ok = (name) => { checks++; console.log(`  ok - ${name}`) }

// ── The drop is refused when Day Close was used ─────────────────────────────
{
  const used = new PGlite()
  await used.exec(PLATFORM)
  await used.exec(mig('20270622000000_day_close.sql'))
  const plan = (await used.query(`insert into public.day_plans (employee_id, work_date) values ($1, '2026-11-13') returning id`, [U.rakesh])).rows[0].id
  await used.query(`insert into public.day_plan_items (plan_id, employee_id, source, title) values ($1, $2, 'own', 'Post a reel')`, [plan, U.rakesh])
  await assert.rejects(() => used.exec(mig('20270623000000_day_close_in_tasks.sql')), /day_plan_items holds rows/)
  ok('the migration refuses to drop day_plan_items when it holds a row')
}

const db = new PGlite()
await db.exec(PLATFORM)
await db.exec(mig('20270622000000_day_close.sql'))
await db.exec(mig('20270623000000_day_close_in_tasks.sql'))

const one = async (sql, params = []) => (await db.query(sql, params)).rows[0]
// One transaction as a signed-in person (the deferred proof check runs at COMMIT, as in a PostgREST request).
async function asTx(uid, statements) {
  await db.exec('begin')
  try {
    await db.exec(`select set_config('request.jwt.claim.sub', '${uid ?? ''}', true)`)
    for (const [sql, params] of statements) await db.query(sql, params ?? [])
    await db.exec('commit')
  } catch (e) {
    await db.exec('rollback').catch(() => {})
    throw e
  }
}

// ── Structure ───────────────────────────────────────────────────────────────
{
  assert.equal((await one(`select to_regclass('public.day_plan_items') as t`)).t, null)
  const col = await one(`select data_type from information_schema.columns where table_name = 'day_plans' and column_name = 'planned_task_ids'`)
  assert.equal(col.data_type, 'ARRAY')
  for (const role of ['authenticated', 'anon']) {
    await db.exec(`set role ${role}`)
    await assert.rejects(() => db.query(`select count(*) from public.day_close_carryovers`), /permission denied/)
    await db.exec('reset role')
  }
  ok('the item list is gone; plans keep the planned tasks; carry-overs are closed to the browser')
}

// ── Carry-overs ─────────────────────────────────────────────────────────────
await db.query(`insert into public.day_close_members (employee_id) values ($1)`, [U.rakesh])
const t1 = (await one(`insert into public.tasks (title, status, due_date, assigned_to, created_by) values ('Reel: sofa range', 'working', '2026-11-13', $1, $2) returning id`, [U.rakesh, U.owner])).id
const plan = (await one(`insert into public.day_plans (employee_id, work_date, submitted_at, planned_task_ids) values ($1, '2026-11-13', now(), array[$2]::uuid[]) returning id`, [U.rakesh, t1])).id
await assert.rejects(() => db.query(`insert into public.day_close_carryovers (plan_id, task_id, reason, next_date) values ($1, $2, 'no', '2026-11-14')`, [plan, t1]), /day_close_carryovers_reason_check/)
await db.query(`insert into public.day_close_carryovers (plan_id, task_id, reason, next_date) values ($1, $2, 'Waiting for the shoot', '2026-11-14')`, [plan, t1])
await assert.rejects(() => db.query(`insert into public.day_close_carryovers (plan_id, task_id, reason, next_date) values ($1, $2, 'Again', '2026-11-15')`, [plan, t1]), /day_close_carryovers_once/)
await db.query(`insert into public.day_close_carryovers (plan_id, task_id, reason, next_date) values ($1, $2, 'Again', '2026-11-15') on conflict (plan_id, task_id) do update set reason = excluded.reason, next_date = excluded.next_date`, [plan, t1])
ok('a carry-over needs a real reason, is one per task per day, and the server upsert names that conflict')

await db.query(`update public.day_plans set closed_at = now() where id = $1`, [plan])
await assert.rejects(() => db.query(`update public.day_close_carryovers set reason = 'changed later' where plan_id = $1`, [plan]), /DAY_CLOSED/)
await assert.rejects(() => db.query(`delete from public.day_close_carryovers where plan_id = $1`, [plan]), /DAY_CLOSED/)
ok('a closed day’s carry-overs cannot change')

// ── Proof ───────────────────────────────────────────────────────────────────
const task = async (assignee, creator, status = 'working') =>
  (await one(`insert into public.tasks (title, status, due_date, assigned_to, created_by) values ('T', $1, '2026-11-13', $2, $3) returning id`, [status, assignee, creator])).id
const setStatus = (id, s) => [`update public.tasks set status = $2 where id = $1`, [id, s]]

{
  const self = await task(U.rakesh, U.rakesh)
  await assert.rejects(() => asTx(U.rakesh, [setStatus(self, 'completed')]), /DAY_CLOSE_PROOF_REQUIRED/)
  assert.equal((await one(`select status from public.tasks where id = $1`, [self])).status, 'working', 'rolled back')
  ok('a switched-on person cannot complete their self task without proof, and nothing is saved')

  // The way change_task_status() works: the status first, then the history row with the attachment, one transaction.
  await asTx(U.rakesh, [setStatus(self, 'completed'),
    [`insert into public.task_activity_log (task_id, actor_id, action, from_status, to_status, attachment_url) values ($1, $2, 'status_changed', 'working', 'completed', 'storage://task-attachments/x.jpg')`, [self, U.rakesh]]])
  ok('a file sent with the status change itself is proof (checked at commit)')
}

{
  const delegated = await task(U.rakesh, U.owner)
  await assert.rejects(() => asTx(U.rakesh, [setStatus(delegated, 'pending_approval')]), /DAY_CLOSE_PROOF_REQUIRED/)
  await db.query(`insert into public.task_activity_log (task_id, actor_id, action, note) values ($1, $2, 'note_added', 'Posted: https://www.instagram.com/reel/abc')`, [delegated, U.rakesh])
  await asTx(U.rakesh, [setStatus(delegated, 'pending_approval')])
  await asTx(U.owner, [setStatus(delegated, 'completed')])
  ok('submitting needs proof (a link in an update counts); the creator’s approval needs nothing more')
}

{
  const fileOnUpdate = await task(U.rakesh, U.rakesh)
  const log = (await one(`insert into public.task_activity_log (task_id, actor_id, action, note) values ($1, $2, 'note_added', 'Done, see photo') returning id`, [fileOnUpdate, U.rakesh])).id
  await db.query(`insert into public.task_attachments (activity_log_id, url, created_by) values ($1, 'storage://task-attachments/p.jpg', $2)`, [log, U.rakesh])
  await asTx(U.rakesh, [setStatus(fileOnUpdate, 'completed')])
  ok('a photo attached to an update counts')
}

{
  const briefOnly = await task(U.rakesh, U.owner)
  await db.query(`insert into public.task_attachments (task_id, url, created_by) values ($1, 'storage://task-attachments/brief.pdf', $2)`, [briefOnly, U.owner])
  await db.query(`insert into public.task_activity_log (task_id, actor_id, action, note) values ($1, $2, 'note_added', 'See https://example.com/brief')`, [briefOnly, U.owner])
  await assert.rejects(() => asTx(U.rakesh, [setStatus(briefOnly, 'pending_approval')]), /DAY_CLOSE_PROOF_REQUIRED/)
  ok('the creator’s brief and links are not the assignee’s proof')
}

{
  const other = await task(U.asha, U.asha)
  await asTx(U.asha, [setStatus(other, 'completed')])
  const viaService = await task(U.rakesh, U.rakesh)
  await asTx(null, [setStatus(viaService, 'completed')])
  const cancelled = await task(U.rakesh, U.owner)
  await asTx(U.rakesh, [setStatus(cancelled, 'blocked')])
  await db.query(`update public.day_close_members set active = false where employee_id = $1`, [U.rakesh])
  const off = await task(U.rakesh, U.rakesh)
  await asTx(U.rakesh, [setStatus(off, 'completed')])
  ok('not checked: somebody not switched on, the service role, other statuses, or after being switched off')
}

console.log(`all ${checks} checks passed`)
