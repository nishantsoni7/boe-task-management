/**
 * Payroll deletion rules — pure, no database.
 *
 * These are the decisions the API route, the row menu and the confirmation
 * dialog all defer to. Everything asserted here is asserted again against a real
 * database in src/app/api/payroll/delete/route.test.ts — the two suites are not
 * duplicates: this one pins the WORDING and the ORDER of the refusals, that one
 * proves the database enforces the same answers when the UI is bypassed.
 *
 * Run:
 *   npx tsx --test src/lib/payroll/deletionRules.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  canDeletePayrollPeriod,
  payrollDeletionConfirmationMatches,
  payrollDeletionConfirmationText,
  payrollDeletionScope,
  validateDeletionReason,
  DELETION_REASON_MAX_LENGTH,
  type PayrollDeletionFacts,
} from './deletionRules'

/** A generated month with nothing standing in the way of deleting it. */
const deletable = (over: Partial<PayrollDeletionFacts> = {}): PayrollDeletionFacts => ({
  status: 'generated',
  resultCount: 9,
  settlementCount: 9,
  paidSettlementCount: 0,
  lockedResultCount: 0,
  generationRunning: false,
  carryForwardDependentCount: 0,
  ...over,
})

describe('canDeletePayrollPeriod — authorization', () => {
  test('an admin may delete an eligible payroll', () => {
    const p = canDeletePayrollPeriod('admin', deletable())
    assert.equal(p.allowed, true)
  })

  test('an employee is denied', () => {
    const p = canDeletePayrollPeriod('employee', deletable())
    assert.equal(p.allowed, false)
    assert.equal(p.allowed === false && p.reason, 'not_authorised')
  })

  test('a manager is denied — managers are not admins in this codebase', () => {
    const p = canDeletePayrollPeriod('manager', deletable())
    assert.equal(p.allowed, false)
    assert.equal(p.allowed === false && p.reason, 'not_authorised')
  })

  test('every non-admin role is denied, including ones that do not exist yet', () => {
    for (const role of ['employee', 'manager', 'hr', 'finance', 'custom', '', 'ADMIN', 'Admin']) {
      const p = canDeletePayrollPeriod(role, deletable())
      assert.equal(p.allowed, false, `role "${role}" must not be able to delete payroll`)
    }
  })

  test('a missing role is denied — module visibility is not a payroll permission', () => {
    // The shape a Control Center "Custom" member arrives in: they can open the
    // Payroll module, so they reach this code, and they still cannot delete.
    assert.equal(canDeletePayrollPeriod(null,      deletable()).allowed, false)
    assert.equal(canDeletePayrollPeriod(undefined, deletable()).allowed, false)
  })

  test('authorization is decided before the period state, so a non-admin learns nothing about it', () => {
    const p = canDeletePayrollPeriod('employee', deletable({ status: 'locked', paidSettlementCount: 4 }))
    assert.equal(p.allowed === false && p.reason, 'not_authorised')
    assert.ok(!/locked|payment/i.test(p.allowed === false ? p.message : ''))
  })
})

