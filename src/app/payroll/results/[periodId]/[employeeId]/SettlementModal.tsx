'use client'

// Recording the two settlement facts payroll cannot work out for itself: what
// was owed from last month, and what was actually paid this month.
//
// SIGNED AMOUNTS WITHOUT A MINUS KEY
// ----------------------------------
// The carry-forward is a signed figure, and asking an admin to type "-1500"
// makes the direction depend on remembering a character. A transposed sign here
// turns "the employee is owed ₹1,500" into "the employee owes ₹1,500" — the
// error is silent, it compounds into next month's opening balance, and nothing
// downstream can detect it.
//
// So the direction is a choice with words on it, the amount is always entered as
// a positive number, and the two are combined into a signed value on submit. The
// dialog also states, in a sentence, what the chosen combination means before it
// is saved.

import { useState } from 'react'
import { colors } from '@/lib/tokens'
import {
  PayrollModal,
  PayrollField,
  PayrollModalActions,
  PayrollModalError,
} from '@/components/payroll/PayrollModal'
import { fmtMoney } from '@/lib/payroll/settlement'

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 11px', borderRadius: 8,
  border: `1px solid ${colors.border}`, fontSize: 13,
  background: '#fff', color: colors.primary,
}

// ─── Carry forward ────────────────────────────────────────────────────────────

export type CarryForwardSubmit = {
  amount?: number
  remark?: string
  reset?: boolean
}

export function CarryForwardModal({
  employeeName, currentAmount, proposedAmount, isManual, currentRemark,
  saving, error, onSubmit, onClose,
}: {
  employeeName: string
  currentAmount: number
  proposedAmount: number
  isManual: boolean
  currentRemark: string | null
  saving: boolean
  error: string | null
  onSubmit: (payload: CarryForwardSubmit) => void
  onClose: () => void
}) {
  // Seeded from the CURRENT value, split into its two parts.
  const [direction, setDirection] = useState<'owed' | 'advance'>(currentAmount < 0 ? 'advance' : 'owed')
  const [amount,    setAmount]    = useState(String(Math.abs(currentAmount) || ''))
  const [remark,    setRemark]    = useState(currentRemark ?? '')

  const magnitude = Number(amount)
  const valid     = amount.trim() !== '' && Number.isFinite(magnitude) && magnitude >= 0 && remark.trim() !== ''
  const signed    = direction === 'advance' ? -magnitude : magnitude

  return (
    <PayrollModal
      title="Previous Balance"
      subtitle={`Anything left unsettled from ${employeeName}'s previous payroll month.`}
      onClose={onClose}
      width={520}
    >
      {error && <PayrollModalError message={error} />}

      {/* What the system worked out, always visible — an override should be a
          decision taken against the proposal, not instead of seeing it. */}
      <div style={{
        padding: '10px 13px', borderRadius: 8, background: 'rgba(0,0,0,0.028)',
        fontSize: 12.5, color: '#3D4455', lineHeight: 1.55,
      }}>
        Proposed automatically from the previous payroll period:{' '}
        <strong>{signedLabel(proposedAmount)}</strong>
        {isManual && (
          <div style={{ color: '#8C94A6', marginTop: 4 }}>
            This balance is currently set manually. The proposed figure above is kept and can be restored.
          </div>
        )}
      </div>

      <PayrollField label="Direction">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <DirectionButton
            active={direction === 'owed'}
            onClick={() => setDirection('owed')}
            label="BOE owes the employee"
          />
          <DirectionButton
            active={direction === 'advance'}
            onClick={() => setDirection('advance')}
            label="Employee received in advance"
          />
        </div>
      </PayrollField>

      <PayrollField label="Amount" hint="Enter a positive number. The direction above decides the sign.">
        <input
          type="number"
          min="0"
          step="0.01"
          value={amount}
          onChange={e => setAmount(e.target.value)}
          style={inputStyle}
          placeholder="0.00"
        />
      </PayrollField>

      {/* The consequence in a sentence, before it is saved. */}
      {amount.trim() !== '' && Number.isFinite(magnitude) && (
        <div style={{
          padding: '9px 12px', borderRadius: 8,
          background: direction === 'owed' ? 'rgba(69,168,112,0.09)' : 'rgba(232,160,48,0.10)',
          fontSize: 12.5, color: '#3D4455', lineHeight: 1.5,
        }}>
          This will be recorded as <strong>{signedLabel(signed)}</strong> —{' '}
          {direction === 'owed'
            ? `BOE still owes ${employeeName} ${fmtMoney(magnitude)}, and it is added to this month's Salary Payable.`
            : `${employeeName} has already received ${fmtMoney(magnitude)}, and it is recovered from this month's Salary Payable.`}
        </div>
      )}

      <PayrollField label="Reason" hint="Required. Shown on the payslip, to the employee as well as to admins.">
        <textarea
          value={remark}
          onChange={e => setRemark(e.target.value)}
          rows={3}
          style={{ ...inputStyle, resize: 'vertical' }}
          placeholder="Why this balance is being set manually"
        />
      </PayrollField>

      {isManual && (
        <button
          onClick={() => onSubmit({ reset: true })}
          disabled={saving}
          className="boe-btn boe-btn-ghost"
          style={{ padding: '6px 12px', fontSize: 12.5, alignSelf: 'flex-start' }}
        >
          Restore the proposed balance ({signedLabel(proposedAmount)})
        </button>
      )}

      <PayrollModalActions
        onClose={onClose}
        onSave={() => onSubmit({ amount: signed, remark: remark.trim() })}
        saving={saving}
        saveLabel="Save balance"
        disabled={!valid}
      />
    </PayrollModal>
  )
}

