'use client'

// WHAT IS WAITING ON THE APPROVER, AND WHAT THEY HAVE PASSED ON — read here, drawn as four cards by DecisionCards.
//
//   PI review      every PI Draft in status `submitted`                                       → New PIs to approve
//   PI revision    revised PIs on confirmed Orders waiting on this reader                      → Changes on running orders
//   Change / cancellation request  a pending amendment on a Confirmed Order: an acting ADMINISTRATOR's only → same
//   PI flagged     a PI Operations cannot accept (my_flagged_pis, 20270611000000), by who holds it:
//                    the approver → Clarifications from Operations; Sales replied → Changes on running orders;
//                    with Sales → Waiting on others
//   Operations' answers on revised PIs that still ask something of the approver              → Clarifications from Operations
//   Orders waiting on the Operations reviewer (the page's own alignment list, no extra read)  → Waiting on others
//   Design Files / Client PO submissions waiting on this reader                               → one line under the cards
//
// The reads run together under the reader's own RLS, so a row can never name a PI or an Order the reader may not
// open, and each row is a link to where the decision itself is made. The Operations answers and the alignment list
// arrive from the page's own summary read, so this adds one small read (the Orders' salespeople) in the same burst
// as the names, and nothing to the page's first load.
//
// A FAILED PI READ IS AN ERROR LINE, NEVER "NOTHING IS WAITING". A refused revisions or documents
// read (migration not applied) just leaves those rows out, as it always did. Nothing is read under
// View As. A flagged-PI read that fails is said on the card (the rows already read are still drawn); a database
// without the function simply has none. The payment chip on a PI is the database's own position (see lib/orders/adminDashboard.ts);
// a PI whose summary could not be read simply has no chip.
//
// CHANGE REQUESTS ARE READ FOR AN ACTING ADMINISTRATOR ONLY. This list is drawn for everybody who can approve
// PIs, but the Order page offers a change request's review to an acting admin alone, and the table's policy also
// returns a requester their own rows, so the read is gated here and not left to the policy. A failed read is said
// on the card, like the flagged-PI one.

import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadPiPaymentSummaries } from '@/lib/finance/piPaymentView'
import { displayOrderNumber } from '@/lib/orderNumbering'
import type { AlignmentRow } from '@/lib/orders/orderDashboardSummary'
import type { ChangeResponse } from '@/lib/orders/operationsDashboard'
import {
  splitDocumentQueue,
  type PersistedDocumentSubmission,
} from '@/lib/orders/orderDocumentSubmissions'
import { splitRevisionQueue } from '@/lib/orders/orderPiVersions'
import { loadFlaggedPis, loadSentBackComments, sentBackHistoryRead } from '@/lib/orders/flaggedPis'
import {
  awaitingReviewRow,
  changeRequestRow,
  documentRow,
  flaggedRow,
  needsFollowUp,
  operationsAnswerRow,
  paymentChip,
  reviewRow,
  revisionRow,
  sortDecisionRows,
  type ChangeRequestSource,
  type DecisionRow,
  type DocumentSource,
  type ReviewSource,
  type RevisionSource,
} from '@/lib/orders/adminDashboard'
import {
  readOpenDocumentSubmissions,
  readOpenPiRevisions,
  rememberName,
  type PersonEmbed,
  type QueueRead,
} from '@/components/orders/DocumentActionQueue'
import { DecisionCards, type DecisionState } from './DecisionCards'

export type { DecisionState }

/** Payment summaries are read for this many PIs at most, in one call (the database takes up to 50). */
const CHIP_READS = 12

type OrderEmbed = { display_number?: string | null; client_name?: string | null } | null
type RevisionRaw = {
  id: string; order_id: string; version_number: number; status: 'pending' | 'admin_approved'
  uploaded_by: string | null; uploaded_at: string; operations_reviewer: string | null
  revision_reason: string | null; order: OrderEmbed; uploader: PersonEmbed
}
type DocumentRaw = PersistedDocumentSubmission & { order: OrderEmbed; submitter: PersonEmbed }
type ReviewRaw = ReviewSource & { submitter: PersonEmbed }
type ChangeRaw = ChangeRequestSource & { requested_by_user: { full_name: string } | null }
type SalespersonRaw = { id: string; salesperson: { full_name: string | null } | null }

