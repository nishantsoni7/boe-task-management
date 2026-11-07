// Database regression suite for 20270608000000 (merge a duplicate Sales payment
// request into the payment already in Confirmed Payments).
//
// Applies the REAL migration on an in-memory Postgres (PGlite), together with the REAL
// functions it relies on, extracted from their latest migrations and never retyped:
// allocate_payment_to_target_internal (20260921000000),
// allocate_payment_to_legacy_order_internal + normalize_legacy_order_no and the allocation
// transition guard (20270407000000), finance_payment_requests_freeze_deleted (20270226000000),
// finance_payment_status_is_verified + the reversal deriver (20260918000000),
// assert_bank_reconcile_door (20270329000000) and unlink_bank_line_payment (20270514000000).
// Stubbed, and said so: auth.uid(), users, permissions (a grants table), module_entry_open,
// can_view_order_submission, and the tables (only the columns these functions read).
//
// NOT part of npm test (PGlite is not an app dependency). Run:
//   node supabase/tests/payment_request_merge_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all N checks passed". MUTATE=<name> breaks the migration on purpose
// (see MUTATIONS) and the run must then FAIL.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node payment_request_merge_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const mig = f => readFileSync(`${REPO}/supabase/migrations/${f}`, 'utf8')

function extract(text, fnName) {
  const lines = text.replace(/\r/g, '').split('\n')
  const head = l => { const s = l.toLowerCase(); return s.startsWith(`create or replace function public.${fnName.toLowerCase()}(`) || s.startsWith(`create function public.${fnName.toLowerCase()}(`) }
  const start = lines.findIndex(head)
  if (start < 0) throw new Error('cannot extract ' + fnName)
  const out = []
  let tag = null
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    out.push(line)
    if (!tag) {
      const m = /(\$[a-z_]*\$)/i.exec(line)
      if (m) { tag = m[1]; if (line.slice(m.index + tag.length).includes(tag) && /;\s*$/.test(line)) break }
      continue
    }
    if (line.includes(tag) && /;\s*$/.test(line)) break
  }
  return out.join('\n')
}

// Deliberate breaks of the migration text: each must make this suite fail.
const MUTATIONS = {
  no_reconcile_door: s => s.replace("v_actor := public.assert_bank_reconcile_door();", "v_actor := auth.uid();"),
  no_approve_check: s => s.replace("if not public.actor_has_module_permission('finance', 'approve') then", "if false then"),
  no_self_check: s => s.replace("if v_req.submitted_by = v_actor\n     and not", "if false\n     and not"),
  no_pending_check: s => s.replace("if v_req.status <> 'pending_approval' then", "if false then"),
  no_verified_check: s => s.replace("if not public.finance_payment_status_is_verified(v_old.status) then", "if false then"),
  no_amount_check: s => s.replace("if v_old.amount <> v_req.amount then", "if false then"),
  no_account_check: s => s.replace("if v_old.payment_mode <> v_req.payment_mode then", "if false then"),
  no_elsewhere_check: s => s.replace("if v_old_live > 0 and not exists (", "if false and not exists ("),
  no_carry: s => s.replace("if v_old_live = 0 then\n    for v_claim", "if false then\n    for v_claim"),
  no_soft_close: s => s.replace("set deleted_at = v_now, deleted_by = v_actor", "set updated_at = v_now"),
  no_proof_move: s => s.replace("update public.payment_proof_attachments set payment_request_id = v_old.id where payment_request_id = v_req.id;", "v_files := 0;"),
  no_unlink: s => s.replace("perform public.unlink_bank_line_payment(", "perform 1 /* "),
  no_old_activity: s => s.replace("values (v_old.id, v_actor, 'request_merged_in',", "values (v_req.id, v_actor, 'request_merged_in',"),
  no_test_mismatch: s => s.replace("if v_old.is_test_data is distinct from v_req.is_test_data then", "if false then"),
  anon_may_run: s => s.replace("revoke all on function public.merge_payment_request(uuid, uuid, text) from public, anon;", "grant execute on function public.merge_payment_request(uuid, uuid, text) to anon;"),
}

const U = {
  owner:    '00000000-0000-0000-0000-0000000000a1', // finance.approve + reconcile + view_all
  reconcile:'00000000-0000-0000-0000-0000000000a2', // reconcile only
  sales:    '00000000-0000-0000-0000-0000000000b2', // sends requests, no Finance permissions
  admin:    '00000000-0000-0000-0000-0000000000d4', // role admin
  outsider: '00000000-0000-0000-0000-0000000000e5', // nothing
}

