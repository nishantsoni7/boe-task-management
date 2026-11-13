'use client'

// THE MONTHLY TEAM VOTE (owner, 2026-11-12), on the Modules page and the Task Management dashboard, only while
// the vote is open (the last 3 days of the month) and only for somebody on the Scoreboard:
//
//   "Who helped you most this month?"  3 different colleagues, an optional line each, one Send. Secret.
//   Not voting costs your own Team points (2 of the 10), which the card says.
//
// After voting it thanks them and stays until the vote closes, so nobody wonders whether it went through.

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { dayCloseFetch } from '@/components/dayClose/api'
import styles from './scoreCard.module.css'

type VoteState = {
  month: string
  open: boolean
  opensOn: string
  closesAt: string
  canVote: boolean
  voted?: boolean
  candidates?: { id: string; name: string }[]
}

function monthName(month: string): string {
  return new Date(`${month}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', timeZone: 'UTC' })
}

export function VoteCard({ enabled }: { enabled: boolean }) {
  const queryClient = useQueryClient()
  const { data } = useQuery<VoteState>({
    queryKey: ['scoreboard', 'vote'],
    enabled,
    queryFn: async () => {
      const r = await dayCloseFetch<VoteState>('/api/scoreboard/vote')
      if (!r.ok) throw new Error(r.error)
      return r.data
    },
    staleTime: 5 * 60_000,
    retry: false,
  })
  const [chosen, setChosen] = useState<string[]>([])
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!enabled || !data || !data.open || !data.canVote) return null

  const closes = new Date(data.closesAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })

  if (data.voted) {
    return (
      <section className={styles.card} aria-label="Team vote">
        <h2 className={styles.title}>Team vote · {monthName(data.month)}</h2>
        <p className={styles.muted}>Thank you, your 3 votes are in. Results are announced at the award meeting.</p>
      </section>
    )
  }

  const toggle = (id: string) => {
    setError(null)
    setChosen(c => c.includes(id) ? c.filter(x => x !== id) : c.length >= 3 ? c : [...c, id])
  }

  const send = async () => {
    if (busy) return
    setBusy(true)
    const r = await dayCloseFetch('/api/scoreboard/vote', { body: { nominees: chosen, notes } })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    await queryClient.invalidateQueries({ queryKey: ['scoreboard'] })
  }

  return (
    <section className={styles.card} aria-labelledby="vote-heading">
      <div className={styles.head}>
        <h2 id="vote-heading" className={styles.title}>Who helped you most in {monthName(data.month)}?</h2>
        <span className={`${styles.band} ${styles.steady}`}>{chosen.length} of 3</span>
      </div>
      <p className={styles.muted}>Choose 3 colleagues. Your votes are secret. Not voting costs you 2 Team points. Closes {closes}.</p>
      <ul className={styles.list} aria-label="Colleagues">
        {(data.candidates ?? []).map(c => {
          const on = chosen.includes(c.id)
          return (
            <li key={c.id} className={styles.voteRow}>
              <label className={styles.voteLabel}>
                <input type="checkbox" checked={on} onChange={() => toggle(c.id)} disabled={!on && chosen.length >= 3} />
                <span>{c.name}</span>
              </label>
              {on && (
                <input
                  className={styles.voteNote}
                  value={notes[c.id] ?? ''}
                  maxLength={200}
                  onChange={e => setNotes(n => ({ ...n, [c.id]: e.target.value }))}
                  placeholder="How did they help? (optional)"
                  aria-label={`How ${c.name} helped`}
                />
              )}
            </li>
          )
        })}
      </ul>
      {error && <p className={styles.voteError} role="alert">{error}</p>}
      <button type="button" className="boe-btn boe-btn-primary" onClick={send} disabled={busy || chosen.length !== 3} aria-busy={busy}>
        {busy ? 'Sending…' : 'Send my 3 votes'}
      </button>
    </section>
  )
}
