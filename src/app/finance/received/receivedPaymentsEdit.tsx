'use client'

// Split out of ReceivedPaymentsView.tsx (it had grown past 3,000 lines). Nothing here changed.

import { useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import { groupIndianDigits, isValidAmount } from '@/lib/currency'
import { paymentModeLabel, customerDisplayName } from '@/lib/finance/paymentEntry'
import { FormDialog, OptionalDisclosure, PaymentDetailsFields, scrollToFirstProblem } from '@/app/finance/components/PaymentFormParts'
import { PaymentRequest, friendlyDbErrorMessage, ErrorBanner } from './receivedPaymentsModel'
import { PaymentCashLockNotice, usePaymentCashLock } from '@/components/finance/PaymentCashLockNotice'
import type { LegacyOrderRow } from '@/lib/finance/allocatedAgainst'
import { LEGACY_CLIENT_NAME_MAX, LEGACY_ORDER_WORD, normalizeLegacyClientName } from '@/lib/finance/legacyOrderAllocation'

// Quiet, Notion-like type: labels small and muted, values larger and darker.
const LABEL_STYLE: React.CSSProperties = { fontSize: '12px', fontWeight: 500, color: colors.muted }
const HELP_STYLE: React.CSSProperties = { fontSize: '12px', color: colors.muted, lineHeight: 1.5 }
const SECTION_STYLE: React.CSSProperties = {
  margin: 0, paddingBottom: '6px', borderBottom: `1px solid ${colors.border}`,
  fontSize: '12px', fontWeight: 600, color: colors.secondary, letterSpacing: '0.04em', textTransform: 'uppercase',
}

function QuietField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <span style={LABEL_STYLE}>{label}</span>
      {children}
    </label>
  )
}

// ── Edit Payment modal ────────────────────────────────────────────────────────

