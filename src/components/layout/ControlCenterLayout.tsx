'use client'

import { Suspense, useState } from 'react'
import Link from 'next/link'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import {
  Home, LayoutGrid, Building2, Users, Briefcase, ShieldCheck, Layers, X, Hash, Eraser, DatabaseZap,
} from 'lucide-react'
import { BoeBrandIcon } from './BoeBrandIcon'
import type { UserProfile } from '@/lib/types'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'
import cc from '@/components/controlCenter/controlCenter.module.css'

// 'modules' (Module Visibility) is retained so the existing ?tab=modules URL
// still resolves for rollback, but it is not reachable from the sidebar — see
// the note in ControlCenterNav.
export type ControlCenterTab = 'overview' | 'departments' | 'people' | 'modules' | 'order-numbering'

const MAIN_PATH = '/admin/control-center'

/** The section the main page shows for a ?tab= value. Anything unknown is Overview. */
export function resolveControlCenterTab(tabParam: string | null): ControlCenterTab {
  return tabParam === 'departments' || tabParam === 'people' || tabParam === 'modules'
    || tabParam === 'order-numbering'
    ? tabParam : 'overview'
}

type Heading = { group?: string; title: string; subtitle?: string }

// One heading per destination. The shell is mounted once by
// control-center/layout.tsx and owns the header, so a section never hands over
// its own title on mount.
const TAB_HEADINGS: Record<ControlCenterTab, Heading> = {
  overview: {
    title: 'Control Center',
    subtitle: 'Administration workspace for people, access and system controls.',
  },
  people: {
    group: 'People', title: 'Employees',
    subtitle: 'Everyone with a BOE account — department, role, position and status.',
  },
  departments: {
    group: 'People', title: 'Departments',
    subtitle: 'Company departments used for assignment and access defaults.',
  },
  modules: {
    group: 'System', title: 'Module Visibility',
    subtitle: 'Control which modules appear in the app launcher, and to whom.',
  },
  'order-numbering': {
    group: 'System', title: 'Order Numbering',
    subtitle: 'The number the next Confirmed Order will be given.',
  },
}

const PATH_HEADINGS: Record<string, Heading> = {
  [`${MAIN_PATH}/positions`]: {
    group: 'People', title: 'Positions',
    subtitle: 'Job titles available on employee records.',
  },
  [`${MAIN_PATH}/permissions`]: {
    group: 'Access', title: 'By Employee',
    subtitle: 'Manage what each employee can access, module by module',
  },
  [`${MAIN_PATH}/permissions/modules`]: {
    group: 'Access', title: 'By Module',
    subtitle: 'One module across everyone — who can open it, at what level, and why',
  },
  [`${MAIN_PATH}/test-data-cleanup`]: {
    group: 'System', title: 'Test Data Cleanup',
    subtitle: 'Remove a complete verified test transaction while the system is in testing.',
  },
  [`${MAIN_PATH}/data-management`]: {
    group: 'System', title: 'Data Management',
    subtitle: 'Clear all operational Order and Finance data. Admin only, and never reversible.',
  },
  [`${MAIN_PATH}/action-queue`]: {
    title: 'Action Queue',
    subtitle: 'Finance and Orders work currently waiting on an admin action',
  },
}

