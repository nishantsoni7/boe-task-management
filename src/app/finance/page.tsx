'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { PageShell } from '@/components/layout/PageShell'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'

// ── Status chips ──────────────────────────────────────────────────────────────

const STATUS_CHIPS = [
  { label: 'Pending Approval',    bg: '#FFFBEB', color: '#92400E' },
  { label: 'Approved',            bg: '#F0FDF4', color: '#166534' },
  { label: 'Needs Clarification', bg: '#EFF6FF', color: '#1E40AF' },
  { label: 'Rejected',            bg: '#FEF2F2', color: '#991B1B' },
]

const PAYMENT_MODE_OPTIONS = ['Bank Transfer', 'Cash', 'UPI', 'Cheque', 'Other']
const RECEIVED_IN_OPTIONS  = ['Company Account', 'Cash in Hand', 'Savings Account', 'Other']

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
  clientName:   '',
  amount:       '',
  paymentDate:  '',
  paymentMode:  PAYMENT_MODE_OPTIONS[0],
  receivedIn:   RECEIVED_IN_OPTIONS[0],
  proofNote:    '',
  orderNumber:  '',
  salesNote:    '',
}

function NewPaymentConfirmationModal({ onClose }: { onClose: () => void }) {
  const [form, setForm]       = useState(EMPTY_FORM)
  const [submitted, setSubmitted] = useState(false)

  const set = (key: keyof typeof EMPTY_FORM) => (
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(prev => ({ ...prev, [key]: e.target.value }))
  )

  const handleSubmit = () => {
    if (!form.clientName.trim() || !form.amount.trim() || !form.paymentDate) return
    setSubmitted(true)
  }

  return (
    <Modal title="New Payment Confirmation" onClose={onClose}>

      {submitted ? (
        <div style={{
          padding: '18px 16px', borderRadius: '8px',
          background: colors.blueTint, border: `1px solid ${colors.blue}22`,
          fontSize: '13px', color: colors.secondary, textAlign: 'center',
        }}>
          Saving will be connected in the next step.
        </div>
      ) : (
        <>
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
                {PAYMENT_MODE_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </Field>
            <Field label="Received In" required>
              <select className="boe-input" value={form.receivedIn} onChange={set('receivedIn')} style={{ width: '100%' }}>
                {RECEIVED_IN_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
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
        </>
      )}

      <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
        <button onClick={onClose} className="boe-btn boe-btn-ghost" style={{ padding: '8px 18px', fontSize: '13px' }}>
          Cancel
        </button>
        {!submitted && (
          <button
            onClick={handleSubmit}
            disabled={!form.clientName.trim() || !form.amount.trim() || !form.paymentDate}
            className="boe-btn boe-btn-primary"
            style={{ padding: '8px 18px', fontSize: '13px' }}
          >
            Submit Request
          </button>
        )}
      </div>

    </Modal>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function FinancePage() {
  const [loading, setLoading]   = useState(true)
  const [showForm, setShowForm] = useState(false)
  const router  = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (loading) return <LoadingScreen />

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
              }}>0</span>
            </span>
          ))}
        </div>

        {/* Empty state */}
        <div style={{
          padding: '32px 0', textAlign: 'center',
          borderTop: `1px solid ${colors.border}`,
          color: colors.muted, fontSize: '13px',
        }}>
          No payment confirmations yet.
        </div>

      </div>

      {showForm && <NewPaymentConfirmationModal onClose={() => setShowForm(false)} />}

    </PageShell>
  )
}
