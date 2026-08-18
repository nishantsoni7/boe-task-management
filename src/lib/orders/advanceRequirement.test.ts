/**
 * The advance requirement: the choice an employee declares, the decision
 * management takes on it, and what every screen says about both.
 *
 * WHY THESE ARE WORTH TESTING. Almost every rule here is about a BOUNDARY, and
 * a boundary is exactly what stops being checked on the third read of a form:
 *
 *   * 40% is not an exception. 39.99% is. 0% is, and means something specific.
 *   * "12.345" must be REFUSED, not quietly rounded to 12.35 — the figure that
 *     reaches management has to be the figure somebody typed.
 *   * an unknown grand total must fail CLOSED, for both conditions, because a
 *     percentage of an unknown is not a number.
 *   * a pending decision must not offer its controls to somebody who does not
 *     hold the authority, and must still show them the STATE.
 *
 * NONE OF THIS IS THE ACCESS CONTROL. submit_order_submission_with_advance,
 * approve_pi_advance_exception and reject_pi_advance_exception re-derive the
 * actor, the permission, the ownership, the status and every one of these
 * numeric rules inside the database, under a row lock, on every call. What is
 * asserted here is that the SCREEN does not offer a control the database would
 * refuse, does not hide one it would allow, and never sends a figure the
 * database would reject.
 *
 * AND NOTHING HERE IS A PAYMENT. A test at the foot of this file reads every
 * exported string and fails if any of them claims money was received.
 *
 * Pure functions only. No DB, no network, no browser.
 *
 * Run:
 *   npx tsx --test src/lib/orders/advanceRequirement.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  ADVANCE_NOT_A_PAYMENT,
  ADVANCE_PERCENT_MAX_DECIMALS,
  ADVANCE_PERCENT_OUT_OF_RANGE,
  ADVANCE_PERCENT_REQUIRED,
  ADVANCE_PERCENT_TOO_PRECISE,
  ADVANCE_REASON_MAX_LENGTH,
  ADVANCE_REASON_REQUIRED,
  ADVANCE_REASON_TOO_LONG,
  ADVANCE_REJECTED_INSTRUCTION,
  ADVANCE_STANDARD_PERCENT,
  ADVANCE_TOTAL_MISSING,
  ADVANCE_ZERO_EXPLANATION,
  APPROVE_EXCEPTION_BUTTON_LABEL,
  PI_ADVANCE_COLUMNS,
  REJECT_EXCEPTION_BUTTON_LABEL,
  advanceIsReady,
  advanceNumber,
  describeAdvance,
  describeAdvanceActions,
  formatPercent,
  initialAdvanceSelection,
  previewAdvanceAmount,
  validateAdvanceSelection,
  type PersistedAdvance,
} from './advanceRequirement'
import { PI_ADVANCE_PERCENT, computeAdvanceAmount, computeRequiredAdvance } from '@/lib/pi/previewView'
import { deriveOrdersCapabilities } from '@/lib/permissions/orders'
import { isProtectedAction } from '@/lib/permissions/levels'

const OWNER = '11111111-1111-4111-8111-111111111111'
const APPROVER = '22222222-2222-4222-8222-222222222222'

/** A record that has declared nothing — every PI submitted before Phase B. */
const undeclared = (over: Partial<PersistedAdvance> = {}): PersistedAdvance => ({
  advance_condition: null,
  advance_exception_percent: null,
  advance_exception_reason: null,
  advance_exception_status: null,
  advance_exception_requested_by: null,
  advance_exception_requested_at: null,
  advance_exception_decided_by: null,
  advance_exception_decided_at: null,
  advance_exception_rejection_reason: null,
  ...over,
})

const standard = (): PersistedAdvance => undeclared({ advance_condition: 'standard' })

const exception = (
  percent: number | string,
  status: 'pending' | 'approved' | 'rejected',
  over: Partial<PersistedAdvance> = {},
): PersistedAdvance => undeclared({
  advance_condition: 'exception',
  advance_exception_percent: percent,
  advance_exception_reason: 'client is a repeat buyer',
  advance_exception_status: status,
  advance_exception_requested_by: OWNER,
  advance_exception_requested_at: '2026-08-16T09:00:00.000Z',
  advance_exception_decided_by: status === 'pending' ? null : APPROVER,
  advance_exception_decided_at: status === 'pending' ? null : '2026-08-17T09:00:00.000Z',
  advance_exception_rejection_reason: status === 'rejected' ? 'too low for a first order' : null,
  ...over,
})

