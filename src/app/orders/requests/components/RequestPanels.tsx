'use client'

// ── Order Request detail panels ───────────────────────────────────────────────
// The read + linkage surfaces of one Order Request: status badge, label/value
// rows, attachments, the payments attached to the request, the payment-link
// search panel, and the two payment dialogs (view / unlink).
//
// Moved out of the Order Requests list page when the detail experience became
// its own route (/orders/requests/[id]). Every backend path is unchanged: the
// two linkage RPCs, the private attachment bucket's signed URLs, and the
// viewer's own RLS on finance_payment_requests / order_request_attachments.
//
// The attachments and payments panels are PRESENTATIONAL — the detail page owns
// those queries, because it also needs their results for the attention banner
// and the commercial summary, and one page must not fetch the same rows twice.

import { useEffect, useRef, useState } from 'react'
import type { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import { FileSpreadsheet, Paperclip } from 'lucide-react'
import {
  FinanceModal,
  RequestModalShell,
  useModalScrollLockAndEscape,
  FINANCE_MODAL_OVERLAY_Z,
  FINANCE_MODAL_DIALOG_Z,
} from '@/app/finance/components/FinanceModalShell'
import { PaymentProofView } from '@/components/PaymentProofView'
import { PaymentRequestActivity } from '@/components/PaymentRequestActivity'
import {
  ORDER_REQ_ATTACHMENT_BUCKET,
  ORDER_REQ_ATTACHMENT_MAX_BYTES,
  MAIN_PI_ACCEPT,
  MAIN_PI_TYPES_LABEL,
  REFERENCE_ACCEPT,
  REFERENCE_TYPES_LABEL,
  formatBytes,
} from '@/lib/orderRequestAttachments'
import {
  EMPTY_ATTACHMENT_EDITS,
  type AttachmentEdits,
  type StagedAttachment,
} from './RequestInlineEdit'
import {
  buildSuspenseSearchConds,
  canManagePayments,
  fmtAmount,
  fmtDate,
  friendlyLinkError,
  paymentStatusMeta,
  previewKindOf,
  PAYMENT_MODE_LABEL,
  RECEIVED_IN_LABEL,
  STATUS_META,
  SUSPENSE_PAGE_SIZE,
  type LinkedPayment,
  type OrderRequest,
  type RequestAttachmentRow,
  type SuspensePayment,
} from './shared'

// ── Small shared primitives ───────────────────────────────────────────────────

export function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { label: status, bg: '#F3F4F6', color: '#4B5563', border: '#E5E7EB' }
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: '5px',
      background: meta.bg, color: meta.color,
      border: `1px solid ${meta.border}`,
      fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      {meta.label}
    </span>
  )
}

// Compact horizontal label–value row: muted uppercase label on the left, darker
// value on the right, hairline separator between rows (suppressed on the last
// row so panel height tracks content exactly).
export function DetailRow({ label, value, muted, last }: {
  label: string
  value: React.ReactNode
  muted?: boolean
  last?: boolean
}) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '16px',
      padding: '9px 0', borderBottom: last ? 'none' : `1px solid ${colors.border}`,
    }}>
      <span style={{ fontSize: '11px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap', flexShrink: 0 }}>
        {label}
      </span>
      <span style={{ fontSize: '14px', color: muted ? colors.muted : colors.primary, textAlign: 'right', wordBreak: 'break-word', minWidth: 0, lineHeight: 1.4 }}>
        {value}
      </span>
    </div>
  )
}

// Compact uppercase section label, as used across the Finance detail surfaces.
export function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: '11px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
      {children}
    </div>
  )
}

// ── Payment-link panel (order-first workflow) ─────────────────────────────────
// Reuses the SAME guarded backend path Finance's Link modal uses —
// link_finance_payment_to_order_request (20260698) — never a direct column
// update and never a second RPC. Suspense eligibility mirrors Finance exactly:
// approved_unlinked, order_id null, order_request_id null. Nothing loads until
// the user explicitly searches or views all.

