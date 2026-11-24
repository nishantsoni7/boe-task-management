// Reading the product photos: the four faults of the first live run (24 Nov 2026, stopped at 50 of 373) stay fixed.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { batchOutcome, PACE_MS, photoRateLimiter, sniffMedia } from './photoRun'

describe('the route\'s limit counts only the photos it lets through', () => {
  test('30 a minute; a refused call adds nothing, so a minute after the last allowed call it opens again', () => {
    const limited = photoRateLimiter()
    const t0 = 1_000_000
    for (let i = 0; i < 6; i++) assert.equal(limited('u', 5, t0), false) // 30 photos
    assert.equal(limited('u', 5, t0 + 1_000), true)
    assert.equal(limited('u', 5, t0 + 30_000), true)                  // refused again: before the fix this pushed the wait further
    assert.equal(limited('u', 5, t0 + 60_001), false)                 // a minute after the 30, open
    assert.equal(limited('someone else', 5, t0 + 1_000), false)        // per person
  })
  test('the card never asks faster than the limit', () => {
    assert.equal(PACE_MS, 10_000) // five every 10 s = 30 a minute
  })
})

describe('the image type comes from the file\'s own bytes', () => {
  test('JPEG, PNG and WebP are known; anything else is not; a .png holding a JPEG is a JPEG', () => {
    assert.equal(sniffMedia(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'image/jpeg')
    assert.equal(sniffMedia(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png')
    assert.equal(sniffMedia(new Uint8Array([...'RIFF'].map(c => c.charCodeAt(0)).concat([1, 2, 3, 4], [...'WEBP'].map(c => c.charCodeAt(0))))), 'image/webp')
    assert.equal(sniffMedia(new Uint8Array([0x47, 0x49, 0x46, 0x38])), null) // GIF
    assert.equal(sniffMedia(new Uint8Array([])), null)
  })
})

describe('a failure every photo shares stops the run instead of skipping photo by photo', () => {
  const fail = (key: string, error: string) => ({ key, ok: false, error })
  test('all five fail the same way: stop with that reason (they are skipped, so the next run tries the next five)', () => {
    const why = 'The reading service answered 400 invalid_request_error: Your credit balance is too low.'
    const out = batchOutcome(['a', 'b', 'c', 'd', 'e'].map(k => fail(k, why)))
    assert.equal(out.stop, why); assert.deepEqual(out.skip, ['a', 'b', 'c', 'd', 'e']); assert.equal(out.reason, why)
  })
  test('one bad photo among good ones, or different reasons: skip and go on', () => {
    assert.equal(batchOutcome([fail('a', 'The photo could not be opened.'), { key: 'b', ok: true }]).stop, null)
    assert.deepEqual(batchOutcome([fail('a', 'The photo could not be opened.'), { key: 'b', ok: true }]).skip, ['a'])
    assert.equal(batchOutcome([fail('a', 'x'), fail('b', 'y')]).stop, null)
    assert.equal(batchOutcome([]).stop, null)
  })
})

describe('the route and the card', () => {
  test('the route keeps the service\'s own message and reads the type from the bytes', () => {
    const route = readFileSync('src/app/api/pricing/photo-facts/read/route.ts', 'utf8')
    assert.match(route, /const rateLimited = photoRateLimiter\(\)/)
    assert.match(route, /detail\?\.error\?\.message/)
    assert.match(route, /const media = sniffMedia\(bytes\)/)
    assert.doesNotMatch(route, /^export (const|function) (?!POST|runtime|maxDuration)/m) // a route file exports route names only
  })
  test('the card paces itself, waits out "too many", stops on a shared failure, says why, and names the stall', () => {
    const card = readFileSync('src/components/pricing/learning/PhotoFactsCard.tsx', 'utf8')
    assert.match(card, /await pause\(PACE_MS - \(Date\.now\(\) - started\)\)/)
    assert.match(card, /\.status !== 429 \|\| \+\+busyTries > BUSY_TRIES\) throw e/)
    assert.match(card, /if \(out\.stop\) \{ setError\(`Stopped: every photo of the last five failed the same way\. \$\{out\.stop\}`\); break \}/)
    assert.match(card, /Reload the page to try them again/)
    assert.doesNotMatch(card, /too large, or not a picture/)
    assert.match(readFileSync('src/lib/pricing/photoFactsApi.ts', 'utf8'), /throw Object\.assign\(new Error\(json\.error\), \{ status: res\.status \}\)/)
  })
})
