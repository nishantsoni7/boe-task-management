'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { useRefresh } from '@/contexts/RefreshContext'
import type { Notification, UserProfile } from '@/lib/types'
import type { NotificationCategory } from '@/lib/notifications'
import { getNotificationMeta } from '@/lib/notificationMeta'
import { timeAgo } from '@/lib/ui'
import { colors, font } from '@/lib/tokens'
import { LoadingScreen } from '@/components/ui/atoms'
import { Bell, CheckCheck, ExternalLink, Clock, Trash2, Check } from 'lucide-react'
import { useProfile } from '@/hooks/queries/useProfile'
import { useNotifications } from '@/hooks/queries/useNotifications'

type FilterTab = 'all' | 'unread'

// `title` is typed as `string` (not `React.ReactNode`) because FinanceLayout's
// prop is `string`-only — NotificationsView always passes the literal string
// "Notifications" anyway, so this stays compatible with both DashboardLayout
// (which accepts the broader ReactNode) and FinanceLayout.
type LayoutComponent = React.ComponentType<{
  profile: UserProfile | null
  title: string
  subtitle?: string
  actions?: React.ReactNode
  onSignOut: () => void
  children: React.ReactNode
}>

type NotificationsViewProps = {
  /** Narrows the list to one module (e.g. 'finance'). Omit for the global/shared view. */
  category?: NotificationCategory
  /** The module shell to render inside — DashboardLayout for the global page, FinanceLayout for Finance's. */
  Layout: LayoutComponent
  /** Where to send the user after logging out. */
  loginRedirectPath?: string
}

