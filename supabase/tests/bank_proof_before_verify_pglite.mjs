// Database regression suite for 20270516000000 (an HDFC payment is verified only
// against the bank). Stubs: auth.uid(), permissions, the columns these functions
// read, apply_payment_allocation_intents. REAL: approve_finance_payment_request,
// the decision guard, in_finance_payment_verification, user_has_module_permission,
// assert_bank_reconcile_door, link_bank_line_to_payment, unlink_bank_line_payment,
// finance_payment_status_is_verified and everything in the migration under test,
// so every route to verified is the real one. Run:
//   node supabase/tests/bank_proof_before_verify_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all 55 checks passed".
// Set BANK_PROOF_MIGRATION to another file to run these checks against a broken copy.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node bank_proof_before_verify_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
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
  admin:     '00000000-0000-0000-0000-0000000000d4', // role admin
  other:     '00000000-0000-0000-0000-0000000000d5', // a second role admin
  verifier:  '00000000-0000-0000-0000-0000000000a1', // reconcile + approve
  approver:  '00000000-0000-0000-0000-0000000000a2', // approve only, no bank access
  reconcile: '00000000-0000-0000-0000-0000000000a3', // reconcile only, cannot verify
  selfver:   '00000000-0000-0000-0000-0000000000a4', // reconcile + approve + verify_own_payment
  sales:     '00000000-0000-0000-0000-0000000000e5', // nothing
}

const db = new PGlite()
await db.exec(`
create role anon nologin; create role authenticated nologin;
create schema auth;
grant usage on schema auth to anon, authenticated;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create type notification_type as enum ('finance_approved_linked', 'finance_approved_suspense');
create table users (id uuid primary key, role text not null default 'member', is_active boolean not null default true, is_deleted boolean default false, full_name text);
create table grants (user_id uuid, action text);
create table notifications (id uuid primary key default gen_random_uuid(), user_id uuid, task_id uuid, entity_id uuid, type notification_type, title text, body text, is_push_sent boolean);
create table order_requests (id uuid primary key, status text, finalized_at timestamptz, converted_order_id uuid, request_number text);
create table orders (id uuid primary key, display_number text);
create function module_entry_open(text) returns boolean language sql as $$ select true $$;
create function actor_has_module_permission(p_module text, p_action text) returns boolean language sql stable as $$
  select exists (select 1 from users where id = auth.uid() and role = 'admin')
      or exists (select 1 from grants where user_id = auth.uid() and action = p_action) $$;
create function resolve_permission(p_user uuid, p_module text, p_action text) returns boolean language sql stable as $$
  select exists (select 1 from grants where user_id = p_user and action = p_action) $$;
create function apply_payment_allocation_intents(p_id uuid) returns jsonb language sql as $$ select '{"applied_count": 0}'::jsonb $$;
create table bank_statement_lines (id uuid primary key default gen_random_uuid(), account text not null, line_date date not null,
  seq integer not null default 0, narration text not null, bank_ref text, withdrawal numeric not null default 0, deposit numeric not null default 0,
  classification text);
create table finance_payment_requests (id uuid primary key default gen_random_uuid(), request_number text, human_payment_id text,
  client_name text, amount numeric not null, payment_date date not null, payment_mode text not null, proof_note text,
  sales_note text, status text not null default 'pending_approval', submitted_by uuid, deleted_at timestamptz,
  is_test_data boolean not null default false, order_request_id uuid, order_request_number text, payment_target_type text,
  order_id uuid, order_number text, approved_by uuid, approved_at timestamptz, admin_note text, updated_at timestamptz);
create table bank_line_payment_links (id uuid primary key default gen_random_uuid(), line_id uuid not null references bank_statement_lines(id),
  payment_id uuid not null references finance_payment_requests(id), amount numeric not null, linked_by uuid not null,
  linked_at timestamptz default now(), unlinked_by uuid, unlinked_at timestamptz, unlink_reason text);
insert into users (id, role, full_name) values
  ('${U.admin}','admin','Admin one'),('${U.other}','admin','Admin two'),('${U.verifier}','member','Verifier'),
  ('${U.approver}','member','Approver'),('${U.reconcile}','member','Reconciler'),('${U.selfver}','member','Self verifier'),('${U.sales}','member','Sales');
insert into grants values
  ('${U.verifier}','reconcile'),('${U.verifier}','approve'),
  ('${U.approver}','approve'),
  ('${U.reconcile}','reconcile'),
  ('${U.selfver}','reconcile'),('${U.selfver}','approve'),('${U.selfver}','verify_own_payment');
`)
const m0329 = mig('20270329000000_finance_bank_statements.sql')
const m0120 = mig('20270120000000_order_submission_admin_decisions_ask_permissions.sql')
for (const f of ['assert_bank_reconcile_door', 'link_bank_line_to_payment', 'unlink_bank_line_payment']) await db.exec(extract(m0329, f))
await db.exec(extract(mig('20260918000000_finance_payment_allocations.sql'), 'finance_payment_status_is_verified'))
await db.exec(extract(mig('20260920000000_finance_approver_can_verify_payment.sql'), 'in_finance_payment_verification'))
await db.exec(extract(mig('20261118000000_restore_finance_payment_verification_context.sql'), 'approve_finance_payment_request'))
for (const f of ['user_holds_permission', 'user_has_module_permission', 'complete_payment_entry', 'finance_payment_requests_guard_decision_status']) await db.exec(extract(m0120, f))
await db.exec(`create trigger finance_payment_requests_guard_decision_status before insert or update on finance_payment_requests
  for each row execute function finance_payment_requests_guard_decision_status()`)