const db = new PGlite()
await db.exec(`
create role anon nologin; create role authenticated nologin;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create table users (id uuid primary key, role text not null default 'member', full_name text, team text, is_active boolean not null default true, is_deleted boolean not null default false, created_at timestamptz not null default now());
create table grants (user_id uuid, module text, action text);
create function module_entry_open(text) returns boolean language sql as $$ select true $$;
create function actor_has_module_permission(p_module text, p_action text) returns boolean language sql stable as $$
  select exists (select 1 from users u where u.id = auth.uid() and u.role = 'admin')
      or exists (select 1 from grants g where g.user_id = auth.uid() and g.module = p_module and g.action = p_action) $$;
create function user_has_module_permission(p_user uuid, p_module text, p_action text) returns boolean language sql stable as $$
  select exists (select 1 from users u where u.id = p_user and u.role = 'admin')
      or exists (select 1 from grants g where g.user_id = p_user and g.module = p_module and g.action = p_action) $$;
create function can_view_order_submission(p uuid) returns boolean language sql stable as $$ select true $$;
create function in_pi_submission_approval(p uuid) returns boolean language sql stable as $$ select false $$;

create sequence pid_seq;
create table order_submissions (
  id uuid primary key default gen_random_uuid(),
  draft_reference text not null default ('PID-' || lpad(nextval('pid_seq')::text, 5, '0')),
  status text not null, client_name text, order_id uuid, deletion_claim_token uuid);
create table orders (id uuid primary key default gen_random_uuid(), client_name text, status text not null default 'running',
  display_number text, requested_by uuid, assigned_to uuid, source_order_submission_id uuid);
create table finance_payment_requests (
  id uuid primary key default gen_random_uuid(), request_number text, human_payment_id text,
  amount numeric not null, client_name text, status text not null, payment_date date not null,
  payment_mode text not null default 'hdfc', submitted_by uuid, created_at timestamptz not null default now(),
  updated_at timestamptz, deleted_at timestamptz, deleted_by uuid, is_test_data boolean not null default false);
create table finance_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  payment_request_id uuid not null references finance_payment_requests(id),
  order_submission_id uuid references order_submissions(id), order_id uuid references orders(id),
  legacy_order_no text, legacy_client_name text,
  allocated_amount numeric not null, status text not null default 'active', origin_target_type text,
  created_by uuid, created_at timestamptz not null default clock_timestamp(),
  reversed_by uuid, reversed_at timestamptz, reversal_reason text);
create table finance_payment_allocation_intents (
  id uuid primary key default gen_random_uuid(),
  payment_request_id uuid not null references finance_payment_requests(id),
  target_type text not null,
  order_submission_id uuid references order_submissions(id), order_id uuid references orders(id),
  legacy_order_no text, legacy_client_name text,
  intended_amount numeric not null, status text not null default 'pending',
  applied_allocation_id uuid, applied_at timestamptz, cancelled_at timestamptz, cancelled_reason text, created_by uuid);
create table payment_proof_attachments (
  id uuid primary key default gen_random_uuid(),
  payment_request_id uuid not null references finance_payment_requests(id), file_name text not null);
create table bank_line_payment_links (
  id uuid primary key default gen_random_uuid(), line_id uuid not null,
  payment_id uuid not null references finance_payment_requests(id), amount numeric not null,
  linked_by uuid, linked_at timestamptz not null default now(),
  unlinked_by uuid, unlinked_at timestamptz, unlink_reason text);
create table finance_payment_request_activity_log (
  id uuid primary key default gen_random_uuid(),
  payment_request_id uuid not null references finance_payment_requests(id) on delete cascade,
  actor_id uuid, event_type text not null, payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint finance_payment_request_activity_log_event_type_check check (event_type in (
    'request_submitted','order_linked','order_unlinked','order_link_changed','order_request_linked',
    'order_request_unlinked','target_changed','status_changed','collection_details_updated',
    'cash_handover_recorded','allocation_created','allocation_reversed','allocation_moved','request_deleted')));
`)

const A = mig('20260918000000_finance_payment_allocations.sql')
await db.exec(extract(A, 'finance_payment_status_is_verified'))
await db.exec(extract(A, 'finance_payment_allocations_derive_reversal'))
await db.exec(`create trigger derive_reversal before update on finance_payment_allocations
  for each row execute function finance_payment_allocations_derive_reversal();`)
