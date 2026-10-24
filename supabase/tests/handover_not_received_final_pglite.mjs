// Database regression suite for 20270418000000 ("Not received" is final;
// handovers carry whole payments only).
//
// Applies the REAL migrations 20270410000000 → 0100 → 20270412000000 →
// 20270413000000 → 20270414000000 → 20270415000000 → 20270416000000 →
// 20270417000000 → 20270418000000 on an in-memory Postgres (PGlite), with real
// copies (extracted from the migration files, never retyped) of the functions
// they call. Stubbed: auth.uid(), permissions (by users.role), notifications'
// table, the Order model the order-approval exception needs (two bare tables),
// and approve_finance_payment_request (20270416000000 only checks that it
// exists; since 20270417000000 nothing in the handover path calls it, and the
// stand-in raises if anything does).
//
// NOT part of npm test (PGlite is not a dependency of the app). Run it with a
// directory that has @electric-sql/pglite installed:
//   node supabase/tests/handover_not_received_final_pglite.mjs <dir with node_modules/@electric-sql/pglite>
// Expected last line: "all 14 checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node handover_not_received_final_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const mig = f => readFileSync(`${REPO}/supabase/migrations/${f}`, 'utf8')

// Extracts one CREATE OR REPLACE FUNCTION statement, whatever its dollar tag.
function extract(text, fnName) {
  const lines = text.replace(/\r/g, '').split('\n')
  const start = lines.findIndex(l => l.toLowerCase().startsWith(`create or replace function public.${fnName.toLowerCase()}(`))
  if (start < 0) throw new Error('cannot extract ' + fnName)
  const out = []
  let tag = null
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    out.push(line)
    if (!tag) {
      const m = /(\$[a-z_]*\$)/i.exec(line)
      if (m) {
        tag = m[1]
        if (line.slice(m.index + tag.length).includes(tag) && /;\s*$/.test(line)) break
      }
      continue
    }
    if (line.includes(tag) && /;\s*$/.test(line)) break
  }
  return out.join('\n')
}

const db = new PGlite()
const U = {
  junior: '00000000-0000-0000-0000-0000000000a1',
  senior: '00000000-0000-0000-0000-0000000000a2',
  nitish: '00000000-0000-0000-0000-0000000000c3',
  admin:  '00000000-0000-0000-0000-0000000000d4',
  other:  '00000000-0000-0000-0000-0000000000e5',
}
const P = {
  p1: '10000000-0000-0000-0000-000000000001', // not received, then handed to Nitish
  p2: '10000000-0000-0000-0000-000000000002', // not received: lock released
  p3: '10000000-0000-0000-0000-000000000003', // accepted earlier, later not received: stays locked
  p4: '10000000-0000-0000-0000-000000000004', // pending: still locked (Phase 1)
  p5: '10000000-0000-0000-0000-000000000005', // not received, then received directly
  p6: '10000000-0000-0000-0000-000000000006', // typed-cash attempts
}

