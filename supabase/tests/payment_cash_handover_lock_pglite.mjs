// Database regression suite for 20270415000000 (payment cash-handover lock).
//
// Applies the REAL handover migrations 20270410000000 → 0100 → 20270412000000 →
// 20270413000000 and the new migration on an in-memory Postgres (PGlite),
// together with real copies — extracted from the migration files, never retyped
// — of the payment guards and doors the lock must live alongside:
//   freeze_deleted + delete_own_payment_request (20270226),
//   guard_decision_status (20270120), guard_approved (20260901),
//   guard_approved_delete + begin_finance_payment_deletion + deletable_by (20270331),
//   finalize_finance_payment_deletion (20270405), and the three markers.
// Stubbed: auth.uid(), permissions (by users.role), notifications, allocation
// tables, proof attachments, bank links. approve_finance_payment_request is
// emulated by its marker + its UPDATE statement (its real body needs the Order
// model). edit_payment_request is exercised through the UPDATE it issues.
//
// NOT part of npm test (PGlite is not a dependency of the app). Run it with a
// directory that has @electric-sql/pglite installed:
//   node supabase/tests/payment_cash_handover_lock_pglite.mjs <dir with node_modules/@electric-sql/pglite>
// Expected last line: "all 17 checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node payment_cash_handover_lock_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
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
        const rest = line.slice(m.index + tag.length)
        if (rest.includes(tag) && /;\s*$/.test(line)) break
      }
      continue
    }
    if (line.includes(tag) && /;\s*$/.test(line)) break
  }
  return out.join('\n')
}

const db = new PGlite()
const U = {
  junior:   '00000000-0000-0000-0000-0000000000a1',
  senior:   '00000000-0000-0000-0000-0000000000a2',
  nitish:   '00000000-0000-0000-0000-0000000000c3',
  admin:    '00000000-0000-0000-0000-0000000000d4',
  verifier: '00000000-0000-0000-0000-0000000000f6',
  manager:  '00000000-0000-0000-0000-0000000000f7',
  other:    '00000000-0000-0000-0000-0000000000e5',
}
const P = {
  open:      '10000000-0000-0000-0000-000000000001', // handover pending
  accepted:  '10000000-0000-0000-0000-000000000002', // handover accepted
  cancelled: '10000000-0000-0000-0000-000000000003', // handover cancelled, never accepted
  chain:     '10000000-0000-0000-0000-000000000004', // accepted, then a later handover cancelled
  received:  '10000000-0000-0000-0000-000000000005', // custodian received directly
  disputed:  '10000000-0000-0000-0000-000000000006', // handover disputed (still open)
  hdfc:      '10000000-0000-0000-0000-000000000007', // never tracked
  legacy:    '10000000-0000-0000-0000-000000000008', // one-sided legacy handed_over event
  verify:    '10000000-0000-0000-0000-000000000009', // accepted, then verified
  reject:    '10000000-0000-0000-0000-00000000000a', // accepted, then rejected
  clarify:   '10000000-0000-0000-0000-00000000000b', // accepted, then sent back
  testdata:  '10000000-0000-0000-0000-00000000000c', // test data, accepted
  adminDel:  '10000000-0000-0000-0000-00000000000d', // accepted, deleted by the admin claim
  plain:     '10000000-0000-0000-0000-00000000000e', // tracked, never handed over
}