const UNDER_TEST = process.env.BANK_PROOF_MIGRATION ?? `${REPO}/supabase/migrations/20270516000000_finance_bank_proof_before_verify.sql`
const migration = readFileSync(UNDER_TEST, 'utf8')
await db.exec(migration)

const as = id => db.exec(`select set_config('request.jwt.claim.sub', '${id ?? ''}', false)`)
const q = async (sql, params) => (await db.query(sql, params)).rows
let seq = 0, payN = 0
const line = async (deposit, opts = {}) =>
  (await q(`insert into bank_statement_lines (account, line_date, seq, narration, bank_ref, deposit, withdrawal, classification) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [opts.account ?? 'hdfc', opts.date ?? '2026-10-06', ++seq, opts.narration ?? `NEFT CR-SOME PAYER-${seq}`, opts.ref ?? null, deposit, opts.withdrawal ?? 0, opts.classification ?? null]))[0].id
/** A verified HDFC payment with no link: what the rule finds already there on the day it arrives. */
const verifiedBefore = async amount => {
  const human = `P-ZZ-${String(++payN).padStart(4, '0')}`
  await as(U.admin)
  const id = (await q(`insert into finance_payment_requests (request_number, human_payment_id, client_name, amount, payment_date, payment_mode, submitted_by, status, payment_target_type)
    values ($1,$2,'Client',$3,'2026-09-01','hdfc',$4,'approved_unlinked','suspense') returning id`, ['R' + payN, human, amount, U.sales]))[0].id
  return { id, human }
}
const pay = async (amount, opts = {}) => {
  const human = `P-ZZ-${String(++payN).padStart(4, '0')}`
  await as(opts.by ?? U.sales)
  const id = (await q(`insert into finance_payment_requests (request_number, human_payment_id, client_name, amount, payment_date, payment_mode, submitted_by, is_test_data, payment_target_type)
    values ($1,$2,$3,$4,$5,$6,$7,$8,'suspense') returning id`,
    ['R' + payN, human, opts.client ?? 'Client', amount, opts.date ?? '2026-10-06', opts.mode ?? 'hdfc', opts.by ?? U.sales, opts.test ?? false]))[0].id
  return { id, human }
}
const call = async (sql, params) => { try { return { ok: (await q(sql, params))[0]?.r ?? true } } catch (e) { return { err: String(e.message) } } }
const approve = id => call('select approve_finance_payment_request($1, null) as r', [id])
const verify = (id, lines = []) => call('select verify_payment_with_bank($1, $2::uuid[]) as r', [id, lines])
const urgent = (id, reason = 'Seen in the bank app') => call('select verify_payment_bank_check_pending($1, $2) as r', [id, reason])
const complete = id => call('select complete_payment_entry($1) as r', [id])
const link = (l, p, a = null) => call('select link_bank_line_to_payment($1, $2, $3) as r', [l, p, a])
const status = async id => (await q('select status from finance_payment_requests where id = $1', [id]))[0].status
const links = async id => (await q('select * from bank_line_payment_links where payment_id = $1 and unlinked_at is null', [id]))
const pendingList = () => q('select * from finance_bank_check_pending()')
const verified = s => s === 'approved_unlinked' || s === 'approved_linked'

let checks = 0
const check = async (name, fn) => {
  await as(U.admin)
  await fn()
  checks++
  console.log(`ok ${checks} ${name}`)
}

// ── The rule: every route to verified ─────────────────────────────────────────

await check('the verification door refuses an HDFC payment with no bank credit', async () => {
  const p = await pay(500000); await as(U.approver)
  const r = await approve(p.id)
  assert.match(r.err, /PAYMENT_NEEDS_BANK_MATCH/)
  assert.equal(await status(p.id), 'pending_approval')
})

await check('so does the same door for an admin', async () => {
  const p = await pay(500000); await as(U.admin)
  assert.match((await approve(p.id)).err, /PAYMENT_NEEDS_BANK_MATCH/)
})

await check('an admin status write, which the decision guard lets through, is refused', async () => {
  const p = await pay(500000); await as(U.admin)
  const r = await call(`update finance_payment_requests set status = 'approved_unlinked' where id = $1`, [p.id])
  assert.match(r.err, /PAYMENT_NEEDS_BANK_MATCH/)
  assert.equal(await status(p.id), 'pending_approval')
})

await check('direct SQL with no signed-in user is refused too', async () => {
  const p = await pay(500000); await as(null)
  const r = await call(`update finance_payment_requests set status = 'approved_linked', order_id = null where id = $1`, [p.id])
  assert.match(r.err, /PAYMENT_NEEDS_BANK_MATCH/)
})

await check('a payment sent back and corrected is refused the same way', async () => {
  const p = await pay(500000); await as(U.admin)
  await q(`update finance_payment_requests set status = 'needs_clarification' where id = $1`, [p.id])
  const r = await call(`update finance_payment_requests set status = 'approved_unlinked' where id = $1`, [p.id])
  assert.match(r.err, /PAYMENT_NEEDS_BANK_MATCH/)
})

await check('HDFC SEC is covered as well as HDFC PRI', async () => {
  const p = await pay(21000, { mode: 'hdfc_sec' }); await as(U.admin)
  assert.match((await approve(p.id)).err, /PAYMENT_NEEDS_BANK_MATCH/)
})

await check('a credit that covers only part of the payment is not enough', async () => {
  const p = await pay(500000); const l = await line(300000); await as(U.admin)
  await link(l, p.id)
  assert.match((await approve(p.id)).err, /PAYMENT_NEEDS_BANK_MATCH/)
})

await check('a credit in the other HDFC account does not count', async () => {
  const p = await pay(500000); const l = await line(500000, { account: 'hdfc_sec' }); await as(U.admin)
  await link(l, p.id)
  assert.match((await approve(p.id)).err, /PAYMENT_NEEDS_BANK_MATCH/)
})

await check('an unlinked credit does not count', async () => {
  const p = await pay(500000); const l = await line(500000); await as(U.admin)
  await link(l, p.id)
  await q(`update bank_line_payment_links set unlinked_at = now(), unlinked_by = $1 where payment_id = $2`, [U.admin, p.id])
  assert.match((await approve(p.id)).err, /PAYMENT_NEEDS_BANK_MATCH/)
})

await check('with a credit covering it, the ordinary door passes', async () => {
  const p = await pay(500000); const l = await line(500000); await as(U.admin)
  await link(l, p.id)
  assert.ok((await approve(p.id)).ok)
  assert.equal(await status(p.id), 'approved_unlinked')
})

await check('PNB, Paytm and Canara are verified by hand, as today', async () => {
  for (const mode of ['pnb', 'paytm', 'canara']) {
    const p = await pay(90000, { mode }); await as(U.approver)
    assert.ok((await approve(p.id)).ok, mode)
    assert.ok(verified(await status(p.id)))
  }
})

await check('a test-data payment is left alone', async () => {
  const p = await pay(1000, { test: true }); await as(U.approver)
  assert.ok((await approve(p.id)).ok)
})

await check('a payment verified before this rule is not caught by moving between the two verified statuses', async () => {
  const p = await verifiedBefore(90000); await as(U.admin)
  const r = await call(`update finance_payment_requests set status = 'approved_linked' where id = $1`, [p.id])
  assert.equal(r.err, undefined)
})

// ── Editing a verified payment ────────────────────────────────────────────────

await check('a verified cash payment cannot be edited into HDFC with no credit', async () => {
  const p = await pay(90000, { mode: 'paytm' }); await as(U.admin)
  await approve(p.id)
  const r = await call(`update finance_payment_requests set payment_mode = 'hdfc' where id = $1`, [p.id])
  assert.match(r.err, /PAYMENT_EDIT_NEEDS_BANK_MATCH/)
})

await check('a covered payment cannot be raised past its credit', async () => {
  const p = await pay(100000); const l = await line(100000); await as(U.verifier)
  await verify(p.id, [l]); await as(U.admin)
  const r = await call(`update finance_payment_requests set amount = 200000 where id = $1`, [p.id])
  assert.match(r.err, /PAYMENT_EDIT_NEEDS_BANK_MATCH/)
})

await check('a covered payment cannot be moved to the other HDFC account', async () => {
  const p = await pay(100000); const l = await line(100000); await as(U.verifier)
  await verify(p.id, [l]); await as(U.admin)
  const r = await call(`update finance_payment_requests set payment_mode = 'hdfc_sec' where id = $1`, [p.id])
  assert.match(r.err, /PAYMENT_EDIT_NEEDS_BANK_MATCH/)
})

await check('lowering a covered payment is fine, and so is any edit that leaves it covered', async () => {
  const p = await pay(100000); const l = await line(100000); await as(U.verifier)
  await verify(p.id, [l]); await as(U.admin)
  assert.equal((await call(`update finance_payment_requests set amount = 90000 where id = $1`, [p.id])).err, undefined)
  assert.equal((await call(`update finance_payment_requests set proof_note = 'SAMP1' where id = $1`, [p.id])).err, undefined)
})

await check('raised after a second credit is linked: the edit passes', async () => {
  const p = await pay(100000); const a = await line(100000); const b = await line(50000); await as(U.verifier)
  await verify(p.id, [a]); await as(U.admin)
  await q(`insert into bank_line_payment_links (line_id, payment_id, amount, linked_by) values ($1, $2, 50000, $3)`, [b, p.id, U.admin])
  assert.equal((await call(`update finance_payment_requests set amount = 150000 where id = $1`, [p.id])).err, undefined)
})

await check('a payment verified before this rule, and short already, can still be corrected', async () => {
  const p = await verifiedBefore(90000); await as(U.admin)
  assert.equal((await call(`update finance_payment_requests set amount = 95000 where id = $1`, [p.id])).err, undefined)
  assert.equal((await call(`update finance_payment_requests set payment_mode = 'hdfc_sec' where id = $1`, [p.id])).err, undefined)
})

await check('a payment verified with a bank check pending can be corrected too', async () => {
  const p = await pay(90000); await as(U.admin)
  await urgent(p.id)
  assert.equal((await call(`update finance_payment_requests set amount = 95000 where id = $1`, [p.id])).err, undefined)
})

await check('rejecting and sending back are not affected', async () => {
  const p = await pay(500000); await as(U.approver)
  const r = await call(`update finance_payment_requests set status = 'rejected', admin_note = 'No such money' where id = $1`, [p.id])
  assert.equal(r.err, undefined)
})

// ── Verifying against the bank ────────────────────────────────────────────────

await check('one call links the credit and verifies', async () => {
  const p = await pay(375000); const l = await line(375000); await as(U.verifier)
  assert.ok((await verify(p.id, [l])).ok)
  assert.ok(verified(await status(p.id)))
  const k = await links(p.id)
  assert.equal(k.length, 1)
  assert.equal(k[0].linked_by, U.verifier)
  assert.equal(Number(k[0].amount), 375000)
})

await check('two credits can cover one payment', async () => {
  const p = await pay(500000); const a = await line(300000); const b = await line(200000); await as(U.verifier)
  assert.ok((await verify(p.id, [a, b])).ok)
  assert.equal((await links(p.id)).length, 2)
})

await check('one credit can cover two payments, each for its part', async () => {
  const a = await pay(600000); const b = await pay(400000); const l = await line(1000000); await as(U.verifier)
  assert.ok((await verify(a.id, [l])).ok)
  assert.ok((await verify(b.id, [l])).ok)
  assert.equal(Number((await links(a.id))[0].amount), 600000)
  assert.equal(Number((await links(b.id))[0].amount), 400000)
})

await check('THE POINT: a second request for the same money can never be confirmed', async () => {
  const first = await pay(500000); const second = await pay(500000); const l = await line(500000); await as(U.verifier)
  assert.ok((await verify(first.id, [l])).ok)
  assert.match((await verify(second.id, [l])).err, /BANK_LINE_OVER_LINKED/)
  assert.equal(await status(second.id), 'pending_approval')
  assert.equal((await links(second.id)).length, 0)
  assert.match((await approve(second.id)).err, /PAYMENT_NEEDS_BANK_MATCH/)
})

await check('a credit too small refuses, and its link goes back', async () => {
  const p = await pay(500000); const l = await line(300000); await as(U.verifier)
  assert.match((await verify(p.id, [l])).err, /PAYMENT_NEEDS_BANK_MATCH/)
  assert.equal((await links(p.id)).length, 0)
  assert.equal(await status(p.id), 'pending_approval')
})

await check('a credit in the other account refuses, and says so', async () => {
  const p = await pay(500000); const l = await line(500000, { account: 'hdfc_sec' }); await as(U.verifier)
  assert.match((await verify(p.id, [l])).err, /BANK_ACCOUNT_DIFFERS/)
  assert.equal((await links(p.id)).length, 0)
})

await check('a credit a person marked as old order or not customer money refuses', async () => {
  const p = await pay(500000); const l = await line(500000, { classification: 'old_order' }); await as(U.verifier)
  assert.match((await verify(p.id, [l])).err, /BANK_LINE_CLASSIFIED/)
})

await check('a debit refuses', async () => {
  const p = await pay(500000); const l = await line(0, { withdrawal: 500000 }); await as(U.verifier)
  assert.match((await verify(p.id, [l])).err, /BANK_LINE_NOT_A_CREDIT/)
})

await check('a payment already linked verifies with no credit named', async () => {
  const p = await pay(500000); const l = await line(500000); await as(U.verifier)
  await link(l, p.id)
  assert.ok((await verify(p.id, [])).ok)
})

await check('a payment raised after it was linked: the same link grows, up to what the credit has left', async () => {
  const p = await pay(50000); const l = await line(100000); await as(U.verifier)
  await link(l, p.id)
  await as(U.admin); await q(`update finance_payment_requests set amount = 80000 where id = $1`, [p.id])
  await as(U.verifier)
  assert.ok((await verify(p.id, [l])).ok)
  const k = await links(p.id)
  assert.equal(k.length, 1)
  assert.equal(Number(k[0].amount), 80000)
})

await check('a link cannot grow past the credit: refused, and it stays as it was', async () => {
  const p = await pay(50000); const l = await line(60000); await as(U.verifier)
  await link(l, p.id)
  await as(U.admin); await q(`update finance_payment_requests set amount = 80000 where id = $1`, [p.id])
  await as(U.verifier)
  assert.match((await verify(p.id, [l])).err, /PAYMENT_NEEDS_BANK_MATCH/)
  assert.equal(Number((await links(p.id))[0].amount), 50000)
})

await check('naming a credit already linked to it does not link it twice', async () => {
  const p = await pay(500000); const l = await line(500000); await as(U.verifier)
  await link(l, p.id)
  assert.ok((await verify(p.id, [l])).ok)
  assert.equal((await links(p.id)).length, 1)
})

await check('no bank access: refused, whatever else they hold', async () => {
  const p = await pay(500000); const l = await line(500000); await as(U.approver)
  assert.match((await verify(p.id, [l])).err, /BANK_FORBIDDEN/)
})

await check('no bank access: refused here even when there is nothing left to link', async () => {
  const p = await pay(500000); const l = await line(500000); await as(U.verifier)
  await link(l, p.id)
  await as(U.approver)
  assert.match((await verify(p.id, [])).err, /BANK_FORBIDDEN/)
  assert.equal(await status(p.id), 'pending_approval')
})

await check('bank access without the right to verify: refused, and nothing stays linked', async () => {
  const p = await pay(500000); const l = await line(500000); await as(U.reconcile)
  assert.ok((await verify(p.id, [l])).err)
  assert.equal(await status(p.id), 'pending_approval')
  assert.equal((await links(p.id)).length, 0)
})

await check('nobody verifies their own payment through this door without verify_own_payment', async () => {
  const p = await pay(500000, { by: U.verifier }); const l = await line(500000); await as(U.verifier)
  assert.match((await verify(p.id, [l])).err, /PAYMENT_SELF_DECISION_FORBIDDEN/)
  assert.equal((await links(p.id)).length, 0)
})

await check('a holder of verify_own_payment may', async () => {
  const p = await pay(500000, { by: U.selfver }); const l = await line(500000); await as(U.selfver)
  assert.ok((await verify(p.id, [l])).ok)
})

await check('a cash payment is not verified through this door', async () => {
  const p = await pay(90000, { mode: 'paytm' }); await as(U.verifier)
  assert.match((await verify(p.id, [])).err, /BANK_PAYMENT_NOT_IN_A_BANK_ACCOUNT/)
})

await check('a payment no longer pending refuses, and the credit stays free', async () => {
  const p = await pay(500000); const l = await line(500000); await as(U.admin)
  await q(`update finance_payment_requests set status = 'needs_clarification' where id = $1`, [p.id])
  await as(U.verifier)
  assert.ok((await verify(p.id, [l])).err)
  assert.equal((await links(p.id)).length, 0)
})

await check('more than 20 credits are refused', async () => {
  const p = await pay(500000); await as(U.verifier)
  const many = Array.from({ length: 21 }, () => '00000000-0000-0000-0000-000000000000')
  assert.match((await verify(p.id, many)).err, /BANK_LINES_TOO_MANY/)
})

// ── Verify, bank check pending ────────────────────────────────────────────────

await check('only an active admin: a verifier with every Finance right is refused', async () => {
  const p = await pay(210000); await as(U.selfver)
  assert.match((await urgent(p.id)).err, /BANK_CHECK_PENDING_ADMIN_ONLY/)
  assert.equal(await status(p.id), 'pending_approval')
})

await check('an inactive admin is refused', async () => {
  const p = await pay(210000)
  await as(U.other); await q(`update users set is_active = false where id = $1`, [U.other])
  assert.match((await urgent(p.id)).err, /BANK_CHECK_PENDING_ADMIN_ONLY/)
  await q(`update users set is_active = true where id = $1`, [U.other])
})

await check('it needs a reason', async () => {
  const p = await pay(210000); await as(U.admin)
  assert.match((await urgent(p.id, '  ')).err, /BANK_REASON_REQUIRED/)
  assert.match((await urgent(p.id, 'x'.repeat(201))).err, /BANK_REASON_TOO_LONG/)
})

await check('an admin verifies it: it counts now, and stays on the list with the reason', async () => {
  const before = (await pendingList()).length
  const p = await pay(210000); await as(U.admin)
  assert.ok((await urgent(p.id)).ok)
  assert.ok(verified(await status(p.id)))
  const list = await pendingList()
  assert.equal(list.length, before + 1)
  const row = list.find(r => r.payment_id === p.id)
  assert.equal(row.reason, 'Seen in the bank app')
  assert.equal(row.created_by_name, 'Admin one')
  assert.equal(Number(row.covered), 0)
})

await check('the credit arrives, a person links it, and the list clears by itself', async () => {
  const p = await pay(210000); await as(U.admin)
  await urgent(p.id)
  const l = await line(210000); await as(U.verifier)
  assert.ok((await link(l, p.id)).ok)
  assert.equal((await pendingList()).some(r => r.payment_id === p.id), false)
})

await check('two urgent records of one transfer: only one can take the credit, so the other stays on the list', async () => {
  const a = await pay(180000); const b = await pay(180000); await as(U.admin)
  await urgent(a.id); await urgent(b.id)
  const l = await line(180000); await as(U.verifier)
  assert.ok((await link(l, a.id)).ok)
  assert.match((await link(l, b.id)).err, /BANK_LINE_OVER_LINKED/)
  const list = await pendingList()
  assert.equal(list.some(r => r.payment_id === a.id), false)
  assert.equal(list.some(r => r.payment_id === b.id), true)
})

await check('a cash payment has no bank check to wait for', async () => {
  const p = await pay(90000, { mode: 'canara' }); await as(U.admin)
  assert.match((await urgent(p.id)).err, /BANK_PAYMENT_NOT_IN_A_BANK_ACCOUNT/)
})

await check('the exception ends when the payment stops being verified: it cannot excuse a second verification', async () => {
  const p = await pay(90000); await as(U.admin)
  await urgent(p.id)
  await q(`update finance_payment_requests set status = 'pending_approval' where id = $1`, [p.id])
  assert.equal((await q('select count(*)::int c from finance_payment_bank_exceptions where payment_id = $1', [p.id]))[0].c, 0)
  assert.equal((await pendingList()).some(r => r.payment_id === p.id), false)
  await as(U.approver)
  assert.match((await approve(p.id)).err, /PAYMENT_NEEDS_BANK_MATCH/)
})

await check('a stray exception on a payment that is not verified is not listed', async () => {
  const p = await pay(90000); await as(U.admin)
  await q(`insert into finance_payment_bank_exceptions (payment_id, reason, created_by) values ($1, 'Stray row', $2)`, [p.id, U.admin])
  assert.equal((await pendingList()).some(r => r.payment_id === p.id), false)
})

await check('a refused verification keeps no reason behind', async () => {
  const p = await pay(90000); await as(U.admin)
  await q(`update finance_payment_requests set status = 'needs_clarification' where id = $1`, [p.id])
  assert.ok((await urgent(p.id)).err)
  assert.equal((await pendingList()).some(r => r.payment_id === p.id), false)
  assert.equal((await q('select count(*)::int c from finance_payment_bank_exceptions where payment_id = $1', [p.id]))[0].c, 0)
})

await check('the list needs bank access', async () => {
  await as(U.approver)
  const r = await call('select count(*) as r from finance_bank_check_pending()')
  assert.match(r.err, /BANK_FORBIDDEN/)
})

// ── Somebody who verifies their own payments ──────────────────────────────────

await check('their HDFC entry stays pending, with no error, and nobody is told it was verified', async () => {
  const before = (await q('select count(*)::int c from notifications'))[0].c
  const p = await pay(500000, { by: U.selfver }); await as(U.selfver)
  const r = await complete(p.id)
  assert.equal(r.ok.verified_on_entry, false)
  assert.equal(r.ok.waiting_for_bank, true)
  assert.equal(await status(p.id), 'pending_approval')
  assert.equal((await q('select count(*)::int c from notifications'))[0].c, before)
})

await check('their cash entry is verified as it is recorded, as today', async () => {
  const p = await pay(90000, { mode: 'pnb', by: U.selfver }); await as(U.selfver)
  const r = await complete(p.id)
  assert.equal(r.ok.verified_on_entry, true)
  assert.ok(verified(await status(p.id)))
})

await check('an HDFC entry already covered by its credit is verified as it is recorded', async () => {
  const p = await pay(500000, { by: U.selfver }); const l = await line(500000); await as(U.selfver)
  await link(l, p.id)
  assert.equal((await complete(p.id)).ok.verified_on_entry, true)
})

// ── The migration ─────────────────────────────────────────────────────────────

await db.exec(migration)
console.log('the migration can be run twice')

const counted = (await readFileSync(fileURLToPath(import.meta.url), 'utf8').match(/^await check\(/gm) ?? []).length
assert.equal(checks, counted)
console.log(`all ${checks} checks passed`)
