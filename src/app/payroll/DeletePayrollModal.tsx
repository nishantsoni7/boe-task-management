'use client'

// Permanent deletion of one payroll month, confirmed.
//
// The dialog's job is to make sure the admin who clicks Delete has understood
// three things that a two-line confirm() cannot convey: WHICH payroll this is,
// what stops existing, and what survives. The last one matters most — the reason
// an admin hesitates over deleting a bad payroll is the fear that attendance or
// salary configuration goes with it, and it does not.
//
// Nothing here decides anything. Whether the period may be deleted at all comes
// from the server as a resolved permission (src/lib/payroll/deletionRules.ts),
// so a blocked period opens this dialog showing the refusal and its remedy
// rather than a Delete button that would 422.

import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { PayrollModal, PayrollField, PayrollModalError } from '@/components/payroll/PayrollModal'
import { shouldCloseFormModal } from '@/lib/ui/modalDismissal'
import {
  payrollDeletionConfirmationMatches,
  validateDeletionReason,
  type PayrollDeletionFacts,
  type PayrollDeletionPermission,
} from '@/lib/payroll/deletionRules'

export type DeletePayrollPreview = {
  payroll_period_id: string
  payroll_month: number
  payroll_year: number
  period_label: string
  status: 'draft' | 'generated' | 'locked'
  facts: PayrollDeletionFacts
  permission: PayrollDeletionPermission
  scope: { removed: string[]; kept: string[] }
  confirmation_text: string
}

const STATUS_WORD: Record<DeletePayrollPreview['status'], string> = {
  draft:     'Draft',
  generated: 'Generated',
  locked:    'Locked',
}

