import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import {
  classifyDeletionError,
  type DeletionBlocker,
  type SubmissionDeletionCode,
} from '@/lib/orders/submissionDeletion'
import {
  SUBMISSION_ID_RE,
  removeAllObjectsForSubmission,
} from '@/lib/orders/submissionFilesServer'
import { readDeletionBlockers } from '@/lib/orders/submissionDeletionBlockersServer'

// Permanently deleting one PI submission, together with its stored files.
//
// WHY A ROUTE AND NOT A PLAIN RPC CALL FROM THE BROWSER
// -----------------------------------------------------
// The storage DELETE policy on order-files admits the owner of a DRAFT only —
// not an administrator, and not anybody deleting a REJECTED PI. Both of those
// are cases this feature exists to serve, so the object removal needs the
// service role, which must never be within reach of browser code.
//
// THE SEQUENCE, AND THE DEFECT IT EXISTS TO PREVENT
// -------------------------------------------------
// Postgres and Supabase Storage cannot share a transaction, so the files are
// removed between two database calls. An earlier version of this route swept
// storage and then deleted the row, which left one intolerable outcome: the
// owner submits the PI from another tab in the gap, the delete is correctly
// refused, and A VALID SUBMITTED PI SURVIVES WITH ITS WORKBOOK AND EVERY PRODUCT
// IMAGE DESTROYED. Silent, permanent, and landing on the reviewer.
//
// The gap is now closed rather than narrowed. The record is RESERVED before a
// byte is touched, and while the reservation stands no caller — through any
// route, including direct SQL and the service role — can submit, resubmit,
// replace, review or otherwise transition it:
//
//   1. authenticate the caller;
//   2. validate the submission id;
//   3. confirm the service role is configured, so cleanup is ATTEMPTABLE before
//      anything is reserved or destroyed;
//   4. establish that nothing OUTSIDE this record still refers to it, so a PI
//      that cannot be finalized is refused before a byte is touched;
//   5. begin_order_submission_deletion — authorize, verify status, RESERVE, and
//      receive the storage keys the record owns, read from the database and
//      never from anything the browser sent;
//   6. remove those objects with the service role;
//   7. finalize_order_submission_deletion, on the claim. It cannot be refused by
//      an ordinary status race, because step 5 made one impossible;
//   8. on any storage failure, release_order_submission_deletion — the record and
//      all of its metadata are untouched, so it returns to exactly the state it
//      was in and the whole call retries cleanly.
//
// WHY STEP 4 EXISTS, AND WHY IT COMES BEFORE THE RESERVATION
// ----------------------------------------------------------
// A PI Draft stopped deleting in production. The dialog reported "already being
// deleted" and the record stayed, with its workbook and every product image
// already destroyed.
//
// The reservation had done its job. What refused the deletion was a foreign key
// belonging to a DIFFERENT module: finance_payment_allocations names the PI a
// payment was allocated to, with the default NO ACTION rule, and
// finalize_order_submission_deletion() neither deletes such a row nor should.
// order_submission_correction_requests and orders.source_order_submission_id are
// the same shape. The final DELETE came back as a raw constraint error — after
// the sweep had succeeded, on the one path that deliberately keeps the
// reservation, because by then the files really are gone.
//
// From there the record could not converge. Each attempt reserved it again,
// found the bucket already empty, and was refused by the same foreign key; an
// attempt made within the claim's time to live never got that far and met the
// neutral "already being deleted" instead. Nothing was corrupt and nothing was
// retryable.
//
// So the question is asked FIRST, while the answer still costs nothing: a PI
// something else depends on is refused with its files intact, its reservation
// never taken, and the actual reason on screen.
//
// THE CHECK IS NOT AUTHORITY AND DOES NOT SPEAK BEFORE AUTHORITY DOES. It reads
// with the service role, because two of the three tables are invisible to the
// person deleting the PI and a refusal conditional on the reader is not a
// refusal. What it finds is disclosed only once order_submission_deletable_by()
// — the same predicate begin re-derives under its own lock — has said this
// caller may delete this PI. A caller who may not falls through to begin, which
// refuses them in its own words and reserves nothing.
//
// THE CLAIM TOKEN NEVER REACHES THE BROWSER. It lives in this function's scope
// for the length of one request and is not in any response body.
//
// THE RESERVATION IS RELEASED ONLY WHEN THE STORAGE WORK HAS SETTLED. Not when
// it has been given up on — when every list and every remove this request
// started has finished, successfully or otherwise. removeAllObjectsForSubmission
// guarantees that: it returns or throws only once nothing it began is still
// running.
//
// There is deliberately NO TIMEOUT here. An earlier version raced the cleanup
// against a timer and released the reservation on losing, which left `.remove()`
// calls in flight against a record that was about to be unfrozen — able to
// delete the workbook of a PI that had since been resubmitted. A promise race is
// not cancellation, and these calls cannot be genuinely cancelled: storage-js's
// public remove() accepts no AbortSignal. The full reasoning is in
// submissionFilesServer.ts. What fixed the slow dialog is the bounded-
// concurrency traversal, not a timer.
//
// A CRASHED REQUEST DOES NOT BLOCK A PI FOREVER. The reservation goes stale
// after order_submission_deletion_claim_ttl(), after which another deletion
// attempt takes it over — issuing a new token and invalidating the abandoned
// one — or an owner or admin releases it by hand. Neither is automatic, and
// deliberately so: a reservation left standing after a crash means files MAY
// already be gone, and quietly unfreezing the record would assert something this
// system cannot know. Even then the invariant holds independently, because
// submit_order_submission_* verifies that the workbook and every image still
// exist in storage before it will submit anything.