const OLD = mig('20270407000000_finance_allocate_to_old_order.sql')
await db.exec(extract(OLD, 'finance_payment_allocations_guard_transition'))
await db.exec(`create trigger guard_transition before update on finance_payment_allocations
  for each row execute function finance_payment_allocations_guard_transition();`)
await db.exec(extract(OLD, 'normalize_legacy_order_no'))
await db.exec(extract(OLD, 'allocate_payment_to_legacy_order_internal'))
await db.exec(extract(mig('20260921000000_order_submission_verified_payment_gate.sql'), 'allocate_payment_to_target_internal'))
await db.exec(extract(mig('20270226000000_payment_request_owner_soft_delete.sql'), 'finance_payment_requests_freeze_deleted'))
await db.exec(`create trigger a_freeze_deleted before update on finance_payment_requests
  for each row execute function finance_payment_requests_freeze_deleted();`)
await db.exec(extract(mig('20270329000000_finance_bank_statements.sql'), 'assert_bank_reconcile_door'))
await db.exec(extract(mig('20270514000000_finance_bank_line_review.sql'), 'unlink_bank_line_payment'))

// REHEARSE=<file>: run a rollback-only rehearsal file (the one the owner runs on the real database)
// against a pair seeded like the real one, instead of the checks below. Prints the last result.
if (process.env.REHEARSE) {
  if (process.env.SEED_PAIR !== 'no') {
    await db.exec(`
      insert into users (id, role, full_name) values ('${U.admin}', 'admin', 'Admin Person'), ('${U.sales}', 'member', 'Mohit Sharma');
      insert into finance_payment_requests (amount, status, payment_date, payment_mode, submitted_by, request_number, human_payment_id)
        values (1338565, 'approved_unlinked', '2026-11-05', 'hdfc', '${U.admin}', 'PAY-REQ-89', 'P-AA-0089'),
               (1338565, 'pending_approval', '2026-11-05', 'hdfc', '${U.sales}', 'PAY-REQ-93', 'P-AA-0093');`)
  }
  const results = await db.exec(readFileSync(process.env.REHEARSE, 'utf8'))
  console.log('REHEARSAL LAST RESULT:', JSON.stringify(results[results.length - 1].rows))
  process.exit(0)
}

// THE MIGRATION UNDER TEST, whole, including its own assertions (optionally broken on purpose).
let text = mig('20270608000000_finance_merge_duplicate_payment_request.sql').replace(/\r/g, '')
const MUTATE = process.env.MUTATE
if (MUTATE) {
  if (!MUTATIONS[MUTATE]) throw new Error('unknown mutation ' + MUTATE)
  const broken = MUTATIONS[MUTATE](text)
  if (broken === text) throw new Error('mutation ' + MUTATE + ' changed nothing')
  text = broken
}
await db.exec(text)

let checks = 0
const pass = name => { checks++; console.log('ok', checks, name) }
const as = async (user, sql, params = []) => {
  await db.exec(`select set_config('request.jwt.claim.sub', '${user ?? ''}', false)`)
  return (await db.query(sql, params)).rows
}
const refuses = async (user, sql, params, code) => {
  try { await as(user, sql, params) } catch (e) {
    assert.ok(String(e.message).includes(code), `expected ${code}, got: ${e.message}`)
    return
  }
  assert.fail(`expected ${code}, but it succeeded`)
}
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0]
const merge = (user, req, into, note = null) => as(user, `select merge_payment_request($1, $2, $3) as r`, [req, into, note]).then(r => r[0].r)

await db.exec(`
insert into users (id, role, full_name) values ('${U.owner}', 'member', 'Nishant Soni'), ('${U.reconcile}', 'member', 'Reconciler'),
  ('${U.sales}', 'member', 'Mohit Sharma'), ('${U.admin}', 'admin', 'Admin Person'), ('${U.outsider}', 'member', 'Outsider');
insert into grants values ('${U.owner}', 'finance', 'approve'), ('${U.owner}', 'finance', 'reconcile'), ('${U.owner}', 'finance', 'view_all'),
  ('${U.reconcile}', 'finance', 'reconcile');
`)
let seq = 0
const pay = async (o) => (await one(
  `insert into finance_payment_requests (amount, client_name, status, payment_date, payment_mode, submitted_by, request_number, human_payment_id, is_test_data)
   values ($1, $2, $3, $4, $5, $6, $7, $7, $8) returning id`,
  [o.amount ?? 1338565, o.client ?? null, o.status ?? 'pending_approval', '2026-11-05', o.mode ?? 'hdfc', o.by ?? U.sales, o.number ?? `P-AA-${String(100 + ++seq).padStart(4, '0')}`, o.test ?? false])).id
