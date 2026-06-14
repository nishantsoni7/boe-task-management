'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  Package, Bell, Home, LogOut, RefreshCw,
  LayoutList, CheckCheck, Truck, Archive, Clock, Send, ThumbsDown,
  Eye, X,
} from 'lucide-react'
import type { UserProfile } from '@/lib/types'
import { initials } from '@/lib/ui'
import { useRefresh } from '@/contexts/RefreshContext'
import { useViewAs } from '@/hooks/useViewAs'

// ─── Tab types (single source of truth) ──────────────────────────────────────

export type TabKey =
  | 'all' | 'pending_approval' | 'approved' | 'qr_submitted'
  | 'dispatched' | 'rejected' | 'closed'

export type SectionKey = TabKey | 'notifications'

export const TABS: { key: TabKey; label: string; accent: string; Icon: React.ElementType }[] = [
  { key: 'all',              label: 'All Requests',     accent: '#5B7FA6', Icon: LayoutList  },
  { key: 'pending_approval', label: 'Pending Approval', accent: '#B45309', Icon: Clock       },
  { key: 'approved',         label: 'Approved',         accent: '#2E9E6B', Icon: CheckCheck  },
  { key: 'qr_submitted',     label: 'QR Submitted',     accent: '#7C3AED', Icon: Send        },
  { key: 'dispatched',       label: 'Dispatched / Out', accent: '#1A2035', Icon: Truck       },
  { key: 'rejected',         label: 'Rejected',         accent: '#D94F4F', Icon: ThumbsDown  },
  { key: 'closed',           label: 'Closed',           accent: '#6B7A99', Icon: Archive     },
]

// ─── Props ────────────────────────────────────────────────────────────────────

type SamplesLayoutProps = {
  profile: UserProfile | null
  activeSection: SectionKey
  counts?: Partial<Record<TabKey, number>>
  unreadCount: number
  title: string
  subtitle?: string
  actions?: React.ReactNode
  onTabSelect: (tab: TabKey) => void
  onSignOut: () => void
  children: React.ReactNode
}

// ─── Layout ───────────────────────────────────────────────────────────────────

