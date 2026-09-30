// Read-only pairing of EXISTING reviews by their stored screenshots — the engine of
// `scripts/backfill-review-image-hashes.ts --verify`.
//
// WHAT THIS IS FOR. After the backfill has filled proof_phash on older reviews, a NEW
// submission is compared against them (they are candidates). Existing reviews are NOT
// flagged retroactively: duplicate flags are written only when a review is submitted,
// edited or reapplied. This module answers the question an administrator asks before
// trusting that: "which of the older reviews would already look alike?" — by listing
// pairs, in memory, with references only. It writes nothing anywhere.
//
// Images only: an older review has no reviewer name or review text (those fields are
// new), so only the screenshot (identical hash, or similar perceptual hash) can pair
// two of them.

import { DUPLICATE_THRESHOLDS, imageDistance, type DuplicateStrength } from './duplicateDetection'

export type HistoricalReview = {
  id: string
  ref: string
  submittedBy: string
  sha256: string
  phash: string | null
  deleted: boolean
}

export type HistoricalPair = {
  a: string
  b: string
  sameEmployee: boolean
  kind: 'identical' | 'similar'
  /** Differing marked bits / marked bits, 0 for identical files. */
  ratio: number
  strength: DuplicateStrength
}

const POP = (() => {
  const t = new Uint8Array(256)
  for (let i = 0; i < 256; i++) { let n = i, c = 0; while (n) { c += n & 1; n >>= 1 } t[i] = c }
  return t
})()

function toBytes(hex: string): Uint8Array {
  const out = new Uint8Array(Math.floor(hex.length / 2))
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * Every pair among `reviews` whose screenshots are identical (same SHA-256) or whose
 * perceptual hashes are within the similarity threshold. Strongest first. O(n²) over
 * the hashed reviews — fine for a few thousand; the script refuses more.
 */
export function findHistoricalPairs(reviews: HistoricalReview[]): HistoricalPair[] {
  const T = DUPLICATE_THRESHOLDS
  const pairs: HistoricalPair[] = []
  const hashed = reviews
    .filter(r => r.phash && /^[0-9a-f]+$/.test(r.phash))
    .map(r => ({ r, bytes: toBytes(r.phash as string) }))

  for (let i = 0; i < reviews.length; i++) {
    for (let j = i + 1; j < reviews.length; j++) {
      const a = reviews[i], b = reviews[j]
      if (a.sha256 === b.sha256) {
        pairs.push({ a: a.ref, b: b.ref, sameEmployee: a.submittedBy === b.submittedBy, kind: 'identical', ratio: 0, strength: 'strong' })
      }
    }
  }
  const identical = new Set(pairs.map(p => `${p.a}|${p.b}`))

  for (let i = 0; i < hashed.length; i++) {
    for (let j = i + 1; j < hashed.length; j++) {
      const x = hashed[i], y = hashed[j]
      if (x.bytes.length !== y.bytes.length) continue
      let distance = 0, marked = 0
      for (let k = 0; k < x.bytes.length; k++) {
        distance += POP[x.bytes[k] ^ y.bytes[k]]
        marked += POP[x.bytes[k] | y.bytes[k]]
      }
      if (marked < T.IMAGE_MIN_MARKED_BITS) continue
      const ratio = distance / marked
      if (ratio > T.IMAGE_SIMILAR_MAX_RATIO) continue
      if (identical.has(`${x.r.ref}|${y.r.ref}`) || identical.has(`${y.r.ref}|${x.r.ref}`)) continue
      pairs.push({
        a: x.r.ref, b: y.r.ref, sameEmployee: x.r.submittedBy === y.r.submittedBy,
        kind: 'similar', ratio: Math.round(ratio * 1000) / 1000,
        strength: ratio <= T.IMAGE_STRONG_MAX_RATIO ? 'strong' : 'moderate',
      })
    }
  }
  const rank = { strong: 0, moderate: 1, weak: 2 } as const
  return pairs.sort((p, q) => rank[p.strength] - rank[q.strength] || p.ratio - q.ratio || p.a.localeCompare(q.a))
}

/** The same test the route applies to one pair, exposed so the two can be checked against each other. */
export function pairIsSimilar(a: string | null, b: string | null): boolean {
  const d = imageDistance(a, b)
  return d !== null && d.ratio <= DUPLICATE_THRESHOLDS.IMAGE_SIMILAR_MAX_RATIO
}
