'use client'

import { useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { Bell } from 'lucide-react'
import { useUnreadNotifications } from '@/hooks/queries/useUnreadNotifications'

// Permanent sidebar entry to the shared /notifications page. Dropped into every
// module shell so notifications stay reachable even when the unread count is
// zero — it is never hidden by count. The unread badge (shown only when > 0)
// reads from the one shared count query, keeping a single source of truth across
// modules. Styling matches the surrounding `boe-nav-item` buttons.
//
// `onNavigate` lets a layout close its mobile sidebar after the click; the item
// performs its own navigation so callers don't have to.
//
// `count` optionally overrides the badge with a module-scoped unread number
// (e.g. Finance passes its `finance_%`-only count). When omitted the item reads
// the shared total, keeping every other module's sidebar unchanged.
//
// `href` optionally overrides the destination (e.g. Finance routes to its own
// `/finance/notifications` page instead of the global `/notifications`).
export function NotificationsNavItem({
  onNavigate, count, href = '/notifications',
}: { onNavigate?: () => void; count?: number; href?: string }) {
  const router   = useRouter()
  const pathname = usePathname()
  const total    = useUnreadNotifications()
  const unread   = count ?? total
  const active   = pathname === href

  // Warm the destination the way DashboardLayout already warms /modules.
  //
  // Notifications is a client route in its own bundle, so without this the
  // click had to download that chunk before anything could render — the
  // "entering Notifications is slow" complaint was largely this, not the
  // notification query. Prefetching costs one idle request per shell mount and
  // Next.js dedupes it; it does NOT fetch any notification data.
  useEffect(() => { router.prefetch(href) }, [router, href])

  return (
    <button
      className={`boe-nav-item${active ? ' active' : ''}`}
      onClick={() => { router.push(href); onNavigate?.() }}
      aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
      aria-current={active ? 'page' : undefined}
      style={{ fontWeight: active ? 600 : 400, marginBottom: '2px' }}
    >
      <span style={{ color: active ? '#DC1F2E' : '#A0A9BE', display: 'flex', alignItems: 'center' }}>
        <Bell size={15} strokeWidth={1.8} />
      </span>
      Notifications
      {unread > 0 && (
        <span
          aria-hidden="true"
          style={{
            marginLeft: 'auto',
            fontSize: '10px', fontWeight: 700, color: '#fff',
            background: '#DC1F2E', borderRadius: '999px',
            padding: '1px 6px', lineHeight: '15px', minWidth: '17px', textAlign: 'center',
          }}
        >
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  )
}
