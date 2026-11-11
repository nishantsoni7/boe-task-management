// Database regression suite for 20270611000000 (my_flagged_pis: the PIs Operations flagged
// that the CALLER must answer).
//
// Applies the REAL migration file on an in-memory Postgres (PGlite), together with the REAL
// text of can_propose_order_pi_edit() sliced out of 20270115000000, so the answer door's own
// rule is what is being asked. Stubbed, and said so: auth.uid(), module_entry_open,
// can_view_order (hides the orders listed in zz_hidden), actor_has_module_permission
// (holders of orders.create are listed in zz_create), and the tables (only the columns the
// functions read). The last-but-one check runs supabase/tests/my_flagged_pis_rehearsal_footer.sql, the file the
// owner runs against the real database, so a syntax slip in it cannot waste their time.
//
// NOT part of npm test (PGlite is not an app dependency). Run:
//   node supabase/tests/my_flagged_pis_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all 16 checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node my_flagged_pis_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const mig = f => readFileSync(`${REPO}/supabase/migrations/${f}`, 'utf8').replace(/\r/g, '')

// The REAL answer-door rule, from its own migration.
const REVISIONS = mig('20270115000000_order_submission_pi_edit_revisions.sql')
const start = REVISIONS.indexOf('create or replace function public.can_propose_order_pi_edit(uuid)'.replace('(uuid)', '(p_order_id uuid)'))
assert.ok(start > 0, 'can_propose_order_pi_edit is in 20270115000000')
const DOOR = REVISIONS.slice(start, REVISIONS.indexOf('$$;', REVISIONS.indexOf('as $$', start)) + 3)

const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const ADMIN = id(0xa0), OWNER = id(0xa1), OTHER = id(0xb1), REVIEWER = id(0xc1), NOCREATE = id(0xd1), INACTIVE_ADMIN = id(0xa9)
const O = n => id(0x100 + n)   // orders
const S = n => id(0x200 + n)   // PI drafts
const V = n => id(0x300 + n)   // PI versions
const H = n => id(0x400 + n)   // handoffs

const db = new PGlite()
let checks = 0
const check = async (name, fn) => { await fn(); checks += 1; console.log('ok -', name) }
const as = uid => db.exec(`select set_config('test.uid', '${uid ?? ''}', false)`)
const ordersOpen = yes => db.exec(`select set_config('test.orders_open', '${yes ? 'yes' : 'no'}', false)`)
const mine = async () => (await db.query(`select public.my_flagged_pis() as r`)).rows[0].r
const numbers = async () => (await mine()).map(r => r.order_number)

