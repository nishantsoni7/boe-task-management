'use client'

// THE SALESPERSON'S OWN ORDERS DASHBOARD (owner, 2026-10-30, layout A).
//
// Top to bottom, the questions a salesperson asks:
//   1. Was anything sent back to me?  One line per PI returned to Sales, with
//      Open PI. The approver's note is NOT drawn: it is at the top of the PI
//      page, where the change is made. No PI returned = no strip.
//   2. How are my sales?              This month so far beside last month.
//   3. What must I chase?             Advance below 40% (the wide column) and
//                                     Ready for dispatch.
//   4. What am I waiting on?          Waiting for approval.
// Closed (deal lost) PIs, the all-time total and Fabric / Finish are not drawn
// (owner's decisions, 2026-10-30); the database still sends them.
//
// Every list shows EVERY matching order — no preview cap, no "view all" link, no
// fixed-height scroll box — and its heading carries the full count. Each figure
// appears once on the page.
//
// A ROW IS ONE LINK to the record's existing page, which re-checks access on its
// own. A PI the reader cannot open under the existing PI rules is plain text,
// never a link that would refuse.
//
// LAYOUT: two independent columns, left [Advance below 40%] and right [Ready for
// dispatch, Waiting for approval], so a short list never leaves a gap. Below 900px
// the columns dissolve and the lists stack in that same order; chips under the
// figures jump to each list.

import type { ReactNode } from 'react'
import Link from 'next/link'
import { withReturnTo } from '@/lib/navigation/recordReturn'
import {
  SP_ADVANCE_BELOW_NONE_KNOWN,
  SP_ADVANCE_COLUMNS,
  SP_ADVANCE_UNCHECKED_HEADING,
  SP_ADVANCE_UNCHECKED_PILL,
  SP_ADVANCE_UNCHECKED_RULE,
  SP_CHIP,
  SP_EMPTY,
  SP_EXCEPTION_APPROVED,
  SP_HINT,
  SP_LIST_ADVANCE,
  SP_LIST_PENDING,
  SP_LIST_READY,
  SP_NOT_OPENABLE,
  SP_NOT_OPENABLE_SHORT,
  SP_OPEN_PI,
  SP_RETURNED_HINT_MANY,
  SP_RETURNED_HINT_ONE,
  SP_SALES_BASIS,
  SP_SALES_LAST_MONTH,
  SP_SALES_NOT_AVAILABLE,
  SP_SALES_THIS_MONTH,
  advanceCountText,
  advancePercentText,
  confirmedAgoText,
  plannedDispatchText,
  readyForText,
  returnedByText,
  returnedTitle,
  revenueMonthLabel,
  revenueNotes,
  revenueText,
  shortfallText,
  waitingText,
  type SalespersonDashboard,
  type SpReviewedRow,
} from '@/lib/orders/salespersonDashboard'
import { plural } from '@/lib/orders/orderDashboardSummary'
// One rule for "red from the third day", shared with the Modules card.
import { isReturnedPiUrgent } from '@/lib/orders/returnedPis'

const RETURN_TO = '/orders'

type Area = 'advance' | 'ready' | 'pending'

function List({ area, title, hint, count, countText, empty, children }: {
  area: Area
  title: string
  hint: string
  /** How many rows the list holds; zero draws the empty state. */
  count: number
  /** What the heading says when it is not just `count` (below 40% and not checked are two numbers). */
  countText?: string
  empty: string
  children: ReactNode
}) {
  return (
    <section className="spd-list" id={`spd-${area}`} data-area={area} aria-labelledby={`spd-${area}-title`}>
      <header className="spd-list-head">
        <h2 id={`spd-${area}-title`} className="spd-list-title">{title}</h2>
        <span className="spd-count" aria-label={`${countText ?? count} matching`}>{countText ?? count}</span>
        <span className="spd-list-hint">{hint}</span>
      </header>
      {count === 0 ? <p className="spd-empty">{empty}</p> : children}
    </section>
  )
}

/** Number and client, the same two first cells in every row. */
function Who({ number, client, children }: { number: string; client: string; children?: ReactNode }) {
  return (
    <span className="spd-who">
      <span className="spd-num">{number}</span>
      <span className="spd-client">{client || 'Client not recorded'}</span>
      {children}
    </span>
  )
}

