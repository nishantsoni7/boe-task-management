'use client'

// ── PI details, and the Submit card beside the payment ───────────────────────
//
// THE ONE PLACE (owner, 2026-10-30): everything Submit for approval needs sits
// together near the top of the PI Draft page. The left card holds the details —
// Client, Order details, Supporting details — each section with its own status
// and its own editor; the right column holds the payment and, for whoever can
// submit, this file's Submit card: one line per part of the PI and the Submit
// control under them.
//
// It is presentation only: every field is still saved by the editor and the RPC
// that already owns it, and every requirement it names is one the code and the
// database already enforce (see piCompletion.ts). It decides nothing about
// authority — `canEdit`, `locked` and `submit` come from the page's own answers
// and each RPC re-derives them.

import { AlertCircle, Check, ClipboardCheck, FileText, Lock, Minus, Pencil, Send, Upload } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { RequiredMark, SectionChip } from './PiFormParts'
import {
  type CompletionFact,
  type CompletionItem,
  type SubmitCheck,
} from '@/lib/orders/piCompletion'

export const COMPLETION_TITLE = 'PI details'
export const COMPLETION_LOCKED_TITLE = 'PI details'
export const COMPLETION_LOCKED_HINT = 'Locked while this PI is with management.'
export const COMPLETION_SUBTITLE = 'Everything Submit for approval needs'
export const COMPLETION_LOCKED_SUBTITLE = 'What Sales submitted'
export const COMPLETION_LOCKED_CHIP = 'Locked while with management'
export const SUBMIT_CARD_TITLE = 'Submit for approval'

/**
 * One read-out group (the client) with its single edit control.
 *
 * Each fact is a small label over its value, and the five facts share one row
 * on a wide card (see .pi-client-facts in globals.css), so no value sits a page
 * width away from its label. `chip` is the section's one status — "Complete" or
 * "1 needed" — drawn beside the title.
 */
export function PiCompletionFacts({ title, facts, editLabel, canEdit, locked, onEdit, chip = null }: {
  title: string
  facts: readonly CompletionFact[]
  editLabel: string
  canEdit: boolean
  locked: boolean
  onEdit: () => void
  chip?: React.ReactNode
}) {
  const isAddress = (f: CompletionFact) => f.key === 'billing_address' || f.key === 'shipping_address'
  const details = facts.filter(f => !isAddress(f))
  const addresses = facts.filter(isAddress)
  const fact = (f: CompletionFact) => (
    <div key={f.key} data-fact={f.key} className="pi-client-fact">
      <dt>
        {f.label}
        {f.need === 'submission' && <RequiredMark />}
      </dt>
      <dd data-empty={f.value ? undefined : 'true'} data-required={!f.value && f.need === 'submission' ? 'true' : undefined}>
        {f.value ?? (f.need === 'submission' ? 'Not added yet' : 'Not given')}
      </dd>
    </div>
  )
  return (
    <section aria-label={title} className="pi-client-facts">
      <div className="pi-section-head">
        <h3 className="pi-section-title">{title}</h3>
        {chip}
        {(canEdit || locked) && (
          <button
            type="button"
            className="boe-btn boe-btn-ghost pi-section-action"
            style={locked ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}
            disabled={locked}
            title={locked ? COMPLETION_LOCKED_HINT : undefined}
            onClick={onEdit}
            aria-haspopup="dialog"
          >
            <Pencil size={12} aria-hidden="true" /> {editLabel}
          </button>
        )}
      </div>
      {/* The client's own details, then the billing address and the shipping
          address. Same five facts, same order, same words. */}
      <div className="pi-client-body">
        <dl className="pi-client-col pi-client-col--details">{details.map(fact)}</dl>
        {addresses.map(a => <dl key={a.key} className="pi-client-col pi-client-col--address">{fact(a)}</dl>)}
      </div>
    </section>
  )
}

/**
 * THE DETAILS CARD. Header first — the title, one line on what the card is for,
 * and the card's one status — then the grouped sections separated by thin rules.
 *
 *   complete  the viewer can submit: "N needed to submit" or "Ready to submit"
 *   locked    the PI is with management: every section legible, editing muted
 *   read      anybody else: the same sections, read-only, no status
 *
 * The Submit control is NOT here: it is the Submit card's, beside the payment.
 */
