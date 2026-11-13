'use client'

// THE MORNING CARD (owner, 2026-11-12: no separate Performance module; the score is seen twice a day where
// people already are). On the Modules page and the Task Management dashboard:
//
//   your month-to-date score, its band, the change since yesterday's record, the month's line,
//   where the points come from, the one fastest way up, and the top 5 (names only; nobody sees a rank).
//   The top 5 and "Most improved" reach staff only when the owner switches them on (2026-11-13); the server
//   sends an empty list otherwise, and administrators always get them.
//
// The evening half is the line under "Day closed" on the Today card (EveningScoreLine). Both read
// /api/scoreboard/me, which takes the person from the bearer token. Nothing is drawn while loading, if the
// read fails, or for somebody who is not scored (administrators, people excluded from tracking).

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { dayCloseFetch } from '@/components/dayClose/api'
import styles from './scoreCard.module.css'

type Band = 'star' | 'strong' | 'steady' | 'watch' | 'red'

export type MyScore = {
  today: string
  month: string
  scored: boolean
  score?: number | null
  band?: Band | null
  bandLabel?: string | null
  change?: number | null
  trend?: (number | null)[]
  pillars?: { pillar: string; label: string; earned: number; possible: number }[]
  parts?: { key: string; label: string; max: number; earned: number | null; note: string }[]
  tip?: string | null
  top5: { name: string; score: number; band: Band; bandLabel: string }[]
  mostImproved: { name: string; rise: number } | null
  /** Last month's winners, once the owner has announced them. */
  champions?: { label: string; names: string[] }[] | null
  championsMonth?: string | null
  /** The person's own goals from last month's private review (only they and the owner see them). */
  myGoals?: { goals: string[]; checkin_on: string } | null
}

export function useMyScore(enabled: boolean) {
  return useQuery<MyScore>({
    queryKey: ['scoreboard', 'me'],
    enabled,
    queryFn: async () => {
      const r = await dayCloseFetch<MyScore>('/api/scoreboard/me')
      if (!r.ok) throw new Error(r.error)
      return r.data
    },
    staleTime: 5 * 60_000,
    retry: false,
  })
}

const BAND_CLASS: Record<Band, string> = {
  star: styles.star, strong: styles.strong, steady: styles.steady, watch: styles.watch, red: styles.red,
}

