'use client'

// ── Founders' payouts › Payments ─────────────────────────────────────────────
//
// One control line, as on Expenses: the total that follows the filters, what it
// is made of, a magnifier and one Filters button. Below it a ledger: a payout is
// one <tbody>, the date, company account, note and actions span its lines. A
// phone gets the same payouts as cards.

import { useState } from 'react'
import { Pencil, Search, SlidersHorizontal, Trash2 } from 'lucide-react'
import { FinanceEmpty } from '@/app/finance/components/FinanceListParts'
import {
  FOUNDER_PAID_FROM,
  FOUNDER_PAYOUT_KINDS,
  formatRupees,
  groupByPayout,
  kindShort,
  paidFromLabel,
  taxYearLabel,
  taxYearMonths,
  type FounderBook,
  type FounderPayout,
  type FounderPayoutKind,
  type FounderYear,
} from '@/lib/finance/founderPayouts'
import { monthName } from './FounderOverview'
import { KIND_COLOUR } from './FounderParts'
import styles from './founders.module.css'

export type Filters = { search: string; accountId: string; kind: string; side: string; paidFrom: string; month: string }
export const NO_FILTERS: Filters = { search: '', accountId: '', kind: '', side: '', paidFrom: '', month: '' }

const PANEL_FILTERS = ['accountId', 'kind', 'side', 'paidFrom', 'month'] as const