export function PiCompletionPanel({ mode, neededCount, groups }: {
  mode: 'complete' | 'locked' | 'read'
  /** Items Submit still waits for, from piCompletion's requiredMissing. */
  neededCount: number
  /** The grouped sections: Client, Order details, Supporting details. */
  groups: React.ReactNode
}) {
  const locked = mode === 'locked'
  const title = locked ? COMPLETION_LOCKED_TITLE : COMPLETION_TITLE
  const Icon = locked ? Lock : mode === 'complete' ? ClipboardCheck : FileText
  return (
    <section
      id="pi-complete-details"
      aria-label={title}
      data-locked={locked ? 'true' : 'false'}
      className="pi-completion"
    >
      <div className="pi-completion-head">
        <Icon size={18} aria-hidden="true" style={{ color: locked ? colors.blue : mode === 'complete' ? colors.brand : colors.secondary }} />
        <h2 className="pi-completion-title">{title}</h2>
        {mode !== 'read' && (
          <span className="pi-completion-subtitle">{locked ? COMPLETION_LOCKED_SUBTITLE : COMPLETION_SUBTITLE}</span>
        )}
        {locked && <SectionChip tone="blue">{COMPLETION_LOCKED_CHIP}</SectionChip>}
        {mode === 'complete' && (neededCount > 0
          ? <SectionChip tone="amber">{neededCount} needed to submit</SectionChip>
          : <SectionChip tone="green">Ready to submit</SectionChip>)}
      </div>

      <div className="pi-completion-groups">{groups}</div>
    </section>
  )
}

const CHECK_ICON = { ok: Check, need: AlertCircle, optional: Minus } as const

/**
 * THE SUBMIT CARD, beside the payment, for whoever can submit this PI.
 *
 * One line per part of the PI — done, still needed, or optional — then the
 * Submit control, full width, and under it the one sentence that says why it
 * cannot be pressed yet. Each "Add" takes the person to the editor that owns the
 * item. Change PI (a corrected workbook) is the quiet control at the foot.
 */
export function PiSubmitCard({ checks, onFix, disabled, submit, onChangePi }: {
  checks: readonly SubmitCheck[]
  /** Takes the person to an item's editor; null when this viewer may not edit. */
  onFix: ((item: CompletionItem) => void) | null
  /** While anything is being sent. */
  disabled: boolean
  submit: { label: string; disabled: boolean; reason: string | null; onSubmit: () => void }
  onChangePi: (() => void) | null
}) {
  return (
    <section aria-label={SUBMIT_CARD_TITLE} className="pi-submit-card">
      <h2 className="pi-submit-title">{submit.label}</h2>
      <ul className="pi-submit-checks">
        {checks.map(check => {
          const Icon = CHECK_ICON[check.state]
          return (
            <li key={check.key} className={`pi-submit-check pi-submit-check--${check.state}`} data-check={check.key}>
              <span className="pi-submit-check-icon" aria-hidden="true"><Icon size={12} strokeWidth={3} /></span>
              <span className="pi-submit-check-text">
                <strong>{check.label}</strong>
                <span>{check.text}</span>
              </span>
              {check.fix && onFix && (
                <button type="button" className="pi-submit-check-fix" disabled={disabled} onClick={() => onFix(check.fix as CompletionItem)}>
                  Add
                </button>
              )}
            </li>
          )
        })}
      </ul>
      <button
        type="button"
        className="boe-btn boe-btn-primary pi-submit-button"
        onClick={submit.onSubmit}
        disabled={submit.disabled}
        title={submit.reason ?? undefined}
      >
        <Send size={14} strokeWidth={2} aria-hidden="true" /> {submit.label}
      </button>
      {submit.reason && <p data-testid="pi-submit-reason" className="pi-submit-reason">{submit.reason}.</p>}
      {onChangePi && (
        <button type="button" className="boe-btn boe-btn-ghost pi-submit-change" onClick={onChangePi} disabled={disabled}>
          <Upload size={13} strokeWidth={2} aria-hidden="true" /> Change PI
        </button>
      )}
    </section>
  )
}


/**
 * THE STATUS NOTICE for a PI that is with management: prominent, plain, and with
 * the one route back. Shown to everybody who opens it — a reviewer reads it as
 * "this is locked for its owner", the owner as "ask management to unlock it".
 */
export function PiLockedNotice({ title, body, onRequestChange }: {
  title: string
  body: string
  onRequestChange: (() => void) | null
}) {
  return (
    <div
      role="status"
      data-testid="pi-locked-notice"
      style={{
        display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap',
        border: '1px solid rgba(51,90,134,0.45)', background: colors.brandTint,
        borderRadius: '12px', padding: '12px 16px',
      }}
    >
      <Lock size={18} aria-hidden="true" style={{ color: colors.brand, flexShrink: 0 }} />
      <div style={{ flex: '1 1 260px', minWidth: 0 }}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary }}>{title}</div>
        <div style={{ fontSize: '12.5px', color: colors.secondary, lineHeight: 1.5, marginTop: '2px' }}>{body}</div>
      </div>
      {onRequestChange && (
        <button type="button" className="boe-btn boe-btn-primary" onClick={onRequestChange} aria-haspopup="dialog">
          Request change
        </button>
      )}
    </div>
  )
}