const legacyIntent = (payment, no, client, amount = 1338565) => db.query(
  `insert into finance_payment_allocation_intents (payment_request_id, target_type, legacy_order_no, legacy_client_name, intended_amount, created_by)
   values ($1, 'legacy_order', $2, $3, $4, $5)`, [payment, no, client, amount, U.sales])
const state = id => one(`select status, deleted_at, deleted_by from finance_payment_requests where id = $1`, [id])
const live = id => one(`select count(*)::int as n, coalesce(sum(allocated_amount), 0)::numeric as total from finance_payment_allocations where payment_request_id = $1 and status = 'active'`, [id])

// ── The screenshot case: a Suspense payment already verified, and Sales' request for it ──
const E = await pay({ status: 'approved_unlinked', by: U.owner, number: 'P-AA-0089' })
const R = await pay({ number: 'P-AA-0093' })
await legacyIntent(R, 'old-478', 'Northbliss')
await db.query(`insert into payment_proof_attachments (payment_request_id, file_name) values ($1, 'screenshot.png')`, [R])
const link = (await one(`insert into bank_line_payment_links (line_id, payment_id, amount, linked_by) values (gen_random_uuid(), $1, 100, $2) returning id`, [R, U.owner])).id

// Refusals first: each must leave the request exactly as it was.
await refuses(U.outsider, `select merge_payment_request($1, $2, null)`, [R, E], 'BANK_FORBIDDEN')
pass('someone without finance.reconcile cannot merge')
await refuses(U.reconcile, `select merge_payment_request($1, $2, null)`, [R, E], 'MERGE_FORBIDDEN')
pass('a reconciler without finance.approve cannot merge')
await refuses(U.owner, `select merge_payment_request($1, $1, null)`, [R], 'MERGE_SAME_PAYMENT')
pass('a payment cannot be merged into itself')
await refuses(U.owner, `select merge_payment_request($1, $2, $3)`, [R, E, 'x'.repeat(201)], 'MERGE_NOTE_TOO_LONG')
pass('the note is bounded')
await refuses(U.owner, `select merge_payment_request($1, gen_random_uuid(), null)`, [R], 'MERGE_NOT_FOUND')
pass('an unknown payment is refused')

const ownReq = await pay({ by: U.owner })
await refuses(U.owner, `select merge_payment_request($1, $2, null)`, [ownReq, E], 'PAYMENT_SELF_DECISION_FORBIDDEN')
pass('nobody merges the request they recorded themselves')

const verifiedReq = await pay({ status: 'approved_unlinked' })
await refuses(U.owner, `select merge_payment_request($1, $2, null)`, [verifiedReq, E], 'MERGE_REQUEST_NOT_PENDING')
pass('only a request waiting for Finance can be merged')
const cashReq = await pay({ mode: 'pnb' })
const cashOld = await pay({ mode: 'pnb', status: 'approved_unlinked' })
await refuses(U.owner, `select merge_payment_request($1, $2, null)`, [cashReq, cashOld], 'MERGE_NOT_BANK_ACCOUNT')
pass('cash payments are not merged here')
const otherAcct = await pay({ mode: 'hdfc_sec', status: 'approved_unlinked' })
await refuses(U.owner, `select merge_payment_request($1, $2, null)`, [R, otherAcct], 'MERGE_ACCOUNT_DIFFERS')
pass('the two payments must be in the same account')
const pendingOld = await pay({})
await refuses(U.owner, `select merge_payment_request($1, $2, null)`, [R, pendingOld], 'MERGE_TARGET_NOT_VERIFIED')
pass('the payment merged into must be verified')
const otherAmt = await pay({ amount: 1338000, status: 'approved_unlinked' })
await refuses(U.owner, `select merge_payment_request($1, $2, null)`, [R, otherAmt], 'MERGE_AMOUNT_DIFFERS')
pass('the amount must match to the paisa')
const testOld = await pay({ status: 'approved_unlinked', test: true })
await refuses(U.owner, `select merge_payment_request($1, $2, null)`, [R, testOld], 'MERGE_TEST_DATA_MISMATCH')
pass('a test payment and a real one are never merged')

