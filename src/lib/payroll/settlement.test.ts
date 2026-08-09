/**
 * Salary settlement — carry-forward, actual payment, closing balance.
 *
 * The defect these are shaped around is DOUBLE COUNTING. `net_salary` already
 * contains Other Adjustments, so the intuitive `net_salary + carry_forward`
 * counts every manual adjustment twice. Several tests below exist only to prove
 * that a figure is used exactly once, and the end-to-end case at the bottom
 * reconciles every displayed number against the underlying records.
 *
 * Run:
 *   npx tsx --test src/lib/payroll/settlement.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeSettlement,
  proposedCarryForwardFrom,
  closingBalanceMeaning,
  closingBalanceSentence,
  adjustmentsReconcile,
  fmtSigned,
  sameMoney,
  type SettlementResultInput,
  type SettlementRecordInput,
} from './settlement'
import { toSignedAdjustments, type StoredAdjustment } from './adjustments'
import { selectPrecedingPeriod } from './settlementStore'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** The worked example from the specification, as payroll_results stores it. */
const GROSS       = 26_500
const DEDUCTIONS  = 2_578.05
const AFTER_ATTENDANCE = 23_921.95   // 26,500 − 2,578.05

function result(overrides: Partial<SettlementResultInput> = {}): SettlementResultInput {
  return {
    gross_salary:             GROSS,
    total_deductions:         DEDUCTIONS,
    pending_adjustment_total: 0,
    days_present:             24,
    ...overrides,
  }
}

function settlement(overrides: Partial<NonNullable<SettlementRecordInput>> = {}): SettlementRecordInput {
  return { carry_forward_amount: 0, amount_paid: null, ...overrides }
}

// ─── Salary after attendance ──────────────────────────────────────────────────

describe('salary after attendance', () => {
  test('is gross minus deductions, taken from stored columns', () => {
    const f = computeSettlement(result(), settlement())
    assert.equal(f.salary_after_attendance, AFTER_ATTENDANCE)
  })

  test('is NOT derived from net_salary — the clamp would corrupt it', () => {
    // net_salary is max(0, gross − deductions + adjustments). Deriving
    // "after attendance" as net_salary − adjustments inverts that clamp and
    // produces a wrong number whenever it fired. Proof: a recovery big enough to
    // clamp net_salary to 0 leaves salary_after_attendance untouched.
    const f = computeSettlement(result({ pending_adjustment_total: -30_000 }), settlement())
    assert.equal(f.salary_after_attendance, AFTER_ATTENDANCE)
  })

  test('floors at zero for a month with no attendance at all', () => {
    // ~27 working days charged at salary÷26 makes gross − deductions negative,
    // which is a divisor artefact rather than a debt.
    const f = computeSettlement(
      result({ days_present: 0, total_deductions: 27_519.23 }),
      settlement(),
    )
    assert.equal(f.salary_after_attendance, 0)
  })

  test('the absence floor does NOT wipe out money owed from an earlier month', () => {
    // Confirmed business meaning: a debt from June survives a fully absent July.
    const f = computeSettlement(
      result({ days_present: 0, total_deductions: 27_519.23 }),
      settlement({ carry_forward_amount: 2_000 }),
    )
    assert.equal(f.salary_after_attendance, 0)
    assert.equal(f.salary_payable, 2_000)
  })
})

// ─── Carry forward ────────────────────────────────────────────────────────────

describe('carry forward', () => {
  test('positive carry forward increases Salary Payable — BOE still owes', () => {
    const f = computeSettlement(result(), settlement({ carry_forward_amount: 2_000 }))
    assert.equal(f.carry_forward, 2_000)
    assert.equal(f.salary_payable, AFTER_ATTENDANCE + 2_000)
  })

  test('negative carry forward decreases Salary Payable — already advanced', () => {
    const f = computeSettlement(result(), settlement({ carry_forward_amount: -1_500 }))
    assert.equal(f.carry_forward, -1_500)
    assert.equal(f.salary_payable, AFTER_ATTENDANCE - 1_500)
  })

  test('zero carry forward leaves Salary Payable at salary after attendance', () => {
    const f = computeSettlement(result(), settlement({ carry_forward_amount: 0 }))
    assert.equal(f.salary_payable, AFTER_ATTENDANCE)
  })

  test('a month with no settlement row yet reads as no carry forward and no payment', () => {
    const f = computeSettlement(result(), null)
    assert.equal(f.carry_forward, 0)
    assert.equal(f.amount_paid, null)
    assert.equal(f.payment_status, 'not_recorded')
    assert.equal(f.closing_balance, null)
    assert.equal(f.salary_payable, AFTER_ATTENDANCE)
  })
})

