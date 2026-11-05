// Database regression suite for 20270603000000 (Finance: a private note on a payment that only an admin can see).
//
// Applies the REAL migration on an in-memory Postgres (PGlite) over a small stand-in for what it depends on: auth.uid()
// (a session setting), the three roles, users and a minimal finance_payment_requests (id, deleted_at). Everything the
// migration defines is the real thing.
//
// NOT part of npm test (PGlite is not a dependency of the app). Run it with a directory that has @electric-sql/pglite:
//   node supabase/tests/payment_admin_notes_pglite.mjs <dir with node_modules/@electric-sql/pglite>
// Expected last line: "all N checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node payment_admin_notes_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const migration = readFileSync(`${REPO}/supabase/migrations/20270603000000_finance_payment_admin_notes.sql`, 'utf8')

const U = {
  admin:     '00000000-0000-0000-0000-0000000000a1',   // active admin
  admin2:    '00000000-0000-0000-0000-0000000000a2',   // a second active admin
  gone:      '00000000-0000-0000-0000-0000000000a3',   // an admin who is switched off
  removed:   '00000000-0000-0000-0000-0000000000a4',   // an admin who is deleted
  manager:   '00000000-0000-0000-0000-0000000000b1',   // role manager (a Finance approver would look like this)
  sales:     '00000000-0000-0000-0000-0000000000b2',   // the person who sent the payment
}
const P = {
  live:    '00000000-0000-0000-0000-00000000c001',
  deleted: '00000000-0000-0000-0000-00000000c002',
  other:   '00000000-0000-0000-0000-00000000c003',
}

const db = new PGlite()
let checks = 0
const ok = (name) => { checks += 1; console.log(`  ok  ${name}`) }

await db.exec(`
create schema if not exists auth;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
grant usage on schema auth, public to anon, authenticated;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
grant execute on function auth.uid() to anon, authenticated;

create table public.users (id uuid primary key, full_name text, role text not null default 'member',
  is_active boolean not null default true, is_deleted boolean not null default false);
create table public.finance_payment_requests (id uuid primary key, submitted_by uuid references public.users(id), deleted_at timestamptz);

insert into public.users (id, full_name, role, is_active, is_deleted) values
  ('${U.admin}', 'Owner', 'admin', true, false), ('${U.admin2}', 'Second admin', 'admin', true, false),
  ('${U.gone}', 'Switched off', 'admin', false, false), ('${U.removed}', 'Deleted', 'admin', true, true),
  ('${U.manager}', 'Manager', 'manager', true, false), ('${U.sales}', 'Sales', 'member', true, false);
insert into public.finance_payment_requests (id, submitted_by, deleted_at) values
  ('${P.live}', '${U.sales}', null), ('${P.deleted}', '${U.sales}', now()), ('${P.other}', '${U.sales}', null);
`)

await db.exec(migration)
ok('the migration applies, self-checks included')

const as = async (uid) => { await db.query(`select set_config('test.uid', $1, false)`, [uid ?? '']) }
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0]
const all = async (sql, params = []) => (await db.query(sql, params)).rows
const expectError = async (fn, pattern, name) => {
  try { await fn(); assert.fail(`${name}: expected a refusal`) }
  catch (e) { assert.match(String(e.message), pattern, `${name}: ${e.message}`); ok(name) }
}
const save = (id, note) => one(`select public.set_payment_admin_note($1, $2) as saved`, [id, note]).then(r => r.saved)
const read = (ids) => all(`select * from public.get_payment_admin_notes($1::uuid[])`, [ids])
const rowCount = async () => Number((await one(`select count(*) as n from public.finance_payment_admin_notes`)).n)

// ── Reach ──
{
  const t = await one(`select c.relrowsecurity as rls, (select count(*) from pg_policies where tablename = 'finance_payment_admin_notes') as policies,
                              has_table_privilege('authenticated', 'public.finance_payment_admin_notes', 'select') as sel,
                              has_table_privilege('authenticated', 'public.finance_payment_admin_notes', 'insert') as ins,
                              has_table_privilege('authenticated', 'public.finance_payment_admin_notes', 'update') as upd,
                              has_table_privilege('authenticated', 'public.finance_payment_admin_notes', 'delete') as del,
                              has_table_privilege('anon', 'public.finance_payment_admin_notes', 'select') as anon_sel
                         from pg_class c where c.relname = 'finance_payment_admin_notes'`)
  assert.equal(t.rls, true); assert.equal(Number(t.policies), 0)
  assert.equal(t.sel, false); assert.equal(t.ins, false); assert.equal(t.upd, false); assert.equal(t.del, false); assert.equal(t.anon_sel, false)
  ok('the table: RLS on, no policy, no select / insert / update / delete for authenticated or anon')
  const f = await one(`select has_function_privilege('anon', 'public.get_payment_admin_notes(uuid[])', 'execute') as anon_get,
                              has_function_privilege('anon', 'public.set_payment_admin_note(uuid, text)', 'execute') as anon_set,
                              has_function_privilege('authenticated', 'public.get_payment_admin_notes(uuid[])', 'execute') as auth_get,
                              has_function_privilege('authenticated', 'public.set_payment_admin_note(uuid, text)', 'execute') as auth_set,
                              has_function_privilege('authenticated', 'public.finance_admin_note_caller_is_admin()', 'execute') as auth_helper`)
  assert.equal(f.anon_get, false); assert.equal(f.anon_set, false)
  assert.equal(f.auth_get, true); assert.equal(f.auth_set, true); assert.equal(f.auth_helper, false)
  ok('anon cannot call either function; authenticated can (and meets the admin door); the admin check is internal')
  await db.exec('set role authenticated')
  await as(U.admin)
  await expectError(() => db.query(`select * from public.finance_payment_admin_notes`), /permission denied/i, 'even an admin cannot read the table directly: the functions are the only door')
  await expectError(() => db.query(`insert into public.finance_payment_admin_notes (payment_id, note) values ('${P.live}', 'x')`), /permission denied/i, 'even an admin cannot write the table directly')
  await db.exec('reset role')
}

