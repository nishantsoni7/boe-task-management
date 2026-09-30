'use client'

// Overview: where an admin starts. It holds no numbers of its own; it groups the
// module's pages by the job they do, in the order the month's work happens.

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { useRefresh } from '@/contexts/RefreshContext'
import { LoadingScreen } from '@/components/ui/atoms'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { ui } from '@/components/attendancePayroll/ui'
import styles from './overview.module.css'

// Importing the machine export WRITES raw attendance, so /api/attendance/import
// and /api/attendance/preview both admit `admin` and nothing else
// (ALLOWED_ROLES in each route). A member Control Center granted the module to
// can read every screen here, but module access is read access — it must not be
// shown a card whose first request is a 403. This list mirrors the routes
// exactly; widen both together or neither.
const IMPORT_ROLES = ['admin']

type Shortcut = { title: string; description: string; href: string; adminOnly?: boolean; importOnly?: boolean }
type Group = { title: string; subtitle: string; items: Shortcut[]; wide?: boolean }

const GROUPS: Group[] = [
  {
    title: 'Each month',
    subtitle: 'Bring the month in, check it, then move on to pay.',
    items: [
      {
        title: 'Upload Monthly Attendance',
        description: 'Import monthly attendance data from the fingerprint machine Excel export.',
        href: '/attendance/upload',
        importOnly: true,
      },
      {
        title: 'View Imported Records',
        description: 'Browse and verify attendance records imported from Excel.',
        href: '/attendance/records',
      },
      {
        title: 'Monthly Attendance Review',
        description: 'Per-employee summary: present, half-day, absent, late, and missing punch counts.',
        href: '/attendance/monthly-review',
      },
      {
        title: 'Attendance Requests',
        description: 'Approve or reject employees’ requests about their attendance.',
        href: '/attendance/requests',
        adminOnly: true,
      },
      {
        title: 'Payroll',
        description: 'Preview the month’s pay, generate payroll runs and read each payslip.',
        href: '/payroll',
        adminOnly: true,
      },
    ],
  },
  {
    title: 'Keep an eye on',
    subtitle: 'Checks and history behind the numbers.',
    items: [
      {
        title: 'Attendance Sync',
        description: 'Punches the fingerprint machine sent, and any that need an admin’s attention.',
        href: '/attendance/minop',
        adminOnly: true,
      },
      {
        title: 'Correction Log',
        description: 'Audit trail of attendance records created or modified during import.',
        href: '/attendance/correction-log',
        adminOnly: true,
      },
    ],
  },
  {
    title: 'Set up',
    subtitle: 'People and rules the calculations rely on.',
    items: [
      {
        title: 'Employee Fingerprint Mapping',
        description: 'Map employee codes to fingerprint device IDs.',
        href: '/attendance/employees',
      },
      {
        title: 'Holiday Management',
        description: 'Add or remove public holidays excluded from working days.',
        href: '/attendance/holidays',
        adminOnly: true,
      },
      {
        title: 'Payroll Rules',
        description: 'Working hours, lateness and deduction rules used to calculate pay.',
        href: '/payroll/settings',
        adminOnly: true,
      },
    ],
  },
]

export default function AttendancePage() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { refreshKey } = useRefresh()

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const { data: me } = await supabase
        .from('users')
        .select(USER_PROFILE_COLUMNS)
        .eq('id', session.user.id)
        .single()

      setProfile(me as UserProfile)
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  const isAdmin = profile?.role === 'admin'
  const canImport = IMPORT_ROLES.includes(profile?.role ?? '')
  const visible = (s: Shortcut) => (!s.adminOnly || isAdmin) && (!s.importOnly || canImport)

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="Overview"
      subtitle="Attendance is managed through a monthly fingerprint Excel import; start here and follow the month."
      onSignOut={handleSignOut}
    >
      <p className={styles.intro}>
        Upload the export from your fingerprint device software each month to record employee attendance,
        review it, then move on to payroll.
      </p>

      <div className={styles.groups}>
        {GROUPS.map(group => {
          const items = group.items.filter(visible)
          if (items.length === 0) return null
          return (
            <section key={group.title} className={`${ui.surface} ${group.wide ? styles.wideGroup : ''}`} aria-labelledby={`ov-${group.title}`}>
              <div className={ui.surfaceHead}>
                <div>
                  <h2 className={ui.surfaceTitle} id={`ov-${group.title}`}>{group.title}</h2>
                  <p className={ui.surfaceSub}>{group.subtitle}</p>
                </div>
              </div>
              <ul className={styles.list}>
                {items.map(item => (
                  <li key={item.href}>
                    <Link href={item.href} className={styles.item}>
                      <span className={styles.itemText}>
                        <span className={styles.itemTitle}>{item.title}</span>
                        <span className={styles.itemDesc} style={{ display: 'block' }}>{item.description}</span>
                      </span>
                      <span className={styles.chevron} aria-hidden="true">›</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>
    </AttendancePayrollLayout>
  )
}
