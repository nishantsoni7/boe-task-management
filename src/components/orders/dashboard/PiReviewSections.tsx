'use client'

// THE TOP OF THE APPROVER'S DASHBOARD: what is waiting for their decision.
//
//   PI submitted for review   — full width. Every submitted PI Draft, longest waiting first.
//   PI changes requested      — full width, below it, and drawn ONLY when at least one revised
//                               PI is waiting on an order that is already confirmed.
//
// Both are ONE read each under the reader's own RLS, so a row can never name a PI the reader
// may not open. A failed read draws nothing rather than a false "nothing is waiting". Each row
// is a link to the PI (or the order) where the decision itself is made. Nothing under View As.

import { displayOrderNumber } from '@/lib/orderNumbering'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { withReturnTo } from '@/lib/navigation/recordReturn'
import { draftDetailHref, PI_REVIEW_EMPTY_TEXT } from '@/lib/orders/draftsView'
import { splitRevisionQueue, type RevisionQueueRow } from '@/lib/orders/orderPiVersions'
import { formatDate, formatRupees, formatWaiting } from '@/lib/orders/orderDashboardSummary'

type ReviewRow = {
  id: string
  client: string
  reference: string | null
  by: string | null
  submittedAt: string | null
  value: number | null
}

type ChangeRow = RevisionQueueRow & { client: string; reason: string | null }

type Loaded = {
  review: ReviewRow[]
  changes: ChangeRow[]
  names: Map<string, string>
}

const toNumber = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/** Whole seconds since an ISO instant; 0 when it cannot be read. */
const secondsSince = (iso: string | null): number => {
  const ms = iso ? Date.parse(iso) : NaN
  return Number.isNaN(ms) ? 0 : Math.max(0, Math.floor((Date.now() - ms) / 1000))
}

