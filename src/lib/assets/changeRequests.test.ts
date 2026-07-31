/**
 * Asset change requests — behavioural tests for the client-side rules.
 *
 * The authorization half (only an admin may approve, a reviewed request
 * cannot be reviewed twice, a blocked removal never marks approved) lives in
 * SECURITY DEFINER functions and is asserted in
 * docs/Module Docs/assets-custody-integrity-verification.sql, which needs a
 * live database. What is testable here is the shaping and the guards that
 * decide what the reader is allowed to submit.
 *
 * Run:
 *   npx tsx --test src/lib/assets/changeRequests.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  hasPendingRequest,
  buildProposedFields,
  hasAnyProposedChange,
  validateChangeRequest,
  describeProposedChanges,
  canReviewRequest,
  type AssetChangeRequest,
} from './changeRequests'

const CURRENT = {
  asset_type: 'laptop_desktop',
  asset_name: 'Dell XPS 15',
  serial_no: 'SN-1',
  specifications: '16GB RAM',
}

function request(over: Partial<AssetChangeRequest> = {}): AssetChangeRequest {
  return {
    id: 'r1',
    asset_id: 'a1',
    asset_name_snapshot: 'Dell XPS 15',
    request_type: 'edit',
    requested_by: 'u1',
    reason: 'Serial was mistyped',
    proposed_asset_type: null,
    proposed_asset_name: null,
    proposed_serial_no: null,
    proposed_specifications: null,
    status: 'pending',
    reviewed_by: null,
    reviewed_at: null,
    review_note: null,
    created_at: '2026-07-31T00:00:00Z',
    updated_at: '2026-07-31T00:00:00Z',
    ...over,
  }
}

describe('hasPendingRequest', () => {
  test('finds this user’s own open request of that type', () => {
    const rows = [request()]
    assert.equal(hasPendingRequest(rows, 'a1', 'u1', 'edit'), true)
  })

  test('another person’s pending request does not block yours', () => {
    const rows = [request({ requested_by: 'u2' })]
    assert.equal(hasPendingRequest(rows, 'a1', 'u1', 'edit'), false)
  })

  test('a pending edit does not block a removal request', () => {
    const rows = [request()]
    assert.equal(hasPendingRequest(rows, 'a1', 'u1', 'remove'), false)
  })

  test('a reviewed request never blocks a new one', () => {
    for (const status of ['approved', 'rejected'] as const) {
      const rows = [request({ status, reviewed_by: 'admin', reviewed_at: 'x' })]
      assert.equal(hasPendingRequest(rows, 'a1', 'u1', 'edit'), false, status)
    }
  })

  test('a request against a different asset does not block this one', () => {
    assert.equal(hasPendingRequest([request({ asset_id: 'a2' })], 'a1', 'u1', 'edit'), false)
  })
})

describe('buildProposedFields', () => {
  test('proposes only what actually changed', () => {
    const proposed = buildProposedFields(CURRENT, { ...CURRENT, serial_no: 'SN-2' })
    assert.deepEqual(proposed, {
      proposed_asset_type: null,
      proposed_asset_name: null,
      proposed_serial_no: 'SN-2',
      proposed_specifications: null,
    })
  })

  test('an untouched form proposes nothing', () => {
    assert.equal(hasAnyProposedChange(buildProposedFields(CURRENT, { ...CURRENT })), false)
  })

  test('whitespace-only edits are not changes', () => {
    const proposed = buildProposedFields(CURRENT, { ...CURRENT, asset_name: '  Dell XPS 15  ' })
    assert.equal(proposed.proposed_asset_name, null)
  })

  test('proposed values are trimmed', () => {
    const proposed = buildProposedFields(CURRENT, { ...CURRENT, asset_name: '  Dell XPS 17  ' })
    assert.equal(proposed.proposed_asset_name, 'Dell XPS 17')
  })

  test('clearing a field proposes nothing — NULL means unchanged downstream', () => {
    // Documented limitation: blanking a value stays an admin's direct edit,
    // because the approval function COALESCEs a NULL proposal to the current
    // value. Emptying the box must therefore not read as a change.
    const proposed = buildProposedFields(CURRENT, { ...CURRENT, serial_no: '' })
    assert.equal(proposed.proposed_serial_no, null)
  })

  test('a null current value with a new value is a change', () => {
    const proposed = buildProposedFields(
      { ...CURRENT, specifications: null },
      { ...CURRENT, specifications: '32GB RAM' },
    )
    assert.equal(proposed.proposed_specifications, '32GB RAM')
  })
})

describe('validateChangeRequest', () => {
  const changed = buildProposedFields(CURRENT, { ...CURRENT, asset_name: 'Dell XPS 17' })

  test('an edit request with a reason and a change is valid', () => {
    assert.equal(validateChangeRequest({ type: 'edit', reason: 'Renamed', proposed: changed }), null)
  })

  test('a reason is mandatory', () => {
    assert.match(validateChangeRequest({ type: 'edit', reason: '   ', proposed: changed }) ?? '', /reason/i)
    assert.match(validateChangeRequest({ type: 'remove', reason: '' }) ?? '', /reason/i)
  })

  test('an edit request that changes nothing is refused', () => {
    const nothing = buildProposedFields(CURRENT, { ...CURRENT })
    assert.match(validateChangeRequest({ type: 'edit', reason: 'x', proposed: nothing }) ?? '', /at least one field/i)
  })

  test('a removal request needs only a reason', () => {
    assert.equal(validateChangeRequest({ type: 'remove', reason: 'Damaged beyond repair' }), null)
  })
})

describe('describeProposedChanges', () => {
  test('lists only the fields the request names', () => {
    const lines = describeProposedChanges(request({ proposed_serial_no: 'SN-2' }))
    assert.deepEqual(lines, ['Serial No. → SN-2'])
  })

  test('renders the asset type readably', () => {
    const lines = describeProposedChanges(request({ proposed_asset_type: 'laptop_desktop' }))
    assert.deepEqual(lines, ['Type → laptop desktop'])
  })

  test('a removal request describes no field changes', () => {
    assert.deepEqual(describeProposedChanges(request({ request_type: 'remove' })), [])
  })
})

describe('canReviewRequest', () => {
  test('only a pending request can be reviewed', () => {
    assert.equal(canReviewRequest({ status: 'pending' }), true)
  })

  test('an already-reviewed request cannot be processed twice', () => {
    assert.equal(canReviewRequest({ status: 'approved' }), false)
    assert.equal(canReviewRequest({ status: 'rejected' }), false)
  })
})
