'use client'

// THE SALESPERSON'S OWN ORDERS DASHBOARD: three figures, then four complete lists.
//
// Every list shows EVERY matching order — no preview cap, no "view all" link, no
// fixed-height scroll box — and its heading carries the full count. An order may
// sit in more than one list; within one list it appears once (the database
// returns one row per order). The page body holds nothing else.
//
// A ROW IS ONE LINK to the order's existing detail page, which re-checks access on
// its own. The only exception is a pending PI the reader cannot open under the
// existing PI rules: it is drawn as plain text, never as a link that would refuse.
//
// LAYOUT: two independent columns, left [Pending approval, Fabric/Finish] and
// right [Advance below 40%, Ready for dispatch], so a short panel never leaves a
// gap under it. Below 900px the columns dissolve and the panels stack in the
// order Pending → Advance → Fabric/Finish → Ready (CSS `order`).

import type { ReactNode } from 'react'
import Link from 'next/link'
import { withReturnTo } from '@/lib/navigation/recordReturn'
import {
  SP_BELOW_40,
  SP_CARD_PENDING,
  SP_CARD_PENDING_SUB,
  SP_CARD_REVENUE,
  SP_CARD_TOTAL,
  SP_CARD_TOTAL_SUB,
  SP_EMPTY,
  SP_FABRIC_NO_KNOWN_PENDING,
  SP_FABRIC_PENDING_HEADING,
  SP_NOT_OPENABLE,
  SP_NOT_OPENABLE_SHORT,
  SP_UNKNOWN_HEADING,
  SP_UNKNOWN_RULE,
  SP_OVER_15,
  SP_PANEL_ADVANCE,
  SP_PANEL_FABRIC,
  SP_PANEL_PENDING,
  SP_PANEL_READY,
  SP_PENDING_STATUS,
  SP_READY_STATUS,
  SP_REVENUE_BASIS,
  advancePercentText,
  advanceUncheckedNote,
  dispatchDateText,
  fabricCountText,
  pendingKindsText,
  pendingWaitText,
  revenueMonthLabel,
  revenueNotes,
  revenueText,
  sinceConfirmationText,
  unknownKindsText,
  type SalespersonDashboard,
} from '@/lib/orders/salespersonDashboard'

const RETURN_TO = '/orders'

function Card({ id, label, value, sub, notes }: { id: string; label: string; value: ReactNode; sub: string; notes?: string[] }) {
  return (
    <section className="spd-card" aria-labelledby={id}>
      <h2 id={id} className="spd-card-label">{label}</h2>
      <p className="spd-card-value">{value}</p>
      <p className="spd-card-sub">{sub}</p>
      {notes && notes.length > 0 ? (
        <ul className="spd-notes">{notes.map(n => <li key={n}>{n}</li>)}</ul>
      ) : null}
    </section>
  )
}

function Panel({ id, area, title, count, countText, empty, notes, raw, children }: {
  id: string
  area: 'pending' | 'advance' | 'fabric' | 'ready'
  title: string
  /** How many rows the panel holds; zero draws the empty state. */
  count: number
  /** What the heading says when it is not just `count` (known pending and unknown are two numbers). */
  countText?: string
  empty: string
  notes?: (string | null)[]
  /** The children are already their own lists. */
  raw?: boolean
  children: ReactNode
}) {
  const shown = (notes ?? []).filter((n): n is string => !!n)
  return (
    <section className="spd-panel" data-area={area} aria-labelledby={id}>
      <header className="spd-panel-head">
        <h2 id={id} className="spd-panel-title">{title}</h2>
        <span className="spd-panel-count" aria-label={`${countText ?? count} matching`}>{countText ?? count}</span>
      </header>
      {count === 0 ? <p className="spd-empty">{empty}</p> : raw ? children : <ul className="spd-rows">{children}</ul>}
      {shown.map(n => <p key={n} className="spd-gap">{n}</p>)}
    </section>
  )
}

function RowBody({ number, client, children }: { number: string; client: string; children: ReactNode }) {
  return (
    <>
      <span className="spd-row-main">
        <span className="spd-row-num">{number}</span>
        <span className="spd-row-client">{client || 'Client not recorded'}</span>
      </span>
      <span className="spd-row-meta">{children}</span>
    </>
  )
}

function OrderRow({ orderId, number, client, children }: { orderId: string; number: string; client: string; children: ReactNode }) {
  return (
    <li>
      <Link href={withReturnTo(`/orders/${orderId}`, RETURN_TO)} className="spd-row" prefetch={false}>
        <RowBody number={number} client={client}>{children}</RowBody>
      </Link>
    </li>
  )
}

