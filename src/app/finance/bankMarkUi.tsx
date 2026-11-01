'use client'

// ── The bank marker: a chip on the list, a panel in the payment window ──────
//
// Drawn only for a holder of finance.reconcile (the page decides; the bank tables
// are closed to everyone else by RLS anyway). An HDFC payment is VERIFIED HERE:
// verify_payment_with_bank links the credit and verifies in one step, and the
// database refuses it without a credit covering the payment (20270516000000).
// Linking on its own stays a note beside the payment and verifies nothing.
//
// COMPARE, THEN DECIDE. One credit at a time, what Sales entered beside what the bank
// shows. Not this one is a note, not a rule (20270517000000): the credit stops being
// suggested for this payment, and the search can still find it. A credit picked in
// the search gets the same comparison and the same doubts as a suggestion.

import { useState } from 'react'
import Link from 'next/link'
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatMoney, paymentModeLabel } from '@/lib/finance/piPaymentView'
import { BANK_ACCOUNT_LABEL, bankLineId } from '@/lib/finance/bankStatement'
import { amountsClose, payerFromNarration } from '@/lib/finance/bankMatching'
import { toPaise } from '@/lib/finance/bankMoney'
import {
  bankMarkSummary, bankVerifyRefusal, candidateDoubts, compareCandidate, creditHolderAdvice, isBankAccountMode, markCandidates,
  searchBankCredits, searchCandidate,
  type BankCandidate, type BankMark, type BankMarkTone, type SearchCredit,
} from '@/lib/finance/bankMarks'
import { PAYMENT_STATUS_LABEL, creditHref, formatBankDate, paymentHref, rpcMessage } from './bank/bankStatementsModel'

/** What an admin usually means when a payment cannot wait for the next statement. They can change it. */
export const BANK_CHECK_DEFAULT_REASON = 'Seen in the bank app'
export const BANK_CHECK_ACTION = 'Verify, bank check pending'
const REASON_MIN = 3
const REASON_MAX = 200
const VERIFY_LABEL = 'Verify and link'
const SEARCH_CAP = 50

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

