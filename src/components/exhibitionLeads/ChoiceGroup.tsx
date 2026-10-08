'use client'

import { useEffect, useRef, useState } from 'react'
import { Check, Info } from 'lucide-react'
import s from './leads.module.css'

// Tap-friendly single / multiple choice, on the shared .boe-choice styling
// (48px tall, whole tile is the hit target, a check mark on the chosen ones).
// The option text is regular weight: the bold is reserved for the field label
// above the group.
//
// An option may carry a `hint`: longer explanatory text that is NOT shown by
// default. A small "i" button on the tile opens it in a small popup anchored to
// that tile. The popup closes on a tap anywhere else, on Escape, or on a second
// tap of the "i"; opening another one replaces it.

type Option = { readonly value: string; readonly label: string; readonly hint?: string }

export function ChoiceGroup({
  name, legend, options, columns = 2, multiple = false, value, onChange, invalid, describedBy, accents,
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
  /** A colour per option value: a dot before the text, and the chosen tile takes the colour. */
  accents?: Readonly<Record<string, string>>
}) {
  const [openHint, setOpenHint] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const chosen = (v: string) => (multiple ? (value as readonly string[]).includes(v) : value === v)

  useEffect(() => {
    if (!openHint) return
    const onDown = (e: PointerEvent) => {
      const el = e.target as Element | null
      if (!el?.closest('[data-hint-ui]')) setOpenHint(null)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenHint(null) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [openHint])

  return (
    <div
      ref={rootRef}
      role={multiple ? 'group' : 'radiogroup'}
      aria-label={legend}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      className={columns === 1 ? 'boe-choice-grid' : `boe-choice-grid boe-choice-grid--${columns}`}
    >
      {options.map(o => {
        const hintId = `${name}-${o.value}-hint`
        const open = openHint === o.value
        const accent = accents?.[o.value]
        return (
          <div key={o.value} className={s.choiceTile}>
            <label
              className={`boe-choice ${s.choiceRegular}${accent ? ` ${s.accentChoice}` : ''}`}
              style={{
                ...(invalid && !chosen(o.value) ? { borderColor: '#DC1F2E' } : null),
                ...(o.hint ? { paddingRight: 48 } : null),
                ...(accent ? { ['--accent' as string]: accent } : null),
              }}
            >
              <input
                type={multiple ? 'checkbox' : 'radio'}
                name={name}
                value={o.value}
                checked={chosen(o.value)}
                onChange={() => onChange(o.value)}
              />
              {accent && <span className={s.accentDot} aria-hidden="true" />}
              <span className="boe-choice-text">{o.label}</span>
              <Check size={15} strokeWidth={2.6} className="boe-choice-check" aria-hidden="true" />
            </label>
            {o.hint && (
              <button
                type="button"
                data-hint-ui
                className={s.infoBtn}
                aria-label={`About ${o.label}`}
                aria-expanded={open}
                aria-controls={hintId}
                onClick={() => setOpenHint(open ? null : o.value)}
              >
                <Info size={16} aria-hidden="true" />
              </button>
            )}
            {o.hint && open && (
              <div id={hintId} role="note" data-hint-ui className={s.hintPopup}>{o.hint}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}
