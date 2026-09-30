/**
 * Older reviews vs their historical screenshots: what the image matcher DOES and DOES NOT
 * find, on real pictures. Documents the limits as assertions.
 *
 *   found:     the same file (identical SHA-256); a re-encoded / resized / blurred copy;
 *   kept apart: different reviews rendered in one template;
 *   MISSED (false negatives, by design of a 65 x 64 difference hash): a crop, a rotation,
 *              an inverted (dark-mode) copy;
 *   a nearly blank page pair is not compared at all (below the marked-bit minimum).
 *
 * Also the pairing engine behind `scripts/backfill-review-image-hashes.ts --verify`.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/historicalMatching.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { DUPLICATE_THRESHOLDS, imageDistance } from './duplicateDetection'
import { differenceHash } from './imageHash'
import { findHistoricalPairs, pairIsSimilar, type HistoricalReview } from './historicalPairs'

function screenshot(name: string, stars: number, lines: string[]) {
  const text = lines.map((l, i) => `<text x="40" y="${220 + i * 46}" font-size="30" font-family="Arial" fill="#222">${l}</text>`).join('')
  const starRow = Array.from({ length: 5 }, (_, i) => `<circle cx="${60 + i * 44}" cy="150" r="16" fill="${i < stars ? '#f5a623' : '#ddd'}"/>`).join('')
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="900"><rect width="100%" height="100%" fill="#fff"/>`
    + `<circle cx="70" cy="70" r="30" fill="#4a90e2"/><text x="120" y="80" font-size="32" font-family="Arial" fill="#111">${name}</text>${starRow}${text}</svg>`)
}
const png = (svg: Buffer) => sharp(svg).png().toBuffer()
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

const ORIGINAL = ['Excellent quality furniture and', 'very helpful staff at the BOE', 'showroom. Delivery was on time', 'and installation was neat.']

describe('historical screenshot matching', () => {
  test('same file, re-encoded copies and different reviews in one template', async () => {
    const original = await png(screenshot('Rahul Verma', 5, ORIGINAL))
    const base = await differenceHash(original)

    // identical file: identical hash and identical SHA-256
    assert.equal(await differenceHash(Buffer.from(original)), base)
    assert.equal(sha(original), sha(Buffer.from(original)))

    const copies: Record<string, Buffer> = {
      jpeg25: await sharp(original).jpeg({ quality: 25 }).toBuffer(),
      jpeg50: await sharp(original).jpeg({ quality: 50 }).toBuffer(),
      resize400: await sharp(original).resize(400).jpeg({ quality: 70 }).toBuffer(),
      resize1440: await sharp(original).resize(1440).png().toBuffer(),
      blur: await sharp(original).blur(1.2).jpeg({ quality: 80 }).toBuffer(),
    }
    for (const [label, buf] of Object.entries(copies)) {
      assert.notEqual(sha(buf), sha(original), `${label} is a different file, so only the perceptual hash can pair it`)
      assert.ok(pairIsSimilar(base, await differenceHash(buf)), `${label} must be found`)
    }

    const others: Record<string, Buffer> = {
      otherReviewer: await png(screenshot('Neha Kapoor', 5, ['Lovely designs, the team guided', 'us through every option and the', 'final finish looks premium.', 'Highly recommended to all.'])),
      sameNameOtherText: await png(screenshot('Rahul Verma', 4, ['Good service overall but the', 'delivery took a little longer', 'than promised. Product is fine.', 'Would buy again.'])),
      shorterReview: await png(screenshot('Amit Shah', 5, ['Great experience.'])),
    }
    for (const [label, buf] of Object.entries(others)) {
      assert.ok(!pairIsSimilar(base, await differenceHash(buf)), `${label} must NOT be paired`)
    }
  })

  test('KNOWN FALSE NEGATIVES: a crop, a rotation and an inverted copy are not found', async () => {
    const original = await png(screenshot('Rahul Verma', 5, ORIGINAL))
    const base = await differenceHash(original)
    const missed: Record<string, Buffer> = {
      crop: await sharp(original).extract({ left: 0, top: 120, width: 720, height: 600 }).png().toBuffer(),
      rotate: await sharp(original).rotate(6, { background: '#fff' }).png().toBuffer(),
      inverted: await sharp(original).negate({ alpha: false }).png().toBuffer(),
    }
    for (const [label, buf] of Object.entries(missed)) {
      const d = imageDistance(base, await differenceHash(buf))
      assert.ok(d === null || d.ratio > DUPLICATE_THRESHOLDS.IMAGE_SIMILAR_MAX_RATIO, `${label} is a known miss — if this fails the matcher improved: update docs §24`)
    }
  })

  test('two nearly blank pages are not compared', async () => {
    const blank = (name: string) => png(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="720" height="900"><rect width="100%" height="100%" fill="#fff"/><text x="40" y="80" font-size="20" font-family="Arial">${name}</text></svg>`))
    const a = await differenceHash(await blank('A'))
    const b = await differenceHash(await blank('B'))
    assert.equal(pairIsSimilar(a, b), false)
  })
})

describe('findHistoricalPairs (the --verify engine)', () => {
  const rev = (ref: string, by: string, over: Partial<HistoricalReview> = {}): HistoricalReview =>
    ({ id: ref, ref, submittedBy: by, sha256: ref.padEnd(64, '0'), phash: null, deleted: false, ...over })

  test('pairs identical files by SHA-256 and re-encodes by perceptual hash; lists references only; strongest first', async () => {
    const original = await png(screenshot('Rahul Verma', 5, ORIGINAL))
    const jpeg = await sharp(original).jpeg({ quality: 40 }).toBuffer()
    const other = await png(screenshot('Neha Kapoor', 5, ['Lovely designs, the team guided', 'us through every option and the', 'final finish looks premium.', 'Highly recommended to all.']))
    const hO = await differenceHash(original), hJ = await differenceHash(jpeg), hX = await differenceHash(other)
    const pairs = findHistoricalPairs([
      rev('R1', 'emp-a', { sha256: sha(original), phash: hO }),
      rev('R2', 'emp-b', { sha256: sha(original), phash: hO }),          // same file, another employee
      rev('R3', 'emp-a', { sha256: sha(jpeg), phash: hJ }),              // re-encoded copy
      rev('R4', 'emp-c', { sha256: sha(other), phash: hX }),             // different review
      rev('R5', 'emp-d', { sha256: 'z'.repeat(64), phash: null }),       // no hash yet: SHA only
    ])
    const keys = pairs.map(p => `${p.a}-${p.b}:${p.kind}`)
    assert.ok(keys.includes('R1-R2:identical'))
    assert.ok(keys.includes('R1-R3:similar') && keys.includes('R2-R3:similar'))
    assert.ok(!keys.some(k => k.includes('R4') || k.includes('R5')), 'different and unhashed reviews are not paired')
    assert.equal(pairs[0].kind, 'identical')
    assert.equal(pairs.find(p => p.a === 'R1' && p.b === 'R2')?.sameEmployee, false)
    assert.equal(pairs.find(p => p.a === 'R1' && p.b === 'R3')?.sameEmployee, true)
    // nothing but references and numbers
    for (const p of pairs) assert.deepEqual(Object.keys(p).sort(), ['a', 'b', 'kind', 'ratio', 'sameEmployee', 'strength'])
  })

  test('an identical pair is reported once, not again as similar', () => {
    const h = 'a'.repeat(1024)
    const pairs = findHistoricalPairs([rev('A', 'x', { sha256: 's'.repeat(64), phash: h }), rev('B', 'y', { sha256: 's'.repeat(64), phash: h })])
    assert.equal(pairs.length, 1)
    assert.equal(pairs[0].kind, 'identical')
  })

  test('reviews without a hash can only be paired by identical file', () => {
    const pairs = findHistoricalPairs([rev('A', 'x', { sha256: 's'.repeat(64) }), rev('B', 'y', { sha256: 's'.repeat(64) }), rev('C', 'z')])
    assert.deepEqual(pairs.map(p => `${p.a}-${p.b}`), ['A-B'])
  })
})
