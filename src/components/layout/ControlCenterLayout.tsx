'use client'

import { Suspense, useState } from 'react'
import Link from 'next/link'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { Home, LayoutGrid, Building2, Users, ShieldCheck, History, X, Hash, Eraser, DatabaseZap } from 'lucide-react'
import { BoeBrandIcon } from './BoeBrandIcon'
import type { UserProfile } from '@/lib/types'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'

// 'modules' (Module Visibility) is retained so the existing ?tab=modules URL
// still resolves for rollback, but it is no longer reachable from the sidebar —
// see the note where its NavItem used to be.
export type ControlCenterTab = 'overview' | 'departments' | 'people' | 'modules' | 'order-numbering'

const MAIN_PATH = '/admin/control-center'

/** The section the main page shows for a ?tab= value. Anything unknown is Overview. */
export function resolveControlCenterTab(tabParam: string | null): ControlCenterTab {
  return tabParam === 'departments' || tabParam === 'people' || tabParam === 'modules'
    || tabParam === 'order-numbering'
    ? tabParam : 'overview'
}

// One heading per route. The shell is mounted once by control-center/layout.tsx
// and owns the header, so a section no longer hands over its title on every
// mount. The copy is exactly what each page used to pass.
const HEADINGS: Record<string, { title: string; subtitle?: string }> = {
  [MAIN_PATH]: {
    title: 'Control Center',
    subtitle: 'The admin operating panel for departments, people, module visibility, and access.',
  },
  [`${MAIN_PATH}/permissions`]: {
    title: 'Access Control',
    subtitle: 'Manage what each employee can access, module by module',
  },
  [`${MAIN_PATH}/test-data-cleanup`]: {
    title: 'Test Data Cleanup',
    subtitle: 'Remove a complete verified test transaction while the system is in testing.',
  },
  [`${MAIN_PATH}/data-management`]: {
    title: 'Data Management',
    subtitle: 'Clear all operational Order and Finance data. Admin only, and never reversible.',
  },
  [`${MAIN_PATH}/action-queue`]: {
    title: 'Action Queue',
    subtitle: 'Finance and Orders work currently waiting on an admin action',
  },
}

type ControlCenterLayoutProps = {
  profile: UserProfile | null
  onSignOut: () => void
  children: React.ReactNode
}

