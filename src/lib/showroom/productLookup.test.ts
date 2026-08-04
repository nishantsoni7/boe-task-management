/**
 * Global product lookup — request shape, limits and keyboard rules.
 *
 * The two things that must never regress: a blank box does not fetch (an empty
 * term would match the whole catalogue, which is the browse-everything screen
 * this feature is explicitly not), and a result cannot navigate anywhere except
 * a real Product Master URL.
 *
 * Run:
 *   npx tsx --test src/lib/showroom/productLookup.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  LOOKUP_DEBOUNCE_MS,
  LOOKUP_RESULT_LIMIT,
  lookupOrExpression,
  lookupRequestPath,
  lookupResultHref,
  moveLookupHighlight,
  normalizeLookupQuery,
  resolveLookupKey,
  shouldRunLookup,
} from './productLookup'
import { PRODUCT_LIST_PATH } from './productNav'

// ── Query construction ────────────────────────────────────────────────────────

describe('lookup query construction', () => {
  test('a term becomes lookup=1 on the existing products route', () => {
    const path = lookupRequestPath('BOE-1042')
    assert.ok(path)
    const url = new URL(path, 'http://x')
    assert.equal(url.pathname, '/api/showroom/admin/products')
    assert.equal(url.searchParams.get('lookup'), '1')
    assert.equal(url.searchParams.get('q'), 'BOE-1042')
  })

  test('the request carries the result cap, and it is small', () => {
    const url = new URL(lookupRequestPath('chair')!, 'http://x')
    assert.equal(url.searchParams.get('limit'), String(LOOKUP_RESULT_LIMIT))
    assert.ok(LOOKUP_RESULT_LIMIT <= 10, 'a lookup is a jump-to control, not a result set')
  })

  test('no catalogue-wide controls are ever sent', () => {
    const url = new URL(lookupRequestPath('chair')!, 'http://x')
    // Sending any of these would make this a second catalogue browse.
    for (const banned of ['status', 'sort', 'page', 'category', 'counts', 'meta']) {
      assert.equal(url.searchParams.get(banned), null, banned)
    }
  })

  test('the term is encoded, not concatenated', () => {
    const path = lookupRequestPath('oak & teak / 50%')!
    const url = new URL(path, 'http://x')
    // Round-trips intact, and the raw characters never leak into the query
    // string where `&` would start a new parameter.
    assert.equal(url.searchParams.get('q'), 'oak & teak / 50%')
    assert.ok(!url.search.includes(' '))
    assert.match(path, /q=oak\+%26\+teak\+%2F\+50%25/)
  })

  test('whitespace is normalised so one query is one cache entry', () => {
    assert.equal(normalizeLookupQuery('  BOE   1042 '), 'BOE 1042')
    assert.equal(normalizeLookupQuery(null), '')
    assert.equal(normalizeLookupQuery(undefined), '')
  })

  test('input is debounced before it becomes a request', () => {
    assert.ok(LOOKUP_DEBOUNCE_MS >= 150 && LOOKUP_DEBOUNCE_MS <= 400, 'a usable debounce window')
  })
})

// ── No request for a blank query ──────────────────────────────────────────────

describe('a blank query never fetches', () => {
  test('blank, whitespace and null produce no request at all', () => {
    for (const raw of ['', '   ', '\t', '\n  \n', null, undefined]) {
      assert.equal(shouldRunLookup(raw), false, JSON.stringify(raw))
      assert.equal(lookupRequestPath(raw), null, JSON.stringify(raw))
    }
  })

  test('a single character is enough to search — codes are short', () => {
    assert.equal(shouldRunLookup('7'), true)
    assert.ok(lookupRequestPath('7'))
  })
})

// ── Matching ──────────────────────────────────────────────────────────────────

describe('what the lookup matches', () => {
  test('product code and product name, both as contains', () => {
    const expr = lookupOrExpression('1042')
    assert.match(expr, /product_code\.ilike\."%1042%"/)
    assert.match(expr, /name\.ilike\."%1042%"/)
  })

  test('category is NOT matched — that would be a catalogue browse', () => {
    // One word would otherwise return every product in a category, which is the
    // All Products screen by another name.
    assert.ok(!lookupOrExpression('Benches').includes('category.ilike'))
  })

  test('the expression is a single PostgREST or() of exactly two clauses', () => {
    const parts = lookupOrExpression('x').split(',')
    assert.equal(parts.length, 2)
  })

  test('an already-escaped term is passed through untouched', () => {
    // Escaping belongs to the route (it owns escapeSearchTerm); this builder
    // must not double-escape what it is handed.
    assert.match(lookupOrExpression('50\\\\%'), /%50\\\\%%/)
  })
})

// ── Navigation from a result ──────────────────────────────────────────────────

describe('navigating from a result', () => {
  test('a result opens that product’s edit page', () => {
    assert.equal(lookupResultHref('BOE-1042'), '/showroom-admin/products/BOE-1042/edit')
  })

  test('the code is URL-encoded', () => {
    assert.equal(lookupResultHref('BOE/10 42'), '/showroom-admin/products/BOE%2F10%2042/edit')
  })

  test('no from= breadcrumb — there is no list view behind a lookup', () => {
    // Back on the product then falls through to the product's own category,
    // which is a real Product Master URL, rather than replaying a list the user
    // was never on.
    assert.ok(!lookupResultHref('BOE-1042').includes('from='))
  })

  test('every destination stays inside Product Master', () => {
    for (const code of ['BOE-1', 'x', '../../etc/passwd', 'https://evil.example']) {
      assert.ok(lookupResultHref(code).startsWith(`${PRODUCT_LIST_PATH}/`), code)
    }
  })
})

// ── Keyboard ──────────────────────────────────────────────────────────────────

describe('keyboard behaviour', () => {
  const base = { resultsOpen: true, count: 3, highlight: -1, hasQuery: true }

  test('Down enters the list, then walks it and wraps', () => {
    assert.deepEqual(resolveLookupKey({ ...base, key: 'ArrowDown' }), { action: 'move', index: 0 })
    assert.deepEqual(resolveLookupKey({ ...base, key: 'ArrowDown', highlight: 0 }), { action: 'move', index: 1 })
    assert.deepEqual(resolveLookupKey({ ...base, key: 'ArrowDown', highlight: 2 }), { action: 'move', index: 0 })
  })

  test('Up from nothing goes to the last row, and wraps back', () => {
    assert.deepEqual(resolveLookupKey({ ...base, key: 'ArrowUp' }), { action: 'move', index: 2 })
    assert.deepEqual(resolveLookupKey({ ...base, key: 'ArrowUp', highlight: 0 }), { action: 'move', index: 2 })
  })

  test('Enter opens the highlighted row', () => {
    assert.deepEqual(resolveLookupKey({ ...base, key: 'Enter', highlight: 1 }), { action: 'open', index: 1 })
  })

  test('Enter with nothing highlighted opens the first match', () => {
    // Typing a full code and pressing Enter is the fast path.
    assert.deepEqual(resolveLookupKey({ ...base, key: 'Enter' }), { action: 'open', index: 0 })
  })

  test('Escape closes the results first, and clears the box second', () => {
    assert.deepEqual(resolveLookupKey({ ...base, key: 'Escape' }), { action: 'close' })
    assert.deepEqual(
      resolveLookupKey({ ...base, key: 'Escape', resultsOpen: false }),
      { action: 'clear' },
    )
  })

  test('Escape on an empty closed box does nothing — it does not swallow the key', () => {
    assert.equal(
      resolveLookupKey({ ...base, key: 'Escape', resultsOpen: false, hasQuery: false }),
      null,
    )
  })

  test('Escape never navigates', () => {
    for (const resultsOpen of [true, false]) {
      const action = resolveLookupKey({ ...base, key: 'Escape', resultsOpen })
      assert.notEqual(action?.action, 'open')
    }
  })

  test('arrows and Enter do nothing with no results to act on', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter']) {
      assert.equal(resolveLookupKey({ ...base, key, count: 0 }), null, `${key} with no results`)
      assert.equal(resolveLookupKey({ ...base, key, resultsOpen: false }), null, `${key} while closed`)
    }
  })

  test('ordinary typing is left alone', () => {
    for (const key of ['a', 'B', '1', '-', 'Backspace', 'Tab', ' ']) {
      assert.equal(resolveLookupKey({ ...base, key }), null, key)
    }
  })

  test('the highlight helper never returns an out-of-range index', () => {
    for (let count = 0; count <= 4; count++) {
      for (let current = -1; current <= count; current++) {
        for (const delta of [1, -1]) {
          const next = moveLookupHighlight(current, count, delta)
          if (count === 0) assert.equal(next, -1)
          else assert.ok(next >= 0 && next < count, `${current}/${count}/${delta} -> ${next}`)
        }
      }
    }
  })
})
