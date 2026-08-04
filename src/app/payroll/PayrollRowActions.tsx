'use client'

// The Payroll dashboard's row controls: one text action, icon buttons for the
// rest, and an icon for Attention that opens the detail rather than printing it
// into the cell.
//
// Why these live outside page.tsx: a table row's controls are a rendering
// contract worth asserting ("a locked row shows Unlock as an icon and nothing
// else", "no row carries the words Lock Payroll"), and none of that is testable
// while it is buried inside a page component that opens with a session fetch.
// Every component here is deliberately hook-free, so a test can call it as a
// plain function and check the wiring as well as the markup.
//
// Nothing here decides what a row may do — payrollRowActions() and
// payrollAttention() do, and they are shared with the tests.

import { AlertTriangle, Eye, History, Lock, RefreshCw, Unlock } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { PayrollModal } from '@/components/payroll/PayrollModal'
import {
  PAYROLL_ACTION_LABELS,
  PAYROLL_ATTENTION_ARIA_LABEL,
  PAYROLL_ROW_ACTION_PRESENTATION,
  payrollRowActions,
  type PayrollAttentionDetail,
  type PayrollPeriodAction,
} from '@/lib/payroll/periodActions'
import type { PeriodStatus } from '@/lib/payroll/correctionRules'

/**
 * Row-scoped CSS, rendered once by the page.
 *
 * Colocated with the components it styles (unique `boe-payroll-` names) rather
 * than appended to the shared global stylesheet: hover, focus and disabled
 * states must ship with the row, and a hover rule cannot be written inline at
 * all. The 34px icon buttons themselves reuse .boe-record-action--icon from the
 * design system — this adds only what inline styles cannot express.
 */
export const PAYROLL_ROW_CSS = `
  .boe-payroll-row { transition: background 0.25s ease; }
  /* Subtle enough to read as "this row", not as a selection. */
  .boe-payroll-row:hover { background: #FAFBFC; }

  .boe-payroll-attention {
    -webkit-appearance: none;
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.16s ease, border-color 0.16s ease;
  }
  .boe-payroll-attention:focus-visible { outline: 2px solid #5585E8; outline-offset: 2px; }

  .boe-payroll-attention--amber { background: rgba(232,160,48,0.14); border: 1px solid rgba(232,160,48,0.42); color: #B45309; }
  .boe-payroll-attention--amber:hover { background: rgba(232,160,48,0.24); border-color: rgba(232,160,48,0.62); }

  .boe-payroll-attention--info { background: rgba(85,133,232,0.10); border: 1px solid rgba(85,133,232,0.34); color: #3A6BD4; }
  .boe-payroll-attention--info:hover { background: rgba(85,133,232,0.18); border-color: rgba(85,133,232,0.52); }

  /* The actions cell never wraps — a row whose controls stack is a row whose
     height no longer matches its neighbours. The table scrolls inside its own
     card instead, which it already did. */
  .boe-payroll-actions { display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; }

  /* The text action is sized to the 34px icon buttons beside it, so every
     control in the row shares one baseline. Written as a rule rather than an
     inline height on purpose — an inline min-height would outrank the mobile
     44px touch target in globals.css, and shrink the one control a thumb has to
     hit. */
  .boe-payroll-actions .boe-btn { min-height: 34px; padding: 0 14px; }

  @media (max-width: 767px) {
    /* Touch: the row keeps all of its controls, at a size a thumb can hit. */
    .boe-payroll-actions .boe-btn { min-height: 44px; }
    .boe-payroll-actions .boe-record-action--icon { width: 40px; min-width: 40px; min-height: 40px; }
    .boe-payroll-attention { width: 38px; height: 38px; }
  }
`

// ─── Row actions ──────────────────────────────────────────────────────────────

const ACTION_ICON: Record<PayrollPeriodAction, typeof RefreshCw> = {
  view:       Eye,
  generate:   RefreshCw,
  regenerate: RefreshCw,
  lock:       Lock,
  unlock:     Unlock,
}

/** Per-action colour for the icon buttons. Neutral unless the action says otherwise. */
const ICON_TONE: Partial<Record<PayrollPeriodAction, React.CSSProperties>> = {
  // Locking is the consequential one, so it reads darker than its neighbour.
  lock:   { color: '#111318' },
  // Reopening a finalised month is an amber decision, outlined not filled: the
  // one filled button in the row stays the primary action.
  unlock: { color: '#B45309', borderColor: 'rgba(232,160,48,0.55)' },
}

export type PayrollRowActionBarProps = {
  status: PeriodStatus
  /** True while a generation for this row is in flight. */
  isBusy: boolean
  onGenerate: () => void
  onLock: () => void
  onUnlock: () => void
  onViewResults: () => void
}

