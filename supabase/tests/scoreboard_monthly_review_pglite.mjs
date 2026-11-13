// Database regression suite for 20270627000000 (the Scoreboard's monthly review). Runs the REAL migration in an
// in-memory Postgres (PGlite) with Supabase's default grants first. Run:
//   node supabase/tests/scoreboard_monthly_review_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all N checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node scoreboard_monthly_review_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const mig = f => readFileSync(`${REPO}/supabase/migrations/${f}`, 'utf8').replace(/\r/g, '')

const [OWNER, P, D] = ['a1', 'b2', 'c3'].map(x => `00000000-0000-0000-0000-0000000000${x}`)
const db = new PGlite()
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  create table public.users (id uuid primary key);
  insert into public.users values ('${OWNER}'), ('${P}'), ('${D}');
`)
await db.exec(mig('20270627000000_scoreboard_monthly_review.sql'))

let checks = 0
const ok = name => { checks++; console.log(`  ok - ${name}`) }
const rejects = (sql, params, re) => assert.rejects(() => db.query(sql, params), re)
const award = (a, id, month = '2026-11-01') => db.query(`insert into public.scoreboard_awards (month, award, employee_id) values ($1, $2, $3)`, [month, a, id])

for (const role of ['authenticated', 'anon']) {
  for (const t of ['scoreboard_months', 'scoreboard_awards', 'scoreboard_reviews']) {
    await db.exec(`set role ${role}`)
    await assert.rejects(() => db.query(`select count(*) from public.${t}`), /permission denied/)
    await db.exec('reset role')
  }
}
ok('all three tables are closed to signed-in and anonymous clients')

await award('star_performer', P)
await assert.rejects(() => award('star_performer', D), /scoreboard_awards_one_winner/)
await award('never_late', P); await award('never_late', D)
await assert.rejects(() => award('best_dressed', D), /scoreboard_awards_award_check/)
ok('one winner per award, any number of Never Late, only the five awards')

await db.query(`insert into public.scoreboard_months (month, frozen_by) values ('2026-11-01', $1)`, [OWNER])
await assert.rejects(() => award('team_player', D), /SCOREBOARD_MONTH_FROZEN/)
await rejects(`update public.scoreboard_awards set employee_id = $1 where award = 'star_performer'`, [D], /SCOREBOARD_AWARDS_FINAL/)
await rejects(`delete from public.scoreboard_awards where month = '2026-11-01'`, [], /SCOREBOARD_AWARDS_FINAL/)
await rejects(`delete from public.scoreboard_months where month = '2026-11-01'`, [], /SCOREBOARD_MONTH_FROZEN/)
await rejects(`insert into public.scoreboard_months (month, frozen_by) values ('2026-11-01', $1)`, [OWNER], /duplicate key/)
ok('once frozen, a month gets no new awards, and its awards and freeze never change')

await rejects(`insert into public.scoreboard_reviews (month, employee_id, goals, checkin_on, created_by) values ('2026-11-01', $1, '{}', '2026-12-15', $2)`, [D, OWNER], /scoreboard_reviews_goals_check/)
await rejects(`insert into public.scoreboard_reviews (month, employee_id, goals, checkin_on, created_by) values ('2026-11-01', $1, array['a','b','c','d'], '2026-12-15', $2)`, [D, OWNER], /scoreboard_reviews_goals_check/)
await rejects(`insert into public.scoreboard_reviews (month, employee_id, goals, checkin_on, created_by) values ('2026-11-01', $1, array['Plan by 10:30'], '2026-10-20', $2)`, [D, OWNER], /scoreboard_reviews_checkin_after_month/)
await db.query(`insert into public.scoreboard_reviews (month, employee_id, goals, checkin_on, created_by) values ('2026-11-01', $1, array['Plan by 10:30'], '2026-12-15', $2)`, [D, OWNER])
await db.query(`insert into public.scoreboard_reviews (month, employee_id, goals, checkin_on, warning, created_by) values ('2026-11-01', $1, array['Plan by 10:30','Close every day'], '2026-12-15', true, $2) on conflict (month, employee_id) do update set goals = excluded.goals, warning = excluded.warning`, [D, OWNER])
assert.equal((await db.query(`select cardinality(goals) n, warning from public.scoreboard_reviews`)).rows[0].warning, true)
ok('a review has one to three goals and a check-in after the month; the server upsert updates it')

await db.exec(mig('20270627000000_scoreboard_monthly_review.sql'))
ok('the migration is safe to run again')

console.log(`all ${checks} checks passed`)
