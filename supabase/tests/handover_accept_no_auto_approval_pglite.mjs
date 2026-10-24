// Database regression suite for 20270417000000 (accepting a cash handover never
// approves a payment).
//
// Applies the REAL migrations 20270410000000 → … → 20270416000000 (the
// auto-approval) → 20270417000000 (its removal) on an in-memory Postgres
// (PGlite), with real copies — extracted from the migration files, never
// retyped — of the payment guards the approval path meets:
// guard_decision_status (20270120), the payment lock (20270415), the markers.
// approve_finance_payment_request is a stand-in with the real door's shape
// (verification marker + the status UPDATE); its real body needs the Order model.
// Permissions: Nishant is admin; Nitish holds finance.approve by grant; Senior
// and Ashok hold nothing.
//
// A NEGATIVE CONTROL runs first: with 20270416000000 live, Nitish's acceptance
// DOES approve the payment, so the suite can see the thing it guards against.
//
// NOT part of npm test (PGlite is not a dependency of the app). Run it with a
// directory that has @electric-sql/pglite installed:
//   node supabase/tests/handover_accept_no_auto_approval_pglite.mjs <dir with node_modules/@electric-sql/pglite>
// Expected last line: "all 8 checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node handover_accept_no_auto_approval_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
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
  ashok:   '00000000-0000-0000-0000-0000000000a1', // junior, records payments
  senior:  '00000000-0000-0000-0000-0000000000a2', // ordinary employee
  nishant: '00000000-0000-0000-0000-0000000000b2', // admin, NOT the cash custodian
  nitish:  '00000000-0000-0000-0000-0000000000c3', // cash custodian, finance.approve by grant
}
const P = {
  control: '10000000-0000-0000-0000-000000000001', // negative control under 20270416000000
  toNishant: '10000000-0000-0000-0000-000000000002',
  toNitish:  '10000000-0000-0000-0000-000000000003',
  toSenior:  '10000000-0000-0000-0000-000000000004',
  nitishOwn: '10000000-0000-0000-0000-000000000005', // recorded by Nitish himself
}

await db.exec(`
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema public to anon, authenticated, service_role;
create type notification_type as enum ('task_assigned','finance_submitted');
create table users (id uuid primary key, full_name text, is_active boolean not null default true, is_deleted boolean not null default false, role text not null default 'member');
create table finance_grants (user_id uuid, module text, action text);
create table notifications (id uuid primary key default gen_random_uuid(), user_id uuid, task_id uuid, entity_id uuid, type notification_type, title text, body text, is_push_sent boolean, is_read boolean default false, created_at timestamptz default now());
create table finance_payment_requests (id uuid primary key, request_number text, human_payment_id text, client_name text, amount numeric not null,
  payment_date date not null default current_date, payment_mode text not null, status text not null default 'pending_approval',
  submitted_by uuid not null references users(id), admin_note text, approved_by uuid, approved_at timestamptz, updated_at timestamptz default now(),
  rejected_at timestamptz, clarification_requested_at timestamptz, payment_target_type text default 'unallocated', payment_against text default 'new_order',
  order_id uuid, order_number text, deleted_at timestamptz, collected_by_user_id uuid, handed_over_to_user_id uuid,
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
-- Grants stand-in: an active admin, or a grant row (as actor_has_module_permission reads it).
create function actor_has_module_permission(p_module text, p_action text) returns boolean language sql stable as $$
  select exists (select 1 from users where id = auth.uid() and role = 'admin' and is_active)
      or exists (select 1 from finance_grants where user_id = auth.uid() and module = p_module and action = p_action) $$;
create function user_has_module_permission(uuid, text, text) returns boolean language sql stable as $$ select false $$;
create function can_read_payment_as_participant(uuid) returns boolean language sql stable as $$ select false $$;
create table order_submissions (id uuid primary key, status text not null default 'submitted');
create table orders (id uuid primary key default gen_random_uuid(), client_name text, source_order_submission_id uuid references order_submissions(id));
create table finance_payment_allocations (id uuid primary key default gen_random_uuid(), payment_request_id uuid references finance_payment_requests(id), order_submission_id uuid references order_submissions(id), status text not null default 'active');
create function actor_can_approve_order() returns boolean language sql stable as $$ select false $$;
create function can_view_order_submission(uuid) returns boolean language sql stable as $$ select false $$;
`)
await db.exec(extract(mig('20261014000000_payment_destination_display_modes_and_custody.sql'), 'payment_mode_requires_custody'))
await db.exec(extract(mig('20270318000000_custody_handed_by_outside_name.sql'), 'append_payment_custody_events_internal'))
await db.exec(extract(mig('20270321000001_order_submission_notifications_complete.sql'), 'order_notify_users'))
await db.exec(extract(mig('20260918000000_finance_payment_allocations.sql'), 'finance_payment_status_is_verified'))
await db.exec(extract(mig('20260920000000_finance_approver_can_verify_payment.sql'), 'in_finance_payment_verification'))
await db.exec(extract(mig('20261011000000_admin_payment_deletion_and_payment_id.sql'), 'in_finance_payment_deletion_finalization'))
await db.exec(extract(mig('20260705000000_protect_finalized_orders_and_payments.sql'), 'in_test_data_cleanup'))
await db.exec(extract(mig('20270120000000_order_submission_admin_decisions_ask_permissions.sql'), 'finance_payment_requests_guard_decision_status'))
await db.exec(`create trigger finance_payment_requests_guard_decision_status before insert or update on finance_payment_requests
  for each row execute function finance_payment_requests_guard_decision_status();`)
