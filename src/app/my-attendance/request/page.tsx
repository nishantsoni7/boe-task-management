'use client'

// "Attendance request" — the employee's page for telling BOE they will be late,
// leave early, step out, take a half day or take leave.
//
// Self-service, like /my-attendance beside it: the API takes the employee from
// the bearer token, so there is no employee to choose and none to tamper with.
// This page only shows the signed-in person's name so they can see who the
// request is for. Nothing here decides what is allowed — every rule is
// re-checked by POST /api/attendance-requests.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import {
  AttendanceRequestForm,
  type RequestPayload,
  type ShiftContext,
} from '@/components/attendanceRequests/AttendanceRequestForm'
import { REQUEST_STATUS_LABEL, REQUEST_TYPE_LABEL, requestSummary, type AttendanceRequestRow } from '@/lib/attendance/requests'
import { statusTone } from '@/components/attendanceRequests/format'
import styles from '@/components/attendanceRequests/attendanceRequests.module.css'

const MY_REQUESTS_HREF = '/my-attendance#my-requests'

export default function AttendanceRequestPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [shift, setShift] = useState<ShiftContext | null>(null)
  const [submitted, setSubmitted] = useState<AttendanceRequestRow | null>(null)
  // Bumped by "New request" so the form remounts empty rather than reusing the
  // values of the one just sent.
  const [formKey, setFormKey] = useState(0)
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const getToken = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ?? null
  }, [supabase])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      const { data: prof } = await supabase.from('users').select(USER_PROFILE_COLUMNS).eq('id', session.user.id).single()
      if (!prof) { router.push('/login'); return }
      setProfile(prof)

      // The company shift, for the hint beside the times. Not needed to submit:
      // if it does not load the form simply says less.
      const res = await fetch('/api/attendance-requests', { headers: { authorization: `Bearer ${session.access_token}` } })
      if (res.ok) {
        const json = await res.json().catch(() => null)
        if (json?.shift) setShift(json.shift)
      }
    }
    void init()
  }, [supabase, router])

  const submit = async (payload: RequestPayload): Promise<string | null> => {
    const token = await getToken()
    if (!token) { router.push('/login'); return 'Your session has ended. Sign in again — your entries are kept.' }
    const res = await fetch('/api/attendance-requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return json.error ?? 'Could not submit your request.'
    setSubmitted(json.request ?? null)
    return null
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (!profile) return <LoadingScreen />

  const tone = submitted ? statusTone(submitted.status) : null

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="Attendance request"
      subtitle="Tell us before your shift starts if you can."
      onSignOut={handleSignOut}
      actions={
        <Link href={MY_REQUESTS_HREF} className="boe-btn boe-btn-ghost" style={{ minHeight: 36, padding: '0 14px', fontSize: 13 }}>
          My requests
        </Link>
      }
    >
      <div className={styles.formPage}>
        {submitted ? (
          <section className={`${styles.surface} ${styles.success}`} role="status" aria-live="polite">
            <div className={styles.successTitle}>Request submitted</div>
            <p className={styles.successBody} style={{ margin: 0 }}>
              An admin will review it. You will be notified when it is decided.
            </p>
            <div className={styles.summary}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                <strong>{REQUEST_TYPE_LABEL[submitted.request_type]}</strong>
                {tone && (
                  <span className={styles.badge} style={{ background: tone.bg, color: tone.fg }}>
                    {REQUEST_STATUS_LABEL[submitted.status]}
                  </span>
                )}
              </div>
              <div>{requestSummary(submitted)}</div>
              <div style={{ fontSize: 12.5, color: '#6B7384' }}>
                {submitted.informed_before_shift ? 'Sent before your shift starts.' : 'Sent after your shift start time.'}
              </div>
            </div>
            <div className={styles.successActions}>
              <Link href={MY_REQUESTS_HREF} className={`boe-btn boe-btn-primary ${styles.linkBtn}`}>View my requests</Link>
              <button
                type="button"
                className={`boe-btn boe-btn-ghost ${styles.linkBtn}`}
                onClick={() => { setSubmitted(null); setFormKey(k => k + 1) }}
              >
                New request
              </button>
            </div>
          </section>
        ) : (
          <>
            <div className={styles.identity}>
              Requesting as <strong>{profile.full_name}</strong>
              {profile.employee_code && <span>· {profile.employee_code}</span>}
            </div>
            <div className={styles.surface}>
              <AttendanceRequestForm
                key={formKey}
                variant="page"
                shift={shift}
                onSubmit={submit}
                onSubmitted={() => { /* the success panel is driven by `submitted` */ }}
              />
            </div>
          </>
        )}
      </div>
    </AttendancePayrollLayout>
  )
}
