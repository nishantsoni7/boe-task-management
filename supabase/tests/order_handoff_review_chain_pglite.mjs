// Database regression suite for 20270718000000 (the PI review chain: every hop between Operations and
// Sales passes through the approver).
//
// Applies the REAL migration file on an in-memory Postgres (PGlite), over the REAL text of
// order_operations_handoffs_guard() (20261229000000), order_notify_users() (20270321000001) and
// can_propose_order_pi_edit() (20270115000000), so the new trigger is proven next to the shipped guard.
// Stubbed, and said so: auth.uid(), assert_order_submission_actor(), the permission engine
// (zz_grants: user, module, action; an admin passes actor_has_module_permission), can_view_order /
// can_read_order_detail (hide the Orders in zz_hidden), module_entry_open, the old definitions of the
// three functions the migration re-emits (so its dependency check passes), and the tables (only the
// columns the functions read or write). Postgres RLS and the real decide_order_operations_handoff() are
// NOT exercised: the flag/accept moves are plain UPDATEs of status, which is all the trigger sees.
//
// NOT part of npm test (PGlite is not an app dependency). Run:
//   node supabase/tests/order_handoff_review_chain_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all 24 checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node order_handoff_review_chain_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const mig = f => readFileSync(`${REPO}/supabase/migrations/${f}`, 'utf8').replace(/\r/g, '')
const slice = (sql, re, what) => { const m = sql.match(re); assert.ok(m, `the real ${what} text was found`); return m[0] }

const MIGRATION = mig('20270718000000_order_handoff_review_chain.sql')
const GUARD = slice(mig('20261229000000_order_operations_handoff.sql'),
  /create or replace function public\.order_operations_handoffs_guard\(\)[\s\S]*?\n\$\$;/, 'handoff guard')
