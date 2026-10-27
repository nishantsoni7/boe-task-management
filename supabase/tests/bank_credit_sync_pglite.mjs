// Database regression suite for 20270423000000 (Bank Statements: sync bank
// credits into Confirmed Payments). Same stubs as bank_add_confirmed_payment_pglite.mjs;
// the REAL create_payment_from_bank_line, link_bank_line_to_payment and
// assert_bank_reconcile_door are applied. Run:
//   node supabase/tests/bank_credit_sync_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all 9 checks passed".
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
  seq integer not null default 0, narration text not null, bank_ref text, withdrawal numeric not null default 0, deposit numeric not null default 0, classification text, sync_error text, sync_attempted_at timestamptz);
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
await db.exec(extract(mig('20270329000000_finance_bank_statements.sql'), 'link_bank_line_to_payment'))
await db.exec(mig('20270419000000_finance_bank_add_confirmed_payment.sql'))
await db.exec(mig('20270423000000_finance_bank_credit_sync.sql'))

const as = id => db.exec(`select set_config('request.jwt.claim.sub', '${id ?? ''}', false)`)
const q = async (sql, params) => (await db.query(sql, params)).rows
let seq = 0
const line = async (narration, deposit, opts = {}) =>
  (await q(`insert into bank_statement_lines (account, line_date, seq, narration, deposit, withdrawal, classification)
            values ('hdfc', $1, $2, $3, $4, $5, $6) returning id`,
    [opts.date ?? '2026-10-19', ++seq, narration, opts.debit ? 0 : deposit, opts.debit ? deposit : 0, opts.classification ?? null]))[0].id
const sync = async ids => { try { return { ok: (await q('select sync_bank_credits($1::uuid[]) as r', [ids]))[0].r } } catch (e) { return { err: String(e.message) } } }
const linksOf = async id => q('select * from bank_line_payment_links where line_id = $1 and unlinked_at is null', [id])
const lineRow = async id => (await q('select * from bank_statement_lines where id = $1', [id]))[0]

let n = 0
const check = (name, fn) => fn().then(() => { n++; console.log('ok  ' + name) }).catch(e => { console.error('FAIL ' + name + '\n' + e.stack); process.exit(1) })

await check('syncs new credits into linked payments, one each', async () => {
  await as(U.reconcile)
  const a = await line('NEFT CR-AAAA0000001-ALPHA TRADERS-BESTOFEXPORTS-ALP1234567890', 1000)
  const b = await line('NEFT CR-AAAA0000001-BETA TRADERS-BESTOFEXPORTS-BET1234567890', 2000)
  const { ok, err } = await sync([a, b])
  assert.ok(ok, err)
  assert.equal(ok.created, 2); assert.equal(ok.failed.length, 0)
  assert.equal((await linksOf(a)).length, 1); assert.equal((await linksOf(b)).length, 1)
})

await check('running it again is a no-op: already synced, no second payment', async () => {
  await as(U.reconcile)
  const a = await line('NEFT CR-AAAA0000001-GAMMA TRADERS-BESTOFEXPORTS-GAM1234567890', 3000)
  assert.equal((await sync([a])).ok.created, 1)
  const again = await sync([a])
  assert.equal(again.ok.created, 0); assert.equal(again.ok.already_synced, 1)
  assert.equal((await q(`select count(*)::int c from finance_payment_requests where proof_note like '%GAM1234567890%'`))[0].c, 1)
})

await check('a credit whose reference is on a same-amount unlinked payment is linked to it, not duplicated', async () => {
  await as(U.reconcile)
  await q(`insert into finance_payment_requests (request_number, human_payment_id, amount, payment_date, payment_mode, proof_note, submitted_by)
           values ('PAY-REQ-S1','P-AA-0501', 5000, '2026-10-10', 'hdfc', 'UTR UTIB26290SYNC001 received', $1)`, [U.reconcile])
  const id = await line('RTGS CR-UTIB0000008-SOME PAYER-BESTOFEXPORTS-UTIB26290SYNC001', 5000)
  const r = await sync([id])
  assert.equal(r.ok.linked_existing, 1); assert.equal(r.ok.created, 0)
  const links = await linksOf(id)
  assert.equal(links.length, 1)
  assert.equal((await q(`select human_payment_id from finance_payment_requests where id = $1`, [links[0].payment_id]))[0].human_payment_id, 'P-AA-0501')
})

