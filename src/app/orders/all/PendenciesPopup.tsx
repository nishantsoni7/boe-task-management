'use client'

// ── THE PENDENCIES COLUMN AND ITS POPUP (owner, 2026-10-27) ──────────────────
//
// A green dot and "Approved" when nothing is outstanding; otherwise a red pill
// saying how many are pending (owner, 2026-10-31), and a click lists exactly
// what is. Approving is not done here: it needs the ERP screenshot, so the popup
// hands over to the Order's Pendencies card. Display only — the rules live in
// pendencyOverview.ts and the database.

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { X } from 'lucide-react'
import {
  PENDENCY_ALL_APPROVED, pendencyCountLabel, type OrderPendencyOverview,
} from '@/lib/orders/pendencyOverview'

export function PendencyCell({ overview, onOpen }: { overview: OrderPendencyOverview | undefined; onOpen: () => void }) {
  // Not read yet (or unreadable): say nothing rather than a status nobody checked.
  if (!overview) return <span className="fin-muted">—</span>
  if (overview.approved) return <span className="orders-status-ok">{PENDENCY_ALL_APPROVED}</span>
  return (
    <button
      type="button"
      className="fin-pill fin-pill--over"
      style={{ cursor: 'pointer', border: 'none' }}
      aria-haspopup="dialog"
      title={`${overview.pending.length} pending: click to see them`}
      // The row opens the Order on click; this opens the list instead.
      onClick={e => { e.stopPropagation(); onOpen() }}
    >
      {pendencyCountLabel(overview.pending.length)}
    </button>
  )
}

export function PendenciesPopup({ orderNumber, overview, orderHref, onClose }: {
  orderNumber: string
  overview: OrderPendencyOverview
  /** The Order, at its Pendencies card. */
  orderHref: string
  onClose: () => void
}) {
  const panel = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    panel.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="order-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={panel} className="order-modal" role="dialog" aria-modal="true" aria-label={`Pendencies for order ${orderNumber}`} tabIndex={-1}>
        <div className="order-modal-head">
          <div className="order-modal-heading">
            <h2 className="order-modal-title">Pendencies · {orderNumber}</h2>
            <p className="order-modal-subtitle">
              {overview.approved ? 'Everything is approved.' : `${overview.pending.length} still to approve`}
            </p>
          </div>
          <button type="button" className="order-modal-close" onClick={onClose} aria-label="Close">
            <X size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        <div className="order-modal-body">
          <ul className="order-ff-pend-list">
            {overview.pending.map(item => (
              <li key={item.key} className="order-ff-pend-item">
                <span className="order-ff-pend-dot" aria-hidden="true" />
                <span className="order-ff-pend-label">{item.label}</span>
                <span className="fin-sub">{item.detail}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="order-modal-foot">
          <Link href={orderHref} prefetch={false} className="boe-btn boe-btn-primary">
            Open order to approve
          </Link>
        </div>
      </div>
    </div>
  )
}
