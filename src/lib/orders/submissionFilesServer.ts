import type { SupabaseClient } from '@supabase/supabase-js'
import { ORDER_FILES_BUCKET } from './draftsView'

// Server-only storage cleanup for a PI submission.
//
// WHY THE SERVICE ROLE, AND WHY THIS CANNOT BE DONE FROM THE BROWSER
// ------------------------------------------------------------------
// The order-files DELETE policy (20260908000000 §9) admits the OWNER only, only
// while the submission is a draft or has been returned, and only while they hold
// orders.create. Two of the three deletable cases fall outside it — an
// administrator removing somebody else's PI, and anybody removing a REJECTED
// one — so a browser-side .remove() would fail for exactly the cases this
// feature exists to serve. The route proves authorization first, through the
// database, reserves the record, and only then removes the objects.
//
// THE PATHS ARE READ FROM THE DATABASE AND FROM THE BUCKET, never from anything
// the browser sent, and every one of them is under submissions/{id}/ — a prefix
// the path CHECK constraints in 20260908000000 and 20260909000000 make exclusive
// to one submission. No shared object can be named here.
//
// WHY A RECURSIVE SWEEP AS WELL AS THE RECORDED PATHS. The record names the
// workbook it currently points at and the pictures currently attached. A PI that
// was corrected with Change PI, or whose re-parse failed part way, can leave
// earlier objects under the same prefix that no row points at any more. Those
// are still this submission's files and still occupy the bucket, so the sweep
// takes the prefix as well as the record.
//
//
// ═══ WHY THIS WAS REWRITTEN: THE SWEEP WAS SERIAL ═══════════════════════════
//
// The first version recursed depth-first and awaited each child folder inline:
//
//     if (entry.id === null) keys.push(...await walk(service, path, depth + 1))
//
// One `await` inside a `for` loop, which turns a tree walk into a single chain
// of round trips. The tree under one submission is
//
//     submissions/{id}/original/{uuid}-{name}.xlsx
//     submissions/{id}/images/{item_id}/{role}/{position}-{sha}.{ext}
//
// so a PI with 12 products cost, in strict sequence:
//
//     1   submissions/{id}                     → original/, images/
//     1   …/original
//     1   …/images                             → 12 item folders
//     12  …/images/{item_id}                   → 1–2 role folders each
//     12–24 …/images/{item_id}/{role}          → the files
//     ────
//     27–39 sequential list calls, THEN the single remove
//
// At a normal 150–300 ms per hosted round trip that is four to twelve seconds of
// nothing but waiting, which is the "Deleting…" the dialog was stuck on.
//
// The sweep itself is not the problem and is not removed — it is what collects
// the objects a Change PI or an interrupted parse left behind. What changed is
// that INDEPENDENT DIRECTORIES ARE NOW LISTED CONCURRENTLY, breadth-first, with
// a small fixed ceiling on how many requests are in flight at once. The same 12
// product PI becomes 1 + 1 + 2 + 3 = 7 waves instead of 39 serial calls.
//
// BREADTH-FIRST, LEVEL BY LEVEL, is deliberate over a rolling work queue. A
// queue whose workers exit the moment it looks empty truncates the walk while
// other workers are still discovering folders — and a short answer here is read
// as "there is nothing else here", which is precisely the wrong conclusion and
// would delete a record while leaving its files behind. A level boundary is a
// barrier that cannot be raced: every directory at depth N is known before depth
// N+1 begins.

// ═══ WHY THERE IS NO TIMEOUT AROUND THIS ═════════════════════════════════════
//
// There was one, and it was unsafe. It raced the cleanup against a 20-second
// timer and, on losing, released the deletion reservation — on the reasoning
// that the abandoned requests would "land on nothing".
//
// THEY DO NOT LAND ON NOTHING. They land on the bucket. A `.remove()` still in
// flight when the reservation is released deletes the workbook and the images of
// a PI that has, by then, been unfrozen and may have been resubmitted, replaced
// or put in front of a reviewer. That is exactly the file-loss race the
// reservation was built to prevent, reintroduced by the thing meant to make the
// dialog feel responsive.
//
// A PROMISE RACE IS NOT CANCELLATION. It stops awaiting; the request continues.
//
// AND THESE CALLS CANNOT BE GENUINELY CANCELLED. In @supabase/storage-js 2.106.1
// the public `StorageFileApi.remove(paths)` takes no FetchParameters at all — it
// calls the internal helper with `{ headers }` only, dropping the slot that
// would carry an AbortSignal. `list()` does accept one, but aborting only the
// READS is worthless here: a late list deletes nothing, and the dangerous call
// is the remove.
//
// So there is no timeout. The bounded-concurrency traversal below is what fixed
// the delay this was reaching for, and the request lifecycle of the host is what
// deals with a genuinely hung call. If this request dies, the reservation stays
// exactly where it is — frozen, blocking every transition — and is recovered
// later by the stale-claim takeover or an explicit release, both of which are
// safe and idempotent. A PI stuck under a claim is a nuisance; a PI that lost
// its workbook to a request nobody was waiting for any more is unrecoverable.