export function RequestPaymentLinkPanel({
  request,
  supabase,
  searchInputRef,
  ownOnlyUserId,
  onLinked,
}: {
  request: OrderRequest
  supabase: ReturnType<typeof createClient>
  searchInputRef: React.RefObject<HTMLInputElement | null>
  // Non-null for a non-admin: the panel then queries only payments THIS user
  // submitted, so a requester can never page through the company's suspense
  // ledger. finance_payment_requests RLS already limits them to their own
  // submissions (plus payments already attached to a request they own, which
  // are excluded here by the order_request_id IS NULL filter) — this filter is
  // the visible, intentional half of the same rule, not its only enforcement.
  ownOnlyUserId: string | null
  onLinked: (payment: SuspensePayment) => void
}) {
  const [query,     setQuery]     = useState('')
  // The term that actually produced the current search results — Show more
  // paginates against THIS, not the live input box, so editing the box after a
  // search never silently re-filters the loaded page.
  const [searchedTerm, setSearchedTerm] = useState('')
  const [mode,      setMode]      = useState<'search' | 'all' | null>(null)
  const [limit,     setLimit]     = useState(SUSPENSE_PAGE_SIZE)
  const [results,   setResults]   = useState<SuspensePayment[]>([])
  const [hasMore,   setHasMore]   = useState(false)
  const [searching, setSearching] = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  // Guidance shown when a Search term has no usable token after sanitisation
  // (e.g. "₹", ",,,", "()", spaces). Distinct from `error`; never triggers a query.
  const [inputNotice, setInputNotice] = useState<string | null>(null)
  const [confirmTarget, setConfirmTarget] = useState<SuspensePayment | null>(null)
  const [linking,   setLinking]   = useState(false)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRow = (p: any): SuspensePayment => ({
    id: p.id,
    request_number: p.request_number,
    client_name: p.client_name,
    amount: Number(p.amount),
    payment_date: p.payment_date,
    payment_mode: p.payment_mode,
    received_in: p.received_in,
    proof_note: p.proof_note ?? null,
    sales_note: p.sales_note ?? null,
  })

  // One eligibility filter, shared by search and view-all: exactly the rows
  // Finance treats as suspense. Fetches limit+1 to detect "Show more" without
  // a second count query.
  // `searchConds` is required for a 'search' fetch and ignored for 'all'. A
  // 'search' fetch with no conditions is refused outright, so a Search action
  // can never silently degrade into an unfiltered View-all query.
  const runFetch = async (m: 'search' | 'all', lim: number, searchConds?: string[]) => {
    if (m === 'search' && (!searchConds || searchConds.length === 0)) return

    setSearching(true)
    setError(null)
    let q = supabase
      .from('finance_payment_requests')
      .select('id, request_number, client_name, amount, payment_date, payment_mode, received_in, proof_note, sales_note')
      .eq('status', 'approved_unlinked')
      .is('order_id', null)
      .is('order_request_id', null)
      // Newest received first; id is a deterministic tiebreak so same-date rows
      // keep a stable order across "Show more" refetches (no drift/duplication).
      .order('payment_date', { ascending: false })
      .order('id', { ascending: false })
      .limit(lim + 1)

    // Non-admin: own submissions only, applied to search AND view-all alike so
    // neither path can widen into the full ledger.
    if (ownOnlyUserId) q = q.eq('submitted_by', ownOnlyUserId)

    // View-all applies only the eligibility filter above; search adds the
    // pre-built .or() conditions (never rebuilt from the live input here).
    if (m === 'search' && searchConds) q = q.or(searchConds.join(','))

    const { data, error: dbErr } = await q
    if (dbErr) {
      setResults([])
      setHasMore(false)
      setError('Could not load suspense payments. Please try again.')
      setSearching(false)
      return
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (data ?? []) as any[]
    setHasMore(rows.length > lim)
    setResults(rows.slice(0, lim).map(mapRow))
    setSearching(false)
  }

  const handleSearch = () => {
    const raw = query.trim()
    const conds = buildSuspenseSearchConds(raw)
    // Nothing usable survived sanitisation ("₹", ",,,", "()", spaces): show
    // guidance and run no query — this is NOT a View-all.
    if (conds.length === 0) {
      setInputNotice('Enter a payment reference, payer, amount or date.')
      setError(null)
      setConfirmTarget(null)
      setMode(null)
      setResults([])
      setHasMore(false)
      return
    }
    setInputNotice(null)
    setSearchedTerm(raw)
    setMode('search')
    setLimit(SUSPENSE_PAGE_SIZE)
    setConfirmTarget(null)
    runFetch('search', SUSPENSE_PAGE_SIZE, conds)
  }

  const handleViewAll = () => {
    setInputNotice(null)
    setMode('all')
    setLimit(SUSPENSE_PAGE_SIZE)
    setConfirmTarget(null)
    runFetch('all', SUSPENSE_PAGE_SIZE)
  }

  const handleShowMore = () => {
    if (!mode) return
    const next = limit + SUSPENSE_PAGE_SIZE
    setLimit(next)
    // Show more preserves the mode and, in search mode, the ORIGINAL executed
    // term (searchedTerm) — not whatever is currently typed in the box.
    if (mode === 'search') runFetch('search', next, buildSuspenseSearchConds(searchedTerm))
    else runFetch('all', next)
  }

  const handleConfirmLink = async () => {
    if (!confirmTarget || linking) return
    setLinking(true)
    setError(null)
    const { error: rpcErr } = await supabase.rpc('link_finance_payment_to_order_request', {
      p_payment_request_id: confirmTarget.id,
      p_order_request_id:   request.id,
    })
    setLinking(false)
    if (rpcErr) {
      const { text, stale } = friendlyLinkError(rpcErr.message)
      // Only drop the row when the payment itself is no longer eligible; a
      // request-level or transient failure leaves it in place for a retry.
      if (stale) {
        const staleId = confirmTarget.id
        setResults(prev => prev.filter(p => p.id !== staleId))
      }
      setConfirmTarget(null)
      setError(text)
      return
    }
    const linked = confirmTarget
    setConfirmTarget(null)
    setResults(prev => prev.filter(p => p.id !== linked.id))
    onLinked(linked)
  }

  const labelStyle: React.CSSProperties = {
    fontSize: '11px', fontWeight: 700, color: colors.muted,
    textTransform: 'uppercase', letterSpacing: '0.05em',
  }
  const inputStyle: React.CSSProperties = {
    padding: '8px 10px', borderRadius: '6px',
    border: `1px solid ${colors.border}`,
    background: colors.raised, color: colors.primary,
    fontSize: '13px', width: '100%', boxSizing: 'border-box', outline: 'none',
  }

  return (
    <div style={{ padding: '14px 16px', borderRadius: '10px', background: colors.raised, border: `1px solid ${colors.border}`, display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={labelStyle}>
        {ownOnlyUserId ? 'Link a Payment You Submitted' : 'Link Suspense Payment'}
      </div>

      {/* Search row */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'stretch' }}>
        <input
          ref={searchInputRef}
          style={{ ...inputStyle, flex: '1 1 260px' }}
          value={query}
          onChange={e => { setQuery(e.target.value); if (inputNotice) setInputNotice(null) }}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleSearch() } }}
          placeholder="Search by UTR, payer, amount or payment date"
          aria-label={ownOnlyUserId ? 'Search your available payments' : 'Search suspense payments'}
        />
        <button
          type="button"
          onClick={handleSearch}
          disabled={!query.trim() || searching}
          style={{
            padding: '8px 16px', borderRadius: '6px', fontSize: '13px', fontWeight: 600,
            background: '#DC1F2E', border: 'none', color: '#fff',
            cursor: (!query.trim() || searching) ? 'not-allowed' : 'pointer',
            opacity: (!query.trim() || searching) ? 0.6 : 1,
          }}
        >
          Search
        </button>
        <button
          type="button"
          onClick={handleViewAll}
          disabled={searching}
          style={{
            padding: '8px 14px', borderRadius: '6px', fontSize: '13px', fontWeight: 600,
            background: 'transparent', border: `1px solid ${colors.border}`, color: colors.secondary,
            cursor: searching ? 'not-allowed' : 'pointer',
          }}
        >
          {ownOnlyUserId ? 'View your available payments' : 'View all suspense payments'}
        </button>
      </div>

      {/* Confirmation — compact, inline, no separate popup */}
      {confirmTarget && (
        <div style={{
          padding: '10px 12px', borderRadius: '8px',
          background: '#F5F3FF', border: '1px solid #DDD6FE',
          display: 'flex', flexDirection: 'column', gap: '10px',
        }}>
          <div style={{ fontSize: '13px', color: '#5B21B6', lineHeight: 1.5 }}>
            Link <strong>{fmtAmount(confirmTarget.amount)}</strong> received from{' '}
            <strong>{confirmTarget.client_name}</strong> to <strong>{request.request_number}</strong>?
          </div>
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={() => setConfirmTarget(null)}
              disabled={linking}
              style={{
                padding: '6px 14px', borderRadius: '6px', fontSize: '12px', fontWeight: 600,
                background: 'transparent', border: `1px solid ${colors.border}`, color: colors.secondary,
                cursor: linking ? 'not-allowed' : 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmLink}
              disabled={linking}
              style={{
                padding: '6px 14px', borderRadius: '6px', fontSize: '12px', fontWeight: 600,
                background: '#5B21B6', border: 'none', color: '#fff',
                cursor: linking ? 'not-allowed' : 'pointer', opacity: linking ? 0.7 : 1,
              }}
            >
              {linking ? 'Linking…' : 'Confirm & Link'}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div style={{ fontSize: '12px', color: colors.red, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '6px', padding: '8px 12px' }}>
          {error}
        </div>
      )}

      {/* Results / states */}
      {searching ? (
        <div style={{ fontSize: '12px', color: colors.muted, padding: '6px 0' }}>Searching suspense payments…</div>
      ) : inputNotice ? (
        <div style={{ fontSize: '12px', color: colors.muted, lineHeight: 1.5 }}>
          {inputNotice}
        </div>
      ) : mode == null ? (
        <div style={{ fontSize: '12px', color: colors.muted, lineHeight: 1.5 }}>
          {ownOnlyUserId
            ? 'Search the approved payments you submitted, or view them all. Only payments that are approved and not yet attached elsewhere can be linked.'
            : 'Search for a suspense payment or view all available entries.'}
        </div>
      ) : results.length === 0 ? (
        <div style={{ fontSize: '12px', color: colors.muted, padding: '6px 0' }}>
          {ownOnlyUserId
            ? 'None of your payments are available to link. A payment must be approved by an admin first.'
            : 'No available suspense payments found.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {results.map(p => (
            <div
              key={p.id}
              style={{
                border: `1px solid ${colors.border}`, borderRadius: '8px',
                padding: '10px 12px', background: colors.base,
                display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'flex-start',
              }}
            >
              <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '15px', fontWeight: 700, color: colors.primary, fontVariantNumeric: 'tabular-nums' }}>
                    {fmtAmount(p.amount)}
                  </span>
                  <span style={{ fontSize: '12px', color: colors.secondary }}>{fmtDate(p.payment_date)}</span>
                </div>
                <div style={{ fontSize: '12.5px', color: colors.primary, wordBreak: 'break-word' }}>{p.client_name}</div>
                <div style={{ fontSize: '11.5px', color: colors.muted, display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  <span>{p.request_number}</span>
                  <span aria-hidden="true">·</span>
                  <span>{PAYMENT_MODE_LABEL[p.payment_mode] ?? p.payment_mode}</span>
                  <span aria-hidden="true">·</span>
                  <span>{RECEIVED_IN_LABEL[p.received_in] ?? p.received_in}</span>
                </div>
                {p.proof_note && (
                  <div style={{ fontSize: '11.5px', color: colors.muted, wordBreak: 'break-word' }}>
                    Ref: {p.proof_note}
                  </div>
                )}
                {p.sales_note && (
                  <div style={{ fontSize: '11.5px', color: colors.muted, wordBreak: 'break-word' }}>
                    {p.sales_note}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => { setError(null); setConfirmTarget(p) }}
                disabled={linking}
                style={{
                  flexShrink: 0, padding: '6px 12px', borderRadius: '6px',
                  fontSize: '12px', fontWeight: 600,
                  background: confirmTarget?.id === p.id ? '#5B21B6' : 'transparent',
                  border: `1px solid ${confirmTarget?.id === p.id ? '#5B21B6' : colors.border}`,
                  color: confirmTarget?.id === p.id ? '#fff' : colors.blue,
                  cursor: linking ? 'not-allowed' : 'pointer',
                }}
              >
                Link payment
              </button>
            </div>
          ))}
          {hasMore && (
            <button
              type="button"
              onClick={handleShowMore}
              style={{
                alignSelf: 'flex-start', background: 'none', border: 'none', padding: '2px 0',
                cursor: 'pointer', font: 'inherit', fontSize: '12px', fontWeight: 600,
                color: colors.blue, textDecoration: 'underline', textUnderlineOffset: '2px',
              }}
            >
              Show more
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Linked payment dialogs ────────────────────────────────────────────────────

// Read-only detail view for one linked payment. Same two-column shell, proof
// block and activity timeline the Finance Received Payments detail modal uses,
// so a payment reads the same wherever it is opened. Editing never happens
// here — it is Finance's own workflow, reached through the Edit action.
export function LinkedPaymentDetailsModal({
  payment: p,
  supabase,
  onClose,
}: {
  payment: LinkedPayment
  supabase: ReturnType<typeof createClient>
  onClose: () => void
}) {
  const meta = paymentStatusMeta(p)
  const left = (
    <>
      <div style={{
        border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '16px',
        display: 'flex', flexDirection: 'column', gap: '14px',
      }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '14px' }}>
          <div style={{ minWidth: 0 }}>
            <SectionHeader>Amount</SectionHeader>
            <div style={{ fontSize: '28px', fontWeight: 700, color: colors.primary, lineHeight: 1.1, marginTop: '4px', fontVariantNumeric: 'tabular-nums', wordBreak: 'break-word' }}>
              {fmtAmount(p.amount)}
            </div>
          </div>
          <div style={{ minWidth: 0 }}>
            <SectionHeader>Client</SectionHeader>
            <div style={{ fontSize: '18px', fontWeight: 600, color: colors.primary, lineHeight: 1.3, marginTop: '4px', wordBreak: 'break-word' }}>
              {p.client_name}
            </div>
          </div>
        </div>
        <div style={{ borderTop: `1px solid ${colors.border}`, paddingTop: '4px' }}>
          <DetailRow label="Payment Date" value={fmtDate(p.payment_date)} />
          <DetailRow label="Payment Mode" value={PAYMENT_MODE_LABEL[p.payment_mode] ?? p.payment_mode} />
          <DetailRow label="Received In"  value={RECEIVED_IN_LABEL[p.received_in]  ?? p.received_in} />
          <DetailRow label="Reference"    value={p.proof_note || '—'} muted={!p.proof_note} />
          <DetailRow
            label={p.order_number ? 'Order Number' : 'Linked Order Request'}
            value={p.order_number ?? p.order_request_number ?? '—'}
            muted={!p.order_number && !p.order_request_number}
          />
          <DetailRow label="Submitted By" value={p.submitted_by_name ?? '—'} muted={!p.submitted_by_name} last />
        </div>
      </div>

      <div style={{ border: `1px solid ${colors.border}`, borderRadius: '10px', padding: '10px 12px', display: 'flex', alignItems: 'center', gap: '12px' }}>
        <span style={{ fontSize: '11px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em', width: '74px', flexShrink: 0 }}>Proof</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <PaymentProofView supabase={supabase} paymentRequestId={p.id} renderEmpty inline />
        </div>
      </div>

      {p.sales_note && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <SectionHeader>Notes</SectionHeader>
          <div style={{ fontSize: '13.5px', color: colors.secondary, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {p.sales_note}
          </div>
        </div>
      )}
    </>
  )

  const right = (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '16px' }}>
      <PaymentRequestActivity supabase={supabase} paymentRequestId={p.id} />
    </div>
  )

  return (
    <RequestModalShell
      requestNumber={p.request_number}
      submittedLine={p.submitted_by_name ? `Submitted by ${p.submitted_by_name} · ${fmtDate(p.created_at)}` : `Submitted ${fmtDate(p.created_at)}`}
      statusBadge={
        <span style={{
          display: 'inline-block', padding: '2px 8px', borderRadius: '5px',
          background: meta.bg, color: meta.color, border: `1px solid ${meta.border}`,
          fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap',
        }}>
          {meta.label}
        </span>
      }
      onClose={onClose}
      left={left}
      right={right}
      ariaLabel={`Payment ${p.request_number}`}
    />
  )
}

// Detach a payment from this request, back to plain suspense. Routed through
// unlink_finance_payment_from_order_request (20260698/20260699), which requires
// a non-empty reason and re-checks authorization server-side.
export function UnlinkPaymentModal({
  payment: p,
  request,
  supabase,
  onClose,
  onUnlinked,
}: {
  payment: LinkedPayment
  request: OrderRequest
  supabase: ReturnType<typeof createClient>
  onClose: () => void
  onUnlinked: (payment: LinkedPayment) => void
}) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)
  const valid = reason.trim().length > 0

  const handleUnlink = async () => {
    if (!valid || saving) return
    setSaving(true)
    setError(null)
    const { error: rpcErr } = await supabase.rpc('unlink_finance_payment_from_order_request', {
      p_payment_request_id: p.id,
      p_reason:             reason,
    })
    setSaving(false)
    if (rpcErr) {
      const m = (rpcErr.message ?? '').toLowerCase()
      setError(
        m.includes('only an admin') || m.includes('payment you submitted')
          ? 'You do not have permission to unlink this payment.'
          : m.includes('no linked order request')
            ? 'This payment is no longer linked to this request. Refresh and try again.'
            : 'Could not unlink this payment. Please refresh and try again.'
      )
      return
    }
    onUnlinked(p)
  }

  return (
    <FinanceModal title="Unlink Payment?" width="420px" closeOnBackdropClick={false} onClose={() => { if (!saving) onClose() }}>
      <div style={{ fontSize: '13px', color: colors.secondary, lineHeight: 1.6 }}>
        This removes the link between <strong>{p.request_number}</strong> ({fmtAmount(p.amount)} from{' '}
        <strong>{p.client_name}</strong>) and <strong>{request.request_number}</strong>. The payment
        returns to suspense and stops counting towards this request&rsquo;s advance.
      </div>
      <label style={{
        display: 'flex', flexDirection: 'column', gap: '4px',
        fontSize: '11px', fontWeight: 600, color: colors.muted,
        textTransform: 'uppercase', letterSpacing: '0.05em',
      }}>
        Reason *
        <textarea
          autoFocus
          className="boe-input"
          value={reason}
          onChange={e => { setReason(e.target.value); setError(null) }}
          placeholder="Why is this payment being unlinked? (required)"
          rows={2}
          disabled={saving}
          style={{ width: '100%', resize: 'vertical' }}
        />
      </label>
      {error && (
        <div style={{ fontSize: '12px', color: colors.red, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '6px', padding: '8px 12px' }}>
          {error}
        </div>
      )}
      <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="boe-btn boe-btn-ghost"
          style={{ padding: '8px 18px', fontSize: '13px' }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleUnlink}
          disabled={saving || !valid}
          style={{
            padding: '8px 18px', fontSize: '13px', fontWeight: 600, borderRadius: '8px',
            border: `1px solid ${colors.border}`, background: colors.raised, color: colors.primary,
            cursor: (saving || !valid) ? 'not-allowed' : 'pointer',
            opacity: (saving || !valid) ? 0.6 : 1,
          }}
        >
          {saving ? 'Unlinking…' : 'Yes, Unlink'}
        </button>
      </div>
    </FinanceModal>
  )
}

// ── Payments card ─────────────────────────────────────────────────────────────
// The payments actually attached to this request, read by the detail page with
// the viewer's own RLS on order_request_id — the only linkage an open request
// can have. Admins and the requester see the identical list; only the available
// actions differ.

const PAYMENTS_TH: React.CSSProperties = {
  padding: '7px 10px', textAlign: 'left',
  fontSize: '10px', fontWeight: 700, color: colors.muted,
  textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
  borderBottom: `1px solid ${colors.border}`, background: colors.raised,
}
const PAYMENTS_TD: React.CSSProperties = {
  padding: '8px 10px', borderBottom: `1px solid ${colors.border}`,
  fontSize: '12px', color: colors.secondary, whiteSpace: 'nowrap',
}

export function RequestPaymentsCard({
  request: r,
  rows,
  linkedBy,
  loading,
  error,
  isAdmin,
  currentUserId,
  onView,
  onEdit,
  onUnlink,
}: {
  request: OrderRequest
  rows: LinkedPayment[]
  // "Linked by" comes from the request's own activity trail, the only place the
  // linker is recorded. A payment attached during conversion from the admin's
  // manual selection has no such row and honestly shows "—" rather than
  // borrowing the submitter's name.
  linkedBy: Record<string, string>
  loading: boolean
  error: string | null
  isAdmin: boolean
  currentUserId: string
  onView:   (p: LinkedPayment) => void
  onEdit:   (p: LinkedPayment) => void
  onUnlink: (p: LinkedPayment) => void
}) {
  // A linked payment is always approved, so the creator-edit window
  // (pending/needs_clarification/rejected — finance_payment_requests_own_update)
  // has closed for a requester. The rule is still evaluated per row rather than
  // assumed, so the button appears if and only if the database would allow it.
  const canEditPayment = (p: LinkedPayment) =>
    isAdmin || (p.submitted_by === currentUserId
      && ['pending_approval', 'needs_clarification', 'rejected'].includes(p.status))

  // Only a payment still parked on THIS request can be detached here; once it
  // has transferred to the converted Order, unlinking is Finance's workflow.
  const canUnlinkPayment = (p: LinkedPayment) =>
    canManagePayments(r, currentUserId, isAdmin)
    && p.order_request_id === r.id
    && p.payment_against === 'new_order'
    && (isAdmin || p.submitted_by === currentUserId)

  const total = rows.reduce((sum, p) => sum + (Number.isFinite(p.amount) ? p.amount : 0), 0)

  return (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: '10px', overflow: 'hidden', background: colors.base }}>
      <div style={{
        padding: '10px 14px', borderBottom: `1px solid ${colors.border}`,
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap',
      }}>
        <SectionHeader>Linked Payments</SectionHeader>
        {/* The count/total is the header's job only when there IS something to
            count — an empty list is stated once, by the body below. */}
        {loading ? (
          <span style={{ fontSize: '11.5px', color: colors.muted }}>Loading…</span>
        ) : rows.length > 0 ? (
          <span style={{ fontSize: '11.5px', color: colors.muted }}>
            {rows.length} payment{rows.length !== 1 ? 's' : ''} · {fmtAmount(total)}
          </span>
        ) : null}
      </div>

      {error ? (
        <div style={{ padding: '14px', fontSize: '12px', color: colors.red }}>{error}</div>
      ) : loading ? (
        <div style={{ padding: '14px', fontSize: '12px', color: colors.muted }}>Loading payments…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: '14px', fontSize: '12px', color: colors.muted, lineHeight: 1.5 }}>
          No payments are linked to this request yet.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '820px' }}>
            <thead>
              <tr>
                <th style={PAYMENTS_TH}>Payment #</th>
                <th style={PAYMENTS_TH}>Date</th>
                <th style={{ ...PAYMENTS_TH, textAlign: 'right' }}>Amount</th>
                <th style={PAYMENTS_TH}>Mode</th>
                <th style={PAYMENTS_TH}>Received In</th>
                <th style={PAYMENTS_TH}>Reference</th>
                <th style={PAYMENTS_TH}>Status</th>
                <th style={PAYMENTS_TH}>Submitted By</th>
                <th style={PAYMENTS_TH}>Linked By</th>
                <th style={{ ...PAYMENTS_TH, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(p => {
                const meta = paymentStatusMeta(p)
                return (
                  <tr key={p.id}>
                    <td style={{ ...PAYMENTS_TD, fontWeight: 700, color: colors.primary }}>{p.request_number}</td>
                    <td style={PAYMENTS_TD}>{fmtDate(p.payment_date)}</td>
                    <td style={{ ...PAYMENTS_TD, textAlign: 'right', fontWeight: 700, color: colors.primary, fontVariantNumeric: 'tabular-nums' }}>
                      {fmtAmount(p.amount)}
                    </td>
                    <td style={PAYMENTS_TD}>{PAYMENT_MODE_LABEL[p.payment_mode] ?? p.payment_mode}</td>
                    <td style={PAYMENTS_TD}>{RECEIVED_IN_LABEL[p.received_in] ?? p.received_in}</td>
                    <td style={{ ...PAYMENTS_TD, whiteSpace: 'normal', maxWidth: '180px', wordBreak: 'break-word' }}>
                      {p.proof_note || '—'}
                    </td>
                    <td style={PAYMENTS_TD}>
                      <span style={{
                        display: 'inline-block', padding: '2px 8px', borderRadius: '5px',
                        background: meta.bg, color: meta.color, border: `1px solid ${meta.border}`,
                        fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap',
                      }}>
                        {meta.label}
                      </span>
                    </td>
                    <td style={PAYMENTS_TD}>{p.submitted_by_name ?? '—'}</td>
                    <td style={PAYMENTS_TD}>{linkedBy[p.id] ?? '—'}</td>
                    <td style={{ ...PAYMENTS_TD, textAlign: 'right' }}>
                      <span style={{ display: 'inline-flex', gap: '4px', alignItems: 'center' }}>
                        <button
                          type="button"
                          onClick={() => onView(p)}
                          className="boe-btn boe-btn-ghost"
                          style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 500 }}
                        >
                          View
                        </button>
                        {canEditPayment(p) && (
                          <button
                            type="button"
                            onClick={() => onEdit(p)}
                            className="boe-btn boe-btn-ghost"
                            style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 500 }}
                          >
                            Edit
                          </button>
                        )}
                        {canUnlinkPayment(p) && (
                          <button
                            type="button"
                            onClick={() => onUnlink(p)}
                            className="boe-btn boe-btn-ghost"
                            style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 500, color: colors.muted }}
                          >
                            Unlink
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}


