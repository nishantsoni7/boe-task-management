'use client'

// The one row of section tabs beneath the page header.
//
// Each tab is a real <Link> to the page's EXISTING url. That is the whole trick:
//
//   • Deep links, refresh and the browser Back button work with no state to
//     restore — the address IS the selected tab.
//   • A tab that is not open costs nothing. Nothing here fetches; the next tab's
//     data is requested only when its page mounts.
//   • The routes keep their guards (AttendanceGuard / PayrollGuard), so a tab
//     grants nothing. Which tabs an admin sees is decided by
//     attendancePayrollNav.tsx, which holds no access rule of its own.
//
// It is navigation between pages, so it uses <nav> + aria-current rather than
// role="tablist" (which would promise arrow-key and single-tab-stop behaviour it
// would then have to implement, over links that are already keyboard-operable).
// Below 768px the row scrolls sideways inside itself and the current tab is
// scrolled into view, so the page never scrolls sideways.

import Link from 'next/link'
import { useEffect, useRef } from 'react'
import { BookOpen } from 'lucide-react'
import {
  activeTabFor,
  isAttendancePayrollNavItemActive,
  type AttendancePayrollSection,
} from './attendancePayrollNav'
import styles from './attendancePayrollShell.module.css'

export function ModuleSectionTabs({
  section, pathname,
}: {
  section: AttendancePayrollSection
  pathname: string
}) {
  const rowRef = useRef<HTMLElement>(null)
  const active = activeTabFor(pathname, section)
  const helpActive = !!section.help && isAttendancePayrollNavItemActive(pathname, section.help)

  // Keep the current tab visible when the row overflows. Scrolls the row only —
  // `inline: 'nearest'` and `block: 'nearest'` never move the page.
  useEffect(() => {
    const current = rowRef.current?.querySelector<HTMLElement>('[aria-current="page"]')
    current?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [pathname])

  if (!section.tabs || section.tabs.length === 0) return null

  return (
    <nav ref={rowRef} className={styles.tabsRow} aria-label={`${section.label} pages`}>
      {section.tabs.map(tab => {
        const isActive = active?.path === tab.path
        return (
          <Link
            key={tab.path}
            href={tab.path}
            className={`${styles.tab}${isActive ? ` ${styles.tabActive}` : ''}`}
            aria-current={isActive ? 'page' : undefined}
          >
            {tab.label}
          </Link>
        )
      })}
      {section.help && (
        <Link
          href={section.help.path}
          className={`${styles.tab} ${styles.tabHelp}${helpActive ? ` ${styles.tabActive} ${styles.tabHelpActive}` : ''}`}
          aria-current={helpActive ? 'page' : undefined}
        >
          <BookOpen size={14} strokeWidth={1.8} aria-hidden="true" />
          {section.help.label}
        </Link>
      )}
    </nav>
  )
}
