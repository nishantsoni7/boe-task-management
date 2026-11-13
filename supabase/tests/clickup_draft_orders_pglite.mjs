// Rehearsal for 20270713000000 (Draft Orders from ClickUp). Runs the REAL migration in an in-memory Postgres (PGlite)
// over a stub of what it touches (public.users, storage.buckets, the three API roles). Run:
//   node supabase/tests/clickup_draft_orders_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all N checks passed". It proves the SQL applies, twice, and that the table behaves as the routes
// expect (counts, shape check, one row per ClickUp task, closed to the API roles). It does NOT prove the real database
// has the same schema or Storage settings: the PR says so.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node clickup_draft_orders_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const MIGRATION = readFileSync(`${REPO}/supabase/migrations/20270713000000_clickup_draft_orders.sql`, 'utf8').replace(/\r/g, '')

const db = new PGlite()
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create table public.users (id uuid primary key);
  create schema storage;
  create table storage.buckets (id text primary key, name text not null, public boolean default false,
    file_size_limit bigint, allowed_mime_types text[]);
  grant usage on schema public, storage to anon, authenticated, service_role;
`)

let n = 0
const check = (name, ok) => { n += 1; assert.ok(ok, name); console.log(`  ok ${n} - ${name}`) }
const fails = async (sql, code, name) => {
  try { await db.exec(sql) } catch (e) { check(`${name} (${e.code ?? e.message})`, code === undefined || e.code === code || String(e.message).includes(code)); return }
  check(`${name}: should have failed`, false)
}
const one = async sql => (await db.query(sql)).rows[0]

// 1. It applies
await db.exec(MIGRATION)
check('the migration applies', true)
const bucket = await one(`select * from storage.buckets where id = 'clickup-draft-files'`)
check('the bucket exists, private, 50 MiB, any file type', bucket && bucket.public === false && Number(bucket.file_size_limit) === 52428800 && bucket.allowed_mime_types === null)

// 2. The table behaves as the routes expect
await db.exec(`insert into public.clickup_draft_orders (clickup_id, name) values ('86abc1', '535 Sample')`)
let row = await one(`select file_count, comment_count, status, fields, assignees from public.clickup_draft_orders where clickup_id = '86abc1'`)
check('a bare order has no files and no comments', row.file_count === 0 && row.comment_count === 0 && row.status === '')
await db.exec(`update public.clickup_draft_orders set files = '[{"id":"f1"},{"id":"f2"}]'::jsonb, comments = '[{"id":"c1"}]'::jsonb where clickup_id = '86abc1'`)
row = await one(`select file_count, comment_count from public.clickup_draft_orders where clickup_id = '86abc1'`)
check('the counts follow the files and the comments', row.file_count === 2 && row.comment_count === 1)

await fails(`insert into public.clickup_draft_orders (clickup_id, name) values ('86abc1', 'again')`, '23505', 'the same ClickUp task cannot be stored twice')
await fails(`insert into public.clickup_draft_orders (clickup_id, name, fields) values ('86abc2', 'x', '[]'::jsonb)`, '23514', 'fields must be an object')
await fails(`insert into public.clickup_draft_orders (clickup_id, name, files) values ('86abc3', 'x', '{}'::jsonb)`, '22023', 'files must be an array (the generated count refuses a non-array first)')
await fails(`insert into public.clickup_draft_orders (clickup_id) values ('86abc4')`, '23502', 'a name is required')
await fails(`update public.clickup_draft_orders set file_count = 9`, '428C9', 'the count cannot be written by hand')

// 3. The save the route performs: replace by ClickUp task id, never double
await db.exec(`insert into public.clickup_draft_orders (clickup_id, name, status) values ('86abc1', '535 Renamed', 'dispatched')
  on conflict (clickup_id) do update set name = excluded.name, status = excluded.status`)
row = await one(`select count(*)::int as n, max(name) as name, max(status) as status from public.clickup_draft_orders`)
check('saving the same task again replaces it', row.n === 1 && row.name === '535 Renamed' && row.status === 'dispatched')

// 4. Closed to the API roles
await db.exec(`set role authenticated`)
await fails(`select * from public.clickup_draft_orders`, '42501', 'a signed-in person cannot read the table')
await fails(`insert into public.clickup_draft_orders (clickup_id, name) values ('x', 'x')`, '42501', 'a signed-in person cannot write the table')
await db.exec(`reset role; set role anon`)
await fails(`select * from public.clickup_draft_orders`, '42501', 'an anonymous caller cannot read the table')
await db.exec(`reset role`)
const meta = await one(`select relrowsecurity, (select count(*)::int from pg_policies where tablename = 'clickup_draft_orders') as policies from pg_class where oid = 'public.clickup_draft_orders'::regclass`)
check('row level security is on and there is no policy', meta.relrowsecurity === true && meta.policies === 0)

// 5. Applying it again is harmless and keeps the data
await db.exec(MIGRATION)
row = await one(`select count(*)::int as n from public.clickup_draft_orders`)
check('applying it a second time keeps the rows', row.n === 1)

// 6. The self-check really stops a wrong state
await db.exec(`create policy leak on public.clickup_draft_orders for select using (true)`)
await fails(MIGRATION, 'must have no policy', 'a policy on the table aborts the migration')
await db.exec(`drop policy leak on public.clickup_draft_orders`)
await db.exec(`update storage.buckets set public = true, file_size_limit = 1 where id = 'clickup-draft-files'`)
await db.exec(MIGRATION)
const fixed = await one(`select public, file_size_limit from storage.buckets where id = 'clickup-draft-files'`)
check('a bucket made public by hand is made private again', fixed.public === false && Number(fixed.file_size_limit) === 52428800)

console.log(`all ${n} checks passed`)
