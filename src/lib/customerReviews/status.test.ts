/**
 * THE LIFECYCLE — available → booked → submitted → verified, and nothing else.
 *
 * The browser's copy of the transition table lives in ./status.ts. The DECIDING
 * copy is in the migration, and migration.test.ts compares the two edge by
 * edge. This file asserts what the browser's copy MEANS: which moves exist, who
 * may make them, what a submission needs, and — the point of the whole module —
 * that a verified card is in no active list.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/status.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  TEST_CARD_TRANSITIONS,
  VERIFIER_ONLY_TRANSITIONS,
  availableActions,
  canBookCard,
  canTransition,
  isTerminalStatus,
  submissionBlockers,
  transitionRequiresVerify,
} from './status'
import { ACTIVE_TESTER_STATUSES, TEST_CARD_STATUSES, type TestCardStatus } from './types'

const HOLDER = 'user-holder'
const OTHER = 'user-other'

// THE VIEWER SHAPE HAS NO isAdmin FIELD, and that is the point of this file's
// half of the ownership correction. availableActions() cannot consult a role
// because it is never handed one; `admin` below is not a special viewer, it is
// simply somebody who holds both actions and does not hold the card.
const tester   = { userId: HOLDER, canUse: true,  canVerify: false }
const verifier = { userId: OTHER,  canUse: false, canVerify: true }
const both     = { userId: OTHER,  canUse: true,  canVerify: true }
const admin    = { userId: OTHER,  canUse: true,  canVerify: true }
const nobody   = { userId: OTHER,  canUse: false, canVerify: false }
const adminHoldingIt = { userId: HOLDER, canUse: true, canVerify: true }

const card = (status: TestCardStatus, booked_by: string | null = HOLDER) => ({ status, booked_by })

describe('the shape of the lifecycle', () => {
  test('there are four statuses and no fifth', () => {
    assert.deepEqual([...TEST_CARD_STATUSES], ['available', 'booked', 'submitted', 'verified'])
    assert.deepEqual(Object.keys(TEST_CARD_TRANSITIONS).sort(), [...TEST_CARD_STATUSES].sort())
  })

  test('THERE IS NO `returned` STATUS — a return goes back to `booked`', () => {
    // The smallest thing that answers the requirement. A verifier who cannot
    // read the evidence hands the card back; the tester holds it again exactly
    // as they did before submitting, and the reason travels on the row and in
    // the trail rather than in a fifth state.
    assert.equal((TEST_CARD_STATUSES as readonly string[]).includes('returned'), false)
    assert.ok(TEST_CARD_TRANSITIONS.submitted.includes('booked'))
  })

  test('BOOKING IS NOT A TRANSITION', () => {
    // It has its own function because it must be a single conditional UPDATE to
    // win a race between two testers. Listing it here would invite a future
    // caller to route it through the generic transition, which locks a row it
    // has already read — one lock too late.
    assert.deepEqual(TEST_CARD_TRANSITIONS.available, [])
    assert.equal(canTransition('available', 'booked'), false)
  })

  test('the only forward path is booked → submitted → verified', () => {
    assert.deepEqual(TEST_CARD_TRANSITIONS.booked, ['submitted'])
    assert.deepEqual([...TEST_CARD_TRANSITIONS.submitted].sort(), ['booked', 'verified'])
    assert.deepEqual(TEST_CARD_TRANSITIONS.verified, [])
  })

  test('verified is terminal, and available is a dead end without booking', () => {
    assert.equal(isTerminalStatus('verified'), true)
    assert.equal(isTerminalStatus('available'), true)
    assert.equal(isTerminalStatus('booked'), false)
    assert.equal(isTerminalStatus('submitted'), false)
  })

  test('no card can skip a step', () => {
    assert.equal(canTransition('booked', 'verified'), false)
    assert.equal(canTransition('available', 'submitted'), false)
    assert.equal(canTransition('verified', 'booked'), false)
    assert.equal(canTransition('verified', 'submitted'), false)
  })
})

describe('who may make which move', () => {
  test('verifying and returning need `verify`, and nothing else does', () => {
    assert.deepEqual([...VERIFIER_ONLY_TRANSITIONS].sort(), ['booked', 'verified'])
    assert.equal(transitionRequiresVerify('verified'), true)
    assert.equal(transitionRequiresVerify('booked'), true)
    assert.equal(transitionRequiresVerify('submitted'), false)
  })

  test('the tester holding a card may submit it', () => {
    assert.deepEqual(
      availableActions(card('booked'), tester).map(a => a.to),
      ['submitted'],
    )
  })

  test('A TESTER CANNOT VERIFY THEIR OWN TEST', () => {
    // The separation the whole workflow exists to exercise.
    assert.deepEqual(availableActions(card('submitted'), tester), [])
  })

  test('a colleague who merely holds `use` is offered nothing', () => {
    const colleague = { userId: OTHER, canUse: true, canVerify: false }
    assert.deepEqual(availableActions(card('booked'), colleague), [])
    assert.deepEqual(availableActions(card('submitted'), colleague), [])
  })

  test('a verifier is offered verify and return, on a submitted card only', () => {
    assert.deepEqual(
      availableActions(card('submitted'), verifier).map(a => a.to).sort(),
      ['booked', 'verified'],
    )
    // ...and nothing on a card that has not been handed over.
    assert.deepEqual(availableActions(card('booked'), verifier), [])
  })

  test('a verifier does not submit somebody else’s test for them', () => {
    assert.equal(
      availableActions(card('booked'), both).some(a => a.to === 'submitted'),
      false,
    )
  })

  // ── THE ADMIN BYPASS, REMOVED ─────────────────────────────────────────────
  //
  // The test that stood here asserted 'an admin may act on a card they do not
  // hold' and expected Submit to be offered on somebody else's booked card.
  // That was the defect, not the specification: submitting is the tester's
  // statement that THEY ran the test, and an administrator offering it is an
  // administrator being invited to make that statement on another person's
  // behalf.
  //
  // The two tests below are what replaces it. Note what is NOT lost: an
  // administrator keeps every verifier move on a submitted card, which is the
  // whole of the authority they need.
  test('an administrator is offered NO tester action on a card they do not hold', () => {
    assert.deepEqual(availableActions(card('booked'), admin), [],
      'Submit must not be offered on somebody else’s card')
  })

  test('an administrator keeps verify and return, which is their actual authority', () => {
    assert.deepEqual(
      availableActions(card('submitted'), admin).map(a => a.to).sort(),
      ['booked', 'verified'],
    )
  })

  test('an administrator who booked the card themselves submits it like anyone', () => {
    // Ownership, not role, is what changed the answer between this test and the
    // one above it — the capabilities are identical and only `userId` differs.
    assert.deepEqual(
      availableActions(card('booked'), adminHoldingIt).map(a => a.to),
      ['submitted'],
    )
  })

  test('the two `use` holders are told apart by the card, not by anything else', () => {
    // Same capabilities, same status, different holder — and the only reason
    // the answers differ.
    const holder = { userId: HOLDER, canUse: true, canVerify: false }
    const other  = { userId: OTHER,  canUse: true, canVerify: false }
    assert.deepEqual(availableActions(card('booked'), holder).map(a => a.to), ['submitted'])
    assert.deepEqual(availableActions(card('booked'), other), [])
  })

  test('somebody with no permission is offered nothing, at any status', () => {
    for (const status of TEST_CARD_STATUSES) {
      assert.deepEqual(availableActions(card(status), nobody), [], status)
    }
  })

  test('a signed-out caller is offered nothing', () => {
    const signedOut = { userId: null, canUse: true, canVerify: true }
    for (const status of TEST_CARD_STATUSES) {
      assert.deepEqual(availableActions(card(status), signedOut), [], status)
    }
  })

  test('A VERIFIED CARD OFFERS NOTHING TO ANYBODY', () => {
    for (const viewer of [tester, verifier, both, admin, nobody]) {
      assert.deepEqual(availableActions(card('verified'), viewer), [])
    }
  })

  test('a return is labelled as one, and asks for a reason', () => {
    const back = availableActions(card('submitted'), verifier).find(a => a.to === 'booked')!
    assert.equal(back.label, 'Return to candidate')
    assert.equal(back.prompt, 'return_reason')
    assert.equal(back.destructive, true)
  })

  test('the submit button says what the tester is doing, not the status name', () => {
    const submit = availableActions(card('booked'), tester)[0]
    assert.equal(submit.label, 'Submit for verification')
  })
})

describe('booking', () => {
  test('only an available card, and only somebody who may use the module', () => {
    assert.equal(canBookCard({ status: 'available' }, tester), true)
    assert.equal(canBookCard({ status: 'available' }, admin), true)
    assert.equal(canBookCard({ status: 'available' }, nobody), false)
  })

  test('A VERIFIER WHO DOES NOT HOLD `use` CANNOT BOOK', () => {
    // The checker does not become the tester.
    assert.equal(canBookCard({ status: 'available' }, verifier), false)
  })

  test('a card that is already taken cannot be booked again', () => {
    for (const status of ['booked', 'submitted', 'verified'] as const) {
      assert.equal(canBookCard({ status }, tester), false, status)
    }
  })

  test('a signed-out caller books nothing', () => {
    assert.equal(canBookCard({ status: 'available' }, { userId: null, canUse: true }), false)
  })
})

describe('what a submission needs', () => {
  const unconfirmed = { sent_confirmed_at: null }
  const confirmed = { sent_confirmed_at: '2026-08-29T10:00:00Z' }

  test('the tester’s own confirmation, and a screenshot', () => {
    assert.deepEqual(submissionBlockers(unconfirmed, 0), [
      'Confirm that you sent the message.',
      'Attach a screenshot of the message you sent.',
    ])
  })

  test('confirming alone is not enough', () => {
    assert.deepEqual(submissionBlockers(confirmed, 0), [
      'Attach a screenshot of the message you sent.',
    ])
  })

  test('a screenshot alone is not enough either', () => {
    assert.deepEqual(submissionBlockers(unconfirmed, 1), [
      'Confirm that you sent the message.',
    ])
  })

  test('both, and the card is ready', () => {
    assert.deepEqual(submissionBlockers(confirmed, 1), [])
  })

  test('OPENING WHATSAPP IS NOT ONE OF THE PREREQUISITES', () => {
    // The most important negative in the file. `whatsapp_opened_at` is not a
    // parameter of submissionBlockers, so there is no way for an opened link to
    // stand in for a person's claim that they pressed send.
    const blockers = submissionBlockers(
      { sent_confirmed_at: null } as never,
      1,
    )
    assert.ok(blockers.includes('Confirm that you sent the message.'))
  })
})

describe('which lists a card belongs in', () => {
  test('a tester’s active list is booked and submitted, and nothing else', () => {
    assert.deepEqual([...ACTIVE_TESTER_STATUSES].sort(), ['booked', 'submitted'])
  })

  test('A VERIFIED CARD IS IN NO ACTIVE LIST', () => {
    // The requirement, in one assertion. It is not filtered out cosmetically:
    // 'verified' is simply not a member of the active set, and 'available' is
    // not either — a verified card does not return to the pool.
    assert.equal(ACTIVE_TESTER_STATUSES.has('verified'), false)
    assert.equal(ACTIVE_TESTER_STATUSES.has('available'), false)
  })
})
