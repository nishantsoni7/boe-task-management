'use client'

// "NEEDS YOUR ACTION" — Design Files and Client PO submissions (20261231000000),
// filtered to the signed-in reader's role, on the Orders dashboard.
//
//   Admin        submissions awaiting the admin decision
//   Operations   admin-approved submissions addressed to them
//   Sales        their rejected submissions awaiting correction, and —
//                separately — their own submissions awaiting somebody else
//
// ONE READ under the reader's own RLS (only Orders they may open), filtered by
// splitDocumentQueue. Each row links to the Order's Documents section, where
// the decision itself is made. Draws nothing when nothing is waiting, and
// nothing under View As. Accepted order rows elsewhere are untouched.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  ORDER_DOCUMENT_SUBMISSION_SELECT,
  SUBMISSION_STATUS_LABEL,
  categoriesLabel,
  currentOwnerLabel,
  nextActionLabel,
  queueHref,
  splitDocumentQueue,
  type DocumentViewer,
  type PersistedDocumentSubmission,
  type QueueRow,
} from '@/lib/orders/orderDocumentSubmissions'
import { splitRevisionQueue, type RevisionQueueRow } from '@/lib/orders/orderPiVersions'

const OPEN_STATUSES = ['pending_admin', 'awaiting_operations', 'rejected_admin', 'rejected_operations']

type Loaded = {
  rows: { submission: PersistedDocumentSubmission; orderNumber: string }[]
  // Revised PIs open on an Order (20270101000000): pending the admin, or
  // approved and awaiting the operations reviewer.
  revisions: RevisionQueueRow[]
  names: Map<string, string>
}

const TONE: Record<string, { bg: string; fg: string }> = {
  pending_admin: { bg: '#FFF6E0', fg: '#9A6A12' },
  awaiting_operations: { bg: '#FFF6E0', fg: '#9A6A12' },
  rejected_admin: { bg: '#FDECEA', fg: '#B42318' },
  rejected_operations: { bg: '#FDECEA', fg: '#B42318' },
  accepted: { bg: '#E8F5EE', fg: '#2F7A52' },
}

