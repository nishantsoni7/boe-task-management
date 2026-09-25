'use client'

import { useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { Home, Megaphone, X } from 'lucide-react'
import { BoeBrandIcon } from './BoeBrandIcon'
import type { UserProfile } from '@/lib/types'
import { ViewModeSidebarSection } from './AdminViewModeControls'
import { QuickActionList, type QuickAction } from './QuickActions'

type BoeOsLayoutProps = {
  profile: UserProfile | null
  title: string
  subtitle?: string
  onSignOut: () => void
  /**
   * Quick actions the viewer is authorized for, already gated by the caller.
   * Rendered directly below Home and displayed only while the sidebar is
   * permanent; below 767px the page carries its own copy instead. Defaults
   * to none, so a caller that passes nothing gets the sidebar exactly as it
   * is today.
   */
  quickActions?: QuickAction[]
  /**
   * The page's own control, rendered at the right-hand end of the header row.
   *
   * ONE HEADER, NOT TWO. The launcher used to name itself twice — this header
   * said "BOE Operating System" over the date, and the page body opened with a
   * second heading block carrying its own title, its own supporting line and
   * its own divider. The page now puts its real title here, and the control
   * that belongs beside that title comes with it.
   *
   * `.boe-header-actions` is the class every other shell in this app already
   * uses for exactly this slot (Orders, Finance, Meetings, Assets and the rest),
   * so the placement, the spacing and the wrapping behaviour are the ones the
   * rest of the application already has. Optional: a caller that passes nothing
   * gets the header exactly as it was.
   */
  headerActions?: React.ReactNode
  /**
   * Caps the header row and the page body to one centred content column of
   * this many pixels, so a page whose content is a compact block (the Modules
   * launcher) shares its left and right edges with its own title and header
   * control instead of stretching across a wide screen. Applies only while the
   * sidebar is permanent; below 768px the usual gutters stand. Optional: a
   * caller that passes nothing gets the full-width shell exactly as before.
   */
  contentMaxWidth?: number
  /**
   * Unacknowledged announcements, shown as a count beside the Announcements
   * entry. Optional: a caller that has not loaded them shows the entry alone.
   */
  announcementUnread?: number
  children: React.ReactNode
}

export function BoeOsLayout({
  profile, title, subtitle, onSignOut, quickActions = [], headerActions = null,
  contentMaxWidth, announcementUnread = 0, children,
}: BoeOsLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const router   = useRouter()
  const pathname = usePathname()

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

        {/* Brand */}
        <div className="boe-sidebar-brand">
          <BoeBrandIcon />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="boe-sidebar-brand-name">BOE</div>
            <div className="boe-sidebar-brand-sub">Operating System</div>
          </div>
        </div>

        {/* Nav */}
        <div className="boe-sidebar-section">
          <OsNavItem
            label="Home"
            icon={<Home size={15} strokeWidth={1.8} />}
            active={pathname === '/modules'}
            onClick={() => navTo('/modules')}
          />
          {/* Announcements sits beside Home, not inside a module: a notice
              from the company is not Task Management's or anybody else's.
              Every active announcement for this person stays reachable here
              for its whole window, read or not. */}
          <OsNavItem
            label="Announcements"
            icon={<Megaphone size={15} strokeWidth={1.8} />}
            active={pathname?.startsWith('/announcements') ?? false}
            onClick={() => navTo('/announcements')}
            count={announcementUnread}
          />
          {/* Account Settings is NOT a second nav item here. The launcher
              carried it in this list and again at the foot of the sidebar; now
              that the foot is one identity menu, keeping it here would put the
              same destination on screen twice. The menu is the one place, and
              the route is unchanged. */}
        </div>

        {/* Quick actions, directly below Home so they sit near the top of the
            sidebar. Displayed only while this sidebar is permanent — below
            767px the launcher page carries the section instead, so it is
            never behind the menu button. See QuickActions.tsx.

            Nothing under this point moves: the identity block below still
            pins itself to the foot with margin-top: auto. */}
        <QuickActionList actions={quickActions} variant="sidebar" />

        {/* Bottom: profile + account settings + view as + sign out */}
        <ViewModeSidebarSection
          profile={profile}
          onSignOut={onSignOut}
          accountSettingsHref="/account?returnTo=/modules"
        />
      </aside>

      {/* Main content */}
      <div
        className={`boe-main-content${contentMaxWidth ? ' boe-main-content-capped' : ''}`}
        style={contentMaxWidth
          ? { '--boe-content-max': `${contentMaxWidth}px` } as React.CSSProperties
          : undefined}
      >

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
            {/* THE PAGE'S ONE HEADING. An <h1> rather than a styled div,
                because this line is now the page's title and not a strip of
                chrome above the real one — the launcher no longer repeats it
                in the body.

                The margin is set here rather than on `.boe-page-title`: that
                class is shared by ten other shells which all render it as a
                div, and a div has no default margin to cancel. Resetting it in
                globals.css would mean editing a rule every page in the app
                uses, to fix something only this element has. */}
            <h1 className="boe-page-title" style={{ margin: '0 0 2px' }}>{title}</h1>
            {subtitle && <div className="boe-page-subtitle">{subtitle}</div>}
          </div>
          {/* The page's own control, at the right-hand end of the same row.
              `.boe-page-header` is already `justify-content: space-between`
              with `flex-wrap: wrap`, so this sits opposite the title on a
              desktop and drops onto its own line before anything is squeezed.

              flexWrap/flexShrink match what Orders, Finance, Meetings, Assets,
              Image Editor and Performance already pass here. The base class is
              `flex-shrink: 0`, which is right for two icon buttons and wrong
              for edit mode with three labelled controls at 390px; with these,
              the row gives way instead of overflowing. */}
          {headerActions && (
            <div className="boe-header-actions" style={{ flexWrap: 'wrap', flexShrink: 1 }}>
              {headerActions}
            </div>
          )}
        </div>

        {/* Page body */}
        <div className="boe-page-body">
          {children}
        </div>

      </div>
    </div>
  )
}

// ── Sidebar nav item ──────────────────────────────────────────────────────────

function OsNavItem({
  label, icon, active, onClick, count = 0,
}: {
  label: string
  icon: React.ReactNode
  active: boolean
  onClick: () => void
  /** A red count pill, the one NotificationsNavItem uses. Hidden at zero. */
  count?: number
}) {
  return (
    <button
      className={`boe-nav-item${active ? ' active' : ''}`}
      onClick={onClick}
      aria-label={count > 0 ? `${label}, ${count} unread` : undefined}
      aria-current={active ? 'page' : undefined}
      style={{ fontWeight: active ? 600 : 400, marginBottom: '2px' }}
    >
      <span style={{ color: active ? '#DC1F2E' : '#A0A9BE', display: 'flex', alignItems: 'center' }}>
        {icon}
      </span>
      {label}
      {count > 0 && (
        <span
          aria-hidden="true"
          style={{
            marginLeft: 'auto',
            fontSize: '10px', fontWeight: 700, color: '#fff',
            background: '#DC1F2E', borderRadius: '999px',
            padding: '1px 6px', lineHeight: '15px', minWidth: '17px', textAlign: 'center',
          }}
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  )
}
