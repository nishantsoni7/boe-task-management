'use client'

// THE AT-A-GLANCE DASHBOARD: six cards, and under them one board of the orders that
// need somebody.
//
//   Running · Ready for production · Delayed · Payments pending · Fabric or finish
//   pending · Due in 7 days
//
// Every card is a count the database computed (orders_dashboard_summary, 20270328000000
// and before), and a card that has something behind it opens that list on the board
// below. The board is tabs over the same data, one list at a time: delayed, payments,
// not aligned, fabric/finish, due soon, ready for production. Every row is a link to
// its order. A tab with nothing in it says so in a sentence, never an empty box.
//
// NOTHING IS COMPUTED HERE: no date arithmetic, no totals over orders. The page only
// chooses which list to show.

import { useId, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { withReturnTo } from '@/lib/navigation/recordReturn'
import {
  BOARD_COPY,
  OVERVIEW_EMPTY_NOTE,
  advanceLine,
  alignmentLine,
  dueLine,
  fabricFinishLine,
  formatDate,
  formatRupees,
  formatWaiting,
  overviewCards,
  plural,
  waitingOnLabel,
  type BoardKey,
  type DashboardOrderRef,
  type DashboardSummary,
  type ScheduleRow,
} from '@/lib/orders/orderDashboardSummary'

/** How many rows a tab shows before "Show all". */
export const BOARD_VISIBLE_ROWS = 8

/** The tabs, most urgent first. The first one with rows is the one open on arrival. */
export const BOARD_ORDER: readonly BoardKey[] = ['delayed', 'payments', 'not_aligned', 'fabric', 'due_soon', 'aligned']

type BoardRow = DashboardOrderRef & {
  key: string
  /** What is wrong, or what is coming. */
  headline: string
  /** Who or what it waits on; muted. */
  sub: string
  /** Right-hand figure: a rupee value or an elapsed time. */
  figure: string
  figureLabel: string
}

const scheduleRow = (r: ScheduleRow): BoardRow => ({
  orderId: r.orderId, displayNumber: r.displayNumber, clientName: r.clientName, status: r.status,
  key: r.orderId,
  headline: dueLine(r),
  sub: [r.salesperson ? `Salesperson: ${r.salesperson}` : 'No salesperson recorded', r.dueDate ? `Due ${formatDate(r.dueDate)}` : null]
    .filter(Boolean).join(' · '),
  figure: r.value !== null ? formatRupees(r.value) : '—',
  figureLabel: 'Product value',
})

/** The rows of one tab. Pure: it reads the summary and returns lines. */
export function boardRows(summary: DashboardSummary, key: BoardKey): BoardRow[] {
  const ov = summary.overview
  const reviewer = summary.reviewer?.name ?? null
  switch (key) {
    case 'delayed': return (ov?.delayedList ?? []).map(scheduleRow)
    case 'due_soon': return (ov?.dueSoonList ?? []).map(scheduleRow)
    case 'aligned': return (ov?.alignedList ?? []).map(scheduleRow)
    case 'payments':
      return summary.advance.map(r => ({
        orderId: r.orderId, displayNumber: r.displayNumber, clientName: r.clientName, status: r.status,
        key: r.orderId,
        headline: advanceLine(r),
        sub: [r.exceptionApproved ? 'Exception approved' : null, r.held ? 'Held for advance' : null].filter(Boolean).join(' · ') || 'Advance not yet verified',
        figure: formatRupees(r.shortfall),
        figureLabel: 'Short',
      }))
    case 'fabric':
      return summary.fabricFinish.map(r => ({
        orderId: r.orderId, displayNumber: r.displayNumber, clientName: r.clientName, status: r.status,
        key: r.orderId,
        headline: fabricFinishLine(r),
        sub: `Confirmed ${formatDate(r.confirmDate)}`,
        figure: plural(r.daysSinceConfirmation, 'day'),
        figureLabel: 'Since confirmation',
      }))
    case 'not_aligned':
      return summary.notAligned.map(r => ({
        orderId: r.orderId, displayNumber: r.displayNumber, clientName: r.clientName, status: r.status,
        key: r.orderId,
        headline: alignmentLine(r),
        sub: waitingOnLabel(r.waitingOn, reviewer),
        figure: formatWaiting(r.waitingSeconds),
        figureLabel: 'Waiting',
      }))
  }
}

export function OverviewCards({ summary, onOpen, only }: {
  summary: DashboardSummary
  /** Without it the cards are plain figures: nothing opens. */
  onOpen?: (key: BoardKey) => void
  /** Draw only these cards, in this order. */
  only?: readonly string[]
}) {
  const all = overviewCards(summary)
  const cards = only
    ? only.flatMap(k => all.filter(c => c.key === k))
    : all
  if (cards.length === 0) return null
  return (
    <section className="od-ov" aria-label="Orders at a glance">
      <ul className="od-ov-grid">
        {cards.map(c => {
          const body = (
            <>
              <span className="od-ov-label">{c.label}</span>
              <span className="od-ov-count">{c.count}</span>
              <span className="od-ov-sub">{c.sub}</span>
              {c.detail ? <span className="od-ov-detail">{c.detail}</span> : null}
            </>
          )
          return (
            <li key={c.key}>
              {onOpen && c.board && c.count > 0 ? (
                <button type="button" className="od-ov-card" data-tone={c.tone} onClick={() => onOpen(c.board as BoardKey)}>
                  {body}
                </button>
              ) : (
                <div className="od-ov-card" data-tone={c.count > 0 ? c.tone : 'neutral'} data-static="true">{body}</div>
              )}
            </li>
          )
        })}
      </ul>
      {summary.overview && summary.overview.running.orders === 0 ? (
        <p className="od-note">{OVERVIEW_EMPTY_NOTE}</p>
      ) : null}
    </section>
  )
}

export function ActionBoard({ summary, active, onSelect }: {
  summary: DashboardSummary
  active: BoardKey
  onSelect: (key: BoardKey) => void
}) {
  const router = useRouter()
  const panelId = useId()
  const [expanded, setExpanded] = useState<BoardKey | null>(null)
  if (!summary.overview) return null

  const counts = Object.fromEntries(BOARD_ORDER.map(k => [k, boardRows(summary, k).length])) as Record<BoardKey, number>
  const rows = boardRows(summary, active)
  const shown = expanded === active ? rows : rows.slice(0, BOARD_VISIBLE_ROWS)

  return (
    <section className="od-board" aria-label="Orders that need action">
      <div className="od-board-tabs" role="tablist" aria-label="Order lists">
        {BOARD_ORDER.map(k => (
          <button
            key={k} type="button" role="tab" id={`${panelId}-${k}`}
            aria-selected={active === k} aria-controls={panelId}
            className="od-board-tab" data-active={active === k ? 'true' : undefined}
            onClick={() => onSelect(k)}
          >
            {BOARD_COPY[k].label}
            <span className="od-board-tab-count" data-zero={counts[k] === 0 ? 'true' : undefined}>{counts[k]}</span>
          </button>
        ))}
      </div>
      <div id={panelId} role="tabpanel" aria-labelledby={`${panelId}-${active}`} className="od-board-panel">
        {rows.length === 0 ? (
          <p className="od-board-empty">{BOARD_COPY[active].empty}</p>
        ) : (
          <>
            <ul className="od-board-rows">
              {shown.map(r => (
                <li key={r.key} className="od-board-row">
                  <div className="od-board-id">
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
                  <div className="od-board-what">
                    <span className="od-row-strong">{r.headline}</span>
                    <span className="od-row-sub">{r.sub}</span>
                  </div>
                  <div className="od-board-figure" title={r.figureLabel}>
                    <span>{r.figure}</span>
                    <span className="od-board-figure-label">{r.figureLabel}</span>
                  </div>
                </li>
              ))}
            </ul>
            {rows.length > BOARD_VISIBLE_ROWS ? (
              <button
                type="button" className="boe-btn boe-btn-ghost od-show-all" aria-expanded={expanded === active}
                onClick={() => setExpanded(expanded === active ? null : active)}
              >
                {expanded === active ? 'Show fewer' : `Show all ${plural(rows.length, 'order')}`}
              </button>
            ) : null}
          </>
        )}
      </div>
    </section>
  )
}

/** The first tab with something in it, so the board never opens on an empty list when another is not. */
export function firstBoardWithRows(summary: DashboardSummary): BoardKey {
  return BOARD_ORDER.find(k => boardRows(summary, k).length > 0) ?? 'delayed'
}
