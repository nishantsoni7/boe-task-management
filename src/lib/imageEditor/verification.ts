// What the route was able to establish about a delivered image, and how that
// travels to the browser.
//
// CLIENT-SAFE. Pure strings and one parser — no sharp, no network, no key. The
// route imports it and so does the page, so the two cannot disagree about what
// the header means.
//
// WHY THIS EXISTS
// ---------------
// The structural gate cannot always reach a verdict. It locates a product by
// edge energy, which works on a plain background and does not work on a
// cluttered one — and BOE's factory photographs are taken against textured
// concrete, so on most real uploads the comparison is INCONCLUSIVE even when
// the product came back perfectly.
//
// Refusing those would refuse most of the module's actual traffic on the
// strength of a check that never ran. So an inconclusive result is delivered,
// and the fact that nobody verified it travels with it. What must never happen
// is the third option: delivering it silently and letting an employee assume
// it was checked.

/**
 * The response header carrying the verdict.
 *
 * A header rather than a field in the JSON body because the body is the image
 * and nothing else — no measurements, no bounds, no provider detail. This says
 * only which of two states the route reached.
 *
 * Same-origin, so the browser can read it without any CORS exposure list.
 */
export const VERIFICATION_HEADER = 'X-BOE-Image-Verification'

/**
 * What the route established.
 *
 * There is no 'failed' member on purpose: a confirmed structural failure is a
 * 422 with an error message, so no image and no header ever accompany it.
 */
export type VerificationStatus =
  /** Compared against the upload and the structure survived. */
  | 'passed'
  /** Not compared — the upload could not serve as ground truth. A person has
   *  to look at the result before it is used. */
  | 'manual_review_required'

/** Shown beside an unverified image. Deliberately not a warning about the
 *  image being wrong — it is a note that nobody has checked it yet. */
export const MANUAL_REVIEW_NOTE =
  'Please inspect fine product details before catalogue use.'

/** Read the header off a response, ignoring anything unrecognised. */
export function parseVerification(value: string | null | undefined): VerificationStatus | undefined {
  if (value === 'passed' || value === 'manual_review_required') return value
  return undefined
}

/** Whether a result still needs a person to look at it. */
export function needsManualReview(status: VerificationStatus | undefined): boolean {
  return status === 'manual_review_required'
}
