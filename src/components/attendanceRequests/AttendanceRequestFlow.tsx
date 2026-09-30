'use client'

// The Attendance request form together with the way it is sent: ONE component
// that every entry point opens — the Modules page quick action, the desktop
// sidebar, and My Attendance — so there is a single form, a single submit path
// and a single success screen.
//
// It posts to /api/attendance-requests with the caller's own bearer token. That
// route takes the employee from the token and from nothing else, so opening
// this form gives nobody any access to another employee's attendance,
// approvals or payroll. Any signed-in active employee may send their own.
//
// It renders through a portal: the sidebar is a fixed, stacking-context parent,
// and a dialog drawn inside it would be clipped to it.

import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { AttendanceRequestRow } from '@/lib/attendance/requests'
import { AttendanceRequestModal, type RequestPayload } from './AttendanceRequestModal'

export const MY_REQUESTS_ANCHOR = 'my-requests'
export const MY_REQUESTS_PATH = '/my-attendance'

/**
 * Sends one request. Resolves to a message a person can act on, or null when
 * saved. A network failure is a message, not an exception, so the form keeps
 * every entered value and stays open.
 */
export async function postAttendanceRequest(
  token: string | null,
  payload: RequestPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<{ error: string | null; request?: AttendanceRequestRow }> {
  if (!token) return { error: 'Your session has expired. Sign in again to send this request.' }
  try {
    const res = await fetchImpl('/api/attendance-requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return { error: json.error ?? 'Could not send your request. Try again.' }
    return { error: null, request: json.request }
  } catch {
    return { error: 'Could not reach BOE. Check your connection and try again — what you entered is still here.' }
  }
}

export function AttendanceRequestFlow({
  original, onClose, onSent, getToken,
}: {
  original?: AttendanceRequestRow | null
  onClose: () => void
  /** Called once a request is saved, so a list on the page can refresh. */
  onSent?: () => void
  /** Optional: a page that already has a token source passes it. */
  getToken?: () => Promise<string | null>
}) {
  const router = useRouter()
  const pathname = usePathname()
  const supabase = useMemo(() => createClient(), [])
  // false while server-rendering, true in the browser: the portal needs document.
  const mounted = useSyncExternalStore(() => () => {}, () => true, () => false)

  const token = useCallback(async () => {
    if (getToken) return getToken()
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ?? null
  }, [getToken, supabase])

  const submit = useCallback(async (payload: RequestPayload) => {
    const { error } = await postAttendanceRequest(await token(), payload)
    if (!error) onSent?.()
    return error
  }, [token, onSent])

  const viewRequests = () => {
    onClose()
    if (pathname === MY_REQUESTS_PATH) {
      document.getElementById(MY_REQUESTS_ANCHOR)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    } else {
      router.push(`${MY_REQUESTS_PATH}#${MY_REQUESTS_ANCHOR}`)
    }
  }

  if (!mounted) return null
  return createPortal(
    <AttendanceRequestModal original={original} onClose={onClose} onSubmit={submit} onViewRequests={viewRequests} />,
    document.body,
  )
}
