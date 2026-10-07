'use client'

import { Check } from 'lucide-react'

// Tap-friendly single / multiple choice, on the shared .boe-choice styling
// (48px tall, whole tile is the hit target, a check mark on the chosen ones).

type Option = { readonly value: string; readonly label: string }

export function ChoiceGroup({
  name, legend, options, columns = 2, multiple = false, value, onChange, invalid, describedBy,
}: {
  name: string
  legend: string
  options: readonly Option[]
  columns?: 2 | 3
  multiple?: boolean
  value: string | readonly string[]
  onChange: (next: string) => void
  invalid?: boolean
  describedBy?: string
}) {
  const chosen = (v: string) => (multiple ? (value as readonly string[]).includes(v) : value === v)
  return (
    <div
      role={multiple ? 'group' : 'radiogroup'}
      aria-label={legend}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      className={`boe-choice-grid boe-choice-grid--${columns}`}
    >
      {options.map(o => (
        <label
          key={o.value}
          className="boe-choice"
          style={invalid && !chosen(o.value) ? { borderColor: '#DC1F2E' } : undefined}
        >
          <input
            type={multiple ? 'checkbox' : 'radio'}
            name={name}
            value={o.value}
            checked={chosen(o.value)}
            onChange={() => onChange(o.value)}
          />
          <span className="boe-choice-text">{o.label}</span>
          <Check size={15} strokeWidth={2.6} className="boe-choice-check" aria-hidden="true" />
        </label>
      ))}
    </div>
  )
}
