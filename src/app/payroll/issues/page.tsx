'use client'

// Payroll Issues — "what did employees report about this payroll month?"
//
// A dedicated primary destination rather than a panel buried inside a
// results page, because answering that question used to require knowing
// which payroll period held the month you cared about. The scope is exactly
// what ObjectionQueue already enforces server-side: employee_record_objections
// → payroll_result → payroll_period, resolved by year/month through
// GET /api/objections?payroll_year=&payroll_month= (see src/lib/objections.ts,
// payrollPeriodScopeQuery) — never the current calendar month, never inferred
// from subject text.

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { ObjectionQueue } from '@/components/objections/ObjectionQueue'
import { periodLabel } from '@/lib/payroll/months'

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
]

function currentYearMonth() {
  const now = new Date()
  return { year: now.getFullYear(), month: now.getMonth() + 1 }
}

export default function PayrollIssuesPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [token,   setToken]   = useState('')

  const def = currentYearMonth()
  const [year,  setYear]  = useState(def.year)
  const [month, setMonth] = useState(def.month)
  // The month the panel below is actually scoped to — separate from the
  // selectors so changing them does not silently re-scope a panel that is
  // mid-review, the same rule View Payroll and the results page already
  // follow for this exact list.
  const [shown, setShown] = useState(def)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      setToken(session.access_token)

      const { data: prof } = await supabase
        .from('users')
        .select(USER_PROFILE_COLUMNS)
        .eq('id', session.user.id)
        .single()

      if (!prof) { router.push('/coming-soon'); return }
      setProfile(prof as UserProfile)
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  const yearOptions: number[] = []
  for (let y = def.year; y >= def.year - 2; y--) yearOptions.push(y)

  const inputStyle: React.CSSProperties = {
    fontSize: 13, border: `1px solid ${colors.border}`, borderRadius: 7,
    background: colors.base, color: colors.primary, outline: 'none',
    padding: '8px 12px', boxSizing: 'border-box',
  }

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="Payroll Issues"
      subtitle="What employees reported about a payroll month"
      onSignOut={handleSignOut}
    >
      <div style={{ maxWidth: 900, padding: '24px 0' }}>

        {/* Month selector */}
        <div style={{
          background: colors.base, border: `1px solid ${colors.border}`,
          borderRadius: 10, padding: '16px 20px', marginBottom: 20,
          display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap',
        }}>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Month</label>
            <select value={month} onChange={e => setMonth(parseInt(e.target.value))} style={{ ...inputStyle, width: 160 }}>
              {MONTH_NAMES.map((name, i) => (
                <option key={i + 1} value={i + 1}>{name}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Year</label>
            <select value={year} onChange={e => setYear(parseInt(e.target.value))} style={{ ...inputStyle, width: 110 }}>
              {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <button
            onClick={() => setShown({ year, month })}
            style={{
              padding: '9px 22px', fontSize: 13, fontWeight: 600, borderRadius: 7,
              border: 'none', cursor: 'pointer', background: '#1A2035', color: '#E8A030',
            }}
          >
            View
          </button>
        </div>

        <ObjectionQueue
          subject="payroll"
          token={token}
          period={{ year: shown.year, month: shown.month }}
          title={`Reported payroll issues — ${periodLabel(shown.month, shown.year)}`}
          emptyLabel="No payroll issues were reported for this period."
        />

      </div>
    </AttendancePayrollLayout>
  )
}