export function DocumentActionQueue({ supabase, viewerId, isAdmin, viewingAs, formatWhen }: {
  supabase: SupabaseClient
  viewerId: string | null
  isAdmin: boolean
  viewingAs: boolean
  formatWhen: (iso: string) => string
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    if (!viewerId || viewingAs) return
    let live = true
    void (async () => {
      const { data, error } = await supabase
        .from('order_document_submissions')
        .select(`${ORDER_DOCUMENT_SUBMISSION_SELECT}, order:orders!order_id(display_number)`)
        .in('status', OPEN_STATUSES)
        // Documents sent with a PI ride with the PI review and the handoff.
        .eq('stage', 'amendment')
        .order('submitted_at', { ascending: false })
        .limit(200)
      // An absent table (migration not applied) or a refused read draws nothing.
      if (error || !live) return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = ((data ?? []) as any[]).map(r => ({
        submission: r as PersistedDocumentSubmission,
        orderNumber: (r.order?.display_number as string | undefined) ?? '—',
      }))
      const { data: revData, error: revErr } = await supabase
        .from('order_pi_versions')
        .select('id, order_id, version_number, status, uploaded_by, uploaded_at, operations_reviewer, order:orders!order_id(display_number)')
        .in('status', ['pending', 'admin_approved'])
        .order('uploaded_at', { ascending: false })
        .limit(100)
      if (!live) return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const revisions: RevisionQueueRow[] = revErr ? [] : ((revData ?? []) as any[]).map(r => ({
        id: r.id, orderId: r.order_id, orderNumber: (r.order?.display_number as string | undefined) ?? '—',
        versionNumber: r.version_number, status: r.status, uploadedBy: r.uploaded_by ?? null,
        uploadedAt: r.uploaded_at, operationsReviewer: r.operations_reviewer ?? null,
      }))
      const ids = new Set<string>()
      for (const { submission: s } of rows) for (const uid of [s.submitted_by, s.operations_reviewer]) if (uid) ids.add(uid)
      for (const r of revisions) for (const uid of [r.uploadedBy, r.operationsReviewer]) if (uid) ids.add(uid)
      let names = new Map<string, string>()
      if (ids.size > 0) {
        const { data: users } = await supabase.from('users').select('id, full_name').in('id', [...ids])
        names = new Map((users ?? []).map((u: { id: string; full_name: string }) => [u.id, u.full_name]))
      }
      if (live) setLoaded({ rows, revisions, names })
    })()
    return () => { live = false }
  }, [supabase, viewerId, viewingAs])

  if (!loaded || !viewerId || viewingAs) return null
  const viewer: DocumentViewer = {
    viewerId, isAdmin, canSubmit: true, viewingAs,
  }
  const { needsYou, waitingOnOthers } = splitDocumentQueue(loaded.rows, viewer)
  const rev = splitRevisionQueue(loaded.revisions, { viewerId, isAdmin, viewingAs })
  const needsCount = needsYou.length + rev.needsYou.length
  if (needsCount === 0 && waitingOnOthers.length === 0 && rev.waitingOnOthers.length === 0) return null
  const nameOf = (id: string | null) => (id ? loaded.names.get(id) ?? null : null)

  const Row = ({ r }: { r: QueueRow }) => {
    const s = r.submission
    const tone = TONE[s.status] ?? TONE.pending_admin
    return (
      <li className="order-docq-row">
        <div className="order-docq-main">
          <strong>Order {r.orderNumber}</strong> · {categoriesLabel(s)} · {s.file_count} file{s.file_count === 1 ? '' : 's'}
          {' '}
          <span className="order-status-chip" style={{ background: tone.bg, color: tone.fg, borderColor: 'transparent' }}>
            {SUBMISSION_STATUS_LABEL[s.status]}
          </span>
          <span className="order-docq-meta">
            Submitted by {nameOf(s.submitted_by) ?? 'Sales'} · {formatWhen(s.submitted_at)}
            {' · '}Owner: {currentOwnerLabel(s, nameOf)}
            {' · '}Next: {nextActionLabel(s)}
            {s.resubmission_of && ' · correction of a rejected submission'}
          </span>
          {(s.status === 'rejected_admin' || s.status === 'rejected_operations') && (
            <span className="order-docq-meta">
              Reason: {s.status === 'rejected_admin' ? s.admin_reason : s.operations_reason}
            </span>
          )}
        </div>
        <Link href={queueHref(s.order_id ?? '')} className="boe-btn boe-btn-ghost order-doc-action">
          {s.status === 'pending_admin' && isAdmin ? 'Review'
            : s.status === 'awaiting_operations' && r.submission.operations_reviewer === viewerId ? 'Review'
            : s.status.startsWith('rejected') ? 'Correct' : 'Open'}
        </Link>
      </li>
    )
  }

  const RevRow = ({ r }: { r: RevisionQueueRow }) => (
    <li className="order-docq-row">
      <div className="order-docq-main">
        <strong>Order {r.orderNumber}</strong> · Revised PI · PI V{r.versionNumber}
        {' '}
        <span className="order-status-chip" style={{ background: '#FFF6E0', color: '#9A6A12', borderColor: 'transparent' }}>
          {r.status === 'pending' ? 'Pending Admin approval' : 'Approved by Admin — awaiting Operations'}
        </span>
        <span className="order-docq-meta">
          Uploaded by {nameOf(r.uploadedBy) ?? 'Sales'} · {formatWhen(r.uploadedAt)}
          {' · '}Owner: {r.status === 'pending' ? 'Admin' : `Operations — ${nameOf(r.operationsReviewer) ?? 'no reviewer assigned'}`}
          {' · '}Next: {r.status === 'pending' ? 'Admin to approve or reject' : 'Operations to accept or reject'}
          {r.status === 'pending' ? ' · The current PI stays in force until then' : ''}
        </span>
      </div>
      <Link href={`/orders/${r.orderId}#documents`} className="boe-btn boe-btn-ghost order-doc-action">
        {(r.status === 'pending' && isAdmin) || (r.status === 'admin_approved' && r.operationsReviewer === viewerId) ? 'Review' : 'Open'}
      </Link>
    </li>
  )

  return (
    <section className="order-docq" aria-label="Needs your action">
      <div className="order-docq-head">
        <h2 className="order-docq-title">Needs your action — Order documents and revised PIs</h2>
        {needsCount > 0 && <span className="order-docq-count" aria-label={`${needsCount} waiting on you`}>{needsCount}</span>}
      </div>
      {needsCount > 0 ? (
        <ul className="order-docq-list">
          {rev.needsYou.map(r => <RevRow key={r.id} r={r} />)}
          {needsYou.map(r => <Row key={r.submission.id} r={r} />)}
        </ul>
      ) : (
        <p className="order-docq-meta" style={{ padding: '8px 14px', margin: 0 }}>Nothing is waiting on you.</p>
      )}
      {(waitingOnOthers.length > 0 || rev.waitingOnOthers.length > 0) && (
        <>
          <p className="order-docq-sub">Your submissions awaiting someone else</p>
          <ul className="order-docq-list">
            {rev.waitingOnOthers.map(r => <RevRow key={r.id} r={r} />)}
            {waitingOnOthers.map(r => <Row key={r.submission.id} r={r} />)}
          </ul>
        </>
      )}
    </section>
  )
}