export function fmtDate(iso: string): string {
  const at = new Date(`${iso}T00:00:00`)
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function PayoutActions({ payout, onEdit, onDelete }: { payout: FounderPayout; onEdit: (p: FounderPayout) => void; onDelete: (p: FounderPayout) => void }) {
  const on = fmtDate(payout.paidOn)
  return (
    <div className={styles.rowActions}>
      <button type="button" className={styles.iconBtn} title="Change" aria-label={`Change the payout of ${on}`} onClick={() => onEdit(payout)}>
        <Pencil size={15} strokeWidth={1.8} aria-hidden="true" />
      </button>
      <button type="button" className={`${styles.iconBtn} ${styles.iconBtnDanger}`} title="Delete" aria-label={`Delete the payout of ${on}`} onClick={() => onDelete(payout)}>
        <Trash2 size={15} strokeWidth={1.8} aria-hidden="true" />
      </button>
    </div>
  )
}

export function FounderPayments({ year, lines, filters, setFilters, sides, book, onEdit, onDelete }: {
  year: FounderYear
  lines: FounderYear['lines']
  filters: Filters
  setFilters: (f: Filters | ((prev: Filters) => Filters)) => void
  sides: string[]
  book: FounderBook
  onEdit: (p: FounderPayout) => void
  onDelete: (p: FounderPayout) => void
}) {
  const [filtersOpen, setFiltersOpen] = useState(false)
  const panelCount = PANEL_FILTERS.filter(k => filters[k] !== '').length
  const narrowed = panelCount > 0 || filters.search !== ''
  const groups = groupByPayout(lines)
  const total = lines.reduce((s, l) => s + l.paise, 0)
  const byKind = new Map<FounderPayoutKind, number>()
  for (const l of lines) byKind.set(l.kind, (byKind.get(l.kind) ?? 0) + l.paise)
  const set = (patch: Partial<Filters>) => setFilters(prev => ({ ...prev, ...patch }))
  const kinds = FOUNDER_PAYOUT_KINDS.filter(k => byKind.has(k.value))

  return (
    <section className={`fin-board ${styles.panel}`} data-testid="founder-payments">
      <div className={styles.ledgerBar}>
        <span className={styles.ledgerTotal} data-testid="founder-payments-total" aria-live="polite">
          <strong>{formatRupees(total)}</strong> in {groups.length} payout{groups.length === 1 ? '' : 's'}
        </span>
        {kinds.length > 0 && <span className={styles.divider} aria-hidden="true" />}
        <div className={styles.kinds}>
          {kinds.map(k => (
            <span key={k.value}><span className="fin-dot" aria-hidden="true" style={{ background: KIND_COLOUR[k.value] }} /> {k.short} <b>{formatRupees(byKind.get(k.value) ?? 0)}</b></span>
          ))}
        </div>

        <div className={styles.tools} role="search" aria-label="Filter payments">
          <label className={`boe-list-search ${styles.search}${filters.search ? ` ${styles.searchFilled}` : ''}`} title="Search">
            <Search size={16} strokeWidth={1.8} aria-hidden="true" style={{ flexShrink: 0 }} />
            <input type="search" aria-label="Search name, note or reference" placeholder="Search name, note or reference"
              value={filters.search} onChange={e => set({ search: e.target.value })} />
            {filters.search && <button type="button" onClick={() => set({ search: '' })} aria-label="Clear search" className="boe-list-search-clear">✕</button>}
          </label>
          <button type="button" className={styles.tool} data-testid="founder-filters-button"
            aria-label={panelCount > 0 ? `Filters, ${panelCount} on` : 'Filters'} aria-haspopup="dialog" aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen(open => !open)}>
            <SlidersHorizontal size={15} strokeWidth={1.8} aria-hidden="true" /> Filters
            {panelCount > 0 && <span className={styles.toolCount}>{panelCount}</span>}
          </button>
          {filtersOpen && (
            <>
              <div aria-hidden="true" className={styles.filterAway} onClick={() => setFiltersOpen(false)} />
              <div className={styles.filterPanel} role="dialog" aria-label="Filters" onKeyDown={e => { if (e.key === 'Escape') setFiltersOpen(false) }}>
                <label className={styles.filterRow}>
                  <span>Account</span>
                  <select className="boe-input" value={filters.accountId} onChange={e => set({ accountId: e.target.value })}>
                    <option value="">All accounts</option>
                    {book.accounts.map(a => <option key={a.id} value={a.id}>{a.displayName}</option>)}
                  </select>
                </label>
                <label className={styles.filterRow}>
                  <span>Kind</span>
                  <select className="boe-input" value={filters.kind} onChange={e => set({ kind: e.target.value })}>
                    <option value="">All kinds</option>
                    {FOUNDER_PAYOUT_KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
                  </select>
                </label>
                {sides.length > 1 && (
                  <label className={styles.filterRow}>
                    <span>Side</span>
                    <select className="boe-input" value={filters.side} onChange={e => set({ side: e.target.value })}>
                      <option value="">Every side</option>
                      {sides.map(s => <option key={s} value={s}>{s}&rsquo;s side</option>)}
                    </select>
                  </label>
                )}
                <label className={styles.filterRow}>
                  <span>Paid from</span>
                  <select className="boe-input" value={filters.paidFrom} onChange={e => set({ paidFrom: e.target.value })}>
                    <option value="">Any company account</option>
                    {FOUNDER_PAID_FROM.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                </label>
                <label className={styles.filterRow}>
                  <span>Month</span>
                  <select className="boe-input" value={filters.month} onChange={e => set({ month: e.target.value })}>
                    <option value="">Whole year</option>
                    {taxYearMonths(year.taxYear).map(m => <option key={m} value={m}>{monthName(m, 'long')}</option>)}
                  </select>
                </label>
                {panelCount > 0 && (
                  <div className={styles.filterFoot}>
                    <button type="button" className={styles.link} onClick={() => setFilters(prev => ({ ...NO_FILTERS, search: prev.search }))}>Clear filters</button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {groups.length === 0 ? (
        <FinanceEmpty icon={narrowed ? 'search' : 'card'} title={narrowed ? 'No payment matches these filters' : `No payout recorded for ${taxYearLabel(year.taxYear)}`} />
      ) : (
        <>
          <div className={`fin-table-wrap ${styles.ledgerWrap}`}>
            <table className={`fin-table ${styles.ledger}`}>
              <colgroup>
                <col style={{ width: 138 }} />
                <col style={{ width: 220 }} />
                <col style={{ width: 132 }} />
                <col style={{ width: 112 }} />
                <col style={{ width: 104 }} />
                <col />
                <col style={{ width: 76 }} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col" className={styles.cDate}>Date</th>
                  <th scope="col">Paid to</th>
                  <th scope="col">Kind</th>
                  <th scope="col" className="fin-num">Amount</th>
                  <th scope="col" className={styles.cFrom}>Paid from</th>
                  <th scope="col">Note and reference</th>
                  <th scope="col" className={styles.cActions}><span className="boe-sr-only">Actions</span></th>
                </tr>
              </thead>
              {groups.map(({ payout, lines: own }) => {
                const hidden = payout.lines.length - own.length
                const span = own.length + (hidden > 0 ? 1 : 0)
                return (
                  <tbody key={payout.id}>
                    {own.map((l, i) => (
                      <tr key={l.id}>
                        {i === 0 && (
                          <td className={styles.cDate} rowSpan={span}>
                            <span className={styles.date}>{fmtDate(payout.paidOn)}</span>
                            {payout.lines.length > 1 && <span className="fin-sub">Total {formatRupees(payout.lines.reduce((s, x) => s + x.paise, 0))}</span>}
                          </td>
                        )}
                        <td>
                          <span className={`${styles.name} ${styles.nameLine}`}>{l.account?.displayName ?? '—'}</span>
                          <span className="fin-sub">{l.account ? `${l.account.side}’s side` : ''}{l.account?.bankLabel ? ` · ${l.account.bankLabel}` : ''}</span>
                        </td>
                        <td><span className={styles.kind}><span className="fin-dot" aria-hidden="true" style={{ background: KIND_COLOUR[l.kind] }} /> {kindShort(l.kind)}</span></td>
                        <td className="fin-num"><span className={styles.amount}>{formatRupees(l.paise)}</span></td>
                        {i === 0 && (
                          <>
                            <td className={styles.cFrom} rowSpan={span}>{paidFromLabel(payout.paidFrom)}</td>
                            <td className={styles.cNote} rowSpan={span}>
                              {payout.note && <span className={styles.noteText}>{payout.note}</span>}
                              {payout.bankReference && <span className="fin-sub">Ref {payout.bankReference}</span>}
                              {!payout.note && !payout.bankReference && <span className={styles.dash}>–</span>}
                            </td>
                            <td className={styles.cActions} rowSpan={span}><PayoutActions payout={payout} onEdit={onEdit} onDelete={onDelete} /></td>
                          </>
                        )}
                      </tr>
                    ))}
                    {hidden > 0 && <tr className={styles.hiddenLines}><td colSpan={3}>{hidden} more line{hidden === 1 ? '' : 's'} hidden by the filters</td></tr>}
                  </tbody>
                )
              })}
            </table>
          </div>

          <div className={styles.ledgerCards}>
            {groups.map(({ payout, lines: own }) => {
              const hidden = payout.lines.length - own.length
              return (
                <div key={payout.id} className={styles.card}>
                  <div className={styles.cardHead}>
                    <span className={styles.date}>{fmtDate(payout.paidOn)}</span>
                    {payout.lines.length > 1 && <span className={`${styles.muted} ${styles.small}`}>Total {formatRupees(payout.lines.reduce((s, x) => s + x.paise, 0))}</span>}
                    <PayoutActions payout={payout} onEdit={onEdit} onDelete={onDelete} />
                  </div>
                  <div className={styles.cardMeta}>From {paidFromLabel(payout.paidFrom)}{payout.bankReference ? ` · Ref ${payout.bankReference}` : ''}</div>
                  {payout.note && <div className={styles.cardMeta}>{payout.note}</div>}
                  {own.map(l => (
                    <div key={l.id} className={styles.cardLine}>
                      <span>
                        <span className={`${styles.name} ${styles.nameLine}`}>{l.account?.displayName ?? '—'}</span>
                        <span className="fin-sub">{kindShort(l.kind)}{l.account ? ` · ${l.account.side}’s side` : ''}</span>
                      </span>
                      <span className={styles.amount}>{formatRupees(l.paise)}</span>
                    </div>
                  ))}
                  {hidden > 0 && <div className={styles.cardMeta}>{hidden} more line{hidden === 1 ? '' : 's'} hidden by the filters</div>}
                </div>
              )
            })}
          </div>
        </>
      )}
    </section>
  )
}
