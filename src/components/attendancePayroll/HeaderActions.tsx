'use client'

// A page's own header actions, the way a phone needs them (owner, 2026-11-05,
// "phones: content first"). Below 768px the module header is one row; a text
// button such as "Salary Processing Report" or "Create Payroll Period" beside
// the title squeezed the title to a few letters or pushed the row onto a
// second line. On a phone those actions move into the shared ⋯ / + menu
// (PhoneHeaderMenu); on a desktop the page's own buttons are drawn exactly as
// before.
//
// Presentation only: every item calls what the desktop button calls.

import type { ReactNode } from 'react'
import { PhoneHeaderMenu, type PhoneMenuItem } from '@/components/layout/PhoneHeaderMenu'

export function HeaderActions({ children, items, label = 'More actions', kind = 'more' }: {
  /** The desktop buttons, unchanged. */
  children: ReactNode
  /** The same actions for the phone menu. */
  items: PhoneMenuItem[]
  label?: string
  kind?: 'more' | 'add'
}) {
  return (
    <>
      {/* display: contents keeps the desktop row exactly as it was. */}
      <span className="boe-desktop-only" style={{ display: 'contents' }}>{children}</span>
      <PhoneHeaderMenu label={label} kind={kind} items={items} />
    </>
  )
}
