import type { SupabaseClient } from '@supabase/supabase-js'

// Server-only helpers for Order Request attachment storage cleanup. The storage
// DELETE policy on the private bucket is DRAFT-ONLY, so a finalized (or being-
// deleted) request's objects can only be removed by the service role, inside a
// route that has already proven admin authorization. These helpers always load
// the authoritative object paths FROM THE DATABASE — the browser is never
// trusted as the source of truth — which is also what keeps a failed cleanup
// recoverable: while the request row (and its cascaded metadata) still exists,
// the paths remain discoverable and the operation can be retried.

export const ORDER_REQ_ATTACHMENT_BUCKET = 'order-request-attachments'

export const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ObjectRemovalResult = {
  count:   number    // metadata rows found for the request
  removed: string[]  // object paths CONFIRMED removed
  failed:  string[]  // object paths that could not be removed
  /**
   * Whether a DESTRUCTIVE request was issued — not whether one succeeded.
   *
   * A `.remove()` can delete objects on the server and then lose its response to
   * a network or gateway failure, leaving `removed` empty. "Nothing was
   * confirmed removed" is NOT "nothing was removed". A caller deciding whether
   * it is safe to give a record back must read THIS, never `removed.length`.
   */
  removalAttempted: boolean
}

// Load a request's attachment object paths straight from order_request_attachments
// (authoritative), then remove those objects with the service role. Never trusts
// a caller-supplied path list. Idempotent: removing an already-gone object is a
// no-op, so a retry after a partial failure converges.
export async function removeAllObjectsForRequest(
  service: SupabaseClient,
  requestId: string,
  options: {
    /**
     * Called immediately BEFORE the remove request is issued.
     *
     * A return value arrives only if this function returns; the callback fires
     * while the request is still being made, so a caller that sets a flag in it
     * knows objects may be gone even if this call throws.
     */
    onRemoveAttempt?: () => void
  } = {},
): Promise<ObjectRemovalResult> {
  const { data, error } = await service
    .from('order_request_attachments')
    .select('storage_path')
    .eq('order_request_id', requestId)
  if (error) {
    // Could not read the authoritative paths — report as a total failure so the
    // caller never proceeds to delete the DB row (which would strand the files).
    throw new Error(`Could not read attachment metadata: ${error.message}`)
  }

  const paths = ((data ?? []) as { storage_path: string }[])
    .map(r => r.storage_path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0)

  // No objects, so no destructive request: the caller may safely give the
  // record back.
  if (paths.length === 0) {
    return { count: 0, removed: [], failed: [], removalAttempted: false }
  }

  // MARK BEFORE THE REQUEST. From here on, objects may be gone whatever happens
  // next — including a throw that never reaches a return below.
  try {
    options.onRemoveAttempt?.()
  } catch { /* a caller's bookkeeping must never abort a removal */ }

  const { data: removed, error: rmErr } = await service.storage
    .from(ORDER_REQ_ATTACHMENT_BUCKET).remove(paths)
  if (rmErr) {
    return { count: paths.length, removed: [], failed: paths, removalAttempted: true }
  }
  const removedPaths = (removed ?? []).map(o => o.name)
  const failed = paths.filter(p => !removedPaths.includes(p))
  return { count: paths.length, removed: removedPaths, failed, removalAttempted: true }
}
