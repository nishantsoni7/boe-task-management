'use client'

// ── The bank marker: a chip on the list, a panel in the payment window ──────
//
// Drawn only for a holder of finance.reconcile (the page decides; the bank tables
// are closed to everyone else by RLS anyway). An HDFC payment is VERIFIED HERE:
// verify_payment_with_bank links the credit and verifies in one step, and the
// database refuses it without a credit covering the payment (20270516000000).
// Linking on its own stays a note beside the payment and verifies nothing.

import { useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatMoney } from '@/lib/finance/piPaymentView'
import { BANK_ACCOUNT_LABEL } from '@/lib/finance/bankStatement'
import { amountsClose } from '@/lib/finance/bankMatching'
import { toPaise } from '@/lib/finance/bankMoney'
import {
  bankMarkSummary, bankVerifyRefusal, candidateDoubts, compareCandidate, isBankAccountMode, markCandidates,
  type BankCandidate, type BankMark, type BankMarkTone,
} from '@/lib/finance/bankMarks'
import { formatBankDate, rpcMessage } from './bank/bankStatementsModel'

/** What an admin usually means when a payment cannot wait for the next statement. They can change it. */
export const BANK_CHECK_DEFAULT_REASON = 'Seen in the bank app'
export const BANK_CHECK_ACTION = 'Verify, bank check pending'
const REASON_MIN = 3
const REASON_MAX = 200

export function bankMarkText(mark: BankMark): { text: string; tone: BankMarkTone; title: string } {
  const { text, tone } = bankMarkSummary(mark)
  switch (mark.kind) {
    case 'linked':
      return { text, tone, title: mark.complete ? `Linked to the bank credit of ${formatBankDate(mark.links[0].lineDate)}` : 'Only part of this payment is linked to bank credits' }
    case 'suggested': {
      const best = mark.candidates[0]
      return { text, tone, title: `${formatMoney(best.deposit)} credited on ${formatBankDate(best.lineDate)} looks like this payment. Open the payment to verify it.` }
    }
    case 'lookalike':
      return { text, tone, title: `The bank credit of ${formatBankDate(mark.lineDate)} is already linked to another payment` }
    case 'none':
      return { text, tone, title: 'The statement covers this date, but no credit matches this payment' }
    case 'uncovered':
      return { text, tone, title: 'No bank statement stored for this date yet' }
  }
}

/** The small line under a payment's status in the list. */
export function BankMarkChip({ mark }: { mark: BankMark | undefined }) {
  if (!mark) return null
  const t = bankMarkText(mark)
  return <span className={`bank-mark bank-mark--${t.tone}`} title={t.title}>{t.text}</span>
}

/** A payment's PI is waiting for this decision before it can be approved. */
export function PiWaitingChip() {
  return <span className="bank-mark bank-mark--warn" title="This payment's PI cannot be approved until this payment is decided">PI waiting</span>
}

type PanelPayment = {
  id: string
  amount: number
  client_name: string | null
  payment_date: string
  payment_mode: string
  proof_note: string | null
}

