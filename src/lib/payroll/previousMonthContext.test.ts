/**
 * Previous Month Context — what the preceding payroll month worked out to and
 * what was paid, shown on the employee payroll detail page as orientation for
 * this month's carry-forward.
 *
 * THE RULE THIS EXISTS TO PROTECT
 * --------------------------------
 * Every figure here is either a stored primitive or the SAME computeSettlement()
 * the rest of the settlement layer already trusts (src/lib/payroll/settlement.ts).
 * Nothing is estimated, and — the one that matters most — a month whose payment
 * was never recorded must show "not recorded", never a fabricated ₹0. Treating
 * an unrecorded amount_paid as 0 would invent a debt for the whole of that
 * month's Salary Payable, which is exactly the trap settlement.ts was written
 * to avoid; this is the same trap one hop further into the UI.
 *
 * Run:
 *   npx tsx --test src/lib/payroll/previousMonthContext.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fetchPreviousMonthContext } from './settlementStore'
import { buildResultDetailPayload } from './resultDetailPayload'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const EMP = 'emp-1'

// ─── A minimal, ACTUALLY-filtering fake ────────────────────────────────────────
//
// Unlike the "one employee-month per table" fake used elsewhere in this
// package, these tests need two distinct periods (current and preceding) in
// the SAME tables, so filters must be real: .eq()/.is() narrow the rows,
// .lte()/.order()/.limit() are no-ops (the pure selectPrecedingPeriod inside
// fetchPrecedingPeriod does the actual period-sequence comparison, so the
// fake only has to hand back every period row and let that logic decide).

function fakeSvc(tables: Record<string, Record<string, unknown>[]>) {
  const chain = (table: string, filters: Array<(r: Record<string, unknown>) => boolean> = []) => {
    const rows = () => (tables[table] ?? []).filter(r => filters.every(f => f(r)))
    const c: Record<string, unknown> = {
      select: () => c,
      eq:     (col: string, val: unknown) => chain(table, [...filters, r => r[col] === val]),
      is:     (col: string, val: unknown) => chain(table, [...filters, r => r[col] === val]),
      lte:    () => c,
      gte:    () => c,
      order:  () => c,
      limit:  () => c,
      range:  () => c,
      single:      () => Promise.resolve({ data: rows()[0] ?? null, error: rows()[0] ? null : { message: `${table}: no row` } }),
      maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(ok),
    }
    return c
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: (table: string) => chain(table) } as any
}

const JULY   = { id: 'per-jul', payroll_month: 7, payroll_year: 2026 }
const AUGUST = { id: 'per-aug', payroll_month: 8, payroll_year: 2026 }

function world(opts: {
  periods?: Record<string, unknown>[]
  results?: Record<string, unknown>[]
  settlements?: Record<string, unknown>[]
  applications?: Record<string, unknown>[]
}) {
  return fakeSvc({
    payroll_periods: opts.periods ?? [JULY, AUGUST],
    payroll_results: opts.results ?? [],
    payroll_settlements: opts.settlements ?? [],
    boe_credit_payroll_applications: opts.applications ?? [],
  })
}

// ─── 1. No preceding period ────────────────────────────────────────────────────

describe('the first payroll month BOE has run', () => {
  test('has no previous month, and says so with null rather than an empty shell', async () => {
    const svc = world({ periods: [JULY] })
    // JULY is the only period, so JULY itself has no predecessor.
    const ctx = await fetchPreviousMonthContext(svc, 7, 2026, EMP)
    assert.equal(ctx, null)
  })
})

// ─── 2. A preceding period with nothing for this employee ─────────────────────

describe('a preceding period that never generated a result for this employee', () => {
  test('is has_result: false, not a silently empty set of zeros', async () => {
    const svc = world({ periods: [JULY, AUGUST], results: [] })
    const ctx = await fetchPreviousMonthContext(svc, 8, 2026, EMP)
    assert.ok(ctx)
    assert.equal(ctx!.has_result, false)
    assert.equal(ctx!.period.payroll_month, 7)
    assert.equal(ctx!.period.payroll_year, 2026)
    // Nothing invented for a month that has genuinely nothing.
    assert.equal(ctx!.salary_payable, null)
    assert.equal(ctx!.amount_paid, null)
    assert.equal(ctx!.closing_balance, null)
  })
})

// ─── 3. A real result, no payment recorded ─────────────────────────────────────

describe('a preceding month with a result but no recorded payment', () => {
  test('computes Salary Payable from the stored primitives, and leaves the payment unrecorded — not ₹0', async () => {
    const svc = world({
      periods: [JULY, AUGUST],
      results: [{
        payroll_period_id: JULY.id, employee_id: EMP,
        gross_salary: 26_000, total_deductions: 1_000, pending_adjustment_total: 0, days_present: 25,
      }],
      settlements: [], // no settlement row at all for July
    })
    const ctx = await fetchPreviousMonthContext(svc, 8, 2026, EMP)
    assert.ok(ctx)
    assert.equal(ctx!.has_result, true)
    assert.equal(ctx!.salary_payable, 25_000) // 26,000 - 1,000, no carry-forward, no adjustments
    assert.equal(ctx!.amount_paid, null)
    assert.equal(ctx!.closing_balance, null, 'no payment recorded means no closing balance, not a balance of the full payable')
    assert.equal(ctx!.payment_status, 'not_recorded')
  })
})

// ─── 4. A real result, payment recorded ────────────────────────────────────────

describe('a preceding month with a recorded payment', () => {
  test('the difference is Salary Payable minus what was actually paid', async () => {
    const svc = world({
      periods: [JULY, AUGUST],
      results: [{
        payroll_period_id: JULY.id, employee_id: EMP,
        gross_salary: 22_057, total_deductions: 0, pending_adjustment_total: 0, days_present: 26,
      }],
      settlements: [{
        payroll_period_id: JULY.id, employee_id: EMP,
        carry_forward_amount: 0, amount_paid: 18_624,
      }],
    })
    const ctx = await fetchPreviousMonthContext(svc, 8, 2026, EMP)
    assert.ok(ctx)
    assert.equal(ctx!.salary_payable, 22_057)
    assert.equal(ctx!.amount_paid, 18_624)
    assert.equal(ctx!.closing_balance, 3_433)
    assert.equal(ctx!.payment_status, 'recorded')
  })

  test('a recorded ₹0 IS a real balance, distinct from not recorded at all', async () => {
    const svc = world({
      periods: [JULY, AUGUST],
      results: [{
        payroll_period_id: JULY.id, employee_id: EMP,
        gross_salary: 20_000, total_deductions: 0, pending_adjustment_total: 0, days_present: 26,
      }],
      settlements: [{
        payroll_period_id: JULY.id, employee_id: EMP,
        carry_forward_amount: 0, amount_paid: 0,
      }],
    })
    const ctx = await fetchPreviousMonthContext(svc, 8, 2026, EMP)
    assert.equal(ctx!.amount_paid, 0)
    assert.equal(ctx!.payment_status, 'recorded')
    assert.equal(ctx!.closing_balance, 20_000, 'a recorded ₹0 payment leaves the whole payable outstanding')
  })
})

// ─── 5. The payroll SEQUENCE, not the calendar ─────────────────────────────────

describe('the preceding period is the one before in the payroll sequence', () => {
  test('a gap month is skipped, exactly as settlementStore already guarantees for carry-forward', async () => {
    // May and August exist; June and July never ran. August's predecessor is May.
    const MAY = { id: 'per-may', payroll_month: 5, payroll_year: 2026 }
    const svc = world({
      periods: [MAY, AUGUST],
      results: [{
        payroll_period_id: MAY.id, employee_id: EMP,
        gross_salary: 10_000, total_deductions: 0, pending_adjustment_total: 0, days_present: 26,
      }],
    })
    const ctx = await fetchPreviousMonthContext(svc, 8, 2026, EMP)
    assert.equal(ctx!.period.payroll_month, 5)
    assert.equal(ctx!.salary_payable, 10_000)
  })
})

// ─── 6. Wiring: the payload carries it, the UI never fabricates a value ───────

describe('the payload and the presentation both honour the null rule', () => {
  const detailPayload = read('src/lib/payroll/resultDetailPayload.ts')
  const view = read('src/app/payroll/results/[periodId]/[employeeId]/PayrollDetailView.tsx')

  test('the detail payload calls the real function and never fails the payslip for it', () => {
    assert.match(detailPayload, /fetchPreviousMonthContext\(/)
    assert.match(detailPayload, /previous_month:\s*previousMonthContext/)
    // Same degrade-not-fail posture as the settlement read beside it.
    const call = detailPayload.slice(detailPayload.indexOf('fetchPreviousMonthContext('))
    assert.match(call.slice(0, 300), /\.catch\(/)
  })

  test('the payload key is OMITTED, not sent as null, when the caller did not ask for it', () => {
    assert.match(detailPayload,
      /\.\.\.\(includePreviousMonth \? \{ previous_month: previousMonthContext \} : \{\}\)/,
      'a conditional spread, not an unconditional `previous_month: ...` field')
  })

  test('the lookup itself is skipped, not just hidden, when not requested', () => {
    // No query should run at all for a reader who never asked — this is
    // about not touching the table on the employee path, not merely about
    // what ends up in the response.
    assert.match(detailPayload,
      /includePreviousMonth\s*\n?\s*\?\s*fetchPreviousMonthContext\(/,
      'the fetch must be conditional on includePreviousMonth')
  })

  test('the card never coalesces a null amount into a displayed zero', () => {
    // Slice from differenceLabel(), not PreviousMonthContextCard itself: the
    // "not recorded" branch for the Difference row is a small shared helper
    // (also used by the summary rail's own Settlement Status line) defined
    // just above the card, not inlined in the card's own JSX.
    const card = view.slice(view.indexOf('function differenceLabel'))
    assert.equal(/context\.amount_paid\s*\?\?\s*0/.test(card), false,
      'amount_paid must render PAYMENT_NOT_RECORDED_LABEL when null, not ₹0')
    assert.match(card, /PAYMENT_NOT_RECORDED_LABEL/)
    assert.match(card, /SETTLEMENT_STATUS_NOT_RECORDED/)
  })

  test('an employee with no result in the previous period is told so, not shown blank figures', () => {
    const card = view.slice(
      view.indexOf('function PreviousMonthContextCard'),
      view.indexOf('export function AdjustmentsAndSettlement'),
    )
    assert.match(card, /has_result/)
    assert.match(card, /No payroll record for this employee/)
  })

  test('the carry-forward figure shown is THIS period’s own settlement, not recomputed', () => {
    // The card takes it as a prop rather than deriving it from `context`
    // (the PRECEDING period) — carrying it forward is what this period's own
    // settlement.figures.carry_forward already is.
    const workspace = view.slice(view.indexOf('export function PayrollDetailWorkspace'))
    assert.match(workspace, /carryForward=\{data\.settlement\.figures\.carry_forward\}/)
    assert.match(workspace, /carryForwardRemark=\{data\.settlement\.carry_forward\?\.remark/)
  })

  test('nothing here writes — it is display only, like the rest of settlementStore reads', () => {
    const fn = read('src/lib/payroll/settlementStore.ts')
    const body = fn.slice(fn.indexOf('export async function fetchPreviousMonthContext'))
    for (const forbidden of ['.insert(', '.update(', '.delete(', '.upsert(']) {
      assert.equal(body.slice(0, body.indexOf('// ─── Event log')).includes(forbidden), false,
        `fetchPreviousMonthContext must not ${forbidden}`)
    }
  })
})

// ─── 7. Admin-only: which route asks for it, and what happens if neither does ─

describe('admin-only enforcement: which route asks for it', () => {
  const adminRoute    = read('src/app/api/payroll/results/detail/route.ts')
  const employeeRoute = read('src/app/api/payroll/my-result/route.ts')
  const detailPayload = read('src/lib/payroll/resultDetailPayload.ts')

  test('the admin detail route opts in', () => {
    assert.match(adminRoute, /includePreviousMonth:\s*true/)
  })

  test('the employee route does not opt in at all', () => {
    assert.equal(employeeRoute.includes('includePreviousMonth'), false,
      '/api/payroll/my-result must not request Previous Month Context')
  })

  test('includePreviousMonth defaults to false in the shared builder itself', () => {
    // The default matters as much as the two call sites: if it ever flipped,
    // every reader would start receiving previous_month, employee included,
    // with neither route needing to change a line.
    assert.match(detailPayload, /includePreviousMonth\s*=\s*false/)
  })
})

// ─── 8. The real thing: buildResultDetailPayload, end to end ──────────────────
//
// Everything above is source-text proof of the wiring. This drives the actual
// function — same one both API routes call — against a minimal fake DB, to
// prove at runtime (not just by reading the code) that omitting
// includePreviousMonth leaves `previous_month` off the payload entirely, the
// way an employee's own request actually receives it, and that passing it
// produces the real figures.

const EMP2    = 'emp-2'
const PERIOD2 = 'period-2'
const PREV2   = 'period-1-prev'

/**
 * One employee-month per table — the same "ignore filters" fake used by
 * resultDetailPayload.stale.test.ts, since buildResultDetailPayload reads
 * across many tables (deduction lines, adjustments, attendance, holidays,
 * corrections, redemptions, credit settings) that this test has no reason to
 * exercise. payroll_periods and payroll_results are the two exceptions: they
 * must tell PERIOD2 and PREV2 apart, since the whole point is reading one
 * period's own result plus a DIFFERENT, preceding period's.
 */
