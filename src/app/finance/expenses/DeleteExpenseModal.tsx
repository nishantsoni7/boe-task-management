'use client'

// ── Removing an expense, with the four facts and one typed word ─────────────
//
// THE DIALOG'S JOB IS TO MAKE THE PERSON CERTAIN WHICH ROW THIS IS. An expense
// list is a column of near-identical lines — ₹500 to Ramesh, ₹500 to Ramesh —
// and the realistic mistake is not "I did not mean to delete anything", it is
// "I deleted the wrong one". So the date, the amount, the payee and the category
// are printed here, large, before anything else, and the typed word is the pause
// that makes somebody read them.
//
// WHAT IT PROMISES, AND WHAT IT DOES NOT. It says the expense will be removed
// from the normal records, and it says a record is kept. It does NOT say
// "permanently deleted" — that would be untrue — and it does not say "soft
// delete", which means nothing to somebody standing in a factory.
//
// THE WRITE IS AN ORDINARY UPDATE. Two columns, through the same two Phase 1
// policies that already allow this person to correct this expense. There is no
// DELETE here, because there is no DELETE policy to reach.

import { useEffect, useRef, useState } from 'react'
import { colors } from '@/lib/tokens'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import { formatMoney } from '@/lib/finance/piPaymentView'
import type { createClient } from '@/lib/supabase/client'
import type { ExpenseRow } from '@/lib/finance/expenses'
import {
  EXPENSE_DELETE_CONFIRMATION,
  EXPENSE_DELETE_EXPLANATION,
  EXPENSE_DELETE_PROMPT,
  EXPENSE_DELETE_RETENTION_NOTE,
  expenseDeleteConfirmationMatches,
  expenseDeleteConfirmationProblem,
  expenseSoftDeletePayload,
} from '@/lib/finance/expenseDeletion'
import { friendlyWriteError } from './ExpenseForm'

type Supabase = ReturnType<typeof createClient>

function fmtDate(value: string): string {
  const at = new Date(`${value}T00:00:00`)
  if (Number.isNaN(at.getTime())) return value
  return at.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function DeleteExpenseModal({
  supabase, userId, expense, categoryName, onClose, onDeleted,
}: {
  supabase: Supabase
  userId: string
  expense: ExpenseRow
  categoryName: string
  onClose: () => void
  onDeleted: (expense: ExpenseRow) => void
}) {
  const [typed, setTyped] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // DOUBLE SUBMISSION IS IMPOSSIBLE, not merely discouraged — the same
  // arrangement the expense form uses. The button is disabled while `deleting`,
  // and this ref is set SYNCHRONOUSLY, so two taps inside one frame both see it
  // even though the state update has not rendered yet.
  const inFlight = useRef(false)

  useEffect(() => { inputRef.current?.focus() }, [])

  const armed = expenseDeleteConfirmationMatches(typed)
  const problem = expenseDeleteConfirmationProblem(typed)

  const remove = async () => {
    if (inFlight.current) return
    // CHECKED AGAIN HERE, not only on the button's disabled attribute: a
    // keyboard Enter, an assistive technology activating a disabled-looking
    // control, or a future refactor of the button must all hit the same gate.
    if (!expenseDeleteConfirmationMatches(typed)) return

    inFlight.current = true
    setDeleting(true)
    setError(null)
    try {
      const { error: dbError } = await supabase
        .from('expenses')
        .update(expenseSoftDeletePayload(userId))
        .eq('id', expense.id)
        // ALREADY DELETED IS NOT DELETED AGAIN. The trigger refuses it anyway;
        // this makes the no-op explicit rather than an exception somebody has
        // to read.
        .is('deleted_at', null)

      if (dbError) { setError(friendlyWriteError(dbError)); return }
      onDeleted(expense)
    } catch {
      setError('The expense could not be deleted. Check your connection and try again.')
    } finally {
      inFlight.current = false
      setDeleting(false)
    }
  }

  return (
    <FinanceModal title="Delete expense" onClose={onClose} width="420px" closeOnBackdropClick={false}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>

        {/* ── THE FOUR FACTS. First, largest, before any instruction. ── */}
        <div
          data-testid="delete-expense-summary"
          style={{
            border: `1px solid ${colors.border}`, borderRadius: '10px',
            background: colors.raised, padding: '12px 14px',
            display: 'flex', flexDirection: 'column', gap: '6px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px' }}>
            <span style={{ fontSize: '14px', fontWeight: 700, color: colors.primary, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {expense.paid_to}
            </span>
            <span style={{ fontSize: '16px', fontWeight: 700, color: colors.primary, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
              {formatMoney(expense.amount)}
            </span>
          </div>
          <div style={{ fontSize: '12px', color: colors.tertiary, lineHeight: 1.5 }}>
            {fmtDate(expense.expense_date)} · {categoryName}
          </div>
        </div>

        <div style={{ fontSize: '12.5px', color: colors.secondary, lineHeight: 1.6 }}>
          {EXPENSE_DELETE_EXPLANATION}
        </div>
        <div style={{ fontSize: '11.5px', color: colors.muted, lineHeight: 1.6 }}>
          {EXPENSE_DELETE_RETENTION_NOTE}
        </div>

        {/* ── The typed word ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          <label htmlFor="expense-delete-confirm" className="boe-input-label">
            {EXPENSE_DELETE_PROMPT}
          </label>
          <input
            id="expense-delete-confirm"
            ref={inputRef}
            className="boe-input"
            value={typed}
            disabled={deleting}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={20}
            placeholder={EXPENSE_DELETE_CONFIRMATION}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? 'expense-delete-confirm-problem' : undefined}
            onChange={e => { setTyped(e.target.value); setError(null) }}
            onKeyDown={e => {
              if (e.key === 'Enter' && armed && !deleting) { e.preventDefault(); void remove() }
            }}
          />
          {problem && (
            <div id="expense-delete-confirm-problem" role="alert" style={{ fontSize: '12px', color: '#C13030', lineHeight: 1.4 }}>
              {problem}
            </div>
          )}
        </div>

        {error && (
          <div role="alert" style={{
            padding: '10px 12px', borderRadius: '8px',
            background: 'rgba(217,79,79,0.1)', color: '#C13030', fontSize: '12px', lineHeight: 1.5,
          }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button
            type="button" onClick={onClose} disabled={deleting}
            className="boe-btn boe-btn-ghost" style={{ minHeight: '44px', fontSize: '13px' }}
          >
            Keep it
          </button>
          <button
            type="button"
            onClick={() => void remove()}
            // DISABLED UNTIL THE WORD MATCHES, and while a delete is in flight.
            // The two conditions are separate facts and both have to hold.
            disabled={!armed || deleting}
            className="boe-btn"
            style={{
              minHeight: '44px', fontSize: '13px', minWidth: '130px', fontWeight: 600,
              background: armed && !deleting ? '#C13030' : 'rgba(217,79,79,0.18)',
              color: armed && !deleting ? '#FFFFFF' : 'rgba(193,48,48,0.65)',
              border: '1px solid rgba(193,48,48,0.35)',
              cursor: armed && !deleting ? 'pointer' : 'not-allowed',
            }}
          >
            {deleting ? 'Deleting…' : 'Delete expense'}
          </button>
        </div>
      </div>
    </FinanceModal>
  )
}
