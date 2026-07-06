'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { LoadingScreen } from '@/components/ui/atoms'
import { BoeOsLayout } from '@/components/layout/BoeOsLayout'
import DailyQuoteLoader from '@/components/DailyQuoteLoader'
import { useViewAs } from '@/hooks/useViewAs'
import { canAccessModule, type ModuleVisibilityType } from '@/lib/moduleAccess'

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
  visibilityType?: string   // from app_modules — drives badge when present
  allowedDepartment?: string[] | null
}

const STATUS_LABEL: Record<ModuleStatus, { label: string; color: string; bg: string }> = {
  active:     { label: 'Active',     color: '#166534', bg: '#F0FDF4' },
  foundation: { label: 'Foundation', color: '#1E40AF', bg: '#EFF6FF' },
  planned:    { label: 'Planned',    color: '#4B5563', bg: '#F3F4F6' },
}

// ── Page ─────────────────────────────────────────────────────────────────────

// ── Visibility resolver — used by /modules to evaluate app_modules DB rules ──

type ModVisRow = { visibility_type: string; allowed_department: string[] | null }

function canSeeModule(
  key: string,
  modVis: Record<string, ModVisRow>,
  effectiveProfile: UserProfile | null,
  fallback: boolean,
): boolean {
  const mod = modVis[key]
  return canAccessModule(
    mod?.visibility_type as ModuleVisibilityType | undefined,
    mod?.allowed_department,
    effectiveProfile,
    fallback,
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function BoeOsHomePage() {
  const [profile,  setProfile]  = useState<UserProfile | null>(null)
  const [loading,  setLoading]  = useState(true)
  // null = count unavailable (no API), number = real count from module's own API
  const [taskNotif,   setTaskNotif]   = useState<number | null>(null)
  const [sampleNotif, setSampleNotif] = useState<number | null>(null)
  const [modVis,      setModVis]      = useState<Record<string, ModVisRow>>({})

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { viewAsUserId, viewAsProfile } = useViewAs()

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const uid = session.user.id

      const [
        { data: profileData },
        { data: appModulesData },
        taskNotifsRes,
        sampleNotifsRes,
      ] = await Promise.all([
        supabase
          .from('users')
          .select('id, full_name, email, phone, role, team, is_active, created_at')
          .eq('id', uid)
          .single(),
        supabase
          .from('app_modules')
          .select('module_key, visibility_type, allowed_department')
          .order('sort_order'),
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

      if (appModulesData) {
        const vis: Record<string, ModVisRow> = {}
        for (const m of appModulesData) vis[m.module_key] = m
        setModVis(vis)
      }

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

  // In View Mode use the viewed user's profile for card visibility; fall back to actual profile.
  const effectiveProfile = (viewAsUserId && viewAsProfile) ? viewAsProfile : profile

  // Fallback values used when app_modules DB data is unavailable
  const isAdminFallback = effectiveProfile?.role === 'admin'
  const hasShowroomFallback = isAdminFallback ||
    (effectiveProfile?.team?.toLowerCase().includes('sales') ?? false) ||
    (effectiveProfile?.team?.toLowerCase().includes('showroom') ?? false)

  const modules: ModuleDef[] = [
    ...(canSeeModule('task_management', modVis, effectiveProfile, true) ? [{
      key: 'tasks',
      title: 'Task Management',
      description: 'Create, assign, and track tasks across your team.',
      href: '/dashboard',
      status: 'active' as ModuleStatus,
      accent: '#1A2035',
      icon: <TaskIcon />,
      notificationCount: taskNotif,
      visibilityType: modVis['task_management']?.visibility_type,
      allowedDepartment: modVis['task_management']?.allowed_department,
    }] : []),
    ...(canSeeModule('sample_tracking', modVis, effectiveProfile, true) ? [{
      key: 'samples',
      title: 'Sample Tracking',
      description: 'Request sample catalogs, track dispatch and returns, follow up on overdue items.',
      href: '/samples',
      status: 'active' as ModuleStatus,
      accent: '#B45309',
      icon: <BoxIcon />,
      notificationCount: sampleNotif,
      visibilityType: modVis['sample_tracking']?.visibility_type,
      allowedDepartment: modVis['sample_tracking']?.allowed_department,
    }] : []),
    ...(canSeeModule('attendance', modVis, effectiveProfile, isAdminFallback) ? [{
      key: 'attendance',
      title: 'Attendance',
      description: 'Manage employee attendance records, uploads, and leave history.',
      href: '/attendance',
      status: 'active' as ModuleStatus,
      accent: '#0F766E',
      icon: <CalIcon />,
      adminOnly: true,
      notificationCount: null,
      visibilityType: modVis['attendance']?.visibility_type,
      allowedDepartment: modVis['attendance']?.allowed_department,
    }] : []),
    ...(canSeeModule('payroll', modVis, effectiveProfile, isAdminFallback) ? [{
      key: 'payroll',
      title: 'Payroll',
      description: 'Process payroll runs, view salary breakdowns, and download payslips.',
      href: '/payroll',
      status: 'active' as ModuleStatus,
      accent: '#166534',
      icon: <PayIcon />,
      adminOnly: true,
      notificationCount: null,
      visibilityType: modVis['payroll']?.visibility_type,
      allowedDepartment: modVis['payroll']?.allowed_department,
    }] : []),
    ...(canSeeModule('showroom_qr', modVis, effectiveProfile, hasShowroomFallback) ? [{
      key: 'showroom',
      title: 'Showroom QR',
      description: 'QR-based showroom inquiries and quotations.',
      href: '/showroom-admin',
      status: 'active' as ModuleStatus,
      accent: '#7C3AED',
      icon: <ShowroomIcon />,
      notificationCount: null,
      visibilityType: modVis['showroom_qr']?.visibility_type,
      allowedDepartment: modVis['showroom_qr']?.allowed_department,
    }] : []),
    ...(canSeeModule('assets_access', modVis, effectiveProfile, true) ? [{
      key: 'assets',
      title: 'Assets & Access',
      description: 'View your assigned devices and access records, or manage the company inventory.',
      href: '/assets-access',
      status: 'foundation' as ModuleStatus,
      accent: '#4B5563',
      icon: <AssetIcon />,
      notificationCount: null,
      visibilityType: modVis['assets_access']?.visibility_type,
      allowedDepartment: modVis['assets_access']?.allowed_department,
    }] : []),
    ...(canSeeModule('employee_records', modVis, effectiveProfile, isAdminFallback) ? [{
      key: 'members',
      title: 'Employee Records',
      description: 'View and manage employee profiles, roles, and team assignments.',
      href: '/admin/members',
      status: 'active' as ModuleStatus,
      accent: '#1E40AF',
      icon: <MembersIcon />,
      adminOnly: true,
      notificationCount: null,
      visibilityType: modVis['employee_records']?.visibility_type,
      allowedDepartment: modVis['employee_records']?.allowed_department,
    }] : []),
    ...(canSeeModule('finance', modVis, effectiveProfile, true) ? [{
      key: 'finance',
      title: 'Finance',
      description: 'Payment confirmations, order advances, and finance approvals.',
      href: '/finance',
      status: 'foundation' as ModuleStatus,
      accent: '#065F46',
      icon: <FinanceIcon />,
      notificationCount: null,
      visibilityType: modVis['finance']?.visibility_type,
      allowedDepartment: modVis['finance']?.allowed_department,
    }] : []),
    ...(canSeeModule('orders', modVis, effectiveProfile, isAdminFallback) ? [{
      key: 'orders',
      title: 'Order Management',
      description: 'Track confirmed orders from request through production and dispatch.',
      href: '/orders',
      status: 'active' as ModuleStatus,
      accent: '#DC1F2E',
      icon: <OrdersIcon />,
      notificationCount: null,
      visibilityType: modVis['orders']?.visibility_type,
      allowedDepartment: modVis['orders']?.allowed_department,
    }] : []),
    ...(effectiveProfile?.role === 'admin' ? [{
      key: 'control_center',
      title: 'Admin Control Center',
      description: 'Control modules, departments, and user department access.',
      href: '/admin/control-center',
      status: 'active' as ModuleStatus,
      accent: '#6B21A8',
      icon: <ControlCenterIcon />,
      adminOnly: true,
      notificationCount: null,
      visibilityType: 'admin_only',
      allowedDepartment: null,
    }] : []),
  ]

  return (
    <DailyQuoteLoader>
      {loading ? <LoadingScreen /> : (
        <BoeOsLayout
          profile={profile}
          title="BOE Operating System"
          subtitle={new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
          onSignOut={handleSignOut}
        >
          {/* Section label */}
          <div style={{
            fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em',
            color: '#8C94A6', textTransform: 'uppercase', marginBottom: '16px',
          }}>
            Modules
          </div>

          {/* Responsive app-launcher grid */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: '20px',
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
      )}
    </DailyQuoteLoader>
  )
}

// ── ModuleCard ────────────────────────────────────────────────────────────────

const VIS_BADGE: Record<string, { color: string; bg: string; label: (dept?: string[] | null) => string }> = {
  live:            { color: '#166534', bg: '#F0FDF4', label: () => 'Live' },
  admin_only:      { color: '#1E40AF', bg: '#EFF6FF', label: () => 'Admin Only' },
  department_only: {
    color: '#92400E', bg: '#FFFBEB',
    label: (dept) => dept?.length
      ? `${dept.map(d => `${d.charAt(0).toUpperCase()}${d.slice(1)}`).join('/')} Only`
      : 'Dept Only',
  },
  hidden:          { color: '#4B5563', bg: '#F3F4F6', label: () => 'Hidden' },
}

function ModuleCard({ mod, onClick }: { mod: ModuleDef; onClick: () => void }) {
  const [hovered, setHovered] = useState(false)

  // Use DB visibility badge when available; fall back to legacy status label.
  const visMeta = mod.visibilityType ? VIS_BADGE[mod.visibilityType] : undefined
  const st = visMeta
    ? { label: visMeta.label(mod.allowedDepartment), color: visMeta.color, bg: visMeta.bg }
    : STATUS_LABEL[mod.status]
  const hasNotif = (mod.notificationCount ?? 0) > 0
  const count    = mod.notificationCount

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
        border: `1.5px solid ${hovered ? mod.accent : '#E8EBF0'}`,
        borderRadius: '16px',
        padding: '24px 22px 20px',
        cursor: 'pointer',
        transition: 'border-color 0.15s, box-shadow 0.15s, transform 0.15s',
        boxShadow: hovered
          ? `0 8px 24px rgba(0,0,0,0.10), 0 2px 6px rgba(0,0,0,0.06)`
          : '0 1px 4px rgba(0,0,0,0.05)',
        transform: hovered ? 'translateY(-2px)' : 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        minHeight: '200px',
      }}
    >
      {/* ── Icon block with notification badge ── */}
      <div style={{ position: 'relative', alignSelf: 'flex-start' }}>
        <div style={{
          width: 56, height: 56, borderRadius: '14px',
          background: `${mod.accent}12`,
          border: `1.5px solid ${mod.accent}22`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: mod.accent,
          transition: 'background 0.15s',
          ...(hovered ? { background: `${mod.accent}1E` } : {}),
        }}>
          {mod.icon}
        </div>
        {hasNotif && (
          <div style={{
            position: 'absolute', top: '-5px', right: '-5px',
            background: '#D94F4F', color: '#fff',
            fontSize: '9px', fontWeight: 800,
            borderRadius: '999px',
            minWidth: '18px', height: '18px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '0 4px',
            border: '2px solid #fff',
            boxShadow: '0 1px 3px rgba(0,0,0,0.18)',
            letterSpacing: '0.01em',
          }}>
            {count! > 99 ? '99+' : count}
          </div>
        )}
      </div>

      {/* ── Name + description ── */}
      <div style={{ flex: 1 }}>
        <div style={{
          fontSize: '15px', fontWeight: 700, color: '#111318',
          letterSpacing: '-0.02em', marginBottom: '5px', lineHeight: 1.2,
        }}>
          {mod.title}
        </div>
        <div style={{
          fontSize: '12px', color: '#6B7384', lineHeight: 1.5,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}>
          {mod.description}
        </div>
      </div>

      {/* ── Footer: status pill + notification line + open ── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        paddingTop: '12px',
        borderTop: '1px solid #F3F4F6',
        gap: '8px',
      }}>
        {/* Left: status + notification signal */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
          <span style={{
            fontSize: '10px', fontWeight: 700,
            color: st.color, background: st.bg,
            borderRadius: '5px', padding: '2px 7px',
            whiteSpace: 'nowrap', flexShrink: 0,
          }}>
            {st.label}
          </span>
          <span style={{
            fontSize: '11px',
            color: hasNotif ? '#D94F4F' : '#B0B8C8',
            fontWeight: hasNotif ? 600 : 400,
            whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {count == null
              ? 'No notifications'
              : hasNotif
                ? `${count} ${count === 1 ? 'notification' : 'notifications'}`
                : 'No notifications'}
          </span>
        </div>

        {/* Right: Open */}
        <span style={{
          fontSize: '12px', fontWeight: 600,
          color: hovered ? mod.accent : '#A0A9BE',
          display: 'flex', alignItems: 'center', gap: '3px',
          transition: 'color 0.15s',
          flexShrink: 0,
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
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  )
}

function BoxIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.29 7 12 12 20.71 7" /><line x1="12" y1="22" x2="12" y2="12" />
    </svg>
  )
}

function CalIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  )
}

function PayIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="4" width="22" height="16" rx="2" /><line x1="1" y1="10" x2="23" y2="10" />
    </svg>
  )
}

function AssetIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" />
      <path d="M7 8h.01M11 8h4M7 12h.01M11 12h4" />
    </svg>
  )
}

function MembersIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
    </svg>
  )
}

function ControlCenterIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07M8.46 8.46a5 5 0 0 0 0 7.07" />
    </svg>
  )
}

function FinanceIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  )
}

function OrdersIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
      <rect x="9" y="3" width="6" height="4" rx="1" />
      <line x1="9" y1="12" x2="15" y2="12" /><line x1="9" y1="16" x2="13" y2="16" />
    </svg>
  )
}

function ShowroomIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M14 14h2v2h-2zM18 14h3M14 18h2M18 18h3M14 21h5" />
    </svg>
  )
}
