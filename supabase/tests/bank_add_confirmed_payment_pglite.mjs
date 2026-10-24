// Database regression suite for 20270419000000 (Bank Statements: "Add to
// Confirmed Payments").
//
// Applies the REAL migration, with the REAL assert_bank_reconcile_door
// (extracted from 20270329000000, never retyped), on an in-memory Postgres
// (PGlite). Stubbed, and said so: auth.uid(), permissions (by users.role plus a
// grants table), the bank tables (columns this function reads), the payment
// table (columns it reads), submit_payment_request (inserts a pending Suspense
// payment, as the real door does) and complete_payment_entry (verifies only for
// an admin / a verify_own_payment grant, as the real one does).
//
// NOT part of npm test (PGlite is not an app dependency). Run:
//   node supabase/tests/bank_add_confirmed_payment_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all 14 checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node bank_add_confirmed_payment_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
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
  admin:    '00000000-0000-0000-0000-0000000000d4', // admin: reconcile + create + self-verify
  reconcile:'00000000-0000-0000-0000-0000000000a1', // reconcile + create, cannot self-verify
  nocreate: '00000000-0000-0000-0000-0000000000a2', // reconcile only
  outsider: '00000000-0000-0000-0000-0000000000e5', // nothing
}
const db = new PGlite()
await db.exec(`
create role anon nologin; create role authenticated nologin;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create table users (id uuid primary key, role text not null default 'member');
create table grants (user_id uuid, action text);
create function module_entry_open(text) returns boolean language sql as $$ select true $$;
create function actor_has_module_permission(p_module text, p_action text) returns boolean language sql stable as $$
  select exists (select 1 from users where id = auth.uid() and role = 'admin')
      or exists (select 1 from grants where user_id = auth.uid() and action = p_action) $$;
create table bank_statement_lines (id uuid primary key default gen_random_uuid(), account text not null, line_date date not null,
  narration text not null, bank_ref text, withdrawal numeric not null default 0, deposit numeric not null default 0, classification text);
create table finance_payment_requests (id uuid primary key default gen_random_uuid(), request_number text, human_payment_id text,
  client_name text, amount numeric not null, payment_date date not null, payment_mode text not null, proof_note text,
  sales_note text, status text not null default 'pending_approval', submitted_by uuid, deleted_at timestamptz);
create table bank_line_payment_links (id uuid primary key default gen_random_uuid(), line_id uuid not null references bank_statement_lines(id),
  payment_id uuid not null references finance_payment_requests(id), amount numeric not null, linked_by uuid not null,
  linked_at timestamptz default now(), unlinked_by uuid, unlinked_at timestamptz);
create sequence pay_seq;
create function submit_payment_request(p_destination text, p_target_id uuid default null, p_amount numeric default null,
  p_payment_date date default null, p_payment_mode text default null, p_proof_note text default null, p_sales_note text default null,
  p_custody_events jsonb default '[]'::jsonb, p_idempotency_key uuid default null) returns jsonb language plpgsql as $$
declare v_id uuid; v_n bigint := nextval('pay_seq');
begin
  if p_destination <> 'suspense' or p_target_id is not null then raise exception 'stub: only suspense'; end if;
  insert into finance_payment_requests (request_number, human_payment_id, amount, payment_date, payment_mode, proof_note, sales_note, submitted_by)
  values ('PAY-REQ-' || v_n, 'P-ZZ-' || lpad(v_n::text, 4, '0'), p_amount, p_payment_date, p_payment_mode, p_proof_note, p_sales_note, auth.uid())
  returning id into v_id;
  return jsonb_build_object('payment_request_id', v_id, 'request_number', 'PAY-REQ-' || v_n);
end $$;
create function complete_payment_entry(p_id uuid) returns jsonb language plpgsql as $$
declare v boolean := actor_has_module_permission('finance', 'verify_own_payment');
begin
  if v then update finance_payment_requests set status = 'approved_unlinked' where id = p_id; end if;
  return jsonb_build_object('verified_on_entry', v);
end $$;
insert into users values ('${U.admin}','admin'),('${U.reconcile}','member'),('${U.nocreate}','member'),('${U.outsider}','member');
insert into grants values ('${U.reconcile}','reconcile'),('${U.reconcile}','create'),('${U.nocreate}','reconcile');
`)
await db.exec(extract(mig('20270329000000_finance_bank_statements.sql'), 'assert_bank_reconcile_door'))
await db.exec(mig('20270419000000_finance_bank_add_confirmed_payment.sql'))

