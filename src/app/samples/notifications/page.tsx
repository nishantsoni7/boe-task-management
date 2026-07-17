'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors, font } from '@/lib/tokens'
import { LoadingScreen } from '@/components/ui/atoms'
import { Bell, CheckCheck, ArrowUpRight } from 'lucide-react'
import { SamplesLayout, type TabKey } from '@/components/layout/SamplesLayout'
import { useRefresh } from '@/contexts/RefreshContext'

// ─── Types ────────────────────────────────────────────────────────────────────

type SampleNotif = {
  id: string
  event: string
  title: string
  body: string | null
  is_read: boolean
  created_at: string
}

// ─── Event label map ──────────────────────────────────────────────────────────

const EVENT_META: Record<string, { label: string; color: string; bg: string }> = {
  sample_request_created:   { label: 'New Request',  color: colors.blue,  bg: colors.blueTint  },
  sample_request_approved:  { label: 'Approved',     color: colors.green, bg: colors.greenTint },
  sample_request_rejected:  { label: 'Rejected',     color: colors.red,   bg: colors.redTint   },
  sample_request_reapplied: { label: 'Reapplied',    color: colors.blue,  bg: colors.blueTint  },
  sample_request_edited:    { label: 'Edited',       color: colors.muted, bg: colors.float     },
  sample_request_deleted:   { label: 'Deleted',      color: colors.red,   bg: colors.redTint   },
  sample_qr_submitted:      { label: 'QR Submitted', color: '#7C3AED',    bg: '#EDE9FE'        },
  sample_dispatched:        { label: 'Dispatched',   color: '#1A2035',    bg: '#1A203514'      },
  sample_followup:          { label: 'Follow-up',    color: colors.muted, bg: colors.float     },
  sample_returned:          { label: 'Returned',     color: colors.green, bg: colors.greenTint },
  sample_lost:              { label: 'Lost',         color: colors.red,   bg: colors.redTint   },
}

function eventMeta(event: string) {
  return EVENT_META[event] ?? { label: 'Update', color: colors.muted, bg: colors.float }
}

