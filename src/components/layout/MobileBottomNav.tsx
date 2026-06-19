'use client'

import { useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import {
  Home, ClipboardList, Bell, TrendingUp, MoreHorizontal,
  CheckSquare, Briefcase, Plus, Settings, LogOut, Users,
} from 'lucide-react'
import type { UserProfile } from '@/lib/types'
import { useViewAs } from '@/hooks/useViewAs'

type NavCounts = { myActive: number; assignedByMeActive: number }

type Props = {
  profile:      UserProfile | null
  unreadNotifs?: number
  navCounts?:   NavCounts
  onSignOut:    () => void
}

// ─── Nav item ─────────────────────────────────────────────────────────────────

function BottomNavItem({
  label, icon: Icon, active, badge, onClick,
}: {
  label:    string
  icon:     React.ElementType
  active:   boolean
  badge?:   number
  onClick:  () => void
}) {
  const accent = '#5585E8'
  const muted  = '#8C94A6'

  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 3,
        padding: '6px 0',
        border: 'none', background: 'transparent',
        cursor: 'pointer', position: 'relative',
        minHeight: 52,
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <span style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon size={22} strokeWidth={active ? 2.2 : 1.8} color={active ? accent : muted} />
        {(badge ?? 0) > 0 && (
          <span style={{
            position: 'absolute', top: -5, right: -8,
            minWidth: 16, height: 16,
            background: '#E8A030', color: '#fff',
            fontSize: 9, fontWeight: 700,
            borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '0 3px', lineHeight: 1,
          }}>
            {(badge ?? 0) > 99 ? '99+' : badge}
          </span>
        )}
      </span>
      <span style={{
        fontSize: 9.5, fontWeight: active ? 700 : 500,
        color: active ? accent : muted,
        letterSpacing: '0.01em',
      }}>
        {label}
      </span>
      {active && (
        <span style={{
          position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)',
          width: 32, height: 2.5, borderRadius: '0 0 3px 3px',
          background: accent,
        }} />
      )}
    </button>
  )
}

// ─── More sheet item ──────────────────────────────────────────────────────────

function MoreItem({
  label, icon: Icon, accent = '#5585E8', onClick,
}: {
  label:   string
  icon:    React.ElementType
  accent?: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 14,
        padding: '13px 20px',
        border: 'none', background: 'transparent',
        cursor: 'pointer', textAlign: 'left',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <span style={{
        width: 34, height: 34, borderRadius: 9,
        background: accent + '18',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <Icon size={16} strokeWidth={1.8} color={accent} />
      </span>
      <span style={{ fontSize: 14, fontWeight: 500, color: '#111318' }}>{label}</span>
    </button>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function MobileBottomNav({ profile, unreadNotifs = 0, navCounts, onSignOut }: Props) {
  const [moreOpen, setMoreOpen] = useState(false)

  const router   = useRouter()
  const pathname = usePathname()
  const { viewAsUserId } = useViewAs()
  const inViewMode = !!viewAsUserId

  const isAdmin          = profile?.role === 'admin'
  const isAdminOrManager = isAdmin || profile?.role === 'manager'

  const go = (path: string) => {
    setMoreOpen(false)
    router.push(path)
  }

  const handleSignOut = () => {
    setMoreOpen(false)
    onSignOut()
  }

  const myTasksActive   = pathname.startsWith('/tasks/my') || pathname.startsWith('/tasks/cancelled')
  const notifsActive    = pathname.startsWith('/notifications')
  const perfActive      = pathname.startsWith('/performance')
  const homeActive      = pathname === '/dashboard'
  const moreActive      = !homeActive && !myTasksActive && !notifsActive && !perfActive

  const myBadge   = navCounts?.myActive   || 0
  const notifBadge = unreadNotifs

  // ── Nav bar height constant (matches CSS) ─────────────────────────────────
  const NAV_H = 56

  return (
    <>
      {/* Overlay — closes "More" sheet */}
      {moreOpen && (
        <div
          onClick={() => setMoreOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 1001,
            background: 'rgba(0,0,0,0.30)',
          }}
        />
      )}

      {/* "More" sheet — slides up from above the nav bar */}
      <div
        className="boe-mobile-bottom-nav"
        style={{
          position: 'fixed', left: 0, right: 0,
          bottom: NAV_H,
          zIndex: 1002,
          background: '#fff',
          borderRadius: '16px 16px 0 0',
          boxShadow: '0 -4px 28px rgba(0,0,0,0.14)',
          borderTop: '1px solid #EEF0F4',
          transform: moreOpen ? 'translateY(0)' : 'translateY(105%)',
          transition: 'transform 0.25s cubic-bezier(0.32,0.72,0,1)',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        }}
      >
        {/* Handle */}
        <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 4px' }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: '#DDE0E7' }} />
        </div>

        <div style={{ padding: '6px 0 12px' }}>
          <MoreItem label="Assigned By Me"  icon={CheckSquare} accent="#2E9E6B" onClick={() => go('/tasks/assigned-by-me')} />
          <MoreItem label="Assets & Access" icon={Briefcase}   accent="#E8A030" onClick={() => go('/assets-access')} />

          {!inViewMode && (
            <MoreItem label="Create Self Task"  icon={Plus}    accent="#5585E8" onClick={() => go('/tasks/create-self')} />
          )}
          {!inViewMode && isAdminOrManager && (
            <MoreItem label="Delegate Task"     icon={Plus}    accent="#9B6FD4" onClick={() => go('/tasks/create')} />
          )}
          {isAdminOrManager && (
            <MoreItem label="Team Performance"  icon={Users}   accent="#D94F4F" onClick={() => go('/performance/team')} />
          )}
          {isAdmin && !inViewMode && (
            <MoreItem label="Settings"          icon={Settings} accent="#6B7384" onClick={() => go('/settings')} />
          )}

          {/* Divider */}
          <div style={{ height: 1, background: '#F0F1F3', margin: '8px 20px' }} />

          <MoreItem label="Sign Out" icon={LogOut} accent="#D94F4F" onClick={handleSignOut} />
        </div>
      </div>

      {/* Bottom nav bar */}
      <nav
        className="boe-mobile-bottom-nav"
        style={{
          position: 'fixed', bottom: 0, left: 0, right: 0,
          zIndex: 1003,
          background: '#fff',
          borderTop: '1px solid #EEF0F4',
          display: 'flex', alignItems: 'stretch',
          height: NAV_H,
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          boxShadow: '0 -1px 8px rgba(0,0,0,0.06)',
        }}
      >
        <BottomNavItem label="Home"        icon={Home}          active={homeActive}    onClick={() => go('/dashboard')} />
        <BottomNavItem label="My Tasks"    icon={ClipboardList} active={myTasksActive} badge={myBadge}    onClick={() => go('/tasks/my')} />
        <BottomNavItem label="Notifs"      icon={Bell}          active={notifsActive}  badge={notifBadge} onClick={() => go('/notifications')} />
        <BottomNavItem label="Performance" icon={TrendingUp}    active={perfActive}    onClick={() => go('/performance')} />
        <BottomNavItem
          label="More"
          icon={MoreHorizontal}
          active={moreActive || moreOpen}
          onClick={() => setMoreOpen(o => !o)}
        />
      </nav>
    </>
  )
}
