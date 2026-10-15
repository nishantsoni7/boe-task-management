/**
 * Forgot password → the link in the email → /reset-password.
 *
 * The reset page decides what to do from the URL Supabase sends the user back
 * to. These tests pin each shape of that URL, and the password rule the page
 * shares with Account Settings.
 *
 * Run:
 *   npx tsx --test src/lib/auth/recoveryLink.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  readRecoveryLink,
  newPasswordProblem,
  isFreshRecoverySession,
  EXPIRED_LINK_MESSAGE,
} from './recoveryLink'

describe('readRecoveryLink', () => {
  test('a token_hash link is verified on any device', () => {
    assert.deepEqual(
      readRecoveryLink('?token_hash=abc123&type=recovery', ''),
      { kind: 'token_hash', tokenHash: 'abc123' },
    )
  })

  test('a token_hash for some other email type is not treated as a reset', () => {
    assert.deepEqual(readRecoveryLink('?token_hash=abc123&type=signup', ''), { kind: 'none' })
  })

  test('a PKCE code link is left to the browser client', () => {
    assert.deepEqual(readRecoveryLink('?code=xyz', ''), { kind: 'code' })
  })

  test('an expired link says so, from the query or the fragment', () => {
    const expected = { kind: 'error', message: EXPIRED_LINK_MESSAGE }
    assert.deepEqual(
      readRecoveryLink('?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid', ''),
      expected,
    )
    assert.deepEqual(
      readRecoveryLink('', '#error=access_denied&error_code=otp_expired'),
      expected,
    )
  })

  test('any other refusal shows what Supabase said', () => {
    assert.deepEqual(
      readRecoveryLink('?error=server_error&error_description=Something+broke', ''),
      { kind: 'error', message: 'Something broke' },
    )
  })

  test('an error wins over a code in the same URL', () => {
    assert.equal(readRecoveryLink('?code=xyz&error=access_denied', '').kind, 'error')
  })

  test('a bare visit has nothing to verify', () => {
    assert.deepEqual(readRecoveryLink('', ''), { kind: 'none' })
  })
})

describe('isFreshRecoverySession', () => {
  const NOW = 1_800_000_000
  const token = (payload: unknown) =>
    ['header', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.')

  test('a PKCE reset link session ("recovery") is accepted', () => {
    assert.equal(isFreshRecoverySession(token({ amr: [{ method: 'recovery', timestamp: NOW - 60 }] }), NOW), true)
  })

  test('a token_hash reset link session ("otp") is accepted', () => {
    assert.equal(isFreshRecoverySession(token({ amr: [{ method: 'otp', timestamp: NOW - 60 }] }), NOW), true)
  })

  test('someone already signed in with a password is NOT accepted', () => {
    assert.equal(isFreshRecoverySession(token({ amr: [{ method: 'password', timestamp: NOW - 60 }] }), NOW), false)
  })

  test('a reset session older than an hour is not accepted', () => {
    assert.equal(isFreshRecoverySession(token({ amr: [{ method: 'recovery', timestamp: NOW - 3601 }] }), NOW), false)
  })

  test('a malformed token is not accepted', () => {
    assert.equal(isFreshRecoverySession('not-a-jwt', NOW), false)
    assert.equal(isFreshRecoverySession(token({}), NOW), false)
  })
})

describe('newPasswordProblem', () => {
  test('requires a password of at least 8 characters that matches the confirmation', () => {
    assert.equal(newPasswordProblem('', ''), 'New password is required.')
    assert.equal(newPasswordProblem('short', 'short'), 'Password must be at least 8 characters.')
    assert.equal(newPasswordProblem('longenough', 'different1'), 'Passwords do not match.')
    assert.equal(newPasswordProblem('longenough', 'longenough'), null)
  })
})