function monthName(month: string): string {
  return new Date(`${month}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', timeZone: 'UTC' })
}

function Spark({ values }: { values: (number | null)[] }) {
  const pts = values.map((v, i) => ({ v, i })).filter((p): p is { v: number; i: number } => p.v !== null)
  if (pts.length < 2) return null
  const w = 240, h = 40, n = values.length - 1 || 1
  const x = (i: number) => (i / n) * w
  const y = (v: number) => h - 4 - (v / 100) * (h - 8)
  const line = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ')
  const last = pts[pts.length - 1]
  return (
    <svg className={styles.spark} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="Your score this month, day by day">
      <path d={`${line} L${x(last.i).toFixed(1)} ${h} L${x(pts[0].i).toFixed(1)} ${h} Z`} className={styles.sparkFill} />
      <path d={line} className={styles.sparkLine} />
      <circle cx={x(last.i)} cy={y(last.v)} r={3} className={styles.sparkDot} />
    </svg>
  )
}

export function ScoreCard({ enabled }: { enabled: boolean }) {
  const { data } = useMyScore(enabled)
  const [open, setOpen] = useState(false)
  if (!enabled || !data) return null
  if (!data.scored && data.top5.length === 0 && !data.champions?.length) return null

  return (
    <section className={styles.card} aria-labelledby="score-card-heading">
      {data.champions && data.champions.length > 0 && (
        <div className={styles.champions}>
          <span className={styles.label}>👑 Champions of {data.championsMonth}</span>
          <ul className={styles.championList}>
            {data.champions.map(c => <li key={c.label}><strong>{c.label}:</strong> {c.names.join(', ')}</li>)}
          </ul>
        </div>
      )}
      {data.myGoals && (
        <div className={styles.goals}>
          <span className={styles.label}>Your goals this month (private)</span>
          <ol className={styles.goalList}>{data.myGoals.goals.map((g, i) => <li key={i}>{g}</li>)}</ol>
          <span className={styles.muted}>Check-in with the owner on {new Date(`${data.myGoals.checkin_on}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })}.</span>
        </div>
      )}
      <div className={styles.head}>
        <h2 id="score-card-heading" className={styles.title}>Scoreboard · {monthName(data.month)}</h2>
        {data.scored && data.band && <span className={`${styles.band} ${BAND_CLASS[data.band]}`}>{data.bandLabel}</span>}
      </div>

      {data.scored && (
        data.score === null || data.score === undefined ? (
          <p className={styles.muted}>Not enough of the month yet to give you a score. It starts as your days add up.</p>
        ) : (
          <div className={styles.mine}>
            <div className={styles.big}>
              <span className={styles.num}>{data.score}</span>
              <span className={styles.of}>/ 100</span>
              {typeof data.change === 'number' && data.change !== 0 && (
                <span className={data.change > 0 ? styles.up : styles.down}>
                  {data.change > 0 ? '▲' : '▼'} {Math.abs(data.change)} since yesterday
                </span>
              )}
            </div>
            <Spark values={data.trend ?? []} />
            {data.tip && <p className={styles.tip}><strong>Fastest way up:</strong> {data.tip}</p>}
            <button type="button" className={styles.toggle} onClick={() => setOpen(o => !o)} aria-expanded={open}>
              {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
              {' '}Where your points come from
            </button>
            {open && (
              <ul className={styles.parts}>
                {(data.pillars ?? []).map(p => (
                  <li key={p.pillar} className={styles.pillar}>
                    <span className={styles.pillarName}>{p.label}</span>
                    <span className={styles.pillarPts}>{p.earned} / {p.possible}</span>
                    <span className={styles.track}><i style={{ width: `${p.possible ? Math.round((100 * p.earned) / p.possible) : 0}%` }} /></span>
                  </li>
                ))}
                {(data.parts ?? []).map(p => (
                  <li key={p.key} className={styles.partRow}>
                    <span>{p.label}</span>
                    <span className={styles.muted}>{p.earned === null ? 'not counted yet' : `${p.earned} / ${p.max}`} · {p.note}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      )}

      {data.top5.length > 0 && (
        <div className={styles.top}>
          <span className={styles.label}>Top 5</span>
          <ol className={styles.list}>
            {data.top5.map((p, i) => (
              <li key={p.name} className={styles.row}>
                <span className={styles.rank}>{i + 1}</span>
                <span className={styles.name}>{p.name}{i === 0 ? ' 👑' : ''}</span>
                <span className={`${styles.band} ${BAND_CLASS[p.band]}`}>{p.bandLabel}</span>
                <span className={styles.pts}>{p.score}</span>
              </li>
            ))}
          </ol>
          {data.mostImproved && (
            <p className={styles.muted}>Most improved so far: <strong>{data.mostImproved.name}</strong> (▲ {data.mostImproved.rise})</p>
          )}
        </div>
      )}
    </section>
  )
}

/** The evening half: under "Day closed", what the day did to the month's score. */
export function EveningScoreLine({ enabled }: { enabled: boolean }) {
  const { data } = useMyScore(enabled)
  if (!enabled || !data?.scored || data.score === null || data.score === undefined) return null
  const change = data.change ?? null
  return (
    <p className={styles.evening}>
      {change === null ? 'Your score this month' : change >= 0 ? `Today: ▲ ${change}` : `Today: ▼ ${Math.abs(change)}`}
      {' · '}<strong>{data.score}/100</strong>{data.bandLabel ? ` (${data.bandLabel})` : ''}
      {data.tip ? ` · Tomorrow: ${data.tip}` : ''}
    </p>
  )
}