function fakeBuilderSvc(opts: { amountPaid: number | null }) {
  const periods = [
    { id: PREV2,   payroll_month: 7, payroll_year: 2026, status: 'generated', locked_at: null, settings_snapshot: null },
    { id: PERIOD2, payroll_month: 8, payroll_year: 2026, status: 'generated', locked_at: null, settings_snapshot: null },
  ]
  const results = [
    { id: 'res-prev', payroll_period_id: PREV2, employee_id: EMP2, gross_salary: 22_057, total_deductions: 0, pending_adjustment_total: 0, days_present: 26 },
    {
      id: 'res-cur', payroll_period_id: PERIOD2, employee_id: EMP2, monthly_salary: 22_057,
      working_days_in_month: 26, days_present: 26, days_absent: 0, half_day_count: 0,
      gross_salary: 22_057, total_deductions: 0, pending_adjustment_total: 0, net_salary: 22_057,
      status: 'draft', generated_at: '2026-09-01T00:00:00Z', employee_reviewed_at: null,
      users: { full_name: 'Test Employee 2', employee_code: 'T-002' },
    },
  ]
  const settlements = [
    { payroll_period_id: PREV2, employee_id: EMP2, carry_forward_amount: 0, amount_paid: opts.amountPaid },
  ]

  const chain = (table: string, filters: Array<(r: Record<string, unknown>) => boolean> = []) => {
    const table_ = table
    const byTable: Record<string, Record<string, unknown>[]> = {
      payroll_periods: periods, payroll_results: results, payroll_settlements: settlements,
      boe_credit_payroll_applications: [], boe_credit_settings: [], boe_credit_balances: [],
      payroll_deduction_lines: [], payroll_pending_adjustments: [], payroll_settings: [],
      users: [{ id: EMP2, monthly_salary: 22_057, payroll_active: true, joining_date: null, employment_type: 'permanent' }],
      attendance_records: [], payroll_holidays: [], attendance_day_corrections: [],
      boe_credit_attendance_redemptions: [],
    }
    const rows = () => (byTable[table_] ?? []).filter(r => filters.every(f => f(r)))
    const c: Record<string, unknown> = {
      select: () => c,
      eq:     (col: string, val: unknown) => chain(table_, [...filters, r => r[col] === val]),
      is:     () => c,
      neq:    () => c,
      order:  () => c,
      limit:  () => c,
      range:  () => c,
      lte:    () => c,
      gte:    () => c,
      or:     () => c,
      single:      () => Promise.resolve({ data: rows()[0] ?? null, error: rows()[0] ? null : { message: `${table_}: no row` } }),
      maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(ok),
    }
    return c
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: (table: string) => chain(table) } as any
}

