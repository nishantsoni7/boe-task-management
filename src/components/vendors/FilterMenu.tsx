'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import s from './vendors.module.css'

// A filter button that opens a small checklist (Notion's multi-select filter). Shows what is chosen on the button
// itself, so the active filters are readable without opening anything. Closes on an outside click or Escape.

type Option = { readonly value: string; readonly label: string }

export default function FilterMenu({
  label, options, value, onChange, emptyText = 'Nothing to choose yet',
}: {
  label: string
  options: readonly Option[]
  value: readonly string[]
  onChange: (next: string[]) => void
  emptyText?: string
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', esc) }
  }, [open])

  const on = value.length > 0
  const summary = value.length === 1 ? (options.find(o => o.value === value[0])?.label ?? value[0]) : value.length > 1 ? `${value.length} chosen` : null

  return (
    <div ref={box} className={s.fmenu}>
      <button type="button" className={`${s.fbtn}${on ? ` ${s.fbtnOn}` : ''}`} aria-haspopup="listbox" aria-expanded={open}
              onClick={() => setOpen(v => !v)}>
        <span>{label}</span>
        {summary && <span className={s.fbtnVal}>{summary}</span>}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className={`${s.fpop} ${s.fade}`} role="listbox" aria-label={label} aria-multiselectable="true">
          {options.length === 0 && <div className={s.muted} style={{ padding: '6px 4px' }}>{emptyText}</div>}
          {options.map(o => (
            <label key={o.value} className={s.fopt}>
              <input type="checkbox" checked={value.includes(o.value)}
                     onChange={e => onChange(e.target.checked ? [...value, o.value] : value.filter(v => v !== o.value))} />
              <span>{o.label}</span>
            </label>
          ))}
          {on && <button type="button" className={s.linkBtn} style={{ alignSelf: 'flex-start' }} onClick={() => onChange([])}>Clear</button>}
        </div>
      )}
    </div>
  )
}
