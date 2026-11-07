'use client'

// ── The punch-in strip, at the very top of the Modules page ─────────────────
//
// Owner, 2026-11-07: everybody sees their punch-in for 30 minutes after it, and
// anybody who has not punched in sees a highlighted notice for the rest of the
// day, so nobody can say they missed the punch.
//
//   green  "You punched in at 10:04 am"  (on time)     30 minutes
//   amber  "You punched in at 10:27 am"  (late by N)   30 minutes
//   red    "No punch-in recorded for you today"        all day, until they punch
//          in or press "Hide for today"; tomorrow it is judged afresh
//
// THE SERVER DECIDES WHAT TO SAY AND FOR HOW LONG (src/lib/minop/punchStrip.ts,
// GET /api/attendance/my-punch); this only draws it. The time left is counted
// from when the answer arrived, so a wrong device clock cannot keep a strip up.
// "Hide for today" is remembered per user on this device, against the server's
// date (src/lib/modules/punchStripHidden.ts), and never hides green or amber.
//
// Nothing is drawn while the answer is loading, if the read fails, or for
// anybody the server cannot honestly say it of. It is never a reason to block
// the launcher. A placement and nothing else: no write goes anywhere.

import { useEffect, useState } from 'react'
import { CircleCheck, Clock, TriangleAlert, type LucideIcon } from 'lucide-react'
import { usePunchStrip } from '@/hooks/queries/usePunchStrip'
import type { PunchStripTone } from '@/lib/minop/punchStrip'
import { isPunchStripHidden, punchStripHiddenKey } from '@/lib/modules/punchStripHidden'
import styles from './punchStrip.module.css'

const TONES: Record<PunchStripTone, { className: string; Icon: LucideIcon }> = {
  on_time: { className: styles.ok, Icon: CircleCheck },
  late: { className: styles.late, Icon: Clock },
  missing: { className: styles.missing, Icon: TriangleAlert },
}

export function PunchStrip({ userId, enabled }: { userId: string | null; enabled: boolean }) {
  const { data, dataUpdatedAt } = usePunchStrip(userId, enabled)
  const [hiddenOn, setHiddenOn] = useState<string | null>(null)
  const [expiredAt, setExpiredAt] = useState(0)

  // Read after mount (localStorage is not there during the server render), when
  // the user changes, and when another tab hides it.
  useEffect(() => {
    if (!userId) return
    const load = () => {
      let stored: string | null = null
      try { stored = window.localStorage.getItem(punchStripHiddenKey(userId)) } catch { /* private mode */ }
      setHiddenOn(stored)
    }
    load()
    window.addEventListener('storage', load)
    return () => window.removeEventListener('storage', load)
  }, [userId])

  // The 30 minutes end while the page is open.
  const showFor = data?.tone ? data.showForMs : null
  useEffect(() => {
    if (showFor === null) return
    const left = Math.max(0, showFor - (Date.now() - dataUpdatedAt))
    const timer = window.setTimeout(() => setExpiredAt(dataUpdatedAt), Math.min(left, 2 ** 31 - 1))
    return () => window.clearTimeout(timer)
  }, [showFor, dataUpdatedAt])

  // `enabled` off (previewing somebody else) draws nothing even when this
  // person's own answer is still cached from before.
  if (!enabled || !data || !data.tone) return null
  if (data.showForMs !== null && expiredAt === dataUpdatedAt) return null
  if (data.tone === 'missing' && isPunchStripHidden(hiddenOn, data.today)) return null

  const { className, Icon } = TONES[data.tone]

  const hide = () => {
    if (!userId) return
    setHiddenOn(data.today)
    try { window.localStorage.setItem(punchStripHiddenKey(userId), data.today) } catch { /* private mode */ }
  }

  return (
    <section className={`${styles.strip} ${className}`} role="status" aria-label="Today's punch-in">
      <span className={styles.icon}><Icon aria-hidden="true" focusable="false" /></span>
      <div className={styles.text}>
        <p className={styles.title}>{data.title}</p>
        <p className={styles.detail}>{data.detail}</p>
      </div>
      {data.tone === 'missing' && (
        <button type="button" className={styles.hide} onClick={hide}>Hide for today</button>
      )}
    </section>
  )
}
