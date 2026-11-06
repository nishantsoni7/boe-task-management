// Database regression suite for 20270605000000 (a review month that is still open follows the
// monthly review target saved now; a qualified or closed month keeps the one it has).
//
// Replays the REAL BOE Credits migration chain on an in-memory Postgres (PGlite), the same chain
// run_custom_review_submissions_local.sh builds on a bare container: the test-only baseline 002,
// the four prerequisites, stubs 003, 20261104000000, stubs 004 and 005, then 20261204000000 to
// 20261207000000. Then it REPRODUCES the reported defect on that schema (the target is lowered and
// nothing moves), applies 20270605000000 (twice) and checks the rule.
//
// NOT part of npm test (PGlite is not an app dependency). Run:
//   node supabase/tests/boe_credits_open_months_target_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all N checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node boe_credits_open_months_target_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = rel => readFileSync(`${REPO}/${rel}`, 'utf8')
const mig = name => read(`supabase/migrations/${name}`)
const boot = name => read(`supabase/tests/bootstrap/${name}`)
const MIGRATION = mig('20270605000000_boe_credits_open_months_follow_target.sql')

/** The chain, in the order run_custom_review_submissions_local.sh applies it. */
async function buildChain() {
  const db = new PGlite()
  for (const sql of [
    boot('002_boe_credits_baseline.sql'),
    mig('20260611_create_payroll_periods.sql'),
    mig('20260612000000_create_payroll_generation_tables.sql'),
    mig('20260616_add_generated_status_to_payroll_periods.sql'),
    mig('20261101000000_boe_credits_foundation.sql'),
    mig('20261103000000_boe_credits_attendance_redemption.sql'),
    boot('003_boe_credits_phase_1d_stubs.sql'),
    mig('20261104000000_boe_credits_phase_1d.sql'),
    boot('004_decimal_credits_and_custom_reviews_stubs.sql'),
    boot('005_custom_review_phase_stubs.sql'),
    mig('20261204000000_boe_credits_decimal_credits.sql'),
    mig('20261205000000_customer_review_custom_submissions.sql'),
    mig('20261206000000_customer_review_custom_reapply_and_monthly_rules.sql'),
    mig('20261207000000_customer_review_reapplied_event_attempt_number.sql'),
  ]) await db.exec(sql)
  return db
}

// ─── Small helpers ────────────────────────────────────────────────────────────

const ADMIN = '00000000-0000-4000-8000-0000000000ad'
const person = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const MOHIT = person(11), SHRAVI = person(12), JASVI = person(13)
const DEV = person(21), ESHA = person(22), FARAH = person(23), GITA = person(24), HARI = person(25), INDU = person(26), JAYA = person(27)
const OCT = '2026-10-01', SEP = '2026-09-01'

async function seedUsers(db) {
  const rows = [[ADMIN, 'Admin', 'admin'], ...[MOHIT, SHRAVI, JASVI, DEV, ESHA, FARAH, GITA, HARI, INDU, JAYA].map((id, i) => [id, `Person ${i}`, 'member'])]
  for (const [id, name, role] of rows) {
    await db.query(`insert into public.users (id, full_name, role) values ($1, $2, $3::public.user_role)`, [id, name, role])
  }
}

let serial = 0
/** One approved custom review, submitted on `day` of `month` (IST), through the real reward function. */
async function approve(db, employee, month, day = 5, credits = 1) {
  serial += 1
  const at = `${month.slice(0, 8)}${String(day).padStart(2, '0')}T06:00:00Z`
  const { rows } = await db.query(
    `select public.post_boe_credit_custom_review_reward($1::uuid, gen_random_uuid(), $2, $3::numeric, $4::timestamptz, $5::uuid) as out`,
    [employee, `CR-T${String(serial).padStart(5, '0')}`, credits, at, ADMIN])
  return rows[0].out.transaction_id
}

const monthRow = async (db, employee, month) => (await db.query(
  `select status, minimum_reviews_snapshot as minimum, qualifying_review_count as count, earned_review_credits::text as earned,
          qualified_at, finalized_at, lapse_transaction_id, updated_at
     from public.boe_credit_review_months where employee_id = $1 and review_month = $2::date`, [employee, month])).rows[0]
const num = async (db, fn, employee) => Number((await db.query(`select public.${fn}($1::uuid) as v`, [employee])).rows[0].v)
const spendable = (db, e) => num(db, 'boe_credit_spendable_balance', e)
const provisional = (db, e) => num(db, 'boe_credit_provisional_credits', e)
const ledgerCount = async db => Number((await db.query(`select count(*) as n from public.boe_credit_transactions`)).rows[0].n)

