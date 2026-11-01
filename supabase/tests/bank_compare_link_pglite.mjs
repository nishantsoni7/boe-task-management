// Database regression suite for 20270517000000 (Bank Statements ID, Not this one,
// search of the money not matched yet). Stubs: auth.uid(), permissions, and the
// columns these functions read. REAL: assert_bank_reconcile_door and everything in
// the migration under test. Run:
//   node supabase/tests/bank_compare_link_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all 27 checks passed".
// Set BANK_COMPARE_MIGRATION to another file to run these checks against a broken copy.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node bank_compare_link_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const migrationFile = process.env.BANK_COMPARE_MIGRATION ?? `${REPO}/supabase/migrations/20270517000000_finance_bank_line_ids_and_match_search.sql`
const migration = readFileSync(migrationFile, 'utf8')

const door = (() => {
  const text = readFileSync(`${REPO}/supabase/migrations/20270329000000_finance_bank_statements.sql`, 'utf8').replace(/\r/g, '')
  const from = text.indexOf('create or replace function public.assert_bank_reconcile_door()')
  return text.slice(from, text.indexOf('$fn$;', from) + 5)
})()

const U = {
  bank:  '00000000-0000-0000-0000-0000000000a1', // reconcile
  sales: '00000000-0000-0000-0000-0000000000e5', // nothing
}

async function fresh() {
  const db = new PGlite()
  await db.exec(`
create role anon nologin; create role authenticated nologin;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create table users (id uuid primary key);
create table grants (user_id uuid, action text);
create function module_entry_open(text) returns boolean language sql as $$ select true $$;
create function actor_has_module_permission(p_module text, p_action text) returns boolean language sql stable as $$
  select exists (select 1 from grants where user_id = auth.uid() and action = p_action) $$;
create table bank_statement_lines (id uuid primary key default gen_random_uuid(), account text not null, line_date date not null,
  seq integer not null default 0, narration text not null, bank_ref text, withdrawal numeric not null default 0, deposit numeric not null default 0,
  classification text);
create table finance_payment_requests (id uuid primary key default gen_random_uuid(), amount numeric);
create table bank_line_payment_links (id uuid primary key default gen_random_uuid(), line_id uuid not null references bank_statement_lines(id),
  payment_id uuid not null references finance_payment_requests(id), amount numeric not null, unlinked_at timestamptz);
insert into users values ('${U.bank}'), ('${U.sales}');
insert into grants values ('${U.bank}', 'reconcile');
`)
  await db.exec(door)
  return db
}

