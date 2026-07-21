'use client'

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { FinanceLayout } from '@/components/layout/FinanceLayout'
import type { UserProfile } from '@/lib/types'
import { PaymentProofView } from '@/components/PaymentProofView'
import { PaymentRequestActivity } from '@/components/PaymentRequestActivity'
import { formatINR, isValidAmount } from '@/lib/currency'
import { notifyFinance } from '@/lib/notify'
import { FinanceModal, RequestModalShell } from '@/app/finance/components/FinanceModalShell'

// ── Types ─────────────────────────────────────────────────────────────────────

type PaymentRequest = {
  id: string
  request_number: string
  client_name: string
  amount: number
  payment_date: string
  payment_mode: string
  received_in: string
  proof_note: string | null
  order_number: string | null
  order_id: string | null
  order_request_id: string | null
  order_request_number: string | null
  sales_note: string | null
  status: string
  payment_against: string
  submitted_by: string
  submitted_by_name?: string
  admin_note: string | null
  created_at: string
}

// Combined Link-modal search result: a Confirmed Order or an eligible Order
// Request, tagged so the two are never confused. A payment links to exactly
// one of them (enforced server-side by the 20260698 CHECK + RPCs).
type LinkTarget =
  | {
      kind: 'order'
      id: string
      display_number: string
      client_name: string
      total_value: number | null
      status: string
      confirm_date: string | null
    }
  | {
      kind: 'request'
      id: string
      request_number: string
      client_name: string
      assignee_name: string | null
      total_value: number | null
      status: string
    }

// ── Constants ─────────────────────────────────────────────────────────────────

const PAYMENT_MODE_LABEL: Record<string, string> = {
  bank_transfer: 'Bank Transfer',
  cash:          'Cash',
  upi:           'UPI',
  cheque:        'Cheque',
  other:         'Other',
}

const RECEIVED_IN_LABEL: Record<string, string> = {
  company_account: 'HDFC',
  cash_in_hand:    'Paytm',
  savings_account: 'Canara',
  other:           'PNB',
}

const STATUS_META: Record<string, { label: string; bg: string; color: string; border: string }> = {
  pending_approval:    { label: 'Pending',             bg: '#FFFBEB', color: '#92400E', border: '#FDE68A' },
  approved_unlinked:   { label: 'Order No. Pending',   bg: '#FFF7ED', color: '#92400E', border: '#FED7AA' },
  approved_linked:     { label: 'Received Payment',    bg: '#F0FDF4', color: '#166534', border: '#BBF7D0' },
  needs_clarification: { label: 'Needs Clarification', bg: '#EFF6FF', color: '#1E40AF', border: '#BFDBFE' },
  rejected:            { label: 'Rejected',            bg: '#FEF2F2', color: '#991B1B', border: '#FECACA' },
}

const ORDER_STATUS_META: Record<string, { label: string; color: string }> = {
  running:            { label: 'Running',             color: '#1E40AF' },
  on_hold:            { label: 'On Hold',             color: '#9A3412' },
  ready_for_dispatch: { label: 'Ready for Dispatch',  color: '#5B21B6' },
  dispatched:         { label: 'Dispatched',          color: '#166534' },
  cancelled:          { label: 'Cancelled',           color: '#991B1B' },
}

// Order Request statuses eligible to receive a payment link (the RPC enforces
// the same pair server-side).
const REQUEST_STATUS_META: Record<string, { label: string; color: string }> = {
  submitted:           { label: 'Submitted',           color: '#92400E' },
  needs_clarification: { label: 'Needs Clarification', color: '#1E40AF' },
}

const PAYMENT_MODE_OPTIONS = [
  { label: 'Bank Transfer', value: 'bank_transfer' },
  { label: 'Cash',          value: 'cash' },
  { label: 'UPI',           value: 'upi' },
  { label: 'Cheque',        value: 'cheque' },
  { label: 'Other',         value: 'other' },
]

const RECEIVED_IN_OPTIONS = [
  { label: 'HDFC',   value: 'company_account' },
  { label: 'PNB',    value: 'other' },
  { label: 'Paytm',  value: 'cash_in_hand' },
  { label: 'Canara', value: 'savings_account' },
]

// approved_unlinked and approved_linked are deliberately excluded — see
// isLinkageStatus below and 20260691000000: those two states may only be
// reached through approve_finance_payment_request, link_finance_payment_to_order,
// or unlink_finance_payment_from_order.
const STATUS_CORRECTION_OPTIONS = [
  { value: 'pending_approval',    label: 'Pending' },
  { value: 'needs_clarification', label: 'Needs Clarification' },
  { value: 'rejected',            label: 'Rejected' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function fmtAmount(n: number) {
  return formatINR(n)
}

function fmtDateTime(iso: string) {
  const d = new Date(iso)
  const date = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
  return `${date}, ${time}`
}

// Maps the approved_linked-requires-order_id CHECK constraint violation to a
// clear message instead of surfacing the raw Postgres error.
function friendlyDbErrorMessage(dbError: { code?: string; message: string } | null): string {
  if (!dbError) return ''
  if (dbError.code === '23514' || dbError.message?.includes('finance_payment_requests_approved_linked_requires_order_id')) {
    return 'Select a valid order before marking this payment as linked.'
  }
  return dbError.message
}

// ── Shared UI atoms ───────────────────────────────────────────────────────────
// FinanceModal and RequestModalShell (the shared Finance modal layering
// system) live in src/app/finance/components/FinanceModalShell.tsx — shared
// with the Payment Requests page so both use one consistent set of overlay/
// dialog z-index values instead of each page picking its own.

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <label style={{ fontSize: '11px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}{required && <span style={{ color: colors.red, marginLeft: '2px' }}>*</span>}
      </label>
      {children}
    </div>
  )
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div style={{ padding: '10px 12px', borderRadius: '8px', background: 'rgba(217,79,79,0.1)', color: '#C13030', fontSize: '12px' }}>
      {message}
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <span style={{ fontSize: '10px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
      <span style={{ fontSize: '13px', color: colors.primary }}>{value}</span>
    </div>
  )
}

// Compact uppercase section label used inside RequestModalShell cards —
// matches the Payment Requests page's DetailsModal styling exactly.
function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: '11px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
      {children}
    </div>
  )
}

// Label-over-value metadata item; muted styling for empty/placeholder values.
function MetaItem({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
      <span style={{ fontSize: '11px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>
      <span style={{ fontSize: '14px', color: muted ? colors.muted : colors.primary, wordBreak: 'break-word', lineHeight: 1.4 }}>{value}</span>
    </div>
  )
}

function StatusBadge({ status, requestLinked }: { status: string; requestLinked?: boolean }) {
  // A payment parked on an Order Request stays approved_unlinked in the
  // database (it is not an order advance yet) but must read as its own state,
  // not as plain "Order No. Pending".
  const meta = (requestLinked && status === 'approved_unlinked')
    ? { label: 'Awaiting Order Confirmation', bg: '#F5F3FF', color: '#5B21B6', border: '#DDD6FE' }
    : STATUS_META[status] ?? { label: status, bg: '#F3F4F6', color: '#4B5563', border: '#E5E7EB' }
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: '5px',
      background: meta.bg, color: meta.color, border: `1px solid ${meta.border}`,
      fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      {meta.label}
    </span>
  )
}

// Shown in the Order column when the payment is parked on an Order Request.
function RequestLinkBadge({ requestNumber }: { requestNumber: string }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: '5px',
      background: '#F5F3FF', color: '#5B21B6', border: '1px solid #DDD6FE',
      fontSize: '11px', fontWeight: 700, whiteSpace: 'nowrap',
    }}>
      {requestNumber}
    </span>
  )
}