export function SamplesLayout({
  profile,
  activeSection,
  counts = {},
  unreadCount,
  title,
  subtitle,
  actions,
  onTabSelect,
  onSignOut,
  children,
}: SamplesLayoutProps) {
  const router = useRouter()
  const { viewAsProfile, exitViewMode } = useViewAs()
  const inViewMode = !!viewAsProfile
  const [refreshing, setRefreshing] = useState(false)
  const { triggerRefresh } = useRefresh()

  const handleRefresh = useCallback(() => {
    if (refreshing) return
    setRefreshing(true)
    triggerRefresh()
    router.refresh()
    setTimeout(() => setRefreshing(false), 1000)
  }, [refreshing, triggerRefresh, router])

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') handleRefresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="boe-app-shell">

      {/* ── Sidebar ── */}
      <aside className="boe-sidebar">

        {/* Brand */}
        <div className="boe-sidebar-brand">
          <div className="boe-sidebar-brand-icon">
            <Package size={15} color="#E8A030" strokeWidth={2} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="boe-sidebar-brand-name">BOE</div>
            <div className="boe-sidebar-brand-sub">Sample Tracking</div>
          </div>
          <button
            onClick={() => router.push('/')}
            title="Home"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, borderRadius: '7px',
              background: 'rgba(232,160,48,0.12)',
              border: '1px solid rgba(232,160,48,0.25)',
              color: '#E8A030', cursor: 'pointer', flexShrink: 0,
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(232,160,48,0.22)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(232,160,48,0.12)' }}
          >
            <Home size={14} strokeWidth={2} />
          </button>
        </div>

        {/* Nav items */}
        <div className="boe-sidebar-section">
          {TABS.map((tab, i) => {
            const isActive = activeSection === tab.key
            const { Icon } = tab
            const count = counts[tab.key] ?? 0
            return (
              <button
                key={tab.key}
                className={`boe-nav-item${isActive ? ' active' : ''}`}
                onClick={() => onTabSelect(tab.key)}
                style={{ fontWeight: isActive ? 600 : 400, marginBottom: i < TABS.length - 1 ? '2px' : 0 }}
              >
                <span style={{ color: isActive ? '#E8A030' : '#A0A9BE', display: 'flex', alignItems: 'center' }}>
                  <Icon size={15} strokeWidth={1.8} />
                </span>
                {tab.label}
                {count > 0 && (
                  <span style={{
                    marginLeft: 'auto',
                    fontSize: '10px', fontWeight: 600, color: '#8C94A6',
                    background: 'rgba(0,0,0,0.07)', borderRadius: '999px',
                    padding: '1px 6px', lineHeight: '15px',
                  }}>
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {/* Notification block */}
        {unreadCount > 0 ? (
          <div style={{ padding: '0 10px 14px' }}>
            <button
              onClick={() => router.push('/samples/notifications')}
              className="boe-notif-alert"
            >
              <div className="boe-notif-alert-bell">
                <Bell size={24} strokeWidth={1.8} color="#E8A030" />
              </div>
              <div style={{ fontSize: '28px', fontWeight: 800, color: '#111318', lineHeight: 1 }}>
                {unreadCount > 99 ? '99+' : unreadCount}
              </div>
              <div style={{ fontSize: '11.5px', fontWeight: 600, color: '#3D4455' }}>
                unread {unreadCount === 1 ? 'notification' : 'notifications'}
              </div>
              <div style={{ fontSize: '10px', fontWeight: 600, color: '#E8A030', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                Tap to review →
              </div>
            </button>
          </div>
        ) : (
          <div style={{ padding: '0 10px 8px' }}>
            <button
              onClick={() => router.push('/samples/notifications')}
              className={`boe-nav-item${activeSection === 'notifications' ? ' active' : ''}`}
              style={{ color: activeSection === 'notifications' ? '#111318' : '#8C94A6', fontSize: '12.5px', gap: '8px' }}
            >
              <Bell size={14} strokeWidth={1.8} />
              Notifications
            </button>
          </div>
        )}

        {/* Profile + sign out */}
        {profile && (
          <div style={{ marginTop: 'auto', borderTop: '1px solid rgba(0,0,0,0.07)', padding: '10px 10px 6px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px 6px' }}>
              <div style={{
                width: 30, height: 30, borderRadius: '8px', background: '#1A2035',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '11px', fontWeight: 700, color: '#E8A030', flexShrink: 0,
              }}>
                {initials(profile.full_name)}
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: '12.5px', fontWeight: 600, color: '#111318', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {profile.full_name}
                </div>
                <div style={{ fontSize: '10.5px', color: '#8C94A6', textTransform: 'capitalize' }}>
                  {profile.role} · {profile.team}
                </div>
              </div>
            </div>
            <button
              className="boe-nav-item"
              onClick={onSignOut}
              style={{ color: '#8C94A6', fontSize: '12.5px', gap: '8px' }}
            >
              <LogOut size={14} strokeWidth={1.8} />
              Sign out
            </button>
          </div>
        )}
      </aside>

      {/* ── Main content ── */}
      <div className="boe-main-content">

        {/* Page header */}
        <div className="boe-page-header">
          <div className="boe-page-title-group">
            <div className="boe-page-title">{title}</div>
            {subtitle && <div className="boe-page-subtitle">{subtitle}</div>}
          </div>
          <div className="boe-header-actions">
            {actions}
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              title="Refresh"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 32, height: 32, borderRadius: '8px',
                background: refreshing ? 'rgba(232,160,48,0.15)' : 'rgba(0,0,0,0.05)',
                border: '1px solid rgba(0,0,0,0.10)',
                color: refreshing ? '#E8A030' : '#6B7384',
                cursor: refreshing ? 'default' : 'pointer',
                flexShrink: 0, transition: 'background 0.15s, color 0.15s',
              }}
              onMouseEnter={e => { if (!refreshing) { e.currentTarget.style.background = 'rgba(232,160,48,0.12)'; e.currentTarget.style.color = '#E8A030' } }}
              onMouseLeave={e => { if (!refreshing) { e.currentTarget.style.background = 'rgba(0,0,0,0.05)'; e.currentTarget.style.color = '#6B7384' } }}
            >
              <RefreshCw
                size={14}
                strokeWidth={2}
                style={refreshing ? { animation: 'boe-spin 0.7s linear infinite' } : undefined}
              />
            </button>
          </div>
        </div>

        {/* Page body */}
        <div className="boe-page-body">
          {inViewMode && viewAsProfile && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              flexWrap: 'wrap', gap: '8px',
              padding: '12px 20px',
              background: '#FFFBEB',
              border: '1.5px solid #FCD34D',
              borderRadius: '10px',
              marginBottom: '20px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <Eye size={16} color="#D97706" strokeWidth={2.2} style={{ flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: '#78350F', letterSpacing: '-0.01em' }}>
                    ADMIN VIEW MODE — Viewing as <strong>{viewAsProfile.full_name}</strong>
                  </div>
                  <div style={{ fontSize: '11.5px', color: '#92400E', marginTop: '1px' }}>
                    You are observing this user&apos;s workspace. All actions are disabled.
                  </div>
                </div>
                <span style={{
                  fontSize: '10px', fontWeight: 700,
                  color: '#B45309', background: '#FEF3C7',
                  borderRadius: '4px', padding: '2px 8px',
                  border: '1px solid #FDE68A',
                  whiteSpace: 'nowrap',
                }}>
                  READ ONLY
                </span>
              </div>
              <button
                onClick={() => { exitViewMode(); router.push('/dashboard') }}
                style={{
                  display: 'flex', alignItems: 'center', gap: '5px',
                  fontSize: '12px', fontWeight: 600,
                  color: '#92400E', background: '#FEF3C7',
                  border: '1px solid #FDE68A', borderRadius: '6px',
                  padding: '6px 14px', cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                <X size={12} strokeWidth={2.5} />
                Exit View Mode
              </button>
            </div>
          )}
          {children}
        </div>

      </div>
    </div>
  )
}
