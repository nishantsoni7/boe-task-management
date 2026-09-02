'use client'

// "Cover this day with BOE Credits" — the employee's confirmation.
//
// One decision, stated in full before it is made: which day, which deduction,
// how many credits it costs, what that removes from the salary, and what is
// left afterwards. Nothing to type. On confirm it POSTs once; the server runs
// the payroll engine again and decides for itself whether the day qualifies,
// so nothing shown here is trusted by the route — it is the offer the route
// made, echoed back.
//
// Built on PayrollModal so it inherits the BOE Form Modal Dismissal Rule: a
// failed request keeps the dialog open with the message; success closes it.

import { useState } from 'react'
import { PayrollModal, PayrollModalActions, PayrollModalError } from '@/components/payroll/PayrollModal'
import { colors } from '@/lib/tokens'
import { formatRupees } from '@/lib/payroll/money'
import {
  REDEEMABLE_DEDUCTION_LABELS,
  creditsWord,
  type RedeemableDate,
} from '@/lib/boeCredits/attendanceRedemption'

function Row({ label, value, tone, strong }: { label: string; value: string; tone?: string; strong?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, padding: '5px 0' }}>
      <span style={{ fontSize: 12.5, color: strong ? '#3D4455' : colors.tertiary, fontWeight: strong ? 600 : 400 }}>{label}</span>
      <span style={{
        fontSize: strong ? 14 : 13.5, fontWeight: strong ? 700 : 600,
        color: tone ?? colors.primary, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
      }}>
        {value}
      </span>
    </div>
  )
}

export function RedeemCreditsModal({
  offer, dateLabel, availableCredits, onClose, onConfirm,
}: {
  offer: RedeemableDate
  /** "12 August, Wed" — formatted by the page, which owns date presentation. */
  dateLabel: string
  /** Null while the balance is still loading. */
  availableCredits: number | null
  onClose: () => void
  /** Resolves to null on success, or the error to show. Success closes the dialog. */
  onConfirm: () => Promise<string | null>
}) {
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  const enough = availableCredits != null && availableCredits >= offer.credits
  const after  = availableCredits != null ? availableCredits - offer.credits : null

  const confirm = async () => {
    setError('')
    setSaving(true)
    const failure = await onConfirm()
    setSaving(false)
    if (failure) { setError(failure); return }
    onClose()
  }

  return (
    <PayrollModal
      title="Cover this day with BOE Credits"
      subtitle={`${dateLabel} · ${REDEEMABLE_DEDUCTION_LABELS[offer.deduction_type]}`}
      onClose={onClose}
      width={440}
    >
      {error && <PayrollModalError message={error} />}

      <div style={{
        background: colors.raised, border: `1px solid ${colors.border}`,
        borderRadius: 10, padding: '10px 14px',
      }}>
        <Row label="Deduction removed" value={`−${formatRupees(offer.amount)}`} tone="#DC2626" />
        <Row label="Credits used" value={creditsWord(offer.credits)} />
        <div style={{ height: 1, background: colors.borderSoft, margin: '6px 0' }} />
        <Row
          label="Credits after this"
          value={availableCredits == null ? '…' : after == null ? '—' : creditsWord(after)}
          tone={availableCredits != null && !enough ? '#DC2626' : undefined}
          strong
        />
      </div>

      <div style={{ fontSize: 12.5, color: '#3D4455', lineHeight: 1.55 }}>
        {enough
          ? 'The deduction for this day is removed from your salary and the credits are spent. The day still shows as it happened; this cannot be undone from here.'
          : availableCredits == null
            ? 'Checking your credits…'
            : `You need ${creditsWord(offer.credits)} for this day and have ${creditsWord(availableCredits)}.`}
      </div>

      <PayrollModalActions
        onClose={onClose}
        onSave={confirm}
        saving={saving}
        saveLabel={`Use ${creditsWord(offer.credits)}`}
        disabled={!enough}
      />
    </PayrollModal>
  )
}