export const SUBMISSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type SubmissionObjectRemoval = {
  /** Every key this submission owns, from the record and from the bucket. */
  found: string[]
  /**
   * Whether a DESTRUCTIVE request was issued — not whether one succeeded.
   *
   * THE DISTINCTION IS THE WHOLE POINT, and conflating the two is a data-loss
   * bug. A `.remove()` can delete objects on the server and then lose its
   * response to a network or gateway failure; the client sees a throw, or a
   * reply naming nothing, and `removed` is empty. "Nothing was confirmed
   * removed" is NOT "nothing was removed", and a caller that treats it as such
   * will unfreeze a record whose files are already gone.
   *
   * So this is set to true immediately BEFORE the first remove request goes out
   * and is never cleared. A caller deciding whether it is safe to give a record
   * back must read THIS, never `removed.length`.
   */
  removalAttempted: boolean
  removed: string[]
  /**
   * Keys that still exist and could not be removed. A recorded path that was
   * ALREADY absent is not one of these — see the note on `expected` below.
   */
  failed: string[]
  /** Diagnostics. Counts and durations only; never a key, never a secret. */
  stats: {
    directories: number
    batches: number
    listMs: number
    removeMs: number
  }
}

/** How deep the walk goes: submissions/{id}/images/{item}/{role}/{file} is five. */
export const MAX_DEPTH = 6
/** Supabase caps a list page; paged explicitly so a large PI is not truncated. */
export const PAGE = 100

/**
 * How many directory listings may be in flight at once.
 *
 * SMALL AND FIXED. Eight is enough to collapse the deep, narrow tree above into
 * a handful of waves, and low enough that deleting one PI cannot behave like a
 * burst of traffic against the storage API. It is never derived from the number
 * of products, because that is exactly how an unbounded Promise.all is written
 * by accident.
 */
export const LIST_CONCURRENCY = 8

/**
 * How many keys go in one remove request, and how many such requests run at once.
 *
 * The Supabase storage API takes the whole key list in one JSON body, so a PI
 * with hundreds of images would otherwise be one very large request whose
 * failure mode is a rejected body rather than a reported per-key result.
 * Batching at the same size as a list page keeps both halves of this file
 * working in the same units. Deleting one object per request is the other
 * extreme and is exactly the serial problem this file just fixed.
 */
export const REMOVE_BATCH = 100
export const REMOVE_CONCURRENCY = 4

/**
 * Map with a ceiling on how many run at once.
 *
 * ROLLING, not chunked: a worker that finishes early takes the next item rather
 * than waiting for the slowest member of a batch. At most `limit` calls are ever
 * outstanding, and never more than there are items.
 *
 * ═══ IT SETTLES EVERYTHING BEFORE IT RETURNS, INCLUDING WHEN IT FAILS ═══
 *
 * This is not a detail. `Promise.all` rejects on the FIRST rejection and leaves
 * its siblings running, so a naive version would hand a failure back to the
 * caller while storage requests were still in flight. The caller's response to a
 * failure is to RELEASE THE DELETION RESERVATION — and a `.remove()` that lands
 * after that release deletes the workbook of a PI that has since been unfrozen,
 * resubmitted and put in front of a reviewer. That is precisely the file-loss
 * race the reservation exists to prevent, reintroduced through the back door.
 *
 * So a failing worker records the error and stops taking NEW work, every worker
 * already mid-call runs to completion, and the error is rethrown only once all
 * of them have finished. When this function returns or throws, nothing it
 * started is still running.
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  let firstError: unknown = null
  let failed = false

  const worker = async (): Promise<void> => {
    for (;;) {
      // Once anything has failed no further work is STARTED, but whatever is
      // already in flight is still awaited by its own worker.
      if (failed) return
      const index = next
      next += 1
      if (index >= items.length) return
      try {
        results[index] = await fn(items[index], index)
      } catch (error) {
        if (!failed) {
          failed = true
          firstError = error
        }
        return
      }
    }
  }

  // Never rejects: every worker swallows its own error, so this resolves only
  // when all of them have stopped — which is the guarantee above.
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))

  if (failed) throw firstError
  return results
}

type Listing = { files: string[]; directories: string[] }

/**
 * One directory, every page of it.
 *
 * PAGES STAY SEQUENTIAL, deliberately: page N+1's offset only means anything
 * once page N has been counted, and a directory is one small unit of work. The
 * concurrency that matters is across SIBLING directories, which is where the
 * round trips actually were.
 *
 * A folder comes back from .list() as an entry with a null id; a file has one.
 * Throws rather than returning a partial answer.
 */
