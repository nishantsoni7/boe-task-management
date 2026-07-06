'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { ClipboardList, QrCode, Package, Home, X } from 'lucide-react'
import { BoeBrandIcon } from './BoeBrandIcon'
import type { UserProfile } from '@/lib/types'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'
import { useViewAs } from '@/hooks/useViewAs'
import { createClient } from '@/lib/supabase/client'
import { canAccessModule, type ModuleVisibilityType } from '@/lib/moduleAccess'

type ShowroomAdminLayoutProps = {
  profile: UserProfile | null
  title: string
  subtitle?: string
  onSignOut: () => void
  children: React.ReactNode
}

type ModVisRow = { visibility_type: string; allowed_department: string[] | null }
const teamFallback = (team?: string | null) =>
  !!team && (team.toLowerCase().includes('sales') || team.toLowerCase().includes('showroom'))

export function ShowroomAdminLayout({ profile, title, subtitle, onSignOut, children }: ShowroomAdminLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [showroomMod, setShowroomMod] = useState<ModVisRow | null>(null)
  const router   = useRouter()
  const pathname = usePathname()
  const supabase = useMemo(() => createClient(), [])

  const { viewAsProfile } = useViewAs()
  const effectiveProfile = viewAsProfile ?? profile
  const isAdmin = effectiveProfile?.role === 'admin'

  // Sidebar nav needs the same Control-Center-driven permission the
  // showroom-admin route guards use, so "Product Master" isn't hidden from
  // a department that's allowed into the module but isn't an admin.
  useEffect(() => {
    supabase
      .from('app_modules')
      .select('visibility_type, allowed_department')
      .eq('module_key', 'showroom_qr')
      .single()
      .then((res: { data: ModVisRow | null }) => setShowroomMod(res.data ?? null))
  }, [supabase])

  const canManageProducts = isAdmin || canAccessModule(
    showroomMod?.visibility_type as ModuleVisibilityType | undefined,
    showroomMod?.allowed_department,
    effectiveProfile ?? null,
    teamFallback(effectiveProfile?.team),
  )

  const navTo = (path: string) => {
    router.push(path)
    setSidebarOpen(false)
  }

  return (
    <div className="boe-app-shell">

      {/* Mobile overlay */}
      <div
        className={`boe-sidebar-overlay${sidebarOpen ? ' open' : ''}`}
        onClick={() => setSidebarOpen(false)}
      />

      {/* Sidebar */}
      <aside className={`boe-sidebar${sidebarOpen ? ' open' : ''}`}>

        {/* Brand header — with home icon top-right matching other modules */}
        <div className="boe-sidebar-brand" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <BoeBrandIcon />
            <div>
              <div className="boe-sidebar-brand-name">Showroom QR</div>
              <div className="boe-sidebar-brand-sub">BOE Operating System</div>
            </div>
          </div>
          <button
            onClick={() => navTo('/modules')}
            title="BOE OS Home"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, borderRadius: '7px',
              background: 'rgba(220,31,46,0.08)',
              border: '1px solid rgba(220,31,46,0.20)',
              color: '#DC1F2E', cursor: 'pointer', flexShrink: 0,
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(220,31,46,0.10)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(220,31,46,0.08)' }}
          >
            <Home size={14} strokeWidth={2} />
          </button>
        </div>

        {/* Module nav — Showroom QR links only */}
        <div className="boe-sidebar-section">
          <NavItem
            label="My Inquiries"
            icon={<ClipboardList size={15} strokeWidth={1.8} />}
            active={pathname === '/showroom-admin'}
            onClick={() => navTo('/showroom-admin')}
          />
          <NavItem
            label="My QR Code"
            icon={<QrCode size={15} strokeWidth={1.8} />}
            active={pathname === '/showroom-admin/qr'}
            onClick={() => navTo('/showroom-admin/qr')}
          />
          {canManageProducts && (
            <NavItem
              label="Product Master"
              icon={<Package size={15} strokeWidth={1.8} />}
              active={pathname.startsWith('/showroom-admin/products')}
              onClick={() => navTo('/showroom-admin/products')}
            />
          )}
        </div>

        {/* Bottom: profile + account settings + view as + sign out */}
        <ViewModeSidebarSection
          profile={profile}
          onSignOut={onSignOut}
          accountSettingsHref="/account?returnTo=/showroom-admin"
        />
      </aside>

      {/* Main content */}
      <div className="boe-main-content">

        {/* Sticky page header */}
        <div className="boe-page-header">
          <button
            className="boe-menu-toggle"
            onClick={() => setSidebarOpen(o => !o)}
            aria-label="Open menu"
          >
            {sidebarOpen ? <X size={18} /> : '☰'}
          </button>
          <div className="boe-page-title-group">
            <div className="boe-page-title">{title}</div>
            {subtitle && <div className="boe-page-subtitle">{subtitle}</div>}
          </div>
          {/* Top-right home icon — same pattern as other modules */}
          <div className="boe-header-actions">
            <button
              onClick={() => router.push('/modules')}
              title="BOE OS Home"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 32, height: 32, borderRadius: '8px',
                background: 'rgba(0,0,0,0.05)',
                border: '1px solid rgba(0,0,0,0.10)',
                color: '#6B7384',
                cursor: 'pointer',
                flexShrink: 0, transition: 'background 0.15s, color 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(220,31,46,0.08)'; e.currentTarget.style.color = '#DC1F2E' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.05)'; e.currentTarget.style.color = '#6B7384' }}
            >
              <Home size={14} strokeWidth={2} />
            </button>
          </div>
        </div>

        {/* Page body */}
        <div className="boe-page-body">
          <ViewModeBanner />
          {children}
        </div>

      </div>
    </div>
  )
}

function NavItem({
  label, icon, active, onClick,
}: {
  label: string
  icon: React.ReactNode
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      className={`boe-nav-item${active ? ' active' : ''}`}
      onClick={onClick}
      style={{ fontWeight: active ? 600 : 400, marginBottom: '2px' }}
    >
      <span style={{ color: active ? '#DC1F2E' : '#A0A9BE', display: 'flex', alignItems: 'center' }}>
        {icon}
      </span>
      {label}
    </button>
  )
}
