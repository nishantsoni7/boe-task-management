/**
 * BOE Credits Phase 1D — what the migration SAYS, what the routes trust, and
 * what the screens send.
 *
 * The executable proof of the database rules is
 * supabase/tests/boe_credits_phase_1d_assertions.sql (run by
 * run_boe_credits_phase_1d_local.sh). This file catches the drift a text can
 * show — a grant whose signature no longer matches, a route that reads an
 * employee id from a body, a screen that sends a rate — before a database is
 * involved. Comments are stripped before every assertion, so a claim cannot
 * be satisfied by prose.
 *
 * Run:
 *   npx tsx --test src/lib/boeCredits/phase1d.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const FILE = '20261104000000_boe_credits_phase_1d.sql'
const PREVIOUS_TRANSITION = '20261102000000_boe_credits_review_reward.sql'
const MIGRATIONS = join(ROOT, 'supabase/migrations')
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
const stripSql = (s: string) => s.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')
const stripTs = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*')).join('\n')
const src = (p: string) => stripTs(read(join(ROOT, p)))

const sql  = read(join(MIGRATIONS, FILE))
const code = stripSql(sql)

function fn(name: string, from = code): string {
  const start = from.indexOf(`create or replace function public.${name}(`)
  assert.ok(start >= 0, `function ${name} is defined`)
  const end = from.indexOf('\n$$;', start)
  assert.ok(end > start, `function ${name} closes`)
  return from.slice(start, end + 4)
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) yield full
  }
}

// ── 1. The file ─────────────────────────────────────────────────────────────

describe('the file, and where it sits', () => {
  test('it is the newest migration and follows Phase 1C', () => {
    const all = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
    assert.equal(all[all.length - 1], FILE)
    assert.equal(all[all.length - 2], '20261103000000_boe_credits_attendance_redemption.sql')
  })

  test('it creates exactly the three Phase 1D tables and alters only credits tables', () => {
    const created = [...code.matchAll(/create table if not exists public\.(\w+)/g)].map(m => m[1])
    assert.deepEqual(created, ['boe_credit_review_months', 'boe_credit_review_rewards', 'boe_credit_payroll_applications'])
    const altered = [...new Set([...code.matchAll(/alter table (?:only )?public\.(\w+)/g)].map(m => m[1]))].sort()
    assert.deepEqual(altered, [
      'boe_credit_payroll_applications', 'boe_credit_review_months', 'boe_credit_review_rewards',
      'boe_credit_settings', 'boe_credit_transactions',
    ])
    assert.equal(/drop table|^\s*truncate\b|^\s*begin;\s*$|^\s*commit;\s*$/m.test(code), false)
    assert.equal((code.match(/\$\$/g) ?? []).length % 2, 0)
  })

  test('it touches no attendance, payroll or review table beyond reading them', () => {
    assert.equal(/(insert into|update|delete from|alter table) public\.(attendance_records|attendance_day_corrections|payroll_results|payroll_deduction_lines|payroll_periods|payroll_settlements)/.test(code), false)
    // The transition still updates the card row it always updated, and nothing else in the review schema.
    const reviewWrites = [...code.matchAll(/(?:insert into|update|delete from) public\.(customer_review_\w+)/g)].map(m => m[1])
    assert.deepEqual([...new Set(reviewWrites)].sort(), ['customer_review_test_card_events', 'customer_review_test_cards'])
    assert.equal(/alter table public\.customer_review/.test(code), false)
  })

  test('NO BACKFILL: the post-conditions prove nothing was posted, and no seed touches the ledger', () => {
    const block = code.slice(code.lastIndexOf('do $$'))
    for (const needle of [
      'from public.boe_credit_transactions where created_at >= transaction_timestamp()',
      'from public.boe_credit_review_months where created_at >= transaction_timestamp()',
      'from public.boe_credit_payroll_applications where created_at >= transaction_timestamp()',
    ]) assert.ok(block.includes(needle), needle)
    const inserts = [...code.matchAll(/insert into public\.(\w+)/g)].map(m => m[1])
    assert.equal(inserts.includes('boe_credit_transactions'), true, 'only inside post_boe_credit_transaction')
    const seedInserts = [...stripSql(sql).slice(0, code.indexOf('create table if not exists public.boe_credit_review_months')).matchAll(/insert into public\.(\w+)/g)].map(m => m[1])
    assert.deepEqual(seedInserts, ['boe_credit_settings'], 'the only top-level INSERT is the settings row')
  })
})

// ── 2. Settings ─────────────────────────────────────────────────────────────

describe('settings', () => {
  test('three new bounded columns, credit_value positive, the Phase 1A row kept', () => {
    assert.match(code, /add column if not exists half_day_redemption_credits integer not null default 8\s*\n\s*check \(half_day_redemption_credits > 0 and half_day_redemption_credits <= 100000\)/)
    assert.match(code, /add column if not exists full_day_redemption_credits integer not null default 15\s*\n\s*check \(full_day_redemption_credits > 0 and full_day_redemption_credits <= 100000\)/)
    assert.match(code, /add column if not exists minimum_monthly_reviews integer not null default 3\s*\n\s*check \(minimum_monthly_reviews > 0 and minimum_monthly_reviews <= 1000\)/)
    assert.match(code, /add constraint boe_credit_settings_credit_value_positive check \(credit_value > 0\)/)
    assert.equal(/update public\.boe_credit_settings|delete from public\.boe_credit_settings|drop column/.test(code), false)
  })

  test('the new active row is inserted once, and only if the newest row is not already it', () => {
    assert.match(code, /if not found\s*\n\s*or v_newest\.review_reward_credits\s+is distinct from 1/)
    assert.match(code, /values \(1, 100\.00, 8, 15, 3, null, 'BOE Credits Phase 1D defaults'\)/)
  })

  test('half day and full day are never derived from each other anywhere in the file', () => {
    assert.equal(/half_day_redemption_credits \* 2|full_day_redemption_credits \/ 2/.test(code), false)
  })
})

// ── 3. The fifth kind and the spendable balance ─────────────────────────────

describe('the ledger: review_month_lapse and the spendable balance', () => {
  const post = fn('post_boe_credit_transaction')

  test('the kind check is re-created with five kinds, found by definition rather than by an assumed name', () => {
    assert.match(code, /pg_get_constraintdef\(oid\) like '%transaction_type%'/)
    assert.match(code, /'review_reward',\s*\n\s*'redemption',\s*\n\s*'reversal',\s*\n\s*'admin_adjustment',\s*\n\s*'review_month_lapse'/)
    assert.match(code, /when 'review_month_lapse' then credits < 0 and source_type = 'boe_credit_review_month'/)
  })

  test('a redemption is checked against the SPENDABLE balance, under the per-employee lock', () => {
    assert.match(post, /v_balance := public\.boe_credit_spendable_balance\(p_employee_id\);/)
    assert.equal(/select coalesce\(sum\(credits\), 0\) into v_balance/.test(post), false, 'no raw SUM check remains')
    const lock = post.indexOf('pg_advisory_xact_lock(')
    const check = post.indexOf('BOE_CREDITS_INSUFFICIENT')
    const insert = post.indexOf('insert into public.boe_credit_transactions')
    assert.ok(lock > 0 && lock < check && check < insert)
  })

  test('a lapse needs an active admin actor, a negative amount and the employee’s own month row', () => {
    assert.match(post, /if p_transaction_type in \('admin_adjustment', 'review_month_lapse'\) and not v_actor_admin then/)
    assert.match(post, /a review month lapse removes credits — the amount must be negative/)
    assert.match(post, /where m\.id = p_source_id and m\.employee_id = p_employee_id/)
  })

  test('the ONE non-admin reversal: an employee reversing their own payroll application, and nothing else', () => {
    const block = post.slice(post.indexOf("if p_transaction_type = 'reversal' and not v_actor_admin then"))
    assert.match(block, /v_original\.source_type <> 'payroll_redemption'\s*\n\s*or v_original\.employee_id <> p_actor_id/)
    assert.match(block, /BOE_CREDITS_DENIED: only an administrator can post a reversal/)
  })

  test('provisional = open-month rewards not reversed; spendable = recorded − provisional; both SECURITY INVOKER', () => {
    const prov = fn('boe_credit_provisional_credits')
    assert.equal(/security definer/.test(prov), false)
    assert.match(prov, /m\.status = 'open'/)
    assert.match(prov, /rv\.transaction_type = 'reversal'\s*\n\s*and rv\.source_type = 'boe_credit_transaction'\s*\n\s*and rv\.source_id = t\.id/)
    const spend = fn('boe_credit_spendable_balance')
    assert.equal(/security definer/.test(spend), false)
    assert.match(spend, /public\.boe_credit_balance\(p_employee_id\) - public\.boe_credit_provisional_credits\(p_employee_id\)/)
    assert.match(code, /create view public\.boe_credit_balances\s*\n\s*with \(security_invoker = true\) as/)
    assert.match(code, /as spendable_credits/)
    assert.match(code, /as provisional_credits/)
  })

  test('grants: every Phase 1D write function is service_role only; the transition is authenticated only', () => {
    for (const sig of [
      'public.post_boe_credit_transaction(uuid, text, integer, text, uuid, text, uuid, uuid)',
      'public.post_boe_credit_review_reward(uuid, uuid, text, timestamptz, uuid)',
      'public.refresh_boe_credit_review_month(uuid, date)',
      'public.finalize_boe_credit_review_month(uuid, date, uuid)',
      'public.redeem_boe_credits_for_attendance(uuid, uuid, date, text, uuid)',
      'public.apply_boe_credits_to_payroll(uuid, uuid, integer, uuid)',
      'public.remove_boe_credit_payroll_application(uuid, uuid, uuid)',
    ]) {
      const esc = sig.replace(/[.()]/g, m => `\\${m}`)
      assert.match(code, new RegExp(`revoke execute on function ${esc}\\s+from public, anon, authenticated;`), sig)
      assert.match(code, new RegExp(`grant  execute on function ${esc}\\s+to service_role;`), sig)
    }
    assert.match(code, /revoke execute on function public\.transition_customer_review_test_card\(uuid, text, text\) from public, anon;/)
    assert.match(code, /grant  execute on function public\.transition_customer_review_test_card\(uuid, text, text\) to authenticated;/)
  })

  test('every SECURITY DEFINER function pins search_path, pg_temp last', () => {
    const defs = [...code.matchAll(/create or replace function public\.(\w+)\(/g)].map(m => m[1])
    for (const name of new Set(defs)) {
      const f = fn(name)
      if (!/security definer/.test(f)) continue
      assert.match(f, /set search_path = public, pg_temp/, name)
      assert.equal(/set search_path = pg_temp/.test(f), false, name)
    }
  })

  test('every raise a caller can trigger carries a SQLSTATE', () => {
    for (const r of code.match(/raise exception[\s\S]*?;/g) ?? []) {
      if (/^raise exception 'BOE_CREDITS_1D: /.test(r)) continue
      assert.match(r, /using errcode = '[0-9A-Z]{5}'/, r)
    }
  })
})

// ── 4. Attribution, qualification, lapse ────────────────────────────────────

describe('the review month', () => {
  const reward = fn('post_boe_credit_review_reward')
  const refresh = fn('refresh_boe_credit_review_month')
  const finalize = fn('finalize_boe_credit_review_month')

  test('the month is the Asia/Kolkata month of submitted_at, and the minimum is snapshotted on first use', () => {
    assert.match(reward, /v_month := date_trunc\('month', \(p_submitted_at at time zone 'Asia\/Kolkata'\)::date\)::date;/)
    assert.match(reward, /insert into public\.boe_credit_review_months \(employee_id, review_month, minimum_reviews_snapshot\)\s*\n\s*values \(p_employee_id, v_month, v_settings\.minimum_monthly_reviews\)\s*\n\s*on conflict \(employee_id, review_month\) do nothing;/)
    assert.equal(/verified_at|booked_at/.test(reward), false, 'never the verification or booking instant')
  })

  test('the reward is posted through the one write path, for the active setting, under the employee lock', () => {
    assert.match(reward, /perform pg_advisory_xact_lock\(hashtext\('boe_credits'\), hashtext\(p_employee_id::text\)\);/)
    assert.match(reward, /v_tx := public\.post_boe_credit_transaction\(\s*\n\s*p_employee_id,\s*\n\s*'review_reward',\s*\n\s*v_settings\.review_reward_credits,\s*\n\s*'customer_review',\s*\n\s*p_card_id,/)
    assert.equal(/insert into public\.boe_credit_transactions/.test(reward), false)
    assert.ok(reward.indexOf('pg_advisory_xact_lock(') < reward.indexOf('public.post_boe_credit_transaction('))
  })

  test('refresh counts un-reversed rewards and moves open → qualified only; never back, never lapsed', () => {
    assert.match(refresh, /not exists \(\s*\n\s*select 1 from public\.boe_credit_transactions rv\s*\n\s*where rv\.transaction_type = 'reversal'/)
    assert.match(refresh, /status\s+= case when status = 'open' and v_count >= minimum_reviews_snapshot then 'qualified' else status end/)
    assert.equal(/'lapsed'/.test(refresh), false)
    assert.match(refresh, /for update/)
  })

  test('finalize: admin, month ended (IST), recount first, idempotent, one lapse of the still-valid credits only', () => {
    assert.match(finalize, /BOE_CREDITS_DENIED: only an administrator can finalize a review month/)
    assert.match(finalize, /v_today\s+date := \(now\(\) at time zone 'Asia\/Kolkata'\)::date;/)
    assert.match(finalize, /if p_review_month >= date_trunc\('month', v_today\)::date then\s*\n\s*raise exception 'BOE_CREDITS_MONTH_OPEN/)
    assert.ok(finalize.indexOf('pg_advisory_xact_lock(') < finalize.indexOf('refresh_boe_credit_review_month('))
    assert.match(finalize, /if v_row\.finalized_at is not null then/)
    assert.match(finalize, /'already_finalized',\s+true/)
    assert.match(finalize, /if v_row\.earned_review_credits > 0 then\s*\n\s*v_lapse := public\.post_boe_credit_transaction\(\s*\n\s*p_employee_id,\s*\n\s*'review_month_lapse',\s*\n\s*-v_row\.earned_review_credits,\s*\n\s*'boe_credit_review_month',\s*\n\s*v_row\.id,/)
    assert.equal(/status = 'open'\s*\n?\s*where id = v_row\.id/.test(finalize), false, 'nothing reopens')
  })

  test('the reversal guard refuses a lapsed month’s reward and a locked month’s redemption; the effects trigger refreshes the month and closes a payroll application', () => {
    const guard = fn('boe_credit_reversal_guard')
    assert.match(guard, /m\.status = 'lapsed'/)
    assert.match(guard, /BOE_CREDITS_MONTH_LAPSED/)
    assert.match(guard, /if v_original\.transaction_type = 'review_month_lapse' then\s*\n\s*raise exception 'BOE_CREDITS_REVERSAL: a review month lapse is final/)
    assert.match(guard, /v_original\.source_type in \('attendance_redemption', 'payroll_redemption'\)/)
    assert.match(guard, /if v_status = 'locked' then\s*\n\s*raise exception 'BOE_CREDITS_PERIOD_LOCKED/)
    assert.match(code, /create trigger boe_credit_reversal_guard\s*\n\s*before insert on public\.boe_credit_transactions/)
    const effects = fn('boe_credit_reversal_effects')
    assert.match(effects, /perform public\.refresh_boe_credit_review_month\(v_reward\.employee_id, v_reward\.review_month\);/)
    assert.match(effects, /update public\.boe_credit_payroll_applications\s*\n\s*set reversal_transaction_id = new\.id,\s*\n\s*reversed_at\s+= new\.created_at\s*\n\s*where redemption_transaction_id = v_original\.id\s*\n\s*and reversal_transaction_id is null;/)
  })

  test('the months guard: a lapsed month is final, a qualified month stays qualified, identity and minimum never move', () => {
    const g = fn('boe_credit_review_months_guard')
    assert.match(g, /old\.status = 'lapsed' and \(new\.status <> 'lapsed'/)
    assert.match(g, /old\.status = 'qualified' and new\.status <> 'qualified'/)
    assert.match(g, /new\.minimum_reviews_snapshot <> old\.minimum_reviews_snapshot/)
    assert.match(g, /if tg_op = 'DELETE' then/)
  })
})

// ── 5. The transition ───────────────────────────────────────────────────────

describe('the verify transition, re-created', () => {
  const now  = fn('transition_customer_review_test_card')
  const prev = fn('transition_customer_review_test_card', stripSql(read(join(MIGRATIONS, PREVIOUS_TRANSITION))))

  test('everything before the reward branch is byte-identical to Phase 1B', () => {
    // Up to the reward branch — the first `if p_next_status = 'verified' then`
    // (the earlier gate reads `in ('verified', 'booked')`).
    const cut = (s: string) => s.slice(s.indexOf('begin\n'), s.indexOf("  if p_next_status = 'verified' then"))
    const a = cut(now).replace(/\s+/g, ' ')
    const b = cut(prev).replace(/\s+/g, ' ')
    assert.equal(a, b)
  })

  test('it consults no role, resolves both permissions, keeps the holder-only submit gate and the row lock before the status read', () => {
    assert.equal(/u\.role|users\.role|'admin'/.test(now), false)
    assert.match(now, /v_use\s+:= public\.resolve_permission\(v_uid, 'customer_review_requests', 'use'\);/)
    assert.match(now, /if not \(v_holder and v_use\) then/)
    assert.ok(now.indexOf('for update') < now.indexOf('v_legal := case c.status'))
  })

  test('the reward branch calls post_boe_credit_review_reward with the holder, the card, its ref and its submitted_at', () => {
    assert.match(now, /v_reward := public\.post_boe_credit_review_reward\(\s*\n\s*c\.booked_by,\s*\n\s*p_card_id,\s*\n\s*c\.card_ref,\s*\n\s*c\.submitted_at,\s*\n\s*v_uid\s*\n\s*\);/)
    assert.equal(/public\.post_boe_credit_transaction\(/.test(now), false, 'the transition no longer posts the ledger row itself')
    assert.match(now, /if c\.submitted_at is null then/)
  })
})

// ── 6. The payroll application ──────────────────────────────────────────────

describe('the payroll application', () => {
  const apply = fn('apply_boe_credits_to_payroll')
  const remove = fn('remove_boe_credit_payroll_application')

  test('the table snapshots credits, rate and rupees, and admits one ACTIVE row per employee-period', () => {
    const table = code.slice(code.indexOf('create table if not exists public.boe_credit_payroll_applications'), code.indexOf('comment on table public.boe_credit_payroll_applications'))
    assert.match(table, /credit_value_snapshot\s+numeric\(12,2\) not null check \(credit_value_snapshot > 0\)/)
    assert.match(table, /credit_amount_snapshot\s+numeric\(12,2\) not null check \(credit_amount_snapshot > 0\)/)
    assert.match(table, /credit_amount_snapshot = round\(credits_used \* credit_value_snapshot, 2\)/)
    assert.match(code, /create unique index if not exists boe_credit_payroll_applications_active_unique\s*\n\s*on public\.boe_credit_payroll_applications \(employee_id, payroll_period_id\)\s*\n\s*where reversal_transaction_id is null;/)
  })

  test('the actor must be the employee; the rate is the newest setting; the period is read FOR SHARE and refused when locked', () => {
    assert.match(apply, /if p_employee_id is null or p_actor_id is null or p_actor_id <> p_employee_id then/)
    assert.match(apply, /select \* into v_settings from public\.boe_credit_settings order by created_at desc limit 1;/)
    assert.match(apply, /for share/)
    assert.match(apply, /BOE_CREDITS_PERIOD_LOCKED/)
    assert.match(apply, /BOE_CREDITS_NOT_GENERATED/)
    assert.equal(/p_credit_value|p_amount|p_rate/.test(apply), false, 'no rate or rupee parameter')
  })

  test('same credits → unchanged; different → reversal then a new redemption, both under the lock', () => {
    assert.match(apply, /if v_existing\.credits_used = p_credits then/)
    assert.match(apply, /'unchanged',\s+true/)
    const reversal = apply.indexOf("'reversal',")
    const redemption = apply.indexOf("'redemption',")
    const lock = apply.indexOf('pg_advisory_xact_lock(')
    assert.ok(lock > 0 && lock < reversal && reversal < redemption)
    assert.match(apply, /v_amount := round\(p_credits \* v_settings\.credit_value, 2\);/)
    assert.match(apply, /'payroll_redemption',/)
  })

  test('removal is the employee’s, refused on a locked month, and nothing-to-remove is not an error', () => {
    assert.match(remove, /p_actor_id <> p_employee_id/)
    assert.match(remove, /BOE_CREDITS_PERIOD_LOCKED/)
    assert.match(remove, /'removed', false/)
  })
})

// ── 7. The routes ───────────────────────────────────────────────────────────

describe('the routes', () => {
  const APPLICATIONS = src('src/app/api/boe-credits/payroll-applications/route.ts')
  const MONTHS = src('src/app/api/boe-credits/review-months/route.ts')
  const REVERSALS = src('src/app/api/boe-credits/reversals/route.ts')
  const LEDGER = src('src/app/api/boe-credits/ledger/route.ts')
  const SETTINGS = src('src/app/api/boe-credits/settings/route.ts')

  test('payroll applications: the caller is the employee AND the actor; nothing in the body names one, a rate or a balance', () => {
    assert.match(APPLICATIONS, /const caller = await resolveCaller\(req\)/)
    assert.match(APPLICATIONS, /employeeId: caller\.id,\s*\n\s*payrollPeriodId: periodId,\s*\n\s*credits,\s*\n\s*actorId: caller\.id,/)
    assert.equal(/payload\.(employee_id|employeeId|credit_value|amount|rate|balance)|body\.(employee_id|credit_value|amount)/.test(APPLICATIONS), false)
    assert.equal(/requireAdmin/.test(APPLICATIONS), false, 'no admin path — applying is the employee’s own decision')
    assert.equal(/\.insert\(|\.update\(|\.delete\(|\.rpc\(/.test(APPLICATIONS), false, 'writes only through the service')
    assert.match(APPLICATIONS, /export async function POST/)
    assert.match(APPLICATIONS, /export async function DELETE/)
    assert.equal(/export async function (GET|PUT|PATCH)/.test(APPLICATIONS), false)
  })

  test('review months: admin only on both verbs, and the actor is the token', () => {
    const get = MONTHS.slice(MONTHS.indexOf('export async function GET'), MONTHS.indexOf('export async function POST'))
    const post = MONTHS.slice(MONTHS.indexOf('export async function POST'))
    assert.match(get, /const auth = await requireAdmin\(req\)/)
    assert.match(post, /const auth = await requireAdmin\(req\)/)
    assert.match(post, /actorId: auth\.id/)
    assert.equal(/payload\.(actor|actor_id)/.test(post), false)
    assert.equal(/\.insert\(|\.update\(|\.delete\(|\.rpc\(/.test(MONTHS), false)
  })

  test('reversals: admin only, actor from the token, reason validated with the shared rule', () => {
    assert.match(REVERSALS, /const auth = await requireAdmin\(req\)/)
    assert.match(REVERSALS, /actorId: auth\.id/)
    assert.match(REVERSALS, /creditReasonIssue\(payload\.reason\)/)
    assert.equal(/\.insert\(|\.update\(|\.delete\(|\.rpc\(/.test(REVERSALS), false)
  })

  test('the ledger answers all three figures, and the settings carry all five numbers', () => {
    assert.match(LEDGER, /provisional_credits: balance\.provisional_credits/)
    assert.match(LEDGER, /spendable_credits:\s+balance\.spendable_credits/)
    for (const k of ['half_day_redemption_credits', 'full_day_redemption_credits', 'minimum_monthly_reviews']) {
      assert.ok(SETTINGS.includes(k), k)
    }
  })
})

// ── 8. The screens ──────────────────────────────────────────────────────────

describe('the screens', () => {
  test('the payroll credits panel sends the period and a number of credits, and nothing that prices them', () => {
    const page = src('src/app/my-payroll/[periodId]/page.tsx')
    const post = page.slice(page.indexOf("fetch('/api/boe-credits/payroll-applications'"), page.indexOf("fetch('/api/boe-credits/payroll-applications'") + 400)
    assert.match(post, /body: JSON\.stringify\(\{ payroll_period_id: periodId, credits \}\)/)
    assert.equal(/credit_value|amount|employee_id/.test(post), false)
    const panel = src('src/components/boeCredits/PayrollCreditsPanel.tsx')
    assert.equal(/fetch\(|supabase/.test(panel), false, 'the panel performs no request of its own')
  })

  test('the admin payslip carries no credits panel and no redeem action', () => {
    const admin = src('src/app/payroll/results/[periodId]/[employeeId]/page.tsx')
    assert.equal(/creditsPanel=|onRedeem=/.test(admin), false)
  })

  test('the knowledge page reads the settings and types no business number of its own', () => {
    const guide = src('src/app/my-credits/how-it-works/page.tsx')
    assert.match(guide, /fetch\('\/api\/boe-credits\/settings'/)
    assert.equal(/half_day_redemption_credits:\s*\d|full_day_redemption_credits:\s*\d|credit_value:\s*\d|minimum_monthly_reviews:\s*\d|review_reward_credits:\s*\d/.test(guide), false)
    assert.equal(/\b8 credits\b|\b15 credits\b|₹100\b/.test(guide), false, 'no literal price in the prose')
  })

  test('no active code path carries the Phase 1C literals or the Phase 1A defaults', () => {
    const offenders: string[] = []
    for (const file of walk(join(ROOT, 'src'))) {
      if (/\.test\.tsx?$/.test(file)) continue
      const c = stripTs(read(file))
      if (/ATTENDANCE_REDEMPTION_COST\b/.test(c)) offenders.push(`${file}: ATTENDANCE_REDEMPTION_COST`)
      if (/review_reward_credits:\s*100\b/.test(c)) offenders.push(`${file}: reward 100`)
      if (/credit_value:\s*1\.0\b|credit_value:\s*1,/.test(c)) offenders.push(`${file}: value 1.0`)
    }
    assert.deepEqual(offenders, [])
  })

  test('the ledger route explains rows; no screen shows a database code to an employee', () => {
    for (const p of ['src/components/boeCredits/CreditHistoryModal.tsx', 'src/app/my-credits/page.tsx']) {
      const c = src(p)
      // Source-type codes never reach a screen; the transaction KIND is a
      // TypeScript union the components branch on, which is not a display.
      assert.equal(/'attendance_redemption'|'payroll_redemption'|'boe_credit_review_month'|'customer_review'/.test(c), false, p)
    }
  })
})