const orderX = (await one(`insert into orders (client_name, display_number) values ('Elsewhere Ltd', '0534') returning id`)).id
const allocatedOld = await pay({ status: 'approved_unlinked' })
await db.query(`insert into finance_payment_allocations (payment_request_id, order_id, allocated_amount, origin_target_type, created_by) values ($1, $2, 1338565, 'confirmed_order', $3)`, [allocatedOld, orderX, U.owner])
await refuses(U.owner, `select merge_payment_request($1, $2, null)`, [R, allocatedOld], 'MERGE_ALLOCATED_ELSEWHERE')
pass('a payment already allocated somewhere else is not merged into')

const untouched = await state(R)
assert.equal(untouched.status, 'pending_approval'); assert.equal(untouched.deleted_at, null)
assert.equal((await one(`select count(*)::int as n from finance_payment_allocation_intents where payment_request_id = $1 and status = 'pending'`, [R])).n, 1)
assert.equal((await one(`select count(*)::int as n from bank_line_payment_links where payment_id = $1 and unlinked_at is null`, [R])).n, 1)
assert.equal((await one(`select count(*)::int as n from payment_proof_attachments where payment_request_id = $1`, [R])).n, 1)
assert.equal((await live(allocatedOld)).n, 1)
pass('every refusal left the request, its intent, its link and its file untouched')

// ── The merge ──
const done = await merge(U.owner, R, E, 'Same NEFT, entered twice')
assert.equal(done.into_human_id, 'P-AA-0089'); assert.equal(done.request_human_id, 'P-AA-0093')
assert.equal(done.allocations_applied, 1); assert.equal(done.proof_files_moved, 1); assert.equal(done.bank_links_released, 1)
assert.equal(done.submitted_by, U.sales)
pass('the merge reports what it did')

const closed = await state(R)
assert.equal(closed.status, 'pending_approval', 'closed, not rejected')
assert.ok(closed.deleted_at); assert.equal(closed.deleted_by, U.owner)
pass('the request is closed as removed, never rejected, by the person who merged')

const oldAfter = await one(`select status, amount::numeric as amount from finance_payment_requests where id = $1`, [E])
assert.equal(oldAfter.status, 'approved_unlinked'); assert.equal(Number(oldAfter.amount), 1338565)
pass('the old payment keeps its status and amount')

const onOld = await one(`select legacy_order_no, legacy_client_name, allocated_amount::numeric as amount, status, origin_target_type from finance_payment_allocations where payment_request_id = $1`, [E])
assert.equal(onOld.legacy_order_no, 'OLD-478'); assert.equal(onOld.legacy_client_name, 'Northbliss')
assert.equal(Number(onOld.amount), 1338565); assert.equal(onOld.status, 'active'); assert.equal(onOld.origin_target_type, 'legacy_order')
pass('what Sales asked for (Old order 478, Northbliss) is now on the old payment')

const intent = await one(`select status, cancelled_reason from finance_payment_allocation_intents where payment_request_id = $1`, [R])
assert.equal(intent.status, 'cancelled'); assert.equal(intent.cancelled_reason, 'merged into P-AA-0089')
pass("the request's own intent is cancelled, with the reason")

assert.equal((await one(`select count(*)::int as n from payment_proof_attachments where payment_request_id = $1`, [E])).n, 1)
assert.equal((await one(`select count(*)::int as n from payment_proof_attachments where payment_request_id = $1`, [R])).n, 0)
pass("the request's proof file moved to the old payment")

const lk = await one(`select unlinked_at, unlinked_by, unlink_reason from bank_line_payment_links where id = $1`, [link])
assert.ok(lk.unlinked_at); assert.equal(lk.unlinked_by, U.owner); assert.equal(lk.unlink_reason, 'Merged into P-AA-0089')
pass('the closed request no longer holds a bank credit')

