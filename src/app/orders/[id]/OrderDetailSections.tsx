'use client'

// THE ORDER'S DETAILS, ALL OPEN, BELOW THE PRODUCTS (owner, 25 Nov 2026).
//
// Client and sale, Dates, Payment, Pendencies, Internal details and terms, the
// Commercial breakdown and Activity used to be seven FOLDED rows (24 Nov): nothing
// was visible until somebody opened it, and the owner said so ("everything is
// collapsed which is not required ... the commercial breakdown should be always
// visible"). They are separate sections now, none folded, in two-column grids whose
// sections are the SAME HEIGHT as the one beside them, in two places:
//
//   with the PRODUCTS   Internal details and terms (Pendencies at its foot)  |  Commercial breakdown
//                       (OrderTermsAndMoney: the foot of the Products card, owner, 25 Nov 2026,
//                        "make it look like part of the product section only, with some minimal
//                        separation through color or line": a hairline and a faint tint)
//   below them          Payment                                              |  Dates over Client and sale
//                       Activity                                                (OrderDetailSections: its own card)
//
// PRESENTATION ONLY. The bodies are the page's own cards, handed in; nothing here
// fetches, writes or authorizes, and every body is mounted from the first draw, so
// the cards that read on mount (Pendencies) still read once, at startup, and the
// pinned startup counts do not move.
//
// THE HEIGHTS MATCH BY LAYOUT, NOT BY LUCK (globals.css): a section is a column
// that fills its cell, and the block at its foot (Pendencies, the Order value, the
// advance note) sticks to the bottom edge, so two columns end on the same line
// whatever their content.
//
// SCROLLING. The Advance cell on the facts line asks for the Payment section, and a
// link to #order-pendencies asks for the section Pendencies sits in; both scroll to
// it (nothing is opened any more, because nothing is closed). Nothing is remembered.

import { useEffect, useState, type ReactNode } from 'react'
import { Activity, CalendarDays, Receipt, Scale, Users, Wallet, type LucideIcon } from 'lucide-react'

export type SectionKey = 'terms' | 'totals' | 'pay' | 'dates' | 'client' | 'act'

export const SECTION_TITLE: Record<SectionKey, string> = {
  terms: 'Internal details and terms',
  totals: 'Commercial breakdown',
  pay: 'Payment',
  dates: 'Dates',
  client: 'Client and sale',
  act: 'Activity',
}

const ICON: Record<SectionKey, LucideIcon> = {
  terms: Scale,
  totals: Receipt,
  pay: Wallet,
  dates: CalendarDays,
  client: Users,
  act: Activity,
}

export const ORDER_DETAILS_LABEL = 'Order details'
export const TERMS_AND_MONEY_LABEL = 'Internal details and commercial breakdown'

/** Which hash scrolls to which section. Only the one other screens already link to. */
const HASH_SECTION: Record<string, SectionKey> = { '#order-pendencies': 'terms' }

export type SectionRequest = { key: SectionKey; nonce: number }

function Head({ k, actions }: { k: SectionKey; actions?: ReactNode }) {
  const Icon = ICON[k]
  return (
    <header className="order-section-head">
      <Icon size={17} strokeWidth={2} aria-hidden="true" />
      <h2 className="order-section-title" id={`order-sec-${k}-title`}>{SECTION_TITLE[k]}</h2>
      {actions ? <div className="order-section-actions">{actions}</div> : null}
    </header>
  )
}

/**
 * Internal details and terms (with Pendencies at its foot) beside the Commercial breakdown. `attached` joins it
 * to the Products card above it: no gap, no top edge, a faint tint (the page puts it INSIDE the products
 * wrapper then). Without products (an Order with no source PI) it is a card of its own.
 */
export function OrderTermsAndMoney({ terms, pendencies, totals, attached = false }: {
  /** The internal details card (or its loading placeholder). */
  terms: ReactNode
  /** Fabric and Finish approvals with the pendency list: drawn at the foot of the terms section. */
  pendencies: ReactNode
  totals: ReactNode
  attached?: boolean
}) {
  return (
    <section className={attached ? 'order-sections order-sections--attached' : 'order-sections'} aria-label={TERMS_AND_MONEY_LABEL}>
      <div className="order-sections-band order-sections-band--two">
        <section className="order-section" id="order-sec-terms" aria-labelledby="order-sec-terms-title">
          <Head k="terms" />
          {terms}
          <div className="order-section-foot">{pendencies}</div>
        </section>
        <section className="order-section order-section--commercial" id="order-sec-totals" aria-labelledby="order-sec-totals-title">
          <Head k="totals" />
          {totals}
        </section>
      </div>
    </section>
  )
}

export function OrderDetailSections({ payment, dates, client, activity, request = null }: {
  /** The Payment figures, and the controls drawn on the right of its heading. */
  payment: { actions: ReactNode; body: ReactNode }
  dates: ReactNode
  client: ReactNode
  activity: ReactNode
  /** Scrolls to a section: the facts line's gates. A new nonce asks again. */
  request?: SectionRequest | null
}) {
  // A link from another screen (#order-pendencies). Nothing on this page scrolls to a hash by
  // itself and the page draws a skeleton first, so it is read once, when this component first
  // appears (never during server rendering).
  const [fromHash] = useState<SectionKey | null>(() =>
    typeof window === 'undefined' ? null : HASH_SECTION[window.location.hash] ?? null)
  const [target, setTarget] = useState<SectionRequest | null>(fromHash ? { key: fromHash, nonce: 0 } : null)
  const [handled, setHandled] = useState<number | null>(null)

  // The gate asked for a section: remember to scroll to it. Done while rendering (React's way of
  // adjusting state to a changed prop), not in an effect.
  if (request && request.nonce !== handled) {
    setHandled(request.nonce)
    setTarget(request)
  }

  useEffect(() => {
    if (!target) return
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    document.getElementById(`order-sec-${target.key}`)?.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'center' })
  }, [target])

  return (
    <section className="order-sections" aria-label={ORDER_DETAILS_LABEL}>
      <div className="order-sections-band order-sections-band--two">
        <section className="order-section order-section--payment" id="order-sec-pay" aria-labelledby="order-sec-pay-title">
          <Head k="pay" actions={payment.actions} />
          {payment.body}
        </section>
        <div className="order-sections-stack">
          <section className="order-section order-section--dates" id="order-sec-dates" aria-labelledby="order-sec-dates-title">
            <Head k="dates" />
            {dates}
          </section>
          <section className="order-section" id="order-sec-client" aria-labelledby="order-sec-client-title">
            <Head k="client" />
            {client}
          </section>
        </div>
      </div>
      <div className="order-sections-band order-sections-band--one">
        <section className="order-section" id="order-sec-act" aria-labelledby="order-sec-act-title">
          <Head k="act" />
          {activity}
        </section>
      </div>
    </section>
  )
}
