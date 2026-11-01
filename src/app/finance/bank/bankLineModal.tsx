'use client'

// ── One bank credit: what it is, and what to do with it ─────────────────────
//
// What this credit is, whether it is Matched to a verified payment, the recorded
// payments it could be, side by side, and the marks that say it is not customer
// money. A person links the same money, or opens the payment form to record it as a
// different payment. Which payments to compare comes from the database, the same rule that
// refuses a second payment. A payment linked to the wrong credit is moved here with
// a reason. A match with a doubt is never the obvious button and asks first. Nothing
// in this file verifies, rejects or edits a payment, and it never sends an amount.

import { useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import type { SupabaseClient } from '@supabase/supabase-js'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import { formatMoney } from '@/lib/finance/piPaymentView'
import { BANK_ACCOUNT_LABEL, NON_CUSTOMER_KIND_LABEL, type NonCustomerKind } from '@/lib/finance/bankStatement'
import { payerFromNarration } from '@/lib/finance/bankMatching'
import { toPaise } from '@/lib/finance/bankMoney'
import {
  PAYMENT_STATUS_LABEL,
  STATUS_TONE,
  SYNC_PILL,
  activeLinks,
  compareMatch,
  formatBankDate,
  linkedTotal,
  matchDoubts,
  paymentHref,
  rpcMessage,
  statusLabelFor,
  syncReason,
  syncState,
  type BankExpense,
  type BankLine,
  type BankMatch,
  type BankPayment,
  type LineWithSuggestions,
} from './bankStatementsModel'
import { BankDebitPanel } from './bankDebitPanel'
import { orderSuggestionLabel } from '@/lib/finance/bankOrderHistory'

type Props = {
  supabase: SupabaseClient
  item: LineWithSuggestions
  payments: BankPayment[]
  /** Recorded expenses a debit may be (money out). */
  expenses: BankExpense[]
  /** The viewer may record a payment (finance.create). */
  canAdd: boolean
  /** Opens the ordinary payment form, filled in from this credit. */
  onRecord: () => void
  onClose: () => void
  /** Reload the page's data after a write; the modal closes itself when told to. */
  onChanged: (message: string, close?: boolean) => void
}

const REASON_MIN = 3
const REASON_MAX = 200

/** Red is for a match nothing speaks against; a doubt never gets the obvious button. */
const pressFor = (line: BankLine, match: BankMatch) =>
  `boe-btn ${matchDoubts(line, match).length === 0 ? 'boe-btn-primary' : 'boe-btn-ghost'}`

function MatchCard({ line, match, busy, asking, onAsk, onLink, children }: {
  line: BankLine
  match: BankMatch
  busy: boolean
  /** Its question is open under the card, in place of the button. */
  asking: boolean
  /** Open the question: why to move it, or whether to link it despite a doubt. */
  onAsk: () => void
  onLink: () => void
  children: ReactNode
}) {
  const heldBy = match.linkedNarration ? payerFromNarration(match.linkedNarration) : null
  const doubts = matchDoubts(line, match)
  const sure = doubts.length === 0
  return (
    <div className="bank-compare">
      <div className="bank-compare-head">
        <strong>{match.humanPaymentId ?? 'Payment'} · {match.clientName ?? 'Suspense payment'}</strong>
        <Link href={paymentHref(match.paymentId, match.status)} target="_blank">Open payment</Link>
      </div>
      <table className="bank-compare-table">
        <thead><tr><th scope="col" /><th scope="col">This credit</th><th scope="col">Recorded payment</th><th scope="col" /></tr></thead>
        <tbody>
          {compareMatch(line, match).map(r => (
            <tr key={r.label}>
              <th scope="row">{r.label}</th>
              <td>{r.credit}</td>
              <td>{r.payment}</td>
              <td className={`is-${r.tone}`}>{r.verdict}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {match.kind === 'reference_used' && (
        <p className="fin-muted" style={{ fontSize: 12, margin: 0 }}>This payment is already linked to another bank line, so it cannot take this credit too.</p>
      )}
      {match.kind === 'linked_elsewhere' && (
        <p className="bank-warn" style={{ fontSize: 12, margin: 0 }}>
          This payment is linked to the credit of {match.linkedLineDate ? formatBankDate(match.linkedLineDate) : 'another date'}{heldBy ? ` from ${heldBy}` : ''}. If it belongs here, move it to this credit.
        </p>
      )}
      {!sure && <p className="bank-warn" style={{ fontSize: 12, margin: 0 }}>Check first: {doubts.join(' and ')}.</p>}
      {match.kind === 'linked_elsewhere' && !asking && (
        <div><button className={pressFor(line, match)} disabled={busy || !match.linkedLinkId} onClick={onAsk}>{sure ? 'Move this payment here' : 'Move anyway'}</button></div>
      )}
      {(match.kind === 'reference' || match.kind === 'amount') && !asking && (
        <div><button className={pressFor(line, match)} disabled={busy} onClick={sure ? onLink : onAsk}>{sure ? 'Same payment, link them' : 'Link anyway'}</button></div>
      )}
      {asking && children}
    </div>
  )
}

export function BankLineModal({ supabase, item, payments, expenses, canAdd, onRecord, onClose, onChanged }: Props) {
  const { line, status, nonCustomer, review, orderSuggestions } = item
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<'none' | 'old' | 'other'>('none')
  const [customer, setCustomer] = useState('')
  const [orderRef, setOrderRef] = useState('')
  const [kind, setKind] = useState<NonCustomerKind>(nonCustomer?.kind ?? 'other')
  const [note, setNote] = useState('')
  const [unlinking, setUnlinking] = useState<string | null>(null)
  const [unlinkReason, setUnlinkReason] = useState('')
  // The payment whose card has its question open.
  const [asking, setAsking] = useState<string | null>(null)

  const paymentById = useMemo(() => new Map(payments.map(p => [p.id, p])), [payments])
  const links = activeLinks(line)
  const remaining = (toPaise(line.deposit) - toPaise(linkedTotal(line))) / 100
  const payer = payerFromNarration(line.narration)
  const isCredit = line.deposit > 0
  const open = isCredit && (status === 'unlinked' || status === 'partly')
  const state = isCredit ? syncState(item) : 'not_needed'
  const reason = isCredit ? syncReason(item) : null
  const mustLink = review.matches.some(m => m.kind === 'reference')
  const askingHere = open && review.matches.some(m => m.paymentId === asking)
  const marked = status === 'old_order' || status === 'not_customer'
  const pill = isCredit && !marked ? SYNC_PILL[state] : { tone: STATUS_TONE[status], label: statusLabelFor(line, status) }

  const run = async (key: string, doneMessage: string, close: boolean, fn: () => PromiseLike<{ error: { message?: string } | null }>) => {
    setBusy(key)
    setError(null)
    const { error: err } = await fn()
    setBusy(null)
    if (err) { setError(rpcMessage(err, 'That did not save. Try again.')); return false }
    onChanged(doneMessage, close)
    return true
  }

  const saveOld = () =>
    run('old', 'Marked as an old order', true, () =>
      supabase.rpc('classify_bank_line', {
        p_line_id: line.id, p_classification: 'old_order', p_customer: customer, p_order_ref: orderRef || null, p_note: note || null,
      }))

  const saveOther = (k: NonCustomerKind) =>
    run('other', 'Marked as not customer money', true, () =>
      supabase.rpc('classify_bank_line', {
        p_line_id: line.id, p_classification: 'not_customer_money', p_kind: k, p_note: note || null,
      }))

  const clear = () =>
    run('clear', 'Mark removed', false, () => supabase.rpc('clear_bank_line_classification', { p_line_id: line.id }))

  const sendLink = (m: BankMatch) => supabase.rpc('link_bank_line_to_payment', { p_line_id: line.id, p_payment_id: m.paymentId })
  const sendUnlink = (linkId: string) => supabase.rpc('unlink_bank_line_payment', { p_link_id: linkId, p_reason: unlinkReason.trim() })

  const link = (m: BankMatch) =>
    run(`link:${m.paymentId}`, `Linked to ${m.humanPaymentId ?? 'the payment'}`, true, () => sendLink(m))

  const unlink = async (linkId: string) => {
    const done = await run('unlink', 'Unlinked. The payment stays recorded.', false, () => sendUnlink(linkId))
    if (done) setUnlinking(null)
  }

  // The same two doors a person would use, one after the other, so each keeps its
  // checks. If the second refuses, nothing is lost: the payment is free, the page
  // reloads, and this card's question becomes the link again, with what happened.
  const move = async (m: BankMatch) => {
    if (!m.linkedLinkId) return
    const name = m.humanPaymentId ?? 'The payment'
    setBusy('move')
    setError(null)
    const { error: unlinkError } = await sendUnlink(m.linkedLinkId)
    if (unlinkError) { setBusy(null); setError(rpcMessage(unlinkError, 'That did not save. Try again.')); return }
    const { error: linkError } = await sendLink(m)
    setBusy(null)
    if (linkError) {
      setError(`${name} came off the other credit but did not link here: ${rpcMessage(linkError, 'try again')}`)
      onChanged('Unlinked. The payment stays recorded.', false)
      return
    }
    onChanged(`Moved ${name} to this credit`, true)
  }

  const askAbout = (m: BankMatch) => { setAsking(m.paymentId); setUnlinking(null); setUnlinkReason(''); setError(null) }
  const startUnlink = (linkId: string) => { setUnlinking(linkId); setAsking(null); setUnlinkReason('') }

  const moveForm = (m: BankMatch) => (
    <div className="bank-form">
      {error && <div role="alert" className="bank-error">{error}</div>}
      <p className="fin-muted" style={{ fontSize: 12, margin: 0 }}>
        {m.humanPaymentId ?? 'The payment'} moves to this credit, and the other credit goes back to Not matched. The payment itself does not change. Your name and this reason are kept.
      </p>
      <label className="bank-field"><span>Why is that link wrong? *</span>
        <input className="boe-input" value={unlinkReason} onChange={e => setUnlinkReason(e.target.value)} maxLength={REASON_MAX} autoFocus />
      </label>
      <div className="bank-actions">
        <button className="boe-btn boe-btn-ghost" disabled={busy !== null} onClick={() => setAsking(null)}>Keep the link</button>
        <button className={pressFor(line, m)} disabled={busy !== null || unlinkReason.trim().length < REASON_MIN} onClick={() => move(m)}>
          {busy === 'move' ? 'Moving…' : 'Move it here'}
        </button>
      </div>
    </div>
  )

  const linkForm = (m: BankMatch) => (
    <div className="bank-form">
      {error && <div role="alert" className="bank-error">{error}</div>}
      <p className="fin-muted" style={{ fontSize: 12, margin: 0 }}>Link {m.humanPaymentId ?? 'this payment'} to this credit?</p>
      <div className="bank-actions">
        <button className="boe-btn boe-btn-ghost" disabled={busy !== null} onClick={() => setAsking(null)}>Keep it unlinked</button>
        <button className={pressFor(line, m)} disabled={busy !== null} onClick={() => link(m)}>
          {busy === `link:${m.paymentId}` ? 'Linking…' : 'Yes, link them'}
        </button>
      </div>
    </div>
  )

  const unlinkForm = unlinking && (
    <div className="bank-form">
      <p className="fin-muted" style={{ fontSize: 12, margin: 0 }}>
        The payment stays recorded and moves to Payments not in the bank, so nothing disappears. Your name and this reason are kept.
      </p>
      <label className="bank-field"><span>Why is this link wrong? *</span>
        <input className="boe-input" value={unlinkReason} onChange={e => setUnlinkReason(e.target.value)} maxLength={REASON_MAX} autoFocus />
      </label>
      <div className="bank-actions">
        <button className="boe-btn boe-btn-ghost" disabled={busy !== null} onClick={() => setUnlinking(null)}>Keep the link</button>
        <button className="boe-btn boe-btn-primary" disabled={busy !== null || unlinkReason.trim().length < REASON_MIN} onClick={() => unlink(unlinking)}>
          {busy === 'unlink' ? 'Unlinking…' : 'Unlink'}
        </button>
      </div>
    </div>
  )

  return (
    <FinanceModal title={isCredit ? 'Bank credit' : 'Bank debit'} onClose={onClose} width="640px">
      <div className="bank-facts">
        <div>
          <div className="bank-amount">{formatMoney(isCredit ? line.deposit : line.withdrawal)}</div>
          <div className="fin-muted" style={{ fontSize: 12 }}>
            {formatBankDate(line.line_date)} · {BANK_ACCOUNT_LABEL[line.account]}
          </div>
        </div>
        <span className={`fin-pill fin-pill--${pill.tone}`}>{pill.label}</span>
      </div>

      <div className="bank-narration">
        {payer && <div className="bank-payer">{payer}</div>}
        <div>{line.narration}</div>
        {line.bank_ref && <div className="fin-muted" style={{ marginTop: 4 }}>Ref {line.bank_ref}</div>}
      </div>

      {error && !askingHere && <div role="alert" className="bank-error">{error}</div>}

      {!isCredit && <BankDebitPanel supabase={supabase} item={item} expenses={expenses} onChanged={onChanged} />}

      {/* ── linked ── */}
      {isCredit && links.length > 0 && (
        <section className="bank-section">
          <h3>Linked to</h3>
          {links.map(l => {
            const p = paymentById.get(l.payment_id ?? '')
            return (
              <div key={l.id} className="bank-row">
                <div style={{ minWidth: 0 }}>
                  <div className="fin-primary-text">{p ? p.client_name ?? 'Suspense payment (no client)' : 'Payment no longer available'}</div>
                  <div className="fin-sub">
                    {p?.human_payment_id ?? 'Payment'} · {formatMoney(l.amount)}{p ? ` · ${PAYMENT_STATUS_LABEL[p.status] ?? p.status}` : ''}
                  </div>
                </div>
                <div className="bank-choice">
                  {p && state !== 'synced' && <Link className="boe-btn boe-btn-ghost" href={paymentHref(p.id, p.status)} target="_blank">Open payment</Link>}
                  <button className="boe-btn boe-btn-ghost" disabled={busy !== null} onClick={() => startUnlink(l.id)}>Unlink</button>
                </div>
              </div>
            )
          })}
          {state === 'synced'
            ? <p className="fin-muted" style={{ fontSize: 12, margin: 0 }}>Matched: verified payments in this account cover this credit.</p>
            : <p style={{ fontSize: 12, margin: 0, color: state === 'waiting' ? '#805B0D' : '#A12438' }}>{reason}</p>}
          {status === 'partly' && (
            <p className="fin-muted" style={{ fontSize: 12, margin: 0 }}>
              {formatMoney(remaining)} of this credit is not linked to any payment yet. Record a payment for it and it will appear here to link.
            </p>
          )}
          {unlinkForm}
        </section>
      )}

      {/* ── marked ── */}
      {status === 'old_order' && (
        <section className="bank-section">
          <h3>Old order</h3>
          <div>{line.old_order_customer}{line.old_order_ref ? ` · ${line.old_order_ref}` : ''}</div>
          {line.note && <div className="fin-muted">{line.note}</div>}
          <div><button className="boe-btn boe-btn-ghost" disabled={busy !== null} onClick={clear}>{busy === 'clear' ? 'Removing…' : 'Remove this mark'}</button></div>
        </section>
      )}
      {status === 'not_customer' && (
        <section className="bank-section">
          <h3>Not customer money</h3>
          <div>{line.non_customer_kind ? NON_CUSTOMER_KIND_LABEL[line.non_customer_kind] : ''}</div>
          {line.note && <div className="fin-muted">{line.note}</div>}
          <div><button className="boe-btn boe-btn-ghost" disabled={busy !== null} onClick={clear}>{busy === 'clear' ? 'Removing…' : 'Remove this mark'}</button></div>
        </section>
      )}

      {/* ── is this money already recorded? ── */}
      {open && review.matches.length > 0 && (
        <section className="bank-section">
          <h3>Is this already recorded?</h3>
          <p className="fin-muted" style={{ fontSize: 12, margin: 0 }}>
            {review.matches.length === 1 ? '1 recorded payment could be this money.' : `${review.matches.length} recorded payments could be this money.`} Compare, then choose.
          </p>
          {review.matches.map(m => (
            <MatchCard key={m.paymentId} line={line} match={m} busy={busy !== null} asking={asking === m.paymentId}
              onAsk={() => askAbout(m)} onLink={() => link(m)}>
              {m.kind === 'linked_elsewhere' ? moveForm(m) : linkForm(m)}
            </MatchCard>
          ))}
          {mustLink && (
            <p className="fin-muted" style={{ fontSize: 12, margin: 0 }}>
              The bank&apos;s own reference is on a payment above, so this credit cannot be a different payment.
            </p>
          )}
          {status === 'unlinked' && canAdd && !mustLink && (
            <div className="bank-compare-other">
              <span className="fin-muted">None of these is this money?</span>
              <button className="boe-btn boe-btn-ghost" disabled={busy !== null} onClick={onRecord}>Different payment, record it</button>
            </div>
          )}
        </section>
      )}

      {/* ── what it may be, and how to finish it ── */}
      {status === 'unlinked' && (
        <>
          {nonCustomer && review.matches.length === 0 && (
            <section className="bank-section bank-hint">
              <h3>This looks like: {NON_CUSTOMER_KIND_LABEL[nonCustomer.kind]}</h3>
              <div className="fin-muted">{nonCustomer.reason}. This is only a guess from the bank&apos;s words, so it stays Not matched until you decide.</div>
              <div className="bank-choice">
                <button className="boe-btn boe-btn-primary" disabled={busy !== null} onClick={() => saveOther(nonCustomer.kind)}>
                  {busy === 'other' ? 'Saving…' : 'Yes, not customer money'}
                </button>
                {canAdd && <button className="boe-btn boe-btn-ghost" disabled={busy !== null} onClick={onRecord}>No, it is a customer&apos;s, record it</button>}
              </div>
            </section>
          )}

          {!nonCustomer && review.matches.length === 0 && (
            <section className="bank-section">
              <h3>{reason}</h3>
              <div className="fin-muted">A statement records nothing by itself. Record this money, and it can then be verified against this credit.</div>
              {orderSuggestions[0] && <div className="fin-muted">Earlier money from this payer went to {orderSuggestionLabel(orderSuggestions[0])}.</div>}
              {canAdd && <div><button className="boe-btn boe-btn-primary" disabled={busy !== null} onClick={onRecord}>Record it</button></div>}
            </section>
          )}

          <section className="bank-section">
            <h3>Or say what this is</h3>
            <div className="bank-choice">
              <button className={`boe-btn ${mode === 'old' ? 'boe-btn-primary' : 'boe-btn-ghost'}`} onClick={() => setMode(mode === 'old' ? 'none' : 'old')}>An old order</button>
              <button className={`boe-btn ${mode === 'other' ? 'boe-btn-primary' : 'boe-btn-ghost'}`} onClick={() => setMode(mode === 'other' ? 'none' : 'other')}>Not customer money</button>
            </div>
            {mode === 'old' && (
              <div className="bank-form">
                <p className="fin-muted" style={{ fontSize: 12, margin: 0 }}>
                  For an order that was never put into the app. The credit counts as explained, not as unlinked.
                </p>
                <label className="bank-field"><span>Customer *</span>
                  <input className="boe-input" value={customer} onChange={e => setCustomer(e.target.value)} maxLength={120} placeholder={payer ?? 'Customer name'} />
                </label>
                <label className="bank-field"><span>Old order or PI number (optional)</span>
                  <input className="boe-input" value={orderRef} onChange={e => setOrderRef(e.target.value)} maxLength={60} />
                </label>
                <label className="bank-field"><span>Note (optional)</span>
                  <input className="boe-input" value={note} onChange={e => setNote(e.target.value)} maxLength={300} />
                </label>
                <div><button className="boe-btn boe-btn-primary" disabled={busy !== null || customer.trim() === ''} onClick={saveOld}>{busy === 'old' ? 'Saving…' : 'Save as old order'}</button></div>
              </div>
            )}
            {mode === 'other' && (
              <div className="bank-form">
                <label className="bank-field"><span>What is it?</span>
                  <select className="boe-input" value={kind} onChange={e => setKind(e.target.value as NonCustomerKind)}>
                    {(Object.keys(NON_CUSTOMER_KIND_LABEL) as NonCustomerKind[]).map(k => (
                      <option key={k} value={k}>{NON_CUSTOMER_KIND_LABEL[k]}</option>
                    ))}
                  </select>
                </label>
                <label className="bank-field"><span>Note (optional)</span>
                  <input className="boe-input" value={note} onChange={e => setNote(e.target.value)} maxLength={300} />
                </label>
                <div><button className="boe-btn boe-btn-primary" disabled={busy !== null} onClick={() => saveOther(kind)}>{busy === 'other' ? 'Saving…' : 'Save'}</button></div>
              </div>
            )}
          </section>
        </>
      )}
    </FinanceModal>
  )
}
