'use client'

// THE ORDER'S QUIET PARTS, FOLDED BELOW THE PRODUCTS (Nitish / Operations, 24 Nov 2026).
//
// Client and sale, Dates, Payment, Pendencies, Internal details and terms, the
// Commercial breakdown and Activity used to fill the top of the page. Operations
// reads the products and the PI all day and these rarely, so each is a row with
// ONE line saying where it stands (orderDetailRows.ts words it) and opens in
// place when somebody wants it.
//
// PRESENTATION ONLY. The bodies are the page's own cards, handed in; nothing
// here fetches, writes or authorizes.
//
// EVERY BODY STAYS MOUNTED. A closed row is `hidden`, not removed, so the cards
// that read on mount (Pendencies) still read once, at startup, exactly as before
// and the pinned startup counts do not move; the Order bar's "From client" count
// depends on that read having run.
//
// A ROW OPENS BY ITSELF in two cases only: it is holding up the viewer's
// decision (DetailRowView.openByDefault), or something asked for it — a gate on
// the Order bar, or a link from another screen (#order-pendencies). A person's
// own click always wins over the first; nothing is remembered between visits.

import { useEffect, useState, type ReactNode } from 'react'
import { Activity, CalendarDays, ChevronDown, ListChecks, Receipt, Scale, Users, Wallet } from 'lucide-react'
import {
  DETAILS_HEADING,
  DETAILS_HEADING_NOTE,
  type DetailRowKey,
  type DetailRowView,
} from '@/lib/orders/orderDetailRows'

const ICON: Record<DetailRowKey, typeof Users> = {
  client: Users,
  dates: CalendarDays,
  pay: Wallet,
  pend: ListChecks,
  terms: Scale,
  totals: Receipt,
  act: Activity,
}

/** Which hash opens which row. Only the one other screens already link to. */
const HASH_ROW: Record<string, DetailRowKey> = { '#order-pendencies': 'pend' }

export type RowOpenRequest = { key: DetailRowKey; nonce: number }

export function OrderDetailRows({ rows, bodies, request = null }: {
  rows: readonly DetailRowView[]
  bodies: Record<DetailRowKey, ReactNode>
  /** Opens a row and scrolls to it: the Order bar's gates. A new nonce asks again. */
  request?: RowOpenRequest | null
}) {
  // A link from another screen (#order-pendencies). Nothing on this page scrolls
  // to a hash by itself and the page draws a skeleton first, so it is read once,
  // when this component first appears (never during server rendering).
  const [fromHash] = useState<DetailRowKey | null>(() =>
    typeof window === 'undefined' ? null : HASH_ROW[window.location.hash] ?? null)

  // What the person chose by hand. A row with no choice follows its own default,
  // which can change once the figures it depends on have been read.
  const [chosen, setChosen] = useState<Partial<Record<DetailRowKey, boolean>>>(() => (fromHash ? { [fromHash]: true } : {}))
  const [target, setTarget] = useState<{ key: DetailRowKey; nonce: number } | null>(fromHash ? { key: fromHash, nonce: 0 } : null)
  const [handled, setHandled] = useState<number | null>(null)

  const isOpen = (r: DetailRowView) => chosen[r.key] ?? r.openByDefault

  // A gate on the bar asked for a row: open it and remember to scroll to it. Done
  // while rendering (React's way of adjusting state to a changed prop), not in an effect.
  if (request && request.nonce !== handled) {
    setHandled(request.nonce)
    setChosen(c => ({ ...c, [request.key]: true }))
    setTarget({ key: request.key, nonce: request.nonce })
  }

  // Scroll after the row has opened, so the target has its height.
  useEffect(() => {
    if (!target) return
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    document.getElementById(`order-row-${target.key}`)?.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'center' })
  }, [target])

  return (
    <section className="order-rows" aria-label={DETAILS_HEADING}>
      <div className="order-rows-head">
        <h2 className="order-rows-title">{DETAILS_HEADING}</h2>
        <span className="order-rows-note">{DETAILS_HEADING_NOTE}</span>
      </div>
      <div className="order-rows-card">
        {rows.map(r => {
          const open = isOpen(r)
          const Icon = ICON[r.key]
          return (
            <div
              key={r.key}
              id={`order-row-${r.key}`}
              className={['order-row', r.flag ? `order-row--${r.flag}` : ''].filter(Boolean).join(' ')}
            >
              <button
                type="button"
                className="order-row-head"
                aria-expanded={open}
                aria-controls={`order-row-body-${r.key}`}
                onClick={() => setChosen(c => ({ ...c, [r.key]: !open }))}
              >
                <span className="order-row-icon" aria-hidden="true"><Icon size={18} strokeWidth={2} /></span>
                <span className="order-row-text">
                  <span className="order-row-title">{r.title}</span>
                  <span className="order-row-summary">{r.summary}</span>
                </span>
                {r.badge && (
                  <span className={`order-row-badge order-row-badge--${r.badge.tone}`}>
                    <span aria-hidden="true">{r.badge.text}</span>
                    <span className="order-row-sr">{r.badge.label}</span>
                  </span>
                )}
                <ChevronDown className="order-row-chev" size={18} strokeWidth={2} aria-hidden="true" />
              </button>
              <div
                id={`order-row-body-${r.key}`}
                className="order-row-body"
                role="region"
                aria-label={r.title}
                hidden={!open}
              >
                {bodies[r.key]}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
