/**
 * Asset custody lifecycle — behavioural tests.
 *
 * Covers the client-side half of the three integrity fixes in
 * 20260722000000_assets_custody_integrity.sql. The database half (the
 * accept_employee_asset RPC, the delete trigger, the RESTRICT FK) cannot be
 * asserted from here — those cases are scripted in
 * docs/Module Docs/assets-custody-integrity-verification.sql and must be run
 * against a live project.
 *
 * Run:
 *   npx tsx --test src/lib/assets/lifecycle.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  ASSET_STATUS_AFTER_RETURN,
  ASSIGNMENT_STATUS_AFTER_RETURN,
  canAssignAsset,
  acceptanceStatusKey,
  assetDeleteBlockReason,
} from './lifecycle'
import { ASSET_STATUS_OPTIONS } from './types'

describe('return lifecycle', () => {
  test('a normal return puts the asset back to available, not returned', () => {
    assert.equal(ASSET_STATUS_AFTER_RETURN, 'available')
  })

  test('the assignment row still records returned — that is where the event belongs', () => {
    assert.equal(ASSIGNMENT_STATUS_AFTER_RETURN, 'returned')
  })

  test('a returned asset can be assigned again', () => {
    assert.equal(canAssignAsset(ASSET_STATUS_AFTER_RETURN), true)
  })

  test('an asset stranded in the old returned state is NOT assignable', () => {
    // This is the defect itself, and the reason 20260722000000 backfills.
    assert.equal(canAssignAsset('returned'), false)
  })

  test('assigned and lost assets are not assignable', () => {
    assert.equal(canAssignAsset('assigned'), false)
    assert.equal(canAssignAsset('lost'), false)
  })
})

// The database half of this rule is the assets_status_known CHECK, replaced by
// 20260801000100 to drop 'returned'. These lock the app's vocabulary to that
// list, so a status the database would refuse can never be offered in the UI.
const DB_ALLOWED_ASSET_STATUSES = [
  'available', 'assigned', 'under_repair', 'lost', 'retired', 'disposed',
] as const

describe('asset-master statuses (20260801000100)', () => {
  test('a return leaves the asset at available — the whole reason returned is not a status', () => {
    assert.equal(ASSET_STATUS_AFTER_RETURN, 'available')
    assert.ok(
      (DB_ALLOWED_ASSET_STATUSES as readonly string[]).includes(ASSET_STATUS_AFTER_RETURN),
      'the post-return status must be one the database accepts',
    )
  })

  test('returned is not offered as an asset status anywhere in the UI', () => {
    assert.ok(
      !ASSET_STATUS_OPTIONS.includes('returned' as never),
      'returned is a custody event, not a state an asset can rest in',
    )
  })

  test('every status the UI offers is one the database will accept', () => {
    for (const status of ASSET_STATUS_OPTIONS) {
      assert.ok(
        (DB_ALLOWED_ASSET_STATUSES as readonly string[]).includes(status),
        `${status} is offered by the UI but is not in the assets_status_known CHECK`,
      )
    }
  })

  test('the UI offers every status the database allows — no state is unreachable', () => {
    for (const status of DB_ALLOWED_ASSET_STATUSES) {
      assert.ok(
        (ASSET_STATUS_OPTIONS as readonly string[]).includes(status),
        `${status} exists in the database but cannot be filtered for`,
      )
    }
  })
})

describe('acceptanceStatusKey', () => {
  test('available asset with no assignment reads as available', () => {
    assert.equal(acceptanceStatusKey('available', undefined), 'available')
  })

  test('after a return the asset reads as available again, not returned', () => {
    assert.equal(acceptanceStatusKey(ASSET_STATUS_AFTER_RETURN, undefined), 'available')
  })

  test('a live assignment drives the displayed status', () => {
    assert.equal(acceptanceStatusKey('assigned', 'pending_acceptance'), 'pending_acceptance')
    assert.equal(acceptanceStatusKey('assigned', 'accepted'), 'accepted')
  })

  test('lost wins over any assignment state', () => {
    assert.equal(acceptanceStatusKey('lost', 'accepted'), 'lost')
  })

  test('legacy returned assets still render as returned', () => {
    assert.equal(acceptanceStatusKey('returned', undefined), 'returned')
  })
})

describe('assetDeleteBlockReason', () => {
  const base = { canDeleteAsset: true, hasActiveAssignment: false, assignmentHistoryCount: 0 }

  test('a never-assigned asset may be deleted by someone holding delete', () => {
    assert.equal(assetDeleteBlockReason(base), null)
  })

  test('an asset with any history is blocked, even after return', () => {
    const reason = assetDeleteBlockReason({ ...base, assignmentHistoryCount: 1 })
    assert.match(reason ?? '', /assignment history/i)
  })

  test('history blocks deletion no matter how old the custody was', () => {
    assert.notEqual(assetDeleteBlockReason({ ...base, assignmentHistoryCount: 7 }), null)
  })

  test('a currently-assigned asset is blocked, with the more specific reason', () => {
    const reason = assetDeleteBlockReason({ ...base, hasActiveAssignment: true, assignmentHistoryCount: 1 })
    assert.match(reason ?? '', /currently assigned/i)
  })

  test('a manager (no delete permission) is blocked even for a never-assigned asset', () => {
    const reason = assetDeleteBlockReason({ ...base, canDeleteAsset: false })
    assert.match(reason ?? '', /permission/i)
  })

  test('permission is checked before history, so a manager never sees history detail', () => {
    const reason = assetDeleteBlockReason({
      canDeleteAsset: false, hasActiveAssignment: true, assignmentHistoryCount: 3,
    })
    assert.match(reason ?? '', /permission/i)
  })
})
