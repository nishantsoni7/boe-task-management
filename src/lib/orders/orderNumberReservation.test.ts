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
  PI_RESERVATION_COLUMNS,
  RESERVATION_INSTRUCTION,
  describeReservation,
  normalizeOrderNumberReference,
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

  test('held, and a revised file has arrived — but nothing is promised by it', () => {
    // THE SENTENCE THAT USED TO OVERPROMISE. It said "The Confirmed Order will
    // be created as 0042", which is only true if the revised file actually
    // CARRIES 0042 — and this screen cannot see that: it reads the workbook
    // hash, never the parsed cell. The server checks the number on submit and
    // says so if it is wrong.
    const view = describeReservation({ ...reserved, currentWorkbookSha256: 'b'.repeat(64) })
    assert.equal(view.state, 'revised_pi_uploaded')
    assert.match(view.standing, /revised file has been uploaded/)
    assert.match(view.standing, /checked against 0042 when the PI is submitted/)
    assert.doesNotMatch(view.standing, /will be created as/)
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
  test('the revised PI is missing — the server’s own sentence, minus the code', () => {
    // It used to be replaced with a fixed sentence here. The server's version
    // names the number, and the number is the actionable part.
    assert.equal(
      reservationApprovalMessage({ message: 'ORDER_SUBMISSION_REVISED_PI_MISSING: Order number 0042 is reserved for this PI, but no revised PI has been uploaded since it was issued.' }),
      'Order number 0042 is reserved for this PI, but no revised PI has been uploaded since it was issued.')
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

describe('the number read out of a workbook, normalized the way SQL normalizes it', () => {
  test('surrounding whitespace and case are harmless', () => {
    for (const raw of ['0042', ' 0042', '0042 ', '  0042  ', '\t0042\n']) {
      assert.equal(normalizeOrderNumberReference(raw), '0042')
    }
    assert.equal(normalizeOrderNumberReference(' 00ab '), '00AB')
  })

  test('a blank cell says nothing, and says it as null', () => {
    for (const raw of [null, undefined, '', '   ', '\t\n']) {
      assert.equal(normalizeOrderNumberReference(raw), null)
    }
  })

  test('internal whitespace is COLLAPSED, never removed', () => {
    // '00 42' is not '0042'. A reader of the document sees a space, and the
    // document therefore does not carry the Order number. Removing the space
    // here would accept a document that says something else.
    assert.equal(normalizeOrderNumberReference('00  42'), '00 42')
    assert.notEqual(normalizeOrderNumberReference('00 42'), '0042')
  })

  test('leading zeros are NOT stripped, because they are part of the identifier', () => {
    // 20260704000000 §4: "leading zeros are part of the identifier, which is why
    // the column stays text". A PI printed with 42 carries the wrong number.
    assert.notEqual(normalizeOrderNumberReference('42'), normalizeOrderNumberReference('0042'))
  })

  test('nothing that merely contains the number normalizes to it', () => {
    for (const near of ['PI-0042', '0042/2026', '0042A', '004', '00420']) {
      assert.notEqual(normalizeOrderNumberReference(near), '0042')
    }
  })
})

describe('the panel does not offer a decision that is not being made', () => {
  const newDraft = { ...draft, reservationRequired: true }

  test('a NEW draft is told its number is coming, not invited to take one', () => {
    const view = describeReservation(newDraft)
    assert.equal(view.state, 'available')
    assert.match(view.standing, /issued for this PI as soon as its PI file is uploaded/)
    assert.match(view.standing, /must carry it before the PI can be submitted/)
    // No invitation, and no suggestion that skipping it is possible.
    assert.doesNotMatch(view.standing, /Reserve one now|if the revised PI has to carry it/)
  })

  test('a GRANDFATHERED draft is still offered the choice', () => {
    const view = describeReservation({ ...draft, reservationRequired: false })
    assert.match(view.standing, /Reserve one now/)
  })

  test('either way the absence of a PI number is stated', () => {
    for (const input of [newDraft, draft]) {
      assert.ok(describeReservation(input).standing.includes(NO_PI_NUMBER_NOTE))
    }
  })

  test('a blocked NEW draft says the number has not arrived YET', () => {
    const view = describeReservation({ ...newDraft, hasWorkbook: false })
    assert.equal(view.state, 'blocked')
    assert.match(view.standing, /has been reserved for this PI yet/)
    assert.match(view.blockedReason ?? '', /Upload the PI file first/)
  })
})

describe('the columns the panel reads travel with the record', () => {
  test('the obligation and the reservation are read together, in one list', () => {
    assert.ok(PI_RESERVATION_COLUMNS.includes('reservation_required'))
    assert.ok(PI_RESERVATION_COLUMNS.includes('reserved_order_number'))
    assert.ok(PI_RESERVATION_COLUMNS.includes('reserved_number_workbook_sha256'))
    assert.ok(PI_RESERVATION_COLUMNS.includes('source_workbook_sha256'))
  })

  test('the workbook’s own reference is NOT among them', () => {
    // source_order_number is what the revised-PI rule compares, and the
    // comparison is the database's. No PI screen renders it: beside a reserved
    // Order number it could only be read as a rival answer to one question, and
    // draftsAccess.test.ts holds these pages to that.
    assert.ok(!PI_RESERVATION_COLUMNS.includes('source_order_number'))
  })
})

describe('the refusals that name two numbers are passed through, not rewritten', () => {
  test('a mismatch keeps what the file says AND what is reserved', () => {
    const raw = 'ORDER_SUBMISSION_REVISED_PI_NUMBER_MISMATCH: the revised PI carries Order number 0099, but 0042 is reserved for it. Correct the PI and upload it again.'
    const message = reservationApprovalMessage({ message: raw })
    assert.match(message ?? '', /0099/)
    assert.match(message ?? '', /0042/)
    // The machine prefix is taken off; nothing else is.
    assert.doesNotMatch(message ?? '', /ORDER_SUBMISSION_REVISED_PI_NUMBER_MISMATCH/)
    assert.match(message ?? '', /^the revised PI carries Order number 0099/)
  })

  test('a missing revised PI keeps the number it is asking for', () => {
    const raw = 'ORDER_SUBMISSION_REVISED_PI_MISSING: Order number 0042 is reserved for this PI, but no revised PI has been uploaded since it was issued. Put 0042 into the PI and upload it with Change PI.'
    assert.match(reservationApprovalMessage({ message: raw }) ?? '', /0042/)
    assert.doesNotMatch(reservationApprovalMessage({ message: raw }) ?? '', /ORDER_SUBMISSION/)
  })

  test('a blank reference is reported as its own thing', () => {
    const raw = 'ORDER_SUBMISSION_REVISED_PI_NO_NUMBER: the revised PI does not carry an Order number. Put 0042 into the PI and upload it again.'
    assert.match(reservationApprovalMessage({ message: raw }) ?? '', /does not carry an Order number/)
  })

  test('a missing reservation on a new draft says what to do', () => {
    assert.match(
      reservationApprovalMessage({ message: 'ORDER_SUBMISSION_RESERVATION_REQUIRED: …' }) ?? '',
      /Upload the PI file so a number can be issued/)
  })

  test('an Order created outside approval is named as such', () => {
    assert.match(
      reservationApprovalMessage({ message: 'ORDER_FROM_RESERVED_PI_REQUIRES_APPROVAL: …' }) ?? '',
      /only be created by approving it/)
  })

  test('a refusal with no recognisable shape is still passed on whole', () => {
    // Saying less than the server did is never an improvement.
    const raw = 'ORDER_SUBMISSION_REVISED_PI_MISSING'
    assert.equal(reservationApprovalMessage({ message: raw }), raw)
  })

  test('and anything that is not a reservation refusal is still NOT claimed', () => {
    assert.equal(reservationApprovalMessage({ message: 'ORDER_SUBMISSION_PAYMENT_INSUFFICIENT: …' }), null)
  })
})