// ─── Next month's proposal ────────────────────────────────────────────────────

describe('next-month carry forward', () => {
  test("July's closing balance becomes August's proposed previous balance", () => {
    // July: payable 25,000, paid 23,000 → closing +2,000.
    const july = computeSettlement(
      result({ gross_salary: 25_000, total_deductions: 0 }),
      settlement({ amount_paid: 23_000 }),
    )
    assert.equal(july.closing_balance, 2_000)

    const august = computeSettlement(
      result(),
      settlement({ carry_forward_amount: proposedCarryForwardFrom(july.closing_balance) }),
    )
    assert.equal(august.carry_forward, 2_000)
  })

  test('a negative closing balance carries forward as a negative opening balance', () => {
    // The sign must survive the hand-off, or every advance becomes a debt.
    const july = computeSettlement(
      result({ gross_salary: 25_000, total_deductions: 0 }),
      settlement({ amount_paid: 28_000 }),
    )
    assert.equal(july.closing_balance, -3_000)
    assert.equal(proposedCarryForwardFrom(july.closing_balance), -3_000)
  })

  test('a fully settled month proposes nothing for the next', () => {
    const july = computeSettlement(
      result({ gross_salary: 25_000, total_deductions: 0 }),
      settlement({ amount_paid: 25_000 }),
    )
    assert.equal(proposedCarryForwardFrom(july.closing_balance), 0)
  })

  test('a month whose payment was never recorded carries NOTHING forward', () => {
    // The corrected rule. An unrecorded payment leaves no confirmed closing
    // balance, so there is nothing to bring forward. Carrying the full Salary
    // Payable — which is what treating null as ₹0 did — would invent a debt out
    // of an admin simply not having filled the figure in yet, and then present
    // that invention as a reviewed number on the next payslip.
    const july = computeSettlement(result({ gross_salary: 25_000, total_deductions: 0 }), settlement())

    assert.equal(july.payment_status, 'not_recorded')
    assert.equal(july.closing_balance, null)
    assert.equal(proposedCarryForwardFrom(july.closing_balance), 0)
  })

  test('a month with a recorded ₹0 payment DOES carry the whole payable forward', () => {
    // The contrast that makes the rule above safe: recording ₹0 is a statement
    // that nothing was paid, so the entire amount really is still owed.
    const july = computeSettlement(
      result({ gross_salary: 25_000, total_deductions: 0 }),
      settlement({ amount_paid: 0 }),
    )

    assert.equal(july.payment_status, 'recorded')
    assert.equal(july.closing_balance, 25_000)
    assert.equal(proposedCarryForwardFrom(july.closing_balance), 25_000)
  })
})

// ─── Other adjustments ────────────────────────────────────────────────────────

