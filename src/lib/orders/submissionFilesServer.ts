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
// database, and then removes the objects with the service role.
//
// THE PATHS ARE READ FROM THE DATABASE, never from anything the browser sent,
// and every one of them is under submissions/{id}/ — a prefix the path CHECK
// constraints in 20260908000000 and 20260909000000 make exclusive to one
// submission. No shared object can be named here.
//
// WHY A RECURSIVE WALK AS WELL AS THE RECORDED PATHS. The record names the
// workbook it currently points at and the pictures currently attached. A PI that
// was corrected with Change PI, or whose re-parse failed part way, can leave
// earlier objects under the same prefix that no row points at any more. Those
// are still this submission's files and still occupy the bucket, so the sweep
// takes the prefix as well as the record. Anything the walk cannot read is a
// total failure rather than a silent gap: reporting success while files remain
// is the one outcome this must never produce.

export const SUBMISSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type SubmissionObjectRemoval = {
  /** Every key found, from the record and from the bucket. */
  found: string[]
  removed: string[]
  failed: string[]
}

/** How deep the walk goes: submissions/{id}/images/{item}/{role}/{file} is five. */
const MAX_DEPTH = 6
/** Supabase caps a list page; paged explicitly so a large PI is not truncated. */
const PAGE = 100

/**
 * Every object key under one prefix, recursively.
 *
 * A folder comes back from .list() as an entry with a null id; a file has one.
 * Throws rather than returning a partial answer — a short list would be read as
 * "there is nothing else here", which is precisely the wrong conclusion.
 */
async function walk(
  service: SupabaseClient,
  prefix: string,
  depth: number,
): Promise<string[]> {
  if (depth > MAX_DEPTH) return []

  const keys: string[] = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await service.storage
      .from(ORDER_FILES_BUCKET)
      .list(prefix, { limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } })
    if (error) throw new Error(`Could not list ${prefix}: ${error.message}`)

    const entries = data ?? []
    for (const entry of entries) {
      if (!entry?.name) continue
      const path = `${prefix}/${entry.name}`
      if (entry.id === null) keys.push(...await walk(service, path, depth + 1))
      else keys.push(path)
    }
    if (entries.length < PAGE) break
  }
  return keys
}

/**
 * Remove every storage object belonging solely to one PI submission.
 *
 * IDEMPOTENT. Removing an object that is already gone is a no-op, so a retry
 * after a partial failure converges rather than compounding — which is what
 * makes "storage first, database second" a recoverable ordering.
 */
export async function removeAllObjectsForSubmission(
  service: SupabaseClient,
  submissionId: string,
  /** The keys the record itself names, read by the caller from the database. */
  recordedPaths: readonly string[],
): Promise<SubmissionObjectRemoval> {
  if (!SUBMISSION_ID_RE.test(submissionId)) {
    throw new Error('A valid submissionId is required.')
  }

  const prefix = `submissions/${submissionId}`
  const swept = await walk(service, prefix, 0)

  // The union, de-duplicated and confined to this submission's own prefix. The
  // second condition is belt and braces: a recorded path is already constrained
  // to this shape by the database, and a key that somehow is not stays untouched
  // rather than being removed on this submission's authority.
  const found = [...new Set([...recordedPaths, ...swept])]
    .filter(path => typeof path === 'string' && path.startsWith(`${prefix}/`))
    .sort()

  if (found.length === 0) return { found, removed: [], failed: [] }

  const { data: removed, error } = await service.storage
    .from(ORDER_FILES_BUCKET).remove([...found])
  if (error) return { found, removed: [], failed: found }

  const removedNames = new Set((removed ?? []).map(object => object.name))
  return {
    found,
    removed: found.filter(path => removedNames.has(path)),
    failed: found.filter(path => !removedNames.has(path)),
  }
}
