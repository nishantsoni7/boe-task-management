'use client'

// ── The Day Close strip, under the punch-in strip on the Modules page ────────
//
// Owner, 2026-11-12: whoever is switched on must not be able to say they missed it.
//
//   red    "3 tasks are still open"                        from 6:00 pm until the day is closed
// (2026-11-18: no morning plan and no strikes any more; the evening close is the only ask.)
//
// "Open Task Management" goes to the dashboard, whose Today card holds the day's tasks and Close my day.
//
// It cannot be hidden: it leaves when the thing is done. THE SERVER DECIDES (GET /api/day-close/prompt,
// src/lib/dayClose/rules.ts dayPrompt); this only draws it. Nothing for anybody not switched on, while
// loading, or if the read fails. A placement and nothing else: no write goes anywhere from here.

import { AppLink as Link } from '@/components/ui/AppLink'
import { TriangleAlert } from 'lucide-react'
import { useDayPrompt } from '@/hooks/queries/useDayPrompt'
import styles from './punchStrip.module.css'

export function DayStrip({ userId, enabled }: { userId: string | null; enabled: boolean }) {
  const { data } = useDayPrompt(userId, enabled)
  if (!enabled || !data) return null
  const p = data.prompt

  // No morning plan and no strikes (owner, 2026-11-18): the strip asks only for the evening close.
  if (p.kind !== 'close_day') return null
  const tone = styles.missing
  const title = p.open > 0
    ? `${p.open} ${p.open === 1 ? 'task is' : 'tasks are'} still open`
    : 'Close your day before you punch out'
  const detail = 'Before you leave, finish each task or move it to a new date with a reason, then close your day.'

  const Icon = TriangleAlert
  return (
    <section className={`${styles.strip} ${tone}`} role="status" aria-label="Your day">
      <span className={styles.icon}><Icon aria-hidden="true" focusable="false" /></span>
      <div className={styles.text}>
        <p className={styles.title}>{title}</p>
        <p className={styles.detail}>{detail}</p>
      </div>
      <Link href="/dashboard" className={styles.hide} style={{ textDecoration: 'none' }}>Open Task Management</Link>
    </section>
  )
}