// The approval door's shape: finance.approve, the row lock, Pending only, the
// verification marker, then the status UPDATE (as 20261118000000 writes it).
await db.exec(`
create function approve_finance_payment_request(p_request_id uuid, p_admin_note text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid := auth.uid(); v_req finance_payment_requests%rowtype;
begin
  if not actor_has_module_permission('finance', 'approve') then raise exception 'Only an admin may approve a payment request' using errcode = '42501'; end if;
  select * into v_req from finance_payment_requests where id = p_request_id for update;
  if v_req.status <> 'pending_approval' then raise exception 'Only a pending payment request can be approved (% is %)', v_req.request_number, v_req.status; end if;
  perform set_config('boe.finance_payment_verification', p_request_id::text, true);
  update finance_payment_requests set status = 'approved_unlinked', approved_by = v_actor, approved_at = now(), admin_note = p_admin_note, updated_at = now() where id = p_request_id;
  perform set_config('boe.finance_payment_verification', '', true);
  return jsonb_build_object('status', 'approved_unlinked');
end $$;
`)

const pay = (id, num, by) => `('${id}','PAY-REQ-${num}','P-AA-${num}','Client ${num}',1000,'paytm','${by}')`
await db.exec(`
insert into users (id, full_name, role) values
 ('${U.ashok}','Ashok','member'),('${U.senior}','Senior','member'),('${U.nishant}','Nishant Soni','admin'),('${U.nitish}','Nitish Bansal','manager');
insert into finance_grants values ('${U.nitish}', 'finance', 'approve');
insert into finance_payment_requests (id, request_number, human_payment_id, client_name, amount, payment_mode, submitted_by) values
 ${[pay(P.control, '0001', U.ashok), pay(P.toNishant, '0002', U.ashok), pay(P.toNitish, '0003', U.ashok),
    pay(P.toSenior, '0004', U.ashok), pay(P.nitishOwn, '0005', U.senior)].join(',\n ')};
`)