function headingFor(pathname: string, tab: ControlCenterTab | null): Heading {
  if (pathname === MAIN_PATH) return TAB_HEADINGS[tab ?? 'overview']
  return PATH_HEADINGS[pathname] ?? { title: 'Control Center' }
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

  const closeSidebar = () => setSidebarOpen(false)
  const goHome = () => { router.push('/modules'); closeSidebar() }

  return (
    <div className="boe-app-shell">

      {/* Mobile overlay */}
      <div className={`boe-sidebar-overlay${sidebarOpen ? ' open' : ''}`} onClick={closeSidebar} />

      {/* Sidebar */}
      <aside className={`boe-sidebar${sidebarOpen ? ' open' : ''}`}>

        <div className="boe-sidebar-brand" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
            <BoeBrandIcon />
            <div style={{ minWidth: 0 }}>
              <div className="boe-sidebar-brand-name">Control Center</div>
              <div className="boe-sidebar-brand-sub">BOE Operating System</div>
            </div>
          </div>
          <button
            onClick={goHome}
            title="BOE OS Home"
            aria-label="BOE OS Home"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, borderRadius: '7px',
              background: 'rgba(220,31,46,0.08)',
              border: '1px solid rgba(220,31,46,0.20)',
              color: '#DC1F2E', cursor: 'pointer', flexShrink: 0,
            }}
          >
            <Home size={14} strokeWidth={2} />
          </button>
        </div>

        {/* Navigation. The active tab is read from the URL inside a Suspense
            boundary, as useSearchParams asks; the fallback is the same list
            with no tab known, which only ever renders during prerender. */}
        <Suspense fallback={<ControlCenterNav pathname={pathname} tab={null} onNavigate={closeSidebar} />}>
          <ControlCenterNavWithTab pathname={pathname} onNavigate={closeSidebar} />
        </Suspense>

        <ViewModeSidebarSection
          profile={profile}
          onSignOut={onSignOut}
          accountSettingsHref="/account?returnTo=/admin/control-center"
        />
      </aside>

      {/* Main content */}
      <div className="boe-main-content">
        <Suspense fallback={<ControlCenterHeader pathname={pathname} tab={null} sidebarOpen={sidebarOpen} onToggle={() => setSidebarOpen(o => !o)} onHome={goHome} />}>
          <ControlCenterHeaderWithTab pathname={pathname} sidebarOpen={sidebarOpen} onToggle={() => setSidebarOpen(o => !o)} onHome={goHome} />
        </Suspense>

        <div className="boe-page-body">
          <div className={cc.content}>
            <ViewModeBanner />
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Header ───────────────────────────────────────────────────────────────────

type HeaderProps = {
  pathname: string
  tab: ControlCenterTab | null
  sidebarOpen: boolean
  onToggle: () => void
  onHome: () => void
}

function ControlCenterHeaderWithTab(props: Omit<HeaderProps, 'tab'>) {
  const tab = resolveControlCenterTab(useSearchParams().get('tab'))
  return <ControlCenterHeader {...props} tab={tab} />
}

function ControlCenterHeader({ pathname, tab, sidebarOpen, onToggle, onHome }: HeaderProps) {
  const heading = headingFor(pathname, tab)
  return (
    <div className="boe-page-header">
      <button className="boe-menu-toggle" onClick={onToggle} aria-label="Open menu">
        {sidebarOpen ? <X size={18} /> : '☰'}
      </button>
      <div className="boe-page-title-group">
        {heading.group && <div className={cc.eyebrow}>{heading.group}</div>}
        <div className="boe-page-title">{heading.title}</div>
        {heading.subtitle && <div className="boe-page-subtitle">{heading.subtitle}</div>}
      </div>
      <div className="boe-header-actions">
        <button
          onClick={onHome}
          title="BOE OS Home"
          aria-label="BOE OS Home"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 32, height: 32, borderRadius: '8px',
            background: 'rgba(0,0,0,0.05)',
            border: '1px solid rgba(0,0,0,0.10)',
            color: '#6B7384', cursor: 'pointer', flexShrink: 0,
          }}
        >
          <Home size={14} strokeWidth={2} />
        </button>
      </div>
    </div>
  )
}

// ── Navigation ───────────────────────────────────────────────────────────────

function ControlCenterNavWithTab({ pathname, onNavigate }: { pathname: string; onNavigate: () => void }) {
  const tab = resolveControlCenterTab(useSearchParams().get('tab'))
  return <ControlCenterNav pathname={pathname} tab={tab} onNavigate={onNavigate} />
}

