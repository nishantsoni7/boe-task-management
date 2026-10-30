'use client'

// Overview: where an admin starts. It shows who is doing well and who needs
// attention this month, and keeps a link to every page of the module. The month is
// in the address (?year=&month=); with none, the route picks the newest month with
// enough complete days to rank. Admins only: AttendanceGuard sends everyone else to
// /my-attendance, and the route checks requireAdmin itself.

import { Suspense, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { useRefresh } from '@/contexts/RefreshContext'
import { LoadingScreen } from '@/components/ui/atoms'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { MONTH_NAMES, MonthPicker, Notice, StateBlock, istCurrentYearMonth, ui } from '@/components/attendancePayroll/ui'
import type { OverviewData } from '@/lib/attendance/attendanceScore'
import {
  isFutureMonth, isMachineMonth, machineMonthEmptyMessage, monthNotImportedMessage, selectableYears,
} from '@/lib/attendance/monthAvailability'
import type { MachineDayView } from '@/lib/minop/machineDayView'
import { OverviewBoard, PageLinks } from './OverviewBoard'

/** The month in the address, or null when it is absent or not one we allow. */
function monthFromParams(params: URLSearchParams): { year: number; month: number } | null {
  const year = Number(params.get('year'))
  const month = Number(params.get('month'))
  const allowed = selectableYears().includes(year) && Number.isInteger(month) && month >= 1 && month <= 12
  return allowed && !isFutureMonth(year, month) ? { year, month } : null
}

async function fetchOverview(token: string, query: string): Promise<{ data: OverviewData } | { error: string }> {
  try {
    const res = await fetch(`/api/attendance/overview${query}`, { headers: { Authorization: `Bearer ${token}` } })
    const json = await res.json().catch(() => ({}))
    if (res.ok) return { data: json as OverviewData }
    return { error: json.error ?? 'Could not load this month.' }
  } catch {
    return { error: 'Could not reach the server. Check your connection and try again.' }
  }
}

/** Today's line is extra: when it cannot be read the rest of the page still stands. */
async function fetchToday(token: string): Promise<MachineDayView | null> {
  try {
    const res = await fetch('/api/attendance/machine-day', { headers: { Authorization: `Bearer ${token}` } })
    return res.ok ? (await res.json() as MachineDayView) : null
  } catch {
    return null
  }
}

function coverageLine(data: OverviewData): string {
  const name = `${MONTH_NAMES[data.month - 1]} ${data.year}`
  if (!data.coverageThrough) return `${name}. No attendance yet.`
  const days = `${data.workingDaysCounted} working ${data.workingDaysCounted === 1 ? 'day' : 'days'} counted`
  const lastOfMonth = new Date(Date.UTC(data.year, data.month, 0)).toISOString().slice(0, 10)
  if (data.coverageThrough >= lastOfMonth) return `${name}. ${days}.`
  const through = new Date(`${data.coverageThrough}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  })
  return `${name}. Complete through ${through}, ${days}.`
}

// useSearchParams needs a Suspense boundary; same shape as Monthly Review.
export default function AttendancePage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <OverviewScreen />
    </Suspense>
  )
}

function OverviewScreen() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [token, setToken] = useState('')
  const [data, setData] = useState<OverviewData | null>(null)
  const [today, setToday] = useState<MachineDayView | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  const router = useRouter()
  const params = useSearchParams()
  const supabase = useMemo(() => createClient(), [])
  const { refreshKey } = useRefresh()

  const asked = monthFromParams(params)
  const query = asked ? `?year=${asked.year}&month=${asked.month}` : ''

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      const { data: me } = await supabase.from('users').select(USER_PROFILE_COLUMNS).eq('id', session.user.id).single()
      if (!me) { router.push('/login'); return }
      setProfile(me as UserProfile)
      setToken(session.access_token)
    }
    void init()
  }, [supabase, router])

  useEffect(() => {
    if (!token) return
    // Only the newest request may fill the page: months can be picked quickly.
    let superseded = false
    void fetchOverview(token, query).then(result => {
      if (superseded) return
      if ('data' in result) {
        setData(result.data)
        setError('')
      } else {
        setError(result.error)
      }
    })
    void fetchToday(token).then(view => {
      if (!superseded) setToday(view)
    })
    return () => { superseded = true }
  }, [token, query, refreshKey, attempt])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (!profile) return <LoadingScreen />

  const shown = asked ?? data ?? istCurrentYearMonth()

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="Overview"
      subtitle={data ? coverageLine(data) : 'Who is doing well this month, and who needs attention.'}
      onSignOut={handleSignOut}
      actions={
        <MonthPicker
          year={shown.year}
          month={shown.month}
          idPrefix="overview-month"
          onChange={(year, month) => router.replace(`/attendance?year=${year}&month=${month}`, { scroll: false })}
        />
      }
    >
      <div className={ui.stack}>
        {error && (
          <StateBlock
            kind="error"
            title="Could not load this month"
            action={<button type="button" className={`boe-btn boe-btn-ghost ${ui.btnSm}`} onClick={() => setAttempt(a => a + 1)}>Try again</button>}
          >
            {error}
          </StateBlock>
        )}

        {!data && !error && <StateBlock kind="loading">Loading the month…</StateBlock>}

        {data?.fellBackFrom && (
          <Notice kind="info">
            {MONTH_NAMES[data.fellBackFrom.month - 1]} has too few complete days to rank yet, so this shows{' '}
            {MONTH_NAMES[data.month - 1]}.
          </Notice>
        )}

        {data && !error && (
          data.coverageThrough && data.people.length > 0
            ? <OverviewBoard data={data} today={today} />
            : (
              <>
                <StateBlock kind="empty" title={`No attendance for ${MONTH_NAMES[data.month - 1]} yet`}>
                  {isMachineMonth(data.year, data.month)
                    ? machineMonthEmptyMessage(`${MONTH_NAMES[data.month - 1]} ${data.year}`)
                    : monthNotImportedMessage(`${MONTH_NAMES[data.month - 1]} ${data.year}`)}
                </StateBlock>
                <PageLinks />
              </>
            )
        )}

        {error && <PageLinks />}
      </div>
    </AttendancePayrollLayout>
  )
}
