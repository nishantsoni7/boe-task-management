'use client'

// ── Order Request detail panels ───────────────────────────────────────────────
// The read + linkage surfaces of one Order Request: status badge, label/value
// rows, attachments, the Payment Received modal (the payments attached to the
// request AND the payment-link search, as two views of one dialog), and the two
// payment dialogs (view / unlink).
//
// Moved out of the Order Requests list page when the detail experience became
// its own route (/orders/requests/[id]). Every backend path is unchanged: the
// two linkage RPCs, the private attachment bucket's signed URLs, and the
// viewer's own RLS on finance_payment_requests / order_request_attachments.
//
// The attachments card and the payment surfaces are PRESENTATIONAL — the detail
// page owns those queries, because it also needs their results for the attention
// banner and the commercial summary, and one page must not fetch the same rows
// twice.

import { useEffect, useRef, useState } from 'react'
import type { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import { CheckCircle2, ChevronLeft, FileSpreadsheet, Paperclip } from 'lucide-react'
import {
  FinanceModal,
  RequestModalShell,
  useModalScrollLockAndEscape,
  FINANCE_MODAL_DIALOG_Z,
  FINANCE_MODAL_OVERLAY_Z,
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
  isExcelAttachmentName,
} from '@/lib/orderRequestAttachments'
// The SAME preview surface Task Management uses. Reused rather than reimplemented
// so an Excel Main PI renders identically in both modules — see the block above
// AttachmentFileRow for the one caveat that reuse carries.
import { AttachmentPreviewModal } from '@/components/ui/AttachmentPreviewModal'
import {
  EMPTY_ATTACHMENT_EDITS,
  type AttachmentEdits,
  type StagedAttachment,
} from './RequestInlineEdit'
import {
  buildSuspenseSearchConds,
  canManagePayments,
  canPreviewAttachment,
  fmtAmount,
  fmtDate,
  friendlyLinkError,
  paymentStatusMeta,
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

// ── Payment card primitives ───────────────────────────────────────────────────
// One visual language for BOTH payment lists on this page — the payments already
// linked to the request, and the available payments offered for linking. They
// replace the fixed-width table the linked list used to be: a wrapping card can
// absorb a long submitter name, a long client name or a large amount without
// forcing the whole page to scroll sideways.

const PAYMENT_CARD: React.CSSProperties = {
  border: `1px solid ${colors.border}`, borderRadius: '8px',
  padding: '9px 11px', background: colors.base,
  display: 'flex', flexDirection: 'column', gap: '5px', minWidth: 0,
}

// Primary row of a payment card: the payment number reads first, the amount is
// pushed to the trailing edge and stays on the same line until the number is too
// long to share it, at which point the amount simply wraps beneath.
function PaymentCardPrimaryRow({ number, amount }: { number: string; amount: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
      <span style={{ fontSize: '13px', fontWeight: 700, color: colors.primary, minWidth: 0, wordBreak: 'break-word', letterSpacing: '0.01em' }}>
        {number}
      </span>
      <span style={{ fontSize: '15px', fontWeight: 700, color: colors.primary, fontVariantNumeric: 'tabular-nums', marginLeft: 'auto', whiteSpace: 'nowrap' }}>
        {fmtAmount(amount)}
      </span>
    </div>
  )
}

// Compact "a · b · c" metadata line. Absent parts are DROPPED rather than shown
// as a bare dash — a missing reference should read as nothing at all, not as an
// empty field the reader has to interpret.
function PaymentMetaLine({ parts, style }: { parts: (string | null | undefined)[]; style?: React.CSSProperties }) {
  const shown = parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
  if (shown.length === 0) return null
  return (
    <div style={{
      fontSize: '11.5px', color: colors.muted, lineHeight: 1.45,
      display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '2px 6px', minWidth: 0,
      ...style,
    }}>
      {shown.map((part, i) => (
        <span key={i} style={{ display: 'contents' }}>
          {i > 0 && <span aria-hidden="true">·</span>}
          <span style={{ minWidth: 0, wordBreak: 'break-word' }}>{part}</span>
        </span>
      ))}
    </div>
  )
}

// ── Payment-link panel (order-first workflow) ─────────────────────────────────
// Reuses the SAME guarded backend path Finance's Link modal uses —
// link_finance_payment_to_order_request (20260698) — never a direct column
// update and never a second RPC. Suspense eligibility mirrors Finance exactly:
// approved_unlinked, order_id null, order_request_id null. Nothing loads until
// the user explicitly searches or views all.
//
// This is now the SECOND VIEW of the Payment Received modal rather than a
// permanent strip at the bottom of the page. Only its container chrome changed:
// every query, filter, eligibility rule, RPC call, error translation and
// stale-row rule below is exactly what the page-level panel ran.

function RequestPaymentLinkPanel({
  request,
  supabase,
  searchInputRef,
  ownOnlyUserId,
  backAction,
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
  /** The modal's "Back to linked payments" control, rendered on the header row
   *  beside the view-all action so the two browsing controls share one line. */
  backAction?: React.ReactNode
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

  const inputStyle: React.CSSProperties = {
    padding: '7px 10px', borderRadius: '6px',
    border: `1px solid ${colors.border}`,
    background: colors.base, color: colors.primary,
    fontSize: '12.5px', width: '100%', boxSizing: 'border-box', outline: 'none',
  }

  return (
    // A VIEW of the Payment Received modal, not a card of its own: the dialog
    // owns the frame and the padding, so this contributes only its own stack of
    // controls and results. No border, no raised strip, no fixed width — the
    // modal body is already the container.
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0 }}>
      {/* Browsing controls — Back on the left, the quiet view-all action on the
          right. They sit here rather than in the search row so Search stays the
          one obvious action; on a narrow width they simply wrap. The view title
          is the modal's header, so no second heading repeats it. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
        {backAction}
        <button
          type="button"
          onClick={handleViewAll}
          disabled={searching}
          style={{
            background: 'none', border: 'none', padding: 0, font: 'inherit',
            fontSize: '11.5px', fontWeight: 600, color: colors.blue,
            cursor: searching ? 'not-allowed' : 'pointer',
            opacity: searching ? 0.6 : 1, whiteSpace: 'nowrap',
            marginLeft: 'auto',
          }}
        >
          {ownOnlyUserId ? 'View available payments' : 'View all suspense payments'}
        </button>
      </div>

      {/* Standing guidance. Carries the eligibility rule that used to be shown
          only before the first search, so it is stated whatever the state. */}
      <div style={{ fontSize: '11.5px', color: colors.muted, lineHeight: 1.5 }}>
        {ownOnlyUserId
          ? 'Search your available unlinked payments and connect one to this order request. Only payments approved and not yet attached elsewhere can be linked.'
          : 'Search the unlinked suspense ledger and connect a payment to this order request.'}
      </div>

      {/* Search row */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'stretch' }}>
        <input
          ref={searchInputRef}
          style={{ ...inputStyle, flex: '1 1 220px', minWidth: 0 }}
          value={query}
          onChange={e => { setQuery(e.target.value); if (inputNotice) setInputNotice(null) }}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleSearch() } }}
          // Names exactly the columns buildSuspenseSearchConds() actually
          // queries — request_number, client_name, proof_note, amount and an
          // EXACT ISO date — so the field never advertises a search it cannot do.
          placeholder="Search by payment number, client, UTR, amount or date (YYYY-MM-DD)"
          aria-label={ownOnlyUserId ? 'Search your available payments' : 'Search suspense payments'}
        />
        <button
          type="button"
          onClick={handleSearch}
          disabled={!query.trim() || searching}
          style={{
            // #DC1F2E is this module's established primary-action fill (New Order
            // Request, Confirm & Convert, Request Clarification) — not a
            // destructive colour here.
            padding: '7px 18px', borderRadius: '6px', fontSize: '12.5px', fontWeight: 600,
            background: '#DC1F2E', border: 'none', color: '#fff',
            cursor: (!query.trim() || searching) ? 'not-allowed' : 'pointer',
            opacity: (!query.trim() || searching) ? 0.6 : 1,
            flexShrink: 0,
          }}
        >
          Search
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
        // Nothing searched yet — the standing guidance above already says what
        // this box does, so no second paragraph repeats it here.
        null
      ) : results.length === 0 ? (
        <div style={{ fontSize: '12px', color: colors.muted, padding: '6px 0' }}>
          {ownOnlyUserId
            ? 'None of your payments are available to link. A payment must be approved by an admin first.'
            : 'No available suspense payments found.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {results.map(p => (
            // Same card language as a linked payment: number and amount on the
            // primary row, everything else as compact metadata beneath — the
            // action rides the last row so the card never grows a fourth line
            // just to hold a button.
            <div key={p.id} style={PAYMENT_CARD}>
              <PaymentCardPrimaryRow number={p.request_number} amount={p.amount} />
              <PaymentMetaLine parts={[p.client_name, fmtDate(p.payment_date)]} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <PaymentMetaLine
                  parts={[
                    PAYMENT_MODE_LABEL[p.payment_mode] ?? p.payment_mode,
                    RECEIVED_IN_LABEL[p.received_in] ?? p.received_in,
                    p.proof_note ? `Ref ${p.proof_note}` : null,
                  ]}
                  style={{ flex: '1 1 200px' }}
                />
                <button
                  type="button"
                  onClick={() => { setError(null); setConfirmTarget(p) }}
                  disabled={linking}
                  style={{
                    flexShrink: 0, padding: '5px 12px', borderRadius: '6px',
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
              {p.sales_note && (
                <div style={{ fontSize: '11.5px', color: colors.muted, wordBreak: 'break-word' }}>
                  {p.sales_note}
                </div>
              )}
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

// ── Linked payments list ──────────────────────────────────────────────────────
// The payments actually attached to this request, read by the detail page with
// the viewer's own RLS on order_request_id — the only linkage an open request
// can have. Admins and the requester see the identical list; only the available
// actions differ.
//
// This used to be a permanently expanded panel at the bottom of the detail page.
// It is now the DEFAULT VIEW of the Payment Received modal, opened from the
// Commercial Summary figure it explains. The rows, the per-row permission rules
// and the three actions are unchanged — only where they are rendered moved.

function LinkedPaymentList({
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
  // manual selection has no such row, so the line is simply omitted rather than
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

  if (error)   return <div style={{ fontSize: '12.5px', color: colors.red, lineHeight: 1.5 }}>{error}</div>
  if (loading) return <div style={{ fontSize: '12.5px', color: colors.muted }}>Loading payments…</div>
  if (rows.length === 0) {
    return <div style={{ fontSize: '12.5px', color: colors.muted, lineHeight: 1.5 }}>No payments linked yet.</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 }}>
      {rows.map(p => {
        const meta = paymentStatusMeta(p)
        return (
          <div key={p.id} style={PAYMENT_CARD}>
            <PaymentCardPrimaryRow number={p.request_number} amount={p.amount} />

            {/* Secondary metadata — date, mode, where it landed, the client, and
                the reference only when there is one. */}
            <PaymentMetaLine
              parts={[
                fmtDate(p.payment_date),
                PAYMENT_MODE_LABEL[p.payment_mode] ?? p.payment_mode,
                RECEIVED_IN_LABEL[p.received_in] ?? p.received_in,
                p.client_name || null,
                p.proof_note ? `Ref ${p.proof_note}` : null,
              ]}
            />

            {/* Supporting row — status, the people on the record, and the
                row's actions. Wraps as a unit; the actions never leave the
                card they belong to. */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: '8px 12px', flexWrap: 'wrap', marginTop: '1px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', minWidth: 0, flex: '1 1 200px' }}>
                <span style={{
                  display: 'inline-block', padding: '2px 8px', borderRadius: '5px',
                  background: meta.bg, color: meta.color, border: `1px solid ${meta.border}`,
                  fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0,
                }}>
                  {meta.label}
                </span>
                <PaymentMetaLine
                  parts={[
                    p.submitted_by_name ? `Submitted by ${p.submitted_by_name}` : null,
                    linkedBy[p.id] ? `Linked by ${linkedBy[p.id]}` : null,
                  ]}
                  style={{ flex: '1 1 auto' }}
                />
              </div>
              <span style={{ display: 'inline-flex', gap: '4px', alignItems: 'center', flexShrink: 0, flexWrap: 'wrap' }}>
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
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Payment Received modal ────────────────────────────────────────────────────
// ONE dialog for everything payment-related on the detail page, opened from the
// Payment Received figure in the Commercial Summary. It replaces the permanent
// payments panel that used to sit at the bottom of the record: the information
// is worth reading, but not worth a page-length section that is expanded at all
// times.
//
// TWO VIEWS, never two dialogs. `linked` is the list of payments attached to the
// request; `available` is the suspense search that attaches another. Switching
// between them swaps the body of THIS modal, so nothing ever stacks on top of
// it — that matters because a second overlay at the shared Finance z-layer would
// also arm a second Escape handler.
//
// The view is owned by the PAGE (see the detail page's paymentModalView), so the
// deep-link that used to open the link panel — ?link=1 from the Order Requests
// list — still lands straight on the search with the input focused.
//
// The shell is handwritten from the shared Finance modal primitives rather than
// FinanceModal/RequestModalShell: this needs a sticky header, a scrolling body
// and a pinned footer around a single-column card list, which is neither of
// those two shapes. It uses the SAME overlay/dialog z-layers and the SAME
// scroll-lock + Escape hook, exactly as PreviewShell below does.

export function RequestPaymentsModal({
  request: r,
  supabase,
  rows,
  linkedBy,
  loading,
  error,
  isAdmin,
  currentUserId,
  /** canManagePayments — the same gate the two linkage RPCs enforce. Viewing is
   *  open to anyone who can already read the request; only linking is gated. */
  canLink,
  view,
  onViewChange,
  searchInputRef,
  onView,
  onEdit,
  onUnlink,
  onLinked,
  onClose,
}: {
  request: OrderRequest
  supabase: ReturnType<typeof createClient>
  rows: LinkedPayment[]
  linkedBy: Record<string, string>
  loading: boolean
  error: string | null
  isAdmin: boolean
  currentUserId: string
  canLink: boolean
  view: 'linked' | 'available'
  onViewChange: (view: 'linked' | 'available') => void
  searchInputRef: React.RefObject<HTMLInputElement | null>
  onView:   (p: LinkedPayment) => void
  onEdit:   (p: LinkedPayment) => void
  onUnlink: (p: LinkedPayment) => void
  onLinked: (payment: SuspensePayment) => void
  onClose: () => void
}) {
  useModalScrollLockAndEscape(onClose)
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => { dialogRef.current?.focus() }, [])

  // The page reports a successful link in its own banner, which the modal's
  // backdrop covers for as long as this stays open — so the same sentence is
  // also stated HERE, beside the list the payment was just added to. It is the
  // page's message repeated, not a second source of truth, and it is dropped the
  // moment the reader goes back to search for another payment.
  const [linkedNotice, setLinkedNotice] = useState<string | null>(null)

  const total    = rows.reduce((sum, p) => sum + (Number.isFinite(p.amount) ? p.amount : 0), 0)
  const linking  = view === 'available'
  // The link view holds a typed search term, so its backdrop is inert — the BOE
  // form-modal dismissal rule (docs 05_Business_Rules.md). The read-only linked
  // view keeps click-away-to-close. Escape and the × close either way.
  const closeOnBackdrop = !linking

  return (
    <>
      <div
        onClick={closeOnBackdrop ? onClose : undefined}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: FINANCE_MODAL_OVERLAY_Z }}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={linking ? `Link a payment to ${r.request_number}` : `Payments linked to ${r.request_number}`}
        tabIndex={-1}
        style={{
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          // Card lists, not a table: 620px is enough for a payment card to read
          // on one or two lines and narrow enough to stay comfortable. It shrinks
          // to the viewport on a phone, so nothing scrolls sideways.
          width: '620px', maxWidth: 'calc(100vw - 24px)', maxHeight: '88vh',
          background: colors.base, borderRadius: '12px', border: `1px solid ${colors.border}`,
          boxShadow: '0 12px 40px rgba(0,0,0,0.16)', zIndex: FINANCE_MODAL_DIALOG_Z,
          display: 'flex', flexDirection: 'column', overflow: 'hidden', outline: 'none',
        }}
      >
        {/* ── Sticky header — stays readable however long the list runs ── */}
        <div style={{
          padding: '14px 18px', borderBottom: `1px solid ${colors.border}`,
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexShrink: 0,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '16px', fontWeight: 700, color: colors.primary, lineHeight: 1.25, wordBreak: 'break-word' }}>
              {linking ? 'Link payment' : 'Payment Received'}
            </div>
            <div style={{ fontSize: '12px', color: colors.tertiary, marginTop: '3px', wordBreak: 'break-word', fontVariantNumeric: 'tabular-nums' }}>
              {linking
                ? `Select an eligible suspense payment to link to ${r.request_number}.`
                : loading
                  ? `${r.request_number} · Loading…`
                  : error
                    ? r.request_number
                    : rows.length > 0
                      ? `${r.request_number} · ${rows.length} linked · ${fmtAmount(total)}`
                      : `${r.request_number} · No payments linked`}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="boe-btn boe-btn-ghost"
            style={{ padding: '4px 10px', fontSize: '13px', flexShrink: 0 }}
          >
            ✕
          </button>
        </div>

        {/* ── Scrolling body — the only scroller in the dialog, and vertical
               only, so a long payment number or client name wraps instead of
               pushing the card sideways. ── */}
        <div style={{
          padding: '14px 18px', overflowY: 'auto', overflowX: 'hidden', flex: 1,
          display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0,
        }}>
          {linking ? (
            <RequestPaymentLinkPanel
              request={r}
              supabase={supabase}
              searchInputRef={searchInputRef}
              // A non-admin's link search is restricted to their own submissions;
              // an admin keeps the full suspense-ledger search.
              ownOnlyUserId={isAdmin ? null : currentUserId}
              backAction={
                <button
                  type="button"
                  onClick={() => { setLinkedNotice(null); onViewChange('linked') }}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: '3px',
                    background: 'none', border: 'none', padding: 0, font: 'inherit',
                    fontSize: '11.5px', fontWeight: 600, color: colors.blue, cursor: 'pointer',
                  }}
                >
                  <ChevronLeft size={13} strokeWidth={2.2} aria-hidden="true" />
                  Back to linked payments
                </button>
              }
              onLinked={p => {
                setLinkedNotice(`${fmtAmount(p.amount)} from ${p.client_name} linked to ${r.request_number}.`)
                onLinked(p)
              }}
            />
          ) : (
            <>
              {linkedNotice && (
                <div style={{
                  display: 'flex', alignItems: 'flex-start', gap: '8px',
                  padding: '9px 12px', borderRadius: '8px',
                  background: '#F0FDF4', border: '1px solid #BBF7D0',
                  fontSize: '12.5px', color: '#166534', lineHeight: 1.5,
                }}>
                  <span style={{ display: 'flex', flexShrink: 0, marginTop: '1px' }}>
                    <CheckCircle2 size={14} strokeWidth={2} aria-hidden="true" />
                  </span>
                  <span style={{ minWidth: 0, wordBreak: 'break-word' }}>{linkedNotice}</span>
                </div>
              )}
              <LinkedPaymentList
                request={r}
                rows={rows}
                linkedBy={linkedBy}
                loading={loading}
                error={error}
                isAdmin={isAdmin}
                currentUserId={currentUserId}
                onView={onView}
                onEdit={onEdit}
                onUnlink={onUnlink}
              />
            </>
          )}
        </div>

        {/* ── Pinned footer — the one action the linked view offers, and only to
               a viewer the linkage RPCs would actually accept. ── */}
        {!linking && canLink && (
          <div style={{
            padding: '11px 18px', borderTop: `1px solid ${colors.border}`, flexShrink: 0,
            background: colors.base, display: 'flex', justifyContent: 'flex-end',
          }}>
            <button
              type="button"
              onClick={() => { setLinkedNotice(null); onViewChange('available') }}
              style={{
                // #DC1F2E is this module's established primary-action fill — not
                // a destructive colour here.
                padding: '7px 18px', borderRadius: '6px', fontSize: '12.5px', fontWeight: 600,
                background: '#DC1F2E', border: 'none', color: '#fff', cursor: 'pointer',
              }}
            >
              Link payment
            </button>
          </div>
        )}
      </div>
    </>
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

// ── Previewing an attachment ──────────────────────────────────────────────────
// Order Requests use the SAME preview surface as Task Management
// (@/components/ui/AttachmentPreviewModal) instead of a second, module-local
// renderer. That component already handles every type BOE accepts, and reusing
// it is what makes an Excel Main PI render with its real formatting, merged
// cells, column widths, embedded images and sheet tabs — none of which the
// module-local xlsx→<table> reconstruction it replaces could ever show, because
// that path only ever extracted cell VALUES.
//
// READ THIS BEFORE TOUCHING THE EXCEL PATH — it is the one non-BOE dependency in
// this file. The shared component renders .xlsx/.xls in an iframe pointed at
// Microsoft's public Office Online viewer (view.officeapps.live.com), which
// works by having MICROSOFT'S SERVERS FETCH THE FILE URL. In Task Management
// that costs nothing: `task-attachments` is a PUBLIC bucket whose URLs are
// permanent and unauthenticated already. Order Request attachments are the
// opposite — a private bucket read through short-lived signed URLs — so handing
// one to that viewer discloses the workbook to a third party for the life of the
// URL.
//
// The Excel path is therefore ROLE-GATED: only an admin, the person who actually
// has to approve the request against its PI, can open a workbook in the shared
// preview. For everyone else an Excel attachment is download-only and the
// disclosure never happens. See canPreviewAttachment() for the rule and the note
// rendered in RequestAttachmentsCard, which tells the admin where the render
// comes from rather than leaving them to assume it is local.
//
// Nothing about storage changes: the bucket stays private, the signed URL is
// minted on demand per open, and it is never persisted, logged, or written into
// any activity or notification payload.

// Preview URLs live a little longer than download URLs (5 min vs 60 s) because
// the reader is expected to actually look at the file — and, for a workbook,
// because Office Online has to fetch it server-side before anything renders.
// Still short-lived, still scoped to one object in a private bucket.
const PREVIEW_URL_TTL  = 300
const DOWNLOAD_URL_TTL = 60

// The rule itself lives in ./shared (canPreviewAttachment) with the module's
// other pure permission guards, so it is testable without a DOM and cannot drift
// between the button that offers the preview and the modal that performs it.

// Mints a signed URL for one attachment and hands it to the shared preview.
//
// This wrapper is why the shared component did not have to change: Task
// Management already holds a ready-to-use public URL, while an Order Request
// must first exchange a private storage path for a short-lived signed one. That
// exchange happens here, once per open — never during render, so no loop can
// mint URLs.
function RequestAttachmentPreview({ row, supabase, onClose }: {
  row: RequestAttachmentRow
  supabase: ReturnType<typeof createClient>
  onClose: () => void
}) {
  const [url,    setUrl]    = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    ;(async () => {
      const { data, error } = await supabase.storage
        .from(ORDER_REQ_ATTACHMENT_BUCKET)
        .createSignedUrl(row.storage_path, PREVIEW_URL_TTL)
      if (!active) return
      if (error || !data?.signedUrl) { setFailed(true); return }
      setUrl(data.signedUrl)
    })()
    return () => { active = false }
  }, [supabase, row.storage_path])

  if (!url) {
    return (
      <PreviewShell onClose={onClose}>
        {failed
          ? 'This file could not be opened. It may have been moved or removed.'
          : 'Preparing preview…'}
      </PreviewShell>
    )
  }
  // Passed straight through: the signed URL is held in this component's state for
  // the life of the open modal and goes nowhere else.
  return <AttachmentPreviewModal url={url} fileName={row.file_name} onClose={onClose} />
}

// Shown only while the signed URL is being minted, or when it could not be.
// Deliberately mirrors the shared modal's own overlay (same dim, same z-layer,
// which sits above this module's 200/201 dialogs and the fixed sidebar) so the
// preview does not visibly jump between two different shells.
const SHARED_PREVIEW_OVERLAY_Z = 9999

function PreviewShell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  useModalScrollLockAndEscape(onClose)
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: SHARED_PREVIEW_OVERLAY_Z,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: colors.base, borderRadius: '12px', padding: '28px 32px',
          fontSize: '13px', color: colors.secondary, textAlign: 'center',
          boxShadow: '0 8px 40px rgba(0,0,0,0.3)',
        }}
      >
        {children}
      </div>
    </div>
  )
}

