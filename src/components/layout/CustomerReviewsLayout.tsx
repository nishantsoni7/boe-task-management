'use client'

import { useState } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { History, Home, Layers, MessageSquareHeart, ShieldCheck } from 'lucide-react'
import type { UserProfile } from '@/lib/types'
import { BoeBrandIcon } from './BoeBrandIcon'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'

// The Review Workflow Test (Internal) module shell.
//
// Complies with the BOE Module Layout Standard, same as MeetingsLayout: two
// columns, a module header with a Home button back to /modules, module-only
// navigation in the middle, and the shared user area at the bottom. No
// cross-module links.
//
// FOUR entries, because the module has two audiences asking two questions each:
//
//   Available   the unbooked pool. Anyone who may use the module sees it.
//   My tests    the cards this person is holding or has submitted.
//   To Verify   what is waiting for somebody to check it. Verifier only,
//               because for anybody else it would be an empty screen with a
//               promising name.
//   History     verified tests, kept for the record. Verifier only, and it is
//               the ONLY place a verified card appears — it leaves both active
//               lists the moment it is verified.

type CustomerReviewsLayoutProps = {
  profile: UserProfile | null
  title: string
  subtitle?: string
  actions?: React.ReactNode
  /** Verifier-only navigation. Hidden entirely for everyone else. */
  canVerify: boolean
  onSignOut: () => void
  children: React.ReactNode
}

type NavItem = {
  label: string
  path: string
  query?: string
  icon: React.ReactNode
  verifierOnly?: boolean
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Available', path: '/customer-reviews', query: 'tab=available', icon: <Layers size={15} strokeWidth={1.8} /> },
  { label: 'My tests',  path: '/customer-reviews', query: 'tab=mine',      icon: <MessageSquareHeart size={15} strokeWidth={1.8} /> },
  {
    label: 'To Verify',
    path: '/customer-reviews',
    query: 'tab=to_verify',
    icon: <ShieldCheck size={15} strokeWidth={1.8} />,
    verifierOnly: true,
  },
  {
    label: 'History',
    path: '/customer-reviews',
    query: 'tab=history',
    icon: <History size={15} strokeWidth={1.8} />,
    verifierOnly: true,
  },
]

export function CustomerReviewsLayout({
  profile, title, subtitle, actions, canVerify, onSignOut, children,
}: CustomerReviewsLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const items = NAV_ITEMS.filter(item => !item.verifierOnly || canVerify)
  const href = (item: NavItem) => (item.query ? `${item.path}?${item.query}` : item.path)

  // Only the list route highlights an entry at all — a detail screen is not one
  // of the four questions the nav asks, so nothing lights up there. That is
  // honest rather than tidy: pretending "Available" is selected while the user
  // is reading one card tells them nothing.
  //
  // EVERY ENTRY NOW CARRIES A QUERY, so the highlight has to read the actual
  // tab rather than "the one without a query". An earlier version returned
  // `!item.query`, which was correct while one entry had none and silently
  // highlighted nothing once they all did.
  const activeTab = searchParams.get('tab') ?? 'available'
  const isActive = (item: NavItem): boolean => {
    if (pathname !== '/customer-reviews') return false
    return item.query === `tab=${activeTab}`
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

        <div
          className="boe-sidebar-brand"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <BoeBrandIcon />
            <div>
              <div className="boe-sidebar-brand-name">BOE</div>
              <div className="boe-sidebar-brand-sub">Workflow Test</div>
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
                key={`${item.path}-${item.query ?? ''}`}
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
          accountSettingsHref="/account?returnTo=/customer-reviews"
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
