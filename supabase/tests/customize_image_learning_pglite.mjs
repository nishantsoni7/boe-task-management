// Database regression suite for 20270420000000 (Customize image learning).
//
// Applies the REAL migration on an in-memory Postgres (PGlite). Stubbed, and
// said so: auth.uid(), users, the permission tables (the columns and unique
// keys the migration's upserts need), order_submissions (id only),
// module_entry_open (always open) and actor_has_module_permission (admin role
// or a grants row — the shape of the real one).
//
// NOT part of npm test (PGlite is not an app dependency). Run:
//   node supabase/tests/customize_image_learning_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all 12 checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node customize_image_learning_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const MIGRATION = readFileSync(`${REPO}/supabase/migrations/20270420000000_orders_customize_image_learning.sql`, 'utf8')

const U = {
  admin:    '00000000-0000-0000-0000-0000000000d4',
  trainer:  '00000000-0000-0000-0000-0000000000a1', // granted orders.train_customize_image
  sales:    '00000000-0000-0000-0000-0000000000b2', // nothing
}
const SUB = '11111111-1111-4111-8111-111111111111'
const ITEM = '22222222-2222-4222-8222-222222222222'

const db = new PGlite()
await db.exec(`
create role anon nologin; create role authenticated nologin;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create table public.users (id uuid primary key, role text not null default 'member');
create table public.grants (user_id uuid, action text);
create table public.permission_modules (id uuid primary key default gen_random_uuid(), module_key text unique not null);
create table public.permission_actions (id uuid primary key default gen_random_uuid(), action_key text unique not null, display_name text, is_system boolean);
create table public.module_permission_actions (module_id uuid, action_id uuid, default_allowed boolean, unique (module_id, action_id));
insert into public.permission_modules (module_key) values ('orders'), ('finance');
create table public.order_submissions (id uuid primary key);
create function public.module_entry_open(text) returns boolean language sql as $$ select true $$;
create function public.actor_has_module_permission(p_module text, p_action text) returns boolean language sql stable as $$
  select exists (select 1 from public.users where id = auth.uid() and role = 'admin')
      or exists (select 1 from public.grants where user_id = auth.uid() and action = p_action) $$;
grant usage on schema public to anon, authenticated;
-- As on Supabase: every new table in public is granted to anon and authenticated
-- unless the migration revokes it, so check 4 proves the REVOKE, not a default.
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
insert into public.users (id, role) values ('${U.admin}', 'admin'), ('${U.trainer}', 'member'), ('${U.sales}', 'member');
insert into public.grants values ('${U.trainer}', 'train_customize_image');
insert into public.order_submissions values ('${SUB}');
`)

