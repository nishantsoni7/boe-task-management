/**
 * Possible-duplicate detection: the matching rules, on real inputs.
 *
 *   exact and near text, whitespace / case / punctuation folded;
 *   short generic text and a common name alone are NOT confident matches;
 *   identical images by content hash, visually similar images by a difference hash
 *   computed from real (synthetic) screenshots — re-encoded, resized, blurred —
 *   and different reviews of the same layout kept apart;
 *   what an employee may be told, and nothing more.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/duplicateDetection.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import {
  DUPLICATE_REASON_LABELS,
  DUPLICATE_THRESHOLDS,
  IMAGE_HASH_BITS,
  compareWithCandidate,
  describeEvidence,
  detectDuplicates,
  employeeView,
  hammingHex,
  imageDistance,
  needsDecision,
  normalizeName,
  normalizeText,
  textSimilarity,
  type DuplicateCandidate,
  type DuplicateSubject,
} from './duplicateDetection'
import { differenceHash } from './imageHash'
import { contentFingerprint, duplicateToken, normalizedFields, runDuplicateCheck } from './duplicateCheck.server'

// 1024 hex characters (4096 bits), half of them marked: `a` = 1010.
const HASH_A = 'a'.repeat(1024)

const subject = (over: Partial<DuplicateSubject> = {}): DuplicateSubject => ({
  nameNorm: null, textNorm: null, sha256: 'new'.repeat(21) + 'n', phash: null, ...over,
})
const candidate = (over: Partial<DuplicateCandidate> = {}): DuplicateCandidate => ({
  id: 'c1', submittedBy: 'other', nameNorm: null, textNorm: null, sha256: 'old'.repeat(21) + 'o', phash: null, deleted: false, ...over,
})
const T = (s: string) => normalizeText(s)

const LONG = 'Excellent quality furniture and very helpful staff at the BOE showroom. Delivery was on time and the installation was neat.'

describe('normalization', () => {
  test('case, spacing and punctuation are folded', () => {
    assert.equal(normalizeText('  Great   SERVICE!!  Thank-you… 😊 '), 'great service thank you')
    assert.equal(normalizeText('Great service, thank you'), normalizeText('great  service thank you.'))
    assert.equal(normalizeText(null), '')
  })
  test('a name is compared whole, in any word order', () => {
    assert.equal(normalizeName('Amit Sharma'), normalizeName('  sharma,  AMIT '))
    assert.notEqual(normalizeName('Amit Sharma'), normalizeName('Amit Sharmaa'))
  })
  test('Devanagari text keeps its vowel signs', () => {
    assert.equal(normalizeText('बहुत अच्छा फर्नीचर'), 'बहुत अच्छा फर्नीचर')
  })
})

describe('review text', () => {
  test('identical text (case / punctuation aside) is an exact match', () => {
    const m = compareWithCandidate(subject({ textNorm: T(LONG) }), candidate({ textNorm: T(LONG.toUpperCase() + '!!') }))
    assert.deepEqual(m?.reasons, ['review_text'])
    assert.equal(m?.evidence.text_kind, 'exact')
    assert.equal(m?.strength, 'strong', 'an exact match of 60+ characters is strong')
  })

  test('a light rewrite is a near match', () => {
    const rewritten = 'Excellent quality furniture and very helpful staff at the BOE showroom. Delivery was on time and installation was neat!'
    const m = compareWithCandidate(subject({ textNorm: T(LONG) }), candidate({ textNorm: T(rewritten) }))
    assert.deepEqual(m?.reasons, ['review_text'])
    assert.equal(m?.evidence.text_kind, 'similar')
    assert.ok((m?.evidence.text_similarity ?? 0) >= DUPLICATE_THRESHOLDS.TEXT_NEAR_MIN)
  })

  test('a typo-level change is still similar; a different review is not', () => {
    const typo = LONG.replace('Excellent', 'Excelent').replace('helpful', 'helpfull')
    assert.ok(textSimilarity(T(LONG), T(typo)) > 0.9)
    const other = 'The wardrobe finish looks premium and the carpenters cleaned up after the fitting was done.'
    assert.ok(textSimilarity(T(LONG), T(other)) < DUPLICATE_THRESHOLDS.TEXT_NEAR_MIN)
    assert.equal(compareWithCandidate(subject({ textNorm: T(LONG) }), candidate({ textNorm: T(other) })), null)
  })

  test('SHORT GENERIC TEXT IS NOT EVIDENCE — identical or not', () => {
    for (const generic of ['Great service, thank you', 'Nice', 'Good quality furniture', 'Highly recommended!']) {
      assert.equal(compareWithCandidate(subject({ textNorm: T(generic) }), candidate({ textNorm: T(generic) })), null, generic)
    }
  })

  test('an exact match just over the minimum is moderate, not strong', () => {
    const mid = 'Very good service and timely delivery of all our items'
    assert.ok(T(mid).length >= DUPLICATE_THRESHOLDS.TEXT_MIN_CHARS && T(mid).length < DUPLICATE_THRESHOLDS.TEXT_EXACT_STRONG_CHARS)
    const m = compareWithCandidate(subject({ textNorm: T(mid) }), candidate({ textNorm: T(mid) }))
    assert.equal(m?.strength, 'moderate')
  })
})

describe('reviewer name', () => {
  test('a shared name ALONE is weak and never queued for a decision', () => {
    const m = compareWithCandidate(subject({ nameNorm: normalizeName('Rahul Sharma') }), candidate({ nameNorm: normalizeName('sharma rahul') }))
    assert.deepEqual(m?.reasons, ['reviewer_name'])
    assert.equal(m?.strength, 'weak')
    assert.equal(needsDecision(m!.strength), false)
  })
  test('a name shorter than the minimum is not compared', () => {
    assert.equal(compareWithCandidate(subject({ nameNorm: 'raj' }), candidate({ nameNorm: 'raj' })), null)
  })
  test('a name never turns different content into a match', () => {
    const m = compareWithCandidate(
      subject({ nameNorm: normalizeName('Rahul Sharma'), textNorm: T(LONG) }),
      candidate({ nameNorm: normalizeName('Rahul Sharma'), textNorm: T('Completely different words about a wardrobe delivery that arrived late in March.') }),
    )
    assert.deepEqual(m?.reasons, ['reviewer_name'])
    assert.equal(m?.strength, 'weak')
  })
  test('a name added to a moderate signal makes it strong', () => {
    const mid = 'Very good service and timely delivery of all our items'
    const m = compareWithCandidate(
      subject({ nameNorm: normalizeName('Rahul Sharma'), textNorm: T(mid) }),
      candidate({ nameNorm: normalizeName('Rahul Sharma'), textNorm: T(mid) }),
    )
    assert.deepEqual([...(m?.reasons ?? [])].sort(), ['review_text', 'reviewer_name'])
    assert.equal(m?.strength, 'strong')
  })
})

describe('images, by hash', () => {
  test('identical bytes are a strong match', () => {
    const m = compareWithCandidate(subject({ sha256: 'x'.repeat(64) }), candidate({ sha256: 'x'.repeat(64) }))
    assert.equal(m?.evidence.image_kind, 'identical')
    assert.equal(m?.strength, 'strong')
  })
  test('hamming distance, and a missing hash cannot be compared', () => {
    assert.equal(hammingHex('00', 'ff'), 8)
    assert.equal(hammingHex(HASH_A, HASH_A), 0)
    assert.equal(hammingHex(null, HASH_A), null)
    assert.equal(hammingHex('abc', 'abcd'), null)
    assert.equal(hammingHex('zz', 'zz'), null)
  })
  test('similarity is differing bits as a share of the MARKED bits; thresholds and the blank-page rule', () => {
    // Flip `bits` bits of a hash that has 2048 marked bits (the union stays ~2048 + flips).
    const flip = (bits: number) => {
      const chars = HASH_A.split('')
      let remaining = bits
      for (let i = 0; i < chars.length && remaining > 0; i++) {
        // 'a' = 1010: turning the 1s off flips 2 bits, so use XOR 0b0101 (flips the 0s on) for a stable union
        const n = Math.min(remaining, 4)
        chars[i] = (parseInt(chars[i], 16) ^ ((1 << n) - 1)).toString(16)
        remaining -= n
      }
      return chars.join('')
    }
    const T = DUPLICATE_THRESHOLDS
    const at = (bits: number) => compareWithCandidate(subject({ phash: HASH_A }), candidate({ phash: flip(bits) }))
    const d = imageDistance(HASH_A, flip(200))!
    assert.equal(d.distance, 200)
    assert.ok(d.marked >= 2048 && d.ratio === d.distance / d.marked)
    // just inside 12% strong, just outside; just inside 30% similar, just outside
    assert.equal(at(Math.floor(T.IMAGE_STRONG_MAX_RATIO * 2100))?.strength, 'strong')
    assert.equal(at(Math.floor(T.IMAGE_STRONG_MAX_RATIO * 2200) + 60)?.strength, 'moderate')
    assert.equal(at(Math.floor(T.IMAGE_SIMILAR_MAX_RATIO * 2300))?.strength, 'moderate')
    assert.equal(at(Math.ceil(T.IMAGE_SIMILAR_MAX_RATIO * 2600)), null)
    assert.equal(at(IMAGE_HASH_BITS / 4), null)
    // two nearly blank pages have nothing to be similar about, even at distance 0-ish
    const blank = '0'.repeat(1023) + '1'
    const blank2 = '0'.repeat(1022) + '11'
    assert.equal(imageDistance(blank, blank2), null)
    assert.equal(compareWithCandidate(subject({ phash: blank }), candidate({ phash: blank2 })), null)
  })
  test('a filename or URL is never compared: the candidate type has neither', () => {
    const keys = Object.keys(candidate())
    assert.ok(!keys.some(k => /name|url|path/i.test(k) && k !== 'nameNorm'))
  })
})

describe('images, by perceptual hash of REAL pictures', () => {
  function screenshot(name: string, stars: number, lines: string[]) {
    const text = lines.map((l, i) => `<text x="40" y="${220 + i * 46}" font-size="30" font-family="Arial" fill="#222">${l}</text>`).join('')
    const starRow = Array.from({ length: 5 }, (_, i) => `<circle cx="${60 + i * 44}" cy="150" r="16" fill="${i < stars ? '#f5a623' : '#ddd'}"/>`).join('')
    return Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="900"><rect width="100%" height="100%" fill="#fff"/>`
      + `<circle cx="70" cy="70" r="30" fill="#4a90e2"/><text x="120" y="80" font-size="32" font-family="Arial" fill="#111">${name}</text>${starRow}${text}</svg>`)
  }
  const png = (svg: Buffer) => sharp(svg).png().toBuffer()

  test('re-encoding, resizing and blurring one screenshot stay similar; different reviews stay apart', async () => {
    const original = await png(screenshot('Rahul Verma', 5, ['Excellent quality furniture and', 'very helpful staff at the BOE', 'showroom. Delivery was on time', 'and installation was neat.']))
    const variants = {
      jpeg400: await sharp(original).resize(400).jpeg({ quality: 55 }).toBuffer(),
      jpeg25: await sharp(original).jpeg({ quality: 25 }).toBuffer(),
      webp40: await sharp(original).webp({ quality: 40 }).toBuffer(),
      zoom1440: await sharp(original).resize(1440).png().toBuffer(),
      blurred: await sharp(original).blur(1.2).jpeg({ quality: 80 }).toBuffer(),
    }
    const others = {
      otherReviewer: await png(screenshot('Neha Kapoor', 5, ['Lovely designs, the team guided', 'us through every option and the', 'final finish looks premium.', 'Highly recommended to all.'])),
      sameNameDifferentText: await png(screenshot('Rahul Verma', 4, ['Good service overall but the', 'delivery took a little longer', 'than promised. Product is fine.', 'Would buy again.'])),
    }
    const base = await differenceHash(original)
    assert.equal(base.length, 1024)
    for (const [label, buf] of Object.entries(variants)) {
      const d = imageDistance(base, await differenceHash(buf))!
      assert.ok(d.ratio <= DUPLICATE_THRESHOLDS.IMAGE_SIMILAR_MAX_RATIO, `${label}: ${(d.ratio * 100).toFixed(0)}% of the marked bits differ`)
      const m = compareWithCandidate(subject({ phash: base }), candidate({ phash: await differenceHash(buf) }))
      assert.deepEqual(m?.reasons, ['image'], `${label} is flagged`)
    }
    for (const [label, buf] of Object.entries(others)) {
      const d = imageDistance(base, await differenceHash(buf))!
      assert.ok(d.ratio > DUPLICATE_THRESHOLDS.IMAGE_SIMILAR_MAX_RATIO, `${label}: ${(d.ratio * 100).toFixed(0)}% must not read as similar`)
      assert.equal(compareWithCandidate(subject({ phash: base }), candidate({ phash: await differenceHash(buf) })), null, label)
    }
  })
})

describe('detection across many reviews', () => {
  test('every match is reported, strongest first, deleted reviews included', () => {
    const sub = subject({ nameNorm: normalizeName('Rahul Sharma'), textNorm: T(LONG), sha256: 'S'.repeat(64) })
    const out = detectDuplicates(sub, [
      candidate({ id: 'weak', nameNorm: normalizeName('Rahul Sharma') }),
      candidate({ id: 'strong', textNorm: T(LONG), deleted: true }),
      candidate({ id: 'none', textNorm: T('Something else entirely, nothing in common with the review under test at all.') }),
      candidate({ id: 'identical', sha256: 'S'.repeat(64) }),
    ])
    assert.deepEqual(out.map(m => m.matchedId), ['identical', 'strong', 'weak'])
    assert.equal(out.find(m => m.matchedId === 'strong')?.matchedDeleted, true)
  })
  test('the record being edited is the caller\'s to leave out: an empty list is clear', () => {
    assert.deepEqual(detectDuplicates(subject({ textNorm: T(LONG) }), []), [])
  })
  test('the evidence reads in plain words for a verifier', () => {
    const lines = describeEvidence(['image', 'review_text', 'reviewer_name'], {
      image_kind: 'similar', image_distance: 300, image_ratio: 0.18, text_kind: 'similar', text_similarity: 0.91, name_match: true,
    })
    assert.equal(lines.length, 3)
    assert.match(lines[0], /18% of their marked image-hash bits differ/)
    assert.match(lines[1], /91%/)
    assert.match(lines[2], /weak signal/)
  })
})

describe('what an employee may see', () => {
  const sub = subject({ textNorm: T(LONG), nameNorm: normalizeName('Rahul Sharma') })
  const matches = detectDuplicates(sub, [
    candidate({ id: 'theirs-secret-id', submittedBy: 'colleague', textNorm: T(LONG), nameNorm: normalizeName('Rahul Sharma') }),
    candidate({ id: 'mine', submittedBy: 'me', textNorm: T(LONG) }),
  ])
  const view = employeeView('flagged', matches, 'me', id => (id === 'mine' ? 'CR-000007' : 'CR-000099'))

  test('reason categories, in the brief\'s words, and nothing about a colleague\'s review', () => {
    assert.deepEqual(view.reasons, ['reviewer_name', 'review_text'])
    assert.deepEqual(view.reasons.map(r => DUPLICATE_REASON_LABELS[r]), ['Same reviewer name', 'Similar review text'])
    const json = JSON.stringify(view)
    assert.ok(!json.includes('theirs-secret-id'), 'no id')
    assert.ok(!json.includes('CR-000099'), 'no reference')
    assert.ok(!json.includes('colleague'), 'no submitter')
    assert.ok(!json.includes('mine'), 'not even the id of their own')
    assert.ok(!/excellent|furniture|sharma/i.test(json), 'no name or text')
  })
  test('for their OWN earlier review they get its reference', () => {
    const own = view.items.find(i => i.scope === 'yours')
    assert.equal(own?.ref, 'CR-000007')
    assert.equal(view.items.find(i => i.scope === 'another_employee')?.ref, undefined)
  })
})

describe('the server-side check', () => {
  const rows = [
    { id: 'r1', submitted_by: 'colleague', submission_ref: 'CR-000001', reviewer_name_norm: null, review_text_norm: T(LONG), proof_content_sha256: 'q'.repeat(64), proof_phash: null, deleted: true },
  ]
  const service = (rpc: () => Promise<{ data: unknown; error: unknown }>) => ({ rpc }) as never

  test('a match against a DELETED review is found', async () => {
    const out = await runDuplicateCheck({
      service: service(async () => ({ data: rows, error: null })), actorId: 'me', excludeId: null,
      reviewerName: null, reviewText: LONG, sha256: 'z'.repeat(64), phash: null,
    })
    assert.equal(out.status, 'flagged')
    assert.equal(out.matches[0].matchedDeleted, true)
    assert.equal(out.token, duplicateToken('flagged', out.matches))
  })
  test('a check that cannot run is UNAVAILABLE, never clear — on an error and on a throw', async () => {
    for (const rpc of [
      async () => ({ data: null, error: { message: 'boom' } }),
      async () => { throw new Error('network') },
      async () => ({ data: 'not an array', error: null }),
    ]) {
      const out = await runDuplicateCheck({
        service: service(rpc), actorId: 'me', excludeId: null, reviewerName: null, reviewText: LONG, sha256: 'z'.repeat(64), phash: null,
      })
      assert.equal(out.status, 'unavailable')
      assert.equal(out.token, 'unavailable')
      assert.deepEqual(out.matches, [])
    }
  })
  test('no candidates is clear, with no token to acknowledge', async () => {
    const out = await runDuplicateCheck({
      service: service(async () => ({ data: [], error: null })), actorId: 'me', excludeId: null,
      reviewerName: 'Someone', reviewText: null, sha256: 'z'.repeat(64), phash: null,
    })
    assert.equal(out.status, 'clear')
    assert.equal(out.token, '')
  })
  test('the acknowledgement token changes when the matches change', () => {
    const a = detectDuplicates(subject({ textNorm: T(LONG) }), [candidate({ id: 'one', textNorm: T(LONG) })])
    const b = detectDuplicates(subject({ textNorm: T(LONG) }), [candidate({ id: 'one', textNorm: T(LONG) }), candidate({ id: 'two', textNorm: T(LONG) })])
    assert.notEqual(duplicateToken('flagged', a), duplicateToken('flagged', b))
    assert.equal(duplicateToken('flagged', a), duplicateToken('flagged', [...a]))
  })
  test('the fingerprint follows the content that is compared, not the remark or the date', () => {
    const n = normalizedFields('Rahul Sharma', LONG)
    const f1 = contentFingerprint('sha', n.nameNorm, n.textNorm)
    assert.equal(f1, contentFingerprint('sha', n.nameNorm, n.textNorm))
    assert.notEqual(f1, contentFingerprint('sha2', n.nameNorm, n.textNorm))
    assert.notEqual(f1, contentFingerprint('sha', n.nameNorm, normalizeText(LONG + ' Really.')))
    assert.match(f1, /^[0-9a-f]{64}$/)
  })
})
