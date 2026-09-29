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

/** One line per order: what is wrong, whose court it is in, and how long it has waited. */
type Row = DashboardOrderRef & {
  key?: string
  status: ReactNode
  /** Small muted line under the status. */
  sub?: ReactNode
  /** Elapsed time, short; `waitingTitle` carries the full timestamp for hover. */
  waiting?: string
  waitingTitle?: string
}

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
            <div className="od-row-detail">
              <span className="od-row-strong">{r.status}</span>
              {r.sub ? <span className="od-row-sub">{r.sub}</span> : null}
            </div>
            <div className="od-row-wait" title={r.waitingTitle}>{r.waiting ?? ''}</div>
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

function Heading({ id, title, count }: { id: string; title: string; count: number }) {
  return (
    <header className="od-group-head">
      <h2 id={id} className="od-group-title">{title}</h2>
      <span className="od-group-count">{count}</span>
    </header>
  )
}

// ── The status strip: three counters, one glance ─────────────────────────────
//
// A list with nothing in it draws no section at all — its counter says "0" here, in green. A
// counter above zero jumps to its list. What could not be assessed is still said, under the
// strip, so a green zero is never a claim about orders nobody could check.

export function StatusStrip({ summary }: { summary: DashboardSummary }) {
  const items: { key: GroupKey; count: number }[] = [
    { key: 'not_aligned', count: summary.notAligned.length },
    { key: 'advance_below_40', count: summary.advance.length },
    { key: 'fabric_finish_pending', count: summary.fabricFinish.length },
  ]
  return (
    <nav className="od-strip" aria-label="Orders that need intervention">
      {items.map(i => {
        const inner = (
          <>
            <span className="od-strip-dot" data-state={i.count > 0 ? 'attention' : 'clear'} aria-hidden="true" />
            <span className="od-strip-label">{GROUP_COPY[i.key].label}</span>
            <span className="od-strip-count">{i.count}</span>
          </>
        )
        return i.count > 0
          ? <a key={i.key} href={`#${groupAnchor(i.key)}`} className="od-strip-item">{inner}</a>
          : <span key={i.key} className="od-strip-item" data-clear="true">{inner}</span>
      })}
    </nav>
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
    status: alignmentLine(r),
    sub: (
      <>
        <span className="od-row-court" data-court={r.waitingOn}>{waitingOnLabel(r.waitingOn, reviewerName)}</span>
        {r.advanceBlocks && r.state !== 'held_advance' ? <> · {ADVANCE_BLOCKS_NOTE}</> : null}
      </>
    ),
    waiting: formatWaiting(r.waitingSeconds),
    waitingTitle: `Since ${formatInstantIst(r.since)}`,
  }))
  if (rows.length === 0) return null
  return (
    <section id={groupAnchor('not_aligned')} className="od-group" aria-labelledby={headId}>
      <Heading id={headId} title={copy.label} count={rows.length} />
      <p className="od-group-summary">{alignmentSummary(summary.notAligned, reviewerName)}</p>
      <RowList rows={rows} visible={6} />
    </section>
  )
}

// ── 2. Advance below 40% ─────────────────────────────────────────────────────

export function AdvanceSection({ summary }: { summary: DashboardSummary }) {
  const copy = GROUP_COPY.advance_below_40
  const headId = useId()
  const rows: Row[] = summary.advance.map(r => ({
    ...r,
    status: advanceLine(r),
    sub: r.exceptionApproved || r.held ? (
      <>
        {r.exceptionApproved ? <span className="od-row-flag">{EXCEPTION_APPROVED_NOTE}</span> : null}
        {r.held ? <span>Held for advance</span> : null}
      </>
    ) : undefined,
  }))
  const gap = groupGapNote('advance_below_40', summary.gaps)
  if (rows.length === 0) return gap ? <p className="od-group-gap">{gap}</p> : null
  return (
    <section id={groupAnchor('advance_below_40')} className="od-group" aria-labelledby={headId}>
      <Heading id={headId} title={copy.label} count={rows.length} />
      <RowList rows={rows} />
      {gap ? <p className="od-group-gap">{gap}</p> : null}
    </section>
  )
}

// ── 3. Fabric or finish pending ──────────────────────────────────────────────

export function FabricFinishSection({ summary }: { summary: DashboardSummary }) {
  const copy = GROUP_COPY.fabric_finish_pending
  const headId = useId()
  const rows: Row[] = summary.fabricFinish.map(r => ({ ...r, status: fabricFinishLine(r) }))
  const unrecorded: Row[] = summary.fabricUnrecorded.map(r => ({ ...r, status: unrecordedLine(r) }))
  const gap = groupGapNote('fabric_finish_pending', summary.gaps)
  const unrecordedBlock = unrecorded.length > 0 ? (
    <details className="od-unrecorded">
      <summary>{UNRECORDED_TITLE} · {unrecorded.length}</summary>
      <p className="od-group-rule">{UNRECORDED_RULE}</p>
      <RowList rows={unrecorded} />
    </details>
  ) : null
  if (rows.length === 0) {
    if (!unrecordedBlock && !gap) return null
    return (
      <div id={groupAnchor('fabric_finish_pending')}>
        {unrecordedBlock}
        {gap ? <p className="od-group-gap">{gap}</p> : null}
      </div>
    )
  }
  return (
    <section id={groupAnchor('fabric_finish_pending')} className="od-group" aria-labelledby={headId}>
      <Heading id={headId} title={copy.label} count={rows.length} />
      <RowList rows={rows} />
      {unrecordedBlock}
      {gap ? <p className="od-group-gap">{gap}</p> : null}
    </section>
  )
}
