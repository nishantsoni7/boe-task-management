'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle, CalendarCheck, CalendarClock, CalendarDays, Layers,
} from 'lucide-react'
import { LoadingScreen } from '@/components/ui/atoms'
import { StatusTabs, accentFromBadge, BRAND_TAB_ACCENT, type StatusTab } from '@/components/ui/StatusTabs'
import { Toast, useToast } from '@/components/ui/toast'
import { colors } from '@/lib/tokens'
import { MeetingsLayout } from '@/components/layout/MeetingsLayout'
import { MeetingBadge } from '@/components/meetings/MeetingModal'
import { ItemUpdateModal } from '@/components/meetings/ItemUpdateModal'
import { useDepartments } from '@/components/meetings/MeetingOrderModals'
import { useMeetings } from '@/hooks/useMeetings'
import { useListUrlState, useUrlSearchInput } from '@/hooks/useListUrlState'
import { enumParam, optionParam, textParam } from '@/lib/listState'
import { fetchAllRows } from '@/lib/supabasePaging'
import { istToday } from '@/lib/istDate'
import {
  FOLLOW_UP_DUE_FILTERS, FOLLOW_UP_DUE_META, daysOverdue, filterFollowUps,
  followUpCounts, followUpDue, sortFollowUps,
  type FollowUpDueFilter, type FollowUpRow,
} from '@/lib/meetings/followUps'
import { previousUpdateForItem } from '@/lib/meetings/history'
import {
  ITEM_STATUSES, ITEM_STATUS_META, MEETING_HISTORY_COLUMNS, MEETING_ORDER_COLUMNS,
  MEETING_ORDER_ITEM_COLUMNS, MEETING_TYPES, MEETING_TYPE_META,
  departmentLabel, formatMeetingDate,
  type ItemStatus, type MeetingHistoryEntry, type MeetingOrder, type MeetingOrderItem,
  type MeetingType,
} from '@/lib/meetings/types'

// Due and Overdue follow-ups — one compact operational list.
//
// This is the screen someone opens on a Tuesday morning to find out what was
// promised and has not happened. It is deliberately a LIST and not a dashboard:
// no charts, no tiles, no summaries. Each row carries the eight facts needed to
// act — due date, order, SKU, meeting type, department, last update, when it was
// last updated, and any linked task — and one quick action that opens the same
// update dialog the meeting screen uses.
//
// Filters live in the URL, so opening a row and coming back restores the exact
// view, and the sidebar's "Due Follow-ups" / "Overdue" entries are just this
// screen with `?due=` preset.

const FOLLOW_UP_PARAMS = {
  due:    enumParam(FOLLOW_UP_DUE_FILTERS, 'all'),
  type:   optionParam(MEETING_TYPES),
  dept:   textParam(),
  status: optionParam(ITEM_STATUSES),
  q:      textParam(),
}

const COMPACT_CONTROL: React.CSSProperties = {
  width: 'auto', minWidth: '124px', maxWidth: '170px',
  padding: '6px 8px', fontSize: '12px', flexShrink: 0, cursor: 'pointer',
}

/** Everything the screen needs to open the update dialog for a row. */
type RowContext = { order: MeetingOrder; item: MeetingOrderItem }

/** The meeting fields this screen needs — type, and the write-permission inputs. */
type MeetingLite = {
  id: string
  meeting_type: MeetingType
  title: string
  status: string
  lead_id: string
  created_by: string
}

