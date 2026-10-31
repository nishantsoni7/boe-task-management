'use client'

// ── Founders' payouts › Tax planner ──────────────────────────────────────────
//
// Two jobs, worked in the order the money works. First the firm: expected book
// profit, the ceiling on partner remuneration it allows, what has been paid, what
// is left. Then each person, grouped by side: the role in BOE, what has counted
// as their income, their other income (typed here), the room left under the
// tax-free limit, the room per month until March, and "what if you pay more" to
// see the tax an amount would cost. The explanations fold away below; the warning
// to take this to the CA stays in view.
//
// The figures come from src/lib/finance/founderPayoutTax.ts and are never
// stored. They are general rules, so the page sends the owner to the CA.

import { useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ChevronRight, Info } from 'lucide-react'
import {
  FOUNDER_TAX_ROLES,
  accountsBySide,
  formatLakh,
  formatRupees,
  monthsLeftInTaxYear,
  taxYearLabel,
  type AccountYear,
  type FounderAccount,
  type FounderYear,
} from '@/lib/finance/founderPayouts'
import { remunerationCeiling, roomLeft, rulesFor, taxFreeLimit, taxIfPaid, type TaxRole, type TaxYearRules } from '@/lib/finance/founderPayoutTax'
import { parseAmountToPaise } from './FounderPayoutModal'
import { Meter, SideLabel, meterTone } from './FounderParts'
import { saveBookProfit, saveFounderAccount, saveOtherIncome } from './founderPayoutsData'
import styles from './founders.module.css'

/** ₹12,34,567 is read as 12,34,567 here, not 1234567; both parsers below drop the commas. */
const rupeeText = (paise: number | null) =>
  (paise === null ? '' : (Math.round(paise) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 }))

