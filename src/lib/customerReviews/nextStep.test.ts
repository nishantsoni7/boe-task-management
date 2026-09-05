/**
 * The next-step sentence — one per state, per viewer — and the stage index
 * behind the progress strip.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/nextStep.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { nextStepFor, stageIndex, REVIEW_STAGES } from './nextStep'

const ME = 'user-me'
const OTHER = 'user-other'
const holder  = { userId: ME, canUse: true, canVerify: false }
const verifier = { userId: OTHER, canUse: false, canVerify: true }
const both = { userId: OTHER, canUse: true, canVerify: true }

const card = (over: Partial<Parameters<typeof nextStepFor>[0]> = {}) => ({
  status: 'booked' as const, booked_by: ME, whatsapp_opened_at: null, sent_confirmed_at: null,
  returned_at: null, return_reason: null, deleted_at: null,
  // Every review was a text review before types existed, so that is what a
  // default fixture is; the image cases say so explicitly.
  review_type: 'text' as const, image_group_id: null, ...over,
})

describe('the holder’s path, in order', () => {
  test('booked, nothing done → open WhatsApp', () => {
    const s = nextStepFor(card(), holder)
    assert.equal(s.tone, 'act')
    assert.match(s.headline, /Open WhatsApp/)
  })
  test('opened, not confirmed → confirm sent', () => {
    const s = nextStepFor(card({ whatsapp_opened_at: 't' }), holder)
    assert.match(s.headline, /Confirm you sent it/)
  })
  test('confirmed, no screenshot → attach', () => {
    const s = nextStepFor(card({ whatsapp_opened_at: 't', sent_confirmed_at: 't' }), holder, false)
    assert.match(s.headline, /Attach your screenshot/)
  })
  test('confirmed, screenshot attached → submit', () => {
    const s = nextStepFor(card({ whatsapp_opened_at: 't', sent_confirmed_at: 't' }), holder, true)
    assert.match(s.headline, /Submit for verification/)
  })
  test('a list tile, which cannot know about the screenshot, says both halves', () => {
    const s = nextStepFor(card({ whatsapp_opened_at: 't', sent_confirmed_at: 't' }), holder)
    assert.match(s.headline, /Attach your screenshot and submit/)
  })
  test('returned → fix and resubmit, with the verifier’s reason', () => {
    const s = nextStepFor(card({ whatsapp_opened_at: 't', sent_confirmed_at: 't', returned_at: 't', return_reason: 'Screenshot unreadable' }), holder, true)
    assert.equal(s.tone, 'attention')
    assert.match(s.headline, /Returned/)
    assert.match(s.hint ?? '', /Screenshot unreadable/)
  })
  test('submitted → waiting', () => {
    const s = nextStepFor(card({ status: 'submitted', whatsapp_opened_at: 't', sent_confirmed_at: 't' }), holder)
    assert.equal(s.tone, 'wait')
    assert.match(s.headline, /Waiting for verification/)
  })
})

describe('the verifier', () => {
  test('a submitted review is ready to verify', () => {
    const s = nextStepFor(card({ status: 'submitted', booked_by: ME, whatsapp_opened_at: 't', sent_confirmed_at: 't' }), verifier)
    assert.equal(s.tone, 'act')
    assert.match(s.headline, /Ready to verify/)
    assert.match(s.hint ?? '', /return it/)
  })
  test('somebody else’s booked review is theirs to finish', () => {
    const s = nextStepFor(card(), verifier)
    assert.equal(s.tone, 'wait')
    assert.match(s.headline, /Booked · not sent yet/)
    const sent = nextStepFor(card({ whatsapp_opened_at: 't', sent_confirmed_at: 't' }), verifier)
    assert.match(sent.headline, /Sent/)
  })
  test('a verifier holding a card is a holder on it — the tester path applies', () => {
    const s = nextStepFor(card({ booked_by: OTHER }), both)
    assert.match(s.headline, /Open WhatsApp/)
  })
  test('a pending draft asks the verifier to approve it', () => {
    assert.match(nextStepFor(card({ status: 'pending_approval', booked_by: null }), verifier).headline, /Approve/)
    assert.equal(nextStepFor(card({ status: 'pending_approval', booked_by: null }), holder).tone, 'wait')
  })
})

describe('the ends', () => {
  test('available: view then book for a candidate; a plain status for anybody else', () => {
    assert.match(nextStepFor(card({ status: 'available', booked_by: null }), holder).headline, /View, then book/)
    assert.equal(nextStepFor(card({ status: 'available', booked_by: null }), verifier).tone, 'wait')
  })
  test('verified and deleted are done, for everyone', () => {
    assert.equal(nextStepFor(card({ status: 'verified' }), holder).tone, 'done')
    assert.equal(nextStepFor(card({ deleted_at: 't' }), holder).tone, 'done')
    assert.equal(nextStepFor(card({ deleted_at: 't' }), verifier).tone, 'done')
  })
  test('no viewer id → never an action', () => {
    assert.equal(nextStepFor(card(), { userId: null, canUse: true, canVerify: false }).tone, 'wait')
  })
})

describe('the stages', () => {
  test('four named stages, and the index follows the five facts', () => {
    assert.deepEqual([...REVIEW_STAGES], ['Booked', 'Sent', 'Submitted', 'Verified'])
    assert.equal(stageIndex({ status: 'available', sent_confirmed_at: null }), 0)
    assert.equal(stageIndex({ status: 'booked', sent_confirmed_at: null }), 1)
    assert.equal(stageIndex({ status: 'booked', sent_confirmed_at: 't' }), 2)
    assert.equal(stageIndex({ status: 'submitted', sent_confirmed_at: 't' }), 3)
    assert.equal(stageIndex({ status: 'verified', sent_confirmed_at: 't' }), 4)
  })
})
