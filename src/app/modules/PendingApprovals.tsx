'use client'

// ── Leave and late-arrival requests in the launcher's For you panel ─────────
//
// The leave and late-arrival requests waiting for a decision, decided from the first
// screen without opening Attendance & Payroll first. A SHORTCUT AND NOTHING
// ELSE: it reads the same queue (`/api/attendance-requests?scope=queue`) and
// opens the same review panel (RequestReviewDrawer) as /attendance/requests,
// and every rule lives where it already did —
//
//   • only an admin may read the queue or decide; the route refuses anybody
//     else, and the page only mounts this for an admin;
//   • nobody decides their own request: the route refuses, and the admin's own
//     requests are left out of this list (they wait for another admin);
//   • rejecting needs a reason; the panel asks for it.
//
// With nothing waiting nothing is drawn. The list is short on purpose: the
// oldest five, then a link to the full queue.

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { REQUEST_TYPE_LABEL, requestSummary } from '@/lib/attendance/requests'
import {
  RequestReviewDrawer,
  type Punch,
  type QueueRow,
  type Shift,
} from '@/components/attendanceRequests/RequestReviewDrawer'
import { actionableRequests, launcherRequests, PENDING_APPROVALS_SHOWN } from '@/lib/attendance/pendingApprovals'
import { itemKeys } from '@/lib/modules/forYouSnooze'
import { timeAgo } from '@/lib/ui'
import styles from './attentionPanel.module.css'

type QueueResponse = {
  requests: QueueRow[]
  punches: Record<string, Punch>
  shift: Shift | null
  viewer_id: string | null
}

/** Shared with nothing else on purpose: the queue page keeps its own state. */
export const pendingApprovalsKey = (userId: string) => ['attendance-requests', 'home-pending', userId] as const

function useAccessToken() {
  const supabase = useMemo(() => createClient(), [])
  return useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ?? null
  }, [supabase])
}

/**
 * The queue, read once. The panel calls it for the count in its header and
 * PendingApprovals for the rows; both use the same key, so it is one request.
 * `enabled` is false for anybody who is not the signed-in admin.
 */
export function usePendingApprovalQueue(userId: string | null, enabled: boolean) {
  const getToken = useAccessToken()
  const query = useQuery<QueueResponse>({
    queryKey: pendingApprovalsKey(userId ?? ''),
    enabled: enabled && !!userId,
    queryFn: async () => {
      const token = await getToken()
      const res = await fetch('/api/attendance-requests?scope=queue&status=pending', {
        headers: { authorization: `Bearer ${token ?? ''}` },
      })
      if (!res.ok) throw new Error(`queue ${res.status}`)
      return res.json()
    },
    staleTime: 30_000,
  })
  // Leave and late arrival only (LAUNCHER_REQUEST_TYPES); the other types still
  // wait in Attendance → Requests.
  const rows = query.data
    ? launcherRequests(actionableRequests(query.data.requests ?? [], query.data.viewer_id))
    : []
  return { ...query, rows, getToken }
}

/**
 * The requests, as cards of the For you panel. `shown` is the panel's Clear all
 * filter: a request hidden for 24 hours is left out here too.
 */
export function PendingApprovals({ userId, shown: isShown }: { userId: string; shown: (key: string) => boolean }) {
  const queryClient = useQueryClient()
  const [reviewing, setReviewing] = useState<QueueRow | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const queue = usePendingApprovalQueue(userId, true)
  const { data, isError, refetch, getToken } = queue
  const rows = queue.rows.filter(r => isShown(itemKeys.request(r.id)))

  const decide = async (status: 'approved' | 'rejected', note: string): Promise<string | null> => {
    if (!reviewing) return null
    const target = reviewing
    const token = await getToken()
    const res = await fetch(`/api/attendance-requests/${target.id}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token ?? ''}` },
      body: JSON.stringify({ status, note }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return json.error ?? 'Could not save the decision.'
    setReviewing(null)
    setNotice(`${target.employee?.full_name ?? 'Employee'}’s ${REQUEST_TYPE_LABEL[target.request_type].toLowerCase()} request was ${status}.`)
    await queryClient.invalidateQueries({ queryKey: pendingApprovalsKey(userId) })
    return null
  }

  // A failed read is said, quietly, with a retry — a silent gap could hide a
  // request somebody is waiting on.
  if (isError) {
    return (
      <li className={styles.card} role="alert">
        <span className={styles.cardLabel}>
          <CalendarClock size={13} strokeWidth={2} aria-hidden="true" />
          Leave and late arrival
        </span>
        <span className={styles.cardError}>Could not be loaded.</span>
        <button type="button" className={styles.button} onClick={() => void refetch()}>Try again</button>
      </li>
    )
  }

  // Nothing waiting (or not loaded yet): no cards. A notice after the last
  // decision is still shown, so the decision is acknowledged.
  if (rows.length === 0) {
    return notice ? <li className={styles.approvalsNotice} role="status">{notice}</li> : null
  }

  const shown = rows.slice(0, PENDING_APPROVALS_SHOWN)

  return (
    <>
      {notice && <li className={styles.approvalsNotice} role="status">{notice}</li>}
      {shown.map(r => {
        const name = r.employee?.full_name ?? 'Employee'
        const type = REQUEST_TYPE_LABEL[r.request_type]
        return (
          <li key={r.id} className={styles.card}>
            <span className={styles.cardLabel}>
              <CalendarClock size={13} strokeWidth={2} aria-hidden="true" />
              {type}{r.submitted_at ? ` · ${timeAgo(r.submitted_at)}` : ''}
            </span>
            <span className={styles.cardBrief}>{name}</span>
            <span className={styles.cardDetail}>{requestSummary(r)}</span>
            <button
              type="button"
              className={styles.button}
              onClick={() => { setNotice(null); setReviewing(r) }}
              aria-label={`Review ${type.toLowerCase()} request from ${name}`}
            >
              Review
            </button>
          </li>
        )
      })}
      {rows.length > shown.length && (
        <li>
          <Link href="/attendance/requests" className={styles.moreLink}>
            {rows.length - shown.length} more requests →
          </Link>
        </li>
      )}

      {/* In its own list item so the list stays valid markup; the drawer
          itself is an overlay. */}
      {reviewing && (
        <li className={styles.drawerHost}>
          <RequestReviewDrawer
            row={reviewing}
            punch={data?.punches?.[`${reviewing.employee_id}|${reviewing.start_date}`]}
            shift={data?.shift ?? null}
            own={false}
            getToken={getToken}
            onClose={() => setReviewing(null)}
            onDecide={decide}
          />
        </li>
      )}
    </>
  )
}