/** Above this, one deletion is worth a line in the server log. */
const SLOW_DELETION_MS = 4_000

type Failure = { code: SubmissionDeletionCode; status: number; detail?: unknown }

const fail = ({ code, status, detail }: Failure) =>
  NextResponse.json({ ok: false, code, ...(detail === undefined ? {} : { detail }) }, { status })

/** The HTTP status each refusal deserves. 409 for "the world moved", 403 for authority. */
const HTTP_FOR: Partial<Record<SubmissionDeletionCode, number>> = {
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  STATUS_CHANGED: 409,
  IN_PROGRESS: 409,
  CLAIM_INVALID: 409,
  // 409 rather than 403: the caller has every right to ask, and the answer will
  // change the moment the record standing in the way is dealt with.
  BLOCKED: 409,
}

/**
 * A deletion that has already happened, answered as the success it is.
 *
 * IDEMPOTENT ON PURPOSE. A second tab, a retried request or a browser that lost
 * the first response asks again for a row that is no longer there. "This PI has
 * already been deleted" is true and useless — the state the caller asked for is
 * the state the database is in — so the row leaves the list and the dialog
 * closes, exactly as it would have on the attempt that did the work.
 *
 * IT DISCLOSES NOTHING. The same answer is given for an id that never existed,
 * so it cannot be used to learn whether a PI is real.
 */
const alreadyGone = (submissionId: string) =>
  NextResponse.json({
    ok: true, submissionId, alreadyDeleted: true,
    removedFiles: 0, items: 0, images: 0, activity: 0,
  })

