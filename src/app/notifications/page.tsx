'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Notification, UserProfile } from '@/lib/types'
import { timeAgo } from '@/lib/ui'
import { colors, font } from '@/lib/tokens'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { Bell, CheckCheck, ExternalLink, Check, X } from 'lucide-react'

export default function NotificationsPage() {
  const [profile,       setProfile]       = useState<UserProfile | null>(null)
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [hidden,        setHidden]        = useState<Set<string>>(new Set())
  const [loading,       setLoading]       = useState(true)
  const [markingAll,    setMarkingAll]    = useState(false)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const [{ data: profileData }, res] = await Promise.all([
        supabase.from('users')
          .select('id, full_name, email, phone, role, team, is_active, created_at')
          .eq('id', user.id).single(),
        fetch('/api/notifications'),
      ])
      if (profileData) setProfile(profileData as UserProfile)
      if (res.ok) {
        const { notifications: list } = await res.json()
        setNotifications(list ?? [])
      } else {
        console.error('[notifications] load failed:', await res.json().catch(() => null))
      }
      setLoading(false)
    }
    init()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const visible = notifications.filter(n => !hidden.has(n.id))
  const unreadCount = visible.filter(n => !n.is_read).length

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const markAllRead = async () => {
    if (unreadCount === 0 || markingAll) return
    setMarkingAll(true)
    const res = await fetch('/api/notifications/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    })
    if (res.ok) {
      const now = new Date().toISOString()
      setNotifications(prev => prev.map(n => n.is_read ? n : { ...n, is_read: true, read_at: now }))
    } else {
      console.error('[notifications] mark all failed:', await res.json().catch(() => null))
    }
    setMarkingAll(false)
  }

  const markRead = async (id: string) => {
    const now = new Date().toISOString()
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, is_read: true, read_at: now } : n))
    fetch('/api/notifications/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }).catch(err => console.error('[notifications] mark read failed:', err))
  }

  const clearNotif = (id: string) => {
    // Mark read in DB (fire-and-forget) and hide from local list
    const notif = notifications.find(n => n.id === id)
    if (notif && !notif.is_read) {
      fetch('/api/notifications/mark-read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }).catch(err => console.error('[notifications] clear-mark-read failed:', err))
    }
    setHidden(prev => new Set([...prev, id]))
  }

  const viewTask = async (n: Notification) => {
    if (!n.is_read) await markRead(n.id)
    if (n.task_id) router.push(`/tasks/${n.task_id}`)
  }

  if (loading) return <LoadingScreen />

  return (
    <DashboardLayout
      profile={profile}
      title="Notifications"
      subtitle={unreadCount > 0 ? `${unreadCount} unread` : 'You are all caught up'}
      onSignOut={handleLogout}
      actions={
        <button
          onClick={markAllRead}
          disabled={unreadCount === 0 || markingAll}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '6px',
            padding: '7px 14px', borderRadius: '7px',
            border: `1.5px solid ${unreadCount === 0 ? colors.border : colors.blue}`,
            background: unreadCount === 0 ? 'transparent' : colors.blue,
            color: unreadCount === 0 ? colors.muted : '#ffffff',
            fontSize: '12px', fontWeight: 600,
            cursor: unreadCount === 0 || markingAll ? 'not-allowed' : 'pointer',
            fontFamily: font.body,
            opacity: markingAll ? 0.6 : 1,
            transition: 'all 0.15s',
          }}
        >
          <CheckCheck size={14} strokeWidth={2.2} />
          {markingAll ? 'Marking…' : 'Mark all as read'}
        </button>
      }
    >
      {visible.length === 0 ? (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', padding: '64px 24px', gap: '10px',
        }}>
          <span style={{
            width: '44px', height: '44px', borderRadius: '50%',
            background: colors.float,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Bell size={18} color={colors.muted} />
          </span>
          <span style={{ fontSize: '14px', fontWeight: 600, color: colors.secondary }}>
            No notifications yet
          </span>
          <span style={{ fontSize: '12px', color: colors.muted }}>
            Task activity will show up here.
          </span>
        </div>
      ) : (
        <div className="boe-card" style={{ overflow: 'hidden', padding: 0, maxWidth: '760px' }}>
          {visible.map((n, i) => (
            <div
              key={n.id}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: '12px',
                padding: '14px 16px',
                background: n.is_read ? '#ffffff' : colors.blueTint,
                borderBottom: i < visible.length - 1 ? `1px solid ${colors.border}` : 'none',
                transition: 'background 0.12s',
              }}
            >
              {/* Unread dot */}
              <span style={{
                marginTop: '5px', flexShrink: 0,
                width: '8px', height: '8px', borderRadius: '50%',
                background: n.is_read ? 'transparent' : colors.blue,
                border: n.is_read ? `1.5px solid ${colors.border}` : 'none',
              }} />

              {/* Content */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: '13px', fontWeight: n.is_read ? 500 : 700,
                  color: colors.primary, lineHeight: 1.4,
                  marginBottom: '2px',
                }}>
                  {n.title}
                </div>
                {n.body && (
                  <div style={{
                    fontSize: '12px', color: colors.secondary, lineHeight: 1.5,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    marginBottom: '2px',
                  }}>
                    {n.body}
                  </div>
                )}
                <div style={{ fontSize: '10.5px', color: colors.muted, marginBottom: '10px' }}>
                  {timeAgo(n.created_at)}
                </div>

                {/* Action buttons */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  {n.task_id && (
                    <button
                      onClick={() => viewTask(n)}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: '5px',
                        padding: '5px 11px', borderRadius: '6px',
                        fontSize: '11.5px', fontWeight: 600,
                        background: colors.blue, color: '#fff',
                        border: 'none', cursor: 'pointer',
                        fontFamily: font.body,
                      }}
                    >
                      <ExternalLink size={11} strokeWidth={2.2} />
                      View Task
                    </button>
                  )}
                  {!n.is_read && (
                    <button
                      onClick={() => markRead(n.id)}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: '5px',
                        padding: '5px 11px', borderRadius: '6px',
                        fontSize: '11.5px', fontWeight: 600,
                        background: 'transparent',
                        color: colors.secondary,
                        border: `1.5px solid ${colors.border}`,
                        cursor: 'pointer', fontFamily: font.body,
                      }}
                    >
                      <Check size={11} strokeWidth={2.5} />
                      Mark Read
                    </button>
                  )}
                  <button
                    onClick={() => clearNotif(n.id)}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: '5px',
                      padding: '5px 11px', borderRadius: '6px',
                      fontSize: '11.5px', fontWeight: 600,
                      background: 'transparent',
                      color: colors.muted,
                      border: `1.5px solid ${colors.border}`,
                      cursor: 'pointer', fontFamily: font.body,
                    }}
                  >
                    <X size={11} strokeWidth={2.5} />
                    Clear
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </DashboardLayout>
  )
}
