'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { ClipboardList, QrCode, Tag, Home, X } from 'lucide-react'
import { BoeBrandIcon } from './BoeBrandIcon'
import type { UserProfile } from '@/lib/types'
import { ViewModeBanner, ViewModeSidebarSection } from '@/components/layout/AdminViewModeControls'
import { useViewAs } from '@/hooks/useViewAs'
import { createClient } from '@/lib/supabase/client'
import { resolveModuleAccess } from '@/lib/moduleAccess'
import { ProductMasterNav } from '@/components/layout/ProductMasterNav'
import { ProductLookup } from '@/components/layout/ProductLookup'
import { useShowroomProductCounts } from '@/hooks/queries/useShowroomProductCounts'
import { isProductRoute, productCategoryHref, resolveParentClick } from '@/lib/showroom/productNav'

type ShowroomAdminLayoutProps = {
  profile: UserProfile | null
  title: string
  subtitle?: string
  /**
   * Stored name of the Product Master category to highlight. Passed in rather
   * than read here: only the Product Master routes carry it, and both of them
   * already sit inside the `<Suspense>` boundary `useSearchParams` needs — the
   * shell must not drag that requirement onto every other page in the module.
   */
  activeProductCategory?: string
  onSignOut: () => void
  children: React.ReactNode
}

type ModVisRow = { visibility_type: string; allowed_department: string[] | null; allowed_user_ids: string[] | null }
const teamFallback = (team?: string | null) =>
  !!team && (team.toLowerCase().includes('sales') || team.toLowerCase().includes('showroom'))

export function ShowroomAdminLayout({
  profile, title, subtitle, activeProductCategory: activeCategory = '', onSignOut, children,
}: ShowroomAdminLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [showroomMod, setShowroomMod] = useState<ModVisRow | null>(null)
  const router   = useRouter()
  const pathname = usePathname()
  const supabase = useMemo(() => createClient(), [])

  const { viewAsProfile } = useViewAs()
  const effectiveProfile = viewAsProfile ?? profile
  const isAdmin = effectiveProfile?.role === 'admin'

  // Sidebar nav needs the same Control-Center-driven permission the
  // showroom-admin route guards use, so "Product Master" isn't hidden from
  // a department that's allowed into the module but isn't an admin.
  useEffect(() => {
    supabase
      .from('app_modules')
      .select('visibility_type, allowed_department, allowed_user_ids')
      .eq('module_key', 'showroom_qr')
      .single()
      .then((res: { data: ModVisRow | null }) => setShowroomMod(res.data ?? null))
  }, [supabase])

  const canManageProducts = isAdmin || resolveModuleAccess('showroom_qr', showroomMod, effectiveProfile ?? null, teamFallback(effectiveProfile?.team),
  )

  const navTo = (path: string) => {
    router.push(path)
    setSidebarOpen(false)
  }

  // Product Master sub-navigation ─────────────────────────────────────────────
  const productCounts = useShowroomProductCounts(canManageProducts)
  const onProductRoute = isProductRoute(pathname)

  // Open whenever the user is inside Product Master, and closable from there.
  // Adjusted during render (not in an effect) so entering or leaving the module
  // never shows the wrong state for a frame.
  const [productNavOpen, setProductNavOpen] = useState(onProductRoute)
  const [prevOnProductRoute, setPrevOnProductRoute] = useState(onProductRoute)
  if (onProductRoute !== prevOnProductRoute) {
    setPrevOnProductRoute(onProductRoute)
    setProductNavOpen(onProductRoute)
  }

  const handleProductParentClick = () => {
    const result = resolveParentClick({
      onProductRoute,
      firstCategory: productCounts.categories[0]?.name ?? null,
    })
    if (result.action === 'toggle') setProductNavOpen(open => !open)
    else navTo(result.href)
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

        {/* Brand header — with home icon top-right matching other modules */}
        <div className="boe-sidebar-brand" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <BoeBrandIcon />
            <div>
              <div className="boe-sidebar-brand-name">Showroom QR</div>
              <div className="boe-sidebar-brand-sub">BOE Operating System</div>
            </div>
          </div>
          <button
            onClick={() => navTo('/modules')}
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

        {/* Module nav — Showroom QR links only */}
        <div className="boe-sidebar-section">
          <NavItem
            label="My Inquiries"
            icon={<ClipboardList size={15} strokeWidth={1.8} />}
            active={pathname === '/showroom-admin'}
            onClick={() => navTo('/showroom-admin')}
          />
          <NavItem
            label="My QR Code"
            icon={<QrCode size={15} strokeWidth={1.8} />}
            active={pathname === '/showroom-admin/qr'}
            onClick={() => navTo('/showroom-admin/qr')}
          />
          {canManageProducts && (
            <ProductMasterNav
              categories={productCounts.categories}
              totalCount={productCounts.total}
              activeCategory={activeCategory}
              active={onProductRoute}
              expanded={productNavOpen}
              onParentClick={handleProductParentClick}
              onSelectCategory={name => navTo(productCategoryHref(name))}
            />
          )}
          {/* Directly under Product Master, because it answers the question the
              category list cannot: "which category is BOE-1042 in?". navTo, so
              picking a result closes the mobile drawer like any other entry. */}
          {canManageProducts && (
            <ProductLookup enabled={canManageProducts} onOpenProduct={navTo} />
          )}
          {canManageProducts && (
            <NavItem
              label="Categories"
              icon={<Tag size={15} strokeWidth={1.8} />}
              active={pathname.startsWith('/showroom-admin/categories')}
              onClick={() => navTo('/showroom-admin/categories')}
            />
          )}
        </div>

        {/* Bottom: profile + account settings + view as + sign out */}
        <ViewModeSidebarSection
          profile={profile}
          onSignOut={onSignOut}
          accountSettingsHref="/account?returnTo=/showroom-admin"
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
            <div className="boe-page-title">{title}</div>
            {subtitle && <div className="boe-page-subtitle">{subtitle}</div>}
          </div>
          {/* Top-right home icon — same pattern as other modules */}
          <div className="boe-header-actions">
            <button
              onClick={() => router.push('/modules')}
              title="BOE OS Home"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 32, height: 32, borderRadius: '8px',
                background: 'rgba(0,0,0,0.05)',
                border: '1px solid rgba(0,0,0,0.10)',
                color: '#6B7384',
                cursor: 'pointer',
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

function NavItem({
  label, icon, active, onClick,
}: {
  label: string
  icon: React.ReactNode
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      className={`boe-nav-item${active ? ' active' : ''}`}
      onClick={onClick}
      style={{ fontWeight: active ? 600 : 400, marginBottom: '2px' }}
    >
      <span style={{ color: active ? '#DC1F2E' : '#A0A9BE', display: 'flex', alignItems: 'center' }}>
        {icon}
      </span>
      {label}
    </button>
  )
}
