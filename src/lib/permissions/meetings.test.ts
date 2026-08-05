/**
 * Meetings permission derivation.
 *
 * The rule this suite protects: **'view' is module entry, not visibility.**
 *
 * Assets & Access learned this the expensive way — a module-entry default
 * quietly became organisation-wide read access to the whole inventory
 * (see src/lib/permissions/assetsAccess.ts and migration 20260810000000).
 * Meetings are confidential management reviews, so the same mistake here would
 * put every order discussion in front of every employee.
 *
 * These are DISPLAY gates. RLS (can_view_meeting / can_edit_meeting in
 * 20260814000000) remains the enforcement boundary — nothing asserted here
 * grants anything the database would accept.
 *
 * Run:
 *   npx tsx --test src/lib/permissions/meetings.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveMeetingsCapabilities, canEditThisMeeting, canSetThisMeetingStatus,
  NO_MEETINGS_CAPABILITIES,
} from './meetings'
import type { EffectivePermission } from './types'

const grant = (...actions: string[]): EffectivePermission[] =>
  actions.map(actionKey => ({ actionKey, allowed: true, source: 'role' as const }))

/** An explicitly denied action must read exactly like an absent one. */
const deny = (...actions: string[]): EffectivePermission[] =>
  actions.map(actionKey => ({ actionKey, allowed: false, source: 'role' as const }))

const LEAD = 'user-lead'
const CREATOR = 'user-creator'
const STRANGER = 'user-stranger'

const meeting = (over: Partial<{ status: 'draft' | 'in_progress' | 'completed'; lead_id: string; created_by: string }> = {}) => ({
  status: 'in_progress' as const, lead_id: LEAD, created_by: CREATOR, ...over,
})

describe('deriveMeetingsCapabilities', () => {
  test('an admin bypasses the engine entirely', () => {
    const caps = deriveMeetingsCapabilities('admin', [])
    assert.equal(caps.canAccessMeetings, true)
    assert.equal(caps.canViewAllMeetings, true)
    assert.equal(caps.canCompleteMeeting, true)
    assert.equal(caps.canImport, true)
  })

  test('no grants means no capability at all', () => {
    assert.deepEqual(deriveMeetingsCapabilities('member', []), NO_MEETINGS_CAPABILITIES)
  })

  test("'view' opens the module but does NOT reveal everyone's meetings", () => {
    const caps = deriveMeetingsCapabilities('member', grant('view'))
    assert.equal(caps.canAccessMeetings, true)
    // The rule this file exists for. RLS still narrows the rows to meetings
    // this person led, created or attended.
    assert.equal(caps.canViewAllMeetings, false)
    assert.equal(caps.canConductMeeting, false)
    assert.equal(caps.canCompleteMeeting, false)
    assert.equal(caps.canImport, false)
  })

  test("'manage' is what grants sight of every meeting, and completion", () => {
    const caps = deriveMeetingsCapabilities('manager', grant('view', 'manage'))
    assert.equal(caps.canViewAllMeetings, true)
    assert.equal(caps.canCompleteMeeting, true)
    assert.equal(caps.canConductMeeting, true)
  })

  test("'edit' conducts a meeting but does not widen visibility", () => {
    const caps = deriveMeetingsCapabilities('member', grant('view', 'edit'))
    assert.equal(caps.canConductMeeting, true)
    assert.equal(caps.canImport, true)
    assert.equal(caps.canViewAllMeetings, false)
    // Completing is a management decision, not an editing one.
    assert.equal(caps.canCompleteMeeting, false)
  })

  test('a stronger grant always implies module entry', () => {
    // Otherwise someone could be authorized to act on a module they cannot open.
    for (const action of ['create', 'edit', 'manage']) {
      const caps = deriveMeetingsCapabilities('member', grant(action))
      assert.equal(caps.canAccessMeetings, true, action)
    }
  })

  test('an explicitly denied action reads exactly like an absent one', () => {
    assert.deepEqual(
      deriveMeetingsCapabilities('member', deny('view', 'create', 'edit', 'manage', 'delete')),
      NO_MEETINGS_CAPABILITIES,
    )
  })

  test('a foreign module’s permissions are never borrowed', () => {
    // getEffectivePermissions is called per module, but a mixed array must not
    // accidentally satisfy anything: only exact action keys count.
    const caps = deriveMeetingsCapabilities('member', [
      { actionKey: 'manage_meetings', allowed: true, source: 'role' },
      { actionKey: 'viewer', allowed: true, source: 'role' },
    ])
    assert.deepEqual(caps, NO_MEETINGS_CAPABILITIES)
  })
})

describe('canEditThisMeeting', () => {
  const attendeeCaps = deriveMeetingsCapabilities('member', grant('view'))
  const editorCaps   = deriveMeetingsCapabilities('member', grant('view', 'edit'))

  test('the lead and the creator may record their own review without a module grant', () => {
    // Whoever is running the meeting must be able to write it down.
    assert.equal(canEditThisMeeting(meeting(), LEAD, attendeeCaps), true)
    assert.equal(canEditThisMeeting(meeting(), CREATOR, attendeeCaps), true)
  })

  test('a plain attendee may not', () => {
    assert.equal(canEditThisMeeting(meeting(), STRANGER, attendeeCaps), false)
  })

  test("an 'edit' grant is enough for anyone", () => {
    assert.equal(canEditThisMeeting(meeting(), STRANGER, editorCaps), true)
  })

  test('a completed meeting is editable by nobody — not the lead, not an admin', () => {
    const adminCaps = deriveMeetingsCapabilities('admin', [])
    assert.equal(canEditThisMeeting(meeting({ status: 'completed' }), LEAD, editorCaps), false)
    assert.equal(canEditThisMeeting(meeting({ status: 'completed' }), 'any-admin', adminCaps), false)
  })

  test('a signed-out caller can never edit', () => {
    assert.equal(canEditThisMeeting(meeting(), null, editorCaps), false)
    assert.equal(canEditThisMeeting(meeting(), undefined, editorCaps), false)
  })

  test('a draft is editable, same as a live meeting', () => {
    assert.equal(canEditThisMeeting(meeting({ status: 'draft' }), LEAD, attendeeCaps), true)
  })
})

describe('canSetThisMeetingStatus', () => {
  const attendeeCaps = deriveMeetingsCapabilities('member', grant('view'))
  const managerCaps  = deriveMeetingsCapabilities('manager', grant('view', 'manage'))

  test('the owners may complete their own meeting', () => {
    assert.equal(canSetThisMeetingStatus(meeting(), LEAD, attendeeCaps), true)
    assert.equal(canSetThisMeetingStatus(meeting(), CREATOR, attendeeCaps), true)
  })

  test('a plain attendee may not', () => {
    assert.equal(canSetThisMeetingStatus(meeting(), STRANGER, attendeeCaps), false)
  })

  test("reopening a completed meeting stays available — the one write against one", () => {
    // canEditThisMeeting refuses a completed meeting; this must not, or a
    // completed meeting could never be corrected.
    assert.equal(canSetThisMeetingStatus(meeting({ status: 'completed' }), LEAD, attendeeCaps), true)
    assert.equal(canSetThisMeetingStatus(meeting({ status: 'completed' }), STRANGER, managerCaps), true)
  })

  test('a signed-out caller can never change status', () => {
    assert.equal(canSetThisMeetingStatus(meeting(), null, managerCaps), false)
  })
})
