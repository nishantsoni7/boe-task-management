'use client'

// ── The Day Close strip, under the punch-in strip on the Modules page ────────
//
// Owner, 2026-11-12: whoever is switched on must not be able to say they missed it.
//
//   amber  "File today's plan by 10:30 am"                until the plan is filed
//   red    "Your plan was due at 10:30 am"                 after the due time
//   red    "Close your day before you punch out"           from 6:00 pm until the day is closed
//
// It cannot be hidden: it leaves when the thing is done. THE SERVER DECIDES (GET /api/day-close/prompt,
// src/lib/dayClose/rules.ts dayPrompt); this only draws it. Nothing for anybody not switched on, while
// loading, or if the read fails. A placement and nothing else: no write goes anywhere from here.

import { AppLink as Link } from '@/components/ui/AppLink'
import { TriangleAlert, ListChecks } from 'lucide-react'
import { useDayPrompt } from '@/hooks/queries/useDayPrompt'
import styles from './punchStrip.module.css'

export function DayStrip({ userId, enabled }: { userId: string | null; enabled: boolean }) {
  const { data } = useDayPrompt(userId, enabled)
  if (!enabled || !data) return null
  const p = data.prompt

  let tone: string
  let title: string
  let detail: string
  if (p.kind === 'file_plan') {
    tone = p.late ? styles.missing : styles.late
    title = p.late ? `Your plan was due at ${p.due}` : `File today’s plan by ${p.due}`
    detail = 'Write what you will get done today. A late or missing plan is recorded as a strike.'
  } else if (p.kind === 'close_day') {
    tone = styles.missing
    title = 'Close your day before you punch out'
    detail = p.open > 0
      ? `${p.open} ${p.open === 1 ? 'item is' : 'items are'} still open. Leaving without closing is recorded as a strike.`
      : 'Leaving without closing is recorded as a strike.'
  } else {
    return null
  }

  const Icon = p.kind === 'file_plan' && !p.late ? ListChecks : TriangleAlert
  return (
    <section className={`${styles.strip} ${tone}`} role="status" aria-label="Your day">
      <span className={styles.icon}><Icon aria-hidden="true" focusable="false" /></span>
      <div className={styles.text}>
        <p className={styles.title}>{title}</p>
        <p className={styles.detail}>{detail}</p>
      </div>
      <Link href="/my-day" className={styles.hide} style={{ textDecoration: 'none' }}>Open My Day</Link>
    </section>
  )
}