// ── The admin ──
{
  await as(U.admin)
  assert.deepEqual(await read([P.live, P.other]), [])
  ok('a payment with no note reads as nothing')
  const saved = await save(P.live, '  Called the client. Money comes Monday.\nSecond line.  ')
  assert.ok(saved)
  const rows = await read([P.live, P.other])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].payment_id, P.live)
  assert.equal(rows[0].note, 'Called the client. Money comes Monday.\nSecond line.')
  ok('an admin saves a note: the ends are trimmed, a line break inside is kept, only that payment is returned')
  const who = await one(`select updated_by from public.finance_payment_admin_notes where payment_id = $1`, [P.live])
  assert.equal(who.updated_by, U.admin)
  ok('the note records who saved it')

  await as(U.admin2)
  await save(P.live, 'Changed by the second admin')
  assert.equal((await read([P.live]))[0].note, 'Changed by the second admin')
  assert.equal(await rowCount(), 1)
  assert.equal((await one(`select updated_by from public.finance_payment_admin_notes`)).updated_by, U.admin2)
  ok('saving again replaces the note (one note per payment); any active admin may')

  await save(P.other, 'x'.repeat(2000))
  ok('2,000 characters is allowed')
  await expectError(() => save(P.other, 'x'.repeat(2001)), /ADMIN_NOTE_TOO_LONG/, 'more than 2,000 characters is refused')
  assert.equal((await read([P.other]))[0].note.length, 2000)
  ok('a refused save leaves the old note as it was')

  assert.equal(await save(P.other, '   \n\t '), null)
  assert.deepEqual(await read([P.other]), [])
  ok('saving an empty note removes it (and says so with null)')
  assert.equal(await save(P.other, null), null)
  ok('removing a note that is not there is not an error')

  await expectError(() => save(P.deleted, 'note on a deleted payment'), /ADMIN_NOTE_PAYMENT_NOT_FOUND/, 'a soft-deleted payment takes no note')
  await expectError(() => save('00000000-0000-0000-0000-00000000dead', 'note'), /ADMIN_NOTE_PAYMENT_NOT_FOUND/, 'a payment that does not exist takes no note')
  await expectError(() => read(Array.from({ length: 501 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`)),
    /ADMIN_NOTE_TOO_MANY/, 'asking for more than 500 payments at once is refused')
  assert.deepEqual(await read(null), [])
  ok('asking for no payments returns nothing')
}

// ── Everybody else ──
{
  await as(U.admin)
  await save(P.live, 'secret')
  const people = [
    ['the person who sent the payment', U.sales], ['a manager (a Finance approver is not an admin)', U.manager],
    ['an admin who is switched off', U.gone], ['an admin who is deleted', U.removed], ['somebody not signed in', null],
  ]
  for (const [who, uid] of people) {
    await as(uid)
    await expectError(() => read([P.live]), /ADMIN_NOTE_ADMIN_ONLY/, `${who} cannot read a note`)
    await expectError(() => save(P.live, 'overwritten'), /ADMIN_NOTE_ADMIN_ONLY/, `${who} cannot write a note`)
    await expectError(() => save(P.live, ''), /ADMIN_NOTE_ADMIN_ONLY/, `${who} cannot remove a note`)
  }
  await as(U.admin)
  assert.equal((await read([P.live]))[0].note, 'secret')
  ok('after every refusal the note is exactly as the admin left it')
}

// ── Lifecycle ──
{
  await as(U.admin)
  await save(P.other, 'goes with the payment')
  await db.query(`delete from public.finance_payment_requests where id = $1`, [P.other])
  assert.equal(await rowCount(), 1)
  ok('deleting a payment deletes its note (admin deletion and Test Data Cleanup are not blocked)')
  // The note on P.live was last saved by the first admin (the refusals above changed nothing).
  const before = await one(`select updated_by from public.finance_payment_admin_notes where payment_id = $1`, [P.live])
  assert.equal(before.updated_by, U.admin)
  await db.query(`delete from public.users where id = $1`, [U.admin])
  const after = await one(`select note, updated_by from public.finance_payment_admin_notes where payment_id = $1`, [P.live])
  assert.equal(after.updated_by, null)
  assert.equal(after.note, 'secret')
  ok('removing the user who saved a note is not blocked; the note stays, with nobody named')
}

console.log(`all ${checks} checks passed`)
await db.close()
