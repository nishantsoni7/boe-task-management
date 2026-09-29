'use client'

// THE FOUR THINGS THAT NEED SOMEBODY TO STEP IN — counts, then the orders.
//
// Every count is a LINK to its own list on this page, and every row is a link to
// its order, so no figure is a dead end. An order may appear under more than one
// heading and is NOT de-duplicated: each heading answers its own question, and
// the page says so. What could not be assessed (no due date, no confirmation date,
// no order value) is said under the heading it affects, never folded into "0".

import { useId, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { withReturnTo } from '@/lib/navigation/recordReturn'
import {
  ADVANCE_BLOCKS_NOTE,
  EXCEPTION_APPROVED_NOTE,
  GROUP_COPY,
  advanceLine,
  alignmentLine,
  fabricFinishLine,
  groupGapNote,
  listsNote,
  overdueLine,
  plural,
  type DashboardSummary,
  type GroupCopy,
  type GroupKey,
} from '@/lib/orders/orderDashboardSummary'

/** How many rows a heading shows before "Show all". */
export const VISIBLE_ROWS = 5

export const groupAnchor = (key: GroupKey) => `od-group-${key}`

type Row = { orderId: string; displayNumber: string; clientName: string; line: string; note: string | null }

function rowsFor(summary: DashboardSummary, key: GroupKey): Row[] {
  switch (key) {
    case 'not_aligned':
      return summary.notAligned.map(r => ({ ...r, line: alignmentLine(r), note: r.advanceBlocks && r.reason !== 'held_advance' ? ADVANCE_BLOCKS_NOTE : null }))
    case 'advance_below_40':
      return summary.advance.map(r => ({ ...r, line: advanceLine(r), note: r.exceptionApproved ? EXCEPTION_APPROVED_NOTE : r.held ? 'Held for advance' : null }))
    case 'overdue':
      return summary.overdue.map(r => ({ ...r, line: overdueLine(r), note: null }))
    case 'fabric_finish_pending':
      return summary.fabricFinish.map(r => ({ ...r, line: fabricFinishLine(r), note: null }))
  }
}

export function AttentionCounts({ summary }: { summary: DashboardSummary }) {
  return (
    <nav className="od-counts" aria-label="Orders that need attention">
      {GROUP_COPY.map(g => {
        const n = rowsFor(summary, g.key).length
        return (
          <a
            key={g.key}
            href={`#${groupAnchor(g.key)}`}
            className={g.prominent ? 'od-tile od-tile--prominent' : 'od-tile'}
            data-tone={n > 0 ? 'attention' : 'clear'}
          >
            <span className="od-tile-label">{g.label}</span>
            <span className="od-tile-count">{n}</span>
            <span className="od-tile-sub">{n === 0 ? 'None' : n === 1 ? 'order' : 'orders'} · view list</span>
          </a>
        )
      })}
    </nav>
  )
}

function Group({ copy, summary }: { copy: GroupCopy; summary: DashboardSummary }) {
  const rows = rowsFor(summary, copy.key)
  const listId = useId()
  const router = useRouter()
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? rows : rows.slice(0, VISIBLE_ROWS)
  const gap = groupGapNote(copy.key, summary.gaps)

  return (
    <section
      id={groupAnchor(copy.key)}
      className={copy.prominent ? 'od-group od-group--prominent' : 'od-group'}
      aria-labelledby={`${listId}-h`}
    >
      <header className="od-group-head">
        <h2 id={`${listId}-h`} className="od-group-title">
          {copy.label}
          <span className="od-group-count"> · {rows.length}</span>
        </h2>
        <p className="od-group-rule">{copy.rule}</p>
      </header>

      {rows.length === 0 ? (
        <p className="od-group-empty">{copy.emptyText}</p>
      ) : (
        <ul id={listId} className="od-rows">
          {shown.map(r => (
            <li key={r.orderId} className="od-row">
              <div className="od-row-id">
                {/* Hover or focus is the earliest honest sign this order is about to be
                    opened, so its ROUTE (never the record) is fetched now: no record, no
                    permission and no file is read until the page mounts under the
                    reader's own session. */}
                <Link
                  href={withReturnTo(`/orders/${r.orderId}`, '/orders')}
                  className="od-order-link"
                  prefetch={false}
                  onMouseEnter={() => router.prefetch(`/orders/${r.orderId}`)}
                  onFocus={() => router.prefetch(`/orders/${r.orderId}`)}
                >
                  {r.displayNumber}
                </Link>
                <span className="od-row-client">{r.clientName || 'Client not recorded'}</span>
              </div>
              <div className="od-row-detail">
                <span>{r.line}</span>
                {r.note ? <span className="od-row-note">{r.note}</span> : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {rows.length > VISIBLE_ROWS ? (
        <button
          type="button" className="boe-btn boe-btn-ghost od-show-all"
          aria-expanded={expanded} aria-controls={listId}
          onClick={() => setExpanded(v => !v)}
        >
          {expanded ? `Show fewer` : `Show all ${plural(rows.length, 'order')}`}
        </button>
      ) : null}

      {gap ? <p className="od-group-gap">{gap}</p> : null}
    </section>
  )
}

export function AttentionGroups({ summary }: { summary: DashboardSummary }) {
  return (
    <div className="od-groups">
      <p className="od-note">{listsNote(summary.viewer.seesAllOrders)}</p>
      {GROUP_COPY.map(g => <Group key={g.key} copy={g} summary={summary} />)}
    </div>
  )
}