function DirectionButton({
  active, onClick, label,
}: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        flex: '1 1 180px', padding: '9px 12px', borderRadius: 8, cursor: 'pointer',
        border: `1px solid ${active ? 'rgba(79,111,208,0.5)' : colors.border}`,
        background: active ? 'rgba(79,111,208,0.08)' : '#fff',
        color: active ? '#3B63B8' : '#6B7280',
        fontSize: 12.5, fontWeight: active ? 600 : 500, textAlign: 'left', lineHeight: 1.4,
      }}
    >
      {label}
    </button>
  )
}

function signedLabel(amount: number): string {
  if (Math.abs(amount) < 0.005) return fmtMoney(0)
  return `${amount > 0 ? '+' : '−'}${fmtMoney(Math.abs(amount))}`
}

// ─── Actual amount paid ───────────────────────────────────────────────────────

export type PaymentSubmit = {
  amount_paid: number | null
  payment_date: string | null
  remark: string
}

export function PaymentModal({
  employeeName, salaryPayable, currentAmount, currentDate, currentRemark,
  saving, error, onSubmit, onClose,
}: {
  employeeName: string
  salaryPayable: number
  currentAmount: number | null
  currentDate: string | null
  currentRemark: string | null
  saving: boolean
  error: string | null
  onSubmit: (payload: PaymentSubmit) => void
  onClose: () => void
}) {
  const [amount, setAmount] = useState(currentAmount != null ? String(currentAmount) : '')
  const [date,   setDate]   = useState(currentDate ?? '')
  const [remark, setRemark] = useState(currentRemark ?? '')

  const paid  = Number(amount)
  const valid = amount.trim() !== '' && Number.isFinite(paid) && paid >= 0
  const closing = valid ? salaryPayable - paid : null

  return (
    <PayrollModal
      title="Actual Amount Paid"
      subtitle={`What was actually paid to ${employeeName} for this month.`}
      onClose={onClose}
      width={520}
    >
      {error && <PayrollModalError message={error} />}

      {/* Stated up front, because this is the misunderstanding the whole feature
          turns on: the payment does not change the salary. */}
      <div style={{
        padding: '10px 13px', borderRadius: 8, background: 'rgba(0,0,0,0.028)',
        fontSize: 12.5, color: '#3D4455', lineHeight: 1.55,
      }}>
        Salary Payable for this month is <strong>{fmtMoney(salaryPayable)}</strong>.
        <div style={{ color: '#8C94A6', marginTop: 4 }}>
          Recording a payment does not change attendance, deductions or Salary Payable. It sets
          the balance carried forward.
        </div>
      </div>

      <PayrollField label="Amount paid" hint="May be equal to, less than, or more than Salary Payable.">
        <input
          type="number"
          min="0"
          step="0.01"
          value={amount}
          onChange={e => setAmount(e.target.value)}
          style={inputStyle}
          placeholder="0.00"
        />
      </PayrollField>

      {closing != null && (
        <div style={{
          padding: '9px 12px', borderRadius: 8,
          background: Math.abs(closing) < 0.005
            ? 'rgba(69,168,112,0.09)'
            : closing > 0 ? 'rgba(85,133,232,0.09)' : 'rgba(232,160,48,0.10)',
          fontSize: 12.5, color: '#3D4455', lineHeight: 1.5,
        }}>
          Balance carried forward: <strong>{signedLabel(closing)}</strong>
          <div style={{ color: '#5B6474', marginTop: 3 }}>
            {Math.abs(closing) < 0.005
              ? 'This month will be fully settled.'
              : closing > 0
                ? `${fmtMoney(closing)} will remain pending from BOE and carry into next month.`
                : `${fmtMoney(closing)} will be treated as paid in advance and recovered next month.`}
          </div>
        </div>
      )}

      <PayrollField label="Payment date" hint="Optional.">
        <input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
          style={inputStyle}
        />
      </PayrollField>

      <PayrollField label="Remark" hint="Optional. Shown on the payslip.">
        <textarea
          value={remark}
          onChange={e => setRemark(e.target.value)}
          rows={2}
          style={{ ...inputStyle, resize: 'vertical' }}
          placeholder="Bank transfer reference, part payment note, and so on"
        />
      </PayrollField>

      {currentAmount != null && (
        // Clearing is distinct from recording ₹0: one says "we have not recorded
        // this yet", the other says "we paid nothing".
        <button
          onClick={() => onSubmit({ amount_paid: null, payment_date: null, remark: remark.trim() })}
          disabled={saving}
          className="boe-btn boe-btn-ghost"
          style={{ padding: '6px 12px', fontSize: 12.5, alignSelf: 'flex-start' }}
        >
          Clear the recorded payment
        </button>
      )}

      <PayrollModalActions
        onClose={onClose}
        onSave={() => onSubmit({
          amount_paid:  paid,
          payment_date: date || null,
          remark:       remark.trim(),
        })}
        saving={saving}
        saveLabel="Save payment"
        disabled={!valid}
      />
    </PayrollModal>
  )
}
