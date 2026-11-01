'use client'

// ── The sync check: both accounts, every month ──────────────────────────────
//
// The page shows one account and one month; this strip shows what is open in all
// of them, in both directions: credits not matched, and payments with no bank
// credit. When both are zero on both accounts the bank and the records agree,
// because one credit cannot carry more than its amount, so a second payment for
// the same money always lands on the second count. A failed read says so; it
// never draws a tick. The figures are the database's (bank_sync_overview).

import { formatMoney } from '@/lib/finance/piPaymentView'
import { BANK_ACCOUNT_LABEL, type BankAccountKey } from '@/lib/finance/bankStatement'
import { formatBankDate, type SyncOverview } from './bankStatementsModel'

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function BankSyncCheck({ overview, account, onOpen }: {
  overview: SyncOverview | 'failed' | null
  account: BankAccountKey
  /** Show the newest month with something open; `tab` is where it is. */
  onOpen: (account: BankAccountKey, month: string | undefined, tab: 'in' | 'payments') => void
}) {
  if (overview === null) return null
  if (overview === 'failed') {
    return <p className="bank-gap-note" role="alert">The bank check could not be read. Press refresh before relying on this page.</p>
  }
  return (
    <>
      <div className="bank-sync-check" aria-label="Bank check, both accounts">
        {(['hdfc', 'hdfc_sec'] as const).map(a => {
          const months = overview.months.filter(m => m.account === a)
          const notSynced = months.reduce((n, m) => n + m.not_synced, 0)
          const notInBank = months.reduce((n, m) => n + m.not_in_bank, 0)
          const paise = months.reduce((n, m) => n + Math.round(m.not_synced_amount * 100), 0)
          const first = months.find(m => m.not_synced > 0) ?? months[0]
          const uploaded = overview.accounts.includes(a)
          return (
            <button key={a} type="button" className={`bank-sync-card${a === account ? ' is-active' : ''}`} aria-pressed={a === account}
              onClick={() => onOpen(a, first?.month, notSynced > 0 || notInBank === 0 ? 'in' : 'payments')}>
              <strong>{BANK_ACCOUNT_LABEL[a]}</strong>
              {!uploaded && <span className="fin-muted">No statement uploaded yet</span>}
              {uploaded && (
                <>
                  <span className={notSynced > 0 ? 'bank-sync-bad' : 'bank-sync-good'}>
                    {notSynced > 0 ? `${plural(notSynced, 'credit', 'credits')} not matched · ${formatMoney(paise / 100)}` : '✓ All credits matched'}
                  </span>
                  <span className={notInBank > 0 ? 'bank-sync-bad' : 'bank-sync-good'}>
                    {notInBank > 0 ? `${plural(notInBank, 'payment', 'payments')} not in the bank` : '✓ Every payment found in the bank'}
                  </span>
                </>
              )}
            </button>
          )
        })}
      </div>
      {overview.gaps.map(g => (
        <p key={`${g.account}${g.gap_from}`} className="bank-gap-note" role="status">
          {BANK_ACCOUNT_LABEL[g.account]}: no statement uploaded for {formatBankDate(g.gap_from)} to {formatBankDate(g.gap_to)}. Credits on those dates cannot be checked.
        </p>
      ))}
    </>
  )
}
