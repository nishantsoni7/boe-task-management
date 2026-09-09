/**
 * Typed product codes.
 *
 * These have to normalise the same way the by-code route does, because the scan
 * screen navigates with the normalised value and the route matches on its own
 * normalised value. A disagreement shows up as a code that works when scanned
 * and 404s when typed.
 *
 * Run:
 *   npx tsx --test src/lib/showroom/productCode.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeProductCode } from './productCode'

describe('normalizeProductCode', () => {
  test('a correctly typed code is unchanged', () => {
    assert.equal(normalizeProductCode('BOE-SR-105'), 'BOE-SR-105')
  })

  test('matches the route: uppercase and trim', () => {
    // The route does `decodeURIComponent(code).toUpperCase().trim()`.
    assert.equal(normalizeProductCode('boe-sr-105'), 'BOE-SR-105')
    assert.equal(normalizeProductCode('  BOE-CH-002  '), 'BOE-CH-002')
    assert.equal(normalizeProductCode('Boe-Sr-105\n'), 'BOE-SR-105')
  })

  test('a stray space inside a pasted code is removed', () => {
    assert.equal(normalizeProductCode('BOE-SR- 105'), 'BOE-SR-105')
    assert.equal(normalizeProductCode('BOE -SR-105'), 'BOE-SR-105')
  })

  test('separators are never invented', () => {
    // Guessing hyphens would silently look up a different product.
    assert.equal(normalizeProductCode('BOE SR 105'), 'BOESR105')
  })

  test('nothing usable is the empty string, which the caller rejects', () => {
    assert.equal(normalizeProductCode(''), '')
    assert.equal(normalizeProductCode('   '), '')
    assert.equal(normalizeProductCode(null), '')
    assert.equal(normalizeProductCode(undefined), '')
  })
})
