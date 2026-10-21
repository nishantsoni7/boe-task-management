'use client'

// ── One bank credit: what it is, and what to do with it ─────────────────────
//
// Suggestions are computed by the page (lib/finance/bankMatching) and shown here
// with their reasons. LINKING IS A PERSON'S ACT: nothing in this file links on
// its own, and linking never verifies, rejects or edits the payment — it is a
// note beside it. The payment keeps its own approval flow.

import { useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import { formatMoney } from '@/lib/finance/piPaymentView'
import { BANK_ACCOUNT_LABEL, NON_CUSTOMER_KIND_LABEL, type NonCustomerKind } from '@/lib/finance/bankStatement'
import { payerFromNarration, type PaymentSuggestion } from '@/lib/finance/bankMatching'
import { toPaise } from '@/lib/finance/bankMoney'
import {
  PAYMENT_STATUS_LABEL,
  STATUS_TONE,
  activeLinks,
  formatBankDate,
  linkedTotal,
  rpcMessage,
  statusLabelFor,
  type BankExpense,
  type BankPayment,
  type LineWithSuggestions,
} from './bankStatementsModel'
import { BankDebitPanel } from './bankDebitPanel'

type Props = {
  supabase: SupabaseClient
  item: LineWithSuggestions
  payments: BankPayment[]
  /** Recorded expenses a debit may be (money out). */
  expenses: BankExpense[]
  onClose: () => void
  /** Reload the page's data after a write; the modal closes itself when told to. */
  onChanged: (message: string, close?: boolean) => void
}

const CONFIDENCE_LABEL = { strong: 'Strong match', likely: 'Likely match', possible: 'Possible match' } as const

export function BankLineModal({ supabase, item, payments, expenses, onClose, onChanged }: Props) {
  const { line, status, suggestions, nonCustomer } = item
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<'none' | 'old' | 'other'>('none')
  const [customer, setCustomer] = useState('')
  const [orderRef, setOrderRef] = useState('')
  const [kind, setKind] = useState<NonCustomerKind>(nonCustomer?.kind ?? 'other')
  const [note, setNote] = useState('')
  const [search, setSearch] = useState('')

  const paymentById = useMemo(() => new Map(payments.map(p => [p.id, p])), [payments])
  const links = activeLinks(line)
  const remaining = (toPaise(line.deposit) - toPaise(linkedTotal(line))) / 100
  const payer = payerFromNarration(line.narration)
  const isCredit = line.deposit > 0

  const run = async (key: string, doneMessage: string, close: boolean, fn: () => PromiseLike<{ error: { message?: string } | null }>) => {
    setBusy(key)
    setError(null)
    const { error: err } = await fn()
    setBusy(null)
    if (err) { setError(rpcMessage(err, 'That did not save. Try again.')); return }
    onChanged(doneMessage, close)
  }

  const link = (paymentId: string) =>
    run('link:' + paymentId, 'Linked', true, () =>
      supabase.rpc('link_bank_line_to_payment', { p_line_id: line.id, p_payment_id: paymentId }))

  const unlink = (linkId: string) =>
    run('unlink:' + linkId, 'Unlinked', false, () =>
      supabase.rpc('unlink_bank_line_payment', { p_link_id: linkId }))

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

  const searchHits = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return []
    const suggested = new Set(suggestions.map(s => s.paymentId))
    return payments
      .filter(p => p.remaining > 0 && !suggested.has(p.id) &&
        ((p.client_name ?? '').toLowerCase().includes(q) ||
          (p.human_payment_id ?? '').toLowerCase().includes(q) ||
          String(p.amount).includes(q.replace(/[,₹\s]/g, ''))))
      .slice(0, 6)
  }, [search, payments, suggestions])

  return (
    <FinanceModal title={isCredit ? 'Bank credit' : 'Bank debit'} onClose={onClose} width="640px">
      <div className="bank-facts">
        <div>
          <div className="bank-amount">{formatMoney(isCredit ? line.deposit : line.withdrawal)}</div>
          <div className="fin-muted" style={{ fontSize: 12 }}>
            {formatBankDate(line.line_date)} · {BANK_ACCOUNT_LABEL[line.account]}
          </div>
        </div>
        <span className={`fin-pill fin-pill--${STATUS_TONE[status]}`}>{statusLabelFor(line, status)}</span>
      </div>

      <div className="bank-narration">
        {payer && <div className="bank-payer">{payer}</div>}
        <div>{line.narration}</div>
        {line.bank_ref && <div className="fin-muted" style={{ marginTop: 4 }}>Ref {line.bank_ref}</div>}
      </div>

      {error && <div role="alert" className="bank-error">{error}</div>}

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
                  <div className="fin-primary-text">{p?.client_name ?? 'Suspense payment (no client)'}</div>
                  <div className="fin-sub">
                    {p?.human_payment_id ?? 'Payment'} · {formatMoney(l.amount)}{p ? ` · ${PAYMENT_STATUS_LABEL[p.status] ?? p.status}` : ''}
                  </div>
                </div>
                <button className="boe-btn boe-btn-ghost" disabled={busy !== null} onClick={() => unlink(l.id)}>
                  {busy === 'unlink:' + l.id ? 'Unlinking…' : 'Unlink'}
                </button>
              </div>
            )
          })}
          {status === 'partly' && (
            <p className="fin-muted" style={{ fontSize: 12, margin: 0 }}>
              {formatMoney(remaining)} of this credit is not linked to any payment yet.
            </p>
          )}
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

      {/* ── suggestions and search ── */}
      {isCredit && (status === 'unlinked' || status === 'partly') && (
        <>
          {nonCustomer && (
            <section className="bank-section bank-hint">
              <h3>This looks like: {NON_CUSTOMER_KIND_LABEL[nonCustomer.kind]}</h3>
              <div className="fin-muted">{nonCustomer.reason}. Nothing is marked until you confirm.</div>
              <div>
                <button className="boe-btn boe-btn-primary" disabled={busy !== null} onClick={() => saveOther(nonCustomer.kind)}>
                  {busy === 'other' ? 'Saving…' : 'Yes, not customer money'}
                </button>
              </div>
            </section>
          )}

          <section className="bank-section">
            <h3>{suggestions.length > 0 ? 'Suggested payments' : 'No recorded payment matches this credit'}</h3>
            {suggestions.map(s => (
              <SuggestionCard key={s.paymentId} s={s} p={paymentById.get(s.paymentId)} busy={busy} onLink={() => link(s.paymentId)} />
            ))}
            <label className="bank-field">
              <span>Find another payment</span>
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Client, payment ID or amount"
                className="boe-input"
              />
            </label>
            {searchHits.map(p => (
              <div key={p.id} className="bank-row">
                <div style={{ minWidth: 0 }}>
                  <div className="fin-primary-text">{p.client_name ?? 'Suspense payment (no client)'}</div>
                  <div className="fin-sub">{p.human_payment_id} · {formatMoney(p.remaining)} · {formatBankDate(p.payment_date)}</div>
                </div>
                <button className="boe-btn boe-btn-primary" disabled={busy !== null} onClick={() => link(p.id)}>
                  {busy === 'link:' + p.id ? 'Linking…' : 'Link'}
                </button>
              </div>
            ))}
            {search.trim() && searchHits.length === 0 && <p className="fin-muted" style={{ fontSize: 12, margin: 0 }}>No unlinked payment found.</p>}
          </section>

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

function SuggestionCard({ s, p, busy, onLink }: {
  s: PaymentSuggestion
  p: BankPayment | undefined
  busy: string | null
  onLink: () => void
}) {
  if (!p) return null
  return (
    <div className={`bank-suggest bank-suggest--${s.confidence}`}>
      <div className="bank-suggest-head">
        <div style={{ minWidth: 0 }}>
          <div className="fin-primary-text">{p.client_name ?? 'Suspense payment (no client)'}</div>
          <div className="fin-sub">
            {p.human_payment_id} · {formatMoney(p.remaining)} · recorded {formatBankDate(p.payment_date)} · {BANK_ACCOUNT_LABEL[p.payment_mode as 'hdfc' | 'hdfc_sec'] ?? p.payment_mode} · {PAYMENT_STATUS_LABEL[p.status] ?? p.status}
          </div>
        </div>
        <button className="boe-btn boe-btn-primary" disabled={busy !== null} onClick={onLink}>
          {busy === 'link:' + p.id ? 'Linking…' : 'Link'}
        </button>
      </div>
      <div className="bank-suggest-why">
        <strong>{CONFIDENCE_LABEL[s.confidence]}</strong>
        {s.reasons.length > 0 && <> — {s.reasons.join(' · ')}</>}
        {s.warnings.map(w => <div key={w} className="bank-warn">{w}</div>)}
      </div>
    </div>
  )
}
