// Central presentation resolver for the shared Notifications experience.
//
// One place decides, per notification, everything that varies by module:
//   * the heading shown on the first row line (task actor, or module label),
//   * the coloured status badge,
//   * the deep-link URL to the exact source record, and
//   * the "View …" action label.
//
// This keeps the shared bell, list and page rendering module-agnostic: the page
// renders one row layout and never branches on Finance/Orders type checks.
//
// Contract by module:
//   * Task Management  — all task activity is stored under the single enum type
//     `task_acknowledged`; meaning lives in the title, so the badge/actor are
//     parsed from the title and the deep link uses `task_id`.
//   * Finance / Orders — dedicated stable enum types (`finance_*` / `order_*`)
//     drive the badge and destination; the exact record is found via `entity_id`
//     using each page's existing `?request=` / `?payment=` deep-link contract.

import type { Notification } from '@/lib/types'
import { colors } from '@/lib/tokens'

export type NotificationCategory = 'task' | 'finance' | 'order' | 'other'

export type NotificationMeta = {
  category: NotificationCategory
  /** First-line heading: the task actor's name, or the module label. */
  heading: string
  /** Whether `heading` is a person (task actor) vs. a module label — styling. */
  headingIsActor: boolean
  badge: { label: string; color: string; bg: string }
  /** Deep link to the exact record, or null when there is nothing to open. */
  href: string | null
  /** Action-button / accessibility label, module-aware. */
  actionLabel: string
}

// ── Task Management: parse actor + badge from the title ──────────────────────
const TASK_PATTERNS: Array<{ re: RegExp; label: string; color: string; bg: string }> = [
  { re: /added a comment/i,       label: 'Added comment',    color: colors.blue,  bg: colors.blueTint  },
  { re: /new comment on task/i,   label: 'New comment',      color: colors.blue,  bg: colors.blueTint  },
  { re: /acknowledged task/i,     label: 'Acknowledged',     color: colors.green, bg: colors.greenTint },
  { re: /task acknowledged/i,     label: 'Acknowledged',     color: colors.green, bg: colors.greenTint },
  { re: /completed task/i,        label: 'Completed',        color: colors.green, bg: colors.greenTint },
  { re: /task completed/i,        label: 'Completed',        color: colors.green, bg: colors.greenTint },
  { re: /cancelled task/i,        label: 'Cancelled',        color: colors.red,   bg: colors.redTint   },
  { re: /task cancelled/i,        label: 'Cancelled',        color: colors.red,   bg: colors.redTint   },
  { re: /cancellation reversed/i, label: 'Cancellation reversed', color: colors.blue, bg: colors.blueTint },
  { re: /reversed cancellation/i, label: 'Cancellation reversed', color: colors.blue, bg: colors.blueTint },
  { re: /moved task to blocked/i, label: 'Moved to Blocked', color: colors.red,   bg: colors.redTint   },
  { re: /moved task to waiting/i, label: 'Moved to Waiting', color: colors.amber, bg: colors.amberTint },
  { re: /moved task to \w+/i,     label: 'Status changed',   color: colors.blue,  bg: colors.blueTint  },
]

// ── Finance / Orders: badge keyed off the stable enum type ───────────────────
const TYPE_BADGES: Record<string, { label: string; color: string; bg: string }> = {
  // Finance
  finance_submitted:         { label: 'Needs review',    color: colors.amber, bg: colors.amberTint },
  finance_resubmitted:       { label: 'Resubmitted',     color: colors.blue,  bg: colors.blueTint  },
  finance_clarification:     { label: 'Clarification',   color: colors.blue,  bg: colors.blueTint  },
  finance_approved_suspense: { label: 'Approved',        color: colors.green, bg: colors.greenTint },
  finance_approved_linked:   { label: 'Approved',        color: colors.green, bg: colors.greenTint },
  finance_rejected:          { label: 'Rejected',        color: colors.red,   bg: colors.redTint   },
  finance_linked:            { label: 'Linked',          color: colors.green, bg: colors.greenTint },
  finance_status_corrected:  { label: 'Status updated',  color: colors.amber, bg: colors.amberTint },
  // Orders
  order_submitted:           { label: 'Needs review',    color: colors.amber, bg: colors.amberTint },
  order_assigned:            { label: 'Assigned',        color: colors.blue,  bg: colors.blueTint  },
  order_clarification:       { label: 'Clarification',   color: colors.blue,  bg: colors.blueTint  },
  order_resubmitted:         { label: 'Resubmitted',     color: colors.blue,  bg: colors.blueTint  },
  order_rejected:            { label: 'Rejected',        color: colors.red,   bg: colors.redTint   },
  order_converted:           { label: 'Converted',       color: colors.green, bg: colors.greenTint },
}