export function DeletePayrollModal({
  preview, loading, deleting, error, onCancel, onConfirm,
}: {
  /** Null while the preview is still being fetched. */
  preview: DeletePayrollPreview | null
  loading: boolean
  deleting: boolean
  error: string | null
  onCancel: () => void
  onConfirm: (args: { reason: string; confirmation: string }) => void
}) {
  const [confirmation, setConfirmation] = useState('')
  const [reason, setReason]             = useState('')
  const [localError, setLocalError]     = useState<string | null>(null)

  // Nothing resets this state on a period change, because nothing has to: the
  // caller keys this component on the period id, so opening the dialog for a
  // different month mounts a fresh one. A typed "July 2026" can therefore never
  // survive into a confirmation for August.

  const title = preview
    ? `Delete ${preview.period_label} payroll?`
    : 'Delete payroll?'

  if (loading || !preview) {
    return (
      <PayrollModal title={title} onClose={onCancel} width={520}>
        <div style={{ fontSize: 13, color: colors.secondary }}>
          {error ?? 'Checking what this payroll contains…'}
        </div>
        {error && (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button onClick={onCancel} className="boe-btn boe-btn-ghost" style={{ padding: '8px 18px', fontSize: 13 }}>
              Close
            </button>
          </div>
        )}
      </PayrollModal>
    )
  }

  const { permission, facts, scope } = preview

  // ── Blocked ────────────────────────────────────────────────────────────────
  // No confirmation field, no Delete button. An admin who cannot delete this
  // period is told why and what would have to change, and that is the whole
  // dialog — offering a disabled Delete underneath would only invite clicks.
  if (!permission.allowed) {
    return (
      <PayrollModal
        title={title}
        subtitle={`${STATUS_WORD[preview.status]} · ${facts.resultCount} employee result${facts.resultCount === 1 ? '' : 's'}`}
        onClose={onCancel}
        width={520}
      >
        <div role="alert" style={{
          display: 'flex', gap: 10, padding: '11px 12px', borderRadius: 8,
          background: 'rgba(217,79,79,0.09)', border: '1px solid rgba(192,57,43,0.25)',
        }}>
          <AlertTriangle size={16} strokeWidth={2.2} color="#C0392B" style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
          <div style={{ fontSize: 12.5, color: colors.secondary, lineHeight: 1.55 }}>
            <div style={{ fontWeight: 600, color: '#C0392B' }}>This payroll cannot be deleted</div>
            <div style={{ marginTop: 3 }}>{permission.message}</div>
            {permission.resolution && (
              <div style={{ marginTop: 6, color: colors.tertiary }}>{permission.resolution}</div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onCancel} className="boe-btn boe-btn-ghost" style={{ padding: '8px 18px', fontSize: 13 }}>
            Close
          </button>
        </div>
      </PayrollModal>
    )
  }

  // ── Deletable ──────────────────────────────────────────────────────────────
  const reasonCheck  = validateDeletionReason(reason)
  const typedMatches = payrollDeletionConfirmationMatches(
    confirmation, preview.payroll_month, preview.payroll_year,
  )
  // `deleting` is what blocks a second submission, so a double click cannot fire
  // two deletions for the same period.
  const canSubmit = typedMatches && reasonCheck.ok && !deleting

  const handleConfirm = () => {
    if (deleting) return
    setLocalError(null)
    if (!reasonCheck.ok) { setLocalError(reasonCheck.error); return }
    if (!typedMatches) {
      setLocalError(`Type ${preview.confirmation_text} exactly to confirm.`)
      return
    }
    onConfirm({ reason: reasonCheck.value, confirmation })
  }

  return (
    <PayrollModal
      title={title}
      subtitle={`${STATUS_WORD[preview.status]} · ${facts.resultCount} employee result${facts.resultCount === 1 ? '' : 's'}`}
      onClose={onCancel}
      width={560}
    >
      <div role="alert" style={{
        display: 'flex', gap: 10, padding: '11px 12px', borderRadius: 8,
        background: 'rgba(217,79,79,0.09)', border: '1px solid rgba(192,57,43,0.25)',
      }}>
        <AlertTriangle size={16} strokeWidth={2.2} color="#C0392B" style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
        <div style={{ fontSize: 12.5, color: colors.secondary, lineHeight: 1.55 }}>
          <div style={{ fontWeight: 600, color: '#C0392B' }}>This cannot be undone</div>
          <div style={{ marginTop: 3 }}>
            {permission.removesEmployeeVisibleSalary
              ? `The generated salary records for ${preview.period_label} will permanently disappear from every affected employee’s account. Employees who have already seen this payslip will no longer find it.`
              : `This payroll has never produced employee results, so nothing an employee can see today will change.`}
          </div>
        </div>
      </div>

      <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '5px 14px', margin: 0, fontSize: 12 }}>
        <dt style={{ color: colors.muted }}>Payroll month</dt>
        <dd style={{ margin: 0, color: colors.primary, fontWeight: 600 }}>{preview.period_label}</dd>
        <dt style={{ color: colors.muted }}>State</dt>
        <dd style={{ margin: 0, color: colors.primary }}>{STATUS_WORD[preview.status]}</dd>
        <dt style={{ color: colors.muted }}>Employee results</dt>
        <dd style={{ margin: 0, color: colors.primary }}>{facts.resultCount}</dd>
        <dt style={{ color: colors.muted }}>Payments recorded</dt>
        <dd style={{ margin: 0, color: colors.primary }}>
          {facts.paidSettlementCount > 0 ? `${facts.paidSettlementCount}` : 'None'}
        </dd>
        <dt style={{ color: colors.muted }}>Settlement records</dt>
        <dd style={{ margin: 0, color: colors.primary }}>
          {facts.settlementCount > 0 ? `${facts.settlementCount} (unpaid)` : 'None'}
        </dd>
      </dl>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <ScopeList
          heading="Will be deleted"
          tone="#C0392B"
          items={scope.removed}
        />
        <ScopeList
          heading="Will NOT be touched"
          tone="#1F7A4D"
          items={scope.kept}
        />
      </div>

      <PayrollField
        label="Reason for deleting"
        hint="Required. Kept permanently in the deletion audit, with your name and the time. No salary figures are kept."
      >
        <textarea
          value={reason}
          onChange={e => setReason(e.target.value)}
          rows={2}
          placeholder="e.g. Test payroll created while configuring the module; not a real salary month."
          style={{
            fontSize: 13, border: `1px solid ${colors.border}`, borderRadius: 7,
            background: colors.base, color: colors.primary, outline: 'none',
            padding: '8px 10px', boxSizing: 'border-box', width: '100%',
            resize: 'vertical', fontFamily: 'inherit',
          }}
        />
      </PayrollField>

      <PayrollField
        label={`Type “${preview.confirmation_text}” to confirm`}
        hint="The Delete button stays disabled until this matches exactly."
      >
        <input
          value={confirmation}
          onChange={e => setConfirmation(e.target.value)}
          placeholder={preview.confirmation_text}
          aria-label={`Type ${preview.confirmation_text} to confirm deletion`}
          autoComplete="off"
          style={{
            fontSize: 13, border: `1px solid ${typedMatches ? 'rgba(31,122,77,0.5)' : colors.border}`,
            borderRadius: 7, background: colors.base, color: colors.primary, outline: 'none',
            padding: '8px 10px', boxSizing: 'border-box', width: '100%',
          }}
        />
      </PayrollField>

      {(localError || error) && <PayrollModalError message={localError ?? error!} />}

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 4, flexWrap: 'wrap' }}>
        <button
          onClick={() => { if (shouldCloseFormModal('cancel')) onCancel() }}
          className="boe-btn boe-btn-ghost"
          style={{ padding: '8px 18px', fontSize: 13 }}
        >
          Cancel
        </button>
        <button
          onClick={handleConfirm}
          disabled={!canSubmit}
          aria-busy={deleting || undefined}
          className="boe-btn"
          style={{
            padding: '8px 18px', fontSize: 13, fontWeight: 600,
            background: '#C0392B', color: '#fff', border: '1px solid #C0392B',
            opacity: canSubmit ? 1 : 0.5,
            cursor: canSubmit ? 'pointer' : 'not-allowed',
          }}
        >
          {deleting ? 'Deleting…' : 'Delete Payroll'}
        </button>
      </div>
    </PayrollModal>
  )
}

function ScopeList({ heading, tone, items }: { heading: string; tone: string; items: string[] }) {
  return (
    <div>
      <div style={{
        fontSize: 11, fontWeight: 700, color: tone,
        textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5,
      }}>
        {heading}
      </div>
      <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: colors.secondary, lineHeight: 1.6 }}>
        {items.map(item => <li key={item}>{item}</li>)}
      </ul>
    </div>
  )
}
