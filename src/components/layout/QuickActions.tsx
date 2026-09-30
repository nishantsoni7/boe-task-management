'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarClock, Receipt as ReceiptIcon } from 'lucide-react'
import { AttendanceRequestFlow } from '@/components/attendanceRequests/AttendanceRequestFlow'

// ── QUICK ACTIONS — ONE DEFINITION LIST, TWO PLACEMENTS ──────────────────────
//
// A quick action is the handful of things somebody must be able to start from
// the first screen after signing in, without opening a module and finding a
// list first. An entry is a link to an existing route (`href`) or opens a shared
// form in place (`opens`); a new one is a single entry in buildQuickActions.
//
// WHERE IT IS DRAWN depends only on whether the permanent sidebar is on screen,
// and that question is answered by CSS at the sidebar's own 767px breakpoint
// (see .boe-quick-actions-sidebar / .boe-quick-actions-page in globals.css):
//
//   >= 768px  the sidebar is permanent, so the section lives in it, directly
//             below Home, and the dashboard body carries nothing.
//   <= 767px  the sidebar is a drawer behind a menu button, so the section
//             lives in the page above the module grid instead. It is NOT left
//             in the drawer as well — an action you have to open a menu to
//             reach is not a quick action.
//
// Both copies are always in the DOM and exactly one is displayed, so there is
// no viewport at which the action appears twice and no media query in
// JavaScript to disagree with the one in CSS.
//
// NOTHING HERE IS A PERMISSION. The gates are computed by the caller from each
// module's own capability derivation and passed in; this file only decides
// layout. See src/app/modules/page.tsx.

export type QuickAction = {
  /** Stable key for React and for tests. */
  key: string
  /** Full button label. Never abbreviated — it is the same on both surfaces. */
  label: string
  /** Existing route. Unchanged by this file. */
  href?: string
  /** Opens a shared form in place instead of navigating. */
  opens?: 'attendance-request'
  icon: React.ReactNode
}

/**
 * Whether each action is authorized for the person whose screen this is.
 * One flag per definition below, named after it.
 */
export type QuickActionGates = {
  canQuickAddExpense: boolean
  /**
   * Any signed-in, active employee may send their OWN attendance request. This
   * is not module access: the API pins the request to the caller's token and
   * grants nothing about anybody else's attendance, approvals or payroll.
   */
  canRequestAttendance: boolean
}

/**
 * The definitions, in the order they are stacked. Add an action by adding an
 * entry and its gate — both placements pick it up with no layout work.
 */
export function buildQuickActions(gates: QuickActionGates): QuickAction[] {
  const actions: QuickAction[] = []

  if (gates.canRequestAttendance) {
    actions.push({
      key: 'attendance-request',
      label: 'Attendance request',
      opens: 'attendance-request',
      icon: <CalendarClock size={16} strokeWidth={1.9} aria-hidden="true" />,
    })
  }

  if (gates.canQuickAddExpense) {
    actions.push({
      key: 'add-expense',
      label: 'Quick Add Expense',
      href: '/finance/expenses/new',
      icon: <ReceiptIcon size={16} strokeWidth={1.9} aria-hidden="true" />,
    })
  }

  return actions
}

/**
 * The section, rendered identically on both surfaces apart from the wrapper
 * that the breakpoint switches on.
 *
 * Renders nothing at all when no action is authorized, so an unauthorized
 * employee gets no empty heading in either place.
 */
export function QuickActionList({
  actions,
  variant,
}: {
  actions: QuickAction[]
  variant: 'sidebar' | 'page'
}) {
  const router = useRouter()
  // Each placement owns its own open state; CSS shows exactly one of them, so
  // only one can ever be tapped.
  const [openForm, setOpenForm] = useState<QuickAction['opens'] | null>(null)

  if (actions.length === 0) return null

  const isSidebar = variant === 'sidebar'

  return (
    <section
      className={isSidebar
        ? 'boe-sidebar-section boe-quick-actions-sidebar'
        : 'boe-quick-actions-page'}
      aria-label="Quick Actions"
    >
      <h2 className={isSidebar ? 'boe-sidebar-label' : 'boe-quick-actions-page-label'}>
        Quick Actions
      </h2>
      <div className="boe-quick-action-list">
        {actions.map(action => (
          <button
            key={action.key}
            type="button"
            className="boe-btn boe-quick-action"
            onClick={() => (action.opens ? setOpenForm(action.opens) : router.push(action.href!))}
          >
            {action.icon}
            {action.label}
          </button>
        ))}
      </div>
      {openForm === 'attendance-request' && <AttendanceRequestFlow onClose={() => setOpenForm(null)} />}
    </section>
  )
}
