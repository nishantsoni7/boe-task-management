/**
 * Task Detail draws "Add to Meeting" only for the people the database accepts as
 * the source task's owner — creator, current assignee, admin — and only with
 * Meetings access. A delegator is deliberately not one of them.
 *
 * Run:
 *   npx tsx --test src/lib/tasks/addToMeetingAccess.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { canOfferAddToMeeting } from './addToMeetingAccess'

const base = { hasMeetingAccess: true, isCreator: false, isAssignee: false, isAdmin: false, isQuotation: false }

describe('canOfferAddToMeeting', () => {
  test('creator, current assignee and admin are offered it', () => {
    assert.equal(canOfferAddToMeeting({ ...base, isCreator: true }), true)
    assert.equal(canOfferAddToMeeting({ ...base, isAssignee: true }), true)
    assert.equal(canOfferAddToMeeting({ ...base, isAdmin: true }), true)
  })

  test('a delegator — someone who can open the task but is none of the three — is not', () => {
    assert.equal(canOfferAddToMeeting(base), false)
  })

  test('without Meetings access nobody is offered it', () => {
    for (const role of ['isCreator', 'isAssignee', 'isAdmin'] as const) {
      assert.equal(canOfferAddToMeeting({ ...base, [role]: true, hasMeetingAccess: false }), false)
    }
  })

  test('never on a quotation request', () => {
    assert.equal(canOfferAddToMeeting({ ...base, isCreator: true, isQuotation: true }), false)
  })
})
