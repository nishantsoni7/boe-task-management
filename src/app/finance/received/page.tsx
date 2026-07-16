'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { FinanceLayout } from '@/components/layout/FinanceLayout'
import type { UserProfile } from '@/lib/types'
import { PaymentProofView } from '@/components/PaymentProofView'
import { PaymentRequestActivity } from '@/components/PaymentRequestActivity'
import { formatINR, isValidAmount } from '@/lib/currency'

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
  sales_note: string | null
  status: string
  submitted_by: string
  submitted_by_name?: string
  admin_note: string | null
  created_at: string
}

type OrderResult = {
  id: string
  display_number: string
  client_name: string
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
  company_account: 'Company Account',
  cash_in_hand:    'Cash in Hand',
  savings_account: 'Savings Account',
  other:           'Other',
}

const STATUS_META: Record<string, { label: string; bg: string; color: string; border: string }> = {
  pending_approval:    { label: 'Pending',             bg: '#FFFBEB', color: '#92400E', border: '#FDE68A' },
  approved_unlinked:   { label: 'Order No. Pending',   bg: '#FFF7ED', color: '#92400E', border: '#FED7AA' },
  approved_linked:     { label: 'Received Payment',    bg: '#F0FDF4', color: '#166534', border: '#BBF7D0' },
  needs_clarification: { label: 'Needs Clarification', bg: '#EFF6FF', color: '#1E40AF', border: '#BFDBFE' },
  rejected:            { label: 'Rejected',            bg: '#FEF2F2', color: '#991B1B', border: '#FECACA' },
}

const ORDER_STATUS_META: Record<string, { label: string; color: string }> = {
  requested:          { label: 'Requested',          color: '#92400E' },
  running:            { label: 'Running',             color: '#1E40AF' },
  on_hold:            { label: 'On Hold',             color: '#9A3412' },
  ready_for_dispatch: { label: 'Ready for Dispatch',  color: '#5B21B6' },
  dispatched:         { label: 'Dispatched',          color: '#166534' },
  cancelled:          { label: 'Cancelled',           color: '#991B1B' },
}

const PAYMENT_MODE_OPTIONS = [
  { label: 'Bank Transfer', value: 'bank_transfer' },
  { label: 'Cash',          value: 'cash' },
  { label: 'UPI',           value: 'upi' },
  { label: 'Cheque',        value: 'cheque' },
  { label: 'Other',         value: 'other' },
]

const RECEIVED_IN_OPTIONS = [
  { label: 'Company Account', value: 'company_account' },
  { label: 'Cash in Hand',    value: 'cash_in_hand' },
  { label: 'Savings Account', value: 'savings_account' },
  { label: 'Other',           value: 'other' },
]

const STATUS_CORRECTION_OPTIONS = [
  { value: 'pending_approval',    label: 'Pending' },
  { value: 'needs_clarification', label: 'Needs Clarification' },
  { value: 'approved_unlinked',   label: 'Order No. Pending' },
  { value: 'approved_linked',     label: 'Received Payment' },
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

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 59 }} />
      <div style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
        width: '480px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 48px)', overflowY: 'auto',
        background: colors.base, borderRadius: '12px', border: `1px solid ${colors.border}`,
        zIndex: 60, padding: '24px', display: 'flex', flexDirection: 'column', gap: '14px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: '15px', fontWeight: 700, color: colors.primary }}>{title}</div>
          <button onClick={onClose} className="boe-btn boe-btn-ghost" style={{ padding: '4px 10px', fontSize: '13px' }}>✕</button>
        </div>
        {children}
      </div>
    </>
  )
}

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

