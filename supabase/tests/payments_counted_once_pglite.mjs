// Database regression suite for 20270505000000 (Payments counted once, Step 1:
// a closed PI gives its money back; Add payment can use money already received).
//
// Applies the REAL migration on an in-memory Postgres (PGlite), together with the
// REAL functions it relies on, extracted from their latest migrations and never
// retyped: allocate_payment_to_target_internal (20260921000000),
// finance_payment_allocations_derive_reversal (20260918000000),
// finance_payment_allocations_guard_transition (20270407000000),
// assert_finance_payment_door (20261219000000) and
// finance_payment_status_is_verified (20260918000000).
// Stubbed, and said so: auth.uid(), users, permissions (a grants table),
// assert_order_submission_actor, actor_can_approve_order, can_view_order_submission,
// in_pi_submission_approval, log_order_submission_activity, and the tables (only the
// columns these functions read).
//
// NOT part of npm test (PGlite is not an app dependency). Run:
//   node supabase/tests/payments_counted_once_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all 21 checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node payments_counted_once_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const mig = f => readFileSync(`${REPO}/supabase/migrations/${f}`, 'utf8')

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
      if (m) { tag = m[1]; if (line.slice(m.index + tag.length).includes(tag) && /;\s*$/.test(line)) break }
      continue
    }
    if (line.includes(tag) && /;\s*$/.test(line)) break
  }
  return out.join('\n')
}

const U = {
  approver: '00000000-0000-0000-0000-0000000000a1', // may approve orders
  sales:    '00000000-0000-0000-0000-0000000000b2', // submitted the PIs, no Finance permissions
  finance:  '00000000-0000-0000-0000-0000000000c3', // finance.allocate + view_all
  outsider: '00000000-0000-0000-0000-0000000000e5', // nothing
}

const db = new PGlite()
await db.exec(`
create role anon nologin; create role authenticated nologin;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create table users (id uuid primary key, role text not null default 'member', team text, is_active boolean not null default true, is_deleted boolean not null default false);
create table grants (user_id uuid, module text, action text);
create function module_entry_open(text) returns boolean language sql as $$ select true $$;
create function actor_has_module_permission(p_module text, p_action text) returns boolean language sql stable as $$
  select exists (select 1 from grants g where g.user_id = auth.uid() and g.module = p_module and g.action = p_action) $$;
create function actor_can_approve_order() returns boolean language sql stable as $$ select actor_has_module_permission('orders', 'approve_order') $$;
create function assert_order_submission_actor() returns uuid language plpgsql as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  return auth.uid();
end $$;
create function can_view_order_submission(p uuid) returns boolean language sql stable as $$ select true $$;
create function in_pi_submission_approval(p uuid) returns boolean language sql stable as $$ select false $$;

create sequence pid_seq;
create table order_submissions (
  id uuid primary key default gen_random_uuid(),
  draft_reference text not null default ('PID-' || lpad(nextval('pid_seq')::text, 5, '0')),
  status text not null, client_name text, order_id uuid,
  submitted_by uuid, created_by uuid, assigned_to uuid, deletion_claim_token uuid,
  rejected_by uuid, rejected_at timestamptz, review_note text);
create table orders (id uuid primary key default gen_random_uuid(), client_name text, status text not null default 'running',
  display_number text, requested_by uuid, assigned_to uuid, source_order_submission_id uuid);
create table finance_payment_requests (
  id uuid primary key default gen_random_uuid(), request_number text, human_payment_id text,
  amount numeric not null, client_name text, status text not null, payment_date date not null,
  payment_mode text not null default 'hdfc', deleted_at timestamptz);
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
  order_submission_id uuid references order_submissions(id), order_id uuid references orders(id),
  intended_amount numeric not null, status text not null default 'pending',
  cancelled_at timestamptz, cancelled_reason text);
create table activity (submission_id uuid, actor uuid, action text, note text, payload jsonb);
create function log_order_submission_activity(p_sub uuid, p_actor uuid, p_action text, p_from text, p_to text, p_note text, p_payload jsonb)
returns void language sql as $$ insert into activity values (p_sub, p_actor, p_action, p_note, p_payload) $$;
`)

const A = mig('20260918000000_finance_payment_allocations.sql')
await db.exec(extract(A, 'finance_payment_status_is_verified'))
await db.exec(extract(A, 'finance_payment_allocations_derive_reversal'))
await db.exec(`create trigger derive_reversal before update on finance_payment_allocations
  for each row execute function finance_payment_allocations_derive_reversal();`)
await db.exec(extract(mig('20270407000000_finance_allocate_to_old_order.sql'), 'finance_payment_allocations_guard_transition'))
await db.exec(`create trigger guard_transition before update on finance_payment_allocations
  for each row execute function finance_payment_allocations_guard_transition();`)
await db.exec(extract(mig('20260921000000_order_submission_verified_payment_gate.sql'), 'allocate_payment_to_target_internal'))
await db.exec(extract(mig('20261219000000_order_submission_unsaved_drafts_and_payment_idempotency.sql'), 'assert_finance_payment_door'))