async function listDirectory(service: SupabaseClient, prefix: string): Promise<Listing> {
  const files: string[] = []
  const directories: string[] = []

  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await service.storage
      .from(ORDER_FILES_BUCKET)
      .list(prefix, { limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } })
    if (error) throw new Error(`Could not list ${prefix}: ${error.message}`)

    const entries = data ?? []
    for (const entry of entries) {
      if (!entry?.name) continue
      const path = `${prefix}/${entry.name}`
      if (entry.id === null) directories.push(path)
      else files.push(path)
    }
    if (entries.length < PAGE) break
  }

  return { files, directories }
}

/**
 * Every object key under one prefix, breadth-first, `LIST_CONCURRENCY` at a time.
 *
 * Depth is bounded by MAX_DEPTH exactly as the serial walk was: a folder found at
 * the limit is not descended into.
 */
async function sweepPrefix(
  service: SupabaseClient,
  prefix: string,
  limit: number,
): Promise<{ files: string[]; directories: number }> {
  const files: string[] = []
  let level: string[] = [prefix]
  let directories = 0

  for (let depth = 0; depth <= MAX_DEPTH && level.length > 0; depth += 1) {
    const listings = await mapWithLimit(level, limit, path => listDirectory(service, path))
    directories += level.length

    const nextLevel: string[] = []
    for (const listing of listings) {
      files.push(...listing.files)
      // At the limit the tree is deeper than this feature can produce; the
      // folder is left alone rather than descended into forever.
      if (depth < MAX_DEPTH) nextLevel.push(...listing.directories)
    }
    level = nextLevel
  }

  return { files, directories }
}

/**
 * Remove every storage object belonging solely to one PI submission.
 *
 * IDEMPOTENT, AND IT HAS TO BE. The route removes objects before it erases the
 * record, so a failure is retried — and a retry must converge rather than report
 * the same failure forever.
 *
 * WHICH IS WHY `expected` EXISTS. The storage API returns the objects it
 * actually deleted; a key that was already gone is simply absent from that list.
 * Counting every unreturned key as a failure meant that the second attempt at a
 * partly-completed deletion could never succeed: the recorded workbook path is
 * always submitted, the first attempt had already removed it, and its absence
 * from the reply was read as "could not remove". So a key is only a FAILURE when
 * the sweep just saw it in the bucket. A recorded key the sweep did not find is
 * already gone, which is the outcome being asked for.
 */
export async function removeAllObjectsForSubmission(
  service: SupabaseClient,
  submissionId: string,
  /** The keys the record itself names, read by the caller from the database. */
  recordedPaths: readonly string[],
  options: {
    /**
     * Called immediately BEFORE each remove request is issued.
     *
     * WHY A CALLBACK AND NOT ONLY THE RETURN VALUE. A return value arrives only
     * if this function returns. If it throws — or if the process dies — a caller
     * relying on the result learns nothing, and "I got no result" is exactly the
     * case in which objects may already be gone. The callback fires while the
     * request is still being made, so a caller that sets a flag in it knows the
     * truth no matter how this call ends.
     *
     * It must not throw and must not be slow: it runs on the path of every
     * batch.
     */
    onRemoveAttempt?: () => void
  } = {},
): Promise<SubmissionObjectRemoval> {
  if (!SUBMISSION_ID_RE.test(submissionId)) {
    throw new Error('A valid submissionId is required.')
  }
  return removeAllObjectsUnderPrefix(service, `submissions/${submissionId}`, recordedPaths, options)
}

/**
 * Remove every storage object belonging solely to one CONFIRMED ORDER — its
 * generated documents, under the reserved orders/{order_id}/versions/ prefix.
 *
 * A SIBLING OF THE ABOVE, not a widening of it. The two prefixes belong to
 * different records with different lifetimes: a PI's files may be removed while
 * its Order still exists, and an Order's documents are removed only when the
 * Order itself is. Keeping them separate means neither call can ever reach into
 * the other's territory, whatever it is handed.
 *
 * WHY THIS EXISTS AT ALL. Test Data Cleanup deletes the Order, and generated
 * documents are the only files an Order owns in its own right. Without this they
 * would survive every record that referred to them — unreachable through any
 * policy, since publication is what authorizes a read and the version row is
 * gone, but present in the bucket forever.
 */