const validate = (condition: 'standard' | 'exception', percentText: string, reason: string,
                  grandTotal: number | null = 100000) =>
  validateAdvanceSelection({ condition, percentText, reason, grandTotal })

// ── The standard rule ─────────────────────────────────────────────────────────

describe('there is one advance percentage and one formula', () => {
  test('the standard is 40%, and it is the commercial summary’s own constant', () => {
    assert.equal(ADVANCE_STANDARD_PERCENT, 40)
    assert.equal(ADVANCE_STANDARD_PERCENT, PI_ADVANCE_PERCENT,
      'a second constant is a second source that can drift')
  })

  test('the database agrees, and the migration is where that is checked', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase', 'migrations',
           '20260913000000_order_submission_advance_exceptions.sql'), 'utf8')
    assert.ok(sql.includes(`select ${ADVANCE_STANDARD_PERCENT}::numeric`),
      'order_submission_standard_advance_percent() must return the same number')
  })

  test('the commercial summary’s advance is the shared formula applied at 40%', () => {
    // ONE FORMULA. computeRequiredAdvance is now expressed in terms of
    // computeAdvanceAmount, so the summary row and the exception preview cannot
    // round differently or drop a percentage sign in different places.
    for (const total of [100000, 118000, 123456.78, 0, 1]) {
      assert.equal(
        computeRequiredAdvance({ amount: total, text: null, zeroMeaning: null } as never),
        computeAdvanceAmount(total, ADVANCE_STANDARD_PERCENT),
      )
    }
  })

  test('the amount is rounded to paise, never to a float artefact', () => {
    assert.equal(computeAdvanceAmount(100000, 40), 40000)
    assert.equal(computeAdvanceAmount(123456.78, 12.5), 15432.1)
    assert.equal(computeAdvanceAmount(100000, 0), 0, 'zero percent is ₹0, not null')
  })

  test('an unknown input derives nothing rather than a guess', () => {
    assert.equal(computeAdvanceAmount(null, 40), null)
    assert.equal(computeAdvanceAmount(100000, null), null)
    assert.equal(computeAdvanceAmount(Number.NaN, 40), null)
    assert.equal(computeAdvanceAmount(100000, Number.POSITIVE_INFINITY), null)
  })
})

// ── The declaration ───────────────────────────────────────────────────────────

describe('the standard requirement is the simple choice', () => {
  test('it needs no percentage and no reason', () => {
    const result = validate('standard', '', '')
    assert.ok(result.ok)
    assert.deepEqual(result.value, { condition: 'standard' })
  })

  test('and it is unaffected by whatever was typed in the exception fields', () => {
    // Somebody who typed a proposal and then changed their mind back to
    // Standard sends a standard declaration, not a contradictory pair. The RPC
    // refuses a standard carrying a percentage, so this is what keeps the two
    // from disagreeing.
    const result = validate('standard', '12.5', 'left over from a moment ago')
    assert.ok(result.ok)
    assert.deepEqual(result.value, { condition: 'standard' })
  })
})

