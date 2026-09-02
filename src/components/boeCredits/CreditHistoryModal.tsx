'use client'

// "History" — every credit transaction on one employee's ledger.
//
// This is an AUDIT TRAIL, not a statement to edit: each row is a ledger entry
// that was posted once and will never change. The balances shown at the top
// are what the database derives, and the rows below are the whole of what it
// summed. There is nothing to type here; corrections are posted as new rows
// from the management screen, and appear here as such.
//
// EACH ROW SAYS WHAT IT WAS FOR IN WORDS — "Half Day covered · 12 Aug 2026",
// "Review verified · September", "Applied to September 2026 payroll" — and a
// review reward carries whether its credit can be spent yet. The sentences
// come from the ledger route, which joins the record tables; no database code
// reaches this screen.
//
// Built on PayrollModal so it inherits the BOE Form Modal Dismissal Rule rather
// than restating it. Same construction as IssueHistoryModal.

import { useState } from 'react'
import { PayrollModal } from '@/components/payroll/PayrollModal'
import { colors } from '@/lib/tokens'
import {
  creditTransactionLabel,
  creditTransactionTone,
  formatCredits,
  sortNewestFirst,
  REWARD_STATUS_LABELS,
  type CreditTransactionDescription,
} from '@/lib/boeCredits/ledger'
import type { CreditTransaction } from '@/lib/boeCredits/types'

/** A ledger row as the /api/boe-credits/ledger route returns it: explained, with the balance after it. */
export type CreditHistoryRow = CreditTransaction & {
  created_by_name?: string | null
  title?: string
  detail?: string | null
  status?: CreditTransactionDescription['status']
  balance_after?: number
}

function stamp(at: string): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return at
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function actorLabel(row: CreditHistoryRow): string | null {
  if (row.transaction_type === 'admin_adjustment' || row.transaction_type === 'reversal' || row.transaction_type === 'review_month_lapse') {
    return row.created_by == null ? 'System' : row.created_by_name ?? 'An administrator'
  }
  return null
}

const STATUS_TONE: Record<NonNullable<CreditTransactionDescription['status']>, { bg: string; fg: string }> = {
  pending:   { bg: 'rgba(232,160,48,0.14)', fg: '#92400E' },
  available: { bg: 'rgba(5,150,105,0.12)',  fg: '#047857' },
  lapsed:    { bg: 'rgba(220,38,38,0.10)',  fg: '#B91C1C' },
  reversed:  { bg: 'rgba(140,148,166,0.16)', fg: '#4B5563' },
}

