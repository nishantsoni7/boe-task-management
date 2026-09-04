'use client'

import { useState } from 'react'
import Link from 'next/link'
import { colors } from '@/lib/tokens'
import { PayrollModal, PayrollField, PayrollModalActions, PayrollModalError } from '@/components/payroll/PayrollModal'

// The Create Payroll Period form, moved off the dashboard and into a dialog.
//
// A payroll period may only be created for a month that has already happened
// AND that attendance has already been uploaded for — enforced server-side by
// checkPeriodCreateEligibility() in src/app/api/payroll/periods/route.ts. This
// modal reads GET /api/payroll/periods/eligible-months and offers ONLY the
// months that check would actually accept, so the admin never picks a
// combination the server is going to refuse. When the CURRENT month is the one
// held back, that is stated explicitly rather than the month simply not
// appearing — see currentMonthUnavailable.

export type EligibleMonth = { year: number; month: number; label: string }

export type CreatePeriodModalProps = {
  saving: boolean
  /** Server-side failure. A failed create keeps the dialog open with the selection intact. */
  error: string | null
  /**
   * The duplicate-period notice. Not an error: an existing Draft/Generated
   * period is reused, and the caller highlights it in the list behind.
   */
  info: string | null
  /** Months attendance already exists for and that have no period yet, newest first. */
  eligibleMonths: EligibleMonth[]
  /** Set only when the current calendar month specifically has no attendance yet. */
  currentMonthUnavailable: EligibleMonth | null
  /** True while GET /api/payroll/periods/eligible-months is still loading. */
  loadingEligibility: boolean
  onClose: () => void
  onCreate: (month: number, year: number) => void
}

function monthKey(m: { year: number; month: number }): string {
  return `${m.year}-${m.month}`
}

export function CreatePeriodModal({
  saving, error, info, eligibleMonths, currentMonthUnavailable, loadingEligibility, onClose, onCreate,
}: CreatePeriodModalProps) {
  const [selected, setSelected] = useState(eligibleMonths[0] ? monthKey(eligibleMonths[0]) : '')

  const selectStyle: React.CSSProperties = {
    fontSize: 13, border: `1px solid ${colors.border}`, borderRadius: 7,
    background: colors.base, color: colors.primary, outline: 'none',
    padding: '8px 10px', boxSizing: 'border-box', width: '100%', cursor: 'pointer',
  }

  const chosen = eligibleMonths.find(m => monthKey(m) === selected) ?? eligibleMonths[0] ?? null

  return (
    <PayrollModal
      title="Create Payroll Period"
      subtitle="Payroll is generated one calendar month at a time."
      onClose={onClose}
      width={460}
    >
      {/* The current month specifically, named — not simply absent from the list below. */}
      {currentMonthUnavailable && (
        <div style={{
          padding: '11px 13px', borderRadius: 8,
          background: 'rgba(85,133,232,0.08)', color: '#1F3A8A',
          border: '1px solid rgba(85,133,232,0.25)', fontSize: 12.5, lineHeight: 1.5,
        }}>
          <strong>{currentMonthUnavailable.label} payroll is not available yet.</strong>
          <div style={{ marginTop: 3 }}>
            Attendance for {currentMonthUnavailable.label} has not been uploaded.
          </div>
          <Link
            href="/attendance/upload"
            style={{
              display: 'inline-block', marginTop: 8, fontSize: 12.5, fontWeight: 600,
              color: '#3B63B8', textDecoration: 'none',
            }}
          >
            Upload Attendance →
          </Link>
        </div>
      )}

      {loadingEligibility ? (
        <div style={{ fontSize: 13, color: colors.tertiary, padding: '6px 0' }}>Checking available months…</div>
      ) : eligibleMonths.length === 0 ? (
        !currentMonthUnavailable && (
          <div style={{ fontSize: 13, color: colors.tertiary, padding: '6px 0' }}>
            No month is currently available to create payroll for — every recent month with uploaded
            attendance already has a payroll period.
          </div>
        )
      ) : (
        <PayrollField label="Payroll Month">
          <select value={selected || monthKey(eligibleMonths[0])} onChange={e => setSelected(e.target.value)} style={selectStyle}>
            {eligibleMonths.map(m => (
              <option key={monthKey(m)} value={monthKey(m)}>{m.label}</option>
            ))}
          </select>
        </PayrollField>
      )}

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
        onSave={() => chosen && onCreate(chosen.month, chosen.year)}
        saving={saving || !chosen}
        saveLabel="Create Payroll Period"
      />
    </PayrollModal>
  )
}
