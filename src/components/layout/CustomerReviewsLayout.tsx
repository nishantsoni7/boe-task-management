'use client'

import { useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { BarChart3, Home, Image as ImageIcon, Layers, MessageSquareHeart, Sparkles } from 'lucide-react'
import type { UserProfile } from '@/lib/types'
import { BoeBrandIcon } from './BoeBrandIcon'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'

// The Review Workflow module shell.
//
// Complies with the BOE Module Layout Standard, same as MeetingsLayout: two
// columns, a module header with a Home button back to /modules, module-only
// navigation in the middle, and the shared user area at the bottom. No
// cross-module links.
//
// FIVE DESTINATIONS FOR A VERIFIER, ONE FOR A CANDIDATE:
//
//   Overview       what needs attention right now. The verifier's landing page.
//   Reviews        the operational queue. The four workflow states live inside
//                  it as tabs, because a state filters one queue rather than
//                  being a place of its own.
//   Batches        generate → review → approve → assign, in one workspace.
//   Image Library  the project image groups an image review draws from.
//   Progress       assigned / posted / verified / remaining, per employee.
//
//   My Reviews     the candidate's single screen, and their only entry. It is
//                  the same route as Overview; what it renders depends on
//                  whether the viewer resolves `verify`.
//
// THERE IS NO HISTORY ENTRY, AND THAT IS DELIBERATE. A verified card is
// finished, and the product owner's rule is that a finished card appears in no
// frontend list at all. The record and its audit trail stay in the database —
// nothing is deleted — but the module offers no screen that reads them back.
// Adding one later would be a new feature, not a restoration.

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
  icon: React.ReactNode
  /** Only `pathname === path` lights this item. The module root needs it. */
  exact?: boolean
  verifierOnly?: boolean
}

/**
 * FIVE DESTINATIONS FOR A VERIFIER, ONE FOR A CANDIDATE — and each is a place,
 * not a filter.
 *
 * WHAT THIS REPLACED, AND WHY. The sidebar used to list the five workflow
 * STATES, every entry pointing at `/customer-reviews?tab=…`, while the page
 * body rendered the same five as tabs. Two controls, one query parameter: the
 * sidebar told you where you were and the tab strip told you the same thing
 * again, and neither could show you anything the other could not. A state is
 * not a destination — it is a filter over one queue, and it belongs inside that
 * queue's page.
 *
 * A candidate now has ONE entry. They used to have two, Available and My
 * reviews, which split one question ("what work do I have?") across two screens
 * and made every summary number partial.
 */
const NAV_ITEMS: NavItem[] = [
  // The candidate's only entry, and the verifier's landing page. One route,
  // two audiences: a verifier gets Overview, a candidate gets My Reviews.
  {
    label: 'My Reviews',
    path: '/customer-reviews',
    icon: <MessageSquareHeart size={15} strokeWidth={1.8} />,
    exact: true,
  },
  {
    label: 'Reviews',
    path: '/customer-reviews/reviews',
    icon: <Layers size={15} strokeWidth={1.8} />,
    verifierOnly: true,
  },
  {
    label: 'Batches',
    path: '/customer-reviews/batches',
    icon: <Sparkles size={15} strokeWidth={1.8} />,
    verifierOnly: true,
  },
  {
    label: 'Image Library',
    path: '/customer-reviews/images',
    icon: <ImageIcon size={15} strokeWidth={1.8} />,
    verifierOnly: true,
  },
  {
    label: 'Progress',
    path: '/customer-reviews/progress',
    icon: <BarChart3 size={15} strokeWidth={1.8} />,
    verifierOnly: true,
  },
]

/** The verifier's landing page is Overview; the candidate's is their own work. */
const ROOT_LABEL = { verifier: 'Overview', candidate: 'My Reviews' } as const

export function CustomerReviewsLayout({
  profile, title, subtitle, actions, canVerify, onSignOut, children,
}: CustomerReviewsLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const router = useRouter()
  const pathname = usePathname()

  const items = NAV_ITEMS
    .filter(item => !item.verifierOnly || canVerify)
    // The root entry is Overview for a verifier and My Reviews for everybody
    // else. It is the same route; what it renders differs, so the label has to.
    .map(item => (item.exact && canVerify ? { ...item, label: ROOT_LABEL.verifier } : item))

  // BY ROUTE, not by query — the same shape MeetingsLayout uses. The root is
  // `exact` because otherwise it would claim every page beneath it.
  //
  // A DETAIL SCREEN LIGHTS NOTHING, deliberately. `/customer-reviews/<id>` is
  // not one of the five questions the nav asks, and pretending "Reviews" is
  // selected while somebody reads one card tells them nothing true.
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
              <div className="boe-sidebar-brand-sub">Review Workflow</div>
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
