'use client'

// ── Order Request focused action modals ───────────────────────────────────────
// Convert, Request Clarification, Reject and Delete. Each is a single,
// irreversible-ish DECISION taken on one request — a confirmation with its own
// required input — so each stays a focused modal even though the request itself
// has a dedicated detail page (/orders/requests/[id]).
//
// Changing the request's own FIELDS is not a decision of that kind and is not
// here: it happens inline on the record (see RequestInlineEdit).
//
// Every authorization rule, RPC, notification and error mapping is unchanged
// from the original implementation on the list page.

import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import { AlertTriangle, X } from 'lucide-react'
import { notifyOrders } from '@/lib/notify'
import { formatINR } from '@/lib/currency'
import { orderNumberErrorMessage } from '@/lib/orderNumbering'
import { StatusBadge } from './RequestPanels'
import {
  convertGuardErrorMessage,
  deleteRequestErrorMessage,
  fmtAmount,
  fmtDate,
  normalizeClientName,
  paymentAccountLabel,
  sumAmounts,
  useEscapeToClose,
  LEAD_SOURCE_OPTIONS,
  NO_APPROVED_PAYMENT_MESSAGE,
  type ConvertResult,
  type EligiblePayment,
  type OrderRequest,
} from './shared'

// ── Convert modal presentation primitives ─────────────────────────────────────
// The Convert confirmation states three different payment sets — what transfers
// automatically, what is attached but not approved, and what the admin may
// additionally select — and they have to read as ONE structure, because the
// admin is comparing them. So all three go through the same frame, the same
// header treatment, the same row height and the same column alignment, defined
// once here at module scope rather than rebuilt on every render.
//
// The table is deliberately the heaviest element in the dialog: the summary card
// above it is grouped rows on a neutral background, no per-field tiles.

const SR_ONLY: React.CSSProperties = {
  position: 'absolute', width: '1px', height: '1px', padding: 0, margin: '-1px',
  overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0,
}

const CONVERT_LABEL: React.CSSProperties = {
  fontSize: '10px', fontWeight: 700, color: colors.muted,
  textTransform: 'uppercase', letterSpacing: '0.06em',
}

const TH: React.CSSProperties = {
  ...CONVERT_LABEL, padding: '7px 10px', textAlign: 'left', whiteSpace: 'nowrap',
}

const TD: React.CSSProperties = {
  padding: '8px 10px', fontSize: '12.5px', color: colors.secondary,
  whiteSpace: 'nowrap', verticalAlign: 'top',
}

// Amounts: right aligned, heavier than the row around them, and tabular so the
// rupee figures in a column line up digit for digit.
const TD_AMOUNT: React.CSSProperties = {
  ...TD, textAlign: 'right', fontWeight: 700, color: colors.primary,
  fontVariantNumeric: 'tabular-nums',
}

function SectionHeading({ title, note }: { title: string; note?: string }) {
  return (
    <>
      <h3 style={{ ...CONVERT_LABEL, margin: 0, whiteSpace: 'normal' }}>{title}</h3>
      {note && (
        <div style={{ fontSize: '11.5px', color: colors.tertiary, lineHeight: 1.45, margin: '3px 0 7px' }}>
          {note}
        </div>
      )}
      {!note && <div style={{ height: '6px' }} />}
    </>
  )
}

// Rounded, bordered frame around one payment table. The horizontal scroll lives
// HERE rather than on the dialog: on a narrow screen the table slides inside its
// own frame and the rest of the dialog stays put.
function TableFrame({ minWidth = 460, children }: { minWidth?: number; children: React.ReactNode }) {
  return (
    <div style={{
      border: `1px solid ${colors.border}`, borderRadius: '8px',
      overflow: 'hidden', background: colors.base,
    }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', minWidth: `${minWidth}px`, borderCollapse: 'collapse' }}>
          {children}
        </table>
      </div>
    </div>
  )
}

// Loading and empty states for a payment section: one compact line in the same
// frame the table would occupy, not a large dashed placeholder.
function TableNotice({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      border: `1px solid ${colors.border}`, borderRadius: '8px',
      background: colors.raised, padding: '10px 12px',
      fontSize: '12px', color: colors.muted,
    }}>
      {children}
    </div>
  )
}

// The Payment Request cell: the request number is the primary value, and the
// client name is secondary muted text shown only where the caller says it adds
// something. `strong` marks a selected row without relying on the tint.
function PaymentRef({
  payment: p,
  showClient = false,
  strong = false,
  otherClient = false,
}: {
  payment: EligiblePayment
  showClient?: boolean
  strong?: boolean
  otherClient?: boolean
}) {
  return (
    <span style={{ display: 'block', minWidth: 0 }}>
      <span style={{
        display: 'block', fontSize: '12.5px', fontWeight: strong ? 700 : 600,
        color: colors.primary, fontVariantNumeric: 'tabular-nums',
      }}>
        {p.request_number}
        {otherClient && (
          <span style={{
            marginLeft: '6px', fontSize: '10px', fontWeight: 600, whiteSpace: 'nowrap',
            color: '#9A3412', background: '#FFF7ED', border: '1px solid #FED7AA',
            borderRadius: '4px', padding: '1px 5px',
          }}>
            Different client
          </span>
        )}
      </span>
      {showClient && (
        <span style={{ display: 'block', fontSize: '11px', color: colors.muted, marginTop: '2px' }}>
          {p.client_name}
        </span>
      )}
    </span>
  )
}

