// Possible-duplicate detection for Custom Reviews — pure, explainable, no service.
//
// WHAT IT COMPARES
//   reviewer name   normalized (case, spacing, punctuation, word order)  → WEAK on its own
//   review text     normalized; exact match, or character-trigram similarity
//   proof image     SHA-256 of the stored bytes (identical) and a 4096-bit
//                   difference hash (visually similar; see imageHash.ts)
//
// WHAT IT NEVER DOES
//   It never rejects a review and never touches a reward. It produces
//   "possible duplicate" matches with reasons and a strength; a person decides.
//   No paid or AI service is used: it is string and bit arithmetic.
//
// THE THRESHOLDS ARE HERE, ONCE, and documented in
// docs/Module Docs/CUSTOMER_REVIEW_OUTREACH.md §24. They are deliberately
// conservative in the direction of FEWER false alarms:
//
//   * a shared name alone is a weak signal, and the ordinary case (a common
//     name) must not raise a decision for a verifier;
//   * text shorter than TEXT_MIN_CHARS characters / TEXT_MIN_TOKENS words
//     carries no text signal at all — "Great service, thank you" is written by
//     thousands of customers and identical short reviews are not evidence;
//   * two screenshots of the same website look alike (measured on synthetic
//     review screenshots, 4096 bits, lightly blurred, counting differing bits as
//     a share of the marked bits: re-encodes, blur and resizes of ONE screenshot
//     differ by 13–21%; different reviews in one template by 43–61%), so the
//     perceptual threshold sits between them at 30%, with 12% for a strong
//     match. Two nearly blank pages are not comparable at all.
//
// LIMITATIONS (also documented)
//   * Text similarity is lexical: a translation or a genuine paraphrase is not
//     seen. Character trigrams tolerate typos, case and punctuation, not meaning.
//   * The image hash survives re-encoding, resizing and light compression, not
//     cropping to a different region, rotation, or an overlay.
//   * Names are compared whole (word order ignored); "A. Sharma" and
//     "Amit Sharma" are not the same name to this check.
//   * Reviews submitted before this feature have no name, text or perceptual
//     hash: only an identical screenshot (SHA-256) can match them until the
//     backfill script has run.

export type DuplicateReason = 'reviewer_name' | 'review_text' | 'image'

/** The wording the employee and the verifier read. */
export const DUPLICATE_REASON_LABELS: Record<DuplicateReason, string> = {
  reviewer_name: 'Same reviewer name',
  review_text:   'Similar review text',
  image:         'Similar image',
}

export const DUPLICATE_WARNING_TITLE = 'Possible duplicate review'
export const DUPLICATE_UNAVAILABLE_TITLE = 'Duplicate check unavailable'

export type DuplicateStrength = 'strong' | 'moderate' | 'weak'

export const DUPLICATE_THRESHOLDS = {
  /** A name shorter than this (normalized) is not compared. */
  NAME_MIN_CHARS: 4,
  /** Text shorter than either bound carries no text signal. */
  TEXT_MIN_CHARS: 30,
  TEXT_MIN_TOKENS: 6,
  /** An exact match at or above this many characters is a strong signal; below it, moderate. */
  TEXT_EXACT_STRONG_CHARS: 60,
  /** Trigram Dice similarity: at least this is "similar"; at least the strong bound is strong. */
  TEXT_NEAR_MIN: 0.8,
  TEXT_NEAR_STRONG: 0.92,
  /**
   * Differing bits as a share of the bits set in EITHER hash (0..1). Identical bytes are
   * always strong. A pair with fewer than IMAGE_MIN_MARKED_BITS marked bits is not
   * compared: two nearly blank pages have nothing to be similar about.
   */
  IMAGE_STRONG_MAX_RATIO: 0.12,
  IMAGE_SIMILAR_MAX_RATIO: 0.3,
  IMAGE_MIN_MARKED_BITS: 60,
} as const

export const IMAGE_HASH_BITS = 4096

