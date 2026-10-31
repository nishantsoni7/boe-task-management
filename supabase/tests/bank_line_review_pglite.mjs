// Database regression suite for 20270514000000 (Bank Statements: Synced is
// checked, and a person reviews every possible duplicate). Same stubs as
// bank_credit_sync_pglite.mjs: auth.uid(), permissions, the columns these
// functions read, submit_payment_request and complete_payment_entry. REAL:
// assert_bank_reconcile_door, link_bank_line_to_payment, classify_bank_line,
// finance_payment_status_is_verified, sync_bank_credits and everything in the
// migration under test. Run:
//   node supabase/tests/bank_line_review_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all 37 checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node bank_line_review_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
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
grant usage on schema auth to anon, authenticated;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create table users (id uuid primary key, role text not null default 'member');
create table grants (user_id uuid, action text);
create function module_entry_open(text) returns boolean language sql as $$ select true $$;
create function actor_has_module_permission(p_module text, p_action text) returns boolean language sql stable as $$
  select exists (select 1 from users where id = auth.uid() and role = 'admin')
      or exists (select 1 from grants where user_id = auth.uid() and action = p_action) $$;
create table bank_statement_imports (id uuid primary key default gen_random_uuid(), account text not null, period_from date not null, period_to date not null);
create table bank_statement_lines (id uuid primary key default gen_random_uuid(), account text not null, line_date date not null,
  seq integer not null default 0, narration text not null, bank_ref text, withdrawal numeric not null default 0, deposit numeric not null default 0,
  classification text, non_customer_kind text, old_order_customer text, old_order_ref text, note text, classified_by uuid, classified_at timestamptz,
  sync_error text, sync_attempted_at timestamptz);
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
const m0329 = mig('20270329000000_finance_bank_statements.sql')
for (const f of ['assert_bank_reconcile_door', 'link_bank_line_to_payment', 'unlink_bank_line_payment', 'classify_bank_line']) await db.exec(extract(m0329, f))
await db.exec(extract(mig('20260918000000_finance_payment_allocations.sql'), 'finance_payment_status_is_verified'))
await db.exec(mig('20270419000000_finance_bank_add_confirmed_payment.sql'))
await db.exec(mig('20270423000000_finance_bank_line_sync.sql'))
await db.exec(mig('20270514000000_finance_bank_line_review.sql'))
await db.exec(`grant select on all tables in schema public to authenticated`)

const as = id => db.exec(`select set_config('request.jwt.claim.sub', '${id ?? ''}', false)`)
const q = async (sql, params) => (await db.query(sql, params)).rows
let seq = 0, payN = 0, tag = 1000
const narration = () => `NEFT CR-KKBK0000958-SOME PAYER-BESTOFEXPORTS-KKBKH2629${++tag}999`
const line = async (deposit, opts = {}) =>
  (await q(`insert into bank_statement_lines (account, line_date, seq, narration, bank_ref, deposit) values ($1,$2,$3,$4,$5,$6) returning id`,
    [opts.account ?? 'hdfc_sec', opts.date ?? '2026-10-28', ++seq, opts.narration ?? narration(), opts.ref ?? null, deposit]))[0].id
