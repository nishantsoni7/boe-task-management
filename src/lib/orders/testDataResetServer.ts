// The storage half of a module reset: the exact objects, and nothing beside
// them.
//
// WHY THIS IS SERVER-ONLY AND WHY IT TAKES A MANIFEST
// ---------------------------------------------------
// Postgres and Supabase Storage cannot share a transaction, so the files are
// removed between two database calls. Everything about how that window is made
// safe is already settled in submissionFilesServer.ts — bounded concurrency, a
// flag set BEFORE each destructive request rather than after it, strict prefix
// confinement, and the rule that a recorded key the sweep did not find is
// already gone rather than a failure. This module adds no new mechanism. It
// adds a MANIFEST: the four buckets one module reset owns, assembled from ids
// the database froze.
//
// THE CLIENT CANNOT ENLARGE IT. The route never reads a path or an id from the
// request body; it reads them from the claim, through an admin-only RPC, and
// hands them here. Every id is re-validated against SUBMISSION_ID_RE before it
// becomes a prefix, so nothing outside this module can name a prefix to sweep
// even if a database row were somehow wrong.
//
// A PREFIX IS NEVER A STRING SOMEBODY PASSED. removeAllObjectsForSubmission and
// removeAllObjectsForOrder build `submissions/{uuid}/` and `orders/{uuid}/`
// themselves from a validated uuid, which is what makes a neighbouring
// submission — or a bucket key that merely starts with the same characters —
// unreachable.

import type { SupabaseClient } from '@supabase/supabase-js'
import { PROOF_BUCKET } from '@/lib/paymentProof'
import { removeAllObjectsForRequest } from '@/lib/orderRequestAttachmentsServer'
import {
  SUBMISSION_ID_RE,
  removeAllObjectsForOrder,
  removeAllObjectsForSubmission,
} from './submissionFilesServer'

/** The four things one module reset owns in storage, as the claim recorded them. */
export type ResetStorageManifest = {
  /** order-files, under submissions/{id}/ */
  submissions: string[]
  /** order-files, under orders/{id}/ */
  orders: string[]
  /** order-request-attachments, under {id}/ */
  order_requests: string[]
  /** payment-proofs, exact keys read from payment_proof_attachments */
  payment_proofs: string[]
}

export type ResetStorageOutcome = {
  /** Objects storage positively reported as removed. */
  removed: number
  /** Keys still in a bucket after the sweep. Empty means the sweep is complete. */
  failed: string[]
  /**
   * Whether a DESTRUCTIVE request was ISSUED — not whether one succeeded.
   *
   * A `.remove()` can delete objects on the server and then lose its response,
   * so "nothing was confirmed removed" must never be read as "nothing was
   * removed". The caller releases the claim only when this is false.
   */
  removalAttempted: boolean
}

/**
 * Whatever the RPC returned, as a manifest this module will act on.
 *
 * FAIL CLOSED ON ANYTHING UNEXPECTED. An id that is not a uuid is dropped
 * rather than turned into a prefix, and a proof key is kept only if it is a
 * plain relative key — never one that climbs out of the bucket. A manifest that
 * arrives malformed sweeps less, never more.
 */
export function parseResetManifest(value: unknown): ResetStorageManifest {
  const source = (value ?? {}) as Record<string, unknown>
  const ids = (key: string): string[] => {
    const list = source[key]
    if (!Array.isArray(list)) return []
    return [...new Set(list.filter(
      (entry): entry is string => typeof entry === 'string' && SUBMISSION_ID_RE.test(entry)))]
  }
  const keys = Array.isArray(source.payment_proofs) ? source.payment_proofs : []
  return {
    submissions:    ids('submissions'),
    orders:         ids('orders'),
    order_requests: ids('order_requests'),
    payment_proofs: [...new Set(keys.filter(
      (entry): entry is string =>
        typeof entry === 'string'
        && entry.length > 0
        && !entry.startsWith('/')
        && !entry.includes('..')))],
  }
}

/**
 * Remove exactly the objects the manifest names, in every bucket it covers.
 *
 * IT NEVER STOPS EARLY. Each stage is run to completion and its failures
 * collected, because abandoning a sweep half-way leaves a state nobody can
 * describe — and because a caller that has to decide whether to release a claim
 * needs the whole truth, not the first half of it.
 *
 * A MISSING OBJECT IS SUCCESS. That is the rule the underlying helpers already
 * apply for the two order-files prefixes, and the reason a retry converges. The
 * payment-proofs pass below applies the same rule explicitly: `.remove()` lists
 * what it actually deleted, and a key absent from that list was already gone.
 */
export async function removeResetStorage(
  service: SupabaseClient,
  manifest: ResetStorageManifest,
  options: { onRemoveAttempt?: () => void } = {},
): Promise<ResetStorageOutcome> {
  let removed = 0
  let removalAttempted = false
  const failed: string[] = []

  const mark = () => {
    removalAttempted = true
    try { options.onRemoveAttempt?.() } catch { /* bookkeeping must never abort a sweep */ }
  }

  for (const submissionId of manifest.submissions) {
    try {
      const outcome = await removeAllObjectsForSubmission(
        service, submissionId, [], { onRemoveAttempt: mark })
      if (outcome.removalAttempted) removalAttempted = true
      removed += outcome.removed.length
      failed.push(...outcome.failed)
    } catch {
      failed.push(`submissions/${submissionId}`)
    }
  }

  for (const orderId of manifest.orders) {
    try {
      const outcome = await removeAllObjectsForOrder(
        service, orderId, [], { onRemoveAttempt: mark })
      if (outcome.removalAttempted) removalAttempted = true
      removed += outcome.removed.length
      failed.push(...outcome.failed)
    } catch {
      failed.push(`orders/${orderId}`)
    }
  }

  for (const requestId of manifest.order_requests) {
    try {
      const outcome = await removeAllObjectsForRequest(
        service, requestId, { onRemoveAttempt: mark })
      if (outcome.removalAttempted) removalAttempted = true
      removed += outcome.removed.length
      failed.push(...outcome.failed)
    } catch {
      failed.push(`order-request-attachments/${requestId}`)
    }
  }

  // ── Payment proofs ────────────────────────────────────────────────────────
  //
  // MOVED SERVER-SIDE. The chain protocol removed these from the browser after
  // the commit, with a documented rationale about which side a failure is
  // recoverable on. A module reset cannot do that: it removes hundreds of keys
  // across the whole module, and a browser that closes half-way leaves objects
  // whose payment rows are gone and which no policy can ever reach again.
  //
  // EXACT KEYS ONLY, never a prefix. payment-proofs is keyed by payment id, and
  // a prefix sweep there would be a sweep of a bucket this reset does not own
  // the whole of.
  if (manifest.payment_proofs.length > 0) {
    for (let i = 0; i < manifest.payment_proofs.length; i += PROOF_BATCH) {
      const batch = manifest.payment_proofs.slice(i, i + PROOF_BATCH)
      mark()
      try {
        const { data, error } = await service.storage.from(PROOF_BUCKET).remove(batch)
        if (error) { failed.push(...batch); continue }
        // A key absent from the reply was already gone, which is the outcome
        // being asked for — counted as removed nowhere, treated as failed
        // nowhere.
        removed += (data ?? []).length
      } catch {
        failed.push(...batch)
      }
    }
  }

  return { removed, failed: [...new Set(failed)], removalAttempted }
}

/** The same ceiling the submission sweep uses, for the same reason. */
export const PROOF_BATCH = 100
