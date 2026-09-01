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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  TEST_CARD_TRANSITIONS,
  VERIFIER_ONLY_TRANSITIONS,
  availableActions,
  canApproveDrafts,
  canBookCard,
  canTransition,
  canUnbookCard,
  isTerminalStatus,
  submissionBlockers,
  transitionRequiresVerify,
  unbookBlocker,
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

const card = (status: TestCardStatus, booked_by: string | null = HOLDER) =>
  ({ status, booked_by, deleted_at: null as string | null })

describe('the shape of the lifecycle', () => {
  test('there are five statuses and no sixth', () => {
    // `pending_approval` is the fifth, added by 20261026000000, and it comes
    // FIRST because it is where a generated draft starts. Nothing was renamed:
    // the four that were here are the four that are here.
    assert.deepEqual([...TEST_CARD_STATUSES],
      ['pending_approval', 'available', 'booked', 'submitted', 'verified'])
    assert.deepEqual(Object.keys(TEST_CARD_TRANSITIONS).sort(), [...TEST_CARD_STATUSES].sort())
  })

  test('APPROVAL IS NOT A TRANSITION EITHER', () => {
    // Same reason booking is not: a selection is approved atomically, and
    // approve_customer_review_drafts locks every named row and rechecks it
    // before writing. transition_customer_review_test_card reads one row, then
    // locks it, then decides — one lock too late for a move across a set.
    assert.deepEqual(TEST_CARD_TRANSITIONS.pending_approval, [])
    assert.equal(canTransition('pending_approval', 'available'), false)
    assert.equal(canTransition('pending_approval', 'booked'), false)
  })

  test('and a pending draft offers a candidate nothing at all', () => {
    // Not because the screen hides it: no status lists pending_approval as a
    // destination, and pending_approval lists no destination of its own, so
    // availableActions has nothing to return whoever is asking.
    for (const viewer of [
      { userId: 'u1', canUse: true,  canVerify: false },
      { userId: 'u1', canUse: false, canVerify: true },
      { userId: 'u1', canUse: true,  canVerify: true },
    ]) {
      assert.deepEqual(
        availableActions({ status: 'pending_approval', booked_by: null, deleted_at: null }, viewer), [])
    }
    assert.equal(
      canBookCard({ status: 'pending_approval', deleted_at: null }, { userId: 'u1', canUse: true }), false)
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
    assert.equal(canBookCard({ status: 'available', deleted_at: null }, tester), true)
    assert.equal(canBookCard({ status: 'available', deleted_at: null }, admin), true)
    assert.equal(canBookCard({ status: 'available', deleted_at: null }, nobody), false)
  })

  test('A VERIFIER WHO DOES NOT HOLD `use` CANNOT BOOK', () => {
    // The checker does not become the tester.
    assert.equal(canBookCard({ status: 'available', deleted_at: null }, verifier), false)
  })

  test('a card that is already taken cannot be booked again', () => {
    for (const status of ['booked', 'submitted', 'verified'] as const) {
      assert.equal(canBookCard({ status, deleted_at: null }, tester), false, status)
    }
  })

  test('a signed-out caller books nothing', () => {
    assert.equal(canBookCard({ status: 'available', deleted_at: null }, { userId: null, canUse: true }), false)
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

// ══ RELEASING A BOOKING ═════════════════════════════════════════════════════
//
// canUnbookCard() is the browser-side mirror of
// unbook_customer_review_test_card(), clause for clause. It decides what button
// to draw; the definer function re-checks every line of it under a row lock and
// is what actually refuses. A test here that passed while the function refused
// would be the exact failure this module's first rule forbids — a button that
// appears for something the database will not do.

const booked = (over: Partial<{
  status: TestCardStatus
  booked_by: string | null
  sent_confirmed_at: string | null
  returned_at: string | null
}> = {}) => ({
  status: 'booked' as TestCardStatus,
  booked_by: HOLDER as string | null,
  sent_confirmed_at: null as string | null,
  deleted_at: null as string | null,
  // An ordinary booking has never been returned. The returned shape gets its
  // own builder below, because returned implies sent and the two travel together.
  returned_at: null as string | null,
  ...over,
})

describe('the holder may release a booking, until they say they sent it', () => {
  test('the holder can, while it is booked and unsent', () => {
    assert.equal(canUnbookCard(booked(), tester), true)
    assert.equal(unbookBlocker(booked(), tester), null)
  })

  test('NOBODY ELSE CAN — not a colleague, not a verifier, not an administrator', () => {
    // The `admin` viewer below is not a special case in the code: it is
    // somebody holding both permissions who does not hold the card. There is no
    // role to consult, here or in the function.
    for (const [name, viewer] of [
      ['a colleague', { userId: OTHER, canUse: true }],
      ['a verifier', { userId: verifier.userId, canUse: verifier.canUse }],
      ['an administrator', { userId: admin.userId, canUse: admin.canUse }],
      ['somebody holding both', { userId: both.userId, canUse: both.canUse }],
    ] as const) {
      assert.equal(canUnbookCard(booked(), viewer), false, `${name} was offered Release`)
    }
  })

  test('and neither can somebody who is not signed in, or who lost `use`', () => {
    assert.equal(canUnbookCard(booked(), { userId: null, canUse: true }), false)
    assert.equal(canUnbookCard(booked(), { userId: HOLDER, canUse: false }), false)
  })

  test('ONCE A SEND IS CONFIRMED IT IS REFUSED, AND THE REASON IS SAID', () => {
    // The claim exists and cannot be withdrawn: releasing the review would let
    // somebody else book one that has already reached a real recipient.
    const sent = booked({ sent_confirmed_at: '2026-08-31T10:00:00Z' })
    assert.equal(canUnbookCard(sent, tester), false)
    assert.match(unbookBlocker(sent, tester) ?? '', /confirmed you sent this review/)
  })

  test('A LIVE SCREENSHOT BLOCKS IT, and the reason is actionable', () => {
    // An available review's screenshots are readable by every `use` holder, so
    // releasing one with somebody's WhatsApp screen attached would publish that
    // image to the whole pool. The holder can take it off themselves.
    assert.equal(canUnbookCard(booked(), tester, true), false)
    assert.match(unbookBlocker(booked(), tester, true) ?? '', /Remove the screenshot/)
  })

  test('and a review in any other status cannot be unbooked', () => {
    for (const status of ['pending_approval', 'available', 'submitted', 'verified'] as const) {
      assert.equal(canUnbookCard(booked({ status }), tester), false,
        `a ${status} review was offered Release`)
      // No blocker sentence either: the control is not merely disabled, it is
      // not the right question to be asking about that review.
      assert.equal(unbookBlocker(booked({ status }), tester), null)
    }
  })

  test('releasing is NOT in the transition table', () => {
    // It has its own function for the same reason booking does: it must clear
    // every booking field and append a trail entry in one transaction, under a
    // row lock that also serialises it against a send confirmation.
    assert.deepEqual(TEST_CARD_TRANSITIONS.booked, ['submitted'])
    assert.equal(canTransition('booked', 'available'), false)
  })
})

// ══ APPROVING ═══════════════════════════════════════════════════════════════

describe('approval needs the resolved verify permission and nothing else', () => {
  test('a verifier may, a candidate may not', () => {
    assert.equal(canApproveDrafts({ userId: OTHER, canVerify: true }), true)
    assert.equal(canApproveDrafts({ userId: HOLDER, canVerify: false }), false)
  })

  test('and being signed out is not a way in', () => {
    assert.equal(canApproveDrafts({ userId: null, canVerify: true }), false)
  })

  test('THERE IS NO ROLE ARGUMENT TO PASS, so no role can be consulted', () => {
    // The same shape as the rest of the module: an administrator approves
    // because the engine resolves `verify` for them, and one whose `verify` was
    // revoked in Control Center is refused exactly like anybody else. A
    // function that accepted a role would be a function somebody could hand
    // 'admin' to.
    assert.equal(canApproveDrafts.length, 1)
  })
})

// ══ A RETURNED REVIEW IS NOT AN ORDINARY BOOKING ════════════════════════════
//
// A verifier who cannot use the evidence sends the card back: submitted →
// booked, with a reason. The candidate holds it again and it is `booked`, which
// is the same status an untouched booking has — so "can this be unbooked?" has
// to answer differently for the two, and the difference must not depend on
// anybody remembering to check.
//
// IT DOES NOT: a returned review always carries sent_confirmed_at. Submitting
// requires it (assert_customer_review_test_card_submittable), a return is
// submitted → booked, and nothing clears it while a card is held. So the
// send-confirmation clause refuses a returned review structurally, and the
// invariant is asserted here rather than assumed.

const returned = (over: Partial<{ sent_confirmed_at: string | null; returned_at: string | null }> = {}) => ({
  status: 'booked' as TestCardStatus,
  booked_by: HOLDER as string | null,
  // Both non-null is the ONLY shape a returned review can have.
  sent_confirmed_at: '2026-08-30T09:00:00Z' as string | null,
  returned_at: '2026-08-31T09:00:00Z' as string | null,
  deleted_at: null as string | null,
  ...over,
})

describe('a review a verifier returned cannot be unbooked', () => {
  test('THE HOLDER IS REFUSED, even though it is booked and theirs again', () => {
    assert.equal(canUnbookCard(returned(), tester), false,
      'a returned review was offered Unbook — it has already reached a recipient')
  })

  test('and the reason names the RETURN rather than the send', () => {
    // Both are true. Only one is what the holder is looking at.
    const why = unbookBlocker(returned(), tester)
    assert.match(why ?? '', /verifier sent this review back/)
    assert.match(why ?? '', /submit it again/)
    assert.equal(/no longer be unbooked\.$/.test(why ?? ''), false,
      'the returned case fell through to the generic sent sentence')
  })

  test('an ordinary sent review gets the OTHER sentence', () => {
    const sentNotReturned = returned({ returned_at: null })
    assert.equal(canUnbookCard(sentNotReturned, tester), false)
    assert.match(unbookBlocker(sentNotReturned, tester) ?? '',
      /You confirmed you sent this review/)
  })

  test('THE INVARIANT: returned implies sent, so there is no third case', () => {
    // A card carrying returned_at but NOT sent_confirmed_at is not reachable —
    // submitting requires the confirmation and a return comes from submitted.
    // If the workflow ever changed so that it were reachable, this is where the
    // decision would have to be made deliberately rather than falling through
    // to "unbookable", so the shape is pinned.
    const impossible = returned({ sent_confirmed_at: null })
    assert.equal(canUnbookCard(impossible, tester), true,
      'the unreachable shape changed meaning; the returned path needs revisiting')
    // ...and it stays unreachable because submission requires the confirmation.
    assert.deepEqual(submissionBlockers({ sent_confirmed_at: null }, 1),
      ['Confirm that you sent the message.'])
  })

  test('and unbooking a returned review would be refused by the database too', () => {
    // The browser-side mirror is not the boundary. unbook_customer_review_test_card
    // raises ALREADY_SENT on any card with sent_confirmed_at, which every
    // returned card has — asserted against a live database in section 14i of
    // supabase/tests/customer_review_test_card_assertions.sql.
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20261026000000_review_workflow_batch_approval.sql'),
      'utf8',
    ).replace(/\r\n/g, '\n')
    const fn = sql.slice(sql.indexOf('create or replace function public.unbook_customer_review_test_card'))
    assert.ok(fn.includes('if c.sent_confirmed_at is not null then'))
    assert.ok(fn.includes('CUSTOMER_REVIEW_TEST_ALREADY_SENT'))
  })
})