// One field in the Order information card. A value the request does not carry
// reads as a quiet "Not provided" rather than an em dash given the weight of an
// answer; financial values carry slightly more weight than the rest.
function SummaryField({
  label,
  value,
  emphasis = false,
  span = false,
}: {
  label: string
  value: string | null
  emphasis?: boolean
  span?: boolean
}) {
  const provided = value != null && value !== ''
  return (
    <div style={{ minWidth: 0, gridColumn: span ? '1 / -1' : undefined }}>
      <div style={{ ...CONVERT_LABEL, marginBottom: '3px' }}>{label}</div>
      <div style={{
        fontSize: emphasis ? '14px' : '12.5px',
        fontWeight: emphasis ? 700 : 500,
        color: provided ? colors.primary : colors.muted,
        fontVariantNumeric: emphasis ? 'tabular-nums' : undefined,
        lineHeight: 1.45, wordBreak: 'break-word',
        whiteSpace: span ? 'pre-wrap' : undefined,
      }}>
        {provided ? value : 'Not provided'}
      </div>
    </div>
  )
}

// ── Convert to Order modal (admin only) ───────────────────────────────────────
// Confirmation only: every value that ends up on the official Order is derived
// server-side by convert_order_request_to_order(). There is deliberately no
// Order-number input and no editing of request fields here.

