// REMOVING ONE PHOTOGRAPH, INCLUDING THE SECOND ATTEMPT.
//
// The orchestration lives here rather than inside the route handler for one
// reason: a retry is the part most likely to be wrong, and it is impossible to
// test through a Next.js route without a live Supabase project. Everything below
// takes its two collaborators as arguments, so the whole state machine —
// including every failure and every resumption — is driven for real in
// photoRemovalRetry.test.ts.
//
// THE DEFECT THIS FILE EXISTS TO FIX
// ----------------------------------
// Removal is three steps against two systems: mark the row, delete the object,
// delete the row. Any of them can be the last thing that happens, so the
// operation has to be resumable. It was not, in two ways:
//
//   1. WHEN THE ROW WAS ALREADY GONE — finish() had succeeded but its response
//      was lost, or another tab completed it — the route's pre-read found
//      nothing and answered 404. A removal that had in fact COMPLETED was
//      reported to the employee as a failure, and no amount of retrying could
//      ever turn it into a success.
//
//   2. WHEN THE ROW WAS MARKED BUT PRESENT, the retry worked only BY ACCIDENT.
//      Every ordinary read in this module filters `removal_started_at`, and the
//      route's read did not — not by design, just by omission. The next person
//      tidying reads would have added the filter, and the resume path would have
//      died silently. It is deliberate now, and pinned by a test.
//
// THE ANSWER IS UNIFORM FOR EVERY ID A CALLER CANNOT RESOLVE.
//
// "Already removed", "never existed" and "belongs to somebody else" all produce
// the same success. That is not laziness — it is the requirement. If a completed
// removal returned 200 while another employee's photograph returned 404, the
// difference would itself be the disclosure: a caller could walk uuids and learn
// which ones exist on requests they cannot see. Nothing is deleted on that path
// and nothing is returned; the caller simply cannot tell the three apart.
//
// A refusal (409/403) is only ever reachable for a photograph the caller CAN
// already read, so those distinct answers disclose nothing new.

/** What the route needs to know about the caller's own visibility. */
export type PhotoVisibilityReader = {
  /**
   * Whether this photograph is readable BY THE CALLER, under their own RLS.
   *
   * MUST NOT filter `removal_started_at`. A marked row is hidden from every
   * ordinary list and detail read — that is the point of marking it — but this
   * is the resume path, and a resume that could not see the thing it is
   * resuming would be no resume at all.
   *
   * `failed` separates "the read said no" from "the read did not answer": a
   * transport error must not be mistaken for an absent row, or a network blip
   * would report a removal that never happened.
   */
  isVisibleToCaller(photoId: string): Promise<{ visible: boolean; failed: boolean }>
}

/** The privileged half. Every method here runs as the service role. */
export type PhotoRemovalService = {
  /**
   * begin_customer_review_photo_removal(). Re-checks the authorization in SQL,
   * locks the row, stamps removal_started_at/removal_by, and returns the
   * storage path FROM THE DATABASE. Idempotent: a row already marked is
   * returned unchanged.
   */
  beginRemoval(photoId: string, actorId: string): Promise<BeginResult>
  /** Deletes the object. `missing` means it was not there, which is a success. */
  deleteObject(storagePath: string): Promise<{ ok: boolean; missing: boolean }>
  /** finish_customer_review_photo_removal(). Idempotent. */
  finishRemoval(photoId: string): Promise<{ ok: boolean }>
}

export type BeginResult =
  | { outcome: 'ready'; storagePath: string }
  /** The row is gone: the removal already completed. */
  | { outcome: 'gone' }
  /** Verified proof, or a status that no longer permits removal. */
  | { outcome: 'locked' }
  /** Not this caller's to remove. */
  | { outcome: 'forbidden' }
  | { outcome: 'error' }

export type RemovalOutcome =
  /** The object and the row are both gone, and the trail has its entry. */
  | { status: 'removed' }
  /**
   * Nothing left to do, and nothing was done. Returned for a completed removal
   * AND for any id this caller cannot resolve — see the note above.
   */
  | { status: 'already_removed' }
  | { status: 'refused'; reason: 'locked' | 'forbidden' }
  /** The row stays marked, still names its path, and a retry converges. */
  | { status: 'failed'; reason: 'object' | 'row' | 'unknown' }

/**
 * Run a removal, or resume one.
 *
 * The caller has already been authenticated, checked for active status and
 * checked for `customer_review_requests.use`; `actorId` is the identity this
 * server established from the session, never anything the browser sent. The
 * per-photograph authority — owner or admin, the status rules, and the
 * verified-proof rule — is re-checked inside beginRemoval(), in SQL.
 */
export async function runPhotoRemoval(
  deps: { reader: PhotoVisibilityReader; service: PhotoRemovalService },
  actorId: string,
  photoId: string,
): Promise<RemovalOutcome> {
  const seen = await deps.reader.isVisibleToCaller(photoId)

  // A read that did not answer is not a read that said no.
  if (seen.failed) return { status: 'failed', reason: 'unknown' }

  // Not resolvable by this caller. Uniform answer, no privileged call made, no
  // row touched — so a probe learns nothing and a completed removal reports as
  // the success it was.
  if (!seen.visible) return { status: 'already_removed' }

  const begun = await deps.service.beginRemoval(photoId, actorId)

  switch (begun.outcome) {
    // Lost the race with another attempt that finished. Same answer as above.
    case 'gone':      return { status: 'already_removed' }
    case 'locked':    return { status: 'refused', reason: 'locked' }
    case 'forbidden': return { status: 'refused', reason: 'forbidden' }
    case 'error':     return { status: 'failed', reason: 'unknown' }
  }

  const object = await deps.service.deleteObject(begun.storagePath)
  // `missing` is a success: on a resume the object is usually already gone,
  // and treating that as a failure would make the operation permanently stuck
  // exactly when it is closest to finishing.
  if (!object.ok && !object.missing) return { status: 'failed', reason: 'object' }

  const finished = await deps.service.finishRemoval(photoId)
  if (!finished.ok) return { status: 'failed', reason: 'row' }

  return { status: 'removed' }
}

/**
 * Whether a storage error means the object was not there.
 *
 * supabase-js normally reports a missing key as a plain empty result, so this
 * is belt to that braces — but a removal that cannot distinguish "gone" from
 * "broken" is a removal that never converges, and the resume path is precisely
 * where the object is expected to be missing already.
 */
export function isMissingObjectError(error: { message?: string; status?: number } | null): boolean {
  if (!error) return false
  if (error.status === 404) return true
  const message = (error.message ?? '').toLowerCase()
  return message.includes('not found')
    || message.includes('does not exist')
    || message.includes('no such')
}