describe('an exception percentage, at every boundary', () => {
  test('0% is legitimate and means no advance at all', () => {
    const result = validate('exception', '0', 'long-standing account')
    assert.ok(result.ok)
    assert.equal(result.value.condition === 'exception' && result.value.percent, 0)
    assert.ok(/no advance/i.test(ADVANCE_ZERO_EXPLANATION),
      'and the screen says what 0% means rather than showing a bare ₹0')
  })

  test('every value strictly below the standard is accepted', () => {
    for (const raw of ['0', '0.01', '1', '12.5', '20', '39', '39.9', '39.99']) {
      const result = validate('exception', raw, 'agreed with the client')
      assert.ok(result.ok, `${raw}% must be accepted`)
      assert.equal(result.value.condition === 'exception' && result.value.percent, Number(raw))
    }
  })

  test('the standard itself is NOT an exception', () => {
    const result = validate('exception', '40', 'agreed')
    assert.ok(!result.ok)
    assert.equal(result.message, ADVANCE_PERCENT_OUT_OF_RANGE)
  })

  test('anything above the standard is refused', () => {
    for (const raw of ['40.01', '41', '50', '100', '1000']) {
      const result = validate('exception', raw, 'agreed')
      assert.ok(!result.ok, `${raw}% must be refused`)
      assert.equal(result.message, ADVANCE_PERCENT_OUT_OF_RANGE)
    }
  })

  test('a negative percentage is refused', () => {
    for (const raw of ['-0.01', '-1', '-100']) {
      const result = validate('exception', raw, 'agreed')
      assert.ok(!result.ok, `${raw}% must be refused`)
    }
  })

  test('a malformed figure is refused rather than coerced', () => {
    // Number('') is 0 and Number('1e1') is 10. Both would be a figure nobody
    // typed, so the shape is checked before the value.
    for (const raw of ['abc', 'NaN', 'Infinity', '1e1', '1,5', '12%', '--3', '1.2.3', '+5', ' 1 2 ']) {
      const result = validate('exception', raw, 'agreed')
      assert.ok(!result.ok, `"${raw}" must be refused`)
    }
  })

  test('an empty percentage asks for one rather than assuming zero', () => {
    for (const raw of ['', '   ', '.']) {
      const result = validate('exception', raw, 'agreed')
      assert.ok(!result.ok)
      assert.equal(result.message, ADVANCE_PERCENT_REQUIRED)
    }
  })

  test('excessive precision is REFUSED, never rounded', () => {
    // This is the one that matters most. numeric(4,2) in the database would have
    // stored 12.35 for a typed 12.345 — a figure management would then decide on
    // that nobody proposed. The column is plain numeric and the CHECK refuses.
    for (const raw of ['12.345', '0.001', '1.2345', '39.999']) {
      const result = validate('exception', raw, 'agreed')
      assert.ok(!result.ok, `${raw} must be refused`)
      assert.equal(result.message, ADVANCE_PERCENT_TOO_PRECISE)
    }
    assert.equal(ADVANCE_PERCENT_MAX_DECIMALS, 2)
  })

  test('two decimal places, including trailing zeroes, are fine', () => {
    for (const raw of ['12.50', '0.00', '39.00', '1.10']) {
      assert.ok(validate('exception', raw, 'agreed').ok, `${raw} must be accepted`)
    }
  })
})

describe('the reason is mandatory, and whitespace is not a reason', () => {
  test('an exception with no reason is refused', () => {
    const result = validate('exception', '10', '')
    assert.ok(!result.ok)
    assert.equal(result.message, ADVANCE_REASON_REQUIRED)
  })

  test('whitespace alone is refused', () => {
    for (const reason of ['   ', '\n', '\t\t', ' \n ']) {
      const result = validate('exception', '10', reason)
      assert.ok(!result.ok, `"${JSON.stringify(reason)}" is not a reason`)
      assert.equal(result.message, ADVANCE_REASON_REQUIRED)
    }
  })

  test('the reason that is sent is TRIMMED, so the trail shows what was meant', () => {
    const result = validate('exception', '10', '   client pays on delivery   ')
    assert.ok(result.ok)
    assert.equal(result.value.condition === 'exception' && result.value.reason,
      'client pays on delivery')
  })

  test('length is measured after trimming, exactly as the database measures it', () => {
    const padded = `  ${'x'.repeat(ADVANCE_REASON_MAX_LENGTH)}  `
    assert.ok(validate('exception', '10', padded).ok,
      'a reason padded with spaces is not rejected for a length it does not have')

    const tooLong = 'x'.repeat(ADVANCE_REASON_MAX_LENGTH + 1)
    const result = validate('exception', '10', tooLong)
    assert.ok(!result.ok)
    assert.equal(result.message, ADVANCE_REASON_TOO_LONG)
  })

  test('the browser cap matches the database cap', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase', 'migrations',
           '20260913000000_order_submission_advance_exceptions.sql'), 'utf8')
    assert.ok(sql.includes(`char_length(v_reason) > ${ADVANCE_REASON_MAX_LENGTH}`),
      'the two limits must be the same number')
  })
})

