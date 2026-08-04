'use client'

import { useState } from 'react'
import { colors } from '@/lib/tokens'
import { PayrollModal, PayrollField, PayrollModalActions, PayrollModalError } from '@/components/payroll/PayrollModal'
import { validateUnlockReason } from '@/lib/payroll/unlockRules'

// Confirmation for reopening a finalised payroll month.
//
// The reason field is the point of the dialog, not decoration: it is the only
// thing that will explain the decision in the payroll history afterwards, so it
// is required here and required again on the server. The same
// validateUnlockReason the route uses runs on this side too, so the two cannot
// disagree about what counts as a reason.

export function UnlockPayrollModal({
  periodLabel, saving, error, onCancel, onConfirm,
}: {
  periodLabel: string
  saving: boolean
  error: string | null
  onCancel: () => void
  onConfirm: (reason: string) => void
}) {
  const [reason, setReason] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  const validation = validateUnlockReason(reason)

  const handleConfirm = () => {
    setLocalError(null)
    if (!validation.ok) { setLocalError(validation.error); return }
    onConfirm(validation.value)
  }

  return (
    <PayrollModal
      title={`Unlock ${periodLabel} payroll?`}
      onClose={onCancel}
      width={480}
    >
      <div style={{ fontSize: 13, color: colors.secondary, lineHeight: 1.6 }}>
        Unlocking will allow attendance corrections, payroll regeneration, and
        payroll-result changes for this period.
      </div>

      <PayrollField
        label="Reason for unlocking"
        hint="Kept permanently in the payroll history, with your name and the time."
      >
        <textarea
          value={reason}
          onChange={e => setReason(e.target.value)}
          rows={3}
          placeholder="e.g. Late attendance correction approved for two employees."
          style={{
            fontSize: 13, border: `1px solid ${colors.border}`, borderRadius: 7,
            background: colors.base, color: colors.primary, outline: 'none',
            padding: '8px 10px', boxSizing: 'border-box', width: '100%',
            resize: 'vertical', fontFamily: 'inherit',
          }}
        />
      </PayrollField>

      {(localError || error) && <PayrollModalError message={localError ?? error!} />}

      <PayrollModalActions
        onClose={onCancel}
        onSave={handleConfirm}
        saving={saving}
        saveLabel="Unlock Payroll"
        disabled={!validation.ok}
      />
    </PayrollModal>
  )
}
