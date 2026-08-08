'use client'

// "Raise Issue" — the one form an employee uses to report that their own
// attendance day or payroll result looks wrong.
//
// Shared by /my-attendance and /my-payroll because the two are the same act:
// name the thing, say what looks wrong, submit. The only difference is the
// read-only summary at the top, which the caller supplies.
//
// There is nothing editable here but the reason. An employee reports; an admin
// corrects. Built on PayrollModal so it inherits the BOE Form Modal Dismissal
// Rule rather than restating it.

import { useState } from 'react'
import { PayrollModal, PayrollModalActions, PayrollModalError } from '@/components/payroll/PayrollModal'
import { colors } from '@/lib/tokens'
import { REASON_MAX_LENGTH } from '@/lib/objections'

export type RaiseIssueSubject = {
  /** "20 July, Mon" or "July 2026" — what the employee is objecting to. */
  title: string
  /**
   * The figures or punches as they stand. Read-only, never editable.
   *
   * Empty when the record has not been chosen yet — the dedicated issues page
   * opens this modal with nothing selected, so there is nothing yet to quote.
   */
  summary: string
}

export function RaiseIssueModal({
  subject, targetPicker, targetChosen = true, onClose, onSubmit,
}: {
  subject: RaiseIssueSubject
  /**
   * Controls for choosing WHICH record this is about.
   *
   * Present only on the dedicated issues page, which is reached without a
   * record already in hand. /my-attendance and /my-payroll open this modal from
   * a row, so the target is already settled and this stays undefined — the form
   * an employee sees there is unchanged.
   */
  targetPicker?: React.ReactNode
  /** False while the picker has no selection; blocks submit without hiding it. */
  targetChosen?: boolean
  onClose: () => void
  /** Resolves to an error message, or null when the issue was filed. */
  onSubmit: (reason: string) => Promise<string | null>
}) {
  const [reason, setReason]   = useState('')
  const [saving, setSaving]   = useState(false)
  const [error,  setError]    = useState<string | null>(null)

  const trimmed = reason.trim()

  const submit = async () => {
    if (!trimmed || !targetChosen || saving) return
    setSaving(true)
    setError(null)
    const message = await onSubmit(trimmed)
    if (message) { setError(message); setSaving(false); return }
    onClose()
  }

  return (
    <PayrollModal
      title="Raise an issue"
      subtitle={subject.title}
      onClose={onClose}
      width={460}
    >
      {error && <PayrollModalError message={error} />}

      {targetPicker}

      {/* What they are objecting to, exactly as the screen shows it. Hidden
          until a record is chosen — an empty "As recorded" box states nothing. */}
      {subject.summary && (
        <div style={{
          background: colors.raised, border: `1px solid ${colors.border}`,
          borderRadius: 10, padding: '11px 14px', flexShrink: 0,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 600, color: colors.muted,
            textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4,
          }}>
            As recorded
          </div>
          <div style={{ fontSize: 13, color: '#111318', lineHeight: 1.5 }}>
            {subject.summary}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, flexShrink: 0 }}>
        <label htmlFor="objection-reason" style={{
          fontSize: 11, fontWeight: 600, color: colors.muted,
          textTransform: 'uppercase', letterSpacing: '0.05em',
        }}>
          What looks wrong? <span style={{ color: '#DC2626' }}>*</span>
        </label>
        <textarea
          id="objection-reason"
          value={reason}
          onChange={e => setReason(e.target.value)}
          maxLength={REASON_MAX_LENGTH}
          rows={4}
          autoFocus
          placeholder="For example: I was present but the machine did not record my punch-out."
          className="boe-input"
          style={{ resize: 'vertical', fontSize: 13, lineHeight: 1.5, padding: '9px 11px' }}
        />
        <div style={{ fontSize: 11, color: colors.muted }}>
          An admin will review this. Your attendance and salary are not changed by
          raising an issue. {REASON_MAX_LENGTH - reason.length} characters left.
        </div>
      </div>

      <PayrollModalActions
        onClose={onClose}
        onSave={submit}
        saving={saving}
        saveLabel="Submit issue"
        disabled={!trimmed || !targetChosen}
      />
    </PayrollModal>
  )
}