// Shown when payment has no order_id
function SuspenseBadge() {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: '5px',
      background: '#FFF7ED', color: '#9A3412', border: '1px solid #FED7AA',
      fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      Suspense
    </span>
  )
}

// ── Details modal ─────────────────────────────────────────────────────────────

function DetailsModal({
  request: r,
  onClose,
  isAdmin,
  supabase,
  onCorrected,
}: {
  request: PaymentRequest
  onClose: () => void
  isAdmin?: boolean
  supabase?: ReturnType<typeof createClient>
  onCorrected?: () => void
}) {
  // Every row on this page is approved_linked or approved_unlinked (the page
  // query is scoped to exactly those two statuses), so this is always true
  // here — the generic correction control below never renders on this page.
  // Kept as an explicit, named check (rather than deleting the block) so the
  // same guard reads identically to finance/page.tsx.
  const isLinkageStatus = r.status === 'approved_unlinked' || r.status === 'approved_linked'

  const [newStatus,       setNewStatus]       = useState(r.status)
  const [correctionNote,  setCorrectionNote]  = useState('')
  const [correcting,      setCorrecting]      = useState(false)
  const [correctionError, setCorrectionError] = useState<string | null>(null)

  const noteRequiredForCorrection = newStatus === 'needs_clarification' || newStatus === 'rejected'
  const statusChanged = newStatus !== r.status
  const canCorrect = statusChanged && (!noteRequiredForCorrection || correctionNote.trim())

  const handleCorrect = async () => {
    if (!canCorrect || !supabase || !onCorrected) return
    setCorrecting(true)
    setCorrectionError(null)
    const { error: dbError } = await supabase
      .from('finance_payment_requests')
      .update({
        status:     newStatus,
        admin_note: correctionNote.trim() || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', r.id)
    setCorrecting(false)
    if (dbError) { setCorrectionError(friendlyDbErrorMessage(dbError)); return }
    onCorrected()
  }

  const submittedLine = r.submitted_by_name
    ? `Submitted by ${r.submitted_by_name} · ${fmtDate(r.created_at)}`
    : `Submitted ${fmtDate(r.created_at)}`

  const left = (
    <>
      {/* Primary summary card — amount + client lead, payment details below.
          Same shell as the Payment Requests page's detail modal. */}
      <div style={{
        border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '16px',
        display: 'flex', flexDirection: 'column', gap: '14px',
      }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '14px' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Amount</div>
            <div style={{ fontSize: '28px', fontWeight: 700, color: colors.primary, lineHeight: 1.1, marginTop: '4px', fontVariantNumeric: 'tabular-nums', wordBreak: 'break-word' }}>
              {fmtAmount(r.amount)}
            </div>
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Client</div>
            <div style={{ fontSize: '18px', fontWeight: 600, color: colors.primary, lineHeight: 1.3, marginTop: '4px', wordBreak: 'break-word' }}>
              {r.client_name}
            </div>
          </div>
        </div>
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 16px',
          borderTop: `1px solid ${colors.border}`, paddingTop: '14px',
        }}>
          <MetaItem label="Payment Date" value={fmtDate(r.payment_date)} />
          <MetaItem label="Payment Mode" value={PAYMENT_MODE_LABEL[r.payment_mode] ?? r.payment_mode} />
          <MetaItem label="Received In"  value={RECEIVED_IN_LABEL[r.received_in]  ?? r.received_in} />
          {r.order_request_number && !r.order_number ? (
            <MetaItem label="Linked Order Request" value={r.order_request_number} />
          ) : (
            <MetaItem label="Order Number" value={r.order_number ?? '—'} muted={!r.order_number} />
          )}
        </div>
      </div>

      {/* Proof and reference — same compact bordered block as the Payment
          Requests page's detail modal. */}
      <div style={{ border: `1px solid ${colors.border}`, borderRadius: '10px', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px' }}>
          <span style={{ fontSize: '11px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em', width: '74px', flexShrink: 0 }}>Proof</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            {supabase
              ? <PaymentProofView supabase={supabase} paymentRequestId={r.id} renderEmpty inline />
              : <span style={{ fontSize: '13px', color: colors.muted }}>Not attached</span>}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '10px 12px', borderTop: `1px solid ${colors.border}` }}>
          <span style={{ fontSize: '11px', fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em', width: '74px', flexShrink: 0, paddingTop: '1px' }}>Reference</span>
          <span style={{ fontSize: '13.5px', color: r.proof_note ? colors.primary : colors.muted, minWidth: 0, wordBreak: 'break-word', lineHeight: 1.45 }}>
            {r.proof_note || 'Not provided'}
          </span>
        </div>
      </div>

      {/* Notes — only when a sales note exists */}
      {r.sales_note && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <SectionHeader>Notes</SectionHeader>
          <div style={{ fontSize: '13.5px', color: colors.secondary, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {r.sales_note}
          </div>
        </div>
      )}
    </>
  )

  const right = (
    <>
      {/* Activity panel — same bordered shell as the Payment Requests page's
          detail modal. */}
      {supabase && (
        <div style={{ border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '16px' }}>
          <PaymentRequestActivity supabase={supabase} paymentRequestId={r.id} />
        </div>
      )}

      {/* Admin controls — never renders on this page in practice (every row
          here is approved_unlinked/approved_linked), kept for parity with the
          Payment Requests page's guard structure. */}
      {isAdmin && supabase && onCorrected && !isLinkageStatus && (
        <div style={{
          border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '16px',
          display: 'flex', flexDirection: 'column', gap: '12px',
        }}>
          <div>
            <SectionHeader>Admin controls</SectionHeader>
            <div style={{ fontSize: '12px', color: colors.muted, marginTop: '4px', lineHeight: 1.5 }}>
              Administrative correction. This action will be recorded in activity history.
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <select
              className="boe-input"
              aria-label="Correct status"
              value={newStatus}
              onChange={e => { setNewStatus(e.target.value); setCorrectionNote(''); setCorrectionError(null) }}
              style={{ fontSize: '13px', maxWidth: '260px' }}
            >
              {STATUS_CORRECTION_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            {!statusChanged && (
              <div style={{ fontSize: '12px', color: colors.muted, lineHeight: 1.5 }}>
                Select a different status to make a correction.
              </div>
            )}
            {statusChanged && noteRequiredForCorrection && (
              <textarea
                className="boe-input"
                aria-label={newStatus === 'needs_clarification' ? 'Clarification note' : 'Rejection reason'}
                value={correctionNote}
                onChange={e => setCorrectionNote(e.target.value)}
                placeholder={newStatus === 'needs_clarification' ? 'Clarification note (required)' : 'Rejection reason (required)'}
                rows={2}
                style={{ width: '100%', resize: 'vertical', fontSize: '13px' }}
              />
            )}
            {statusChanged && !noteRequiredForCorrection && (
              <textarea
                className="boe-input"
                aria-label="Admin note"
                value={correctionNote}
                onChange={e => setCorrectionNote(e.target.value)}
                placeholder="Admin note (optional)"
                rows={2}
                style={{ width: '100%', resize: 'vertical', fontSize: '13px' }}
              />
            )}
            {correctionError && <ErrorBanner message={correctionError} />}
            {statusChanged && (
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  onClick={handleCorrect}
                  disabled={!canCorrect || correcting}
                  className="boe-btn boe-btn-primary"
                  style={{ padding: '7px 16px', fontSize: '13px' }}
                >
                  {correcting ? 'Saving…' : 'Save Correction'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      {isAdmin && isLinkageStatus && (
        <div style={{
          border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '16px',
          fontSize: '12px', color: colors.muted, lineHeight: 1.5,
        }}>
          Order linkage is managed with Link / Unlink, not here.
        </div>
      )}
    </>
  )

  return (
    <RequestModalShell
      requestNumber={r.request_number}
      submittedLine={submittedLine}
      statusBadge={<StatusBadge status={r.status} requestLinked={!!r.order_request_id} />}
      onClose={onClose}
      left={left}
      right={right}
    />
  )
}

// ── Edit Payment modal ────────────────────────────────────────────────────────

function EditPaymentModal({
  request: r,
  supabase,
  onClose,
  onSaved,
}: {
  request: PaymentRequest
  supabase: ReturnType<typeof createClient>
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState({
    clientName:  r.client_name,
    amount:      String(r.amount),
    paymentDate: r.payment_date,
    paymentMode: r.payment_mode,
    receivedIn:  r.received_in,
    proofNote:   r.proof_note ?? '',
    orderNumber: r.order_number ?? '',
    salesNote:   r.sales_note  ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState<string | null>(null)

  // Every row on this page is approved_unlinked or approved_linked (see the
  // page-level query), so this is always true here — order_number for those
  // states is owned exclusively by link_finance_payment_to_order /
  // unlink_finance_payment_from_order (20260691000000), never by this form.
  const isLinkageStatus = r.status === 'approved_unlinked' || r.status === 'approved_linked'

  const set = (key: keyof typeof form) => (
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(prev => ({ ...prev, [key]: e.target.value }))
  )

  const canSubmit = form.clientName.trim() && isValidAmount(form.amount) && form.paymentDate

  const handleSave = async () => {
    if (!canSubmit) return
    setSaving(true)
    setError(null)
    const { data: updated, error: dbError } = await supabase
      .from('finance_payment_requests')
      .update({
        client_name:  form.clientName.trim(),
        amount:       Number(form.amount),
        payment_date: form.paymentDate,
        payment_mode: form.paymentMode,
        received_in:  form.receivedIn,
        proof_note:   form.proofNote.trim() || null,
        ...(isLinkageStatus ? {} : { order_number: form.orderNumber.trim() || null }),
        sales_note:   form.salesNote.trim()   || null,
        updated_at:   new Date().toISOString(),
      })
      .eq('id', r.id)
      .select('id')
      .single()
    setSaving(false)
    if (dbError) { setError(friendlyDbErrorMessage(dbError)); return }
    if (!updated) { setError('No row was updated. Check permissions.'); return }
    onSaved()
  }

  return (
    <FinanceModal title="Edit Received Payment" onClose={onClose}>
      <Field label="Client Name" required>
        <input className="boe-input" value={form.clientName} onChange={set('clientName')}
          placeholder="e.g. Raj Enterprises" style={{ width: '100%' }} />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <Field label="Amount (₹)" required>
          <input className="boe-input" type="number" min="0" value={form.amount}
            onChange={set('amount')} placeholder="0" style={{ width: '100%' }} />
        </Field>
        <Field label="Payment Date" required>
          <input className="boe-input" type="date" value={form.paymentDate}
            onChange={set('paymentDate')} style={{ width: '100%' }} />
        </Field>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <Field label="Payment Mode" required>
          <select className="boe-input" value={form.paymentMode} onChange={set('paymentMode')} style={{ width: '100%' }}>
            {PAYMENT_MODE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
        <Field label="Received In" required>
          <select className="boe-input" value={form.receivedIn} onChange={set('receivedIn')} style={{ width: '100%' }}>
            {RECEIVED_IN_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Payment Proof / Reference Note">
        <textarea className="boe-input" value={form.proofNote} onChange={set('proofNote')}
          placeholder="e.g. UTR 123456789, cheque no. 001234, or cash received at office (optional)"
          rows={2} style={{ width: '100%', resize: 'vertical' }} />
      </Field>
      <Field label="Order Number">
        <input className="boe-input" value={form.orderNumber} onChange={set('orderNumber')}
          placeholder="Order number" style={{ width: '100%' }}
          readOnly={isLinkageStatus} disabled={isLinkageStatus} />
        {isLinkageStatus && (
          <span style={{ fontSize: '11px', color: colors.muted, marginTop: '2px' }}>
            Managed by Link / Unlink.
          </span>
        )}
      </Field>
      <Field label="Sales Note (optional)">
        <textarea className="boe-input" value={form.salesNote} onChange={set('salesNote')}
          placeholder="Any additional context"
          rows={2} style={{ width: '100%', resize: 'vertical' }} />
      </Field>
      {error && <ErrorBanner message={error} />}
      <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
        <button onClick={onClose} className="boe-btn boe-btn-ghost" style={{ padding: '8px 18px', fontSize: '13px' }}>Cancel</button>
        <button onClick={handleSave} disabled={!canSubmit || saving}
          className="boe-btn boe-btn-primary" style={{ padding: '8px 18px', fontSize: '13px' }}>
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>
    </FinanceModal>
  )
}

// ── Link to Order modal ───────────────────────────────────────────────────────

function LinkOrderModal({
  payment,
  supabase,
  onClose,
  onLinked,
}: {
  payment: PaymentRequest
  supabase: ReturnType<typeof createClient>
  onClose: () => void
  onLinked: () => void
}) {
  const [query,   setQuery]   = useState('')
  const [results, setResults] = useState<LinkTarget[]>([])
  const [searching, setSearching] = useState(false)
  const [selected,  setSelected]  = useState<LinkTarget | null>(null)
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  // Only a new_order-origin payment may be parked on an Order Request — the
  // link RPC rejects anything else (20260698), so the search doesn't offer
  // request targets for other payments at all.
  const canLinkToRequest = payment.payment_against === 'new_order'

  // One search field, two sources: Confirmed Orders (as before) plus active
  // Order Requests ('submitted' / 'needs_clarification' — the same pair the
  // link RPC enforces server-side). Results are tagged and rendered with an
  // explicit type badge so the two can never be confused.
  const handleSearch = async (q: string) => {
    setQuery(q)
    setSelected(null)
    const trimmed = q.trim()
    if (!trimmed) { setResults([]); return }

    setSearching(true)
    const [ordersRes, requestsRes] = await Promise.all([
      supabase
        .from('orders')
        .select('id, display_number, client_name, total_value, status, confirm_date')
        .or(`display_number.ilike.%${trimmed}%,client_name.ilike.%${trimmed}%`)
        .not('status', 'in', '(cancelled)')
        .order('created_at', { ascending: false })
        .limit(20),
      canLinkToRequest
        ? supabase
            .from('order_requests')
            .select('id, request_number, client_name, total_value, status, assigned_to_user:users!assigned_to(full_name)')
            .or(`request_number.ilike.%${trimmed}%,client_name.ilike.%${trimmed}%`)
            .in('status', ['submitted', 'needs_clarification'])
            .order('created_at', { ascending: false })
            .limit(20)
        : Promise.resolve({ data: [] }),
    ])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orderTargets: LinkTarget[] = ((ordersRes.data ?? []) as any[]).map(o => ({
      kind: 'order',
      id: o.id,
      display_number: o.display_number,
      client_name: o.client_name,
      total_value: o.total_value,
      status: o.status,
      confirm_date: o.confirm_date ?? null,
    }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const requestTargets: LinkTarget[] = ((requestsRes.data ?? []) as any[]).map(r => ({
      kind: 'request',
      id: r.id,
      request_number: r.request_number,
      client_name: r.client_name,
      total_value: r.total_value,
      status: r.status,
      assignee_name: r.assigned_to_user?.full_name ?? null,
    }))

    setResults([...orderTargets, ...requestTargets])
    setSearching(false)
  }

  // Routed entirely through the guarded RPCs (link_finance_payment_to_order,
  // 20260691000000, and link_finance_payment_to_order_request, 20260698000000):
  // each locks its rows, revalidates eligibility server-side, and writes the
  // activity rows itself. No client-side .update() of finance_payment_requests
  // or the activity tables remains.
  const handleLink = async () => {
    if (!selected) return
    setSaving(true)
    setError(null)

    const { error: rpcError } = selected.kind === 'order'
      ? await supabase.rpc('link_finance_payment_to_order', {
          p_payment_request_id: payment.id,
          p_order_id:           selected.id,
        })
      : await supabase.rpc('link_finance_payment_to_order_request', {
          p_payment_request_id: payment.id,
          p_order_request_id:   selected.id,
        })

    setSaving(false)
    if (rpcError) { setError(friendlyDbErrorMessage(rpcError)); return }

    // Tell the request creator their payment is now attached. Reuses the
    // existing finance_linked event for both targets; the number in the
    // message makes the target type obvious (BOE-… vs ORD-REQ-…).
    void notifyFinance({
      event: 'finance_linked',
      requestNumber: payment.request_number,
      entityId: payment.id,
      creatorId: payment.submitted_by,
      clientName: payment.client_name,
      orderNumber: selected.kind === 'order' ? selected.display_number : selected.request_number,
    })

    onLinked()
  }

  const isSuspense = !payment.order_id

  return (
    <FinanceModal title={isSuspense ? 'Link to Order' : 'Change Linked Order'} onClose={onClose}>
      {/* Payment summary */}
      <div style={{
        background: colors.raised, borderRadius: '8px', padding: '12px 14px',
        border: `1px solid ${colors.border}`,
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px',
      }}>
        <DetailRow label="Client" value={payment.client_name} />
        <DetailRow label="Amount" value={fmtAmount(payment.amount)} />
        <DetailRow label="Payment Date" value={fmtDate(payment.payment_date)} />
        <DetailRow label="Mode" value={PAYMENT_MODE_LABEL[payment.payment_mode] ?? payment.payment_mode} />
      </div>

      {/* Search */}
      <Field label="Search Orders & Order Requests">
        <div style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          background: colors.raised, border: `1px solid ${colors.border}`,
          borderRadius: '6px', padding: '6px 10px',
        }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            autoFocus
            placeholder="Order / request number or client name…"
            value={query}
            onChange={e => handleSearch(e.target.value)}
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: '13px', color: colors.primary }}
          />
          {searching && <span style={{ fontSize: '11px', color: colors.muted }}>Searching…</span>}
        </div>
      </Field>

      {/* Results — Confirmed Orders first, then eligible Order Requests, each
          carrying an explicit type badge. */}
      {results.length > 0 && (
        <div style={{
          border: `1px solid ${colors.border}`, borderRadius: '8px', overflow: 'hidden',
          maxHeight: '240px', overflowY: 'auto',
        }}>
          {results.map((t, idx) => {
            const isSelected = selected?.kind === t.kind && selected?.id === t.id
            const number = t.kind === 'order' ? t.display_number : t.request_number
            const statusMeta = t.kind === 'order'
              ? (ORDER_STATUS_META[t.status] ?? { label: t.status, color: colors.muted })
              : (REQUEST_STATUS_META[t.status] ?? { label: t.status, color: colors.muted })
            const typeBadge = t.kind === 'order'
              ? { label: 'Confirmed Order', bg: colors.blueTint, color: colors.blue, border: 'rgba(85,133,232,0.25)' }
              : { label: 'Order Request',   bg: '#F5F3FF',      color: '#5B21B6',   border: '#DDD6FE' }
            const subline = t.kind === 'order'
              ? [t.client_name, t.confirm_date ? `Confirmed ${fmtDate(t.confirm_date)}` : null].filter(Boolean).join(' · ')
              : [t.client_name, t.assignee_name ? `Assignee: ${t.assignee_name}` : null].filter(Boolean).join(' · ')
            return (
              <div
                key={`${t.kind}-${t.id}`}
                onClick={() => setSelected(isSelected ? null : t)}
                style={{
                  padding: '10px 14px',
                  borderBottom: idx < results.length - 1 ? `1px solid ${colors.border}` : 'none',
                  cursor: 'pointer',
                  background: isSelected ? colors.blueTint : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
                }}
                onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = colors.raised }}
                onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={{
                      display: 'inline-block', padding: '1px 6px', borderRadius: '4px',
                      background: typeBadge.bg, color: typeBadge.color, border: `1px solid ${typeBadge.border}`,
                      fontSize: '10px', fontWeight: 700, whiteSpace: 'nowrap',
                    }}>
                      {typeBadge.label}
                    </span>
                    <span style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>{number}</span>
                    <span style={{ fontSize: '11px', fontWeight: 600, color: statusMeta.color }}>{statusMeta.label}</span>
                  </div>
                  <div style={{ fontSize: '12px', color: colors.secondary, marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {subline}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>
                    {t.total_value != null ? fmtAmount(t.total_value) : '—'}
                  </div>
                  {t.kind === 'request' && (
                    <div style={{ fontSize: '10px', color: colors.muted, marginTop: '2px' }}>Expected value</div>
                  )}
                  {isSelected && (
                    <div style={{ fontSize: '10px', color: colors.blue, fontWeight: 600, marginTop: '2px' }}>Selected</div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {query.trim() && !searching && results.length === 0 && (
        <div style={{ fontSize: '13px', color: colors.muted, textAlign: 'center', padding: '12px 0' }}>
          No orders or order requests found for &ldquo;{query.trim()}&rdquo;.
        </div>
      )}

      {selected?.kind === 'request' && (
        <div style={{
          fontSize: '12px', color: '#5B21B6', background: '#F5F3FF',
          border: '1px solid #DDD6FE', borderRadius: '6px', padding: '8px 12px', lineHeight: 1.5,
        }}>
          Linking does not convert this request. When it is converted to an
          official Order, this payment will transfer to that Order automatically.
        </div>
      )}

      {error && <ErrorBanner message={error} />}

      <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
        <button onClick={onClose} className="boe-btn boe-btn-ghost" style={{ padding: '8px 18px', fontSize: '13px' }}>
          Cancel
        </button>
        <button
          onClick={handleLink}
          disabled={!selected || saving}
          className="boe-btn boe-btn-primary"
          style={{ padding: '8px 18px', fontSize: '13px', opacity: (!selected || saving) ? 0.6 : 1, cursor: (!selected || saving) ? 'not-allowed' : 'pointer' }}
        >
          {saving
            ? 'Linking…'
            : !selected
              ? 'Link'
              : selected.kind === 'order'
                ? `Link to Order ${selected.display_number}`
                : `Link to Request ${selected.request_number}`}
        </button>
      </div>
    </FinanceModal>
  )
}

// ── Table ─────────────────────────────────────────────────────────────────────

const TH_STYLE: React.CSSProperties = {
  padding: '8px 12px',
  textAlign: 'left',
  fontSize: '10px',
  fontWeight: 700,
  color: colors.muted,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  whiteSpace: 'nowrap',
  borderBottom: `1px solid ${colors.border}`,
  background: colors.raised,
}

function ReceivedPaymentsTable({
  rows,
  isAdmin,
  highlightId,
  onView,
  onEdit,
  onLink,
  onUnlink,
}: {
  rows: PaymentRequest[]
  isAdmin: boolean
  highlightId?: string | null
  onView:   (r: PaymentRequest) => void
  onEdit:   (r: PaymentRequest) => void
  onLink:   (r: PaymentRequest) => void
  onUnlink: (r: PaymentRequest) => void
}) {
  const TD: React.CSSProperties = { padding: '8px 12px', borderBottom: `1px solid ${colors.border}`, whiteSpace: 'nowrap' }

  return (
    <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '960px' }}>
        <thead>
          <tr>
            <th style={TH_STYLE}>Client</th>
            <th style={TH_STYLE}>Order</th>
            <th style={{ ...TH_STYLE, textAlign: 'right' }}>Amount</th>
            <th style={TH_STYLE}>Payment Date</th>
            <th style={TH_STYLE}>Mode</th>
            <th style={TH_STYLE}>Received In</th>
            <th style={TH_STYLE}>Submitted By</th>
            <th style={TH_STYLE}>Submitted On</th>
            <th style={TH_STYLE}>Status</th>
            <th style={{ ...TH_STYLE, textAlign: 'right' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const isLinked = !!r.order_id
            const isRequestLinked = !r.order_id && !!r.order_request_id
            const isHighlighted = r.id === highlightId
            return (
              <tr
                key={r.id}
                id={`payment-row-${r.id}`}
                onClick={() => onView(r)}
                style={{ cursor: 'pointer', background: isHighlighted ? colors.amberTint : undefined }}
                onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = colors.raised }}
                onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = isHighlighted ? colors.amberTint : 'transparent' }}
              >
                <td style={{ ...TD, fontSize: '13px', fontWeight: 600, color: colors.primary }}>
                  {r.client_name}
                </td>
                {/* Order column — linked order number, linked order request
                    number, or Suspense badge */}
                <td style={TD}>
                  {isLinked ? (
                    <span style={{
                      display: 'inline-block', padding: '2px 8px', borderRadius: '5px',
                      background: colors.blueTint, color: colors.blue,
                      border: `1px solid rgba(85,133,232,0.25)`,
                      fontSize: '11px', fontWeight: 700, whiteSpace: 'nowrap',
                    }}>
                      {r.order_number ?? r.order_id}
                    </span>
                  ) : isRequestLinked ? (
                    <RequestLinkBadge requestNumber={r.order_request_number ?? r.order_request_id!} />
                  ) : (
                    <SuspenseBadge />
                  )}
                </td>
                <td style={{ ...TD, fontSize: '13px', fontWeight: 700, color: colors.primary, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {fmtAmount(r.amount)}
                </td>
                <td style={{ ...TD, fontSize: '12px', color: colors.secondary }}>
                  {fmtDate(r.payment_date)}
                </td>
                <td style={{ ...TD, fontSize: '12px', color: colors.secondary }}>
                  {PAYMENT_MODE_LABEL[r.payment_mode] ?? r.payment_mode}
                </td>
                <td style={{ ...TD, fontSize: '12px', color: colors.secondary }}>
                  {RECEIVED_IN_LABEL[r.received_in] ?? r.received_in}
                </td>
                <td style={{ ...TD, fontSize: '12px', color: colors.secondary }}>
                  {r.submitted_by_name ?? '—'}
                </td>
                <td style={{ ...TD, fontSize: '11px', color: colors.muted }}>
                  {fmtDateTime(r.created_at)}
                </td>
                <td style={TD}>
                  <StatusBadge status={r.status} requestLinked={isRequestLinked} />
                </td>
                <td style={{ ...TD, textAlign: 'right' }}>
                  <div
                    style={{ display: 'inline-flex', gap: '4px', alignItems: 'center' }}
                    onClick={e => e.stopPropagation()}
                  >
                    <button
                      onClick={() => onView(r)}
                      className="boe-btn boe-btn-ghost"
                      style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 500 }}
                    >
                      View
                    </button>
                    {isAdmin && (
                      <>
                        {/* Link action for fully unlinked suspense payments */}
                        {!isLinked && !isRequestLinked && (
                          <button
                            onClick={() => onLink(r)}
                            className="boe-btn boe-btn-ghost"
                            style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 600, color: colors.blue }}
                          >
                            Link
                          </button>
                        )}
                        {/* Unlink from an Order Request — same reason-required
                            flow, routed through
                            unlink_finance_payment_from_order_request
                            (20260698000000), same new_order-origin gate. */}
                        {isRequestLinked && r.payment_against === 'new_order' && (
                          <button
                            onClick={() => onUnlink(r)}
                            className="boe-btn boe-btn-ghost"
                            style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 500, color: colors.muted }}
                          >
                            Unlink
                          </button>
                        )}
                        {/* Unlink action — only for payments that originated as a new
                            order. An existing_order payment was validated against a
                            real order at submission and unlink_finance_payment_from_order
                            (20260691000000) rejects it outright, so the option is not
                            offered here at all. */}
                        {isLinked && r.payment_against === 'new_order' && (
                          <button
                            onClick={() => onUnlink(r)}
                            className="boe-btn boe-btn-ghost"
                            style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 500, color: colors.muted }}
                          >
                            Unlink
                          </button>
                        )}
                        <button
                          onClick={() => onEdit(r)}
                          className="boe-btn boe-btn-ghost"
                          style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 500 }}
                        >
                          Edit
                        </button>
                        {/* No Delete. A row on this page is a Received Payment —
                            money that actually arrived — and is permanent bank
                            payment history (20260705000000). The database
                            refuses the delete regardless of what the UI offers:
                            the admin policy is now unapproved-only and
                            finance_payment_requests_guard_approved_delete no
                            longer exempts admins or the service role. */}
                      </>
                    )}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ReceivedPaymentsPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <ReceivedPaymentsPageInner />
    </Suspense>
  )
}

function ReceivedPaymentsPageInner() {
  const [pageLoading,    setPageLoading]    = useState(true)
  const [isAdmin,        setIsAdmin]        = useState(false)
  const [profile,        setProfile]        = useState<UserProfile | null>(null)
  const [requests,       setRequests]       = useState<PaymentRequest[]>([])
  const [listLoading,    setListLoading]    = useState(false)
  const [detailRequest,  setDetailRequest]  = useState<PaymentRequest | null>(null)
  const [editRequest,    setEditRequest]    = useState<PaymentRequest | null>(null)
  const [linkRequest,    setLinkRequest]    = useState<PaymentRequest | null>(null)
  const [unlinkTarget,   setUnlinkTarget]   = useState<PaymentRequest | null>(null)
  const [unlinkReason,   setUnlinkReason]   = useState('')
  const [unlinking,      setUnlinking]      = useState(false)
  const [unlinkError,    setUnlinkError]    = useState<string | null>(null)
  const [search,         setSearch]         = useState('')
  const [highlightId,    setHighlightId]    = useState<string | null>(null)

  const router       = useRouter()
  const supabase     = useMemo(() => createClient(), [])
  const searchParams = useSearchParams()

  // Guards the one-time ?payment= deep-link resolution below (see effect near
  // the bottom of init) so it can never re-fire and reopen a closed modal.
  const deepLinkHandled = useRef(false)

  const loadRequests = async () => {
    setListLoading(true)
    const { data } = await supabase
      .from('finance_payment_requests')
      .select(`
        id, request_number, client_name, amount, payment_date, payment_mode,
        received_in, proof_note, order_number, order_id,
        order_request_id, order_request_number, sales_note,
        status, payment_against, submitted_by, admin_note, created_at,
        submitted_by_user:users!submitted_by(full_name)
      `)
      .in('status', ['approved_linked', 'approved_unlinked'])
      .order('created_at', { ascending: false })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapped: PaymentRequest[] = ((data ?? []) as any[]).map(r => ({
      ...r,
      submitted_by_name: r.submitted_by_user?.full_name ?? undefined,
      submitted_by_user: undefined,
    }))
    setRequests(mapped)
    setListLoading(false)
  }

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const { data: me } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, position, is_active, created_at, employee_code, joining_date, monthly_salary, office_timing, fingerprint_employee_code')
        .eq('id', session.user.id)
        .single()

      setProfile(me as UserProfile)
      setIsAdmin(me?.role === 'admin')
      await loadRequests()
      setPageLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Deep-link resolution (?payment=&action=link|edit) ────────────────────────
  // Runs exactly once, once `requests` is loaded. Sources: the Admin Action
  // Queue (action=link) and the Order Requests details modal's per-payment Edit
  // action (action=edit). Each modal auto-opens only when the loaded payment
  // still satisfies the same rule the manual button uses — a stale, already
  // linked, or not-permitted payment is simply highlighted, never a fatal error.
  useEffect(() => {
    const resolveDeepLink = () => {
      if (pageLoading || deepLinkHandled.current) return
      deepLinkHandled.current = true

      const paymentId = searchParams.get('payment')
      const action     = searchParams.get('action')
      if (paymentId) {
        const match = requests.find(r => r.id === paymentId)
        if (match) {
          setHighlightId(match.id)
          setTimeout(() => setHighlightId(null), 3000)
          document.getElementById(`payment-row-${match.id}`)?.scrollIntoView({ block: 'center' })
          if (isAdmin && action === 'link' && !match.order_id && !match.order_request_id) {
            setLinkRequest(match)
          } else if (isAdmin && action === 'edit') {
            // Editing a received payment is admin-only here, exactly as the
            // table's own Edit button is.
            setEditRequest(match)
          } else if (action === 'edit' || action === 'link') {
            // Not permitted (or no longer eligible): fall back to the read-only
            // view rather than silently doing nothing.
            setDetailRequest(match)
          }
        }
        // Drop the deep-link params so a refresh or back-navigation can't
        // reopen the modal.
        router.replace('/finance/received')
      }
    }
    resolveDeepLink()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageLoading])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  // Unlink a payment — routed entirely through the guarded RPCs
  // (unlink_finance_payment_from_order, 20260691000000, or
  // unlink_finance_payment_from_order_request, 20260698000000, depending on
  // which linkage the row carries — the DB guarantees it is never both): each
  // locks the payment row, requires a non-empty reason, enforces the
  // new_order-origin gate, and records the activity rows itself. No
  // client-side .update() of finance_payment_requests or the activity tables
  // remains.
  const handleUnlink = async () => {
    if (!unlinkTarget) return
    const reason = unlinkReason.trim()
    if (!reason) { setUnlinkError('A reason is required to unlink this payment.'); return }
    setUnlinking(true)
    setUnlinkError(null)

    const { error: rpcError } = unlinkTarget.order_id
      ? await supabase.rpc('unlink_finance_payment_from_order', {
          p_payment_request_id: unlinkTarget.id,
          p_reason:             reason,
        })
      : await supabase.rpc('unlink_finance_payment_from_order_request', {
          p_payment_request_id: unlinkTarget.id,
          p_reason:             reason,
        })

    setUnlinking(false)
    if (rpcError) { setUnlinkError(friendlyDbErrorMessage(rpcError)); return }

    setUnlinkTarget(null)
    setUnlinkReason('')
    loadRequests()
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return requests
    return requests.filter(r =>
      r.client_name.toLowerCase().includes(q) ||
      (r.order_number ?? '').toLowerCase().includes(q) ||
      (r.order_request_number ?? '').toLowerCase().includes(q)
    )
  }, [requests, search])

  // Summary counts — three-way: linked to a Confirmed Order, parked on an
  // Order Request (awaiting conversion), or fully unlinked suspense.
  const linkedCount        = requests.filter(r => r.order_id).length
  const requestLinkedCount = requests.filter(r => !r.order_id && r.order_request_id).length
  const suspenseCount      = requests.filter(r => !r.order_id && !r.order_request_id).length

  if (pageLoading) return <LoadingScreen />

  return (
    <FinanceLayout
      profile={profile}
      title="Received Payments"
      subtitle="Approved payments — linked to orders or in suspense."
      onSignOut={handleSignOut}
      onRefresh={loadRequests}
    >
      {/* Suspense summary bar — shown only when there are unlinked payments */}
      {suspenseCount > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '10px',
          padding: '10px 14px', borderRadius: '8px', marginBottom: '12px',
          background: '#FFF7ED', border: '1px solid #FED7AA',
          fontSize: '13px', color: '#9A3412',
        }}>
          <span style={{ fontWeight: 700 }}>{suspenseCount} suspense payment{suspenseCount !== 1 ? 's' : ''}</span>
          <span style={{ color: '#C05621' }}>pending order linkage.</span>
          <span style={{ marginLeft: 'auto', fontSize: '12px', color: '#92400E' }}>
            {linkedCount} linked{requestLinkedCount > 0 ? ` · ${requestLinkedCount} awaiting order confirmation` : ''} · {suspenseCount} unlinked
          </span>
        </div>
      )}

      <div className="boe-card" style={{ overflow: 'hidden' }}>
        {/* Search bar */}
        <div style={{ padding: '10px 16px', borderBottom: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', gap: '6px' }}>
          <div style={{
            marginLeft: 'auto',
            display: 'flex', alignItems: 'center', gap: '6px',
            background: colors.raised, border: `1px solid ${colors.border}`,
            borderRadius: '6px', padding: '5px 10px', minWidth: '160px',
          }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              placeholder="Client or order…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: '12px', color: colors.primary, minWidth: 0 }}
            />
            {search && (
              <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, padding: 0, lineHeight: 1, fontSize: '13px' }}>✕</button>
            )}
          </div>
        </div>

        {/* Table */}
        {listLoading ? (
          <div style={{ padding: '40px 0', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>Loading…</div>
        ) : visible.length === 0 ? (
          <div style={{ padding: '40px 0', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>
            {search.trim() ? `No results for "${search.trim()}".` : 'No received payments yet.'}
          </div>
        ) : (
          <ReceivedPaymentsTable
            rows={visible}
            isAdmin={isAdmin}
            highlightId={highlightId}
            onView={r  => setDetailRequest(r)}
            onEdit={r  => setEditRequest(r)}
            onLink={r  => setLinkRequest(r)}
            onUnlink={r => { setUnlinkTarget(r); setUnlinkReason(''); setUnlinkError(null) }}
          />
        )}
      </div>

      {/* ── Modals ── */}

      {detailRequest && (
        <DetailsModal
          request={detailRequest}
          onClose={() => setDetailRequest(null)}
          isAdmin={isAdmin}
          supabase={supabase}
          onCorrected={() => { setDetailRequest(null); loadRequests() }}
        />
      )}

      {editRequest && (
        <EditPaymentModal
          request={editRequest}
          supabase={supabase}
          onClose={() => setEditRequest(null)}
          onSaved={() => { setEditRequest(null); loadRequests() }}
        />
      )}



      {linkRequest && (
        <LinkOrderModal
          payment={linkRequest}
          supabase={supabase}
          onClose={() => setLinkRequest(null)}
          onLinked={() => { setLinkRequest(null); loadRequests() }}
        />
      )}

      {/* Unlink confirmation — same shared modal shell as every other Finance
          dialog; closing (backdrop, header ✕, or Escape) is guarded exactly
          as before so it can't be dismissed mid-request. */}
      {unlinkTarget && (
        <FinanceModal
          title="Unlink Payment?"
          width="380px"
          onClose={() => { if (!unlinking) { setUnlinkTarget(null); setUnlinkReason(''); setUnlinkError(null) } }}
        >
          <div style={{ fontSize: '13px', color: colors.secondary, lineHeight: 1.6 }}>
            This will remove the link between{' '}
            <strong>{unlinkTarget.client_name}</strong> ({fmtAmount(unlinkTarget.amount)}) and{' '}
            {unlinkTarget.order_id ? 'order' : 'order request'}{' '}
            <strong>
              {unlinkTarget.order_id
                ? (unlinkTarget.order_number ?? unlinkTarget.order_id)
                : (unlinkTarget.order_request_number ?? unlinkTarget.order_request_id)}
            </strong>.
            <br /><br />
            The payment will return to suspense status.
          </div>
          <Field label="Reason" required>
            <textarea
              className="boe-input"
              value={unlinkReason}
              onChange={e => { setUnlinkReason(e.target.value); setUnlinkError(null) }}
              placeholder="Why is this payment being unlinked? (required)"
              rows={2}
              disabled={unlinking}
              style={{ width: '100%', resize: 'vertical' }}
            />
          </Field>
          {unlinkError && <ErrorBanner message={unlinkError} />}
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button
              onClick={() => { setUnlinkTarget(null); setUnlinkReason(''); setUnlinkError(null) }}
              disabled={unlinking}
              className="boe-btn boe-btn-ghost"
              style={{ padding: '8px 18px', fontSize: '13px' }}
            >
              Cancel
            </button>
            <button
              onClick={handleUnlink}
              disabled={unlinking || !unlinkReason.trim()}
              style={{
                padding: '8px 18px', fontSize: '13px', fontWeight: 600, borderRadius: '8px',
                border: `1px solid ${colors.border}`, background: colors.raised,
                color: colors.primary,
                cursor: (unlinking || !unlinkReason.trim()) ? 'not-allowed' : 'pointer',
                opacity: (unlinking || !unlinkReason.trim()) ? 0.6 : 1,
              }}
            >
              {unlinking ? 'Unlinking…' : 'Yes, Unlink'}
            </button>
          </div>
        </FinanceModal>
      )}

    </FinanceLayout>
  )
}
