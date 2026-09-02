'use client'

// "Credit settings" — the two numbers, editable by an admin.
//
//   Review reward   credits ONE verified review earns (read by Phase 1B)
//   Credit value    rupees ONE credit is worth (read by Payroll, Phase 1D)
//
// Saving writes a NEW settings row; the previous ones stay as history. The
// form validates with parseBoeCreditSettings, the same function the API uses.

import { useState } from 'react'
import {
  PayrollModal, PayrollField, PayrollModalActions, PayrollModalError,
} from '@/components/payroll/PayrollModal'
import { colors } from '@/lib/tokens'
import { parseBoeCreditSettings } from '@/lib/boeCredits/settings'
import type { BoeCreditSettings } from '@/lib/boeCredits/types'

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 8, fontSize: 13.5,
  border: `1px solid ${colors.borderSoft}`, background: colors.base, color: colors.primary,
  fontFamily: 'inherit', boxSizing: 'border-box',
}

export function CreditSettingsModal({
  current, onClose, onSubmit,
}: {
  current: BoeCreditSettings
  onClose: () => void
  /** Resolves to null on success, or the error to show. Success closes the dialog. */
  onSubmit: (input: { settings: BoeCreditSettings; note: string | null }) => Promise<string | null>
}) {
  const [reward, setReward] = useState(String(current.review_reward_credits))
  const [value,  setValue]  = useState(current.credit_value.toFixed(2))
  const [note,   setNote]   = useState('')
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  const parsed = parseBoeCreditSettings({ review_reward_credits: reward, credit_value: value })
  const issueFor = (key: keyof BoeCreditSettings) =>
    parsed.ok ? null : parsed.issues.find(i => i.key === key)?.message ?? null

  const dirty =
    parsed.ok &&
    (parsed.settings.review_reward_credits !== current.review_reward_credits ||
      parsed.settings.credit_value !== current.credit_value)

  const save = async () => {
    setError('')
    if (!parsed.ok) { setError('Some values are not valid. Check the highlighted fields.'); return }
    setSaving(true)
    const failure = await onSubmit({ settings: parsed.settings, note: note.trim() || null })
    setSaving(false)
    if (failure) { setError(failure); return }
    onClose()
  }

  return (
    <PayrollModal
      title="Credit settings"
      subtitle="Two separate numbers. Changing one does not change the other."
      onClose={onClose}
      width={460}
    >
      {error && <PayrollModalError message={error} />}

      <PayrollField label="Review reward" hint="Credits one verified review earns.">
        <input
          type="number" step={1} inputMode="numeric" min={1}
          value={reward}
          onChange={e => { setReward(e.target.value); setError('') }}
          style={inputStyle}
        />
        {issueFor('review_reward_credits') && (
          <div style={{ fontSize: 11.5, color: '#C13030' }}>{issueFor('review_reward_credits')}</div>
        )}
      </PayrollField>

      <PayrollField label="Credit value (₹ per credit)" hint="Used by Payroll when credits are redeemed. Not shown to employees.">
        <input
          type="number" step="0.01" inputMode="decimal" min={0}
          value={value}
          onChange={e => { setValue(e.target.value); setError('') }}
          style={inputStyle}
        />
        {issueFor('credit_value') && (
          <div style={{ fontSize: 11.5, color: '#C13030' }}>{issueFor('credit_value')}</div>
        )}
      </PayrollField>

      <PayrollField label="Note" hint="Optional. Why the setting changed.">
        <input
          type="text" maxLength={500}
          value={note}
          onChange={e => setNote(e.target.value)}
          style={inputStyle}
        />
      </PayrollField>

      <PayrollModalActions
        onClose={onClose}
        onSave={save}
        saving={saving}
        saveLabel="Save settings"
        disabled={!dirty}
      />
    </PayrollModal>
  )
}
