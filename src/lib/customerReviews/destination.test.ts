/**
 * The review destination — what the module will and will not point a customer at.
 *
 * Fictional links only.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/destination.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  REVIEW_URL_MAX_LENGTH,
  isSafeReviewDestination,
  parseReviewDestination,
  parseReviewEvidenceUrl,
} from './destination'

const ROOT = process.cwd()

describe('what is accepted', () => {
  test('a plain https link is accepted and canonicalised', () => {
    const result = parseReviewDestination('https://example.test/place/review')
    assert.ok(result.ok)
    assert.equal(result.ok && result.url, 'https://example.test/place/review')
  })

  test('surrounding whitespace is trimmed rather than refused', () => {
    const result = parseReviewDestination('  https://example.test/r?id=7  ')
    assert.equal(result.ok && result.url, 'https://example.test/r?id=7')
  })

  test('the same destination typed two ways is stored one way', () => {
    const a = parseReviewDestination('https://example.test')
    const b = parseReviewDestination('https://example.test/')
    assert.equal(a.ok && a.url, b.ok && b.url)
  })
})

describe('what is refused', () => {
  test('every non-https protocol', () => {
    for (const url of [
      'http://example.test/review',
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'ftp://example.test/review',
      'file:///etc/passwd',
      'whatsapp://send?text=hi',
    ]) {
      assert.equal(isSafeReviewDestination(url), false, url)
    }
  })

  test('http is refused rather than silently upgraded', () => {
    const result = parseReviewDestination('http://example.test/review')
    assert.equal(result.ok, false)
    assert.ok(result.ok === false && result.error.includes('https'))
  })

  test('a credentialled URL, which is how a link disguises where it goes', () => {
    assert.equal(isSafeReviewDestination('https://user:pass@evil.test/review'), false)
    assert.equal(isSafeReviewDestination('https://example.test@evil.test/review'), false)
  })

  test('anything that is not a complete address', () => {
    for (const url of ['', '   ', 'example.test/review', 'www.example.test', 'review', '//example.test']) {
      assert.equal(isSafeReviewDestination(url), false, JSON.stringify(url))
    }
  })

  test('a link longer than the column can hold', () => {
    const long = `https://example.test/${'a'.repeat(REVIEW_URL_MAX_LENGTH)}`
    assert.equal(isSafeReviewDestination(long), false)
  })

  test('null and undefined are refused, not treated as blank success', () => {
    assert.equal(isSafeReviewDestination(null), false)
    assert.equal(isSafeReviewDestination(undefined), false)
  })
})

describe('the evidence URL uses the same rule under its own name', () => {
  test('it accepts and refuses identically', () => {
    assert.ok(parseReviewEvidenceUrl('https://example.test/review/9').ok)
    assert.equal(parseReviewEvidenceUrl('http://example.test/review/9').ok, false)
    assert.equal(parseReviewEvidenceUrl('javascript:alert(1)').ok, false)
  })

  test('its blank message talks about the published review, not the destination', () => {
    const result = parseReviewEvidenceUrl('')
    assert.equal(result.ok, false)
    assert.ok(result.ok === false && result.error.includes('published review'))
  })
})

describe('no BOE review URL is invented anywhere in the module', () => {
  const files = (dir: string): string[] => {
    const out: string[] = []
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory()) out.push(...files(path))
      else if (/\.tsx?$/.test(entry.name)) out.push(path)
    }
    return out
  }

  test('no hardcoded Google, Maps or bestofexports review link ships as a default', () => {
    // The repository has no configured BOE review URL — that was checked before
    // this module was written — and inventing one would send real customers to
    // an address nobody verified. The employee supplies it per request.
    const sources = [
      ...files('src/lib/customerReviews'),
      ...files('src/components/customerReviews'),
      ...files('src/app/customer-reviews'),
    ]
    for (const file of sources) {
      const text = readFileSync(join(ROOT, file), 'utf8')
      for (const pattern of [/g\.page\//i, /maps\.app\.goo/i, /search\.google\.com\/local/i, /bestofexports\.com/i]) {
        assert.equal(pattern.test(text), false, `${file} hardcodes a review destination (${pattern})`)
      }
    }
  })

  test('the form tells the employee there is no standing link, rather than pretending', () => {
    const form = readFileSync(join(ROOT, 'src/components/customerReviews/RequestForm.tsx'), 'utf8')
    assert.ok(form.includes('no standing review link configured'))
  })
})
