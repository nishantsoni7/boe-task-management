'use client'

// THE STAR SELLER'S SUPER PRIORITY on everybody's Modules page and Task dashboard (owner, 2026-11-12): who won
// Star Seller last month, and which of their Orders they put into Factory Focus, so every salesperson sees the
// power worth winning. The Star Seller alone, before picking, chooses one of their own open Orders here.
// Nothing is drawn when last month has no announced Star Seller.

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { dayCloseFetch } from '@/components/dayClose/api'
import styles from './scoreCard.module.css'

type State = {
  month: string
  monthLabel: string
  seller: { name: string; isMe: boolean } | null
  pick?: { orderNumber: string | null; status: string | null; note: string | null; active: boolean } | null
  openOrders?: { id: string; number: string; client: string }[]
}

export function StarSellerCard({ enabled }: { enabled: boolean }) {
  const queryClient = useQueryClient()
  const { data } = useQuery<State>({
    queryKey: ['scoreboard', 'star-seller'],
    enabled,
    queryFn: async () => {
      const r = await dayCloseFetch<State>('/api/scoreboard/star-seller')
      if (!r.ok) throw new Error(r.error)
      return r.data
    },
    staleTime: 10 * 60_000,
    retry: false,
  })
  const [orderId, setOrderId] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!enabled || !data?.seller) return null
  const { seller, pick } = data

  if (pick) {
    return (
      <section className={styles.starCard} aria-label="Star Seller’s Super Priority">
        <span className={styles.starTitle}>★ Star Seller’s Super Priority</span>
        <span className={styles.starOrder}>Order {pick.orderNumber ?? '—'}{pick.active ? '' : ' (done)'}</span>
        <span className={styles.muted}>Chosen by {seller.isMe ? 'you' : seller.name}, {data.monthLabel}’s Star Seller.{pick.note ? ` “${pick.note}”` : ''} It is in Factory Focus until dispatched.</span>
      </section>
    )
  }

  if (!seller.isMe) {
    return (
      <section className={styles.starCard} aria-label="Star Seller">
        <span className={styles.starTitle}>★ {seller.name} is {data.monthLabel}’s Star Seller</span>
        <span className={styles.muted}>The highest sales of the month earn one Order of their choice in Factory Focus.</span>
      </section>
    )
  }

  const pickIt = async () => {
    if (busy || !orderId) return
    setBusy(true)
    const r = await dayCloseFetch('/api/scoreboard/star-seller', { body: { order_id: orderId, note } })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    await queryClient.invalidateQueries({ queryKey: ['scoreboard', 'star-seller'] })
  }

  return (
    <section className={styles.starCard} aria-labelledby="star-pick-heading">
      <span id="star-pick-heading" className={styles.starTitle}>★ You are {data.monthLabel}’s Star Seller</span>
      <span className={styles.muted}>Choose one of your open Orders for Super Priority. It goes into Factory Focus, where the factory sees it first, and every salesperson sees your name on it.</span>
      {(data.openOrders ?? []).length === 0 ? (
        <span className={styles.muted}>You have no open Order right now. The pick stays yours: come back when you do.</span>
      ) : (
        <>
          <select className={styles.voteNote} value={orderId} onChange={e => setOrderId(e.target.value)} aria-label="Your open Orders">
            <option value="">Choose an Order</option>
            {(data.openOrders ?? []).map(o => <option key={o.id} value={o.id}>{o.number} · {o.client}</option>)}
          </select>
          <input className={styles.voteNote} value={note} maxLength={200} onChange={e => setNote(e.target.value)} placeholder="Why this one? (optional, everybody sees it)" aria-label="Why this Order" />
          {error && <p className={styles.voteError} role="alert">{error}</p>}
          <button type="button" className="boe-btn boe-btn-primary" onClick={pickIt} disabled={busy || !orderId} aria-busy={busy}>
            {busy ? 'Saving…' : 'Use my Super Priority'}
          </button>
        </>
      )}
    </section>
  )
}