/** Save a new target the way the app does: a new settings row copied from the newest one. */
async function saveTarget(db, n) {
  const cols = (await db.query(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'boe_credit_settings'
        and column_name not in ('id', 'created_at', 'minimum_monthly_reviews') order by ordinal_position`)).rows.map(r => r.column_name).join(', ')
  await db.query(
    `insert into public.boe_credit_settings (${cols}, minimum_monthly_reviews, created_at)
     select ${cols}, $1::integer, clock_timestamp() from (select * from public.boe_credit_settings order by created_at desc limit 1) s`, [n])
}
const finalize = (db, employee, month) => db.query(
  `select public.finalize_boe_credit_review_month($1::uuid, $2::date, $3::uuid) as out`, [employee, month, ADMIN]).then(r => r.rows[0].out)

async function rejects(fn, pattern, label) {
  let err = null
  try { await fn() } catch (e) { err = e }
  assert.ok(err, `${label}: expected an error`)
  assert.match(String(err.message), pattern, `${label}: wrong error: ${err.message}`)
}

let passed = 0
const check = async (name, fn) => { await fn(); passed += 1; console.log(`PASS  ${name}`) }

// ═══ The scenario ═════════════════════════════════════════════════════════════

const db = await buildChain()
await seedUsers(db)

await check('the chain is in place: target 3 is the active target', async () => {
  const { rows } = await db.query(`select minimum_monthly_reviews as m from public.boe_credit_settings order by created_at desc limit 1`)
  assert.equal(rows[0].m, 3)
})

// ── A. The reported defect, on the schema as it is BEFORE this migration ───────

await approve(db, MOHIT, OCT, 3); await approve(db, MOHIT, OCT, 9)                              // 2 reviews
await approve(db, SHRAVI, OCT, 4)                                                                // 1 review
for (const d of [2, 8, 14, 20]) await approve(db, JASVI, OCT, d)                                 // 4 reviews, 1.0 each

await check('A1 at target 3: 2 reviews and 1 review are open, 4 reviews is qualified (the owner\'s screen)', async () => {
  assert.deepEqual([(await monthRow(db, MOHIT, OCT)).status, (await monthRow(db, MOHIT, OCT)).minimum], ['open', 3])
  assert.deepEqual([(await monthRow(db, SHRAVI, OCT)).status, (await monthRow(db, SHRAVI, OCT)).minimum], ['open', 3])
  const j = await monthRow(db, JASVI, OCT)
  assert.deepEqual([j.status, j.minimum, j.count], ['qualified', 3, 4])
  assert.equal(await provisional(db, MOHIT), 2)
  assert.equal(await spendable(db, MOHIT), 0)
})

await saveTarget(db, 1)

await check('A2 THE DEFECT: lowering the target to 1 moves nobody; the months still read "of 3" and are still open', async () => {
  for (const e of [MOHIT, SHRAVI]) {
    const m = await monthRow(db, e, OCT)
    assert.deepEqual([m.status, m.minimum], ['open', 3])
  }
  assert.equal(await spendable(db, MOHIT), 0)
})

await check('A3 THE DEFECT: the database refuses to move the stored minimum of a month, even one that is open', async () => {
  await rejects(() => db.query(`update public.boe_credit_review_months set minimum_reviews_snapshot = 1 where employee_id = $1`, [MOHIT]),
    /keeps its employee, month and minimum/, 'old guard')
})

await check('A4 THE DEFECT: closing October at this point would LAPSE the 2 reviews (rehearsed in a savepoint, then undone)', async () => {
  await db.exec('begin')
  const out = await finalize(db, MOHIT, OCT)
  await db.exec('rollback')
  assert.equal(out.status, 'lapsed')
  assert.equal(Number(out.lapsed_credits), 2)
  assert.equal((await monthRow(db, MOHIT, OCT)).status, 'open', 'the rollback left the month as it was')
})

// ── B. Apply the migration (twice) ─────────────────────────────────────────────

const ledgerBefore = await ledgerCount(db)
const jasviBefore = await monthRow(db, JASVI, OCT)
await db.exec(MIGRATION)

await check('B1 applying it qualifies the open months that already meet the saved target (1), and only those', async () => {
  for (const [e, count] of [[MOHIT, 2], [SHRAVI, 1]]) {
    const m = await monthRow(db, e, OCT)
    assert.deepEqual([m.status, m.minimum, m.count], ['qualified', 1, count])
    assert.ok(m.qualified_at, 'qualified_at is stamped')
  }
})

await check('B2 Jasvi, already qualified under 3, is untouched: same status, minimum and qualified_at', async () => {
  const j = await monthRow(db, JASVI, OCT)
  assert.deepEqual([j.status, j.minimum, j.count], ['qualified', 3, 4])
  assert.equal(String(j.qualified_at), String(jasviBefore.qualified_at))
  assert.equal(String(j.updated_at), String(jasviBefore.updated_at), 'her row was not even rewritten')
})

await check('B3 the credits become spendable and no ledger row was written (2 + 1 credits move from pending to spendable)', async () => {
  assert.equal(await provisional(db, MOHIT), 0)
  assert.equal(await spendable(db, MOHIT), 2)
  assert.equal(await spendable(db, SHRAVI), 1)
  assert.equal(await ledgerCount(db), ledgerBefore)
})

await check('B4 applying the file a second time is a no-op', async () => {
  const before = [await monthRow(db, MOHIT, OCT), await monthRow(db, SHRAVI, OCT)]
  await db.exec(MIGRATION)
  const after = [await monthRow(db, MOHIT, OCT), await monthRow(db, SHRAVI, OCT)]
  assert.deepEqual(after.map(m => [m.status, m.minimum, String(m.qualified_at)]), before.map(m => [m.status, m.minimum, String(m.qualified_at)]))
  assert.equal(await ledgerCount(db), ledgerBefore)
})

// ── C. The rule going forward ─────────────────────────────────────────────────

await check('C1 raising the target back to 3 takes nothing back: qualified months stay qualified and spendable', async () => {
  await saveTarget(db, 3)
  for (const e of [MOHIT, SHRAVI]) {
    const m = await monthRow(db, e, OCT)
    assert.deepEqual([m.status, m.minimum], ['qualified', 1])
  }
  assert.equal(await spendable(db, MOHIT), 2)
})

await approve(db, DEV, SEP, 6)                                                                   // 1 review at target 3
await approve(db, FARAH, SEP, 6); await approve(db, FARAH, SEP, 7)                               // 2 reviews at target 3
await check('C2 at target 3 a month with 1 or 2 reviews is open and reads "of 3"', async () => {
  assert.deepEqual([(await monthRow(db, DEV, SEP)).status, (await monthRow(db, DEV, SEP)).minimum], ['open', 3])
  assert.deepEqual([(await monthRow(db, FARAH, SEP)).status, (await monthRow(db, FARAH, SEP)).minimum], ['open', 3])
  assert.equal(await provisional(db, FARAH), 2)
})

await saveTarget(db, 2)
await check('C3 saving a target recounts open months at once, with no manual step: 2 reviews qualify at 2, 1 review stays open and reads "of 2"', async () => {
  const f = await monthRow(db, FARAH, SEP)
  assert.deepEqual([f.status, f.minimum], ['qualified', 2])
  const d = await monthRow(db, DEV, SEP)
  assert.deepEqual([d.status, d.minimum], ['open', 2])
  assert.equal(await spendable(db, FARAH), 2)
})

await saveTarget(db, 4)
await check('C4 raising the target moves an open month\'s minimum up and leaves a qualified one alone', async () => {
  assert.deepEqual([(await monthRow(db, DEV, SEP)).status, (await monthRow(db, DEV, SEP)).minimum], ['open', 4])
  assert.deepEqual([(await monthRow(db, FARAH, SEP)).status, (await monthRow(db, FARAH, SEP)).minimum], ['qualified', 2])
})

await check('C5 an approval still qualifies a month the ordinary way: the 4th review reaches a target of 4', async () => {
  for (const d of [7, 8]) await approve(db, DEV, SEP, d)
  const before = await monthRow(db, DEV, SEP)
  assert.equal(before.status, 'open')
  assert.equal(before.count, 3)
  await approve(db, DEV, SEP, 9)
  const after = await monthRow(db, DEV, SEP)
  assert.deepEqual([after.status, after.minimum, after.count], ['qualified', 4, 4])
  assert.equal(await provisional(db, DEV), 0)
})

await check('C6 saving a target rewrites only open months: a qualified month\'s row is not touched', async () => {
  const before = await monthRow(db, FARAH, SEP)
  await saveTarget(db, 3)
  const after = await monthRow(db, FARAH, SEP)
  assert.equal(String(after.updated_at), String(before.updated_at))
  assert.deepEqual([after.status, after.minimum], ['qualified', 2])
})

await check('C7 a reversed review lowers an open month\'s count, and a qualified month still never un-qualifies', async () => {
  const tx = await approve(db, ESHA, SEP, 5)                                                      // 1 review at target 3: open
  assert.equal((await monthRow(db, ESHA, SEP)).count, 1)
  await db.query(`select public.reverse_boe_credit_transaction($1::uuid, $2::uuid, 'wrong review')`, [tx, ADMIN])
  const e = await monthRow(db, ESHA, SEP)
  assert.deepEqual([e.status, e.count, Number(e.earned)], ['open', 0, 0])
  // Farah is qualified at 2 reviews; reverse one and she stays qualified.
  const { rows } = await db.query(
    `select r.transaction_id from public.boe_credit_review_rewards r
       join public.boe_credit_review_months m on m.id = r.review_month_id
      where m.employee_id = $1 and m.review_month = $2::date limit 1`, [FARAH, SEP])
  await db.query(`select public.reverse_boe_credit_transaction($1::uuid, $2::uuid, 'wrong review')`, [rows[0].transaction_id, ADMIN])
  const f = await monthRow(db, FARAH, SEP)
  assert.deepEqual([f.status, f.count], ['qualified', 1])
})

// ── D. Closing a month ────────────────────────────────────────────────────────

await check('D1 closing a month that is open and below the saved target lapses it, and remembers the target it was judged against', async () => {
  await approve(db, HARI, SEP, 5)                                                                 // 1 review, target 3
  const out = await finalize(db, HARI, SEP)
  assert.deepEqual([out.status, Number(out.minimum_reviews), Number(out.lapsed_credits)], ['lapsed', 3, 1])
  assert.equal(await spendable(db, HARI), 0)
})

await check('D2 closing a month the live target already satisfies qualifies it and keeps its credits', async () => {
  await approve(db, INDU, SEP, 5)                                                                 // 1 review, target 3: open
  await saveTarget(db, 1)                                                                         // trigger qualifies it
  assert.equal((await monthRow(db, INDU, SEP)).status, 'qualified')
  const out = await finalize(db, INDU, SEP)
  assert.deepEqual([out.status, Number(out.lapsed_credits)], ['qualified', 0])
  assert.equal(await spendable(db, INDU), 1)
  assert.ok((await monthRow(db, INDU, SEP)).finalized_at)
})

await check('D3 closing re-reads the target itself: with the settings trigger off, an open month is still judged against the saved target', async () => {
  await saveTarget(db, 3)
  await approve(db, JAYA, SEP, 5); await approve(db, JAYA, SEP, 6)                                // 2 reviews at target 3: open
  await db.exec('alter table public.boe_credit_settings disable trigger boe_credit_settings_refresh_open_months')
  await saveTarget(db, 2)
  await db.exec('alter table public.boe_credit_settings enable trigger boe_credit_settings_refresh_open_months')
  assert.deepEqual([(await monthRow(db, JAYA, SEP)).status, (await monthRow(db, JAYA, SEP)).minimum], ['open', 3], 'nothing recounted it')
  const out = await finalize(db, JAYA, SEP)
  assert.deepEqual([out.status, Number(out.minimum_reviews), Number(out.lapsed_credits)], ['qualified', 2, 0])
})

await check('D4 a closed month keeps the minimum it was closed under, whatever is saved afterwards', async () => {
  const lapsed = await monthRow(db, HARI, SEP)
  const closedQualified = await monthRow(db, INDU, SEP)
  await saveTarget(db, 1); await saveTarget(db, 5)
  const l = await monthRow(db, HARI, SEP), q = await monthRow(db, INDU, SEP)
  assert.deepEqual([l.status, l.minimum], ['lapsed', lapsed.minimum])
  assert.deepEqual([q.status, q.minimum], ['qualified', closedQualified.minimum])
  assert.equal(String(l.updated_at), String(lapsed.updated_at))
})

// ── E. The guard ──────────────────────────────────────────────────────────────

const update = (sql, args) => db.query(sql, args)
await check('E1 the minimum of a QUALIFIED month cannot be changed directly', async () => {
  await rejects(() => update(`update public.boe_credit_review_months set minimum_reviews_snapshot = 9 where employee_id = $1 and review_month = $2::date`, [MOHIT, OCT]),
    /qualified or closed review month keeps its minimum/, 'qualified')
})
await check('E2 the minimum of a CLOSED month cannot be changed directly', async () => {
  await rejects(() => update(`update public.boe_credit_review_months set minimum_reviews_snapshot = 9 where employee_id = $1 and review_month = $2::date`, [HARI, SEP]),
    /qualified or closed review month keeps its minimum/, 'lapsed')
})
await check('E3 the minimum of an OPEN month may change, because it follows the target', async () => {
  await approve(db, GITA, SEP, 5)                                                                 // target is 5 now: open
  assert.equal((await monthRow(db, GITA, SEP)).status, 'open')
  await update(`update public.boe_credit_review_months set minimum_reviews_snapshot = 7 where employee_id = $1 and review_month = $2::date`, [GITA, SEP])
  assert.equal((await monthRow(db, GITA, SEP)).minimum, 7)
})
await check('E4 identity, deletion, qualified -> open and a lapsed month stay protected exactly as before', async () => {
  await rejects(() => update(`update public.boe_credit_review_months set review_month = date '2025-01-01' where employee_id = $1 and review_month = $2::date`, [GITA, SEP]), /keeps its employee and month/, 'month')
  await rejects(() => update(`update public.boe_credit_review_months set employee_id = $2 where employee_id = $1 and review_month = $3::date`, [GITA, ESHA, SEP]), /keeps its employee and month/, 'employee')
  await rejects(() => update(`delete from public.boe_credit_review_months where employee_id = $1`, [GITA]), /never deleted/, 'delete')
  await rejects(() => update(`update public.boe_credit_review_months set status = 'open' where employee_id = $1 and review_month = $2::date`, [MOHIT, OCT]), /stays qualified/, 'un-qualify')
  await rejects(() => update(`update public.boe_credit_review_months set status = 'open' where employee_id = $1 and review_month = $2::date`, [HARI, SEP]), /lapsed review month is final/, 'lapsed')
})

// ── F. Who may call what ──────────────────────────────────────────────────────

await check('F1 no client role can run a recount; the service role can', async () => {
  for (const fn of ['public.refresh_open_boe_credit_review_months()', 'public.refresh_boe_credit_review_month(uuid, date)', 'public.boe_credit_settings_refresh_open_months()']) {
    const { rows } = await db.query(
      `select has_function_privilege('anon', $1, 'execute') as anon, has_function_privilege('authenticated', $1, 'execute') as auth,
              has_function_privilege('service_role', $1, 'execute') as svc`, [fn])
    assert.equal(rows[0].anon, false, `${fn} anon`)
    assert.equal(rows[0].auth, false, `${fn} authenticated`)
    if (!fn.includes('settings_refresh')) assert.equal(rows[0].svc, true, `${fn} service_role`)
  }
})

// ── G. The apply-time self-checks really abort a wrong apply (mutations) ──────

async function mutationAborts(label, mutate, pattern) {
  const m = await buildChain()
  await seedUsers(m)
  await approve(m, MOHIT, OCT, 3); await approve(m, MOHIT, OCT, 9)
  await saveTarget(m, 1)
  const broken = mutate(MIGRATION)
  assert.notEqual(broken, MIGRATION, `${label}: the mutation changed nothing`)
  await rejects(() => m.exec(broken), pattern, label)
  await m.close()
}

await check('G1 MUTATION: a recount that ignores the saved target makes the apply abort on its own check', async () => {
  await mutationAborts('M1', sql => sql.replace('v_min := coalesce(v_target, v_min);', 'v_min := v_min;'), /BOE_CREDITS_ASSERT: \d+ open review month\(s\) still do not follow/)
})
await check('G2 MUTATION: no settings trigger makes the apply abort on its own check', async () => {
  await mutationAborts('M2', sql => sql.replace(/create trigger boe_credit_settings_refresh_open_months[\s\S]*?execute function public\.boe_credit_settings_refresh_open_months\(\);/, ''), /the settings trigger is missing/)
})
await check('G3 MUTATION: a recount callable by clients makes the apply abort on its own check', async () => {
  await mutationAborts('M3', sql => sql.replace('revoke execute on function public.refresh_open_boe_credit_review_months() from public, anon, authenticated;', 'grant execute on function public.refresh_open_boe_credit_review_months() to anon;'), /a client role can execute a review month refresh/)
})

await check('G4 MUTATION: a guard that still blocks an open month\'s minimum makes the apply fail instead of half-working', async () => {
  await mutationAborts('M4', sql => sql.replace("and (old.status <> 'open' or old.finalized_at is not null) then", 'and true then'), /qualified or closed review month keeps its minimum/)
})

await db.close()
console.log(`all ${passed} checks passed`)