describe('a missing grand total fails closed', () => {
  test('neither condition may be declared against an unknown amount', () => {
    for (const total of [null, Number.NaN]) {
      const std = validate('standard', '', '', total)
      assert.ok(!std.ok, 'not even the standard requirement')
      assert.equal(std.message, ADVANCE_TOTAL_MISSING)

      const exc = validate('exception', '10', 'agreed', total)
      assert.ok(!exc.ok, 'and certainly not an exception')
      assert.equal(exc.message, ADVANCE_TOTAL_MISSING)
    }
  })

  test('the refusal is checked FIRST, so it is not masked by a field error', () => {
    // Somebody with no grand total and an empty form must be told the real
    // problem — the record — rather than sent to fix a percentage that could
    // never have been valid.
    const result = validate('exception', '', '', null)
    assert.ok(!result.ok)
    assert.equal(result.message, ADVANCE_TOTAL_MISSING)
  })

  test('a real total of zero is a known amount, not a missing one', () => {
    // A ₹0 grand total is a strange PI, but it is a PI whose total is KNOWN.
    // Treating it as missing would be inventing a second meaning for zero, which
    // is the mistake the commercial summary already refuses to make.
    assert.ok(validate('standard', '', '', 0).ok)
  })
})

// ── The Phase C predicate ─────────────────────────────────────────────────────

describe('advance-ready is exactly two cases', () => {
  test('the standard requirement is ready', () => {
    assert.equal(advanceIsReady(standard()), true)
  })

  test('an APPROVED exception below the standard is ready, zero included', () => {
    for (const percent of [0, 0.01, 12.5, 39.99]) {
      assert.equal(advanceIsReady(exception(percent, 'approved')), true, `${percent}% approved`)
    }
  })

  test('pending is NOT ready', () => {
    assert.equal(advanceIsReady(exception(12.5, 'pending')), false)
  })

  test('rejected is NOT ready', () => {
    assert.equal(advanceIsReady(exception(12.5, 'rejected')), false)
  })

  test('undeclared is NOT ready', () => {
    assert.equal(advanceIsReady(undeclared()), false)
  })

  test('a malformed or out-of-range approval is NOT ready', () => {
    for (const percent of [40, 40.01, 100, -1, Number.NaN]) {
      assert.equal(advanceIsReady(exception(percent, 'approved')), false, `${percent}% approved`)
    }
    assert.equal(
      advanceIsReady(exception(12.5, 'approved', { advance_exception_percent: null })), false,
      'an approved exception with no percentage is not a decision about anything')
    assert.equal(
      advanceIsReady(undeclared({ advance_condition: 'nonsense', advance_exception_status: 'approved' })),
      false, 'an unknown condition is not ready')
  })

  test('a percentage arriving as a string is still a percentage', () => {
    // PostgREST renders `numeric` as a STRING to keep its precision.
    assert.equal(advanceIsReady(exception('12.50', 'approved')), true)
    assert.equal(advanceIsReady(exception('40', 'approved')), false)
    assert.equal(advanceNumber('12.50'), 12.5)
    assert.equal(advanceNumber('not a number'), null)
    assert.equal(advanceNumber(null), null)
  })

  test('it matches the database predicate, case for case', () => {
    // The SQL rule is the authority; this asserts the browser's mirror was
    // written from the same three inputs and the same two cases.
    const sql = readFileSync(
      join(process.cwd(), 'supabase', 'migrations',
           '20260913000000_order_submission_advance_exceptions.sql'), 'utf8')
    assert.ok(sql.includes("p_advance_condition = 'standard'"))
    assert.ok(sql.includes("p_advance_exception_status = 'approved'"))
    assert.ok(sql.includes('p_advance_percent < public.order_submission_standard_advance_percent()'))
  })
})

// ── What the screens show ─────────────────────────────────────────────────────

