'use client'

// ── One bank debit: an expense, or not an expense ───────────────────────────
//
// Most debits are NOT expenses recorded in the app — supplier NEFT/RTGS payments,
// tax, EMIs, transfers to the company's own other account — so "not an expense"
// is a first-class answer, and a supplier payment is marked with the payee's
// name only (there is no purchases module to link it to). Nothing here marks or
// links on its own: a suggestion waits for a person.

import { useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatMoney } from '@/lib/finance/piPaymentView'
import { DEBIT_KIND_LABEL, payeeFromDebitNarration, type DebitKind } from '@/lib/finance/bankStatement'
import { toPaise } from '@/lib/finance/bankMoney'
import {
  activeLinks,
  formatBankDate,
  linkedTotal,
  rpcMessage,
  type BankExpense,
  type LineWithSuggestions,
} from './bankStatementsModel'

const CONFIDENCE_LABEL = { strong: 'Strong match', likely: 'Likely match', possible: 'Possible match' } as const
const EXPENSE_MODE: Record<string, string> = {
  cash: 'Cash', upi: 'UPI', bank_transfer: 'Bank transfer', credit_card: 'Credit card', debit_card: 'Debit card', cheque: 'Cheque', other: 'Other',
}

export function BankDebitPanel({ supabase, item, expenses, onChanged }: {
  supabase: SupabaseClient
  item: LineWithSuggestions
  expenses: BankExpense[]
  onChanged: (message: string, close?: boolean) => void
}) {
  const { line, status, expenseSuggestions, debitKind } = item
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<DebitKind>(debitKind?.kind ?? 'supplier_payment')
  const [payee, setPayee] = useState(debitKind?.payee ?? payeeFromDebitNarration(line.narration) ?? '')
  const [note, setNote] = useState('')
  const [search, setSearch] = useState('')

  const expenseById = useMemo(() => new Map(expenses.map(e => [e.id, e])), [expenses])
  const links = activeLinks(line)
  const remaining = (toPaise(line.withdrawal) - toPaise(linkedTotal(line))) / 100

  const run = async (key: string, message: string, close: boolean, fn: () => PromiseLike<{ error: { message?: string } | null }>) => {
    setBusy(key)
    setError(null)
    const { error: err } = await fn()
    setBusy(null)
    if (err) { setError(rpcMessage(err, 'That did not save. Try again.')); return }
    onChanged(message, close)
  }

  const link = (expenseId: string) =>
    run('link:' + expenseId, 'Linked to the expense', true, () =>
      supabase.rpc('link_bank_debit_to_expense', { p_line_id: line.id, p_expense_id: expenseId }))
  const unlink = (linkId: string) =>
    run('unlink:' + linkId, 'Unlinked', false, () => supabase.rpc('unlink_bank_debit_expense', { p_link_id: linkId }))
  const mark = (k: DebitKind, p: string, n: string) =>
    run('mark', 'Marked as not an expense', true, () =>
      supabase.rpc('classify_bank_debits', { p_items: [{ line_id: line.id, kind: k, payee: p, note: n }] }))
  const clear = () =>
    run('clear', 'Mark removed', false, () => supabase.rpc('clear_bank_line_classification', { p_line_id: line.id }))

  const searchHits = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return []
    const suggested = new Set(expenseSuggestions.map(s => s.expenseId))
    return expenses
      .filter(e => e.remaining > 0 && !suggested.has(e.id) &&
        (e.paid_to.toLowerCase().includes(q) || (e.remark ?? '').toLowerCase().includes(q) || String(e.amount).includes(q.replace(/[,₹\s]/g, ''))))
      .slice(0, 6)
  }, [search, expenses, expenseSuggestions])

  return (
    <>
      {error && <div role="alert" className="bank-error">{error}</div>}

      {links.length > 0 && (
        <section className="bank-section">
          <h3>Linked to</h3>
          {links.map(l => {
            const e = l.expense_id ? expenseById.get(l.expense_id) : undefined
            return (
              <div key={l.id} className="bank-row">
                <div style={{ minWidth: 0 }}>
                  <div className="fin-primary-text">{e?.paid_to ?? 'Expense'}</div>
                  <div className="fin-sub">{formatMoney(l.amount)}{e ? ` · ${formatBankDate(e.expense_date)}` : ''}{e?.remark ? ` · ${e.remark}` : ''}</div>
                </div>
                <button className="boe-btn boe-btn-ghost" disabled={busy !== null} onClick={() => unlink(l.id)}>
                  {busy === 'unlink:' + l.id ? 'Unlinking…' : 'Unlink'}
                </button>
              </div>
            )
          })}
          {status === 'partly' && <p className="fin-muted" style={{ fontSize: 12, margin: 0 }}>{formatMoney(remaining)} of this debit is not linked to an expense yet.</p>}
        </section>
      )}

      {status === 'not_expense' && (
        <section className="bank-section">
          <h3>Not an expense</h3>
          <div>{line.debit_kind ? DEBIT_KIND_LABEL[line.debit_kind] : ''}{line.debit_payee ? ` · ${line.debit_payee}` : ''}</div>
          {line.note && <div className="fin-muted">{line.note}</div>}
          <div><button className="boe-btn boe-btn-ghost" disabled={busy !== null} onClick={clear}>{busy === 'clear' ? 'Removing…' : 'Remove this mark'}</button></div>
        </section>
      )}

      {(status === 'unlinked' || status === 'partly') && (
        <>
          {debitKind && expenseSuggestions.length === 0 && (
            <section className="bank-section bank-hint">
              <h3>This looks like: {DEBIT_KIND_LABEL[debitKind.kind]}</h3>
              <div className="fin-muted">{debitKind.reason}. Nothing is marked until you confirm.</div>
              <div>
                <button className="boe-btn boe-btn-primary" disabled={busy !== null} onClick={() => mark(debitKind.kind, debitKind.payee ?? '', '')}>
                  {busy === 'mark' ? 'Saving…' : `Yes, ${DEBIT_KIND_LABEL[debitKind.kind].toLowerCase()}`}
                </button>
              </div>
            </section>
          )}

          <section className="bank-section">
            <h3>{expenseSuggestions.length > 0 ? 'Suggested expenses' : 'No recorded expense matches this debit'}</h3>
            {expenseSuggestions.map(s => {
              const e = expenseById.get(s.expenseId)
              if (!e) return null
              return (
                <div key={s.expenseId} className={`bank-suggest bank-suggest--${s.confidence}`}>
                  <div className="bank-suggest-head">
                    <div style={{ minWidth: 0 }}>
                      <div className="fin-primary-text">{e.paid_to}</div>
                      <div className="fin-sub">
                        {formatMoney(e.remaining)} · {formatBankDate(e.expense_date)} · {EXPENSE_MODE[e.payment_mode] ?? e.payment_mode}{e.remark ? ` · ${e.remark}` : ''}
                      </div>
                    </div>
                    <button className="boe-btn boe-btn-primary" disabled={busy !== null} onClick={() => link(e.id)}>
                      {busy === 'link:' + e.id ? 'Linking…' : 'Link'}
                    </button>
                  </div>
                  <div className="bank-suggest-why">
                    <strong>{CONFIDENCE_LABEL[s.confidence]}</strong>{s.reasons.length > 0 && <> — {s.reasons.join(' · ')}</>}
                    {s.warnings.map(w => <div key={w} className="bank-warn">{w}</div>)}
                  </div>
                </div>
              )
            })}
            <label className="bank-field">
              <span>Find another expense</span>
              <input className="boe-input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Paid to, remark or amount" />
            </label>
            {searchHits.map(e => (
              <div key={e.id} className="bank-row">
                <div style={{ minWidth: 0 }}>
                  <div className="fin-primary-text">{e.paid_to}</div>
                  <div className="fin-sub">{formatMoney(e.remaining)} · {formatBankDate(e.expense_date)}</div>
                </div>
                <button className="boe-btn boe-btn-primary" disabled={busy !== null} onClick={() => link(e.id)}>
                  {busy === 'link:' + e.id ? 'Linking…' : 'Link'}
                </button>
              </div>
            ))}
            {search.trim() && searchHits.length === 0 && <p className="fin-muted" style={{ fontSize: 12, margin: 0 }}>No unlinked expense found.</p>}
          </section>

          <section className="bank-section">
            <h3>Or say what this is</h3>
            <div className="bank-choice">
              <button className={`boe-btn ${open ? 'boe-btn-primary' : 'boe-btn-ghost'}`} onClick={() => setOpen(!open)}>Not an expense</button>
            </div>
            {open && (
              <div className="bank-form">
                <label className="bank-field"><span>What is it?</span>
                  <select className="boe-input" value={kind} onChange={e => setKind(e.target.value as DebitKind)}>
                    {(Object.keys(DEBIT_KIND_LABEL) as DebitKind[]).map(k => <option key={k} value={k}>{DEBIT_KIND_LABEL[k]}</option>)}
                  </select>
                </label>
                <label className="bank-field"><span>Paid to (optional)</span>
                  <input className="boe-input" value={payee} onChange={e => setPayee(e.target.value)} maxLength={120} />
                </label>
                <label className="bank-field"><span>Note (optional)</span>
                  <input className="boe-input" value={note} onChange={e => setNote(e.target.value)} maxLength={300} />
                </label>
                <div><button className="boe-btn boe-btn-primary" disabled={busy !== null} onClick={() => mark(kind, payee, note)}>{busy === 'mark' ? 'Saving…' : 'Save'}</button></div>
              </div>
            )}
          </section>
        </>
      )}
    </>
  )
}