export function ConvertModal({
  request,
  onClose,
  onConverted,
}: {
  request: OrderRequest
  onClose: () => void
  onConverted: (result: ConvertResult) => void
}) {
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState<string | null>(null)
  const [payments, setPayments] = useState<EligiblePayment[]>([])
  const [preLinked, setPreLinked] = useState<EligiblePayment[]>([])
  const [loadingPayments, setLoadingPayments] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const supabase = useMemo(() => createClient(), [])

  // Eligible = approved but not yet attached to any Order OR any Order
  // Request. Payments already parked on THIS request (order_request_id,
  // 20260698) are loaded separately: the conversion RPC transfers them
  // automatically, so they are shown as fixed, not selectable. Payments
  // parked on a DIFFERENT request are excluded entirely. Admin-only data:
  // this relies on the existing finance_payment_requests admin SELECT policy,
  // so no Finance visibility is widened for anyone else. The DB order
  // (payment_date desc) is the newest-first tie-break preserved within each
  // client-match group by the stable sort in `sortedPayments` below — the
  // match/mismatch grouping itself has no column to sort by server-side,
  // since it depends on comparing against this specific request's client_name.
  const loadEligiblePayments = async () => {
    setLoadingPayments(true)
    // payment_mode + received_in are read as a PAIR: the account name the
    // payment table shows (HDFC / PNB / Paytm / Canara) exists only in the
    // combination, exactly as the Finance Payment Requests page reads it. Both
    // datasets below share this one column list, so the two tables can never
    // resolve the same payment to different accounts.
    const paymentColumns = 'id, request_number, client_name, amount, payment_date, payment_mode, received_in, proof_note, status, submitted_by_user:users!submitted_by(full_name)'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapRows = (rows: any[]): EligiblePayment[] => rows.map(p => ({
      id: p.id,
      request_number: p.request_number,
      client_name: p.client_name,
      amount: p.amount,
      payment_date: p.payment_date,
      payment_mode: p.payment_mode,
      received_in: p.received_in,
      proof_note: p.proof_note ?? null,
      status: p.status,
      submitted_by_name: p.submitted_by_user?.full_name ?? undefined,
    }))

    const [eligibleRes, preLinkedRes] = await Promise.all([
      supabase
        .from('finance_payment_requests')
        .select(paymentColumns)
        .eq('status', 'approved_unlinked')
        .is('order_id', null)
        .is('order_request_id', null)
        .order('payment_date', { ascending: false }),
      supabase
        .from('finance_payment_requests')
        .select(paymentColumns)
        .eq('order_request_id', request.id)
        .order('payment_date', { ascending: false }),
    ])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapped = mapRows((eligibleRes.data ?? []) as any[])
    setPayments(mapped)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setPreLinked(mapRows((preLinkedRes.data ?? []) as any[]))
    setLoadingPayments(false)
    return mapped
  }

  // Refresh eligibility whenever the modal opens.
  useEffect(() => {
    const onMount = () => { loadEligiblePayments() }
    onMount()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Matching-client-first, newest-first within each group. Array.prototype.sort
  // is a stable sort (guaranteed by spec since ES2019), so a comparator that
  // only looks at the match/mismatch boolean preserves the payment_date-desc
  // order the query already returned within each group — no secondary sort
  // key needed here.
  const requestClientNorm = useMemo(() => normalizeClientName(request.client_name), [request.client_name])
  const isClientMatch = (p: EligiblePayment) => normalizeClientName(p.client_name) === requestClientNorm
  const sortedPayments = useMemo(
    () => payments.slice().sort((a, b) => Number(isClientMatch(b)) - Number(isClientMatch(a))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [payments, requestClientNorm]
  )

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // ── What is actually attached to this request, by decision state ────────────
  // Since 20260715 a payment can be raised against a request BEFORE Finance has
  // decided anything, so "parked on this request" is no longer the same set as
  // "will transfer". Only approved payments transfer; the others are shown so
  // the admin can see what they still have to decide.
  const preLinkedApproved  = preLinked.filter(p => p.status === 'approved_unlinked')
  const preLinkedUndecided = preLinked.filter(p => p.status === 'pending_approval' || p.status === 'needs_clarification')
  const preLinkedRejected  = preLinked.filter(p => p.status === 'rejected')

  const selectedList  = payments.filter(p => selected.has(p.id))
  // Both figures sum EXACTLY the rows listed beneath them and nothing else: the
  // transferring total covers the approved pre-linked rows only — never an
  // undecided or rejected one, which are not money — and the selected total
  // covers the live selection. Same helper for both, so a total can never come
  // from a different set than the table it labels.
  const selectedTotal   = sumAmounts(selectedList)
  const transferTotal   = sumAmounts(preLinkedApproved)

  // The two conversion guards, mirrored. convert_order_request_to_order enforces
  // both under row locks and is the actual gate — this only tells the admin
  // before they click, and never widens what the RPC would accept. The eligible
  // list excludes anything already parked on a request, so the two counts below
  // cannot overlap.
  const transferCount = preLinkedApproved.length + selected.size
  const blockedReason =
    loadingPayments                 ? null :
    transferCount === 0             ? NO_APPROVED_PAYMENT_MESSAGE :
    preLinkedUndecided.length > 0   ? `${preLinkedUndecided.length} payment request${preLinkedUndecided.length !== 1 ? 's' : ''} linked to this request ${preLinkedUndecided.length !== 1 ? 'are' : 'is'} still awaiting a finance decision. Approve or reject ${preLinkedUndecided.length !== 1 ? 'them' : 'it'} before converting.`
                                    : null
  // Display/warning only — never blocks selection or conversion. Recomputed
  // from the live selection, so it appears and disappears exactly with
  // deselection, no separate state to keep in sync.
  const mismatchedSelected = selectedList.filter(p => !isClientMatch(p))

  // Escape closes; the backdrop does not (form-modal dismissal rule). Selected
  // payments are unsaved input, so an outside click must never discard them.
  useEscapeToClose(onClose, !saving)

  // ── Modality ────────────────────────────────────────────────────────────────
  // The dialog IS the modal for as long as it is open: the page behind it does
  // not scroll (so the reader cannot lose the dialog while scrolling a long
  // payment table), and Tab cycles inside it, so a keyboard user cannot reach
  // the request page underneath. Focus starts on the dialog, which is what
  // makes the accessible name announce before anything inside it. Escape
  // dismissal stays with useEscapeToClose above — deliberately inert while a
  // conversion is in flight.
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus()

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const dialog = dialogRef.current
      if (!dialog) return
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')
      ).filter(el => el.offsetParent !== null)
      if (focusable.length === 0) return
      const first  = focusable[0]
      const last   = focusable[focusable.length - 1]
      const active = document.activeElement
      // Only the two boundaries are intercepted — every Tab in between is the
      // browser's own, so reading order inside the dialog is untouched.
      if (e.shiftKey && (active === first || active === dialog)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)

    return () => {
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  const handleConvert = async () => {
    if (saving || blockedReason) return  // the RPC is the real guard for both
    setSaving(true)
    setError(null)

    const { data, error: rpcErr } = await supabase.rpc('convert_order_request_to_order', {
      p_order_request_id:    request.id,
      p_payment_request_ids: Array.from(selected),
    })

    if (rpcErr || !data) {
      // A payment we offered was linked by someone else in the meantime: re-read
      // eligibility, drop what is gone from the selection, and keep the modal
      // open. Nothing was created — the RPC rolled the whole conversion back.
      if (rpcErr?.message?.includes('STALE_PAYMENTS')) {
        const fresh = await loadEligiblePayments()
        const stillEligible = new Set(fresh.map(p => p.id))
        setSelected(prev => new Set(Array.from(prev).filter(id => stillEligible.has(id))))
        setError('One or more selected payments are no longer available. The list has been refreshed.')
      } else {
        // The two payment guards (20260715 §7) come first: each names a rule the
        // admin can act on, and a retry cannot fix either. Like STALE_PAYMENTS
        // the whole conversion rolled back — no Order, no moved payment, and the
        // Order number cycle did not advance.
        //
        // Order numbering failures (20260703000000) then get their own
        // plain-language sentence, for the same reason.
        const guard = convertGuardErrorMessage(rpcErr?.message)
        if (guard) {
          // The guard was evaluated against committed state, which may be newer
          // than what this modal is showing — re-read so the panel and the
          // message agree.
          await loadEligiblePayments()
          setError(guard)
        } else {
          const numbering = orderNumberErrorMessage(rpcErr?.message, 'conversion')
          setError(numbering ?? 'Could not convert this request. Please refresh and try again.')
        }
      }
      setSaving(false)
      return
    }

    const result = data as ConvertResult

    // Notify the creator and the assigned user of the conversion. Any payments
    // linked during conversion are covered by this single notification.
    //
    // entityId is the ORDER id, not the request id — unlike every other Order
    // notification. The subject of this event is the Confirmed Order that now
    // exists, and getNotificationMeta routes order_converted to /orders/{id}
    // accordingly. Pointing it at the request would deep-link into the Order
    // Requests module, which no longer surfaces converted requests.
    void notifyOrders({
      event: 'order_converted',
      requestNumber: request.request_number,
      entityId: result.order_id,
      clientName: request.client_name,
      creatorId: request.requested_by,
      assignedTo: request.assigned_to,
      orderNumber: result.order_display_number,
    })

    onConverted(result)
  }

  // ── Order information summary ───────────────────────────────────────────────
  // Grouped in reading order — who and what, then when, then how much — so the
  // commercial figures sit last, immediately above the payment tables they have
  // to be reconciled against. `null` means the request genuinely does not carry
  // the value and reads as a quiet "Not provided"; an em dash is never given the
  // weight of an answer.
  const carried: { label: string; value: string | null; emphasis?: boolean; span?: boolean }[] = [
    { label: 'Client',              value: request.client_name },
    { label: 'Lead Source',         value: LEAD_SOURCE_OPTIONS.find(o => o.value === request.lead_source)?.label ?? null },
    { label: 'Requested By',        value: request.requested_by_name ?? null },
    { label: 'Assignee',            value: request.assigned_to_name ?? null },
    { label: 'Confirmation Date',   value: request.confirm_date ? fmtDate(request.confirm_date) : null },
    { label: 'Due Date',            value: request.due_date ? fmtDate(request.due_date) : null },
    { label: 'Total Product Value', value: request.total_product_value == null ? null : fmtAmount(request.total_product_value), emphasis: true },
    { label: 'Total Order Value',   value: request.total_value == null ? null : fmtAmount(request.total_value), emphasis: true },
    { label: 'Notes',               value: request.notes?.trim() || null, span: true },
  ]

  // Everything that ends up attached to the new Order, for the footer's running
  // count — the two sets the two tables list, and nothing else.
  const footerTotal = sumAmounts([...preLinkedApproved, ...selectedList])

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
      // Backdrop is inert by design (BOE form-modal dismissal rule): an outside
      // click never closes and never discards entered data. Dismiss via ×,
      // Cancel, Escape (useEscapeToClose above), or a successful submit.
    >
      {/* ── Dialog: fixed header, one scrolling body, pinned footer ──
             The dialog itself never scrolls (overflow: hidden) — the body is the
             single scroller, so the title, the request being converted and the
             two actions stay on screen however long the payment tables run, and
             the page behind never scrolls (lock effect above).

             880px is what the four-column payment table needs to read without
             wrapping; it is capped at the viewport so a laptop or a phone gets
             the same dialog, narrower, with the tables scrolling sideways inside
             their own frames rather than the dialog. ── */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="convert-order-title"
        tabIndex={-1}
        style={{
          background: colors.base,
          border: `1px solid ${colors.border}`,
          borderRadius: '12px',
          width: '100%', maxWidth: '880px',
          maxHeight: 'calc(100vh - 32px)',
          boxShadow: '0 12px 40px rgba(0,0,0,0.18)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden', outline: 'none',
        }}
      >
        {/* ── Header — what is being converted, and into what ── */}
        <div style={{
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '14px',
          padding: '14px 20px', borderBottom: `1px solid ${colors.border}`, flexShrink: 0,
        }}>
          <div style={{ minWidth: 0 }}>
            <h2 id="convert-order-title" style={{
              margin: 0, fontSize: '16px', fontWeight: 700, color: colors.primary, lineHeight: 1.25,
            }}>
              Convert to Official Order
            </h2>
            <div style={{
              fontSize: '12.5px', fontWeight: 600, color: colors.secondary, marginTop: '3px',
              fontVariantNumeric: 'tabular-nums', wordBreak: 'break-word',
            }}>
              {request.request_number} · {request.client_name}
            </div>
            <div style={{ fontSize: '11.5px', color: colors.tertiary, marginTop: '4px', lineHeight: 1.45 }}>
              This request and the payments below become part of a new official Order,
              numbered automatically when you confirm.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
            style={{
              background: 'none', border: 'none', padding: '2px', display: 'flex', flexShrink: 0,
              color: colors.muted, cursor: saving ? 'not-allowed' : 'pointer',
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* ── Body — the only scroller in the dialog. Every direct child is
               flexShrink: 0 so a child that clips its own overflow (the table
               frames) keeps its natural height instead of being squashed. ── */}
        <div style={{
          flex: 1, overflowY: 'auto', overflowX: 'hidden',
          padding: '14px 20px 18px',
          display: 'flex', flexDirection: 'column', gap: '16px',
        }}>
          {/* ── 1. Conversion warning ── */}
          <div style={{
            flexShrink: 0, display: 'flex', gap: '9px',
            fontSize: '12px', color: '#92400E',
            background: '#FFFBEB', border: '1px solid #FDE68A',
            borderRadius: '8px', padding: '9px 11px', lineHeight: 1.45,
          }}>
            <span style={{ display: 'flex', flexShrink: 0, marginTop: '1px' }}>
              <AlertTriangle size={14} strokeWidth={2.2} aria-hidden="true" />
            </span>
            <span style={{ minWidth: 0 }}>
              <strong style={{ fontWeight: 700 }}>Permanent conversion.</strong>{' '}
              This request will be marked Converted and linked to the newly created
              official Order. This action cannot be reversed.
            </span>
          </div>

          {/* ── 2. Order information summary — two columns on desktop, one when
                 the dialog is narrower than the pair can hold. ── */}
          <div style={{ flexShrink: 0 }}>
            <SectionHeading title="Order information" />
            <div style={{
              border: `1px solid ${colors.border}`, borderRadius: '8px',
              background: colors.raised, padding: '13px 15px',
              display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              columnGap: '22px', rowGap: '11px',
            }}>
              {carried.map(f => (
                <SummaryField
                  key={f.label}
                  label={f.label}
                  value={f.value}
                  emphasis={f.emphasis}
                  span={f.span}
                />
              ))}
            </div>
          </div>

          {/* ── The reason this conversion cannot proceed ──
                 Stated ABOVE the payment lists, because it is the thing the
                 admin has to resolve before anything below matters. The RPC
                 enforces both rules independently under row locks; this only
                 saves a round trip. */}
          {blockedReason && (
            <div style={{
              flexShrink: 0, fontSize: '12px', color: '#991B1B',
              background: '#FEF2F2', border: '1px solid #FECACA',
              borderRadius: '8px', padding: '9px 12px', lineHeight: 1.45,
            }}>
              {blockedReason}
            </div>
          )}

          {/* ── 3. Approved payments on this request — transfer automatically ── */}
          <div style={{ flexShrink: 0 }}>
            <SectionHeading
              title="Payments transferring to the official order"
              note="These approved payments are already linked to this request and will transfer automatically."
            />
            {loadingPayments ? (
              <TableNotice>Loading payments…</TableNotice>
            ) : preLinkedApproved.length === 0 ? (
              <TableNotice>No approved payment is linked to this request yet.</TableNotice>
            ) : (
              <TableFrame>
                <thead>
                  <tr style={{ background: colors.raised }}>
                    <th scope="col" style={TH}>Payment Request</th>
                    <th scope="col" style={TH}>Date</th>
                    <th scope="col" style={TH}>Payment Mode</th>
                    <th scope="col" style={{ ...TH, textAlign: 'right' }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {preLinkedApproved.map(p => (
                    <tr key={p.id} style={{ borderTop: `1px solid ${colors.border}` }}>
                      <td style={TD}>
                        {/* Already linked to THIS request, so its client is the
                            header's client — named only when it is not, which is
                            the one case the reader needs it. */}
                        <PaymentRef payment={p} showClient={!isClientMatch(p)} />
                      </td>
                      <td style={TD}>{fmtDate(p.payment_date)}</td>
                      <td style={TD}>{paymentAccountLabel(p.payment_mode, p.received_in)}</td>
                      <td style={TD_AMOUNT}>{fmtAmount(p.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: `1px solid ${colors.borderSoft}`, background: colors.raised }}>
                    <th scope="row" colSpan={3} style={{ ...TD, textAlign: 'left', fontWeight: 600, color: colors.secondary }}>
                      Total transferring
                    </th>
                    <td style={TD_AMOUNT}>{fmtAmount(transferTotal)}</td>
                  </tr>
                </tfoot>
              </TableFrame>
            )}
          </div>

          {/* ── Payments on this request that are NOT approved ──
                 Listed separately and never as money: no total, and the amounts
                 stay muted. The undecided ones block conversion; a rejected one
                 does not, and stays on the request as history rather than
                 transferring. */}
          {!loadingPayments && (preLinkedUndecided.length > 0 || preLinkedRejected.length > 0) && (
            <div style={{ flexShrink: 0 }}>
              <SectionHeading
                title="Linked payments not approved"
                note="These are not received money and will not transfer to the official order."
              />
              <TableFrame minWidth={560}>
                <thead>
                  <tr style={{ background: colors.raised }}>
                    <th scope="col" style={TH}>Payment Request</th>
                    <th scope="col" style={TH}>Status</th>
                    <th scope="col" style={TH}>Date</th>
                    <th scope="col" style={TH}>Payment Mode</th>
                    <th scope="col" style={{ ...TH, textAlign: 'right' }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {[...preLinkedUndecided, ...preLinkedRejected].map(p => (
                    <tr key={p.id} style={{ borderTop: `1px solid ${colors.border}` }}>
                      <td style={TD}><PaymentRef payment={p} showClient={!isClientMatch(p)} /></td>
                      <td style={{ ...TD, color: '#9A3412', fontWeight: 600 }}>
                        {p.status === 'rejected'
                          ? 'Rejected'
                          : p.status === 'needs_clarification'
                            ? 'Needs clarification'
                            : 'Pending approval'}
                      </td>
                      <td style={TD}>{fmtDate(p.payment_date)}</td>
                      <td style={TD}>{paymentAccountLabel(p.payment_mode, p.received_in)}</td>
                      <td style={{ ...TD_AMOUNT, color: colors.muted, fontWeight: 600 }}>{fmtAmount(p.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </TableFrame>
            </div>
          )}

          {/* ── 4. Optional: link other approved payments ── */}
          <div style={{ flexShrink: 0 }}>
            <SectionHeading
              title="Additional approved payments"
              note="Select any other approved, unlinked payments that should be attached to the new order."
            />

            {loadingPayments ? (
              <TableNotice>Loading payments…</TableNotice>
            ) : payments.length === 0 ? (
              <TableNotice>No approved payments are waiting to be linked.</TableNotice>
            ) : (
              <>
                <TableFrame minWidth={560}>
                  <thead>
                    <tr style={{ background: colors.raised }}>
                      <th scope="col" style={{ ...TH, width: '32px', paddingRight: 0 }}>
                        <span style={SR_ONLY}>Select</span>
                      </th>
                      <th scope="col" style={TH}>Payment Request</th>
                      <th scope="col" style={TH}>Date</th>
                      <th scope="col" style={TH}>Payment Mode</th>
                      <th scope="col" style={{ ...TH, textAlign: 'right' }}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedPayments.map((p, idx) => {
                      const on = selected.has(p.id)
                      const matches = isClientMatch(p)
                      // A subtle divider where the matching group ends and the
                      // non-matching group begins — display only, never hides
                      // mismatched payments.
                      const prevMatches = idx > 0 ? isClientMatch(sortedPayments[idx - 1]) : matches
                      const showDivider = idx > 0 && prevMatches && !matches
                      return (
                        <Fragment key={p.id}>
                          {showDivider && (
                            <tr>
                              <td colSpan={5} style={{
                                padding: '4px 10px', background: colors.float,
                                borderTop: `1px solid ${colors.border}`,
                                fontSize: '10px', fontWeight: 700, color: colors.muted,
                                textTransform: 'uppercase', letterSpacing: '0.06em',
                              }}>
                                Other clients
                              </td>
                            </tr>
                          )}
                          <tr
                            onClick={e => {
                              // The checkbox is a real control and handles its
                              // own click and Space; the rest of the row is a
                              // convenience target, so a click that landed on
                              // the input must not toggle a second time.
                              if (saving) return
                              if ((e.target as HTMLElement).tagName === 'INPUT') return
                              toggle(p.id)
                            }}
                            style={{
                              borderTop: `1px solid ${colors.border}`,
                              background: on ? 'rgba(220,31,46,0.045)' : 'transparent',
                              cursor: saving ? 'not-allowed' : 'pointer',
                            }}
                          >
                            <td style={{ ...TD, paddingRight: 0 }}>
                              <input
                                type="checkbox"
                                checked={on}
                                onChange={() => toggle(p.id)}
                                disabled={saving}
                                aria-label={`Link ${p.request_number} — ${p.client_name}, ${fmtAmount(p.amount)}`}
                                style={{ display: 'block', cursor: saving ? 'not-allowed' : 'pointer' }}
                              />
                            </td>
                            <td style={TD}>
                              {/* This list is the whole suspense ledger, so the
                                  client is always worth naming. Selection is
                                  carried by the checkbox and by the weight of
                                  the number, never by the tint alone. */}
                              <PaymentRef payment={p} showClient strong={on} otherClient={!matches} />
                            </td>
                            <td style={TD}>{fmtDate(p.payment_date)}</td>
                            <td style={TD}>{paymentAccountLabel(p.payment_mode, p.received_in)}</td>
                            <td style={TD_AMOUNT}>{fmtAmount(p.amount)}</td>
                          </tr>
                        </Fragment>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ borderTop: `1px solid ${colors.borderSoft}`, background: colors.raised }}>
                      <th scope="row" colSpan={4} style={{
                        ...TD, textAlign: 'left', fontWeight: 600,
                        color: selected.size > 0 ? colors.secondary : colors.muted,
                      }}>
                        {selected.size} payment{selected.size !== 1 ? 's' : ''} selected
                      </th>
                      <td style={{
                        ...TD_AMOUNT,
                        color: selected.size > 0 ? colors.primary : colors.muted,
                        fontWeight: selected.size > 0 ? 700 : 500,
                      }}>
                        {fmtAmount(selectedTotal)}
                      </td>
                    </tr>
                  </tfoot>
                </TableFrame>

                {selected.size > 0 && (
                  <div style={{ fontSize: '11.5px', color: colors.tertiary, marginTop: '6px', lineHeight: 1.45 }}>
                    The selected payment{selected.size !== 1 ? 's' : ''} will be linked to the new
                    official Order and marked as received.
                  </div>
                )}

                {mismatchedSelected.length > 0 && (
                  <div style={{
                    fontSize: '11.5px', color: '#9A3412', background: '#FFF7ED',
                    border: '1px solid #FED7AA', borderRadius: '8px',
                    padding: '8px 10px', marginTop: '8px', lineHeight: 1.45,
                  }}>
                    <div>
                      The recorded client on this payment does not match the client on this order request.
                      Confirm that this is the correct payment before creating the order.
                    </div>
                    <ul style={{ margin: '6px 0 0', paddingLeft: '16px' }}>
                      {mismatchedSelected.map(p => (
                        <li key={p.id}>
                          {p.request_number} — payment client &ldquo;{p.client_name}&rdquo;, order request client &ldquo;{request.client_name}&rdquo;
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* ── Error — outside the scroller, so it can never be scrolled away
               from the button that produced it. ── */}
        {error && (
          <div style={{
            flexShrink: 0, padding: '9px 20px', borderTop: `1px solid ${colors.border}`,
            fontSize: '12px', color: '#991B1B', background: '#FEF2F2', lineHeight: 1.45,
          }}>
            {error}
          </div>
        )}

        {/* ── Pinned footer — the two actions stay reachable while the body
               scrolls, with the figure they commit to stated beside them. ── */}
        <div style={{
          flexShrink: 0, padding: '11px 20px', borderTop: `1px solid ${colors.border}`,
          background: colors.base, display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap',
        }}>
          <div style={{
            fontSize: '11.5px', color: colors.tertiary, minWidth: 0,
            fontVariantNumeric: 'tabular-nums',
          }}>
            {loadingPayments
              ? 'Checking payments…'
              : `${transferCount} payment${transferCount !== 1 ? 's' : ''} · ${fmtAmount(footerTotal)} moving to the new Order`}
          </div>
          <div style={{ display: 'flex', gap: '10px', flexShrink: 0 }}>
            <button type="button" onClick={onClose} disabled={saving} style={{
              padding: '8px 16px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
              background: 'transparent', border: `1px solid ${colors.border}`, color: colors.secondary,
              cursor: saving ? 'not-allowed' : 'pointer',
            }}>
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConvert}
              disabled={saving || !!blockedReason || loadingPayments}
              title={blockedReason ?? undefined}
              style={{
                // #DC1F2E is this module's established primary-action fill (the
                // same one the payments modal uses for Link payment) — a
                // high-commitment action, deliberately NOT boe-btn-danger's
                // tinted delete treatment.
                padding: '8px 18px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
                background: '#DC1F2E', border: 'none', color: '#fff',
                cursor: (saving || blockedReason || loadingPayments) ? 'not-allowed' : 'pointer',
                opacity: (saving || blockedReason || loadingPayments) ? 0.7 : 1,
              }}
            >
              {saving ? 'Converting…' : 'Convert to Order'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Request Clarification modal (admin only) ──────────────────────────────────
// Deliberately separate from ConvertModal: asking a question and creating an
// official Order are different decisions and must not share a confirmation.

export function ClarifyModal({
  request,
  onClose,
  onRequested,
}: {
  request: OrderRequest
  onClose: () => void
  onRequested: (requestNumber: string) => void
}) {
  const [note,   setNote]   = useState('')
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)
  const supabase = useMemo(() => createClient(), [])

  const noteValid = note.trim().length > 0

  // Escape closes; the backdrop does not (form-modal dismissal rule).
  useEscapeToClose(onClose, !saving)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (saving || !noteValid) return
    setSaving(true)
    setError(null)

    const { error: rpcErr } = await supabase.rpc('request_order_request_clarification', {
      p_order_request_id:   request.id,
      p_clarification_note: note,
    })

    if (rpcErr) {
      // Modal stays open so the admin can retry or copy their note out.
      setError('Could not request clarification. The request may have already changed. Please refresh and try again.')
      setSaving(false)
      return
    }

    // Tell the creator their request needs clarification.
    void notifyOrders({
      event: 'order_clarification',
      requestNumber: request.request_number,
      entityId: request.id,
      clientName: request.client_name,
      creatorId: request.requested_by,
    })

    onRequested(request.request_number)
  }

  const labelStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: '4px',
    fontSize: '11px', fontWeight: 600, color: colors.muted,
    textTransform: 'uppercase', letterSpacing: '0.05em',
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
      // Backdrop is inert by design (BOE form-modal dismissal rule): an outside
      // click never closes and never discards entered data. Dismiss via ×,
      // Cancel, Escape (useEscapeToClose above), or a successful submit.
    >
      <div style={{
        background: colors.base,
        border: `1px solid ${colors.border}`,
        borderRadius: '12px',
        width: '100%', maxWidth: '460px',
        boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: `1px solid ${colors.border}`,
        }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary }}>Request Clarification</div>
            <div style={{ fontSize: '12px', color: colors.muted, marginTop: '2px' }}>
              {request.request_number} · {request.client_name}
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: saving ? 'not-allowed' : 'pointer', color: colors.muted, display: 'flex' }}
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.5 }}>
            The request goes back to the requester, who can update it and resubmit
            it for review. It cannot be converted until then.
          </div>

          <label style={labelStyle}>
            What needs clarifying? *
            <textarea
              autoFocus
              style={{
                padding: '7px 10px', borderRadius: '6px',
                border: `1px solid ${colors.border}`,
                background: colors.raised, color: colors.primary,
                fontSize: '13px', width: '100%', boxSizing: 'border-box',
                outline: 'none', minHeight: '80px', resize: 'vertical',
                fontFamily: 'inherit',
              }}
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="Ask the requester what to correct or add…"
            />
          </label>

          {error && (
            <div style={{ fontSize: '12px', color: colors.red, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '6px', padding: '8px 12px' }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
            <button type="button" onClick={onClose} disabled={saving} style={{
              padding: '8px 16px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
              background: 'transparent', border: `1px solid ${colors.border}`, color: colors.secondary,
              cursor: saving ? 'not-allowed' : 'pointer',
            }}>
              Cancel
            </button>
            <button type="submit" disabled={saving || !noteValid} style={{
              padding: '8px 18px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
              background: '#DC1F2E', border: 'none', color: '#fff',
              cursor: (saving || !noteValid) ? 'not-allowed' : 'pointer',
              opacity: (saving || !noteValid) ? 0.5 : 1,
            }}>
              {saving ? 'Sending…' : 'Request Clarification'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Delete Request modal (admin only, unconverted only) ───────────────────────
//
// Deleting an Order Request is legitimate cleanup of something that was never
// finalized — a duplicate, a mistake, a request that will never proceed. It is
// NOT how a converted request goes away: that one produced a Confirmed Order and
// is permanent source history, which the database enforces independently of this
// modal (20260705000000).
//
// The one case that needs care is a request with approved payments parked on it.
// Those are real money sitting in Suspense, so they are DETACHED and kept, never
// deleted, and the modal says so before the admin commits. Detaching and
// deleting happen in one transaction inside admin_delete_order_request() — doing
// them as two client calls would leave a window where the payments are unparked
// but the request survives.

export function DeleteRequestModal({
  request,
  onClose,
  onDeleted,
}: {
  request: OrderRequest
  onClose: () => void
  onDeleted: (requestNumber: string, unlinkedCount: number) => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [payments, setPayments] = useState<{ id: string; request_number: string; amount: number }[] | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [error,    setError]    = useState<string | null>(null)

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase
        .from('finance_payment_requests')
        .select('id, request_number, amount')
        .eq('order_request_id', request.id)
      setPayments((data ?? []) as { id: string; request_number: string; amount: number }[])
    }
    void load()
  }, [supabase, request.id])

  const linkedCount  = payments?.length ?? 0
  const linkedAmount = (payments ?? []).reduce((sum, p) => sum + Number(p.amount ?? 0), 0)

  // Escape closes; the backdrop does not (form-modal dismissal rule).
  useEscapeToClose(onClose, !deleting)

  const handleDelete = async () => {
    if (deleting) return
    setDeleting(true)
    setError(null)

    // Deletion is a single server-side orchestration (/api/orders/requests/delete):
    // it loads the attachment paths from the database itself (never trusting the
    // browser), removes the storage objects with the service role FIRST, and only
    // THEN runs admin_delete_order_request. If storage removal fails the request
    // is NOT deleted, so its files stay recorded and discoverable for a retry —
    // there is no window where the row is gone but objects are orphaned.
    let body: { success?: boolean; unlinked_count?: number; error?: string } | null = null
    try {
      const res = await fetch('/api/orders/requests/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: request.id, unlinkPayments: linkedCount > 0 }),
      })
      body = await res.json().catch(() => null)
      if (!res.ok || !body?.success) {
        setDeleting(false)
        setError(body?.error ? deleteRequestErrorMessage(body.error) : 'Could not delete this request. Please try again.')
        return
      }
    } catch {
      setDeleting(false)
      setError('Could not reach the server to delete this request. Please try again.')
      return
    }

    onDeleted(request.request_number, body?.unlinked_count ?? 0)
  }

  const keyStyle: React.CSSProperties = {
    color: colors.muted, fontSize: '11px', fontWeight: 600,
    textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
      // Backdrop is inert by design (BOE form-modal dismissal rule): an outside
      // click never closes. Dismiss via ×, Cancel, or Escape (useEscapeToClose
      // above), all of which already respect the in-flight delete guard.
    >
      <div style={{
        background: colors.base, border: `1px solid ${colors.border}`,
        borderRadius: '12px', width: '100%', maxWidth: '480px',
        boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: `1px solid ${colors.border}`,
        }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary }}>Delete Order Request</div>
            <div style={{ fontSize: '12px', color: colors.muted, marginTop: '2px' }}>
              {request.request_number} · {request.client_name}
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={deleting}
            aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: deleting ? 'not-allowed' : 'pointer', color: colors.muted, display: 'flex' }}
          >
            <X size={16} />
          </button>
        </div>

        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
              <span style={keyStyle}>Request Number</span>
              <span style={{ color: colors.primary, fontWeight: 600 }}>{request.request_number}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
              <span style={keyStyle}>Status</span>
              <StatusBadge status={request.status} />
            </div>
            {linkedCount > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                <span style={keyStyle}>Linked Payments</span>
                <span style={{ color: colors.primary }}>
                  {linkedCount} · {formatINR(linkedAmount)}
                </span>
              </div>
            )}
          </div>

          <div style={{
            fontSize: '12px', color: '#991B1B',
            background: '#FEF2F2', border: '1px solid #FECACA',
            borderRadius: '6px', padding: '9px 12px', lineHeight: 1.55,
          }}>
            <strong>Will be deleted:</strong> this Order Request and its activity history.
            {linkedCount === 0 && ' Nothing else is affected.'}
          </div>

          {linkedCount > 0 && (
            <div style={{
              fontSize: '12px', color: '#166534',
              background: '#F0FDF4', border: '1px solid #BBF7D0',
              borderRadius: '6px', padding: '9px 12px', lineHeight: 1.55,
            }}>
              <strong>Will be kept:</strong> {linkedCount} received{' '}
              {linkedCount === 1 ? 'payment' : 'payments'} totalling {formatINR(linkedAmount)}.
              {' '}They are real bank payments and are never deleted — they will be unlinked from
              this request and returned to Suspense, ready to attach elsewhere.
            </div>
          )}

          {error && (
            <div style={{
              padding: '9px 12px', borderRadius: '6px',
              background: 'rgba(217,79,79,0.1)', color: '#C13030', fontSize: '12px', lineHeight: 1.5,
            }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button
              onClick={onClose}
              disabled={deleting}
              style={{
                padding: '8px 16px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
                background: 'transparent', border: `1px solid ${colors.border}`,
                color: colors.secondary, cursor: deleting ? 'not-allowed' : 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting || payments === null}
              style={{
                padding: '8px 18px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
                background: colors.red, border: 'none', color: '#fff',
                cursor: deleting || payments === null ? 'not-allowed' : 'pointer',
                opacity: deleting || payments === null ? 0.7 : 1,
              }}
            >
              {deleting
                ? 'Deleting…'
                : linkedCount > 0 ? 'Unlink Payments and Delete' : 'Delete Request'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Reject Request modal (admin only) ──────────────────────────────────────────
// Deliberately separate from ConvertModal and ClarifyModal: rejecting is a
// terminal decision distinct from asking a question or creating an Order, and
// must not share a confirmation with either.

export function RejectModal({
  request,
  onClose,
  onRejected,
}: {
  request: OrderRequest
  onClose: () => void
  onRejected: (requestNumber: string) => void
}) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)
  const supabase = useMemo(() => createClient(), [])

  const reasonValid = reason.trim().length > 0

  // Escape closes; the backdrop does not (form-modal dismissal rule).
  useEscapeToClose(onClose, !saving)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (saving || !reasonValid) return
    setSaving(true)
    setError(null)

    const { error: rpcErr } = await supabase.rpc('reject_order_request', {
      p_order_request_id: request.id,
      p_rejection_reason: reason,
    })

    if (rpcErr) {
      // Modal stays open so the admin can retry or copy their reason out.
      setError('Could not reject this request. It may have already changed. Please refresh and try again.')
      setSaving(false)
      return
    }

    // Tell the creator their request was rejected.
    void notifyOrders({
      event: 'order_rejected',
      requestNumber: request.request_number,
      entityId: request.id,
      clientName: request.client_name,
      creatorId: request.requested_by,
    })

    onRejected(request.request_number)
  }

  const labelStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: '4px',
    fontSize: '11px', fontWeight: 600, color: colors.muted,
    textTransform: 'uppercase', letterSpacing: '0.05em',
  }
  const keyStyle: React.CSSProperties = {
    color: colors.muted, fontSize: '11px', fontWeight: 600,
    textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
      // Backdrop is inert by design (BOE form-modal dismissal rule): an outside
      // click never closes and never discards entered data. Dismiss via ×,
      // Cancel, Escape (useEscapeToClose above), or a successful submit.
    >
      <div style={{
        background: colors.base,
        border: `1px solid ${colors.border}`,
        borderRadius: '12px',
        width: '100%', maxWidth: '460px',
        boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: `1px solid ${colors.border}`,
        }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary }}>Reject Request</div>
            <div style={{ fontSize: '12px', color: colors.muted, marginTop: '2px' }}>
              {request.request_number} · {request.client_name}
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: saving ? 'not-allowed' : 'pointer', color: colors.muted, display: 'flex' }}
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{
            fontSize: '12px', color: '#991B1B',
            background: '#FEF2F2', border: '1px solid #FECACA',
            borderRadius: '6px', padding: '9px 12px', lineHeight: 1.5,
          }}>
            This cannot be undone. The request will be permanently marked Rejected
            and cannot be converted or resubmitted.
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
              <span style={keyStyle}>Request Number</span>
              <span style={{ color: colors.primary, fontWeight: 600 }}>{request.request_number}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
              <span style={keyStyle}>Client</span>
              <span style={{ color: colors.primary }}>{request.client_name}</span>
            </div>
          </div>

          <label style={labelStyle}>
            Rejection Reason *
            <textarea
              autoFocus
              style={{
                padding: '7px 10px', borderRadius: '6px',
                border: `1px solid ${colors.border}`,
                background: colors.raised, color: colors.primary,
                fontSize: '13px', width: '100%', boxSizing: 'border-box',
                outline: 'none', minHeight: '80px', resize: 'vertical',
                fontFamily: 'inherit',
              }}
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="Explain why this request is being rejected…"
            />
          </label>

          {error && (
            <div style={{ fontSize: '12px', color: colors.red, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '6px', padding: '8px 12px' }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
            <button type="button" onClick={onClose} disabled={saving} style={{
              padding: '8px 16px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
              background: 'transparent', border: `1px solid ${colors.border}`, color: colors.secondary,
              cursor: saving ? 'not-allowed' : 'pointer',
            }}>
              Cancel
            </button>
            <button type="submit" disabled={saving || !reasonValid} style={{
              padding: '8px 18px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
              background: '#991B1B', border: 'none', color: '#fff',
              cursor: (saving || !reasonValid) ? 'not-allowed' : 'pointer',
              opacity: (saving || !reasonValid) ? 0.5 : 1,
            }}>
              {saving ? 'Rejecting…' : 'Reject Request'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