await db.exec(`
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema public to anon, authenticated, service_role;
create type notification_type as enum ('task_assigned','finance_submitted');
create table users (id uuid primary key, full_name text, is_active boolean not null default true, is_deleted boolean not null default false, role text not null default 'member');
create table notifications (id uuid primary key default gen_random_uuid(), user_id uuid, task_id uuid, entity_id uuid, type notification_type, title text, body text, is_push_sent boolean, is_read boolean default false, created_at timestamptz default now());
create table finance_payment_requests (id uuid primary key, request_number text, human_payment_id text, client_name text, amount numeric not null,
  payment_date date not null default current_date, payment_mode text not null, status text not null default 'pending_approval',
  submitted_by uuid not null references users(id), deleted_at timestamptz, collected_by_user_id uuid, handed_over_to_user_id uuid,
  created_at timestamptz not null default now());
create table finance_payment_custody_events (
  id uuid primary key default gen_random_uuid(),
  payment_request_id uuid not null references finance_payment_requests(id) on delete cascade,
  activity_type text not null check (activity_type in ('collected','handed_over')),
  occurred_at timestamptz not null,
  collected_by_user_id uuid references users(id), handed_by_user_id uuid references users(id), handed_by_name text, handed_to_user_id uuid references users(id),
  remark text, payment_mode_at_event text not null,
  created_by uuid not null references users(id), created_at timestamptz not null default now(),
  idempotency_key text not null, is_test_data boolean not null default false);
create unique index on finance_payment_custody_events (payment_request_id, idempotency_key);
create unique index finance_payment_custody_events_natural_idx on finance_payment_custody_events (
  payment_request_id, activity_type, occurred_at,
  coalesce(collected_by_user_id, handed_by_user_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(lower(btrim(handed_by_name)), ''), coalesce(handed_to_user_id, '00000000-0000-0000-0000-000000000000'::uuid));
create function module_entry_open(text) returns boolean language sql as $$ select true $$;
-- Grants stand-in: an active admin, or a grant row. As in production, Nitish holds finance.approve.
create table finance_grants (user_id uuid, module text, action text);
create function actor_has_module_permission(p_module text, p_action text) returns boolean language sql stable as $$
  select exists (select 1 from users where id = auth.uid() and role = 'admin' and is_active)
      or exists (select 1 from finance_grants where user_id = auth.uid() and module = p_module and action = p_action) $$;
create function can_read_payment_as_participant(uuid) returns boolean language sql stable as $$ select false $$;
-- The Order model 20270414000000 needs, bare.
create table order_submissions (id uuid primary key, status text not null default 'submitted');
create table orders (id uuid primary key default gen_random_uuid(), client_name text, source_order_submission_id uuid references order_submissions(id));
create table finance_payment_allocations (id uuid primary key default gen_random_uuid(), payment_request_id uuid references finance_payment_requests(id), order_submission_id uuid references order_submissions(id), status text not null default 'active');
create function actor_can_approve_order() returns boolean language sql stable as $$ select exists (select 1 from users where id = auth.uid() and role = 'admin') $$;
create function can_view_order_submission(uuid) returns boolean language sql stable as $$ select false $$;
-- 20270416000000 requires the approval door to exist; nothing may call it from a handover.
create function approve_finance_payment_request(p_request_id uuid, p_admin_note text default null) returns jsonb
language plpgsql as $$ begin raise exception 'APPROVAL_CALLED_FROM_HANDOVER'; end $$;
`)
await db.exec(extract(mig('20261014000000_payment_destination_display_modes_and_custody.sql'), 'payment_mode_requires_custody'))
await db.exec(extract(mig('20270318000000_custody_handed_by_outside_name.sql'), 'append_payment_custody_events_internal'))
await db.exec(extract(mig('20270321000001_order_submission_notifications_complete.sql'), 'order_notify_users'))
await db.exec(extract(mig('20260918000000_finance_payment_allocations.sql'), 'finance_payment_status_is_verified'))
await db.exec(extract(mig('20260920000000_finance_approver_can_verify_payment.sql'), 'in_finance_payment_verification'))
await db.exec(extract(mig('20261011000000_admin_payment_deletion_and_payment_id.sql'), 'in_finance_payment_deletion_finalization'))
await db.exec(extract(mig('20260705000000_protect_finalized_orders_and_payments.sql'), 'in_test_data_cleanup'))

const pay = (id, num, mode) => `('${id}','PAY-REQ-${num}','P-AA-${num}','Client ${num}',1000,'${mode}','${U.junior}')`
await db.exec(`
insert into users (id, full_name, role) values
 ('${U.junior}','Ashok','member'),('${U.senior}','Senior','member'),('${U.nitish}','Nitish Bansal','manager'),
 ('${U.admin}','Admin','admin'),('${U.other}','Other','member');
insert into finance_payment_requests (id, request_number, human_payment_id, client_name, amount, payment_mode, submitted_by) values
 ${[pay(P.p1, '0001', 'paytm'), pay(P.p2, '0002', 'pnb'), pay(P.p3, '0003', 'canara'),
    pay(P.p4, '0004', 'paytm'), pay(P.p5, '0005', 'paytm'), pay(P.p6, '0006', 'paytm')].join(',\n ')};
`)

