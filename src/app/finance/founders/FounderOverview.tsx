'use client'

// ── Founders' payouts › Overview ─────────────────────────────────────────────
//
// Three questions, in the order the owner asks them: are the two sides level
// (the figures), what has each person had and how much more can they take
// tax-free (one table, grouped by side, so the money lines up and adds up), and
// when did it go out (the months). Payouts are irregular, so the months are a
// grid of exact amounts: a bar chart of a sparse year is mostly empty.

import { Check, TriangleAlert } from 'lucide-react'
import { FinanceEmpty } from '@/app/finance/components/FinanceListParts'
import {
  accountsBySide,
  equalShareGap,
  formatLakh,
  formatRupees,
  kindsPaidIn,
  monthShade,
  monthsLeftInTaxYear,
  roleLabel,
  taxYearLabel,
  taxYearMonths,
  taxYearOf,
  type AccountYear,
  type FounderYear,
} from '@/lib/finance/founderPayouts'
import { roomLeft, rulesFor, type TaxYearRules } from '@/lib/finance/founderPayoutTax'
import { Meter, SideDot, SideLabel, meterTone } from './FounderParts'
import styles from './founders.module.css'

const SHADE = ['', styles.shade1, styles.shade2, styles.shade3]

/** Blank for nothing paid, so the figures that are there stand out. */
function Money({ paise }: { paise: number }) {
  return paise === 0 ? <span className={styles.dash}>–</span> : <>{formatRupees(paise)}</>
}

export function monthName(yyyyMm: string, style: 'short' | 'long' = 'short'): string {
  return new Date(`${yyyyMm}-01T00:00:00`).toLocaleDateString('en-IN', style === 'short' ? { month: 'short' } : { month: 'long', year: 'numeric' })
}