await db.exec(`
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema public to anon, authenticated, service_role;
create type notification_type as enum ('task_assigned','finance_submitted');
create table users (id uuid primary key, full_name text, email text, is_active boolean not null default true, is_deleted boolean not null default false, role text not null default 'member');
create table notifications (id uuid primary key default gen_random_uuid(), user_id uuid, task_id uuid, entity_id uuid, type notification_type, title text, body text, is_push_sent boolean, is_read boolean default false, created_at timestamptz default now());
create table finance_payment_requests (
  id uuid primary key, request_number text, human_payment_id text, client_name text,
  amount numeric not null, payment_date date not null default current_date, payment_mode text not null,
  status text not null default 'pending_approval', submitted_by uuid not null references users(id),
  admin_note text, approved_by uuid, approved_at timestamptz, updated_at timestamptz default now(),
  rejected_at timestamptz, clarification_requested_at timestamptz,
  payment_target_type text default 'unallocated', payment_against text default 'new_order',
  order_id uuid, order_number text, proof_note text, sales_note text,
  deleted_at timestamptz, deleted_by uuid, is_test_data boolean not null default false,
  collected_by_user_id uuid, collected_from_text text, handed_over_to_user_id uuid, handed_over_at timestamptz, collection_handover_note text,
  received_in text, created_at timestamptz not null default now());
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
create table finance_payment_request_activity_log (id uuid primary key default gen_random_uuid(), payment_request_id uuid references finance_payment_requests(id) on delete cascade, actor_id uuid, event_type text, payload jsonb, created_at timestamptz default now());
create table finance_payment_allocations (id uuid primary key default gen_random_uuid(), payment_request_id uuid references finance_payment_requests(id), order_id uuid, order_submission_id uuid, allocated_amount numeric, status text default 'active', reversal_reason text, created_at timestamptz default now());
create table finance_payment_allocation_intents (id uuid primary key default gen_random_uuid(), payment_request_id uuid references finance_payment_requests(id) on delete cascade, status text default 'pending', cancelled_at timestamptz, cancelled_reason text);
create table payment_proof_attachments (id uuid primary key default gen_random_uuid(), payment_request_id uuid references finance_payment_requests(id) on delete cascade, storage_path text);
create table bank_line_payment_links (id uuid primary key default gen_random_uuid(), payment_id uuid references finance_payment_requests(id), unlinked_at timestamptz);
create table finance_payment_deletion_claims (
  id uuid primary key default gen_random_uuid(), claim_token uuid not null unique default gen_random_uuid(),
  payment_id uuid not null, payment_number text, payment_status text not null,
  storage_paths text[] not null default '{}', storage_removed text[] not null default '{}',
  allocation_ids uuid[] not null default '{}', claimed_by uuid, claimed_by_email text,
  claimed_at timestamptz not null default now(), finalized_at timestamptz, released_at timestamptz,
  result jsonb not null default '{}'::jsonb, human_payment_id text, amount numeric, customer_name text,
  deletion_reason text not null default '', allocation_details jsonb);
create function module_entry_open(text) returns boolean language sql as $$ select true $$;
-- Grants stand-in: admin holds everything; 'verifier' holds finance.approve; 'manager' finance.manage.
create function actor_has_module_permission(p_module text, p_level text) returns boolean language sql stable as $$
  select exists (select 1 from users where id = auth.uid() and (role = 'admin'
    or (role = 'verifier' and p_module = 'finance' and p_level = 'approve')
    or (role = 'manager'  and p_module = 'finance' and p_level in ('manage', 'view_all')))) $$;
create function user_has_module_permission(uuid, text, text) returns boolean language sql stable as $$ select false $$;
create function can_read_payment_as_participant(uuid) returns boolean language sql stable as $$ select false $$;
`)
await db.exec(extract(mig('20261014000000_payment_destination_display_modes_and_custody.sql'), 'payment_mode_requires_custody'))
await db.exec(extract(mig('20270318000000_custody_handed_by_outside_name.sql'), 'append_payment_custody_events_internal'))
await db.exec(extract(mig('20270321000001_order_submission_notifications_complete.sql'), 'order_notify_users'))
// The three markers.
await db.exec(extract(mig('20260920000000_finance_approver_can_verify_payment.sql'), 'in_finance_payment_verification'))
await db.exec(extract(mig('20261011000000_admin_payment_deletion_and_payment_id.sql'), 'in_finance_payment_deletion_finalization'))
await db.exec(extract(mig('20260705000000_protect_finalized_orders_and_payments.sql'), 'in_test_data_cleanup'))
// The existing payment guards, bound as in production.
await db.exec(extract(mig('20270226000000_payment_request_owner_soft_delete.sql'), 'finance_payment_requests_freeze_deleted'))
await db.exec(extract(mig('20270120000000_order_submission_admin_decisions_ask_permissions.sql'), 'finance_payment_requests_guard_decision_status'))
await db.exec(extract(mig('20260901000000_finance_orders_permission_enforcement.sql'), 'finance_payment_requests_guard_approved'))
await db.exec(extract(mig('20270331000000_finance_admin_may_delete_confirmed_payment.sql'), 'finance_payment_requests_guard_approved_delete'))
await db.exec(`
create trigger finance_payment_requests_a_freeze_deleted before update on finance_payment_requests for each row execute function finance_payment_requests_freeze_deleted();
create trigger finance_payment_requests_guard_decision_status before insert or update on finance_payment_requests for each row execute function finance_payment_requests_guard_decision_status();
create trigger finance_payment_requests_guard_approved before update on finance_payment_requests for each row execute function finance_payment_requests_guard_approved();
create trigger finance_payment_requests_guard_approved_delete before delete on finance_payment_requests for each row execute function finance_payment_requests_guard_approved_delete();
`)
// The doors.
await db.exec(extract(mig('20270226000000_payment_request_owner_soft_delete.sql'), 'delete_own_payment_request'))
await db.exec(extract(mig('20270331000000_finance_admin_may_delete_confirmed_payment.sql'), 'finance_payment_deletable_by'))
await db.exec(extract(mig('20270331000000_finance_admin_may_delete_confirmed_payment.sql'), 'begin_finance_payment_deletion'))
await db.exec(extract(mig('20270405000000_payment_deletion_clears_allocation_intents.sql'), 'finalize_finance_payment_deletion'))

