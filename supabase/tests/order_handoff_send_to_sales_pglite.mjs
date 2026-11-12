// Database regression suite for 20270619000000 (send_order_handoff_to_sales: the approver sends a PI
// version back to the salesperson with a comment).
//
// Applies the REAL migration file on an in-memory Postgres (PGlite), and takes the REAL
// order_notify_users() text out of 20270321000001 so the notice rules (never the actor, never an inactive
// account, one notice per person) are the shipped ones. Stubbed, and said so: auth.uid(),
// assert_order_submission_actor(), actor_has_module_permission() (true only for the people listed in
// zz_approvers), can_read_order_detail() (hides the Orders listed in zz_hidden), and the tables (only the
// columns the function reads or writes). The permission engine and RLS are NOT exercised here.
//
// NOT part of npm test (PGlite is not an app dependency). Run:
//   node supabase/tests/order_handoff_send_to_sales_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all 12 checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node order_handoff_send_to_sales_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const MIGRATION = readFileSync(`${REPO}/supabase/migrations/20270619000000_order_handoff_send_to_sales.sql`, 'utf8').replace(/\r/g, '')
const NOTIFY_SQL = readFileSync(`${REPO}/supabase/migrations/20270321000001_order_submission_notifications_complete.sql`, 'utf8').replace(/\r/g, '')
const helper = NOTIFY_SQL.match(/create or replace function public\.order_notify_users\([\s\S]*?\n\$\$;/)
assert.ok(helper, 'the real order_notify_users() text was found')

const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const APPROVER = id(0xa1), SALES = id(0xb1), CREATOR = id(0xb2), STRANGER = id(0xc1), INACTIVE = id(0xd1), HIDDEN_APPROVER = id(0xe1)
const O = n => id(0x100 + n), S = n => id(0x200 + n), V = n => id(0x300 + n), H = n => id(0x400 + n)

const db = new PGlite()
let checks = 0
const check = async (name, fn) => { await fn(); checks += 1; console.log('ok -', name) }
const as = uid => db.exec(`select set_config('test.uid', '${uid ?? ''}', false)`)
const send = (handoff, comment) => db.query(`select public.send_order_handoff_to_sales($1::uuid, $2) as r`, [handoff, comment])
const refused = async (promise, pattern) => {
  let err = null
  try { await promise } catch (e) { err = e }
  assert.ok(err, 'the call was refused')
  assert.match(String(err.message), pattern)
}
const count = async sql => (await db.query(sql)).rows[0].n
const history = order => count(`select count(*)::int as n from public.order_activity_log where order_id = '${order}'`)
const notices = order => count(`select count(*)::int as n from public.notifications where entity_id = '${order}'`)

await db.exec(`
  create schema if not exists auth;
  create role anon nologin;
  create role authenticated nologin;
  create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create function public.assert_order_submission_actor() returns uuid language plpgsql stable as $$
    begin
      if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
      return auth.uid();
    end $$;
  create type notification_type as enum ('order_operations_review_decided', 'order_operations_review_requested');

  create table public.users (id uuid primary key, full_name text, is_active boolean default true, is_deleted boolean default false);
  create table public.order_submissions (id uuid primary key, created_by uuid, submitted_by uuid);
  create table public.orders (id uuid primary key, display_number text, status text default 'running',
    assigned_to uuid, requested_by uuid, source_order_submission_id uuid, production_alignment text default 'not_aligned');
  create table public.order_operations_handoffs (id uuid primary key, order_id uuid references public.orders(id),
    pi_version_id uuid, version_number int, status text, superseded_at timestamptz);
  create table public.order_activity_log (id uuid primary key default gen_random_uuid(), order_id uuid, actor_id uuid,
    event_type text, payload jsonb, created_at timestamptz default now());
  create table public.notifications (id uuid primary key default gen_random_uuid(), user_id uuid, task_id uuid, entity_id uuid,
    type notification_type, title text, body text, is_push_sent boolean, created_at timestamptz default now());
  create table public.zz_approvers (user_id uuid);
  create table public.zz_hidden (order_id uuid);

  create function public.actor_has_module_permission(p_module text, p_action text) returns boolean language sql stable
    as $$ select p_module = 'orders' and p_action = 'approve_order'
                 and exists (select 1 from public.zz_approvers a where a.user_id = auth.uid()) $$;
  create function public.can_read_order_detail(uuid) returns boolean language sql stable
    as $$ select not exists (select 1 from public.zz_hidden h where h.order_id = $1) $$;
`)
await db.exec(helper[0])

await db.exec(`
  insert into public.users (id, full_name, is_active) values
    ('${APPROVER}', 'Nishant Approver', true), ('${SALES}', 'Sales Person', true), ('${CREATOR}', 'PI Creator', true),
    ('${STRANGER}', 'Someone Else', true), ('${INACTIVE}', 'Left The Company', false), ('${HIDDEN_APPROVER}', 'Cannot Open', true);
  insert into public.zz_approvers values ('${APPROVER}'), ('${HIDDEN_APPROVER}');
  insert into public.order_submissions values ('${S(1)}', '${CREATOR}', '${SALES}'), ('${S(2)}', '${CREATOR}', '${CREATOR}'),
    ('${S(3)}', '${INACTIVE}', '${INACTIVE}'), ('${S(4)}', '${APPROVER}', '${APPROVER}');
  insert into public.orders (id, display_number, status, assigned_to, requested_by, source_order_submission_id) values
    ('${O(1)}', '0547', 'running',   '${SALES}',    '${SALES}',    '${S(1)}'),
    ('${O(2)}', '0548', 'running',   '${APPROVER}', '${CREATOR}',  '${S(2)}'),
    ('${O(3)}', '0549', 'running',   '${INACTIVE}', '${INACTIVE}', '${S(3)}'),
    ('${O(4)}', '0550', 'cancelled', '${SALES}',    '${SALES}',    '${S(1)}'),
    ('${O(5)}', '0551', 'running',   '${APPROVER}', '${APPROVER}', '${S(4)}'),
    ('${O(6)}', '0552', 'running',   '${SALES}',    '${SALES}',    '${S(1)}');
  insert into public.order_operations_handoffs values
    ('${H(1)}', '${O(1)}', '${V(1)}', 1, 'clarification_needed', null),
    ('${H(2)}', '${O(2)}', '${V(2)}', 1, 'awaiting', null),
    ('${H(3)}', '${O(3)}', '${V(3)}', 1, 'awaiting', null),
    ('${H(4)}', '${O(4)}', '${V(4)}', 1, 'awaiting', null),
    ('${H(5)}', '${O(5)}', '${V(5)}', 1, 'awaiting', null),
    ('${H(6)}', '${O(6)}', '${V(6)}', 1, 'accepted', null),
    ('${H(7)}', '${O(6)}', '${V(7)}', 1, 'awaiting', now());
  insert into public.zz_hidden values ('${O(1)}');
`)
// Order 1 is hidden from everyone for the "cannot open" check; reveal it again for the normal ones.
await db.exec(`delete from public.zz_hidden`)

// The REAL migration, executed.
await db.exec(MIGRATION)

const COMMENT = 'Operations is right: the chair price is too low. Please revise the PI and tell the client.'

await check('the migration applies; signed-in people may call it, anon may not', async () => {
  const q = await db.query(`select
      has_function_privilege('anon', 'public.send_order_handoff_to_sales(uuid, text)', 'execute') as a,
      has_function_privilege('authenticated', 'public.send_order_handoff_to_sales(uuid, text)', 'execute') as s`)
  assert.deepEqual(q.rows[0], { a: false, s: true })
})

await check('somebody who is not an approver or administrator is refused, and nothing is written', async () => {
  await as(STRANGER)
  await refused(send(H(1), COMMENT), /Only an administrator or a PI approver/)
  assert.equal(await history(O(1)), 0)
  assert.equal(await notices(O(1)), 0)
  await as(null)
})

await check('a blank comment and an over-long comment are refused', async () => {
  await as(APPROVER)
  await refused(send(H(1), '   '), /SEND_BACK_COMMENT_REQUIRED/)
  await refused(send(H(1), null), /SEND_BACK_COMMENT_REQUIRED/)
  await refused(send(H(1), 'x'.repeat(1001)), /SEND_BACK_COMMENT_TOO_LONG/)
  assert.equal(await history(O(1)), 0)
})

await check('an unknown handoff is refused', async () => {
  await refused(send(id(0x999), COMMENT), /ORDER_OPERATIONS_HANDOFF_NOT_FOUND/)
})

await check('an approver who cannot open the Order is refused', async () => {
  await db.exec(`insert into public.zz_hidden values ('${O(1)}')`)
  await as(HIDDEN_APPROVER)
  await refused(send(H(1), COMMENT), /Only an administrator or a PI approver/)
  await db.exec(`delete from public.zz_hidden`)
  assert.equal(await history(O(1)), 0)
})

await check('a flagged version goes back: one history entry with the comment, one notice each to the salesperson and the creator, none to the approver', async () => {
  await as(APPROVER)
  const r = (await send(H(1), `  ${COMMENT}  `)).rows[0].r
  assert.equal(r.version_number, 1)
  assert.equal(r.notified, 2)
  assert.deepEqual([...r.recipients].sort(), [SALES, CREATOR].sort())
  const log = (await db.query(`select actor_id, event_type, payload from public.order_activity_log where order_id = '${O(1)}'`)).rows
  assert.equal(log.length, 1)
  assert.equal(log[0].event_type, 'operations_handoff_sent_to_sales')
  assert.equal(log[0].actor_id, APPROVER)
  assert.equal(log[0].payload.comment, COMMENT, 'the comment is stored trimmed')
  assert.equal(log[0].payload.handoff_id, H(1))
  assert.equal(log[0].payload.handoff_status, 'clarification_needed')
  const n = (await db.query(`select user_id, type, title, body from public.notifications where entity_id = '${O(1)}' order by user_id`)).rows
  assert.deepEqual(n.map(x => x.user_id).sort(), [SALES, CREATOR].sort())
  for (const x of n) {
    assert.equal(x.type, 'order_operations_review_decided')
    assert.equal(x.title, 'Order 0547: Nishant Approver sent PI V1 back to you.')
    assert.equal(x.body, COMMENT)
  }
})

await check('nothing else moves: the handoff status, the Order and its alignment are as they were', async () => {
  const h = (await db.query(`select status, superseded_at from public.order_operations_handoffs where id = '${H(1)}'`)).rows[0]
  assert.deepEqual(h, { status: 'clarification_needed', superseded_at: null })
  const o = (await db.query(`select status, production_alignment from public.orders where id = '${O(1)}'`)).rows[0]
  assert.deepEqual(o, { status: 'running', production_alignment: 'not_aligned' })
})

await check('a version still waiting for Operations can be sent back too; the actor, being the Order\'s salesperson, is not told', async () => {
  const r = (await send(H(2), COMMENT)).rows[0].r
  assert.deepEqual(r.recipients, [CREATOR])
  assert.equal(r.notified, 1)
  assert.equal(await notices(O(2)), 1)
})

await check('an inactive salesperson is never a recipient; with nobody left the call is refused and nothing is written', async () => {
  await refused(send(H(3), COMMENT), /SEND_BACK_NO_SALESPERSON/)
  assert.equal(await history(O(3)), 0)
  assert.equal(await notices(O(3)), 0)
})

await check('when the approver is also the only salesperson there is nobody to send it to', async () => {
  await refused(send(H(5), COMMENT), /SEND_BACK_NO_SALESPERSON/)
  assert.equal(await history(O(5)), 0)
})

await check('a cancelled Order, an accepted version and a superseded version are refused', async () => {
  await refused(send(H(4), COMMENT), /ORDER_OPERATIONS_HANDOFF_CLOSED/)
  await refused(send(H(6), COMMENT), /ORDER_OPERATIONS_HANDOFF_ALREADY_ACCEPTED/)
  await refused(send(H(7), COMMENT), /ORDER_OPERATIONS_HANDOFF_SUPERSEDED/)
  assert.equal(await history(O(4)), 0)
  assert.equal(await history(O(6)), 0)
})

await check('a second send within two minutes is recorded in the history, but the notice is not doubled', async () => {
  await as(APPROVER)
  const r = (await send(H(1), 'One more thing: please attach the client\'s email.')).rows[0].r
  assert.equal(r.notified, 0)
  assert.equal(await history(O(1)), 2)
  assert.equal(await notices(O(1)), 2)
})

console.log(`all ${checks} checks passed`)
await db.close()
