'use client'

import { useEffect, useState, useMemo, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors, font } from '@/lib/tokens'
import { LoadingScreen } from '@/components/ui/atoms'
import { Bell, CheckCheck, ArrowUpRight, Trash2, Check, AlertTriangle } from 'lucide-react'
import { SamplesLayout, type TabKey } from '@/components/layout/SamplesLayout'
import { useRefresh } from '@/contexts/RefreshContext'
import { createPendingGuard } from '@/lib/notificationMutations'
import {
  deleteSampleNotification,
  deleteSelectedSampleNotifications,
  deleteAllSampleNotifications,
  type SampleNotif,
  type SampleNotifState,
  type SampleDeleteDeps,
} from '@/lib/sampleNotificationDeletes'

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

// Row background / left rule. Selection wins over read-state, using the same
// blue treatment NotificationsView uses, so a selected row reads identically in
// both modules. Unselected rows keep Sample Tracking's amber unread accent.
const rowBackground = (isSelected: boolean, isRead: boolean, hover = false) => {
  if (isSelected) return 'rgba(85,133,232,0.10)'
  if (isRead)     return hover ? colors.float : '#fff'
  return hover ? 'rgba(232,160,48,0.08)' : 'rgba(232,160,48,0.04)'
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SampleNotificationsPage() {
  const [profile,      setProfile]      = useState<UserProfile | null>(null)
  const [notifs,       setNotifs]       = useState<SampleNotif[]>([])
  const [loading,      setLoading]      = useState(true)
  const [markingAll,   setMarkingAll]   = useState(false)
  const [selected,     setSelected]     = useState<ReadonlySet<string>>(() => new Set<string>())
  const [error,        setError]        = useState<string | null>(null)
  const [deletingBulk, setDeletingBulk] = useState(false)
  const [deletingAll,  setDeletingAll]  = useState(false)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { refreshKey } = useRefresh()

  // Synchronous per-id lock, reused verbatim from Task Management. A
  // double-click delivers both events before React re-renders the button as
  // disabled, so a state-based guard alone would let the second one through.
  const [guard] = useState(createPendingGuard)
  const [pendingDeletes, setPendingDeletes] = useState<ReadonlySet<string>>(() => new Set<string>())

  // The delete mutations are framework-free and read state through this ref.
  // `setState` below writes it synchronously so an in-flight mutation always
  // sees what it just wrote, without waiting for a re-render.
  const stateRef = useRef<SampleNotifState>({ notifs: [], selected: new Set(), error: null })
  useEffect(() => { stateRef.current = { notifs, selected, error } })

  const deps: SampleDeleteDeps = useMemo(() => ({
    getState: () => stateRef.current,
    setState: (next: SampleNotifState) => {
      stateRef.current = next
      setNotifs(next.notifs)
      setSelected(next.selected)
      setError(next.error)
    },
    releasePending: (id: string) => {
      guard.release(id)
      setPendingDeletes(guard.snapshot())
    },
  }), [guard])

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
    if (markingAll) return
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

  // ── Selection + delete entry points ─────────────────────────────────────
  // The optimistic write / snapshot / rollback all live in
  // src/lib/sampleNotificationDeletes.ts; these wrappers own only the guard and
  // the in-flight flags.

  const toggleSelect = useCallback((id: string) => {
    setSelected(prev => {
      const s = new Set(prev)
      if (s.has(id)) s.delete(id)
      else s.add(id)
      return s
    })
  }, [])

  const handleDeleteSingle = (id: string) => {
    // Rejected synchronously if this id is already in flight, so a rapid
    // double-click produces exactly one DELETE request.
    if (!guard.tryAcquire(id)) return
    setPendingDeletes(guard.snapshot())
    void deleteSampleNotification(deps, id)
  }

  const handleDeleteSelected = async () => {
    if (deletingBulk || selected.size === 0) return
    setDeletingBulk(true)
    try {
      await deleteSelectedSampleNotifications(deps, [...selected])
    } finally {
      setDeletingBulk(false)
    }
  }

  const handleDeleteAll = async () => {
    if (deletingAll || notifs.length === 0) return
    setDeletingAll(true)
    try {
      await deleteAllSampleNotifications(deps)
    } finally {
      setDeletingAll(false)
    }
  }

  if (loading) return <LoadingScreen />

  // Rows with a DELETE still in flight stay hidden even if something puts them
  // back in state — the server has been told to remove them. A failed delete
  // rolls the row back and clears its pending id, so it returns.
  const rows = pendingDeletes.size === 0 ? notifs : notifs.filter(n => !pendingDeletes.has(n.id))
  const unreadCount = rows.filter(n => !n.is_read).length

  // ── Toolbar button base style helpers (identical to NotificationsView) ────
  const toolBtn = (active: boolean, danger = false) => ({
    display: 'inline-flex' as const, alignItems: 'center' as const, gap: '6px',
    padding: '7px 14px', borderRadius: '7px',
    fontSize: '12px', fontWeight: 600,
    fontFamily: font.body,
    transition: 'all 0.15s',
    border: `1.5px solid ${active ? (danger ? colors.red : colors.blue) : colors.border}`,
    background: active && !danger ? colors.blue : 'transparent',
    color: active ? (danger ? colors.red : '#ffffff') : colors.muted,
    cursor: active ? 'pointer' : 'not-allowed',
    opacity: 1,
  })

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
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {/* Delete selected — only shown when something is selected */}
          {selected.size > 0 && (
            <button
              onClick={handleDeleteSelected}
              disabled={deletingBulk}
              style={{
                ...toolBtn(true, true),
                opacity: deletingBulk ? 0.6 : 1,
              }}
            >
              <Trash2 size={13} strokeWidth={2.2} />
              {deletingBulk ? 'Deleting…' : `Delete selected (${selected.size})`}
            </button>
          )}

          <button
            onClick={handleMarkAllRead}
            disabled={unreadCount === 0 || markingAll}
            style={{ ...toolBtn(unreadCount > 0 && !markingAll), opacity: markingAll ? 0.6 : 1 }}
          >
            <CheckCheck size={14} strokeWidth={2.2} />
            {markingAll ? 'Marking…' : 'Mark all read'}
          </button>

          <button
            onClick={handleDeleteAll}
            disabled={deletingAll || rows.length === 0}
            style={{
              ...toolBtn(rows.length > 0 && !deletingAll, true),
              opacity: deletingAll ? 0.6 : 1,
            }}
          >
            <Trash2 size={13} strokeWidth={2.2} />
            {deletingAll ? 'Deleting…' : 'Delete all'}
          </button>
        </div>
      }
    >
      <div style={{ maxWidth: '680px', width: '100%' }}>

        {/* Error banner — the only user-visible signal that a delete failed.
            Non-disruptive: the list stays rendered underneath, and a rolled-back
            row is already back in place by the time this shows. */}
        {error && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: '9px',
            marginBottom: '12px', padding: '10px 14px',
            borderRadius: '8px',
            background: colors.redTint,
            border: `1px solid ${colors.red}33`,
          }}>
            <AlertTriangle size={14} color={colors.red} strokeWidth={2.2} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: '12.5px', fontWeight: 500, color: colors.red, fontFamily: font.body }}>
              {error}
            </span>
            <button
              onClick={() => setError(null)}
              title="Dismiss"
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: colors.red, fontSize: '15px', lineHeight: 1, padding: '0 2px', flexShrink: 0,
              }}
            >
              ×
            </button>
          </div>
        )}

        {rows.length === 0 ? (
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
            {rows.map((n, i) => {
              const em = eventMeta(n.event)
              const isSelected = selected.has(n.id)
              const isPending  = pendingDeletes.has(n.id)
              return (
                <div
                  key={n.id}
                  onClick={() => handleClickNotif(n)}
                  style={{
                    display: 'flex', alignItems: 'flex-start',
                    background: rowBackground(isSelected, n.is_read),
                    borderLeft: isSelected
                      ? `3px solid ${colors.blue}`
                      : n.is_read ? '3px solid transparent' : '3px solid #E8A030',
                    borderBottom: i < rows.length - 1 ? `1px solid ${colors.border}` : 'none',
                    cursor: 'pointer',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.background = rowBackground(isSelected, n.is_read, true)
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.background = rowBackground(isSelected, n.is_read)
                  }}
                >
                  {/* ── Checkbox ── */}
                  <div
                    onClick={e => { e.stopPropagation(); toggleSelect(n.id) }}
                    title={isSelected ? 'Deselect' : 'Select'}
                    style={{
                      flexShrink: 0,
                      width: '40px',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      alignSelf: 'stretch',
                      cursor: 'pointer',
                    }}
                  >
                    <span style={{
                      width: '16px', height: '16px', borderRadius: '4px',
                      border: `1.5px solid ${isSelected ? colors.blue : colors.borderSoft}`,
                      background: isSelected ? colors.blue : 'transparent',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      flexShrink: 0,
                      transition: 'all 0.12s',
                    }}>
                      {isSelected && <Check size={10} color="#fff" strokeWidth={3} />}
                    </span>
                  </div>

                  {/* Icon */}
                  <div style={{
                    width: 34, height: 34, borderRadius: '9px', flexShrink: 0,
                    background: em.bg,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    margin: '14px 12px 0 0',
                  }}>
                    <Bell size={14} strokeWidth={1.8} color={em.color} />
                  </div>

                  {/* Content */}
                  <div style={{ flex: 1, minWidth: 0, padding: '13px 0' }}>
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

                  {/* ── Right: open arrow + trash ── */}
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: '6px',
                    padding: '13px 12px 0 8px', flexShrink: 0,
                  }}>
                    <span style={{ color: colors.muted, display: 'inline-flex' }}>
                      <ArrowUpRight size={14} strokeWidth={1.8} />
                    </span>

                    {/* Per-row trash — disabled while THIS row's DELETE is in
                        flight, so a second click cannot fire a duplicate request. */}
                    <button
                      onClick={e => { e.stopPropagation(); handleDeleteSingle(n.id) }}
                      disabled={isPending}
                      title="Delete notification"
                      style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: '28px', height: '28px', borderRadius: '6px',
                        background: 'transparent',
                        color: colors.muted,
                        border: `1.5px solid ${colors.border}`,
                        cursor: isPending ? 'not-allowed' : 'pointer',
                        opacity: isPending ? 0.5 : 1,
                        flexShrink: 0,
                      }}
                    >
                      <Trash2 size={12} strokeWidth={2} />
                    </button>
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