const pay = async (amount, opts = {}) => {
  const human = `P-AA-${String(++payN).padStart(4, '0')}`
  const id = (await q(`insert into finance_payment_requests (request_number, human_payment_id, client_name, amount, payment_date, payment_mode, proof_note, status)
    values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    ['R' + payN, human, opts.client ?? 'Client', amount, opts.date ?? '2026-10-28', opts.mode ?? 'hdfc_sec', opts.note ?? null, opts.status ?? 'approved_unlinked']))[0].id
  return { id, human }
}
const call = async (sql, params) => { try { return { ok: (await q(sql, params))[0]?.r || true } } catch (e) { return { err: String(e.message) } } }
const add = (id, checked = [], reason = null) => call('select add_bank_line_to_confirmed($1,$2::uuid[],$3) as r', [id, checked, reason])
const link = (l, p) => call('select link_bank_line_to_payment($1,$2) as r', [l, p])
const unlink = (id, reason) => call('select unlink_bank_line_payment($1,$2) as r', [id, reason])
const sync = ids => call('select sync_bank_credits($1::uuid[]) as r', [ids])
const state = async id => (await q('select * from bank_lines_sync_state($1::uuid[])', [[id]]))[0]
const matches = id => q('select * from bank_lines_recorded_matches($1::uuid[])', [[id]])
const links = id => q('select * from bank_line_payment_links where line_id = $1 and unlinked_at is null', [id])
const payments = async () => (await q('select count(*)::int c from finance_payment_requests'))[0].c
const paymentOf = async id => (await q('select p.* from finance_payment_requests p join bank_line_payment_links k on k.payment_id = p.id where k.line_id = $1 and k.unlinked_at is null', [id]))[0]

let n = 0
const check = (name, fn) => fn().then(() => { n++; console.log('ok  ' + name) }).catch(e => { console.error('FAIL ' + name + '\n' + e.stack); process.exit(1) })

await check('a plain new credit is added through the one door, once', async () => {
  await as(U.admin)
  const l = await line(1000)
  const r = await add(l)
  assert.ok(r.ok, r.err)
  assert.equal((await links(l)).length, 1)
  assert.match((await add(l)).err, /BANK_LINE_ALREADY_LINKED/)
  assert.equal((await paymentOf(l)).sales_note, 'Added from the bank statement')
})

await check('link then add, and add then link, are both refused', async () => {
  await as(U.admin)
  const a = await line(1101); const p = await pay(1101, { date: '2026-08-01' })
  assert.ok((await link(a, p.id)).ok)
  assert.match((await add(a)).err, /BANK_LINE_ALREADY_LINKED/)
  const b = await line(1200); await add(b)
  const other = await pay(1200, { date: '2026-08-01' })
  assert.match((await link(b, other.id)).err, /BANK_LINE_OVER_LINKED/)
})

await check('one payment cannot cover two credits', async () => {
  await as(U.admin)
  const a = await line(1300); const b = await line(1300); const p = await pay(1300)
  assert.ok((await link(a, p.id)).ok)
  assert.match((await link(b, p.id)).err, /BANK_PAYMENT_OVER_LINKED/)
})

await check('sync never adds a possible duplicate, and the database names it', async () => {
  await as(U.admin)
  const p = await pay(2100, { client: 'Sample Client', date: '2026-10-20' }) // too far to be sure
  const l = await line(2100)
  const before = await payments()
  const r = await sync([l])
  assert.equal(r.ok.created, 0); assert.equal(await payments(), before)
  assert.match(r.ok.failed[0].reason, /may already be recorded as/)
  const [m] = await matches(l)
  assert.equal(m.payment_id, p.id); assert.equal(m.match_kind, 'amount'); assert.equal(Number(m.left_to_link), 2100)
  assert.equal(m.human_payment_id, p.human); assert.equal(m.client_name, 'Sample Client')
})

await check('Different payment needs the compared ids and a reason, and writes them on the new payment', async () => {
  await as(U.admin)
  const p = await pay(2200)
  const l = await line(2200)
  assert.match((await add(l)).err, /BANK_MATCHES_CHANGED/)
  assert.match((await add(l, [p.id])).err, /BANK_REASON_REQUIRED/)
  assert.match((await add(l, [p.id], '  x ')).err, /BANK_REASON_REQUIRED/)
  assert.match((await add(l, [p.id], 'y'.repeat(201))).err, /BANK_REASON_TOO_LONG/)
  assert.equal((await links(l)).length, 0)
  assert.ok((await add(l, [p.id], 'Different customer')).ok)
  const made = await paymentOf(l)
  assert.equal(made.sales_note, `Added from the bank statement. Checked against ${p.human}: Different customer`)
  assert.equal(made.submitted_by, U.admin)
})

await check('a payment recorded after the comparison stops the add', async () => {
  await as(U.admin)
  const p1 = await pay(2300)
  const l = await line(2300)
  const p2 = await pay(2300)
  const r = await add(l, [p1.id], 'Different customer')
  assert.match(r.err, /BANK_MATCHES_CHANGED/); assert.ok(r.err.includes(p2.human)); assert.ok(!r.err.includes(p1.human))
  assert.equal((await links(l)).length, 0)
})

await check('the bank reference on a payment with room left can only be linked, never overridden', async () => {
  await as(U.admin)
  const t = 'UTIB26290REVIEW01'
  const p = await pay(2400, { note: 'UTR ' + t, date: '2026-07-01', mode: 'hdfc' })
  const l = await line(2500, { narration: 'RTGS CR-UTIB0000008-X-BESTOFEXPORTS-' + t })
  const [m] = await matches(l)
  assert.equal(m.match_kind, 'reference'); assert.equal(m.payment_id, p.id)
  assert.match((await add(l, [p.id], 'I insist')).err, /BANK_PAYMENT_DUPLICATE/)
  assert.ok((await link(l, p.id)).ok)
})

await check('a reference on a payment in another mode and month is still found', async () => {
  await as(U.admin)
  const t = 'UTIB26290REVIEW02'
  const p = await pay(9000, { note: 'UTR ' + t, date: '2026-05-01', mode: 'pnb' })
  const l = await line(5000, { narration: 'RTGS CR-UTIB0000008-X-BESTOFEXPORTS-' + t })
  const [m] = await matches(l)
  assert.equal(m.payment_id, p.id); assert.equal(m.match_kind, 'reference'); assert.equal(m.payment_mode, 'pnb')
})

await check('a reference on a fully linked payment is never stuck, and never added on its own', async () => {
  await as(U.admin)
  const acct = '99999047729686'
  const first = await line(3000, { narration: `${acct}-TPT-FURNITURE ADVANCE-SAMPLE HOTEL PRIVATE LIMITED` })
  await sync([first])
  const earlier = await paymentOf(first)
  assert.match(earlier.proof_note, new RegExp(acct))
  const second = await line(7000, { date: '2026-10-29', narration: `${acct}-TPT-BALANCE-SAMPLE HOTEL PRIVATE LIMITED` })
  const before = await payments()
  const s = await sync([second])
  assert.equal(s.ok.created, 0); assert.equal(await payments(), before)
  assert.match(s.ok.failed[0].reason, /already on .* linked to another bank line/)
  const [m] = await matches(second)
  assert.equal(m.match_kind, 'reference_used'); assert.equal(m.payment_id, earlier.id); assert.equal(Number(m.left_to_link), 0)
  assert.match((await add(second)).err, /BANK_MATCHES_CHANGED/)
  assert.match((await link(second, earlier.id)).err, /BANK_PAYMENT_OVER_LINKED/)
  assert.ok((await add(second, [earlier.id], 'Second transfer from the same account')).ok)
  assert.equal((await state(second)).issue, null)
})

await check('the same reference on a credit that may be a second stored copy waits for a person', async () => {
  await as(U.admin)
  const t = 'UTIB26290REVIEW03'
  const a = await line(4000, { narration: 'RTGS CR-UTIB0000008-X-BESTOFEXPORTS-' + t })
  await sync([a])
  const b = await line(4000, { narration: 'RTGS CR-UTIB0000008-X Y-BESTOFEXPORTS-' + t })
  const before = await payments()
  assert.equal((await sync([b])).ok.created, 0)
  assert.equal(await payments(), before)
})

await check('a same-amount reference with nothing linked is still linked by sync', async () => {
  await as(U.reconcile)
  const t = 'UTIB26290REVIEW04'
  const p = await pay(5000, { note: 'UTR ' + t, date: '2026-10-10' })
  const l = await line(5000, { narration: 'RTGS CR-UTIB0000008-X-BESTOFEXPORTS-' + t })
  const r = await sync([l])
  assert.equal(r.ok.linked_existing, 1); assert.equal(r.ok.created, 0)
  assert.equal((await links(l))[0].payment_id, p.id)
})

await check('a payment with the rest left to link is a match, so a split credit is not added twice', async () => {
  await as(U.admin)
  const p = await pay(42000)
  const a = await line(21000, { date: '2026-10-20' })
  assert.ok((await link(a, p.id)).ok)
  const b = await line(21000, { date: '2026-10-21' })
  const before = await payments()
  assert.equal((await sync([b])).ok.created, 0); assert.equal(await payments(), before)
  const [m] = await matches(b)
  assert.equal(m.payment_id, p.id); assert.equal(Number(m.left_to_link), 21000)
  assert.ok((await link(b, p.id)).ok)
  assert.equal((await state(a)).issue, null); assert.equal((await state(b)).issue, null)
})

await check('Synced only when verified payments in the same account cover every rupee', async () => {
  await as(U.admin)
  const none = await line(3100)
  let s = await state(none)
  assert.equal(s.issue, 'no_payment'); assert.equal(Number(s.uncovered), 3100)

  const good = await line(3200, { date: '2026-10-01' }); const pGood = await pay(3200, { date: '2026-08-01' }); await link(good, pGood.id)
  s = await state(good)
  assert.equal(s.issue, null); assert.equal(Number(s.uncovered), 0)

  const waiting = await line(3300, { date: '2026-10-01' }); const pW = await pay(3300, { status: 'pending_approval', date: '2026-08-01' }); await link(waiting, pW.id)
  s = await state(waiting)
  assert.equal(s.issue, 'waiting'); assert.equal(Number(s.uncovered), 3300); assert.equal(s.payment_label, pW.human)

  const clarify = await line(3350, { date: '2026-10-01' }); const pC = await pay(3350, { status: 'needs_clarification', date: '2026-08-01' }); await link(clarify, pC.id)
  assert.equal((await state(clarify)).issue, 'waiting')

  const other = await line(3400, { date: '2026-10-01' }); const pO = await pay(3400, { mode: 'hdfc', date: '2026-08-01' }); await link(other, pO.id)
  s = await state(other)
  assert.equal(s.issue, 'other_account'); assert.equal(s.payment_mode, 'hdfc')
})

await check('a linked payment changed later turns the credit back to Not Synced', async () => {
  await as(U.admin)
  const lr = await line(3500, { date: '2026-10-02' }); const pr = await pay(3500, { date: '2026-08-01' }); await link(lr, pr.id)
  assert.equal((await state(lr)).issue, null)
  await q(`update finance_payment_requests set status = 'rejected' where id = $1`, [pr.id])
  let s = await state(lr)
  assert.equal(s.issue, 'payment_rejected'); assert.equal(s.payment_label, pr.human); assert.equal(Number(s.uncovered), 3500)

  const ld = await line(3600, { date: '2026-10-02' }); const pd = await pay(3600, { date: '2026-08-01' }); await link(ld, pd.id)
  await q(`update finance_payment_requests set deleted_at = now() where id = $1`, [pd.id])
  assert.equal((await state(ld)).issue, 'payment_deleted')

  const le = await line(3700, { date: '2026-10-02' }); const pe = await pay(3700, { date: '2026-08-01' }); await link(le, pe.id)
  await q(`update finance_payment_requests set amount = 2000 where id = $1`, [pe.id])
  assert.equal((await state(le)).issue, 'amount_changed')
})

await check('a part-linked credit is Not Synced and says how much is uncovered', async () => {
  await as(U.admin)
  const l = await line(100000, { date: '2026-10-03' }); const p = await pay(60000, { date: '2026-08-01' }); await link(l, p.id)
  const s = await state(l)
  assert.equal(s.issue, 'part_linked'); assert.equal(Number(s.uncovered), 40000)
  const rest = await pay(40000, { date: '2026-08-01' })
  assert.ok((await link(l, rest.id)).ok)
  assert.equal((await state(l)).issue, null)
})

await check('a rejected payment recorded later does not count, and a marked credit has no sync row', async () => {
  await as(U.admin)
  const rejected = await pay(3800, { status: 'rejected' })
  const l = await line(3800)
  assert.equal((await matches(l)).filter(m => m.payment_id === rejected.id).length, 0)
  const marked = await line(3900)
  assert.ok((await call(`select classify_bank_line($1,'not_customer_money','other') as r`, [marked])).ok)
  assert.equal(await state(marked), undefined)
})

await check('unlink needs a reason, keeps it with who and when, and the payment stays', async () => {
  await as(U.admin)
  const l = await line(4100)
  await sync([l])
  const [k] = await links(l)
  assert.match((await unlink(k.id, '')).err, /BANK_REASON_REQUIRED/)
  assert.equal((await links(l)).length, 1)
  assert.ok((await unlink(k.id, 'Wrong payment')).ok)
  const row = (await q('select * from bank_line_payment_links where id = $1', [k.id]))[0]
  assert.equal(row.unlink_reason, 'Wrong payment'); assert.equal(row.unlinked_by, U.admin); assert.ok(row.unlinked_at)
  assert.equal((await q('select count(*)::int c from finance_payment_requests where id = $1', [k.payment_id]))[0].c, 1)
  assert.match((await unlink(k.id, 'Twice')).err, /BANK_LINK_NOT_FOUND/)
})

await check('after an unlink the leftover payment still blocks a second one, and shows as a match', async () => {
  await as(U.admin)
  const l = await line(4200)
  await sync([l])
  const [k] = await links(l)
  await unlink(k.id, 'Wrong payment')
  const before = await payments()
  const [m] = await matches(l)
  assert.equal(m.payment_id, k.payment_id); assert.equal(m.match_kind, 'reference')
  assert.match((await add(l, [k.payment_id], 'Trying again')).err, /BANK_PAYMENT_DUPLICATE/)
  assert.equal(await payments(), before)
  const r = await sync([l])
  assert.equal(r.ok.linked_existing, 1); assert.equal(await payments(), before)
})

await check('the overview covers both accounts, every month, both directions and missing statements', async () => {
  await db.exec(`delete from bank_line_payment_links; delete from bank_statement_lines; delete from finance_payment_requests; delete from bank_statement_imports;`)
  await as(U.admin)
  await q(`insert into bank_statement_imports (account, period_from, period_to) values
    ('hdfc','2026-08-01','2026-08-31'), ('hdfc','2026-08-15','2026-09-10'), ('hdfc','2026-09-20','2026-10-28'), ('hdfc_sec','2026-08-01','2026-10-28')`)
  const open = await line(1500, { account: 'hdfc', date: '2026-09-05' })
  const waiting = await line(2500, { account: 'hdfc', date: '2026-10-05' })
  await link(waiting, (await pay(2500, { mode: 'hdfc', date: '2026-10-05', status: 'pending_approval' })).id)
  const fine = await line(700, { account: 'hdfc_sec', date: '2026-10-07' })
  await link(fine, (await pay(700, { date: '2026-10-07' })).id)
  await pay(900, { mode: 'hdfc_sec', date: '2026-10-09' })
  await pay(800, { mode: 'hdfc', date: '2026-07-09' }) // before the first statement month
  await pay(600, { mode: 'hdfc_sec', date: '2026-10-11', status: 'rejected' })
  await pay(650, { mode: 'pnb', date: '2026-10-11' })
  const r = (await q('select bank_sync_overview() as r'))[0].r
  assert.deepEqual(r.accounts, ['hdfc', 'hdfc_sec'])
  const row = (a, m) => r.months.find(x => x.account === a && x.month === m)
  assert.equal(row('hdfc', '2026-09').not_synced, 1); assert.equal(Number(row('hdfc', '2026-09').not_synced_amount), 1500)
  assert.equal(row('hdfc', '2026-10').not_synced, 1); assert.equal(Number(row('hdfc', '2026-10').not_synced_amount), 2500)
  assert.equal(row('hdfc_sec', '2026-10').not_synced, 0); assert.equal(row('hdfc_sec', '2026-10').not_in_bank, 1)
  assert.equal(r.months.length, 3)
  assert.equal(r.gaps.length, 1)
  assert.deepEqual([r.gaps[0].account, r.gaps[0].gap_from, r.gaps[0].gap_to], ['hdfc', '2026-09-11', '2026-09-19'])
  void open
})

await check('who may call what', async () => {
  await as(U.nocreate)
  const l = await line(5100); const p = await pay(5100)
  assert.ok((await matches(l)).length === 1)
  assert.match((await add(l, [p.id], 'Different')).err, /BANK_CREATE_FORBIDDEN/)
  assert.ok((await link(l, p.id)).ok)
  await as(U.outsider)
  for (const r of [await add(l), await unlink((await links(l))[0].id, 'Nope'), await call('select bank_sync_overview() as r'),
    await call('select * from bank_lines_sync_state($1::uuid[])', [[l]]), await call('select * from bank_lines_recorded_matches($1::uuid[])', [[l]])]) {
    assert.ok(r.err, 'an outsider was let through')
  }
  await as(null)
  assert.ok((await add(l)).err)
})

await check('a browser cannot reach the blanket override, and sync still works from a browser role', async () => {
  await as(U.admin)
  const l = await line(5200)
  const other = await line(5300)
  await pay(5300, { date: '2026-10-20' }) // too far to be sure, so sync leaves it for a person
  await db.exec('set role authenticated')
  const direct = await call('select create_payment_from_bank_line($1, true) as r', [other])
  assert.match(direct.err, /permission denied/)
  for (const sql of ['select bank_line_payment_matches($1) as r', 'select bank_line_sure_payment($1) as r', 'select bank_lines_sync_rows(array[$1]::uuid[]) as r']) {
    assert.match((await call(sql, [other])).err, /permission denied/)
  }
  const r = await sync([l, other])
  await db.exec('reset role')
  assert.equal(r.ok.created, 1); assert.equal(r.ok.failed.length, 1)
  assert.equal((await links(other)).length, 0)
  assert.equal((await links(l)).length, 1)
})

// ── A payment linked to the wrong credit, and links sync makes by itself ─────
// Fresh tables: these checks are about what else is near a credit, so nothing
// from the checks above may stand in the 21-day window.
const wipe = () => db.exec(`delete from bank_line_payment_links; delete from bank_statement_lines; delete from finance_payment_requests;`)
const prepared = async () => { await wipe(); await as(U.admin) }
const synced = (a, b) => ({ account: 'hdfc', date: a, ...b })

await check('the shape of the real case: a payment linked to a later credit shows on the credit it fits, and nothing is added twice', async () => {
  await prepared()
  const p = await pay(500000, { mode: 'hdfc', date: '2026-10-06', client: 'Payer One' })
  const fits = await line(500000, synced('2026-10-06'))
  const later = await line(500000, synced('2026-10-22'))
  assert.ok((await link(later, p.id)).ok)
  const [m] = await matches(fits)
  assert.equal(m.match_kind, 'linked_elsewhere'); assert.equal(m.payment_id, p.id); assert.equal(Number(m.left_to_link), 0)
  assert.equal(m.linked_link_id, (await links(later))[0].id)
  assert.equal(new Date(m.linked_line_date).toISOString().slice(0, 10), '2026-10-22')
  assert.match(m.linked_narration, /SOME PAYER/)

  const before = await payments()
  const s = await sync([fits])
  assert.equal(s.ok.created, 0); assert.equal(s.ok.linked_existing, 0); assert.equal(await payments(), before)
  assert.match(s.ok.failed[0].reason, /^this may be P-AA-\d+, which is linked to another bank line/)
  assert.match((await add(fits)).err, /BANK_MATCHES_CHANGED/)
  assert.match((await link(fits, p.id)).err, /BANK_PAYMENT_OVER_LINKED/)
  assert.equal(await payments(), before)
})

await check('the fix for it: unlink with a reason, link the right credit, and the other credit becomes a plain add', async () => {
  await prepared()
  const p = await pay(500000, { mode: 'hdfc', date: '2026-10-06' })
  const fits = await line(500000, synced('2026-10-06'))
  const later = await line(500000, synced('2026-10-22'))
  await link(later, p.id)
  const [m] = await matches(fits)
  assert.ok((await unlink(m.linked_link_id, 'Paid by another customer')).ok)
  const [now] = await matches(fits)
  assert.equal(now.match_kind, 'amount'); assert.equal(Number(now.left_to_link), 500000)
  assert.ok((await link(fits, p.id)).ok)
  assert.equal((await state(fits)).issue, null)
  assert.deepEqual(await matches(later), [])
  assert.ok((await add(later)).ok)
  assert.equal((await state(later)).issue, null)
})

await check('still a different payment if a person says so, with the reason kept', async () => {
  await prepared()
  const p = await pay(500000, { mode: 'hdfc', date: '2026-10-06' })
  const fits = await line(500000, synced('2026-10-06'))
  const later = await line(500000, synced('2026-10-22'))
  await link(later, p.id)
  assert.match((await add(fits, [p.id])).err, /BANK_REASON_REQUIRED/)
  assert.ok((await add(fits, [p.id], 'Second payment that day')).ok)
  assert.match((await paymentOf(fits)).sales_note, /Checked against P-AA-\d+: Second payment that day/)
})

await check('not flagged: a credit no closer than the one linked, another amount, a part link, or past 21 days', async () => {
  await prepared()
  const p = await pay(500000, { mode: 'hdfc', date: '2026-10-06' })
  const own = await line(500000, synced('2026-10-06'))
  await link(own, p.id)
  const near = await line(500000, synced('2026-10-07'))
  assert.deepEqual(await matches(near), [])

  await wipe()
  const q2 = await pay(500000, { mode: 'hdfc', date: '2026-10-06' })
  const far = await line(500000, synced('2026-10-10'))
  await link(far, q2.id)
  const sameGap = await line(500000, synced('2026-10-02'))
  assert.deepEqual(await matches(sameGap), [], 'as far as the linked credit, so nothing says the link is wrong')
  assert.deepEqual(await matches(await line(400000, synced('2026-10-06'))), [])

  await wipe()
  const q3 = await pay(500000, { mode: 'hdfc', date: '2026-10-06' })
  const big = await line(900000, synced('2026-10-20'))
  await call('select link_bank_line_to_payment($1,$2,$3) as r', [big, q3.id, 200000])
  assert.deepEqual(await matches(await line(500000, synced('2026-10-06'))), [], 'a part link leaves the payment open, so the amount rule cannot apply either')

  await wipe()
  const q4 = await pay(500000, { mode: 'hdfc', date: '2026-10-06' })
  await link(await line(500000, synced('2026-12-01')), q4.id)
  assert.deepEqual(await matches(await line(500000, synced('2026-10-28'))), [], '22 days away')
})

await check('the nearest payment comes first, so the reason on the row names the likeliest one', async () => {
  await prepared()
  const far = await pay(500000, { mode: 'hdfc', date: '2026-09-26' })
  const close = await pay(500000, { mode: 'hdfc', date: '2026-10-06' })
  const later = await line(500000, synced('2026-10-22'))
  await link(later, close.id)
  const fits = await line(500000, synced('2026-10-06'))
  assert.deepEqual((await matches(fits)).map(m => [m.payment_id, m.match_kind]), [[close.id, 'linked_elsewhere'], [far.id, 'amount']])
})

await check('sync links a payment recorded first, and adds nothing', async () => {
  await prepared()
  const p = await pay(1000000, { mode: 'hdfc', date: '2026-10-06' })
  const l = await line(1000000, synced('2026-10-06'))
  await q('update bank_statement_lines set sync_error = $2 where id = $1', [l, 'stale'])
  const before = await payments()
  const r = await sync([l])
  assert.equal(r.ok.linked_existing, 1); assert.equal(r.ok.created, 0); assert.deepEqual(r.ok.failed, [])
  assert.equal(await payments(), before)
  assert.equal((await links(l))[0].payment_id, p.id)
  assert.equal((await links(l))[0].linked_by, U.admin)
  assert.equal((await q('select sync_error from bank_statement_lines where id = $1', [l]))[0].sync_error, null)
  assert.equal((await state(l)).issue, null)
})

await check('three days either way is sure, four is not; an unverified payment links and waits', async () => {
  await prepared()
  const a = await pay(1100, { mode: 'hdfc', date: '2026-10-03' })
  const before = await line(1100, synced('2026-10-06'))
  const b = await pay(1200, { mode: 'hdfc', date: '2026-10-09' })
  const after = await line(1200, synced('2026-10-06'))
  const c = await pay(1300, { mode: 'hdfc', date: '2026-10-02' })
  const four = await line(1300, synced('2026-10-06'))
  const d = await pay(1400, { mode: 'hdfc', date: '2026-10-06', status: 'pending_approval' })
  const waits = await line(1400, synced('2026-10-06'))
  const r = await sync([before, after, four, waits])
  assert.equal(r.ok.linked_existing, 3); assert.equal(r.ok.created, 0); assert.equal(r.ok.failed.length, 1)
  assert.equal((await links(before))[0].payment_id, a.id)
  assert.equal((await links(after))[0].payment_id, b.id)
  assert.equal((await links(four)).length, 0)
  assert.equal((await matches(four))[0].payment_id, c.id)
  assert.equal((await links(waits))[0].payment_id, d.id)
  assert.equal((await state(waits)).issue, 'waiting')
})

await check('two credits for one payment: neither is linked, in either order, and nothing is added', async () => {
  await prepared()
  const p = await pay(500000, { mode: 'hdfc', date: '2026-09-26', client: 'Payer Two' })
  const earlier = await line(500000, synced('2026-09-23'))
  const same = await line(500000, synced('2026-09-26'))
  const before = await payments()
  for (const ids of [[earlier, same], [same, earlier]]) {
    const r = await sync(ids)
    assert.equal(r.ok.linked_existing, 0); assert.equal(r.ok.created, 0); assert.equal(r.ok.failed.length, 2)
  }
  assert.equal(await payments(), before)
  assert.ok((await link(same, p.id)).ok, 'a person links the right one')
  assert.ok((await sync([earlier])).ok.created === 1, 'and the other is then its own payment')
})

await check('two payments for one credit: not linked, and a person chooses', async () => {
  await prepared()
  const a = await pay(700000, { mode: 'hdfc', date: '2026-10-05' })
  const b = await pay(700000, { mode: 'hdfc', date: '2026-10-07' })
  const l = await line(700000, synced('2026-10-06'))
  const before = await payments()
  const r = await sync([l])
  assert.equal(r.ok.linked_existing, 0); assert.equal(r.ok.created, 0); assert.equal(await payments(), before)
  assert.deepEqual((await matches(l)).map(m => m.payment_id).sort(), [a.id, b.id].sort())
})

await check('never sure: another account, a rejected or deleted payment, or a part-linked payment', async () => {
  await prepared()
  const other = await pay(2100, { mode: 'hdfc_sec', date: '2026-10-06' })
  const l1 = await line(2100, synced('2026-10-06'))
  const r1 = await sync([l1])
  assert.equal(r1.ok.linked_existing, 0); assert.equal(r1.ok.created, 0)
  assert.equal((await matches(l1))[0].payment_id, other.id)

  await pay(2200, { mode: 'hdfc', date: '2026-10-06', status: 'rejected' })
  const l2 = await line(2200, synced('2026-10-06'))
  const r2 = await sync([l2])
  assert.equal(r2.ok.linked_existing, 0); assert.equal(r2.ok.created, 1)

  const gone = await pay(2300, { mode: 'hdfc', date: '2026-10-06' })
  await q('update finance_payment_requests set deleted_at = now() where id = $1', [gone.id])
  const l3 = await line(2300, synced('2026-10-06'))
  assert.equal((await sync([l3])).ok.created, 1)

  const part = await pay(4000, { mode: 'hdfc', date: '2026-10-06' })
  await call('select link_bank_line_to_payment($1,$2,$3) as r', [await line(9000, synced('2026-10-06')), part.id, 2000])
  const l4 = await line(2000, synced('2026-10-06'))
  const r4 = await sync([l4])
  assert.equal(r4.ok.linked_existing, 0); assert.equal(r4.ok.created, 0)
  assert.equal(Number((await matches(l4))[0].left_to_link), 2000)
})

await check('a payment goes to the credit in its own account, even when a same-amount credit in the other account comes first', async () => {
  await prepared()
  const p = await pay(2600, { mode: 'hdfc_sec', date: '2026-10-06' })
  const otherAccount = await line(2600, synced('2026-10-05'))
  const ownAccount = await line(2600, { account: 'hdfc_sec', date: '2026-10-06' })
  const r = await sync([otherAccount, ownAccount])
  assert.equal(r.ok.linked_existing, 1); assert.equal(r.ok.created, 0)
  assert.equal((await links(otherAccount)).length, 0)
  assert.equal((await links(ownAccount))[0].payment_id, p.id)
})

await check('a payment goes to the credit within three days, even when one four days away comes first', async () => {
  await prepared()
  const p = await pay(2700, { mode: 'hdfc', date: '2026-10-10' })
  const fourDays = await line(2700, synced('2026-10-06'))
  const threeDays = await line(2700, synced('2026-10-07'))
  const r = await sync([fourDays, threeDays])
  assert.equal(r.ok.linked_existing, 1); assert.equal(r.ok.created, 0)
  assert.equal((await links(fourDays)).length, 0)
  assert.equal((await links(threeDays))[0].payment_id, p.id)
})

await check('a credit a person marked does not stand in the way of the one that is left', async () => {
  await prepared()
  const p = await pay(3100, { mode: 'hdfc', date: '2026-10-06' })
  const marked = await line(3100, synced('2026-10-06'))
  await call(`select classify_bank_line($1,'not_customer_money','other') as r`, [marked])
  const l = await line(3100, synced('2026-10-07'))
  assert.equal((await sync([l])).ok.linked_existing, 1)
  assert.equal((await links(l))[0].payment_id, p.id)
})

await check('a bank reference on another payment beats a same-amount payment close by', async () => {
  await prepared()
  const t = 'UTIB26290REVIEW05'
  const byRef = await pay(6100, { mode: 'hdfc', date: '2026-07-01', note: 'UTR ' + t })
  await pay(6100, { mode: 'hdfc', date: '2026-10-06' })
  const l = await line(6100, synced('2026-10-06', { narration: 'RTGS CR-UTIB0000008-X-BESTOFEXPORTS-' + t }))
  const r = await sync([l])
  assert.equal(r.ok.linked_existing, 1)
  assert.equal((await links(l))[0].payment_id, byRef.id)
})

await check('a wrong link elsewhere stops a sure-looking link too', async () => {
  await prepared()
  const held = await pay(7100, { mode: 'hdfc', date: '2026-10-06' })
  await link(await line(7100, synced('2026-10-20')), held.id)
  const free = await pay(7100, { mode: 'hdfc', date: '2026-10-08' })
  const l = await line(7100, synced('2026-10-06'))
  const r = await sync([l])
  assert.equal(r.ok.linked_existing, 0); assert.equal(r.ok.created, 0); assert.equal((await links(l)).length, 0)
  assert.deepEqual((await matches(l)).map(m => m.payment_id), [held.id, free.id])
})

await check('both new rules on one statement: the six clear credits link, the two unclear ones wait, and nothing is added', async () => {
  await prepared()
  const sure = [
    [1100000, '2026-10-06', '2026-10-06'], [4321098.7, '2026-10-07', '2026-10-07'], [52000, '2026-10-06', '2026-10-06'],
    [53000, '2026-09-30', '2026-09-30'], [610000, '2026-09-23', '2026-09-23'], [140375, '2026-09-23', '2026-09-23'],
  ]
  const pairs = []
  for (const [amount, lineDate, payDate] of sure) {
    pairs.push({ line: await line(amount, synced(lineDate)), pay: await pay(amount, { mode: 'hdfc', date: payDate }) })
  }
  const wrong = await pay(500000, { mode: 'hdfc', date: '2026-10-06' })
  await link(await line(500000, synced('2026-10-22')), wrong.id)
  const fits = await line(500000, synced('2026-10-06'))
  const twoCredits = await pay(500000, { mode: 'hdfc', date: '2026-09-26' })
  const earlier = await line(500000, synced('2026-09-23'))
  const same = await line(500000, synced('2026-09-26'))
  const before = await payments()

  const r = await sync([...pairs.map(p => p.line), fits, earlier, same])
  assert.equal(r.ok.linked_existing, 6); assert.equal(r.ok.created, 0); assert.equal(r.ok.failed.length, 3)
  assert.equal(await payments(), before)
  for (const p of pairs) assert.equal((await links(p.line))[0].payment_id, p.pay.id)
  assert.equal((await links(fits)).length, 0); assert.equal((await links(earlier)).length, 0); assert.equal((await links(same)).length, 0)
  assert.equal((await matches(fits))[0].payment_id, wrong.id)
  assert.ok((await matches(same)).some(m => m.payment_id === twoCredits.id))
})

console.log(`all ${n} checks passed`)