const pay = (id, num, mode, status = 'pending_approval', extra = '') =>
  `('${id}','PAY-REQ-${num}','P-AA-${num}','Client ${num}',1000,'${mode}','${status}','${U.junior}'${extra})`
await db.exec(`
insert into users (id, full_name, email, role) values
 ('${U.junior}','Ashok','a@example.invalid','member'),('${U.senior}','Senior','s@example.invalid','member'),
 ('${U.nitish}','Nitish Bansal','n@example.invalid','member'),('${U.admin}','Admin','ad@example.invalid','admin'),
 ('${U.verifier}','Verifier','v@example.invalid','verifier'),('${U.manager}','Manager','m@example.invalid','manager'),
 ('${U.other}','Other','o@example.invalid','member');
insert into finance_payment_requests (id, request_number, human_payment_id, client_name, amount, payment_mode, status, submitted_by) values
 ${[pay(P.open,'0001','paytm'), pay(P.accepted,'0002','paytm'), pay(P.cancelled,'0003','paytm'), pay(P.chain,'0004','pnb'),
    pay(P.received,'0005','canara'), pay(P.disputed,'0006','paytm'), pay(P.hdfc,'0007','hdfc'), pay(P.legacy,'0008','paytm'),
    pay(P.verify,'0009','paytm'), pay(P.reject,'0010','paytm'), pay(P.clarify,'0011','paytm'), pay(P.testdata,'0012','paytm'),
    pay(P.adminDel,'0013','paytm'), pay(P.plain,'0014','paytm')].join(',\n ')};
update finance_payment_requests set is_test_data = true where id = '${P.testdata}';
-- A one-sided "handed over" written before 20270413 (no acceptance marker existed).
insert into finance_payment_custody_events (payment_request_id, activity_type, occurred_at, handed_by_user_id, handed_to_user_id, payment_mode_at_event, created_by, idempotency_key)
values ('${P.legacy}','handed_over', now() - interval '3 days', '${U.junior}', '${U.senior}', 'paytm', '${U.junior}', 'legacy-form-1');
`)

await db.exec(mig('20270410000000_finance_handover_notification_types.sql'))
await db.exec(mig('20270410000100_finance_cash_handovers.sql'))
await db.exec(mig('20270412000000_finance_handover_cash_balance.sql'))
await db.exec(mig('20270413000000_finance_cash_journeys.sql'))
console.log('handover migrations applied')

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
const accept = id => q(`select accept_cash_handover($1)`, [id])
const amountOf = async id => Number((await q(`select amount from finance_payment_requests where id = $1`, [id]))[0]?.amount)

