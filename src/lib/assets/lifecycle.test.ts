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

// The database half — that the purge actually removes every dependent row and
// leaves unrelated records alone — is scripted in
// supabase/tests/asset_permanent_delete_assertions.sql, because only a live
// project can assert it.
describe('assetDeleteBlockReason (20260803000000)', () => {
  const base = { canDeleteAsset: true, isAdmin: true, hasActiveAssignment: false }

  test('an admin may permanently delete a never-assigned asset', () => {
    assert.equal(assetDeleteBlockReason(base), null)
  })

  test('assignment history no longer blocks — that is the whole point of the purge', () => {
    // Before 20260803000000 this returned "…custody record is permanent." The
    // history is now erased WITH the asset rather than standing in its way.
    assert.equal(assetDeleteBlockReason(base), null)
  })

  test('a currently-assigned asset is still blocked, with an actionable reason', () => {
    const reason = assetDeleteBlockReason({ ...base, hasActiveAssignment: true })
    assert.match(reason ?? '', /currently assigned/i)
    assert.match(reason ?? '', /returned or lost/i)
  })

  test('a non-admin holding assets_access.delete is refused', () => {
    const reason = assetDeleteBlockReason({ ...base, isAdmin: false })
    assert.match(reason ?? '', /administrator/i)
  })

  test('an admin without the delete permission is refused', () => {
    const reason = assetDeleteBlockReason({ ...base, canDeleteAsset: false })
    assert.match(reason ?? '', /administrator/i)
  })

  test('authority is checked before state, so a non-admin never sees custody detail', () => {
    const reason = assetDeleteBlockReason({
      canDeleteAsset: false, isAdmin: false, hasActiveAssignment: true,
    })
    assert.match(reason ?? '', /administrator/i)
    assert.doesNotMatch(reason ?? '', /currently assigned/i)
  })

  test('no refusal ever tells the reader that history is permanent', () => {
    const inputs = [
      base,
      { ...base, hasActiveAssignment: true },
      { ...base, isAdmin: false },
      { ...base, canDeleteAsset: false },
    ]
    for (const input of inputs) {
      assert.doesNotMatch(assetDeleteBlockReason(input) ?? '', /custody record is permanent/i)
    }
  })
})
