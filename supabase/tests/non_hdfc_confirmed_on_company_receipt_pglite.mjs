// Database regression suite for 20270612000000 (PNB, Paytm and Canara payments are
// Confirmed only when their cash is with the company).
//
// Applies the REAL migrations 20270410000000 → 0100 → 12 → 13 → 14 → 15 → 16 → 17
// → 18 → 20270612000000 on an in-memory Postgres (PGlite), with real copies
// (extracted from the migration files, never retyped) of the payment guards the
// approval path meets. approve_finance_payment_request is a stand-in with the real
// door's shape (finance.approve check, Pending only, the verification marker, the
// status UPDATE); its real body needs the Order model. Stubbed: auth.uid(), grants,
// finance_payment_awaits_bank_match (HDFC bank rule: always "covered" here) and the
// bank-proof trigger name the migration asserts.
// Permissions: Nishant is admin, not the cash custodian; Nitish is the custodian and
// holds finance.approve; Sunil is a second custodian WITHOUT finance.approve.
//
// NOT part of npm test (PGlite is not a dependency of the app). Run it with a
// directory that has @electric-sql/pglite installed:
//   node supabase/tests/non_hdfc_confirmed_on_company_receipt_pglite.mjs <dir with node_modules/@electric-sql/pglite>
// Expected last line: "all 18 checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node non_hdfc_confirmed_on_company_receipt_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
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
create type notification_type as enum ('task_assigned','finance_submitted','finance_approved_linked','finance_approved_suspense');
create table users (id uuid primary key, full_name text, is_active boolean not null default true, is_deleted boolean not null default false, role text not null default 'member');
create table finance_grants (user_id uuid, module text, action text);
create table notifications (id uuid primary key default gen_random_uuid(), user_id uuid, task_id uuid, entity_id uuid, type notification_type, title text, body text, is_push_sent boolean, is_read boolean default false, created_at timestamptz default now());
create table finance_payment_requests (id uuid primary key, request_number text, human_payment_id text, client_name text, amount numeric not null,
  payment_date date not null default current_date, payment_mode text not null, status text not null default 'pending_approval',
  submitted_by uuid not null references users(id), admin_note text, approved_by uuid, approved_at timestamptz, updated_at timestamptz default now(),
  rejected_at timestamptz, clarification_requested_at timestamptz, payment_target_type text default 'unallocated', payment_against text default 'new_order',
  order_id uuid, order_number text, deleted_at timestamptz, collected_by_user_id uuid, handed_over_to_user_id uuid,
  created_at timestamptz not null default now(), is_test_data boolean not null default false);
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
create function user_has_module_permission(p_user uuid, p_module text, p_action text) returns boolean language sql stable as $$
  select exists (select 1 from finance_grants where user_id = p_user and module = p_module and action = p_action) $$;
-- 20270516000000 stand-ins: this suite is about PNB/Paytm/Canara, so the HDFC bank rule never waits.
create function finance_payment_awaits_bank_match(uuid, text, numeric, boolean) returns boolean language sql stable as $$ select false $$;
-- complete_payment_entry exists in production with these grants; the migration replaces its body.
create function complete_payment_entry(p_request_id uuid) returns jsonb language sql as $$ select '{}'::jsonb $$;
revoke all on function complete_payment_entry(uuid) from public, anon;
grant execute on function complete_payment_entry(uuid) to authenticated;
create function noop_bank_proof() returns trigger language plpgsql as $$ begin return new; end $$;
create trigger finance_payment_requests_require_bank_proof before update on finance_payment_requests for each row execute function noop_bank_proof();
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

