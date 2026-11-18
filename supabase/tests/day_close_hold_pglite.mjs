// Database regression suite for 20270802000100 (the attendance hold, proof as a written line, the Scoreboard
// switch). Runs the REAL migrations 20270622000000, 20270624000000, 20270704000000 and then 20270802000100 in an in-memory Postgres (PGlite) over small stubs of
// tasks, the task activity log and attachments. Run:
//   node supabase/tests/day_close_hold_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all N checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node day_close_hold_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
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

await db.exec(mig('20270704000000_day_close_team_switch.sql'))
await db.query('update public.day_close_settings set team_live = true where singleton')

await assert.rejects(() => (async () => { const d2 = new PGlite(); await d2.exec(mig('20270802000100_day_close_attendance_hold.sql')) })(), /DEPENDENCY MISSING/)
ok('refuses to run before Day Close exists')

await db.exec(mig('20270802000100_day_close_attendance_hold.sql'))

{
  const t = await task()
  await assert.rejects(() => asTx(U.rakesh, [
    [`insert into public.task_activity_log (task_id, actor_id, action, note) values ($1, $2, 'comment', 'ok')`, [t, U.rakesh]],
    finish(t),
  ]), /DAY_CLOSE_PROOF_REQUIRED/)
  ok('a two-letter note is not proof')
  await asTx(U.rakesh, [
    [`insert into public.task_activity_log (task_id, actor_id, action, note) values ($1, $2, 'comment', 'Sent the catalogue to Rahul')`, [t, U.rakesh]],
    finish(t),
  ])
  ok('one written line of what was done is proof')
  const t2 = await task()
  await assert.rejects(() => asTx(U.rakesh, [finish(t2)]), /one line is enough/)
  ok('nothing at all is still refused, and the message says one line is enough')
}

{
  const s = await one('select scoreboard_live from public.day_close_settings where singleton')
  assert.equal(s.scoreboard_live, false)
  ok('the Scoreboard switch starts off')
}

{
  await db.query(`insert into public.day_close_holds (employee_id, held_date, cause_date, open_tasks) values ($1, '2026-11-19', '2026-11-18', 3)`, [U.rakesh])
  await assert.rejects(() => db.query(`insert into public.day_close_holds (employee_id, held_date, cause_date, open_tasks) values ($1, '2026-11-19', '2026-11-18', 1)`, [U.rakesh]), /one_per_day/)
  await assert.rejects(() => db.query(`insert into public.day_close_holds (employee_id, held_date, cause_date, open_tasks) values ($1, '2026-11-18', '2026-11-18', 1)`, [U.rakesh]), /after_cause/)
  await assert.rejects(() => db.query(`insert into public.day_close_holds (employee_id, held_date, cause_date, open_tasks) values ($1, '2026-11-21', '2026-11-20', 0)`, [U.rakesh]), /open_tasks/)
  await assert.rejects(() => db.query(`update public.day_close_holds set cleared_by = $1, cleared_at = now() where employee_id = $2`, [U.owner, U.rakesh]), /lift_has_reason/)
  await db.query(`update public.day_close_holds set cleared_by = $1, cleared_at = now(), clear_reason = 'Hospital visit' where employee_id = $2`, [U.owner, U.rakesh])
  ok('one hold per person per day, after its cause, with open work; a lift needs a reason')
}

for (const role of ['authenticated', 'anon']) {
  await db.exec(`set role ${role}`)
  await assert.rejects(() => db.query('select * from public.day_close_holds'), /permission denied/)
  await db.exec('reset role')
}
ok('holds are closed to signed-in and anonymous clients')

await db.exec(mig('20270802000100_day_close_attendance_hold.sql'))
assert.equal((await one('select count(*)::int n from public.day_close_holds')).n, 1)
ok('safe to run again; holds kept')

console.log(`all ${checks} checks passed`)