for (const f of ['20270410000000_finance_handover_notification_types.sql', '20270410000100_finance_cash_handovers.sql',
                 '20270412000000_finance_handover_cash_balance.sql', '20270413000000_finance_cash_journeys.sql',
                 '20270414000000_order_submission_cash_exceptions.sql', '20270415000000_finance_payment_cash_handover_lock.sql',
                 '20270416000000_finance_accept_handover_confirms_payment.sql', '20270417000000_finance_accept_handover_no_auto_approval.sql']) {
  await db.exec(mig(f))
}

const as = id => db.exec(`select set_config('request.jwt.claim.sub', '${id ?? ''}', false)`)
const q = async (sql, params) => (await db.query(sql, params)).rows
async function rejects(fn, code) {
  try { await fn() } catch (e) { assert.ok(String(e.message).includes(code), `expected ${code}, got: ${e.message}`); return e.message }
  assert.fail(`expected ${code} but it succeeded`)
}
let n = 0
const ok = name => console.log(`ok ${++n} - ${name}`)
let k = 0
const handOver = (to, id) => q(`select create_cash_handover($1, $2::uuid[], null, null, $3) as id`, [to, `{${id}}`, `key-${++k}`]).then(r => r[0].id)
const statusOf = async h => (await q(`select status from finance_cash_handovers where id = $1`, [h]))[0].status
const holder = async p => (await q(`select finance_payment_current_holder($1) as h`, [p]))[0].h
const lockOf = async p => (await q(`select finance_payment_cash_lock($1) as l`, [p]))[0].l
const notReceived = (h, reason = 'I never got this cash') => q(`select dispute_cash_handover($1, $2)`, [h, reason])

// Before the new migration (as in production): one accepted transfer to keep.
await as(U.junior)
const h3a = await handOver(U.senior, P.p3)
await as(U.senior)
await q(`select accept_cash_handover($1)`, [h3a])

// ── Apply the new migration (its own assertions run here) ────────────────────
await db.exec(mig('20270418000000_finance_handover_not_received_final.sql'))
ok('20270418000000 applies on top of 20270410 → 20270417 and its self-assertions pass')

// ── 1. "Not received" needs a reason and only the recipient may say it ──────
await as(U.junior)
const h1 = await handOver(U.senior, P.p1)
await rejects(() => notReceived(h1), 'HANDOVER_NOT_ALLOWED')
await as(U.other)
await rejects(() => notReceived(h1), 'HANDOVER_NOT_ALLOWED')
await as(U.senior)
await rejects(() => notReceived(h1, '  '), 'HANDOVER_REASON_REQUIRED')
await notReceived(h1, 'Ashok never gave me the cash')
assert.equal(await statusOf(h1), 'disputed')
const ev = (await q(`select event_type, note from finance_cash_handover_events where handover_id = $1 order by created_at`, [h1])).map(r => [r.event_type, r.note])
assert.deepEqual(ev.at(-1), ['disputed', 'Ashok never gave me the cash'])
const note = (await q(`select title, body from notifications where entity_id = $1 and user_id = $2 order by created_at desc limit 1`, [h1, U.junior]))[0]
assert.equal(note.title, 'Cash not received')
assert.match(note.body, /did not receive your handover .*: Ashok never gave me the cash\. The cash is still with you/)
ok('only the recipient can say "not received", with a reason; the reason is recorded and the giver is told in plain words')

// ── 2. It is final ──────────────────────────────────────────────────────────
await rejects(() => q(`select accept_cash_handover($1)`, [h1]), 'HANDOVER_CLOSED')
await rejects(() => notReceived(h1, 'again, again'), 'HANDOVER_CLOSED')
await as(U.junior)
await rejects(() => q(`select cancel_cash_handover($1, null)`, [h1]), 'HANDOVER_CLOSED')
await rejects(() => q(`select remind_cash_handover($1)`, [h1]), 'HANDOVER_CLOSED')
await as(U.admin)
await rejects(() => q(`select cancel_cash_handover($1, 'admin tidy-up')`, [h1]), 'HANDOVER_CLOSED')
await as(null)
await rejects(() => q(`update finance_cash_handovers set status = 'accepted', accepted_at = now() where id = $1`, [h1]), 'HANDOVER_TRANSITION_INVALID')
await rejects(() => q(`update finance_cash_handovers set last_reminded_at = now() where id = $1`, [h1]), 'HANDOVER_CLOSED')
ok('a not-received handover can no longer be accepted, re-answered, cancelled, reminded, or moved by direct SQL')