const db = await fresh()
const q = async (sql, params) => (await db.query(sql, params)).rows
const as = id => db.exec(`select set_config('request.jwt.claim.sub', '${id ?? ''}', false)`)
let seq = 0
const line = async (deposit, opts = {}) =>
  (await q(`insert into bank_statement_lines (account, line_date, seq, narration, bank_ref, deposit, withdrawal, classification)
    values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [opts.account ?? 'hdfc', opts.date ?? '2026-10-06', opts.seq ?? ++seq, opts.narration ?? `NEFT CR-SOME PAYER-${seq}`, opts.ref ?? null,
      deposit, opts.withdrawal ?? 0, opts.classification ?? null]))[0].id
const no = async id => Number((await q('select statement_no from bank_statement_lines where id = $1', [id]))[0].statement_no)
const pay = async () => (await q(`insert into finance_payment_requests (amount) values (100) returning id`))[0].id
const call = async (sql, params) => { try { return { rows: await q(sql, params) } } catch (e) { return { err: String(e.message) } } }
const dismiss = (p, l) => call('select dismiss_bank_match($1, $2)', [p, l])
const restore = (p, l) => call('select restore_bank_match($1, $2)', [p, l])
const search = async (text, date = null) => {
  const r = await call('select * from search_bank_unmatched($1, $2)', [text, date])
  if (r.err) throw new Error(r.err)
  return r.rows
}
const found = async (text, id, date = null) => (await search(text, date)).some(r => r.line_id === id)
const active = async (p, l) => Number((await q('select count(*) c from bank_match_dismissals where payment_id = $1 and line_id = $2 and undone_at is null', [p, l]))[0].c)

let n = 0
const check = async (name, fn) => { await fn(); console.log(`ok ${++n} ${name}`) }

// ── Lines already there on the day it arrives ───────────────────────────────
const late = await line(100, { date: '2026-10-09', narration: 'LATE', seq: 1 })
const secFirst = await line(100, { date: '2026-10-08', account: 'hdfc_sec', seq: 7 })
const priB = await line(100, { date: '2026-10-08', account: 'hdfc', seq: 9 })
const priA = await line(100, { date: '2026-10-08', account: 'hdfc', seq: 2 })
const old = await line(0, { date: '2026-10-01', withdrawal: 40, narration: 'A DEBIT', seq: 3 })

await db.exec(migration)

await check('every line already there is numbered oldest first, debits too, both accounts in one run', async () => {
  assert.deepEqual([await no(old), await no(priA), await no(priB), await no(secFirst), await no(late)], [1, 2, 3, 4, 5])
})

await check('a new upload carries on from the last number, in either account', async () => {
  assert.equal(await no(await line(100, { account: 'hdfc_sec' })), 6)
  assert.equal(await no(await line(100)), 7)
})

await check('the migration can be run twice, and nobody is renumbered', async () => {
  await db.exec(migration)
  assert.equal(await no(late), 5)
  assert.equal(await no(await line(100)), 8)
})

await check('two lines cannot share a number', async () => {
  await assert.rejects(q('update bank_statement_lines set statement_no = 5 where id = $1', [old]), /unique/)
})

await check('a browser can read a line but not write the number', async () => {
  const r = await q(`select has_column_privilege('authenticated', 'bank_match_dismissals', 'id', 'select') as read,
    has_table_privilege('authenticated', 'bank_match_dismissals', 'insert') as ins`)
  assert.deepEqual(r[0], { read: true, ins: false })
})

await check('on an empty table it starts at 1', async () => {
  const empty = await fresh()
  await empty.exec(migration)
  const r = await empty.query(`insert into bank_statement_lines (account, line_date, narration, deposit) values ('hdfc','2026-10-01','X',1) returning statement_no`)
  assert.equal(Number(r.rows[0].statement_no), 1)
})

// ── Not this one ────────────────────────────────────────────────────────────
await as(U.bank)
const p1 = await pay()
const c1 = await line(5000)

await check('it records who rejected which credit for which payment', async () => {
  assert.equal((await dismiss(p1, c1)).err, undefined)
  const row = (await q('select * from bank_match_dismissals where payment_id = $1', [p1]))[0]
  assert.equal(row.dismissed_by, U.bank)
  assert.equal(row.line_id, c1)
})

await check('twice is the same as once', async () => {
  assert.equal((await dismiss(p1, c1)).err, undefined)
  assert.equal(await active(p1, c1), 1)
})

await check('undo keeps the row, with who undid it', async () => {
  assert.equal((await restore(p1, c1)).err, undefined)
  assert.equal(await active(p1, c1), 0)
  const row = (await q('select * from bank_match_dismissals where payment_id = $1', [p1]))[0]
  assert.equal(row.undone_by, U.bank)
})

await check('it can be rejected again after an undo', async () => {
  assert.equal((await dismiss(p1, c1)).err, undefined)
  assert.equal(await active(p1, c1), 1)
})

await check('undo with nothing to undo does nothing', async () => {
  assert.equal((await restore(p1, await line(1))).err, undefined)
})

await check('no bank access: rejecting, undoing and searching are all refused', async () => {
  await as(U.sales)
  assert.match((await dismiss(p1, c1)).err, /BANK_FORBIDDEN/)
  assert.match((await restore(p1, c1)).err, /BANK_FORBIDDEN/)
  await assert.rejects(search('NEFT'), /BANK_FORBIDDEN/)
  await as(U.bank)
})

await check('signed out: refused', async () => {
  await as(null)
  assert.match((await dismiss(p1, c1)).err, /BANK_UNAUTHENTICATED/)
  await as(U.bank)
})

await check('a debit cannot be rejected as a match, and nor can a line that is not there', async () => {
  assert.match((await dismiss(p1, old)).err, /BANK_LINE_NOT_FOUND/)
  assert.match((await dismiss(p1, '00000000-0000-0000-0000-000000000099')).err, /BANK_LINE_NOT_FOUND/)
  assert.match((await dismiss('00000000-0000-0000-0000-000000000099', c1)).err, /BANK_PAYMENT_NOT_FOUND/)
})

// ── Search ──────────────────────────────────────────────────────────────────
const named = await line(375000, { narration: 'NEFT CR-SAMPLE HOTELS LLP-BEST OF EXPORTS', ref: 'SAMP26279000111', date: '2026-10-20' })
const namedNo = await no(named)

await check('by Bank Statements ID, however it is typed', async () => {
  for (const t of [`BS-${String(namedNo).padStart(5, '0')}`, `bs-${namedNo}`, `bs${namedNo}`, ` BS-${namedNo} `]) assert.ok(await found(t, named), t)
})

await check('an ID finds that line only', async () => {
  assert.deepEqual((await search(`BS-${namedNo}`)).map(r => r.line_id), [named])
  assert.deepEqual((await search(`BS-${await no(c1)}`)).map(r => r.line_id), [c1], 'lines numbered after it stay out')
})

await check('by name, in any case', async () => { assert.ok(await found('sample hotels', named)) })
await check('by UTR', async () => { assert.ok(await found('26279000111', named)) })
await check('by amount, with or without commas and the rupee sign', async () => {
  for (const t of ['375000', '3,75,000', '₹3,75,000.00', '375000.00']) assert.ok(await found(t, named), t)
})
await check('by date', async () => {
  assert.ok(await found('', named, '2026-10-20'))
  assert.equal(await found('', named, '2026-10-21'), false)
})

await check('it says what is left on a credit partly used, and finds it by that amount too', async () => {
  const c = await line(1000, { narration: 'PART USED' })
  await q(`insert into bank_line_payment_links (line_id, payment_id, amount) values ($1, $2, 400)`, [c, await pay()])
  const row = (await search('PART USED')).find(r => r.line_id === c)
  assert.equal(Number(row.remaining), 600)
  assert.ok(await found('600', c))
})

await check('a credit used up is not offered, until it is unlinked', async () => {
  const c = await line(700, { narration: 'USED UP' })
  await q(`insert into bank_line_payment_links (line_id, payment_id, amount) values ($1, $2, 700)`, [c, await pay()])
  assert.equal(await found('USED UP', c), false)
  await q(`update bank_line_payment_links set unlinked_at = now() where line_id = $1`, [c])
  assert.ok(await found('USED UP', c))
})

await check('a credit marked old order or not customer money, and a debit, are not offered', async () => {
  const c = await line(800, { narration: 'MARKED LINE', classification: 'old_order' })
  assert.equal(await found('MARKED LINE', c), false)
  assert.equal(await found('A DEBIT', old), false)
})

await check('a rejected credit can still be found, so a mistake can never block a payment', async () => {
  assert.equal(await active(p1, c1), 1)
  assert.ok(await found(`BS-${await no(c1)}`, c1))
})

await check('both accounts are searched', async () => {
  const c = await line(900, { account: 'hdfc_sec', narration: 'OTHER ACCOUNT LINE' })
  assert.equal((await search('OTHER ACCOUNT LINE')).find(r => r.line_id === c).account, 'hdfc_sec')
})

await check('too short a search asks for nothing, and % and _ are plain characters', async () => {
  assert.deepEqual(await search('N'), [])
  assert.deepEqual(await search(''), [])
  assert.deepEqual(await search('%%'), [])
  assert.deepEqual(await search('__'), [])
})

await check('it stops at 50, newest first', async () => {
  for (let i = 0; i < 55; i++) await line(10, { narration: 'MANY LINES', date: `2026-09-${String((i % 28) + 1).padStart(2, '0')}` })
  const r = await search('MANY LINES')
  assert.equal(r.length, 50)
  assert.ok(r[0].line_date >= r[49].line_date)
})

assert.equal(n, 27)
console.log(`all ${n} checks passed`)
