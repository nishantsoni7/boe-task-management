// Database regression suite for 20270808000000 (picture credits: settings, allowances, ledger, four functions).
// Runs the REAL migration over a stub of public.users. Run:
//   node supabase/tests/picture_wallet_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all N checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node picture_wallet_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const migration = readFileSync(`${REPO}/supabase/migrations/20270808000000_picture_wallet.sql`, 'utf8').replace(/\r/g, '')

const [ANU, BEN, CARA] = ['a1', 'b2', 'c3'].map(x => `00000000-0000-0000-0000-0000000000${x}`)
const db = new PGlite()
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  grant usage on schema public to anon, authenticated, service_role;
  create table public.users (id uuid primary key);
  insert into public.users values ('${ANU}'), ('${BEN}'), ('${CARA}');
`)
await db.exec(migration)
await db.exec(`grant select, insert, update, delete on all tables in schema public to service_role`)

let checks = 0
const ok = name => { checks++; console.log(`  ok - ${name}`) }
const spend = async (user, credits = 2, tool = 'quotation_clean', usd = 0.08) =>
  (await db.query(`select public.image_credit_spend($1, $2, $3, $4) as r`, [user, tool, credits, usd])).rows[0].r
const set = sql => db.exec(`update public.image_credit_settings set ${sql}`)
const rows = async (where = 'true') => (await db.query(`select * from public.image_credit_ledger where ${where}`)).rows
const wipe = () => db.exec(`delete from public.image_credit_ledger; delete from public.image_credit_allowances;
  update public.image_credit_settings set enabled = true, enforce = false, monthly_pool = 1500, daily_cap = 60`)

// 1. Measure first: the shipped defaults record everything and block nothing.
let s = (await db.query(`select * from public.image_credit_settings`)).rows
assert.equal(s.length, 1); assert.equal(s[0].enabled, true); assert.equal(s[0].enforce, false)
for (let i = 0; i < 40; i++) assert.equal((await spend(ANU)).ok, true)
assert.equal((await rows()).length, 40)
ok('as shipped (limits off) every press is recorded and nobody is blocked, even with no allowance')

// 2. The pause switch is the one thing that blocks while limits are off.
await set(`enabled = false`)
assert.deepEqual(await spend(BEN), { ok: false, code: 'PAUSED' })
assert.equal((await rows(`user_id = '${BEN}'`)).length, 0)
await set(`enabled = true`)
ok('the pause switch refuses and records nothing')

// 3. Limits on: no allowance means no press; an allowance is a monthly number of credits.
await wipe(); await set(`enforce = true`)
assert.deepEqual(await spend(ANU), { ok: false, code: 'NO_ALLOWANCE' })
await db.exec(`insert into public.image_credit_allowances (user_id, monthly_credits) values ('${ANU}', 10)`)
for (let i = 0; i < 5; i++) assert.equal((await spend(ANU)).ok, true)
assert.deepEqual(await spend(ANU), { ok: false, code: 'USER_MONTH' })
assert.deepEqual(await spend(BEN), { ok: false, code: 'NO_ALLOWANCE' })
ok('limits on: no allowance is refused; five two-credit presses fit ten credits and the sixth is refused')

// 4. A press is all or nothing: 1 credit left does not allow a 2-credit press, but allows a 1-credit one.
await wipe(); await set(`enforce = true`)
await db.exec(`insert into public.image_credit_allowances (user_id, monthly_credits) values ('${ANU}', 5)`)
await spend(ANU); await spend(ANU)
assert.deepEqual(await spend(ANU, 2), { ok: false, code: 'USER_MONTH' })
assert.equal((await spend(ANU, 1, 'studio', 0.042)).ok, true)
ok('a press that would pass the allowance is refused whole; a smaller one still fits')

// 5. The daily cap, per person.
await wipe(); await set(`enforce = true, daily_cap = 4`)
await db.exec(`insert into public.image_credit_allowances (user_id, monthly_credits) values ('${ANU}', 100), ('${BEN}', 100)`)
await spend(ANU); await spend(ANU)
assert.deepEqual(await spend(ANU), { ok: false, code: 'USER_DAY' })
assert.equal((await spend(BEN)).ok, true)
ok('the daily cap stops one person for the day without touching anyone else')

// 6. The company pool is a hard stop for everyone.
await wipe(); await set(`enforce = true, monthly_pool = 6`)
await db.exec(`insert into public.image_credit_allowances (user_id, monthly_credits) values ('${ANU}', 100), ('${BEN}', 100)`)
await spend(ANU); await spend(ANU); await spend(BEN)
assert.deepEqual(await spend(BEN), { ok: false, code: 'POOL' })
assert.deepEqual(await spend(ANU), { ok: false, code: 'POOL' })
ok('when the month’s pool is used, everyone is refused')

// 7. Refunds give the credits back, once.
await wipe(); await set(`enforce = true, monthly_pool = 4`)
await db.exec(`insert into public.image_credit_allowances (user_id, monthly_credits) values ('${ANU}', 4)`)
const a = await spend(ANU); await spend(ANU)
assert.deepEqual(await spend(ANU), { ok: false, code: 'USER_MONTH' })
assert.equal((await db.query(`select public.image_credit_refund($1) as r`, [a.ledger_id])).rows[0].r, true)
assert.equal((await db.query(`select public.image_credit_refund($1) as r`, [a.ledger_id])).rows[0].r, false)
assert.equal((await spend(ANU)).ok, true)
assert.equal((await rows(`status = 'refunded'`)).length, 1)
ok('a refund frees the credits once; the row stays, marked refunded')

// 8. Month boundary in India time: a press one second before the month started does not count.
await wipe(); await set(`enforce = true`)
await db.exec(`insert into public.image_credit_allowances (user_id, monthly_credits) values ('${ANU}', 4)`)
const month = `(date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')`
await db.exec(`insert into public.image_credit_ledger (user_id, tool, credits, usd_estimate, created_at)
  values ('${ANU}', 'studio', 4, 0.1, ${month} - interval '1 second')`)
assert.equal((await spend(ANU)).ok, true)
await db.exec(`insert into public.image_credit_ledger (user_id, tool, credits, usd_estimate, created_at)
  values ('${ANU}', 'studio', 2, 0.1, ${month})`)
assert.deepEqual(await spend(ANU), { ok: false, code: 'USER_MONTH' })
ok('the month starts at midnight India time on the 1st: last month’s credits do not count, the first second does')

// 9. What the note beside the button reads.
await wipe()
assert.deepEqual((await db.query(`select public.image_credit_status($1) as r`, [ANU])).rows[0].r, { enabled: true, enforce: false })
await set(`enforce = true`)
assert.deepEqual((await db.query(`select public.image_credit_status($1) as r`, [ANU])).rows[0].r, { enabled: true, enforce: true, allowed: false })
await db.exec(`insert into public.image_credit_allowances (user_id, monthly_credits) values ('${ANU}', 10)`)
await spend(ANU)
assert.deepEqual((await db.query(`select public.image_credit_status($1) as r`, [ANU])).rows[0].r,
  { enabled: true, enforce: true, allowed: true, month_left: 8, today_left: 58, pool_left: 1498 })
ok('status: nothing to show with limits off, "not switched on" without an allowance, and the credits left otherwise')

// 10. The tracking report: by day, person and tool; refunded presses are not counted.
await wipe()
await db.exec(`insert into public.image_credit_allowances (user_id, monthly_credits) values ('${ANU}', 100)`)
await spend(ANU, 2, 'quotation_clean', 0.08); await spend(ANU, 2, 'pi_customize', 0.08); await spend(BEN, 1, 'studio', 0.042)
const gone = await spend(CARA, 2, 'quotation_change', 0.08)
await db.query(`select public.image_credit_refund($1)`, [gone.ledger_id])
await db.exec(`insert into public.image_credit_ledger (user_id, tool, credits, usd_estimate, created_at)
  values ('${BEN}', 'studio', 1, 0.042, now() - interval '3 days')`)
const rep = (await db.query(`select public.image_credit_report(14) as r`)).rows[0].r
assert.equal(rep.today.presses, 3); assert.equal(rep.today.credits, 5)
assert.equal(rep.month.presses >= 3, true)
assert.equal(rep.daily[0].top_user, ANU); assert.equal(rep.daily[0].top_presses, 2)
assert.equal(rep.people[0].user_id, ANU); assert.equal(rep.people[0].presses, 2)
assert.deepEqual(rep.tools.map(t => t.tool).sort(), ['pi_customize', 'quotation_clean', 'studio'])
assert.equal(rep.people.some(p => p.user_id === CARA), false)
assert.equal(Number(rep.usd_prev7).toFixed(3), '0.042')
ok('the report counts charged presses only, names the day’s top user, and gives the dollars of the previous seven days')

// 11. Nobody but the server can touch any of it.
for (const role of ['anon', 'authenticated']) {
  await db.exec(`set role ${role}`)
  await assert.rejects(() => db.query(`select public.image_credit_spend('${ANU}', 'studio', 1, 0.04)`), /permission denied/)
  await assert.rejects(() => db.query(`select public.image_credit_report(7)`), /permission denied/)
  await assert.rejects(() => db.query(`select * from public.image_credit_ledger`), /permission denied/)
  await assert.rejects(() => db.query(`select * from public.image_credit_allowances`), /permission denied/)
  await db.exec(`reset role`)
}
await db.exec(`set role service_role`)
assert.equal((await spend(ANU, 1, 'studio', 0.04)).ok, true)
await db.exec(`reset role`)
ok('browser roles cannot read the tables or call the functions; the service role can')

// 12. A bad cost is refused before anything is written.
await assert.rejects(() => spend(ANU, 0), /IMAGE_CREDIT_BAD_COST/)
await assert.rejects(() => db.query(`select public.image_credit_spend($1, 'studio', 1, -1)`, [ANU]), /IMAGE_CREDIT_BAD_COST/)
await assert.rejects(() => db.query(`select public.image_credit_spend($1, 'nonsense', 1, 0.04)`, [ANU]), /image_credit_ledger_tool_check/)
ok('a zero or negative cost and an unknown tool name are refused')

// 13. Safe to run again, and it does not reset the owner’s settings.
await set(`enforce = true, monthly_pool = 2222`)
await db.exec(migration)
s = (await db.query(`select * from public.image_credit_settings`)).rows
assert.equal(s.length, 1); assert.equal(s[0].enforce, true); assert.equal(s[0].monthly_pool, 2222)
ok('the migration is safe to run again and keeps the owner’s settings')

console.log(`all ${checks} checks passed`)