/** What the page already holds from its own summary read: nothing here is read again. */
export type PageHeldRows = {
  /** The database's alignment list; the rows waiting on the Operations reviewer become "Waiting on others". */
  alignment?: readonly AlignmentRow[]
  reviewerName?: string | null
  /** Operations' answers on revised PIs; the ones that still ask something of the approver become rows. */
  answers?: readonly ChangeResponse[]
}

// ── TWO ROUNDS, NOT THREE, AND THE FIRST ONE BESIDE THE PAGE'S OWN READS (2026-11-21) ──────────────────────────────────
//
// This list used to be read after the page's first batch had landed (round 2), and then looked up the people's names
// and the rest in a third round. Now:
//   ROUND 1  the page starts startDecisionRead beside its three dashboard reads: the PIs, the revised PIs, the
//            documents, the flagged PIs and (for an acting administrator) the change requests. Each of those names its
//            people in the same request (an embed over the foreign key to users), so no lookup of users follows.
//   ROUND 2  what depends on round 1's rows: the payment summaries (one call for all the PIs, 20270818000000; per
//            PI where the database does not have it yet), the send-back comments and the flagged
//            Orders' salespeople, all at once, and only as soon as round 1 has answered, not after the page's batch.
// What the page's own read adds (Operations' answers, the orders waiting on Operations) is applied on top by
// composeDecisionRows, which reads nothing. Same reads under the same rights as before: the page only starts them sooner.

/** Everything the list needs from the database, before the page's own rows are laid over it. */
export type DecisionRead = {
  reviews: ReviewRaw[]
  myRevisions: RevisionSource[]
  myDocuments: DocumentSource[]
  /** null = the flagged-PI read failed (the card says so); [] = none, or this database does not have the function. */
  flagged: Awaited<ReturnType<typeof loadFlaggedPis>>
  changeRows: ChangeRaw[]
  changesFailed: boolean
  names: ReadonlyMap<string, string>
  summaries: Awaited<ReturnType<typeof loadPiPaymentSummaries>>
  sent: Awaited<ReturnType<typeof loadSentBackComments>>
  salespeople: ReadonlyMap<string, string>
}

type DecisionViewer = { viewerId: string; isAdmin: boolean; canReviewChanges: boolean }

/**
 * The reads, in two rounds. null = the PI read failed, which the card says. `canReviewChanges` is the ACTING
 * administrator (role admin, not under View As): it is not `isAdmin`, which here means "can approve PIs".
 * `open` carries the two open-queue reads when somebody started them already (see startDecisionRead).
 */
