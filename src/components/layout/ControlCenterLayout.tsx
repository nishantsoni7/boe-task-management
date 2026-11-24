'use client'

import { PageBackButton } from '@/components/layout/PageBackButton'
import { Suspense, useEffect, useState } from 'react'
import { AppLink as Link } from '@/components/ui/AppLink'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { ChevronRight, Home, LayoutGrid, Search, X } from 'lucide-react'
import { BoeBrandIcon } from './BoeBrandIcon'
import type { UserProfile } from '@/lib/types'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'
import { FindAnything } from '@/components/controlCenter/FindAnything'
import { HUB_ICON } from '@/components/controlCenter/hubIcons'
import {
  MAIN_PATH, NAV_HUBS, activeHub, activeSection, hubHref, isSectionActive, resolveControlCenterTab, sectionById,
  type ControlCenterTab, type HubId, type NavHub, type NavLocation, type NavSection,
} from '@/lib/controlCenter/navModel'
import { rememberSection } from '@/lib/controlCenter/recent'
import { SidebarPinButton, railShellClass, useSidebarPinned } from './RailControls'
import cc from '@/components/controlCenter/controlCenter.module.css'

// The map itself (areas, settings, search keywords, which one is active) lives in
// '@/lib/controlCenter/navModel'. This file draws it: the sidebar, the page header
// with its breadcrumb, and the one-line "affects / related" strip under it.
export { resolveControlCenterTab }
export type { ControlCenterTab }

type Heading = { title: string; subtitle: string; section: (NavSection & { hub: NavHub }) | null }

// One heading per destination, read from the registry so the title and the sidebar can never disagree.
// Home, and any screen outside the map, is plain "Control Center". The shell is mounted once by
// control-center/layout.tsx and owns the header, so a section never hands over its own title on mount.
function headingFor(loc: NavLocation): Heading {
  const section = activeSection(loc)
  if (!section || section.id === 'home') {
    return { title: 'Control Center', subtitle: 'Find any setting in one step.', section: null }
  }
  return { title: section.label, subtitle: section.description, section }
}

type ControlCenterLayoutProps = {
  profile: UserProfile | null
  onSignOut: () => void
  children: React.ReactNode
}

export function ControlCenterLayout({ profile, onSignOut, children }: ControlCenterLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [finding, setFinding] = useState(false)
  // Desktop-with-a-mouse only: the sidebar rests as an icon rail and opens over
  // the page on hover, unless pinned. Elsewhere this changes nothing. Here it starts
  // PINNED for a browser that has never chosen: a new administrator should read the
  // labels, not guess from nine icons. Anyone who unpins keeps their choice.
  const [railPinned, toggleRailPinned] = useSidebarPinned(true)
  const router  = useRouter()
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
    <div className={railShellClass(railPinned)}>

      {/* Mobile overlay */}
      <div className={`boe-sidebar-overlay${sidebarOpen ? ' open' : ''}`} onClick={closeSidebar} />

      {/* Sidebar */}
      <aside className={`boe-sidebar${sidebarOpen ? ' open' : ''}`}>

        <div className="boe-sidebar-brand" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
            <BoeBrandIcon />
            <div className="boe-rail-label" style={{ minWidth: 0 }}>
              <div className="boe-sidebar-brand-name">Control Center</div>
              <div className="boe-sidebar-brand-sub">BOE One</div>
            </div>
          </div>
          <button
            className="boe-rail-label"
            onClick={goHome}
            title="BOE One Home"
            aria-label="BOE One Home"
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

        <button className={cc.navFind} onClick={openFind} aria-label="Search settings" title="Search settings" aria-keyshortcuts="Control+K Meta+K">
          <Search size={14} strokeWidth={2} />
          <span className={`${cc.navFindText} boe-rail-label`}>Search settings…</span>
          <span className={`${cc.kbd} boe-rail-label`}>Ctrl K</span>
        </button>

        {/* Navigation. The active tab is read from the URL inside a Suspense
            boundary, as useSearchParams asks; the fallback is the same list
            with no tab known, which only ever renders during prerender. */}
        <Suspense fallback={<ControlCenterNav pathname={pathname} tab={null} onNavigate={closeSidebar} />}>
          <ControlCenterNavWithTab pathname={pathname} onNavigate={closeSidebar} />
        </Suspense>

        <div className="boe-sidebar-foot">
          <SidebarPinButton pinned={railPinned} onToggle={toggleRailPinned} />
          <ViewModeSidebarSection
            profile={profile}
            onSignOut={onSignOut}
            accountSettingsHref="/account?returnTo=/admin/control-center"
          />
        </div>
      </aside>

      {/* Main content */}
      <div className="boe-main-content">
        <Suspense fallback={<ControlCenterHeader pathname={pathname} tab={null} sidebarOpen={sidebarOpen} onToggle={() => setSidebarOpen(o => !o)} onHome={goHome} onFind={openFind} />}>
          <ControlCenterHeaderWithTab pathname={pathname} sidebarOpen={sidebarOpen} onToggle={() => setSidebarOpen(o => !o)} onHome={goHome} onFind={openFind} />
        </Suspense>

        <div className="boe-page-body">
          <div className={cc.content}>
            <ViewModeBanner />
            <Suspense fallback={null}>
              <SectionContextWithTab pathname={pathname} />
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
  onFind: () => void
}