export function FollowUpsScreen() {
  const { supabase, profile, caps, loading: authLoading, signOut } = useMeetings()
  const router = useRouter()
  const { toast, show, dismiss } = useToast()
  const departments = useDepartments(supabase)

  const [rows, setRows]       = useState<FollowUpRow[]>([])
  const [contexts, setContexts] = useState<Record<string, RowContext>>({})
  const [history, setHistory] = useState<MeetingHistoryEntry[]>([])
  const [editableMeetings, setEditableMeetings] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [updating, setUpdating] = useState<RowContext | null>(null)
  const [isMobile, setIsMobile] = useState(false)

  const { state, setState, resetState } = useListUrlState(FOLLOW_UP_PARAMS)
  const [searchInput, setSearchInput, flushSearch] = useUrlSearchInput(
    state.q, next => setState({ q: next }),
  )

  // Computed once per render rather than per row, so a list rendered either
  // side of midnight cannot classify two rows against two different "todays".
  const today = istToday()

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 1000)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // Reads before it writes — the mount effect calls it directly, so nothing
  // here may set state before the first await. `refresh` is the wrapper that
  // shows the spinner, for Retry and for a save.
  const load = useCallback(async () => {
    // Every read below is already narrowed by RLS to the meetings this person
    // may see, so an employee's follow-up list is their own meetings' follow-ups
    // and a manager's is the company's. Nothing here re-implements that.
    //
    // Paged, because that scope is unbounded: for a manager holding 'manage'
    // this is every meeting the company has ever held. A plain select would be
    // silently capped at 1000 rows by PostgREST and the follow-ups belonging to
    // the oldest meetings would vanish from the Overdue list with no error at
    // all — the exact failure this repo has hit before
    // (src/lib/supabasePaging.ts).
    const meetingResult = await fetchAllRows<MeetingLite>((from, to) =>
      supabase
        .from('meetings')
        .select('id, meeting_type, title, status, lead_id, created_by')
        .order('id', { ascending: true })
        .range(from, to),
    )

    if (!meetingResult.ok || meetingResult.truncated) {
      console.error('[meetings:follow-ups] load failed', meetingResult)
      setLoadError('Could not load follow-ups. Check your connection and try again.')
      setLoading(false)
      return
    }
    setLoadError(null)

    const meetings = meetingResult.rows

    if (meetings.length === 0) {
      setRows([]); setContexts({}); setHistory([]); setEditableMeetings(new Set())
      setLoading(false)
      return
    }

    // Which meetings this person may still WRITE to. A completed meeting is
    // read-only, so its follow-ups are shown but not updatable from here — the
    // same rule the meeting screen applies, evaluated once for the whole list.
    setEditableMeetings(new Set(
      meetings
        .filter(m => m.status !== 'completed' && (
          caps.canConductMeeting || m.lead_id === profile?.id || m.created_by === profile?.id
        ))
        .map(m => m.id),
    ))

    const meetingById = new Map(meetings.map(m => [m.id, m]))
    const meetingIds = meetings.map(m => m.id)

    const orderResult = await fetchAllRows<MeetingOrder>((from, to) =>
      supabase
        .from('meeting_orders')
        .select(MEETING_ORDER_COLUMNS)
        .in('meeting_id', meetingIds)
        .order('id', { ascending: true })
        .range(from, to),
    )
    if (!orderResult.ok) {
      setLoadError('Could not load follow-ups. Please retry.')
      setLoading(false)
      return
    }
    const orderById = new Map(orderResult.rows.map(o => [o.id, o]))

    if (orderById.size === 0) {
      setRows([]); setContexts({}); setHistory([])
      setLoading(false)
      return
    }

    // Only dated, unresolved lines — the follow-up population, filtered in the
    // database rather than fetched whole and thrown away in the browser.
    const itemResult = await fetchAllRows<MeetingOrderItem>((from, to) =>
      supabase
        .from('meeting_order_items')
        .select(MEETING_ORDER_ITEM_COLUMNS)
        .in('meeting_order_id', [...orderById.keys()])
        .not('next_follow_up_date', 'is', null)
        .neq('status', 'resolved')
        .order('id', { ascending: true })
        .range(from, to),
    )
    if (!itemResult.ok) {
      setLoadError('Could not load follow-ups. Please retry.')
      setLoading(false)
      return
    }

    const taskIds = [...new Set(itemResult.rows.map(i => i.linked_task_id).filter((id): id is string => !!id))]
    const taskById = new Map<string, { title: string; status: string }>()
    if (taskIds.length > 0) {
      const { data: taskRows } = await supabase
        .from('tasks')
        .select('id, title, status')
        .in('id', taskIds)
      for (const t of (taskRows ?? []) as { id: string; title: string; status: string }[]) {
        taskById.set(t.id, { title: t.title, status: t.status })
      }
    }

    const nextRows: FollowUpRow[] = []
    const nextContexts: Record<string, RowContext> = {}

    for (const item of itemResult.rows) {
      const order = orderById.get(item.meeting_order_id)
      if (!order) continue
      const meeting = meetingById.get(order.meeting_id)
      if (!meeting) continue

      const task = item.linked_task_id ? taskById.get(item.linked_task_id) : undefined
      nextRows.push({
        itemId: item.id,
        meetingId: meeting.id,
        meetingType: meeting.meeting_type,
        orderId: order.id,
        orderNumber: order.order_number,
        sku: item.sku,
        productName: item.product_name,
        responsibleDepartment: item.responsible_department,
        latestUpdate: item.latest_update,
        lastUpdatedAt: item.updated_at,
        nextFollowUpDate: item.next_follow_up_date,
        status: item.status,
        linkedTaskId: item.linked_task_id,
        linkedTaskTitle: task?.title ?? null,
        linkedTaskStatus: task?.status ?? null,
      })
      nextContexts[item.id] = { order, item }
    }

    setRows(nextRows)
    setContexts(nextContexts)

    // History only for the lines on this screen — the "previously" line in the
    // update dialog needs it, and reading every meeting's whole trail to render
    // a list would not be worth it.
    const itemIds = itemResult.rows.map(i => i.id)
    if (itemIds.length > 0) {
      const historyResult = await fetchAllRows<MeetingHistoryEntry>((from, to) =>
        supabase
          .from('meeting_update_history')
          .select(MEETING_HISTORY_COLUMNS)
          .in('meeting_order_item_id', itemIds)
          .order('id', { ascending: true })
          .range(from, to),
      )
      setHistory(historyResult.ok ? historyResult.rows : [])
    } else {
      setHistory([])
    }

    setLoading(false)
  }, [supabase, caps.canConductMeeting, profile?.id])

  const refresh = useCallback(async () => {
    setLoading(true)
    await load()
  }, [load])

  useEffect(() => {
    if (authLoading) return
    // Called through a local function rather than directly, matching the
    // convention in src/app/assets-access/[id]/page.tsx: the effect schedules
    // the read, it does not itself set state.
    const run = () => { void load() }
    run()
  }, [authLoading, load])

  const filters = useMemo(() => ({
    due: state.due as FollowUpDueFilter,
    meetingType: state.type as MeetingType | '',
    department: state.dept,
    status: state.status as ItemStatus | '',
    search: state.q,
  }), [state])

  const counts  = useMemo(() => followUpCounts(rows, filters, today), [rows, filters, today])
  const visible = useMemo(
    () => sortFollowUps(filterFollowUps(rows, filters, today)),
    [rows, filters, today],
  )

  const filtersActive =
    filters.due !== 'all' || !!filters.meetingType || !!filters.department
    || !!filters.status || filters.search.trim() !== ''

  const tabs: StatusTab<FollowUpDueFilter>[] = [
    { key: 'all',      label: 'All',      Icon: Layers,        accent: BRAND_TAB_ACCENT,                            count: counts.all },
    { key: 'overdue',  label: 'Overdue',  Icon: AlertTriangle, accent: accentFromBadge(FOLLOW_UP_DUE_META.overdue), count: counts.overdue },
    { key: 'today',    label: 'Due Today', Icon: CalendarCheck, accent: accentFromBadge(FOLLOW_UP_DUE_META.today),  count: counts.today },
    { key: 'upcoming', label: 'Upcoming', Icon: CalendarDays,  accent: accentFromBadge(FOLLOW_UP_DUE_META.upcoming), count: counts.upcoming },
  ]

  if (authLoading) return <LoadingScreen />

  return (
    <MeetingsLayout
      profile={profile}
      title="Follow-ups"
      subtitle="Everything committed to in a review and not yet resolved."
      onSignOut={signOut}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' }}>
        <input
          className="boe-input"
          aria-label="Search follow-ups"
          placeholder="Search order, SKU, product or update…"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          onBlur={flushSearch}
          style={{ flex: 1, minWidth: '180px', maxWidth: '300px', padding: '6px 10px', fontSize: '12px' }}
        />
        <select
          className="boe-input"
          aria-label="Filter by meeting type"
          value={filters.meetingType}
          onChange={e => setState({ type: e.target.value as MeetingType | '' })}
          style={COMPACT_CONTROL}
        >
          <option value="">All meetings</option>
          {MEETING_TYPES.map(t => (
            <option key={t} value={t}>{MEETING_TYPE_META[t].label}s</option>
          ))}
        </select>
        <select
          className="boe-input"
          aria-label="Filter by responsible department"
          value={filters.department}
          onChange={e => setState({ dept: e.target.value })}
          style={COMPACT_CONTROL}
        >
          <option value="">All departments</option>
          {departments.map(d => <option key={d.key} value={d.key}>{d.name}</option>)}
        </select>
        <select
          className="boe-input"
          aria-label="Filter by status"
          value={filters.status}
          onChange={e => setState({ status: e.target.value as ItemStatus | '' })}
          style={COMPACT_CONTROL}
        >
          <option value="">Open and waiting</option>
          {ITEM_STATUSES.filter(s => s !== 'resolved').map(s => (
            <option key={s} value={s}>{ITEM_STATUS_META[s].label}</option>
          ))}
        </select>
        {filtersActive && (
          <button
            onClick={() => { setSearchInput(''); resetState() }}
            style={{
              padding: '6px 10px', borderRadius: '8px', fontSize: '12px', fontWeight: 600,
              cursor: 'pointer', border: `1px solid ${colors.border}`,
              background: 'transparent', color: colors.muted, whiteSpace: 'nowrap', flexShrink: 0,
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {loadError && (
        <div role="alert" style={{
          padding: '10px 14px', borderRadius: '8px', marginBottom: '10px',
          background: colors.redTint, border: '1px solid rgba(217,79,79,0.25)',
          fontSize: '13px', color: colors.red,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px',
        }}>
          <span>{loadError}</span>
          <button onClick={refresh} className="boe-btn boe-btn-ghost" style={{ padding: '4px 12px', fontSize: '12px' }}>
            Retry
          </button>
        </div>
      )}

      <div style={{
        background: colors.base, border: `1px solid ${colors.border}`,
        borderRadius: '10px', overflow: 'hidden',
      }}>
        <StatusTabs
          tabs={tabs}
          active={filters.due}
          onSelect={key => setState({ due: key })}
          summary={loading ? 'Loading…' : `${visible.length} shown`}
        />

        {loading ? (
          <div style={{ padding: '32px', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>Loading…</div>
        ) : visible.length === 0 ? (
          <EmptyFollowUps
            filtersActive={filtersActive}
            due={filters.due}
            onClear={() => { setSearchInput(''); resetState() }}
          />
        ) : isMobile ? (
          <div style={{ padding: '10px' }}>
            {visible.map(row => (
              <FollowUpCard
                key={row.itemId}
                row={row}
                today={today}
                canUpdate={editableMeetings.has(row.meetingId)}
                onUpdate={() => { const c = contexts[row.itemId]; if (c) setUpdating(c) }}
                onOpenMeeting={() => router.push(`/meetings/${row.meetingId}`)}
                onOpenTask={id => router.push(`/tasks/${id}`)}
              />
            ))}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                  {['Due', 'Order', 'Product', 'Meeting', 'Owner', 'Last Update', 'Task', ''].map(h => (
                    <th key={h} style={{
                      padding: '7px 12px', textAlign: 'left',
                      fontSize: '10px', fontWeight: 600, color: colors.muted,
                      textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map(row => {
                  const due = followUpDue(row.nextFollowUpDate, row.status, today)
                  const meta = due ? FOLLOW_UP_DUE_META[due] : null
                  return (
                    <tr key={row.itemId} style={{ borderBottom: `1px solid ${colors.border}`, verticalAlign: 'top' }}>
                      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                        <div style={{ fontWeight: 600, color: meta?.color ?? colors.secondary }}>
                          {formatMeetingDate(row.nextFollowUpDate)}
                        </div>
                        {due === 'overdue' && row.nextFollowUpDate && (
                          <div style={{ fontSize: '10px', fontWeight: 700, color: meta?.color }}>
                            {daysOverdue(row.nextFollowUpDate, today)} day
                            {daysOverdue(row.nextFollowUpDate, today) === 1 ? '' : 's'} overdue
                          </div>
                        )}
                        {due === 'today' && (
                          <div style={{ fontSize: '10px', fontWeight: 700, color: meta?.color }}>Due today</div>
                        )}
                      </td>
                      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                        <button
                          onClick={() => router.push(`/meetings/${row.meetingId}`)}
                          style={{
                            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                            fontWeight: 700, color: colors.primary, fontSize: '12.5px',
                            textDecoration: 'underline', textUnderlineOffset: '2px',
                          }}
                        >
                          {row.orderNumber}
                        </button>
                      </td>
                      <td style={{ padding: '10px 12px', minWidth: '140px' }}>
                        <div style={{ fontWeight: 600, color: colors.primary }}>{row.sku}</div>
                        <div style={{ fontSize: '11.5px', color: colors.muted }}>{row.productName}</div>
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <MeetingBadge meta={MEETING_TYPE_META[row.meetingType]} />
                      </td>
                      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                        <div style={{ color: colors.secondary }}>{departmentLabel(row.responsibleDepartment)}</div>
                        <div style={{ marginTop: '3px' }}>
                          <MeetingBadge meta={ITEM_STATUS_META[row.status]} />
                        </div>
                      </td>
                      <td style={{ padding: '10px 12px', minWidth: '200px', maxWidth: '340px' }}>
                        <div style={{ color: row.latestUpdate ? colors.primary : colors.muted, lineHeight: 1.4 }}>
                          {row.latestUpdate ?? 'No update recorded'}
                        </div>
                        <div style={{ fontSize: '10.5px', color: colors.muted, marginTop: '2px' }}>
                          {row.lastUpdatedAt ? formatMeetingDate(row.lastUpdatedAt) : '—'}
                        </div>
                      </td>
                      <td style={{ padding: '10px 12px', minWidth: '110px' }}>
                        {row.linkedTaskId ? (
                          <button
                            onClick={() => router.push(`/tasks/${row.linkedTaskId}`)}
                            style={{
                              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                              textAlign: 'left',
                            }}
                          >
                            <span className={`boe-badge boe-badge-${row.linkedTaskStatus ?? 'pending'}`} style={{ textTransform: 'capitalize' }}>
                              {row.linkedTaskStatus ?? 'Task'}
                            </span>
                          </button>
                        ) : (
                          <span style={{ fontSize: '11.5px', color: colors.muted }}>—</span>
                        )}
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {editableMeetings.has(row.meetingId) ? (
                          <button
                            onClick={() => { const c = contexts[row.itemId]; if (c) setUpdating(c) }}
                            className="boe-btn boe-btn-primary"
                            style={{ padding: '5px 11px', fontSize: '12px' }}
                          >
                            Update
                          </button>
                        ) : (
                          <span
                            title="This meeting is completed — reopen it to record a change"
                            style={{ fontSize: '11px', color: colors.muted }}
                          >
                            Read-only
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {updating && (
        <ItemUpdateModal
          supabase={supabase}
          order={updating.order}
          item={updating.item}
          previousUpdate={previousUpdateForItem(history, updating.item.id)}
          hasNext={false}
          onClose={() => setUpdating(null)}
          onSaved={async () => { setUpdating(null); await refresh(); show('Update saved') }}
          onSavedNext={async () => { setUpdating(null); await refresh(); show('Update saved') }}
        />
      )}

      <Toast toast={toast} onDismiss={dismiss} />
    </MeetingsLayout>
  )
}

function FollowUpCard({
  row, today, canUpdate, onUpdate, onOpenMeeting, onOpenTask,
}: {
  row: FollowUpRow
  today: string
  canUpdate: boolean
  onUpdate: () => void
  onOpenMeeting: () => void
  onOpenTask: (id: string) => void
}) {
  const due = followUpDue(row.nextFollowUpDate, row.status, today)
  const meta = due ? FOLLOW_UP_DUE_META[due] : null

  return (
    <div style={{
      border: `1px solid ${colors.border}`, borderRadius: '10px',
      padding: '11px 13px', marginBottom: '8px', background: colors.base,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '12px', fontWeight: 700, color: meta?.color ?? colors.secondary }}>
          {formatMeetingDate(row.nextFollowUpDate)}
          {due === 'overdue' && row.nextFollowUpDate && ` · ${daysOverdue(row.nextFollowUpDate, today)}d overdue`}
          {due === 'today' && ' · due today'}
        </span>
        <MeetingBadge meta={MEETING_TYPE_META[row.meetingType]} />
      </div>

      <button
        onClick={onOpenMeeting}
        style={{
          background: 'none', border: 'none', padding: 0, marginTop: '6px',
          cursor: 'pointer', textAlign: 'left', display: 'block',
        }}
      >
        <span style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>
          {row.orderNumber} · {row.sku}
        </span>
      </button>
      <div style={{ fontSize: '11.5px', color: colors.muted }}>{row.productName}</div>

      <div style={{
        marginTop: '7px', fontSize: '12.5px',
        color: row.latestUpdate ? colors.primary : colors.muted, lineHeight: 1.4,
      }}>
        {row.latestUpdate ?? 'No update recorded'}
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '8px',
      }}>
        <MeetingBadge meta={ITEM_STATUS_META[row.status]} />
        <span style={{ fontSize: '11.5px', color: colors.muted }}>
          {departmentLabel(row.responsibleDepartment)}
        </span>
        {row.linkedTaskId && (
          <button
            onClick={() => onOpenTask(row.linkedTaskId!)}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
          >
            <span className={`boe-badge boe-badge-${row.linkedTaskStatus ?? 'pending'}`} style={{ textTransform: 'capitalize' }}>
              {row.linkedTaskStatus ?? 'Task'}
            </span>
          </button>
        )}
      </div>

      {canUpdate && (
        <button
          onClick={onUpdate}
          className="boe-btn boe-btn-primary"
          style={{ marginTop: '10px', padding: '7px 14px', fontSize: '12.5px', width: '100%' }}
        >
          Quick Update
        </button>
      )}
    </div>
  )
}

function EmptyFollowUps({
  filtersActive, due, onClear,
}: { filtersActive: boolean; due: FollowUpDueFilter; onClear: () => void }) {
  if (filtersActive) {
    const message = due === 'overdue'
      ? 'Nothing is overdue.'
      : due === 'today'
        ? 'Nothing is due today.'
        : 'No follow-ups match the current filters.'
    return (
      <div style={{ padding: '44px 24px', textAlign: 'center' }}>
        <CalendarCheck size={26} strokeWidth={1.4} color={colors.muted} />
        <p style={{ fontSize: '13px', fontWeight: 600, color: colors.secondary, marginTop: '10px' }}>{message}</p>
        <button
          onClick={onClear}
          className="boe-btn boe-btn-ghost"
          style={{ marginTop: '10px', padding: '6px 14px', fontSize: '12px' }}
        >
          Clear filters
        </button>
      </div>
    )
  }

  return (
    <div style={{ padding: '48px 24px', textAlign: 'center' }}>
      <CalendarClock size={28} strokeWidth={1.4} color={colors.muted} />
      <p style={{ fontSize: '13px', fontWeight: 600, color: colors.secondary, marginTop: '10px' }}>
        No follow-ups scheduled
      </p>
      <p style={{
        fontSize: '12px', color: colors.muted, marginTop: '4px',
        maxWidth: '380px', margin: '4px auto 0', lineHeight: 1.5,
      }}>
        A product line appears here when someone sets a follow-up date on it during a review.
        Resolved lines drop off automatically.
      </p>
    </div>
  )
}