describe('the section describes the condition without inventing a figure', () => {
  test('the standard amount is always shown, so the comparison is visible', () => {
    const view = describeAdvance(exception(10, 'pending'), 100000)
    assert.equal(view.standardPercentLabel, '40%')
    assert.equal(view.standardAmount, '₹40,000')
    assert.equal(view.exceptionPercentLabel, '10%')
    assert.equal(view.exceptionAmount, '₹10,000')
  })

  test('the exception amount is derived from the CURRENT persisted total', () => {
    // An approved exception is a decision about a PERCENTAGE. When a corrected
    // PI changes the total, the figure moves with it rather than reporting an
    // amount nobody agreed to — which is also why no amount is stored.
    const advance = exception(25, 'approved')
    assert.equal(describeAdvance(advance, 200000).exceptionAmount, '₹50,000')
    assert.equal(describeAdvance(advance, 400000).exceptionAmount, '₹1,00,000')
  })

  test('an unknown total is an em dash, never ₹0', () => {
    const view = describeAdvance(exception(10, 'pending'), null)
    assert.equal(view.standardAmount, '—')
    assert.equal(view.exceptionAmount, null)
  })

  test('an undeclared record says so rather than pretending it chose', () => {
    const view = describeAdvance(undeclared(), 100000)
    assert.equal(view.undeclared, true)
    assert.equal(view.condition, null)
    assert.equal(view.conditionLabel, null)
    assert.equal(view.status, null)
    assert.equal(view.ready, false)
  })

  test('the status reads as English, never as a database value', () => {
    for (const [status, label] of [
      ['pending', 'Pending decision'], ['approved', 'Approved'], ['rejected', 'Rejected'],
    ] as const) {
      const view = describeAdvance(exception(10, status), 100000)
      assert.equal(view.statusLabel, label)
      assert.ok(!view.statusLabel!.includes('_'))
    }
  })

  test('both reasons are carried separately, trimmed, and never merged', () => {
    const view = describeAdvance(exception(10, 'rejected', {
      advance_exception_reason: '  client pays on delivery  ',
      advance_exception_rejection_reason: '  too low for a first order  ',
    }), 100000)
    assert.equal(view.requestReason, 'client pays on delivery')
    assert.equal(view.rejectionReason, 'too low for a first order')
  })

  test('0% is flagged so its meaning can be spelled out', () => {
    assert.equal(describeAdvance(exception(0, 'pending'), 100000).isZeroPercent, true)
    assert.equal(describeAdvance(exception(0.5, 'pending'), 100000).isZeroPercent, false)
    assert.equal(describeAdvance(standard(), 100000).isZeroPercent, false)
  })

  test('a percentage is shown as it was typed, without padded zeroes', () => {
    assert.equal(formatPercent(12.5), '12.5')
    assert.equal(formatPercent(12), '12')
    assert.equal(formatPercent(12.05), '12.05')
    assert.equal(formatPercent(0), '0')
    assert.equal(formatPercent(Number.NaN), '—')
    assert.equal(describeAdvance(exception('15.00', 'approved'), 100000).exceptionPercentLabel, '15%')
  })

  test('the decision record is surfaced, and only when it exists', () => {
    const pending = describeAdvance(exception(10, 'pending'), 100000)
    assert.equal(pending.requestedById, OWNER)
    assert.equal(pending.decidedById, null)
    assert.equal(pending.decidedAtIso, null)

    const decided = describeAdvance(exception(10, 'approved'), 100000)
    assert.equal(decided.decidedById, APPROVER)
    assert.equal(decided.decidedAtIso, '2026-08-17T09:00:00.000Z')
  })
})

describe('the live preview beside the percentage box', () => {
  test('a usable figure is shown in rupees', () => {
    assert.equal(previewAdvanceAmount('12.5', 118000), '₹14,750')
    assert.equal(previewAdvanceAmount('0', 118000), '₹0', 'a genuine zero is ₹0 and says so')
  })

  test('a half-typed or unusable figure shows nothing rather than flashing one', () => {
    for (const raw of ['', '.', 'abc', '40', '41', '-1', '1e1']) {
      assert.equal(previewAdvanceAmount(raw, 118000), '—', `"${raw}" must preview nothing`)
    }
  })

  test('an unknown total previews nothing', () => {
    assert.equal(previewAdvanceAmount('12.5', null), '—')
  })
})

// ── Which controls appear ─────────────────────────────────────────────────────

