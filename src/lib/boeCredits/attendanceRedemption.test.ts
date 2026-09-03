/**
 * BOE Credits Phase 1C, priced by Phase 1D — the cost, the eligibility rule,
 * and what the two migrations SAY.
 *
 * Three things are pinned here:
 *   1. the cost is a SETTING: attendanceRedemptionCost() reads the two
 *      numbers it is handed and nothing else, and the SQL function reads the
 *      same two columns from the newest settings row — no literal anywhere;
 *   2. attendanceRedemptionEligibility() admits exactly a chargeable absent or
 *      half-day line and refuses everything the rules exclude, each with its
 *      reason, and quotes the price from the settings it is given;
 *   3. 20261103000000_boe_credits_attendance_redemption.sql is shaped as
 *      documented — the foundation's vocabulary ('redemption' /
 *      'attendance_redemption'), service-role only, close-once-else-append-only,
 *      one ACTIVE coverage per day, the ledger trigger that closes a record,
 *      no attendance table touched, no foundation object altered, no backfill.
 *
 * The executable proof of (3) is supabase/tests/boe_credits_attendance_
 * redemption_assertions.sql; of (1) it is §3 and §11 of
 * boe_credits_phase_1d_assertions.sql. Comments are stripped before every
 * text assertion, so a claim cannot be satisfied by prose.
 *
 * Run:
 *   npx tsx --test src/lib/boeCredits/attendanceRedemption.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  attendanceRedemptionCost,
  attendanceRedemptionEligibility,
  coveredLabel,
  redemptionCovers,
  redemptionOfferLabel,
  isRedeemableDeductionType,
  REDEEMABLE_DEDUCTION_TYPES,
  type RedeemableDayInput,
} from './attendanceRedemption'
import { DEFAULT_BOE_CREDIT_SETTINGS } from './settings'
import { CREDIT_TRANSACTION_TYPES } from './types'

const ROOT = process.cwd()
const FILE = '20261103000000_boe_credits_attendance_redemption.sql'
const PHASE_1D = '20261104000000_boe_credits_phase_1d.sql'
const FOUNDATION = '20261101000000_boe_credits_foundation.sql'
const MIGRATIONS = join(ROOT, 'supabase/migrations')
const read  = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
const strip = (s: string) => s.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')
const sql   = read(join(MIGRATIONS, FILE))
const code  = strip(sql)
const phase1d = strip(read(join(MIGRATIONS, PHASE_1D)))
const foundation = strip(read(join(MIGRATIONS, FOUNDATION)))

function fnIn(src: string, name: string): string {
  const start = src.indexOf(`create or replace function public.${name}(`)
  assert.ok(start >= 0, `function ${name} is defined`)
  const end = src.indexOf('\n$$;', start)
  assert.ok(end > start, `function ${name} closes`)
  return src.slice(start, end + 4)
}
const fn = (name: string) => fnIn(code, name)

// ── 1. The cost ─────────────────────────────────────────────────────────────

const COSTS = { half_day_redemption_credits: 8, full_day_redemption_credits: 15 }

describe('the cost is a setting, read the same way in SQL and TypeScript', () => {
  test('two kinds, and each reads its own setting — nothing is derived from the other', () => {
    assert.deepEqual([...REDEEMABLE_DEDUCTION_TYPES], ['half_day', 'absent'])
    assert.equal(attendanceRedemptionCost('half_day', COSTS), 8)
    assert.equal(attendanceRedemptionCost('absent', COSTS), 15)
    assert.equal(attendanceRedemptionCost('half_day', { half_day_redemption_credits: 1, full_day_redemption_credits: 2 }), 1)
    assert.equal(attendanceRedemptionCost('absent', { half_day_redemption_credits: 20, full_day_redemption_credits: 10 }), 10, 'no ratio is assumed')
    assert.equal(attendanceRedemptionCost('half_day', DEFAULT_BOE_CREDIT_SETTINGS), 8)
    assert.equal(attendanceRedemptionCost('absent', DEFAULT_BOE_CREDIT_SETTINGS), 15)
    assert.ok(isRedeemableDeductionType('half_day'))
    assert.ok(isRedeemableDeductionType('absent'))
    assert.equal(isRedeemableDeductionType('late_arrival'), false)
    assert.equal(isRedeemableDeductionType('missing_punch_in'), false)
  })

  test('the Phase 1D SQL function reads the two settings columns and carries no literal price', () => {
    const f = fnIn(phase1d, 'redeem_boe_credits_for_attendance')
    assert.match(f, /select \* into v_settings from public\.boe_credit_settings order by created_at desc limit 1;/)
    assert.match(f, /when 'half_day' then v_settings\.half_day_redemption_credits\s*\n\s*else\s+v_settings\.full_day_redemption_credits/)
    assert.equal(/when 'half_day' then \d|when 'absent'\s+then \d/.test(f), false, 'no literal cost')
    assert.equal(/credit_value|monthly_salary|per_day/.test(f), false, 'cost is not derived from money')
    // The price is written on the record, so history reads the same when the setting changes.
    assert.match(f, /v_id, p_employee_id, p_attendance_date, p_deduction_type, v_cost,/)
  })

  test('the Phase 1C file still carries its two literals — it is history, applied and unchanged', () => {
    const f = fn('redeem_boe_credits_for_attendance')
    assert.match(f, /when 'half_day' then 1\s*\n\s*when 'absent'\s+then 2/)
  })

  test('labels say credits, never rupees, at the price they are given', () => {
    assert.equal(redemptionOfferLabel('half_day', 8), 'Half Day · 8 credits')
    assert.equal(redemptionOfferLabel('absent', 15),  'Absent · 15 credits')
    assert.equal(redemptionOfferLabel('half_day', 1), 'Half Day · 1 credit')
    assert.equal(coveredLabel(1), 'Covered with 1 BOE Credit')
    assert.equal(coveredLabel(8), 'Covered with 8 BOE Credits')
  })

  test('an absent redemption covers a day that became a half day; not the other way', () => {
    assert.equal(redemptionCovers('absent', 'absent'),     true)
    assert.equal(redemptionCovers('absent', 'half_day'),   true)
    assert.equal(redemptionCovers('half_day', 'half_day'), true)
    assert.equal(redemptionCovers('half_day', 'absent'),   false)
  })
})

// ── 2. Eligibility ──────────────────────────────────────────────────────────

const CTX = { periodStatus: 'generated' as const, today: '2026-08-20', periodMonth: 8, periodYear: 2026, costs: COSTS }
const day = (date: string, lines: RedeemableDayInput['deduction_lines']): RedeemableDayInput => ({ date, deduction_lines: lines })

describe('eligibility comes from the settled deduction line, not the attendance status', () => {
  test('a chargeable half day → the half-day price', () => {
    const e = attendanceRedemptionEligibility(day('2026-08-12', [{ deduction_type: 'half_day', amount_deducted: 385 }]), CTX)
    assert.deepEqual(e, { eligible: true, deduction_type: 'half_day', credits: 8, amount: 385 })
  })

  test('a chargeable absent day → the full-day price', () => {
    const e = attendanceRedemptionEligibility(day('2026-08-13', [{ deduction_type: 'absent', amount_deducted: 769 }]), CTX)
    assert.deepEqual(e, { eligible: true, deduction_type: 'absent', credits: 15, amount: 769 })
  })

  test('the price follows the settings handed in, not a constant', () => {
    const cheap = { ...CTX, costs: { half_day_redemption_credits: 1, full_day_redemption_credits: 2 } }
    const e = attendanceRedemptionEligibility(day('2026-08-13', [{ deduction_type: 'absent', amount_deducted: 769 }]), cheap)
    assert.ok(e.eligible && e.credits === 2)
  })

  test('a company-paid (₹0, paid leave) day is refused', () => {
    const e = attendanceRedemptionEligibility(day('2026-08-03', [{ deduction_type: 'absent', amount_deducted: 0, waived_by: 'paid_leave' }]), CTX)
    assert.equal(e.eligible, false)
    if (!e.eligible) assert.equal(e.reason, 'company_paid')
  })

  test('a ₹0 line with no stated waiver is still not a deduction to cover', () => {
    const e = attendanceRedemptionEligibility(day('2026-08-03', [{ deduction_type: 'absent', amount_deducted: 0 }]), CTX)
    assert.equal(e.eligible, false)
    if (!e.eligible) assert.equal(e.reason, 'company_paid')
  })

  test('a late mark is refused', () => {
    const e = attendanceRedemptionEligibility(day('2026-08-05', [{ deduction_type: 'late_arrival', amount_deducted: 45 }]), CTX)
    assert.equal(e.eligible, false)
    if (!e.eligible) { assert.equal(e.reason, 'not_day_deduction'); assert.match(e.message, /Late arrivals/) }
  })

  test('a missing punch is refused, even stacked with a late arrival', () => {
    const e = attendanceRedemptionEligibility(day('2026-08-06', [
      { deduction_type: 'missing_punch_out', amount_deducted: 181 },
      { deduction_type: 'late_arrival', amount_deducted: 45 },
    ]), CTX)
    assert.equal(e.eligible, false)
    if (!e.eligible) assert.equal(e.reason, 'not_day_deduction')
  })

  test('a day with no deduction at all is refused', () => {
    const e = attendanceRedemptionEligibility(day('2026-08-07', []), CTX)
    assert.equal(e.eligible, false)
    if (!e.eligible) assert.equal(e.reason, 'no_deduction')
    const none = attendanceRedemptionEligibility(undefined, CTX)
    assert.equal(none.eligible, false)
  })

  test('an already-covered day is refused as such, not as company paid', () => {
    const e = attendanceRedemptionEligibility(day('2026-08-12', [{ deduction_type: 'half_day', amount_deducted: 0, waived_by: 'boe_credits', credits_redeemed: 8 }]), CTX)
    assert.equal(e.eligible, false)
    if (!e.eligible) assert.equal(e.reason, 'already_covered')
  })

  test('a future date is refused — no advance redemption', () => {
    const e = attendanceRedemptionEligibility(day('2026-08-21', [{ deduction_type: 'absent', amount_deducted: 769 }]), CTX)
    assert.equal(e.eligible, false)
    if (!e.eligible) assert.equal(e.reason, 'future_date')
    const today = attendanceRedemptionEligibility(day('2026-08-20', [{ deduction_type: 'absent', amount_deducted: 769 }]), CTX)
    assert.equal(today.eligible, true, 'today itself is allowed')
  })

  test('a date outside the period is refused', () => {
    const e = attendanceRedemptionEligibility(day('2026-07-31', [{ deduction_type: 'absent', amount_deducted: 769 }]), CTX)
    assert.equal(e.eligible, false)
    if (!e.eligible) assert.equal(e.reason, 'not_in_period')
  })

  test('a locked period refuses before anything else is looked at', () => {
    const e = attendanceRedemptionEligibility(day('2026-08-12', [{ deduction_type: 'half_day', amount_deducted: 385 }]), { ...CTX, periodStatus: 'locked' })
    assert.equal(e.eligible, false)
    if (!e.eligible) { assert.equal(e.reason, 'locked'); assert.match(e.message, /locked/) }
  })
})

// ── 3. The Phase 1C migration ───────────────────────────────────────────────

describe('the file, and where it sits', () => {
  test('it follows the two credits files before it, and Phase 1D follows it', () => {
    const all = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
    const at = all.indexOf(FILE)
    assert.equal(all[at - 1], '20261102000000_boe_credits_review_reward.sql')
    assert.equal(all[at + 1], PHASE_1D)
  })

  test('it is additive: one new table, and it alters only that table', () => {
    const created = [...code.matchAll(/create table if not exists public\.(\w+)/g)].map(m => m[1])
    assert.deepEqual(created, ['boe_credit_attendance_redemptions'])
    const altered = [...code.matchAll(/alter table (?:only )?public\.(\w+)/g)].map(m => m[1])
    assert.deepEqual([...new Set(altered)], ['boe_credit_attendance_redemptions'])
    const inserts = [...code.matchAll(/insert into public\.(\w+)/g)].map(m => m[1])
    assert.deepEqual([...new Set(inserts)], ['boe_credit_attendance_redemptions'], 'the ledger is reached through post_boe_credit_transaction')
    assert.equal(/drop table|^\s*truncate\b|^\s*begin;\s*$|^\s*commit;\s*$/m.test(code), false)
    assert.equal((code.match(/\$\$/g) ?? []).length % 2, 0)
  })

  test('OLD-CODE COMPATIBILITY: it redefines none of the foundation\'s functions and widens nothing on its tables', () => {
    for (const f of ['post_boe_credit_transaction', 'reverse_boe_credit_transaction', 'can_manage_boe_credits', 'boe_credit_balance', 'boe_credits_append_only']) {
      assert.equal(code.includes(`create or replace function public.${f}(`), false, f)
      assert.equal(code.includes(`drop function if exists public.${f}(`), false, f)
    }
    assert.equal(/alter table (?:only )?public\.boe_credit_(transactions|settings)/.test(code), false)
    assert.equal(/drop (index|policy|trigger) if exists [^\n]*boe_credit_transactions_(append_only|one_per_source_idx|read_own_or_manage)/.test(code), false)
    assert.equal(/credit_redeemed/.test(code.replace(/not like '%credit_redeemed%'/g, '')), false, 'no new transaction kind')
    const ledgerTouches = [...code.matchAll(/[^\n]*\bpublic\.boe_credit_transactions\b[^\n]*/g)].map(m => m[0].trim())
      .filter(t => !/^(select|from|where|and|if|insert into|assert|raise|--)/.test(t))
      .filter(t => !/references public\.boe_credit_transactions\(id\)/.test(t))
      .filter(t => !/'public\.boe_credit_transactions'::regclass/.test(t))
      .filter(t => !/boe_credit_redemption_closed_by_reversal on public\.boe_credit_transactions/.test(t))
      .filter(t => !/^after insert on public\.boe_credit_transactions$/.test(t))
      .filter(t => !/^comment on column public\.boe_credit_transactions\.source_type is$/.test(t))
    assert.deepEqual(ledgerTouches, [])
    assert.match(code, /create trigger boe_credit_redemption_closed_by_reversal\s*\n\s*after insert on public\.boe_credit_transactions\s*\n\s*for each row\s*\n\s*when \(new\.transaction_type = 'reversal'\)/)
  })

  test('it touches no attendance table, and only READS payroll_results', () => {
    assert.equal(/(insert into|update|delete from|alter table) public\.(attendance_records|attendance_day_corrections|payroll_results|payroll_deduction_lines)/.test(code), false)
    for (const name of ['redeem_boe_credits_for_attendance', 'reverse_boe_credit_attendance_redemption']) {
      assert.equal(/attendance_records|attendance_day_corrections|payroll_deduction_lines/.test(fn(name)), false, name)
    }
    assert.match(fn('redeem_boe_credits_for_attendance'), /from public\.payroll_results/)
  })
})