// ── 3. Custody never moved: the giver holds it and can hand it over again ───
assert.equal(await holder(P.p1), U.junior)
await as(U.junior)
const st = (await q(`select finance_payment_custody_status($1::uuid[]) as j`, [`{${P.p1}}`]))[0].j[0]
assert.equal(st.state, 'with_holder')
assert.equal(st.open_handover, null)
assert.equal(st.can_hand_over, true)
const mine = (await q(`select finance_my_handoverable_payments() as j`))[0].j
assert.ok(JSON.stringify(mine).includes(P.p1), 'the payment is offered for a new handover')
const h1b = await handOver(U.nitish, P.p1)
await as(U.nitish)
await q(`select accept_cash_handover($1)`, [h1b])
assert.equal(await holder(P.p1), U.nitish)
assert.equal((await q(`select finance_payment_is_closed($1) as c`, [P.p1]))[0].c, true)
assert.equal((await q(`select status from finance_payment_requests where id = $1`, [P.p1]))[0].status, 'pending_approval', 'Nitish (finance.approve) accepting approves nothing')
ok('the cash stays with the giver, who hands it over again at once (no Cancel needed); Nitish then accepts, and the payment stays Pending')

// ── 4. The list and the banner treat it as closed ────────────────────────────
await as(U.senior)
const list = (await q(`select finance_handover_list(null, true, 50, 0, $1) as j`, [h1]))[0].j
assert.equal(list.length, 1)
assert.equal(list[0].status, 'disputed')
assert.equal(list[0].dispute_reason, 'Ashok never gave me the cash')
for (const flag of ['can_accept', 'can_dispute', 'can_cancel', 'can_remind']) assert.equal(list[0][flag], false, flag)
await as(U.junior)
const open = (await q(`select finance_handover_list(array['pending'], true, 50, 0, null) as j`))[0].j
assert.equal(open.some(h => h.id === h1), false)
ok('finance_handover_list: no action flags on a not-received handover, and it is not among the open ones')

// ── 5. The Phase 1 lock follows ──────────────────────────────────────────────
await as(U.junior)
const h2 = await handOver(U.senior, P.p2)
assert.equal((await lockOf(P.p2)).reason, 'open_handover')
await as(U.senior)
await notReceived(h2)
assert.equal(await lockOf(P.p2), null)
const h3b = await handOver(U.nitish, P.p3)
await as(U.nitish)
await notReceived(h3b)
assert.equal((await lockOf(P.p3)).reason, 'accepted_transfer')
assert.equal(await holder(P.p3), U.senior)
await as(U.junior)
await handOver(U.senior, P.p4)
assert.equal((await lockOf(P.p4)).reason, 'open_handover')
ok('"not received" releases a pending lock; an earlier accepted transfer keeps it; a pending handover still locks')

// ── 6. Receiving directly leaves a not-received handover as it was ───────────
const h5 = await handOver(U.senior, P.p5)
await as(U.senior)
await notReceived(h5)
await as(U.nitish)
assert.equal((await q(`select receive_cash_directly($1::uuid[], 'brought to the office') as c`, [`{${P.p5}}`]))[0].c, 1)
assert.equal(await statusOf(h5), 'disputed')
assert.equal(await holder(P.p5), U.nitish)
ok('Nitish can still receive the cash directly; the not-received handover keeps its answer')