const as = id => db.exec(`select set_config('request.jwt.claim.sub', '${id ?? ''}', false)`)
const q = async (sql, params) => (await db.query(sql, params)).rows
const line = async (narration, deposit, opts = {}) =>
  (await q(`insert into bank_statement_lines (account, line_date, narration, bank_ref, deposit, withdrawal, classification)
            values ('hdfc', $1, $2, $3, $4, $5, $6) returning id`,
    [opts.date ?? '2026-10-19', narration, opts.ref ?? null, opts.withdrawal ? 0 : deposit, opts.withdrawal ? deposit : 0, opts.classification ?? null]))[0].id
const add = async (id, flag) => { try { return { ok: (await q('select create_payment_from_bank_line($1, $2) as r', [id, flag ?? false]))[0].r } } catch (e) { return { err: String(e.message) } } }

let n = 0
const check = (name, fn) => fn().then(() => { n++; console.log('ok  ' + name) }).catch(e => { console.error('FAIL ' + name + '\n' + e.stack); process.exit(1) })

const NARR = 'NEFT CR-KKBK0000958-HOTEL ALANKAR PRIVATE LIMITED-BESTOFEXPORTS-KKBKH26295886339'

await check('a reconciler with create adds a credit: payment + link in one step, pending, in the credit account, dated and valued from the line', async () => {
  await as(U.reconcile)
  const id = await line(NARR, 250000)
  const { ok, err } = await add(id)
  assert.ok(ok, err)
  assert.equal(ok.status, 'pending_approval')
  assert.equal(ok.verified_on_entry, false)
  const [p] = await q('select * from finance_payment_requests where id = $1', [ok.payment_request_id])
  assert.equal(Number(p.amount), 250000); assert.equal(p.payment_mode, 'hdfc'); assert.equal(p.client_name, null)
  assert.equal(String(p.payment_date.toISOString?.().slice(0, 10) ?? p.payment_date).slice(0, 10), '2026-10-19')
  assert.match(p.proof_note, /KKBKH26295886339/)
  const links = await q('select * from bank_line_payment_links where line_id = $1 and unlinked_at is null', [id])
  assert.equal(links.length, 1); assert.equal(Number(links[0].amount), 250000); assert.equal(links[0].payment_id, ok.payment_request_id)
})

await check('an admin (self-verifier) gets it verified at once', async () => {
  await as(U.admin)
  const id = await line('NEFT CR-SCBL0036001-MOUNTAIN CAFE-BEST OF EXPORT-SCBLH26282006418', 141800)
  const { ok, err } = await add(id)
  assert.ok(ok, err)
  assert.equal(ok.verified_on_entry, true); assert.equal(ok.status, 'approved_unlinked')
})

await check('the same credit cannot be added twice (already linked)', async () => {
  await as(U.reconcile)
  const id = await line('NEFT CR-AAAA0000001-DOUBLE CLICK TRADERS-BESTOFEXPORTS-DBL1234567890', 1000)
  assert.ok((await add(id)).ok)
  const again = await add(id)
  assert.match(again.err, /BANK_LINE_ALREADY_LINKED/)
  assert.equal((await q('select count(*)::int c from finance_payment_requests where proof_note like $1', ['%DBL1234567890%']))[0].c, 1)
})

await check('a payment that already carries the bank reference blocks it, even with the confirm flag', async () => {
  await as(U.reconcile)
  await q(`insert into finance_payment_requests (request_number, human_payment_id, amount, payment_date, payment_mode, proof_note, submitted_by)
           values ('PAY-REQ-X1','P-AA-0099', 5000, '2026-10-10', 'hdfc', 'UTR UTIB26290REFXYZ99 received', $1)`, [U.reconcile])
  const id = await line('RTGS CR-UTIB0000008-SOME PAYER LTD-BESTOFEXPORTS-UTIB26290REFXYZ99', 5000)
  const r = await add(id, true)
  assert.match(r.err, /BANK_PAYMENT_DUPLICATE: payment P-AA-0099/)
})

await check('a rejected or deleted payment with that reference does not block', async () => {
  await as(U.reconcile)
  await q(`insert into finance_payment_requests (request_number, human_payment_id, amount, payment_date, payment_mode, proof_note, submitted_by, status)
           values ('PAY-REQ-X2','P-AA-0098', 7000, '2026-10-10', 'hdfc', 'REJ26290REFABC123', $1, 'rejected')`, [U.reconcile])
  const id = await line('RTGS CR-UTIB0000008-PAYER-BESTOFEXPORTS-REJ26290REFABC123', 7000)
  const r = await add(id)
  assert.ok(r.ok, r.err)
})