function OrderLink({ orderId, className, children }: { orderId: string; className: string; children: ReactNode }) {
  return (
    <li>
      <Link href={withReturnTo(`/orders/${orderId}`, RETURN_TO)} className={className} prefetch={false}>{children}</Link>
    </li>
  )
}

/** One PI returned to Sales: which PI, who returned it, how long it has waited, Open PI. */
function ReturnedRow({ r }: { r: SpReviewedRow }) {
  const body = (
    <>
      <Who number={r.reference} client={r.clientName} />
      <span className="spd-meta spd-grow">{returnedByText(r.byName)}</span>
      <span className="spd-pill" data-tone={isReturnedPiUrgent(r.sinceSeconds) ? 'alert' : 'warn'}>{waitingText(r.sinceSeconds)}</span>
      {r.canOpen
        ? <span className="spd-open" aria-hidden="true">{SP_OPEN_PI}</span>
        : <span className="spd-meta spd-restricted">{SP_NOT_OPENABLE_SHORT}</span>}
    </>
  )
  return (
    <li>
      {r.canOpen ? (
        <Link href={withReturnTo(`/orders/drafts/${r.submissionId}`, RETURN_TO)} className="spd-returned-row" prefetch={false}>{body}</Link>
      ) : (
        <div className="spd-returned-row" data-static="true" title={SP_NOT_OPENABLE}>{body}</div>
      )}
    </li>
  )
}

function SalesFigure({ label, amount, month, orders, notes }: {
  label: string
  amount: number | null
  month: string | null
  orders: number | null
  notes: string[]
}) {
  return (
    <div className="spd-fig">
      <h2 className="spd-fig-label">{label}</h2>
      <p className="spd-fig-value">{amount === null ? '–' : revenueText(amount)}</p>
      <p className="spd-fig-sub">
        {month === null || orders === null ? SP_SALES_NOT_AVAILABLE : `${revenueMonthLabel(month)} · ${plural(orders, 'order')}`}
      </p>
      {notes.length > 0 ? <ul className="spd-notes">{notes.map(n => <li key={n}>{n}</li>)}</ul> : null}
    </div>
  )
}