function CreditCard({ payment, credit, remaining, best, canVerify, confirmLabel, busy, onVerify, onLink }: {
  payment: PanelPayment
  credit: BankCandidate
  /** What this payment still needs covered. */
  remaining: number
  /** The first card, and the only one that may carry the red button. */
  best: boolean
  canVerify: boolean
  confirmLabel: string
  busy: boolean
  onVerify: () => void
  onLink: () => void
}) {
  const [asking, setAsking] = useState(false)
  const doubts = candidateDoubts(credit, payment.client_name)
  const covers = toPaise(credit.remaining) >= toPaise(remaining)
  const sure = doubts.length === 0 && best
  const short = !covers && amountsClose(remaining, credit.remaining)
  // What the whole payment would be with this credit, beside anything already linked.
  const bankAmount = (toPaise(payment.amount) - toPaise(remaining) + toPaise(credit.remaining)) / 100
  return (
    <div className="bank-compare">
      <div className="bank-compare-head">
        <strong>Credit of {formatBankDate(credit.lineDate)}</strong>
        <span className="fin-sub">{BANK_ACCOUNT_LABEL[credit.account]}</span>
      </div>
      <table className="bank-compare-table">
        <thead><tr><th scope="col" /><th scope="col">Payment request</th><th scope="col">Bank credit</th><th scope="col" /></tr></thead>
        <tbody>
          {compareCandidate(payment, credit, remaining).map(r => (
            <tr key={r.label}>
              <th scope="row">{r.label}</th>
              <td>{r.request}</td>
              <td>{r.bank}</td>
              <td className={`is-${r.tone}`}>{r.verdict}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="fin-sub" title={credit.narration}>{credit.narration}</div>
      {doubts.length > 0 && <p className="bank-warn" style={{ fontSize: 12, margin: 0 }}>Check first: {doubts.join(' and ')}.</p>}
      {short && <p className="fin-muted" style={{ fontSize: 12, margin: 0 }}>If the bank amount is right, edit this payment to {formatMoney(bankAmount)}, then verify it.</p>}
      {!credit.sameAccount ? (
        <p className="fin-muted" style={{ fontSize: 12, margin: 0 }}>Correct the payment&apos;s account first.</p>
      ) : !canVerify ? (
        <div><button className="boe-btn boe-btn-ghost" disabled={busy} onClick={onLink}>{confirmLabel}</button></div>
      ) : !covers ? (
        <div><button className="boe-btn boe-btn-ghost" disabled={busy} onClick={onLink}>Link this part</button></div>
      ) : asking ? (
        <div className="bank-actions">
          <button className="boe-btn boe-btn-ghost" disabled={busy} onClick={() => setAsking(false)}>Keep it waiting</button>
          <button className="boe-btn boe-btn-ghost" disabled={busy} onClick={onVerify}>Yes, verify with this credit</button>
        </div>
      ) : sure ? (
        <div><button className="boe-btn boe-btn-primary" disabled={busy} onClick={onVerify}>Verify</button></div>
      ) : (
        <div><button className="boe-btn boe-btn-ghost" disabled={busy} onClick={() => setAsking(true)}>Use this one anyway</button></div>
      )}
    </div>
  )
}

/** What the bank shows for this payment, and where an HDFC payment is verified. */
export function BankMatchPanel({ supabase, payment, mark, markFailed = false, canVerify, canVerifyUrgent, confirmLabel = 'Link', onChanged, onVerified }: {
  supabase: SupabaseClient
  payment: PanelPayment
  /** Undefined while it is being read. */
  mark: BankMark | undefined
  /** The read failed: nobody can tell from this what the bank shows. */
  markFailed?: boolean
  /** May verify: finance.approve, pending, and not their own unless they may verify their own. */
  canVerify: boolean
  /** An active admin, on a pending HDFC payment: may verify before the credit is seen. */
  canVerifyUrgent: boolean
  /** What the button on a card says when it only links. */
  confirmLabel?: string
  onChanged: () => void
  onVerified: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [urgentOpen, setUrgentOpen] = useState(false)
  const [reason, setReason] = useState(BANK_CHECK_DEFAULT_REASON)
  if (!isBankAccountMode(payment.payment_mode)) return null
  if (!mark) {
    return (
      <div className="bank-panel">
        <div className="bank-panel-title">Bank statement</div>
        {markFailed
          ? <div role="alert" className="bank-error">The bank statement could not be read, so this payment cannot be checked yet. Close this window and open it again.</div>
          : <p className="fin-muted bank-panel-note">Reading the bank statement…</p>}
      </div>
    )
  }

  const candidates = markCandidates(mark)
  const remaining = mark.kind === 'suggested' || mark.kind === 'linked' ? mark.remaining : 0
  const fits = candidates.filter(c => c.amountExact).length
  const covered = mark.kind === 'linked' && mark.complete

  const refused = (message: string | undefined, fallback: string) => {
    setBusy(null)
    setError(bankVerifyRefusal(message) ?? fallback)
  }

  const link = async (lineId: string) => {
    setBusy(lineId)
    setError(null)
    const { error: err } = await supabase.rpc('link_bank_line_to_payment', { p_line_id: lineId, p_payment_id: payment.id })
    if (err) { refused(err.message, rpcMessage(err, 'That did not link. Try again.')); return }
    setBusy(null)
    onChanged()
  }

  const verify = async (lineIds: string[]) => {
    setBusy(lineIds[0] ?? 'verify')
    setError(null)
    const { error: err } = await supabase.rpc('verify_payment_with_bank', { p_payment_id: payment.id, p_line_ids: lineIds })
    if (err) { refused(err.message, 'The payment could not be verified. Try again.'); return }
    onVerified()
  }

  const verifyUrgent = async () => {
    setBusy('urgent')
    setError(null)
    const { error: err } = await supabase.rpc('verify_payment_bank_check_pending', { p_payment_id: payment.id, p_reason: reason.trim() })
    if (err) { refused(err.message, 'The payment could not be verified. Try again.'); return }
    onVerified()
  }

  return (
    <div className="bank-panel">
      <div className="bank-panel-title">Bank statement</div>

      {mark.kind === 'linked' && mark.links.map(l => (
        <div key={l.lineId} className="bank-panel-line">
          <strong>{formatMoney(l.amount)}</strong> linked to the bank credit of {formatBankDate(l.lineDate)}
          <div className="fin-sub">{l.narration}</div>
        </div>
      ))}
      {mark.kind === 'linked' && !covered && (
        <p className="fin-muted bank-panel-note">{formatMoney(mark.remaining)} of this payment still needs a bank credit.</p>
      )}
      {mark.kind === 'linked' && mark.otherAccount && (
        <p className="bank-warn" style={{ fontSize: 12, margin: 0 }}>A linked credit is in the other HDFC account, so it does not count. Correct this payment&apos;s account, or unlink that credit on Bank Statements.</p>
      )}
      {covered && canVerify && (
        <div><button className="boe-btn boe-btn-primary" disabled={busy !== null} onClick={() => verify([])}>Verify</button></div>
      )}

      {candidates.length > 0 && (
        <p className="fin-muted bank-panel-note">
          {fits > 1
            ? 'More than one credit fits this payment. Pick the right one.'
            : canVerify
              ? 'Check this is the same money, then verify. That links the credit and moves the payment to Confirmed Payments.'
              : 'This looks like the following bank credit.'}
        </p>
      )}
      {candidates.map((c, i) => (
        <CreditCard key={c.lineId} payment={payment} credit={c} remaining={remaining} best={i === 0} canVerify={canVerify}
          confirmLabel={confirmLabel} busy={busy !== null} onVerify={() => verify([c.lineId])} onLink={() => link(c.lineId)} />
      ))}

      {mark.kind === 'lookalike' && (
        <div className="bank-panel-line">
          <strong>May be a duplicate.</strong> {formatMoney(mark.deposit)} credited on {formatBankDate(mark.lineDate)} is already linked to another payment, so this one cannot be verified unless it is different money with its own credit.
          <div className="fin-sub">{mark.narration}</div>
        </div>
      )}
      {mark.kind === 'none' && <p className="fin-muted bank-panel-note">The bank statement covers this date, but no credit matches this payment. It may not have arrived yet, or was recorded with a different amount or date. If it came as part of a bigger transfer in another name, add the UTR to this payment and it will show here.</p>}
      {mark.kind === 'uncovered' && <p className="fin-muted bank-panel-note">No bank statement is stored for this date yet. Upload it on the Bank Statements page.</p>}

      {error && <div role="alert" className="bank-error">{error}</div>}

      {canVerifyUrgent && !covered && (candidates.length === 0 || urgentOpen ? (
        <div className="bank-form">
          <label className="bank-field"><span>Why can this not wait for the statement? *</span>
            <input className="boe-input" value={reason} onChange={e => setReason(e.target.value)} maxLength={REASON_MAX} />
          </label>
          <p className="fin-muted" style={{ fontSize: 12, margin: 0 }}>It counts now. You confirm the match after your next upload.</p>
          <div>
            <button className="boe-btn boe-btn-ghost" disabled={busy !== null || reason.trim().length < REASON_MIN} onClick={verifyUrgent}>
              {busy === 'urgent' ? 'Verifying…' : BANK_CHECK_ACTION}
            </button>
          </div>
        </div>
      ) : (
        <div><button className="bank-link-button" disabled={busy !== null} onClick={() => setUrgentOpen(true)}>The money is in the bank but not on a statement yet</button></div>
      ))}
    </div>
  )
}
