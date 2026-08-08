'use client'

// "Why was this deducted?" — one date, answered in place.
//
// A popup rather than a page: the answer is short, and the admin is in the
// middle of reading a ledger. It is read-only and stays available when payroll
// is locked, because explaining a figure is not editing it.
//
// Every number rendered here comes from the payroll engine via
// src/lib/payroll/deductionExplanation.ts. This component formats and lays out;
// it does not calculate. The Edit action lives on its own control in the row and
// is never reachable from inside this dialog.

import { colors } from '@/lib/tokens'
import { PayrollModal } from '@/components/payroll/PayrollModal'
import { istClockOf } from '@/lib/istDate'
import {
  explainDay,
  money,
  COMPANY_PAID_NOTE,
  type ExplainableLine,
} from '@/lib/payroll/deductionExplanation'

export type ExplanationDayContext = {
  date: string
  /** "01 July, Wed" — formatted by the page, which owns date presentation. */
  dateLabel: string
  classification: string
  classificationLabel: string
  check_in_at: string | null
  check_out_at: string | null
  is_corrected: boolean
  correctionRemark?: string | null
  lines: ExplainableLine[]
  /**
   * What the date cost, as the engine settled it.
   *
   * Displayed as-is. The popup deliberately does NOT re-add the lines to get
   * here: that would be a second implementation of the same figure living in a
   * React component, and the day the two disagreed the screen would be the one
   * that was wrong. dayDeductionTotal() still exists and still sums the lines —
   * as a test assertion, which is where a cross-check belongs.
   */
  total_amount: number
}

const SECTION_LABEL: React.CSSProperties = {
  fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.09em', color: '#8C94A6', marginBottom: 4,
}

export function DeductionExplanationModal({
  employeeName, day, onClose,
}: {
  employeeName: string
  day: ExplanationDayContext
  onClose: () => void
}) {
  const explained = explainDay(day.lines)
  const total = day.total_amount

  return (
    <PayrollModal
      title="How this deduction was calculated"
      subtitle={`${employeeName} · ${day.dateLabel}`}
      onClose={onClose}
      width={520}
    >
      {/* ── What happened ──────────────────────────────────────────────────── */}
      <div style={{
        background: colors.raised, border: `1px solid ${colors.border}`,
        borderRadius: 10, padding: '12px 14px',
      }}>
        <div style={SECTION_LABEL}>Attendance</div>
        <div style={{
          fontSize: 15, fontWeight: 600, color: '#111318',
          fontVariantNumeric: 'tabular-nums',
        }}>
          {day.check_in_at ? istClockOf(day.check_in_at) : 'No punch-in'}
          <span style={{ color: '#B0B8C8', fontWeight: 400 }}> → </span>
          {day.check_out_at ? istClockOf(day.check_out_at) : 'No punch-out'}
        </div>
        <div style={{ fontSize: 12.5, color: '#6B7280', marginTop: 3 }}>
          {day.classificationLabel}
          {day.is_corrected && (
            <>
              {' · '}
              <span style={{ color: '#3B63B8', fontWeight: 600 }}>Corrected by an admin</span>
            </>
          )}
        </div>
        {/* The reason on the record, verbatim. A corrected day is only
            explainable if the admin's stated reason travels with it. */}
        {day.is_corrected && day.correctionRemark && (
          <div style={{ fontSize: 12, color: '#6B7280', marginTop: 5, fontStyle: 'italic' }}>
            “{day.correctionRemark}”
          </div>
        )}
      </div>

      {/* ── One block per reason ───────────────────────────────────────────── */}
      {explained.map(item => (
        <div
          key={item.key}
          style={{
            border: `1px solid ${item.companyPaid ? 'rgba(5,150,105,0.3)' : colors.border}`,
            borderRadius: 10, overflow: 'hidden',
            // The dialog is a column flex box that scrolls. Without this, a date
            // with more than one reason makes these cards shrink instead, and
            // `overflow: hidden` then clips the Calculation rows out of reach.
            flexShrink: 0,
          }}
        >
          <div style={{
            display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10,
            padding: '10px 14px', borderBottom: `1px solid ${colors.border}`,
            background: item.companyPaid ? 'rgba(5,150,105,0.05)' : 'transparent',
          }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: '#111318' }}>{item.title}</div>
              {item.companyPaid && (
                <div style={{ fontSize: 11.5, color: '#047857', marginTop: 2 }}>{COMPANY_PAID_NOTE}</div>
              )}
            </div>
            <div style={{
              fontSize: 15, fontWeight: 700, whiteSpace: 'nowrap',
              fontVariantNumeric: 'tabular-nums',
              color: item.amount > 0 ? '#DC2626' : '#047857',
            }}>
              {item.amount > 0 ? `−${money(item.amount)}` : money(0)}
            </div>
          </div>

          <div style={{ padding: '11px 14px 13px' }}>
            <div style={SECTION_LABEL}>Rule</div>
            <div style={{ fontSize: 12.5, color: '#3D4455', lineHeight: 1.55, marginBottom: 11 }}>
              {item.rule}
            </div>

            <div style={SECTION_LABEL}>Calculation</div>
            {item.calculation.map((row, i) => (
              <div
                key={i}
                style={{
                  display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12,
                  padding: '3px 0',
                  ...(row.strong
                    ? { borderTop: `1px solid ${colors.border}`, marginTop: 5, paddingTop: 7 }
                    : null),
                }}
              >
                <span style={{
                  fontSize: 12.5,
                  color: row.strong ? '#3D4455' : '#6B7280',
                  fontWeight: row.strong ? 600 : 400,
                }}>
                  {row.label}
                </span>
                <span style={{
                  fontSize: row.strong ? 13.5 : 12.5,
                  fontWeight: row.strong ? 700 : 500,
                  color: row.strong ? (item.amount > 0 ? '#DC2626' : '#047857') : '#3D4455',
                  fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
                }}>
                  {row.value}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* ── The date's total ───────────────────────────────────────────────── */}
      {/* Shown whenever a date carries more than one reason — the sum is the
          thing the row above the popup displays, and seeing it built from the
          parts is the whole point of grouping by date. */}
      {explained.length > 1 && (
        <div style={{
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12,
          padding: '11px 14px', borderRadius: 10,
          background: 'rgba(0,0,0,0.025)', border: `1px solid ${colors.border}`,
        }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#3D4455' }}>
            Total deduction for this date
          </span>
          <span style={{
            fontSize: 15, fontWeight: 700, color: total > 0 ? '#DC2626' : '#047857',
            fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
          }}>
            {total > 0 ? `−${money(total)}` : money(0)}
          </span>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" className="boe-btn boe-btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </PayrollModal>
  )
}