describe('the ledger vocabulary', () => {
  test('the foundation admits exactly four kinds; Phase 1D adds the fifth, and TypeScript agrees', () => {
    assert.match(foundation, /transaction_type\s+text\s+not null check \(transaction_type in \(\s*'review_reward',\s*'redemption',\s*'reversal',\s*'admin_adjustment'\s*\)\)/)
    assert.deepEqual([...CREDIT_TRANSACTION_TYPES], ['review_reward', 'redemption', 'reversal', 'admin_adjustment', 'review_month_lapse'])
    assert.equal(/credit_redeemed/.test(foundation), false)
  })

  test('the redemption is posted as redemption / attendance_redemption / the record id — in both the 1C and the 1D definition', () => {
    for (const f of [fn('redeem_boe_credits_for_attendance'), fnIn(phase1d, 'redeem_boe_credits_for_attendance')]) {
      const call = f.slice(f.indexOf('public.post_boe_credit_transaction('), f.indexOf(');', f.indexOf('public.post_boe_credit_transaction(')))
      const args = call.slice(call.indexOf('(') + 1).split(',').map(a => a.trim())
      assert.equal(args[0], 'p_employee_id')
      assert.equal(args[1], "'redemption'")
      assert.equal(args[2], '-v_cost')
      assert.equal(args[3], "'attendance_redemption'")
      assert.equal(args[4], 'v_id', 'the record id, generated fresh per redemption')
      assert.equal(args[6], 'p_actor_id')
      assert.equal(args[7], 'p_payroll_period_id')
      assert.match(f, /v_id\s+:= gen_random_uuid\(\);/)
      assert.match(f, /'Attendance redemption · ' \|\| v_label/)
      assert.match(f, /to_char\(p_attendance_date, 'DD Mon YYYY'\)/)
    }
    assert.equal(/md5\(/.test(code), false, 'no derived source id: a reversed day may be covered again with a new row')
  })
})

describe('the redemption record', () => {
  const table = code.slice(
    code.indexOf('create table if not exists public.boe_credit_attendance_redemptions'),
    code.indexOf('comment on table public.boe_credit_attendance_redemptions'),
  )

  test('one ACTIVE coverage per day (partial unique), one ledger row per record, one reversal per record, two kinds', () => {
    assert.match(code, /create unique index if not exists boe_credit_attendance_redemptions_active_unique\s*\n\s*on public\.boe_credit_attendance_redemptions \(employee_id, attendance_date\)\s*\n\s*where reversal_transaction_id is null;/)
    assert.equal(/constraint \w+ unique \(employee_id, attendance_date\)/.test(table), false, 'no unconditional unique — that would ban re-redemption forever')
    assert.match(table, /transaction_id\s+uuid\s+not null unique references public\.boe_credit_transactions\(id\)/)
    assert.match(table, /reversal_transaction_id uuid\s+unique references public\.boe_credit_transactions\(id\)/)
    assert.match(table, /\(reversal_transaction_id is null\) = \(reversed_at is null\)/)
    assert.match(table, /deduction_type\s+text\s+not null check \(deduction_type in \('half_day', 'absent'\)\)/)
    assert.match(table, /credits\s+integer\s+not null check \(credits > 0\)/)
    assert.match(table, /payroll_period_id\s+uuid\s+not null references public\.payroll_periods\(id\)/)
  })

  test('close once, otherwise append-only: the guard refuses DELETE, any change to a closed row, any change but the closing, and a foreign reversal', () => {
    const g = fn('boe_credit_attendance_redemptions_guard')
    assert.match(g, /if tg_op = 'DELETE' then/)
    assert.match(g, /if old\.reversal_transaction_id is not null then/)
    assert.match(g, /if new\.reversal_transaction_id is null or new\.reversed_at is null then/)
    assert.match(g, /\(to_jsonb\(new\) - 'reversal_transaction_id' - 'reversed_at'\)\s*\n\s*<> \(to_jsonb\(old\) - 'reversal_transaction_id' - 'reversed_at'\)/)
    assert.match(g, /t\.source_id = old\.transaction_id/)
    assert.equal((g.match(/errcode = '42501'/g) ?? []).length, 5)
    assert.match(code, /create trigger boe_credit_attendance_redemptions_guard\s*\n\s*before update or delete on public\.boe_credit_attendance_redemptions/)
  })

  test('the ledger trigger closes exactly the record whose ledger row was reversed, and only if still open', () => {
    const t = fn('boe_credit_redemption_closed_by_reversal')
    assert.match(t, /security definer/)
    assert.match(t, /update public\.boe_credit_attendance_redemptions\s*\n\s*set reversal_transaction_id = new\.id,\s*\n\s*reversed_at\s+= new\.created_at\s*\n\s*where transaction_id = new\.source_id\s*\n\s*and reversal_transaction_id is null;/)
  })

  test('RLS on, one SELECT policy (own rows or management), no client writes, anon blind', () => {
    assert.match(code, /alter table public\.boe_credit_attendance_redemptions enable row level security;/)
    const policies = [...code.matchAll(/create policy "([^"]+)"\s*\n\s*on public\.(\w+)\s*\n\s*for (\w+)/g)]
    assert.deepEqual(policies.map(p => [p[2], p[3]]), [['boe_credit_attendance_redemptions', 'select']])
    assert.match(code, /using \(employee_id = auth\.uid\(\) or public\.can_manage_boe_credits\(\)\);/)
    assert.match(code, /revoke insert, update, delete, truncate, references, trigger\s*\n\s*on public\.boe_credit_attendance_redemptions from authenticated, anon;/)
    assert.equal(/using \(true\)|with check \(true\)/.test(code), false)
  })
})

describe('the two write paths', () => {
  const reverse = fn('reverse_boe_credit_attendance_redemption')
  // The redemption's CURRENT definition is Phase 1D's; the rules below hold for both.
  const redeems = [fn('redeem_boe_credits_for_attendance'), fnIn(phase1d, 'redeem_boe_credits_for_attendance')]

  test('SECURITY DEFINER, search_path pinned, EXECUTE for service_role alone — on the exact signatures, in both files', () => {
    for (const [src, f, sig] of [
      [code,    redeems[0], 'public.redeem_boe_credits_for_attendance(uuid, uuid, date, text, uuid)'],
      [phase1d, redeems[1], 'public.redeem_boe_credits_for_attendance(uuid, uuid, date, text, uuid)'],
      [code,    reverse,    'public.reverse_boe_credit_attendance_redemption(uuid, uuid, text)'],
    ] as const) {
      assert.match(f, /security definer/)
      assert.match(f, /set search_path = public, pg_temp/)
      const esc = sig.replace(/[.()]/g, m => `\\${m}`)
      assert.match(src, new RegExp(`revoke execute on function ${esc}\\s*\\n\\s*from public, anon, authenticated;`))
      assert.match(src, new RegExp(`grant  execute on function ${esc}\\s*\\n\\s*to service_role;`))
    }
  })

  test('the actor is the employee or an ACTIVE admin, checked first', () => {
    for (const redeem of redeems) {
      assert.match(redeem, /if p_actor_id <> p_employee_id and not exists \(\s*\n\s*select 1 from public\.users\s*\n\s*where id = p_actor_id and role = 'admin' and is_active = true and coalesce\(is_deleted, false\) = false/)
      assert.ok(redeem.indexOf('BOE_CREDITS_DENIED') < redeem.indexOf('BOE_CREDITS_REDEMPTION_TYPE'))
    }
  })

  test('both take the per-employee advisory lock FIRST, then the period FOR SHARE — the same order, so they cannot deadlock', () => {
    for (const f of [...redeems, reverse]) {
      const lock  = f.indexOf("pg_advisory_xact_lock(hashtext('boe_credits'), hashtext(")
      const share = f.indexOf('for share')
      assert.ok(lock > 0 && share > lock, 'advisory lock before the period row lock')
    }
    for (const redeem of redeems) {
      assert.ok(redeem.indexOf('pg_advisory_xact_lock(') < redeem.indexOf('BOE_CREDITS_ALREADY_COVERED'), 'the active check runs under the lock')
    }
    assert.ok(reverse.indexOf('pg_advisory_xact_lock(') < reverse.indexOf('for update'), 'the record is locked under the employee lock')
  })

  test('the redemption refuses a locked month, an ungenerated month, a bad date, a future date and an active duplicate', () => {
    for (const redeem of redeems) {
      assert.match(redeem, /if v_period\.status = 'locked' then\s*\n\s*raise exception 'BOE_CREDITS_PERIOD_LOCKED[^\n]*\n\s*using errcode = '55000'/)
      assert.match(redeem, /BOE_CREDITS_NOT_GENERATED[^\n]*\n\s*using errcode = '55000'/)
      assert.match(redeem, /extract\(year\s+from p_attendance_date\)::integer <> v_period\.payroll_year/)
      assert.match(redeem, /v_today\s+date := \(now\(\) at time zone 'Asia\/Kolkata'\)::date/)
      assert.match(redeem, /if p_attendance_date > v_today then/)
      assert.match(redeem, /and reversal_transaction_id is null\s*\n\s*\) then\s*\n\s*raise exception 'BOE_CREDITS_ALREADY_COVERED[^\n]*\n\s*using errcode = '23505'/)
      assert.equal(/insert into public\.boe_credit_transactions/.test(redeem), false)
      assert.ok(redeem.indexOf('public.post_boe_credit_transaction(') < redeem.indexOf('insert into public.boe_credit_attendance_redemptions'))
    }
  })

  test('the reversal goes through reverse_boe_credit_transaction (admin + reason), refuses a closed record and a locked month, and checks the trigger closed the record', () => {
    assert.match(reverse, /BOE_CREDITS_ALREADY_REVERSED[^\n]*\n\s*using errcode = '55000'/)
    assert.match(reverse, /BOE_CREDITS_PERIOD_LOCKED[^\n]*\n\s*using errcode = '55000'/)
    assert.match(reverse, /v_rev := public\.reverse_boe_credit_transaction\(v_r\.transaction_id, p_actor_id, p_reason\);/)
    assert.match(reverse, /if v_closed is distinct from v_rev then/)
    assert.equal(/update public\.boe_credit_attendance_redemptions|insert into/.test(reverse), false, 'the record is closed by the trigger, not by hand')
  })

  test('every raise carries a SQLSTATE', () => {
    for (const f of [...redeems, reverse, fn('boe_credit_attendance_redemptions_guard')]) {
      for (const r of f.match(/raise exception[\s\S]*?;/g) ?? []) assert.match(r, /using errcode = '[0-9A-Z]{5}'/, r)
    }
  })

  test('NO BACKFILL, and the post-conditions cover the index, both triggers, the policy, the grants and the untouched CHECK', () => {
    const block = code.slice(code.lastIndexOf('do $$'))
    for (const needle of [
      'c.relrowsecurity',
      'boe_credit_attendance_redemptions_active_unique',
      'where (reversal_transaction_id is null)',
      "'boe_credit_attendance_redemptions_guard', 'boe_credit_redemption_closed_by_reversal'",
      "cmd <> 'SELECT'",
      "has_table_privilege('authenticated', 'public.boe_credit_attendance_redemptions', 'INSERT')",
      "has_function_privilege('service_role', 'public.reverse_boe_credit_attendance_redemption(uuid, uuid, text)', 'EXECUTE')",
      "not like '%credit_redeemed%'",
      "transaction_type in ('redemption', 'reversal') and created_at >= transaction_timestamp()",
    ]) {
      assert.ok(block.includes(needle), needle)
    }
  })
})
