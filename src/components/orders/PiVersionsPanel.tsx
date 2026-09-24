'use client'

// ── PI VERSIONS: V1 → V2 → V3, AND EDIT PI (20270103000000) ──────────────────
//
// One strip of cards, one per version, newest last: swipe on a phone, arrows on
// a desktop. Each card says what the version is (current, awaiting a decision,
// rejected, replaced), when, by whom, and what it changed. A pending or rejected
// version stays in the history and never replaces the current one.
//
// The Admin opens a proposed version to see it against the one in force —
// changed fields with old and new values, products added, removed and changed
// with their quantity, price and total deltas, photo changes — and authorizes
// or rejects it there. Authorizing puts nothing in force: Operations accepts
// it (20270101000000), and until then the current version stays usable.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ChevronLeft, ChevronRight, Pencil } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { formatInr } from '@/lib/pi/previewView'
import { notifyPiSubmission } from '@/lib/notify'
import {
  diffPi,
  normalizePi,
  normalizeProposal,
  type NormalizedPi,
  type PiContentImage,
  type PiContentItem,
} from '@/lib/orders/piEdit'
import { EDIT_PI_LABEL, PiDiffView, PiEditor, loadPiContentAsViewer } from './PiEditor'

export type PiVersionRow = {
  id: string
  version_number: number
  status: 'pending' | 'admin_approved' | 'approved' | 'rejected' | 'superseded'
  source_kind: 'workbook' | 'edit'
  uploaded_by: string | null
  uploaded_at: string
  decided_by: string | null
  decided_at: string | null
  revision_reason: string | null
  decision_reason: string | null
  operations_reason: string | null
  proposal: { change_summary?: string[] } | null
}

export const VERSION_STATUS_LABEL: Record<PiVersionRow['status'], string> = {
  approved: 'Current',
  pending: 'Awaiting Admin approval',
  admin_approved: 'Awaiting Operations acceptance',
  rejected: 'Rejected',
  superseded: 'Replaced',
}

const TONE: Record<PiVersionRow['status'], { bg: string; fg: string }> = {
  approved: { bg: colors.greenTint, fg: '#166534' },
  pending: { bg: colors.amberTint, fg: '#9A6212' },
  admin_approved: { bg: colors.amberTint, fg: '#9A6212' },
  rejected: { bg: colors.redTint, fg: '#991B1B' },
  superseded: { bg: colors.raised, fg: colors.secondary },
}

/** The one-line account of what a version is, for its card. */
export function versionSummary(v: PiVersionRow): string {
  if (v.version_number === 1) return 'Original PI'
  const lines = v.proposal?.change_summary
  if (Array.isArray(lines) && lines.length > 0) return lines.join(' · ')
  return v.source_kind === 'workbook' ? 'New workbook uploaded' : 'Edited in the app'
}

/** Whatever a version detail returned, in the comparison's one shape. */
export function normalizeVersionContent(detail: { source: string; content: Record<string, unknown> | null } | null): NormalizedPi | null {
  if (!detail || !detail.content) return null
  const c = detail.content
  if (detail.source === 'proposal') return normalizeProposal(c as { payload: Record<string, unknown>; terms?: Record<string, unknown> })
  if (detail.source === 'staged') return normalizeProposal(c as { payload: Record<string, unknown> })
  if (detail.source === 'captured') {
    return normalizePi({ submission: (c.submission ?? {}) as Record<string, unknown>,
      items: (c.items ?? []) as PiContentItem[], images: (c.images ?? []) as PiContentImage[] })
  }
  if (detail.source === 'snapshot') {
    const order = (c.order ?? {}) as Record<string, unknown>
    return normalizePi({ submission: { client_name: order.client_name, grand_total: order.total_value,
      gross_product_amount: order.total_product_value, billing_percentage: order.billing_percentage },
      items: (c.items ?? []) as PiContentItem[], images: (c.images ?? []) as PiContentImage[] })
  }
  return null
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '')