export function PayrollRowActionBar({
  status, isBusy, onGenerate, onLock, onUnlock, onViewResults,
}: PayrollRowActionBarProps) {
  const { primary, secondary } = payrollRowActions(status)

  const run: Record<PayrollPeriodAction, () => void> = {
    view:       onViewResults,
    generate:   onGenerate,
    regenerate: onGenerate,
    lock:       onLock,
    unlock:     onUnlock,
  }

  // Only the two engine actions are long-running, so only they show progress
  // and only they are blocked while one is in flight.
  const isRunning = (a: PayrollPeriodAction) => a === 'generate' || a === 'regenerate'

  const control = (action: PayrollPeriodAction, kind: 'primary' | 'secondary') => {
    const busy  = isBusy && isRunning(action)
    const label = PAYROLL_ACTION_LABELS[action]
    const Icon  = ACTION_ICON[action]

    if (PAYROLL_ROW_ACTION_PRESENTATION[action] === 'text') {
      return (
        <button
          key={action}
          type="button"
          onClick={run[action]}
          disabled={busy}
          aria-busy={busy || undefined}
          title={label}
          className={`boe-btn ${kind === 'primary' ? 'boe-btn-primary' : 'boe-btn-ghost'}`}
          style={{ whiteSpace: 'nowrap' }}
        >
          <Icon size={14} strokeWidth={2} aria-hidden="true" />
          {busy ? 'Working…' : label}
        </button>
      )
    }

    return (
      <button
        key={action}
        type="button"
        onClick={run[action]}
        disabled={busy}
        aria-busy={busy || undefined}
        // The icon carries no text, so the label has to reach both assistive
        // technology and a sighted user who does not recognise the glyph.
        aria-label={label}
        title={label}
        className="boe-record-action boe-record-action--icon"
        style={ICON_TONE[action]}
      >
        <Icon size={15} strokeWidth={2} aria-hidden="true" />
      </button>
    )
  }

  return (
    <div className="boe-payroll-actions">
      {control(primary, 'primary')}
      {secondary.map(a => control(a, 'secondary'))}
    </div>
  )
}

// ─── Attention ────────────────────────────────────────────────────────────────

/**
 * The Attention cell: an icon, or nothing to say.
 *
 * The warning text it replaces was the reason rows had uneven heights — a
 * two-line staleness note beside a one-line neighbour. The sentence has not
 * been dropped, it moved into the popup this opens.
 */
export function PayrollAttentionIndicator({
  detail, onOpen,
}: { detail: PayrollAttentionDetail | null; onOpen: () => void }) {
  if (!detail) {
    return <span style={{ fontSize: 12.5, color: '#8C94A6' }}>—</span>
  }

  const Icon = detail.tone === 'amber' ? AlertTriangle : History

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={PAYROLL_ATTENTION_ARIA_LABEL}
      aria-haspopup="dialog"
      // Colour alone never carries the meaning: the tooltip names the state.
      title={detail.title}
      className={`boe-payroll-attention boe-payroll-attention--${detail.tone}`}
    >
      <Icon size={16} strokeWidth={2.2} aria-hidden="true" />
    </button>
  )
}

export type PayrollReopenNote = {
  actorName: string | null
  at: string
  reason: string | null
}

/**
 * The Attention detail, in the module's existing dialog shell.
 *
 * Deliberately short: what happened, which period, when it was last generated,
 * what to do, and the one button that starts doing it. The full lock/unlock
 * history is not an admin's first question on this screen, and printing it here
 * would rebuild the tall cell this popup exists to remove.
 */
export function PayrollAttentionModal({
  detail, periodLabel, lastGeneratedLabel, reopened, onAct, onClose,
}: {
  detail: PayrollAttentionDetail
  periodLabel: string
  lastGeneratedLabel: string
  reopened: PayrollReopenNote | null
  onAct: (action: PayrollPeriodAction) => void
  onClose: () => void
}) {
  return (
    <PayrollModal title={detail.title} onClose={onClose} width={420}>
      <div style={{ fontSize: 13, color: colors.secondary, lineHeight: 1.55 }}>
        {detail.body}
      </div>

      <dl style={{
        display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '5px 14px',
        margin: 0, fontSize: 12,
      }}>
        <dt style={{ color: colors.muted }}>Payroll period</dt>
        <dd style={{ margin: 0, color: colors.primary, fontWeight: 600 }}>{periodLabel}</dd>
        <dt style={{ color: colors.muted }}>Last generated</dt>
        <dd style={{ margin: 0, color: colors.primary }}>{lastGeneratedLabel}</dd>
      </dl>

      {detail.steps.length > 0 && (
        <ol style={{
          margin: 0, paddingLeft: 18, fontSize: 12.5,
          color: colors.secondary, lineHeight: 1.7,
        }}>
          {detail.steps.map(s => <li key={s}>{s}</li>)}
        </ol>
      )}

      {detail.steps.length === 0 && detail.action === 'regenerate' && (
        <div style={{ fontSize: 12.5, color: colors.secondary, lineHeight: 1.55 }}>
          Regenerate this payroll so the results match the corrected attendance.
        </div>
      )}

      {reopened && (
        <div style={{
          fontSize: 11.5, color: colors.secondary, lineHeight: 1.5,
          background: 'rgba(85,133,232,0.08)', borderRadius: 8, padding: '8px 10px',
        }}>
          <span style={{ fontWeight: 600, color: '#3A6BD4' }}>Reopened after locking</span>
          {' · '}
          {reopened.actorName ?? 'Unknown admin'} · {reopened.at}
          {reopened.reason && (
            <div style={{ color: colors.tertiary, marginTop: 3 }}>“{reopened.reason}”</div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', paddingTop: 2 }}>
        <button
          type="button"
          onClick={onClose}
          className="boe-btn boe-btn-ghost"
          style={{ padding: '8px 18px', fontSize: 13 }}
        >
          Close
        </button>
        {detail.action && (
          <button
            type="button"
            onClick={() => onAct(detail.action!)}
            className="boe-btn boe-btn-primary"
            style={{ padding: '8px 18px', fontSize: 13 }}
          >
            {PAYROLL_ACTION_LABELS[detail.action]}
          </button>
        )}
      </div>
    </PayrollModal>
  )
}