// THE MIGRATION UNDER TEST, whole, including its own assertions.
await db.exec(mig('20270505000000_order_submission_close_returns_payments.sql'))

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

await db.exec(`
insert into users (id, role) values ('${U.approver}', 'member'), ('${U.sales}', 'member'), ('${U.finance}', 'member'), ('${U.outsider}', 'member');
insert into grants values ('${U.approver}', 'orders', 'approve_order'), ('${U.finance}', 'finance', 'allocate'), ('${U.finance}', 'finance', 'view_all');
`)
const pi = async (status, client) => (await one(
  `insert into order_submissions (status, client_name, submitted_by, created_by) values ($1, $2, $3, $3) returning id, draft_reference`,
  [status, client, U.sales]))
const pay = async (amount, client, status, date, number) => (await one(
  `insert into finance_payment_requests (amount, client_name, status, payment_date, request_number, human_payment_id)
   values ($1, $2, $3, $4, $5, $5) returning id`, [amount, client, status, date, number])).id
const alloc = async (payment, sub, amount) => db.query(
  `insert into finance_payment_allocations (payment_request_id, order_submission_id, allocated_amount, origin_target_type, created_by)
   values ($1, $2, $3, 'order_submission', $4)`, [payment, sub, amount, U.sales])

// ── Closing a PI gives its money back ──────────────────────────────────────
const piA = await pi('submitted', 'Sharma Interiors')                         // PID-00001
const p1 = await pay(50000, 'Sharma Interiors', 'approved_linked', '2026-10-12', 'P-AB-0123')
await alloc(p1, piA.id, 50000)
const p2 = await pay(20000, 'Sharma Interiors', 'pending_approval', '2026-10-13', 'P-AB-0124')
await db.query(`insert into finance_payment_allocation_intents (payment_request_id, order_submission_id, intended_amount) values ($1, $2, 20000)`, [p2, piA.id])

await refuses(U.sales, `select reject_order_submission($1, 'wrong prices')`, [piA.id], 'permission to review')
pass('only an approver may close a PI')
await refuses(U.approver, `select reject_order_submission($1, '   ')`, [piA.id], 'ORDER_SUBMISSION_REASON_REQUIRED')
pass('a reason is required to close a PI')

const closed = (await as(U.approver, `select reject_order_submission($1, 'Client went elsewhere') as r`, [piA.id]))[0].r
assert.equal(closed.status, 'rejected'); assert.equal(closed.payments_released, 1)
const relA = await one(`select status, reversal_reason, reversed_by from finance_payment_allocations where payment_request_id = $1`, [p1])
assert.equal(relA.status, 'reversed')
assert.equal(relA.reversal_reason, 'PID-00001 was closed (deal lost): Client went elsewhere')
assert.equal(relA.reversed_by, U.approver)
pass('closing reverses the PI\'s allocations with the reason, attributed to the approver')
assert.equal((await one(`select status from finance_payment_requests where id = $1`, [p1])).status, 'approved_linked')
pass('the payment itself is untouched: it stays verified')
const intentA = await one(`select status, cancelled_reason from finance_payment_allocation_intents where payment_request_id = $1`, [p2])
assert.equal(intentA.status, 'cancelled'); assert.match(intentA.cancelled_reason, /PID-00001 was closed/)
pass('closing cancels pending intents on the PI')
const act = await one(`select payload from activity where submission_id = $1 and action = 'rejected'`, [piA.id])
assert.equal(act.payload.payments_released, 1); assert.equal(Number(act.payload.amount_released), 50000)
pass('the PI history records how much was released')

// ── Money already received from this client ──────────────────────────────
const piB = await pi('draft', 'SHARMA  interiors.')                          // PID-00002, same client spelt differently
const search = (user, sub, amount, date) => as(user, `select client_available_payments($1, null, $2, $3) as r`, [sub, amount, date]).then(r => r[0].r)

const found = await search(U.sales, piB.id, 50000, '2026-10-21')
assert.equal(found.length, 1)
assert.equal(found[0].payment_number, 'P-AB-0123'); assert.equal(Number(found[0].available), 50000)
assert.equal(found[0].verified, true); assert.equal(found[0].closed_pi_reference, 'PID-00001')
pass('the search finds the closed PI\'s money for the same client, spelt differently')
assert.deepEqual(await search(U.sales, piB.id, 49999, '2026-10-21'), [])
pass('a different amount finds nothing')
assert.deepEqual(await search(U.sales, piB.id, 50000, null), [])
pass('no date, no search')
assert.deepEqual(await search(U.sales, piB.id, 50000, '2026-12-20'), [])
pass('more than 30 days away finds nothing')
await refuses(U.outsider, `select client_available_payments($1, null, 50000, '2026-10-21')`, [piB.id], 'PI_PAYMENT_NOT_PERMITTED')
pass('someone who may not record on the PI cannot search for it')