await check('same reference but a different amount is Not Synced with the reason, nothing created', async () => {
  await as(U.reconcile)
  await q(`insert into finance_payment_requests (request_number, human_payment_id, amount, payment_date, payment_mode, proof_note, submitted_by)
           values ('PAY-REQ-S2','P-AA-0502', 9000, '2026-10-10', 'hdfc', 'UTR UTIB26290SYNC002 received', $1)`, [U.reconcile])
  const id = await line('RTGS CR-UTIB0000008-SOME PAYER-BESTOFEXPORTS-UTIB26290SYNC002', 5000)
  const r = await sync([id])
  assert.equal(r.ok.failed.length, 1); assert.match(r.ok.failed[0].reason, /P-AA-0502/)
  assert.equal((await linksOf(id)).length, 0)
  assert.match((await lineRow(id)).sync_error, /P-AA-0502/)
})

await check('a possible duplicate (same amount within 21 days, no shared reference) is Not Synced, never added', async () => {
  await as(U.reconcile)
  await q(`insert into finance_payment_requests (request_number, human_payment_id, amount, payment_date, payment_mode, submitted_by, client_name)
           values ('PAY-REQ-S3','P-AA-0503', 123456, '2026-10-12', 'hdfc', $1, 'Maybe Same Ltd')`, [U.reconcile])
  const id = await line('NEFT CR-ICIC0000001-MAYBE SAME LTD-BESTOFEXPORTS-MAY12345678901', 123456)
  const r = await sync([id])
  assert.equal(r.ok.created, 0); assert.match(r.ok.failed[0].reason, /may already be recorded as .*P-AA-0503/)
  assert.equal((await linksOf(id)).length, 0)
})

await check('one bad line does not stop the others, and a later success clears its error', async () => {
  await as(U.reconcile)
  await q(`insert into finance_payment_requests (request_number, human_payment_id, amount, payment_date, payment_mode, submitted_by)
           values ('PAY-REQ-S4','P-AA-0504', 31337, '2026-10-12', 'hdfc', $1)`, [U.reconcile])
  const bad = await line('NEFT CR-A-BAD-BESTOFEXPORTS-BAD12345678901', 31337)
  const good = await line('NEFT CR-A-GOOD-BESTOFEXPORTS-GOOD1234567890', 4242)
  const r = await sync([bad, good])
  assert.equal(r.ok.created, 1); assert.equal(r.ok.failed.length, 1)
  assert.equal((await linksOf(good)).length, 1); assert.equal((await lineRow(good)).sync_error, null)
  assert.ok((await lineRow(bad)).sync_error)
  await q(`update finance_payment_requests set status = 'rejected' where human_payment_id = 'P-AA-0504'`)
  const retry = await sync([bad])
  assert.equal(retry.ok.created, 1, retry.err)
  assert.equal((await lineRow(bad)).sync_error, null)
})

await check('marked credits and debits are skipped silently', async () => {
  await as(U.reconcile)
  const old = await line('NEFT CR-OLD-CUSTOMER-BESTOFEXPORTS-OLD12345678901', 4000, { classification: 'old_order' })
  const debit = await line('NEFT DR-SUPPLIER', 4000, { debit: true })
  const r = await sync([old, debit])
  assert.equal(r.ok.created, 0); assert.equal(r.ok.failed.length, 0)
  assert.equal((await linksOf(old)).length, 0); assert.equal((await linksOf(debit)).length, 0)
})

await check('an admin gets the payments verified at once; others leave them awaiting verification', async () => {
  await as(U.admin)
  const a = await line('NEFT CR-ADM-ADMIN TRADERS-BESTOFEXPORTS-ADM1234567890', 7000)
  await sync([a])
  assert.equal((await q('select status from finance_payment_requests where id = $1', [(await linksOf(a))[0].payment_id]))[0].status, 'approved_unlinked')
  await as(U.reconcile)
  const b = await line('NEFT CR-REC-OTHER TRADERS-BESTOFEXPORTS-REC1234567890', 7100)
  await sync([b])
  assert.equal((await q('select status from finance_payment_requests where id = $1', [(await linksOf(b))[0].payment_id]))[0].status, 'pending_approval')
})

await check('needs finance.create and the bank door; refuses more than 200 lines', async () => {
  const id = await line('NEFT CR-NO-CREATE TRADERS-BESTOFEXPORTS-NOC1234567890', 100)
  await as(U.nocreate); assert.match((await sync([id])).err, /BANK_CREATE_FORBIDDEN/)
  await as(U.outsider); assert.ok((await sync([id])).err)
  await as(U.reconcile)
  assert.match((await sync(Array.from({ length: 201 }, () => id))).err, /BANK_SYNC_TOO_MANY/)
  assert.equal((await linksOf(id)).length, 0)
})

console.log(`all ${n} checks passed`)
