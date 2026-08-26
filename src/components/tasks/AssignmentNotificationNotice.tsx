'use client'

// OUTCOME B, SHOWN THE SAME WAY ON ALL FOUR CREATION SCREENS.
//
// Creating a task and notifying its assignee are two writes, and the second can
// fail on its own. That leaves three outcomes, and the screens must tell them
// apart:
//
//   A  the task was not created            — the existing error path, unchanged
//   B  created, but nobody was notified    — THIS component
//   C  both succeeded                      — the existing success path
//
// WHY B MUST NOT BORROW A's WORDING. "Task creation failed" in case B is worse
// than silence: the task exists, so a user who believes otherwise fills the
// form in again and now there are two tasks. The sentence therefore leads with
// what did work, and the screens keep their success state visible alongside it.
//
// WHAT IT REMEMBERS. One task id, held in React state for as long as the notice
// is on screen. Not the recipient, not the task title, not the notification
// body, nothing persisted. The retry sends the id and nothing else — the server
// derives every field again from the stored task, so a retry cannot be steered
// into notifying somebody else even if this state were tampered with.
//
// RETRY IS THE NOTIFICATION ONLY. It POSTs to /api/tasks/:id/notify-assignment.
// It never re-submits the form and never touches `tasks`, so pressing it twice
// cannot produce a second task. The route treats an assignment notification
// that already exists as success, so a retry after a response that was lost in
// transit resolves rather than duplicating.

import { useState } from 'react'
import { colors } from '@/lib/tokens'
import {
  requestAssignmentNotification,
  ASSIGNMENT_NOTIFICATION_FAILED_MESSAGE,
  ASSIGNMENT_NOTIFICATION_RECOVERED_MESSAGE,
} from '@/lib/tasks/assignmentNotification'

export type AssignmentNotificationNoticeProps = {
  /** The task that WAS created. The only thing retry needs. */
  taskId: string
  /** Called once a retry succeeds, so the screen can show outcome C instead. */
  onResolved: () => void
  /** Called when the reader dismisses the warning without retrying. */
  onDismiss: () => void
  /** `banner` for a page, `inline` inside a modal. Wording is identical. */
  variant?: 'banner' | 'inline'
}

export function AssignmentNotificationNotice({
  taskId, onResolved, onDismiss, variant = 'banner',
}: AssignmentNotificationNoticeProps) {
  const [retrying, setRetrying] = useState(false)
  const [retryFailed, setRetryFailed] = useState(false)

  const retry = async () => {
    if (retrying) return
    setRetrying(true)
    setRetryFailed(false)
    const result = await requestAssignmentNotification(taskId)
    setRetrying(false)
    // `created`, and equally `skipped_duplicate` — a row that already exists is
    // the outcome we wanted, not a failure.
    if (result.ok) { onResolved(); return }
    // Still failing: the warning STAYS. Clearing it would tell the creator the
    // assignee had been reached when they had not.
    setRetryFailed(true)
  }

  return (
    <div
      role="status"
      data-testid="assignment-notification-notice"
      style={{
        marginBottom: variant === 'inline' ? '10px' : '16px',
        padding: '11px 16px',
        borderRadius: '8px',
        background: colors.amberTint,
        border: '1px solid rgba(232,160,48,0.3)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: '12px', flexWrap: 'wrap',
      }}
    >
      <p style={{ fontSize: '13px', fontWeight: 500, color: colors.amber, margin: 0 }}>
        {ASSIGNMENT_NOTIFICATION_FAILED_MESSAGE}
        {retryFailed && ' Still not sent — please tell them directly.'}
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
        <button
          type="button"
          onClick={retry}
          disabled={retrying}
          style={{
            background: 'none', border: `1px solid rgba(232,160,48,0.5)`,
            borderRadius: '6px', cursor: retrying ? 'default' : 'pointer',
            // 44px is the repository's touch target; the label sits inside it.
            minHeight: '44px', padding: '0 12px',
            fontSize: '12px', fontWeight: 600, color: colors.amber,
            opacity: retrying ? 0.6 : 1,
          }}
        >
          {retrying ? 'Retrying…' : 'Retry notification'}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss notification warning"
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: colors.muted, fontSize: '16px', lineHeight: 1,
            minHeight: '44px', padding: '0 6px',
          }}
        >
          ×
        </button>
      </div>
    </div>
  )
}

/** Shown briefly in place of the warning after a successful retry. */
export function AssignmentNotificationRecovered({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      role="status"
      data-testid="assignment-notification-recovered"
      style={{
        marginBottom: '16px', padding: '11px 16px', borderRadius: '8px',
        background: colors.greenTint, border: '1px solid rgba(69,168,112,0.25)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
      }}
    >
      <p style={{ fontSize: '13px', fontWeight: 500, color: colors.green, margin: 0 }}>
        {ASSIGNMENT_NOTIFICATION_RECOVERED_MESSAGE}
      </p>
      <button
        type="button" onClick={onDismiss} aria-label="Dismiss"
        style={{
          background: 'none', border: 'none', cursor: 'pointer', color: colors.muted,
          fontSize: '16px', lineHeight: 1, minHeight: '44px', padding: '0 6px',
        }}
      >
        ×
      </button>
    </div>
  )
}