const NOTIFY_USERS = slice(mig('20270321000001_order_submission_notifications_complete.sql'),
  /create or replace function public\.order_notify_users\([\s\S]*?\n\$\$;/, 'order_notify_users')
const PROPOSE_DOOR = slice(mig('20270115000000_order_submission_pi_edit_revisions.sql'),
  /create or replace function public\.can_propose_order_pi_edit\(p_order_id uuid\)[\s\S]*?\n\$\$;/, 'can_propose_order_pi_edit')

const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const APPROVER = id(0xa1), APPROVER2 = id(0xa2), ADMIN = id(0xa3), SALES = id(0xb1), OPS = id(0xc1), STRANGER = id(0xd1)
const O = n => id(0x100 + n), S = n => id(0x200 + n), V = n => id(0x300 + n), H = n => id(0x400 + n)

const db = new PGlite()
let checks = 0
const check = async (name, fn) => { await fn(); checks += 1; console.log('ok -', name) }
const as = uid => db.exec(`select set_config('test.uid', '${uid ?? ''}', false)`)
const one = async (sql, params) => (await db.query(sql, params)).rows[0]
const refused = async (promise, pattern) => {
  let err = null
  try { await promise } catch (e) { err = e }
  assert.ok(err, 'the call was refused')
  assert.match(String(err.message), pattern)
}
const respond = (h, remark) => db.query(`select public.respond_order_handoff_clarification($1::uuid, $2) as r`, [h, remark])
const sendToSales = (h, c) => db.query(`select public.send_order_handoff_to_sales($1::uuid, $2) as r`, [h, c])
const forward = (h, note) => db.query(`select public.forward_order_handoff_to_operations($1::uuid, $2) as r`, [h, note])
const state = async h => one(`select status, chain_holder as holder, chain_round as round from public.order_operations_handoffs where id = $1`, [h])
const mine = async () => (await one(`select public.my_flagged_pis() as r`)).r
const mineFor = async (uid, order) => { await as(uid); return (await mine()).find(r => r.order_id === order) }
const noticesTo = async (user, order, type) => (await one(
  `select count(*)::int as n from public.notifications where user_id = $1 and entity_id = $2 ${type ? `and type = '${type}'` : ''}`, [user, order])).n
const events = async (order, type) => (await db.query(
  `select actor_id, payload from public.order_activity_log where order_id = $1 and event_type = $2 order by created_at, id`, [order, type])).rows
const flag = (h, reason = 'Cannot align: rates look low') => db.query(
  `update public.order_operations_handoffs set status = 'clarification_needed', clarification_by = $2,
          clarification_at = now(), clarification_reason = $3
    where id = $1`, [h, OPS, reason])
// order_notify_users never rings the same person twice within two minutes; in real life the hops are hours apart.
const ageNotices = () => db.exec(`update public.notifications set created_at = now() - interval '10 minutes'`)

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

  create table public.users (id uuid primary key, full_name text, role text default 'member',
    is_active boolean default true, is_deleted boolean default false);
  create table public.order_submissions (id uuid primary key, order_id uuid, status text, created_by uuid, submitted_by uuid);
  create table public.orders (id uuid primary key, display_number text, client_name text, status text default 'running',
    assigned_to uuid, requested_by uuid, source_order_submission_id uuid);
  create table public.order_pi_versions (id uuid primary key, order_id uuid, status text);
  create table public.order_operations_reviewers (duty text primary key, user_id uuid);
  create table public.order_operations_handoffs (
    id uuid primary key, order_id uuid not null references public.orders(id), pi_version_id uuid not null,
    submission_id uuid not null, version_number int not null, approved_by uuid, approved_at timestamptz not null default now(),
    assigned_to uuid, assigned_at timestamptz, unassigned_reason text,
    production_alignment_at_approval text not null default 'not_aligned', prior_handoff_status text,
    status text not null default 'awaiting',
    accepted_by uuid, accepted_at timestamptz, accepted_note text,
    acceptance_withdrawn_by uuid, acceptance_withdrawn_at timestamptz, acceptance_withdrawn_reason text,
    clarification_by uuid, clarification_at timestamptz, clarification_reason text,
    clarification_response text, clarification_responded_by uuid, clarification_responded_at timestamptz,
    superseded_at timestamptz, superseded_by_version_id uuid, created_at timestamptz not null default now());
  create table public.order_activity_log (id uuid primary key default gen_random_uuid(), order_id uuid, actor_id uuid,
    event_type text, payload jsonb, created_at timestamptz default clock_timestamp());
  create table public.notifications (id uuid primary key default gen_random_uuid(), user_id uuid, task_id uuid, entity_id uuid,
    type notification_type, title text, body text, is_push_sent boolean, created_at timestamptz default now());
  create table public.zz_grants (user_id uuid, module text, action text);
  create table public.zz_hidden (order_id uuid);

  create function public.in_test_data_cleanup() returns boolean language sql stable as $$ select false $$;
  create function public.order_notify_actor_suffix(uuid) returns text language sql stable as $$ select '' $$;
  create function public.module_entry_open(text) returns boolean language sql stable as $$ select true $$;
  create function public.can_view_order(uuid) returns boolean language sql stable
    as $$ select not exists (select 1 from public.zz_hidden h where h.order_id = $1) $$;
  create function public.can_read_order_detail(uuid) returns boolean language sql stable
    as $$ select not exists (select 1 from public.zz_hidden h where h.order_id = $1) $$;
  create function public.actor_has_permission(p_module text, p_action text) returns boolean language sql stable
    as $$ select exists (select 1 from public.zz_grants g where g.user_id = auth.uid() and g.module = p_module and g.action = p_action) $$;
  create function public.actor_has_module_permission(p_module text, p_action text) returns boolean language sql stable
    as $$ select exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin' and u.is_active)
              or public.actor_has_permission(p_module, p_action) $$;
  create function public.user_holds_permission(p_user uuid, p_module text, p_action text) returns boolean language sql stable
    as $$ select exists (select 1 from public.zz_grants g where g.user_id = p_user and g.module = p_module and g.action = p_action) $$;

  -- The OLD definitions the migration re-emits: only so its dependency check finds them.
  create function public.respond_order_handoff_clarification(uuid, text) returns jsonb language sql as $$ select '{}'::jsonb $$;
  create function public.send_order_handoff_to_sales(uuid, text) returns jsonb language sql as $$ select '{}'::jsonb $$;
  create function public.my_flagged_pis() returns jsonb language sql as $$ select '[]'::jsonb $$;

  ${NOTIFY_USERS}
  ${PROPOSE_DOOR}
  ${GUARD}
  create trigger order_operations_handoffs_guard before update or delete on public.order_operations_handoffs
    for each row execute function public.order_operations_handoffs_guard();
`)

await db.exec(`
  insert into public.users (id, full_name, role) values
    ('${APPROVER}', 'Nishant Soni', 'admin'), ('${APPROVER2}', 'Second Approver', 'member'), ('${ADMIN}', 'Other Admin', 'admin'),
    ('${SALES}', 'Ashok Choudhary', 'member'), ('${OPS}', 'Nitish Bansal', 'member'), ('${STRANGER}', 'Someone Else', 'member');
  insert into public.zz_grants values
    ('${APPROVER}', 'orders', 'approve_order'), ('${APPROVER2}', 'orders', 'approve_order'),
    ('${SALES}', 'orders', 'create');
  insert into public.order_operations_reviewers values ('pi_handoff', '${OPS}');

  insert into public.orders (id, display_number, client_name, status, assigned_to, requested_by, source_order_submission_id)
  select o, n, 'Client ' || n, case when n = '0508' then 'cancelled' else 'running' end, '${SALES}', '${SALES}', s
    from (values ('${O(1)}'::uuid, '0501', '${S(1)}'::uuid), ('${O(2)}', '0502', '${S(2)}'), ('${O(3)}', '0503', '${S(3)}'),
                 ('${O(4)}', '0504', '${S(4)}'), ('${O(5)}', '0505', '${S(5)}'), ('${O(6)}', '0506', '${S(6)}'),
                 ('${O(7)}', '0547', '${S(7)}'), ('${O(8)}', '0508', '${S(8)}')) t(o, n, s);
  insert into public.order_submissions
  select s, o, 'approved', '${SALES}', '${SALES}'
    from (values ('${S(1)}'::uuid, '${O(1)}'::uuid), ('${S(2)}', '${O(2)}'), ('${S(3)}', '${O(3)}'), ('${S(4)}', '${O(4)}'),
                 ('${S(5)}', '${O(5)}'), ('${S(6)}', '${O(6)}'), ('${S(7)}', '${O(7)}'), ('${S(8)}', '${O(8)}')) t(s, o);
  insert into public.order_pi_versions select v, o, 'approved'
    from (values ('${V(1)}'::uuid, '${O(1)}'::uuid), ('${V(2)}', '${O(2)}'), ('${V(3)}', '${O(3)}'), ('${V(4)}', '${O(4)}'),
                 ('${V(5)}', '${O(5)}'), ('${V(7)}', '${O(7)}'), ('${V(8)}', '${O(8)}')) t(v, o);
  insert into public.order_pi_versions values ('${V(6)}', '${O(6)}', 'superseded');

  -- BEFORE the migration (no chain columns yet): seven handoffs in the states production can be in.
  insert into public.order_operations_handoffs (id, order_id, pi_version_id, submission_id, version_number, approved_by, assigned_to,
      status, clarification_by, clarification_at, clarification_reason, accepted_by, accepted_at, superseded_at, created_at) values
    -- 1 flagged, then sent to Sales after the flag
    ('${H(1)}', '${O(1)}', '${V(1)}', '${S(1)}', 1, '${APPROVER}', '${OPS}', 'clarification_needed', '${OPS}', now() - interval '5 days', 'Rates low', null, null, null, now() - interval '9 days'),
    -- 2 flagged, nothing since
    ('${H(2)}', '${O(2)}', '${V(2)}', '${S(2)}', 1, '${APPROVER}', '${OPS}', 'clarification_needed', '${OPS}', now() - interval '3 days', 'Size unclear', null, null, null, now() - interval '9 days'),
    -- 3 Order 547's state: flagged, sent to Sales, answered under the OLD door (back to awaiting)
    ('${H(3)}', '${O(3)}', '${V(3)}', '${S(3)}', 1, '${APPROVER}', '${OPS}', 'awaiting', '${OPS}', now() - interval '5 days', 'Old objection', null, null, null, now() - interval '9 days'),
    -- 4 sent to Sales before Operations decided
    ('${H(4)}', '${O(4)}', '${V(4)}', '${S(4)}', 1, '${APPROVER}', '${OPS}', 'awaiting', null, null, null, null, null, null, now() - interval '3 days'),
    -- 5 accepted
    ('${H(5)}', '${O(5)}', '${V(5)}', '${S(5)}', 1, '${APPROVER}', '${OPS}', 'accepted', null, null, null, '${OPS}', now() - interval '1 day', null, now() - interval '4 days'),
    -- 6 superseded
    ('${H(6)}', '${O(6)}', '${V(6)}', '${S(6)}', 1, '${APPROVER}', '${OPS}', 'awaiting', null, null, null, null, null, now() - interval '1 day', now() - interval '6 days'),
    -- 7 plain awaiting (the Order the flow below runs on)
    ('${H(7)}', '${O(7)}', '${V(7)}', '${S(7)}', 1, '${APPROVER}', '${OPS}', 'awaiting', null, null, null, null, null, null, now() - interval '2 days'),
    -- 8 awaiting on a cancelled Order
    ('${H(8)}', '${O(8)}', '${V(8)}', '${S(8)}', 1, '${APPROVER}', '${OPS}', 'awaiting', null, null, null, null, null, null, now() - interval '2 days');
  -- (the shipped guard freezes a superseded row, so set its pointer with the guard off)
  alter table public.order_operations_handoffs disable trigger order_operations_handoffs_guard;
  update public.order_operations_handoffs set superseded_by_version_id = '${V(7)}' where id = '${H(6)}';
  alter table public.order_operations_handoffs enable trigger order_operations_handoffs_guard;

  insert into public.order_activity_log (order_id, actor_id, event_type, payload, created_at) values
    ('${O(1)}', '${OPS}', 'operations_handoff_clarification_needed', jsonb_build_object('handoff_id', '${H(1)}'), now() - interval '5 days'),
    ('${O(1)}', '${APPROVER}', 'operations_handoff_sent_to_sales', jsonb_build_object('handoff_id', '${H(1)}', 'comment', 'Please fix'), now() - interval '4 days'),
    ('${O(2)}', '${OPS}', 'operations_handoff_clarification_needed', jsonb_build_object('handoff_id', '${H(2)}'), now() - interval '3 days'),
    ('${O(3)}', '${OPS}', 'operations_handoff_clarification_needed', jsonb_build_object('handoff_id', '${H(3)}'), now() - interval '5 days'),
    ('${O(3)}', '${APPROVER}', 'operations_handoff_sent_to_sales', jsonb_build_object('handoff_id', '${H(3)}', 'comment', 'Check the modifications'), now() - interval '4 days'),
    ('${O(3)}', '${SALES}', 'operations_handoff_clarification_answered', jsonb_build_object('handoff_id', '${H(3)}', 'response', 'Revised the rates'), now() - interval '1 day'),
    ('${O(4)}', '${APPROVER}', 'operations_handoff_sent_to_sales', jsonb_build_object('handoff_id', '${H(4)}', 'comment', 'Before Ops decides'), now() - interval '1 day');
`)

// The REAL migration, executed (its own assertions run with it), then the real notify trigger it re-emitted the function of.
await db.exec(MIGRATION)
await db.exec(`create trigger order_operations_handoffs_notify after update of status on public.order_operations_handoffs
                 for each row execute function public.order_operations_handoff_notify();`)

await check('the migration applies and its own assertions pass; anon cannot call the doors, signed-in people can', async () => {
  const q = await one(`select
    has_function_privilege('anon', 'public.forward_order_handoff_to_operations(uuid, text)', 'execute') as a1,
    has_function_privilege('authenticated', 'public.forward_order_handoff_to_operations(uuid, text)', 'execute') as s1,
    has_function_privilege('authenticated', 'public.respond_order_handoff_clarification(uuid, text)', 'execute') as s2,
    has_function_privilege('authenticated', 'public.order_chain_coordinators()', 'execute') as internal`)
  assert.deepEqual(q, { a1: false, s1: true, s2: true, internal: false })
})

await check('the backfill sets each existing handoff from its history: sales / coordinator / operations / nobody', async () => {
  const rows = (await db.query(`select id, status, chain_holder as holder, chain_round as round from public.order_operations_handoffs order by id`)).rows
  const by = Object.fromEntries(rows.map(r => [r.id, r]))
  assert.equal(by[H(1)].holder, 'sales');       assert.equal(by[H(1)].round, 1)
  assert.equal(by[H(2)].holder, 'coordinator'); assert.equal(by[H(2)].round, 1)
  assert.equal(by[H(3)].holder, 'operations', 'Order 547 (answered under the old door) is with Operations'); assert.equal(by[H(3)].round, 1)
  assert.equal(by[H(4)].holder, 'sales',        'sent to Sales before Operations decided'); assert.equal(by[H(4)].round, 0)
  assert.equal(by[H(5)].holder, null,           'accepted: nobody holds it')
  assert.equal(by[H(6)].holder, null,           'superseded: nobody holds it')
  assert.equal(by[H(7)].holder, 'operations')
})

await check('a handoff created after the migration starts with Operations, round 0', async () => {
  await db.exec(`insert into public.order_operations_handoffs (id, order_id, pi_version_id, submission_id, version_number, assigned_to)
                 values ('${H(9)}', '${O(2)}', '${V(9)}', '${S(2)}', 2, '${OPS}')`)
  assert.deepEqual(await state(H(9)), { status: 'awaiting', holder: 'operations', round: 0 })
  // (the shipped guard refuses every delete; take the probe row away with the guard off)
  await db.exec(`alter table public.order_operations_handoffs disable trigger order_operations_handoffs_guard;
                 delete from public.order_operations_handoffs where id = '${H(9)}';
                 alter table public.order_operations_handoffs enable trigger order_operations_handoffs_guard;`)
})

await check('Operations flags a version: the approver holds it, one round more, and the SALESPERSON is not told', async () => {
  await flag(H(7))
  assert.deepEqual(await state(H(7)), { status: 'clarification_needed', holder: 'coordinator', round: 1 })
  assert.equal(await noticesTo(SALES, O(7)), 0, 'no direct notice to the salesperson')
  assert.equal(await noticesTo(APPROVER2, O(7), 'order_operations_review_decided'), 1, 'the other approver is told')
  assert.equal(await noticesTo(APPROVER, O(7)), 0, 'the approver of the version is told by decide_order_operations_handoff, not twice')
  assert.equal(await noticesTo(OPS, O(7)), 0)
})

await check('an ACCEPTANCE still tells the salesperson, and leaves nobody holding the version', async () => {
  await db.exec(`update public.order_operations_handoffs set status = 'accepted', accepted_by = '${OPS}', accepted_at = now() where id = '${H(8)}'`)
  assert.equal((await state(H(8))).holder, null)
  assert.equal(await noticesTo(SALES, O(8), 'order_operations_review_decided'), 1)
})

await check('the salesperson sees nothing of the flag until the approver sends it; the approver sees it, held by them', async () => {
  await as(SALES)
  assert.equal((await mine()).find(r => r.order_id === O(7)), undefined)
  const row = await mineFor(APPROVER, O(7))
  assert.equal(row.holder, 'coordinator'); assert.equal(row.mine, true); assert.equal(row.round, 1)
  assert.equal(row.reply, null)
  const admin = await mineFor(ADMIN, O(7))
  assert.ok(admin, 'an administrator without the grant still sees every flagged PI')
})

await check('the salesperson cannot reply before the approver has sent it: NOT_WITH_SALES, nothing written', async () => {
  await as(SALES)
  await refused(respond(H(7), 'I already fixed it'), /ORDER_OPERATIONS_HANDOFF_NOT_WITH_SALES/)
  assert.equal((await events(O(7), 'operations_handoff_clarification_answered')).length, 0)
})

await check('only an approver or administrator can send it to Sales; a stranger and the salesperson are refused', async () => {
  for (const who of [STRANGER, SALES]) {
    await as(who)
    await refused(sendToSales(H(7), 'Please fix'), /Only an administrator or a PI approver/)
  }
  assert.equal((await state(H(7))).holder, 'coordinator')
})

await check('the approver sends it to Sales: Sales holds it, the salesperson is told, the history has the hop', async () => {
  await as(APPROVER)
  const r = (await sendToSales(H(7), 'Check the modifications required and submit the new sheet.')).rows[0].r
  assert.equal(r.holder, 'sales')
  assert.deepEqual(await state(H(7)), { status: 'clarification_needed', holder: 'sales', round: 1 })
  assert.equal(await noticesTo(SALES, O(7), 'order_operations_review_decided'), 1)
  const ev = (await events(O(7), 'operations_handoff_sent_to_sales'))[0]
  assert.equal(ev.payload.from, 'coordinator'); assert.equal(ev.payload.round, 1)
})

await check('now the salesperson sees it, held by them; the approver sees it as a watch row (mine = false)', async () => {
  const s = await mineFor(SALES, O(7))
  assert.equal(s.holder, 'sales'); assert.equal(s.mine, true)
  const a = await mineFor(APPROVER, O(7))
  assert.equal(a.holder, 'sales'); assert.equal(a.mine, false)
})

await check('somebody who is not the PI owner or an administrator cannot reply, even while Sales holds it', async () => {
  await as(STRANGER)
  await refused(respond(H(7), 'x'), /Only the person who owns this PI, or an administrator/)
})

await check('the salesperson replies: the version stays flagged, the APPROVERS hold it and are told, Operations is NOT told', async () => {
  await ageNotices()
  await as(SALES)
  await refused(respond(H(7), '   '), /RESPONSE_REQUIRED/)
  await refused(respond(H(7), 'x'.repeat(1001)), /RESPONSE_TOO_LONG/)
  const r = (await respond(H(7), '  547-BE0005: revised the rates, round wood is fine.  ')).rows[0].r
  assert.deepEqual({ s: r.status, h: r.holder }, { s: 'clarification_needed', h: 'coordinator' })
  const h = await one(`select clarification_response as t, clarification_responded_by as by from public.order_operations_handoffs where id = $1`, [H(7)])
  assert.deepEqual(h, { t: '547-BE0005: revised the rates, round wood is fine.', by: SALES })
  assert.deepEqual(await state(H(7)), { status: 'clarification_needed', holder: 'coordinator', round: 1 })
  assert.equal(await noticesTo(APPROVER, O(7), 'order_operations_review_decided'), 1)
  assert.equal(await noticesTo(APPROVER2, O(7), 'order_operations_review_decided'), 2)
  assert.equal(await noticesTo(OPS, O(7)), 0, 'Operations hears nothing until the approver forwards')
  const ev = (await events(O(7), 'operations_handoff_clarification_answered'))[0]
  assert.equal(ev.payload.to, 'coordinator'); assert.equal(ev.payload.objection, 'Cannot align: rates look low')
})

await check('after the reply: the salesperson no longer holds it; the approver does, and sees the reply', async () => {
  await as(SALES)
  assert.equal((await mine()).find(r => r.order_id === O(7)), undefined)
  const a = await mineFor(APPROVER, O(7))
  assert.equal(a.holder, 'coordinator'); assert.equal(a.mine, true)
  assert.equal(a.reply, '547-BE0005: revised the rates, round wood is fine.'); assert.equal(a.reply_by_name, 'Ashok Choudhary')
})

await check('a second reply is refused: the version is no longer with Sales', async () => {
  await as(SALES)
  await refused(respond(H(7), 'one more thing'), /NOT_WITH_SALES/)
})

await check('only an approver or administrator can forward to Operations', async () => {
  for (const who of [STRANGER, SALES, OPS]) {
    await as(who)
    await refused(forward(H(7), 'x'), /Only an administrator or a PI approver can pass a PI on/)
  }
  assert.equal((await state(H(7))).holder, 'coordinator')
})

await check('the approver forwards the REPLY with no note: back to awaiting, with Operations, the reply travels, Operations is told', async () => {
  await as(APPROVER)
  const r = (await forward(H(7), null)).rows[0].r
  assert.deepEqual({ h: r.holder, f: r.reply_forwarded }, { h: 'operations', f: true })
  assert.deepEqual(await state(H(7)), { status: 'awaiting', holder: 'operations', round: 1 })
  assert.equal(await noticesTo(OPS, O(7), 'order_operations_review_requested'), 1)
  const ev = (await events(O(7), 'operations_handoff_returned_to_operations'))[0]
  assert.equal(ev.actor_id, APPROVER); assert.equal(ev.payload.reply_forwarded, true)
  assert.equal(ev.payload.response, '547-BE0005: revised the rates, round wood is fine.'); assert.equal(ev.payload.from, 'coordinator')
  const n = await one(`select body from public.notifications where user_id = $1 and type = 'order_operations_review_requested'`, [OPS])
  assert.match(n.body, /revised the rates/)
})

await check('a second forward is refused: it is already with Operations', async () => {
  await refused(forward(H(7), 'again'), /ALREADY_WITH_OPERATIONS/)
})

await check('Operations flags it again: a new round, the approver holds it, and the old reply is not shown as the answer', async () => {
  await flag(H(7), 'Still not aligned')
  assert.deepEqual(await state(H(7)), { status: 'clarification_needed', holder: 'coordinator', round: 2 })
  const a = await mineFor(APPROVER, O(7))
  assert.equal(a.round, 2); assert.equal(a.reply, null); assert.equal(a.reason, 'Still not aligned')
})

await check('passing it to Operations WITHOUT a Sales reply needs the approver\'s own note', async () => {
  await as(APPROVER)
  await refused(forward(H(7), '   '), /FORWARD_NOTE_REQUIRED/)
  await refused(forward(H(7), 'x'.repeat(1001)), /FORWARD_NOTE_TOO_LONG/)
  const r = (await forward(H(7), 'The rates are right; please accept.')).rows[0].r
  assert.deepEqual({ h: r.holder, f: r.reply_forwarded }, { h: 'operations', f: false })
  assert.deepEqual(await state(H(7)), { status: 'awaiting', holder: 'operations', round: 2 })
})

await check('taking it back from Sales before Operations decided: status stays awaiting, Operations holds it again', async () => {
  await as(APPROVER)
  assert.equal((await state(H(4))).holder, 'sales')
  await forward(H(4), 'Sales will not change it; please review as it is.')
  assert.deepEqual(await state(H(4)), { status: 'awaiting', holder: 'operations', round: 0 })
})

await check('Operations flags while Sales holds a version: it comes to the approver, not stays with Sales', async () => {
  await db.exec(`update public.order_operations_handoffs set chain_holder = 'sales' where id = '${H(4)}'`)
  await flag(H(4), 'Flagged while with Sales')
  assert.deepEqual(await state(H(4)), { status: 'clarification_needed', holder: 'coordinator', round: 1 })
})

await check('refused, nothing written: an accepted version, a superseded one, a cancelled Order, an unknown handoff', async () => {
  await as(APPROVER)
  const before = (await one(`select count(*)::int as n from public.order_activity_log`)).n
  await refused(forward(H(5), 'x'), /ALREADY_ACCEPTED/)
  await refused(sendToSales(H(5), 'x'), /ALREADY_ACCEPTED/)
  await refused(forward(H(6), 'x'), /SUPERSEDED/)
  await db.exec(`update public.orders set status = 'cancelled' where id = '${O(2)}'`)
  await refused(forward(H(2), 'x'), /CLOSED/)
  await db.exec(`update public.orders set status = 'running' where id = '${O(2)}'`)
  await refused(forward(id(0x999), 'x'), /NOT_FOUND/)
  assert.equal((await one(`select count(*)::int as n from public.order_activity_log`)).n, before)
})

await check('an approver who cannot open the Order is refused', async () => {
  await db.exec(`insert into public.zz_hidden values ('${O(2)}')`)
  await as(APPROVER)
  await refused(forward(H(2), 'x'), /Only an administrator or a PI approver/)
  await db.exec(`delete from public.zz_hidden`)
})

await check('the shipped guard still holds next to the new trigger: an acceptance is never reverted to awaiting', async () => {
  await refused(db.query(`update public.order_operations_handoffs set status = 'awaiting' where id = '${H(5)}'`), /ACCEPTED_IS_PERMANENT/)
  assert.equal((await state(H(5))).holder, null)
})

console.log(`all ${checks} checks passed`)
await db.close()