describe('the exception decision controls', () => {
  const input = (over: Partial<Parameters<typeof describeAdvanceActions>[0]> = {}) =>
    describeAdvanceActions({
      status: 'submitted',
      advance: exception(10, 'pending'),
      canDecideException: true,
      ...over,
    })

  test('an authorised approver gets them on a pending request', () => {
    const actions = input()
    assert.equal(actions.isPending, true)
    assert.equal(actions.canDecide, true)
  })

  test('somebody without the authority sees the STATE and no controls', () => {
    const actions = input({ canDecideException: false })
    assert.equal(actions.isPending, true, 'the record is still visibly waiting')
    assert.equal(actions.canDecide, false, 'but they are offered nothing to press')
  })

  test('an already-decided exception offers nothing, to anybody', () => {
    for (const status of ['approved', 'rejected'] as const) {
      const actions = input({ advance: exception(10, status) })
      assert.equal(actions.isPending, false, `${status} is not pending`)
      assert.equal(actions.canDecide, false)
    }
  })

  test('a pending request on a PI that has left review offers nothing', () => {
    // The RPCs and the database guard both refuse a decision here, so drawing
    // the buttons would be drawing a refusal.
    for (const status of ['needs_changes', 'draft', 'rejected', 'approved']) {
      const actions = input({ status })
      assert.equal(actions.isPending, false, `a ${status} PI has nothing to decide`)
      assert.equal(actions.canDecide, false)
    }
  })

  test('a standard or undeclared record has no decision at all', () => {
    assert.equal(input({ advance: standard() }).canDecide, false)
    assert.equal(input({ advance: undeclared() }).canDecide, false)
  })
})

describe('the four kinds of viewer, by capability', () => {
  const caps = (role: string | null, actions: string[]) =>
    deriveOrdersCapabilities(role, actions.map(actionKey => ({
      actionKey, allowed: true, source: 'employee_override' as const,
    })))

  test('the employee decides nothing', () => {
    const c = caps('member', ['view', 'create'])
    assert.equal(c.canApproveOrderSubmission, false)
    assert.equal(c.canApproveAdvanceException, false)
  })

  test('a PI reviewer reviews the PI and settles no advance', () => {
    const c = caps('member', ['view', 'approve_order'])
    assert.equal(c.canApproveOrderSubmission, true)
    assert.equal(c.canApproveAdvanceException, false,
      'orders.approve_order alone is deliberately not enough')
  })

  test('an exception approver settles the advance and reviews no PI', () => {
    const c = caps('member', ['view', 'approve_advance_exception'])
    assert.equal(c.canApproveAdvanceException, true)
    assert.equal(c.canApproveOrderSubmission, false,
      'and gains no authority to approve, reject or return a PI')
    assert.equal(c.canViewAllOrders, false, 'no company-wide order visibility')
    assert.equal(c.canCreateOrder, false)
    assert.equal(c.canEditOrder, false)
    assert.equal(c.canDeleteOrder, false)
    assert.equal(c.canManageOrders, false)
    assert.equal(c.canExportOrders, false)
  })

  test('an active admin holds both without an explicit grant', () => {
    const c = caps('admin', [])
    assert.equal(c.canApproveAdvanceException, true)
    assert.equal(c.canApproveOrderSubmission, true)
  })

  test('the module parent gate still applies: no entry, no authority', () => {
    const c = caps('member', ['approve_advance_exception'])
    assert.equal(c.canAccessOrdersModule, false)
    assert.equal(c.canApproveAdvanceException, false,
      'a grant with nowhere to land is not a grant')
  })

  test('the action is protected, so no preset can reach it', () => {
    assert.equal(isProtectedAction('approve_advance_exception'), true)
  })
})

// ── The dialog's starting state ───────────────────────────────────────────────

describe('the submit dialog opens on what the record already says', () => {
  test('a record that declared nothing opens on the standard requirement', () => {
    assert.deepEqual(initialAdvanceSelection(undeclared()),
      { condition: 'standard', percentText: '', reason: '' })
  })

  test('a standard record opens on the standard requirement', () => {
    assert.deepEqual(initialAdvanceSelection(standard()),
      { condition: 'standard', percentText: '', reason: '' })
  })

  test('an existing exception is shown rather than silently switched away', () => {
    // A PI returned for an UNRELATED correction must not quietly change the
    // employee's advance condition while they fix a fabric name.
    for (const status of ['pending', 'approved', 'rejected'] as const) {
      assert.deepEqual(initialAdvanceSelection(exception(12.5, status)), {
        condition: 'exception',
        percentText: '12.5',
        reason: 'client is a repeat buyer',
      })
    }
  })

  test('an APPROVED exception reopens identically, so it survives resubmission', () => {
    // The database keeps an approved exception approved only when the
    // percentage AND the reason come back unchanged. Pre-filling both is what
    // makes that the default outcome rather than an accident.
    const advance = exception('15.00', 'approved')
    const initial = initialAdvanceSelection(advance)
    const result = validate('exception', initial.percentText, initial.reason)
    assert.ok(result.ok)
    assert.equal(result.value.condition === 'exception' && result.value.percent, 15)
    assert.equal(result.value.condition === 'exception' && result.value.reason,
      'client is a repeat buyer')
  })
})