// ─── Normalization ────────────────────────────────────────────────────────────

/** Case, width, punctuation and spacing folded away. Marks (Devanagari vowel signs etc.) are kept. */
export function normalizeText(value: string | null | undefined): string {
  if (!value) return ''
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A name, normalized, with its words in sorted order ("Sharma, Amit" = "Amit Sharma"). */
export function normalizeName(value: string | null | undefined): string {
  const base = normalizeText(value)
  if (!base) return ''
  return base.split(' ').sort().join(' ')
}

export function tokenCount(normalized: string): number {
  return normalized === '' ? 0 : normalized.split(' ').length
}

// ─── Text similarity ──────────────────────────────────────────────────────────

function trigrams(normalized: string): Map<string, number> {
  const padded = `  ${normalized} `
  const out = new Map<string, number>()
  for (let i = 0; i + 3 <= padded.length; i++) {
    const g = padded.slice(i, i + 3)
    out.set(g, (out.get(g) ?? 0) + 1)
  }
  return out
}

/** Dice coefficient over character trigrams of two normalized strings: 0..1. */
export function textSimilarity(a: string, b: string): number {
  if (a === '' || b === '') return 0
  if (a === b) return 1
  const ta = trigrams(a)
  const tb = trigrams(b)
  let shared = 0
  let total = 0
  for (const n of ta.values()) total += n
  for (const n of tb.values()) total += n
  for (const [g, n] of ta) shared += Math.min(n, tb.get(g) ?? 0)
  return total === 0 ? 0 : (2 * shared) / total
}

/** True when the text is long enough to be evidence of anything. */
export function textIsComparable(normalized: string): boolean {
  return normalized.length >= DUPLICATE_THRESHOLDS.TEXT_MIN_CHARS
    && tokenCount(normalized) >= DUPLICATE_THRESHOLDS.TEXT_MIN_TOKENS
}

// ─── Image similarity ─────────────────────────────────────────────────────────

const popcount4 = (n: number) => (n & 1) + ((n >> 1) & 1) + ((n >> 2) & 1) + ((n >> 3) & 1)

/** Hamming distance between two equal-length hex strings, or null when they cannot be compared. */
export function hammingHex(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b || a.length !== b.length || !/^[0-9a-f]+$/.test(a) || !/^[0-9a-f]+$/.test(b)) return null
  let bits = 0
  for (let i = 0; i < a.length; i++) bits += popcount4(parseInt(a[i], 16) ^ parseInt(b[i], 16))
  return bits
}

export type ImageDistance = {
  /** Differing bits. */
  distance: number
  /** Bits set in either hash — the marks the two images have between them. */
  marked: number
  /** distance / marked, 0..1. */
  ratio: number
}

/**
 * How far apart two image hashes are, as a share of the marked bits. Null when they
 * cannot be compared: a missing or malformed hash, different lengths, or too few
 * marks between them (two nearly blank pages).
 */
export function imageDistance(a: string | null | undefined, b: string | null | undefined): ImageDistance | null {
  const distance = hammingHex(a, b)
  if (distance === null || !a || !b) return null
  let marked = 0
  for (let i = 0; i < a.length; i++) marked += popcount4(parseInt(a[i], 16) | parseInt(b[i], 16))
  if (marked < DUPLICATE_THRESHOLDS.IMAGE_MIN_MARKED_BITS) return null
  return { distance, marked, ratio: distance / marked }
}

// ─── Matching ─────────────────────────────────────────────────────────────────

/** What is being checked: a new submission, or an edit (excluding itself is the caller's job). */
export type DuplicateSubject = {
  nameNorm: string | null
  textNorm: string | null
  sha256: string
  phash: string | null
}

/** One earlier review, deleted ones included (evidence is kept). */
export type DuplicateCandidate = {
  id: string
  submittedBy: string
  nameNorm: string | null
  textNorm: string | null
  sha256: string
  phash: string | null
  deleted: boolean
}

