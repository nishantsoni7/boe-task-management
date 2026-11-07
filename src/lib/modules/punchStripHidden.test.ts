/**
 * "Hide for today" on the punch-in strip: remembered per user, against the
 * server's date, and gone the next day.
 *
 * Run:
 *   npm run test:file -- src/lib/modules/punchStripHidden.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPunchStripHidden, punchStripHiddenKey } from './punchStripHidden'

test('hidden only for the day it was hidden on', () => {
  assert.equal(isPunchStripHidden('2026-11-03', '2026-11-03'), true)
})

test('the next day it is back: yesterday\'s choice hides nothing', () => {
  assert.equal(isPunchStripHidden('2026-11-03', '2026-11-04'), false)
})

test('nothing stored, or something malformed, hides nothing', () => {
  assert.equal(isPunchStripHidden(null, '2026-11-03'), false)
  assert.equal(isPunchStripHidden('', '2026-11-03'), false)
  assert.equal(isPunchStripHidden('true', '2026-11-03'), false)
})

test('one key per signed-in user, so a shared computer keeps each person\'s own choice', () => {
  assert.notEqual(punchStripHiddenKey('u1'), punchStripHiddenKey('u2'))
  assert.match(punchStripHiddenKey('u1'), /u1$/)
})
