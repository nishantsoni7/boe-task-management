'use client'

// "Adjust credits" — an administrator's correction to one employee's balance.
//
// A signed whole number of credits (positive adds, negative removes) and a
// mandatory reason. On save it POSTs one admin_adjustment row; nothing here
// edits or deletes an existing entry, because the ledger is append-only and a
// correction is a counter-entry with a reason attached.
//
// Validated with the SAME functions the route uses (creditAmountIssue,
// creditReasonIssue), so the form cannot accept something the server will
// reject, or refuse something it would allow.

import { useState } from 'react'
import {
  PayrollModal, PayrollField, PayrollModalActions, PayrollModalError,
} from '@/components/payroll/PayrollModal'
import { colors } from '@/lib/tokens'
import { creditAmountIssue, creditReasonIssue, formatCredits } from '@/lib/boeCredits/ledger'

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 8, fontSize: 13.5,
  border: `1px solid ${colors.borderSoft}`, background: colors.base, color: colors.primary,
  fontFamily: 'inherit', boxSizing: 'border-box',
}

export function AdjustCreditsModal({
  employeeName, availableCredits, onClose, onSubmit,
}: {
  employeeName: string
  availableCredits: number
  onClose: () => void
  /** Resolves to null on success, or the error to show. Success closes the dialog. */
  onSubmit: (input: { credits: number; reason: string }) => Promise<string | null>
}) {
  const [credits, setCredits] = useState('')
  const [reason,  setReason]  = useState('')
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState('')

  const amountIssue = credits.trim() === '' ? null : creditAmountIssue(credits)
  const parsed = Number(credits.trim())
  const after  = amountIssue == null && credits.trim() !== '' ? availableCredits + parsed : null

  const save = async () => {
    setError('')
    const a = creditAmountIssue(credits)
    if (a) { setError(a); return }
    const r = creditReasonIssue(reason)
    if (r) { setError(r); return }

    setSaving(true)
    const failure = await onSubmit({ credits: Number(credits.trim()), reason: reason.trim() })
    setSaving(false)
    if (failure) { setError(failure); return }
    onClose()
  }

  return (
    <PayrollModal
      title="Adjust credits"
      subtitle={`${employeeName} · ${formatCredits(availableCredits)} available`}
      onClose={onClose}
      width={460}
    >
      {error && <PayrollModalError message={error} />}

      <PayrollField
        label="Credits"
        hint="Positive adds credits, negative removes them. Whole numbers only."
      >
        <input
          type="number"
          step={1}
          inputMode="numeric"
          value={credits}
          onChange={e => { setCredits(e.target.value); setError('') }}
          placeholder="e.g. 50 or -25"
          style={inputStyle}
          autoFocus
        />
        {amountIssue && <div style={{ fontSize: 11.5, color: '#C13030' }}>{amountIssue}</div>}
        {after != null && (
          <div style={{ fontSize: 11.5, color: colors.tertiary }}>
            After this entry: {formatCredits(after)}
          </div>
        )}
      </PayrollField>

      <PayrollField label="Reason" hint="Required. Recorded on the entry, permanently.">
        <textarea
          value={reason}
          onChange={e => { setReason(e.target.value); setError('') }}
          rows={3}
          maxLength={500}
          placeholder="Why this correction is being made"
          style={{ ...inputStyle, resize: 'vertical', minHeight: 72 }}
        />
      </PayrollField>

      <PayrollModalActions
        onClose={onClose}
        onSave={save}
        saving={saving}
        saveLabel="Record adjustment"
        disabled={credits.trim() === '' || reason.trim() === ''}
      />
    </PayrollModal>
  )
}