/** A person with no other income shows an empty box rather than a zero to type over. */
const otherIncomeText = (paise: number) => (paise === 0 ? '' : rupeeText(paise))

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
    Object.fromEntries(year.accounts.map(a => [a.account.id, otherIncomeText(a.otherIncomePaise)])))
  const [trial, setTrial] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  if (!found) {
    return (
      <div className={styles.note} role="status">
        The tax rules for {taxYearLabel(year.taxYear)} are not in the app (the regime before 2025-26 was different), so this year shows totals only.
      </div>
    )
  }
  const rules = found.rules

  const commitBookProfit = async () => {
    const paise = parseSignedPaise(bookProfit)
    if (paise === year.bookProfitPaise) return
    setBusy(true)
    try {
      await saveBookProfit(supabase, year.taxYear, paise)
      setBookProfit(rupeeText(paise))
      await onChanged()
    } catch (e) { show(e instanceof Error ? e.message : 'Could not save the book profit', 'error') }
    setBusy(false)
  }

  const commitOther = async (account: FounderAccount, before: number) => {
    const paise = parseAmountToPaise(other[account.id] ?? '')
    if (paise === before) return
    setBusy(true)
    try {
      await saveOtherIncome(supabase, year.taxYear, account.id, paise)
      setOther(prev => ({ ...prev, [account.id]: otherIncomeText(paise) }))
      await onChanged()
    } catch (e) { show(e instanceof Error ? e.message : 'Could not save the other income', 'error') }
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
  const ceilingUsed = ceilingPaise ? (year.partnerRemunerationPaise / ceilingPaise) * 100 : 0
  const groups = accountsBySide(year, a => a.account.isActive || a.totalPaise > 0)

  return (
    <div data-testid="founder-planner">
      {found.assumed && (
        <div className={`${styles.note} ${styles.noteWarn}`} role="status">
          The figures for {taxYearLabel(year.taxYear)} are not published in the app yet; these use the {taxYearLabel(rules.taxYear)} rules until they are added.
        </div>
      )}

      <section className={`fin-board ${styles.panel}`} aria-label="The firm's ceiling on partner remuneration">
        <div className={styles.panelHead}>
          <h3>The firm&rsquo;s ceiling on partner remuneration</h3>
          <p>What BOE can count as a cost in {taxYearLabel(year.taxYear)}, from its profit</p>
        </div>
        <div className={styles.ceilingSum}>
          <label className={styles.fig}>
            <span>Expected book profit, before partner remuneration</span>
            <input className="boe-input" inputMode="decimal" placeholder="₹ e.g. 40,00,000" value={bookProfit} disabled={busy}
              onChange={e => setBookProfit(e.target.value)} onBlur={() => void commitBookProfit()}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
          </label>
          <div className={styles.op} aria-hidden="true">→</div>
          <div className={styles.fig}><span>Ceiling for all working partners</span><b>{ceilingPaise === null ? '—' : formatLakh(ceilingPaise)}</b></div>
          <div className={styles.op} aria-hidden="true">−</div>
          <div className={styles.fig}><span>Paid to working partners so far</span><b>{formatLakh(year.partnerRemunerationPaise)}</b></div>
          <div className={styles.op} aria-hidden="true">=</div>
          <div className={styles.fig}>
            <span>Left under the ceiling</span>
            {ceilingLeft === null ? <b className={styles.muted}>Type the book profit</b>
              : <b className={ceilingLeft < 0 ? styles.bad : styles.good}>{formatLakh(ceilingLeft)}</b>}
          </div>
        </div>
        <div className={styles.ceilingFoot}>
          {ceilingLeft !== null && (
            <Meter percent={ceilingLeft < 0 ? 100 : ceilingUsed} tone={meterTone(ceilingLeft, ceilingUsed)}
              label={`${formatLakh(year.partnerRemunerationPaise)} of the ${formatLakh(ceilingPaise ?? 0)} ceiling used`} />
          )}
          <p>On the first ₹6,00,000 of book profit (or a loss): ₹3,00,000 or 90%, whichever is higher; on the rest, 60%. Interest on partners&rsquo; capital is allowed on top, up to 12% a year.</p>
        </div>
      </section>

      <section className={`fin-board ${styles.panel}`} aria-label="How much more each person can take">
        <div className={styles.panelHead}>
          <h3>How much more each person can take</h3>
          <p>Under the tax-free limit, for {taxYearLabel(year.taxYear)}</p>
        </div>
        <div className="fin-table-wrap">
          <table className={`fin-table ${styles.table} ${styles.tableCards} ${styles.plan}`}>
            <colgroup>
              <col style={{ width: 164 }} />
              <col style={{ width: 226 }} />
              <col style={{ width: 132 }} />
              <col style={{ width: 122 }} />
              <col />
              <col style={{ width: 136 }} />
              <col style={{ width: 224 }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Role in BOE</th>
                <th scope="col" className="fin-num">Counts as income</th>
                <th scope="col" className="fin-num">Other income</th>
                <th scope="col" className={styles.roomHead}>Room left</th>
                <th scope="col" className="fin-num">{monthsLeft > 0 ? `Per month (${monthsLeft} left)` : 'Per month'}</th>
                <th scope="col">What if you pay more</th>
              </tr>
            </thead>
            {groups.map(({ side, accounts }) => (
              <tbody key={side.side}>
                <tr className={styles.sideRow}><td colSpan={7}><SideLabel sides={year.sides} side={side.side} /></td></tr>
                {accounts.map(a => (
                  <PersonRow key={a.account.id} entry={a} rules={rules} monthsLeft={monthsLeft} busy={busy}
                    other={other[a.account.id] ?? ''} onOther={value => setOther(prev => ({ ...prev, [a.account.id]: value }))}
                    onOtherDone={() => void commitOther(a.account, a.otherIncomePaise)}
                    onRole={role => void changeRole(a.account, role)}
                    trial={trial[a.account.id] ?? ''} onTrial={value => setTrial(prev => ({ ...prev, [a.account.id]: value }))} />
                ))}
              </tbody>
            ))}
          </table>
        </div>
      </section>

      <p className={styles.note}>
        <Info size={15} strokeWidth={1.8} aria-hidden="true" />
        <span>General rules, not advice for your family. Before planning the year on them, show this page to your CA, who knows the partnership deed and who holds what share.</span>
      </p>

      <details className={styles.how}>
        <summary><ChevronRight size={15} strokeWidth={2} aria-hidden="true" /> How these numbers work ({taxYearLabel(rules.taxYear)})</summary>
        <div className={styles.howBody}>
          <div className={styles.howThree}>
            <div>
              <h4>The ₹12 lakh line</h4>
              <p>Under the new regime a person pays <b>no tax</b> when their total income for the year is ₹12,00,000 or less. Just above it, almost every extra rupee goes in tax until about ₹12.7 lakh.</p>
            </div>
            <div>
              <h4>Who has room</h4>
              <p>Only money that is really that person&rsquo;s income uses their limit: a working partner&rsquo;s remuneration, incentive and interest (₹12 lakh), or an employee&rsquo;s salary (₹12.75 lakh). Family who do not work in BOE have none.</p>
            </div>
            <div>
              <h4>The firm&rsquo;s ceiling</h4>
              <p>BOE can count partner remuneration as a cost only up to a ceiling worked out from its profit, and only if the partnership deed allows it.</p>
            </div>
          </div>
          <ul>
            <li><b>Other income</b> is anything else the person earns in the year: FD or savings interest, rent, a pension, another job. It lowers the room. The tax shown includes the 4% cess; surcharge (above ₹50 lakh) is ignored. Drawings are left out of &ldquo;counts as income&rdquo;: a partner&rsquo;s profit share is not taxed again in their hands.</li>
            <li><b>New regime slabs:</b> nil up to ₹4 L · 5% to ₹8 L · 10% to ₹12 L · 15% to ₹16 L · 20% to ₹20 L · 25% to ₹24 L · 30% above. A rebate wipes out the tax when total income is ₹12 L or less; just above, marginal relief caps the tax at the amount over ₹12 L.</li>
            <li><b>Standard deduction</b> of ₹75,000 is for salary and pension only. A partner&rsquo;s remuneration is business income and gets none.</li>
            <li><b>TDS:</b> the firm must deduct {Math.round(rules.tdsRate * 100)}% on a partner&rsquo;s remuneration, commission, bonus or interest once it passes {formatRupees(rules.tdsThreshold * 100)} in the year. A partner who stays under ₹12 L gets it back as a refund in the return.</li>
            <li><b>Profit share</b> a partner takes from the firm&rsquo;s taxed profit is not taxed again in the partner&rsquo;s hands, but the firm pays about 31% on that profit first.</li>
            <li><b>Family who do not work in BOE:</b> money paid to them is not their income; it is the partner&rsquo;s own drawing given to them. Interest it earns later can be theirs, except for a spouse or a minor child, where it is added back to the giver.</li>
            <li><b>Spouses:</b> if a partner with 20% or more of the firm has a spouse who is also paid by it, that pay can be taxed in the partner&rsquo;s hands, unless it comes from the spouse&rsquo;s own professional qualification.</li>
          </ul>
        </div>
      </details>
    </div>
  )
}

function PersonRow({ entry, rules, monthsLeft, busy, other, onOther, onOtherDone, onRole, trial, onTrial }: {
  entry: AccountYear
  rules: TaxYearRules
  monthsLeft: number
  busy: boolean
  other: string
  onOther: (value: string) => void
  onOtherDone: () => void
  onRole: (role: TaxRole) => void
  trial: string
  onTrial: (value: string) => void
}) {
  const { account, incomePaise, otherIncomePaise, totalPaise } = entry
  const role = account.taxRole
  const name = account.displayName
  const limit = taxFreeLimit(role, rules)
  const room = roomLeft(role, incomePaise / 100, otherIncomePaise / 100, rules)
  const tryPaise = parseAmountToPaise(trial)
  const tax = tryPaise > 0 ? taxIfPaid(role, incomePaise / 100, otherIncomePaise / 100, tryPaise / 100, rules) : null
  // How much of the limit is gone: other income uses it up as well as what BOE paid.
  const percent = limit && room !== null ? ((limit - room) / limit) * 100 : 0

  return (
    <tr>
      <td><span className={styles.name}>{name}</span></td>
      <td data-l="Role in BOE">
        <select className="boe-input" aria-label={`Role in BOE of ${name}`} value={role} disabled={busy}
          onChange={e => onRole(e.target.value as TaxRole)}>
          {FOUNDER_TAX_ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
      </td>
      <td className="fin-num" data-l="Counts as income">
        <span className={styles.num}>{formatRupees(incomePaise)}</span>
        {totalPaise !== incomePaise && <span className="fin-sub">of {formatRupees(totalPaise)} paid</span>}
      </td>
      <td className="fin-num" data-l="Other income">
        <input className={`boe-input ${styles.numInput}`} inputMode="decimal" placeholder="₹ 0" aria-label={`Other income of ${name}`}
          value={other} disabled={busy}
          onChange={e => onOther(e.target.value)}
          onBlur={onOtherDone}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
      </td>
      {room === null ? (
        <td colSpan={3} className={`${styles.roomCell} ${styles.wide}`}>
          <div className={styles.roomNone}>
            {role === 'unset' ? 'Choose the role to see the room.' : `Not ${name}’s income: it counts as ${account.side}’s drawing, so there is no room to use.`}
          </div>
        </td>
      ) : (
        <>
          <td className={`${styles.roomCell} ${styles.wide}`} data-l="Room left">
            <div className={styles.room}>
              <Meter percent={room < 0 ? 100 : percent} tone={meterTone(room, percent)} label={`${formatLakh(room * 100)} left of the ${formatLakh((limit ?? 0) * 100)} limit`} />
              <div className={styles.roomWords}>
                {room < 0 ? <b className={styles.bad}>{formatLakh(-room * 100)} over the line</b>
                  : <><b>{formatLakh(room * 100)}</b> left of the {formatLakh((limit ?? 0) * 100)} limit</>}
              </div>
            </div>
          </td>
          <td className="fin-num" data-l="Per month">
            {monthsLeft === 0 ? '—' : room <= 0 ? <span className={styles.muted}>Stop for this year</span>
              : <span className={styles.num}>{formatLakh((room / monthsLeft) * 100)}</span>}
          </td>
          <td className={styles.wide} data-l="What if you pay more">
            <div className={styles.tryBox}>
              <input className={`boe-input ${styles.numInput}`} inputMode="decimal" placeholder="₹ more" aria-label={`Try an amount for ${name}`}
                value={trial} onChange={e => onTrial(e.target.value)} />
              <span aria-live="polite">
                {tryPaise === 0 || tax === null ? null
                  : tax === 0 ? <span className="fin-pill fin-pill--full">No tax</span>
                  : <span className="fin-pill fin-pill--over">{formatRupees(tax * 100)} tax</span>}
              </span>
            </div>
          </td>
        </>
      )}
    </tr>
  )
}