await db.exec(`
  create schema if not exists auth;
  create role anon nologin;
  create role authenticated nologin;
  create function auth.uid() returns uuid language sql stable
    as $$ select coalesce(nullif(current_setting('test.uid', true), '')::uuid,
                          (nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub')::uuid) $$;

  create table public.users (id uuid primary key, full_name text, role text,
    is_active boolean default true, is_deleted boolean default false);
  create table public.orders (id uuid primary key, display_number text, client_name text, status text,
    source_order_submission_id uuid);
  create table public.order_submissions (id uuid primary key, order_id uuid, status text,
    created_by uuid, submitted_by uuid);
  create table public.order_pi_versions (id uuid primary key, order_id uuid, status text);
  create table public.order_operations_handoffs (id uuid primary key, order_id uuid, pi_version_id uuid,
    submission_id uuid, version_number int, status text, clarification_by uuid, clarification_at timestamptz,
    clarification_reason text, superseded_at timestamptz);
  create table public.zz_hidden (order_id uuid);
  create table public.zz_create (user_id uuid);

  create function public.module_entry_open(text) returns boolean language sql stable
    as $$ select coalesce(current_setting('test.orders_open', true), 'yes') = 'yes' $$;
  create function public.can_view_order(uuid) returns boolean language sql stable
    as $$ select not exists (select 1 from public.zz_hidden h where h.order_id = $1) $$;
  create function public.actor_has_module_permission(text, text) returns boolean language sql stable
    as $$ select exists (select 1 from public.zz_create c where c.user_id = auth.uid()) $$;

  ${DOOR}

  insert into public.users values
    ('${ADMIN}', 'Nishant Soni', 'admin', true, false),
    ('${OWNER}', 'Mohit Sharma', 'member', true, false),
    ('${OTHER}', 'Other Seller', 'member', true, false),
    ('${REVIEWER}', 'Nitish Bansal', 'member', true, false),
    ('${NOCREATE}', 'No Create', 'member', true, false),
    ('${INACTIVE_ADMIN}', 'Left Admin', 'admin', false, false);
  insert into public.zz_create values ('${OWNER}'), ('${OTHER}');

  -- 1 flagged, owner = OWNER (Order 546) · 2 flagged, owner = OTHER · 3 flagged, Order cancelled
  -- 4 awaiting, not flagged · 5 flagged but replaced by a later version · 6 flagged, a second approved version exists
  -- 7 flagged, creator holds no orders.create · 8 flagged, hidden from every reader by Order visibility
  insert into public.orders values
    ('${O(1)}', '546', 'Qavaali', 'running', '${S(1)}'),
    ('${O(2)}', '547', 'Second Client', 'running', '${S(2)}'),
    ('${O(3)}', '548', 'Cancelled Co', 'cancelled', '${S(3)}'),
    ('${O(4)}', '549', 'Awaiting Co', 'running', '${S(4)}'),
    ('${O(5)}', '550', 'Replaced Co', 'running', '${S(5)}'),
    ('${O(6)}', '551', 'Stale Co', 'running', '${S(6)}'),
    ('${O(7)}', '552', 'No Create Co', 'running', '${S(7)}'),
    ('${O(8)}', '553', 'Hidden Co', 'running', '${S(8)}');
  insert into public.order_submissions values
    ('${S(1)}', '${O(1)}', 'approved', '${OWNER}', '${OWNER}'),
    ('${S(2)}', '${O(2)}', 'approved', '${OTHER}', '${OTHER}'),
    ('${S(3)}', '${O(3)}', 'approved', '${OWNER}', '${OWNER}'),
    ('${S(4)}', '${O(4)}', 'approved', '${OWNER}', '${OWNER}'),
    ('${S(5)}', '${O(5)}', 'approved', '${OWNER}', '${OWNER}'),
    ('${S(6)}', '${O(6)}', 'approved', '${OWNER}', '${OWNER}'),
    ('${S(7)}', '${O(7)}', 'approved', '${NOCREATE}', '${NOCREATE}'),
    ('${S(8)}', '${O(8)}', 'approved', '${OWNER}', '${OWNER}');
  insert into public.order_pi_versions values
    ('${V(1)}', '${O(1)}', 'approved'), ('${V(2)}', '${O(2)}', 'approved'), ('${V(3)}', '${O(3)}', 'approved'),
    ('${V(4)}', '${O(4)}', 'approved'),
    ('${V(5)}', '${O(5)}', 'superseded'), ('${V(50)}', '${O(5)}', 'approved'),
    ('${V(6)}', '${O(6)}', 'approved'), ('${V(60)}', '${O(6)}', 'approved'),
    ('${V(7)}', '${O(7)}', 'approved'), ('${V(8)}', '${O(8)}', 'approved');
  insert into public.order_operations_handoffs (id, order_id, pi_version_id, submission_id, version_number, status,
    clarification_by, clarification_at, clarification_reason, superseded_at) values
    ('${H(1)}', '${O(1)}', '${V(1)}', '${S(1)}', 1, 'clarification_needed', '${REVIEWER}', now() - interval '3 days',
      'As per mohit... client wanted a visit from our side before aligning the order', null),
    ('${H(2)}', '${O(2)}', '${V(2)}', '${S(2)}', 2, 'clarification_needed', '${REVIEWER}', now() - interval '1 day', 'Second reason', null),
    ('${H(3)}', '${O(3)}', '${V(3)}', '${S(3)}', 1, 'clarification_needed', '${REVIEWER}', now() - interval '2 days', 'Cancelled', null),
    ('${H(4)}', '${O(4)}', '${V(4)}', '${S(4)}', 1, 'awaiting', null, null, null, null),
    ('${H(5)}', '${O(5)}', '${V(5)}', '${S(5)}', 1, 'clarification_needed', '${REVIEWER}', now() - interval '5 days', 'Replaced', now() - interval '4 days'),
    ('${H(6)}', '${O(6)}', '${V(6)}', '${S(6)}', 1, 'clarification_needed', '${REVIEWER}', now() - interval '2 days', 'Stale', null),
    ('${H(7)}', '${O(7)}', '${V(7)}', '${S(7)}', 1, 'clarification_needed', '${REVIEWER}', now() - interval '2 days', 'No create', null),
    ('${H(8)}', '${O(8)}', '${V(8)}', '${S(8)}', 1, 'clarification_needed', '${REVIEWER}', now() - interval '2 days', 'Hidden', null);
  insert into public.zz_hidden values ('${O(8)}');

  -- The rehearsal footer runs as the authenticated role, as the real one does.
  grant usage on schema auth, public to authenticated;
  grant execute on function auth.uid() to authenticated;
  grant select on all tables in schema public to authenticated;
  grant execute on all functions in schema public to authenticated;
`)

