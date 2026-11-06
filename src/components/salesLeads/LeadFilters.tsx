'use client'

import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { CalendarDays, UserRound } from 'lucide-react'
import { hasDays, monthDays, monthOf, NO_DAYS, orderDays, rangeLabel, type DayRange, type MonthKey } from '@/lib/salesLeads/dateRange'
import { initialsOf } from '@/lib/salesLeads/format'
import s from './salesLeads.module.css'

// The Lead Master's two compact filters: "Custom dates" (This month, Last month, or From / To) and "Person" (everybody
// who holds a lead, as one list). Both are the Finance chip (.fin-chip: a native <details>; on a phone its panel is a
// bottom sheet), with what that chip does not do: it closes when a choice is made (a button marked data-closes), on
// Escape and on a press outside.

function ChipMenu({ summary, isSet, className, children }: {
  summary: ReactNode
  isSet: boolean
  className?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDetailsElement>(null)
  const close = useCallback(() => { if (ref.current) ref.current.open = false }, [])
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const d = ref.current
      if (d?.open && !d.contains(e.target as Node)) d.open = false
    }
    const onKey = (e: KeyboardEvent) => {
      const d = ref.current
      if (e.key !== 'Escape' || !d?.open) return
      d.open = false
      d.querySelector('summary')?.focus()
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey) }
  }, [])
  return (
    <details ref={ref} className={`fin-chip${isSet ? ' is-set' : ''}${className ? ` ${className}` : ''}`}>
      <summary>{summary}</summary>
      <div className="fin-chip-panel" onClick={e => { if ((e.target as Element).closest('[data-closes]')) close() }}>{children}</div>
    </details>
  )
}

/**
 * Quick months and the two date boxes. `sheet` draws the quick picks as the pills the phone Filter sheet uses for
 * Source; `panel` as the small buttons of the desktop chip (which close it when one is pressed). The boxes are the
 * phone's own date pickers.
 */
export function DatesFields({ days, today, onChange, variant }: {
  days: DayRange
  today: string
  onChange: (days: DayRange) => void
  variant: 'panel' | 'sheet'
}) {
  const month = monthOf(days, today)
  const quick = (key: MonthKey, label: string) => (
    <button
      key={key}
      type="button"
      className={variant === 'panel' ? s.quick : undefined}
      aria-pressed={month === key}
      data-closes={variant === 'panel' ? '' : undefined}
      onClick={() => onChange(monthDays(key, today))}
    >{label}</button>
  )
  return (
    <>
      {variant === 'panel' && <div className={s.panelLabel}>Quick picks</div>}
      <div className={variant === 'panel' ? s.quickRow : 'orders-sheet-options'}>
        {quick('this', 'This month')}
        {quick('last', 'Last month')}
      </div>
      {variant === 'panel' && <div className={s.panelLabel}>Or choose dates</div>}
      <div className={s.dateGrid} role="group" aria-label="Received dates">
        <label className={s.dateField}>
          <span>From</span>
          <input
            type="date"
            className="boe-input"
            aria-label="Received on or after"
            value={days.from}
            max={days.to || today}
            onChange={e => onChange(orderDays({ from: e.target.value, to: days.to }))}
          />
        </label>
        <label className={s.dateField}>
          <span>To</span>
          <input
            type="date"
            className="boe-input"
            aria-label="Received on or before"
            value={days.to}
            min={days.from || undefined}
            max={today}
            onChange={e => onChange(orderDays({ from: days.from, to: e.target.value }))}
          />
        </label>
      </div>
    </>
  )
}

/** The dates button beside Source. It reads "Custom dates" until days are chosen, then says which. */
export function DatesChip({ days, today, active, onChange, className }: {
  days: DayRange
  today: string
  /** False while a search is on: the days are kept but the list is not cut by them. */
  active: boolean
  onChange: (days: DayRange) => void
  className?: string
}) {
  const set = hasDays(days)
  return (
    <ChipMenu
      className={className}
      isSet={set && active}
      summary={<><CalendarDays size={13} aria-hidden="true" />{rangeLabel(days, today)}</>}
    >
      <div className={s.rangeBody}>
        <DatesFields days={days} today={today} onChange={onChange} variant="panel" />
        <div className={s.panelFoot}>
          <span className={s.panelNote}>Dates are India time</span>
          <button type="button" className="boe-btn boe-btn-ghost" disabled={!set} data-closes="" onClick={() => onChange(NO_DAYS)}>Clear dates</button>
        </div>
      </div>
    </ChipMenu>
  )
}

export type PersonCount = { id: string; name: string; n: number }

/**
 * One button for everybody who holds a lead, however many there are. `holder` is the screen's filter ('' everyone, 'none'
 * not allotted, or a user id); only a user id lights this button, the other two have their own chips beside it.
 */
export function PersonChip({ people, holder, onPick }: {
  people: PersonCount[]
  holder: string
  onPick: (id: string) => void
}) {
  const active = holder !== '' && holder !== 'none'
  const picked = people.find(p => p.id === holder)
  return (
    <ChipMenu
      isSet={active}
      summary={active
        ? (
          <>
            <span className="fin-avatar" aria-hidden="true">{initialsOf(picked?.name ?? '?')}</span>
            <span className={s.chipName}>{picked?.name ?? 'This person'}</span>
            {picked && <span className={s.count}>{picked.n}</span>}
          </>
        )
        : <><UserRound size={13} aria-hidden="true" />Person</>}
    >
      <div className={`${s.panelLabel} ${s.phoneOnly}`}>Allotted to</div>
      {people.length === 0 && <span className={s.panelNote}>Nobody to choose yet.</span>}
      <div className={s.peopleGrid} role="group" aria-label="Allotted to">
        {people.map(p => (
          <button
            key={p.id}
            type="button"
            className={`${s.person}${p.n === 0 ? ` ${s.personZero}` : ''}`}
            aria-pressed={holder === p.id}
            data-closes=""
            onClick={() => onPick(p.id)}
          >
            <span className="fin-avatar" aria-hidden="true">{initialsOf(p.name)}</span>
            <span className={s.personName}>{p.name}</span>
            <span className={s.count}>{p.n}</span>
          </button>
        ))}
      </div>
    </ChipMenu>
  )
}
