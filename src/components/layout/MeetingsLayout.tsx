'use client'

import { useState } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { CalendarClock, CheckCircle2, CalendarCheck, AlertTriangle, Home } from 'lucide-react'
import type { UserProfile } from '@/lib/types'
import { BoeBrandIcon } from './BoeBrandIcon'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'

// The Meetings module shell.
//
// Complies with the BOE Module Layout Standard: two columns, a module header
// with a Home button that returns to /modules, module-only navigation in the
// middle, and the shared user area at the bottom (profile, Account Settings,
// View As, Sign Out). No cross-module links.
//
// The four entries are the module's four operational questions, in the order
// they are asked during a week:
//
//   Active & Upcoming — what am I about to run, or still running
//   Due Follow-ups    — what did we commit to that lands today
//   Overdue           — what did we commit to and miss
//   Completed         — what did we decide, historically
//
// Due and Overdue are two entries into ONE screen (`/meetings/follow-ups`) with
// its date filter preset, not two screens. That is why they are matched on the
// query string as well as the path: a nav item must not light up for a filter
// the user is not looking at.

type MeetingsLayoutProps = {
  profile: UserProfile | null
  title: string
  subtitle?: string
  actions?: React.ReactNode
  onSignOut: () => void
  children: React.ReactNode
}

type NavItem = {
  label: string
  path: string
  /** Preset filter for the shared Follow-ups screen; undefined for plain routes. */
  due?: 'overdue' | 'today'
  icon: React.ReactNode
  exact: boolean
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Active & Upcoming', path: '/meetings',             icon: <CalendarClock size={15} strokeWidth={1.8} />, exact: true },
  { label: 'Due Follow-ups',    path: '/meetings/follow-ups',  icon: <CalendarCheck size={15} strokeWidth={1.8} />, exact: false, due: 'today' },
  { label: 'Overdue',           path: '/meetings/follow-ups',  icon: <AlertTriangle size={15} strokeWidth={1.8} />, exact: false, due: 'overdue' },
  { label: 'Completed',         path: '/meetings/completed',   icon: <CheckCircle2  size={15} strokeWidth={1.8} />, exact: false },
]

export function MeetingsLayout({
  profile, title, subtitle, actions, onSignOut, children,
}: MeetingsLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const currentDue = searchParams.get('due')

  const href = (item: NavItem) => (item.due ? `${item.path}?due=${item.due}` : item.path)

  const isActive = (item: NavItem): boolean => {
    const onPath = item.exact ? pathname === item.path : pathname.startsWith(item.path)
    if (!onPath) return false
    // On the shared Follow-ups screen only the entry matching the active filter
    // highlights. Any other filter (All, Upcoming) highlights neither, which is
    // honest: the user is on a view neither entry names.
    if (pathname.startsWith('/meetings/follow-ups')) return currentDue === item.due
    return true
  }

  const navTo = (item: NavItem) => {
    setSidebarOpen(false)
    router.push(href(item))
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

        {/* Brand header */}
        <div className="boe-sidebar-brand" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <BoeBrandIcon />
            <div>
              <div className="boe-sidebar-brand-name">BOE</div>
              <div className="boe-sidebar-brand-sub">Meetings</div>
            </div>
          </div>
          <button
            onClick={() => router.push('/modules')}
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

        {/* Nav */}
        <div className="boe-sidebar-section">
          {NAV_ITEMS.map(item => {
            const active = isActive(item)
            return (
              <button
                key={`${item.path}-${item.due ?? ''}`}
                className={`boe-nav-item${active ? ' active' : ''}`}
                onClick={() => navTo(item)}
                style={{ fontWeight: active ? 600 : 400, marginBottom: '2px' }}
              >
                <span style={{ color: active ? '#DC1F2E' : '#A0A9BE', display: 'flex', alignItems: 'center' }}>
                  {item.icon}
                </span>
                {item.label}
              </button>
            )
          })}
        </div>

        {/* Bottom profile section */}
        <ViewModeSidebarSection
          profile={profile}
          onSignOut={onSignOut}
          accountSettingsHref="/account?returnTo=/meetings"
        />

      </aside>

      {/* Main content */}
      <div className="boe-main-content">

        {/* Page header */}
        <div className="boe-page-header">
          <button
            className="boe-menu-toggle"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
          >
            ☰
          </button>
          <div className="boe-page-title-group">
            <div className="boe-page-title">{title}</div>
            {subtitle && <div className="boe-page-subtitle">{subtitle}</div>}
          </div>
          {actions && (
            <div className="boe-header-actions" style={{ flexWrap: 'wrap', flexShrink: 1 }}>
              {actions}
            </div>
          )}
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