export function ControlCenterLayout({ profile, onSignOut, children }: ControlCenterLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const router   = useRouter()
  const pathname = usePathname()
  const heading  = HEADINGS[pathname] ?? { title: 'Control Center' }

  const closeSidebar = () => setSidebarOpen(false)

  const goHome = () => {
    router.push('/modules')
    closeSidebar()
  }

  return (
    <div className="boe-app-shell">

      {/* Mobile overlay */}
      <div
        className={`boe-sidebar-overlay${sidebarOpen ? ' open' : ''}`}
        onClick={closeSidebar}
      />

      {/* Sidebar */}
      <aside className={`boe-sidebar${sidebarOpen ? ' open' : ''}`}>

        {/* Section 1: Module header with Home button */}
        <div className="boe-sidebar-brand" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <BoeBrandIcon />
            <div>
              <div className="boe-sidebar-brand-name">Control Center</div>
              <div className="boe-sidebar-brand-sub">BOE Operating System</div>
            </div>
          </div>
          <button
            onClick={goHome}
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

        {/* Section 2: Control Center navigation only.
            The active tab is read from the URL inside a Suspense boundary, as
            useSearchParams asks; the fallback is the same list with no tab
            known, which only ever renders during prerender. */}
        <div className="boe-sidebar-section">
          <Suspense fallback={<ControlCenterNav pathname={pathname} tab={null} onNavigate={closeSidebar} />}>
            <ControlCenterNavWithTab pathname={pathname} onNavigate={closeSidebar} />
          </Suspense>
        </div>

        {/* Section 3: Global user area */}
        <ViewModeSidebarSection
          profile={profile}
          onSignOut={onSignOut}
          accountSettingsHref="/account?returnTo=/admin/control-center"
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
            <div className="boe-page-title">{heading.title}</div>
            {heading.subtitle && <div className="boe-page-subtitle">{heading.subtitle}</div>}
          </div>
          <div className="boe-header-actions">
            <button
              onClick={goHome}
              title="BOE OS Home"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 32, height: 32, borderRadius: '8px',
                background: 'rgba(0,0,0,0.05)',
                border: '1px solid rgba(0,0,0,0.10)',
                color: '#6B7384', cursor: 'pointer',
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

function ControlCenterNavWithTab({ pathname, onNavigate }: { pathname: string; onNavigate: () => void }) {
  const tab = resolveControlCenterTab(useSearchParams().get('tab'))
  return <ControlCenterNav pathname={pathname} tab={tab} onNavigate={onNavigate} />
}

// Every entry is a real link, so Next prefetches it and Back/Forward walk
// through sections as they would through any pages. Overview, Departments,
// People and Order Numbering are still tabs of the main page: on that page a
// tab link REPLACES the history entry, exactly as the in-place switch always
// did; from any other section it pushes one.
function ControlCenterNav({
  pathname, tab, onNavigate,
}: {
  pathname: string
  tab: ControlCenterTab | null
  onNavigate: () => void
}) {
  const onMain = pathname === MAIN_PATH
  const tabHref = (t: ControlCenterTab) => `${MAIN_PATH}?tab=${t}`

  return (
    <>
      <NavItem
        label="Overview"
        icon={<LayoutGrid size={15} strokeWidth={1.8} />}
        href={tabHref('overview')}
        replace={onMain}
        active={onMain && (tab === null || tab === 'overview')}
        onNavigate={onNavigate}
      />
      <NavItem
        label="Departments"
        icon={<Building2 size={15} strokeWidth={1.8} />}
        href={tabHref('departments')}
        replace={onMain}
        active={onMain && tab === 'departments'}
        onNavigate={onNavigate}
      />
      <NavItem
        label="People"
        icon={<Users size={15} strokeWidth={1.8} />}
        href={tabHref('people')}
        replace={onMain}
        active={onMain && tab === 'people'}
        onNavigate={onNavigate}
      />
      <NavItem
        label="Access Control"
        icon={<ShieldCheck size={15} strokeWidth={1.8} />}
        href={`${MAIN_PATH}/permissions`}
        active={pathname === `${MAIN_PATH}/permissions`}
        onNavigate={onNavigate}
      />
      {/* Action Queue used to sit here. Every row it listed was a deep link
          into Finance or Order Requests — it decided nothing, stored nothing
          and configured nothing, so it was a second way to reach two
          modules rather than a Control Center function of its own.
          The ROUTE (/admin/control-center/action-queue) is deliberately
          left in place so existing links and bookmarks still resolve, and
          the Finance and Orders pages it pointed at are untouched. Only
          this navigation entry is gone. */}
      {/* Order Numbering earns a top-level entry rather than living inside
          Overview: an admin looking for "where do I set the next Order
          number" scans this list, and anything not named here is, in
          practice, unfindable. */}
      <NavItem
        label="Order Numbering"
        icon={<Hash size={15} strokeWidth={1.8} />}
        href={tabHref('order-numbering')}
        replace={onMain}
        active={onMain && tab === 'order-numbering'}
        onNavigate={onNavigate}
      />
      {/* Module Visibility was a second, parallel way to decide who sees a
          module, sitting one click from Access Control and disagreeing with
          it. Access Control is now the single administrator workflow.

          Nothing was deleted: app_modules still governs Showroom QR's
          department rule and the Attendance/Payroll self-service cards, and
          the tab's code and API routes are untouched behind
          ?tab=modules for rollback. What changed is that it is no longer
          presented as a workflow an administrator is meant to use. */}
      {/* Its own page, deliberately far from the everyday Finance and
          Orders lists. Removing a finalized test record is not a routine
          action and must not sit next to routine ones. */}
      <NavItem
        label="Test Data Cleanup"
        icon={<Eraser size={15} strokeWidth={1.8} />}
        href={`${MAIN_PATH}/test-data-cleanup`}
        active={pathname === `${MAIN_PATH}/test-data-cleanup`}
        onNavigate={onNavigate}
      />
      {/* A SEPARATE ENTRY, not a tab of the one above, because the two
          answer different questions. Test Data Cleanup removes ONE
          transaction, found by searching for it. Data Management clears a
          MODULE, where there is nothing to search for and the only choice
          is which half. Folding them together would put "clear every Order
          in the system" one click from a search box. */}
      <NavItem
        label="Data Management"
        icon={<DatabaseZap size={15} strokeWidth={1.8} />}
        href={`${MAIN_PATH}/data-management`}
        active={pathname === `${MAIN_PATH}/data-management`}
        onNavigate={onNavigate}
      />
      <NavItem
        label="Change History"
        icon={<History size={15} strokeWidth={1.8} />}
        active={false}
        disabled
        badge="Soon"
      />
    </>
  )
}

function NavItem({
  label, icon, active, href, replace, onNavigate, disabled, badge,
}: {
  label: string
  icon: React.ReactNode
  active: boolean
  href?: string
  /** Replace the history entry instead of pushing one. */
  replace?: boolean
  onNavigate?: () => void
  disabled?: boolean
  badge?: string
}) {
  const className = `boe-nav-item${active ? ' active' : ''}`
  const style: React.CSSProperties = {
    fontWeight: active ? 600 : 400,
    marginBottom: '2px',
    opacity: disabled ? 0.55 : 1,
    cursor: disabled ? 'default' : 'pointer',
  }
  const body = (
    <>
      <span style={{ color: active ? '#DC1F2E' : '#A0A9BE', display: 'flex', alignItems: 'center' }}>
        {icon}
      </span>
      {label}
      {badge && <span className="boe-nav-badge amber">{badge}</span>}
    </>
  )

  if (disabled || !href) {
    return (
      <button
        className={className}
        disabled={disabled}
        title={disabled ? 'Coming soon' : undefined}
        style={style}
      >
        {body}
      </button>
    )
  }

  return (
    <Link
      href={href}
      replace={replace}
      onClick={onNavigate}
      className={className}
      aria-current={active ? 'page' : undefined}
      style={{ ...style, textDecoration: 'none' }}
    >
      {body}
    </Link>
  )
}