describe('canDeletePayrollPeriod — safety rules', () => {
  test('a draft payroll is deletable, and removes no employee-visible salary', () => {
    const p = canDeletePayrollPeriod('admin', deletable({ status: 'draft', resultCount: 0, settlementCount: 0 }))
    assert.equal(p.allowed, true)
    assert.equal(p.allowed === true && p.removesEmployeeVisibleSalary, false)
  })

  test('a generated, unpaid, unsettled payroll is deletable and DOES remove visible salary', () => {
    const p = canDeletePayrollPeriod('admin', deletable())
    assert.equal(p.allowed, true)
    assert.equal(p.allowed === true && p.removesEmployeeVisibleSalary, true)
  })

  test('a locked payroll is blocked, and is told to unlock first', () => {
    const p = canDeletePayrollPeriod('admin', deletable({ status: 'locked' }))
    assert.equal(p.allowed, false)
    assert.equal(p.allowed === false && p.reason, 'locked')
    assert.match(p.allowed === false ? p.resolution : '', /unlock/i)
  })

  test('deletion never unlocks anything itself — the remedy is a separate action', () => {
    const p = canDeletePayrollPeriod('admin', deletable({ status: 'locked' }))
    // The resolution instructs the admin; it does not describe something this
    // feature does on their behalf.
    assert.match(p.allowed === false ? p.resolution : '', /Unlock the payroll first/i)
  })

  test('a payroll with a recorded payment is blocked', () => {
    const p = canDeletePayrollPeriod('admin', deletable({ paidSettlementCount: 1 }))
    assert.equal(p.allowed, false)
    assert.equal(p.allowed === false && p.reason, 'paid')
  })

  test('a settled payroll is permanent — the remedy is never "delete the payment"', () => {
    const p = canDeletePayrollPeriod('admin', deletable({ paidSettlementCount: 3 }))
    assert.equal(p.allowed === false && p.reason, 'paid')
    assert.doesNotMatch(p.allowed === false ? p.resolution : '', /remove the payment|delete the payment/i)
  })

  test('unpaid settlement records alone do not block deletion', () => {
    // Every generated result materialises a settlement row, so their existence
    // cannot be the test — only a recorded payment is.
    const p = canDeletePayrollPeriod('admin', deletable({ settlementCount: 11, paidSettlementCount: 0 }))
    assert.equal(p.allowed, true)
  })

  test('a locked employee result blocks deletion even when the period is not locked', () => {
    const p = canDeletePayrollPeriod('admin', deletable({ lockedResultCount: 2 }))
    assert.equal(p.allowed === false && p.reason, 'result_locked')
  })

  test('deletion while a generation is running is blocked', () => {
    const p = canDeletePayrollPeriod('admin', deletable({ generationRunning: true }))
    assert.equal(p.allowed === false && p.reason, 'generation_running')
  })

  test('a later payroll carrying a non-zero balance forward blocks deletion', () => {
    const p = canDeletePayrollPeriod('admin', deletable({ carryForwardDependentCount: 1 }))
    assert.equal(p.allowed === false && p.reason, 'carry_forward_dependency')
  })

  test('refusals are ordered locked → paid → result-locked → running → carry-forward', () => {
    // A period failing every test names the most recoverable one first, so the
    // admin is not sent round a loop fixing the wrong thing.
    const everything = deletable({
      status: 'locked',
      paidSettlementCount: 1,
      lockedResultCount: 1,
      generationRunning: true,
      carryForwardDependentCount: 1,
    })
    assert.equal(canDeletePayrollPeriod('admin', everything).allowed === false
      && (canDeletePayrollPeriod('admin', everything) as { reason: string }).reason, 'locked')

    const paidFirst = { ...everything, status: 'generated' as const }
    assert.equal((canDeletePayrollPeriod('admin', paidFirst) as { reason: string }).reason, 'paid')

    const resultLocked = { ...paidFirst, paidSettlementCount: 0 }
    assert.equal((canDeletePayrollPeriod('admin', resultLocked) as { reason: string }).reason, 'result_locked')

    const running = { ...resultLocked, lockedResultCount: 0 }
    assert.equal((canDeletePayrollPeriod('admin', running) as { reason: string }).reason, 'generation_running')

    const carry = { ...running, generationRunning: false }
    assert.equal((canDeletePayrollPeriod('admin', carry) as { reason: string }).reason, 'carry_forward_dependency')
  })

  test('every refusal states what is wrong and, unless it is authorization, what to do', () => {
    const cases: PayrollDeletionFacts[] = [
      deletable({ status: 'locked' }),
      deletable({ paidSettlementCount: 1 }),
      deletable({ lockedResultCount: 1 }),
      deletable({ generationRunning: true }),
      deletable({ carryForwardDependentCount: 1 }),
    ]
    for (const facts of cases) {
      const p = canDeletePayrollPeriod('admin', facts)
      assert.equal(p.allowed, false)
      if (p.allowed === false) {
        assert.ok(p.message.length > 0, 'a refusal must say what is wrong')
        assert.ok(p.resolution.length > 0, 'a refusal must say what to resolve first')
      }
    }
  })

  test('no refusal message contains a monetary amount', () => {
    const cases: PayrollDeletionFacts[] = [
      deletable({ status: 'locked' }),
      deletable({ paidSettlementCount: 2 }),
      deletable({ carryForwardDependentCount: 1 }),
    ]
    for (const facts of cases) {
      const p = canDeletePayrollPeriod('admin', facts)
      if (p.allowed === false) {
        assert.doesNotMatch(p.message,    /₹|rupee|\d{4,}\.\d{2}/i)
        assert.doesNotMatch(p.resolution, /₹|rupee|\d{4,}\.\d{2}/i)
      }
    }
  })
})

