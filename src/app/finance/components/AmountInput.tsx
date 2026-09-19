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
export function AmountInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [focused, setFocused] = useState(false)
  const display = focused ? value : (value ? groupIndianDigits(value) : '')
  const problem = amountInputProblem(value)
  return (
    <>
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
        style={{ width: '100%' }}
      />
      {problem && <div role="alert" style={{ fontSize: '12px', color: '#C13030', lineHeight: 1.4 }}>{problem}</div>}
    </>
  )
}
