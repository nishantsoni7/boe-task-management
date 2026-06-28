'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { PageShell } from '@/components/layout/PageShell'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'

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
  created_at: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Map DB snake_case values to readable labels
const PAYMENT_MODE_LABEL: Record<string, string> = {
  bank_transfer:   'Bank Transfer',
  cash:            'Cash',
  upi:             'UPI',
  cheque:          'Cheque',
  other:           'Other',
}

const RECEIVED_IN_LABEL: Record<string, string> = {
  company_account: 'Company Account',
  cash_in_hand:    'Cash in Hand',
  savings_account: 'Savings Account',
  other:           'Other',
}

const STATUS_META: Record<string, { label: string; bg: string; color: string }> = {
  pending_approval:    { label: 'Pending Approval',    bg: '#FFFBEB', color: '#92400E' },
  approved_unlinked:   { label: 'Approved',            bg: '#F0FDF4', color: '#166534' },
  approved_linked:     { label: 'Approved',            bg: '#F0FDF4', color: '#166534' },
  needs_clarification: { label: 'Needs Clarification', bg: '#EFF6FF', color: '#1E40AF' },
  rejected:            { label: 'Rejected',            bg: '#FEF2F2', color: '#991B1B' },
}

// UI select options → DB values
const PAYMENT_MODE_OPTIONS: { label: string; value: string }[] = [
  { label: 'Bank Transfer', value: 'bank_transfer' },
  { label: 'Cash',          value: 'cash' },
  { label: 'UPI',           value: 'upi' },
  { label: 'Cheque',        value: 'cheque' },
  { label: 'Other',         value: 'other' },
]

const RECEIVED_IN_OPTIONS: { label: string; value: string }[] = [
  { label: 'Company Account', value: 'company_account' },
  { label: 'Cash in Hand',    value: 'cash_in_hand' },
  { label: 'Savings Account', value: 'savings_account' },
  { label: 'Other',           value: 'other' },
]

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function fmtAmount(n: number) {
  return '₹' + n.toLocaleString('en-IN')
}

// ── Modal shell ───────────────────────────────────────────────────────────────

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 59 }}
      />
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

// ── New Payment Confirmation modal ────────────────────────────────────────────

const EMPTY_FORM = {
  clientName:  '',
  amount:      '',
  paymentDate: '',
  paymentMode: PAYMENT_MODE_OPTIONS[0].value,
  receivedIn:  RECEIVED_IN_OPTIONS[0].value,
  proofNote:   '',
  orderNumber: '',
  salesNote:   '',
}

type NewPaymentModalProps = {
  userId: string
  supabase: ReturnType<typeof createClient>
  onClose: () => void
  onSaved: () => void
}