describe('other adjustments', () => {
  test('a positive adjustment increases payable', () => {
    const f = computeSettlement(result({ pending_adjustment_total: 800 }), settlement())
    assert.equal(f.other_adjustments, 800)
    assert.equal(f.salary_payable, AFTER_ATTENDANCE + 800)
  })

  test('a negative adjustment decreases payable', () => {
    const f = computeSettlement(result({ pending_adjustment_total: -500 }), settlement())
    assert.equal(f.salary_payable, AFTER_ATTENDANCE - 500)
  })

  test('multiple adjustments sum through the engine total, not by re-adding rows', () => {
    // +800 − 500 = +300, as the engine already stored it.
    const rows: StoredAdjustment[] = [
      { id: 'a1', adjustment_type: 'addition',  amount: 800, description: 'Travel reimbursement' },
      { id: 'a2', adjustment_type: 'deduction', amount: 500, description: 'Advance recovery' },
    ]
    const signed = toSignedAdjustments(rows).map(a => a.amount)
    assert.deepEqual(signed, [800, -500])

    const engineTotal = 300
    assert.equal(adjustmentsReconcile(signed, engineTotal), true)

    const f = computeSettlement(result({ pending_adjustment_total: engineTotal }), settlement())
    assert.equal(f.other_adjustments, 300)
  })

  test('itemised rows that do not sum to the engine total are caught', () => {
    // The real defect this guards: reading `amount` without `adjustment_type`
    // makes a deduction look like an addition. +800 +500 = 1300 ≠ 300.
    const unsignedByMistake = [800, 500]
    assert.equal(adjustmentsReconcile(unsignedByMistake, 300), false)
  })

  test('net adjustments combine carry forward and other adjustments, each once', () => {
    const f = computeSettlement(
      result({ pending_adjustment_total: 300 }),
      settlement({ carry_forward_amount: 2_000 }),
    )
    assert.equal(f.net_adjustments, 2_300)
    // The double-count trap: net_salary would be 23,921.95 + 300 = 24,221.95.
    // Adding carry-forward to THAT and calling it payable gives 26,221.95 too —
    // by luck, here. Prove the components are right, not just the total.
    assert.equal(f.other_adjustments, 300)
    assert.equal(f.carry_forward, 2_000)
    assert.equal(f.salary_after_attendance, AFTER_ATTENDANCE)
  })

  test('an adjustment is never counted in both salary after attendance and net adjustments', () => {
    const withAdjustment = computeSettlement(result({ pending_adjustment_total: 800 }), settlement())
    const without        = computeSettlement(result({ pending_adjustment_total: 0 }),   settlement())

    // Salary after attendance must be identical — adjustments live only in the
    // adjustments line.
    assert.equal(withAdjustment.salary_after_attendance, without.salary_after_attendance)
    // And the payable must differ by the adjustment exactly once.
    assert.equal(withAdjustment.salary_payable - without.salary_payable, 800)
  })
})

// ─── Actual payment ───────────────────────────────────────────────────────────

describe('actual amount paid', () => {
  test('paid == payable gives a zero closing balance', () => {
    const f = computeSettlement(
      result({ gross_salary: 25_000, total_deductions: 0 }),
      settlement({ amount_paid: 25_000 }),
    )
    assert.equal(f.salary_payable, 25_000)
    assert.equal(f.closing_balance, 0)
    assert.equal(closingBalanceMeaning(f), 'settled')
  })

  test('paid < payable gives a POSITIVE closing balance — BOE owes', () => {
    const f = computeSettlement(
      result({ gross_salary: 25_000, total_deductions: 0 }),
      settlement({ amount_paid: 22_000 }),
    )
    assert.equal(f.closing_balance, 3_000)
    assert.equal(closingBalanceMeaning(f), 'owed_to_employee')
  })

  test('paid > payable gives a NEGATIVE closing balance — advance', () => {
    const f = computeSettlement(
      result({ gross_salary: 25_000, total_deductions: 0 }),
      settlement({ amount_paid: 28_000 }),
    )
    assert.equal(f.closing_balance, -3_000)
    assert.equal(closingBalanceMeaning(f), 'paid_in_advance')
  })

  test('recording a payment changes nothing except the closing balance', () => {
    // The core requirement: a payment is a settlement record, not a payroll
    // input. Everything above the payment line must be byte-identical.
    const before = computeSettlement(result({ pending_adjustment_total: 300 }), settlement({ carry_forward_amount: 2_000 }))
    const after  = computeSettlement(result({ pending_adjustment_total: 300 }), settlement({ carry_forward_amount: 2_000, amount_paid: 24_000 }))

    assert.equal(after.gross_salary,            before.gross_salary)
    assert.equal(after.attendance_deductions,   before.attendance_deductions)
    assert.equal(after.salary_after_attendance, before.salary_after_attendance)
    assert.equal(after.other_adjustments,       before.other_adjustments)
    assert.equal(after.carry_forward,           before.carry_forward)
    assert.equal(after.salary_payable,          before.salary_payable)

    assert.notEqual(after.closing_balance, before.closing_balance)
  })

  test('a recorded ₹0 and an unrecorded payment are NOT the same thing', () => {
    // These used to produce an identical closing balance, which is precisely the
    // defect: the screen could not tell "we paid nothing" from "nobody has said".
    const paidNothing = computeSettlement(result(), settlement({ amount_paid: 0 }))
    const notRecorded = computeSettlement(result(), settlement({ amount_paid: null }))

    assert.equal(paidNothing.payment_status, 'recorded')
    assert.equal(paidNothing.closing_balance, AFTER_ATTENDANCE)

    assert.equal(notRecorded.payment_status, 'not_recorded')
    assert.equal(notRecorded.closing_balance, null)

    assert.notEqual(paidNothing.closing_balance, notRecorded.closing_balance)
    assert.equal(closingBalanceMeaning(notRecorded), 'unrecorded')
  })

  test('an unrecorded payment never states a balance figure, in any form', () => {
    const f = computeSettlement(result(), settlement())
    assert.equal(f.closing_balance, null)
    // And the prose must not name one either.
    const sentence = closingBalanceSentence(f)
    assert.equal(/\d/.test(sentence), false, `a figure leaked into: "${sentence}"`)
    assert.match(sentence, /has not been recorded/)
  })
})

