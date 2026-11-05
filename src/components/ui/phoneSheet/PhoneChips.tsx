'use client'

/**
 * ONE ROW OF CHIPS THAT SCROLLS SIDEWAYS (phones). It takes the place of a
 * list's status cards or tabs: each chip has its words, an optional coloured
 * dot (`tone`) and an optional count; a zero count is faded, and a count not
 * read yet (`null`) shows "—". The row's class says where it sits:
 * `boe-p3-chips` by default, `orders-phone-chips` on Confirmed Orders.
 */

export type PhoneChip<K extends string> = {
  key: K
  label: string
  count?: number | null
  tone?: 'neutral' | 'partial' | 'zero' | 'full' | 'over'
}

export function PhoneChips<K extends string>({ label, chips, active, onSelect, className, rowClassName = 'boe-p3-chips' }: {
  /** The group's name for a screen reader: "Order status", "Tasks". */
  label: string
  chips: PhoneChip<K>[]
  active: K
  onSelect: (key: K) => void
  /** Added after the row's own class. */
  className?: string
  rowClassName?: string
}) {
  return (
    <div className={`${rowClassName}${className ? ` ${className}` : ''}`} role="group" aria-label={label}>
      {chips.map(c => (
        <button
          key={c.key}
          type="button"
          className={`orders-phone-chip${c.count === 0 ? ' is-zero' : ''}`}
          aria-pressed={active === c.key}
          onClick={() => onSelect(c.key)}
        >
          {c.tone && <span aria-hidden="true" className={`fin-dot fin-dot--${c.tone}`} />}
          {c.label}
          {c.count !== undefined && <span className="orders-phone-chip-count">{c.count ?? '—'}</span>}
        </button>
      ))}
    </div>
  )
}
