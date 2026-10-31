'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Home, LayoutDashboard } from 'lucide-react'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'
import { createClient } from '@/lib/supabase/client'
import { ModuleIcon } from '@/components/modules/ModuleIcons'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'
import { BoeBrandIcon } from './BoeBrandIcon'
import { SidebarPinButton, railShellClass, useSidebarPinned } from './RailControls'
import s from './comingSoonModule.module.css'

// A registered module with nothing inside it yet (Sales, Marketing, Pricing): the BOE Module Layout Standard
// shell around one notice. When the owner sets out what a module does, it gets its own layout and leaves this.

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

export function ComingSoonModule({ moduleKey, title }: { moduleKey: string; title: string }) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [railPinned, toggleRailPinned] = useSidebarPinned()
  const { profile } = usePermissionContext()
  const router = useRouter()
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
            className="boe-nav-item active"
            aria-current="page"
            onClick={() => setSidebarOpen(false)}
            style={{ fontWeight: 500, fontSize: 13.5, marginBottom: '2px' }}
          >
            <span style={{ color: '#37352F', display: 'flex', alignItems: 'center' }}>
              <LayoutDashboard size={15} strokeWidth={1.8} />
            </span>
            <span className="boe-rail-label">Overview</span>
          </button>
        </div>

        <div className="boe-sidebar-foot">
          <SidebarPinButton pinned={railPinned} onToggle={toggleRailPinned} />
          <ViewModeSidebarSection profile={profile} onSignOut={handleSignOut} accountSettingsHref={`/account?returnTo=/${moduleKey}`} />
        </div>
      </aside>

      <div className="boe-main-content">
        <div className="boe-page-header">
          <button className="boe-menu-toggle" onClick={() => setSidebarOpen(true)} aria-label="Open menu">☰</button>
          <div className="boe-page-title-group">
            <div className="boe-page-title">{title}</div>
          </div>
        </div>
        <div className="boe-page-body">
          <ViewModeBanner />
          <ComingSoonNotice moduleKey={moduleKey} />
        </div>
      </div>
    </div>
  )
}
