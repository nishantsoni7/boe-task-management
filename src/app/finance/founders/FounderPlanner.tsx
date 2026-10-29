'use client'

// ── Founders' payouts › Tax planner ──────────────────────────────────────────
//
// Per person, for the chosen financial year: the role in BOE, what they have
// received that counts as their income, their other income (typed here), the
// tax-free limit, the room left, the room per month until March, and "try an
// amount" to see the tax it would cost. Above the table, the firm's ceiling on
// partner remuneration from the expected book profit.
//
// The figures come from src/lib/finance/founderPayoutTax.ts and are never
// stored. They are general rules, so the page sends the owner to the CA.

import { useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  FOUNDER_TAX_ROLES,
  formatLakh,
  formatRupees,
  monthsLeftInTaxYear,
  taxYearLabel,
  type FounderAccount,
  type FounderYear,
} from '@/lib/finance/founderPayouts'
import { remunerationCeiling, roomLeft, rulesFor, taxFreeLimit, taxIfPaid, type TaxRole } from '@/lib/finance/founderPayoutTax'
import { parseAmountToPaise } from './FounderPayoutModal'
import { saveBookProfit, saveFounderAccount, saveOtherIncome } from './founderPayoutsData'

const rupeeText = (paise: number | null) => (paise === null ? '' : String(Math.round(paise) / 100))

