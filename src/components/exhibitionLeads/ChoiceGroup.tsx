'use client'

import { useState } from 'react'
import { Check, Info } from 'lucide-react'
import s from './leads.module.css'

// Tap-friendly single / multiple choice, on the shared .boe-choice styling
// (48px tall, whole tile is the hit target, a check mark on the chosen ones).
//
// An option may carry a `hint`: longer explanatory text that is NOT shown by
// default. A small "i" button on the tile opens it, so the choice itself stays a
// short label (Lead Type uses this).

type Option = { readonly value: string; readonly label: string; readonly hint?: string }

export function ChoiceGroup({
  name, legend, options, columns = 2, multiple = false, value, onChange, invalid, describedBy,
}: {
  name: string
  legend: string
  options: readonly Option[]
  columns?: 1 | 2 | 3
  multiple?: boolean
  value: string | readonly string[]
  onChange: (next: string) => void
  invalid?: boolean
  describedBy?: string
}) {
  const [openHint, setOpenHint] = useState<string | null>(null)
  const chosen = (v: string) => (multiple ? (value as readonly string[]).includes(v) : value === v)
  return (
    <div
      role={multiple ? 'group' : 'radiogroup'}
      aria-label={legend}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      className={columns === 1 ? 'boe-choice-grid' : `boe-choice-grid boe-choice-grid--${columns}`}
    >
      {options.map(o => {
        const hintId = `${name}-${o.value}-hint`
        const open = openHint === o.value
        return (
          <div key={o.value} className={s.choiceCell}>
            <div className={s.choiceTile}>
              <label
                className="boe-choice"
                style={{
                  ...(invalid && !chosen(o.value) ? { borderColor: '#DC1F2E' } : null),
                  ...(o.hint ? { paddingRight: 44 } : null),
                }}
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
              {o.hint && (
                <button
                  type="button"
                  className={s.infoBtn}
                  aria-label={`About ${o.label}`}
                  aria-expanded={open}
                  aria-controls={hintId}
                  onClick={() => setOpenHint(open ? null : o.value)}
                >
                  <Info size={16} aria-hidden="true" />
                </button>
              )}
            </div>
            {o.hint && open && <div id={hintId} className={s.optionHint} role="note">{o.hint}</div>}
          </div>
        )
      })}
    </div>
  )
}