export async function removeAllObjectsForOrder(
  service: SupabaseClient,
  orderId: string,
  /** The keys the register itself names, read by the caller from the database. */
  recordedPaths: readonly string[],
  options: { onRemoveAttempt?: () => void } = {},
): Promise<SubmissionObjectRemoval> {
  if (!SUBMISSION_ID_RE.test(orderId)) {
    throw new Error('A valid orderId is required.')
  }
  return removeAllObjectsUnderPrefix(service, `orders/${orderId}`, recordedPaths, options)
}

/**
 * The shared body: sweep one prefix, remove what is under it, and report
 * honestly.
 *
 * EXTRACTED RATHER THAN DUPLICATED. Every subtlety in here — the strict prefix
 * confinement on both sources, the "a recorded key the sweep did not find is
 * already gone" rule that makes a retry converge, marking before the request
 * rather than after it, a batch that never rejects — was learned once and is
 * expensive to re-learn. Two copies would be two chances to lose one of them.
 *
 * THE PREFIX IS NEVER A CALLER'S STRING. Both entry points above build it from a
 * validated uuid, so nothing outside this module can name a prefix to sweep.
 */
async function removeAllObjectsUnderPrefix(
  service: SupabaseClient,
  prefix: string,
  recordedPaths: readonly string[],
  options: { onRemoveAttempt?: () => void } = {},
): Promise<SubmissionObjectRemoval> {
  /** Set before the first destructive request, never cleared. */
  let removalAttempted = false

  const inPrefix = (path: unknown): path is string =>
    typeof path === 'string' && path.startsWith(`${prefix}/`)

  const listStarted = Date.now()
  const sweep = await sweepPrefix(service, prefix, LIST_CONCURRENCY)
  const listMs = Date.now() - listStarted

  // STRICT PREFIX CONFINEMENT, on both sources. A recorded key is already
  // constrained to this shape by the database; one that somehow is not stays
  // untouched rather than being removed on this submission's authority.
  const present = new Set(sweep.files.filter(inPrefix))
  const recorded = recordedPaths.filter(inPrefix)

  // Deduplicated, and deterministic so tests and diagnostics read the same twice.
  const found = [...new Set([...recorded, ...present])].sort()

  if (found.length === 0) {
    // Nothing to remove, so no destructive request is issued and the caller may
    // safely give the record back.
    return {
      found, removalAttempted: false, removed: [], failed: [],
      stats: { directories: sweep.directories, batches: 0, listMs, removeMs: 0 },
    }
  }

  const batches: string[][] = []
  for (let i = 0; i < found.length; i += REMOVE_BATCH) {
    batches.push(found.slice(i, i + REMOVE_BATCH))
  }

  const removeStarted = Date.now()
  const outcomes = await mapWithLimit(batches, REMOVE_CONCURRENCY, async batch => {
    // A BATCH NEVER REJECTS. A thrown network error is turned into the same
    // "these keys did not go" result as a returned one, so the map above always
    // runs every batch to completion instead of abandoning siblings mid-flight.
    // See the note on mapWithLimit: a remove still running when the caller
    // releases the reservation can delete the files of a PI that is live again.
    // MARK BEFORE THE REQUEST, not after it. From this line on, objects may be
    // gone whatever happens next — including a throw that never reaches the
    // return below.
    removalAttempted = true
    try {
      options.onRemoveAttempt?.()
    } catch { /* a caller's bookkeeping must never abort a sweep */ }

    try {
      const { data, error } = await service.storage.from(ORDER_FILES_BUCKET).remove(batch)
      // A failed batch fails only its own keys. The others are reported on their
      // own terms, so a partial failure is accurate rather than all-or-nothing.
      if (error) return { removed: [] as string[], errored: batch }
      return {
        removed: (data ?? []).map(object => object.name).filter(inPrefix),
        errored: [] as string[],
      }
    } catch {
      return { removed: [] as string[], errored: batch }
    }
  })
  const removeMs = Date.now() - removeStarted

  const removed = new Set(outcomes.flatMap(outcome => outcome.removed))
  const errored = new Set(outcomes.flatMap(outcome => outcome.errored))

  // A key is a failure when it is still in the bucket: either its batch errored,
  // or the API did not report it as removed while the sweep had just seen it.
  const failed = found.filter(path =>
    !removed.has(path) && (errored.has(path) || present.has(path)))

  return {
    found,
    removalAttempted,
    removed: found.filter(path => removed.has(path)),
    failed,
    stats: { directories: sweep.directories, batches: batches.length, listMs, removeMs },
  }
}
