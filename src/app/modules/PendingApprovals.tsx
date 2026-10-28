'use client'

// ── Pending approvals on the Modules launcher ────────────────────────────────
//
// The attendance requests waiting for a decision, decided from the first
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
// With nothing waiting the section is not drawn at all. The list is short on
// purpose: the oldest five, then a link to the full queue.

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { REQUEST_TYPE_LABEL, requestSummary } from '@/lib/attendance/requests'
import {
  RequestReviewDrawer,
  type Punch,
  type QueueRow,
  type Shift,
} from '@/components/attendanceRequests/RequestReviewDrawer'
import { actionableRequests, initialsOf, PENDING_APPROVALS_SHOWN } from '@/lib/attendance/pendingApprovals'
import styles from './modules.module.css'

type QueueResponse = {
  requests: QueueRow[]
  punches: Record<string, Punch>
  shift: Shift | null
  viewer_id: string | null
}

/** Shared with nothing else on purpose: the queue page keeps its own state. */
export const pendingApprovalsKey = (userId: string) => ['attendance-requests', 'home-pending', userId] as const

export function PendingApprovals({ userId, inPanel = false }: { userId: string; inPanel?: boolean }) {
  // In the right-hand attention panel the block is a group of that panel (its
  // own heading and spacing); on its own it is a launcher section, as before.
  const sectionClass = inPanel ? styles.attentionGroup : styles.section
  const titleClass = inPanel ? styles.attentionTitle : styles.sectionTitle
  const supabase = useMemo(() => createClient(), [])
  const queryClient = useQueryClient()
  const [reviewing, setReviewing] = useState<QueueRow | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const getToken = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ?? null
  }, [supabase])

  const { data, isError, refetch } = useQuery<QueueResponse>({
    queryKey: pendingApprovalsKey(userId),
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

  const rows = data ? actionableRequests(data.requests ?? [], data.viewer_id) : []

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
      <section className={sectionClass} aria-labelledby="pending-approvals-heading">
        <h2 id="pending-approvals-heading" className={titleClass}>{inPanel ? 'Attendance approvals' : 'Pending approvals'}</h2>
        <div className={styles.approvalsError} role="alert">
          <span>Could not load attendance requests.</span>
          <button type="button" className={styles.approvalsRetry} onClick={() => void refetch()}>Try again</button>
        </div>
      </section>
    )
  }

  // Nothing waiting (or not loaded yet): no section and no notice. A notice
  // after the last decision is still shown, so the decision is acknowledged.
  if (rows.length === 0) {
    return notice ? <p className={styles.approvalsNotice} role="status">{notice}</p> : null
  }

  const shown = rows.slice(0, PENDING_APPROVALS_SHOWN)

  return (
    <section className={sectionClass} aria-labelledby="pending-approvals-heading">
      <h2 id="pending-approvals-heading" className={titleClass}>
        {inPanel ? 'Attendance approvals' : 'Pending approvals'} <span className={styles.approvalsCount}>{rows.length}</span>
      </h2>
      {notice && <p className={styles.approvalsNotice} role="status">{notice}</p>}
      <div className={styles.approvalsList}>
        {shown.map(r => (
          <button
            key={r.id}
            type="button"
            className={styles.approvalRow}
            onClick={() => { setNotice(null); setReviewing(r) }}
            aria-label={`Review ${REQUEST_TYPE_LABEL[r.request_type].toLowerCase()} request from ${r.employee?.full_name ?? 'employee'}`}
          >
            <span className={styles.approvalAvatar} aria-hidden="true">{initialsOf(r.employee?.full_name)}</span>
            <span className={styles.approvalText}>
              <span className={styles.approvalName}>{r.employee?.full_name ?? 'Employee'}</span>
              <span className={styles.approvalDetail}>
                {REQUEST_TYPE_LABEL[r.request_type]} · {requestSummary(r)}
              </span>
            </span>
            <ChevronRight className={styles.approvalChevron} aria-hidden="true" focusable="false" />
          </button>
        ))}
        {rows.length > shown.length && (
          <Link href="/attendance/requests" className={styles.approvalsMore}>
            See all {rows.length} requests
          </Link>
        )}
      </div>

      {reviewing && (
        <RequestReviewDrawer
          row={reviewing}
          punch={data?.punches?.[`${reviewing.employee_id}|${reviewing.start_date}`]}
          shift={data?.shift ?? null}
          own={false}
          getToken={getToken}
          onClose={() => setReviewing(null)}
          onDecide={decide}
        />
      )}
    </section>
  )
}
