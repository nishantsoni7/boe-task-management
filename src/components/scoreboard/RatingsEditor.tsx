'use client'

// The owner's monthly rating (owner, 2026-11-12): 1 to 5 for each person on the Scoreboard, with one line of
// reason the person reads. Worth its number of points (of 5). Open from the 25th until 23:00 IST on the month's
// last day. Once the vote has closed it also shows each person's vote total and the anonymous lines, for the
// award meeting, never who voted for whom. The owner alone: /api/scoreboard/ratings refuses everybody else.

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { dayCloseFetch } from '@/components/dayClose/api'
import styles from '@/components/dayClose/dayClose.module.css'

type Person = {
  id: string
  name: string
  rating: { rating: number; reason: string } | null
  votes: number | null
  lines: string[]
}
type Ratings = { month: string; open: boolean; opensOn: string; closesAt: string; votesShown: boolean; people: Person[] }

function monthName(month: string): string {
  return new Date(`${month}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

export function RatingsEditor() {
  const [open, setOpen] = useState(false)
  const query = useQuery<Ratings>({
    queryKey: ['scoreboard', 'ratings'],
    enabled: open,
    queryFn: async () => {
      const r = await dayCloseFetch<Ratings>('/api/scoreboard/ratings')
      if (!r.ok) throw new Error(r.error)
      return r.data
    },
    retry: false,
  })
  const d = query.data

  return (
    <section className={styles.card} aria-labelledby="ratings-heading">
      <button type="button" className={styles.toggle} onClick={() => setOpen(o => !o)} aria-expanded={open} id="ratings-heading">
        {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        {' '}Your ratings{d ? ` for ${monthName(d.month)}` : ''}
      </button>
      {open && query.error instanceof Error && <p className={styles.error} role="alert">{query.error.message}</p>}
      {open && !d && !query.error && <p className={styles.muted}>Loading…</p>}
      {open && d && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
          <p className={styles.muted}>
            {d.open
              ? 'Rate each person 1 to 5 with one line of reason. They read both. Worth up to 5 points. You can change a rating until the month closes.'
              : `Ratings open on the 25th (${d.opensOn}).`}
          </p>
          {d.people.map(p => <RatingRow key={p.id} person={p} open={d.open} votesShown={d.votesShown} />)}
        </div>
      )}
    </section>
  )
}

function RatingRow({ person, open, votesShown }: { person: Person; open: boolean; votesShown: boolean }) {
  const queryClient = useQueryClient()
  const [rating, setRating] = useState<number | null>(person.rating?.rating ?? null)
  const [reason, setReason] = useState(person.rating?.reason ?? '')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const save = async () => {
    setBusy(true)
    const r = await dayCloseFetch('/api/scoreboard/ratings', { body: { employee_id: person.id, rating, reason } })
    setBusy(false)
    setMsg(r.ok ? { ok: true, text: 'Saved' } : { ok: false, text: r.error })
    if (r.ok) await queryClient.invalidateQueries({ queryKey: ['scoreboard'] })
  }

  return (
    <div className={styles.item}>
      <div className={styles.itemHead}>
        <p className={styles.itemTitle}>{person.name}</p>
        {votesShown && person.votes !== null && (
          <span className={`${styles.chip} ${styles.chipBlue}`}>{person.votes} {person.votes === 1 ? 'vote' : 'votes'}</span>
        )}
      </div>
      {person.lines.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {person.lines.map((l, i) => <li key={i} className={styles.itemSub}>“{l}”</li>)}
        </ul>
      )}
      {open ? (
        <>
          <div className={styles.actions} role="radiogroup" aria-label={`Rating for ${person.name}`}>
            {[1, 2, 3, 4, 5].map(n => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={rating === n}
                className={`boe-btn ${rating === n ? 'boe-btn-primary' : 'boe-btn-ghost'}`}
                onClick={() => setRating(n)}
                style={{ minWidth: 44 }}
              >
                {n}
              </button>
            ))}
          </div>
          <input className={styles.input} value={reason} maxLength={300} onChange={e => setReason(e.target.value)}
            placeholder="One line of reason (they read it)" aria-label={`Reason for ${person.name}`} />
          <div className={styles.actions}>
            <button type="button" className="boe-btn boe-btn-ghost" onClick={save} disabled={busy || rating === null} aria-busy={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
          {msg && <p className={msg.ok ? styles.muted : styles.error} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
        </>
      ) : person.rating ? (
        <p className={styles.itemSub}>{person.rating.rating} of 5: {person.rating.reason}</p>
      ) : null}
    </div>
  )
}
