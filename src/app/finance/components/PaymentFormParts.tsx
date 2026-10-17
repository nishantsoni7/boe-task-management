'use client'

// ── The small pieces of the Send Payment Request form ────────────────────────
//
// PRESENTATION ONLY. Nothing here decides whether a payment is valid, who may
// send it or what it is allowed to touch — submit_payment_request re-derives
// every rule server-side. These pieces exist so a person is told what to do
// next without scrolling, guessing or retyping.
//
//   FormStep          a numbered section: one heading, one question
//   PaymentModePicker the four accounts as one-tap buttons, not a dropdown
//   QuickDateField    the date, plus Today and Yesterday as one tap each
//   FieldProblem      the red sentence under a field that needs attention
//   OptionalDisclosure  a section that stays closed until somebody wants it

import { useId } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { paymentModeOptionsFor } from '@/lib/finance/paymentEntry'

// ── A numbered step ──────────────────────────────────────────────────────────

export function FormStep({ number, title, hint, children }: {
  number: number
  title: string
  /** Quiet words after the title, such as "Optional". */
  hint?: string
  children: React.ReactNode
}) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <h3 id={headingId} style={{
        margin: 0, display: 'flex', alignItems: 'center', gap: '8px',
        fontSize: '13px', fontWeight: 600, color: colors.primary,
      }}>
        <span aria-hidden="true" style={{
          width: '20px', height: '20px', borderRadius: '50%', flexShrink: 0,
          border: `1px solid ${colors.border}`, background: colors.raised,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '11px', fontWeight: 600, color: colors.secondary,
        }}>{number}</span>
        {title}
        {hint && <span style={{ fontWeight: 400, fontSize: '12px', color: colors.muted }}>{hint}</span>}
      </h3>
      {children}
    </section>
  )
}

// ── A problem under a field ──────────────────────────────────────────────────

export function FieldProblem({ id, message }: { id?: string; message: string | null }) {
  if (!message) return null
  return (
    <div id={id} role="alert" style={{ fontSize: '12px', color: colors.red, lineHeight: 1.4, marginTop: '4px' }}>
      {message}
    </div>
  )
}

// ── The four accounts, one tap each ──────────────────────────────────────────

export function PaymentModePicker({ value, onChange, disabled, describedBy }: {
  value: string
  onChange: (next: string) => void
  disabled?: boolean
  describedBy?: string
}) {
  const options = paymentModeOptionsFor(value)
  return (
    <div
      role="radiogroup"
      aria-label="Payment mode"
      aria-describedby={describedBy}
      style={{ display: 'grid', gap: '8px', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))' }}
    >
      {options.map(option => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            style={{
              padding: '10px 12px', borderRadius: '8px', cursor: disabled ? 'default' : 'pointer',
              fontSize: '13px', fontWeight: 600, color: colors.primary, textAlign: 'center',
              border: `1px solid ${selected ? colors.primary : colors.border}`,
              background: selected ? colors.hover : colors.base,
              boxShadow: selected ? `inset 0 0 0 1px ${colors.primary}` : 'none',
            }}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

// ── The date, with the two answers people actually give ──────────────────────

/** YYYY-MM-DD in the reader's own calendar. toISOString() would be UTC, which in
 *  India is a different day for the first five and a half hours of every morning. */
export function localDateInput(daysAgo = 0, now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function QuickDateField({ value, onChange, disabled, invalid, describedBy }: {
  value: string
  onChange: (next: string) => void
  disabled?: boolean
  invalid?: boolean
  describedBy?: string
}) {
  const id = useId()
  const today = localDateInput(0)
  const yesterday = localDateInput(1)
  const chip = (label: string, date: string) => {
    const on = value === date
    return (
      <button
        key={label}
        type="button"
        disabled={disabled}
        aria-pressed={on}
        onClick={() => onChange(date)}
        style={{
          padding: '3px 11px', borderRadius: '999px', fontSize: '12px', cursor: disabled ? 'default' : 'pointer',
          border: `1px solid ${on ? colors.primary : colors.border}`,
          background: on ? colors.hover : colors.base,
          color: on ? colors.primary : colors.secondary, fontWeight: on ? 600 : 400,
        }}
      >
        {label}
      </button>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <input
        id={id}
        className="boe-input"
        type="date"
        value={value}
        max={today}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={e => onChange(e.target.value)}
        style={{ width: '100%' }}
      />
      <div style={{ display: 'flex', gap: '6px' }}>
        {chip('Today', today)}
        {chip('Yesterday', yesterday)}
      </div>
    </div>
  )
}

// ── Closed until wanted ──────────────────────────────────────────────────────

export function OptionalDisclosure({ title, hint, open, onToggle, children }: {
  title: string
  hint?: string
  /** Controlled by the form so something already typed can never be hidden. */
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  const bodyId = useId()
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={bodyId}
        style={{
          display: 'flex', alignItems: 'center', gap: '6px', alignSelf: 'flex-start',
          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          fontSize: '13px', fontWeight: 600, color: colors.primary,
        }}
      >
        <Chevron size={15} aria-hidden="true" />
        {title}
        {hint && <span style={{ fontWeight: 400, fontSize: '12px', color: colors.muted }}>{hint}</span>}
      </button>
      <div id={bodyId} hidden={!open}>{open && children}</div>
    </div>
  )
}