// The REAL migration, executed (its own assertions run with it).
await db.exec(mig('20270611000000_my_flagged_pis.sql'))

await check('the migration applies and its own assertions pass; anon cannot call it, a signed-in person can', async () => {
  const q = await db.query(`select has_function_privilege('anon', 'public.my_flagged_pis()', 'execute') as a,
                                   has_function_privilege('authenticated', 'public.my_flagged_pis()', 'execute') as s`)
  assert.deepEqual(q.rows[0], { a: false, s: true })
})

await check('an admin sees every live flag on a visible Order, oldest first, and nothing else', async () => {
  await as(ADMIN)
  assert.deepEqual(await numbers(), ['546', '552', '547'])
})

await check('the PI owner sees only their own flagged Order (546)', async () => {
  await as(OWNER)
  const rows = await mine()
  assert.deepEqual(rows.map(r => r.order_number), ['546'])
  assert.equal(rows[0].client_name, 'Qavaali')
  assert.equal(rows[0].version_number, 1)
  assert.equal(rows[0].order_id, O(1))
  assert.equal(rows[0].handoff_id, H(1))
  assert.equal(rows[0].by_name, 'Nitish Bansal')
  assert.match(rows[0].reason, /client wanted a visit/)
  const waited = Number(rows[0].waiting_seconds)
  assert.ok(waited > 3 * 86400 - 60 && waited < 3 * 86400 + 300, `waiting_seconds is about three days (${waited})`)
})

await check('another salesperson sees only the Order they own, not 546', async () => {
  await as(OTHER)
  assert.deepEqual(await numbers(), ['547'])
})

await check('the operations reviewer who flagged it is not asked to answer it', async () => {
  await as(REVIEWER)
  assert.deepEqual(await numbers(), [])
})

await check('a creator without orders.create, and an inactive admin, see nothing', async () => {
  await as(NOCREATE)
  assert.deepEqual(await numbers(), [])
  await as(INACTIVE_ADMIN)
  assert.deepEqual(await numbers(), [])
})

await check('cancelled, awaiting, superseded, stale (a second approved version) and hidden Orders are never listed, even for an admin', async () => {
  await as(ADMIN)
  const n = await numbers()
  for (const gone of ['548', '549', '550', '551', '553']) assert.equal(n.includes(gone), false, `${gone} is not listed`)
})

await check('nobody signed in, or Orders closed to the caller, gets an empty list and no error', async () => {
  await as(null)
  assert.deepEqual(await mine(), [])
  await as(ADMIN)
  await ordersOpen(false)
  assert.deepEqual(await mine(), [])
  await ordersOpen(true)
})

