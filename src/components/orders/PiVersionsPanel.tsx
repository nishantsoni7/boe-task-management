'use client'

// ── PI HISTORY: V1 → V2 → V3, AND EDIT PI (20270115000000) ───────────────────
//
// A popup opened from the Main PI row of the Documents card, listing one entry
// per version, oldest first. Each says what the version is (current, awaiting a
// decision, rejected, replaced), when, by whom, and what it changed. A pending
// or rejected version stays in the history and never replaces the current one.
// It used to be a standalone strip under Documents; it is the same data, the
// same View / Review changes doors and the same Edit PI editor, now on demand.
//
// PI HISTORY IS NOT DOCUMENT HISTORY. The Documents header's "Document history"
// is the file trail — every uploaded workbook and every Design Files / Client PO
// submission. This is the PI's versions and their decisions.
//
// The Admin opens a proposed version to see it against the one in force —
// changed fields with old and new values, products added, removed and changed
// with their quantity, price and total deltas, photo changes — and authorizes
// or rejects it there. Approving puts it in force and amends the Order to its
// values (20270116000000); Operations is then sent it for review. Every version
// opens its own PDF, rendered from its own content.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Pencil } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { OrderModalShell } from '@/app/orders/[id]/OrderStatusWorkspace'
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
import { EDIT_PI_LABEL, PiDiffView, loadPiContentAsViewer } from './PiEditor'
import { PiLineReview, requestPiRevisionApproval, type PiLineReviewData } from './PiLineReview'
import { percentText, rupees, type AdvanceReadiness } from '@/lib/orders/advanceReadiness'
import {
  PI_EDITED_VERSION_WORKBOOK_NOTE,
  PI_VERSION_PDF_DOWNLOAD_LABEL,
  PI_VERSION_PDF_VIEW_LABEL,
  piVersionPdfHref,
} from '@/lib/orders/piVersionPdf'
import { ORDER_FILES_BUCKET } from '@/lib/orders/draftsView'
import { PI_VERSIONS_HISTORY_LABEL } from '@/lib/orders/orderDocumentsPanel'
import { ORDER_PI_WORKBOOK_URL_TTL_SECONDS } from '@/lib/orders/orderPiHandoff'
import { approvalAdvanceNote, type WorkbookLineReview } from '@/lib/orders/workbookRevisionPreview'

/** What an Admin reads above a revised workbook's comparison. */
export const WORKBOOK_PREVIEW_NOTE =
  'Read from the revised workbook on this device. The server reads the workbook again when you approve, and that is what is applied.'
export const WORKBOOK_PREVIEW_LOADING = 'Reading the revised workbook…'
export const WORKBOOK_PREVIEW_FAILED =
  'The revised workbook could not be read here, so its changes cannot be shown. Open it from Document history before deciding.'

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
  /** A revised workbook's file, read for the Admin's preview before approval. */
  workbook_path?: string | null
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

export const PI_HISTORY_INTRO = 'Every version of this Order’s PI, oldest first. Open one to see its products, figures and PDF.'
export const PI_HISTORY_EMPTY = 'No PI versions are recorded for this Order yet.'
export const PI_HISTORY_READ_FAILED = 'The PI versions could not be read just now. Close this and try again.'
export const EDIT_PI_BLOCKED_NOTE =
  'A revised PI is waiting for a decision; Edit PI is available again once it is decided.'

/** A version that still waits for a decision blocks a second proposal. */
export const isOpenRevision = (status: string) => status === 'pending' || status === 'admin_approved'

/**
 * THE PI HISTORY POPUP AND THE EDIT PI EDITOR, both opened by the page.
 *
 * The page draws the two triggers (in the Documents card's Main PI row) and
 * owns whether each is open; this component owns what they show. The versions
 * are read when the popup opens and again whenever the page's own version read
 * changes (refreshKey), so it never shows a stale state.
 *
 * Opening one version DRILLS IN: the list closes while that version's dialog is
 * open and comes back when it closes, so two dialogs never compete for Escape.
 */