/** A book profit may be a loss: '-2,50,000' → negative paise; blank → null. */
function parseSignedPaise(text: string): number | null {
  const cleaned = text.replace(/[,\s₹]/g, '')
  if (cleaned === '') return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

export function FounderPlanner({
  supabase,
  year,
  todayIso,
  onChanged,
  show,
}: {
  supabase: SupabaseClient
  year: FounderYear
  todayIso: string
  onChanged: () => Promise<void>
  show: (message: string, variant?: 'success' | 'error') => void
}) {
  const found = rulesFor(year.taxYear)
  const monthsLeft = monthsLeftInTaxYear(todayIso, year.taxYear)
  const [bookProfit, setBookProfit] = useState(rupeeText(year.bookProfitPaise))
  const [other, setOther] = useState<Record<string, string>>(() =>
    Object.fromEntries(year.accounts.map(a => [a.account.id, rupeeText(a.otherIncomePaise)])))
  const [trial, setTrial] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  if (!found) {
    return (
      <div className="boe-card fp-note" role="status">
        The tax rules for {taxYearLabel(year.taxYear)} are not in the app (the regime before 2025-26 was different), so this year shows totals only.
      </div>
    )
  }
  const rules = found.rules

  const commitBookProfit = async () => {
    const paise = parseSignedPaise(bookProfit)
    if (paise === year.bookProfitPaise) return
    setBusy(true)
    try { await saveBookProfit(supabase, year.taxYear, paise); await onChanged() }
    catch (e) { show(e instanceof Error ? e.message : 'Could not save the book profit', 'error') }
    setBusy(false)
  }

  const commitOther = async (account: FounderAccount, before: number) => {
    const paise = parseAmountToPaise(other[account.id] ?? '')
    if (paise === before) return
    setBusy(true)
    try { await saveOtherIncome(supabase, year.taxYear, account.id, paise); await onChanged() }
    catch (e) { show(e instanceof Error ? e.message : 'Could not save the other income', 'error') }
    setBusy(false)
  }

  const changeRole = async (account: FounderAccount, taxRole: TaxRole) => {
    setBusy(true)
    try {
      await saveFounderAccount(supabase, { id: account.id, displayName: account.displayName, side: account.side, taxRole, bankLabel: account.bankLabel ?? '', isActive: account.isActive })
      await onChanged()
      show(`${account.displayName}: ${FOUNDER_TAX_ROLES.find(r => r.value === taxRole)?.label}`)
    } catch (e) { show(e instanceof Error ? e.message : 'Could not change the role', 'error') }
    setBusy(false)
  }

  const ceilingPaise = year.bookProfitPaise === null ? null : remunerationCeiling(year.bookProfitPaise / 100, rules) * 100
  const ceilingLeft = ceilingPaise === null ? null : ceilingPaise - year.partnerRemunerationPaise
  const rows = year.accounts.filter(a => a.account.isActive || a.totalPaise > 0)

  return (
    <div className="fp-planner" data-testid="founder-planner">
      {found.assumed && (
        <div className="fp-note fp-note--warn" role="status">
          The figures for {taxYearLabel(year.taxYear)} are not published in the app yet; these use the {taxYearLabel(rules.taxYear)} rules until they are added.
        </div>
      )}

      <div className="fp-explain">
        <div className="boe-card">
          <h3>The ₹12 lakh line</h3>
          <p>Under the new regime a person pays <b>no tax</b> when their total income for the year is ₹12,00,000 or less. Just above it, almost every extra rupee goes in tax until about ₹12.7 lakh.</p>
        </div>
        <div className="boe-card">
          <h3>Who has room</h3>
          <p>Only money that is really that person&rsquo;s income uses their limit: a working partner&rsquo;s remuneration, incentive and interest (₹12 lakh), or an employee&rsquo;s salary (₹12.75 lakh). Family who do not work in BOE have none.</p>
        </div>
        <div className="boe-card">
          <h3>The firm&rsquo;s ceiling</h3>
          <p>BOE can count partner remuneration as a cost only up to a ceiling worked out from its profit, and only if the partnership deed allows it.</p>
        </div>
      </div>

      <div className="boe-card fp-ceiling">
        <label className="fp-field">
          <span>Expected book profit of BOE in {taxYearLabel(year.taxYear)} (before partner remuneration)</span>
          <input className="boe-input" inputMode="decimal" placeholder="₹ e.g. 40,00,000" value={bookProfit} disabled={busy}
            onChange={e => setBookProfit(e.target.value)} onBlur={() => void commitBookProfit()}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
        </label>
        <div><span className="fin-muted">Ceiling for all working partners</span><b>{ceilingPaise === null ? '—' : formatLakh(ceilingPaise)}</b></div>
        <div><span className="fin-muted">Paid to working partners so far</span><b>{formatLakh(year.partnerRemunerationPaise)}</b></div>
        <div><span className="fin-muted">Left under the ceiling</span>
          <b className={ceilingLeft !== null && ceilingLeft < 0 ? 'fp-bad' : 'fp-good'}>{ceilingLeft === null ? 'Type the book profit' : formatLakh(ceilingLeft)}</b></div>
        <p className="fin-muted fp-small">On the first ₹6,00,000 of book profit (or a loss): ₹3,00,000 or 90%, whichever is higher; on the rest, 60%. Interest on partners&rsquo; capital is allowed on top, up to 12% a year.</p>
      </div>

      <div className="fin-board fp-plan-board">
        <table className="fin-table fp-plan-table">
          <thead>
            <tr>
              <th style={{ width: '15%' }}>Account</th>
              <th style={{ width: '17%' }}>Role in BOE</th>
              <th className="fin-num">Counts as income</th>
              <th className="fin-num">Other income</th>
              <th className="fin-num">Tax-free limit</th>
              <th className="fin-num">Room left</th>
              <th className="fin-num">{monthsLeft > 0 ? `Per month (${monthsLeft} left)` : 'Per month'}</th>
              <th className="fin-num">Try an amount</th>
              <th className="fin-num">Tax on that</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(a => {
              const role = a.account.taxRole
              const limit = taxFreeLimit(role, rules)
              const room = roomLeft(role, a.incomePaise / 100, a.otherIncomePaise / 100, rules)
              const tryPaise = parseAmountToPaise(trial[a.account.id] ?? '')
              const tax = tryPaise > 0 ? taxIfPaid(role, a.incomePaise / 100, a.otherIncomePaise / 100, tryPaise / 100, rules) : null
              return (
                <tr key={a.account.id}>
                  <td data-l="Account"><span className="fin-primary-text">{a.account.displayName}</span><span className="fin-sub">{a.account.side}</span></td>
                  <td data-l="Role in BOE">
                    <select className="boe-input" aria-label={`Role in BOE of ${a.account.displayName}`} value={role} disabled={busy}
                      onChange={e => void changeRole(a.account, e.target.value as TaxRole)}>
                      {FOUNDER_TAX_ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </select>
                  </td>
                  <td className="fin-num" data-l="Counts as income">
                    {formatRupees(a.incomePaise)}
                    {a.totalPaise !== a.incomePaise && <span className="fin-sub">of {formatRupees(a.totalPaise)} paid</span>}
                  </td>
                  <td className="fin-num" data-l="Other income">
                    <input className="boe-input fp-num-input" inputMode="decimal" aria-label={`Other income of ${a.account.displayName}`}
                      value={other[a.account.id] ?? ''} disabled={busy}
                      onChange={e => setOther(prev => ({ ...prev, [a.account.id]: e.target.value }))}
                      onBlur={() => void commitOther(a.account, a.otherIncomePaise)}
                      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
                  </td>
                  <td className="fin-num" data-l="Tax-free limit">
                    {role === 'unset' ? <span className="fin-pill fin-pill--zero">Set the role</span>
                      : limit === null ? <span className="fin-muted">Not their income</span> : formatLakh(limit * 100)}
                  </td>
                  <td className="fin-num" data-l="Room left">
                    {room === null ? '—' : <b className={room < 0 ? 'fp-bad' : 'fp-good'}>{formatLakh(room * 100)}</b>}
                  </td>
                  <td className="fin-num" data-l="Per month">
                    {room === null || monthsLeft === 0 ? '—' : room <= 0 ? <span className="fin-muted">Stop for this year</span> : formatLakh((room / monthsLeft) * 100)}
                  </td>
                  <td className="fin-num" data-l="Try an amount">
                    <input className="boe-input fp-num-input" inputMode="decimal" placeholder="₹ more" aria-label={`Try an amount for ${a.account.displayName}`}
                      value={trial[a.account.id] ?? ''} onChange={e => setTrial(prev => ({ ...prev, [a.account.id]: e.target.value }))} />
                  </td>
                  <td className="fin-num" data-l="Tax on that">
                    {tryPaise === 0 ? '—'
                      : tax === null ? <span className="fin-muted">{role === 'unset' ? 'Set the role first' : 'Not their income'}</span>
                      : tax === 0 ? <span className="fin-pill fin-pill--full">No tax</span>
                      : <span className="fin-pill fin-pill--over">{formatRupees(tax * 100)}</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="fin-muted fp-small">&ldquo;Other income&rdquo; is anything else the person earns in the year: FD or savings interest, rent, a pension, another job. It lowers the room. The tax shown includes the 4% cess; surcharge (above ₹50 lakh) is ignored. Drawings are left out of &ldquo;counts as income&rdquo;: a partner&rsquo;s profit share is not taxed again in their hands.</p>

      <details className="fp-rules">
        <summary>The rules behind these numbers ({taxYearLabel(rules.taxYear)})</summary>
        <ul>
          <li><b>New regime slabs:</b> nil up to ₹4 L · 5% to ₹8 L · 10% to ₹12 L · 15% to ₹16 L · 20% to ₹20 L · 25% to ₹24 L · 30% above. A rebate wipes out the tax when total income is ₹12 L or less; just above, marginal relief caps the tax at the amount over ₹12 L.</li>
          <li><b>Standard deduction</b> of ₹75,000 is for salary and pension only. A partner&rsquo;s remuneration is business income and gets none.</li>
          <li><b>TDS:</b> the firm must deduct {Math.round(rules.tdsRate * 100)}% on a partner&rsquo;s remuneration, commission, bonus or interest once it passes {formatRupees(rules.tdsThreshold * 100)} in the year. A partner who stays under ₹12 L gets it back as a refund in the return.</li>
          <li><b>Profit share</b> a partner takes from the firm&rsquo;s taxed profit is not taxed again in the partner&rsquo;s hands, but the firm pays about 31% on that profit first.</li>
          <li><b>Family who do not work in BOE:</b> money paid to them is not their income; it is the partner&rsquo;s own drawing given to them. Interest it earns later can be theirs, except for a spouse or a minor child, where it is added back to the giver.</li>
          <li><b>Spouses:</b> if a partner with 20% or more of the firm has a spouse who is also paid by it, that pay can be taxed in the partner&rsquo;s hands, unless it comes from the spouse&rsquo;s own professional qualification.</li>
        </ul>
        <p className="fp-note fp-note--warn">General rules, not advice for your family. Before planning the year on them, show this page to your CA, who knows the partnership deed and who holds what share.</p>
      </details>
    </div>
  )
}