export type DuplicateEvidence = {
  name_match?: boolean
  text_kind?: 'exact' | 'similar'
  text_similarity?: number
  image_kind?: 'identical' | 'similar'
  image_distance?: number
  /** Differing bits as a share of the marked bits, 0..1. */
  image_ratio?: number
}

export type DuplicateMatch = {
  matchedId: string
  matchedSubmittedBy: string
  matchedDeleted: boolean
  reasons: DuplicateReason[]
  strength: DuplicateStrength
  evidence: DuplicateEvidence
}

/** Compare one subject with one candidate. Null when nothing matches. */
export function compareWithCandidate(subject: DuplicateSubject, candidate: DuplicateCandidate): DuplicateMatch | null {
  const T = DUPLICATE_THRESHOLDS
  const reasons: DuplicateReason[] = []
  const evidence: DuplicateEvidence = {}
  let nameOnly: DuplicateStrength | null = null
  let text: DuplicateStrength | null = null
  let image: DuplicateStrength | null = null

  // Name: whole-name equality after normalization. Weak, always.
  if (subject.nameNorm && candidate.nameNorm
      && subject.nameNorm.length >= T.NAME_MIN_CHARS && subject.nameNorm === candidate.nameNorm) {
    reasons.push('reviewer_name')
    evidence.name_match = true
    nameOnly = 'weak'
  }

  // Text: exact, or near, and only when long enough to mean something.
  if (subject.textNorm && candidate.textNorm
      && textIsComparable(subject.textNorm) && textIsComparable(candidate.textNorm)) {
    if (subject.textNorm === candidate.textNorm) {
      reasons.push('review_text')
      evidence.text_kind = 'exact'
      evidence.text_similarity = 1
      text = subject.textNorm.length >= T.TEXT_EXACT_STRONG_CHARS ? 'strong' : 'moderate'
    } else {
      const sim = textSimilarity(subject.textNorm, candidate.textNorm)
      if (sim >= T.TEXT_NEAR_MIN) {
        reasons.push('review_text')
        evidence.text_kind = 'similar'
        evidence.text_similarity = Math.round(sim * 1000) / 1000
        text = sim >= T.TEXT_NEAR_STRONG ? 'strong' : 'moderate'
      }
    }
  }

  // Image: identical bytes, or a small perceptual distance.
  if (subject.sha256 === candidate.sha256) {
    reasons.push('image')
    evidence.image_kind = 'identical'
    evidence.image_distance = 0
    image = 'strong'
  } else {
    const d = imageDistance(subject.phash, candidate.phash)
    if (d !== null && d.ratio <= T.IMAGE_SIMILAR_MAX_RATIO) {
      reasons.push('image')
      evidence.image_kind = 'similar'
      evidence.image_distance = d.distance
      evidence.image_ratio = Math.round(d.ratio * 1000) / 1000
      image = d.ratio <= T.IMAGE_STRONG_MAX_RATIO ? 'strong' : 'moderate'
    }
  }

  if (reasons.length === 0) return null

  // Strength: the strongest single signal; a name adds weight to a moderate
  // signal, and two independent moderate signals (text AND image) reinforce.
  const rank: Record<DuplicateStrength, number> = { weak: 0, moderate: 1, strong: 2 }
  let strength: DuplicateStrength = 'weak'
  for (const s of [nameOnly, text, image]) if (s && rank[s] > rank[strength]) strength = s
  if (strength === 'moderate' && (nameOnly || (text && image))) strength = 'strong'

  return {
    matchedId: candidate.id,
    matchedSubmittedBy: candidate.submittedBy,
    matchedDeleted: candidate.deleted,
    reasons,
    strength,
    evidence,
  }
}

/**
 * Every candidate that matches, strongest first. The caller leaves the record
 * being edited out of `candidates`.
 */