for (const f of ['20270410000000_finance_handover_notification_types.sql', '20270410000100_finance_cash_handovers.sql',
                 '20270412000000_finance_handover_cash_balance.sql', '20270413000000_finance_cash_journeys.sql',
                 '20270414000000_order_submission_cash_exceptions.sql', '20270415000000_finance_payment_cash_handover_lock.sql',
                 '20270416000000_finance_accept_handover_confirms_payment.sql']) {
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
const statusOf = async p => (await q(`select status from finance_payment_requests where id = $1`, [p]))[0].status
const holder = async p => (await q(`select finance_payment_current_holder($1) as h`, [p]))[0].h
const accept = h => q(`select accept_cash_handover($1)`, [h])

// ── Negative control: 20270416000000 live, Nitish accepts → the payment is approved
await as(U.ashok)
const hc = await handOver(U.nitish, P.control)
await as(U.nitish)
await accept(hc)
assert.equal(await statusOf(P.control), 'approved_unlinked', 'the suite must be able to see an auto-approval')
ok('negative control: under 20270416000000 an acceptance by a finance.approve holder approves the payment')

// ── Apply the fix (its own assertions run here) ──────────────────────────────
await db.exec(mig('20270417000000_finance_accept_handover_no_auto_approval.sql'))
const def = (await q(`select pg_get_functiondef('public.accept_cash_handover(uuid)'::regprocedure) as d`))[0].d
assert.equal(def.includes('approve_finance_payment_request'), false)
ok('20270417000000 applies and its self-assertions pass; accept_cash_handover no longer calls the approval door')

// ── 1. Nishant (admin, not the custodian) accepts ────────────────────────────
await as(U.ashok)
const h1 = await handOver(U.nishant, P.toNishant)
await as(U.nishant)
await accept(h1)
assert.equal(await statusOf(P.toNishant), 'pending_approval')
assert.equal(await holder(P.toNishant), U.nishant)
assert.equal((await q(`select finance_payment_is_closed($1) as c`, [P.toNishant]))[0].c, false)
ok('Nishant accepts: custody moves to him, the payment stays Pending, and it is NOT with the company')

// ── 2. Nitish (custodian, finance.approve) accepts ───────────────────────────
await as(U.ashok)
const h2 = await handOver(U.nitish, P.toNitish)
await as(U.nitish)
await accept(h2)
assert.equal(await statusOf(P.toNitish), 'pending_approval')
assert.equal(await holder(P.toNitish), U.nitish)
assert.equal((await q(`select finance_payment_is_closed($1) as c`, [P.toNitish]))[0].c, true)
ok('Nitish accepts: the cash is with the company, and the payment still waits for Finance (Pending)')

// ── 3. An ordinary employee accepts ──────────────────────────────────────────
await as(U.ashok)
const h3 = await handOver(U.senior, P.toSenior)
await as(U.senior)
await accept(h3)
assert.equal(await statusOf(P.toSenior), 'pending_approval')
assert.equal(await holder(P.toSenior), U.senior)
ok('an ordinary employee accepts: custody moves, the payment stays Pending')

// ── 4. Custody steps and audit are intact ────────────────────────────────────
for (const [h, p, to] of [[h1, P.toNishant, U.nishant], [h2, P.toNitish, U.nitish], [h3, P.toSenior, U.senior]]) {
  const hdr = (await q(`select status, accepted_at from finance_cash_handovers where id = $1`, [h]))[0]
  assert.equal(hdr.status, 'accepted'); assert.ok(hdr.accepted_at)
  const ev = (await q(`select event_type from finance_cash_handover_events where handover_id = $1 order by created_at`, [h])).map(r => r.event_type)
  assert.deepEqual(ev, ['created', 'accepted'])
  const ce = await q(`select handed_by_user_id, handed_to_user_id, idempotency_key from finance_payment_custody_events where payment_request_id = $1 and activity_type = 'handed_over'`, [p])
  assert.equal(ce.length, 1); assert.equal(ce[0].handed_by_user_id, U.ashok); assert.equal(ce[0].handed_to_user_id, to)
  assert.match(ce[0].idempotency_key, /^handover:/)
  assert.equal((await q(`select count(*)::int as c from notifications where entity_id = $1 and type = 'finance_handover_accepted'`, [h]))[0].c, 1)
  assert.equal((await q(`select finance_payment_cash_lock($1)->>'reason' as r`, [p]))[0].r, 'accepted_transfer')
}
ok('each acceptance writes one custody event, closes the handover, logs it, notifies the giver, and locks the payment')

// ── 5. Duplicate and unauthorized acceptance ─────────────────────────────────
await as(U.nitish)
await rejects(() => accept(h2), 'HANDOVER_CLOSED')
await as(U.ashok)
const h5 = await handOver(U.nitish, P.nitishOwn).catch(() => null)
assert.equal(h5, null, 'Ashok does not hold P-AA-0005, so he cannot hand it over')
await as(U.senior)
const h6 = await handOver(U.nitish, P.nitishOwn)
await as(U.nishant)
await rejects(() => accept(h6), 'HANDOVER_NOT_ALLOWED')
await as(U.ashok)
await rejects(() => accept(h6), 'HANDOVER_NOT_ALLOWED')
assert.equal(await statusOf(P.nitishOwn), 'pending_approval')
ok('a second acceptance is refused, and only the named recipient may accept (an admin included)')

// ── 6. Finance approval still works, on its own, through its door ────────────
await as(U.nitish)
await q(`select approve_finance_payment_request($1, 'Proof and PI checked')`, [P.toNitish])
assert.equal(await statusOf(P.toNitish), 'approved_unlinked')
await as(U.nishant)
await q(`select approve_finance_payment_request($1, 'Checked')`, [P.toSenior])
assert.equal(await statusOf(P.toSenior), 'approved_unlinked')
await as(U.senior)
await rejects(() => q(`select approve_finance_payment_request($1, null)`, [P.toNishant]), 'Only an admin may approve')
await as(null)
await rejects(() => q(`update finance_payment_requests set amount = 1 where id = $1`, [P.toNitish]), 'PAYMENT_LOCKED_BY_CASH_HANDOVER')
ok('Finance verifies separately (Nitish or Nishant), a non-approver cannot, and the accepted payment stays locked')

console.log(`\nall ${n} checks passed`)
