import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { classifyDeletionError, type SubmissionDeletionCode } from '@/lib/orders/submissionDeletion'
import {
  SUBMISSION_ID_RE,
  removeAllObjectsForSubmission,
} from '@/lib/orders/submissionFilesServer'

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
//   4. begin_order_submission_deletion — authorize, verify status, RESERVE, and
//      receive the storage keys the record owns, read from the database and
//      never from anything the browser sent;
//   5. remove those objects with the service role;
//   6. finalize_order_submission_deletion, on the claim. It cannot be refused by
//      an ordinary status race, because step 4 made one impossible;
//   7. on any storage failure, release_order_submission_deletion — the record and
//      all of its metadata are untouched, so it returns to exactly the state it
//      was in and the whole call retries cleanly.
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
}

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

  // Step 4. Authorize and RESERVE. Run as the signed-in USER so auth.uid(), the
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
    return fail({ code, status: HTTP_FOR[code] ?? 500 })
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

  // Step 5. Remove the objects. The record is frozen, so nothing can be done to
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

  // Step 6. The point of no return, on the claim that froze the record.
  const finalizeStarted = Date.now()
  const { data: result, error: delErr } = await authClient.rpc(
    'finalize_order_submission_deletion',
    { p_submission_id: submissionId, p_claim_token: claimToken },
  )
  timing.finalize = Date.now() - finalizeStarted
  if (delErr) {
    // Near-unreachable: the reservation ruled out every ordinary race. THE
    // RESERVATION IS NOT RELEASED. By this point the sweep reported success, so
    // the files ARE gone; handing the record back would produce a PI that looks
    // healthy and has no workbook. It stays frozen, which is visible and
    // recoverable, until another attempt finalizes it.
    report('finalization refused after storage cleanup')
    const code = classifyDeletionError(delErr)
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
