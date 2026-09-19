'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Bell } from 'lucide-react'
import { useUnreadNotifications } from '@/hooks/queries/useUnreadNotifications'

// Permanent sidebar entry to the shared /notifications page. Dropped into every
// module shell so notifications stay reachable even when the unread count is
// zero — it is never hidden by count. The unread badge (shown only when > 0)
// reads from the one shared count query, keeping a single source of truth across
// modules. Styling matches the surrounding `boe-nav-item` entries.
//
// A REAL LINK, like every other sidebar destination: it opens in a new tab,
// shows its address, and announces itself with aria-current. Next's <Link>
// prefetches the route's code while the entry is on screen — which is what the
// manual router.prefetch(href) on mount used to do by hand, and why the
// "entering Notifications is slow" complaint was largely the chunk download,
// not the notification query. It prefetches the ROUTE, never notification data.
//
// `onNavigate` lets a layout close its mobile sidebar after the click; the
// navigation itself is the link's.
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
  const pathname = usePathname()
  const total    = useUnreadNotifications()
  const unread   = count ?? total
  const active   = pathname === href

  return (
    <Link
      href={href}
      className={`boe-nav-item${active ? ' active' : ''}`}
      onClick={() => onNavigate?.()}
      aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
      aria-current={active ? 'page' : undefined}
      style={{ fontWeight: active ? 600 : 400, marginBottom: '2px', textDecoration: 'none' }}
    >
      <span aria-hidden="true" style={{ color: active ? '#DC1F2E' : '#A0A9BE', display: 'flex', alignItems: 'center' }}>
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
    </Link>
  )
}
