/**
 * The review credits card reaches the payslip payload — for BOTH readers — and
 * can never change a salary figure or take the payslip down with it.
 *
 * buildResultDetailPayload serves the admin reviewing a payslip and the employee
 * whose payslip it is. This drives that real builder with a table-keyed fake:
 *   - the admin reader and the employee reader both get `review_credits`;
 *   - the settlement (Salary Payable, the BOE Credit Addition) is identical with
 *     and without the card — it explains the addition, it never feeds it;
 *   - a month with no review credit has `review_credits: null`;
 *   - a read that throws drops the card, and the payslip still opens.
 *
 * Run:
 *   npx tsx --test src/lib/payroll/resultDetailPayload.reviewCredits.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildResultDetailPayload } from './resultDetailPayload'

const EMP = 'emp-1'
const PERIOD = 'period-1'
const JULY_WORKING_DAYS = [1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 20, 21, 22, 23, 24, 25, 27, 28, 29, 30, 31]
const iso = (d: number) => `2026-07-${String(d).padStart(2, '0')}`
const at  = (d: number, hh: number, mm: number) => new Date(Date.UTC(2026, 6, d, hh, mm - 330)).toISOString()
const ATTENDANCE = JULY_WORKING_DAYS.map(d => ({
  id: `r-${d}`, user_id: EMP, attendance_date: iso(d), check_in_at: at(d, 10, 0), check_out_at: at(d, 18, 30), punch_direction_source: 'confirmed',
}))

/** Filters are ignored: every table holds one employee-month, like the sibling payload test. */
function fakeSvc(tables: Record<string, unknown[]>, throwOn?: string) {
  const chain = (table: string): Record<string, unknown> => {
    if (table === throwOn) throw new Error(`${table} is unreachable`)
    const c: Record<string, unknown> = {}
    for (const op of ['select', 'eq', 'neq', 'is', 'gte', 'lt', 'in', 'or', 'order', 'limit', 'range']) c[op] = () => c
    const rows = () => tables[table] ?? []
    c.single      = () => Promise.resolve({ data: rows()[0] ?? null, error: rows()[0] ? null : { message: `${table}: no row` } })
    c.maybeSingle = () => Promise.resolve({ data: rows()[0] ?? null, error: null })
    c.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(ok)
    return c
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: (table: string) => chain(table) } as any
}

/** Jasvi's month in miniature: two approved reviews (1 + 1.5 credits), 1.5 applied. */
const REVIEW_TABLES = {
  boe_credit_review_rewards: [
    { employee_id: EMP, review_month: '2026-07-01', transaction_id: 'tx-1', card_id: 'card-1', card_ref: 'CR-000001', submitted_at: '2026-07-05T06:00:00Z' },
    { employee_id: EMP, review_month: '2026-07-01', transaction_id: 'tx-2', card_id: 'card-2', card_ref: 'CR-000002', submitted_at: '2026-07-19T06:00:00Z' },
  ],
  boe_credit_transactions: [
    { id: 'tx-1', credits: '1.00' },
    { id: 'tx-2', credits: '1.50' },
  ],
  customer_review_custom_submissions: [{ id: 'card-1', review_type: 'text' }, { id: 'card-2', review_type: 'image' }],
  boe_credit_review_months: [{ employee_id: EMP, review_month: '2026-07-01', status: 'qualified', qualifying_review_count: 2, minimum_reviews_snapshot: 2 }],
  boe_credit_balances: [{ employee_id: EMP, available_credits: 2.5, provisional_credits: 0, spendable_credits: 1, transaction_count: 3, last_transaction_at: null }],
  boe_credit_payroll_applications: [{
    id: 'app-1', employee_id: EMP, payroll_period_id: PERIOD, credits_used: 1.5, credit_value_snapshot: 50, credit_amount_snapshot: 75,
    redemption_transaction_id: 'tx-r', reversal_transaction_id: null, reversed_at: null, created_at: '2026-08-02T00:00:00Z',
  }],
}

