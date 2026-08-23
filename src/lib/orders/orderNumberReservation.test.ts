/**
 * THE ORDER NUMBER, BEFORE THERE IS AN ORDER.
 *
 * The vocabulary and the gates of the PI Draft's reservation panel. Offline and
 * pure: no database, no React, no clock. The concurrency and atomicity of the
 * reservation itself are proved against a real PostgreSQL —
 * supabase/tests/run_order_number_reservation_suite.sh — because neither can be
 * proved by a function that never takes a lock.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderNumberReservation.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  NO_PI_NUMBER_NOTE,
  NUMBER_LABEL,
  RESERVATION_INSTRUCTION,
  describeReservation,
  reservationApprovalMessage,
  reservationBlockedReason,
  reservationErrorMessage,
  revisedPiOutstanding,
} from './orderNumberReservation'

const draft = {
  reserved: null as string | null,
  reservedWorkbookSha256: null as string | null,
  currentWorkbookSha256: 'a'.repeat(64) as string | null,
  usedAt: null as string | null,
  confirmedNumber: null as string | null,
  status: 'draft',
  hasOrder: false,
  deletionClaimed: false,
  hasWorkbook: true,
  canEditWorkbook: true,
}

describe('when a number may be reserved', () => {
  test('a draft with a workbook, by somebody who may replace it', () => {
    assert.equal(reservationBlockedReason(draft), null)
    assert.equal(describeReservation(draft).state, 'available')
  })

  test('a returned PI is still a stage at which the revised file can be uploaded', () => {
    assert.equal(reservationBlockedReason({ ...draft, status: 'needs_changes' }), null)
  })

  test('a submitted PI is refused, and the reason says why that stage matters', () => {
    // Past submission only an admin may replace the workbook, so a number
    // reserved there would be a number its owner could never put into the file.
    const reason = reservationBlockedReason({ ...draft, status: 'submitted' })
    assert.match(reason ?? '', /draft or has been returned/)
    assert.match(reason ?? '', /revised file can still be uploaded/)
  })

  test('an approved PI already carries its number', () => {
    assert.match(reservationBlockedReason({ ...draft, status: 'approved' }) ?? '', /already become an Order/)
    assert.match(reservationBlockedReason({ ...draft, hasOrder: true }) ?? '', /already become an Order/)
  })

  test('a rejected PI, and one reserved for deletion, are each refused in their own words', () => {
    assert.match(reservationBlockedReason({ ...draft, status: 'rejected' }) ?? '', /rejected PI/)
    assert.match(reservationBlockedReason({ ...draft, deletionClaimed: true }) ?? '', /reserved for deletion/)
  })

  test('a PI with no workbook has nothing to put the number into', () => {
    assert.match(reservationBlockedReason({ ...draft, hasWorkbook: false }) ?? '', /Upload the PI file first/)
  })

  test('somebody who may not replace the workbook may not reserve either', () => {
    // The panel asks exactly the authority the RPC asks, so the control is
    // offered when and only when the write would land.
    assert.match(reservationBlockedReason({ ...draft, canEditWorkbook: false }) ?? '', /owner, or an admin/)
  })

  test('the conversion answer wins over the stage answer', () => {
    // An approved PI is also "not a draft". It must be told the true thing.
    const reason = reservationBlockedReason({ ...draft, status: 'approved', hasWorkbook: false })
    assert.match(reason ?? '', /already become an Order/)
  })
})

describe('whether the revised PI is still outstanding', () => {
  test('the same workbook that was on file when the number was issued is not a revision', () => {
    assert.equal(revisedPiOutstanding({
      reservedWorkbookSha256: 'x'.repeat(64), currentWorkbookSha256: 'x'.repeat(64),
    }), true)
  })

  test('a different workbook is', () => {
    assert.equal(revisedPiOutstanding({
      reservedWorkbookSha256: 'x'.repeat(64), currentWorkbookSha256: 'y'.repeat(64),
    }), false)
  })

  test('a missing live hash is outstanding, never satisfied', () => {
    // It is not evidence that a revised workbook exists, and
    // approve_order_submission() refuses it for exactly that reason. A screen
    // that read it as "done" would promise an approval that will be refused.
    assert.equal(revisedPiOutstanding({
      reservedWorkbookSha256: 'x'.repeat(64), currentWorkbookSha256: null,
    }), true)
    assert.equal(revisedPiOutstanding({
      reservedWorkbookSha256: null, currentWorkbookSha256: null,
    }), true)
  })
})

describe('what the panel says', () => {
  const reserved = {
    ...draft,
    reserved: '0042',
    reservedWorkbookSha256: 'a'.repeat(64),
    currentWorkbookSha256: 'a'.repeat(64),
  }

  test('held, and the revised PI is still to come — with the instruction', () => {
    const view = describeReservation(reserved)
    assert.equal(view.state, 'awaiting_revised_pi')
    assert.equal(view.number, '0042')
    assert.equal(view.canCopy, true)
    assert.ok(view.standing.includes(RESERVATION_INSTRUCTION))
  })

  test('held, and a revised file has been uploaded since', () => {
    const view = describeReservation({ ...reserved, currentWorkbookSha256: 'b'.repeat(64) })
    assert.equal(view.state, 'revised_pi_uploaded')
    assert.match(view.standing, /revised file has been uploaded/)
    assert.match(view.standing, /will be created as 0042/)
  })

  test('used: the Confirmed Order came out carrying it', () => {
    const view = describeReservation({
      ...reserved, usedAt: '2026-08-21T00:00:00Z', confirmedNumber: '0042', status: 'approved', hasOrder: true,
    })
    assert.equal(view.state, 'used')
    assert.match(view.standing, /created as 0042, the number reserved/)
    assert.equal(view.blockedReason, null)
  })

  test('a Confirmed Order that came out with a DIFFERENT number is said plainly', () => {
    // Unreachable through the approval path, which creates the Order WITH the
    // reservation. If it is ever seen it must be shown, not smoothed over.
    const view = describeReservation({
      ...reserved, usedAt: '2026-08-21T00:00:00Z', confirmedNumber: '0099', status: 'approved', hasOrder: true,
    })
    assert.match(view.standing, /reserved 0042, but the Confirmed Order was created as 0099/)
  })

  test('no number, and one cannot be taken: the reason is carried, not swallowed', () => {
    const view = describeReservation({ ...draft, status: 'submitted' })
    assert.equal(view.state, 'blocked')
    assert.equal(view.number, null)
    assert.equal(view.canCopy, false)
    assert.match(view.blockedReason ?? '', /draft or has been returned/)
  })

  test('no number, and one can be: the invitation explains what reserving means', () => {
    const view = describeReservation(draft)
    assert.equal(view.state, 'available')
    assert.equal(view.blockedReason, null)
    assert.match(view.standing, /held for this PI alone/)
  })

  test('there is never a copy control without a number beside it', () => {
    for (const input of [draft, { ...draft, status: 'submitted' }]) {
      const view = describeReservation(input)
      assert.equal(view.canCopy, Boolean(view.number))
    }
  })
})

describe('the numbers are named apart, and the missing one is named too', () => {
  test('reserved and Confirmed Order number each have their own label', () => {
    const labels = Object.values(NUMBER_LABEL)
    assert.equal(new Set(labels).size, 2, 'the two may not read as one another')
    assert.match(NUMBER_LABEL.reserved,  /Reserved/)
    assert.match(NUMBER_LABEL.confirmed, /Confirmed Order/)
  })

  test('there is no label for the workbook’s own reference, because it is never shown', () => {
    // draftsAccess.test.ts holds these screens to it: source_order_number is
    // normally the number of an older PI, and beside a reserved Order number it
    // could only be read as a rival answer.
    assert.equal(Object.keys(NUMBER_LABEL).length, 2)
    for (const label of Object.values(NUMBER_LABEL)) {
      assert.doesNotMatch(label, /from the file|PI reference/)
    }
  })

  test('and the absence is STATED wherever there is no reservation', () => {
    for (const input of [draft, { ...draft, status: 'submitted' }]) {
      assert.ok(describeReservation(input).standing.includes(NO_PI_NUMBER_NOTE),
        'an empty space is not a statement')
    }
    // Never said beside a real number — it would contradict the number above it.
    const held = describeReservation({ ...draft, reserved: '0042' })
    assert.ok(!held.standing.includes(NO_PI_NUMBER_NOTE))
  })
})

describe('server refusals become sentences that name the rule', () => {
  const cases: [string, RegExp][] = [
    ['ORDER_NUMBER_RESERVATION_STAGE: …',       /draft or has been returned/],
    ['ORDER_NUMBER_RESERVATION_NO_WORKBOOK: …', /Upload the PI file first/],
    ['ORDER_SUBMISSION_NOT_OWNED: …',           /owner, or an admin/],
    ['ORDER_SUBMISSION_FORBIDDEN: …',           /do not have permission/],
    ['ORDER_SUBMISSION_NOT_EDITABLE: …',        /left draft/],
    ['ORDER_SUBMISSION_DELETION_CLAIMED: …',    /reserved for deletion/],
    ['ORDER_SUBMISSION_CONVERTED: …',           /already become an Order/],
    ['ORDER_NUMBER_CYCLE_EXHAUSTED: …',         /9999/],
    ['ORDER_NUMBER_CYCLE_MISSING: …',           /not configured/],
  ]
  for (const [raw, expected] of cases) {
    test(raw.split(':')[0], () => {
      // Both shapes a caller can hand over: the PostgrestError object, and the
      // bare string. The screens pass the object, because their own source may
      // never contain `error.message` at all.
      assert.match(reservationErrorMessage({ message: raw }), expected)
      assert.match(reservationErrorMessage(raw), expected)
    })
  }

  test('an unrecognised refusal says nothing was issued, and leaks no database text', () => {
    const message = reservationErrorMessage({
      message: 'duplicate key value violates unique constraint "order_submissions_reserved_order_number_uidx"',
    })
    assert.doesNotMatch(message, /constraint|uidx/)
    assert.match(message, /Nothing was issued/)
  })
})

describe('the approval-time refusals that belong to the reservation', () => {
  test('the revised PI is missing', () => {
    assert.match(
      reservationApprovalMessage({ message: 'ORDER_SUBMISSION_REVISED_PI_MISSING: Order number 0042 …' }) ?? '',
      /revised PI carrying that number has not been uploaded/)
  })

  test('the reserved number is already in use', () => {
    assert.match(
      reservationApprovalMessage({ message: 'ORDER_NUMBER_RESERVATION_IN_USE: …' }) ?? '',
      /already in use/)
  })

  test('anything else is NOT claimed — the caller keeps its own mapping', () => {
    // Returning a sentence here would swallow every other approval refusal into
    // a reservation message, which is how a payment-shortfall error comes to
    // read as a numbering problem.
    assert.equal(reservationApprovalMessage({ message: 'ORDER_SUBMISSION_PAYMENT_INSUFFICIENT: …' }), null)
    assert.equal(reservationApprovalMessage(null), null)
    assert.equal(reservationApprovalMessage(undefined), null)
    assert.equal(reservationApprovalMessage({}), null)
  })
})
