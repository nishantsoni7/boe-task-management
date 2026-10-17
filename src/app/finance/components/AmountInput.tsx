'use client'

import { useState } from 'react'
import { amountInputProblem, groupIndianDigits, sanitizeAmountInput } from '@/lib/currency'

// Indian-grouped amount input. While focused it shows the raw, comma-free
// value for easy editing; on blur it displays Indian digit grouping. The value
// passed to onChange has only spaces, grouping commas and the rupee sign
// removed — nothing that could change the figure.
//
// An amount that cannot be accepted stays exactly as typed and says why: it is
// never rounded or trimmed into a different figure (launch audit, 2026-09-19).
export function AmountInput({ value, onChange, prefix, autoFocus }: {
  value: string
  onChange: (v: string) => void
  /** A symbol drawn inside the left edge, such as the rupee sign. */
  prefix?: string
  autoFocus?: boolean
}) {
  const [focused, setFocused] = useState(false)
  const display = focused ? value : (value ? groupIndianDigits(value) : '')
  const problem = amountInputProblem(value)
  return (
    <>
      <div style={{ position: 'relative' }}>
      {prefix && (
        <span aria-hidden="true" style={{
          position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)',
          fontSize: '14px', color: '#686D6C', pointerEvents: 'none',
        }}>{prefix}</span>
      )}
      <input
        className="boe-input"
        type="text"
        inputMode="decimal"
        value={display}
        aria-invalid={problem !== null}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={e => onChange(sanitizeAmountInput(e.target.value))}
        placeholder="0"
        autoFocus={autoFocus}
        style={{ width: '100%', paddingLeft: prefix ? '28px' : undefined }}
      />
      </div>
      {problem && <div role="alert" style={{ fontSize: '12px', color: '#B42332', lineHeight: 1.4 }}>{problem}</div>}
    </>
  )
}
