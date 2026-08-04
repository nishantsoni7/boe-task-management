'use client'

import { useState } from 'react'
import { colors } from '@/lib/tokens'
import { PayrollModal, PayrollField, PayrollModalActions, PayrollModalError } from '@/components/payroll/PayrollModal'
import { MONTHS } from '@/lib/payroll/months'

// The Create Payroll Period form, moved off the dashboard and into a dialog.
//
// It was a permanently-mounted panel taking the top fifth of the page for a
// two-select form that is used once a month. The month/year selection, the
// duplicate handling and the creation call are unchanged — only where the form
// lives changed.

export type CreatePeriodModalProps = {
  saving: boolean
  /** Server-side failure. A failed create keeps the dialog open with the selection intact. */
  error: string | null
  /**
   * The duplicate-period notice. Not an error: an existing Draft/Generated
   * period is reused, and the caller highlights it in the list behind.
   */
  info: string | null
  onClose: () => void
  onCreate: (month: number, year: number) => void
}

export function CreatePeriodModal({ saving, error, info, onClose, onCreate }: CreatePeriodModalProps) {
  const now = new Date()
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [year,  setYear]  = useState(now.getFullYear())

  const selectStyle: React.CSSProperties = {
    fontSize: 13, border: `1px solid ${colors.border}`, borderRadius: 7,
    background: colors.base, color: colors.primary, outline: 'none',
    padding: '8px 10px', boxSizing: 'border-box', width: '100%', cursor: 'pointer',
  }

  return (
    <PayrollModal
      title="Create Payroll Period"
      subtitle="Payroll is generated one calendar month at a time."
      onClose={onClose}
      width={460}
    >
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 180px', minWidth: 0 }}>
          <PayrollField label="Month">
            <select value={month} onChange={e => setMonth(Number(e.target.value))} style={selectStyle}>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </PayrollField>
        </div>
        <div style={{ flex: '1 1 110px', minWidth: 0 }}>
          <PayrollField label="Year">
            <select value={year} onChange={e => setYear(Number(e.target.value))} style={selectStyle}>
              {Array.from({ length: 5 }, (_, i) => now.getFullYear() - 2 + i).map(y => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </PayrollField>
        </div>
      </div>

      {info && (
        <div style={{
          padding: '10px 12px', borderRadius: 8,
          background: 'rgba(232,160,48,0.10)', color: '#92400E',
          border: '1px solid rgba(232,160,48,0.28)', fontSize: 12,
        }}>
          {info}
        </div>
      )}

      {error && <PayrollModalError message={error} />}

      <PayrollModalActions
        onClose={onClose}
        onSave={() => onCreate(month, year)}
        saving={saving}
        saveLabel="Create Payroll Period"
      />
    </PayrollModal>
  )
}