// ─── Negative payable ─────────────────────────────────────────────────────────

describe('negative Salary Payable', () => {
  test('a recovery larger than the month leaves a negative payable, not zero', () => {
    // net_salary would be clamped to ₹0 here. Settlement must not be.
    const f = computeSettlement(
      result({ pending_adjustment_total: -30_000 }),
      settlement(),
    )
    assert.equal(f.salary_payable, AFTER_ATTENDANCE - 30_000)
    assert.ok(f.salary_payable < 0, 'a negative payable must survive — it is what an advance means')
  })

  test('a negative payable with a recorded ₹0 carries the debt against the employee', () => {
    const f = computeSettlement(result({ pending_adjustment_total: -30_000 }), settlement({ amount_paid: 0 }))
    assert.ok((f.closing_balance ?? 0) < 0)
    assert.equal(closingBalanceMeaning(f), 'paid_in_advance')
    assert.equal(proposedCarryForwardFrom(f.closing_balance) < 0, true, 'the advance must follow the employee forward')
  })
})

// ─── Plain language ───────────────────────────────────────────────────────────

describe('closing balance in plain language', () => {
  test('says what is pending, what is advanced, and what is settled', () => {
    const owed     = computeSettlement(result({ gross_salary: 25_000, total_deductions: 0 }), settlement({ amount_paid: 22_000 }))
    const advanced = computeSettlement(result({ gross_salary: 25_000, total_deductions: 0 }), settlement({ amount_paid: 28_000 }))
    const settled  = computeSettlement(result({ gross_salary: 25_000, total_deductions: 0 }), settlement({ amount_paid: 25_000 }))

    assert.match(closingBalanceSentence(owed),     /₹3,000\.00 is currently pending from BOE/)
    assert.match(closingBalanceSentence(advanced), /₹3,000\.00 has already been paid in advance/)
    assert.match(closingBalanceSentence(settled),  /fully settled/)
  })

  test('never shows a minus sign inside the advance sentence', () => {
    // "−₹3,000 has already been paid in advance" reads as a negative payment.
    const advanced = computeSettlement(result({ gross_salary: 25_000, total_deductions: 0 }), settlement({ amount_paid: 28_000 }))
    assert.equal(closingBalanceSentence(advanced).includes('−'), false)
    assert.equal(closingBalanceSentence(advanced).includes('-'), false)
  })
})

// ─── Signs ────────────────────────────────────────────────────────────────────