export function PiVersionHistory({
  supabase, orderId, submissionId, mayEdit, isAdmin, hasOpenRevision = false,
  open, onClose, onEdit, notice, onNotice, onChanged, refreshKey,
}: {
  supabase: SupabaseClient
  orderId: string
  submissionId: string
  /** The PI's owner holding orders.create, or an admin (the database re-checks). */
  mayEdit: boolean
  /** An active admin, not under View As: may authorize or reject a pending version. */
  isAdmin: boolean
  /** The page's own read says a revision is waiting for a decision. */
  hasOpenRevision?: boolean
  open: boolean
  onClose: () => void
  editing: boolean
  onEdit: () => void
  onEditClose: () => void
  /** The last outcome (a proposal sent, a version decided), said in the popup too. */
  notice: string | null
  onNotice: (message: string) => void
  onChanged: () => void
  /** Changes whenever the page re-reads the versions (e.g. after Operations
   *  accepts one in #205's dialog). */
  refreshKey?: string
}) {
  const [versions, setVersions] = useState<PiVersionRow[] | null>(null)
  const [names, setNames] = useState<Record<string, string>>({})
  const [readError, setReadError] = useState(false)
  const [viewing, setViewing] = useState<PiVersionRow | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    // Read only while somebody is looking: a closed popup costs no request.
    if (!open) return
    let live = true
    void (async () => {
      setReadError(false)
      const { data, error } = await supabase.from('order_pi_versions')
        .select('id, version_number, status, source_kind, uploaded_by, uploaded_at, decided_by, decided_at, revision_reason, decision_reason, operations_reason, proposal, workbook_path')
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
  }, [supabase, orderId, open, reloadKey, refreshKey])

  const blocked = hasOpenRevision || !!versions?.some(v => isOpenRevision(v.status))
  const refresh = useCallback(() => { setReloadKey(k => k + 1); onChanged() }, [onChanged])

  return (
    <>
      {open && !viewing && (
        <OrderModalShell title={PI_VERSIONS_HISTORY_LABEL} onClose={onClose} wide>
          <div className="pi-history-toolbar">
            <p className="pi-history-intro">{PI_HISTORY_INTRO}</p>
            {mayEdit && (
              <button type="button" className="boe-btn boe-btn-ghost order-status-action" disabled={blocked}
                title={blocked ? EDIT_PI_BLOCKED_NOTE : undefined}
                onClick={onEdit}>
                <Pencil size={13} aria-hidden="true" /> {EDIT_PI_LABEL}
              </button>
            )}
          </div>
          {mayEdit && blocked && <p className="order-doc-note">{EDIT_PI_BLOCKED_NOTE}</p>}
          {notice && <p role="status" className="pi-history-notice">{notice}</p>}

          {readError ? (
            <p className="order-doc-unavailable" role="alert">{PI_HISTORY_READ_FAILED}</p>
          ) : versions === null ? (
            <p className="order-doc-loading" role="status">Loading versions…</p>
          ) : versions.length === 0 ? (
            <p className="order-status-empty">{PI_HISTORY_EMPTY}</p>
          ) : (
            <ol className="order-history-list">
              {versions.map(v => (
                <li key={v.id} aria-label={`PI V${v.version_number}`}
                  className={v.status === 'approved' ? 'order-history-row order-history-row--current' : 'order-history-row'}>
                  <div className="order-history-row-head">
                    <span className="order-history-version">V{v.version_number}</span>
                    <span className="pi-history-pill" style={{ background: TONE[v.status].bg, color: TONE[v.status].fg }}>
                      {VERSION_STATUS_LABEL[v.status]}
                    </span>
                  </div>
                  <div className="order-history-meta">
                    {when(v.uploaded_at)}{v.uploaded_by && names[v.uploaded_by] ? ` · ${names[v.uploaded_by]}` : ''}
                    {v.source_kind === 'edit' ? ' · edited in the app' : v.version_number > 1 ? ' · new workbook' : ''}
                  </div>
                  <div className="pi-history-summary">{versionSummary(v)}</div>
                  {v.source_kind === 'edit' && v.status === 'approved' && (
                    <div className="order-history-meta">{PI_EDITED_VERSION_WORKBOOK_NOTE(v.version_number)}</div>
                  )}
                  {v.revision_reason && v.version_number > 1 && (
                    <div className="order-history-meta">Reason: {v.revision_reason}</div>
                  )}
                  {v.status === 'rejected' && (v.decision_reason || v.operations_reason) && (
                    <div className="pi-history-rejected">Rejected: {v.operations_reason ?? v.decision_reason}</div>
                  )}
                  {v.decided_at && v.status !== 'pending' && (
                    <div className="order-history-meta">
                      Decided {when(v.decided_at)}{v.decided_by && names[v.decided_by] ? ` by ${names[v.decided_by]}` : ''}
                    </div>
                  )}
                  <div className="order-history-actions">
                    <button type="button" className="boe-btn boe-btn-ghost order-status-action" onClick={() => setViewing(v)}>
                      {isAdmin && v.status === 'pending' ? 'Review changes' : `View V${v.version_number}`}
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </OrderModalShell>
      )}

      {viewing && (
        <PiVersionDialog supabase={supabase} version={viewing} orderId={orderId} submissionId={submissionId} isAdmin={isAdmin}
          onClose={() => setViewing(null)}
          onDecided={message => { setViewing(null); onNotice(message); refresh() }} />
      )}

      {/* Edit PI is a page now (/orders/[id]/edit-pi); onEdit navigates there. */}
    </>
  )
}

/** One version: its products and figures, and — while proposed — how it differs from the one in force. */
function PiVersionDialog({ supabase, version, orderId, submissionId, isAdmin, onClose, onDecided }: {
  supabase: SupabaseClient
  version: PiVersionRow
  orderId: string
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
  const [review, setReview] = useState<PiLineReviewData | null>(null)
  // A pending revised WORKBOOK, read on this device so the Admin sees what they approve.
  const [workbookPreview, setWorkbookPreview] = useState<'loading' | 'ready' | 'failed' | null>(null)
  const [linesToMatch, setLinesToMatch] = useState<WorkbookLineReview[]>([])
  const [verified, setVerified] = useState<number | null>(null)

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
      if (n) { setContent(n); return }

      // A REVISED WORKBOOK has no recorded contents until it is approved. Read
      // it here, with the parser the upload uses, and map it as the approval does.
      if (version.source_kind === 'workbook' && version.status === 'pending' && version.workbook_path && live$) {
        setWorkbookPreview('loading')
        try {
          const { data: signed, error: urlError } = await supabase.storage.from(ORDER_FILES_BUCKET)
            .createSignedUrl(version.workbook_path, ORDER_PI_WORKBOOK_URL_TTL_SECONDS)
          if (urlError || !signed?.signedUrl) throw new Error('no url')
          const res = await fetch(signed.signedUrl)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const bytes = new Uint8Array(await res.arrayBuffer())
          const [{ parseBoePiWorkbook }, { previewWorkbookRevision }] = await Promise.all([
            import('@/lib/pi/masterSheetParser'), import('@/lib/orders/workbookRevisionPreview'),
          ])
          const parsed = await parseBoePiWorkbook(bytes)
          if (!parsed.ok) throw new Error('unreadable')
          const preview = await previewWorkbookRevision(parsed.data, live$)
          if (!live) return
          setContent(preview.pi); setLinesToMatch(preview.needsReview); setWorkbookPreview('ready')
          return
        } catch {
          if (!live) return
          setWorkbookPreview('failed')
        }
      }
      setUnavailable(true)
    })()
    return () => { live = false }
  }, [supabase, submissionId, version])

  // THE VERIFIED ADVANCE, so the Admin reads what approval does to the 40% position.
  useEffect(() => {
    if (version.status !== 'pending') return
    let live = true
    void (async () => {
      const { data, error } = await supabase.rpc('order_advance_readiness', { p_order_id: orderId })
      if (!live || error || !data) return
      const v = Number((data as AdvanceReadiness).verified)
      if (Number.isFinite(v)) setVerified(v)
    })()
    return () => { live = false }
  }, [supabase, orderId, version.status])

  const open = version.status === 'pending' || version.status === 'admin_approved'
  const diff = useMemo(() => (open && content && current ? diffPi(current, content) : null), [open, content, current])

  const approve = async (lineMap?: Record<string, string>) => {
    setBusy(true); setFailure(null)
    try {
      const { ok, body, review: needsReview } = await requestPiRevisionApproval(version.id, lineMap)
      // A revised WORKBOOK whose lines cannot all be matched by item number:
      // the admin matches them here, and approves again (20270116000000).
      if (needsReview) { setReview(needsReview); return }
      if (!ok) { setFailure(typeof body.message === 'string' ? body.message : 'This revision could not be approved just now.'); return }
      setReview(null)
      void notifyPiSubmission({ event: 'pi_revision_approved', submissionId })
      const adv = body.advance as AdvanceReadiness | undefined
      const short = adv && adv.below && !adv.ready
        ? ` The verified advance is now ${percentText(adv.percent)} of the new value: ${rupees(adv.shortfall)} more must be verified, or production approved below 40%, before Operations can align production.`
        : ''
      onDecided(`PI V${version.version_number} approved — it is now the PI in force${body.order_amendment ? ', and the Order was amended to its values' : ''}. Operations has been sent it for review.${short}`)
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
          {/* THIS version's own PDF, rendered from its own content (20270116000000). */}
          {content && !unavailable && workbookPreview !== 'ready' && (
            <>
              <button type="button" className="boe-btn boe-btn-ghost"
                onClick={() => window.open(piVersionPdfHref(orderId, version.id, false), '_blank', 'noopener,noreferrer')}>
                {PI_VERSION_PDF_VIEW_LABEL(version.version_number)}
              </button>
              <button type="button" className="boe-btn boe-btn-ghost" aria-label={`Download PI V${version.version_number} as PDF`}
                onClick={() => window.open(piVersionPdfHref(orderId, version.id, true), '_blank', 'noopener,noreferrer')}>
                {PI_VERSION_PDF_DOWNLOAD_LABEL}
              </button>
            </>
          )}
          <button type="button" className="boe-btn boe-btn-ghost" onClick={onClose} disabled={busy}>Close</button>
        </div>
        <div className="boe-modal-body">
          {workbookPreview === 'loading' && (
            <div role="status" style={{ fontSize: '12.5px', color: colors.muted }}>{WORKBOOK_PREVIEW_LOADING}</div>
          )}
          {unavailable && (
            <div role={workbookPreview === 'failed' ? 'alert' : undefined} style={{ fontSize: '12.5px', color: workbookPreview === 'failed' ? '#991B1B' : colors.muted }}>
              {workbookPreview === 'failed'
                ? WORKBOOK_PREVIEW_FAILED
                : version.source_kind === 'workbook' && version.status === 'pending'
                  ? 'This revision is a new workbook. Its contents are read when an Admin approves it; open the workbook from Document history to see it.'
                  : 'The contents of this version were not recorded in the app.'}
            </div>
          )}
          {workbookPreview === 'ready' && (
            <div style={{ fontSize: '11.5px', color: colors.muted }}>{WORKBOOK_PREVIEW_NOTE}</div>
          )}
          {linesToMatch.length > 0 && (
            <div style={{ fontSize: '12px', color: '#9A6212', background: colors.amberTint, borderRadius: '7px', padding: '8px 10px' }}>
              {linesToMatch.length} line{linesToMatch.length === 1 ? '' : 's'} cannot be matched by item number and are shown as new here;
              approving asks you to match {linesToMatch.length === 1 ? 'it' : 'them'} first: {linesToMatch.map(l => `${l.name} (${l.why})`).join('; ')}.
            </div>
          )}
          {open && content && (() => {
            const note = approvalAdvanceNote(verified, content.grandTotal)
            return note ? (
              <div role="note" style={{ fontSize: '12px', color: '#9A6212', background: colors.amberTint, borderRadius: '7px', padding: '8px 10px' }}>{note}</div>
            ) : null
          })()}
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
                    Approving puts it in force now and amends the Order to its values (recorded with the old and new values). Operations is then sent it for review.
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
          {review && (
            <PiLineReview versionNumber={version.version_number} review={review} busy={busy}
              onConfirm={lineMap => { void approve(lineMap) }} onCancel={() => setReview(null)} />
          )}
        </div>
      </div>
    </div>
  )
}