function formatTs(iso: string) {
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SampleNotificationsPage() {
  const [profile,    setProfile]    = useState<UserProfile | null>(null)
  const [notifs,     setNotifs]     = useState<SampleNotif[]>([])
  const [loading,    setLoading]    = useState(true)
  const [markingAll, setMarkingAll] = useState(false)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { refreshKey } = useRefresh()

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const [{ data: profileData }, res] = await Promise.all([
        supabase
          .from('users')
          .select('id, full_name, email, phone, role, team, is_active, created_at')
          .eq('id', session.user.id)
          .single(),
        fetch('/api/samples/notifications'),
      ])

      if (profileData) setProfile(profileData as UserProfile)
      if (res.ok) {
        const { notifications: list } = await res.json()
        setNotifs(list ?? [])
      }
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  const handleMarkAllRead = async () => {
    setMarkingAll(true)
    await fetch('/api/samples/notifications', { method: 'PATCH' })
    setNotifs(prev => prev.map(n => ({ ...n, is_read: true })))
    setMarkingAll(false)
  }

  const handleClickNotif = async (n: SampleNotif) => {
    if (!n.is_read) {
      await fetch(`/api/samples/notifications/${n.id}`, { method: 'PATCH' })
      setNotifs(prev => prev.map(x => x.id === n.id ? { ...x, is_read: true } : x))
    }
    router.push('/samples')
  }

  if (loading) return <LoadingScreen />

  const unreadCount = notifs.filter(n => !n.is_read).length

  return (
    <SamplesLayout
      profile={profile}
      activeSection="notifications"
      unreadCount={unreadCount}
      title="Notifications"
      subtitle={unreadCount > 0 ? `${unreadCount} unread` : undefined}
      onTabSelect={(_tab: TabKey) => router.push('/samples')}
      onSignOut={async () => { await supabase.auth.signOut(); router.replace('/login') }}
      actions={
        unreadCount > 0 ? (
          <button
            onClick={handleMarkAllRead}
            disabled={markingAll}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              padding: '7px 14px', borderRadius: '8px',
              border: `1px solid ${colors.border}`,
              background: colors.float, color: colors.secondary,
              fontSize: '12px', fontWeight: 600,
              cursor: markingAll ? 'not-allowed' : 'pointer',
              opacity: markingAll ? 0.6 : 1,
            }}
            onMouseEnter={e => { if (!markingAll) e.currentTarget.style.background = '#E8EAED' }}
            onMouseLeave={e => { e.currentTarget.style.background = colors.float }}
          >
            <CheckCheck size={13} strokeWidth={2} />
            {markingAll ? 'Marking…' : 'Mark all read'}
          </button>
        ) : undefined
      }
    >
      <div style={{ maxWidth: '680px', width: '100%' }}>

        {notifs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 24px', color: colors.muted }}>
            <Bell size={32} strokeWidth={1.4} style={{ margin: '0 auto 12px', color: colors.float }} />
            <div style={{ fontSize: '14px', fontWeight: 600, color: colors.secondary, marginBottom: '4px' }}>
              No notifications yet
            </div>
            <div style={{ fontSize: '13px' }}>
              Sample tracking updates will appear here.
            </div>
          </div>
        ) : (
          <div style={{ border: `1px solid ${colors.border}`, borderRadius: '10px', overflow: 'hidden' }}>
            {notifs.map((n, i) => {
              const em = eventMeta(n.event)
              return (
                <div
                  key={n.id}
                  onClick={() => handleClickNotif(n)}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: '12px',
                    padding: '13px 16px',
                    background: n.is_read ? '#fff' : 'rgba(232,160,48,0.04)',
                    borderLeft: n.is_read ? '3px solid transparent' : '3px solid #E8A030',
                    borderBottom: i < notifs.length - 1 ? `1px solid ${colors.border}` : 'none',
                    cursor: 'pointer',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.background = n.is_read ? colors.float : 'rgba(232,160,48,0.08)'
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.background = n.is_read ? '#fff' : 'rgba(232,160,48,0.04)'
                  }}
                >
                  {/* Icon */}
                  <div style={{
                    width: 34, height: 34, borderRadius: '9px', flexShrink: 0,
                    background: em.bg,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    marginTop: '1px',
                  }}>
                    <Bell size={14} strokeWidth={1.8} color={em.color} />
                  </div>

                  {/* Content */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '3px' }}>
                      <span style={{
                        fontSize: '10px', fontWeight: 700,
                        color: em.color, background: em.bg,
                        padding: '1px 7px', borderRadius: '999px',
                        textTransform: 'uppercase', letterSpacing: '0.04em',
                      }}>
                        {em.label}
                      </span>
                      {!n.is_read && (
                        <span style={{
                          width: 7, height: 7, borderRadius: '50%',
                          background: '#E8A030', display: 'inline-block', flexShrink: 0,
                        }} />
                      )}
                    </div>
                    <div style={{
                      fontSize: '13px', fontWeight: n.is_read ? 400 : 600,
                      color: colors.primary, lineHeight: 1.45, fontFamily: font.body,
                    }}>
                      {n.title}
                    </div>
                    {n.body && (
                      <div style={{ fontSize: '12px', color: colors.secondary, marginTop: '2px' }}>
                        {n.body}
                      </div>
                    )}
                    <div style={{ fontSize: '11px', color: colors.muted, marginTop: '5px' }}>
                      {formatTs(n.created_at)}
                    </div>
                  </div>

                  {/* Arrow */}
                  <div style={{ flexShrink: 0, color: colors.muted, paddingTop: '8px' }}>
                    <ArrowUpRight size={14} strokeWidth={1.8} />
                  </div>
                </div>
              )
            })}
          </div>
        )}

      </div>
    </SamplesLayout>
  )
}
