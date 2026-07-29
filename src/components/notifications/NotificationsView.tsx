'use client'

import { useEffect, useState, useMemo, useRef } from 'react'
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
import { Bell, CheckCheck, ExternalLink, Clock, Trash2, Check, AlertTriangle } from 'lucide-react'
import { useProfile } from '@/hooks/queries/useProfile'
import { useNotifications } from '@/hooks/queries/useNotifications'
import { useNotificationMutations } from '@/hooks/queries/useNotificationMutations'
import { notificationKeys } from '@/lib/notificationCache'

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
  /**
   * Which module's notifications this view owns ('task' | 'finance' | 'order').
   * Required: every list, count, mark-read and delete key is derived from it,
   * and an absent category would produce a list key with no matching count key.
   * All three host pages already pass it explicitly.
   */
  category: NotificationCategory
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
  const [loggedInId, setLoggedInId] = useState('')
  const [filter,     setFilter]     = useState<FilterTab>('all')
  const [selected,   setSelected]   = useState<Set<string>>(new Set())

  const router      = useRouter()
  const supabase    = useMemo(() => createClient(), [])
  const queryClient = useQueryClient()
  const { refreshKey } = useRefresh()

  const { data: profile = null } = useProfile(loggedInId)
  const {
    data: notifications = [],
    isLoading: notifLoading,
    isError: notifError,
    error: notifErrorObj,
  } = useNotifications(category)

  // All list/count cache work lives in this hook: optimistic update, snapshot,
  // rollback on any failure, per-id pending locks, and narrow reconciliation.
  const {
    markRead, markAllRead, deleteSingle, deleteSelected: runDeleteSelected, deleteAll,
    pendingDeletes, markingAll, deletingBulk, deletingAll,
    error: mutationError, clearError,
  } = useNotificationMutations(category)

  // If TQ has cached notifications, show them immediately without waiting for auth re-confirm.
  // Auth redirect (if needed) will fire from the init useEffect shortly after.
  const loading = notifLoading && notifications.length === 0

  // Refresh from the layout's Refresh button / tab-visibility. Two changes from
  // before, both about not fighting an in-flight mutation:
  //  · the initial run is skipped — mounting already fetches, so invalidating
  //    on mount only forced a second identical request every visit;
  //  · only THIS module's list and count are invalidated, not the whole
  //    ['notifications'] prefix, which also refetched the other two modules'
  //    lists and all three badges.
  const lastRefreshKey = useRef(refreshKey)
  useEffect(() => {
    if (lastRefreshKey.current === refreshKey) return
    lastRefreshKey.current = refreshKey
    queryClient.invalidateQueries({ queryKey: notificationKeys.list(category),  exact: true })
    queryClient.invalidateQueries({ queryKey: notificationKeys.count(category), exact: true })
  }, [refreshKey, category, queryClient])

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

  // Rows with a DELETE still in flight are hidden immediately and stay hidden
  // even if a concurrent refetch puts them back in the cache — the server has
  // been told to remove them, so showing them again would be a lie. If the
  // delete fails, the mutation clears the pending id and the row returns.
  const rows = useMemo(
    () => (pendingDeletes.size === 0 ? notifications : notifications.filter(n => !pendingDeletes.has(n.id))),
    [notifications, pendingDeletes],
  )

  const unreadCount = rows.filter(n => !n.is_read).length
  const visible = filter === 'unread' ? rows.filter(n => !n.is_read) : rows

  // Surfaced in the inline banner. A failed list fetch no longer renders as an
  // empty inbox — useNotifications throws, and TanStack keeps the last good
  // list on screen underneath this message.
  const banner = mutationError
    ?? (notifError
      ? (notifErrorObj instanceof Error ? notifErrorObj.message : 'Could not load notifications.')
      : null)

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  // ── Mutation entry points ───────────────────────────────────────────────
  // The optimistic update / snapshot / rollback / reconcile logic all lives in
  // useNotificationMutations; these wrappers only own local selection state.

  const handleDeleteSingle = (id: string) => {
    setSelected(prev => { const s = new Set(prev); s.delete(id); return s })
    deleteSingle(id)
  }

  const handleDeleteSelected = () => {
    if (deletingBulk || selected.size === 0) return
    const ids = [...selected]
    setSelected(new Set())
    runDeleteSelected(ids)
  }

  const handleDeleteAll = () => {
    if (deletingAll || rows.length === 0) return
    setSelected(new Set())
    deleteAll()
  }

  const handleMarkAllRead = () => {
    if (unreadCount === 0 || markingAll) return
    markAllRead()
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
      {/* Error banner — the only user-visible signal that a notification action
          failed. Non-disruptive: the list stays rendered underneath, and a
          rolled-back row is already back in place by the time this shows. */}
      {banner && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '9px',
          marginBottom: '12px', padding: '10px 14px',
          borderRadius: '8px',
          background: colors.redTint,
          border: `1px solid ${colors.red}33`,
          maxWidth: '900px',
        }}>
          <AlertTriangle size={14} color={colors.red} strokeWidth={2.2} style={{ flexShrink: 0 }} />
          <span style={{ flex: 1, fontSize: '12.5px', fontWeight: 500, color: colors.red, fontFamily: font.body }}>
            {banner}
          </span>
          {mutationError && (
            <button
              onClick={clearError}
              title="Dismiss"
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: colors.red, fontSize: '15px', lineHeight: 1, padding: '0 2px', flexShrink: 0,
              }}
            >
              ×
            </button>
          )}
        </div>
      )}

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

                  {/* Per-row trash — disabled while THIS row's DELETE is in
                      flight, so a second click cannot fire a duplicate request. */}
                  <button
                    onClick={e => { e.stopPropagation(); handleDeleteSingle(n.id) }}
                    disabled={pendingDeletes.has(n.id)}
                    title="Delete notification"
                    style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      width: '28px', height: '28px', borderRadius: '6px',
                      background: 'transparent',
                      color: colors.muted,
                      border: `1.5px solid ${colors.border}`,
                      cursor: pendingDeletes.has(n.id) ? 'not-allowed' : 'pointer',
                      opacity: pendingDeletes.has(n.id) ? 0.5 : 1,
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
    </Layout>
  )
}
