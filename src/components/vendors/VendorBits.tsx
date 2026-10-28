'use client'

import { VENDOR_STATUSES, labelOf } from '@/lib/vendors/constants'
import s from './vendors.module.css'

// Small shared pieces of the Vendors screens.

const IST = 'Asia/Kolkata'

export function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: IST, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  })
}

export function formatDay(iso: string): string {
  // A bare date ('2026-10-30') is already an IST calendar day; an instant is converted.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00+05:30`) : new Date(iso)
  return d.toLocaleDateString('en-IN', { timeZone: IST, day: 'numeric', month: 'short', year: 'numeric' })
}

export function daysAgoText(days: number | null | undefined): string {
  if (days === null || days === undefined) return 'Never visited'
  if (days <= 0) return 'Visited today'
  if (days === 1) return 'Visited yesterday'
  return `Visited ${days} days ago`
}

export const mapsHref = (lat: number, lng: number) => `https://www.google.com/maps?q=${lat},${lng}`

export function StatusBadge({ status }: { status: string }) {
  const tone = status === 'approved' ? s.badgeGood : status === 'rejected' ? s.badgeBad : status === 'on_hold' ? s.badgeWarn : ''
  return <span className={`${s.badge} ${tone}`}>{labelOf(VENDOR_STATUSES, status)}</span>
}

type Option = { readonly value: string; readonly label: string }

export function Chips({
  options, value, onChange, multiple = false, label,
}: {
  options: readonly Option[]
  value: string[] | string
  onChange: (next: string[] | string) => void
  multiple?: boolean
  label: string
}) {
  const selected = Array.isArray(value) ? value : value ? [value] : []
  return (
    <div className={s.chips} role={multiple ? 'group' : 'radiogroup'} aria-label={label}>
      {options.map(o => {
        const on = selected.includes(o.value)
        return (
          <button
            key={o.value}
            type="button"
            className={`${s.chip}${on ? ` ${s.chipOn}` : ''}`}
            role={multiple ? 'checkbox' : 'radio'}
            aria-checked={on}
            onClick={() => {
              if (multiple) onChange(on ? selected.filter(v => v !== o.value) : [...selected, o.value])
              else onChange(o.value)
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export function Field({
  label, required, hint, error, children, htmlFor,
}: {
  label: string
  required?: boolean
  hint?: string
  error?: string
  children: React.ReactNode
  htmlFor?: string
}) {
  return (
    <div className={s.field}>
      <label className={s.label} htmlFor={htmlFor}>{label}{required && <span className={s.req} aria-hidden="true">*</span>}</label>
      {children}
      {hint && !error && <div className={s.hint}>{hint}</div>}
      {error && <div className={s.err} role="alert">{error}</div>}
    </div>
  )
}

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The words the person typed, marked wherever they appear in the text. */
export function Highlight({ text, q }: { text: string; q: string }) {
  const terms = q.trim().split(/\s+/).filter(t => t.length > 0)
  if (terms.length === 0) return <>{text}</>
  const re = new RegExp(`(${terms.map(escapeRe).join('|')})`, 'ig')
  const parts = text.split(re)
  return (
    <>
      {parts.map((part, i) => (i % 2 === 1 ? <mark key={i} className={s.mark}>{part}</mark> : <span key={i}>{part}</span>))}
    </>
  )
}

/** How recently a vendor was seen: a coloured dot and a plain sentence. */
export function Freshness({ days, visits, by }: { days: number | null; visits: number; by: string | null }) {
  const tone = days === null ? s.dotBad : days <= 14 ? s.dotGood : days <= 30 ? s.dotWarn : s.dotBad
  return (
    <div className={s.fresh}>
      <span className={`${s.dot} ${tone}`} aria-hidden="true" />
      <span>
        {daysAgoText(days)}{by ? ` by ${by}` : ''} · {visits} visit{visits === 1 ? '' : 's'}
      </span>
    </div>
  )
}