export function SalespersonDashboardView({ data }: { data: SalespersonDashboard }) {
  const last = data.revenueLastMonth
  const returned = data.returned
  const advanceCount = advanceCountText(data.advance.length, data.advanceUnchecked.length)

  return (
    <div className="spd">
      {returned.length > 0 ? (
        <section className="spd-returned" aria-labelledby="spd-returned-title">
          <header className="spd-returned-head">
            <h2 id="spd-returned-title" className="spd-returned-title">{returnedTitle(returned.length)}</h2>
            <span className="spd-returned-hint">{returned.length === 1 ? SP_RETURNED_HINT_ONE : SP_RETURNED_HINT_MANY}</span>
          </header>
          <ul className="spd-returned-rows">
            {returned.map(r => <ReturnedRow key={r.submissionId} r={r} />)}
          </ul>
        </section>
      ) : null}

      <section className="spd-sales" aria-label="Your sales">
        <SalesFigure
          label={SP_SALES_THIS_MONTH}
          amount={data.revenue.amount}
          month={data.monthFrom}
          orders={data.revenue.orders}
          notes={revenueNotes(data.revenue)}
        />
        <SalesFigure
          label={SP_SALES_LAST_MONTH}
          amount={last ? last.amount : null}
          month={last ? last.monthFrom : null}
          orders={last ? last.orders : null}
          notes={last ? revenueNotes(last, 'last month') : []}
        />
        <p className="spd-sales-basis">{SP_SALES_BASIS}</p>
      </section>

      <nav className="spd-chips" aria-label="Jump to a list">
        <a className="spd-chip" href="#spd-advance">{SP_CHIP.advance} <span>{data.advance.length}</span></a>
        <a className="spd-chip" href="#spd-ready">{SP_CHIP.ready} <span>{data.readyForDispatch.length}</span></a>
        <a className="spd-chip" href="#spd-pending">{SP_CHIP.pending} <span>{data.pending.length}</span></a>
      </nav>

      <div className="spd-lists">
        <div className="spd-col spd-col--wide">
          <List
            area="advance" title={SP_LIST_ADVANCE} hint={SP_HINT.advance}
            count={data.advance.length + data.advanceUnchecked.length} countText={advanceCount}
            empty={SP_EMPTY.advance}
          >
            {data.advance.length > 0 ? (
              <>
                <div className="spd-adv-head" aria-hidden="true">
                  {SP_ADVANCE_COLUMNS.map(c => <span key={c}>{c}</span>)}
                </div>
                <ul className="spd-rows">
                  {data.advance.map(r => (
                    <OrderLink key={r.orderId} orderId={r.orderId} className="spd-row spd-adv-row">
                      <span className="spd-num">{r.displayNumber}</span>
                      <span className="spd-client">
                        {r.clientName || 'Client not recorded'}
                        {r.exceptionApproved ? <>{' '}<span className="spd-pill" data-tone="muted">{SP_EXCEPTION_APPROVED}</span></> : null}
                      </span>
                      <span className="spd-pct">{advancePercentText(r.percent)}</span>
                      <span className="spd-short">{shortfallText(r.shortfall)}</span>
                      <span className="spd-meta">{confirmedAgoText(r.daysSinceConfirmation)}</span>
                    </OrderLink>
                  ))}
                </ul>
              </>
            ) : <p className="spd-empty">{SP_ADVANCE_BELOW_NONE_KNOWN}</p>}
            {data.advanceUnchecked.length > 0 ? (
              <div className="spd-unchecked">
                <h3 className="spd-subhead">{SP_ADVANCE_UNCHECKED_HEADING} <span>{data.advanceUnchecked.length}</span></h3>
                <p className="spd-gap">{SP_ADVANCE_UNCHECKED_RULE}</p>
                <ul className="spd-rows">
                  {data.advanceUnchecked.map(r => (
                    <OrderLink key={r.orderId} orderId={r.orderId} className="spd-row">
                      <Who number={r.displayNumber} client={r.clientName} />
                      <span className="spd-pill" data-tone="muted">{SP_ADVANCE_UNCHECKED_PILL}</span>
                    </OrderLink>
                  ))}
                </ul>
              </div>
            ) : null}
          </List>
        </div>

        <div className="spd-col">
          <List area="ready" title={SP_LIST_READY} hint={SP_HINT.ready} count={data.readyForDispatch.length} empty={SP_EMPTY.ready}>
            <ul className="spd-rows">
              {data.readyForDispatch.map(r => {
                const planned = plannedDispatchText(r.plannedDispatchDate, data.today)
                const since = readyForText(r.readyDays)
                return (
                  <OrderLink key={r.orderId} orderId={r.orderId} className="spd-row">
                    <span className="spd-stack">
                      <Who number={r.displayNumber} client={r.clientName} />
                      {since ? <span className="spd-meta">{since}</span> : null}
                    </span>
                    <span className="spd-pill" data-tone={planned.tone}>{planned.text}</span>
                  </OrderLink>
                )
              })}
            </ul>
          </List>

          <List area="pending" title={SP_LIST_PENDING} hint={SP_HINT.pending} count={data.pending.length} empty={SP_EMPTY.pending}>
            <ul className="spd-rows">
              {data.pending.map(r => {
                const body = (
                  <>
                    <Who number={r.reference} client={r.clientName} />
                    <span className="spd-pill" data-tone="warn">{waitingText(r.waitingSeconds)}</span>
                    {r.canOpen ? null : <span className="spd-meta spd-restricted">{SP_NOT_OPENABLE_SHORT}</span>}
                  </>
                )
                return (
                  <li key={r.submissionId}>
                    {r.canOpen ? (
                      <Link href={withReturnTo(`/orders/drafts/${r.submissionId}`, RETURN_TO)} className="spd-row" prefetch={false}>{body}</Link>
                    ) : (
                      <div className="spd-row" data-static="true" title={SP_NOT_OPENABLE}>{body}</div>
                    )}
                  </li>
                )
              })}
            </ul>
          </List>
        </div>
      </div>
    </div>
  )
}