export function PiReviewSections({ supabase, viewerId, isAdmin, viewingAs }: {
  supabase: SupabaseClient
  viewerId: string | null
  isAdmin: boolean
  viewingAs: boolean
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!viewerId || viewingAs) return
    let live = true
    void (async () => {
      const [subs, revs] = await Promise.all([
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
      ])
      if (!live) return
      if (subs.error) { setFailed(true); return }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const review: ReviewRow[] = ((subs.data ?? []) as any[]).map(r => ({
        id: r.id,
        client: (r.client_name || r.bill_to_name || 'Unnamed client') as string,
        reference: (r.draft_reference as string | null) ?? null,
        by: (r.submitted_by as string | null) ?? null,
        submittedAt: (r.submitted_at as string | null) ?? null,
        value: toNumber(r.subtotal_after_discount),
      }))

      // A refused revisions read (migration not applied) just leaves that section out.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const all: ChangeRow[] = revs.error ? [] : ((revs.data ?? []) as any[]).map(r => ({
        id: r.id, orderId: r.order_id, orderNumber: displayOrderNumber(r.order?.display_number as string | undefined) || '—',
        versionNumber: r.version_number, status: r.status, uploadedBy: r.uploaded_by ?? null,
        uploadedAt: r.uploaded_at, operationsReviewer: r.operations_reviewer ?? null,
        client: (r.order?.client_name as string | undefined) || 'Client not recorded',
        reason: (r.revision_reason as string | null) ?? null,
      }))
      // Only the revisions waiting on THIS reader's decision.
      const mine = new Set(splitRevisionQueue(all, { viewerId, isAdmin, viewingAs }).needsYou.map(r => r.id))
      const changes = all.filter(r => mine.has(r.id))

      const ids = new Set<string>()
      for (const r of review) if (r.by) ids.add(r.by)
      for (const r of changes) if (r.uploadedBy) ids.add(r.uploadedBy)
      let names = new Map<string, string>()
      if (ids.size > 0) {
        const { data: users } = await supabase.from('users').select('id, full_name').in('id', [...ids])
        names = new Map((users ?? []).map((u: { id: string; full_name: string }) => [u.id, u.full_name]))
      }
      if (live) setLoaded({ review, changes, names })
    })()
    return () => { live = false }
  }, [supabase, viewerId, viewingAs, isAdmin])

  if (!viewerId || viewingAs || failed) return null
  if (!loaded) return <div className="pi-q-skeleton" aria-busy="true" aria-label="Loading PIs waiting for review" />
  const nameOf = (id: string | null) => (id ? loaded.names.get(id) ?? null : null)

  return (
    <>
      <section className="pi-q" aria-labelledby="pi-q-review-h">
        <header className="pi-q-head">
          <h2 id="pi-q-review-h" className="pi-q-title">PI submitted for review</h2>
          <span className="pi-q-count">{loaded.review.length}</span>
          <span className="pi-q-hint">Longest waiting first</span>
        </header>
        {loaded.review.length === 0 ? (
          <p className="pi-q-empty">{PI_REVIEW_EMPTY_TEXT}</p>
        ) : (
          <ul className="pi-q-list">
            <li className="pi-q-cols" aria-hidden="true">
              <span>Client</span><span>Submitted by</span><span>Submitted</span><span className="pi-q-r">Product value</span><span />
            </li>
            {loaded.review.map(r => (
              <li key={r.id}>
                <Link href={withReturnTo(draftDetailHref(r.id), '/orders')} className="pi-q-row" prefetch={false}>
                  <span className="pi-q-main">
                    <span className="pi-q-client">{r.client}</span>
                    {r.reference ? <span className="pi-q-sub">{r.reference}</span> : null}
                  </span>
                  <span className="pi-q-cell" data-label="Submitted by">{nameOf(r.by) ?? '—'}</span>
                  <span className="pi-q-cell" data-label="Submitted">
                    {r.submittedAt ? formatDate(r.submittedAt) : '—'}
                    {r.submittedAt ? <span className="pi-q-sub">{formatWaiting(secondsSince(r.submittedAt))} ago</span> : null}
                  </span>
                  <span className="pi-q-cell pi-q-r pi-q-value" data-label="Product value">{r.value !== null ? formatRupees(r.value) : '—'}</span>
                  <ChevronRight size={16} strokeWidth={2} className="pi-q-go" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {loaded.changes.length > 0 ? (
        <section className="pi-q" aria-labelledby="pi-q-changes-h">
          <header className="pi-q-head">
            <h2 id="pi-q-changes-h" className="pi-q-title">PI changes requested</h2>
            <span className="pi-q-count" data-tone="attention">{loaded.changes.length}</span>
            <span className="pi-q-hint">Revised PIs on confirmed orders</span>
          </header>
          <ul className="pi-q-list">
            <li className="pi-q-cols" aria-hidden="true">
              <span>Order</span><span>Requested by</span><span>Requested</span><span className="pi-q-r">Revision</span><span />
            </li>
            {loaded.changes.map(r => (
              <li key={r.id}>
                <Link href={withReturnTo(`/orders/${r.orderId}`, '/orders')} className="pi-q-row" prefetch={false}>
                  <span className="pi-q-main">
                    <span className="pi-q-client">{r.orderNumber} · {r.client}</span>
                    {r.reason ? <span className="pi-q-sub">“{r.reason}”</span> : null}
                  </span>
                  <span className="pi-q-cell" data-label="Requested by">{nameOf(r.uploadedBy) ?? '—'}</span>
                  <span className="pi-q-cell" data-label="Requested">
                    {formatDate(r.uploadedAt)}
                    <span className="pi-q-sub">{formatWaiting(secondsSince(r.uploadedAt))} ago</span>
                  </span>
                  <span className="pi-q-cell pi-q-r" data-label="Revision">PI V{r.versionNumber}</span>
                  <ChevronRight size={16} strokeWidth={2} className="pi-q-go" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  )
}
