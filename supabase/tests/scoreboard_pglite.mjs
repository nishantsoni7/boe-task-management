// Database regression suite for 20270625000000 (the BOE Scoreboard). Runs the REAL migration in an in-memory
// Postgres (PGlite) with Supabase's default grants in place first. Run:
//   node supabase/tests/scoreboard_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all N checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node scoreboard_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const mig = f => readFileSync(`${REPO}/supabase/migrations/${f}`, 'utf8').replace(/\r/g, '')

const A = '00000000-0000-0000-0000-0000000000b2'
const db = new PGlite()
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  create table public.users (id uuid primary key, full_name text);
  insert into public.users values ('${A}', 'Rakesh');
`)
await db.exec(mig('20270625000000_scoreboard.sql'))

let checks = 0
const ok = name => { checks++; console.log(`  ok - ${name}`) }
const rejects = (sql, params, re) => assert.rejects(() => db.query(sql, params), re)

for (const role of ['authenticated', 'anon']) {
  for (const t of ['scoreboard_targets', 'scoreboard_daily']) {
    await db.exec(`set role ${role}`)
    await assert.rejects(() => db.query(`select count(*) from public.${t}`), /permission denied/)
    await db.exec('reset role')
  }
}
ok('both tables are closed to signed-in and anonymous clients')

await rejects(`insert into public.scoreboard_targets (month, employee_id) values ('2026-11-12', $1)`, [A], /scoreboard_targets_month_check/)
await rejects(`insert into public.scoreboard_targets (month, employee_id, role_target) values ('2026-11-01', $1, 20)`, [A], /scoreboard_targets_role_complete/)
await rejects(`insert into public.scoreboard_targets (month, employee_id, track) values ('2026-11-01', $1, 'boss')`, [A], /scoreboard_targets_track_check/)
await db.query(`insert into public.scoreboard_targets (month, employee_id, role_target, role_kind, role_label) values ('2026-11-01', $1, 20, 'tasks_done', 'reels posted')`, [A])
await db.query(`insert into public.scoreboard_targets (month, employee_id, track, sales_target) values ('2026-11-01', $1, 'sales', 1500000) on conflict (month, employee_id) do update set track = excluded.track, sales_target = excluded.sales_target, role_target = null, role_kind = null, role_label = null`, [A])
ok('targets: first of the month, a role target names what counts, a known track; the server upsert names its key')

const row = `('${A}', '2026-11-07', '2026-11-01', 'general', 74, 44.5, 60, '[]'::jsonb)`
await db.exec(`insert into public.scoreboard_daily (employee_id, score_date, month, track, score, earned, possible, parts) values ${row}`)
await db.exec(`insert into public.scoreboard_daily (employee_id, score_date, month, track, score, earned, possible, parts) values ${row} on conflict (employee_id, score_date) do nothing`)
await rejects(`update public.scoreboard_daily set score = 99 where employee_id = $1`, [A], /SCOREBOARD_FROZEN/)
await rejects(`delete from public.scoreboard_daily where employee_id = $1`, [A], /SCOREBOARD_FROZEN/)
assert.equal((await db.query(`select score from public.scoreboard_daily`)).rows[0].score, 74)
ok('a day’s score is written once and can never be changed or removed')

await db.exec(mig('20270625000000_scoreboard.sql'))
ok('the migration is safe to run again')

console.log(`all ${checks} checks passed`)
