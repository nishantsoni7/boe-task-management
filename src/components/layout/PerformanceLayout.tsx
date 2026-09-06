'use client'

import { useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { Home, UserRound, Users } from 'lucide-react'
import type { UserProfile } from '@/lib/types'
import { BoeBrandIcon } from './BoeBrandIcon'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'

// The Performance module shell.
//
// WHAT THIS REPLACES. Both Performance screens rendered inside
// DashboardLayout — the TASK MANAGEMENT shell — so somebody reading their own
// score was offered My Tasks, Assigned By Me, Quotation Requests and the task
// notification feed, and nothing that belonged to Performance. Performance
// CONSUMES task data for scoring, which is presumably how the two came to share
// a shell, but consuming a module's data is not being that module. Every other
// module already has its own: Orders, Finance, Assets, Samples, Meetings,
// Review Workflow, Image Editor, Attendance & Payroll. Performance was the only
// one still borrowing another's navigation.
//
// Complies with the BOE Module Layout Standard, same as CustomerReviewsLayout:
// two columns, a module header with a Home button back to /modules,
// module-only navigation in the middle, and the shared user area at the bottom.
// No cross-module links.
//
// TWO DESTINATIONS, AND NO PLACEHOLDERS:
//
//   My Performance    the employee's own report — today's score, the month,
//                     the history, the EOD. Everybody with the module has it,
//                     because everybody is first an individual employee.
//   Team Performance  the management dataset. Only for a `view_team` holder.
//
// Nothing else is listed. A menu of empty rooms is worse than a short menu, and
// the module is expected to grow — a third destination should arrive with the
// screen it opens, not before it.
//
// VISIBILITY IS THE DISPLAY SUBJECT'S, NEVER A ROLE. The caller passes
// `canViewTeam`, which every current call site derives from
// derivePerformanceCapabilities on the DISPLAY SUBJECT (see
// src/hooks/queries/useDisplaySubject.ts). So an administrator previewing an
// employee gets exactly that employee's Performance menu — both entries for
// somebody holding `view_team`, one for somebody who does not — and the View
// Mode banner and read-only rules are untouched, because they live in the
// shared components this shell mounts.

type PerformanceLayoutProps = {
  /** The SIGNED-IN user, for the account menu. Never the viewed employee. */
  profile: UserProfile | null
  title: string
  subtitle?: string
  actions?: React.ReactNode
  /**
   * Whether the DISPLAY SUBJECT holds `performance:view_team`.
   *
   * Hiding the entry is not the boundary — /performance/team has its own route
   * guard and its API refuses the data server-side. This decides what the menu
   * offers, which is a different question from what the route permits.
   */
  canViewTeam: boolean
  onSignOut: () => void
  children: React.ReactNode
}

type NavItem = {
  label: string
  path: string
  icon: React.ReactNode
  /** Only `pathname === path` lights this item. The module root needs it. */
  exact?: boolean
  teamOnly?: boolean
}

const NAV_ITEMS: NavItem[] = [
  {
    label: 'My Performance',
    path: '/performance',
    icon: <UserRound size={15} strokeWidth={1.8} />,
    exact: true,
  },
  {
    label: 'Team Performance',
    path: '/performance/team',
    icon: <Users size={15} strokeWidth={1.8} />,
    teamOnly: true,
  },
]

export function PerformanceLayout({
  profile, title, subtitle, actions, canViewTeam, onSignOut, children,
}: PerformanceLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const router = useRouter()
  const pathname = usePathname()

  const items = NAV_ITEMS.filter(item => !item.teamOnly || canViewTeam)

  // By route. The root is `exact` because otherwise "My Performance" would
  // claim /performance/team as well and both entries would light at once.
  const isActive = (item: NavItem): boolean =>
    item.exact ? pathname === item.path : pathname.startsWith(item.path)

  const navTo = (item: NavItem) => {
    setSidebarOpen(false)
    router.push(item.path)
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

        <div
          className="boe-sidebar-brand"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <BoeBrandIcon />
            <div>
              <div className="boe-sidebar-brand-name">BOE</div>
              <div className="boe-sidebar-brand-sub">Performance</div>
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

        <div className="boe-sidebar-section">
          {items.map(item => {
            const active = isActive(item)
            return (
              <button
                key={item.path}
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

        <ViewModeSidebarSection
          profile={profile}
          onSignOut={onSignOut}
          accountSettingsHref="/account?returnTo=/performance"
        />

      </aside>

      {/* Main content */}
      <div className="boe-main-content">

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

        <div className="boe-page-body">
          <ViewModeBanner />
          {children}
        </div>

      </div>
    </div>
  )
}