await check('an unlinked HDFC payment of the same amount within 21 days is refused with its id, and allowed once confirmed', async () => {
  await as(U.reconcile)
  await q(`insert into finance_payment_requests (request_number, human_payment_id, amount, payment_date, payment_mode, proof_note, submitted_by, client_name)
           values ('PAY-REQ-X3','P-AA-0097', 123456, '2026-10-12', 'hdfc', 'no reference', $1, 'Maybe Same Ltd')`, [U.reconcile])
  const id = await line('NEFT CR-ICIC0000001-MAYBE SAME LTD-BESTOFEXPORTS-MAY12345678901', 123456)
  const first = await add(id)
  assert.match(first.err, /BANK_PAYMENT_POSSIBLE_DUPLICATE: .*P-AA-0097/)
  assert.equal((await q('select count(*)::int c from bank_line_payment_links where line_id = $1', [id]))[0].c, 0)
  const second = await add(id, true)
  assert.ok(second.ok, second.err)
})

await check('a same-amount payment already linked to another credit does not count as a possible duplicate', async () => {
  await as(U.reconcile)
  const other = await line('NEFT CR-X-OTHER-BESTOFEXPORTS-OTH12345678901', 99900)
  await q(`insert into finance_payment_requests (request_number, human_payment_id, amount, payment_date, payment_mode, submitted_by)
           values ('PAY-REQ-X4','P-AA-0096', 99900, '2026-10-18', 'hdfc', $1)`, [U.reconcile])
  const pid = (await q(`select id from finance_payment_requests where human_payment_id = 'P-AA-0096'`))[0].id
  await q('insert into bank_line_payment_links (line_id, payment_id, amount, linked_by) values ($1,$2,99900,$3)', [other, pid, U.reconcile])
  const id = await line('NEFT CR-Y-ANOTHER-BESTOFEXPORTS-ANO12345678901', 99900)
  assert.ok((await add(id)).ok)
})

await check('a payment 40 days away is not a possible duplicate', async () => {
  await as(U.reconcile)
  await q(`insert into finance_payment_requests (request_number, human_payment_id, amount, payment_date, payment_mode, submitted_by)
           values ('PAY-REQ-X5','P-AA-0095', 77700, '2026-08-01', 'hdfc', $1)`, [U.reconcile])
  const id = await line('NEFT CR-Z-FAR-BESTOFEXPORTS-FAR12345678901', 77700)
  assert.ok((await add(id)).ok)
})

await check('a marked credit (old order / not customer money) is refused', async () => {
  await as(U.reconcile)
  const id = await line('NEFT CR-OLD-CUSTOMER-BESTOFEXPORTS-OLD12345678901', 4000, { classification: 'old_order' })
  assert.match((await add(id)).err, /BANK_LINE_CLASSIFIED/)
})

await check('a debit is refused', async () => {
  await as(U.reconcile)
  const id = await line('NEFT DR-SUPPLIER', 4000, { withdrawal: true })
  assert.match((await add(id)).err, /BANK_LINE_NOT_A_CREDIT/)
})

await check('reconcile without create is refused', async () => {
  await as(U.nocreate)
  const id = await line('NEFT CR-NOCREATE-BESTOFEXPORTS-NOC12345678901', 4100)
  assert.match((await add(id)).err, /BANK_CREATE_FORBIDDEN/)
})

await check('an outsider and a signed-out caller are refused by the reconcile door', async () => {
  const id = await line('NEFT CR-OUT-BESTOFEXPORTS-OUT12345678901', 4200)
  await as(U.outsider); assert.match((await add(id)).err, /BANK_FORBIDDEN/)
  await as(null); assert.match((await add(id)).err, /BANK_UNAUTHENTICATED/)
})

await check('a refusal leaves no payment and no link behind', async () => {
  await as(U.reconcile)
  const before = (await q('select count(*)::int c from finance_payment_requests'))[0].c
  const id = await line('NEFT CR-X-ROLLBACK-BESTOFEXPORTS-RB123456789012', 88800, { classification: 'not_customer_money' })
  await add(id)
  assert.equal((await q('select count(*)::int c from finance_payment_requests'))[0].c, before)
})

await check('anon has no execute on the function', async () => {
  const [r] = await q(`select has_function_privilege('anon', 'public.create_payment_from_bank_line(uuid, boolean)', 'execute') a,
                              has_function_privilege('authenticated', 'public.create_payment_from_bank_line(uuid, boolean)', 'execute') b`)
  assert.equal(r.a, false); assert.equal(r.b, true)
})

console.log(`all ${n} checks passed`)