export function detectDuplicates(subject: DuplicateSubject, candidates: DuplicateCandidate[]): DuplicateMatch[] {
  const rank: Record<DuplicateStrength, number> = { weak: 0, moderate: 1, strong: 2 }
  const out: DuplicateMatch[] = []
  for (const c of candidates) {
    const m = compareWithCandidate(subject, c)
    if (m) out.push(m)
  }
  return out.sort((a, b) => rank[b.strength] - rank[a.strength] || a.matchedId.localeCompare(b.matchedId))
}

/** A match a verifier is asked to decide on. A weak (name-only) match is recorded but not queued. */
export function needsDecision(strength: DuplicateStrength): boolean {
  return strength !== 'weak'
}

// ─── What an EMPLOYEE may see ─────────────────────────────────────────────────
//
// Duplicate checking runs across every employee's reviews, so its answer is a
// side channel into private evidence unless it is cut down. The employee gets the
// REASON CATEGORIES and, for their OWN earlier review only, its reference.
// Never another employee's id, reference, name, text, image, date or even the
// fact that a deleted review exists.

export type EmployeeDuplicateItem = {
  scope: 'yours' | 'another_employee'
  reasons: DuplicateReason[]
  /** Only for the employee's own earlier review. */
  ref?: string
}

export type EmployeeDuplicateView = {
  status: 'clear' | 'flagged' | 'unavailable'
  /** The union of reasons, in a stable order. */
  reasons: DuplicateReason[]
  items: EmployeeDuplicateItem[]
}

const REASON_ORDER: DuplicateReason[] = ['reviewer_name', 'review_text', 'image']

export function employeeView(
  status: 'clear' | 'flagged' | 'unavailable',
  matches: DuplicateMatch[],
  actorId: string,
  refOf: (id: string) => string | undefined,
): EmployeeDuplicateView {
  const union = new Set<DuplicateReason>()
  const items: EmployeeDuplicateItem[] = matches.map(m => {
    for (const r of m.reasons) union.add(r)
    const own = m.matchedSubmittedBy === actorId
    return {
      scope: own ? 'yours' : 'another_employee',
      reasons: REASON_ORDER.filter(r => m.reasons.includes(r)),
      ...(own ? { ref: refOf(m.matchedId) } : {}),
    }
  })
  return { status, reasons: REASON_ORDER.filter(r => union.has(r)), items }
}

// ─── What a VERIFIER reads ────────────────────────────────────────────────────

/** The evidence in plain words, one line per reason, for the comparison view. */
export function describeEvidence(reasons: readonly DuplicateReason[], evidence: DuplicateEvidence): string[] {
  const lines: string[] = []
  if (reasons.includes('image')) {
    if (evidence.image_kind === 'identical') {
      lines.push('The screenshot files are identical (same content hash).')
    } else if (typeof evidence.image_ratio === 'number') {
      lines.push(`The screenshots look alike: ${Math.round(evidence.image_ratio * 100)}% of their marked image-hash bits differ (flagged up to ${Math.round(DUPLICATE_THRESHOLDS.IMAGE_SIMILAR_MAX_RATIO * 100)}%).`)
    } else {
      lines.push('The screenshots look alike.')
    }
  }
  if (reasons.includes('review_text')) {
    if (evidence.text_kind === 'exact') {
      lines.push('The review text is identical once case, spacing and punctuation are ignored.')
    } else if (typeof evidence.text_similarity === 'number') {
      lines.push(`The review text is ${Math.round(evidence.text_similarity * 100)}% similar (flagged from ${Math.round(DUPLICATE_THRESHOLDS.TEXT_NEAR_MIN * 100)}%).`)
    } else {
      lines.push('The review text is similar.')
    }
  }
  if (reasons.includes('reviewer_name')) {
    lines.push('The reviewer name is the same. A shared name alone is a weak signal: many customers share a name.')
  }
  return lines
}

export const DUPLICATE_STRENGTH_LABELS: Record<DuplicateStrength, string> = {
  strong:   'Strong match',
  moderate: 'Moderate match',
  weak:     'Weak match (name only)',
}
