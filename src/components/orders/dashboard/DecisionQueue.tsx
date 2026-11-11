'use client'

// "NEEDS YOUR DECISION" — everything waiting on the approver, in ONE list, longest waiting first.
//
//   PI review      every PI Draft in status `submitted`
//   PI revision    revised PIs on confirmed Orders waiting on this reader
//   Design Files / Client PO submissions waiting on this reader
//   PI flagged   a PI Operations cannot accept, which THIS reader must answer (my_flagged_pis, 20270611000000)
//
// It replaces PiReviewSections and the "needs you" half of DocumentActionQueue on the approver's
// dashboard. The three reads run together under the reader's own RLS, so a row can never name a PI or
// an Order the reader may not open, and each row is a link to where the decision itself is made.
//
// A FAILED PI READ IS AN ERROR LINE, NEVER "NOTHING IS WAITING". A refused revisions or documents
// read (migration not applied) just leaves those rows out, as it always did. Nothing is read under
// View As. A flagged-PI read that fails is said on the card (the rows already read are still drawn); a database
// without the function simply has none. The payment chip on a PI is the database's own position (see lib/orders/adminDashboard.ts);
// a PI whose summary could not be read simply has no chip.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronRight, CircleCheck, FileText, TriangleAlert, Clock } from 'lucide-react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadPiPaymentSummary } from '@/lib/finance/piPaymentView'
import { displayOrderNumber } from '@/lib/orderNumbering'
import { formatRupees, formatWaiting } from '@/lib/orders/orderDashboardSummary'
import {
  ORDER_DOCUMENT_SUBMISSION_SELECT,
  splitDocumentQueue,
  type PersistedDocumentSubmission,
} from '@/lib/orders/orderDocumentSubmissions'
import { splitRevisionQueue } from '@/lib/orders/orderPiVersions'
import { FLAGGED_LOAD_FAILED, loadFlaggedPis } from '@/lib/orders/flaggedPis'
import {
  documentRow,
  flaggedRow,
  isMixed,
  paymentChip,
  reviewRow,
  revisionRow,
  sinceLabel,
  sortDecisionRows,
  waitTone,
  type DecisionRow,
  type DocumentSource,
  type ReviewSource,
  type RevisionSource,
} from '@/lib/orders/adminDashboard'
import { OPEN_STATUSES } from '@/components/orders/DocumentActionQueue'
import { TONE_ICON, ToneChip } from './AdminChip'
import styles from './adminDashboard.module.css'

/** Payment summaries are read for this many PIs at most: one call each, side by side. */
const CHIP_READS = 12

type OrderEmbed = { display_number?: string | null; client_name?: string | null } | null
type RevisionRaw = {
  id: string; order_id: string; version_number: number; status: 'pending' | 'admin_approved'
  uploaded_by: string | null; uploaded_at: string; operations_reviewer: string | null
  revision_reason: string | null; order: OrderEmbed
}
type DocumentRaw = PersistedDocumentSubmission & { order: OrderEmbed }

/** null = the PI read failed, which the card says; anything else is the list (and whether the flagged-PI read failed). */
export async function loadDecisionRows(
  supabase: SupabaseClient,
  viewer: { viewerId: string; isAdmin: boolean },
): Promise<{ rows: DecisionRow[]; flaggedFailed: boolean } | null> {
  const [subs, revs, docs, flagged] = await Promise.all([
    supabase
      .from('order_submissions')
      .select('id, client_name, bill_to_name, draft_reference, subtotal_after_discount, submitted_by, submitted_at')
      .eq('status', 'submitted')
      .order('submitted_at', { ascending: true })
      .limit(200),
    supabase
      .from('order_pi_versions')
      .select('id, order_id, version_number, status, uploaded_by, uploaded_at, operations_reviewer, revision_reason, order:orders!order_id(display_number, client_name)')
      .in('status', ['pending', 'admin_approved'])
      .order('uploaded_at', { ascending: true })
      .limit(100),
    supabase
      .from('order_document_submissions')
      .select(`${ORDER_DOCUMENT_SUBMISSION_SELECT}, order:orders!order_id(display_number, client_name)`)
      .in('status', OPEN_STATUSES)
      // Documents sent with a PI ride with the PI review and the handoff.
      .eq('stage', 'amendment')
      .order('submitted_at', { ascending: false })
      .limit(200),
    // The ONE definition of "a flagged PI that waits on me": the database's (20270611000000).
    loadFlaggedPis({ rpc: async (fn: string) => supabase.rpc(fn) }),
  ])
  if (subs.error) return null

  const reviews = (subs.data ?? []) as unknown as ReviewSource[]

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

  const ids = new Set<string>()
  for (const r of reviews) if (r.submitted_by) ids.add(r.submitted_by)
  for (const r of myRevisions) if (r.uploadedBy) ids.add(r.uploadedBy)
  for (const r of myDocuments) if (r.submission.submitted_by) ids.add(r.submission.submitted_by)

  // loadPiPaymentSummary wants a promise from rpc(); the client's builder is a thenable, so await it here.
  const rpcClient = { rpc: async (fn: string, args: Record<string, unknown>) => supabase.rpc(fn, args) }
  const [names, summaries] = await Promise.all([
    ids.size === 0
      ? Promise.resolve(new Map<string, string>())
      : supabase.from('users').select('id, full_name').in('id', [...ids]).then(({ data }) =>
          new Map(((data ?? []) as { id: string; full_name: string }[]).map(u => [u.id, u.full_name] as const))),
    Promise.all(reviews.slice(0, CHIP_READS).map(r => loadPiPaymentSummary(rpcClient, r.id))),
  ])
  const nameOf = (id: string | null) => (id ? names.get(id) ?? null : null)

  const rows = sortDecisionRows([
    ...reviews.map((r, i) => reviewRow(r, nameOf(r.submitted_by), paymentChip(summaries[i] ?? null))),
    ...myRevisions.map(r => revisionRow(r, nameOf(r.uploadedBy))),
    ...myDocuments.map(r => documentRow(r, nameOf(r.submission.submitted_by))),
    ...(flagged ?? []).map(flaggedRow),
  ], Date.now())
  return { rows, flaggedFailed: flagged === null }
}

