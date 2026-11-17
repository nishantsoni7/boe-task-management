'use client'

// THE DRAFT ORDERS LIST (ClickUp): redesigned 2026-11-17 (owner, UI/UX Pro Max pass) on the Finance list
// design the PI Drafts and Confirmed Orders lists already use: status cards that ARE the filter, one view bar with
// the search, one fixed-layout table (`fin-table`) with every column given its own width, soft status pills,
// and cards instead of a table on a phone (`PhoneTableCards`). Drawing only: the page reads the data and keeps
// the card and the search in the address. Its own file so a test can draw it without the router or a fetch.

import { AppLink } from '@/components/ui/AppLink'
import { PhoneTableCards } from '@/components/ui/PhoneTableCards'
import { FinanceEmpty, FinanceStatusCards } from '@/app/finance/components/FinanceListParts'
import {
  DRAFT_ALL, DRAFT_STATUS_TABS, approvalChip, dayIst, filterDrafts, inr, statusLabel, statusTone, type DraftListRow,
} from '@/lib/orders/clickupDrafts'
import styles from './clickupDrafts.module.css'

type Column = { key: string; label: string; width: number; num?: boolean }

// Percent of the table, 100 in all. The Status column is drawn only under "All orders" (under a status card it
// would repeat the card), and its share goes to the client.
const COLUMNS: Column[] = [
  { key: 'order', label: 'Order', width: 7 },
  { key: 'client', label: 'Client', width: 15 },
  { key: 'status', label: 'Status', width: 13 },
  { key: 'assigned', label: 'Assigned', width: 12 },
  { key: 'confirm', label: 'Confirm date', width: 10 },
  { key: 'due', label: 'Due', width: 10 },
  { key: 'value', label: 'Value', width: 10, num: true },
  { key: 'fabric', label: 'Fabric', width: 9 },
  { key: 'finish', label: 'Finish', width: 9 },
  { key: 'files', label: 'Files', width: 5, num: true },
]

const Dash = () => <span className="fin-muted">—</span>

export function DraftsList({ rows, tab, query, onTab, onQuery, onQueryBlur, onClear, onOpen, onDownload, downloading }: {
  rows: readonly DraftListRow[]
  tab: string
  query: string
  onTab: (tab: string) => void
  onQuery: (query: string) => void
  /** Opening an order blurs the box first: the page writes a pending search into the address then, so Back keeps it. */
  onQueryBlur?: () => void
  onClear: () => void
  onOpen: (id: string) => void
  onDownload: () => void
  downloading: boolean
}) {
  const { shown, counts, searched } = filterDrafts(rows, tab, query)
  const narrowed = tab !== 'running orders' || query.trim() !== ''
  const showStatus = tab === DRAFT_ALL
  const columns = COLUMNS.filter(c => showStatus || c.key !== 'status')
  const extra = showStatus ? 0 : COLUMNS.find(c => c.key === 'status')!.width

  const cards = [
    ...DRAFT_STATUS_TABS.map(t => ({ key: t.key as string, label: t.label, tone: statusTone(t.key), count: counts.get(t.key) ?? 0 })),
    { key: DRAFT_ALL, label: 'All orders', tone: 'neutral' as const, count: searched },
  ]

  return (
    <>
      <FinanceStatusCards ariaLabel="Order status" noun="order" active={tab} onSelect={onTab} cards={cards} />

      <div className="fin-board">
        <div className="fin-viewbar">
          <div className="fin-tools" role="search" aria-label="Filter draft orders">
            {/* The box is a LABEL around the input: `boe-list-search` is a wrapper (flex 1 1 220px, 36px tall). On
                the bare input in a column it made the box 220px TALL. */}
            <label className="boe-list-search">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input type="search" aria-label="Search draft orders" placeholder="Order number, client or person…" value={query} onChange={e => onQuery(e.target.value)} onBlur={onQueryBlur} />
              {query && <button type="button" onClick={() => onQuery('')} aria-label="Clear search" className="boe-list-search-clear">✕</button>}
            </label>
            {narrowed && (
              <button type="button" onClick={onClear} className="boe-btn boe-btn-ghost" style={{ padding: '4px 10px', fontSize: '12px' }}>Clear filters</button>
            )}
          </div>
          <div className={styles.actions}>
            <button type="button" className="boe-btn boe-btn-secondary" disabled={downloading || rows.length === 0} onClick={onDownload}>
              {downloading ? 'Preparing…' : 'Download Excel'}
            </button>
            <AppLink href="/orders/clickup/import" className="boe-btn boe-btn-primary">Import from backup folder</AppLink>
          </div>
        </div>

        {rows.length === 0 && (
          <FinanceEmpty icon="box" title="No draft orders yet" body="Use Import from backup folder to copy the ClickUp export in." />
        )}
        {rows.length > 0 && shown.length === 0 && (
          <FinanceEmpty icon="search" title={query.trim() ? `No results for “${query.trim()}”.` : 'No orders with this status.'}
            body="Try an order number, a client or a person, or clear the filters."
            action={<button type="button" onClick={onClear} className="boe-btn boe-btn-secondary" style={{ padding: '6px 14px', fontSize: '13px' }}>Clear filters</button>} />
        )}
        {shown.length > 0 && (
          <div className="fin-table-wrap">
            <PhoneTableCards>
              <table className="fin-table">
                <colgroup>
                  {columns.map(c => <col key={c.key} style={{ width: `${c.width + (c.key === 'client' ? extra : 0)}%` }} />)}
                </colgroup>
                <thead>
                  <tr>{columns.map(c => <th key={c.key} className={c.num ? 'fin-num' : undefined}>{c.label}</th>)}</tr>
                </thead>
                <tbody>
                  {shown.map(r => {
                    const fabric = approvalChip(r.fields['FABRIC STATUS'], 'fabric')
                    const finish = approvalChip(r.fields['FINISH STATUS'], 'finish')
                    const chip = (c: typeof fabric) => c ? <span className={`fin-pill fin-pill--${c.tone}`}>{c.label}</span> : <Dash />
                    return (
                      <tr key={r.id} onClick={() => onOpen(r.id)}>
                        <td><AppLink href={`/orders/clickup/${r.id}`} onClick={e => e.stopPropagation()}><strong>{r.order_no ?? '—'}</strong></AppLink></td>
                        <td className={styles.wrap}><span className="fin-primary-text">{r.client_name}</span></td>
                        {showStatus && <td><span className={`fin-pill fin-pill--${statusTone(r.status)}`}>{statusLabel(r.status)}</span></td>}
                        <td className={styles.wrap}>{r.assignees.join(', ') || <Dash />}</td>
                        <td>{dayIst(r.fields['Confirm Date'] ?? null)}</td>
                        <td>{dayIst(r.due_date)}</td>
                        <td className="fin-num">{inr(r.fields['Total Product Value'])}</td>
                        <td>{chip(fabric)}</td>
                        <td>{chip(finish)}</td>
                        <td className="fin-num fin-muted">{r.file_count}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </PhoneTableCards>
          </div>
        )}
      </div>
    </>
  )
}
