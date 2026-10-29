'use client'

// ── New payout / change a payout ─────────────────────────────────────────────
//
// The owner's case, in one form: "Nitish needed ₹1.5 lakh; put ₹75,000 each
// into Namrata's and Jaishree's accounts". Type the total, pick the accounts,
// and it is split equally (whole rupees, the remainder to the first). Any
// amount can be changed by hand, and the form says when the lines stop adding
// up. Each line has a kind, so Namrata's remuneration and incentive stay apart;
// one account may carry two kinds in the same payout ("+ kind").
//
// Before saving, each line says what it does to that person's tax-free room
// for the year (the rules of src/lib/finance/founderPayoutTax.ts). A backdrop
// click never discards what was typed (the Finance form-modal rule).

import { useMemo, useState, type ReactNode } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import {
  FOUNDER_PAID_FROM,
  draftProblems,
  formatLakh,
  formatRupees,
  kindLabel,
  kindsForRole,
  splitEqually,
  summariseYear,
  taxYearLabel,
  taxYearOf,
  type FounderBook,
  type FounderPayout,
  type FounderPayoutKind,
} from '@/lib/finance/founderPayouts'
import { roomLeft, rulesFor, taxIfPaid } from '@/lib/finance/founderPayoutTax'
import { saveFounderPayout } from './founderPayoutsData'

type Line = { key: string; accountId: string; kind: FounderPayoutKind; amount: string }

/** '75,000' or '75000.50' → paise; anything unreadable → 0. */
export function parseAmountToPaise(text: string): number {
  const n = Number(text.replace(/[,\s₹]/g, ''))
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0
}

const paiseToText = (paise: number) => (paise > 0 ? String(paise % 100 === 0 ? paise / 100 : (paise / 100).toFixed(2)) : '')

let lineSeq = 0
const nextKey = () => `l${++lineSeq}`

