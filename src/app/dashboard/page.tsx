'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { LoadingScreen } from '@/components/ui/atoms'
import { BoeOsLayout } from '@/components/layout/BoeOsLayout'

// ── Module definition ─────────────────────────────────────────────────────────

type ModuleStatus = 'active' | 'foundation' | 'planned'

type ModuleDef = {
  key: string
  title: string
  description: string
  href: string
  status: ModuleStatus
  accent: string
  icon: React.ReactNode
  adminOnly?: boolean
  managerOrAdmin?: boolean
  notificationCount?: number | null  // null = no API yet → "No pending", 0 = confirmed zero, >0 = badge
}

const STATUS_LABEL: Record<ModuleStatus, { label: string; color: string; bg: string }> = {
  active:     { label: 'Active',     color: '#166534', bg: '#F0FDF4' },
  foundation: { label: 'Foundation', color: '#1E40AF', bg: '#EFF6FF' },
  planned:    { label: 'Planned',    color: '#4B5563', bg: '#F3F4F6' },
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function BoeOsHomePage() {
  const [profile,  setProfile]  = useState<UserProfile | null>(null)
  const [loading,  setLoading]  = useState(true)
  // null = count unavailable (no API), number = real count from module's own API
  const [taskNotif,   setTaskNotif]   = useState<number | null>(null)
  const [sampleNotif, setSampleNotif] = useState<number | null>(null)
  const [isMobile, setIsMobile] = useState(false)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const uid = session.user.id

      const [
        { data: profileData },
        taskNotifsRes,
        sampleNotifsRes,
      ] = await Promise.all([
        supabase
          .from('users')
          .select('id, full_name, email, phone, role, team, is_active, created_at')
          .eq('id', uid)
          .single(),
        // Task Management: same unread count the /notifications page shows
        fetch('/api/notifications?count=1')
          .then(r => r.ok ? r.json() : null)
          .catch(() => null),
        // Sample Tracking: unread sample notification count
        fetch('/api/samples/notifications?count=1')
          .then(r => r.ok ? r.json() : null)
          .catch(() => null),
      ])

      if (profileData) setProfile(profileData as UserProfile)
      // Keep null if the API failed so the card shows "No pending" rather than a wrong number
      setTaskNotif(taskNotifsRes != null ? (taskNotifsRes.unreadCount ?? 0) : null)
      setSampleNotif(sampleNotifsRes != null ? (sampleNotifsRes.unreadCount ?? 0) : null)
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

  const isAdmin   = profile?.role === 'admin'
  const isManager = profile?.role === 'manager'

  const modules: ModuleDef[] = [
    {
      key: 'tasks',
      title: 'Task Management',
      description: 'Create, assign, and track tasks across your team.',
      href: '/tasks/my',
      status: 'active',
      accent: '#1A2035',
      icon: <TaskIcon />,
      // Real count — same source the /notifications page uses
      notificationCount: taskNotif,
    },
    {
      key: 'samples',
      title: 'Sample Tracking',
      description: 'Request sample catalogs, track dispatch and returns, follow up on overdue items.',
      href: '/samples',
      status: 'active',
      accent: '#B45309',
      icon: <BoxIcon />,
      // Real count — from sample_notifications table
      notificationCount: sampleNotif,
    },
    ...(isAdmin ? [{
      key: 'attendance',
      title: 'Attendance',
      description: 'Manage employee attendance records, uploads, and leave history.',
      href: '/attendance',
      status: 'active' as ModuleStatus,
      accent: '#0F766E',
      icon: <CalIcon />,
      adminOnly: true,
      notificationCount: null,  // no module-level API yet
    }] : []),
    ...(isAdmin ? [{
      key: 'payroll',
      title: 'Payroll',
      description: 'Process payroll runs, view salary breakdowns, and download payslips.',
      href: '/payroll',
      status: 'active' as ModuleStatus,
      accent: '#166534',
      icon: <PayIcon />,
      adminOnly: true,
      notificationCount: null,  // no module-level API yet
    }] : []),
    {
      key: 'assets',
      title: 'Assets & Access',
      description: 'Track company devices, assigned hardware, and manage login access records.',
      href: '/assets-access',
      status: 'foundation',
      accent: '#4B5563',
      icon: <AssetIcon />,
      notificationCount: null,  // no module-level API yet
    },
    ...(isAdmin ? [{
      key: 'members',
      title: 'Employee Records',
      description: 'View and manage employee profiles, roles, and team assignments.',
      href: '/admin/members',
      status: 'active' as ModuleStatus,
      accent: '#1E40AF',
      icon: <MembersIcon />,
      adminOnly: true,
      notificationCount: null,  // no module-level API yet
    }] : []),
  ]

  const cols = isMobile ? 1 : isAdmin || isManager ? 3 : 2

  return (
    <BoeOsLayout
      profile={profile}
      title="BOE Operating System"
      subtitle={new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
      onSignOut={handleSignOut}
    >
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gap: '16px',
      }}>
        {modules.map(mod => (
          <ModuleCard
            key={mod.key}
            mod={mod}
            onClick={() => router.push(mod.href)}
          />
        ))}
      </div>
    </BoeOsLayout>
  )
}

