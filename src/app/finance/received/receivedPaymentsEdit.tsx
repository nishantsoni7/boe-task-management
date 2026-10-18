'use client'

// Split out of ReceivedPaymentsView.tsx (it had grown past 3,000 lines). Nothing here changed.

import { useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import { groupIndianDigits, isValidAmount } from '@/lib/currency'
import { paymentModeLabel, customerDisplayName } from '@/lib/finance/paymentEntry'
import { FormDialog, FormStep, OptionalDisclosure, PaymentDetailsFields, scrollToFirstProblem } from '@/app/finance/components/PaymentFormParts'
import { PaymentRequest, RECEIVED_IN_OPTIONS, friendlyDbErrorMessage, Field, ErrorBanner } from './receivedPaymentsModel'

// ── Edit Payment modal ────────────────────────────────────────────────────────

export function EditPaymentModal({
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
    amount:      String(r.amount),
    paymentDate: r.payment_date,
    paymentMode: r.payment_mode,
    receivedIn:  r.received_in ?? '',
    proofNote:   r.proof_note ?? '',
    orderNumber: r.order_number ?? '',
    salesNote:   r.sales_note  ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState<string | null>(null)

  // Every row on this page is approved_unlinked or approved_linked (see the
  // page-level query), so this is always true here — order_number for those
  // states was never this form's to write (20260691000000 gave it to the
  // guarded RPCs), and with linking retired nothing writes it at all.
  const isLinkageStatus = r.status === 'approved_unlinked' || r.status === 'approved_linked'

  const set = (key: keyof typeof form) => (
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(prev => ({ ...prev, [key]: e.target.value }))
  )

  const canSubmit = isValidAmount(form.amount) && form.paymentDate

  // Problems are named only after Save was pressed, and clear as they are put right.
  const [showProblems, setShowProblems] = useState(false)
  const [proofOpen, setProofOpen] = useState(!!(form.proofNote.trim() || form.salesNote.trim()))
  const formRef = useRef<HTMLDivElement>(null)
  const amountProblem = showProblems && form.amount.trim() === '' ? 'Enter the amount received.' : null
  const dateProblem = showProblems && !form.paymentDate ? 'Pick the date it was paid.' : null

  // SAVE IS NEVER GREYED OUT BY AN UNFINISHED FORM. It names what is missing and
  // takes the person to it; canSubmit still decides whether anything is sent.
  const reviewAndSave = () => {
    if (saving) return
    if (!canSubmit) {
      setShowProblems(true)
      scrollToFirstProblem(formRef.current)
      return
    }
    void handleSave()
  }

  const handleSave = async () => {
    if (!canSubmit) return
    setSaving(true)
    setError(null)
    const { data: updated, error: dbError } = await supabase
      .from('finance_payment_requests')
      .update({
        // THE CUSTOMER IS NOT IN THIS PAYLOAD. Since 20261013000000 it is
        // derived server-side from the records this payment is allocated to,
        // and is null when there are none. A typed correction here could only
        // disagree with the allocations — so the field is gone and the stored
        // value is left exactly as the server wrote it.
        amount:       Number(form.amount),
        payment_date: form.paymentDate,
        payment_mode: form.paymentMode,
        // '' is the not-stated sentinel and is stored as NULL. A payment
        // recorded against a PI arrives with no account, and correcting some
        // other field here must not invent one.
        received_in:  form.receivedIn === '' ? null : form.receivedIn,
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

  const summary = [
    isValidAmount(form.amount) ? `₹${groupIndianDigits(form.amount)}` : null,
    paymentModeLabel(form.paymentMode),
    customerDisplayName(r.client_name),
  ].filter(Boolean).join(' · ')

  return (
    <FormDialog
      title="Edit Received Payment"
      subtitle={r.human_payment_id ?? undefined}
      onClose={onClose}
      closeDisabled={saving}
      closeOnEscape
      width="600px"
      summary={summary}
      actions={
        <>
          <button onClick={onClose} disabled={saving} className="boe-btn boe-btn-ghost" style={{ padding: '7px 16px', fontSize: '13px' }}>Cancel</button>
          <button onClick={reviewAndSave} disabled={saving}
            className="boe-btn boe-btn-primary" style={{ padding: '7px 16px', fontSize: '13px' }}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </>
      }
    >
      <div ref={formRef} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <Field label="Customer">
          <input className="boe-input" value={customerDisplayName(r.client_name)} readOnly disabled
            style={{ width: '100%' }} />
          <span style={{ fontSize: '12px', color: colors.muted, marginTop: '2px' }}>
            Read from the records this payment is allocated to. Allocate or
            reverse an allocation to change it.
          </span>
        </Field>

        <FormStep number={1} title="Payment">
          {/* A HISTORICAL ROW KEEPS ITS OWN VALUE AS AN OPTION, so correcting
              some other field on a 2026 payment does not silently move it onto
              one of the four. The picker draws paymentModeOptionsFor, which adds
              it, marked retired, only for a row that already carries one.
              finance_payment_requests_enforce_current_payment_mode allows exactly
              that: an UPDATE that leaves the mode alone. */}
          <PaymentDetailsFields
            amount={form.amount}
            onAmount={v => setForm(prev => ({ ...prev, amount: v }))}
            date={form.paymentDate}
            onDate={v => setForm(prev => ({ ...prev, paymentDate: v }))}
            mode={form.paymentMode}
            onMode={v => setForm(prev => ({ ...prev, paymentMode: v }))}
            disabled={saving}
            amountProblem={amountProblem}
            dateProblem={dateProblem}
            modeHintId="edit-received-mode-hint"
          />
          <Field label="Received In" required>
            <select className="boe-input" value={form.receivedIn} onChange={set('receivedIn')} style={{ width: '100%' }}>
              {RECEIVED_IN_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
        </FormStep>

        <OptionalDisclosure
          title="Add proof or notes"
          hint={(form.proofNote.trim() || form.salesNote.trim()) ? 'Added' : 'Optional'}
          open={proofOpen}
          onToggle={() => setProofOpen(o => !o)}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <Field label="Payment Proof / Reference Note">
              <textarea className="boe-input" value={form.proofNote} onChange={set('proofNote')}
                placeholder="e.g. UTR 123456789, cheque no. 001234, or cash received at office (optional)"
                rows={2} style={{ width: '100%', resize: 'vertical' }} />
            </Field>
            <Field label="Sales Note (optional)">
              <textarea className="boe-input" value={form.salesNote} onChange={set('salesNote')}
                placeholder="Any additional context"
                rows={2} style={{ width: '100%', resize: 'vertical' }} />
            </Field>
          </div>
        </OptionalDisclosure>

        {isLinkageStatus ? (
          <div style={{ fontSize: '12px', color: colors.muted, lineHeight: 1.5 }}>
            Funds are attached with Allocate Funds, not here.
          </div>
        ) : (
          <Field label="Order Number">
            <input className="boe-input" value={form.orderNumber} onChange={set('orderNumber')}
              placeholder="Order number" style={{ width: '100%' }} />
          </Field>
        )}

        {error && <ErrorBanner message={error} />}
      </div>
    </FormDialog>
  )
}