export async function POST(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return fail({ code: 'UNAUTHORIZED', status: 401 })

  let submissionId: unknown
  try {
    ({ submissionId } = await req.json() as { submissionId?: unknown })
  } catch {
    return fail({ code: 'DELETE_FAILED', status: 400 })
  }
  if (typeof submissionId !== 'string' || !SUBMISSION_ID_RE.test(submissionId)) {
    return fail({ code: 'DELETE_FAILED', status: 400 })
  }

  // Step 3. Cleanup must be ATTEMPTABLE before anything is reserved, let alone
  // destroyed. A missing service key is a deployment fault, not a permission
  // one, and it must not be discovered with a claim already standing.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return fail({ code: 'STORAGE_CLEANUP_FAILED', status: 500 })
  const service = createServiceClient(url, serviceKey)

  // ── Diagnostics ──
  //
  // DURATIONS AND COUNTS ONLY. No key, no claim token, no signed URL, no service
  // credential and no client name goes anywhere near this — the whole point of
  // the header is to answer "which of the four steps was slow", and none of
  // those values helps answer it.
  const timing: Record<string, number> = {}
  let stats = { directories: 0, batches: 0, listMs: 0, removeMs: 0 }
  let objects = 0

  /** One line, and only when it is worth reading: a failure, or a slow run. */
  const report = (note: string) => {
    const total = Object.values(timing).reduce((sum, ms) => sum + ms, 0)
    if (note === '' && total < SLOW_DELETION_MS) return
    console.info('[orders:submission-delete]', {
      note: note === '' ? 'slow deletion' : note,
      totalMs: total,
      ...timing,
      directories: stats.directories,
      objects,
      batches: stats.batches,
    })
  }

  const serverTiming = () => {
    const total = Object.values(timing).reduce((sum, ms) => sum + ms, 0)
    return [
      `block;dur=${timing.block ?? 0}`,
      `claim;dur=${timing.claim ?? 0}`,
      `sweep;dur=${timing.sweep ?? 0}`,
      `list;dur=${stats.listMs}`,
      `remove;dur=${stats.removeMs}`,
      `finalize;dur=${timing.finalize ?? 0}`,
      `dirs;desc="directories listed";dur=${stats.directories}`,
      `objects;desc="objects found";dur=${objects}`,
      `batches;desc="remove batches";dur=${stats.batches}`,
      `total;dur=${total}`,
    ].join(', ')
  }

  // Step 4. What else still refers to this PI. Read with the service role — see
  // the header — and disclosed only after the deletion predicate has admitted
  // this caller.
  //
  // NO RESERVATION IS TAKEN ON THIS PATH, which is the point of doing it here
  // rather than after begin. A blocked attempt leaves the record exactly as it
  // found it: no claim written, no claim renewed, no file removed. So the moment
  // the blocking record is dealt with the very next attempt goes straight
  // through, instead of meeting a reservation this request had just refreshed.
  const blockStarted = Date.now()
  let blockers: DeletionBlocker[]
  try {
    blockers = await readDeletionBlockers(service, submissionId)
  } catch {
    // The question is unanswered, so the answer is not "nothing is in the way".
    timing.block = Date.now() - blockStarted
    report('could not establish what refers to this PI')
    return fail({ code: 'DELETE_FAILED', status: 500 })
  }
  if (blockers.length > 0) {
    const { data: permitted, error: gateErr } = await authClient.rpc(
      'order_submission_deletable_by',
      { p_submission_id: submissionId, p_actor_id: user.id },
    )
    timing.block = Date.now() - blockStarted
    if (permitted === true) {
      report('deletion blocked by a protected relationship')
      return fail({ code: 'BLOCKED', status: HTTP_FOR.BLOCKED ?? 409, detail: { blockers } })
    }
    if (gateErr || permitted !== false) {
      // The predicate did not answer. Nothing is reserved and nothing is
      // destroyed, and the one thing that must not happen from here is a sweep.
      report('could not establish who may delete this PI')
      return fail({ code: 'DELETE_FAILED', status: 500 })
    }
    // A definite NO. Say nothing about what was found and let begin refuse in
    // its own words — the same predicate, re-derived under its own row lock — so
    // the caller gets the precise reason and no reservation is taken.
  }
  timing.block = Date.now() - blockStarted

  // Step 5. Authorize and RESERVE. Run as the signed-in USER so auth.uid(), the
  // ownership rule, the admin check and the row lock all apply to them. Nothing
  // has been destroyed if this refuses.
  const claimStarted = Date.now()
  const { data: claim, error: claimErr } = await authClient.rpc(
    'begin_order_submission_deletion',
    { p_submission_id: submissionId },
  )
  timing.claim = Date.now() - claimStarted
  if (claimErr) {
    const code = classifyDeletionError(claimErr)
    // The row is gone, which is the outcome that was asked for. Answering with
    // 404 made a completed deletion look like a failure to every caller that had
    // simply asked twice.
    if (code === 'NOT_FOUND') return alreadyGone(submissionId)
    return fail({ code, status: HTTP_FOR[code] ?? 500 })
  }

  // UNREACHABLE, AND CHECKED ANYWAY. begin re-derives order_submission_deletable_by
  // under its own lock, so a caller the predicate above refused cannot get past
  // it — but if the two ever disagreed, this is the line between a blocked PI
  // and its workbook being destroyed. The reservation is not released: nothing
  // has been touched, and it goes stale on its own.
  if (blockers.length > 0) {
    report('a blocked PI was reserved; refusing before the sweep')
    return fail({ code: 'BLOCKED', status: HTTP_FOR.BLOCKED ?? 409, detail: { blockers } })
  }

  const reservation = claim as {
    claim_token?: string
    storage_paths?: string[]
  } | null
  const claimToken = reservation?.claim_token
  if (!claimToken) return fail({ code: 'DELETE_FAILED', status: 500 })

  /** Give the record back, whole. Never throws over the error it is reporting. */
  const release = async () => {
    try {
      await authClient.rpc('release_order_submission_deletion', {
        p_submission_id: submissionId,
        p_claim_token: claimToken,
      })
    } catch {
      // The reservation goes stale on its own and the record is intact either
      // way. Throwing here would replace the real failure with a cleanup one.
    }
  }

  // Step 6. Remove the objects. The record is frozen, so nothing can be done to
  // it while this runs and nothing can contradict it afterwards.
  const sweepStarted = Date.now()

  /**
   * Whether a DESTRUCTIVE request was issued — not whether one succeeded.
   *
   * THE RESERVATION IS GIVEN BACK ONLY WHEN NOTHING COULD HAVE GONE. A
   * `.remove()` can delete objects on the server and then lose its response to a
   * network or gateway failure: the client sees a throw, or a reply naming
   * nothing, and the confirmed count is zero while the files are already gone.
   * Releasing there would unfreeze a PI with a missing workbook — the exact
   * outcome the reservation exists to prevent — so "nothing was CONFIRMED
   * removed" must never be read as "nothing was removed".
   *
   * The flag is set by a callback that fires immediately BEFORE each remove
   * request, so it is true even if the helper throws and returns nothing. A
   * listing failure before any remove leaves it false, and that is the one path
   * on which the record can safely be handed back.
   */
  let removalAttempted = false

  let removal
  try {
    removal = await removeAllObjectsForSubmission(
      service, submissionId, reservation?.storage_paths ?? [],
      { onRemoveAttempt: () => { removalAttempted = true } })
    if (removal.removalAttempted) removalAttempted = true
  } catch {
    // A SETTLED failure: every request this sweep started has finished, so
    // nothing is in flight and a release cannot be overtaken by a late deletion.
    // It is released only if no remove request ever went out — a listing that
    // failed first. Otherwise the reservation stands and the caller retries.
    if (!removalAttempted) await release()
    timing.sweep = Date.now() - sweepStarted
    report('storage cleanup failed')
    return fail({ code: 'STORAGE_CLEANUP_FAILED', status: 500 })
  }
  timing.sweep = Date.now() - sweepStarted
  stats = removal.stats
  objects = removal.found.length

  if (removal.failed.length > 0) {
    // Some keys are still in the bucket, and others may already be gone. The
    // reservation is kept unless nothing was ever attempted, so the record stays
    // frozen and one more attempt finishes the job.
    if (!removalAttempted) await release()
    report('storage objects survived cleanup')
    return fail({
      code: 'STORAGE_CLEANUP_FAILED',
      status: 502,
      detail: { removed: removal.removed.length, failed: removal.failed.length },
    })
  }

  // Step 7. The point of no return, on the claim that froze the record.
  const finalizeStarted = Date.now()
  const { data: result, error: delErr } = await authClient.rpc(
    'finalize_order_submission_deletion',
    { p_submission_id: submissionId, p_claim_token: claimToken },
  )
  timing.finalize = Date.now() - finalizeStarted
  if (delErr) {
    // THE RESERVATION IS NOT RELEASED. By this point the sweep reported success,
    // so the files ARE gone; handing the record back would produce a PI that
    // looks healthy and has no workbook. It stays frozen, which is visible and
    // recoverable, until another attempt finalizes it — and because the claim is
    // released rather than renewed by the blocked path above, the next attempt
    // after this one's time to live either finishes the job or names the reason.
    report('finalization refused after storage cleanup')
    const code = classifyDeletionError(delErr)
    if (code === 'NOT_FOUND') return alreadyGone(submissionId)
    if (code === 'BLOCKED') {
      // Step 4 said nothing was in the way, and a foreign key has just said
      // otherwise — a record created in the window between the two. Read it back
      // so the screen names it rather than reporting a generic failure for a
      // condition that will still be true tomorrow.
      const late = await readDeletionBlockers(service, submissionId).catch(() => [])
      return fail({ code, status: HTTP_FOR.BLOCKED ?? 409, detail: { blockers: late } })
    }
    return fail({ code, status: HTTP_FOR[code] ?? 500 })
  }

  const counts = result as { items?: number; images?: number; activity?: number } | null

  report('')

  return NextResponse.json({
    ok: true,
    submissionId,
    removedFiles: removal.removed.length,
    items:    counts?.items    ?? 0,
    images:   counts?.images   ?? 0,
    activity: counts?.activity ?? 0,
  }, { headers: { 'Server-Timing': serverTiming() } })
}
