'use client'

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import {
  Home, LayoutGrid, Users, ShieldCheck, Hash, DatabaseZap, Megaphone, Search, X,
} from 'lucide-react'
import { BoeBrandIcon } from './BoeBrandIcon'
import type { UserProfile } from '@/lib/types'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'
import { FindAnything } from '@/components/controlCenter/FindAnything'
import {
  MAIN_PATH, NAV_HUBS, activeHub, hubHref, isSectionActive, resolveControlCenterTab,
  type ControlCenterTab, type HubId, type NavHub,
} from '@/lib/controlCenter/navModel'
import cc from '@/components/controlCenter/controlCenter.module.css'

// The map itself (hubs, sections, search keywords, which one is active) lives in
// '@/lib/controlCenter/navModel'. This file draws it.
export { resolveControlCenterTab }
export type { ControlCenterTab }

type Heading = { group?: string; title: string; subtitle?: string }

// One heading per destination. The shell is mounted once by
// control-center/layout.tsx and owns the header, so a section never hands over
// its own title on mount. `group` is the hub the screen belongs to.
const TAB_HEADINGS: Record<ControlCenterTab, Heading> = {
  overview: {
    title: 'Control Center',
    subtitle: 'What is waiting on you, what needs attention, and the jobs you do most.',
  },
  // Retained so an old ?tab=people bookmark still names something while the
  // main page redirects it to /people, where employee administration now lives.
  people: {
    group: 'People', title: 'Employees',
    subtitle: 'Everyone with a BOE account — department, designation, level and status.',
  },
  departments: {
    group: 'People', title: 'Departments',
    subtitle: 'Company departments used for assignment and access defaults.',
  },
  modules: {
    group: 'Access', title: 'Module Visibility',
    subtitle: 'Control which modules appear in the app launcher, and to whom.',
  },
  'order-numbering': {
    group: 'Order Setup', title: 'Numbering',
    subtitle: 'The number the next Confirmed Order will be given.',
  },
  'order-notifications': {
    group: 'Order Setup', title: 'Notifications',
    subtitle: 'Which associated people are told when a Confirmed Order changes.',
  },
  'operations-handoff': {
    group: 'Order Setup', title: 'Operations Handoff',
    subtitle: 'Who reviews each approved PI version for production and accepts it, or asks for clarification.',
  },
  'order-visibility': {
    group: 'Order Setup', title: 'Order Visibility',
    subtitle: 'Whose orders each sales candidate can see: their own, selected colleagues’, or all sales candidates’.',
  },
}

const PATH_HEADINGS: Record<string, Heading> = {
  [`${MAIN_PATH}/people`]: {
    group: 'People', title: 'Employees',
    subtitle: 'Add, edit and retire employee accounts — department, designation, level, status and access.',
  },
  [`${MAIN_PATH}/positions`]: {
    group: 'People', title: 'Designations',
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
    group: 'Records & Data', title: 'Test Data Cleanup',
    subtitle: 'Remove a complete verified test transaction while the system is in testing.',
  },
  [`${MAIN_PATH}/announcements`]: {
    title: 'Announcements',
    subtitle: 'Publish a notice to chosen employees for a set of dates, and see who has read it.',
  },
  [`${MAIN_PATH}/data-management`]: {
    group: 'Records & Data', title: 'Data Management',
    subtitle: 'Clear all operational Order and Finance data. Admin only, and never reversible.',
  },
  [`${MAIN_PATH}/action-queue`]: {
    group: 'Home', title: 'Action Queue',
    subtitle: 'Finance and Orders work currently waiting on an admin action',
  },
}

function headingFor(pathname: string, tab: ControlCenterTab | null): Heading {
  if (pathname === MAIN_PATH) return TAB_HEADINGS[tab ?? 'overview']
  return PATH_HEADINGS[pathname] ?? { title: 'Control Center' }
}

const HUB_ICON: Record<HubId, typeof Home> = {
  home: LayoutGrid, people: Users, access: ShieldCheck, orders: Hash,
  announcements: Megaphone, records: DatabaseZap,
}

type ControlCenterLayoutProps = {
  profile: UserProfile | null
  onSignOut: () => void
  children: React.ReactNode
}

export function ControlCenterLayout({ profile, onSignOut, children }: ControlCenterLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [finding, setFinding] = useState(false)
  const router   = useRouter()
  const pathname = usePathname()

  const closeSidebar = () => setSidebarOpen(false)
  const goHome = () => { router.push('/modules'); closeSidebar() }
  const openFind = () => { setFinding(true); closeSidebar() }

  // Ctrl/Cmd+K from anywhere in the Control Center. "/" works too when the
  // focus is not in a field, so typing into a form never opens the box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setFinding(f => !f)
        return
      }
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const el = e.target as HTMLElement | null
        const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
        if (!typing) { e.preventDefault(); setFinding(true) }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
              width: 28, height: 28, borderRadius: '8px',
              background: 'rgba(185,71,46,0.08)',
              border: '1px solid rgba(185,71,46,0.20)',
              color: '#B9472E', cursor: 'pointer', flexShrink: 0,
            }}
          >
            <Home size={14} strokeWidth={2} />
          </button>
        </div>

        <button className={cc.navFind} onClick={openFind} aria-label="Find anything" aria-keyshortcuts="Control+K Meta+K">
          <Search size={13} strokeWidth={2} />
          <span className={cc.navFindText}>Find anything…</span>
          <span className={cc.kbd}>Ctrl K</span>
        </button>

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
            <Suspense fallback={null}>
              <SectionTabsWithTab pathname={pathname} />
            </Suspense>
            {children}
          </div>
        </div>
      </div>

      {finding && <FindAnything onClose={() => setFinding(false)} />}
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
            border: '1px solid #CFC8BF',
            color: '#686D6C', cursor: 'pointer', flexShrink: 0,
          }}
        >
          <Home size={14} strokeWidth={2} />
        </button>
      </div>
    </div>
  )
}