describe('signed formatting', () => {
  test('prints an explicit sign so direction does not depend on colour', () => {
    assert.equal(fmtSigned(2_000),    '+₹2,000.00')
    assert.equal(fmtSigned(-1_500),   '−₹1,500.00')
    assert.equal(fmtSigned(0),        '₹0.00')
    assert.equal(fmtSigned(2_221.95), '+₹2,221.95')
  })

  test('a negative figure prints its magnitude, not a doubled sign', () => {
    assert.equal(fmtSigned(-500).includes('--'), false)
    assert.equal(fmtSigned(-500), '−₹500.00')
  })

  test('a zero figure carries NO sign at all', () => {
    // "−₹0.00" is not a smaller number than "₹0.00" — it reads as a negative
    // quantity, which is meaningless for money and makes a deliberately
    // recorded ₹0 payment look like a data error. Every signed formatter in the
    // module must agree on this.
    assert.equal(fmtSigned(0), '₹0.00')
    assert.equal(fmtSigned(-0), '₹0.00')
    assert.equal(fmtSigned(0.001), '₹0.00', 'sub-paisa noise must not acquire a sign')
    assert.equal(fmtSigned(-0.001), '₹0.00')
  })

  test('a recorded ₹0 payment still leaves the whole payable outstanding', () => {
    // The display fix must not touch the arithmetic: ₹0 shown unsigned, but the
    // closing balance is still the full Salary Payable.
    const f = computeSettlement(
      result({ gross_salary: 25_000, total_deductions: 0 }),
      settlement({ amount_paid: 0 }),
    )
    assert.equal(f.amount_paid, 0)
    assert.equal(f.closing_balance, 25_000)
    assert.equal(closingBalanceMeaning(f), 'owed_to_employee')
  })
})

// ─── Historical stability ─────────────────────────────────────────────────────

describe('historical stability', () => {
  test('a locked month recomputes to the same figures from the same records', () => {
    // Settlement stores no totals, so "the figures cannot drift" reduces to
    // "the function is pure over its stored inputs". Pin it.
    const r = result({ pending_adjustment_total: 300 })
    const s = settlement({ carry_forward_amount: 2_000, amount_paid: 24_000 })

    assert.deepEqual(computeSettlement(r, s), computeSettlement(r, s))
  })

  test('regenerating a different employee cannot change this one', () => {
    // Settlement reads only this employee's own result and settlement rows.
    const mine   = computeSettlement(result({ pending_adjustment_total: 300 }), settlement({ carry_forward_amount: 2_000 }))
    const theirs = computeSettlement(result({ gross_salary: 90_000 }), settlement({ carry_forward_amount: -9_999 }))

    assert.equal(mine.salary_payable, AFTER_ATTENDANCE + 2_300)
    assert.ok(!sameMoney(theirs.salary_payable, mine.salary_payable))
  })
})

// ─── Which period a balance comes from ────────────────────────────────────────

describe('selecting the preceding payroll period', () => {
  const may  = { id: 'may',  payroll_month: 5, payroll_year: 2026 }
  const july = { id: 'july', payroll_month: 7, payroll_year: 2026 }

  test('a skipped calendar month falls back to the preceding EXISTING period', () => {
    // The corrected rule. May and July exist, June was never run — July's prior
    // period is MAY. Looking up "the previous calendar month" found nothing and
    // silently dropped whatever May left outstanding.
    assert.equal(selectPrecedingPeriod([may, july], 7, 2026)?.id, 'may')
  })

  test('the immediately preceding month is used when it does exist', () => {
    const june = { id: 'june', payroll_month: 6, payroll_year: 2026 }
    assert.equal(selectPrecedingPeriod([may, june, july], 7, 2026)?.id, 'june')
  })

  test('no earlier period at all yields null — the first payroll month', () => {
    assert.equal(selectPrecedingPeriod([july], 7, 2026), null)
    assert.equal(selectPrecedingPeriod([], 7, 2026), null)
  })

  test('a later period is never selected', () => {
    const august = { id: 'august', payroll_month: 8, payroll_year: 2026 }
    assert.equal(selectPrecedingPeriod([august], 7, 2026), null)
    assert.equal(selectPrecedingPeriod([may, august], 7, 2026)?.id, 'may')
  })

  test('the period itself is never its own predecessor', () => {
    assert.equal(selectPrecedingPeriod([july], 7, 2026), null)
  })

  test('crosses a year boundary correctly', () => {
    const december = { id: 'dec', payroll_month: 12, payroll_year: 2025 }
    assert.equal(selectPrecedingPeriod([december], 1, 2026)?.id, 'dec')
  })

  test('picks the latest predecessor across years, not the earliest', () => {
    const old2024 = { id: 'old', payroll_month: 11, payroll_year: 2024 }
    const feb2026 = { id: 'feb', payroll_month: 2,  payroll_year: 2026 }
    assert.equal(selectPrecedingPeriod([old2024, feb2026], 7, 2026)?.id, 'feb')
  })

  test('unordered input does not change the answer', () => {
    const june = { id: 'june', payroll_month: 6, payroll_year: 2026 }
    assert.equal(selectPrecedingPeriod([july, may, june], 7, 2026)?.id, 'june')
  })
})