export function PiVersionsPanel({
  supabase, orderId, submissionId, mayEdit, isAdmin, onChanged, refreshKey,
}: {
  supabase: SupabaseClient
  orderId: string
  submissionId: string
  /** The PI's owner holding orders.create, or an admin (the database re-checks). */
  mayEdit: boolean
  /** An active admin, not under View As: may authorize or reject a pending version. */
  isAdmin: boolean
  onChanged: () => void
  /** Changes whenever the page re-reads the versions (e.g. after Operations
   *  accepts one in #205's dialog), so this strip never shows a stale state. */
  refreshKey?: string
}) {
  const [versions, setVersions] = useState<PiVersionRow[] | null>(null)
  const [names, setNames] = useState<Record<string, string>>({})
  const [readError, setReadError] = useState(false)
  const [editing, setEditing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [open, setOpen] = useState<PiVersionRow | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const strip = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      const { data, error } = await supabase.from('order_pi_versions')
        .select('id, version_number, status, source_kind, uploaded_by, uploaded_at, decided_by, decided_at, revision_reason, decision_reason, operations_reason, proposal')
        .eq('order_id', orderId).order('version_number', { ascending: true })
      if (!live) return
      if (error) { setReadError(true); return }
      const rows = (data ?? []) as unknown as PiVersionRow[]
      setVersions(rows)
      const ids = [...new Set(rows.flatMap(r => [r.uploaded_by, r.decided_by]).filter((x): x is string => !!x))]
      if (ids.length > 0) {
        const { data: people } = await supabase.from('users').select('id, full_name').in('id', ids)
        if (live && people) setNames(Object.fromEntries((people as { id: string; full_name: string }[]).map(p => [p.id, p.full_name])))
      }
    })()
    return () => { live = false }
  }, [supabase, orderId, reloadKey, refreshKey])

  // Open on the current version, so the newest decision is one swipe away.
  useEffect(() => {
    const i = versions?.findIndex(v => v.status === 'approved') ?? -1
    const el = strip.current?.children[i] as HTMLElement | undefined
    if (el && strip.current) strip.current.scrollLeft = el.offsetLeft - strip.current.offsetLeft
  }, [versions])

  const scroll = (dir: -1 | 1) => strip.current?.scrollBy({ left: dir * (strip.current.clientWidth * 0.8), behavior: 'smooth' })
  const hasOpenRevision = !!versions?.some(v => v.status === 'pending' || v.status === 'admin_approved')
  const refresh = useCallback(() => { setReloadKey(k => k + 1); onChanged() }, [onChanged])

  if (readError) return null
  return (
    <section aria-label="PI versions" style={{
      border: `1px solid ${colors.border}`, borderRadius: '10px', background: colors.base, padding: '12px 14px',
      display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <div style={{ fontSize: '13px', fontWeight: 700, color: colors.primary, flex: 1 }}>PI versions</div>
        <button type="button" className="boe-btn boe-btn-ghost" aria-label="Previous version" onClick={() => scroll(-1)}><ChevronLeft size={15} /></button>
        <button type="button" className="boe-btn boe-btn-ghost" aria-label="Next version" onClick={() => scroll(1)}><ChevronRight size={15} /></button>
        {mayEdit && (
          <button type="button" className="boe-btn boe-btn-primary" disabled={hasOpenRevision}
            title={hasOpenRevision ? 'A revised PI is already waiting for a decision.' : undefined}
            onClick={() => { setNotice(null); setEditing(true) }}>
            <Pencil size={13} /> {EDIT_PI_LABEL}
          </button>
        )}
      </div>
      {mayEdit && hasOpenRevision && (
        <div style={{ fontSize: '11.5px', color: colors.muted }}>A revised PI is waiting for a decision; Edit PI is available again once it is decided.</div>
      )}
      {notice && <div role="status" style={{ fontSize: '12px', color: '#166534' }}>{notice}</div>}

      <div ref={strip} className="pi-version-strip" style={{
        display: 'flex', gap: '10px', overflowX: 'auto', scrollSnapType: 'x mandatory', paddingBottom: '4px',
        WebkitOverflowScrolling: 'touch',
      }}>
        {versions === null && <div style={{ fontSize: '12px', color: colors.muted }}>Loading versions…</div>}
        {versions?.map(v => (
          <article key={v.id} aria-label={`PI V${v.version_number}`} style={{
            flex: '0 0 min(280px, 85%)', scrollSnapAlign: 'start', border: `1px solid ${v.status === 'approved' ? '#45A870' : colors.border}`,
            borderRadius: '9px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '6px', background: colors.base,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <strong style={{ fontSize: '14px' }}>V{v.version_number}</strong>
              <span style={{ fontSize: '11px', fontWeight: 700, padding: '2px 7px', borderRadius: '999px', background: TONE[v.status].bg, color: TONE[v.status].fg }}>
                {VERSION_STATUS_LABEL[v.status]}
              </span>
            </div>
            <div style={{ fontSize: '11.5px', color: colors.muted }}>
              {when(v.uploaded_at)}{v.uploaded_by && names[v.uploaded_by] ? ` · ${names[v.uploaded_by]}` : ''}
              {v.source_kind === 'edit' ? ' · edited in the app' : v.version_number > 1 ? ' · new workbook' : ''}
            </div>
            <div style={{ fontSize: '12.5px', color: colors.primary, lineHeight: 1.4 }}>{versionSummary(v)}</div>
            {v.source_kind === 'edit' && v.status === 'approved' && (
              <div style={{ fontSize: '11.5px', color: colors.secondary }}>
                These details are the PI in force; confirmed documents are generated from them. The original uploaded workbook is kept unchanged as V1&apos;s file.
              </div>
            )}
            {v.revision_reason && v.version_number > 1 && (
              <div style={{ fontSize: '11.5px', color: colors.secondary }}>Reason: {v.revision_reason}</div>
            )}
            {v.status === 'rejected' && (v.decision_reason || v.operations_reason) && (
              <div style={{ fontSize: '11.5px', color: '#991B1B' }}>Rejected: {v.operations_reason ?? v.decision_reason}</div>
            )}
            {v.decided_at && v.status !== 'pending' && (
              <div style={{ fontSize: '11px', color: colors.muted }}>
                Decided {when(v.decided_at)}{v.decided_by && names[v.decided_by] ? ` by ${names[v.decided_by]}` : ''}
              </div>
            )}
            <button type="button" className="boe-btn boe-btn-ghost" style={{ alignSelf: 'flex-start', marginTop: 'auto' }}
              onClick={() => setOpen(v)}>
              {isAdmin && v.status === 'pending' ? 'Review changes' : 'View'}
            </button>
          </article>
        ))}
      </div>

      {editing && (
        <PiEditor supabase={supabase} mode="propose" submissionId={submissionId} orderId={orderId}
          onClose={() => setEditing(false)}
          onDone={message => {
            setEditing(false); setNotice(message)
            void notifyPiSubmission({ event: 'pi_revision_proposed', submissionId })
            refresh()
          }} />
      )}
      {open && (
        <PiVersionDialog supabase={supabase} version={open} submissionId={submissionId} isAdmin={isAdmin}
          onClose={() => setOpen(null)}
          onDecided={message => { setOpen(null); setNotice(message); refresh() }} />
      )}
    </section>
  )
}

/** One version: its products and figures, and — while proposed — how it differs from the one in force. */
function PiVersionDialog({ supabase, version, submissionId, isAdmin, onClose, onDecided }: {
  supabase: SupabaseClient
  version: PiVersionRow
  submissionId: string
  isAdmin: boolean
  onClose: () => void
  onDecided: (message: string) => void
}) {
  const [content, setContent] = useState<NormalizedPi | null>(null)
  const [current, setCurrent] = useState<NormalizedPi | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      const live$ = await loadPiContentAsViewer(supabase, submissionId)
      const cur = live$ ? normalizePi(live$) : null
      if (!live) return
      setCurrent(cur)
      if (version.status === 'approved') { setContent(cur); return }
      const { data, error } = await supabase.rpc('order_pi_version_detail', { p_version_id: version.id })
      if (!live) return
      const n = error ? null : normalizeVersionContent(data as { source: string; content: Record<string, unknown> | null })
      if (n) setContent(n); else setUnavailable(true)
    })()
    return () => { live = false }
  }, [supabase, submissionId, version])

  const open = version.status === 'pending' || version.status === 'admin_approved'
  const diff = useMemo(() => (open && content && current ? diffPi(current, content) : null), [open, content, current])

  const approve = async () => {
    setBusy(true); setFailure(null)
    try {
      const res = await fetch('/api/orders/pi-revisions/approve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ versionId: version.id }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { setFailure(body.message ?? 'This revision could not be approved just now.'); return }
      void notifyPiSubmission({ event: 'pi_revision_approved', submissionId })
      onDecided(`PI V${version.version_number} approved. It takes effect when Operations accepts it; the current PI stays in force until then.`)
    } finally { setBusy(false) }
  }
  const reject = async () => {
    setBusy(true); setFailure(null)
    try {
      const { error } = await supabase.rpc('reject_order_pi_revision', { p_version_id: version.id, p_reason: reason.trim() })
      if (error) { setFailure('This revision could not be rejected just now.'); return }
      void notifyPiSubmission({ event: 'pi_revision_rejected', submissionId })
      onDecided(`PI V${version.version_number} rejected. The current PI is unchanged.`)
    } finally { setBusy(false) }
  }

  return (
    <div className="boe-modal-overlay" role="dialog" aria-modal="true" aria-label={`PI V${version.version_number}`}>
      <div className="boe-modal-sheet" style={{ maxWidth: '860px' }}>
        <div className="boe-modal-header" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <strong style={{ flex: 1, fontSize: '15px' }}>PI V{version.version_number} · {VERSION_STATUS_LABEL[version.status]}</strong>
          <button type="button" className="boe-btn boe-btn-ghost" onClick={onClose} disabled={busy}>Close</button>
        </div>
        <div className="boe-modal-body">
          {unavailable && (
            <div style={{ fontSize: '12.5px', color: colors.muted }}>
              {version.source_kind === 'workbook' && version.status === 'pending'
                ? 'This revision is a new workbook. Its contents are read when an Admin approves it; open the workbook from PI history to see it.'
                : 'The contents of this version were not recorded in the app.'}
            </div>
          )}
          {diff && (
            <div style={{ border: `1px solid ${colors.border}`, borderRadius: '8px', padding: '10px 12px' }}>
              <div style={{ fontWeight: 700, fontSize: '12.5px', marginBottom: '6px' }}>Compared with the PI in force</div>
              <PiDiffView diff={diff} />
            </div>
          )}
          {content && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
                <thead><tr style={{ textAlign: 'left', color: colors.muted, fontSize: '11px' }}>
                  <th>Product</th><th>Qty</th><th>Price</th><th style={{ textAlign: 'right' }}>Total</th></tr></thead>
                <tbody>
                  {content.lines.map(l => (
                    <tr key={l.id} style={{ borderTop: `1px solid ${colors.border}` }}>
                      <td style={{ padding: '5px 6px 5px 0' }}><strong>{l.name}</strong>{l.description ? <div style={{ color: colors.muted, fontSize: '11.5px' }}>{l.description}</div> : null}</td>
                      <td>{l.quantity ?? ''}</td>
                      <td>{l.rate === null ? '' : formatInr(l.rate)}</td>
                      <td style={{ textAlign: 'right' }}>{l.total === null ? '' : formatInr(l.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ textAlign: 'right', fontWeight: 700, marginTop: '6px' }}>
                Grand total {content.grandTotal === null ? 'not recorded' : formatInr(content.grandTotal)}
              </div>
            </div>
          )}
          {isAdmin && version.status === 'pending' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', borderTop: `1px solid ${colors.border}`, paddingTop: '10px' }}>
              {rejecting ? (
                <>
                  <label style={{ fontSize: '12px', fontWeight: 600 }}>Why is it rejected? *
                    <textarea rows={2} maxLength={1000} value={reason} onChange={e => setReason(e.target.value)}
                      style={{ width: '100%', boxSizing: 'border-box', marginTop: '4px', padding: '7px', borderRadius: '6px', border: `1px solid ${colors.border}` }} />
                  </label>
                  <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                    <button type="button" className="boe-btn boe-btn-ghost" onClick={() => setRejecting(false)} disabled={busy}>Back</button>
                    <button type="button" className="boe-btn boe-btn-primary" disabled={busy || reason.trim() === ''} onClick={() => void reject()}>Reject PI V{version.version_number}</button>
                  </div>
                </>
              ) : (
                <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                  <span style={{ flex: 1, fontSize: '11.5px', color: colors.muted, minWidth: '200px' }}>
                    Approving authorizes it. It takes effect when Operations accepts it; the current PI stays in force until then.
                  </span>
                  <button type="button" className="boe-btn boe-btn-ghost" onClick={() => setRejecting(true)} disabled={busy}>Reject…</button>
                  <button type="button" className="boe-btn boe-btn-primary" onClick={() => void approve()} disabled={busy}>
                    {busy ? 'Approving…' : `Approve PI V${version.version_number}`}
                  </button>
                </div>
              )}
            </div>
          )}
          {failure && <div role="alert" style={{ color: colors.red, fontSize: '12.5px' }}>{failure}</div>}
        </div>
      </div>
    </div>
  )
}