export async function readDecisionData(
  supabase: SupabaseClient,
  viewer: DecisionViewer,
  open?: { revisions: Promise<QueueRead>; documents: Promise<QueueRead> },
): Promise<DecisionRead | null> {
  const [subs, revs, docs, flagged, changes] = await Promise.all([
    supabase
      .from('order_submissions')
      .select('id, client_name, bill_to_name, draft_reference, subtotal_after_discount, submitted_by, submitted_at, submitter:users!submitted_by(full_name)')
      .eq('status', 'submitted')
      .order('submitted_at', { ascending: true })
      .limit(200),
    // Shared with the documents list below, which loads at the same moment from the same two tables.
    open?.revisions ?? readOpenPiRevisions(supabase),
    open?.documents ?? readOpenDocumentSubmissions(supabase),
    // The ONE definition of "a flagged PI that waits on me": the database's (20270611000000).
    loadFlaggedPis({ rpc: async (fn: string) => supabase.rpc(fn) }),
    // Pending amendments and cancellations, oldest first. Nobody but an acting admin is asked, so nobody else reads them.
    viewer.canReviewChanges
      ? supabase
          .from('order_change_requests')
          .select(`
            id, order_id, order_number_snapshot, request_type, proposed_total_value, created_at,
            order:orders!order_id(client_name),
            requested_by_user:users!requested_by(full_name)
          `)
          .eq('status', 'pending')
          .order('created_at', { ascending: true })
          .limit(200)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (subs.error) return null

  const reviews = (subs.data ?? []) as unknown as ReviewRaw[]

  const ctx = { viewerId: viewer.viewerId, isAdmin: viewer.isAdmin, viewingAs: false }
  const revisions: RevisionSource[] = revs.error ? [] : ((revs.data ?? []) as unknown as RevisionRaw[]).map(r => ({
    id: r.id, orderId: r.order_id, orderNumber: displayOrderNumber(r.order?.display_number ?? undefined) || '—',
    versionNumber: r.version_number, status: r.status, uploadedBy: r.uploaded_by ?? null,
    uploadedAt: r.uploaded_at, operationsReviewer: r.operations_reviewer ?? null,
    client: r.order?.client_name || 'Client not recorded', reason: r.revision_reason ?? null,
  }))
  const myRevisions = splitRevisionQueue(revisions, ctx).needsYou as RevisionSource[]

  const clientOf = new Map<string, string>()
  const docRows = docs.error ? [] : ((docs.data ?? []) as unknown as DocumentRaw[]).map(r => {
    clientOf.set(r.id, r.order?.client_name || 'Client not recorded')
    return { submission: r as PersistedDocumentSubmission, orderNumber: displayOrderNumber(r.order?.display_number ?? undefined) || '—' }
  })
  const myDocuments: DocumentSource[] = splitDocumentQueue(docRows, { ...ctx, canSubmit: true })
    .needsYou.map(r => ({ ...r, client: clientOf.get(r.submission.id) ?? 'Client not recorded' }))

  const changeRows = changes.error ? [] : ((changes.data ?? []) as unknown as ChangeRaw[])

  // The people's names arrived with the rows above, as embeds. Only the ones these lists use are looked at.
  const names = new Map<string, string>()
  for (const r of reviews) rememberName(names, r.submitted_by, r.submitter)
  for (const r of (revs.error ? [] : ((revs.data ?? []) as unknown as RevisionRaw[]))) rememberName(names, r.uploaded_by, r.uploader)
  for (const r of (docs.error ? [] : ((docs.data ?? []) as unknown as DocumentRaw[]))) rememberName(names, r.submitted_by, r.submitter)

  // The Order's salesperson stands in for "Sales" on a PI the approver sent them: the database records that holder as
  // a team, not a person. Only the Orders of flagged PIs are asked, in the same burst as the payment summaries.
  const flaggedOrderIds = [...new Set((flagged ?? []).map(r => r.orderId))]

  // The payment helpers want a promise from rpc(); the client's builder is a thenable, so await it here.
  const rpcClient = { rpc: async (fn: string, args: Record<string, unknown>) => supabase.rpc(fn, args) }
  const [summaries, sent, salespeople] = await Promise.all([
    // ONE call for all the chips (20270818000000); per PI as before where the database does not have it yet.
    loadPiPaymentSummaries(rpcClient, reviews.slice(0, CHIP_READS).map(r => r.id)),
    // Which flagged PIs were returned to Sales (no read when none is flagged; a failed read changes nothing).
    loadSentBackComments(sentBackHistoryRead(supabase), flagged ?? []),
    flaggedOrderIds.length === 0
      ? Promise.resolve(new Map<string, string>())
      : supabase.from('orders').select('id, salesperson:users!assigned_to(full_name)').in('id', flaggedOrderIds).then(({ data }) =>
          new Map(((data ?? []) as unknown as SalespersonRaw[]).flatMap(o => (o.salesperson?.full_name ? [[o.id, o.salesperson.full_name] as const] : [])))),
  ])

  return { reviews, myRevisions, myDocuments, flagged, changeRows, changesFailed: !!changes.error, names, summaries, sent, salespeople }
}

/** The rows, with the page's own answers laid over what was read. Reads nothing. */
export function composeDecisionRows(
  read: DecisionRead,
  held: PageHeldRows,
): { rows: DecisionRow[]; flaggedFailed: boolean; changesFailed: boolean } {
  const { reviews, myRevisions, myDocuments, flagged, changeRows, names, summaries, sent, salespeople } = read
  const nameOf = (id: string | null) => (id ? names.get(id) ?? null : null)

  const nowMs = Date.now()
  const rows = sortDecisionRows([
    ...reviews.map((r, i) => reviewRow(r, nameOf(r.submitted_by), paymentChip(summaries[i] ?? null))),
    ...myRevisions.map(r => revisionRow(r, nameOf(r.uploadedBy))),
    ...myDocuments.map(r => documentRow(r, nameOf(r.submission.submitted_by))),
    ...(flagged ?? []).map(r => flaggedRow(r, sent[r.handoffId], salespeople.get(r.orderId) ?? null)),
    ...changeRows.map(r => changeRequestRow(r, r.requested_by_user?.full_name ?? null)),
    ...(held.answers ?? []).filter(a => needsFollowUp(a, nowMs)).map(operationsAnswerRow),
    ...(held.alignment ?? []).flatMap(a => awaitingReviewRow(a, held.reviewerName ?? null) ?? []),
  ], nowMs)
  return { rows, flaggedFailed: flagged === null, changesFailed: read.changesFailed }
}

/** Both stages in one call: the reads, then the rows. null = the PI read failed, which the card says. */
export async function loadDecisionRows(
  supabase: SupabaseClient,
  viewer: DecisionViewer & PageHeldRows,
): Promise<{ rows: DecisionRow[]; flaggedFailed: boolean; changesFailed: boolean } | null> {
  const read = await readDecisionData(supabase, viewer)
  return read ? composeDecisionRows(read, viewer) : null
}

/**
 * A read started for a given reader, to be handed to DecisionQueue (and its open-queue reads to the documents list).
 * It records WHO it was started for, so a list drawn for somebody else never takes it.
 */
export type EarlyDecisionRead = DecisionViewer & {
  revisions: Promise<QueueRead>
  documents: Promise<QueueRead>
  /** Never rejects: a failed read is null, which the card says. */
  read: Promise<DecisionRead | null>
}

/** Starts the list's reads now, for the page's first batch. */
export function startDecisionRead(supabase: SupabaseClient, viewer: DecisionViewer): EarlyDecisionRead {
  const revisions = readOpenPiRevisions(supabase)
  const documents = readOpenDocumentSubmissions(supabase)
  const read = readDecisionData(supabase, viewer, { revisions, documents }).catch(() => null)
  return { viewerId: viewer.viewerId, isAdmin: viewer.isAdmin, canReviewChanges: viewer.canReviewChanges, revisions, documents, read }
}

/** The early read, only when it was started for exactly this reader and these rights; otherwise null and the list reads for itself. */
export function usableEarlyRead(early: EarlyDecisionRead | null | undefined, viewer: DecisionViewer): Promise<DecisionRead | null> | null {
  return early && early.viewerId === viewer.viewerId && early.isAdmin === viewer.isAdmin && early.canReviewChanges === viewer.canReviewChanges
    ? early.read
    : null
}

export function DecisionQueue({ supabase, viewerId, isAdmin, canReviewChanges, viewingAs, reloadKey, alignment, reviewerName, answers, early }: {
  supabase: SupabaseClient
  viewerId: string | null
  isAdmin: boolean
  /** The acting administrator: role admin and not previewing somebody else. Decides whether change requests are read at all. */
  canReviewChanges: boolean
  viewingAs: boolean
  /** Changes whenever the page re-reads the dashboard, so the list is read again with it. */
  reloadKey: string
  /** The read the page started in its first batch; used only when it was started for this very reader. */
  early?: EarlyDecisionRead | null
} & PageHeldRows) {
  const [state, setState] = useState<DecisionState>({ kind: 'loading' })

  useEffect(() => {
    if (!viewerId || viewingAs) return
    let live = true
    const viewer = { viewerId, isAdmin, canReviewChanges }
    // Reading the page's early read again costs nothing: it only lays the page's answers over rows already read.
    const read = usableEarlyRead(early, viewer) ?? startDecisionRead(supabase, viewer).read
    void read.then(data => {
      if (live) setState(data ? { kind: 'ready', ...composeDecisionRows(data, { alignment, reviewerName, answers }) } : { kind: 'error' })
    })
    return () => { live = false }
  }, [supabase, viewerId, viewingAs, isAdmin, canReviewChanges, reloadKey, alignment, reviewerName, answers, early])

  return <DecisionCards state={!viewerId || viewingAs ? { kind: 'unavailable' } : state} />
}
