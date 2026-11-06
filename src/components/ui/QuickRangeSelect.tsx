'use client'

import type { CSSProperties } from 'react'
import { MONTH_RANGE_PRESETS, matchMonthRange, resolveMonthRange, type MonthRangeKey } from '@/lib/monthRangePresets'

/**
 * "Quick range" for a list's From / To dates: This month, Last month, Last to
 * last month, Last 3 months, Last 6 months (see `monthRangePresets`).
 *
 * A bare <select> so each list can wrap it in its own label and row. It owns no
 * state: what it shows is worked out from the caller's `from` / `to`, so typing
 * a date by hand moves it to "Custom dates", and "Any date" clears both. The
 * caller's `onPick` receives BOTH dates at once, so a list that refetches on a
 * change refetches once.
 */
export function QuickRangeSelect({ from, to, onPick, id, className, style }: {
  from: string
  to: string
  /** Called with the new range; `''` for both means "any date". */
  onPick: (from: string, to: string) => void
  /** For a visible <label htmlFor>; the select is named "Quick range" either way. */
  id?: string
  className?: string
  style?: CSSProperties
}) {
  const matched = matchMonthRange(from, to)
  const value: MonthRangeKey | 'custom' | '' = matched ?? (from || to ? 'custom' : '')

  return (
    <select
      id={id}
      aria-label="Quick range"
      className={className}
      style={style}
      value={value}
      onChange={e => {
        const key = e.target.value as MonthRangeKey | ''
        if (!key) return onPick('', '')
        const range = resolveMonthRange(key)
        onPick(range.from, range.to)
      }}
    >
      <option value="">Any date</option>
      {value === 'custom' && <option value="custom" disabled>Custom dates</option>}
      {MONTH_RANGE_PRESETS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
    </select>
  )
}
