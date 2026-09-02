'use client'

// "History" — every credit transaction on one employee's ledger.
//
// This is an AUDIT TRAIL, not a statement to edit: each row is a ledger entry
// that was posted once and will never change. The balance shown at the top is
// what the database derives — SUM(credits) — and the rows below are the whole
// of what it summed. There is nothing to type here; corrections are posted as
// new rows from the management screen, and appear here as such.
//
// Built on PayrollModal so it inherits the BOE Form Modal Dismissal Rule rather
// than restating it. Same construction as IssueHistoryModal.

import { PayrollModal } from '@/components/payroll/PayrollModal'
import { colors } from '@/lib/tokens'
import {
  creditTransactionLabel,
  creditTransactionTone,
  formatCredits,
  sortNewestFirst,
} from '@/lib/boeCredits/ledger'
import type { CreditTransaction } from '@/lib/boeCredits/types'

/** A ledger row as the /api/boe-credits/ledger route returns it: with the actor's name resolved. */
export type CreditHistoryRow = CreditTransaction & { created_by_name?: string | null }

function stamp(at: string): string {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString('en-IN')
}

function actorLabel(row: CreditHistoryRow): string {
  if (row.created_by == null) return 'System'
  return row.created_by_name ?? 'An administrator'
}

export function CreditHistoryModal({
  transactions, availableCredits, employeeLabel, onClose,
}: {
  transactions: CreditHistoryRow[]
  availableCredits: number
  /** "You" on the employee's own page; the employee's name for an admin. */
  employeeLabel: string
  onClose: () => void
}) {
  const rows = sortNewestFirst(transactions)

  return (
    <PayrollModal
      title="BOE Credits history"
      subtitle={employeeLabel}
      onClose={onClose}
      width={520}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', flexShrink: 0 }}>
        <span style={{
          fontSize: 19, fontWeight: 600, color: colors.primary,
          fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.01em',
        }}>
          {formatCredits(availableCredits)}
        </span>
        <span style={{ fontSize: 12, color: colors.muted }}>
          available · {rows.length === 1 ? '1 entry' : `${rows.length} entries`}
        </span>
      </div>

      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: colors.muted, padding: '8px 0' }}>
          No credit transactions yet.
        </div>
      ) : (
        <ol style={{
          listStyle: 'none', margin: 0, padding: 0,
          display: 'flex', flexDirection: 'column', gap: 12,
        }}>
          {rows.map(row => {
            const t = creditTransactionTone(row)
            return (
              <li key={row.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                {/* The rail: one dot per entry, coloured by what happened. */}
                <span
                  aria-hidden="true"
                  style={{
                    width: 8, height: 8, borderRadius: '50%', background: t.dot,
                    marginTop: 6, flexShrink: 0,
                  }}
                />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: t.fg }}>
                      {creditTransactionLabel(row.transaction_type)}
                    </span>
                    <span style={{
                      fontSize: 13, fontWeight: 600, color: row.credits < 0 ? '#B91C1C' : '#047857',
                      fontVariantNumeric: 'tabular-nums',
                    }}>
                      {formatCredits(row.credits, { signed: true })}
                    </span>
                    <span style={{ fontSize: 11.5, color: colors.muted }}>
                      {actorLabel(row)} · {stamp(row.created_at)}
                    </span>
                  </div>
                  {row.description && (
                    <div style={{
                      fontSize: 12.5, color: '#3D4455', lineHeight: 1.55, marginTop: 3,
                      whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    }}>
                      {row.description}
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
