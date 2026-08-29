/**
 * The verdict that travels from the route to the card.
 *
 * Small, but it is the thing standing between "we could not check this" and an
 * employee assuming it was checked. Both ends import the same module so they
 * cannot drift apart.
 *
 * Run:
 *   npx tsx --test src/lib/imageEditor/verification.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  VERIFICATION_HEADER, MANUAL_REVIEW_NOTE, parseVerification, needsManualReview,
} from './verification'

describe('the wire format', () => {
  test('the header is the agreed name', () => {
    assert.equal(VERIFICATION_HEADER, 'X-BOE-Image-Verification')
  })

  test('both statuses round-trip', () => {
    assert.equal(parseVerification('manual_review_required'), 'manual_review_required')
    assert.equal(parseVerification('passed'), 'passed')
  })

  test('anything else is undefined, never a guess', () => {
    // A header that is missing, empty, misspelled or invented must not become
    // "passed" by accident — that is the one failure mode worth ruling out.
    for (const v of [null, undefined, '', 'PASSED', 'ok', 'true', 'failed', 'manual_review', 'x']) {
      assert.equal(parseVerification(v), undefined, `"${v}" was accepted`)
    }
  })

  test('an unknown status does not read as verified OR as needing review', () => {
    assert.equal(needsManualReview(parseVerification('nonsense')), false)
    assert.equal(needsManualReview(undefined), false)
    assert.equal(needsManualReview('manual_review_required'), true)
    assert.equal(needsManualReview('passed'), false)
  })
})

describe('the note', () => {
  test('it is the agreed sentence, exactly', () => {
    assert.equal(MANUAL_REVIEW_NOTE, 'Please inspect fine product details before catalogue use.')
  })

  test('it does not claim the image is wrong, or verified', () => {
    // It is a note that nobody has looked yet, not a warning that something is
    // broken and not a claim that something was checked.
    for (const word of ['verified', 'failed', 'error', 'invalid', 'corrupt', 'approved']) {
      assert.ok(!MANUAL_REVIEW_NOTE.toLowerCase().includes(word), word)
    }
  })
})

describe('it is client-safe', () => {
  const SOURCE = readFileSync(join(process.cwd(), 'src/lib/imageEditor/verification.ts'), 'utf8')

  test('it imports nothing at all', () => {
    // Both the route and a client component import this. A sharp or fs import
    // here would break the browser build.
    assert.ok(!/^import\s/m.test(SOURCE), 'this module must stay dependency-free')
  })

  test('it names no provider, key or endpoint', () => {
    for (const banned of ['fal', 'bria', 'seedvr', 'FAL_KEY', 'http']) {
      assert.ok(!SOURCE.toLowerCase().includes(banned.toLowerCase()), banned)
    }
  })
})

describe('the card', () => {
  const CARD = readFileSync(join(process.cwd(), 'src/app/image-editor/ResultCard.tsx'), 'utf8')

  test('the note is shown only when a review is actually needed', () => {
    assert.ok(CARD.includes('needsManualReview(item.verification)'))
    assert.ok(CARD.includes('MANUAL_REVIEW_NOTE'))
    // Never a literal copy that could drift from the agreed sentence.
    assert.ok(!CARD.includes('Please inspect fine product'), 'the note must come from the constant')
  })

  test('downloading is NOT blocked by an unverified result', () => {
    // The correction turns on this: an unverified image is not a bad one, and
    // an employee must still be able to take it.
    const download = CARD.slice(CARD.indexOf('onClick={() => onDownload(item)}') - 300,
      CARD.indexOf('onClick={() => onDownload(item)}') + 100)
    assert.ok(!download.includes('verification'), 'Download must not depend on the verdict')
    assert.ok(!download.includes('needsManualReview'))
  })

  test('the card never calls a result verified', () => {
    assert.ok(!/\bverified\b/i.test(CARD), 'nothing on the card may claim verification')
  })
})
