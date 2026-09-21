'use client'

import { useRouter } from 'next/navigation'
import { Receipt as ReceiptIcon } from 'lucide-react'

// ── QUICK ACTIONS — ONE DEFINITION LIST, TWO PLACEMENTS ──────────────────────
//
// A quick action is the handful of things somebody must be able to start from
// the first screen after signing in, without opening a module and finding a
// list first. Today there is exactly one; the shape below exists so the second
// one is a single entry in buildQuickActions and nothing else.
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
  href: string
  icon: React.ReactNode
}

/**
 * Whether each action is authorized for the person whose screen this is.
 * One flag per definition below, named after it.
 */
export type QuickActionGates = {
  canQuickAddExpense: boolean
}

/**
 * The definitions, in the order they are stacked. Add an action by adding an
 * entry and its gate — both placements pick it up with no layout work.
 */
export function buildQuickActions(gates: QuickActionGates): QuickAction[] {
  const actions: QuickAction[] = []

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
            onClick={() => router.push(action.href)}
          >
            {action.icon}
            {action.label}
          </button>
        ))}
      </div>
    </section>
  )
}
