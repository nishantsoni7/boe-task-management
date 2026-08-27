/**
 * The status model: which moves are legal, who may make them, and what a
 * request needs before it can be sent.
 *
 * The DECIDING copy of all of this is in
 * supabase/migrations/20261017000000_customer_review_outreach.sql. This file
 * asserts the browser's copy is correct on its own terms; migration.test.ts
 * asserts the two agree.
 *
 * Fictional data only.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/status.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  CUSTOMER_REVIEW_TRANSITIONS,
  availableActions,
  canTransition,
  isEditableStatus,
  isReadyToSend,
  isTerminalStatus,
  readyToSendBlockers,
  transitionRequiresVerify,
} from './status'
import { CUSTOMER_REVIEW_STATUSES, type CustomerReviewStatus } from './types'

const OWNER = 'user-owner-0000'
const OTHER = 'user-other-0000'

const viewer = (over: Partial<{ userId: string | null; isAdmin: boolean; canUse: boolean; canVerify: boolean }> = {}) => ({
  userId: OWNER as string | null,
  isAdmin: false,
  canUse: true,
  canVerify: false,
  ...over,
})

// Typed with the nullable shape readyToSendBlockers actually accepts, so the
// "missing field" cases below can set a field to null the way a real draft row
// carries it.
const complete: Parameters<typeof readyToSendBlockers>[0] = {
  genuine_customer_confirmed: true,
  customer_name: 'Riverside Café',
  whatsapp_number: '+919999900001',
  interaction_type: 'cafe_project',
  review_url: 'https://example.test/review',
  image_permission_confirmed: false,
}

describe('the transition table', () => {
  test('every status the module declares has an entry', () => {
    for (const status of CUSTOMER_REVIEW_STATUSES) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(CUSTOMER_REVIEW_TRANSITIONS, status),
        `${status} has no transitions entry`,
      )
    }
    assert.equal(Object.keys(CUSTOMER_REVIEW_TRANSITIONS).length, CUSTOMER_REVIEW_STATUSES.length)
  })

  test('every target is itself a declared status — no move goes nowhere', () => {
    for (const [from, targets] of Object.entries(CUSTOMER_REVIEW_TRANSITIONS)) {
      for (const to of targets) {
        assert.ok(
          (CUSTOMER_REVIEW_STATUSES as readonly string[]).includes(to),
          `${from} → ${to} is not a real status`,
        )
      }
    }
  })

  test('the legal moves are exactly these and no others', () => {
    assert.deepEqual(CUSTOMER_REVIEW_TRANSITIONS, {
      draft:              ['ready_to_send', 'cancelled'],
      ready_to_send:      ['draft', 'sent', 'cancelled'],
      sent:               ['customer_responded', 'verified', 'cancelled'],
      customer_responded: ['verified', 'cancelled'],
      verified:           ['closed'],
      closed:             [],
      cancelled:          [],
    })
  })

  test('closed and cancelled are terminal, and nothing else is', () => {
    for (const status of CUSTOMER_REVIEW_STATUSES) {
      assert.equal(
        isTerminalStatus(status),
        status === 'closed' || status === 'cancelled',
        status,
      )
    }
  })

  test('nothing can skip straight to a claim nobody made', () => {
    // The specific jumps that would let the record assert something untrue.
    const forbidden: [CustomerReviewStatus, CustomerReviewStatus][] = [
      ['draft', 'sent'],
      ['draft', 'verified'],
      ['draft', 'closed'],
      ['ready_to_send', 'customer_responded'],
      ['ready_to_send', 'verified'],
      ['ready_to_send', 'closed'],
      ['sent', 'closed'],
      ['customer_responded', 'closed'],
      ['closed', 'verified'],
      ['cancelled', 'draft'],
      ['verified', 'cancelled'],
    ]
    for (const [from, to] of forbidden) {
      assert.equal(canTransition(from, to), false, `${from} → ${to} must be refused`)
    }
  })

  test('a request is never verified without passing through an outreach that happened', () => {
    // Reaching 'verified' always means somebody sent something first.
    const reachesVerified = CUSTOMER_REVIEW_STATUSES
      .filter(s => canTransition(s, 'verified'))
      .sort()
    assert.deepEqual(reachesVerified, ['customer_responded', 'sent'])
  })

  test('closing is only ever reachable from verified', () => {
    const reachesClosed = CUSTOMER_REVIEW_STATUSES.filter(s => canTransition(s, 'closed'))
    assert.deepEqual(reachesClosed, ['verified'])
  })

  test('cancelling stays available while the outreach is still open', () => {
    for (const status of ['draft', 'ready_to_send', 'sent', 'customer_responded'] as const) {
      assert.equal(canTransition(status, 'cancelled'), true, status)
    }
    // ...and stops once the record describes something that was checked.
    assert.equal(canTransition('verified', 'cancelled'), false)
    assert.equal(canTransition('closed', 'cancelled'), false)
  })

  test('only draft and ready_to_send are editable', () => {
    for (const status of CUSTOMER_REVIEW_STATUSES) {
      assert.equal(
        isEditableStatus(status),
        status === 'draft' || status === 'ready_to_send',
        status,
      )
    }
  })
})

describe('who may make which move', () => {
  test('verify and close are the only verifier-gated transitions', () => {
    for (const status of CUSTOMER_REVIEW_STATUSES) {
      assert.equal(
        transitionRequiresVerify(status),
        status === 'verified' || status === 'closed',
        status,
      )
    }
  })

  test('the owner can prepare, send, record a reply and cancel — and cannot verify', () => {
    const offered = (status: CustomerReviewStatus) =>
      availableActions({ status, created_by: OWNER }, viewer()).map(a => a.to).sort()

    assert.deepEqual(offered('draft'), ['cancelled', 'ready_to_send'])
    assert.deepEqual(offered('ready_to_send'), ['cancelled', 'draft', 'sent'])
    assert.deepEqual(offered('sent'), ['cancelled', 'customer_responded'])
    assert.deepEqual(offered('customer_responded'), ['cancelled'])
    // Nothing at all: verified → closed needs `verify`, which this owner lacks.
    assert.deepEqual(offered('verified'), [])
  })

  test('VERIFICATION CANNOT BE SELF-SERVICE: the owner is offered nothing to verify', () => {
    const actions = availableActions({ status: 'sent', created_by: OWNER }, viewer())
    assert.equal(actions.some(a => a.to === 'verified'), false)
  })

  test('a verifier without `use` may verify and close, and may not run the outreach', () => {
    const v = viewer({ userId: OTHER, canUse: false, canVerify: true })
    assert.deepEqual(
      availableActions({ status: 'sent', created_by: OWNER }, v).map(a => a.to),
      ['verified'],
    )
    assert.deepEqual(
      availableActions({ status: 'verified', created_by: OWNER }, v).map(a => a.to),
      ['closed'],
    )
    // Not their outreach, so no preparation or sending is offered.
    assert.deepEqual(availableActions({ status: 'draft', created_by: OWNER }, v).map(a => a.to), [])
  })

  test('somebody else holding only `use` is offered nothing on another employee’s request', () => {
    const v = viewer({ userId: OTHER })
    for (const status of CUSTOMER_REVIEW_STATUSES) {
      assert.deepEqual(availableActions({ status, created_by: OWNER }, v), [], status)
    }
  })

  test('an admin is offered every legal move', () => {
    const admin = viewer({ userId: OTHER, isAdmin: true, canUse: false, canVerify: false })
    assert.deepEqual(
      availableActions({ status: 'sent', created_by: OWNER }, admin).map(a => a.to).sort(),
      ['cancelled', 'customer_responded', 'verified'],
    )
  })

  test('a signed-out viewer is offered nothing', () => {
    assert.deepEqual(
      availableActions({ status: 'draft', created_by: OWNER }, viewer({ userId: null })),
      [],
    )
  })

  test('nothing is offered on a terminal request, to anyone', () => {
    const admin = viewer({ userId: OTHER, isAdmin: true })
    for (const status of ['closed', 'cancelled'] as const) {
      assert.deepEqual(availableActions({ status, created_by: OWNER }, admin), [], status)
    }
  })

  test('the send action is worded as the employee’s own confirmation', () => {
    const send = availableActions({ status: 'ready_to_send', created_by: OWNER }, viewer())
      .find(a => a.to === 'sent')
    assert.ok(send)
    // "I sent this invitation" — a claim the person makes. Never "Mark
    // delivered", "Sent successfully" or anything WhatsApp would have to have
    // told us.
    assert.ok(/^I sent/.test(send!.label), send!.label)
    for (const word of ['delivered', 'success', 'confirmed by whatsapp']) {
      assert.equal(send!.label.toLowerCase().includes(word), false, word)
    }
  })

  test('verifying always asks what was checked', () => {
    const v = viewer({ canVerify: true })
    const verify = availableActions({ status: 'sent', created_by: OWNER }, v).find(a => a.to === 'verified')
    assert.equal(verify?.prompt, 'verification_note')
  })
})

describe('ready-to-send prerequisites', () => {
  test('a complete request with no photographs is ready', () => {
    assert.deepEqual(readyToSendBlockers(complete, 0), [])
    assert.equal(isReadyToSend(complete, 0), true)
  })

  test('each missing field produces its own sentence', () => {
    const cases: [Partial<typeof complete>, string][] = [
      [{ genuine_customer_confirmed: false }, 'genuine BOE customer'],
      [{ customer_name: '' }, 'customer or project name'],
      [{ customer_name: '    ' }, 'customer or project name'],
      [{ whatsapp_number: null }, 'WhatsApp number'],
      [{ interaction_type: null }, 'interaction type'],
      [{ review_url: null }, 'review destination'],
    ]
    for (const [patch, fragment] of cases) {
      const blockers = readyToSendBlockers({ ...complete, ...patch }, 0)
      assert.equal(blockers.length, 1, JSON.stringify(patch))
      assert.ok(blockers[0].includes(fragment), `${blockers[0]} should mention ${fragment}`)
    }
  })

  test('an empty request lists every blocker at once, not one at a time', () => {
    const blockers = readyToSendBlockers({
      genuine_customer_confirmed: false,
      customer_name: '',
      whatsapp_number: null,
      interaction_type: null,
      review_url: null,
      image_permission_confirmed: false,
    }, 0)
    assert.equal(blockers.length, 5)
  })

  test('PHOTOGRAPHS REQUIRE THE SHARING CONFIRMATION, and only when there are photographs', () => {
    assert.deepEqual(readyToSendBlockers(complete, 0), [])
    const withPhotos = readyToSendBlockers(complete, 2)
    assert.equal(withPhotos.length, 1)
    assert.ok(withPhotos[0].includes('permission to share'))

    assert.deepEqual(
      readyToSendBlockers({ ...complete, image_permission_confirmed: true }, 2),
      [],
    )
  })

  test('the internal note is NOT a prerequisite', () => {
    // It never reaches the customer, so requiring it would be requiring
    // paperwork rather than requiring correctness.
    assert.deepEqual(readyToSendBlockers(complete, 0), [])
  })

  test('the confirmation must be literally true, not merely truthy', () => {
    const blockers = readyToSendBlockers(
      { ...complete, genuine_customer_confirmed: undefined as unknown as boolean },
      0,
    )
    assert.equal(blockers.length, 1)
  })
})