describe('the typed confirmation', () => {
  test('names the month and year in words', () => {
    assert.equal(payrollDeletionConfirmationText(7, 2026),  'July 2026')
    assert.equal(payrollDeletionConfirmationText(1, 2026),  'January 2026')
    assert.equal(payrollDeletionConfirmationText(12, 2025), 'December 2025')
  })

  test('an exact match confirms', () => {
    assert.equal(payrollDeletionConfirmationMatches('July 2026', 7, 2026), true)
  })

  test('surrounding whitespace and repeated inner spaces are forgiven', () => {
    assert.equal(payrollDeletionConfirmationMatches('  July 2026 ', 7, 2026), true)
    assert.equal(payrollDeletionConfirmationMatches('July  2026',   7, 2026), true)
  })

  test('the wrong case does NOT confirm — this is the last gate', () => {
    assert.equal(payrollDeletionConfirmationMatches('july 2026', 7, 2026), false)
    assert.equal(payrollDeletionConfirmationMatches('JULY 2026', 7, 2026), false)
  })

  test('the wrong month or year does not confirm', () => {
    assert.equal(payrollDeletionConfirmationMatches('June 2026', 7, 2026), false)
    assert.equal(payrollDeletionConfirmationMatches('July 2025', 7, 2026), false)
    assert.equal(payrollDeletionConfirmationMatches('July',      7, 2026), false)
    assert.equal(payrollDeletionConfirmationMatches('2026',      7, 2026), false)
  })

  test('an empty or non-string confirmation does not confirm', () => {
    assert.equal(payrollDeletionConfirmationMatches('',        7, 2026), false)
    assert.equal(payrollDeletionConfirmationMatches('   ',     7, 2026), false)
    assert.equal(payrollDeletionConfirmationMatches(undefined, 7, 2026), false)
    assert.equal(payrollDeletionConfirmationMatches(null,      7, 2026), false)
    assert.equal(payrollDeletionConfirmationMatches(72026,     7, 2026), false)
  })
})

describe('the mandatory reason', () => {
  test('a stated reason is accepted and trimmed', () => {
    const r = validateDeletionReason('  Test payroll from module setup.  ')
    assert.equal(r.ok, true)
    assert.equal(r.ok && r.value, 'Test payroll from module setup.')
  })

  test('a blank or whitespace-only reason is refused', () => {
    assert.equal(validateDeletionReason('').ok,      false)
    assert.equal(validateDeletionReason('   ').ok,   false)
    assert.equal(validateDeletionReason('\n\t').ok,  false)
  })

  test('a missing or non-string reason is refused', () => {
    assert.equal(validateDeletionReason(undefined).ok, false)
    assert.equal(validateDeletionReason(null).ok,      false)
    assert.equal(validateDeletionReason(42).ok,        false)
  })

  test('an over-long reason is refused at the stated ceiling', () => {
    assert.equal(validateDeletionReason('x'.repeat(DELETION_REASON_MAX_LENGTH)).ok,     true)
    assert.equal(validateDeletionReason('x'.repeat(DELETION_REASON_MAX_LENGTH + 1)).ok, false)
  })
})

describe('what the dialog promises', () => {
  test('the removed list names the employee results and the lines behind them', () => {
    const { removed } = payrollDeletionScope({ resultCount: 9, settlementCount: 9 })
    assert.match(removed.join(' | '), /9 employee payroll results/)
    assert.match(removed.join(' | '), /deduction and addition line/i)
    assert.match(removed.join(' | '), /daily payroll breakdown/i)
    assert.match(removed.join(' | '), /settings pinned/i)
  })

  test('the kept list states that attendance and salary configuration survive', () => {
    const { kept } = payrollDeletionScope({ resultCount: 9, settlementCount: 9 })
    const text = kept.join(' | ')
    assert.match(text, /attendance imports/i)
    assert.match(text, /attendance corrections/i)
    assert.match(text, /salary configuration/i)
    assert.match(text, /Global Payroll Settings/i)
    assert.match(text, /every other payroll month/i)
  })

  test('a period with no settlements does not claim to delete any', () => {
    const { removed } = payrollDeletionScope({ resultCount: 0, settlementCount: 0 })
    assert.doesNotMatch(removed.join(' | '), /settlement/i)
  })

  test('the singular is used for one result', () => {
    const { removed } = payrollDeletionScope({ resultCount: 1, settlementCount: 1 })
    assert.match(removed.join(' | '), /1 employee payroll result for this month/)
  })

  test('neither list mentions a salary amount', () => {
    const { removed, kept } = payrollDeletionScope({ resultCount: 9, settlementCount: 9 })
    for (const line of [...removed, ...kept]) {
      assert.doesNotMatch(line, /₹/)
    }
  })
})


// ─── BOE Credits in use (Phase 1C/1D) ────────────────────────────────────────

describe('credits in use', () => {
  test('a period with an active coverage or payroll application cannot be deleted', () => {
    const p = canDeletePayrollPeriod('admin', deletable({ creditUseCount: 2 }))
    assert.equal(p.allowed, false)
    if (!p.allowed) {
      assert.equal(p.reason, 'credits_in_use')
      assert.match(p.message, /BOE Credits are applied/)
      assert.match(p.resolution, /remove their payroll credit applications/)
    }
  })

  test('none in use, or the fact absent, changes nothing', () => {
    assert.equal(canDeletePayrollPeriod('admin', deletable({ creditUseCount: 0 })).allowed, true)
    assert.equal(canDeletePayrollPeriod('admin', deletable()).allowed, true)
  })

  test('it is checked after the objections an admin cannot clear', () => {
    const p = canDeletePayrollPeriod('admin', deletable({ creditUseCount: 1, paidSettlementCount: 1 }))
    assert.equal(p.allowed, false)
    if (!p.allowed) assert.equal(p.reason, 'paid')
  })
})