export function FounderOverview({ year, todayIso, hasAccounts, onOpenAccounts, onNewPayout }: {
  year: FounderYear
  todayIso: string
  hasAccounts: boolean
  onOpenAccounts: () => void
  onNewPayout: () => void
}) {
  if (!hasAccounts) {
    return (
      <div className="fin-board">
        <FinanceEmpty icon="box" title="Start with the accounts money goes into"
          body="Add each person once (name, whose side, role in BOE). Then every payout is a few taps."
          action={<button className="boe-btn boe-btn-primary" onClick={onOpenAccounts}>Add the first account</button>} />
      </div>
    )
  }

  const rules = rulesFor(year.taxYear)?.rules ?? null
  const monthsLeft = monthsLeftInTaxYear(todayIso, year.taxYear)
  const isCurrent = year.taxYear === taxYearOf(todayIso)
  const gap = equalShareGap(year.sides)
  const incentive = year.sides.reduce((s, x) => s + x.incentivePaise, 0)
  const groups = accountsBySide(year, a => a.totalPaise > 0 || (isCurrent && a.account.isActive))
  const kinds = kindsPaidIn(year)

  return (
    <div data-testid="founder-overview">
      <div className="fin-stats">
        <div className="fin-stat">
          <div className="fin-stat-label">Paid in {taxYearLabel(year.taxYear)}</div>
          <div className="fin-stat-value">{formatLakh(year.totalPaise)}</div>
          <div className="fin-stat-sub">{year.payoutCount} payout{year.payoutCount === 1 ? '' : 's'}{incentive > 0 ? ` · ${formatLakh(incentive)} incentive` : ''}</div>
        </div>
        {year.sides.slice(0, 2).map(s => (
          <div key={s.side} className="fin-stat">
            <div className="fin-stat-label"><SideDot sides={year.sides} side={s.side} /> {s.side}&rsquo;s side, equal share</div>
            <div className="fin-stat-value">{formatLakh(s.equalSharePaise)}</div>
            <div className="fin-stat-sub">{s.incentivePaise > 0 ? `plus ${formatLakh(s.incentivePaise)} incentive, kept apart` : `${s.accountCount} account${s.accountCount === 1 ? '' : 's'} paid`}</div>
          </div>
        ))}
        {gap ? (
          <div className="fin-stat" data-testid="founder-gap">
            <div className="fin-stat-label">Gap between the sides</div>
            <div className={`fin-stat-value ${styles.statState} ${gap.paise === 0 ? styles.good : styles.warn}`}>
              {gap.paise === 0 ? <><Check size={16} strokeWidth={2.4} aria-hidden="true" /> Level</> : <><TriangleAlert size={16} strokeWidth={2} aria-hidden="true" /> {formatLakh(gap.paise)}</>}
            </div>
            <div className="fin-stat-sub">{gap.paise === 0 ? 'Both sides have had the same' : `${gap.behind}’s side is behind`}</div>
          </div>
        ) : year.sides.length > 2 ? (
          <div className="fin-stat"><div className="fin-stat-label">Sides</div><div className="fin-stat-value">{year.sides.length}</div><div className="fin-stat-sub">The gap is shown for exactly two sides</div></div>
        ) : (
          <button type="button" className={styles.statPrompt} data-testid="founder-add-side" onClick={onOpenAccounts}>
            <b>Add the other partner&rsquo;s accounts</b>
            <span>Then the two sides are compared here, and the gap between them shows.</span>
          </button>
        )}
      </div>

      {year.lines.length === 0 && (
        <div className={`fin-board ${styles.panel}`}>
          <FinanceEmpty icon="card" title={`Nothing recorded for ${taxYearLabel(year.taxYear)} yet`}
            body="Record each payout as it happens, or add the earlier ones of this year from the bank statements."
            action={<button className="boe-btn boe-btn-primary" onClick={onNewPayout}>+ New payout</button>} />
        </div>
      )}

      {groups.length > 0 && (
        <section className={`fin-board ${styles.panel}`} aria-label="Each account">
          <div className={styles.panelHead}>
            <h3>Each account</h3>
            <p>What each person received in {taxYearLabel(year.taxYear)}, and how much more they can take tax-free</p>
          </div>
          <div className="fin-table-wrap">
            <table className={`fin-table ${styles.table} ${styles.tableCards}`} style={{ minWidth: 668 + kinds.length * 118 }}>
              <colgroup>
                <col style={{ width: 240 }} />
                {kinds.map(k => <col key={k.value} style={{ width: 118 }} />)}
                <col style={{ width: 128 }} />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  {kinds.map(k => <th key={k.value} scope="col" className="fin-num">{k.short}</th>)}
                  <th scope="col" className="fin-num">Total</th>
                  <th scope="col" className={styles.roomHead}>Tax-free room</th>
                </tr>
              </thead>
              {groups.map(({ side, accounts }) => (
                <tbody key={side.side}>
                  <tr className={styles.sideRow}>
                    <td><SideLabel sides={year.sides} side={side.side} count={accounts.length} /></td>
                    {kinds.map(k => <td key={k.value} className="fin-num"><Money paise={accounts.reduce((s, a) => s + (a.byKind.get(k.value) ?? 0), 0)} /></td>)}
                    <td className={`fin-num ${styles.sideTotal}`}>{formatRupees(side.totalPaise)}</td>
                    <td />
                  </tr>
                  {accounts.map(a => (
                    <tr key={a.account.id}>
                      <td>
                        <span className={styles.name}>{a.account.displayName}</span>
                        <span className="fin-sub">{roleLabel(a.account.taxRole)}</span>
                      </td>
                      {kinds.map(k => {
                        const paise = a.byKind.get(k.value) ?? 0
                        return <td key={k.value} className={`fin-num${paise === 0 ? ` ${styles.blank}` : ''}`} data-l={k.short}><Money paise={paise} /></td>
                      })}
                      <td className="fin-num" data-l="Total"><span className={styles.amount}>{formatRupees(a.totalPaise)}</span></td>
                      <td className={`${styles.roomCell} ${styles.wide}`}>
                        <RoomLeft entry={a} rules={rules} isCurrent={isCurrent} monthsLeft={monthsLeft} onOpenAccounts={onOpenAccounts} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              ))}
              {year.sides.length > 1 && (
                <tfoot>
                  <tr>
                    <td>All accounts</td>
                    {kinds.map(k => <td key={k.value} className="fin-num">{formatRupees(year.accounts.reduce((s, a) => s + (a.byKind.get(k.value) ?? 0), 0))}</td>)}
                    <td className={`fin-num ${styles.sideTotal}`}>{formatRupees(year.totalPaise)}</td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </section>
      )}

      {year.lines.length > 0 && <MonthGrid year={year} todayIso={todayIso} />}
    </div>
  )
}

function RoomLeft({ entry, rules, isCurrent, monthsLeft, onOpenAccounts }: {
  entry: AccountYear
  rules: TaxYearRules | null
  isCurrent: boolean
  monthsLeft: number
  onOpenAccounts: () => void
}) {
  const { account, incomePaise, otherIncomePaise } = entry
  if (!rules) return <div className={styles.roomNone}>Tax rules for this year are not in the app.</div>
  if (account.taxRole === 'unset') {
    return <div className={styles.roomNone}><button type="button" className={styles.roleChip} onClick={onOpenAccounts}>Set the role</button> to see the tax-free room</div>
  }
  if (account.taxRole === 'family') {
    return <div className={styles.roomNone}>Not {account.displayName}&rsquo;s income: counts as {account.side}&rsquo;s drawing</div>
  }
  const room = roomLeft(account.taxRole, incomePaise / 100, otherIncomePaise / 100, rules)
  if (room === null) return null
  // The person's own limit after their other income: what has counted plus what is left.
  const limit = incomePaise + room * 100
  const percent = room < 0 ? 100 : (incomePaise / Math.max(1, limit)) * 100
  return (
    <div className={styles.room}>
      <Meter percent={percent} tone={meterTone(room, percent)} label={`${formatLakh(incomePaise)} of ${formatLakh(limit)} tax-free used`} />
      <div className={styles.roomWords}>
        {room < 0 ? <b className={styles.bad}>{formatLakh(-room * 100)} over the line</b>
          : !isCurrent ? <>Year closed <b>{formatLakh(room * 100)}</b> under the line</>
          : <><b>{formatLakh(room * 100)} left</b> of {formatLakh(limit)}{monthsLeft > 0 ? <> · about <b>{formatLakh((room * 100) / monthsLeft)}</b> a month</> : null}</>}
      </div>
    </div>
  )
}

function MonthGrid({ year, todayIso }: { year: FounderYear; todayIso: string }) {
  const months = taxYearMonths(year.taxYear)
  const thisMonth = todayIso.slice(0, 7)
  const maxMonth = Math.max(0, ...months.flatMap(m => [...(year.months.get(m)?.values() ?? [])]))
  return (
    <section className={`fin-board ${styles.panel}`} aria-label="Month by month">
      <div className={styles.panelHead}>
        <h3>Month by month</h3>
        <p>April to March. The darker the cell, the more was paid.</p>
      </div>
      <div className="fin-table-wrap">
        <table className={`fin-table ${styles.table} ${styles.months}`}>
          <colgroup>
            <col style={{ width: 132 }} />
            {months.map(m => <col key={m} />)}
            <col style={{ width: 92 }} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Side</th>
              {months.map(m => <th key={m} scope="col" className={m === thisMonth ? styles.isNow : m > thisMonth ? styles.isLater : undefined}>{monthName(m)}</th>)}
              <th scope="col" className={styles.totalCol}>Total</th>
            </tr>
          </thead>
          <tbody>
            {year.sides.map(s => (
              <tr key={s.side}>
                <th scope="row"><span className={styles.sideLabel}><SideDot sides={year.sides} side={s.side} /> {s.side}</span></th>
                {months.map(m => {
                  const paise = year.months.get(m)?.get(s.side) ?? 0
                  const later = m > thisMonth
                  return (
                    <td key={m} className={later ? styles.isLater : undefined} title={`${s.side}’s side, ${monthName(m, 'long')}: ${formatRupees(paise)}`}>
                      <span className={`${styles.cell} ${SHADE[monthShade(paise, maxMonth)]}`}>
                        {paise > 0 ? formatLakh(paise) : later ? '·' : <span className={styles.dash}>–</span>}
                      </span>
                    </td>
                  )
                })}
                <td className={styles.totalCol}>{formatLakh(s.totalPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