function ControlCenterHeaderWithTab(props: Omit<HeaderProps, 'tab'>) {
  const tab = resolveControlCenterTab(useSearchParams().get('tab'))
  return <ControlCenterHeader {...props} tab={tab} />
}

function ControlCenterHeader({ pathname, tab, sidebarOpen, onToggle, onHome, onFind }: HeaderProps) {
  const { title, subtitle, section } = headingFor({ pathname, tab })
  return (
    <div className="boe-page-header">
      <button className="boe-menu-toggle" onClick={onToggle} aria-label="Open menu">
        {sidebarOpen ? <X size={18} /> : '☰'}
      </button>
      <PageBackButton />
      <div className="boe-page-title-group">
        {section && (
          // Where you are. The way back is the header's one Back button; a phone drops the trail, the drawer names the rest.
          <nav className={cc.crumbs} aria-label="Breadcrumb">
            <span className={cc.crumbsFull}>
              <Link href={MAIN_PATH}>Control Center</Link>
              <ChevronRight size={13} aria-hidden="true" />
              <Link href={hubHref(section.hub)}>{section.hub.label}</Link>
              <ChevronRight size={13} aria-hidden="true" />
              <span aria-current="page">{section.label}</span>
            </span>
          </nav>
        )}
        <div className="boe-page-title">{title}</div>
        {subtitle && <div className="boe-page-subtitle">{subtitle}</div>}
      </div>
      <div className="boe-header-actions">
        <button className={cc.headFind} onClick={onFind} aria-label="Search settings" aria-keyshortcuts="Control+K Meta+K">
          <Search size={16} strokeWidth={2} aria-hidden="true" />
          <span className={cc.headFindText}>Search</span>
          <span className={cc.kbd}>Ctrl K</span>
        </button>
        <button
          onClick={onHome}
          title="BOE One Home"
          aria-label="BOE One Home"
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

// ── What a change here touches ───────────────────────────────────────────────
//
// One line under the title: who or what the setting affects (red when it cannot be
// undone) and the settings worth a look from here. It is a line, not a column,
// because the screens beneath it are wide and already tuned to the space they have.
// It also notes the screen in this tab's recent list, for Find anything.

function SectionContextWithTab({ pathname }: { pathname: string }) {
  const tab = resolveControlCenterTab(useSearchParams().get('tab'))
  const section = activeSection({ pathname, tab })
  const id = section?.id ?? null
  useEffect(() => { if (id && id !== 'home') rememberSection(id) }, [id])

  if (!section || section.id === 'home') return null
  const related = section.related.map(sectionById).filter((s): s is NonNullable<typeof s> => !!s)
  return (
    <div className={cc.context}>
      <span className={`${cc.contextItem}${section.irreversible ? ` ${cc.contextWarn}` : ''}`}>
        <b>Affects</b> {section.affects}
      </span>
      {related.length > 0 && (
        <span className={cc.contextItem}>
          <b>Related</b>
          {related.map(r => (
            <Link key={r.id} href={r.href} className={cc.contextLink}>{r.label}</Link>
          ))}
        </span>
      )}
    </div>
  )
}

// ── Navigation ───────────────────────────────────────────────────────────────

function ControlCenterNavWithTab({ pathname, onNavigate }: { pathname: string; onNavigate: () => void }) {
  const tab = resolveControlCenterTab(useSearchParams().get('tab'))
  return <ControlCenterNav pathname={pathname} tab={tab} onNavigate={onNavigate} />
}

// Home, then one entry per area. Only the area you are in is open, showing its pages
// underneath, so the list never grows past one screen and the pages are never hidden
// behind a second row of tabs. Every entry is a real link to a real route, so Back/Forward walk
// through every screen. Data & Safety sits apart, in the warning colour.
//
// What is deliberately NOT here:
//   Roles              — nothing manages the three system roles; they are fixed
//                        in code and set as a field on the employee.
//   Module Visibility  — a second, parallel way to decide who sees a module,
//                        retired in favour of Access. ?tab=modules still resolves.
//   Action Queue       — pending work shows on the dashboard of the module that
//                        owns it (Finance, Orders), never in the Control Center.
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
  // The one open area can be folded away by clicking it again. The fold belongs to that visit:
  // moving to another area (or back) forgets it.
  const [folded, setFolded] = useState<HubId | null>(null)
  const areas = NAV_HUBS.filter(h => h.id !== 'home')
  const navigate = () => { setFolded(null); onNavigate() }

  const area = (hub: NavHub) => {
    const Icon = HUB_ICON[hub.id]
    const here = current?.id === hub.id
    const open = here && folded !== hub.id
    return (
      <div key={hub.id}>
        <Link
          href={hubHref(hub)}
          onClick={e => {
            if (here) { e.preventDefault(); setFolded(open ? hub.id : null) } else navigate()
          }}
          className={`boe-nav-item${here ? ` ${cc.navHere}` : ''}${hub.danger ? ` ${cc.navDanger}` : ''}`}
          aria-expanded={here ? open : undefined}
          title={hub.label}
          style={{ marginBottom: '2px', textDecoration: 'none', color: hub.danger ? '#A12438' : undefined }}
        >
          <span style={{ color: here ? (hub.danger ? '#A12438' : '#B9472E') : '#686D6C', display: 'flex', alignItems: 'center' }}>
            <Icon size={15} strokeWidth={1.8} />
          </span>
          <span className="boe-rail-label">{hub.label}</span>
          <ChevronRight size={14} strokeWidth={2} className={`${cc.chev} boe-rail-label`} aria-hidden="true" />
        </Link>
        <div className={`${cc.subWrap}${open ? ` ${cc.subWrapOpen}` : ''}`}>
          {/* inert while folded: a hidden page must not be a tab stop. */}
          <div className={`boe-rail-tree ${cc.sub}`} inert={!open}>
            {hub.sections.map(s => {
              const active = isSectionActive(s, loc) || (s.id === 'by-module' && onMain && tab === 'modules') || (s.id === 'employees' && onMain && tab === 'people')
              return (
                <Link
                  key={s.id}
                  href={s.href}
                  onClick={navigate}
                  className={`boe-nav-item${active ? ' active' : ''}${hub.danger ? ` ${cc.navDangerSub}` : ''}`}
                  aria-current={active ? 'page' : undefined}
                  style={{ fontWeight: active ? 600 : 400, textDecoration: 'none' }}
                >
                  <span>{s.label}</span>
                </Link>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  const everyday = areas.filter(h => !h.danger)
  const danger = areas.filter(h => h.danger)
  const homeActive = current?.id === 'home'

  return (
    <nav className="boe-sidebar-section" aria-label="Control Center">
      <Link
        href={hubHref(NAV_HUBS[0])}
        onClick={navigate}
        className={`boe-nav-item${homeActive ? ' active' : ''}`}
        aria-current={homeActive ? 'page' : undefined}
        title="Home"
        style={{ fontWeight: homeActive ? 600 : 400, marginBottom: '2px', textDecoration: 'none' }}
      >
        <span style={{ color: homeActive ? '#B9472E' : '#686D6C', display: 'flex', alignItems: 'center' }}>
          <LayoutGrid size={15} strokeWidth={1.8} />
        </span>
        <span className="boe-rail-label">Home</span>
      </Link>
      <div className={`${cc.navLabel} boe-rail-ghost`}>Settings</div>
      {everyday.map(area)}
      <div className={cc.navDivider} />
      {danger.map(area)}
    </nav>
  )
}
