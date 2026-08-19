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
  ADVANCE_AMOUNT_MAX_DECIMALS,
  ADVANCE_AMOUNT_NEGATIVE,
  ADVANCE_AMOUNT_REQUIRED,
  ADVANCE_AMOUNT_TOO_PRECISE,
  advanceAboveTotalMessage,
  advanceBelowStandardMessage,
  advanceNotReducedMessage,
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
  previewAdvancePercent,
  standardAdvanceAmount,
  derivedAdvancePercent,
  advanceAmountText,
  advanceChoiceChange,
  validateAdvanceDeclaration,
  advanceChoiceCondition,
  advanceChoiceNeedsReason,
  advanceDeclarationUntouched,
  ADVANCE_CHOICES,
  ADVANCE_CHOICE_HINT,
  ADVANCE_CHOICE_LABEL,
  ADVANCE_NONE_AMOUNT_LABEL,
  ADVANCE_NONE_LABEL,
  ADVANCE_NONE_PERCENT_LABEL,
  ADVANCE_REDUCED_LABEL,
  ADVANCE_STANDARD_LABEL,
  ADVANCE_TOTAL_NOT_POSITIVE,
  ADVANCE_AMOUNT_NOT_A_NUMBER,
  ADVANCE_AMOUNT_ZERO_USE_NONE,
  type AdvanceChoice,
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
  advance_declared_amount: null,
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

/**
 * A standard declaration.
 *
 * WITH NO AMOUNT BY DEFAULT, which is what every record written before this
 * column existed looks like — and the compatibility case that has to keep
 * working. Pass one to describe a record declared the new way.
 */
const standard = (amount: number | string | null = null): PersistedAdvance =>
  undeclared({ advance_condition: 'standard', advance_declared_amount: amount })