let passed = 0
const check = async (name, fn) => { await fn(); passed += 1; console.log('ok', passed, '-', name) }
const as = async (role, uid, sql) => {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false);`)
  try { return await db.query(sql) } finally { await db.exec('reset role;') }
}
const rejects = async (fn, pattern) => {
  let err = null
  try { await fn() } catch (e) { err = e }
  assert.ok(err, 'expected an error')
  if (pattern) assert.match(String(err.message), pattern)
}

await check('the real migration applies and its own assertions pass', async () => {
  await db.exec(MIGRATION)
})

await check('orders.train_customize_image is registered, deny-by-default, on orders only', async () => {
  const { rows } = await db.query(`
    select pm.module_key, mpa.default_allowed from module_permission_actions mpa
      join permission_actions pa on pa.id = mpa.action_id join permission_modules pm on pm.id = mpa.module_id
     where pa.action_key = 'train_customize_image'`)
  assert.deepEqual(rows, [{ module_key: 'orders', default_allowed: false }])
})

await check('five seed rules, active, marked seed', async () => {
  const { rows } = await db.query(`select count(*)::int n from pi_customization_rules where source = 'seed' and is_active`)
  assert.equal(rows[0].n, 5)
  const { rows: plate } = await db.query(`select 1 from pi_customization_rules where rule_text ilike '%ONE continuous floor plate%'`)
  assert.equal(plate.length, 1)
})

await check('a signed-in person cannot read or write any of the three tables directly', async () => {
  for (const t of ['pi_customization_attempts', 'pi_customization_rules', 'pi_customization_examples']) {
    await rejects(() => as('authenticated', U.admin, `select * from public.${t}`), /permission denied/)
    await rejects(() => as('anon', null, `select * from public.${t}`), /permission denied/)
  }
  await rejects(() => as('authenticated', U.admin, `insert into public.pi_customization_rules (rule_text) values ('a sneaky rule')`), /permission denied/)
})

await check('the Learning door: admin and a granted person yes, a salesperson and nobody no', async () => {
  const ask = async uid => (await as('authenticated', uid, 'select public.can_train_customize_image() ok')).rows[0].ok
  assert.equal(await ask(U.admin), true)
  assert.equal(await ask(U.trainer), true)
  assert.equal(await ask(U.sales), false)
  assert.equal(await ask(null), false)
})

await check('anon cannot even ask the Learning door', async () => {
  await rejects(() => as('anon', null, 'select public.can_train_customize_image()'), /permission denied/)
})

await db.exec(`
insert into pi_customization_attempts (id, submission_id, item_id, created_by, source_path, comment, understood_instruction)
values ('33333333-3333-4333-8333-333333333333', '${SUB}', '${ITEM}', '${U.sales}', 'submissions/x/images/y/representative/0-a.png',
        'longer table, 2 pedestal, bottom plate combined', 'Make the top a long rectangle…');
insert into pi_customization_examples (id, attempt_id, comment, instruction, keywords, before_path, after_path)
values ('44444444-4444-4444-8444-444444444444', '33333333-3333-4333-8333-333333333333', 'bottom plate combined',
        'Both pedestals stand on ONE continuous floor plate.', '{table,pedestal,plate}',
        'customize-learning/examples/44444444-4444-4444-8444-444444444444/before.jpg',
        'customize-learning/examples/44444444-4444-4444-8444-444444444444/after.png');
`)

await check('an attempt starts as understood, with empty rule/example lists', async () => {
  const { rows } = await db.query(`select outcome, applied_rule_ids, feedback, jsonb_typeof(understood_assumptions) t from pi_customization_attempts`)
  assert.deepEqual(rows[0], { outcome: 'understood', applied_rule_ids: [], feedback: null, t: 'array' })
})

await check('the checks refuse bad values', async () => {
  await rejects(() => db.query(`update pi_customization_attempts set outcome = 'approved'`), /check/)
  await rejects(() => db.query(`update pi_customization_attempts set feedback = 'maybe'`), /check/)
  await rejects(() => db.query(`insert into pi_customization_rules (rule_text) values ('  ab ')`), /check/)
  await rejects(() => db.query(`update pi_customization_examples set before_path = 'submissions/other/file.png'`), /check/)
  await rejects(() => db.query(`update pi_customization_attempts set reference_count = 3`), /check/)
})

await check('a deleted member leaves their attempts, anonymised', async () => {
  await db.query(`delete from users where id = '${U.sales}'`)
  const { rows } = await db.query(`select created_by from pi_customization_attempts`)
  assert.equal(rows[0].created_by, null)
})

await check('deleting the PI deletes its attempts …', async () => {
  await db.query(`delete from order_submissions where id = '${SUB}'`)
  const { rows } = await db.query(`select count(*)::int n from pi_customization_attempts`)
  assert.equal(rows[0].n, 0)
})

await check('… but an approved example survives, unlinked, with its own pictures', async () => {
  const { rows } = await db.query(`select attempt_id, before_path from pi_customization_examples`)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].attempt_id, null)
  assert.match(rows[0].before_path, /^customize-learning\/examples\//)
})

await check('no existing table was touched (order_submissions still has only its id)', async () => {
  const { rows } = await db.query(`select count(*)::int n from information_schema.columns where table_name = 'order_submissions'`)
  assert.equal(rows[0].n, 1)
})

console.log(`all ${passed} checks passed`)
