// Database regression suite for 20270628000000 (the Star Seller's Super Priority in Factory Focus). Builds the
// Factory Focus table exactly as 20270221000000 defines it (its CREATE TABLE and indexes, cut from that file),
// runs the REAL monthly-review migration (20270627000000) and then the REAL 20270628000000, over stubs of
// users, orders and the owner predicate. Run:
//   node supabase/tests/star_seller_focus_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all N checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node star_seller_focus_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const mig = f => readFileSync(`${REPO}/supabase/migrations/${f}`, 'utf8').replace(/\r/g, '')

const focus = mig('20270221000000_orders_dashboard_factory_focus.sql')
const table = focus.slice(focus.indexOf('create table if not exists public.order_factory_focus_selections'), focus.indexOf('alter table public.order_factory_focus_selections enable row level security'))

const [OWNER, MOHIT, PRERNA] = ['a1', 'b2', 'c3'].map(x => `00000000-0000-0000-0000-0000000000${x}`)
const O = n => `10000000-0000-0000-0000-00000000000${n}`
const db = new PGlite()
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  grant usage on schema public to anon, authenticated;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create table public.users (id uuid primary key);
  insert into public.users values ('${OWNER}'), ('${MOHIT}'), ('${PRERNA}');
  create function public.is_permanent_order_approver(p uuid) returns boolean language sql stable as $$ select p = '${OWNER}'::uuid $$;
  create table public.orders (id uuid primary key, status text not null, assigned_to uuid);
  insert into public.orders values
    ('${O(1)}', 'running', '${MOHIT}'), ('${O(2)}', 'running', '${PRERNA}'), ('${O(3)}', 'dispatched', '${MOHIT}'),
    ('${O(4)}', 'running', '${MOHIT}'), ('${O(5)}', 'running', '${PRERNA}'), ('${O(6)}', 'running', '${PRERNA}'), ('${O(7)}', 'running', '${MOHIT}');
  ${table}
`)
// The original guard first (as production has it), so 20270628000000 restates a real function.
const g0 = focus.indexOf('create or replace function public.order_factory_focus_guard()')
await db.exec(focus.slice(g0, focus.indexOf('$$;', g0) + 3))
await db.exec(`create trigger order_factory_focus_guard before insert or update or delete on public.order_factory_focus_selections for each row execute function public.order_factory_focus_guard();`)
await db.exec(mig('20270627000000_scoreboard_monthly_review.sql'))
await db.exec(mig('20270628000000_star_seller_focus.sql'))

let checks = 0
const ok = name => { checks++; console.log(`  ok - ${name}`) }
const pick = (by, order, kind = 'owner', award = null) => db.query(
  `insert into public.order_factory_focus_selections (order_id, selected_by, selected_month, salesperson_id, kind, award_month)
   values ($1, $2, date '2000-01-01', $2, $3, $4)`, [order, by, kind, award])

// November's Star Seller is Mohit, announced (frozen).
await db.query(`insert into public.scoreboard_awards (month, award, employee_id) values ('2026-11-01', 'star_seller', $1)`, [MOHIT])
await db.query(`insert into public.scoreboard_months (month, frozen_by) values ('2026-11-01', $1)`, [OWNER])

await assert.rejects(() => pick(PRERNA, O(2), 'star_seller', '2026-11-01'), /FACTORY_FOCUS_NOT_STAR_SELLER/)
await assert.rejects(() => pick(MOHIT, O(2), 'star_seller', '2026-11-01'), /FACTORY_FOCUS_NOT_YOUR_ORDER/)
await assert.rejects(() => pick(MOHIT, O(3), 'star_seller', '2026-11-01'), /FACTORY_FOCUS_ORDER_CLOSED/)
await assert.rejects(() => pick(MOHIT, O(1), 'star_seller', '2026-10-01'), /FACTORY_FOCUS_NOT_STAR_SELLER/)
await assert.rejects(() => pick(MOHIT, O(1), 'star_seller', null), /FACTORY_FOCUS_NOT_STAR_SELLER/)
await assert.rejects(() => pick(OWNER, O(5), 'owner', '2026-11-01'), /order_focus_star_month/)
ok('only the announced Star Seller, only their own open Order, only for a frozen award month')

await pick(MOHIT, O(1), 'star_seller', '2026-11-01')
await assert.rejects(() => pick(MOHIT, O(4), 'star_seller', '2026-11-01'), /order_focus_one_star_pick/)
ok('one Star Seller pick per award')

await pick(OWNER, O(5)); await pick(OWNER, O(6))
await assert.rejects(() => pick(OWNER, O(7)), /FACTORY_FOCUS_MONTH_LIMIT/)
ok('the owner keeps exactly two picks a month, and the Star Seller’s pick does not use one')

await assert.rejects(() => pick(MOHIT, O(4)), /FACTORY_FOCUS_NOT_OWNER/)
ok('an ordinary Factory Focus pick is still the owner’s alone')

await assert.rejects(() => db.query(`update public.order_factory_focus_selections set kind = 'owner', award_month = null where kind = 'star_seller'`), /FACTORY_FOCUS_HISTORY/)
await assert.rejects(() => db.query(`update public.order_factory_focus_selections set removed_by = $1, removed_at = now(), removal_reason = 'Not mine' where kind = 'star_seller'`, [MOHIT]), /FACTORY_FOCUS_NOT_OWNER/)
await db.query(`update public.order_factory_focus_selections set removed_by = $1, removed_at = now(), removal_reason = 'Customer paused' where kind = 'star_seller'`, [OWNER])
ok('a pick is never rewritten; only the owner removes it, with a reason')

await db.exec(mig('20270628000000_star_seller_focus.sql'))
ok('the migration is safe to run again')

console.log(`all ${checks} checks passed`)
