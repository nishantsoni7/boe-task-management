'use client'

import { useId } from 'react'
import { colors } from '@/lib/tokens'
import {
  MIXED_CUSTOMER_CONFIRM_LABEL,
  MIXED_CUSTOMER_INCOMPLETE_NOTE,
  MIXED_CUSTOMER_INCOMPLETE_TITLE,
  MIXED_CUSTOMER_TITLE,
  type CustomerGroup,
} from '@/lib/finance/mixedCustomers'

// ── The warning shown when one payment's targets name several customers ─────
//
// Shared by Record Payment and Allocate Funds, so the two doors that divide a
// payment say the same thing in the same words. It warns and asks; it never
// blocks on its own — the form decides that the box must be ticked, and the
// server allows the split either way. See src/lib/finance/mixedCustomers.ts.

export function MixedCustomerWarning({
  groups,
  confirmed,
  onConfirmedChange,
  disabled,
  incomplete,
}: {
  groups: readonly CustomerGroup[]
  confirmed: boolean
  onConfirmedChange: (next: boolean) => void
  disabled?: boolean
  /** The payment's existing customers could not all be read — say so, never guess. */
  incomplete?: boolean
}) {
  const checkboxId = useId()
  return (
    <div
      role="alert"
      style={{
        border: '1px solid #FDE68A', background: '#FFFBEB', borderRadius: '8px',
        padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px',
      }}
    >
      <div style={{ fontSize: '13px', fontWeight: 700, color: '#92400E' }}>
        {incomplete ? MIXED_CUSTOMER_INCOMPLETE_TITLE : MIXED_CUSTOMER_TITLE}
      </div>
      <div style={{ fontSize: '12px', color: '#92400E', lineHeight: 1.5 }}>
        {incomplete
          ? MIXED_CUSTOMER_INCOMPLETE_NOTE
          : 'Check this is intended. The payment will be shown as “Multiple customers”.'}
      </div>
      <ul style={{ margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {groups.map(g => (
          <li key={g.customer} style={{ fontSize: '12.5px', color: colors.primary, lineHeight: 1.45, wordBreak: 'break-word' }}>
            <strong>{g.customer}</strong>
            <span style={{ color: colors.secondary }}> — {g.targets.join(', ')}</span>
          </li>
        ))}
      </ul>
      <label
        htmlFor={checkboxId}
        style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '12.5px', color: colors.primary, cursor: disabled ? 'default' : 'pointer', lineHeight: 1.45 }}
      >
        <input
          id={checkboxId}
          type="checkbox"
          checked={confirmed}
          disabled={disabled}
          onChange={e => onConfirmedChange(e.target.checked)}
          style={{ marginTop: '2px', flexShrink: 0 }}
        />
        <span>{MIXED_CUSTOMER_CONFIRM_LABEL}</span>
      </label>
    </div>
  )
}
