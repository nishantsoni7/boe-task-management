'use client'

// The account a Canara payment came FROM. Replaces "Where is this money now?" for
// Canara on every form that records a payment; the rules and the saved shape live
// in src/lib/finance/canaraAccount.ts (holder and number required, bank optional
// and any bank).

import { useId } from 'react'
import { colors } from '@/lib/tokens'
import { FieldProblem } from './PaymentFormParts'
import {
  CANARA_BANK_MAX, CANARA_HOLDER_MAX, CANARA_NUMBER_MAX,
  type CanaraAccount, type CanaraAccountProblems,
} from '@/lib/finance/canaraAccount'

const LABEL: React.CSSProperties = { fontSize: '12px', fontWeight: 500, color: colors.muted }

export function CanaraAccountFields({ value, onChange, problems, disabled }: {
  value: CanaraAccount
  onChange: (next: CanaraAccount) => void
  /** Pass the problems only once the person pressed Send; null/empty shows none. */
  problems?: CanaraAccountProblems | null
  disabled?: boolean
}) {
  const id = useId()
  const set = (key: keyof CanaraAccount) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...value, [key]: e.target.value })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ fontSize: '13px', color: colors.secondary, lineHeight: 1.45 }}>
        Details of the account the money came from. Nitish accepts this payment once the money has reached the company.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <label htmlFor={`${id}-holder`} style={LABEL}>
            Account holder name<span style={{ color: colors.red, marginLeft: '2px' }}>*</span>
          </label>
          <input
            id={`${id}-holder`} className="boe-input" value={value.holder} onChange={set('holder')}
            maxLength={CANARA_HOLDER_MAX} disabled={disabled} autoComplete="off"
            aria-invalid={!!problems?.holder} aria-describedby={problems?.holder ? `${id}-holder-problem` : undefined}
          />
          <FieldProblem id={`${id}-holder-problem`} message={problems?.holder ?? null} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <label htmlFor={`${id}-number`} style={LABEL}>
            Account number<span style={{ color: colors.red, marginLeft: '2px' }}>*</span>
          </label>
          <input
            id={`${id}-number`} className="boe-input" value={value.number} onChange={set('number')}
            maxLength={CANARA_NUMBER_MAX} disabled={disabled} autoComplete="off" inputMode="text"
            aria-invalid={!!problems?.number} aria-describedby={problems?.number ? `${id}-number-problem` : undefined}
          />
          <FieldProblem id={`${id}-number-problem`} message={problems?.number ?? null} />
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <label htmlFor={`${id}-bank`} style={LABEL}>Bank (optional)</label>
        <input
          id={`${id}-bank`} className="boe-input" value={value.bank} onChange={set('bank')}
          maxLength={CANARA_BANK_MAX} disabled={disabled} autoComplete="off"
          placeholder="Any bank, e.g. SBI or ICICI"
        />
      </div>
    </div>
  )
}