// ── 7. Whole payments only ───────────────────────────────────────────────────
await as(U.junior)
await rejects(() => q(`select create_cash_handover($1, $2::uuid[], null, null, 'tc-1', 100, 0, null)`, [U.senior, `{${P.p6}}`]), 'HANDOVER_FULL_PAYMENTS_ONLY')
await rejects(() => q(`select create_cash_handover($1, '{}'::uuid[], null, null, 'tc-2', 0, 500, 'loose cash from the stall')`, [U.senior]), 'HANDOVER_FULL_PAYMENTS_ONLY')
await rejects(() => q(`select create_cash_handover($1, '{}'::uuid[], null, null, 'tc-3', 0, 0, null)`, [U.senior]), 'choose at least one payment')
const h6 = (await q(`select create_cash_handover($1, $2::uuid[], null, null, 'tc-4', 0, 0, null) as id`, [U.senior, `{${P.p6}}`]))[0].id
const h6row = (await q(`select total_amount, cash_from_hand, cash_new from finance_cash_handovers where id = $1`, [h6]))[0]
assert.deepEqual([Number(h6row.total_amount), Number(h6row.cash_from_hand), Number(h6row.cash_new)], [1000, 0, 0])
ok('a typed cash amount is refused (from hand or new); a handover of whole payments still works with every call shape')

// ── 8. The daily sweep reminds only pending handovers ────────────────────────
await as(null)
await db.exec(`
insert into finance_cash_handovers (giver_user_id, recipient_user_id, total_amount, handed_at, status, disputed_at, dispute_reason, created_by, created_at, idempotency_key)
values ('${U.junior}', '${U.senior}', 10, now() - interval '3 days', 'disputed', now() - interval '2 days', 'never came', '${U.junior}', now() - interval '3 days', 'old-disputed'),
       ('${U.junior}', '${U.senior}', 20, now() - interval '3 days', 'pending', null, null, '${U.junior}', now() - interval '3 days', 'old-pending');
`)
const swept = (await q(`select finance_handover_send_reminders() as c`))[0].c
const reminded = (await q(`select h.idempotency_key from finance_cash_handover_events e join finance_cash_handovers h on h.id = e.handover_id where e.event_type = 'reminded'`)).map(r => r.idempotency_key)
assert.ok(reminded.includes('old-pending'))
assert.equal(reminded.includes('old-disputed'), false)
assert.ok(swept >= 1)
ok('the daily reminder sweep skips not-received handovers')

// ── 9. Nothing reserved by a closed handover; nothing else moved ─────────────
assert.equal(Number((await q(`select finance_cash_reserved($1) as r`, [U.junior]))[0].r), 0)
const priv = (await q(`select has_function_privilege('anon', 'dispute_cash_handover(uuid, text)', 'execute') as a,
                               has_function_privilege('authenticated', 'dispute_cash_handover(uuid, text)', 'execute') as b,
                               has_function_privilege('authenticated', 'finance_cash_payment_state(uuid, uuid)', 'execute') as c`))[0]
assert.deepEqual(priv, { a: false, b: true, c: false })
ok('a closed handover reserves no cash; privileges are exactly as before')

// ── 10. The order-approval check sees the cash back with the giver ───────────
await db.exec(`
insert into order_submissions (id) values ('30000000-0000-0000-0000-000000000001');
insert into finance_payment_allocations (payment_request_id, order_submission_id) values ('${P.p2}', '30000000-0000-0000-0000-000000000001');
update finance_payment_requests set status = 'approved_unlinked' where id = '${P.p2}';
`)
await as(U.admin)
const chk = (await q(`select order_submission_cash_check('30000000-0000-0000-0000-000000000001') as j`))[0].j
assert.equal(chk.uncovered.length, 1)
assert.equal(chk.uncovered[0].state, 'with_holder')
assert.equal(chk.uncovered[0].holder_name, 'Ashok')
ok('the order-approval cash check lists not-received cash as still with the giver')

// ── 11. Whole amounts, one answer, and acceptance never approves ─────────────
const P7 = '10000000-0000-0000-0000-000000000007'
const P8 = '10000000-0000-0000-0000-000000000008'
await db.exec(`insert into finance_payment_requests (id, request_number, human_payment_id, client_name, amount, payment_mode, submitted_by) values
  ('${P7}','PAY-REQ-0007','P-AA-0007','Client 7',1234.56,'paytm','${U.junior}'),
  ('${P8}','PAY-REQ-0008','P-AA-0008','Client 8',750,'canara','${U.junior}')`)