// ── Build the journeys BEFORE the lock exists (as in production) ─────────────
await as(U.junior)
await handOver(U.senior, P.open) // stays pending: H-0001
const hAcc = await handOver(U.senior, P.accepted)
const hCan = await handOver(U.senior, P.cancelled)
const hChain1 = await handOver(U.senior, P.chain)
const hDisp = await handOver(U.senior, P.disputed)
const hVer = await handOver(U.nitish, P.verify)
const hRej = await handOver(U.nitish, P.reject)
const hCla = await handOver(U.nitish, P.clarify)
const hTest = await handOver(U.nitish, P.testdata)
const hDel = await handOver(U.nitish, P.adminDel)
await q(`select cancel_cash_handover($1, null)`, [hCan])
await as(U.senior); await accept(hAcc); await accept(hChain1)
await q(`select dispute_cash_handover($1, 'I never got this cash')`, [hDisp])
const hChain2 = await handOver(U.nitish, P.chain)
await q(`select cancel_cash_handover($1, null)`, [hChain2])
await as(U.nitish)
for (const h of [hVer, hRej, hCla, hTest, hDel]) await accept(h)
await q(`select receive_cash_directly($1::uuid[], null)`, [`{${P.received}}`])

// ── Apply the new migration (its own assertions run here) ────────────────────
await db.exec(mig('20270415000000_finance_payment_cash_handover_lock.sql'))
ok('20270415000000 applies on top of the handover migrations and its self-assertions pass')

// ── 1. Which payments are locked, and why ────────────────────────────────────
await as(null)
const lockOf = async id => (await q(`select finance_payment_cash_lock($1) as l`, [id]))[0].l
assert.deepEqual(await lockOf(P.open), { reason: 'open_handover', handover: 'H-0001' })
assert.equal((await lockOf(P.accepted)).reason, 'accepted_transfer')
assert.equal(await lockOf(P.cancelled), null)
assert.equal((await lockOf(P.chain)).reason, 'accepted_transfer')
assert.deepEqual(await lockOf(P.received), { reason: 'accepted_transfer', handover: null })
assert.equal((await lockOf(P.disputed)).reason, 'open_handover')
assert.equal(await lockOf(P.hdfc), null)
assert.equal(await lockOf(P.legacy), null)
assert.equal(await lockOf(P.plain), null)
ok('open (pending/disputed) and accepted transfers lock; cancelled-only, HDFC, untouched and one-sided legacy activity do not')

// ── 2. Unauthorized and ordinary writes on locked payments ───────────────────
const update = (id, set) => q(`update finance_payment_requests set ${set} where id = $1`, [id])
for (const who of [U.junior, U.admin, U.manager, null]) {
  await as(who)
  await rejects(() => update(P.accepted, 'amount = 999'), 'PAYMENT_LOCKED_BY_CASH_HANDOVER')
  await rejects(() => update(P.open, 'amount = 999'), 'PAYMENT_LOCKED_BY_CASH_HANDOVER')
}
await as(U.junior)
for (const set of ["payment_mode = 'pnb'", "payment_date = current_date - 1", "proof_note = 'x'", "sales_note = 'x'",
                   "client_name = 'Someone else'", "order_number = 'OLD-1'"]) {
  await rejects(() => update(P.accepted, set), 'PAYMENT_LOCKED_BY_CASH_HANDOVER')
}
assert.equal(await amountOf(P.accepted), 1000)
ok('amount, mode, date, notes, customer and order number are refused for the submitter, an admin, finance.manage and direct SQL')

const msgAcc = await rejects(() => update(P.accepted, 'amount = 1'), 'PAYMENT_LOCKED_BY_CASH_HANDOVER')
assert.match(msgAcc, /P-AA-0002 was handed over and accepted \(H-0002\)/)
const msgOpen = await rejects(() => update(P.open, 'amount = 1'), 'PAYMENT_LOCKED_BY_CASH_HANDOVER')
assert.match(msgOpen, /P-AA-0001 is in cash handover H-0001, which has not been accepted yet/)
ok('the refusal names the payment and the handover in plain words')

await as(U.junior)
await rejects(() => q(`select delete_own_payment_request($1)`, [P.accepted]), 'PAYMENT_LOCKED_BY_CASH_HANDOVER')
await rejects(() => q(`select delete_own_payment_request($1)`, [P.open]), 'PAYMENT_LOCKED_BY_CASH_HANDOVER')
assert.equal((await q(`select deleted_at from finance_payment_requests where id = $1`, [P.accepted]))[0].deleted_at, null)
assert.equal((await q(`select count(*)::int as c from finance_payment_request_activity_log where payment_request_id = $1`, [P.accepted]))[0].c, 0)
for (const who of [U.junior, U.admin, null]) {
  await as(who)
  await rejects(() => q(`delete from finance_payment_requests where id = $1`, [P.accepted]), 'PAYMENT_LOCKED_BY_CASH_HANDOVER')
  await rejects(() => q(`delete from finance_payment_requests where id = $1`, [P.open]), 'PAYMENT_LOCKED_BY_CASH_HANDOVER')
}
ok('the submitter cannot soft-delete (delete_own_payment_request rolls back whole) and nobody can DELETE directly')

