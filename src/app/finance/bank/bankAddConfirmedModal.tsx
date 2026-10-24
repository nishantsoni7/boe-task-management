'use client'

// ── Add a bank credit to Confirmed Payments ─────────────────────────────────
//
// One press records the credit as a payment (Suspense: no customer until it is
// allocated), links it to the bank line and — only for a person who may verify
// their own payments — verifies it. EVERY RULE IS THE DATABASE'S
// (create_payment_from_bank_line): the duplicate checks, the permission, the
// lock on the line. This window explains the outcome in words and never
// decides anything itself. It does not allocate: the suggested order is offered
// as a link into Confirmed Payments' own Allocate flow.

import { useState } from 'react'
import Link from 'next/link'
import type { SupabaseClient } from '@supabase/supabase-js'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import { formatMoney } from '@/lib/finance/piPaymentView'
import { BANK_ACCOUNT_LABEL } from '@/lib/finance/bankStatement'
import { payerFromNarration } from '@/lib/finance/bankMatching'
import { orderSuggestionLabel } from '@/lib/finance/bankOrderHistory'
import { notifyFinance } from '@/lib/notify'
import { formatBankDate, rpcMessage, type LineWithSuggestions } from './bankStatementsModel'

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
  /** The viewer holds verify_own_payment (or is an admin): the payment is verified as it is added. */
  verifiesOwn: boolean
  onClose: () => void
  /** Reload the page's data; the window stays open on its result. */
  onAdded: () => void
}

export function BankAddConfirmedModal({ supabase, item, verifiesOwn, onClose, onAdded }: Props) {
  const { line, orderSuggestions } = item
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [possibleDuplicate, setPossibleDuplicate] = useState(false)
  const [sure, setSure] = useState(false)
  const [added, setAdded] = useState<Added | null>(null)
  const payer = payerFromNarration(line.narration)
  const suggestion = orderSuggestions[0] ?? null

  const add = async () => {
    setBusy(true)
    setError(null)
    const { data, error: err } = await supabase.rpc('create_payment_from_bank_line', {
      p_line_id: line.id,
      p_allow_possible_duplicate: possibleDuplicate && sure,
    })
    setBusy(false)
    if (err) {
      setPossibleDuplicate((err.message ?? '').includes('BANK_PAYMENT_POSSIBLE_DUPLICATE'))
      setSure(false)
      setError(rpcMessage(err, 'That did not save. Try again.'))
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

  const hardStop = error !== null && !possibleDuplicate

  return (
    <FinanceModal title="Add to Confirmed Payments" onClose={() => { if (!busy) onClose() }} width="520px" closeOnBackdropClick={!busy}>
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
      {suggestion && (
        <p style={{ margin: 0, fontSize: 13 }}>
          Suggested order: <strong>{orderSuggestionLabel(suggestion)}</strong>
        </p>
      )}
      {error && <p role="alert" style={{ margin: 0, fontSize: 13, color: '#9B2C2C' }}>{error}</p>}
      {possibleDuplicate && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
          <input type="checkbox" checked={sure} onChange={e => setSure(e.target.checked)} />
          <span>This is a different payment. Add it anyway.</span>
        </label>
      )}
      <div className="bank-actions">
        <button className="boe-btn boe-btn-ghost" disabled={busy} onClick={onClose}>{hardStop ? 'Close' : 'Cancel'}</button>
        {!hardStop && (
          <button className="boe-btn boe-btn-primary" disabled={busy || (possibleDuplicate && !sure)} onClick={add}>
            {busy ? 'Adding…' : 'Add to Confirmed Payments'}
          </button>
        )}
      </div>
    </FinanceModal>
  )
}
