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
//     drive the badge and destination; the exact record is found via
//     `entity_id`. Finance uses its pages' `?request=` / `?payment=` deep-link
//     contract; an Order Request has its own detail route, so the id is a path
//     segment there rather than a query parameter.

import type { Notification } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { ISSUE_PARAM } from '@/lib/objections'

export type NotificationCategory = 'task' | 'finance' | 'order' | 'asset' | 'other'

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
  // The event KEYS are history and are never renamed; only the badge a person
  // reads changes, so both routes to this one action say the same word.
  finance_approved_suspense: { label: 'Verified',        color: colors.green, bg: colors.greenTint },
  finance_approved_linked:   { label: 'Verified',        color: colors.green, bg: colors.greenTint },
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
  // Assets & Access
  asset_request_submitted:      { label: 'Needs review',   color: colors.amber, bg: colors.amberTint },
  asset_edit_request_submitted: { label: 'Needs review',   color: colors.amber, bg: colors.amberTint },
  asset_request_approved:       { label: 'Approved',       color: colors.green, bg: colors.greenTint },
  asset_edit_request_approved:  { label: 'Approved',       color: colors.green, bg: colors.greenTint },
  asset_request_rejected:       { label: 'Rejected',       color: colors.red,   bg: colors.redTint   },
  asset_edit_request_rejected:  { label: 'Rejected',       color: colors.red,   bg: colors.redTint   },
  asset_assigned:               { label: 'Assigned',       color: colors.blue,  bg: colors.blueTint  },
  asset_transferred:            { label: 'Transferred',    color: colors.blue,  bg: colors.blueTint  },
  asset_transfer_acknowledged:  { label: 'Accepted',       color: colors.green, bg: colors.greenTint },
  asset_returned:               { label: 'Returned',       color: colors.green, bg: colors.greenTint },
  asset_lost:                   { label: 'Lost',           color: colors.red,   bg: colors.redTint   },
  asset_recovered:              { label: 'Recovered',      color: colors.green, bg: colors.greenTint },
  asset_repair_sent:            { label: 'Sent for repair', color: colors.amber, bg: colors.amberTint },
  asset_repair_returned:        { label: 'Back from repair', color: colors.green, bg: colors.greenTint },
  asset_warranty_expiring:      { label: 'Warranty expiring', color: colors.amber, bg: colors.amberTint },
  asset_edited:                 { label: 'Updated',        color: colors.blue,  bg: colors.blueTint  },
  asset_warranty_updated:       { label: 'Warranty',       color: colors.blue,  bg: colors.blueTint  },
  asset_service_added:          { label: 'Service logged', color: colors.blue,  bg: colors.blueTint  },
  asset_document_uploaded:      { label: 'Document',       color: colors.blue,  bg: colors.blueTint  },
  asset_retired:                { label: 'Retired',        color: colors.amber, bg: colors.amberTint },
  asset_disposed:               { label: 'Disposed',       color: colors.red,   bg: colors.redTint   },
  asset_restored:               { label: 'Restored',       color: colors.green, bg: colors.greenTint },
  access_granted:               { label: 'Access granted', color: colors.green, bg: colors.greenTint },
  access_updated:               { label: 'Access updated', color: colors.blue,  bg: colors.blueTint  },
  access_revoked:               { label: 'Access revoked', color: colors.red,   bg: colors.redTint   },
  access_restored:              { label: 'Access restored', color: colors.green, bg: colors.greenTint },
  // Employee-raised issues. Amber like every other "needs review" event, and
  // labelled as the thing it is — these used to fall through to the neutral
  // "Activity" badge, which read as a log entry rather than as a person
  // disputing their own attendance or pay.
  attendance_issue_raised:      { label: 'Issue raised',   color: colors.amber, bg: colors.amberTint },
  payroll_issue_raised:         { label: 'Issue raised',   color: colors.amber, bg: colors.amberTint },
  // The admin's decision, sent back to the employee who raised it. Blue rather
  // than green or red because one type carries both outcomes — which one it was
  // is stated in the title, and a green chip over the word "rejected" would be
  // worse than a neutral one.
  attendance_issue_reviewed:    { label: 'Issue reviewed', color: colors.blue,  bg: colors.blueTint  },
  payroll_issue_reviewed:       { label: 'Issue reviewed', color: colors.blue,  bg: colors.blueTint  },
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

  // ── Employee-raised attendance and payroll issues ──────────────────────────
  // Each lands where an admin would actually deal with it, not on a list of
  // complaints.
  //
  // ATTENDANCE goes to the correction log, beside the tool that fixes the day
  // and beside the queue the issue is already listed in. That is the review
  // location, so it stays a plain link.
  //
  // PAYROLL cannot be a plain link. The screen an admin needs is the disputed
  // payslip — /payroll/results/[periodId]/[employeeId], where the figures, the
  // employee's stated reason and Resolve/Reject are one page — and that needs
  // two ids, while `entity_id` is a single uuid column holding the OBJECTION.
  // `/payroll` alone was the wrong answer: it is the list of periods, and an
  // admin landing there still has to find the month, then the employee, then
  // the issue.
  //
  // So the objection id is carried as a deep-link parameter and /payroll
  // resolves it — reading the period and employee back through the objection's
  // own foreign key, server-side, in /api/objections. Same shape as Finance's
  // `/finance/received?payment=` resolver. Deliberately NOT a second id in the
  // URL: a route built from ids a caller supplies is a route a caller can point
  // at somebody else's payslip.
  if (type === 'attendance_issue_raised' || type === 'payroll_issue_raised') {
    const isAttendance = type === 'attendance_issue_raised'
    const href = isAttendance
      ? '/attendance/correction-log'
      : (n.entity_id ? `/payroll?${ISSUE_PARAM}=${n.entity_id}` : '/payroll')
    return {
      category: 'other',
      heading: isAttendance ? 'Attendance' : 'Payroll',
      headingIsActor: false,
      badge: TYPE_BADGES[type] ?? NEUTRAL_BADGE,
      href,
      actionLabel: 'Review issue',
    }
  }

  // ── The decision, sent back to the employee who raised it ──────────────────
  // The mirror of the branch above, and the same reasoning about ids: one
  // destination for both subjects, because from the employee's side there is
  // one place their reports live — /my-issues. The objection id travels in
  // `entity_id` and is resolved there against a list /api/objections has
  // already pinned to the caller's own rows, so an id that is not theirs
  // selects nothing and the link cannot become a way to read a colleague's
  // dispute.
  //
  // Order is not load-bearing: both branches test exact type equality, and
  // neither `attendance_issue_reviewed` nor `payroll_issue_reviewed` matches
  // any of the `startsWith` prefixes below (finance / order / access_ / asset)
  // or any Task title pattern. It sits here because it belongs beside the
  // branch it mirrors.
  if (type === 'attendance_issue_reviewed' || type === 'payroll_issue_reviewed') {
    const isAttendance = type === 'attendance_issue_reviewed'
    return {
      category: 'other',
      heading: isAttendance ? 'Attendance' : 'Payroll',
      headingIsActor: false,
      badge: TYPE_BADGES[type] ?? NEUTRAL_BADGE,
      href: n.entity_id ? `/my-issues?${ISSUE_PARAM}=${n.entity_id}` : '/my-issues',
      actionLabel: 'View issue',
    }
  }

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
  // deep-links to that request's own detail page (/orders/requests/[id]) —
  // except order_converted, whose subject is the Confirmed Order that was just
  // created. That one carries the ORDER id instead (set at the call site in the
  // Convert modal) and points at the Order's own detail page, because a
  // converted request is removed from the Order Requests list.
  //
  // `from=all` is the list tab the reader returns to via the detail page's Back
  // control — the "All" scope, the same one this link used to select when it
  // opened the list with a modal on top.
  if (type.startsWith('order')) {
    const badge = TYPE_BADGES[type] ?? NEUTRAL_BADGE
    const href = n.entity_id
      ? (type === 'order_converted'
          ? `/orders/${n.entity_id}`
          : `/orders/requests/${n.entity_id}?from=all`)
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

  // ── Access Register ────────────────────────────────────────────────────────
  // Access records have no detail route, so entity_id is stored for traceability
  // and the link goes to the register itself. Building `/assets-access/<id>`
  // from an access id would open the ASSET detail page on an id no asset has —
  // a link that resolves to "this asset does not exist". Note `access_*` does
  // not match the `asset` prefix tested below, so this branch is reached.
  if (type.startsWith('access_')) {
    return {
      category: 'asset',
      heading: 'Access',
      headingIsActor: false,
      badge: TYPE_BADGES[type] ?? NEUTRAL_BADGE,
      href: '/assets-access?view=access-register',
      actionLabel: 'View access',
    }
  }

  // ── Assets & Access ────────────────────────────────────────────────────────
  // entity_id carries the ASSET id, and every asset has its own permanent
  // detail page — so a custody, service or warranty notification opens the
  // record it is about.
  //
  // Change-request events are the deliberate exception: an APPROVED removal
  // deletes the asset, so a link to /assets-access/<id> would open a page that
  // no longer exists. Those point at the Asset Requests screen instead, where
  // the decision itself is still readable.
  if (type.startsWith('asset')) {
    const badge = TYPE_BADGES[type] ?? NEUTRAL_BADGE
    const isRequestEvent = type.includes('request')
    const href = isRequestEvent
      ? '/assets-access?view=asset-requests'
      : n.entity_id
        ? `/assets-access/${n.entity_id}`
        : '/assets-access?view=asset-inventory'
    return {
      category: 'asset',
      heading: 'Assets',
      headingIsActor: false,
      badge,
      href,
      actionLabel: isRequestEvent ? 'View request' : 'View asset',
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
