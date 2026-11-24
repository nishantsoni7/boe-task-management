'use client'

import { PageBackButton } from '@/components/layout/PageBackButton'
import { useMemo, useState } from 'react'
import { AppLink as Link } from '@/components/ui/AppLink'
import { usePathname, useRouter } from 'next/navigation'
import { GraduationCap, Home, LayoutDashboard } from 'lucide-react'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'
import { createClient } from '@/lib/supabase/client'
import { ModuleIcon } from '@/components/modules/ModuleIcons'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'
import { BoeBrandIcon } from './BoeBrandIcon'
import { SidebarPinButton, railShellClass, useSidebarPinned } from './RailControls'
import s from './comingSoonModule.module.css'

// A registered module with nothing inside it yet (Sales, Marketing, Pricing): the BOE Module Layout Standard
// shell around one notice. When the owner sets out what a module does, it gets its own layout and leaves this.

// A module that has grown a second page lists its pages here; the first one keeps the navLabel it was given.
// Pricing: the Price book, and Training (20270720000000), where a product's price is taught element by element.
const MORE_PAGES: Record<string, { href: string; label: string }[]> = {
  pricing: [{ href: '/pricing/training', label: 'Training' }, { href: '/pricing/woods', label: 'Wood and metal rates' }, { href: '/pricing/logic', label: 'Price logic' }],
}

const BADGE_CLASS = `boe-badge boe-badge-waiting ${s.badge}`

export function ComingSoonNotice({ moduleKey }: { moduleKey: string }) {
  return (
    <div className={s.wrap}>
      <div className={`boe-panel ${s.notice}`}>
        <div className={s.icon}><ModuleIcon moduleKey={moduleKey} size={22} /></div>
        <span className={BADGE_CLASS}>Coming soon</span>
        <p className={s.text}>This module is being built. It will open here when it is ready.</p>
        <Link href="/modules" className="boe-btn boe-btn-secondary">Back to Modules</Link>
      </div>
    </div>
  )
}

// With children (Pricing, from phase 7A) the same shell holds the module's first real page instead of the notice.
export function ComingSoonModule({ moduleKey, title, navLabel = 'Overview', children }: { moduleKey: string; title: string; navLabel?: string; children?: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [railPinned, toggleRailPinned] = useSidebarPinned()
  const { profile } = usePermissionContext()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const more = MORE_PAGES[moduleKey] ?? []
  const onMore = more.some(m => pathname.startsWith(m.href))
  const supabase = useMemo(() => createClient(), [])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  return (
    <div className={railShellClass(railPinned)}>
      <div className={`boe-sidebar-overlay${sidebarOpen ? ' open' : ''}`} onClick={() => setSidebarOpen(false)} />

      <aside className={`boe-sidebar${sidebarOpen ? ' open' : ''}`}>
        <div className="boe-sidebar-brand" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <BoeBrandIcon />
            <div className="boe-rail-label">
              <div className="boe-sidebar-brand-name">BOE One</div>
              <div className="boe-sidebar-brand-sub">{title}</div>
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
          <button
            className={`boe-nav-item${onMore ? '' : ' active'}`}
            aria-current={onMore ? undefined : 'page'}
            onClick={() => { setSidebarOpen(false); if (onMore) router.push(`/${moduleKey}`) }}
            style={{ fontWeight: 500, fontSize: 13.5, marginBottom: '2px' }}
          >
            <span style={{ color: '#37352F', display: 'flex', alignItems: 'center' }}>
              <LayoutDashboard size={15} strokeWidth={1.8} />
            </span>
            <span className="boe-rail-label">{navLabel}</span>
          </button>
          {more.map(m => {
            const active = pathname.startsWith(m.href)
            return (
              <button
                key={m.href}
                className={`boe-nav-item${active ? ' active' : ''}`}
                aria-current={active ? 'page' : undefined}
                onClick={() => { setSidebarOpen(false); router.push(m.href) }}
                style={{ fontWeight: 500, fontSize: 13.5, marginBottom: '2px' }}
              >
                <span style={{ color: '#37352F', display: 'flex', alignItems: 'center' }}>
                  <GraduationCap size={15} strokeWidth={1.8} />
                </span>
                <span className="boe-rail-label">{m.label}</span>
              </button>
            )
          })}
        </div>

        <div className="boe-sidebar-foot">
          <SidebarPinButton pinned={railPinned} onToggle={toggleRailPinned} />
          <ViewModeSidebarSection profile={profile} onSignOut={handleSignOut} accountSettingsHref={`/account?returnTo=/${moduleKey}`} />
        </div>
      </aside>

      <div className="boe-main-content">
        <div className="boe-page-header">
          <button className="boe-menu-toggle" onClick={() => setSidebarOpen(true)} aria-label="Open menu">☰</button>
          <PageBackButton />
          <div className="boe-page-title-group">
            <div className="boe-page-title">{title}</div>
          </div>
        </div>
        <div className="boe-page-body">
          <ViewModeBanner />
          {children ?? <ComingSoonNotice moduleKey={moduleKey} />}
        </div>
      </div>
    </div>
  )
}
