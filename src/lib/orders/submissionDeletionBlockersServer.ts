// What still refers to one PI submission, asked before a single file is removed.
//
// WHY THIS FILE EXISTS
// --------------------
// A PI Draft would not delete. The dialog said "This PI is already being
// deleted", the record never went, and the workbook and every product image had
// already been destroyed.
//
// Nothing about the reservation protocol was wrong. The reservation freezes the
// submission and the three child tables that belong to it alone, and it did so
// correctly. What it cannot freeze — and should not — are the records OTHER
// modules keep about the same PI, and three of those name it through a foreign
// key with the default NO ACTION rule:
//
//   finance_payment_allocations.order_submission_id      (20260918000000 §1)
//   order_submission_correction_requests.submission_id   (20260930000000 §1)
//   orders.source_order_submission_id                    (20260915000000 §9)
//
// finalize_order_submission_deletion() removes the items, the images and the
// activity trail and then the row itself. It does not remove any of the three
// above, and it is right not to: an allocation is money, a correction request is
// what somebody asked for, and a Confirmed Order is what the PI became. So the
// final DELETE was refused by Postgres — with a raw constraint error, arriving
// AFTER the storage sweep had already succeeded, on a path that deliberately
// keeps the reservation because the files really are gone.
//
// That is the whole defect. The deletion protocol had no failure mode for "a
// record that is meant to survive refuses to let this one go", so it met one as
// a generic error at the one moment when nothing could be undone.
//
// THE ANSWER IS TO ASK FIRST, NOT TO DELETE MORE. This module reads those three
// tables before the reservation is taken, so a PI that cannot be deleted is
// refused while its workbook and every image are still in the bucket.
//
// IT IS NOT AUTHORIZATION AND IT IS NOT ALLOWED TO BE. The service role reads
// these tables because two of the three are invisible to the person deleting the
// PI under their own row-level security, and a refusal that depends on what the
// reader may see is not a refusal. Nothing it learns leaves the server until
// begin_order_submission_deletion() — or order_submission_deletable_by(), which
// is the same predicate — has said this caller may delete this PI.
//
// EVERY KEY IS DERIVED, NEVER RECEIVED. The one input is a submission id, and
// the caller has already matched it against SUBMISSION_ID_RE; it is re-checked
// here anyway, because a module that reads tables with the service role does not
// get to assume its caller validated anything.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { DeletionBlocker, DeletionBlockerKind } from './submissionDeletion'
import { SUBMISSION_ID_RE } from './submissionFilesServer'

/**
 * Every NO ACTION foreign key pointing at public.order_submissions, and the kind
 * of record each one is.
 *
 * DERIVED FROM THE SCHEMA, NOT FROM A GUESS about which modules care. The three
 * child tables of the submission itself are absent because finalization deletes
 * them; a fourth NO ACTION reference added by a later phase and not added here
 * would reintroduce the exact defect, which is why the assertion suite counts
 * the catalog's foreign keys against this list.
 */
export const DELETION_BLOCKER_SOURCES: readonly {
  kind: DeletionBlockerKind
  table: string
  column: string
}[] = [
  { kind: 'payment_allocation',  table: 'finance_payment_allocations',        column: 'order_submission_id' },
  { kind: 'correction_request',  table: 'order_submission_correction_requests', column: 'submission_id' },
  { kind: 'confirmed_order',     table: 'orders',                             column: 'source_order_submission_id' },
]

/**
 * How many records of each protected kind still name this PI.
 *
 * COUNTS ONLY, AND HEAD REQUESTS ONLY. Nothing about these rows is needed to
 * decide the question or to say why, so nothing about them is read: no id, no
 * amount, no payment reference. A count cannot leak into a response what a
 * column would.
 *
 * REVERSED ALLOCATIONS COUNT. `status = 'reversed'` is how an allocation ends,
 * and 20260918000000 is explicit that it is never deleted — so a reversed
 * allocation refuses the foreign key exactly as an active one does. Filtering
 * them out here would produce a check that says "nothing is in the way"
 * immediately before Postgres says otherwise, which is the bug, not the fix.
 *
 * IT THROWS RATHER THAN GUESSING. A query that fails leaves the question
 * unanswered, and the one thing this must never do is report "nothing is in the
 * way" because it could not look. The caller turns that into a refusal with the
 * reservation never taken and the bucket untouched.
 */
export async function readDeletionBlockers(
  service: SupabaseClient,
  submissionId: string,
): Promise<DeletionBlocker[]> {
  if (!SUBMISSION_ID_RE.test(submissionId)) {
    throw new Error('A valid submissionId is required.')
  }

  const counts = await Promise.all(DELETION_BLOCKER_SOURCES.map(async source => {
    const { count, error } = await service
      .from(source.table)
      .select('id', { count: 'exact', head: true })
      .eq(source.column, submissionId)
    if (error) {
      throw new Error(`Could not read ${source.table} for this PI.`)
    }
    return { kind: source.kind, count: count ?? 0 }
  }))

  return counts.filter(entry => entry.count > 0)
}