const SUNIL = '00000000-0000-0000-0000-0000000000d4' // second custodian, NO finance.approve
const Q = {
  pre:          '20000000-0000-0000-0000-000000000001', // accepted by Nitish BEFORE 20270612000000
  toNitish:     '20000000-0000-0000-0000-000000000002',
  canara:       '20000000-0000-0000-0000-000000000003',
  viaNishant:   '20000000-0000-0000-0000-000000000004',
  direct:       '20000000-0000-0000-0000-000000000005',
  nitishOwn:    '20000000-0000-0000-0000-000000000006',
  nishantOwn:   '20000000-0000-0000-0000-000000000007',
  sunil:        '20000000-0000-0000-0000-000000000008',
  hdfc:         '20000000-0000-0000-0000-000000000009',
  test:         '20000000-0000-0000-0000-00000000000a',
  verifiedHdfc: '20000000-0000-0000-0000-00000000000b',
  notReceived:  '20000000-0000-0000-0000-00000000000c',
}
const pay = (id, num, mode, by, test = false) => `('${id}','PAY-REQ-${num}','P-AA-${num}','Client ${num}',1000,'${mode}','${by}',${test})`
await db.exec(`
insert into users (id, full_name, role) values
 ('${U.ashok}','Ashok','member'),('${U.senior}','Senior','member'),('${U.nishant}','Nishant Soni','admin'),
 ('${U.nitish}','Nitish Bansal','manager'),('${SUNIL}','Sunil','manager');
insert into finance_grants values ('${U.nitish}', 'finance', 'approve'),
  ('${U.nitish}', 'finance', 'verify_own_payment'), ('${U.nishant}', 'finance', 'verify_own_payment');
insert into finance_payment_requests (id, request_number, human_payment_id, client_name, amount, payment_mode, submitted_by, is_test_data) values
 ${[pay(Q.pre, '0001', 'paytm', U.ashok), pay(Q.toNitish, '0002', 'pnb', U.ashok), pay(Q.canara, '0003', 'canara', U.ashok),
    pay(Q.viaNishant, '0004', 'paytm', U.ashok), pay(Q.direct, '0005', 'pnb', U.ashok), pay(Q.nitishOwn, '0006', 'paytm', U.nitish),
    pay(Q.nishantOwn, '0007', 'paytm', U.nishant), pay(Q.sunil, '0008', 'paytm', U.ashok), pay(Q.hdfc, '0009', 'hdfc', U.ashok),
    pay(Q.test, '0010', 'pnb', U.ashok, true), pay(Q.verifiedHdfc, '0011', 'hdfc', U.ashok), pay(Q.notReceived, '0012', 'paytm', U.ashok)].join(',\n ')};
`)