export function EditPaymentModal({
  request: r,
  legacyOrders = [],
  supabase,
  onClose,
  onSaved,
}: {
  request: PaymentRequest
  /**
   * The ACTIVE old orders this payment is allocated to (Confirmed Payments only).
   * The client typed with each can be corrected here — correct_legacy_order_client,
   * 20270701000000 — because an old order is not a record anywhere else, so this
   * is the only place its client lives. Empty: no "Old orders" section.
   */
  legacyOrders?: LegacyOrderRow[]
  supabase: ReturnType<typeof createClient>
  onClose: () => void
  onSaved: () => void
}) {
  const initialForm = {
    amount:      String(r.amount),
    paymentDate: r.payment_date,
    paymentMode: r.payment_mode,
    proofNote:   r.proof_note ?? '',
    orderNumber: r.order_number ?? '',
    salesNote:   r.sales_note  ?? '',
  }
  const [form, setForm] = useState(initialForm)
  // The client of each old order, by allocation id, as the person is typing it.
  const [legacyClients, setLegacyClients] = useState<Record<string, string>>(
    () => Object.fromEntries(legacyOrders.map(o => [o.allocationId, o.clientName])),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState<string | null>(null)
  // A payment in an open or accepted cash handover cannot be corrected at all
  // (20270415000000); the database refuses the save, this only says so first.
  const cashLock = usePaymentCashLock(supabase, r.id)

  // Every row on this page is approved_unlinked or approved_linked (see the
  // page-level query), so this is always true here — order_number for those
  // states was never this form's to write (20260691000000 gave it to the
  // guarded RPCs), and with linking retired nothing writes it at all.
  const isLinkageStatus = r.status === 'approved_unlinked' || r.status === 'approved_linked'

  const set = (key: keyof typeof form) => (
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(prev => ({ ...prev, [key]: e.target.value }))
  )

  // The old orders whose client was changed, and whether anything about the
  // PAYMENT itself was. A client-only change never writes the payment row, so a
  // payment locked by a cash handover (20270415000000) can still have one corrected.
  const legacyChanges = legacyOrders
    .map(o => ({ ...o, next: normalizeLegacyClientName(legacyClients[o.allocationId]) }))
    .filter(o => o.next !== o.clientName)
  const paymentChanged = (Object.keys(initialForm) as (keyof typeof initialForm)[]).some(k => form[k] !== initialForm[k])
  const clientOnly = legacyChanges.length > 0 && !paymentChanged

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

    // The old orders' clients first: each is its own audited correction, safe to
    // repeat, and a refusal stops here with nothing else saved.
    for (const change of legacyChanges) {
      if (change.next === '') { setSaving(false); setError(`Enter the client for old order ${change.orderNo}.`); return }
      const { error: rpcError } = await supabase.rpc('correct_legacy_order_client', {
        p_allocation_id: change.allocationId,
        p_client_name: change.next,
      })
      if (rpcError) {
        setSaving(false)
        setError(`Old order ${change.orderNo}: ${friendlyDbErrorMessage(rpcError).replace(/^[A-Z][A-Z_]{3,}:\s*/, '')}`)
        return
      }
    }
    // Nothing but a client changed: the payment row is not written at all.
    if (clientOnly) { setSaving(false); onSaved(); return }

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
        // received_in IS NOT IN THIS PAYLOAD EITHER. Payment mode already names
        // the account the money came into (HDFC PRI, HDFC SEC, PNB, Paytm,
        // Canara), so asking twice only invited the two to disagree. The column
        // is nullable and nothing reads it as a rule, so the stored value is
        // left exactly as it was.
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
      banner={cashLock ? <PaymentCashLockNotice lock={cashLock} /> : undefined}
      actions={
        <>
          <button onClick={onClose} disabled={saving} className="boe-btn boe-btn-ghost" style={{ padding: '7px 16px', fontSize: '13px' }}>Cancel</button>
          <button onClick={reviewAndSave} disabled={saving || (!!cashLock && !clientOnly)}
            className="boe-btn boe-btn-primary" style={{ padding: '7px 16px', fontSize: '13px' }}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </>
      }
    >
      <div ref={formRef} style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        <section aria-label="Customer" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={LABEL_STYLE}>Customer</div>
          <div style={{
            padding: '10px 12px', borderRadius: '8px', background: colors.raised,
            border: `1px solid ${colors.border}`, fontSize: '15px', fontWeight: 600, color: colors.primary,
          }}>
            {customerDisplayName(r.client_name)}
          </div>
          <span style={HELP_STYLE}>
            Read from the records this payment is allocated to. Allocate or
            reverse an allocation to change it.
          </span>
        </section>

        {legacyOrders.length > 0 && (
          <section aria-label="Old orders" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <h3 style={SECTION_STYLE}>Old orders</h3>
            {legacyOrders.map(o => (
              <QuietField key={o.allocationId} label={`${LEGACY_ORDER_WORD} ${o.orderNo} · client`}>
                <input
                  className="boe-input"
                  value={legacyClients[o.allocationId] ?? ''}
                  maxLength={LEGACY_CLIENT_NAME_MAX}
                  onChange={e => setLegacyClients(prev => ({ ...prev, [o.allocationId]: e.target.value }))}
                  disabled={saving}
                  placeholder="Client the old order belongs to"
                  style={{ width: '100%' }}
                />
              </QuietField>
            ))}
            <span style={HELP_STYLE}>
              The client typed with each old order. A change is saved on its own and
              recorded in this payment&apos;s history{cashLock ? '; it is allowed even while the payment is locked' : ''}.
            </span>
          </section>
        )}

        <section aria-label="Payment" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <h3 style={SECTION_STYLE}>Payment</h3>
          {/* A HISTORICAL ROW KEEPS ITS OWN VALUE AS AN OPTION, so correcting
              some other field on a 2026 payment does not silently move it onto
              one of the five. The picker draws paymentModeOptionsFor, which adds
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
            quiet
          />
        </section>

        <OptionalDisclosure
          title="Add proof or notes"
          hint={(form.proofNote.trim() || form.salesNote.trim()) ? 'Added' : 'Optional'}
          open={proofOpen}
          onToggle={() => setProofOpen(o => !o)}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <QuietField label="Payment proof or reference note">
              <textarea className="boe-input" value={form.proofNote} onChange={set('proofNote')}
                placeholder="e.g. UTR 123456789, cheque no. 001234, or cash received at office"
                rows={2} style={{ width: '100%', resize: 'vertical' }} />
            </QuietField>
            <QuietField label="Sales note">
              <textarea className="boe-input" value={form.salesNote} onChange={set('salesNote')}
                placeholder="Any additional context"
                rows={2} style={{ width: '100%', resize: 'vertical' }} />
            </QuietField>
          </div>
        </OptionalDisclosure>

        {isLinkageStatus ? (
          <div style={HELP_STYLE}>
            Funds are attached with Allocate Funds, not here.
          </div>
        ) : (
          <QuietField label="Order number">
            <input className="boe-input" value={form.orderNumber} onChange={set('orderNumber')}
              placeholder="Order number" style={{ width: '100%' }} />
          </QuietField>
        )}

        {error && <ErrorBanner message={error} />}
      </div>
    </FormDialog>
  )
}