// ── The columns ───────────────────────────────────────────────────────────────

describe('the columns are named, and are the ones the migration adds', () => {
  test('the reserved column is reused rather than duplicated', () => {
    assert.ok(PI_ADVANCE_COLUMNS.includes('advance_exception_reason'),
      '20260908000000 reserved this for exactly this meaning')
    assert.ok(!PI_ADVANCE_COLUMNS.some(c => c.includes('request_reason')),
      'a second column meaning the same thing is a second source of truth')
  })

  test('every column the module reads is one the migration creates', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase', 'migrations',
           '20260913000000_order_submission_advance_exceptions.sql'), 'utf8')
    for (const column of PI_ADVANCE_COLUMNS) {
      if (column === 'advance_exception_reason') continue  // already applied
      assert.ok(sql.includes(`add column ${column}`), `${column} must be added by Phase B`)
    }
  })

  test('no payment column is read', () => {
    for (const column of PI_ADVANCE_COLUMNS) {
      for (const forbidden of ['payment', 'paid', 'received', 'receipt', 'proof']) {
        assert.ok(!column.includes(forbidden), `${column} names a payment concept`)
      }
    }
  })
})

// ── The payment boundary ──────────────────────────────────────────────────────

describe('nothing on these screens claims a payment', () => {
  test('the boundary is stated where the figures are', () => {
    assert.ok(/no payment has been recorded/i.test(ADVANCE_NOT_A_PAYMENT))
    assert.ok(/requirement/i.test(ADVANCE_NOT_A_PAYMENT))
  })

  test('no exported string says money was received', () => {
    // Read from the module itself rather than from a hand-kept list, so a
    // sentence added later is covered without anybody remembering to add it.
    const source = readFileSync(
      join(process.cwd(), 'src', 'lib', 'orders', 'advanceRequirement.ts'), 'utf8')
    const strings = [...source.matchAll(/'([^'\\]{12,})'|`([^`\\$]{12,})`/g)]
      .map(m => (m[1] ?? m[2]).toLowerCase())

    for (const text of strings) {
      for (const claim of ['payment received', 'advance received', 'amount received',
                           'payment recorded against', 'paid in full', 'has paid',
                           'collect payment', 'reconcile']) {
        assert.ok(!text.includes(claim), `a string claims "${claim}": ${text}`)
      }
    }
    // The one place "received" is allowed is a DENIAL of it.
    for (const text of strings) {
      if (text.includes('received')) {
        assert.ok(/no |never |nothing /.test(text), `"received" must be a denial: ${text}`)
      }
    }
  })

  test('the rejection instruction offers the two real choices and nothing else', () => {
    assert.ok(ADVANCE_REJECTED_INSTRUCTION.includes(`${ADVANCE_STANDARD_PERCENT}%`))
    assert.ok(/different exception|new reason/i.test(ADVANCE_REJECTED_INSTRUCTION))
    assert.ok(!/pay|payment/i.test(ADVANCE_REJECTED_INSTRUCTION))
  })

  test('the two decision labels cannot be confused with approving the PI', () => {
    assert.equal(APPROVE_EXCEPTION_BUTTON_LABEL, 'Approve Exception')
    assert.equal(REJECT_EXCEPTION_BUTTON_LABEL, 'Reject Exception')
    for (const label of [APPROVE_EXCEPTION_BUTTON_LABEL, REJECT_EXCEPTION_BUTTON_LABEL]) {
      assert.ok(/exception/i.test(label), 'each says what it acts on')
      assert.ok(!/\bPI\b|order/i.test(label), 'and neither claims the PI or an order')
    }
  })
})