await check('the same list as the answer door: every row listed is one can_propose_order_pi_edit accepts, for every kind of reader', async () => {
  for (const who of [ADMIN, OWNER, OTHER, REVIEWER, NOCREATE, INACTIVE_ADMIN]) {
    await as(who)
    for (const r of await mine()) {
      const ok = (await db.query(`select public.can_propose_order_pi_edit('${r.order_id}') as ok`)).rows[0].ok
      assert.equal(ok, true, `${who} was shown ${r.order_number} but the door would refuse`)
    }
  }
})

await check('answered and resubmitted (handoff back to awaiting): it leaves the owner and the admin at once', async () => {
  await db.exec(`update public.order_operations_handoffs set status = 'awaiting' where id = '${H(1)}'`)
  await as(OWNER)
  assert.deepEqual(await numbers(), [])
  await as(ADMIN)
  assert.deepEqual(await numbers(), ['552', '547'])
})

await check('Operations flags it again (a new objection): it comes back, with the new reason', async () => {
  await db.exec(`update public.order_operations_handoffs set status = 'clarification_needed', clarification_reason = 'Still not aligned',
                    clarification_at = now() where id = '${H(1)}'`)
  await as(OWNER)
  const rows = await mine()
  assert.deepEqual(rows.map(r => r.order_number), ['546'])
  assert.equal(rows[0].reason, 'Still not aligned')
})

await check('a revised PI is approved (the handoff is superseded): it leaves everyone', async () => {
  await db.exec(`update public.order_operations_handoffs set superseded_at = now() where id = '${H(1)}'`)
  await as(OWNER)
  assert.deepEqual(await numbers(), [])
  await as(ADMIN)
  assert.deepEqual(await numbers(), ['552', '547'])
})

await check('the Order is cancelled: it leaves the PI owner', async () => {
  await db.exec(`update public.orders set status = 'cancelled' where id = '${O(2)}'`)
  await as(OTHER)
  assert.deepEqual(await numbers(), [])
})

await check('the function writes nothing: it is stable and the data it read is unchanged by calling it', async () => {
  const before = JSON.stringify((await db.query(`select * from public.order_operations_handoffs order by id`)).rows)
  await as(ADMIN)
  await mine(); await mine()
  const after = JSON.stringify((await db.query(`select * from public.order_operations_handoffs order by id`)).rows)
  assert.equal(before, after)
  const v = (await db.query(`select provolatile as v, prosecdef as d from pg_proc where proname = 'my_flagged_pis'`)).rows[0]
  assert.deepEqual(v, { v: 's', d: true })
})

await check('the real-database rehearsal footer runs on this data, as real people, and ends REHEARSAL OK', async () => {
  const footer = readFileSync(`${REPO}/supabase/tests/my_flagged_pis_rehearsal_footer.sql`, 'utf8').replace(/\r/g, '')
  await db.exec(`select set_config('test.uid', '', false); begin;`)
  const results = await db.exec(footer)
  await db.exec('rollback')
  const last = results[results.length - 1].rows[0]
  assert.deepEqual(last, { result: 'REHEARSAL OK' })
  const people = results.find(r => r.fields?.some(f => f.name === 'people_exercised')).rows[0]
  // By now 546 was answered then replaced and 547 is cancelled: the only live flag an admin may answer is 552 (its creator lacks orders.create).
  assert.deepEqual({ p: Number(people.people_exercised), r: Number(people.rows_listed) }, { p: 4, r: 1 })
  const perOrder = results.find(r => r.fields?.some(f => f.name === 'people_asked_to_answer')).rows
  assert.deepEqual(perOrder.map(r => r.order_number), ['552'])
})

await check('rolling it back (drop function) removes it and leaves everything else in place', async () => {
  await db.exec(`drop function public.my_flagged_pis()`)
  assert.equal((await db.query(`select count(*)::int as n from pg_proc where proname = 'my_flagged_pis'`)).rows[0].n, 0)
  assert.equal((await db.query(`select count(*)::int as n from pg_proc where proname = 'can_propose_order_pi_edit'`)).rows[0].n, 1)
  assert.equal((await db.query(`select count(*)::int as n from public.order_operations_handoffs`)).rows[0].n, 8)
})

console.log(`all ${checks} checks passed`)
