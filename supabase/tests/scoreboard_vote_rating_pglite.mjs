// Database regression suite for 20270626000000 (the Scoreboard's team vote and owner's rating). Runs the REAL
// migration in an in-memory Postgres (PGlite) with Supabase's default grants first. Run:
//   node supabase/tests/scoreboard_vote_rating_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all N checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node scoreboard_vote_rating_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const mig = f => readFileSync(`${REPO}/supabase/migrations/${f}`, 'utf8').replace(/\r/g, '')

const U = ['a1', 'b2', 'c3', 'd4', 'e5'].map(x => `00000000-0000-0000-0000-0000000000${x}`)
const [OWNER, R, A, B, C] = U
const db = new PGlite()
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  create table public.users (id uuid primary key);
  insert into public.users values ${U.map(u => `('${u}')`).join(', ')};
`)
await db.exec(mig('20270626000000_scoreboard_vote_rating.sql'))

let checks = 0
const ok = name => { checks++; console.log(`  ok - ${name}`) }
const rejects = (sql, params, re) => assert.rejects(() => db.query(sql, params), re)
const vote = (voter, nominee, note = null) => db.query(`insert into public.scoreboard_votes (month, voter_id, nominee_id, note) values ('2026-11-01', $1, $2, $3)`, [voter, nominee, note])

for (const role of ['authenticated', 'anon']) {
  for (const t of ['scoreboard_votes', 'scoreboard_ratings']) {
    await db.exec(`set role ${role}`)
    await assert.rejects(() => db.query(`select count(*) from public.${t}`), /permission denied/)
    await db.exec('reset role')
  }
}
ok('votes and ratings are closed to signed-in and anonymous clients')

await assert.rejects(() => vote(R, R), /scoreboard_votes_not_self/)
await vote(R, A, 'Covered my calls'); await vote(R, B); await vote(R, C)
await assert.rejects(() => vote(R, OWNER), /SCOREBOARD_VOTE_LIMIT/)
await assert.rejects(() => vote(A, R, 'x'), /scoreboard_votes_note_check/)
await vote(A, R)
await assert.rejects(() => vote(A, R), /duplicate key/)
ok('never yourself, three a month, one vote per colleague, a note of at least 2 characters')

await rejects(`update public.scoreboard_votes set nominee_id = $1 where voter_id = $2`, [OWNER, R], /SCOREBOARD_VOTE_FINAL/)
await rejects(`delete from public.scoreboard_votes where voter_id = $1`, [R], /SCOREBOARD_VOTE_FINAL/)
ok('a vote is cast once and never changed or removed')

await rejects(`insert into public.scoreboard_ratings (month, employee_id, rating, reason, rated_by) values ('2026-11-01', $1, 6, 'Too high', $2)`, [R, OWNER], /scoreboard_ratings_rating_check/)
await rejects(`insert into public.scoreboard_ratings (month, employee_id, rating, reason, rated_by) values ('2026-11-01', $1, 4, '', $2)`, [R, OWNER], /scoreboard_ratings_reason_check/)
await db.query(`insert into public.scoreboard_ratings (month, employee_id, rating, reason, rated_by) values ('2026-11-01', $1, 4, 'Great follow-ups', $2)`, [R, OWNER])
await db.query(`insert into public.scoreboard_ratings (month, employee_id, rating, reason, rated_by) values ('2026-11-01', $1, 5, 'Best month yet', $2) on conflict (month, employee_id) do update set rating = excluded.rating, reason = excluded.reason`, [R, OWNER])
assert.equal((await db.query(`select rating from public.scoreboard_ratings`)).rows[0].rating, 5)
ok('a rating is 1-5 with a reason; the server upsert changes it in place')

await db.exec(mig('20270626000000_scoreboard_vote_rating.sql'))
ok('the migration is safe to run again')

console.log(`all ${checks} checks passed`)
