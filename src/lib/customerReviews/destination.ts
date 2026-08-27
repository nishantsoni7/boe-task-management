// The review destination — the public page the customer is pointed at.
//
// WHAT THIS MODULE DOES NOT DO
// ----------------------------
// It does not ship a BOE review URL. There is no configured Google review link
// anywhere in this repository — that was checked, not assumed — and inventing
// one would mean sending real customers to an address nobody verified. The
// employee supplies the destination per request, and the business can move a
// standing one into a settings screen later if it ever wants to; that is a
// product decision with an owner, not something this module should guess at.
//
// WHAT IT DOES DO
// ---------------
// It refuses anything that is not a plain https web address. The destination is
// stored, shown to an employee, and pasted into a message that a customer will
// tap — so `javascript:`, `data:`, a credentialled URL, or a plain-http link
// are each a way to turn a stored field into somebody else's redirect. The same
// rule is repeated as a CHECK constraint in the migration, because a browser
// check protects the person who typed it and a database check protects the
// record.

export const REVIEW_URL_MAX_LENGTH = 500

export type ReviewDestination =
  | { ok: true; url: string }
  | { ok: false; error: string }

/**
 * Validate and canonicalise a review destination.
 *
 * Returns a RESULT rather than throwing, matching normalizeWhatsAppNumber and
 * adminClient: a caller must handle the invalid case, not merely remember to
 * catch it.
 */
export function parseReviewDestination(raw: string | null | undefined): ReviewDestination {
  const input = (raw ?? '').trim()
  if (input === '') return { ok: false, error: 'Add the review link the customer should open.' }
  if (input.length > REVIEW_URL_MAX_LENGTH) {
    return { ok: false, error: `That link is longer than ${REVIEW_URL_MAX_LENGTH} characters.` }
  }

  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return { ok: false, error: 'That is not a complete web address. It should start with https://' }
  }

  // https ONLY. http is not upgraded silently: a link the employee believed was
  // secure and is not should be corrected by the employee, not by this function.
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'The review link must start with https://' }
  }
  if (parsed.hostname === '') {
    return { ok: false, error: 'That link has no website address in it.' }
  }
  // A URL carrying credentials is either a mistake or an attempt to disguise
  // where it goes. Both are refused rather than stripped.
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, error: 'The review link must not contain a username or password.' }
  }

  // href, not the raw input: one canonical spelling per destination, so the
  // same link typed two ways is stored one way.
  const url = parsed.href
  if (url.length > REVIEW_URL_MAX_LENGTH) {
    return { ok: false, error: `That link is longer than ${REVIEW_URL_MAX_LENGTH} characters.` }
  }
  return { ok: true, url }
}

export function isSafeReviewDestination(raw: string | null | undefined): boolean {
  return parseReviewDestination(raw).ok
}

/**
 * The same rule for the OPTIONAL public review URL an employee records as
 * evidence afterwards.
 *
 * It is the identical check under a different name because it is a different
 * decision that happens to have the same answer today. Reusing the function is
 * fine; reusing the NAME would make "where we sent them" and "where the review
 * ended up" look like one field, and the module is careful to keep those
 * separate everywhere else.
 */
export function parseReviewEvidenceUrl(raw: string | null | undefined): ReviewDestination {
  const result = parseReviewDestination(raw)
  if (result.ok) return result
  return { ok: false, error: result.error.replace('review link the customer should open', 'link to the published review') }
}