// ── Attachments ───────────────────────────────────────────────────────────────
// The Main PI is the primary commercial document of an Order Request, so this
// section leads the record rather than trailing it, and the PI itself is given
// its own surface instead of being one row in a list.
//
// Rows are loaded by the detail page (order_request_attachments, viewer's own
// RLS). Nothing weakens the storage rules: the bucket stays private, raw paths
// are never exposed, and every read — preview and download alike — goes through
// a short-lived signed URL created on demand.

// Preview URLs live a little longer than download URLs (5 min vs 60 s) because
// the reader is expected to actually look at the file. Still short-lived, still
// scoped to one object in a private bucket.
const PREVIEW_URL_TTL  = 300
const DOWNLOAD_URL_TTL = 60

// Guards against a pathological workbook locking up the tab. A PI that exceeds
// these is still fully downloadable — only the in-app preview is trimmed, and
// it says so.
const MAX_PREVIEW_ROWS = 300
const MAX_PREVIEW_COLS = 40
const MAX_PREVIEW_TEXT = 200000

type SheetPreview = { names: string[]; active: string; rows: string[][]; truncated: boolean }

// raw:false renders dates and formatted numbers the way the workbook shows
// them, so a PI reads as its author saw it rather than as date serial numbers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readSheet(XLSX: any, wb: any, names: string[], name: string): SheetPreview {
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], {
    header: 1, blankrows: false, defval: '', raw: false,
  }) as unknown[][]
  const truncated = grid.length > MAX_PREVIEW_ROWS
    || grid.some(rowCells => (rowCells?.length ?? 0) > MAX_PREVIEW_COLS)
  const rows = grid.slice(0, MAX_PREVIEW_ROWS).map(rowCells =>
    (rowCells ?? []).slice(0, MAX_PREVIEW_COLS).map(c => (c == null ? '' : String(c)))
  )
  return { names, active: name, rows, truncated }
}

