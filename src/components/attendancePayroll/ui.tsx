'use client'

// Small shared pieces for the Attendance & Payroll pages: a status-filter group,
// a badge, a notice, a loading / empty / error block, and the month picker.
//
// Presentation only. Nothing here fetches, authorises or calculates; pages own
// their data and rules and hand this file the words and the numbers.

import { istCurrentYearMonth, selectableMonthsInYear, selectableYears } from '@/lib/attendance/monthAvailability'
import styles from './ui.module.css'

export const ui = styles

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export type Tone = 'good' | 'warn' | 'bad' | 'neutral' | 'info'

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: React.ReactNode }) {
  return <span className={`${styles.badge} ${styles[`tone-${tone}`]}`}>{children}</span>
}

/**
 * Compact filters over the list beneath them. Real buttons with aria-pressed
 * (they are not page navigation), one tab stop each, visible focus.
 */
export function StatusFilter<K extends string>({
  label, value, options, onChange,
}: {
  /** Names the group for assistive tech, e.g. "Filter requests by status". */
  label: string
  value: K
  options: ReadonlyArray<{ key: K; label: string; count?: number }>
  onChange: (key: K) => void
}) {
  return (
    <div className={styles.filters} role="group" aria-label={label}>
      {options.map(o => (
        <button
          key={o.key}
          type="button"
          aria-pressed={value === o.key}
          className={`${styles.filter}${value === o.key ? ` ${styles.filterActive}` : ''}`}
          onClick={() => onChange(o.key)}
        >
          {o.label}
          {o.count != null && <span className={styles.filterCount}>{o.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function Notice({
  kind, children, action,
}: {
  kind: 'error' | 'success' | 'warning' | 'info'
  children: React.ReactNode
  /** Optional right-hand control, e.g. a "Try again" button. */
  action?: React.ReactNode
}) {
  return (
    <div
      role={kind === 'error' ? 'alert' : 'status'}
      className={`${styles.notice} ${styles[`notice-${kind}`]}${action ? ` ${styles.noticeRow}` : ''}`}
    >
      {action ? <><span>{children}</span>{action}</> : children}
    </div>
  )
}

/** Loading, empty and error in one visual language. */
export function StateBlock({
  kind, title, children, action,
}: {
  kind: 'loading' | 'empty' | 'error'
  title?: string
  children?: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div
      className={`${styles.surface} ${styles.state}`}
      role={kind === 'error' ? 'alert' : kind === 'loading' ? 'status' : undefined}
      aria-busy={kind === 'loading' || undefined}
    >
      {title && <div className={styles.stateTitle}>{title}</div>}
      {children && <div className={styles.stateBody}>{children}</div>}
      {action && <div className={styles.stateAction}>{action}</div>}
    </div>
  )
}

/**
 * Month and year selects over the months the module allows (nothing in the
 * future). Controlled: the page owns the selection so every view of the same
 * month agrees on which month it is.
 */
export function MonthPicker({
  year, month, onChange, idPrefix = 'month',
}: {
  year: number
  month: number
  onChange: (year: number, month: number) => void
  idPrefix?: string
}) {
  const changeYear = (y: number) => {
    const allowed = selectableMonthsInYear(y)
    onChange(y, allowed.includes(month) ? month : allowed[allowed.length - 1])
  }
  return (
    <div className={styles.row} role="group" aria-label="Month">
      <label className={styles.srOnly} htmlFor={`${idPrefix}-m`}>Month</label>
      <select
        id={`${idPrefix}-m`} className={styles.input} style={{ width: 'auto', minWidth: 130 }}
        value={month} onChange={e => onChange(year, Number(e.target.value))}
      >
        {selectableMonthsInYear(year).map(m => <option key={m} value={m}>{MONTH_NAMES[m - 1]}</option>)}
      </select>
      <label className={styles.srOnly} htmlFor={`${idPrefix}-y`}>Year</label>
      <select
        id={`${idPrefix}-y`} className={styles.input} style={{ width: 'auto', minWidth: 90 }}
        value={year} onChange={e => changeYear(Number(e.target.value))}
      >
        {selectableYears().map(y => <option key={y} value={y}>{y}</option>)}
      </select>
    </div>
  )
}

export { istCurrentYearMonth }