function CreditCard({ payment, credit, remaining, best, canVerify, confirmLabel, busy, onVerify, onLink, onReject, onBack }: {
  payment: PanelPayment
  credit: BankCandidate
  /** What this payment still needs covered. */
  remaining: number
  /** The first suggestion, and the only one that may carry the red Verify. */
  best: boolean
  canVerify: boolean
  confirmLabel: string
  busy: boolean
  onVerify: () => void
  onLink: () => void
  /** Not this one. Absent for a credit picked in the search. */
  onReject?: () => void
  /** Back to the search results, for a credit picked there. */
  onBack?: () => void
}) {
  const [asking, setAsking] = useState(false)
  const doubts = candidateDoubts(credit, payment.client_name)
  const covers = toPaise(credit.remaining) >= toPaise(remaining)
  const sure = doubts.length === 0 && best
  const short = !covers && amountsClose(remaining, credit.remaining)
  // What the whole payment would be with this credit, beside anything already linked.
  const bankAmount = (toPaise(payment.amount) - toPaise(remaining) + toPaise(credit.remaining)) / 100
  // When something does not fit, the safe answer is the easy one.
  const rejectFirst = canVerify && covers && credit.sameAccount && !sure && !asking
  return (
    <div className="bank-compare">
      <table className="bank-compare-table">
        <thead><tr><th scope="col" /><th scope="col">Sales entered</th><th scope="col">Bank statement · {bankLineId(credit.statementNo)}</th><th scope="col" /></tr></thead>
        <tbody>
          {compareCandidate(payment, credit, remaining).map(r => (
            <tr key={r.label} className={r.tone === 'differs' ? 'is-differs' : undefined}>
              <th scope="row">{r.label}</th>
              <td>{r.request}</td>
              <td>{r.bank}</td>
              <td className={`is-${r.tone}`}>{r.verdict}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="fin-sub" title={credit.narration}>{credit.narration}</div>
      {doubts.length > 0 && <p className="bank-warn" style={{ fontSize: 13, margin: 0 }}><strong>Check first:</strong> {doubts.join(' and ')}.</p>}
      {short && <p className="fin-muted" style={{ fontSize: 12, margin: 0 }}>If the bank amount is right, edit this payment to {formatMoney(bankAmount)}, then verify it.</p>}
      {!credit.sameAccount && <p className="fin-muted" style={{ fontSize: 12, margin: 0 }}>This credit is in {BANK_ACCOUNT_LABEL[credit.account]}. To use it, correct the payment&apos;s account first.</p>}
      <div className="bank-compare-actions">
        {credit.sameAccount && (
          !canVerify ? (
            <button className="boe-btn boe-btn-ghost" disabled={busy} onClick={onLink}>{confirmLabel}</button>
          ) : !covers ? (
            <button className="boe-btn boe-btn-ghost" disabled={busy} onClick={onLink}>Link this part</button>
          ) : asking ? (
            <>
              <button className="boe-btn boe-btn-ghost" disabled={busy} onClick={() => setAsking(false)}>Keep it waiting</button>
              <button className="boe-btn boe-btn-ghost" disabled={busy} onClick={onVerify}>Yes, verify with this credit</button>
            </>
          ) : sure ? (
            <button className="boe-btn boe-btn-primary" disabled={busy} onClick={onVerify}>{VERIFY_LABEL}</button>
          ) : null
        )}
        {onReject && <button className={`boe-btn ${rejectFirst ? 'boe-btn-primary' : 'boe-btn-ghost'}`} disabled={busy} onClick={onReject}>Not this one</button>}
        {onBack && <button className="boe-btn boe-btn-ghost" disabled={busy} onClick={onBack}>Back to the results</button>}
        {rejectFirst && <button className="boe-btn boe-btn-ghost" disabled={busy} onClick={() => setAsking(true)}>Use this one anyway</button>}
      </div>
    </div>
  )
}

/** Every credit with money left, found by hand, beside what Sales entered. */
function BankSearch({ supabase, payment, need, dismissed, onPick }: {
  supabase: SupabaseClient
  payment: PanelPayment
  need: number
  /** Credits answered Not this one, marked in the results. */
  dismissed: Set<string>
  onPick: (credit: SearchCredit) => void
}) {
  const [text, setText] = useState('')
  const [found, setFound] = useState<SearchCredit[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const run = async () => {
    setBusy(true)
    setFailed(false)
    try {
      setFound(await searchBankCredits(supabase, text.trim()))
    } catch {
      setFound(null)
      setFailed(true)
    }
    setBusy(false)
  }

  return (
    <div className="bank-search">
      <div className="bank-search-side">
        <strong>Sales entered</strong>
        <span>{formatMoney(need)}</span>
        <span>{formatBankDate(payment.payment_date)}</span>
        <span>{paymentModeLabel(payment.payment_mode)}</span>
        <span>{payment.client_name ?? 'Not identified'}</span>
        <span className="fin-muted">{payment.proof_note ?? 'No UTR entered'}</span>
      </div>
      <div className="bank-search-main">
        <label className="bank-field"><span>Search the bank statement</span>
          <span className="bank-search-box">
            <input className="boe-input" value={text} placeholder="Bank Statements ID, name, amount, UTR or date" onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && text.trim().length >= 2) { e.preventDefault(); void run() } }} />
            <button className="boe-btn boe-btn-ghost" disabled={busy || text.trim().length < 2} onClick={run}>{busy ? 'Searching…' : 'Search'}</button>
          </span>
        </label>
        <p className="fin-muted" style={{ fontSize: 12, margin: 0 }}>Only credits with money not matched yet, in both HDFC accounts.</p>
        {failed && <div role="alert" className="bank-error">The bank statement could not be searched. Try again.</div>}
        {found?.length === 0 && <p className="fin-muted bank-panel-note">No credit with money left fits that.</p>}
        {found && found.length > 0 && (
          <div className="bank-others">
            {found.map(c => (
              <div key={c.lineId} className={`bank-result${c.account === payment.payment_mode ? '' : ' is-other'}`}>
                <strong>{bankLineId(c.statementNo)}</strong>
                <span>{formatBankDate(c.lineDate)}</span>
                <span>{BANK_ACCOUNT_LABEL[c.account]}</span>
                <span style={{ minWidth: 0 }}>{payerFromNarration(c.narration) ?? c.narration}</span>
                <strong>{formatMoney(c.remaining)}</strong>
                {dismissed.has(c.lineId) && <span className="fin-muted">Not this one earlier</span>}
                <button className="boe-btn boe-btn-ghost" onClick={() => onPick(c)}>Compare</button>
              </div>
            ))}
            {found.length >= SEARCH_CAP && <p className="fin-muted bank-panel-note">Showing the newest {SEARCH_CAP}. Narrow the search to see older credits.</p>}
          </div>
        )}
      </div>
    </div>
  )
}

/** What the bank shows for this payment, and where an HDFC payment is verified. */
export function BankMatchPanel({ supabase, payment, mark, markFailed = false, canVerify, canVerifyUrgent, confirmLabel = 'Link', onChanged, onReread, onVerified }: {
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
  /** Read the marks again, keeping this window where it is. Defaults to onChanged. */
  onReread?: () => void
  onVerified: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [urgentOpen, setUrgentOpen] = useState(false)
  const [reason, setReason] = useState(BANK_CHECK_DEFAULT_REASON)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [picked, setPicked] = useState<SearchCredit | null>(null)
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
  const mayBeDuplicate = mark.kind === 'lookalike'
  const need = mark.kind === 'suggested' || mark.kind === 'linked' ? mark.remaining : payment.amount
  const focused = candidates.find(c => c.lineId === focusId) ?? candidates[0]
  const others = candidates.filter(c => c !== focused)
  const position = focused ? candidates.indexOf(focused) + 1 : 0
  const dismissedLines = mark.dismissed ?? []
  const showSearch = !covered && (searching || candidates.length === 0)

  // On a possible second record the sentence is theirs to write: the usual reason
  // says the money was seen, and that is true of a credit already recorded too.
  const openUrgent = () => {
    if (mayBeDuplicate) setReason('')
    setUrgentOpen(true)
  }

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

  const reread = onReread ?? onChanged

  const reject = async (lineId: string) => {
    setBusy(lineId)
    setError(null)
    const { error: err } = await supabase.rpc('dismiss_bank_match', { p_payment_id: payment.id, p_line_id: lineId })
    if (err) { refused(err.message, 'That did not save. Try again.'); return }
    setBusy(null)
    setFocusId(null)
    reread()
  }

  const undoReject = async (lineId: string) => {
    setBusy(lineId)
    setError(null)
    const { error: err } = await supabase.rpc('restore_bank_match', { p_payment_id: payment.id, p_line_id: lineId })
    if (err) { refused(err.message, 'That did not save. Try again.'); return }
    setBusy(null)
    reread()
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
      <div className="bank-panel-head">
        <div className="bank-panel-title">Bank statement</div>
        {!picked && !searching && candidates.length > 1 && <span className="fin-muted" style={{ fontSize: 13 }}>Suggestion {position} of {candidates.length}</span>}
      </div>

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

      {picked ? (
        <CreditCard key={picked.lineId} payment={payment} credit={searchCandidate(payment, need, picked)} remaining={need} best canVerify={canVerify}
          confirmLabel={confirmLabel} busy={busy !== null} onVerify={() => verify([picked.lineId])} onLink={() => link(picked.lineId)} onBack={() => setPicked(null)} />
      ) : focused && !searching && (
        <>
          <p className="fin-muted bank-panel-note">
            {fits > 1
              ? 'More than one credit fits this payment. Compare them and pick the right one.'
              : canVerify
                ? 'Check this is the same money, then verify. That links the credit and moves the payment to Confirmed Payments.'
                : 'This looks like the following bank credit.'}
          </p>
          <CreditCard key={focused.lineId} payment={payment} credit={focused} remaining={remaining} best={focused === candidates[0]} canVerify={canVerify}
            confirmLabel={confirmLabel} busy={busy !== null} onVerify={() => verify([focused.lineId])} onLink={() => link(focused.lineId)}
            onReject={() => reject(focused.lineId)} />
          {others.length > 0 && (
            <div className="bank-others">
              <strong style={{ fontSize: 13, paddingBottom: 6 }}>Also possible</strong>
              {others.map(c => (
                <div key={c.lineId} className="bank-other-row">
                  <strong>{bankLineId(c.statementNo)}</strong>
                  <span>{formatBankDate(c.lineDate)}</span>
                  <span>{payerFromNarration(c.narration) ?? c.narration}</span>
                  <strong>{formatMoney(c.remaining)}</strong>
                  <button className="boe-btn boe-btn-ghost" disabled={busy !== null} onClick={() => setFocusId(c.lineId)}>Compare</button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {mark.kind === 'lookalike' && (
        <div className="bank-panel-line">
          <strong>May be a duplicate.</strong> {formatMoney(mark.deposit)} credited on {formatBankDate(mark.lineDate)} is already linked to another payment, so this one cannot be verified unless it is different money with its own credit.
          <div className="fin-sub">{mark.narration}</div>
          {mark.holders.map(h => (
            <div key={h.paymentId} className="bank-row">
              <div style={{ minWidth: 0 }}>
                <div className="fin-primary-text">{h.clientName || 'Suspense payment (no client)'}</div>
                <div className="fin-sub">{h.humanId ?? 'Payment'} · {PAYMENT_STATUS_LABEL[h.status] ?? h.status}</div>
              </div>
              <Link className="boe-btn boe-btn-ghost" href={paymentHref(h.paymentId, h.status)} target="_blank">Open payment</Link>
            </div>
          ))}
          <p className="fin-muted bank-panel-note">{creditHolderAdvice(mark.holders, payment.client_name)}</p>
          <div><Link className="boe-btn boe-btn-ghost" href={creditHref(mark.lineId, mark.lineDate)} target="_blank">Open this credit</Link></div>
        </div>
      )}
      {mark.kind === 'none' && <p className="fin-muted bank-panel-note">The bank statement covers this date, but no credit matches this payment. It may not have arrived yet, or was recorded with a different amount or date. If it came as part of a bigger transfer in another name, add the UTR to this payment and it will show here.</p>}
      {mark.kind === 'uncovered' && <p className="fin-muted bank-panel-note">No bank statement is stored for this date yet. Upload it on the Bank Statements page.</p>}

      {!picked && showSearch && (
        <BankSearch supabase={supabase} payment={payment} need={need} dismissed={new Set(dismissedLines.map(d => d.lineId))} onPick={setPicked} />
      )}
      {!picked && !covered && candidates.length > 0 && (
        <div><button className="bank-link-button" disabled={busy !== null} onClick={() => setSearching(!searching)}>{searching ? 'Back to the suggestions' : 'Search the bank statement'}</button></div>
      )}

      {dismissedLines.map(d => (
        <div key={d.lineId} className="bank-dismissed">
          <span>Not this one: <strong>{bankLineId(d.statementNo)}</strong></span>
          <button className="bank-link-button" disabled={busy !== null} onClick={() => undoReject(d.lineId)}>Undo</button>
        </div>
      ))}

      {error && <div role="alert" className="bank-error">{error}</div>}

      {canVerifyUrgent && !covered && ((candidates.length === 0 && !mayBeDuplicate) || urgentOpen ? (
        <div className="bank-form">
          {mayBeDuplicate && <p className="bank-warn" style={{ fontSize: 12, margin: 0 }}>Only if this is different money. If it is the credit above, verifying here counts the same money twice.</p>}
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
        <div><button className="bank-link-button" disabled={busy !== null} onClick={openUrgent}>{mayBeDuplicate ? 'This is different money, and it cannot wait' : 'The money is in the bank but not on a statement yet'}</button></div>
      ))}
    </div>
  )
}
