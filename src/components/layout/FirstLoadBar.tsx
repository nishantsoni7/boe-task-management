'use client'

import { useEffect, useState } from 'react'
import { useIsFetching } from '@tanstack/react-query'
import styles from './FirstLoadBar.module.css'

// A THIN BAR AT THE TOP OF THE SCREEN WHILE A FIRST READ IS SLOW (28 Nov 2026).
//
// Pages already show a loader or skeleton for their first read, and a click that
// leaves the page shows the BOE One loader (AppLink, NavWaitRouter). What had no
// signal at all was DATA ARRIVING LATE on a page that was already drawn: the
// Modules For you column, an Order's side panels. They pop in and the person
// cannot tell whether the page is finished.
//
// This bar answers that, once, for every screen that reads through React Query:
// it shows while any query that has NOTHING to show yet is fetching, and only
// after FIRST_LOAD_BAR_DELAY_MS, so a quick answer never flashes it. A refresh of
// data already on screen (the 60 s polls, a refetch on mount) has data, so it
// never counts; a query that is switched off is not fetching, so it never counts.
//
// It informs and nothing else: it covers no control and takes no clicks.
// Guard: src/components/layout/FirstLoadBar.dom.test.tsx.

export const FIRST_LOAD_BAR_DELAY_MS = 500

const hasNothingYet = (query: { state: { data: unknown } }) => query.state.data === undefined

export function FirstLoadBar() {
  const waiting = useIsFetching({ predicate: hasNothingYet }) > 0
  const [late, setLate] = useState(false)

  // The timer is what turns the bar on; the cleanup turns it off again (and when the wait ends, and on unmount).
  useEffect(() => {
    if (!waiting) return
    const timer = window.setTimeout(() => setLate(true), FIRST_LOAD_BAR_DELAY_MS)
    return () => { window.clearTimeout(timer); setLate(false) }
  }, [waiting])

  if (!waiting || !late) return null
  return (
    <div className={styles.bar} role="progressbar" aria-label="Loading" aria-busy="true">
      <span className={styles.fill} />
    </div>
  )
}