export function CreditHistoryModal({
  transactions, availableCredits, spendableCredits, provisionalCredits, employeeLabel, onClose, onReverse,
}: {
  transactions: CreditHistoryRow[]
  /** The recorded total. */
  availableCredits: number
  spendableCredits?: number
  provisionalCredits?: number
  /** "You" on the employee's own page; the employee's name for an admin. */
  employeeLabel: string
  onClose: () => void
  /**
   * Admin only: reverse ONE entry with a reason. Absent for the employee, so
   * the control is absent rather than disabled. Resolves to null on success,
   * or the message to show.
   */
  onReverse?: (row: CreditHistoryRow, reason: string) => Promise<string | null>
}) {
  const rows = sortNewestFirst(transactions)
  const spendable = spendableCredits ?? availableCredits
  const provisional = provisionalCredits ?? 0
  const reversedIds = new Set(rows.filter(r => r.transaction_type === 'reversal' && r.source_id).map(r => r.source_id as string))

  const [reversing, setReversing] = useState<string | null>(null)
  const [reason,    setReason]    = useState('')
  const [busy,      setBusy]      = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  const canReverse = (row: CreditHistoryRow) =>
    !!onReverse
    && row.transaction_type !== 'reversal'
    && row.transaction_type !== 'review_month_lapse'
    && !reversedIds.has(row.id)
    && row.status !== 'lapsed'

  const confirmReverse = async (row: CreditHistoryRow) => {
    if (!onReverse || busy) return
    setBusy(true)
    setError(null)
    const failure = await onReverse(row, reason.trim())
    setBusy(false)
    if (failure) { setError(failure); return }
    setReversing(null)
    setReason('')
  }

  return (
    <PayrollModal
      title="BOE Credits history"
      subtitle={employeeLabel}
      onClose={onClose}
      width={560}
    >
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', flexShrink: 0, alignItems: 'baseline' }}>
        <div>
          <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.09em', color: colors.muted }}>Spendable</div>
          <div style={{ fontSize: 19, fontWeight: 700, color: colors.primary, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.01em' }}>
            {formatCredits(spendable)}
          </div>
        </div>
        {provisional > 0 && (
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.09em', color: colors.muted }}>Pending target</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#92400E', fontVariantNumeric: 'tabular-nums' }}>{formatCredits(provisional)}</div>
          </div>
        )}
        <div>
          <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.09em', color: colors.muted }}>Recorded</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: colors.tertiary, fontVariantNumeric: 'tabular-nums' }}>{formatCredits(availableCredits)}</div>
        </div>
        <span style={{ fontSize: 12, color: colors.muted, marginLeft: 'auto' }}>
          {rows.length === 1 ? '1 entry' : `${rows.length} entries`}
        </span>
      </div>

      {error && (
        <div role="alert" style={{ fontSize: 12.5, color: '#B91C1C', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 8, padding: '8px 12px' }}>
          {error}
        </div>
      )}

      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: colors.muted, padding: '8px 0' }}>
          No credit transactions yet.
        </div>
      ) : (
        <ol style={{
          listStyle: 'none', margin: 0, padding: 0,
          display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          {rows.map(row => {
            const t = creditTransactionTone(row)
            const actor = actorLabel(row)
            return (
              <li key={row.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                {/* The rail: one dot per entry, coloured by what happened. */}
                <span
                  aria-hidden="true"
                  style={{ width: 8, height: 8, borderRadius: '50%', background: t.dot, marginTop: 7, flexShrink: 0 }}
                />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: t.fg }}>
                      {row.title ?? creditTransactionLabel(row.transaction_type)}
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: row.credits < 0 ? '#B91C1C' : '#047857', fontVariantNumeric: 'tabular-nums' }}>
                      {formatCredits(row.credits, { signed: true })}
                    </span>
                    {row.status && (
                      <span style={{
                        fontSize: 10.5, fontWeight: 700, padding: '1px 8px', borderRadius: 20, whiteSpace: 'nowrap',
                        background: STATUS_TONE[row.status].bg, color: STATUS_TONE[row.status].fg,
                      }}>
                        {REWARD_STATUS_LABELS[row.status]}
                      </span>
                    )}
                    <span style={{ fontSize: 11.5, color: colors.muted, marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                      {stamp(row.created_at)}
                      {typeof row.balance_after === 'number' && (
                        <span title="Recorded balance after this entry"> · {row.balance_after.toLocaleString('en-IN')} after</span>
                      )}
                    </span>
                  </div>
                  {(row.detail || actor) && (
                    <div style={{ fontSize: 12, color: '#5B6474', lineHeight: 1.5, marginTop: 2, wordBreak: 'break-word' }}>
                      {[row.detail, actor ? `by ${actor}` : null].filter(Boolean).join(' · ')}
                    </div>
                  )}
                  {/* The admin's one control, and only where the database would accept it. */}
                  {canReverse(row) && reversing !== row.id && (
                    <button
                      type="button"
                      onClick={() => { setReversing(row.id); setReason(''); setError(null) }}
                      disabled={busy}
                      style={{ marginTop: 4, fontSize: 11.5, color: '#B45309', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textDecoration: 'underline' }}
                    >
                      Reverse this entry
                    </button>
                  )}
                  {reversing === row.id && (
                    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <input
                        type="text"
                        value={reason}
                        onChange={e => setReason(e.target.value)}
                        placeholder="Why this entry is being reversed (recorded permanently)"
                        maxLength={500}
                        className="boe-input"
                        style={{ fontSize: 12.5 }}
                        autoFocus
                      />
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          type="button"
                          onClick={() => void confirmReverse(row)}
                          disabled={busy || reason.trim() === ''}
                          className="boe-btn boe-btn-primary"
                          style={{ padding: '5px 12px', fontSize: 12 }}
                        >
                          {busy ? 'Reversing…' : `Reverse ${formatCredits(Math.abs(row.credits))}`}
                        </button>
                        <button
                          type="button"
                          onClick={() => { setReversing(null); setError(null) }}
                          disabled={busy}
                          className="boe-btn boe-btn-ghost"
                          style={{ padding: '5px 12px', fontSize: 12 }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      )}

      <div style={{ fontSize: 11.5, color: colors.muted, lineHeight: 1.5, flexShrink: 0 }}>
        Credits carry forward. Every entry here is permanent — a correction is
        recorded as a new entry, never by changing an old one.
      </div>
    </PayrollModal>
  )
}