const NEUTRAL_BADGE = { label: 'Activity', color: colors.muted, bg: colors.float }

// Finance destinations follow where the record actually lives:
//   * /finance/received covers approved rows (status approved_linked /
//     approved_unlinked), so approval/link events point there (`?payment=`).
//     That route is now a resolver: it reads the payment's linkage and forwards
//     to Linked or Non-Linked Payments, so this stays one stable href even
//     though a payment moves between the two pages over its life.
//   * /finance loads every other status (pending, needs_clarification,
//     rejected, suspense), so all remaining events point there (`?request=`).
// Both reuse each page's existing deep-link handling.
const FINANCE_RECEIVED_EVENTS = new Set([
  'finance_approved_suspense',
  'finance_approved_linked',
  'finance_linked',
])

// Task title → actor: text before the matched verb, minus filler words.
function parseTaskActor(title: string, matchIndex: number): string | null {
  const before = title.slice(0, matchIndex).trim()
  return before.length > 0 && !/^(task|new|a)$/i.test(before) ? before : null
}

export function getNotificationMeta(n: Notification): NotificationMeta {
  const type = n.type ?? ''

  // ── Finance ────────────────────────────────────────────────────────────────
  if (type.startsWith('finance')) {
    const badge = TYPE_BADGES[type] ?? NEUTRAL_BADGE
    const href = n.entity_id
      ? (FINANCE_RECEIVED_EVENTS.has(type)
          ? `/finance/received?payment=${n.entity_id}`
          : `/finance?tab=all&request=${n.entity_id}`)
      : '/finance'
    return {
      category: 'finance',
      heading: 'Finance',
      headingIsActor: false,
      badge,
      href,
      actionLabel: 'View details',
    }
  }

  // ── Orders ─────────────────────────────────────────────────────────────────
  // Every Order notification carries the Order REQUEST id in entity_id and
  // deep-links into the Order Requests module — except order_converted, whose
  // subject is the Confirmed Order that was just created. That one carries the
  // ORDER id instead (set at the call site in orders/requests/page.tsx) and
  // points at the Order's own detail page, because a converted request is being
  // removed from the Order Requests module and would no longer resolve there.
  if (type.startsWith('order')) {
    const badge = TYPE_BADGES[type] ?? NEUTRAL_BADGE
    const href = n.entity_id
      ? (type === 'order_converted'
          ? `/orders/${n.entity_id}`
          : `/orders/requests?tab=all&request=${n.entity_id}`)
      : '/orders/requests'
    return {
      category: 'order',
      heading: 'Orders',
      headingIsActor: false,
      badge,
      href,
      actionLabel: 'View details',
    }
  }

  // ── Task Management ──────────────────────────────────────────────────────────
  const title = n.title ?? ''
  for (const p of TASK_PATTERNS) {
    const m = p.re.exec(title)
    if (!m) continue
    return {
      category: 'task',
      heading: parseTaskActor(title, m.index) ?? 'System',
      headingIsActor: parseTaskActor(title, m.index) != null,
      badge: { label: p.label, color: p.color, bg: p.bg },
      href: n.task_id ? `/tasks/${n.task_id}` : null,
      actionLabel: 'View Task',
    }
  }

  // ── Fallback ─────────────────────────────────────────────────────────────────
  return {
    category: n.task_id ? 'task' : 'other',
    heading: 'System',
    headingIsActor: false,
    badge: NEUTRAL_BADGE,
    href: n.task_id ? `/tasks/${n.task_id}` : null,
    actionLabel: n.task_id ? 'View Task' : 'View details',
  }
}