// ── 3. Cancelled / rejected handovers ────────────────────────────────────────
await as(U.junior)
await update(P.cancelled, 'amount = 1500')
assert.equal(await amountOf(P.cancelled), 1500)
await rejects(() => update(P.chain, 'amount = 1500'), 'PAYMENT_LOCKED_BY_CASH_HANDOVER')
await rejects(() => update(P.disputed, 'amount = 1500'), 'PAYMENT_LOCKED_BY_CASH_HANDOVER')
await as(U.junior)
await q(`select cancel_cash_handover($1, null)`, [hDisp])
assert.equal(await lockOf(P.disputed), null)
await update(P.disputed, 'amount = 1200')
ok('a cancelled handover releases the lock only when nothing was ever accepted; a disputed one holds it until cancelled')

await update(P.legacy, 'amount = 1100')
await update(P.plain, 'proof_note = \'ref 123\'')
await q(`select delete_own_payment_request($1)`, [P.plain])
await as(U.admin)
await update(P.hdfc, 'amount = 2000')
ok('unlocked payments (legacy activity, never handed over, HDFC) keep today\'s edit and delete')

// ── 4. Normal Finance workflows on locked payments ───────────────────────────
// Verification: the real approve RPC marks the payment, then writes exactly these columns.
await as(U.verifier)
await q(`select set_config('boe.finance_payment_verification', $1, false)`, [P.verify])
await q(`update finance_payment_requests set status = 'approved_linked', order_id = gen_random_uuid(), order_number = 'ORD-1',
           approved_by = $2, approved_at = now(), admin_note = 'ok', updated_at = now() where id = $1`, [P.verify, U.verifier])
await as(U.admin) // guard_approved exempts admins, so the lock is what refuses here
await rejects(() => update(P.verify, 'amount = 5'), 'PAYMENT_LOCKED_BY_CASH_HANDOVER')
await as(U.verifier)
await q(`select set_config('boe.finance_payment_verification', '', false)`)
assert.equal((await q(`select status from finance_payment_requests where id = $1`, [P.verify]))[0].status, 'approved_linked')
ok('verification of a locked payment (status, approver, Order link, note) goes through; the marker never opens the amount')

await update(P.reject, `status = 'rejected', admin_note = 'Wrong customer', rejected_at = now(), updated_at = now()`)
await update(P.clarify, `status = 'needs_clarification', admin_note = 'Which PI?', clarification_requested_at = now(), updated_at = now()`)
await as(U.admin)
await update(P.clarify, `status = 'pending_approval', admin_note = null, updated_at = now()`)
ok('reject (with reason), send back and the admin status correction still work on locked payments')

await as(U.verifier)
await rejects(() => update(P.accepted, `status = 'rejected', admin_note = null`), 'PAYMENT_REJECTION_REASON_REQUIRED')
await as(U.junior)
await rejects(() => update(P.accepted, `status = 'approved_unlinked'`), 'PAYMENT_SELF_DECISION_FORBIDDEN')
await as(U.other)
await rejects(() => update(P.accepted, `status = 'approved_unlinked'`), 'Verify Payment')
ok('the existing decision guards still apply beside the lock (no reason, self/side-door verification refused)')

await as(U.admin)
await update(P.verify, `status = 'approved_unlinked', order_id = null, order_number = null`)
await rejects(() => update(P.verify, `order_number = 'ORD-9'`), 'PAYMENT_LOCKED_BY_CASH_HANDOVER')
ok('a link/unlink between the approved states moves the Order columns; a bare order-number edit does not')

// Handover journey keeps working on locked payments.
await as(U.senior)
const hFwd = await handOver(U.nitish, P.accepted)
await as(U.nitish); await accept(hFwd)
assert.equal((await lockOf(P.accepted)).reason, 'accepted_transfer')
ok('a locked payment can still be handed on and accepted')