const evOld = await one(`select actor_id, payload from finance_payment_request_activity_log where payment_request_id = $1 and event_type = 'request_merged_in'`, [E])
assert.equal(evOld.actor_id, U.owner)
assert.equal(evOld.payload.request_human_id, 'P-AA-0093'); assert.equal(evOld.payload.submitted_by_name, 'Mohit Sharma')
assert.equal(evOld.payload.merged_by_name, 'Nishant Soni'); assert.equal(evOld.payload.note, 'Same NEFT, entered twice')
assert.equal(evOld.payload.allocations_applied, 1); assert.equal(evOld.payload.proof_files_moved, 1)
pass('the old payment\'s activity says who sent the request, who merged it and why')
const evReq = await one(`select payload from finance_payment_request_activity_log where payment_request_id = $1 and event_type = 'request_merged'`, [R])
assert.equal(evReq.payload.into_human_id, 'P-AA-0089')
pass('the closed request records where it went')

await refuses(U.owner, `select merge_payment_request($1, $2, null)`, [R, E], 'MERGE_NOT_FOUND')
pass('a merged request cannot be merged again')
try { await db.query(`update finance_payment_requests set status = 'rejected' where id = $1`, [R]); assert.fail('update of a closed request should be refused') }
catch (e) { assert.ok(String(e.message).includes('PAYMENT_REQUEST_DELETED'), e.message) }
pass('a closed request is frozen: nobody can reject or reapply it')

// ── A payment recorded from the PI page carries an ALLOCATION, not an intent ──
const sub = (await one(`insert into order_submissions (status, client_name) values ('submitted', 'Sharma Interiors') returning id`)).id
const E2 = await pay({ status: 'approved_unlinked', by: U.owner, amount: 500000 })
const R2 = await pay({ amount: 500000 })
await db.query(`insert into finance_payment_allocations (payment_request_id, order_submission_id, allocated_amount, origin_target_type, created_by) values ($1, $2, 500000, 'order_submission', $3)`, [R2, sub, U.sales])
const d2 = await merge(U.admin, R2, E2)
assert.equal(d2.allocations_applied, 1)
const r2a = await one(`select status, reversal_reason from finance_payment_allocations where payment_request_id = $1`, [R2])
assert.equal(r2a.status, 'reversed'); assert.equal(r2a.reversal_reason, `merged into ${(await one(`select human_payment_id from finance_payment_requests where id = $1`, [E2])).human_payment_id}`)
const e2a = await one(`select order_submission_id, status from finance_payment_allocations where payment_request_id = $1`, [E2])
assert.equal(e2a.order_submission_id, sub); assert.equal(e2a.status, 'active')
pass('a PI-page request: its allocation is reversed and the PI now holds the old payment instead')

// ── The old payment already sits where Sales asked: nothing is added twice ──
const E3 = await pay({ status: 'approved_unlinked', by: U.owner, amount: 250000 })
const R3 = await pay({ amount: 250000 })
await db.query(`insert into finance_payment_allocations (payment_request_id, legacy_order_no, legacy_client_name, allocated_amount, origin_target_type, created_by) values ($1, 'OLD-9', 'Same Client', 250000, 'legacy_order', $2)`, [E3, U.owner])
await legacyIntent(R3, 'old-9', 'Same Client', 250000)
const d3 = await merge(U.owner, R3, E3)
assert.equal(d3.allocations_applied, 0)
assert.equal((await live(E3)).n, 1)
assert.equal((await one(`select status from finance_payment_allocation_intents where payment_request_id = $1`, [R3])).status, 'cancelled')
pass('when the old payment is already on the same target, nothing is allocated twice')

// ── A request with no destination (Suspense) merges and adds nothing ──
const E4 = await pay({ status: 'approved_unlinked', by: U.owner, amount: 99000 })
const R4 = await pay({ amount: 99000 })
const d4 = await merge(U.owner, R4, E4)
assert.equal(d4.allocations_applied, 0); assert.equal((await live(E4)).n, 0)
pass('a Suspense request merges and adds no allocation')

// ── An admin may merge a request they recorded themselves ──
const E5 = await pay({ status: 'approved_unlinked', by: U.owner, amount: 12345 })
const R5 = await pay({ amount: 12345, by: U.admin })
await merge(U.admin, R5, E5)
assert.ok((await state(R5)).deleted_at)
pass('an admin holds the authority to decide their own request')

// ── Not callable by anon ──
assert.equal((await one(`select has_function_privilege('anon', 'public.merge_payment_request(uuid, uuid, text)', 'execute') as ok`)).ok, false)
assert.equal((await one(`select has_function_privilege('authenticated', 'public.merge_payment_request(uuid, uuid, text)', 'execute') as ok`)).ok, true)
pass('only signed-in users may call the door')

console.log(`all ${checks} checks passed`)