function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { label: status, bg: '#F3F4F6', color: '#4B5563', border: '#E5E7EB' }
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
  const meta = STATUS_META[r.status] ?? { label: r.status, bg: '#F3F4F6', color: '#4B5563', border: '#E5E7EB' }

  const [newStatus,       setNewStatus]       = useState(r.status)
  const [correctionNote,  setCorrectionNote]  = useState('')
  const [correcting,      setCorrecting]      = useState(false)
  const [correctionError, setCorrectionError] = useState<string | null>(null)

  const noteRequiredForCorrection = newStatus === 'needs_clarification' || newStatus === 'rejected'
  const linkedRequiresOrderNo = newStatus === 'approved_linked' && !r.order_id
  const statusChanged = newStatus !== r.status
  const canCorrect = statusChanged && (!noteRequiredForCorrection || correctionNote.trim()) && !linkedRequiresOrderNo

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

  return (
    <Modal title="Payment Details" onClose={onClose}>
      <div style={{
        padding: '10px 14px', borderRadius: '8px',
        background: meta.bg, border: `1px solid ${meta.border}`,
        fontSize: '12px', fontWeight: 600, color: meta.color,
      }}>
        {meta.label}
      </div>

      <div style={{
        background: colors.raised, borderRadius: '8px', padding: '14px 16px',
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px',
        border: `1px solid ${colors.border}`,
      }}>
        <DetailRow label="Request No." value={r.request_number} />
        <DetailRow label="Client"       value={r.client_name} />
        <DetailRow label="Amount"       value={fmtAmount(r.amount)} />
        <DetailRow label="Payment Date" value={fmtDate(r.payment_date)} />
        <DetailRow label="Payment Mode" value={PAYMENT_MODE_LABEL[r.payment_mode] ?? r.payment_mode} />
        <DetailRow label="Received In"  value={RECEIVED_IN_LABEL[r.received_in]  ?? r.received_in} />
        <DetailRow label="Order No."    value={r.order_number ?? '—'} />
        <div style={{ gridColumn: '1 / -1' }}>
          <DetailRow label="Proof / Reference" value={r.proof_note ?? '—'} />
        </div>
        {r.sales_note && (
          <div style={{ gridColumn: '1 / -1' }}>
            <DetailRow label="Sales Note" value={r.sales_note} />
          </div>
        )}
        <DetailRow label="Submitted" value={fmtDate(r.created_at)} />
        {r.submitted_by_name && <DetailRow label="Submitted By" value={r.submitted_by_name} />}
      </div>

      {supabase && <PaymentProofView supabase={supabase} paymentRequestId={r.id} />}
      {supabase && <PaymentRequestActivity supabase={supabase} paymentRequestId={r.id} />}

      {isAdmin && supabase && onCorrected && (
        <div style={{
          borderTop: `1px solid ${colors.border}`,
          paddingTop: '14px',
          display: 'flex', flexDirection: 'column', gap: '10px',
        }}>
          <div style={{ fontSize: '11px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Admin — Correct Status
          </div>
          <select
            className="boe-input"
            value={newStatus}
            onChange={e => { setNewStatus(e.target.value); setCorrectionNote(''); setCorrectionError(null) }}
            style={{ fontSize: '12px' }}
          >
            {STATUS_CORRECTION_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          {linkedRequiresOrderNo && (
            <ErrorBanner message="Select a valid order before marking this payment as linked." />
          )}
          {statusChanged && noteRequiredForCorrection && (
            <textarea
              className="boe-input"
              value={correctionNote}
              onChange={e => setCorrectionNote(e.target.value)}
              placeholder={newStatus === 'needs_clarification' ? 'Clarification note (required)' : 'Rejection reason (required)'}
              rows={2}
              style={{ width: '100%', resize: 'vertical', fontSize: '12px' }}
            />
          )}
          {statusChanged && !noteRequiredForCorrection && (
            <textarea
              className="boe-input"
              value={correctionNote}
              onChange={e => setCorrectionNote(e.target.value)}
              placeholder="Admin note (optional)"
              rows={2}
              style={{ width: '100%', resize: 'vertical', fontSize: '12px' }}
            />
          )}
          {correctionError && <ErrorBanner message={correctionError} />}
          {statusChanged && (
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={handleCorrect}
                disabled={!canCorrect || correcting}
                className="boe-btn boe-btn-primary"
                style={{ padding: '7px 16px', fontSize: '12px' }}
              >
                {correcting ? 'Saving…' : 'Save Correction'}
              </button>
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={onClose} className="boe-btn boe-btn-ghost" style={{ padding: '8px 18px', fontSize: '13px' }}>
          Close
        </button>
      </div>
    </Modal>
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

  const set = (key: keyof typeof form) => (
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(prev => ({ ...prev, [key]: e.target.value }))
  )

  const canSubmit = form.clientName.trim() && isValidAmount(form.amount) && form.paymentDate

  const handleSave = async () => {
    if (!canSubmit) return
    setSaving(true)
    setError(null)
    // order_number is display/reference text only — editing it here never
    // changes order_id, so it can never make or break the payment's link.
    const { data: updated, error: dbError } = await supabase
      .from('finance_payment_requests')
      .update({
        client_name:  form.clientName.trim(),
        amount:       Number(form.amount),
        payment_date: form.paymentDate,
        payment_mode: form.paymentMode,
        received_in:  form.receivedIn,
        proof_note:   form.proofNote.trim() || null,
        order_number: form.orderNumber.trim() || null,
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
    <Modal title="Edit Received Payment" onClose={onClose}>
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
          placeholder="Order number" style={{ width: '100%' }} />
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
    </Modal>
  )
}

// ── Delete confirm modal ──────────────────────────────────────────────────────

function DeleteConfirmModal({
  request: r,
  supabase,
  onClose,
  onDeleted,
}: {
  request: PaymentRequest
  supabase: ReturnType<typeof createClient>
  onClose: () => void
  onDeleted: () => void
}) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const meta = STATUS_META[r.status] ?? { label: r.status, bg: '#F3F4F6', color: '#4B5563', border: '#E5E7EB' }

  const handleDelete = async () => {
    setDeleting(true)
    setError(null)
    const { error: dbError, count } = await supabase
      .from('finance_payment_requests')
      .delete({ count: 'exact' })
      .eq('id', r.id)
    setDeleting(false)
    if (dbError) { setError(dbError.message); return }
    if (count === 0) { setError('No row was deleted. Check permissions.'); return }
    onDeleted()
  }

  return (
    <Modal title="Delete Received Payment" onClose={onClose}>
      <div style={{ fontSize: '13px', color: colors.secondary, lineHeight: 1.7 }}>
        Delete this received payment? This cannot be undone.
      </div>
      <div style={{
        background: colors.raised, borderRadius: '8px', padding: '12px 14px',
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px',
        border: `1px solid ${colors.border}`,
      }}>
        <DetailRow label="Client"    value={r.client_name} />
        <DetailRow label="Amount"    value={fmtAmount(r.amount)} />
        <DetailRow label="Order No." value={r.order_number ?? '—'} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <span style={{ fontSize: '10px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Status</span>
          <span style={{
            display: 'inline-block', padding: '2px 8px', borderRadius: '5px', alignSelf: 'flex-start',
            background: meta.bg, color: meta.color, border: `1px solid ${meta.border}`,
            fontSize: '11px', fontWeight: 600,
          }}>
            {meta.label}
          </span>
        </div>
      </div>
      {error && <ErrorBanner message={error} />}
      <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
        <button onClick={onClose} className="boe-btn boe-btn-ghost" style={{ padding: '8px 18px', fontSize: '13px' }}>Cancel</button>
        <button
          onClick={handleDelete}
          disabled={deleting}
          style={{
            padding: '8px 18px', fontSize: '13px', fontWeight: 600, borderRadius: '8px',
            border: `1px solid ${colors.red}`, background: colors.redTint, color: colors.red,
            cursor: deleting ? 'default' : 'pointer', opacity: deleting ? 0.6 : 1,
          }}
        >
          {deleting ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </Modal>
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
  const [results, setResults] = useState<OrderResult[]>([])
  const [searching, setSearching] = useState(false)
  const [selected,  setSelected]  = useState<OrderResult | null>(null)
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  const handleSearch = async (q: string) => {
    setQuery(q)
    setSelected(null)
    const trimmed = q.trim()
    if (!trimmed) { setResults([]); return }

    setSearching(true)
    const { data } = await supabase
      .from('orders')
      .select('id, display_number, client_name, total_value, status')
      .or(`display_number.ilike.%${trimmed}%,client_name.ilike.%${trimmed}%`)
      .not('status', 'in', '(cancelled)')
      .order('created_at', { ascending: false })
      .limit(20)
    setResults((data ?? []) as OrderResult[])
    setSearching(false)
  }

  const handleLink = async () => {
    if (!selected) return
    setSaving(true)
    setError(null)

    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { setError('Not authenticated.'); setSaving(false); return }

    // Update payment
    const { error: updateErr } = await supabase
      .from('finance_payment_requests')
      .update({
        order_id:     selected.id,
        order_number: selected.display_number,
        status:       'approved_linked',
        updated_at:   new Date().toISOString(),
      })
      .eq('id', payment.id)

    if (updateErr) { setError(friendlyDbErrorMessage(updateErr)); setSaving(false); return }

    // Activity log
    await supabase.from('order_activity_log').insert({
      order_id:   selected.id,
      actor_id:   session.user.id,
      event_type: 'payment_linked',
      payload: {
        payment_id:  payment.id,
        amount:      payment.amount,
        client_name: payment.client_name,
      },
    })

    onLinked()
  }

  const isSuspense = !payment.order_id

  return (
    <Modal title={isSuspense ? 'Link to Order' : 'Change Linked Order'} onClose={onClose}>
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
      <Field label="Search Orders">
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
            placeholder="Order number or client name…"
            value={query}
            onChange={e => handleSearch(e.target.value)}
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: '13px', color: colors.primary }}
          />
          {searching && <span style={{ fontSize: '11px', color: colors.muted }}>Searching…</span>}
        </div>
      </Field>

      {/* Results */}
      {results.length > 0 && (
        <div style={{
          border: `1px solid ${colors.border}`, borderRadius: '8px', overflow: 'hidden',
          maxHeight: '240px', overflowY: 'auto',
        }}>
          {results.map((o, idx) => {
            const isSelected = selected?.id === o.id
            const osMeta = ORDER_STATUS_META[o.status] ?? { label: o.status, color: colors.muted }
            return (
              <div
                key={o.id}
                onClick={() => setSelected(isSelected ? null : o)}
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>{o.display_number}</span>
                    <span style={{ fontSize: '11px', fontWeight: 600, color: osMeta.color }}>{osMeta.label}</span>
                  </div>
                  <div style={{ fontSize: '12px', color: colors.secondary, marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {o.client_name}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>
                    {o.total_value != null ? fmtAmount(o.total_value) : '—'}
                  </div>
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
          No orders found for &ldquo;{query.trim()}&rdquo;.
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
          {saving ? 'Linking…' : `Link to ${selected ? selected.display_number : 'Order'}`}
        </button>
      </div>
    </Modal>
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
  onView,
  onEdit,
  onDelete,
  onLink,
  onUnlink,
}: {
  rows: PaymentRequest[]
  isAdmin: boolean
  onView:   (r: PaymentRequest) => void
  onEdit:   (r: PaymentRequest) => void
  onDelete: (r: PaymentRequest) => void
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
            return (
              <tr
                key={r.id}
                onClick={() => onView(r)}
                style={{ cursor: 'pointer' }}
                onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = colors.raised }}
                onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = 'transparent' }}
              >
                <td style={{ ...TD, fontSize: '13px', fontWeight: 600, color: colors.primary }}>
                  {r.client_name}
                </td>
                {/* Order column — shows linked order number or Suspense badge */}
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
                  <StatusBadge status={r.status} />
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
                        {/* Link action for suspense payments */}
                        {!isLinked && (
                          <button
                            onClick={() => onLink(r)}
                            className="boe-btn boe-btn-ghost"
                            style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 600, color: colors.blue }}
                          >
                            Link
                          </button>
                        )}
                        {/* Unlink action for linked payments */}
                        {isLinked && (
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
                        <button
                          onClick={() => onDelete(r)}
                          className="boe-btn boe-btn-ghost"
                          style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 500, color: colors.red }}
                        >
                          Delete
                        </button>
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
  const [pageLoading,    setPageLoading]    = useState(true)
  const [isAdmin,        setIsAdmin]        = useState(false)
  const [profile,        setProfile]        = useState<UserProfile | null>(null)
  const [requests,       setRequests]       = useState<PaymentRequest[]>([])
  const [listLoading,    setListLoading]    = useState(false)
  const [detailRequest,  setDetailRequest]  = useState<PaymentRequest | null>(null)
  const [editRequest,    setEditRequest]    = useState<PaymentRequest | null>(null)
  const [deleteRequest,  setDeleteRequest]  = useState<PaymentRequest | null>(null)
  const [linkRequest,    setLinkRequest]    = useState<PaymentRequest | null>(null)
  const [unlinkTarget,   setUnlinkTarget]   = useState<PaymentRequest | null>(null)
  const [unlinking,      setUnlinking]      = useState(false)
  const [unlinkError,    setUnlinkError]    = useState<string | null>(null)
  const [search,         setSearch]         = useState('')

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const loadRequests = async () => {
    setListLoading(true)
    const { data } = await supabase
      .from('finance_payment_requests')
      .select(`
        id, request_number, client_name, amount, payment_date, payment_mode,
        received_in, proof_note, order_number, order_id, sales_note,
        status, submitted_by, admin_note, created_at,
        submitted_by_user:users!submitted_by(full_name)
      `)
      .eq('status', 'approved_linked')
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

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  // Unlink a payment — sets order_id=null, status=approved_unlinked, logs activity
  const handleUnlink = async () => {
    if (!unlinkTarget) return
    setUnlinking(true)
    setUnlinkError(null)

    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { setUnlinkError('Not authenticated.'); setUnlinking(false); return }

    const previousOrderId     = unlinkTarget.order_id
    const previousOrderNumber = unlinkTarget.order_number

    const { error: updateErr } = await supabase
      .from('finance_payment_requests')
      .update({
        order_id:   null,
        status:     'approved_unlinked',
        updated_at: new Date().toISOString(),
      })
      .eq('id', unlinkTarget.id)

    if (updateErr) { setUnlinkError(updateErr.message); setUnlinking(false); return }

    // Activity log on the order that was previously linked
    if (previousOrderId) {
      await supabase.from('order_activity_log').insert({
        order_id:   previousOrderId,
        actor_id:   session.user.id,
        event_type: 'payment_unlinked',
        payload: {
          payment_id:            unlinkTarget.id,
          amount:                unlinkTarget.amount,
          previous_order_number: previousOrderNumber,
        },
      })
    }

    setUnlinkTarget(null)
    setUnlinking(false)
    loadRequests()
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return requests
    return requests.filter(r =>
      r.client_name.toLowerCase().includes(q) ||
      (r.order_number ?? '').toLowerCase().includes(q)
    )
  }, [requests, search])

  // Summary counts
  const suspenseCount = requests.filter(r => !r.order_id).length
  const linkedCount   = requests.filter(r =>  r.order_id).length

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
            {linkedCount} linked · {suspenseCount} unlinked
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
            onView={r  => setDetailRequest(r)}
            onEdit={r  => setEditRequest(r)}
            onDelete={r => setDeleteRequest(r)}
            onLink={r  => setLinkRequest(r)}
            onUnlink={r => setUnlinkTarget(r)}
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

      {deleteRequest && (
        <DeleteConfirmModal
          request={deleteRequest}
          supabase={supabase}
          onClose={() => setDeleteRequest(null)}
          onDeleted={() => { setDeleteRequest(null); loadRequests() }}
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

      {/* Unlink confirmation inline */}
      {unlinkTarget && (
        <>
          <div
            onClick={() => { if (!unlinking) setUnlinkTarget(null) }}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 59 }}
          />
          <div style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
            width: '380px', maxWidth: 'calc(100vw - 32px)',
            background: colors.base, borderRadius: '12px', border: `1px solid ${colors.border}`,
            zIndex: 60, padding: '24px', display: 'flex', flexDirection: 'column', gap: '14px',
          }}>
            <div style={{ fontSize: '15px', fontWeight: 700, color: colors.primary }}>Unlink Payment?</div>
            <div style={{ fontSize: '13px', color: colors.secondary, lineHeight: 1.6 }}>
              This will remove the link between{' '}
              <strong>{unlinkTarget.client_name}</strong> ({fmtAmount(unlinkTarget.amount)}) and order{' '}
              <strong>{unlinkTarget.order_number ?? unlinkTarget.order_id}</strong>.
              <br /><br />
              The payment will return to suspense status.
            </div>
            {unlinkError && <ErrorBanner message={unlinkError} />}
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setUnlinkTarget(null)}
                disabled={unlinking}
                className="boe-btn boe-btn-ghost"
                style={{ padding: '8px 18px', fontSize: '13px' }}
              >
                Cancel
              </button>
              <button
                onClick={handleUnlink}
                disabled={unlinking}
                style={{
                  padding: '8px 18px', fontSize: '13px', fontWeight: 600, borderRadius: '8px',
                  border: `1px solid ${colors.border}`, background: colors.raised,
                  color: colors.primary, cursor: unlinking ? 'not-allowed' : 'pointer',
                  opacity: unlinking ? 0.6 : 1,
                }}
              >
                {unlinking ? 'Unlinking…' : 'Yes, Unlink'}
              </button>
            </div>
          </div>
        </>
      )}

    </FinanceLayout>
  )
}
