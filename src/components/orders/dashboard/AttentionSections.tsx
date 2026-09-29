'use client'

// THE ORDERS THAT NEED SOMEBODY TO STEP IN.
//
//   1. Not aligned for manufacturing — prominent, straight after Factory Focus.
//      Each row says WHOSE COURT it is in and SINCE WHEN, with the start
//      timestamp and the elapsed time, because "not aligned" is several different
//      waits and only one of them is the operations reviewer's.
//   2. Advance below 40% — an approved exception does not remove a row; it is said.
//   3. Fabric or finish pending — each item on its own; a status nobody ever
//      recorded is a separate, quieter list, never counted as pending.
//
// Every row is a link to its order, and every heading carries its count. An order
// may sit under more than one heading and is NOT de-duplicated. What could not be
// assessed is said under the heading it affects, never folded into "0".

import { useId, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { withReturnTo } from '@/lib/navigation/recordReturn'
import {
  ADVANCE_BLOCKS_NOTE,
  EXCEPTION_APPROVED_NOTE,
  GROUP_COPY,
  UNRECORDED_RULE,
  UNRECORDED_TITLE,
  advanceLine,
  alignmentLine,
  alignmentSummary,
  fabricFinishLine,
  formatInstantIst,
  formatWaiting,
  groupGapNote,
  plural,
  unrecordedLine,
  waitingOnLabel,
  type DashboardSummary,
  type DashboardOrderRef,
  type GroupKey,
} from '@/lib/orders/orderDashboardSummary'

/** How many rows a heading shows before "Show all". */
export const VISIBLE_ROWS = 5

type Row = DashboardOrderRef & { key?: string; detail: ReactNode }

function RowList({ rows, visible = VISIBLE_ROWS }: { rows: Row[]; visible?: number }) {
  const listId = useId()
  const router = useRouter()
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? rows : rows.slice(0, visible)
  return (
    <>
      <ul id={listId} className="od-rows">
        {shown.map(r => (
          <li key={r.key ?? r.orderId} className="od-row">
            <div className="od-row-id">
              {/* Hover or focus is the earliest honest sign this order is about to be opened, so
                  its ROUTE (never the record) is fetched now: no record, no permission and no
                  file is read until the page mounts under the reader's own session. */}
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
            <div className="od-row-detail">{r.detail}</div>
          </li>
        ))}
      </ul>
      {rows.length > visible ? (
        <button
          type="button" className="boe-btn boe-btn-ghost od-show-all"
          aria-expanded={expanded} aria-controls={listId}
          onClick={() => setExpanded(v => !v)}
        >
          {expanded ? 'Show fewer' : `Show all ${plural(rows.length, 'order')}`}
        </button>
      ) : null}
    </>
  )
}

function Heading({ id, title, count, rule }: { id: string; title: string; count: number; rule: string }) {
  return (
    <header className="od-group-head">
      <h2 id={id} className="od-group-title">
        {title}
        <span className="od-group-count"> · {count}</span>
      </h2>
      <p className="od-group-rule">{rule}</p>
    </header>
  )
}

export const groupAnchor = (key: GroupKey) => `od-group-${key}`

// ── 1. Not aligned for manufacturing ─────────────────────────────────────────

export function AlignmentSection({ summary }: { summary: DashboardSummary }) {
  const copy = GROUP_COPY.not_aligned
  const headId = useId()
  const reviewerName = summary.reviewer?.name ?? null
  const rows: Row[] = summary.notAligned.map(r => ({
    ...r,
    detail: (
      <>
        <span className="od-row-strong">{alignmentLine(r)}</span>
        <span className="od-row-court" data-court={r.waitingOn}>{waitingOnLabel(r.waitingOn, reviewerName)}</span>
        <span className="od-row-since">
          Since {formatInstantIst(r.since)} · waiting {formatWaiting(r.waitingSeconds)}
        </span>
        {r.advanceBlocks && r.state !== 'held_advance' ? <span className="od-row-note">{ADVANCE_BLOCKS_NOTE}</span> : null}
      </>
    ),
  }))
  return (
    <section id={groupAnchor('not_aligned')} className="od-group od-group--prominent" aria-labelledby={headId}>
      <Heading id={headId} title={copy.label} count={rows.length} rule={copy.rule} />
      {rows.length > 0 ? (
        <p className="od-group-summary">{alignmentSummary(summary.notAligned, reviewerName)}</p>
      ) : null}
      {rows.length === 0 ? <p className="od-group-empty">{copy.emptyText}</p> : <RowList rows={rows} visible={6} />}
    </section>
  )
}

// ── 2. Advance below 40% ─────────────────────────────────────────────────────

export function AdvanceSection({ summary }: { summary: DashboardSummary }) {
  const copy = GROUP_COPY.advance_below_40
  const headId = useId()
  const rows: Row[] = summary.advance.map(r => ({
    ...r,
    detail: (
      <>
        <span>{advanceLine(r)}</span>
        {r.exceptionApproved ? <span className="od-row-flag">{EXCEPTION_APPROVED_NOTE}</span> : null}
        {r.held ? <span className="od-row-note">Held for advance</span> : null}
      </>
    ),
  }))
  const gap = groupGapNote('advance_below_40', summary.gaps)
  return (
    <section id={groupAnchor('advance_below_40')} className="od-group" aria-labelledby={headId}>
      <Heading id={headId} title={copy.label} count={rows.length} rule={copy.rule} />
      {rows.length === 0 ? <p className="od-group-empty">{copy.emptyText}</p> : <RowList rows={rows} />}
      {gap ? <p className="od-group-gap">{gap}</p> : null}
    </section>
  )
}

// ── 3. Fabric or finish pending ──────────────────────────────────────────────

export function FabricFinishSection({ summary }: { summary: DashboardSummary }) {
  const copy = GROUP_COPY.fabric_finish_pending
  const headId = useId()
  const rows: Row[] = summary.fabricFinish.map(r => ({ ...r, detail: <span>{fabricFinishLine(r)}</span> }))
  const unrecorded: Row[] = summary.fabricUnrecorded.map(r => ({ ...r, detail: <span>{unrecordedLine(r)}</span> }))
  const gap = groupGapNote('fabric_finish_pending', summary.gaps)
  return (
    <section id={groupAnchor('fabric_finish_pending')} className="od-group" aria-labelledby={headId}>
      <Heading id={headId} title={copy.label} count={rows.length} rule={copy.rule} />
      {rows.length === 0 ? <p className="od-group-empty">{copy.emptyText}</p> : <RowList rows={rows} />}
      {unrecorded.length > 0 ? (
        <details className="od-unrecorded">
          <summary>{UNRECORDED_TITLE} · {unrecorded.length}</summary>
          <p className="od-group-rule">{UNRECORDED_RULE}</p>
          <RowList rows={unrecorded} />
        </details>
      ) : null}
      {gap ? <p className="od-group-gap">{gap}</p> : null}
    </section>
  )
}
