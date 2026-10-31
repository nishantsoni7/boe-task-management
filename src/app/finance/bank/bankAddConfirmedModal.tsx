'use client'

// ── Add a bank credit to Confirmed Payments ─────────────────────────────────
//
// One press records the credit as a payment (Suspense: no customer until it is
// allocated), links it to the bank line and — only for a person who may verify
// their own payments — verifies it. EVERY RULE IS THE DATABASE'S
// (add_bank_line_to_confirmed): the duplicate checks, the permission, the lock
// on the line. When recorded payments could be this money the window comes from
// the comparison: it sends the ids the person compared with a reason, and the
// database refuses if anything else matches by then. It does not allocate: the
// suggested order is offered as a link into Confirmed Payments' own Allocate flow.

import { useState } from 'react'
import Link from 'next/link'
import type { SupabaseClient } from '@supabase/supabase-js'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import { formatMoney } from '@/lib/finance/piPaymentView'
import { BANK_ACCOUNT_LABEL } from '@/lib/finance/bankStatement'
import { payerFromNarration } from '@/lib/finance/bankMatching'
import { orderSuggestionLabel } from '@/lib/finance/bankOrderHistory'
import { notifyFinance } from '@/lib/notify'
import { formatBankDate, rpcMessage, type BankMatch, type LineWithSuggestions } from './bankStatementsModel'

type Added = {
  payment_request_id: string
  request_number: string
  human_payment_id: string | null
  status: string
  verified_on_entry: boolean
}

type Props = {
  supabase: SupabaseClient
  item: LineWithSuggestions
  /** The recorded payments the person compared and said this is not. */
  compared: BankMatch[]
  /** The viewer holds verify_own_payment (or is an admin): the payment is verified as it is added. */
  verifiesOwn: boolean
  onClose: () => void
  /** Reload the page's data; the window stays open on its result. */
  onAdded: () => void
}

const REASON_MIN = 3
const REASON_MAX = 200

export function BankAddConfirmedModal({ supabase, item, compared, verifiesOwn, onClose, onAdded }: Props) {
  const { line, orderSuggestions } = item
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refused, setRefused] = useState(false)
  const [reason, setReason] = useState('')
  const [added, setAdded] = useState<Added | null>(null)
  const payer = payerFromNarration(line.narration)
  const suggestion = orderSuggestions[0] ?? null
  const needsReason = compared.length > 0
  const checked = compared.map(m => m.humanPaymentId ?? 'a recorded payment').join(', ')

  const add = async () => {
    setBusy(true)
    setError(null)
    const { data, error: err } = await supabase.rpc('add_bank_line_to_confirmed', {
      p_line_id: line.id,
      p_checked_payment_ids: compared.map(m => m.paymentId),
      p_reason: needsReason ? reason.trim() : null,
    })
    setBusy(false)
    if (err) {
      setRefused((err.message ?? '').includes('BANK_'))
      setError(rpcMessage(err, 'That did not save. Try again.'))
      onAdded() // the page reads what the refusal found
      return
    }
    const result = data as Added
    setAdded(result)
    if (!result.verified_on_entry) {
      void notifyFinance({ event: 'finance_submitted', requestNumber: result.request_number, entityId: result.payment_request_id })
    }
    onAdded()
  }

  if (added) {
    const idLabel = added.human_payment_id ?? added.request_number
    return (
      <FinanceModal title="Added" onClose={onClose} width="520px">
        <p style={{ margin: 0, fontSize: 14 }}>
          <strong>{idLabel}</strong> — {formatMoney(line.deposit)} from {payer ?? 'this credit'} —{' '}
          {added.verified_on_entry
            ? 'is now in Confirmed Payments, verified, and linked to this bank line.'
            : 'is recorded and linked to this bank line. It is awaiting verification by a verifier before it appears in Confirmed Payments.'}
        </p>
        {suggestion && (
          <p style={{ margin: 0, fontSize: 13 }} className="fin-muted">
            Earlier money from this payer went to <strong>{orderSuggestionLabel(suggestion)}</strong>
            {added.verified_on_entry ? '. Open the payment to allocate it there if that is right.' : '. Once it is verified you can allocate it there if that is right.'}
          </p>
        )}
        <div className="bank-actions">
          <button className="boe-btn boe-btn-ghost" onClick={onClose}>Close</button>
          <Link
            className="boe-btn boe-btn-primary"
            href={added.verified_on_entry
              ? `/finance/received?payment=${added.payment_request_id}${suggestion ? '&action=allocate' : ''}`
              : `/finance?tab=all&request=${added.payment_request_id}`}
          >
            {added.verified_on_entry ? (suggestion ? 'Open to allocate' : 'Open payment') : 'Open request'}
          </Link>
        </div>
      </FinanceModal>
    )
  }

  return (
    <FinanceModal title={needsReason ? 'Add as a different payment' : 'Add to Confirmed Payments'} onClose={() => { if (!busy) onClose() }} width="520px" closeOnBackdropClick={!busy}>
      <dl className="bank-facts">
        <div><dt>Received from</dt><dd>{payer ?? line.narration}</dd></div>
        <div><dt>Bank date</dt><dd>{formatBankDate(line.line_date)}</dd></div>
        <div><dt>Amount</dt><dd>{formatMoney(line.deposit)}</dd></div>
        <div><dt>Account</dt><dd>{BANK_ACCOUNT_LABEL[line.account]}</dd></div>
      </dl>
      <p style={{ margin: 0, fontSize: 13 }} className="fin-muted">
        {verifiesOwn
          ? 'This records the payment, links it to this bank line and verifies it now. It will show as “Not identified” until you allocate it to an order.'
          : 'This records the payment and links it to this bank line. A verifier then decides it. It will show as “Not identified” until it is allocated to an order.'}
        {' '}It is checked first that this credit is not already recorded.
      </p>
      {needsReason && (
        <>
          <p style={{ margin: 0, fontSize: 13 }}>
            You checked this credit against <strong>{checked}</strong>. Your name, the date and this reason are saved on the new payment.
          </p>
          <label className="bank-field"><span>Why is this a different payment? *</span>
            <input className="boe-input" value={reason} onChange={e => setReason(e.target.value)} maxLength={REASON_MAX} autoFocus disabled={busy || refused} />
          </label>
        </>
      )}
      {suggestion && (
        <p style={{ margin: 0, fontSize: 13 }}>
          Suggested order: <strong>{orderSuggestionLabel(suggestion)}</strong>
        </p>
      )}
      {error && <p role="alert" style={{ margin: 0, fontSize: 13, color: '#9B2C2C' }}>{error}</p>}
      <div className="bank-actions">
        <button className="boe-btn boe-btn-ghost" disabled={busy} onClick={onClose}>{refused ? 'Close' : 'Cancel'}</button>
        {!refused && (
          <button className="boe-btn boe-btn-primary" disabled={busy || (needsReason && reason.trim().length < REASON_MIN)} onClick={add}>
            {busy ? 'Adding…' : 'Add to Confirmed Payments'}
          </button>
        )}
      </div>
    </FinanceModal>
  )
}