// Every entry is a real link, so Next prefetches it and Back/Forward walk
// through sections. Overview, Employees, Departments and Order Numbering are
// tabs of the main page: on that page a tab link REPLACES the history entry,
// exactly as the in-place switch always did; from any other section it pushes.
//
// What is deliberately NOT here:
//   Roles              — nothing manages roles; the three values are fixed in
//                        code and shown as a field on the employee.
//   Module Visibility  — a second, parallel way to decide who sees a module,
//                        retired from navigation in favour of Access Control.
//                        ?tab=modules still resolves for rollback.
//   Action Queue       — every row was a deep link into Finance or Orders; it
//                        decided nothing. The route remains for old bookmarks.
//   Change History     — does not exist yet, so it is not offered.
function ControlCenterNav({
  pathname, tab, onNavigate,
}: {
  pathname: string
  tab: ControlCenterTab | null
  onNavigate: () => void
}) {
  const onMain = pathname === MAIN_PATH
  const tabHref = (t: ControlCenterTab) => `${MAIN_PATH}?tab=${t}`
  const icon = (I: typeof Home) => <I size={15} strokeWidth={1.8} />

  return (
    <nav className="boe-sidebar-section" aria-label="Control Center">
      <NavItem
        label="Overview"
        icon={icon(LayoutGrid)}
        href={tabHref('overview')}
        replace={onMain}
        active={onMain && (tab === null || tab === 'overview')}
        onNavigate={onNavigate}
      />

      <div className={cc.navGroup}>
        <span className={cc.navGroupLabel}>People</span>
        <NavItem
          label="Employees"
          icon={icon(Users)}
          href={tabHref('people')}
          replace={onMain}
          active={onMain && tab === 'people'}
          onNavigate={onNavigate}
        />
        <NavItem
          label="Departments"
          icon={icon(Building2)}
          href={tabHref('departments')}
          replace={onMain}
          active={onMain && tab === 'departments'}
          onNavigate={onNavigate}
        />
        <NavItem
          label="Positions"
          icon={icon(Briefcase)}
          href={`${MAIN_PATH}/positions`}
          active={pathname === `${MAIN_PATH}/positions`}
          onNavigate={onNavigate}
        />
      </div>

      <div className={cc.navGroup}>
        <span className={cc.navGroupLabel}>Access</span>
        <NavItem
          label="By Employee"
          icon={icon(ShieldCheck)}
          href={`${MAIN_PATH}/permissions`}
          active={pathname === `${MAIN_PATH}/permissions`}
          onNavigate={onNavigate}
        />
        <NavItem
          label="By Module"
          icon={icon(Layers)}
          href={`${MAIN_PATH}/permissions/modules`}
          active={pathname === `${MAIN_PATH}/permissions/modules`}
          onNavigate={onNavigate}
        />
      </div>

      <div className={cc.navGroup}>
        <span className={cc.navGroupLabel}>System</span>
        <NavItem
          label="Order Numbering"
          icon={icon(Hash)}
          href={tabHref('order-numbering')}
          replace={onMain}
          active={onMain && tab === 'order-numbering'}
          onNavigate={onNavigate}
        />
        {/* Test Data Cleanup removes ONE transaction, found by searching for
            it. Data Management clears a MODULE. Two entries, on purpose. */}
        <NavItem
          label="Test Data Cleanup"
          icon={icon(Eraser)}
          href={`${MAIN_PATH}/test-data-cleanup`}
          active={pathname === `${MAIN_PATH}/test-data-cleanup`}
          onNavigate={onNavigate}
        />
        <NavItem
          label="Data Management"
          icon={icon(DatabaseZap)}
          href={`${MAIN_PATH}/data-management`}
          active={pathname === `${MAIN_PATH}/data-management`}
          onNavigate={onNavigate}
        />
      </div>
    </nav>
  )
}

function NavItem({
  label, icon, active, href, replace, onNavigate,
}: {
  label: string
  icon: React.ReactNode
  active: boolean
  href: string
  /** Replace the history entry instead of pushing one. */
  replace?: boolean
  onNavigate?: () => void
}) {
  return (
    <Link
      href={href}
      replace={replace}
      onClick={onNavigate}
      className={`boe-nav-item${active ? ' active' : ''}`}
      aria-current={active ? 'page' : undefined}
      style={{ fontWeight: active ? 600 : 400, marginBottom: '2px', textDecoration: 'none' }}
    >
      <span style={{ color: active ? '#DC1F2E' : '#A0A9BE', display: 'flex', alignItems: 'center' }}>
        {icon}
      </span>
      {label}
    </Link>
  )
}