// Opens one attachment inside the app. Same overlay layer as every other modal
// in this module, so it can never sit under the fixed sidebar.
export function AttachmentPreviewModal({
  row, supabase, onClose,
}: {
  row: RequestAttachmentRow
  supabase: ReturnType<typeof createClient>
  onClose: () => void
}) {
  useModalScrollLockAndEscape(onClose)

  const kind = previewKindOf(row.file_name)
  const [url,     setUrl]     = useState<string | null>(null)
  const [sheet,   setSheet]   = useState<SheetPreview | null>(null)
  const [text,    setText]    = useState<string | null>(null)
  const [loading, setLoading] = useState(kind !== 'none')
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    if (kind === 'none') return
    let active = true
    ;(async () => {
      const { data, error: e } = await supabase.storage
        .from(ORDER_REQ_ATTACHMENT_BUCKET)
        .createSignedUrl(row.storage_path, PREVIEW_URL_TTL)
      if (!active) return
      if (e || !data?.signedUrl) {
        setError('This file could not be opened. It may have been moved or removed.')
        setLoading(false)
        return
      }
      setUrl(data.signedUrl)

      // An image or a PDF is rendered by the browser straight from the signed
      // URL — nothing further to fetch here.
      if (kind === 'image' || kind === 'pdf') { setLoading(false); return }

      try {
        const res = await fetch(data.signedUrl)
        if (!res.ok) throw new Error(String(res.status))

        if (kind === 'text') {
          const body = await res.text()
          if (!active) return
          setText(body.length > MAX_PREVIEW_TEXT ? body.slice(0, MAX_PREVIEW_TEXT) : body)
          setLoading(false)
          return
        }

        // Spreadsheets are parsed in the browser and rendered as a plain table.
        // The parser is imported ON DEMAND, so its weight is never carried by a
        // reader who does not open a workbook. Cells become React text nodes,
        // never HTML, so a crafted cell cannot inject markup.
        const buf = await res.arrayBuffer()
        const XLSX = await import('xlsx')
        const wb = XLSX.read(buf, { type: 'array' })
        if (!active) return
        const names = wb.SheetNames
        if (names.length === 0) { setError('This workbook has no sheets to preview.'); setLoading(false); return }
        setSheet(readSheet(XLSX, wb, names, names[0]))
        setLoading(false)
      } catch {
        if (!active) return
        setError('This file could not be previewed. Download it to open it instead.')
        setLoading(false)
      }
    })()
    return () => { active = false }
  }, [supabase, row.storage_path, kind])

  const switchSheet = async (name: string) => {
    if (!url || !sheet || name === sheet.active) return
    setLoading(true)
    try {
      const res = await fetch(url)
      const buf = await res.arrayBuffer()
      const XLSX = await import('xlsx')
      const wb = XLSX.read(buf, { type: 'array' })
      setSheet(readSheet(XLSX, wb, sheet.names, name))
    } catch {
      setError('That sheet could not be loaded.')
    }
    setLoading(false)
  }

  const download = async () => {
    const { data } = await supabase.storage
      .from(ORDER_REQ_ATTACHMENT_BUCKET)
      .createSignedUrl(row.storage_path, DOWNLOAD_URL_TTL, { download: row.file_name })
    if (data?.signedUrl) window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
  }

  const cellStyle: React.CSSProperties = {
    border: `1px solid ${colors.border}`, padding: '5px 9px',
    fontSize: '12px', color: colors.secondary, whiteSpace: 'nowrap',
    maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis',
  }

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: FINANCE_MODAL_OVERLAY_Z }} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Preview of ${row.file_name}`}
        style={{
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          width: 'min(1120px, calc(100vw - 24px))', height: 'min(88vh, 900px)',
          background: colors.base, borderRadius: '12px', border: `1px solid ${colors.border}`,
          boxShadow: '0 12px 40px rgba(0,0,0,0.16)', zIndex: FINANCE_MODAL_DIALOG_Z,
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        <div style={{
          padding: '12px 16px', borderBottom: `1px solid ${colors.border}`, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {row.file_name}
            </div>
            <div style={{ fontSize: '11.5px', color: colors.muted, marginTop: '2px' }}>
              {row.attachment_type === 'main_pi' ? 'Main PI' : 'Reference attachment'}
              {row.uploaded_size_bytes != null ? ` · ${formatBytes(row.uploaded_size_bytes)}` : ''}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
            <button
              type="button"
              onClick={download}
              className="boe-btn boe-btn-ghost"
              style={{ padding: '5px 12px', fontSize: '12px', fontWeight: 600 }}
            >
              Download
            </button>
            <button onClick={onClose} aria-label="Close" className="boe-btn boe-btn-ghost" style={{ padding: '4px 10px', fontSize: '13px' }}>✕</button>
          </div>
        </div>

        {/* Sheet tabs — only for a workbook with more than one sheet. */}
        {sheet && sheet.names.length > 1 && (
          <div style={{ display: 'flex', gap: '4px', padding: '8px 16px 0', flexWrap: 'wrap', flexShrink: 0 }}>
            {sheet.names.map(n => (
              <button
                key={n}
                type="button"
                onClick={() => switchSheet(n)}
                style={{
                  padding: '4px 10px', borderRadius: '6px', fontSize: '12px', fontWeight: 600,
                  cursor: 'pointer', whiteSpace: 'nowrap',
                  background: n === sheet.active ? colors.float : 'transparent',
                  border: `1px solid ${n === sheet.active ? colors.borderMed : colors.border}`,
                  color: n === sheet.active ? colors.primary : colors.secondary,
                }}
              >
                {n}
              </button>
            ))}
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '14px 16px', background: colors.raised }}>
          {kind === 'none' ? (
            <div style={{ fontSize: '13px', color: colors.secondary, lineHeight: 1.6 }}>
              This file type can&rsquo;t be previewed in the browser. Use Download to open it.
            </div>
          ) : loading ? (
            <div style={{ fontSize: '13px', color: colors.muted }}>Loading preview…</div>
          ) : error ? (
            <div style={{ fontSize: '13px', color: colors.red, lineHeight: 1.6 }}>{error}</div>
          ) : kind === 'image' && url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url} alt={row.file_name} style={{ maxWidth: '100%', display: 'block', margin: '0 auto', borderRadius: '8px' }} />
          ) : kind === 'pdf' && url ? (
            <iframe title={row.file_name} src={url} style={{ width: '100%', height: '100%', minHeight: '60vh', border: 'none', background: colors.base, borderRadius: '8px' }} />
          ) : kind === 'text' && text != null ? (
            <pre style={{
              margin: 0, fontSize: '12px', color: colors.secondary, lineHeight: 1.6,
              whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'var(--font-mono, monospace)',
            }}>
              {text}
            </pre>
          ) : sheet ? (
            <>
              <table style={{ borderCollapse: 'collapse', background: colors.base }}>
                <tbody>
                  {sheet.rows.map((cells, ri) => (
                    <tr key={ri}>
                      {cells.map((c, ci) => (
                        <td
                          key={ci}
                          style={ri === 0
                            ? { ...cellStyle, fontWeight: 700, color: colors.primary, background: colors.raised }
                            : cellStyle}
                          title={c}
                        >
                          {c}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {sheet.truncated && (
                <div style={{ fontSize: '11.5px', color: colors.muted, marginTop: '10px' }}>
                  Preview trimmed to the first {MAX_PREVIEW_ROWS} rows and {MAX_PREVIEW_COLS} columns. Download the file for the complete workbook.
                </div>
              )}
            </>
          ) : (
            <div style={{ fontSize: '13px', color: colors.muted }}>Nothing to preview.</div>
          )}
        </div>
      </div>
    </>
  )
}

// One attachment row: name, size, and the two things a reader wants to do with
// it. Preview is offered only for formats the app can actually render; every
// file is always downloadable.
function AttachmentFileRow({
  row, supabase, onPreview, primary, action, supersededLabel,
}: {
  row: RequestAttachmentRow
  supabase: ReturnType<typeof createClient>
  onPreview: (row: RequestAttachmentRow) => void
  primary?: boolean
  /** Edit-mode controls (Replace / Remove). Absent in read mode. */
  action?: React.ReactNode
  /** Set when a staged change will supersede this file on save. */
  supersededLabel?: string
}) {
  const [busy,  setBusy]  = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canPreview = previewKindOf(row.file_name) !== 'none'

  const download = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    // Content-Disposition: attachment via the `download` option, so a reference
    // file is never rendered inline by accident. Signed URL is short-lived.
    const { data, error: e } = await supabase.storage
      .from(ORDER_REQ_ATTACHMENT_BUCKET)
      .createSignedUrl(row.storage_path, DOWNLOAD_URL_TTL, { download: row.file_name })
    setBusy(false)
    if (e || !data?.signedUrl) {
      setError('This file could not be opened. It may have been moved or removed.')
      return
    }
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
  }

  // A file that a staged change will supersede stays visible and openable, but
  // reads as on its way out.
  const superseded = !!supersededLabel

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
      padding: primary ? '11px 12px' : '8px 10px', borderRadius: '8px',
      background: superseded ? colors.raised : primary ? '#FFFBEB' : colors.base,
      border: `1px solid ${superseded ? colors.border : primary ? '#FDE68A' : colors.border}`,
      opacity: superseded ? 0.75 : 1,
    }}>
      <span style={{ display: 'flex', flexShrink: 0, color: superseded ? colors.muted : primary ? '#92400E' : colors.tertiary }}>
        {primary
          ? <FileSpreadsheet size={16} strokeWidth={1.8} />
          : <Paperclip size={14} strokeWidth={1.8} />}
      </span>
      <span
        title={row.file_name}
        style={{
          fontSize: primary ? '13.5px' : '12.5px',
          fontWeight: primary ? 600 : 400,
          color: colors.primary, flex: 1, minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
      >
        {row.file_name}
      </span>
      {supersededLabel && (
        <span style={{ fontSize: '11px', fontWeight: 600, color: '#1E40AF', flexShrink: 0 }}>{supersededLabel}</span>
      )}
      {row.uploaded_size_bytes != null && (
        <span style={{ fontSize: '11px', color: colors.muted, flexShrink: 0 }}>{formatBytes(row.uploaded_size_bytes)}</span>
      )}
      {canPreview && (
        <button
          type="button"
          onClick={() => onPreview(row)}
          className="boe-btn boe-btn-ghost"
          style={{ padding: '4px 12px', fontSize: '11px', fontWeight: 600, color: colors.blue, flexShrink: 0 }}
        >
          Preview
        </button>
      )}
      <button
        type="button"
        onClick={download}
        disabled={busy}
        className="boe-btn boe-btn-ghost"
        style={{ padding: '4px 12px', fontSize: '11px', fontWeight: 600, flexShrink: 0 }}
      >
        {busy ? 'Opening…' : 'Download'}
      </button>
      {action}
      {error && <span style={{ fontSize: '11px', color: colors.red, width: '100%' }}>{error}</span>}
    </div>
  )
}


// ── Staged-change rows (edit mode only) ───────────────────────────────────────
// Purely visual. Selecting or removing a file here changes NOTHING in Storage or
// the database — it records an intention that Save Changes applies and Cancel
// discards.

function StagedRow({ staged, onDiscard, disabled }: {
  staged: StagedAttachment
  onDiscard: () => void
  disabled: boolean
}) {
  const isError = staged.status === 'error'
  const sizeLine = staged.compressed && staged.finalSize != null && staged.finalSize !== staged.originalSize
    ? `${formatBytes(staged.originalSize)} → ${formatBytes(staged.finalSize)} compressed`
    : formatBytes(staged.finalSize ?? staged.originalSize)

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
      padding: '9px 11px', borderRadius: '8px',
      background: isError ? '#FEF2F2' : '#EFF6FF',
      border: `1px dashed ${isError ? '#FECACA' : '#BFDBFE'}`,
    }}>
      <span style={{ display: 'flex', flexShrink: 0, color: isError ? '#991B1B' : '#1E40AF' }}>
        <Paperclip size={14} strokeWidth={1.8} />
      </span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <span style={{ fontSize: '12.5px', color: colors.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {staged.displayName}
        </span>
        <span style={{ fontSize: '11px', color: isError ? colors.red : '#1E40AF', lineHeight: 1.4, wordBreak: 'break-word' }}>
          {isError
            ? staged.error
            : staged.status === 'preparing'
              ? 'Preparing…'
              : `Pending — applies on save · ${sizeLine}`}
          {staged.replacesName && !isError ? ` · replaces “${staged.replacesName}”` : ''}
        </span>
      </div>
      <button
        type="button"
        onClick={onDiscard}
        disabled={disabled}
        className="boe-btn boe-btn-ghost"
        style={{ padding: '3px 10px', fontSize: '11px', fontWeight: 600, flexShrink: 0 }}
      >
        Discard
      </button>
    </div>
  )
}

// An existing reference staged for removal: still listed, visibly struck out,
// with a one-click Undo. It is not gone until Save succeeds.
function PendingRemovalRow({ row, onUndo, disabled }: {
  row: RequestAttachmentRow
  onUndo: () => void
  disabled: boolean
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
      padding: '8px 10px', borderRadius: '8px',
      background: colors.raised, border: `1px solid ${colors.border}`,
    }}>
      <span style={{ display: 'flex', flexShrink: 0, color: colors.muted }}>
        <Paperclip size={14} strokeWidth={1.8} />
      </span>
      <span style={{
        fontSize: '12.5px', color: colors.muted, textDecoration: 'line-through',
        flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {row.file_name}
      </span>
      <span style={{ fontSize: '11px', color: colors.muted, flexShrink: 0 }}>Removes on save</span>
      <button
        type="button"
        onClick={onUndo}
        disabled={disabled}
        className="boe-btn boe-btn-ghost"
        style={{ padding: '3px 10px', fontSize: '11px', fontWeight: 600, color: colors.blue, flexShrink: 0 }}
      >
        Undo
      </button>
    </div>
  )
}

export function RequestAttachmentsCard({
  rows,
  supabase,
  loading,
  error,
  // ── Edit mode (all optional; omitted entirely in read mode) ──
  editing = false,
  edits,
  disabled = false,
  onReplaceMainPi,
  onUndoMainPi,
  onAddReferences,
  onReplaceReference,
  onRemoveReference,
  onUndoRemoveReference,
  onDiscardStagedRef,
}: {
  rows: RequestAttachmentRow[]
  supabase: ReturnType<typeof createClient>
  loading: boolean
  error: boolean
  editing?: boolean
  edits?: AttachmentEdits
  disabled?: boolean
  onReplaceMainPi?: (file: File) => void
  onUndoMainPi?: () => void
  onAddReferences?: (files: File[]) => void
  onReplaceReference?: (attachmentId: string, file: File) => void
  onRemoveReference?: (attachmentId: string) => void
  onUndoRemoveReference?: (attachmentId: string) => void
  onDiscardStagedRef?: (localId: string) => void
}) {
  const [preview, setPreview] = useState<RequestAttachmentRow | null>(null)

  // Hidden native pickers. `replaceTargetId` remembers which existing reference
  // the "Replace" click belonged to, so one input serves every row.
  const mainPiInputRef  = useRef<HTMLInputElement | null>(null)
  const addRefsInputRef = useRef<HTMLInputElement | null>(null)
  const replaceRefInputRef = useRef<HTMLInputElement | null>(null)
  const [replaceTargetId, setReplaceTargetId] = useState<string | null>(null)

  const mainPi     = rows.find(row => row.attachment_type === 'main_pi') ?? null
  const references = rows.filter(row => row.attachment_type === 'reference')

  const staged        = edits ?? EMPTY_ATTACHMENT_EDITS
  const stagedMainPi  = editing ? staged.mainPi : null
  const removingIds   = editing ? staged.removeRefIds : []
  const stagedRefs    = editing ? staged.addRefs : []

  return (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: '10px', overflow: 'hidden', background: colors.base }}>
      <div style={{
        padding: '10px 14px', borderBottom: `1px solid ${colors.border}`,
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap',
      }}>
        <SectionHeader>Attachments</SectionHeader>
        {!loading && !error && !editing && references.length > 0 && (
          <span style={{ fontSize: '11.5px', color: colors.muted }}>
            {references.length} reference file{references.length !== 1 ? 's' : ''}
          </span>
        )}
        {editing && (
          <span style={{ fontSize: '11.5px', color: '#1E40AF' }}>
            Changes apply when you save
          </span>
        )}
      </div>
      <div style={{ padding: '12px 14px' }}>
        {loading ? (
          <div style={{ fontSize: '12px', color: colors.muted }}>Loading attachments…</div>
        ) : error ? (
          <div style={{ fontSize: '12px', color: colors.red }}>
            Attachments could not be loaded. Refresh the page to try again.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>

            {/* ── Main PI — always stated; its absence is itself information ── */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <span style={{ fontSize: '10.5px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Main PI</span>
              {mainPi
                ? (
                  <AttachmentFileRow
                    row={mainPi}
                    supabase={supabase}
                    onPreview={setPreview}
                    primary
                    supersededLabel={stagedMainPi ? 'Replaced on save' : undefined}
                    action={editing && onReplaceMainPi ? (
                      <button
                        type="button"
                        onClick={() => mainPiInputRef.current?.click()}
                        disabled={disabled}
                        className="boe-btn boe-btn-ghost"
                        style={{ padding: '4px 12px', fontSize: '11px', fontWeight: 600, flexShrink: 0 }}
                      >
                        {stagedMainPi ? 'Choose another' : 'Replace'}
                      </button>
                    ) : undefined}
                  />
                )
                : (
                  <div style={{
                    padding: '10px 12px', borderRadius: '8px',
                    background: colors.raised, border: `1px dashed ${colors.borderSoft}`,
                    fontSize: '12px', color: colors.muted,
                  }}>
                    No Main PI is attached to this request.
                  </div>
                )}

              {stagedMainPi && onUndoMainPi && (
                <StagedRow staged={stagedMainPi} onDiscard={onUndoMainPi} disabled={disabled} />
              )}

              {editing && (
                <>
                  <input
                    ref={mainPiInputRef}
                    type="file"
                    accept={MAIN_PI_ACCEPT}
                    style={{ display: 'none' }}
                    onChange={e => {
                      const f = e.target.files?.[0] ?? null
                      e.target.value = ''
                      if (f && onReplaceMainPi) onReplaceMainPi(f)
                    }}
                  />
                  <span style={{ fontSize: '11px', color: colors.muted, lineHeight: 1.5 }}>
                    The Main PI can only be replaced, never removed — a submitted request must always have one.
                    Excel only ({MAIN_PI_TYPES_LABEL}), up to {formatBytes(ORDER_REQ_ATTACHMENT_MAX_BYTES)}.
                  </span>
                </>
              )}
            </div>

            {/* ── Reference attachments ── */}
            {(references.length > 0 || (editing && (stagedRefs.length > 0 || onAddReferences))) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <span style={{ fontSize: '10.5px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Other Reference Attachments
                </span>

                {references.map(row => {
                  const pendingRemoval = removingIds.includes(row.id)
                  if (editing && pendingRemoval) {
                    // A row being REPLACED shows its replacement beneath it
                    // instead of a bare Undo, so the pairing is obvious.
                    const replacement = stagedRefs.find(a => a.replacesId === row.id)
                    return (
                      <div key={row.id} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <PendingRemovalRow
                          row={row}
                          onUndo={() => onUndoRemoveReference?.(row.id)}
                          disabled={disabled}
                        />
                        {replacement && onDiscardStagedRef && (
                          <StagedRow
                            staged={replacement}
                            onDiscard={() => onDiscardStagedRef(replacement.localId)}
                            disabled={disabled}
                          />
                        )}
                      </div>
                    )
                  }
                  return (
                    <AttachmentFileRow
                      key={row.id}
                      row={row}
                      supabase={supabase}
                      onPreview={setPreview}
                      action={editing ? (
                        <span style={{ display: 'inline-flex', gap: '4px', flexShrink: 0 }}>
                          {onReplaceReference && (
                            <button
                              type="button"
                              onClick={() => { setReplaceTargetId(row.id); replaceRefInputRef.current?.click() }}
                              disabled={disabled}
                              className="boe-btn boe-btn-ghost"
                              style={{ padding: '4px 10px', fontSize: '11px', fontWeight: 600 }}
                            >
                              Replace
                            </button>
                          )}
                          {onRemoveReference && (
                            <button
                              type="button"
                              onClick={() => onRemoveReference(row.id)}
                              disabled={disabled}
                              className="boe-btn boe-btn-ghost"
                              style={{ padding: '4px 10px', fontSize: '11px', fontWeight: 600, color: colors.muted }}
                            >
                              Remove
                            </button>
                          )}
                        </span>
                      ) : undefined}
                    />
                  )
                })}

                {/* Freshly added files (not replacing anything) */}
                {stagedRefs.filter(a => !a.replacesId).map(a => (
                  <StagedRow
                    key={a.localId}
                    staged={a}
                    onDiscard={() => onDiscardStagedRef?.(a.localId)}
                    disabled={disabled}
                  />
                ))}

                {editing && onAddReferences && (
                  <>
                    <input
                      ref={addRefsInputRef}
                      type="file"
                      multiple
                      accept={REFERENCE_ACCEPT}
                      style={{ display: 'none' }}
                      onChange={e => {
                        const files = Array.from(e.target.files ?? [])
                        e.target.value = ''
                        if (files.length > 0) onAddReferences(files)
                      }}
                    />
                    <input
                      ref={replaceRefInputRef}
                      type="file"
                      accept={REFERENCE_ACCEPT}
                      style={{ display: 'none' }}
                      onChange={e => {
                        const f = e.target.files?.[0] ?? null
                        e.target.value = ''
                        const target = replaceTargetId
                        setReplaceTargetId(null)
                        if (f && target && onReplaceReference) onReplaceReference(target, f)
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => addRefsInputRef.current?.click()}
                      disabled={disabled}
                      className="boe-btn boe-btn-ghost"
                      style={{ alignSelf: 'flex-start', padding: '5px 12px', fontSize: '11.5px', fontWeight: 600, color: colors.blue }}
                    >
                      + Add reference attachment
                    </button>
                    <span style={{ fontSize: '11px', color: colors.muted, lineHeight: 1.5 }}>
                      {REFERENCE_TYPES_LABEL}, up to {formatBytes(ORDER_REQ_ATTACHMENT_MAX_BYTES)} each.
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {preview && (
        <AttachmentPreviewModal
          key={preview.id}
          row={preview}
          supabase={supabase}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  )
}