export function FounderPayoutModal({
  supabase,
  book,
  editing,
  todayIso,
  onClose,
  onSaved,
}: {
  supabase: SupabaseClient
  book: FounderBook
  editing: FounderPayout | null
  todayIso: string
  onClose: () => void
  onSaved: (message: string, paidOn: string) => void
}) {
  const accounts = book.accounts
  const byId = useMemo(() => new Map(accounts.map(a => [a.id, a])), [accounts])
  const sides = useMemo(() => [...new Set(accounts.map(a => a.side))].sort((a, b) => a.localeCompare(b)), [accounts])

  const [paidOn, setPaidOn] = useState(editing?.paidOn ?? todayIso)
  const [paidFrom, setPaidFrom] = useState(editing?.paidFrom ?? 'hdfc')
  const [total, setTotal] = useState(editing ? paiseToText(editing.lines.reduce((s, l) => s + l.paise, 0)) : '')
  const [side, setSide] = useState<string>(sides[0] ?? '')
  const [lines, setLines] = useState<Line[]>(() =>
    (editing?.lines ?? []).map(l => ({ key: nextKey(), accountId: l.accountId, kind: l.kind, amount: paiseToText(l.paise) })))
  const [equal, setEqual] = useState(!editing)
  const [note, setNote] = useState(editing?.note ?? '')
  const [reference, setReference] = useState(editing?.bankReference ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [idempotencyKey] = useState(() => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : null))

  const totalPaise = parseAmountToPaise(total)

  // Equal split is DERIVED while it is on, so typing the total re-splits at once.
  const shownLines: Line[] = useMemo(() => {
    if (!equal || lines.length === 0) return lines
    const parts = splitEqually(totalPaise, lines.length)
    return lines.map((l, i) => ({ ...l, amount: paiseToText(parts[i]) }))
  }, [equal, lines, totalPaise])

  const draftLines = shownLines.map(l => ({ accountId: l.accountId, kind: l.kind, paise: parseAmountToPaise(l.amount) }))
  const sum = draftLines.reduce((s, l) => s + l.paise, 0)
  const problems = [
    ...(!(totalPaise > 0) && lines.length > 0 ? ['Type the total amount.'] : []),
    ...draftProblems({ paidOn, paidFrom, totalPaise, lines: draftLines }, todayIso),
  ]

  // What each person has already had this year, leaving out the payout being
  // changed. A few hundred lines at most, so it is simply worked out again.
  const taxYear = /^\d{4}-\d{2}-\d{2}$/.test(paidOn) ? taxYearOf(paidOn) : taxYearOf(todayIso)
  const rules = rulesFor(taxYear)?.rules ?? null
  const others = editing ? { ...book, payouts: book.payouts.filter(p => p.id !== editing.id) } : book
  const before = new Map(summariseYear(others, taxYear).accounts.map(a => [a.account.id, a]))

  const pickedIds = [...new Set(lines.map(l => l.accountId))]

  // Picking or dropping an account re-splits equally: that is the usual case,
  // and a hand-typed split is one tap away again.
  const toggle = (accountId: string) => {
    setError(null)
    setEqual(true)
    if (pickedIds.includes(accountId)) {
      setLines(prev => prev.filter(l => l.accountId !== accountId))
    } else {
      const account = byId.get(accountId)
      setLines(prev => [...prev, { key: nextKey(), accountId, kind: kindsForRole(account?.taxRole ?? 'unset')[0], amount: '' }])
    }
  }

  const addKind = (accountId: string) => {
    const account = byId.get(accountId)
    const used = new Set(lines.filter(l => l.accountId === accountId).map(l => l.kind))
    const next = kindsForRole(account?.taxRole ?? 'unset').find(k => !used.has(k))
    if (!next) return
    setLines(prev => {
      const at = prev.map(l => l.accountId).lastIndexOf(accountId)
      const copy = [...prev]
      copy.splice(at + 1, 0, { key: nextKey(), accountId, kind: next, amount: '' })
      return copy
    })
    setEqual(false)
  }

  const sameAsLastTime = () => {
    const sideAccounts = new Set(accounts.filter(a => a.side === side).map(a => a.id))
    const last = book.payouts.find(p => p.id !== editing?.id && p.lines.some(l => sideAccounts.has(l.accountId)) && !p.lines.every(l => l.kind === 'incentive'))
    if (!last) { setError(`No earlier payout for ${side}'s side.`); return }
    const copied = last.lines.filter(l => sideAccounts.has(l.accountId) && byId.get(l.accountId)?.isActive !== false)
    setLines(copied.map(l => ({ key: nextKey(), accountId: l.accountId, kind: l.kind, amount: paiseToText(l.paise) })))
    if (!totalPaise) setTotal(paiseToText(copied.reduce((s, l) => s + l.paise, 0)))
    setEqual(true)
    setError(null)
  }

  const save = async () => {
    if (saving || problems.length > 0) return
    setSaving(true)
    setError(null)
    try {
      await saveFounderPayout(supabase, {
        id: editing?.id ?? null,
        paidOn,
        paidFrom,
        note,
        bankReference: reference,
        lines: draftLines,
        idempotencyKey,
      })
      onSaved(editing ? 'Payout changed' : `Payout saved: ${formatRupees(sum)} into ${pickedIds.length} account${pickedIds.length === 1 ? '' : 's'}`, paidOn)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The payout could not be saved. Try again.')
      setSaving(false)
    }
  }

  const orderedAccounts = [
    ...accounts.filter(a => a.isActive && a.side === side),
    ...accounts.filter(a => a.isActive && a.side !== side),
    // An inactive account already on the payout being changed stays visible.
    ...accounts.filter(a => !a.isActive && pickedIds.includes(a.id)),
  ]

  return (
    <FinanceModal title={editing ? 'Change payout' : 'New payout'} onClose={onClose} width="620px" closeOnBackdropClick={false}>
      <div className="fp-form" data-testid="founder-payout-form">
        <div className="fp-form-row">
          <label className="fp-field">
            <span>Paid on</span>
            <input type="date" className="boe-input" value={paidOn} max={todayIso} onChange={e => setPaidOn(e.target.value)} />
          </label>
          <label className="fp-field">
            <span>Paid from</span>
            <select className="boe-input" value={paidFrom} onChange={e => setPaidFrom(e.target.value)}>
              {FOUNDER_PAID_FROM.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </label>
        </div>

        <label className="fp-field">
          <span>Total amount</span>
          <input
            className="boe-input fp-amount-big"
            inputMode="decimal"
            placeholder="₹ 1,50,000"
            value={total}
            onChange={e => setTotal(e.target.value)}
            aria-label="Total amount in rupees"
          />
        </label>

        {sides.length > 1 && (
          <div className="fp-field">
            <span>Whose share?</span>
            <div className="fp-seg" role="group" aria-label="Whose share">
              {sides.map(s => (
                <button key={s} type="button" aria-pressed={side === s} onClick={() => setSide(s)}>{s}&rsquo;s side</button>
              ))}
            </div>
          </div>
        )}

        <div className="fp-field">
          <span>Into which accounts?</span>
          {accounts.length === 0 ? (
            <p className="fin-muted" style={{ margin: 0, fontSize: 13 }}>Add the accounts first, on the Accounts tab.</p>
          ) : (
            <div className="fp-pick">
              {orderedAccounts.map((a, i) => (
                <span key={a.id} style={{ display: 'contents' }}>
                  {i > 0 && orderedAccounts[i - 1].side !== a.side && <span className="fp-pick-group">{a.side}&rsquo;s side</span>}
                  <button type="button" aria-pressed={pickedIds.includes(a.id)} onClick={() => toggle(a.id)}>{a.displayName}</button>
                </span>
              ))}
            </div>
          )}
          <div className="fp-inline-actions">
            {!editing && sides.length > 0 && <button type="button" className="boe-btn boe-btn-ghost" onClick={sameAsLastTime}>Same as last time</button>}
            <button type="button" className="boe-btn boe-btn-ghost" disabled={lines.length === 0} onClick={() => setEqual(true)}>Split equally</button>
          </div>
        </div>

        {shownLines.map(l => {
          const account = byId.get(l.accountId)
          if (!account) return null
          const kinds = kindsForRole(account.taxRole)
          const allKinds = kinds.includes(l.kind) ? kinds : [l.kind, ...kinds]
          const paise = parseAmountToPaise(l.amount)
          const already = before.get(account.id)
          const draftIncome = draftLines.filter(d => d.accountId === account.id && d.kind !== 'drawings').reduce((s, d) => s + d.paise, 0)
          let hint: ReactNode = null
          if (account.taxRole === 'unset') hint = <><span className="fin-pill fin-pill--zero">Role not set</span> <span className="fin-muted">Choose {account.displayName}&rsquo;s role on the Accounts tab to see the tax-free room.</span></>
          else if (account.taxRole === 'family') hint = <span className="fin-muted">Not {account.displayName}&rsquo;s income: it counts as {account.side}&rsquo;s drawing.</span>
          else if (l.kind === 'drawings') hint = <span className="fin-muted">A drawing (profit share or capital): not taxed again for {account.displayName}.</span>
          else if (rules && already) {
            const room = roomLeft(account.taxRole, (already.incomePaise + draftIncome) / 100, already.otherIncomePaise / 100, rules)
            if (room !== null && room >= 0) hint = <><span className="fin-pill fin-pill--full">Still tax-free</span> <span className="fin-muted">{formatLakh(room * 100)} room left in {taxYearLabel(taxYear)} after this</span></>
            else if (room !== null) {
              const tax = taxIfPaid(account.taxRole, already.incomePaise / 100, already.otherIncomePaise / 100, draftIncome / 100, rules) ?? 0
              hint = <><span className="fin-pill fin-pill--over">Over the tax-free line by {formatRupees(-room * 100)}</span> <span className="fin-muted">tax for the year about {formatRupees(tax * 100)}</span></>
            }
          }
          const canAddKind = kinds.some(k => !lines.some(x => x.accountId === account.id && x.kind === k))
          return (
            <div key={l.key} className="fp-line">
              <div className="fp-line-row">
                <span className="fp-line-name">{account.displayName}</span>
                <select className="boe-input" aria-label={`Kind of payment to ${account.displayName}`} value={l.kind}
                  onChange={e => setLines(prev => prev.map(x => (x.key === l.key ? { ...x, kind: e.target.value as FounderPayoutKind } : x)))}>
                  {allKinds.map(k => <option key={k} value={k}>{kindLabel(k)}</option>)}
                </select>
                <input className="boe-input fp-line-amount" inputMode="decimal" aria-label={`Amount to ${account.displayName}`}
                  value={l.amount}
                  onChange={e => {
                    const value = e.target.value
                    setLines(shownLines.map(x => (x.key === l.key ? { ...x, amount: value } : x)))
                    setEqual(false)
                  }} />
              </div>
              <div className="fp-line-hint">
                {hint}
                {canAddKind && <button type="button" className="fp-link" onClick={() => addKind(account.id)}>+ kind</button>}
                {paise === 0 && <span className="fin-muted">No amount yet</span>}
              </div>
            </div>
          )
        })}

        {lines.length > 0 && totalPaise > 0 && (
          <div className={`fp-sum ${sum === totalPaise ? 'is-ok' : 'is-off'}`} role="status">
            {sum === totalPaise
              ? `Adds up: ${formatRupees(sum)} into ${pickedIds.length} account${pickedIds.length === 1 ? '' : 's'}.`
              : <>The accounts add up to {formatRupees(sum)}: {formatRupees(Math.abs(totalPaise - sum))} {sum < totalPaise ? 'short of' : 'more than'} the total.{' '}
                  <button type="button" className="fp-link" onClick={() => setEqual(true)}>Split equally</button></>}
          </div>
        )}

        <label className="fp-field">
          <span>Note (optional)</span>
          <input className="boe-input" maxLength={300} value={note} placeholder="e.g. Nitish needed ₹1.5 lakh; matched for our side" onChange={e => setNote(e.target.value)} />
        </label>
        <label className="fp-field">
          <span>Bank reference / UTR (optional)</span>
          <input className="boe-input" maxLength={80} value={reference} onChange={e => setReference(e.target.value)} />
        </label>

        {error && <p className="fp-error" role="alert">{error}</p>}

        <div className="fp-modal-foot">
          <span className="fin-muted">{problems.length > 0 && lines.length > 0 ? problems[0] : ''}</span>
          <button type="button" className="boe-btn boe-btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="boe-btn boe-btn-primary" disabled={saving || problems.length > 0} onClick={() => void save()}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Save payout'}
          </button>
        </div>
      </div>
    </FinanceModal>
  )
}
