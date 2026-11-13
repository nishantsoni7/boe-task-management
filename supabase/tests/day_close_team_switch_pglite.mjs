// Database regression suite for 20270704000000 (the Day Close / Scoreboard team switch). Runs the REAL migrations
// 20270622000000, 20270624000000 and then 20270704000000 in an in-memory Postgres (PGlite) over small stubs of
// tasks, the task activity log and attachments. Run:
//   node supabase/tests/day_close_team_switch_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all N checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node day_close_team_switch_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const mig = f => readFileSync(`${REPO}/supabase/migrations/${f}`, 'utf8').replace(/\r/g, '')

const U = {
  owner: '00000000-0000-0000-0000-0000000000a1',
  rakesh: '00000000-0000-0000-0000-0000000000b2', // switched on for Day Close
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
  insert into public.users (id, full_name, role) values ('${U.owner}', 'Nishant', 'admin'), ('${U.rakesh}', 'Rakesh', 'member');
`

let checks = 0
const ok = (name) => { checks++; console.log(`  ok - ${name}`) }

const db = new PGlite()
await db.exec(PLATFORM)
await db.exec(mig('20270622000000_day_close.sql'))
await db.exec(mig('20270624000000_day_close_in_tasks.sql'))
// The member takes part from before the switch existed: the situation on the live database.
await db.query(`insert into public.day_close_members (employee_id) values ($1)`, [U.rakesh])

// Before the new migration the proof rule applies (this is today's behaviour).
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0]
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
const task = async () =>
  (await one(`insert into public.tasks (title, status, due_date, assigned_to, created_by) values ('T', 'working', '2026-11-13', $1, $1) returning id`, [U.rakesh])).id
const finish = id => [`update public.tasks set status = 'completed' where id = $1`, [id]]

{
  const t = await task()
  await assert.rejects(() => asTx(U.rakesh, [finish(t)]), /DAY_CLOSE_PROOF_REQUIRED/)
  ok('before the migration: a member cannot finish a task without proof (today’s behaviour)')
}

await db.exec(mig('20270704000000_day_close_team_switch.sql'))

{
  const row = await one(`select team_live, live_since from public.day_close_settings`)
  assert.equal(row.team_live, false)
  assert.equal(row.live_since, null)
  assert.equal((await one(`select count(*)::int n from public.day_close_settings`)).n, 1)
  ok('the existing settings row becomes PAUSED the moment the migration applies, with no start date')
}

{
  const t = await task()
  await asTx(U.rakesh, [finish(t)])
  assert.equal((await one(`select status from public.tasks where id = $1`, [t])).status, 'completed')
  ok('paused: a member finishes a task without proof')
}

{
  await db.query(`update public.day_close_settings set team_live = true, live_since = now()`)
  const t = await task()
  await assert.rejects(() => asTx(U.rakesh, [finish(t)]), /DAY_CLOSE_PROOF_REQUIRED/)
  assert.equal((await one(`select status from public.tasks where id = $1`, [t])).status, 'working', 'rolled back')
  await asTx(U.rakesh, [finish(t), [`insert into public.task_activity_log (task_id, actor_id, action, from_status, to_status, note) values ($1, $2, 'status_changed', 'working', 'completed', 'Done: https://example.com/proof')`, [t, U.rakesh]]])
  ok('live: proof is asked for again, and a link posted with the status change still counts')
}

{
  const t = await task()
  await db.query(`update public.day_close_settings set team_live = false`)
  await asTx(U.rakesh, [finish(t)])
  ok('paused again: no proof is asked for')
}

{
  await db.query(`update public.day_close_settings set team_live = true, live_since = '2026-11-20T05:00:00Z'`)
  await db.exec(mig('20270704000000_day_close_team_switch.sql'))
  const row = await one(`select team_live, live_since from public.day_close_settings`)
  assert.equal(row.team_live, true)
  assert.equal(new Date(row.live_since).toISOString(), '2026-11-20T05:00:00.000Z')
  assert.equal((await one(`select count(*)::int n from pg_trigger where tgname = 'tasks_day_close_proof'`)).n, 1)
  ok('running the migration again keeps the owner’s choice and its start date, and leaves one trigger')
}

{
  for (const role of ['authenticated', 'anon']) {
    await db.exec(`set role ${role}`)
    await assert.rejects(() => db.query(`select team_live from public.day_close_settings`), /permission denied/)
    await assert.rejects(() => db.query(`update public.day_close_settings set team_live = true`), /permission denied/)
    await assert.rejects(() => db.query(`select public.day_close_task_proof_check()`), /permission denied|trigger/)
    await db.exec('reset role')
  }
  ok('the switch is closed to the browser: nobody signed in can read or write it, or call the proof function')
}

console.log(`all ${checks} checks passed`)
