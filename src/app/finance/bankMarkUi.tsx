'use client'

// ── The bank marker: a chip on the list, a panel in the review window ───────
//
// Information for the person verifying, drawn only for a holder of
// finance.reconcile (the page decides; the bank tables are closed to everyone
// else by RLS anyway). LINKING FROM HERE IS A NOTE BESIDE THE PAYMENT, exactly as
// on the Bank Statements page: it never verifies, rejects or edits the payment.

import { useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatMoney } from '@/lib/finance/piPaymentView'
import { BANK_ACCOUNT_LABEL } from '@/lib/finance/bankStatement'
import type { BankMark } from '@/lib/finance/bankMarks'
import { formatBankDate, rpcMessage } from './bank/bankStatementsModel'

const CONFIDENCE = { strong: 'Strong', likely: 'Likely', possible: 'Possible' } as const

export function bankMarkText(mark: BankMark): { text: string; tone: 'ok' | 'match' | 'warn' | 'quiet'; title: string } {
  switch (mark.kind) {
    case 'linked':
      return mark.complete
        ? { text: 'In the bank', tone: 'ok', title: `Linked to the bank credit of ${formatBankDate(mark.links[0].lineDate)}` }
        : { text: 'Partly in the bank', tone: 'match', title: 'Only part of this payment is linked to bank credits' }
    case 'suggested': {
      const best = mark.candidates[0]
      return {
        text: `Bank match · ${CONFIDENCE[best.confidence]}`,
        tone: 'match',
        title: `${formatMoney(best.deposit)} credited on ${formatBankDate(best.lineDate)} looks like this payment. Open the payment to link it.`,
      }
    }
    case 'lookalike':
      return { text: 'May be a duplicate', tone: 'warn', title: `The bank credit of ${formatBankDate(mark.lineDate)} is already linked to another payment` }
    case 'none':
      return { text: 'Not found in the bank', tone: 'warn', title: 'The statement covers this date, but no credit matches this payment' }
    case 'uncovered':
      return { text: 'Statement not uploaded', tone: 'quiet', title: 'No bank statement stored for this date yet' }
  }
}

/** The small line under a payment's status in the list. */
export function BankMarkChip({ mark }: { mark: BankMark | undefined }) {
  if (!mark) return null
  const t = bankMarkText(mark)
  return <span className={`bank-mark bank-mark--${t.tone}`} title={t.title}>{t.text}</span>
}

/** The panel in the review window: what the bank shows for this payment, with Link. */
export function BankMatchPanel({ supabase, paymentId, mark, onChanged }: {
  supabase: SupabaseClient
  paymentId: string
  mark: BankMark | undefined
  onChanged: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (!mark) return null

  const link = async (lineId: string) => {
    setBusy(lineId)
    setError(null)
    const { error: err } = await supabase.rpc('link_bank_line_to_payment', { p_line_id: lineId, p_payment_id: paymentId })
    setBusy(null)
    if (err) { setError(rpcMessage(err, 'That did not link. Try again.')); return }
    onChanged()
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
      {mark.kind === 'linked' && !mark.complete && <p className="fin-muted bank-panel-note">Only part of this payment is linked so far.</p>}

      {mark.kind === 'suggested' && (
        <>
          <p className="fin-muted bank-panel-note">This looks like the following bank credit. Linking does not verify the payment.</p>
          {mark.candidates.map(c => (
            <div key={c.lineId} className={`bank-suggest bank-suggest--${c.confidence}`}>
              <div className="bank-suggest-head">
                <div style={{ minWidth: 0 }}>
                  <div className="fin-primary-text">{formatMoney(c.deposit)} · {formatBankDate(c.lineDate)} · {BANK_ACCOUNT_LABEL[c.account]}</div>
                  <div className="fin-sub" title={c.narration}>{c.narration}</div>
                </div>
                <button className="boe-btn boe-btn-primary" disabled={busy !== null} onClick={() => link(c.lineId)}>
                  {busy === c.lineId ? 'Linking…' : 'Link'}
                </button>
              </div>
              <div className="bank-suggest-why">
                <strong>{CONFIDENCE[c.confidence]} match</strong>{c.reasons.length > 0 && <> — {c.reasons.join(' · ')}</>}
                {c.warnings.map(w => <div key={w} className="bank-warn">{w}</div>)}
              </div>
            </div>
          ))}
        </>
      )}

      {mark.kind === 'lookalike' && (
        <div className="bank-panel-line">
          <strong>May be a duplicate.</strong> {formatMoney(mark.deposit)} credited on {formatBankDate(mark.lineDate)} is already linked to another payment. Check this is different money before verifying it.
          <div className="fin-sub">{mark.narration}</div>
        </div>
      )}
      {mark.kind === 'none' && <p className="fin-muted bank-panel-note">The bank statement covers this date, but no credit matches this payment. It may not have arrived yet, or was recorded with a different amount or date.</p>}
      {mark.kind === 'uncovered' && <p className="fin-muted bank-panel-note">No bank statement is stored for this date yet. Upload it on the Bank Statements page.</p>}

      {error && <div role="alert" className="bank-error">{error}</div>}
    </div>
  )
}