describe('buildResultDetailPayload, driven for real', () => {
  test('omits previous_month entirely when includePreviousMonth is not passed — the employee shape', async () => {
    const svc = fakeBuilderSvc({ amountPaid: 18_624 })
    const out = await buildResultDetailPayload(svc, {
      periodId: PERIOD2, employeeId: EMP2, canEdit: false, editBlocked: null,
    })
    assert.ok(out.ok, out.ok ? '' : out.error)
    assert.equal('previous_month' in (out as { payload: object }).payload, false,
      'the key must be absent, not present-and-null, exactly as /api/payroll/my-result receives it')
  })

  test('includes the real figures when includePreviousMonth: true is passed — the admin shape', async () => {
    const svc = fakeBuilderSvc({ amountPaid: 18_624 })
    const out = await buildResultDetailPayload(svc, {
      periodId: PERIOD2, employeeId: EMP2, canEdit: true, editBlocked: null, includePreviousMonth: true,
    })
    assert.ok(out.ok, out.ok ? '' : out.error)
    const pm = (out as unknown as { payload: { previous_month: { salary_payable: number; amount_paid: number | null; closing_balance: number | null } } }).payload.previous_month
    assert.ok(pm)
    assert.equal(pm.salary_payable, 22_057)
    assert.equal(pm.amount_paid, 18_624)
    assert.equal(pm.closing_balance, 3_433)
  })

  test('a null amount_paid stays null through the real payload — never coalesced to 0', async () => {
    const svc = fakeBuilderSvc({ amountPaid: null })
    const out = await buildResultDetailPayload(svc, {
      periodId: PERIOD2, employeeId: EMP2, canEdit: true, editBlocked: null, includePreviousMonth: true,
    })
    assert.ok(out.ok, out.ok ? '' : out.error)
    const pm = (out as unknown as { payload: { previous_month: { amount_paid: number | null; closing_balance: number | null; payment_status: string } } }).payload.previous_month
    assert.equal(pm.amount_paid, null)
    assert.equal(pm.closing_balance, null)
    assert.equal(pm.payment_status, 'not_recorded')
  })

  test('the current period\'s own figures are unaffected by whether previous_month was requested — no calculation drift', async () => {
    const svc1 = fakeBuilderSvc({ amountPaid: 18_624 })
    const without = await buildResultDetailPayload(svc1, {
      periodId: PERIOD2, employeeId: EMP2, canEdit: false, editBlocked: null,
    })
    const svc2 = fakeBuilderSvc({ amountPaid: 18_624 })
    const withIt = await buildResultDetailPayload(svc2, {
      periodId: PERIOD2, employeeId: EMP2, canEdit: false, editBlocked: null, includePreviousMonth: true,
    })
    assert.ok(without.ok && withIt.ok)
    const a = (without as unknown as { payload: { result: unknown; settlement: unknown } }).payload
    const b = (withIt as unknown as { payload: { result: unknown; settlement: unknown } }).payload
    assert.deepEqual(a.result, b.result)
    assert.deepEqual(a.settlement, b.settlement)
  })
})