// The state of production just before this migration: through 20270418000000.
for (const f of ['20270410000000_finance_handover_notification_types.sql', '20270410000100_finance_cash_handovers.sql',
                 '20270412000000_finance_handover_cash_balance.sql', '20270413000000_finance_cash_journeys.sql',
                 '20270414000000_order_submission_cash_exceptions.sql', '20270415000000_finance_payment_cash_handover_lock.sql',
                 '20270416000000_finance_accept_handover_confirms_payment.sql', '20270417000000_finance_accept_handover_no_auto_approval.sql',
                 '20270418000000_finance_handover_not_received_final.sql']) {
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
const closed = async p => (await q(`select finance_payment_is_closed($1) as c`, [p]))[0].c
const accept = h => q(`select accept_cash_handover($1)`, [h])
const approve = (p, note = 'checked') => q(`select approve_finance_payment_request($1, $2)`, [p, note])
const confirmedNotes = p => q(`select count(*)::int as c from notifications where entity_id = $1 and type in ('finance_approved_linked','finance_approved_suspense')`, [p]).then(r => r[0].c)

// ── Before: Nitish accepts under 20270418000000, as production did ───────────
await as(U.ashok)
const hPre = await handOver(U.nitish, Q.pre)
await as(U.nitish)
await accept(hPre)
assert.equal(await statusOf(Q.pre), 'pending_approval')
assert.equal(await closed(Q.pre), true)

// ── Apply 20270612000000 (its own assertions run here) ───────────────────────
await db.exec(mig('20270612000000_finance_non_hdfc_confirmed_on_company_receipt.sql'))
ok('20270612000000 applies on top of 20270410 → 20270418 and its self-assertions pass')

assert.equal(await statusOf(Q.pre), 'pending_approval')
await as(U.nitish)
await approve(Q.pre)
assert.equal(await statusOf(Q.pre), 'approved_unlinked')
ok('a payment already accepted before the migration is not bulk-confirmed at apply; Finance can verify it because its cash is with the company')

// ── 1. The custodian accepts → Confirmed in the same action ──────────────────
await as(U.ashok)
const h1 = await handOver(U.nitish, Q.toNitish)
assert.equal(await statusOf(Q.toNitish), 'pending_approval')
await as(U.nitish)
await accept(h1)
const r1 = (await q(`select status, approved_by, admin_note from finance_payment_requests where id = $1`, [Q.toNitish]))[0]
assert.equal(r1.status, 'approved_unlinked'); assert.equal(r1.approved_by, U.nitish)
assert.match(r1.admin_note, /^Confirmed when handover H-\d+ was accepted by the company$/)
assert.equal((await q(`select status from finance_cash_handovers where id = $1`, [h1]))[0].status, 'accepted')
assert.equal(await closed(Q.toNitish), true)
ok('the custodian accepts a PNB handover: the payment is Confirmed in that same action and the handover is accepted')

assert.equal(await confirmedNotes(Q.toNitish), 1)
assert.equal((await q(`select user_id from notifications where entity_id = $1 and type = 'finance_approved_suspense'`, [Q.toNitish]))[0].user_id, U.ashok)
ok('the person who recorded the payment is told it is confirmed (once)')

// ── 2. Canara has the same journey ───────────────────────────────────────────
await as(U.ashok)
const hc = await handOver(U.nitish, Q.canara)
await as(U.nitish)
await accept(hc)
assert.equal(await statusOf(Q.canara), 'approved_unlinked')
assert.equal((await q(`select count(*)::int as c from finance_payment_custody_events where payment_request_id = $1 and activity_type = 'handed_over'`, [Q.canara]))[0].c, 1)
ok('a Canara payment handed to the custodian and accepted is Confirmed, with its handover on the journey')

// ── 3. Anyone else accepting: custody moves, nothing is confirmed ────────────
await as(U.ashok)
const h3 = await handOver(U.nishant, Q.viaNishant)
await as(U.nishant)
await accept(h3)
assert.equal(await statusOf(Q.viaNishant), 'pending_approval')
assert.equal(await holder(Q.viaNishant), U.nishant)
assert.equal(await closed(Q.viaNishant), false)
assert.equal(await confirmedNotes(Q.viaNishant), 0)
ok('Nishant (admin, not the custodian) accepts: he now holds it, the payment stays Pending and no confirmation goes out')

// ── 4. The door is shut for unclosed cash, for an admin too ──────────────────
await rejects(() => approve(Q.viaNishant), 'PAYMENT_NEEDS_COMPANY_CASH')
assert.equal(await statusOf(Q.viaNishant), 'pending_approval')
ok('Finance (an admin who holds finance.approve) cannot verify a payment whose cash is not with the company')

// ── 5. A chain: Nishant hands it on to Nitish, who accepts ───────────────────
await as(U.nishant)
const h5 = await handOver(U.nitish, Q.viaNishant)
await as(U.nitish)
await accept(h5)
assert.equal(await statusOf(Q.viaNishant), 'approved_unlinked')
assert.equal((await q(`select count(*)::int as c from finance_payment_custody_events where payment_request_id = $1 and activity_type = 'handed_over'`, [Q.viaNishant]))[0].c, 2)
ok('Ashok → Nishant → Nitish: two accepted hops on the journey, Confirmed only at the second')

// ── 6. The custodian receives directly ───────────────────────────────────────
await as(U.nitish)
await q(`select receive_cash_directly($1::uuid[], 'seen at the office')`, [`{${Q.direct}}`])
assert.equal(await statusOf(Q.direct), 'approved_unlinked')
await rejects(() => q(`select receive_cash_directly($1::uuid[], null)`, [`{${Q.direct}}`]), 'HANDOVER_ALREADY_CLOSED')
ok('Receive (custodian, no handover) confirms the payment too, and a second Receive is refused')

// ── 7. Entry by a self-verifier ──────────────────────────────────────────────
await as(U.nitish)
const e1 = (await q(`select complete_payment_entry($1) as r`, [Q.nitishOwn]))[0].r
assert.equal(e1.verified_on_entry, true)
assert.equal(await statusOf(Q.nitishOwn), 'approved_unlinked')
ok('the custodian records a payment they hold: it is verified on entry (their cash is already at the company)')

await as(U.nishant)
const e2 = (await q(`select complete_payment_entry($1) as r`, [Q.nishantOwn]))[0].r
assert.equal(e2.verified_on_entry, false); assert.equal(e2.waiting_for_cash, true)
assert.equal(await statusOf(Q.nishantOwn), 'pending_approval')
ok('a self-verifier who is not the custodian records a Paytm payment: it waits for the cash instead of being verified')

// ── 8. A custodian without finance.approve ───────────────────────────────────
await as(U.nishant)
await q(`select set_finance_cash_custodians($1::uuid[])`, [`{${U.nitish},${SUNIL}}`])
await as(U.ashok)
const h8 = await handOver(SUNIL, Q.sunil)
await as(SUNIL)
await accept(h8)
assert.equal(await closed(Q.sunil), true)
assert.equal(await statusOf(Q.sunil), 'pending_approval')
assert.equal((await q(`select status from finance_cash_handovers where id = $1`, [h8]))[0].status, 'accepted')
await as(U.nitish)
await approve(Q.sunil)
assert.equal(await statusOf(Q.sunil), 'approved_unlinked')
ok('a custodian without finance.approve still receives the cash; the payment stays Pending until an approver verifies it')

// ── 9. What must not change ──────────────────────────────────────────────────
await as(U.nishant)
await approve(Q.hdfc)
assert.equal(await statusOf(Q.hdfc), 'approved_unlinked')
ok('an HDFC payment is verified as before (this rule is for PNB, Paytm and Canara only)')

await approve(Q.test)
assert.equal(await statusOf(Q.test), 'approved_unlinked')
ok('test data is exempt')

await approve(Q.verifiedHdfc)
await rejects(() => q(`update finance_payment_requests set payment_mode = 'pnb' where id = $1`, [Q.verifiedHdfc]), 'PAYMENT_EDIT_NEEDS_COMPANY_CASH')
await q(`update finance_payment_requests set payment_mode = 'hdfc_sec' where id = $1`, [Q.verifiedHdfc])
ok('a verified HDFC payment cannot be re-labelled PNB while its cash is elsewhere; an HDFC SEC edit is untouched')

await as(U.ashok)
const h10 = await handOver(U.nitish, Q.notReceived)
await as(U.nitish)
await q(`select dispute_cash_handover($1, 'not here')`, [h10])
assert.equal(await statusOf(Q.notReceived), 'pending_approval')
assert.equal(await closed(Q.notReceived), false)
await rejects(() => approve(Q.notReceived), 'PAYMENT_NEEDS_COMPANY_CASH')
ok('"Not received" confirms nothing: the payment is back with the giver and cannot be verified')

await as(null)
await rejects(() => q(`update finance_payment_requests set amount = 1 where id = $1`, [Q.toNitish]), 'PAYMENT_LOCKED_BY_CASH_HANDOVER')
ok('the payment lock still holds on a payment confirmed by acceptance')

assert.equal((await q(`select has_function_privilege('authenticated', 'public.finance_confirm_payment_on_company_receipt(uuid, text)', 'execute') as x`))[0].x, false)
assert.equal((await q(`select has_function_privilege('authenticated', 'public.accept_cash_handover(uuid)', 'execute') as x`))[0].x, true)
ok('the confirming helper is internal; the handover doors stay callable')

console.log(`\nall ${n} checks passed`)
