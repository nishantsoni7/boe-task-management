// Database regression suite for 20270703000000 (the Scoreboard Top 5 switch). Runs the REAL Day Close
// migration, then this one, in an in-memory Postgres (PGlite). Run:
//   node supabase/tests/scoreboard_top5_switch_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all N checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node scoreboard_top5_switch_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const mig = f => readFileSync(`${REPO}/supabase/migrations/${f}`, 'utf8').replace(/\r/g, '')

const db = new PGlite()
let checks = 0
const ok = name => { checks++; console.log(`  ok - ${name}`) }

await assert.rejects(() => db.exec(mig('20270703000000_scoreboard_top5_switch.sql')), /DEPENDENCY MISSING/)
ok('refuses to run before Day Close exists')

await db.exec(`
  create role anon nologin; create role authenticated nologin;
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  create table public.users (id uuid primary key, full_name text);
  create table public.tasks (id uuid primary key, assigned_to uuid, status text, due_date date);
  create table public.attendance_requests (id uuid primary key, employee_id uuid, request_type text, status text);
  create function public.set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
  create schema if not exists storage;
  create table if not exists storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
`)
await db.exec(mig('20270622000000_day_close.sql'))
await db.exec(mig('20270703000000_scoreboard_top5_switch.sql'))

const row = await db.query('select scoreboard_top5_public from public.day_close_settings where singleton')
assert.equal(row.rows[0].scoreboard_top5_public, false)
ok('the Top 5 starts hidden from staff')

await db.query('update public.day_close_settings set scoreboard_top5_public = true where singleton')
await db.exec(mig('20270703000000_scoreboard_top5_switch.sql'))
const again = await db.query('select scoreboard_top5_public from public.day_close_settings where singleton')
assert.equal(again.rows[0].scoreboard_top5_public, true)
ok('safe to run again: the owner\'s choice is kept')

await assert.rejects(() => db.query('update public.day_close_settings set scoreboard_top5_public = null where singleton'), /null/)
ok('never null')

for (const role of ['authenticated', 'anon']) {
  await db.exec(`set role ${role}`)
  await assert.rejects(() => db.query('select scoreboard_top5_public from public.day_close_settings'), /permission denied/)
  await db.exec('reset role')
}
ok('still closed to signed-in and anonymous clients')

console.log(`all ${checks} checks passed`)