function tables(withReviews: boolean): Record<string, unknown[]> {
  return {
    boe_credit_settings: [{ id: 's-1', review_reward_credits: 1, credit_value: 50, half_day_redemption_credits: 8, full_day_redemption_credits: 15, minimum_monthly_reviews: 3, half_day_redemption_enabled: false, full_day_redemption_enabled: false, note: null, created_at: '2026-09-01T00:00:00Z', created_by: null }],
    payroll_periods: [{ id: PERIOD, payroll_month: 7, payroll_year: 2026, status: 'generated', locked_at: null, settings_snapshot: null }],
    payroll_results: [{
      id: 'res-1', employee_id: EMP, monthly_salary: 26_000, working_days_in_month: 27, days_present: 27, days_absent: 0, half_day_count: 0,
      gross_salary: 26_000, total_deductions: 0, pending_adjustment_total: 0, net_salary: 26_000,
      status: 'draft', generated_at: '2026-08-01T00:00:00Z', employee_reviewed_at: null,
      users: { full_name: 'Test Employee', employee_code: 'T-001' },
    }],
    payroll_deduction_lines: [],
    payroll_pending_adjustments: [],
    payroll_settlements: [],
    payroll_settings: [],
    users: [{ id: EMP, monthly_salary: 26_000, payroll_active: true, joining_date: null, employment_type: 'permanent' }],
    attendance_records: ATTENDANCE,
    payroll_holidays: [],
    attendance_day_corrections: [],
    boe_credit_attendance_redemptions: [],
    // The applied credits exist in both worlds; only the review rows differ.
    boe_credit_payroll_applications: REVIEW_TABLES.boe_credit_payroll_applications,
    ...(withReviews ? REVIEW_TABLES : {}),
  }
}

async function payloadFor(svc: ReturnType<typeof fakeSvc>, canRedeem: boolean) {
  const out = await buildResultDetailPayload(svc, { periodId: PERIOD, employeeId: EMP, canEdit: false, editBlocked: null, canRedeem })
  assert.ok(out.ok, out.ok ? '' : out.error)
  return out.ok ? out.payload : null!
}

describe('review_credits in the payslip payload', () => {
  for (const [reader, canRedeem] of [['admin', false], ['employee', true]] as const) {
    test(`the ${reader} reader gets each review and the totals`, async () => {
      const p = await payloadFor(fakeSvc(tables(true)), canRedeem)
      const rc = p.review_credits
      assert.ok(rc, 'review_credits is present')
      assert.equal(rc.review_month, '2026-07-01')
      assert.deepEqual(rc.reviews.map((r: { card_ref: string; review_type: string; credits: number }) => [r.card_ref, r.review_type, r.credits]), [
        ['CR-000001', 'text', 1],
        ['CR-000002', 'image', 1.5],
      ])
      assert.equal(rc.earned_credits, 2.5)
      assert.equal(rc.earned_amount, 125)
      assert.equal(rc.spendable_credits, 1)
      // "Applied" is the settlement's own figure (the page keeps it current after
      // Apply / Change / Remove); the block carries no second copy of it.
      assert.deepEqual(p.settlement.credits, { credits_used: 1.5, credit_value: 50, amount: 75 })
      assert.ok(!('applied_credits' in rc) && !('applied_amount' in rc))
    })
  }

  test('the card never moves money: the settlement is the same with and without it', async () => {
    const withCard    = await payloadFor(fakeSvc(tables(true)), false)
    const withoutCard = await payloadFor(fakeSvc(tables(false)), false)
    assert.ok(withCard.review_credits)
    assert.equal(withoutCard.review_credits, null)
    assert.equal(withCard.settlement.figures.boe_credit_addition, 75)
    assert.deepEqual(withCard.settlement.figures, withoutCard.settlement.figures)
    assert.deepEqual(withCard.settlement.credits, withoutCard.settlement.credits)
  })

  test('a month with no review credit has no card', async () => {
    const p = await payloadFor(fakeSvc({ ...tables(true), boe_credit_review_rewards: [] }), false)
    assert.equal(p.review_credits, null)
  })

  test('a read that fails drops the card; the payslip and its settlement still open', async () => {
    const silence = console.error
    console.error = () => {}
    try {
      const p = await payloadFor(fakeSvc(tables(true), 'boe_credit_review_months'), false)
      assert.equal(p.review_credits, null)
      assert.equal(p.settlement.figures.boe_credit_addition, 75)
      assert.equal(p.result.employee_name, 'Test Employee')
    } finally {
      console.error = silence
    }
  })
})