const other = await pay(50000, 'Mehta Homes', 'approved_unlinked', '2026-10-20', 'P-AB-0130')
const piOpen = await pi('submitted', 'Sharma Interiors')                     // PID-00003, open, holds its money
const p4 = await pay(50000, 'Sharma Interiors', 'approved_linked', '2026-10-19', 'P-AB-0131')
await alloc(p4, piOpen.id, 50000)
const ids = (await search(U.sales, piB.id, 50000, '2026-10-21')).map(r => r.payment_number)
assert.deepEqual(ids, ['P-AB-0123'])
pass('another client\'s money and money held by an open PI are never offered')
void other

// ── Use this money ────────────────────────────────────────────────────────
const moveMoney = (user, payment, sub, order) => as(user, `select use_available_payment($1, $2, $3) as r`, [payment, sub, order]).then(r => r[0].r)

await refuses(U.sales, `select use_available_payment($1, $2, null)`, [p4, piB.id], 'PAYMENT_NOTHING_AVAILABLE')
pass('money still held by an open PI cannot be taken')
const used = await moveMoney(U.sales, p1, piB.id, null)
assert.equal(used.payment_number, 'P-AB-0123'); assert.equal(Number(used.allocated_amount), 50000); assert.equal(used.status, 'approved_linked')
const onB = await one(`select count(*)::int as n from finance_payment_allocations where payment_request_id = $1 and order_submission_id = $2 and status = 'active'`, [p1, piB.id])
assert.equal(onB.n, 1)
const logB = await one(`select payload from activity where submission_id = $1 and action = 'payment_recorded'`, [piB.id])
assert.equal(logB.payload.source, 'available_money')
pass('Use this money puts the same payment on the new PI, still verified, and records it')
assert.deepEqual(await search(U.sales, piB.id, 50000, '2026-10-21'), [])
await refuses(U.sales, `select use_available_payment($1, $2, null)`, [p1, piB.id], 'ALLOCATION_DUPLICATE')
pass('once used it is no longer offered, and cannot be used twice')

// A PI rejected BEFORE this migration still holds its allocation.
const piOld = await pi('rejected', 'Sharma Interiors')                       // PID-00005
const p5 = await pay(30000, 'Sharma Interiors', 'approved_linked', '2026-10-15', 'P-AB-0140')
await alloc(p5, piOld.id, 30000)
assert.equal((await search(U.sales, piB.id, 30000, '2026-10-16'))[0]?.closed_pi_reference, piOld.draft_reference)
await moveMoney(U.sales, p5, piB.id, null)
const oldRow = await one(`select status, reversal_reason from finance_payment_allocations where payment_request_id = $1 and order_submission_id = $2`, [p5, piOld.id])
assert.equal(oldRow.status, 'reversed'); assert.equal(oldRow.reversal_reason, `Moved to ${piB.draft_reference}: ${piOld.draft_reference} was closed`)
pass('money on a PI rejected before this change is moved off it, with the reason')

// A pending intent on an open target stays reserved.
const piC = await pi('submitted', 'Sharma Interiors')
const p6 = await pay(100000, 'Sharma Interiors', 'pending_approval', '2026-10-18', 'P-AB-0150')
await db.query(`insert into finance_payment_allocation_intents (payment_request_id, order_submission_id, intended_amount) values ($1, $2, 60000)`, [p6, piC.id])
const res6 = await search(U.sales, piB.id, 40000, '2026-10-18')
assert.equal(res6[0]?.payment_number, 'P-AB-0150'); assert.equal(Number(res6[0].available), 40000)
const used6 = await moveMoney(U.sales, p6, piB.id, null)
assert.equal(Number(used6.allocated_amount), 40000)
pass('money an unverified payment already intends for an open PI stays reserved')

await refuses(U.sales, `select use_available_payment($1, $2, null)`, [other, piB.id], 'PAYMENT_CLIENT_MISMATCH')
pass('another client\'s payment cannot be used')
await refuses(U.sales, `select use_available_payment($1, $2, null)`, [p1, piA.id], 'ORDER_SUBMISSION_REJECTED')
pass('a closed PI cannot receive money')

// Orders: Finance's door (entry + allocate).
const ord = await one(`insert into orders (client_name, display_number) values ('Sharma Interiors', '0524') returning id`)
const p7 = await pay(25000, 'Sharma Interiors', 'approved_unlinked', '2026-10-22', 'P-AB-0160')
await refuses(U.sales, `select client_available_payments(null, $1, 25000, '2026-10-22')`, [ord.id], 'PAYMENT_ENTRY_ALLOCATION_NOT_PERMITTED')
pass('Sales without Finance allocate cannot search or use money on an Order')
const ordFound = (await as(U.finance, `select client_available_payments(null, $1, 25000, '2026-10-22') as r`, [ord.id]))[0].r
assert.equal(ordFound[0]?.payment_number, 'P-AB-0160')
await moveMoney(U.finance, p7, null, ord.id)
assert.equal((await one(`select count(*)::int as n from finance_payment_allocations where payment_request_id = $1 and order_id = $2`, [p7, ord.id])).n, 1)
pass('Finance can find and use the client\'s unallocated money on an Order')

console.log(`all ${checks} checks passed`)