const exception = (
  percent: number | string,
  status: 'pending' | 'approved' | 'rejected',
  over: Partial<PersistedAdvance> = {},
): PersistedAdvance => undeclared({
  advance_condition: 'exception',
  // NO STORED AMOUNT unless a test asks for one: the legacy shape, read through
  // the percentage exactly as it always was.
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

/**
 * The dialog's validation, driven by the CHOICE the employee pressed.
 *
 * `reduced` is what the old two-option `exception` became for every percentage
 * above zero; zero itself now has its own choice, and its own refusal when it is
 * typed into the wrong one.
 */
const validate = (choice: AdvanceChoice, amountText: string, reason: string,
                  grandTotal: number | null = 100000) =>
  validateAdvanceDeclaration({ choice, amountText, reason, grandTotal })

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

describe('the standard choice declares an amount of at least 40%', () => {
  test('the exact 40% figure is accepted, and carries no reason', () => {
    const result = validate('standard', '40000', '')
    assert.ok(result.ok)
    assert.deepEqual(result.value, { condition: 'standard', amount: 40000 })
  })

  test('more than 40% is the same route — it is not an exception', () => {
    for (const raw of ['40000.01', '50000', '99999.99', '100000']) {
      const result = validate('standard', raw, '')
      assert.ok(result.ok, `${raw} must be accepted`)
      assert.deepEqual(result.value, { condition: 'standard', amount: Number(raw) })
    }
  })

  test('a paisa below 40% is refused, and points at the reduced choice', () => {
    // THE CLASSIFICATION IS THE AMOUNT, never a percentage rounded for display.
    // ₹39,999.99 of ₹1,00,000 displays as 39.99% and would display as 40% if it
    // were rounded — it is short of the requirement either way.
    const result = validate('standard', '39999.99', '')
    assert.ok(!result.ok)
    assert.equal(result.message, advanceBelowStandardMessage('₹40,000'))
    assert.ok(result.message.includes(ADVANCE_REDUCED_LABEL),
      'the refusal names the choice to press instead')
  })

  test('more than the grand total is refused', () => {
    const result = validate('standard', '100000.01', '')
    assert.ok(!result.ok)
    assert.equal(result.message, advanceAboveTotalMessage('₹1,00,000'))
  })

  test('the reason is ignored, so a leftover sentence cannot ride along', () => {
    // Somebody who wrote a case for an exception and then changed their mind
    // back sends a standard declaration and nothing else. The RPC refuses a
    // standard carrying a reason, so this is what keeps the two from disagreeing.
    const result = validate('standard', '40000', 'left over from a moment ago')
    assert.ok(result.ok)
    assert.deepEqual(result.value, { condition: 'standard', amount: 40000 })
  })
})

describe('the 40% threshold is a real payable figure, never a fraction of a paisa', () => {
  test('it is taken as the CEILING, so the default always satisfies the rule', () => {
    // 40% of ₹100.01 is ₹40.004. Rounding gives ₹40.00, which is BELOW the
    // requirement — the database would refuse the very figure this screen
    // pre-filled. The ceiling gives ₹40.01.
    assert.equal(standardAdvanceAmount(100.01), 40.01)
    assert.equal(standardAdvanceAmount(100), 40)
    assert.equal(standardAdvanceAmount(2537000), 1014800)
    assert.equal(standardAdvanceAmount(0), 0)
  })

  test('and it never overshoots by a whole paisa', () => {
    for (const total of [0, 1, 100.01, 100.02, 100.03, 100.04, 100.05, 253700, 999999.99]) {
      const minimum = standardAdvanceAmount(total)!
      assert.ok(minimum >= total * 0.4 - 1e-9, `${total} → ${minimum} is below 40%`)
      assert.ok(minimum - total * 0.4 < 0.01, `${total} → ${minimum} overshoots 40%`)
    }
  })

  test('an unknown total has no threshold rather than a guessed one', () => {
    assert.equal(standardAdvanceAmount(null), null)
    assert.equal(standardAdvanceAmount(Number.NaN), null)
    assert.equal(standardAdvanceAmount(-1), null)
  })

  test('the accepted amount and the threshold agree exactly at the boundary', () => {
    for (const total of [100, 100.01, 100.02, 100.03, 100.04, 100.05, 118000, 253700.07]) {
      const minimum = standardAdvanceAmount(total)!
      assert.ok(validate('standard', advanceAmountText(minimum), '', total).ok,
        `the threshold itself must be a valid standard advance for ${total}`)
      const below = Math.round((minimum - 0.01) * 100) / 100
      assert.ok(!validate('standard', advanceAmountText(below), '', total).ok,
        `a paisa below the threshold must not be standard for ${total}`)
      assert.ok(validate('reduced', advanceAmountText(below), 'agreed', total).ok,
        `and must be a REDUCED advance for ${total}`)
    }
  })
})

describe('the percentage is derived from the amount, and truncated', () => {
  test('an exact figure derives its exact percentage', () => {
    assert.equal(derivedAdvancePercent(100000, 40000), 40)
    assert.equal(derivedAdvancePercent(118000, 14750), 12.5)
    assert.equal(derivedAdvancePercent(100000, 0), 0)
  })

  test('TRUNCATED, never rounded, so 39.99999% never prints as 40%', () => {
    // THE CASE THIS RULE EXISTS FOR. Rounding would show a figure claiming the
    // standard requirement is met by an amount that is a paisa short of it.
    assert.equal(derivedAdvancePercent(100000, 39999.99), 39.99)
    assert.ok(derivedAdvancePercent(100000, 39999.99)! < ADVANCE_STANDARD_PERCENT)
    assert.equal(derivedAdvancePercent(100000, 12345.678), 12.34)
  })

  test('a percentage of nothing is not a number', () => {
    assert.equal(derivedAdvancePercent(0, 0), null)
    assert.equal(derivedAdvancePercent(null, 100), null)
    assert.equal(derivedAdvancePercent(100000, null), null)
    assert.equal(derivedAdvancePercent(Number.NaN, 100), null)
  })
})

describe('the three choices are three choices, not two with a trick', () => {
  test('every choice is offered, and each one is named for what it does', () => {
    assert.deepEqual([...ADVANCE_CHOICES], ['standard', 'reduced', 'none'],
      'the order they are drawn in is the order of increasing exception')
    assert.equal(ADVANCE_CHOICE_LABEL.standard, 'Advance: 40% or above')
    assert.equal(ADVANCE_CHOICE_LABEL.reduced, 'Reduced advance: below 40%')
    assert.equal(ADVANCE_CHOICE_LABEL.none, 'No advance: 0%')
  })

  test('the standard helper says the amount is declared, and what bounds it', () => {
    assert.equal(ADVANCE_CHOICE_HINT.standard,
      'Declare the amount agreed. It must be at least 40% of the grand total, and may be more.')
  })

  test('No advance says that management must approve it', () => {
    assert.equal(ADVANCE_CHOICE_HINT.none,
      'Management approval is required to proceed without advance.')
    assert.equal(ADVANCE_NONE_PERCENT_LABEL, '0%')
    assert.equal(ADVANCE_NONE_AMOUNT_LABEL, '₹0')
  })

  test('two of the three become the SAME database condition, and there is no third', () => {
    // 0% is the exception the applied migration already models. Inventing a
    // third advance_condition for it would need a migration, would need the
    // decision RPCs taught about it, and would split one workflow into two.
    assert.equal(advanceChoiceCondition('standard'), 'standard')
    assert.equal(advanceChoiceCondition('reduced'), 'exception')
    assert.equal(advanceChoiceCondition('none'), 'exception')
  })

  test('both exceptions need a reason; the standard needs none', () => {
    assert.equal(advanceChoiceNeedsReason('standard'), false)
    assert.equal(advanceChoiceNeedsReason('reduced'), true)
    assert.equal(advanceChoiceNeedsReason('none'), true)
  })
})

describe('No advance is a first-class choice worth ₹0', () => {
  test('it sends a ₹0 exception with the employee’s reason', () => {
    const result = validate('none', '', 'long-standing account, pays on delivery')
    assert.ok(result.ok)
    assert.deepEqual(result.value, {
      condition: 'exception',
      amount: 0,
      reason: 'long-standing account, pays on delivery',
    })
  })

  test('it ignores whatever is sitting in the amount box', () => {
    // Somebody who tried ₹12,000 and then decided on none must send ₹0. The
    // choice is the declaration; the abandoned box cannot contradict it.
    for (const leftover of ['12500', '39000', 'nonsense', '   ']) {
      const result = validate('none', leftover, 'agreed with the client')
      assert.ok(result.ok, `"${leftover}" must not affect a No advance declaration`)
      assert.equal(result.value.condition === 'exception' && result.value.amount, 0)
    }
  })

  test('the reason is still mandatory — it is the whole case being made', () => {
    for (const reason of ['', '   ', '\n', '\t\t']) {
      const result = validate('none', '', reason)
      assert.ok(!result.ok, 'proceeding on nothing received cannot be asked for silently')
      assert.equal(result.message, ADVANCE_REASON_REQUIRED)
    }
  })

  test('and the screen says what 0% means rather than showing a bare ₹0', () => {
    assert.ok(/no advance/i.test(ADVANCE_ZERO_EXPLANATION))
    assert.ok(/no advance/i.test(ADVANCE_NONE_LABEL))
  })
})

describe('a reduced advance, at every boundary', () => {
  test('every amount strictly between ₹0 and the threshold is accepted', () => {
    for (const raw of ['0.01', '1', '12500', '20000', '39000', '39990', '39999.99']) {
      const result = validate('reduced', raw, 'agreed with the client')
      assert.ok(result.ok, `${raw} must be accepted`)
      assert.equal(result.value.condition === 'exception' && result.value.amount, Number(raw))
    }
  })

  test('ZERO IS REFUSED HERE, and points at the choice that means it', () => {
    // The database would take it — ₹0 is a valid exception — but a screen that
    // silently turned "reduced advance of ₹0" into "no advance" would be
    // deciding on somebody's behalf. Nothing is rounded or reinterpreted.
    for (const raw of ['0', '0.0', '0.00', '.0', '00']) {
      const result = validate('reduced', raw, 'agreed')
      assert.ok(!result.ok, `"${raw}" must be refused under Reduced advance`)
      assert.equal(result.message, ADVANCE_AMOUNT_ZERO_USE_NONE)
      assert.ok(result.message.includes(ADVANCE_NONE_LABEL),
        'the refusal must name the choice to press instead')
    }
  })

  test('the threshold itself is NOT an exception', () => {
    const result = validate('reduced', '40000', 'agreed')
    assert.ok(!result.ok)
    assert.equal(result.message, advanceNotReducedMessage('₹40,000'))
    assert.ok(result.message.includes(ADVANCE_STANDARD_LABEL),
      'and the refusal names the choice that fits')
  })

  test('anything above the threshold is refused', () => {
    for (const raw of ['40000.01', '41000', '50000', '100000']) {
      const result = validate('reduced', raw, 'agreed')
      assert.ok(!result.ok, `${raw} must be refused`)
      assert.equal(result.message, advanceNotReducedMessage('₹40,000'))
    }
  })

  test('more than the grand total is answered as that, not as "not reduced"', () => {
    // Two different mistakes, two different corrections. Somebody who typed one
    // digit too many is not being told to press a different radio.
    const result = validate('reduced', '100000.01', 'agreed')
    assert.ok(!result.ok)
    assert.equal(result.message, advanceAboveTotalMessage('₹1,00,000'))
  })

  test('a negative amount is refused as negative, not as gibberish', () => {
    for (const raw of ['-0.01', '-1', '-100']) {
      const result = validate('reduced', raw, 'agreed')
      assert.ok(!result.ok, `${raw} must be refused`)
      assert.equal(result.message, ADVANCE_AMOUNT_NEGATIVE,
        '"-5000" is a number; it is simply not an advance anybody may declare')
    }
  })

  test('a malformed figure is refused rather than coerced', () => {
    // Number('') is 0 and Number('1e5') is 100000. Both would be a figure nobody
    // typed, so the shape is checked before the value.
    for (const raw of ['abc', 'NaN', 'Infinity', '-Infinity', '1e5', '1E5', '2e-3',
                       '1,5', '1,50,000', '12%', '₹12', '--3', '1.2.3', '+5', ' 1 2 ', '0x10']) {
      const result = validate('reduced', raw, 'agreed')
      assert.ok(!result.ok, `"${raw}" must be refused`)
      assert.equal(result.message, ADVANCE_AMOUNT_NOT_A_NUMBER,
        `"${raw}" is not a figure at all, and is not answered as one out of range`)
    }
  })

  test('an empty amount asks for one rather than assuming zero', () => {
    for (const raw of ['', '   ', '.']) {
      const result = validate('reduced', raw, 'agreed')
      assert.ok(!result.ok)
      assert.equal(result.message, ADVANCE_AMOUNT_REQUIRED)
    }
  })

  test('excessive precision is REFUSED, never rounded', () => {
    // This is the one that matters most. Rounding would store ₹12,345.68 for a
    // typed ₹12,345.675 — a figure management would then decide on that nobody
    // declared. The column is plain numeric and the CHECK refuses.
    for (const raw of ['12345.675', '0.001', '1.2345', '39999.999']) {
      const result = validate('reduced', raw, 'agreed')
      assert.ok(!result.ok, `${raw} must be refused`)
      assert.equal(result.message, ADVANCE_AMOUNT_TOO_PRECISE)
    }
    assert.equal(ADVANCE_AMOUNT_MAX_DECIMALS, 2)
  })

  test('two decimal places, including trailing zeroes, are fine', () => {
    for (const raw of ['12500.50', '39000.00', '1.10']) {
      assert.ok(validate('reduced', raw, 'agreed').ok, `${raw} must be accepted`)
    }
  })

  test('a real advance that rounds to 0% is still a real advance', () => {
    // ₹5 of ₹10,00,000 is 0.0005%, which truncates to 0.00 — and is a positive
    // declared amount all the same. It is a REDUCED advance, not "No advance".
    const result = validate('reduced', '5', 'agreed', 1000000)
    assert.ok(result.ok)
    assert.equal(result.value.condition === 'exception' && result.value.amount, 5)
    assert.equal(derivedAdvancePercent(1000000, 5), 0)
  })
})

describe('the reason is mandatory, and whitespace is not a reason', () => {
  test('an exception with no reason is refused', () => {
    const result = validate('reduced', '10', '')
    assert.ok(!result.ok)
    assert.equal(result.message, ADVANCE_REASON_REQUIRED)
  })

  test('whitespace alone is refused', () => {
    for (const reason of ['   ', '\n', '\t\t', ' \n ']) {
      const result = validate('reduced', '10', reason)
      assert.ok(!result.ok, `"${JSON.stringify(reason)}" is not a reason`)
      assert.equal(result.message, ADVANCE_REASON_REQUIRED)
    }
  })

  test('the reason that is sent is TRIMMED, so the trail shows what was meant', () => {
    const result = validate('reduced', '10', '   client pays on delivery   ')
    assert.ok(result.ok)
    assert.equal(result.value.condition === 'exception' && result.value.reason,
      'client pays on delivery')
  })

  test('length is measured after trimming, exactly as the database measures it', () => {
    const padded = `  ${'x'.repeat(ADVANCE_REASON_MAX_LENGTH)}  `
    assert.ok(validate('reduced', '10', padded).ok,
      'a reason padded with spaces is not rejected for a length it does not have')

    const tooLong = 'x'.repeat(ADVANCE_REASON_MAX_LENGTH + 1)
    const result = validate('reduced', '10', tooLong)
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

      const exc = validate('reduced', '10', 'agreed', total)
      assert.ok(!exc.ok, 'and certainly not a reduced advance')
      assert.equal(exc.message, ADVANCE_TOTAL_MISSING)

      // 0% of an unknown amount is not ₹0 — it is a declaration against a
      // record nobody can price, and the RPC refuses it for the same reason.
      const none = validate('none', '', 'agreed', total)
      assert.ok(!none.ok, 'and not No advance either')
      assert.equal(none.message, ADVANCE_TOTAL_MISSING)
    }
  })

  test('the refusal is checked FIRST, so it is not masked by a field error', () => {
    // Somebody with no grand total and an empty form must be told the real
    // problem — the record — rather than sent to fix a percentage that could
    // never have been valid.
    const result = validate('reduced', '', '', null)
    assert.ok(!result.ok)
    assert.equal(result.message, ADVANCE_TOTAL_MISSING)
  })

  test('a real total of zero is a known amount, not a missing one', () => {
    // A ₹0 grand total is a strange PI, but it is a PI whose total is KNOWN.
    // Treating it as missing would be inventing a second meaning for zero, which
    // is the mistake the commercial summary already refuses to make. The whole
    // of ₹0 is ₹0, and that is a standard declaration.
    const result = validate('standard', '0', '', 0)
    assert.ok(result.ok)
    assert.deepEqual(result.value, { condition: 'standard', amount: 0 })
  })

  test('but no exception can be carved out of a total of zero', () => {
    // An exception is a figure BELOW a threshold that is itself ₹0, and there is
    // no such figure. The database refuses the same case by name.
    for (const choice of ['reduced', 'none'] as const) {
      const result = validate(choice, '0', 'agreed', 0)
      assert.ok(!result.ok, `${choice} must be refused against a zero total`)
      assert.equal(result.message, ADVANCE_TOTAL_NOT_POSITIVE)
    }
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

describe('the live percentage beside the amount box', () => {
  test('a usable figure shows the percentage it comes to', () => {
    assert.equal(previewAdvancePercent('14750', 118000), '12.5%')
    assert.equal(previewAdvancePercent('47200', 118000), '40%')
    assert.equal(previewAdvancePercent('0', 118000), '0%', 'a genuine zero is 0% and says so')
  })

  test('and it truncates, so a figure short of 40% never previews as 40%', () => {
    assert.equal(previewAdvancePercent('39999.99', 100000), '39.99%')
  })

  test('a half-typed or unusable figure shows nothing rather than flashing one', () => {
    for (const raw of ['', '.', 'abc', '-1', '1e5']) {
      assert.equal(previewAdvancePercent(raw, 118000), '—', `"${raw}" must preview nothing`)
    }
  })

  test('an unknown or zero total previews nothing', () => {
    assert.equal(previewAdvancePercent('14750', null), '—')
    assert.equal(previewAdvancePercent('0', 0), '—')
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
  test('a record that declared nothing opens on the exact 40% amount', () => {
    assert.deepEqual(initialAdvanceSelection(undeclared(), 100000),
      { choice: 'standard', amountText: '40000', reason: '' })
  })

  test('a standard record with no stored amount opens on what it always meant', () => {
    // THE COMPATIBILITY CASE. Every PI declared before amounts existed carries a
    // condition and no figure, and what it has always meant is the standard 40%
    // of its grand total. Resubmitting it untouched declares exactly that.
    assert.deepEqual(initialAdvanceSelection(standard(), 100000),
      { choice: 'standard', amountText: '40000', reason: '' })
    assert.ok(validate('standard', '40000', '', 100000).ok)
  })

  test('a standard record WITH an amount opens on the amount it declared', () => {
    assert.deepEqual(initialAdvanceSelection(standard(55000), 100000),
      { choice: 'standard', amountText: '55000', reason: '' })
  })

  test('an existing reduced advance is shown rather than silently switched away', () => {
    // A PI returned for an UNRELATED correction must not quietly change the
    // employee's advance while they fix a fabric name. A legacy record's amount
    // is read from its stored percentage — the figure it has always meant.
    for (const status of ['pending', 'approved', 'rejected'] as const) {
      assert.deepEqual(initialAdvanceSelection(exception(12.5, status), 100000), {
        choice: 'reduced',
        amountText: '12500',
        reason: 'client is a repeat buyer',
      })
    }
  })

  test('a stored ₹0 opens on No advance, NOT on a reduced advance of zero', () => {
    // Opening it as a Reduced advance with "0" in the box would hand the
    // employee a declaration their own screen refuses, so resubmitting an
    // approved ₹0 exception unchanged would be impossible.
    for (const status of ['pending', 'approved', 'rejected'] as const) {
      assert.deepEqual(initialAdvanceSelection(exception(0, status), 100000), {
        choice: 'none',
        amountText: '',
        reason: 'client is a repeat buyer',
      })
    }
  })

  test('an APPROVED reduced exception reopens identically, so it survives resubmission', () => {
    // The database keeps an approved exception approved only when the figure AND
    // the reason come back unchanged. Pre-filling both is what makes that the
    // default outcome rather than an accident.
    const advance = exception('15.00', 'approved')
    const initial = initialAdvanceSelection(advance, 100000)
    const result = validate(initial.choice, initial.amountText, initial.reason)
    assert.ok(result.ok)
    assert.equal(result.value.condition === 'exception' && result.value.amount, 15000)
    assert.equal(result.value.condition === 'exception' && result.value.reason,
      'client is a repeat buyer')
  })

  test('an APPROVED ₹0 exception reopens identically too', () => {
    const advance = exception('0.00', 'approved')
    const initial = initialAdvanceSelection(advance, 100000)
    assert.equal(initial.choice, 'none')
    const result = validate(initial.choice, initial.amountText, initial.reason)
    assert.ok(result.ok, 'reopening an approved ₹0 must produce a sendable declaration')
    assert.deepEqual(result.value,
      { condition: 'exception', amount: 0, reason: 'client is a repeat buyer' })
  })

  test('an unusable grand total leaves the box empty rather than guessing', () => {
    assert.deepEqual(initialAdvanceSelection(undeclared(), null),
      { choice: 'standard', amountText: '', reason: '' })
  })

  test('the red sentence is withheld until something has been typed', () => {
    // Pressing a choice is not a mistake. Submit stays disabled either way. The
    // standard choice is never "untouched": it opens pre-filled with a valid
    // figure, so an empty box there is somebody having deleted one.
    assert.equal(advanceDeclarationUntouched({ choice: 'standard', amountText: '', reason: '' }), false)
    assert.equal(advanceDeclarationUntouched({ choice: 'reduced', amountText: '', reason: '' }), true)
    assert.equal(advanceDeclarationUntouched({ choice: 'reduced', amountText: '5000', reason: '' }), false)
    assert.equal(advanceDeclarationUntouched({ choice: 'reduced', amountText: '', reason: 'x' }), false)
    assert.equal(advanceDeclarationUntouched({ choice: 'none', amountText: '', reason: '' }), true)
    assert.equal(advanceDeclarationUntouched({ choice: 'none', amountText: '', reason: 'x' }), false)
    assert.equal(advanceDeclarationUntouched({ choice: 'none', amountText: '12000', reason: '' }), true,
      'an abandoned amount is not something typed under No advance')
  })
})

describe('changing choice clears what does not belong to the new one', () => {
  const reduced = { choice: 'reduced' as const, amountText: '12500', reason: 'a case for less' }

  test('moving to the standard route resets the box and drops the reason', () => {
    assert.deepEqual(advanceChoiceChange(reduced, 'standard', 100000),
      { choice: 'standard', amountText: '40000', reason: '' },
      'no stale reduced-advance reason may survive into a standard declaration')
  })

  test('moving off the standard route empties the box', () => {
    // The standard figure is by definition NOT a reduced one, so carrying it
    // across would pre-fill a value the new choice immediately refuses.
    const std = { choice: 'standard' as const, amountText: '40000', reason: '' }
    assert.deepEqual(advanceChoiceChange(std, 'reduced', 100000),
      { choice: 'reduced', amountText: '', reason: '' })
    assert.deepEqual(advanceChoiceChange(std, 'none', 100000),
      { choice: 'none', amountText: '', reason: '' })
  })

  test('the reason survives between the two exception choices', () => {
    // They are the same request being reshaped, and losing three sentences of
    // typing to a radio button is the kind of thing nobody forgives twice.
    assert.deepEqual(advanceChoiceChange(reduced, 'none', 100000),
      { choice: 'none', amountText: '', reason: 'a case for less' })
    const none = { choice: 'none' as const, amountText: '', reason: 'a case for none' }
    assert.deepEqual(advanceChoiceChange(none, 'reduced', 100000),
      { choice: 'reduced', amountText: '', reason: 'a case for none' })
  })

  test('pressing the choice already selected changes nothing at all', () => {
    assert.equal(advanceChoiceChange(reduced, 'reduced', 100000), reduced)
  })

  test('and every result is one the validator can judge without a stale error', () => {
    for (const next of ['standard', 'reduced', 'none'] as const) {
      const moved = advanceChoiceChange(reduced, next, 100000)
      const result = validateAdvanceDeclaration({ ...moved, grandTotal: 100000 })
      // Either it is sendable, or it is waiting on input that belongs to the new
      // choice — never refused for something the previous choice carried.
      assert.ok(result.ok || advanceDeclarationUntouched(moved) || next === 'none',
        `${next} must not open on an error inherited from the previous choice`)
    }
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

  test('every column the module reads is one a migration creates', () => {
    // TWO FILES, because the declared amount arrived after the exception
    // columns did. Both are read here so a column cannot be added to the module
    // without a migration that actually creates it.
    const sql = [
      '20260913000000_order_submission_advance_exceptions.sql',
      '20260917000000_order_submission_advance_amount.sql',
    ].map(file => readFileSync(
      join(process.cwd(), 'supabase', 'migrations', file), 'utf8')).join('\n')

    for (const column of PI_ADVANCE_COLUMNS) {
      if (column === 'advance_exception_reason') continue  // already applied
      assert.ok(sql.includes(`add column ${column}`), `${column} must be added by a migration`)
    }
  })

  test('the declared amount is one of them', () => {
    assert.ok(PI_ADVANCE_COLUMNS.includes('advance_declared_amount'),
      'the amount is what is declared; a screen that did not select it could not show it')
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
    assert.equal(ADVANCE_NOT_A_PAYMENT,
      'This records the advance amount declared for this PI. Payment verification and linking will be added separately.')
    assert.ok(/declared/i.test(ADVANCE_NOT_A_PAYMENT),
      'what is recorded is what was SAID, and the sentence says so')
    assert.ok(!/verified through finance|has been verified|confirmed by finance/i.test(ADVANCE_NOT_A_PAYMENT),
      'nothing here reaches Finance, so nothing here may claim it did')
  })

  test('no exported string says money was received', () => {
    // Read from the module itself rather than from a hand-kept list, so a
    // sentence added later is covered without anybody remembering to add it.
    const source = readFileSync(
      join(process.cwd(), 'src', 'lib', 'orders', 'advanceRequirement.ts'), 'utf8')
    // `$` IS ALLOWED INSIDE A TEMPLATE, deliberately. Excluding it made the
    // scanner stop at the first interpolation and then pair the CLOSING backtick
    // with the next opening one, so whole runs of the file — comments included —
    // were read as one "string" and the check reported on text that is not a
    // string at all. Interpolated identifiers appearing in the matched text are
    // harmless: none of the forbidden phrases is an identifier.
    const strings = [...source.matchAll(/'([^'\\\n]{12,})'|`([^`\\]{12,})`/g)]
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

  test('no exported string claims the amount was verified', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'lib', 'orders', 'advanceRequirement.ts'), 'utf8')
    const strings = [...source.matchAll(/'([^'\\\n]{12,})'|`([^`\\]{12,})`/g)]
      .map(m => (m[1] ?? m[2]).toLowerCase())
    for (const text of strings) {
      for (const claim of ['verified through finance', 'finance has verified',
                           'payment verified', 'advance verified', 'payment linked']) {
        assert.ok(!text.includes(claim), `a string claims "${claim}": ${text}`)
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