export type DecisionState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; rows: DecisionRow[]; flaggedFailed?: boolean }

export function DecisionQueue({ supabase, viewerId, isAdmin, viewingAs, reloadKey }: {
  supabase: SupabaseClient
  viewerId: string | null
  isAdmin: boolean
  viewingAs: boolean
  /** Changes whenever the page re-reads the dashboard, so the list is read again with it. */
  reloadKey: string
}) {
  const [state, setState] = useState<DecisionState>({ kind: 'loading' })

  useEffect(() => {
    if (!viewerId || viewingAs) return
    let live = true
    void loadDecisionRows(supabase, { viewerId, isAdmin }).then(read => {
      if (live) setState(read ? { kind: 'ready', rows: read.rows, flaggedFailed: read.flaggedFailed } : { kind: 'error' })
    })
    return () => { live = false }
  }, [supabase, viewerId, viewingAs, isAdmin, reloadKey])

  return <DecisionCard state={!viewerId || viewingAs ? { kind: 'unavailable' } : state} />
}

export function DecisionCard({ state }: { state: DecisionState }) {
  const rows = state.kind === 'ready' ? state.rows : []
  const mixed = isMixed(rows)
  return (
    <section className={styles.card} aria-labelledby="adm-dec-h">
      <header className={styles.cardHead}>
        <h2 id="adm-dec-h" className={styles.cardTitle}>Needs your decision</h2>
        {state.kind === 'ready' ? (
          <span className={`${styles.count} ${rows.length > 0 ? styles.countAttn : ''}`}>{rows.length}</span>
        ) : null}
        <span className={styles.hint}>Longest waiting first</span>
      </header>
      {state.kind === 'ready' && state.flaggedFailed ? <p className={styles.note} role="alert">{FLAGGED_LOAD_FAILED}</p> : null}
      {state.kind === 'loading' ? (
        <div className={styles.skeleton} aria-busy="true" aria-label="Loading what is waiting for your decision" />
      ) : state.kind === 'error' ? (
        <p className={styles.note} role="alert">What is waiting for your decision could not be loaded. Refresh to try again.</p>
      ) : state.kind === 'unavailable' ? (
        <p className={styles.note}>This list is not shown while you view as someone else.</p>
      ) : rows.length === 0 ? (
        // A failed flagged-PI read is said below the header, never "nothing is waiting".
        state.flaggedFailed ? null : (
          <div className={styles.empty}><CircleCheck size={20} aria-hidden="true" /><span>Nothing is waiting for your decision.</span></div>
        )
      ) : (
        <ul className={styles.dlist}>
          <li className={styles.dcols} aria-hidden="true">
            <span>Client</span><span>Waiting</span><span>Details</span><span className={styles.right}>Value</span><span />
          </li>
          {rows.map(r => {
            const tone = waitTone(r.waitSeconds)
            const AgeIcon = tone === 'danger' ? TriangleAlert : Clock
            return (
              <li key={r.key}>
                <Link href={r.href} className={styles.drow} prefetch={false}>
                  <span className={`${styles.who} ${styles.cWho}`}>
                    {mixed ? <span className={styles.kind}>{r.kindLabel}</span> : null}
                    <span className={styles.name}>{r.client}</span>
                    <span className={styles.sub}>{r.ref}{r.by ? ` · ${r.kind === 'pi_review' ? 'by' : 'from'} ${r.by}` : ''}</span>
                  </span>
                  <span className={`${styles.cellv} ${styles.cAge}`}>
                    <span className={`${styles.age} ${tone === 'warn' ? styles.ageWarn : tone === 'danger' ? styles.ageDanger : ''}`}>
                      {tone === 'normal' ? null : <AgeIcon size={15} strokeWidth={2} aria-hidden="true" />}
                      {formatWaiting(r.waitSeconds)}
                    </span>
                    <span className={styles.sub}>Since {sinceLabel(r.sinceIso)}</span>
                  </span>
                  <span className={`${styles.cellv} ${styles.cDet}`}>
                    {r.chip ? (
                      <>
                        <ToneChip tone={r.chip.tone} icon={r.kind === 'pi_review' || r.kind === 'pi_flagged' ? TONE_ICON[r.chip.tone] : FileText}>{r.chip.label}</ToneChip>
                        {r.chip.sub ? <span className={styles.sub}>{r.chip.sub}</span> : null}
                      </>
                    ) : null}
                  </span>
                  <span className={`${styles.val} ${styles.cVal}`}>{r.value !== null ? formatRupees(r.value) : '—'}</span>
                  <ChevronRight size={16} strokeWidth={2} className={styles.go} aria-hidden="true" />
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
