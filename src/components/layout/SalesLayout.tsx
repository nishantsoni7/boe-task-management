'use client'

import { useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { BarChart3, Columns3, Home, ListChecks, Users } from 'lucide-react'
import { useSalesAccess } from '@/hooks/useSalesAccess'
import { useSalesUnreadNotifications } from '@/hooks/queries/useUnreadNotifications'
import { NotificationsNavItem } from './NotificationsNavItem'
import type { UserProfile } from '@/lib/types'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'
import { BoeBrandIcon } from './BoeBrandIcon'
import { SidebarPinButton, railShellClass, useSidebarPinned } from './RailControls'
import s from './salesLayout.module.css'

// The Sales module shell: the BOE Module Layout Standard, two columns, a module header with Home → /modules,
// module-only navigation, and the shared user area at the bottom. On a phone the same items sit in a bar at the
// bottom: a salesperson moves between My day and the board all day, and that must not take two taps.

const BASE = '/sales'

const NAV_ITEMS = [
  { href: `${BASE}/my-day`, label: 'My day', icon: ListChecks, show: 'all' },
  { href: `${BASE}/board`, label: 'Lead Board', icon: Columns3, show: 'all' },
  { href: `${BASE}/team`, label: 'Team', icon: BarChart3, show: 'team' },
  // The register is for whoever adds, allots or oversees leads.
  { href: `${BASE}/lead-master`, label: 'Lead Master', icon: Users, show: 'register' },
] as const

type Props = {
  profile: UserProfile | null
  title: string
  subtitle?: string
  /** Header buttons (Notifications' Mark all read and Delete all). */
  actions?: React.ReactNode
  onSignOut: () => void
  /** The page fills the screen and scrolls inside itself, so the header stays and nothing else moves (the Lead Board). */
  fill?: boolean
  children: React.ReactNode
}

export function SalesLayout({ profile, title, subtitle, actions, onSignOut, fill = false, children }: Props) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [railPinned, toggleRailPinned] = useSidebarPinned()
  const router = useRouter()
  const pathname = usePathname()
  const { canOpenRegister, canOpenTeam } = useSalesAccess()
  const unread = useSalesUnreadNotifications()
  const items = NAV_ITEMS.filter(item => item.show === 'all' || (item.show === 'team' ? canOpenTeam : canOpenRegister))

  return (
    <div className={railShellClass(railPinned)}>
      <div className={`boe-sidebar-overlay${sidebarOpen ? ' open' : ''}`} onClick={() => setSidebarOpen(false)} />

      <aside className={`boe-sidebar${sidebarOpen ? ' open' : ''}`}>
        <div className="boe-sidebar-brand" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <BoeBrandIcon />
            <div className="boe-rail-label">
              <div className="boe-sidebar-brand-name">BOE One</div>
              <div className="boe-sidebar-brand-sub">Sales</div>
            </div>
          </div>
          <button
            className="boe-rail-label"
            onClick={() => router.push('/modules')}
            title="BOE One Home"
            aria-label="BOE One Home"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, borderRadius: '8px',
              background: 'rgba(185,71,46,0.08)', border: '1px solid rgba(185,71,46,0.20)',
              color: '#B9472E', cursor: 'pointer', flexShrink: 0,
            }}
          >
            <Home size={14} strokeWidth={2} />
          </button>
        </div>

        <div className="boe-sidebar-section">
          {items.map(item => {
            // The Add lead page is part of the Lead Master, so the item stays lit there.
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
            const Icon = item.icon
            return (
              <button
                key={item.href}
                className={`boe-nav-item${active ? ' active' : ''}`}
                aria-current={active ? 'page' : undefined}
                onClick={() => { setSidebarOpen(false); router.push(item.href) }}
                style={{ fontWeight: active ? 500 : 400, fontSize: 13.5, marginBottom: '2px' }}
              >
                <span style={{ color: active ? '#37352F' : '#8A8782', display: 'flex', alignItems: 'center' }}>
                  <Icon size={15} strokeWidth={1.8} />
                </span>
                <span className="boe-rail-label">{item.label}</span>
              </button>
            )
          })}
          <NotificationsNavItem onNavigate={() => setSidebarOpen(false)} count={unread} href={`${BASE}/notifications`} />
        </div>

        <div className="boe-sidebar-foot">
          <SidebarPinButton pinned={railPinned} onToggle={toggleRailPinned} />
          <ViewModeSidebarSection profile={profile} onSignOut={onSignOut} accountSettingsHref={`/account?returnTo=${BASE}`} />
        </div>
      </aside>

      <div className={`boe-main-content${fill ? ` ${s.fill}` : ''}`}>
        <div className="boe-page-header">
          <button className="boe-menu-toggle" onClick={() => setSidebarOpen(true)} aria-label="Open menu">☰</button>
          <div className="boe-page-title-group">
            <div className="boe-page-title">{title}</div>
            {subtitle && <div className="boe-page-subtitle">{subtitle}</div>}
          </div>
          {actions && <div className="boe-header-actions">{actions}</div>}
        </div>
        <div className={`boe-page-body ${s.pageBody}${fill ? ` ${s.fillBody}` : ''}`}>
          <ViewModeBanner />
          {children}
        </div>
      </div>

      <nav className={`boe-mobile-bottom-nav ${s.bottomNav}`} aria-label="Sales">
        {items.map(item => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
          const Icon = item.icon
          return (
            <button key={item.href} type="button" className={s.bottomItem} aria-current={active ? 'page' : undefined} onClick={() => router.push(item.href)}>
              <Icon size={20} strokeWidth={1.8} aria-hidden="true" />{item.label}
            </button>
          )
        })}
      </nav>
    </div>
  )
}