// ── ModuleCard ────────────────────────────────────────────────────────────────

function ModuleCard({ mod, onClick }: { mod: ModuleDef; onClick: () => void }) {
  const [hovered, setHovered] = useState(false)
  const st = STATUS_LABEL[mod.status]
  const hasNotif = (mod.notificationCount ?? 0) > 0

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onClick()}
      style={{
        background: '#fff',
        border: `1.5px solid ${hovered ? mod.accent : '#E5E7EB'}`,
        borderRadius: '12px',
        padding: '20px',
        cursor: 'pointer',
        transition: 'border-color 0.15s, box-shadow 0.15s',
        boxShadow: hovered ? '0 4px 16px rgba(0,0,0,0.08)' : '0 1px 3px rgba(0,0,0,0.04)',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      {/* Notification badge (top-right) */}
      {hasNotif && (
        <div style={{
          position: 'absolute', top: '-8px', right: '-8px',
          background: '#D94F4F', color: '#fff',
          fontSize: '10px', fontWeight: 700,
          borderRadius: '999px',
          padding: '2px 7px', minWidth: '20px',
          textAlign: 'center', lineHeight: '16px',
          border: '2px solid #fff',
          boxShadow: '0 1px 4px rgba(0,0,0,0.15)',
        }}>
          {(mod.notificationCount ?? 0) > 99 ? '99+' : mod.notificationCount}
        </div>
      )}

      {/* Icon row + status badge */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div style={{
          width: 42, height: 42, borderRadius: '10px',
          background: `${mod.accent}14`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: mod.accent, flexShrink: 0,
        }}>
          {mod.icon}
        </div>
        <span style={{
          fontSize: '10px', fontWeight: 700,
          color: st.color, background: st.bg,
          borderRadius: '5px', padding: '3px 8px',
          whiteSpace: 'nowrap',
        }}>
          {st.label}
        </span>
      </div>

      {/* Title + description */}
      <div>
        <div style={{
          fontSize: '14px', fontWeight: 700, color: '#111318',
          letterSpacing: '-0.01em', marginBottom: '4px',
        }}>
          {mod.title}
        </div>
        <div style={{ fontSize: '12.5px', color: '#6B7384', lineHeight: 1.55 }}>
          {mod.description}
        </div>
      </div>

      {/* Notification count line */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        paddingTop: '10px',
        borderTop: '1px solid #F3F4F6',
        marginTop: 'auto',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <div style={{
            width: 6, height: 6, borderRadius: '50%',
            background: hasNotif ? '#D94F4F' : '#D1D5DB',
            flexShrink: 0,
          }} />
          <span style={{ fontSize: '11.5px', color: hasNotif ? '#374151' : '#9CA3AF', fontWeight: hasNotif ? 600 : 400 }}>
            {mod.notificationCount == null
              ? 'Notifications unavailable'
              : hasNotif
                ? `${mod.notificationCount} pending`
                : 'No pending notifications'}
          </span>
        </div>
        <span style={{
          fontSize: '12px', fontWeight: 600,
          color: hovered ? mod.accent : '#9CA3AF',
          display: 'flex', alignItems: 'center', gap: '3px',
          transition: 'color 0.15s',
        }}>
          Open
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
            style={{ transform: hovered ? 'translateX(2px)' : 'none', transition: 'transform 0.15s' }}>
            <line x1="5" y1="12" x2="19" y2="12" />
            <polyline points="12 5 19 12 12 19" />
          </svg>
        </span>
      </div>
    </div>
  )
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function TaskIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  )
}

function BoxIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.29 7 12 12 20.71 7" /><line x1="12" y1="22" x2="12" y2="12" />
    </svg>
  )
}

function CalIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  )
}

function PayIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="4" width="22" height="16" rx="2" /><line x1="1" y1="10" x2="23" y2="10" />
    </svg>
  )
}

function AssetIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" />
      <path d="M7 8h.01M11 8h4M7 12h.01M11 12h4" />
    </svg>
  )
}

function MembersIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
    </svg>
  )
}
