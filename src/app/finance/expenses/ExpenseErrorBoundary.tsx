'use client'

// ── A CRASH IN ONE PANEL IS NOT A DEAD PAGE ─────────────────────────────────
//
// WHY THIS EXISTS. The Edit crash was one `.trim()` on a number, inside one
// modal. It took down the ENTIRE Expenses route — list, totals, filters, the
// lot — and replaced it with Next.js's generic "This page couldn't load",
// because this application had no React error boundary anywhere in it. A
// rendering error has nowhere to stop, so it stops at the root.
//
// The root cause is fixed in expenses.ts. This is the OTHER half: the next
// malformed record, on a screen nobody has opened yet, should cost the person
// the panel it is in and nothing else.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
//
// IT IS NOT A `try/catch` AROUND A BUG. It does not swallow the error: the
// error is re-thrown to the console through componentDidCatch, so it still
// appears in the browser console and in any error reporting, exactly as it
// would have. What changes is only how much of the screen dies with it.
//
// IT IS NOT A RETRY LOOP EITHER. `reset` clears the captured error once, at the
// person's request. If the same record still throws, the boundary catches it
// again and says so again, rather than flickering.
//
// IT IS SCOPED, NOT GLOBAL. One boundary around the Expenses content, not an
// app-wide net — a global one would quietly change the failure mode of every
// screen in the product, which is not this fix's business.

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { colors } from '@/lib/tokens'

export const EXPENSE_ERROR_TITLE = 'This part of Expenses could not be displayed.'
export const EXPENSE_ERROR_BODY =
  'Nothing has been changed. Use Try again, or reload the page — your expenses are safe.'

type Props = {
  /**
   * Optional so `createElement(Boundary, { label }, child)` type-checks — the
   * form ESLint's react/no-children-prop requires. A boundary with nothing
   * inside it renders nothing, which is the correct answer anyway.
   */
  children?: ReactNode
  /** Named in the console line, so a report says WHICH panel failed. */
  label: string
  /** Cleared alongside the error, so a retry does not reopen what crashed. */
  onReset?: () => void
}

type State = { error: Error | null }

export class ExpenseErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // STILL REPORTED. The boundary changes the blast radius, never the
    // visibility: whoever is debugging sees the same stack they saw before.
    console.error(`[expenses:${this.props.label}]`, error, info.componentStack)
  }

  private reset = () => {
    this.setState({ error: null })
    this.props.onReset?.()
  }

  render() {
    if (this.state.error === null) return this.props.children

    return (
      <div
        role="alert"
        data-testid="expense-error-boundary"
        style={{
          padding: '22px 20px', display: 'flex', flexDirection: 'column',
          alignItems: 'flex-start', gap: '10px',
          border: `1px solid ${colors.border}`, borderRadius: '10px',
          background: colors.raised,
        }}
      >
        <div style={{ fontSize: '13px', fontWeight: 700, color: '#C13030' }}>
          {EXPENSE_ERROR_TITLE}
        </div>
        <div style={{ fontSize: '12.5px', color: colors.secondary, lineHeight: 1.6, maxWidth: '460px' }}>
          {EXPENSE_ERROR_BODY}
        </div>
        <button
          type="button"
          onClick={this.reset}
          className="boe-btn boe-btn-ghost"
          style={{ minHeight: '44px', fontSize: '13px' }}
        >
          Try again
        </button>
      </div>
    )
  }
}
