'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { AttendanceLayout } from '@/components/layout/AttendanceLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import Link from 'next/link'

const MODULE_CARDS = [
  { title: 'Employee Master',    description: 'View and manage employee records.',         dotColor: colors.blue   },
  { title: 'Leave Requests',     description: 'Submit and track leave applications.',       dotColor: colors.green  },
  { title: 'Late Arrival',       description: 'Log and review late arrival records.',       dotColor: '#F59E0B'     },
  { title: 'Early Departure',    description: 'Log and review early departure records.',    dotColor: '#F97316'     },
  { title: 'Attendance Upload',  description: 'Upload bulk attendance data.',               dotColor: '#8B5CF6'     },
  { title: 'Salary Calculation', description: 'Calculate monthly salary for employees.',   dotColor: '#EC4899'     },
  { title: 'My Salary',          description: 'View your personal salary details.',         dotColor: colors.blue   },
  { title: 'Salary Concerns',    description: 'Raise and track payroll concerns.',          dotColor: '#EF4444'     },
]

export default function AttendancePage() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      const { data } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, is_active, created_at')
        .eq('id', session.user.id)
        .single()
      setProfile(data as UserProfile)
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

  return (
    <AttendanceLayout
      profile={profile}
      title="Attendance & Salary"
      subtitle="Manage attendance and payroll"
      onSignOut={handleSignOut}
    >
      <div style={{ maxWidth: 720, padding: '24px 0' }}>
        <Link href="/" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: colors.tertiary, textDecoration: 'none', marginBottom: '24px' }}
          onMouseEnter={e => (e.currentTarget.style.color = colors.primary)}
          onMouseLeave={e => (e.currentTarget.style.color = colors.tertiary)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" /></svg>
          Back to Home
        </Link>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {MODULE_CARDS.map(card => (
            <div
              key={card.title}
              style={{
                background: colors.base,
                border: `1px solid ${colors.border}`,
                borderRadius: 10,
                padding: '20px',
                cursor: 'default',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <span style={{
                  width: 10, height: 10, borderRadius: '50%',
                  background: card.dotColor, flexShrink: 0,
                }} />
                <span style={{ fontSize: 15, fontWeight: 600, color: colors.primary }}>
                  {card.title}
                </span>
              </div>
              <p style={{ margin: 0, fontSize: 13, color: colors.tertiary, lineHeight: 1.5 }}>
                {card.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </AttendanceLayout>
  )
}
