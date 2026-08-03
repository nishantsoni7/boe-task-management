/**
 * Assets & Access failure classification — behavioural tests.
 *
 * The contract: a reader never sees a driver string. The exact error that
 * started this work — `new row violates row-level security policy for table
 * "assets"` — is the first case below.
 *
 * Run:
 *   npx tsx --test src/lib/assets/errors.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { classifyAssetFailure, assetErrorMessage, type AssetAction } from './errors'

// The real PostgREST payload for an RLS refusal on INSERT.
const RLS_INSERT_REFUSAL = {
  code: '42501',
  message: 'new row violates row-level security policy for table "assets"',
  details: null,
  hint: null,
}

const ALL_ACTIONS: AssetAction[] = [
  'create', 'edit', 'assign', 'return', 'mark-lost', 'delete', 'accept',
  'request-edit', 'request-remove', 'approve-request', 'reject-request',
]

describe('classifyAssetFailure', () => {
  test('an RLS insert refusal is a permission failure', () => {
    assert.equal(classifyAssetFailure(RLS_INSERT_REFUSAL), 'permission')
  })

  test('42501 from a SECURITY DEFINER guard is a permission failure', () => {
    assert.equal(classifyAssetFailure({ code: '42501', message: 'ASSET_DELETE_BLOCKED: …' }), 'permission')
  })

  test('a missing function is a schema failure, not a permission one', () => {
    // accept_employee_asset before 20260722000000 is applied.
    assert.equal(classifyAssetFailure({ code: 'PGRST202', message: 'Could not find the function' }), 'schema')
    assert.equal(classifyAssetFailure({ code: '42883', message: 'function does not exist' }), 'schema')
  })

  test('a dropped connection is a network failure', () => {
    assert.equal(classifyAssetFailure({ code: null, message: 'Failed to fetch' }), 'network')
    assert.equal(classifyAssetFailure({ message: '' }), 'network')
  })

  test('serialization and lock failures are conflicts', () => {
    assert.equal(classifyAssetFailure({ code: '40001', message: '' }), 'conflict')
    assert.equal(classifyAssetFailure({ code: '55P03', message: '' }), 'conflict')
  })

  test('constraint violations are validation failures', () => {
    assert.equal(classifyAssetFailure({ code: '23502', message: 'null value' }), 'validation')
    assert.equal(classifyAssetFailure({ code: '23503', message: 'foreign key' }), 'validation')
  })

  test('anything unrecognised stays unknown rather than being guessed at', () => {
    assert.equal(classifyAssetFailure({ code: 'XX000', message: 'internal error' }), 'unknown')
  })
})

describe('assetErrorMessage', () => {
  test('the RLS create refusal reads as a permission sentence', () => {
    assert.equal(
      assetErrorMessage('create', RLS_INSERT_REFUSAL),
      'You do not have permission to add assets.',
    )
  })

  test('no message leaks the table name, the policy, or the error code', () => {
    for (const action of ALL_ACTIONS) {
      const msg = assetErrorMessage(action, RLS_INSERT_REFUSAL)
      assert.doesNotMatch(msg, /row-level security|42501|policy|"assets"|PGRST/i, `leaked in: ${msg}`)
    }
  })

  test('every action has its own permission sentence', () => {
    const messages = ALL_ACTIONS.map(a => assetErrorMessage(a, RLS_INSERT_REFUSAL))
    assert.equal(new Set(messages).size, ALL_ACTIONS.length)
    for (const m of messages) assert.match(m, /\.$/)
  })

  test('a guard that wrote a human sentence keeps it, minus the machine marker', () => {
    const msg = assetErrorMessage('delete', {
      code: '42501',
      message: 'ASSET_DELETE_BLOCKED: "Dell XPS 15" has assignment history and cannot be deleted',
    })
    assert.equal(msg, '"Dell XPS 15" has assignment history and cannot be deleted.')
    assert.doesNotMatch(msg, /ASSET_DELETE_BLOCKED/)
  })

  test('an acceptance guard message survives the same way', () => {
    const msg = assetErrorMessage('accept', {
      code: '42501',
      message: 'ASSET_ACCEPT_DENIED: No pending assignment found for you',
    })
    assert.equal(msg, 'No pending assignment found for you.')
  })

  test('a bare marker with no sentence falls back rather than showing an empty message', () => {
    const msg = assetErrorMessage('delete', { code: '42501', message: 'ASSET_DELETE_BLOCKED:' })
    assert.equal(msg, 'Only an administrator can permanently delete an asset.')
  })

  test('the permanent-delete guards reach the reader as their own sentences', () => {
    // permanently_delete_asset (20260803000000). A non-admin must be told that
    // the action is reserved, not that "something went wrong".
    assert.equal(
      assetErrorMessage('delete', {
        code: '42501',
        message: 'ASSET_DELETE_DENIED: Only an administrator can permanently delete an asset',
      }),
      'Only an administrator can permanently delete an asset.',
    )
    assert.equal(
      assetErrorMessage('delete', {
        code: '42501',
        message: 'ASSET_DELETE_MISSING: This asset no longer exists',
      }),
      'This asset no longer exists.',
    )
  })

  test('a pending migration is reported as unavailable, never as "no permission"', () => {
    // Telling someone they lack permission when the function is simply not
    // deployed sends them to an admin who cannot help.
    const msg = assetErrorMessage('accept', { code: 'PGRST202', message: 'Could not find the function' })
    assert.match(msg, /not available yet/i)
  })

  test('an unexpected server error is not hidden behind a permission sentence', () => {
    const msg = assetErrorMessage('create', { code: 'XX000', message: 'internal error' })
    assert.equal(msg, 'Something went wrong. Please try again.')
    assert.doesNotMatch(msg, /permission/i)
  })

  test('a network failure tells the reader to check their connection', () => {
    assert.match(assetErrorMessage('create', { message: 'Failed to fetch' }), /connection/i)
  })
})

describe('change-request messages', () => {
  test('the create refusal names adding, and edit names editing directly', () => {
    assert.equal(assetErrorMessage('create', RLS_INSERT_REFUSAL), 'You do not have permission to add assets.')
    assert.equal(assetErrorMessage('edit', RLS_INSERT_REFUSAL), 'You do not have permission to edit assets directly.')
  })

  test('a non-admin approving is told an administrator must do it', () => {
    const msg = assetErrorMessage('approve-request', {
      code: '42501',
      message: 'ASSET_REQUEST_FORBIDDEN: Only an administrator can approve this request',
    })
    assert.equal(msg, 'Only an administrator can approve this request.')
  })

  test('a second review reports that the request was already reviewed', () => {
    const msg = assetErrorMessage('approve-request', {
      code: '42501',
      message: 'ASSET_REQUEST_REVIEWED: This request has already been reviewed',
    })
    assert.equal(msg, 'This request has already been reviewed.')
  })

  test('a blocked removal approval explains the custody history', () => {
    const msg = assetErrorMessage('approve-request', {
      code: '42501',
      message: 'ASSET_DELETE_BLOCKED: "Dell XPS 15" has assignment history and cannot be removed',
    })
    assert.match(msg, /assignment history/)
    assert.doesNotMatch(msg, /ASSET_DELETE_BLOCKED/)
  })

  test('a duplicate pending request is reported as a duplicate, not a bad value', () => {
    const dup = { code: '23505', message: 'duplicate key value violates unique constraint "asset_change_requests_one_pending_per_asset_idx"' }
    assert.equal(assetErrorMessage('request-edit', dup), 'You already have a pending edit request for this asset.')
    assert.equal(assetErrorMessage('request-remove', dup), 'You already have a pending removal request for this asset.')
    assert.doesNotMatch(assetErrorMessage('request-edit', dup), /not valid|constraint|idx/i)
  })

  test('a unique violation on a non-request action keeps the validation sentence', () => {
    const dup = { code: '23505', message: 'duplicate key value' }
    assert.match(assetErrorMessage('create', dup), /not valid/i)
  })

  test('each custody refusal names the operation actually attempted', () => {
    // The database raises one sentence per operation (20260725000000), so an
    // Assign click can never report a generic "manage asset assignments".
    const cases: [Parameters<typeof assetErrorMessage>[0], string, string][] = [
      ['assign',    'You do not have permission to assign assets',          'You do not have permission to assign assets.'],
      ['return',    'You do not have permission to return assets',          'You do not have permission to return assets.'],
      ['mark-lost', 'You do not have permission to mark assets as lost',    'You do not have permission to mark assets as lost.'],
    ]
    for (const [action, guard, expected] of cases) {
      const msg = assetErrorMessage(action, { code: '42501', message: `ASSET_CUSTODY_DENIED: ${guard}` })
      assert.equal(msg, expected)
      assert.doesNotMatch(msg, /ASSET_CUSTODY_DENIED|42501/)
      assert.doesNotMatch(msg, /manage asset assignments/)
    }
  })

  test('the fallback sentences are action-specific too, without a guard prefix', () => {
    // A bare RLS refusal with no guard message must still name the operation.
    const rls = { code: '42501', message: 'permission denied' }
    assert.equal(assetErrorMessage('assign', rls),    'You do not have permission to assign assets.')
    assert.equal(assetErrorMessage('return', rls),    'You do not have permission to return assets.')
    assert.equal(assetErrorMessage('mark-lost', rls), 'You do not have permission to mark assets as lost.')
    assert.equal(assetErrorMessage('edit', rls),      'You do not have permission to edit assets directly.')
  })

  test('a custody state error explains the state rather than blaming permissions', () => {
    const msg = assetErrorMessage('return', {
      code: '42501',
      message: 'ASSET_CUSTODY_INVALID: "Benq TR100" is not currently assigned to anyone',
    })
    assert.equal(msg, '"Benq TR100" is not currently assigned to anyone.')
    assert.doesNotMatch(msg, /permission/i)
  })

  test('an orphaned request reports the missing asset rather than a permission problem', () => {
    const msg = assetErrorMessage('approve-request', {
      code: '42501',
      message: 'ASSET_REQUEST_ORPHANED: The asset this request refers to no longer exists',
    })
    assert.equal(msg, 'The asset this request refers to no longer exists.')
  })
})
