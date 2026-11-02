'use client'

// "ORDERS TO WATCH" — one board of the running orders somebody has to chase, under a one-line
// picture of the pipeline. The tab counts ARE the headline figures, so there is no separate row of
// cards: Delayed · Due in 7 days · Payments pending · Fabric / finish · Not aligned. The first tab
// with rows is open on arrival. Every row opens its order.
//
// The rows are boardRows() from OverviewSection, unchanged: the database's lists, in the words the
// rest of the dashboard uses. Nothing is computed here but the pipeline bar (lib/orders/adminDashboard.ts).

import { useId, useState } from 'react'
import Link from 'next/link'
import { CalendarClock, ChevronRight, CircleCheck, Clock, Factory, IndianRupee, Layers, type LucideIcon } from 'lucide-react'
import { withReturnTo } from '@/lib/navigation/recordReturn'
import { displayOrderNumber } from '@/lib/orderNumbering'
import {
  BOARD_COPY,
  formatRupees,
  plural,
  type BoardKey,
  type DashboardSummary,
} from '@/lib/orders/orderDashboardSummary'
import { ADMIN_BOARD_ORDER, ADMIN_BOARD_VISIBLE_ROWS, BOARD_TONE, pipelineOf } from '@/lib/orders/adminDashboard'
import { boardRows } from './OverviewSection'
import { ToneChip } from './AdminChip'
import styles from './adminDashboard.module.css'

const BOARD_ICON: Record<BoardKey, LucideIcon> = {
  delayed: Clock, due_soon: CalendarClock, payments: IndianRupee, fabric: Layers, not_aligned: Factory, aligned: CircleCheck,
}

export function AdminOrdersBoard({ summary }: { summary: DashboardSummary }) {
  const panelId = useId()
  const [picked, setPicked] = useState<BoardKey | null>(null)
  const [expanded, setExpanded] = useState<BoardKey | null>(null)
  const ov = summary.overview
  if (!ov) return null

  const all = Object.fromEntries(ADMIN_BOARD_ORDER.map(k => [k, boardRows(summary, k)])) as Record<BoardKey, ReturnType<typeof boardRows>>
  const active = picked ?? ADMIN_BOARD_ORDER.find(k => all[k].length > 0) ?? ADMIN_BOARD_ORDER[0]
  const rows = all[active]
  const shown = expanded === active ? rows : rows.slice(0, ADMIN_BOARD_VISIBLE_ROWS)
  const pipe = pipelineOf(ov, summary.notAligned.length)
  const Icon = BOARD_ICON[active]

  return (
    <section className={styles.card} aria-labelledby="adm-watch-h">
      <header className={styles.watchHead}>
        <h2 id="adm-watch-h" className={styles.cardTitle}>Orders to watch</h2>
        <div className={styles.pipe}>
          <span><b>{pipe.running}</b> running {pipe.running === 1 ? 'order' : 'orders'}</span>
          {pipe.running > 0 ? (
            <>
              <span className={styles.bar} role="img" aria-label={`${pipe.ready} of ${pipe.running} ready for production`}>
                <i className={styles.barOk} style={{ width: `${pipe.readyPct}%` }} />
                <i className={styles.barWarn} style={{ width: `${pipe.notAlignedPct}%` }} />
              </span>
              <span className={styles.leg}><span className={styles.dot} aria-hidden="true" />{pipe.ready} ready for production · {formatRupees(pipe.readyValue)}</span>
              {pipe.notAligned > 0 ? (
                <span className={styles.leg}><span className={`${styles.dot} ${styles.dotWarn}`} aria-hidden="true" />{pipe.notAligned} not aligned</span>
              ) : null}
            </>
          ) : null}
        </div>
      </header>
      <div className={styles.tabs} role="tablist" aria-label="Order lists">
        {ADMIN_BOARD_ORDER.map(k => (
          <button
            key={k} type="button" role="tab" id={`${panelId}-${k}`}
            aria-selected={active === k} aria-controls={panelId}
            className={styles.tab}
            onClick={() => setPicked(k)}
          >
            {BOARD_COPY[k].label}
            <span className={`${styles.tabN} ${k === 'delayed' && all[k].length > 0 ? styles.tabNDanger : ''} ${all[k].length === 0 ? styles.tabNZero : ''}`}>{all[k].length}</span>
          </button>
        ))}
      </div>
      <div id={panelId} role="tabpanel" aria-labelledby={`${panelId}-${active}`}>
        {rows.length === 0 ? (
          <div className={styles.empty}><CircleCheck size={20} aria-hidden="true" /><span>{BOARD_COPY[active].empty}</span></div>
        ) : (
          <>
            <ul className={styles.blist}>
              {shown.map(r => {
                const [first, ...rest] = r.sub.split(' · ')
                return (
                  <li key={r.key}>
                    <Link href={withReturnTo(`/orders/${r.orderId}`, '/orders')} className={styles.brow} prefetch={false}>
                      <span className={`${styles.who} ${styles.cOrd}`}>
                        <span className={styles.oid}>#{displayOrderNumber(r.displayNumber)}</span>
                        <span className={styles.oclient}>{r.clientName || 'Client not recorded'}</span>
                      </span>
                      <span className={`${styles.cellv} ${styles.cIss}`}>
                        <ToneChip tone={BOARD_TONE[active]} icon={Icon}>{r.issue ?? r.headline}</ToneChip>
                      </span>
                      <span className={`${styles.cellv} ${styles.cCtx}`}>
                        <span className={styles.ctx1}>{first}</span>
                        {rest.map(line => <span key={line} className={styles.sub}>{line}</span>)}
                      </span>
                      <span className={`${styles.cellv} ${styles.right} ${styles.cFig}`}>
                        <span className={styles.val}>{r.figure}</span>
                        <span className={styles.sub}>{r.figureLabel}</span>
                      </span>
                      <ChevronRight size={16} strokeWidth={2} className={styles.go} aria-hidden="true" />
                    </Link>
                  </li>
                )
              })}
            </ul>
            {rows.length > ADMIN_BOARD_VISIBLE_ROWS ? (
              <div className={styles.more}>
                <button
                  type="button" className="boe-btn boe-btn-text" aria-expanded={expanded === active}
                  onClick={() => setExpanded(expanded === active ? null : active)}
                >
                  {expanded === active ? 'Show fewer' : `Show all ${plural(rows.length, 'order')}`}
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  )
}