// Shared notification list UI + mutations, reused by the global /notifications
// page and module-scoped pages (e.g. /finance/notifications). All fetches and
// mutations go through the same /api/notifications* endpoints; `category` (when
// given) is threaded through every request so list, count, mark-read and
// delete all agree on exactly which rows belong to this view — see
// getNotificationCategoryFilter in src/lib/notifications.ts.
export function NotificationsView({ category, Layout, loginRedirectPath = '/login' }: NotificationsViewProps) {
  const [loggedInId,   setLoggedInId]   = useState('')
  const [filter,       setFilter]       = useState<FilterTab>('all')
  const [selected,     setSelected]     = useState<Set<string>>(new Set())
  const [markingAll,   setMarkingAll]   = useState(false)
  const [deletingAll,  setDeletingAll]  = useState(false)
  const [deletingBulk, setDeletingBulk] = useState(false)

  const router      = useRouter()
  const supabase    = useMemo(() => createClient(), [])
  const queryClient = useQueryClient()
  const { refreshKey } = useRefresh()

  const listKey = useMemo(() => (category ? ['notifications', category] : ['notifications']), [category])
  const categoryQuery = category ? `?category=${category}` : ''

  const { data: profile = null } = useProfile(loggedInId)
  const { data: notifications = [], isLoading: notifLoading } = useNotifications(category)

  // If TQ has cached notifications, show them immediately without waiting for auth re-confirm.
  // Auth redirect (if needed) will fire from the init useEffect shortly after.
  const loading = notifLoading && notifications.length === 0

  // Invalidate notifications cache when refresh is triggered from elsewhere
  useEffect(() => {
    queryClient.invalidateQueries({ queryKey: ['notifications'] })
  }, [refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auth check — once on mount
  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push(loginRedirectPath); return }
      setLoggedInId(user.id)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Prefetch task detail pages for notifications in view
  useEffect(() => {
    if (notifications.length === 0) return
    notifications.slice(0, 12).forEach(n => {
      if (n.task_id) router.prefetch(`/tasks/${n.task_id}`)
    })
  }, [notifications]) // eslint-disable-line react-hooks/exhaustive-deps

  const unreadCount = notifications.filter(n => !n.is_read).length
  const visible = filter === 'unread'
    ? notifications.filter(n => !n.is_read)
    : notifications

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  // Every mutation invalidates the root ['notifications'] / ['notifications','count']
  // keys rather than the scoped ones — TanStack's default fuzzy prefix match means
  // that also covers ['notifications','finance'] / ['notifications','count','finance'],
  // so a Finance-page action clears the global badge too, and vice versa.
  const invalidateCounts = () => queryClient.invalidateQueries({ queryKey: ['notifications', 'count'] })

  // ── Mutation helpers — update TQ cache immediately, rollback on failure ──────

  const markAllRead = async () => {
    if (unreadCount === 0 || markingAll) return
    setMarkingAll(true)
    const now = new Date().toISOString()
    const snapshot = queryClient.getQueryData<Notification[]>(listKey)
    queryClient.setQueryData<Notification[]>(listKey,
      old => (old ?? []).map(n => n.is_read ? n : { ...n, is_read: true, read_at: now }))
    const res = await fetch('/api/notifications/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true, category }),
    })
    if (!res.ok) {
      queryClient.setQueryData(listKey, snapshot)
      console.error('[notifications] mark all failed:', await res.json().catch(() => null))
    } else {
      invalidateCounts()
    }
    setMarkingAll(false)
  }

  const markRead = (id: string) => {
    const now = new Date().toISOString()
    queryClient.setQueryData<Notification[]>(listKey,
      old => (old ?? []).map(n => n.id === id ? { ...n, is_read: true, read_at: now } : n))
    fetch('/api/notifications/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
      .then(res => { if (res.ok) invalidateCounts() })
      .catch(() => queryClient.invalidateQueries({ queryKey: ['notifications'] }))
  }

  const deleteSingle = (id: string) => {
    queryClient.setQueryData<Notification[]>(listKey,
      old => (old ?? []).filter(n => n.id !== id))
    setSelected(prev => { const s = new Set(prev); s.delete(id); return s })
    fetch(`/api/notifications/${id}`, { method: 'DELETE' })
      .then(res => { if (res.ok) invalidateCounts() })
      .catch(() => queryClient.invalidateQueries({ queryKey: ['notifications'] }))
  }

  const deleteSelected = async () => {
    if (deletingBulk || selected.size === 0) return
    setDeletingBulk(true)
    const ids = [...selected]
    const snapshot = queryClient.getQueryData<Notification[]>(listKey)
    queryClient.setQueryData<Notification[]>(listKey,
      old => (old ?? []).filter(n => !selected.has(n.id)))
    setSelected(new Set())
    const res = await fetch('/api/notifications/delete-selected', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
    if (!res.ok) {
      queryClient.setQueryData(listKey, snapshot)
      console.error('[notifications] delete selected failed:', await res.json().catch(() => null))
    } else {
      invalidateCounts()
    }
    setDeletingBulk(false)
  }

  const deleteAll = async () => {
    if (deletingAll || notifications.length === 0) return
    setDeletingAll(true)
    const snapshot = queryClient.getQueryData<Notification[]>(listKey)
    queryClient.setQueryData<Notification[]>(listKey, [])
    setSelected(new Set())
    const res = await fetch(`/api/notifications${categoryQuery}`, { method: 'DELETE' })
    if (!res.ok) {
      queryClient.setQueryData(listKey, snapshot)
      console.error('[notifications] delete all failed:', await res.json().catch(() => null))
    } else {
      invalidateCounts()
    }
    setDeletingAll(false)
  }

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const s = new Set(prev)
      if (s.has(id)) s.delete(id)
      else s.add(id)
      return s
    })
  }

  const openNotif = (n: Notification) => {
    if (!n.is_read) markRead(n.id)
    const href = getNotificationMeta(n).href
    if (href) router.push(href)
  }

  const handleRowClick = (n: Notification) => {
    if (!n.is_read) markRead(n.id)
  }

  if (loading) return <LoadingScreen />

  // ── Toolbar button base style helpers ─────────────────────────────────────
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
    <Layout
      profile={profile}
      title="Notifications"
      subtitle={unreadCount > 0 ? `${unreadCount} unread` : 'You are all caught up'}
      onSignOut={handleLogout}
      actions={
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {/* Delete selected — only shown when something is selected */}
          {selected.size > 0 && (
            <button
              onClick={deleteSelected}
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
            onClick={markAllRead}
            disabled={unreadCount === 0 || markingAll}
            style={{ ...toolBtn(unreadCount > 0 && !markingAll), opacity: markingAll ? 0.6 : 1 }}
          >
            <CheckCheck size={14} strokeWidth={2.2} />
            {markingAll ? 'Marking…' : 'Mark all read'}
          </button>

          <button
            onClick={deleteAll}
            disabled={deletingAll || notifications.length === 0}
            style={{
              ...toolBtn(notifications.length > 0 && !deletingAll, true),
              opacity: deletingAll ? 0.6 : 1,
            }}
          >
            <Trash2 size={13} strokeWidth={2.2} />
            {deletingAll ? 'Deleting…' : 'Delete all'}
          </button>
        </div>
      }
    >
      {/* Filter pills */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '16px' }}>
        {(['all', 'unread'] as FilterTab[]).map(tab => (
          <button
            key={tab}
            onClick={() => setFilter(tab)}
            style={{
              padding: '5px 14px', borderRadius: '20px',
              fontSize: '12px', fontWeight: 600,
              border: `1.5px solid ${filter === tab ? colors.blue : colors.border}`,
              background: filter === tab ? colors.blue : 'transparent',
              color: filter === tab ? '#fff' : colors.secondary,
              cursor: 'pointer', fontFamily: font.body,
              transition: 'all 0.12s',
            }}
          >
            {tab === 'all' ? 'All' : `Unread${unreadCount > 0 ? ` (${unreadCount})` : ''}`}
          </button>
        ))}
      </div>

      {/* Empty state */}
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
            {filter === 'unread' ? 'No unread notifications' : 'No notifications yet'}
          </span>
          <span style={{ fontSize: '12px', color: colors.muted }}>
            {filter === 'unread' ? 'Switch to All to see your history.' : 'Important activity will appear here.'}
          </span>
        </div>
      ) : (
        <div className="boe-card" style={{ overflow: 'hidden', padding: 0, maxWidth: '900px' }}>
          {visible.map((n, i) => {
            const meta = getNotificationMeta(n)
            const isSelected = selected.has(n.id)
            // Primary line is the task title (body) for person-driven task rows;
            // for module rows and system rows it is the operational title so the
            // request number / headline stays visible. Body then becomes the
            // secondary context line (task title, or client name for modules).
            const primaryText   = meta.headingIsActor && n.body ? n.body : n.title
            const secondaryText = meta.headingIsActor && n.body ? null : n.body

            return (
              <div
                key={n.id}
                onClick={() => handleRowClick(n)}
                style={{
                  display: 'flex', alignItems: 'center',
                  borderLeft: isSelected
                    ? `3px solid ${colors.blue}`
                    : n.is_read ? '3px solid transparent' : `3px solid ${colors.blue}`,
                  background: isSelected
                    ? 'rgba(85,133,232,0.10)'
                    : n.is_read ? '#ffffff' : colors.blueTint,
                  borderBottom: i < visible.length - 1 ? `1px solid ${colors.border}` : 'none',
                  transition: 'background 0.12s',
                  cursor: n.is_read ? 'default' : 'pointer',
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

                {/* ── Content ── */}
                <div style={{
                  flex: 1, minWidth: 0,
                  padding: '13px 8px 13px 0',
                  display: 'flex', flexDirection: 'column', gap: '4px',
                }}>
                  {/* Heading (task actor or module label) + badge */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' }}>
                    <span style={{
                      fontSize: '13px',
                      fontWeight: meta.headingIsActor ? 700 : 600,
                      color: meta.headingIsActor ? colors.primary : colors.secondary,
                      lineHeight: 1,
                    }}>
                      {meta.heading}
                    </span>
                    <span style={{
                      display: 'inline-flex', alignItems: 'center',
                      padding: '2px 7px', borderRadius: '20px',
                      fontSize: '10.5px', fontWeight: 600, lineHeight: 1,
                      color: meta.badge.color, background: meta.badge.bg,
                      letterSpacing: '0.01em',
                    }}>
                      {meta.badge.label}
                    </span>
                  </div>

                  {/* Primary line */}
                  {primaryText && (
                    <div style={{
                      fontSize: '12px',
                      color: n.is_read ? colors.tertiary : colors.secondary,
                      fontWeight: 500, lineHeight: 1.35,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {primaryText}
                    </div>
                  )}
                  {/* Secondary context (task title, or client name for modules) */}
                  {secondaryText && (
                    <div style={{
                      fontSize: '12px', color: colors.tertiary, lineHeight: 1.35,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {secondaryText}
                    </div>
                  )}

                  {/* Time */}
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: '4px',
                    fontSize: '11px', color: colors.muted, marginTop: '1px',
                  }}>
                    <Clock size={10} strokeWidth={1.8} />
                    {timeAgo(n.created_at)}
                  </div>
                </div>

                {/* ── Right: View action + trash — fixed width so all rows align ── */}
                <div style={{
                  width: '148px',
                  display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
                  gap: '6px',
                  padding: '0 16px 0 8px', flexShrink: 0,
                }}>
                  {meta.href ? (
                    <button
                      onClick={e => { e.stopPropagation(); openNotif(n) }}
                      title={meta.actionLabel}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: '5px',
                        padding: '5px 12px', borderRadius: '6px',
                        fontSize: '11.5px', fontWeight: 600,
                        background: colors.blue,
                        color: '#fff',
                        border: 'none', cursor: 'pointer',
                        fontFamily: font.body, whiteSpace: 'nowrap',
                      }}
                    >
                      <ExternalLink size={11} strokeWidth={2.2} />
                      {meta.actionLabel}
                    </button>
                  ) : (
                    <span style={{ display: 'inline-block', width: '82px' }} />
                  )}

                  {/* Per-row trash */}
                  <button
                    onClick={e => { e.stopPropagation(); deleteSingle(n.id) }}
                    title="Delete notification"
                    style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      width: '28px', height: '28px', borderRadius: '6px',
                      background: 'transparent',
                      color: colors.muted,
                      border: `1.5px solid ${colors.border}`,
                      cursor: 'pointer', flexShrink: 0,
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
    </Layout>
  )
}
