'use client'

import { colors } from '@/lib/tokens'
import {
  AWAITING_APPROVAL_LABEL,
  type MyTaskTabKey,
} from '@/lib/tasks/myTaskTabs'

// The My Tasks workflow-tab strip.
//
// WHY IT IS ITS OWN COMPONENT. It used to be an IIFE nested three levels inside
// a 1700-line client component, where the only way to check what it rendered
// was to read it. `Awaiting Approval` was reported missing from the running
// page while the source plainly contained it, and nothing in the suite could
// distinguish "the tab is not in the code" from "the tab is in the code but
// never reaches the DOM". Lifted out, the strip renders in a test — see
// MyTaskViewTabs.test.tsx, which asserts all five tabs and their badges appear
// in the markup at both widths.
//
// It owns no data. Counts come from the one classifier
// (countMyTaskBuckets in src/lib/tasks/myTaskTabs.ts), so a badge and the rows
// the tab opens are the same computation and cannot disagree.

export type MyTaskViewTab = {
  key: MyTaskTabKey
  label: string
  accent: string
}

/**
 * The five workflow tabs, in order, as one exported constant.
 *
 * A workflow tab is a question about a task's STATE. The Task Type rail on the
 * left (View All / Self Tasks / Delegated) is a different axis — whose task it
 * is — and the two compose: a Task Type narrows the collection, these tabs then
 * split it by state.
 */
export const MY_TASK_VIEW_TABS: readonly MyTaskViewTab[] = [
  { key: 'today_actionable',   label: 'Today Actionable',      accent: '#2E9E6B' },
  { key: 'overdue_actionable', label: 'Overdue Actionable',    accent: '#C0551A' },
  { key: 'future_actionable',  label: 'Future Actionable',     accent: '#7C5CBF' },
  { key: 'waiting_blocked',    label: 'Waiting / Blocked',     accent: '#5B7FA6' },
  // Work this user has FINISHED and handed to its creator. Not an actionable
  // tab — nothing here is theirs to move — and the only tab these tasks appear
  // in. The gold matches the pending_approval badge on the task detail page.
  { key: 'awaiting_approval',  label: AWAITING_APPROVAL_LABEL, accent: '#A57F14' },
]

export function MyTaskViewTabs({
  activeTab,
  counts,
  onSelect,
  isMobile = false,
}: {
  activeTab: MyTaskTabKey | null
  counts: Record<MyTaskTabKey, number>
  onSelect: (key: MyTaskTabKey) => void
  isMobile?: boolean
}) {
  return (
    <div
      role="tablist"
      aria-label="Task view"
      style={{
        display: 'flex',
        gap: '0',
        borderBottom: `1px solid ${colors.border}`,
        padding: isMobile ? '0 14px' : '0 24px',
        // FIVE TABS NO LONGER FIT A PHONE IN ONE LINE, so on a narrow screen
        // the strip WRAPS onto a second row.
        //
        // The previous attempt scrolled it horizontally with the scrollbar
        // hidden, which is the failure mode this must not have: a tab that is
        // present, reachable in principle, and invisible in practice with no
        // affordance saying to swipe. Wrapping puts every tab on screen at
        // every width, which is worth two rows of chrome on a phone.
        flexWrap: isMobile ? 'wrap' : 'nowrap',
        rowGap: isMobile ? '0px' : undefined,
      }}
    >
      {MY_TASK_VIEW_TABS.map(tab => {
        const isActive = activeTab === tab.key
        return (
          <button
            key={tab.key}
            role="tab"
            aria-selected={isActive}
            aria-controls="my-tasks-list"
            onClick={() => onSelect(tab.key)}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              padding: '12px 4px',
              marginRight: isMobile ? '14px' : '20px',
              background: 'transparent', border: 'none',
              borderBottom: `2px solid ${isActive ? tab.accent : 'transparent'}`,
              cursor: 'pointer', outline: 'none',
              fontSize: isMobile ? '12px' : '12.5px',
              fontWeight: isActive ? 700 : 500,
              color: isActive ? tab.accent : colors.secondary,
              transition: 'color 0.12s, border-color 0.12s',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            {tab.label}
            <span style={{
              fontSize: '11px', fontWeight: 700,
              padding: '1px 7px', borderRadius: '10px',
              background: isActive ? `${tab.accent}18` : 'rgba(0,0,0,0.05)',
              color: isActive ? tab.accent : colors.muted,
              minWidth: '20px', textAlign: 'center',
            }}>
              {counts[tab.key]}
            </span>
          </button>
        )
      })}
    </div>
  )
}
