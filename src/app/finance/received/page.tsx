'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { FinanceLayout } from '@/components/layout/FinanceLayout'
import type { UserProfile } from '@/lib/types'

// ── Types ─────────────────────────────────────────────────────────────────────

type PaymentRequest = {
  id: string
  client_name: string
  amount: number
  payment_date: string
  payment_mode: string
  received_in: string
  proof_note: string
  order_number: string | null
  sales_note: string | null
  status: string
  submitted_by: string
  submitted_by_name?: string
  admin_note: string | null
  created_at: string
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
  return '₹' + n.toLocaleString('en-IN')
}

function fmtDateTime(iso: string) {
  const d = new Date(iso)
  const date = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
  return `${date}, ${time}`
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
      background: meta.bg, color: meta.color,
      border: `1px solid ${meta.border}`,
      fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      {meta.label}
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
  const linkedRequiresOrderNo = newStatus === 'approved_linked' && !r.order_number?.trim()
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
    if (dbError) { setCorrectionError(dbError.message); return }
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
        <DetailRow label="Client"       value={r.client_name} />
        <DetailRow label="Amount"       value={fmtAmount(r.amount)} />
        <DetailRow label="Payment Date" value={fmtDate(r.payment_date)} />
        <DetailRow label="Payment Mode" value={PAYMENT_MODE_LABEL[r.payment_mode] ?? r.payment_mode} />
        <DetailRow label="Received In"  value={RECEIVED_IN_LABEL[r.received_in]  ?? r.received_in} />
        <DetailRow label="Order No."    value={r.order_number ?? '—'} />
        <div style={{ gridColumn: '1 / -1' }}>
          <DetailRow label="Proof / Reference" value={r.proof_note} />
        </div>
        {r.sales_note && (
          <div style={{ gridColumn: '1 / -1' }}>
            <DetailRow label="Sales Note" value={r.sales_note} />
          </div>
        )}
        <DetailRow label="Submitted" value={fmtDate(r.created_at)} />
        {r.submitted_by_name && <DetailRow label="Submitted By" value={r.submitted_by_name} />}
      </div>

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
            <ErrorBanner message="Order number is required before moving to Received Payments." />
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
    proofNote:   r.proof_note,
    orderNumber: r.order_number ?? '',
    salesNote:   r.sales_note  ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState<string | null>(null)

  const set = (key: keyof typeof form) => (
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(prev => ({ ...prev, [key]: e.target.value }))
  )

  const canSubmit = form.clientName.trim() && form.amount.trim() && form.paymentDate && form.proofNote.trim()

  const handleSave = async () => {
    if (!canSubmit) return
    if (r.status === 'approved_linked' && !form.orderNumber.trim()) {
      setError('Order number is required for Received Payments.')
      return
    }
    setSaving(true)
    setError(null)
    const { data: updated, error: dbError } = await supabase
      .from('finance_payment_requests')
      .update({
        client_name:  form.clientName.trim(),
        amount:       parseFloat(form.amount),
        payment_date: form.paymentDate,
        payment_mode: form.paymentMode,
        received_in:  form.receivedIn,
        proof_note:   form.proofNote.trim(),
        order_number: form.orderNumber.trim() || null,
        sales_note:   form.salesNote.trim()   || null,
        updated_at:   new Date().toISOString(),
      })
      .eq('id', r.id)
      .select('id')
      .single()
    setSaving(false)
    if (dbError) { setError(dbError.message); return }
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
      <Field label="Payment Proof / Reference Note" required>
        <textarea className="boe-input" value={form.proofNote} onChange={set('proofNote')}
          placeholder="e.g. UTR 123456789, cheque no. 001234, or cash received at office"
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
        <DetailRow label="Client"       value={r.client_name} />
        <DetailRow label="Amount"       value={fmtAmount(r.amount)} />
        <DetailRow label="Order No."    value={r.order_number ?? '—'} />
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
}: {
  rows: PaymentRequest[]
  isAdmin: boolean
  onView: (r: PaymentRequest) => void
  onEdit: (r: PaymentRequest) => void
  onDelete: (r: PaymentRequest) => void
}) {
  const TD: React.CSSProperties = { padding: '8px 12px', borderBottom: `1px solid ${colors.border}`, whiteSpace: 'nowrap' }

  return (
    <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '960px' }}>
        <thead>
          <tr>
            <th style={TH_STYLE}>Client</th>
            <th style={TH_STYLE}>Order Number</th>
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
          {rows.map(r => (
            <tr
              key={r.id}
              onClick={() => onView(r)}
              style={{ cursor: 'pointer', borderLeft: `3px solid transparent` }}
              onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = colors.raised }}
              onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = 'transparent' }}
            >
              <td style={{ ...TD, fontSize: '13px', fontWeight: 600, color: colors.primary }}>
                {r.client_name}
              </td>
              <td style={{ ...TD, fontSize: '12px', color: r.order_number ? colors.secondary : colors.muted, fontStyle: r.order_number ? 'normal' : 'italic' }}>
                {r.order_number ?? '—'}
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
                    <button
                      onClick={() => onEdit(r)}
                      className="boe-btn boe-btn-ghost"
                      style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 500 }}
                    >
                      Edit
                    </button>
                  )}
                  {isAdmin && (
                    <button
                      onClick={() => onDelete(r)}
                      className="boe-btn boe-btn-ghost"
                      style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 500, color: colors.red }}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ReceivedPaymentsPage() {
  const [pageLoading, setPageLoading] = useState(true)
  const [userId, setUserId]           = useState<string>('')
  const [isAdmin, setIsAdmin]         = useState(false)
  const [profile, setProfile]         = useState<UserProfile | null>(null)
  const [requests, setRequests]       = useState<PaymentRequest[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [detailRequest, setDetailRequest] = useState<PaymentRequest | null>(null)
  const [editRequest,   setEditRequest]   = useState<PaymentRequest | null>(null)
  const [deleteRequest, setDeleteRequest] = useState<PaymentRequest | null>(null)
  const [search, setSearch]           = useState('')

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const uid = session.user.id
      setUserId(uid)

      const { data: me } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, position, is_active, created_at, employee_code, joining_date, monthly_salary, office_timing, fingerprint_employee_code')
        .eq('id', uid)
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

  const loadRequests = async () => {
    setListLoading(true)
    const { data } = await supabase
      .from('finance_payment_requests')
      .select(`
        id, client_name, amount, payment_date, payment_mode,
        received_in, proof_note, order_number, sales_note,
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

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return requests
    return requests.filter(r =>
      r.client_name.toLowerCase().includes(q) ||
      (r.order_number ?? '').toLowerCase().includes(q)
    )
  }, [requests, search])

  if (pageLoading) return <LoadingScreen />

  return (
    <FinanceLayout
      profile={profile}
      title="Received Payments"
      subtitle="Payments fully confirmed with order number assigned."
      onSignOut={handleSignOut}
      onRefresh={loadRequests}
    >
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
            onView={r => setDetailRequest(r)}
            onEdit={r => setEditRequest(r)}
            onDelete={r => setDeleteRequest(r)}
          />
        )}

      </div>

      {/* Modals */}
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

    </FinanceLayout>
  )
}