function NewPaymentConfirmationModal({ userId, supabase, onClose, onSaved }: NewPaymentModalProps) {
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState<string | null>(null)

  const set = (key: keyof typeof EMPTY_FORM) => (
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(prev => ({ ...prev, [key]: e.target.value }))
  )

  const canSubmit = form.clientName.trim() && form.amount.trim() && form.paymentDate && form.proofNote.trim()

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSaving(true)
    setError(null)

    const { error: dbError } = await supabase
      .from('finance_payment_requests')
      .insert({
        client_name:  form.clientName.trim(),
        amount:       parseFloat(form.amount),
        payment_date: form.paymentDate,
        payment_mode: form.paymentMode,
        received_in:  form.receivedIn,
        proof_note:   form.proofNote.trim(),
        order_number: form.orderNumber.trim() || null,
        sales_note:   form.salesNote.trim()   || null,
        status:       'pending_approval',
        submitted_by: userId,
      })

    setSaving(false)
    if (dbError) { setError(dbError.message); return }
    onSaved()
  }

  return (
    <Modal title="New Payment Confirmation" onClose={onClose}>

      <Field label="Client Name" required>
        <input
          className="boe-input"
          value={form.clientName}
          onChange={set('clientName')}
          placeholder="e.g. Raj Enterprises"
          style={{ width: '100%' }}
        />
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <Field label="Amount (₹)" required>
          <input
            className="boe-input"
            type="number"
            min="0"
            value={form.amount}
            onChange={set('amount')}
            placeholder="0"
            style={{ width: '100%' }}
          />
        </Field>
        <Field label="Payment Date" required>
          <input
            className="boe-input"
            type="date"
            value={form.paymentDate}
            onChange={set('paymentDate')}
            style={{ width: '100%' }}
          />
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
        <textarea
          className="boe-input"
          value={form.proofNote}
          onChange={set('proofNote')}
          placeholder="e.g. UTR 123456789, cheque no. 001234, or cash received at office"
          rows={2}
          style={{ width: '100%', resize: 'vertical' }}
        />
      </Field>

      <Field label="Order Number (optional)">
        <input
          className="boe-input"
          value={form.orderNumber}
          onChange={set('orderNumber')}
          placeholder="Leave blank if order not yet created"
          style={{ width: '100%' }}
        />
      </Field>

      <Field label="Sales Note (optional)">
        <textarea
          className="boe-input"
          value={form.salesNote}
          onChange={set('salesNote')}
          placeholder="Any additional context for admin"
          rows={2}
          style={{ width: '100%', resize: 'vertical' }}
        />
      </Field>

      {error && (
        <div style={{
          padding: '10px 12px', borderRadius: '8px',
          background: 'rgba(217,79,79,0.1)', color: '#C13030', fontSize: '12px',
        }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
        <button onClick={onClose} className="boe-btn boe-btn-ghost" style={{ padding: '8px 18px', fontSize: '13px' }}>
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={!canSubmit || saving}
          className="boe-btn boe-btn-primary"
          style={{ padding: '8px 18px', fontSize: '13px' }}
        >
          {saving ? 'Submitting…' : 'Submit Request'}
        </button>
      </div>

    </Modal>
  )
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { label: status, bg: '#F3F4F6', color: '#4B5563' }
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px', borderRadius: '5px',
      background: meta.bg, color: meta.color,
      fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      {meta.label}
    </span>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function FinancePage() {
  const [pageLoading, setPageLoading] = useState(true)
  const [userId, setUserId]           = useState<string>('')
  const [requests, setRequests]       = useState<PaymentRequest[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [showForm, setShowForm]       = useState(false)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  // ── Auth + initial load ──────────────────────────────────────────────────────
  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      setUserId(session.user.id)
      await loadRequests()
      setPageLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Fetch list ───────────────────────────────────────────────────────────────
  const loadRequests = async () => {
    setListLoading(true)
    const { data } = await supabase
      .from('finance_payment_requests')
      .select('id, client_name, amount, payment_date, payment_mode, received_in, proof_note, order_number, sales_note, status, submitted_by, created_at')
      .order('created_at', { ascending: false })
    setRequests((data ?? []) as PaymentRequest[])
    setListLoading(false)
  }

  // ── Counts for status chips ──────────────────────────────────────────────────
  const counts = {
    pending_approval:    requests.filter(r => r.status === 'pending_approval').length,
    approved:            requests.filter(r => r.status === 'approved_unlinked' || r.status === 'approved_linked').length,
    needs_clarification: requests.filter(r => r.status === 'needs_clarification').length,
    rejected:            requests.filter(r => r.status === 'rejected').length,
  }

  const STATUS_CHIPS = [
    { label: 'Pending Approval',    count: counts.pending_approval,    bg: '#FFFBEB', color: '#92400E' },
    { label: 'Approved',            count: counts.approved,            bg: '#F0FDF4', color: '#166534' },
    { label: 'Needs Clarification', count: counts.needs_clarification, bg: '#EFF6FF', color: '#1E40AF' },
    { label: 'Rejected',            count: counts.rejected,            bg: '#FEF2F2', color: '#991B1B' },
  ]

  if (pageLoading) return <LoadingScreen />

  return (
    <PageShell
      title="Finance"
      subtitle="Payment confirmations, order advances, and finance approvals."
      actions={
        <button
          onClick={() => router.push('/modules')}
          className="boe-btn boe-btn-ghost"
          style={{ padding: '6px 14px', fontSize: '12px' }}
        >
          ← Modules
        </button>
      }
    >

      {/* ── Payment Confirmations section ── */}
      <div className="boe-card" style={{ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: '16px' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 700, color: colors.primary, marginBottom: '4px' }}>
              Payment Confirmations
            </div>
            <div style={{ fontSize: '12px', color: colors.muted }}>
              Sales can submit customer payment details here for admin confirmation.
            </div>
          </div>
          <button
            onClick={() => setShowForm(true)}
            className="boe-btn boe-btn-primary"
            style={{ padding: '8px 18px', fontSize: '13px', flexShrink: 0 }}
          >
            + New Payment Confirmation
          </button>
        </div>

        {/* Status summary chips */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          {STATUS_CHIPS.map(chip => (
            <span
              key={chip.label}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                padding: '4px 10px', borderRadius: '6px',
                background: chip.bg, color: chip.color,
                fontSize: '11px', fontWeight: 600,
              }}
            >
              {chip.label}
              <span style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                minWidth: '16px', height: '16px', borderRadius: '4px',
                background: 'rgba(0,0,0,0.08)', fontSize: '10px', fontWeight: 700,
              }}>{chip.count}</span>
            </span>
          ))}
        </div>

        {/* List / empty state */}
        <div style={{ borderTop: `1px solid ${colors.border}` }}>
          {listLoading ? (
            <div style={{ padding: '32px 0', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>
              Loading…
            </div>
          ) : requests.length === 0 ? (
            <div style={{ padding: '32px 0', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>
              No payment confirmations yet.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {requests.map((r, i) => (
                <div
                  key={r.id}
                  style={{
                    padding: '14px 0',
                    borderBottom: i < requests.length - 1 ? `1px solid ${colors.border}` : 'none',
                    display: 'flex', flexDirection: 'column', gap: '6px',
                  }}
                >
                  {/* Row 1: client + amount + status */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                    <div style={{ fontWeight: 600, fontSize: '14px', color: colors.primary }}>
                      {r.client_name}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
                      <span style={{ fontWeight: 700, fontSize: '14px', color: colors.primary }}>
                        {fmtAmount(r.amount)}
                      </span>
                      <StatusBadge status={r.status} />
                    </div>
                  </div>

                  {/* Row 2: meta details */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', fontSize: '12px', color: colors.secondary }}>
                    <span>{fmtDate(r.payment_date)}</span>
                    <span>·</span>
                    <span>{PAYMENT_MODE_LABEL[r.payment_mode] ?? r.payment_mode}</span>
                    <span>·</span>
                    <span>{RECEIVED_IN_LABEL[r.received_in] ?? r.received_in}</span>
                    <span>·</span>
                    <span style={{ color: r.order_number ? colors.secondary : colors.muted, fontStyle: r.order_number ? 'normal' : 'italic' }}>
                      {r.order_number ?? 'Order pending'}
                    </span>
                    <span>·</span>
                    <span style={{ color: colors.muted }}>Submitted {fmtDate(r.created_at)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>

      {showForm && (
        <NewPaymentConfirmationModal
          userId={userId}
          supabase={supabase}
          onClose={() => setShowForm(false)}
          onSaved={() => { setShowForm(false); loadRequests() }}
        />
      )}

    </PageShell>
  )
}