// One attachment, laid out in TWO ROWS: identity first, actions underneath.
//
// The single-row version this replaces put the filename and every button on one
// flex line, so the name was the only thing that could give way — it was pinned
// to `white-space: nowrap` + ellipsis and a real PI name ("294 new Order with
// Replacement — Client Ltd.xlsx") arrived cut off, readable only by hovering for
// the title tooltip. The file's IDENTITY is the thing a reader needs most, so it
// now gets the full width and the buttons get their own line.
function AttachmentFileRow({
  row, supabase, onPreview, canPreview, primary, action, supersededLabel,
}: {
  row: RequestAttachmentRow
  supabase: ReturnType<typeof createClient>
  onPreview: (row: RequestAttachmentRow) => void
  /** Decided by the card from the viewer's role — see canPreviewAttachment. */
  canPreview: boolean
  primary?: boolean
  /** Edit-mode controls (Replace / Remove). Absent in read mode. */
  action?: React.ReactNode
  /** Set when a staged change will supersede this file on save. */
  supersededLabel?: string
}) {
  const [busy,  setBusy]  = useState(false)
  const [error, setError] = useState<string | null>(null)

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
      display: 'flex', flexDirection: 'column', gap: '8px',
      padding: primary ? '11px 12px' : '9px 10px', borderRadius: '8px',
      background: superseded ? colors.raised : primary ? '#FFFBEB' : colors.base,
      border: `1px solid ${superseded ? colors.border : primary ? '#FDE68A' : colors.border}`,
      opacity: superseded ? 0.75 : 1,
    }}>
      {/* ── Row 1: identity. The name takes every pixel the metadata does not. ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
        <span style={{
          display: 'flex', flexShrink: 0, marginTop: '1px',
          color: superseded ? colors.muted : primary ? '#92400E' : colors.tertiary,
        }}>
          {primary
            ? <FileSpreadsheet size={16} strokeWidth={1.8} />
            : <Paperclip size={14} strokeWidth={1.8} />}
        </span>
        <span
          title={row.file_name}
          style={{
            fontSize: primary ? '13.5px' : '12.5px',
            fontWeight: primary ? 600 : 400,
            color: colors.primary, flex: 1, minWidth: 0, lineHeight: 1.4,
            // Wraps instead of truncating, and `anywhere` lets a long unbroken
            // name (no spaces, no hyphens) break mid-token rather than forcing
            // the row to scroll. Capped at two lines so a pathological name
            // cannot push the actions off-screen.
            overflowWrap: 'anywhere',
            display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2,
            overflow: 'hidden',
          }}
        >
          {row.file_name}
        </span>
        {supersededLabel && (
          <span style={{ fontSize: '11px', fontWeight: 600, color: '#1E40AF', flexShrink: 0, marginTop: '1px' }}>
            {supersededLabel}
          </span>
        )}
        {row.uploaded_size_bytes != null && (
          <span style={{ fontSize: '11px', color: colors.muted, flexShrink: 0, marginTop: '2px' }}>
            {formatBytes(row.uploaded_size_bytes)}
          </span>
        )}
      </div>

      {/* ── Row 2: actions. Wraps on narrow widths; the name never shrinks for
             them. `action` carries the edit-mode controls and is supplied only
             where the caller has already established permission. ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
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
      </div>

      {error && <span style={{ fontSize: '11px', color: colors.red }}>{error}</span>}
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
  isAdmin = false,
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
  /** Gates the Excel preview only — see canPreviewAttachment. Defaults to false,
   *  so a caller that forgets to pass it gets the RESTRICTIVE behaviour. */
  isAdmin?: boolean
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

  // Whether the off-site Excel render is reachable from this card at all. Drives
  // the disclosure note below, so the note can never appear without the capability
  // or the capability without the note.
  const showsExcelPreview = rows.some(
    row => isExcelAttachmentName(row.file_name) && canPreviewAttachment(row.file_name, isAdmin),
  )

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
                    canPreview={canPreviewAttachment(mainPi.file_name, isAdmin)}
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
                      canPreview={canPreviewAttachment(row.file_name, isAdmin)}
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

        {/* Where the workbook render actually comes from. Stated once, and only
            to the people who can trigger it, because "preview" otherwise reads
            as an in-app render and this one is not: the file is fetched by
            Microsoft's servers to be rendered. */}
        {showsExcelPreview && (
          <div style={{ fontSize: '11px', color: colors.muted, lineHeight: 1.5, marginTop: '12px' }}>
            Excel previews are rendered by Microsoft Office Online, which retrieves the file from a
            temporary link. Download the file instead if it should not leave BOE.
          </div>
        )}
      </div>

      {preview && (
        <RequestAttachmentPreview
          key={preview.id}
          row={preview}
          supabase={supabase}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  )
}
