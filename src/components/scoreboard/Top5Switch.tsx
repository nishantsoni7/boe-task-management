'use client'

// Who sees the Scoreboard's Top 5 (owner, 2026-11-13). On Team Today -> People & targets, administrators only.
// Off (the default): staff see only their own score; administrators still see the Top 5 and "Most improved".
// On: everybody sees them on their Scoreboard card.

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { dayCloseFetch } from '@/components/dayClose/api'
import styles from '@/components/dayClose/teamToday.module.css'

export function Top5Switch() {
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const query = useQuery<{ top5Public: boolean }>({
    queryKey: ['scoreboard', 'visibility'],
    queryFn: async () => {
      const r = await dayCloseFetch<{ top5Public: boolean }>('/api/scoreboard/visibility')
      if (!r.ok) throw new Error(r.error)
      return r.data
    },
    retry: false,
  })
  const on = query.data?.top5Public ?? false

  const flip = async (next: boolean) => {
    setBusy(true)
    const r = await dayCloseFetch('/api/scoreboard/visibility', { body: { top5Public: next } })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    setError(null)
    await queryClient.invalidateQueries({ queryKey: ['scoreboard'] })
  }

  return (
    <section className={styles.card} aria-labelledby="top5-heading">
      <div className={styles.cardHead}>
        <h2 id="top5-heading" className={styles.h2}>Who sees the Top 5</h2>
        <span className={`${styles.chip} ${on ? styles.chipGreen : styles.chipGrey}`}>{on ? 'Everyone' : 'Only administrators'}</span>
      </div>
      <p className={styles.muted}>
        {on
          ? 'Everybody sees the Top 5 and “Most improved” on their Scoreboard card.'
          : 'Staff see only their own score. You still see the Top 5 and “Most improved”. Announced monthly champions are shown to everyone either way.'}
      </p>
      {query.error instanceof Error && <p className={styles.error} role="alert">{query.error.message}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {query.data && (
        <div className={styles.decisionActions} style={{ marginTop: 10 }}>
          <button type="button" className={`boe-btn ${on ? 'boe-btn-ghost' : 'boe-btn-primary'}`} disabled={busy} aria-busy={busy} onClick={() => flip(!on)}>
            {on ? 'Hide from staff' : 'Show to everyone'}
          </button>
        </div>
      )}
    </section>
  )
}