// ─── Carry-forward when the prior month is unresolved ─────────────────────────

describe('carry forward across an unresolved prior month', () => {
  test('a prior period with a RECORDED payment carries its closing balance', () => {
    const prior = computeSettlement(
      result({ gross_salary: 25_000, total_deductions: 0 }),
      settlement({ amount_paid: 23_000 }),
    )
    assert.equal(proposedCarryForwardFrom(prior.closing_balance), 2_000)
  })

  test('a prior period with NO recorded payment carries nothing', () => {
    // Even though ₹25,000 was payable. Nobody has said what was paid, so there
    // is no balance — and inventing one would put a ₹25,000 debt on the next
    // payslip that no human ever reviewed.
    const prior = computeSettlement(
      result({ gross_salary: 25_000, total_deductions: 0 }),
      settlement({ amount_paid: null }),
    )
    assert.equal(prior.closing_balance, null)
    assert.equal(proposedCarryForwardFrom(prior.closing_balance), 0)
  })

  test('an unresolved prior month does not become a negative balance either', () => {
    // The failure mode is symmetric: a negative payable with no recorded payment
    // must not silently become an advance the employee is chased for.
    const prior = computeSettlement(
      result({ pending_adjustment_total: -30_000 }),
      settlement({ amount_paid: null }),
    )
    assert.ok(prior.salary_payable < 0)
    assert.equal(proposedCarryForwardFrom(prior.closing_balance), 0)
  })
})

// ─── The specification's worked example, end to end ───────────────────────────

describe('end-to-end: the specification example', () => {
  test('every figure matches, and no adjustment is counted twice', () => {
    // Gross ₹26,500 · Deductions ₹2,578.05 · Previous +₹2,000
    // Other +₹800 and −₹500 · Paid ₹24,000
    const adjustmentRows: StoredAdjustment[] = [
      { id: 'a1', adjustment_type: 'addition',  amount: 800, description: 'Travel reimbursement' },
      { id: 'a2', adjustment_type: 'deduction', amount: 500, description: 'Advance recovery' },
    ]

    // The engine's stored total, and the itemised rows, must agree.
    const signed      = toSignedAdjustments(adjustmentRows).map(a => a.amount)
    const engineTotal = 300
    assert.equal(adjustmentsReconcile(signed, engineTotal), true,
      'the itemised rows must sum to the total the engine applied')

    const figures = computeSettlement(
      {
        gross_salary:             26_500,
        total_deductions:         2_578.05,
        pending_adjustment_total: engineTotal,
        days_present:             24,
      },
      { carry_forward_amount: 2_000, amount_paid: 24_000 },
    )

    assert.ok(sameMoney(figures.salary_after_attendance, 23_921.95), `salary after attendance was ${figures.salary_after_attendance}`)
    assert.ok(sameMoney(figures.net_adjustments,          2_300),    `net adjustments were ${figures.net_adjustments}`)
    assert.ok(sameMoney(figures.salary_payable,          26_221.95), `salary payable was ${figures.salary_payable}`)
    assert.equal(figures.payment_status, 'recorded')
    assert.ok(figures.closing_balance != null)
    assert.ok(sameMoney(figures.closing_balance, 2_221.95), `closing balance was ${figures.closing_balance}`)

    // And the arithmetic holds as a chain, not just at the endpoints.
    assert.ok(sameMoney(
      figures.salary_after_attendance + figures.net_adjustments,
      figures.salary_payable,
    ))
    assert.ok(sameMoney(
      figures.salary_payable - (figures.amount_paid ?? 0),
      figures.closing_balance,
    ))

    // The trap, stated as an assertion: net_salary (which already holds the
    // +₹300) plus the carry-forward must NOT be how payable is reached.
    const netSalary = 26_500 - 2_578.05 + 300      // what the engine stored
    const doubleCounted = netSalary + 2_000 + 300  // adding "other adjustments" again
    assert.ok(!sameMoney(doubleCounted, figures.salary_payable),
      'the double-counted figure must not equal the correct payable')
  })
})
