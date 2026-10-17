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
//   FormDialog        the frame: header, a body that scrolls, a footer that does not
//   PaymentDetailsFields  amount, date and mode — the same three on every payment form

import { useId, useRef } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { paymentModeOptionsFor } from '@/lib/finance/paymentEntry'
import {
  FINANCE_MODAL_DIALOG_Z,
  FINANCE_MODAL_OVERLAY_Z,
  useDialogFocus,
  useModalScrollLock,
} from './FinanceModalShell'
import { AmountInput } from './AmountInput'
import { PaymentModeHint } from './PaymentModeHint'

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


// ── The frame every payment form shares ──────────────────────────────────────
//
// A HEADER THAT STAYS, A BODY THAT SCROLLS, A FOOTER THAT STAYS. The buttons and
// the summary of what is about to be sent never scroll out of reach, however
// long the form grows. The backdrop is INERT: these forms hold unsaved input,
// and a stray click must never throw it away. Escape and the close button are
// the form's own guard's business, not this frame's.

export function FormDialog({
  title, subtitle, onClose, closeDisabled, width = '660px', summary, actions, children, banner,
}: {
  title: string
  subtitle?: string
  onClose: () => void
  closeDisabled?: boolean
  width?: string
  /** What is about to be sent, in one line. */
  summary?: React.ReactNode
  /** The footer's buttons. */
  actions: React.ReactNode
  /** Sits above the steps, inside the scrolling body: a status notice, say. */
  banner?: React.ReactNode
  children: React.ReactNode
}) {
  useModalScrollLock()
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef)
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: FINANCE_MODAL_OVERLAY_Z }} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={{
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          width, maxWidth: 'calc(100vw - 24px)', maxHeight: 'calc(100vh - 40px)',
          background: colors.base, borderRadius: '12px', border: `1px solid ${colors.border}`,
          zIndex: FINANCE_MODAL_DIALOG_Z, display: 'flex', flexDirection: 'column', overflow: 'hidden',
          outline: 'none',
        }}
      >
        <div style={{
          padding: '14px 20px 12px', borderBottom: `1px solid ${colors.border}`,
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary }}>{title}</div>
            {subtitle && <div style={{ fontSize: '12px', color: colors.muted, marginTop: '2px' }}>{subtitle}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={closeDisabled}
            aria-label="Close"
            className="boe-btn boe-btn-ghost"
            style={{ padding: '4px 10px', fontSize: '13px', flexShrink: 0 }}
          >
            ✕
          </button>
        </div>

        <div style={{
          padding: '16px 20px', overflowY: 'auto', flex: 1,
          display: 'flex', flexDirection: 'column', gap: '20px',
        }}>
          {banner}
          {children}
        </div>

        <div style={{
          padding: '10px 20px', borderTop: `1px solid ${colors.border}`,
          display: 'flex', gap: '8px 16px', alignItems: 'center', justifyContent: 'space-between',
          flexWrap: 'wrap', flexShrink: 0,
        }}>
          <div aria-live="polite" style={{ fontSize: '13px', color: colors.secondary, minWidth: 0, wordBreak: 'break-word' }}>
            {summary}
          </div>
          <div style={{ display: 'flex', gap: '8px', marginLeft: 'auto' }}>{actions}</div>
        </div>
      </div>
    </>
  )
}

// ── Scroll to what needs attention ───────────────────────────────────────────

/**
 * After Send was pressed on an unfinished form: take the person to the first
 * thing that needs them. Waits one frame so the problems it looks for have been
 * drawn. A field marked aria-invalid wins over any other alert.
 */
export function scrollToFirstProblem(container: HTMLElement | null) {
  requestAnimationFrame(() => {
    const target = container?.querySelector<HTMLElement>('[aria-invalid="true"]')
      ?? container?.querySelector<HTMLElement>('[role="alert"]')
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    target?.focus?.({ preventScroll: true })
  })
}

// ── Amount, date and mode: the same three on every payment form ──────────────

function DetailLabel({ text, required, htmlFor }: { text: string; required?: boolean; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} style={{
      fontSize: '12px', fontWeight: 600, color: colors.muted,
      textTransform: 'uppercase', letterSpacing: '0.05em',
    }}>
      {text}{required && <span style={{ color: colors.red, marginLeft: '2px' }}>*</span>}
    </label>
  )
}

export function PaymentDetailsFields({
  amount, onAmount, date, onDate, mode, onMode, disabled,
  amountProblem, dateProblem, amountLabel = 'Amount', modeHintId,
}: {
  amount: string
  onAmount: (next: string) => void
  date: string
  onDate: (next: string) => void
  mode: string
  onMode: (next: string) => void
  disabled?: boolean
  amountProblem?: string | null
  dateProblem?: string | null
  amountLabel?: string
  modeHintId?: string
}) {
  const hintId = modeHintId ?? 'payment-mode-hint'
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <DetailLabel text={amountLabel} required />
          <AmountInput prefix="₹" value={amount} onChange={onAmount} />
          <FieldProblem message={amountProblem ?? null} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <DetailLabel text="Payment Date" required />
          <QuickDateField value={date} onChange={onDate} disabled={disabled} invalid={!!dateProblem} />
          <FieldProblem message={dateProblem ?? null} />
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <DetailLabel text="Payment Mode" required />
        <PaymentModePicker value={mode} onChange={onMode} disabled={disabled} describedBy={hintId} />
        <PaymentModeHint mode={mode} id={hintId} />
      </div>
    </>
  )
}