// ── Section tabs ─────────────────────────────────────────────────────────────
//
// The screens inside the hub on show, side by side. A hub with one screen
// (Home, Announcements) shows nothing; Action Queue sits outside the map and
// shows nothing either.

function SectionTabsWithTab({ pathname }: { pathname: string }) {
  const tab = resolveControlCenterTab(useSearchParams().get('tab'))
  const loc = { pathname, tab }
  const hub = activeHub(loc)
  if (!hub || hub.sections.length < 2) return null
  const onMain = pathname === MAIN_PATH

  return (
    <nav className={`${cc.sectionTabs}${hub.danger ? ` ${cc.sectionTabsDanger}` : ''}`} aria-label={hub.label}>
      {hub.sections.map(s => {
        const active = isSectionActive(s, loc) || (s.id === 'by-module' && pathname === MAIN_PATH && tab === 'modules')
        return (
          <Link
            key={s.id}
            href={s.href}
            // Switching between two tabs of the main page replaces the history
            // entry, as the in-place switch always did.
            replace={onMain && !!s.tab}
            className={`${cc.sectionTab}${active ? ` ${cc.sectionTabActive}` : ''}`}
            aria-current={active ? 'page' : undefined}
          >
            {s.label}
          </Link>
        )
      })}
    </nav>
  )
}

// ── Navigation ───────────────────────────────────────────────────────────────

function ControlCenterNavWithTab({ pathname, onNavigate }: { pathname: string; onNavigate: () => void }) {
  const tab = resolveControlCenterTab(useSearchParams().get('tab'))
  return <ControlCenterNav pathname={pathname} tab={tab} onNavigate={onNavigate} />
}

// Six entries, one per task area; each hub's other screens are the tabs above
// its page. Every entry is a real link, so Next prefetches it and Back/Forward
// walk through sections.
//
// What is deliberately NOT here:
//   Roles              — nothing manages the three system roles; they are fixed
//                        in code and set as a field on the employee.
//   Module Visibility  — a second, parallel way to decide who sees a module,
//                        retired in favour of Access. ?tab=modules still resolves.
//   Action Queue       — it decided nothing itself (every row is a deep link into
//                        Finance or Orders), so it is no sidebar entry; Home
//                        shows its counts and links to the full list.
//   Change History     — does not exist yet, so it is not offered.
function ControlCenterNav({
  pathname, tab, onNavigate,
}: {
  pathname: string
  tab: ControlCenterTab | null
  onNavigate: () => void
}) {
  const loc = { pathname, tab }
  const current = activeHub(loc)
  const onMain = pathname === MAIN_PATH
  const everyday = NAV_HUBS.filter(h => !h.danger)
  const danger = NAV_HUBS.filter(h => h.danger)

  const item = (hub: NavHub) => {
    const Icon = HUB_ICON[hub.id]
    const active = current?.id === hub.id
    return (
      <NavItem
        key={hub.id}
        label={hub.label}
        icon={<Icon size={15} strokeWidth={1.8} />}
        href={hubHref(hub)}
        replace={onMain && !!hub.sections[0].tab}
        active={active}
        danger={hub.danger}
        onNavigate={onNavigate}
      />
    )
  }

  return (
    <nav className="boe-sidebar-section" aria-label="Control Center">
      {everyday.map(item)}
      <div className={cc.navDivider} />
      {danger.map(item)}
    </nav>
  )
}

function NavItem({
  label, icon, active, href, replace, danger, onNavigate,
}: {
  label: string
  icon: React.ReactNode
  active: boolean
  href: string
  /** Replace the history entry instead of pushing one. */
  replace?: boolean
  /** Records & Data: apart from the everyday entries, in the warning colour. */
  danger?: boolean
  onNavigate?: () => void
}) {
  return (
    <Link
      href={href}
      replace={replace}
      onClick={onNavigate}
      className={`boe-nav-item${active ? ' active' : ''}${danger ? ` ${cc.navDanger}` : ''}`}
      aria-current={active ? 'page' : undefined}
      style={{
        fontWeight: active ? 600 : 400, marginBottom: '2px', textDecoration: 'none',
        color: danger && !active ? '#A12438' : undefined,
      }}
    >
      <span style={{ color: active ? '#B9472E' : '#686D6C', display: 'flex', alignItems: 'center' }}>
        {icon}
      </span>
      {label}
    </Link>
  )
}