export function SalespersonDashboardView({ data }: { data: SalespersonDashboard }) {
  const notes = revenueNotes(data.revenue)
  return (
    <div className="spd">
      <div className="spd-cards">
        <Card id="spd-total" label={SP_CARD_TOTAL} value={data.totalOrders} sub={SP_CARD_TOTAL_SUB} />
        <Card
          id="spd-revenue" label={SP_CARD_REVENUE} value={revenueText(data.revenue.amount)}
          sub={`${revenueMonthLabel(data.monthFrom)} · ${SP_REVENUE_BASIS}`} notes={notes}
        />
        <Card id="spd-pending" label={SP_CARD_PENDING} value={data.pendingTotal} sub={SP_CARD_PENDING_SUB} />
      </div>

      <div className="spd-panels">
        <div className="spd-col">
          <Panel id="spd-p-pending" area="pending" title={SP_PANEL_PENDING} count={data.pending.length} empty={SP_EMPTY.pending}>
            {data.pending.map(r => (
              <li key={r.submissionId}>
                {r.canOpen ? (
                  <Link href={withReturnTo(`/orders/drafts/${r.submissionId}`, RETURN_TO)} className="spd-row" prefetch={false}>
                    <RowBody number={r.reference} client={r.clientName}>
                      <span className="spd-pill" data-tone="warn">{SP_PENDING_STATUS}</span>
                      <span className="spd-meta-text">{pendingWaitText(r.waitingSeconds)}</span>
                    </RowBody>
                  </Link>
                ) : (
                  <div className="spd-row" data-static="true" title={SP_NOT_OPENABLE}>
                    <RowBody number={r.reference} client={r.clientName}>
                      <span className="spd-pill" data-tone="warn">{SP_PENDING_STATUS}</span>
                      <span className="spd-meta-text">{pendingWaitText(r.waitingSeconds)}</span>
                      <span className="spd-meta-text spd-restricted">{SP_NOT_OPENABLE_SHORT}</span>
                    </RowBody>
                  </div>
                )}
              </li>
            ))}
          </Panel>

          <Panel
            id="spd-p-fabric" area="fabric" title={SP_PANEL_FABRIC} raw
            count={data.fabricFinish.length + data.fabricFinishUnknown.length}
            countText={fabricCountText(data.fabricFinish.length, data.fabricFinishUnknown.length)}
            empty={SP_EMPTY.fabric}
          >
            {data.fabricFinishUnknown.length > 0 ? (
              <h3 className="spd-subhead">{SP_FABRIC_PENDING_HEADING} <span>{data.fabricFinish.length}</span></h3>
            ) : null}
            {data.fabricFinish.length > 0 ? (
              <ul className="spd-rows">
                {data.fabricFinish.map(r => (
                  <OrderRow key={r.orderId} orderId={r.orderId} number={r.displayNumber} client={r.clientName}>
                    <span className="spd-pill" data-tone="warn">{pendingKindsText(r.pending)}</span>
                    <span className="spd-meta-text">{sinceConfirmationText(r.daysSinceConfirmation)}</span>
                    {r.unknown.length > 0 ? <span className="spd-meta-text">{unknownKindsText(r.unknown)}</span> : null}
                    {r.over15Days ? <span className="spd-pill" data-tone="alert">{SP_OVER_15}</span> : null}
                  </OrderRow>
                ))}
              </ul>
            ) : <p className="spd-empty">{SP_FABRIC_NO_KNOWN_PENDING}</p>}
            {data.fabricFinishUnknown.length > 0 ? (
              <div className="spd-unknown">
                <h3 className="spd-subhead">{SP_UNKNOWN_HEADING} <span>{data.fabricFinishUnknown.length}</span></h3>
                <p className="spd-gap">{SP_UNKNOWN_RULE}</p>
                <ul className="spd-rows">
                  {data.fabricFinishUnknown.map(r => (
                    <OrderRow key={r.orderId} orderId={r.orderId} number={r.displayNumber} client={r.clientName}>
                      <span className="spd-pill" data-tone="muted">{unknownKindsText(r.unknown)}</span>
                      <span className="spd-meta-text">{sinceConfirmationText(r.daysSinceConfirmation)}</span>
                    </OrderRow>
                  ))}
                </ul>
              </div>
            ) : null}
          </Panel>
        </div>

        <div className="spd-col">
          <Panel
            id="spd-p-advance" area="advance" title={SP_PANEL_ADVANCE} count={data.advance.length}
            empty={SP_EMPTY.advance} notes={[advanceUncheckedNote(data.advanceUnchecked)]}
          >
            {data.advance.map(r => (
              <OrderRow key={r.orderId} orderId={r.orderId} number={r.displayNumber} client={r.clientName}>
                <span className="spd-meta-text spd-strong">{advancePercentText(r.percent)}</span>
                <span className="spd-pill" data-tone="warn">{SP_BELOW_40}</span>
                {r.exceptionApproved ? <span className="spd-meta-text">Exception approved</span> : null}
              </OrderRow>
            ))}
          </Panel>

          <Panel id="spd-p-ready" area="ready" title={SP_PANEL_READY} count={data.readyForDispatch.length} empty={SP_EMPTY.ready}>
            {data.readyForDispatch.map(r => (
              <OrderRow key={r.orderId} orderId={r.orderId} number={r.displayNumber} client={r.clientName}>
                <span className="spd-pill" data-tone="good">{SP_READY_STATUS}</span>
                <span className="spd-meta-text">{dispatchDateText(r.plannedDispatchDate)}</span>
              </OrderRow>
            ))}
          </Panel>
        </div>
      </div>
    </div>
  )
}