await as(U.junior)
const h7 = (await q(`select create_cash_handover($1, $2::uuid[], null, null, 'whole-1') as id`, [U.admin, `{${P7},${P8}}`]))[0].id
const items = await q(`select i.amount, f.amount as paid from finance_cash_handover_items i join finance_payment_requests f on f.id = i.payment_request_id where i.handover_id = $1`, [h7])
assert.equal(items.length, 2)
for (const it of items) assert.equal(Number(it.amount), Number(it.paid), 'each item carries its whole payment')
assert.equal(Number((await q(`select total_amount from finance_cash_handovers where id = $1`, [h7]))[0].total_amount), 1984.56)
const acceptArgs = (await q(`select pronargs from pg_proc where proname = 'accept_cash_handover'`)).map(r => r.pronargs)
assert.deepEqual(acceptArgs, [1], 'accept takes only the handover: there is no partial amount to give')
await as(U.admin)
await q(`select accept_cash_handover($1)`, [h7])
for (const p of [P7, P8]) {
  assert.equal(await holder(p), U.admin)
  assert.equal((await q(`select status from finance_payment_requests where id = $1`, [p]))[0].status, 'pending_approval')
}
await rejects(() => q(`select accept_cash_handover($1)`, [h7]), 'HANDOVER_CLOSED')
await rejects(() => notReceived(h7, 'changed my mind'), 'HANDOVER_CLOSED')
ok('a handover carries whole payments (total = their sum); accepting takes all of it once, and an admin accepting approves nothing')

// ── 12. The amount cannot drift while a handover is open; after "not received" it can be corrected and handed over whole
const P9 = '10000000-0000-0000-0000-000000000009'
await db.exec(`insert into finance_payment_requests (id, request_number, human_payment_id, client_name, amount, payment_mode, submitted_by) values
  ('${P9}','PAY-REQ-0009','P-AA-0009','Client 9',500,'pnb','${U.junior}')`)
await as(U.junior)
const h9 = await handOver(U.senior, P9)
await rejects(() => q(`update finance_payment_requests set amount = 450 where id = $1`, [P9]), 'PAYMENT_LOCKED_BY_CASH_HANDOVER')
await as(U.senior)
await notReceived(h9, 'Only 450 was given, not 500')
await as(U.junior)
await q(`update finance_payment_requests set amount = 450 where id = $1`, [P9])
const h9b = await handOver(U.senior, P9)
assert.equal(Number((await q(`select total_amount from finance_cash_handovers where id = $1`, [h9b]))[0].total_amount), 450)
await rejects(() => q(`update finance_payment_requests set amount = 400 where id = $1`, [P9]), 'PAYMENT_LOCKED_BY_CASH_HANDOVER')
await rejects(() => q(`delete from finance_payment_requests where id = $1`, [P9]), 'PAYMENT_LOCKED_BY_CASH_HANDOVER')
assert.equal(Number((await q(`select total_amount from finance_cash_handovers where id = $1`, [h9]))[0].total_amount), 500)
ok('an open handover freezes the amount; after "not received" it is corrected and handed over again in full (locked again), and the old handover keeps 500')

// ── 13. Retry keeps every answer in the record ───────────────────────────────
await as(U.admin)
const journey = (await q(`select finance_payment_journey($1) as j`, [P.p1]))[0].j
const kinds = journey.steps.map(s => s.kind)
assert.ok(kinds.indexOf('handover_disputed') >= 0, 'the "not received" answer is in the journey')
assert.ok(kinds.lastIndexOf('handover_accepted') > kinds.indexOf('handover_disputed'), 'the later acceptance follows it')
const both = (await q(`select h.status, h.dispute_reason from finance_cash_handovers h join finance_cash_handover_items i on i.handover_id = h.id where i.payment_request_id = $1 order by h.created_at`, [P.p1]))
assert.deepEqual(both.map(r => r.status), ['disputed', 'accepted'])
assert.equal(both[0].dispute_reason, 'Ashok never gave me the cash')
ok('after a retry both handovers stay on record: the refusal with its reason, then the acceptance')

console.log(`\nall ${n} checks passed`)
