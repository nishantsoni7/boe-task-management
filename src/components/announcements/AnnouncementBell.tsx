'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Bell, Megaphone } from 'lucide-react'
import type { MyAnnouncement } from '@/lib/announcements'

// THE HEADER NOTIFICATION CONTROL for announcements, at the top-right of the
// Modules header. The bell and red count pill are the ones the module sidebars
// already use (NotificationsNavItem); the count is UNACKNOWLEDGED announcements.
//
// It is a separate list from task/finance/order notifications on purpose. It is
// derived from the same query as the banner — nothing is written when a page
// loads, and marking or deleting an ordinary notification cannot touch it. An
// announcement leaves this count only through "I have read this".
//
// The panel is a read-only pop-over (no form), so a click outside or Escape
// closes it.
export function AnnouncementBell({ announcements }: { announcements: MyAnnouncement[] }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const unreadCount = announcements.filter(a => !a.read_at).length

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const label = unreadCount > 0
    ? `Announcements, ${unreadCount} unread`
    : 'Announcements'

  return (
    <div className="boe-announce-bell-wrap" ref={rootRef}>
      <button
        type="button"
        className="boe-announce-bell"
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <Bell size={17} strokeWidth={1.9} aria-hidden="true" />
        {unreadCount > 0 && (
          <span className="boe-announce-bell-count" aria-hidden="true">{unreadCount > 9 ? '9+' : unreadCount}</span>
        )}
      </button>

      {open && (
        <div className="boe-announce-panel" role="dialog" aria-label="Announcements">
          <div className="boe-announce-panel-head">Announcements</div>
          {announcements.length === 0 ? (
            <p className="boe-announce-panel-empty">No active announcements.</p>
          ) : (
            <ul className="boe-announce-panel-list">
              {announcements.map(a => (
                <li key={a.id}>
                  <Link
                    href={`/announcements/${a.id}`}
                    className={`boe-announce-panel-item${a.read_at ? '' : ' unread'}`}
                    onClick={() => setOpen(false)}
                  >
                    <Megaphone size={14} strokeWidth={1.9} aria-hidden="true" />
                    <span className="boe-announce-panel-title">{a.title}</span>
                    {!a.read_at && <span className="boe-announce-dot" aria-label="Unread" />}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <Link href="/announcements" className="boe-announce-panel-all" onClick={() => setOpen(false)}>
            All announcements
          </Link>
        </div>
      )}
    </div>
  )
}