// ── 5. The audited admin deletion ────────────────────────────────────────────
await as(U.junior)
await rejects(() => q(`select begin_finance_payment_deletion($1, 'mistake', 'P-AA-0013')`, [P.adminDel]), 'PAYMENT_DELETION_DENIED')
await as(U.admin)
await rejects(() => q(`select begin_finance_payment_deletion($1, '  ', 'P-AA-0013')`, [P.adminDel]), 'PAYMENT_DELETION_REASON_REQUIRED')
await rejects(() => q(`select begin_finance_payment_deletion($1, 'mistake', 'P-AA-9999')`, [P.adminDel]), 'PAYMENT_DELETION_ID_MISMATCH')
const claim = (await q(`select begin_finance_payment_deletion($1, 'Recorded twice by mistake', 'P-AA-0013') as c`, [P.adminDel]))[0].c
await q(`select finalize_finance_payment_deletion($1, $2)`, [P.adminDel, claim.claim_token])
assert.equal((await q(`select count(*)::int as c from finance_payment_requests where id = $1`, [P.adminDel]))[0].c, 0)
const tomb = (await q(`select deletion_reason, claimed_by, amount, human_payment_id, finalized_at from finance_payment_deletion_claims where payment_id = $1`, [P.adminDel]))[0]
assert.equal(tomb.deletion_reason, 'Recorded twice by mistake')
assert.equal(tomb.claimed_by, U.admin)
assert.equal(tomb.human_payment_id, 'P-AA-0013')
assert.ok(tomb.finalized_at)
assert.equal((await q(`select count(*)::int as c from finance_cash_handovers where id = $1`, [hDel]))[0].c, 1)
ok('an admin deletes a locked payment only through the claim (reason + typed ID); the tombstone and the handover header remain')

await as(U.admin)
await q(`select set_config('boe.payment_deletion_finalize', $1, false)`, [P.adminDel])
await rejects(() => q(`delete from finance_payment_requests where id = $1`, [P.accepted]), 'PAYMENT_LOCKED_BY_CASH_HANDOVER')
await q(`select set_config('boe.payment_deletion_finalize', '', false)`)
ok('the deletion marker for one payment does not open another')

// ── 6. Test Data Cleanup ─────────────────────────────────────────────────────
await as(null)
await q(`select set_config('boe.cleanup_context', 'test_data_cleanup', false)`)
await q(`delete from finance_payment_requests where id = $1`, [P.testdata])
await q(`select set_config('boe.cleanup_context', '', false)`)
assert.equal((await q(`select count(*)::int as c from finance_payment_requests where id = $1`, [P.testdata]))[0].c, 0)
ok('Test Data Cleanup still removes a locked test payment')

// ── 7. The read door ─────────────────────────────────────────────────────────
const locks = async ids => (await q(`select finance_payment_cash_locks($1::uuid[]) as j`, [`{${ids.join(',')}}`]))[0].j
const ids = [P.open, P.accepted, P.cancelled, P.chain, P.received, P.hdfc]
await as(U.junior)
const mine = await locks(ids)
assert.deepEqual(mine.map(x => x.payment_id).sort(), [P.open, P.accepted, P.chain, P.received].sort())
assert.equal(mine.find(x => x.payment_id === P.open).reason, 'open_handover')
await as(U.other)
assert.deepEqual(await locks(ids), [])
await as(U.manager)
assert.equal((await locks(ids)).length, 4)
await as(null)
assert.deepEqual(await locks(ids), [])
ok('finance_payment_cash_locks answers the submitter and Finance, and nobody else')

const priv = (await q(`select has_function_privilege('authenticated', 'finance_payment_cash_lock(uuid)', 'execute') as a,
                               has_function_privilege('anon', 'finance_payment_cash_locks(uuid[])', 'execute') as b,
                               has_function_privilege('authenticated', 'finance_payment_cash_locks(uuid[])', 'execute') as c`))[0]
assert.deepEqual(priv, { a: false, b: false, c: true })
ok('privileges: the lock check is internal; the read door is for signed-in users only')

console.log(`\nall ${n} checks passed`)
