'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  AlertTriangle, ArrowLeft, CalendarPlus, CheckCircle2, ChevronLeft, ClipboardList,
  History as HistoryIcon, Pencil, Plus, RotateCcw, Search, Trash2, Upload, Users,
} from 'lucide-react'
import { LoadingScreen } from '@/components/ui/atoms'
import { Toast, useToast } from '@/components/ui/toast'
import { colors } from '@/lib/tokens'
import { MeetingsLayout } from '@/components/layout/MeetingsLayout'
import { MeetingBadge } from '@/components/meetings/MeetingModal'
import { MeetingFormModal } from '@/components/meetings/MeetingFormModal'
import { ItemUpdateModal } from '@/components/meetings/ItemUpdateModal'
import { MeetingTaskModal } from '@/components/meetings/MeetingTaskModal'
import { MeetingHistoryModal } from '@/components/meetings/MeetingHistoryModal'
import { MeetingActivityModal } from '@/components/meetings/MeetingActivityModal'
import { MeetingImportModal } from '@/components/meetings/MeetingImportModal'
import { CompleteMeetingModal, ReopenMeetingModal } from '@/components/meetings/CompleteMeetingModal'
import {
  AddItemModal, AddOrderModal, OrderUpdateModal, RemoveOrderModal,
} from '@/components/meetings/MeetingOrderModals'
import { useMeetings } from '@/hooks/useMeetings'
import { canEditThisMeeting, canSetThisMeetingStatus } from '@/lib/permissions/meetings'
import { historyForItem, historyForOrder, previousUpdateByItem } from '@/lib/meetings/history'
import { followUpDue, daysOverdue, FOLLOW_UP_DUE_META } from '@/lib/meetings/followUps'
import { meetingErrorMessage, logMeetingFailure } from '@/lib/meetings/errors'
import { fetchAllRows } from '@/lib/supabasePaging'
import { hasPermission } from '@/lib/permissions/resolver'
import {
  ITEM_STATUS_META, MEETING_COLUMNS, MEETING_HISTORY_COLUMNS, MEETING_ORDER_COLUMNS,
  MEETING_ORDER_ITEM_COLUMNS, MEETING_STATUS_META, MEETING_TYPE_META,
  MEETING_ACTIVITY_COLUMNS, ORDER_POSITION_META, departmentLabel, formatMeetingDate,
  type LinkedTask, type Meeting, type MeetingActivityEntry, type MeetingHistoryEntry,
  type MeetingOrder, type MeetingOrderItem,
} from '@/lib/meetings/types'

// The meeting working screen — one screen, no nested pages.
//
// It is laid out for the sequence a review is actually conducted in:
//
//   1. open the meeting                → this page
//   2. open or search an order         → the order rail on the left
//   3. review its SKU lines            → the table on the right
//   4. see the previous commitment     → the "Previously" line under each update
//   5. enter the update                → one dialog, three fields
//   6. set the follow-up, or create a task → separate actions on the same row
//   7. move to the next SKU            → "Save & next" inside the dialog
//
// Nothing in that sequence navigates away, and every action is a dialog over
// this screen rather than a route.

type ModalState =
  | { kind: 'none' }
  | { kind: 'edit-meeting' }
  | { kind: 'add-order' }
  | { kind: 'order-update'; order: MeetingOrder }
  | { kind: 'remove-order'; order: MeetingOrder }
  | { kind: 'add-item'; order: MeetingOrder }
  | { kind: 'item-update'; order: MeetingOrder; item: MeetingOrderItem; focus: 'update' | 'follow_up' }
  | { kind: 'create-task'; order: MeetingOrder; item: MeetingOrderItem }
  | { kind: 'history'; title: string; subtitle?: string; entries: MeetingHistoryEntry[] }
  | { kind: 'activity' }
  | { kind: 'import' }
  | { kind: 'complete' }
  | { kind: 'reopen' }

export function MeetingWorkScreen() {
  const routeParams = useParams<{ id: string }>()
  const meetingId = routeParams?.id ?? ''
  const router = useRouter()
  const { supabase, profile, caps, loading: authLoading, signOut } = useMeetings()

  // Creating a task from a meeting writes into Task Management, so it needs
  // that module's entry grant as well as the Meetings one. 20260905000000 makes
  // the database refuse the INSERT regardless; this is the UI half, so the
  // control is absent rather than offered and then rejected.
  //
  // Deny-by-default: false until the check answers, so the button cannot flash
  // for someone who may not use it. Everything else in Meetings is unaffected.
  const [canCreateTasks, setCanCreateTasks] = useState(false)
  useEffect(() => {
    if (!profile) return          // stays false — the initial, denying value
    let active = true
    // Resolved asynchronously even for an admin, so nothing sets state
    // synchronously inside the effect and no cascading render is triggered.
    const resolved = profile.role === 'admin'
      ? Promise.resolve(true)
      : hasPermission(supabase, profile.id, 'task_management', 'view')
    resolved
      .then(allowed => { if (active) setCanCreateTasks(allowed) })
      .catch(() => { if (active) setCanCreateTasks(false) })
    return () => { active = false }
  }, [supabase, profile])
  const { toast, show, dismiss } = useToast()

  const [meeting, setMeeting]     = useState<Meeting | null>(null)
  const [attendees, setAttendees] = useState<{ user_id: string; full_name: string }[]>([])
  const [orders, setOrders]       = useState<MeetingOrder[]>([])
  const [items, setItems]         = useState<MeetingOrderItem[]>([])
  const [history, setHistory]     = useState<MeetingHistoryEntry[]>([])
  const [activity, setActivity]   = useState<MeetingActivityEntry[]>([])
  const [tasks, setTasks]         = useState<Record<string, LinkedTask>>({})

  const [loading, setLoading]     = useState(true)
  const [notFound, setNotFound]   = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null)
  const [orderSearch, setOrderSearch] = useState('')
  const [modal, setModal]         = useState<ModalState>({ kind: 'none' })
  const [isMobile, setIsMobile]   = useState(false)
  const [railOpen, setRailOpen]   = useState(true)
  // The two actions that fire an RPC straight from a button rather than from a
  // modal (which disables its own submit while saving). Both are idempotent in
  // the database, so a double click cannot corrupt anything — but it would fire
  // a second round trip and a second toast, which reads as "did that work?".
  const [actionBusy, setActionBusy] = useState(false)

  useEffect(() => {
    // Tracked so the rail is reset only when the layout actually CROSSES the
    // breakpoint. Reacting to every resize event would slam the order list back
    // over the SKU table each time a phone keyboard opened or the device
    // rotated — mid-update, which is the worst possible moment.
    let wasMobile: boolean | null = null
    const check = () => {
      const mobile = window.innerWidth < 900
      setIsMobile(mobile)
      if (wasMobile !== mobile) {
        // On a phone the rail and the table cannot share the screen, so the
        // rail closes and the SKU table gets the whole width.
        setRailOpen(!mobile)
        wasMobile = mobile
      }
    }
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // Reads before it writes — the mount effect calls it directly, so nothing
  // here may set state before the first await.
  const load = useCallback(async () => {
    if (!meetingId) return

    const { data: meetingRow, error: meetingErr } = await supabase
      .from('meetings')
      .select(`${MEETING_COLUMNS}, lead:users!lead_id(full_name), creator:users!created_by(full_name)`)
      .eq('id', meetingId)
      .maybeSingle()

    if (meetingErr) {
      logMeetingFailure('edit-meeting', meetingErr)
      setLoadError(meetingErrorMessage('edit-meeting', meetingErr))
      setLoading(false)
      return
    }
    if (!meetingRow) {
      // RLS returns "no row" for a meeting that exists but is not yours, which
      // is the right answer to give back: a non-attendee learns nothing about
      // whether a given review happened.
      setNotFound(true)
      setLoading(false)
      return
    }
    setLoadError(null)

    // The two joined names are lifted onto the row and the join objects
    // dropped, so what reaches state is exactly the `Meeting` shape.
    const { lead, creator, ...raw } = meetingRow as unknown as Meeting & {
      lead?: { full_name: string } | null
      creator?: { full_name: string } | null
    }
    setMeeting({
      ...raw,
      lead_name: lead?.full_name ?? null,
      created_by_name: creator?.full_name ?? null,
    })

    const [{ data: attendeeRows }, { data: orderRows }] = await Promise.all([
      supabase
        .from('meeting_attendees')
        .select('user_id, users!user_id(full_name)')
        .eq('meeting_id', meetingId),
      supabase
        .from('meeting_orders')
        .select(MEETING_ORDER_COLUMNS)
        .eq('meeting_id', meetingId)
        .order('created_at', { ascending: true }),
    ])

    setAttendees(
      ((attendeeRows ?? []) as unknown as { user_id: string; users?: { full_name: string } | null }[])
        .map(a => ({ user_id: a.user_id, full_name: a.users?.full_name ?? 'Unknown' })),
    )

    const loadedOrders = (orderRows ?? []) as MeetingOrder[]
    setOrders(loadedOrders)

    // Items and history are paged: a long-running review accumulates history
    // entries without limit, and PostgREST silently caps a read at 1000 rows.
    // A silently truncated history would hide exactly the older commitments
    // this screen exists to surface.
    const orderIds = loadedOrders.map(o => o.id)
    if (orderIds.length > 0) {
      const itemsResult = await fetchAllRows<MeetingOrderItem>((from, to) =>
        supabase
          .from('meeting_order_items')
          .select(MEETING_ORDER_ITEM_COLUMNS)
          .in('meeting_order_id', orderIds)
          .order('id', { ascending: true })
          .range(from, to),
      )
      if (!itemsResult.ok) {
        setLoadError('Could not load the product lines for this meeting. Please retry.')
        setLoading(false)
        return
      }
      const loadedItems = itemsResult.rows
      setItems(loadedItems)

      const taskIds = [...new Set(loadedItems.map(i => i.linked_task_id).filter((id): id is string => !!id))]
      if (taskIds.length > 0) {
        // Read live from Task Management rather than mirroring status here.
        const { data: taskRows } = await supabase
          .from('tasks')
          .select('id, title, status, priority, due_date, assigned_to, assignee:users!assigned_to(full_name)')
          .in('id', taskIds)

        const map: Record<string, LinkedTask> = {}
        for (const t of ((taskRows ?? []) as unknown as (LinkedTask & { assignee?: { full_name: string } | null })[])) {
          map[t.id] = { ...t, assignee_name: t.assignee?.full_name ?? null }
        }
        setTasks(map)
      } else {
        setTasks({})
      }
    } else {
      setItems([])
      setTasks({})
    }

    // Lifecycle trail. Small and bounded — a handful of rows per meeting, one
    // per status change — so it is read whole rather than paged.
    const { data: activityRows } = await supabase
      .from('meeting_activity_log')
      .select(`${MEETING_ACTIVITY_COLUMNS}, actor:users!actor_id(full_name)`)
      .eq('meeting_id', meetingId)
      .order('created_at', { ascending: true })

    setActivity(
      ((activityRows ?? []) as unknown as (MeetingActivityEntry & { actor?: { full_name: string } | null })[])
        .map(({ actor, ...a }) => ({ ...a, actor_name: actor?.full_name ?? null })),
    )

    const historyResult = await fetchAllRows<MeetingHistoryEntry>((from, to) =>
      supabase
        .from('meeting_update_history')
        .select(`${MEETING_HISTORY_COLUMNS}, actor:users!actor_id(full_name)`)
        .eq('meeting_id', meetingId)
        .order('id', { ascending: true })
        .range(from, to),
    )
    if (historyResult.ok) {
      setHistory(
        (historyResult.rows as unknown as (MeetingHistoryEntry & { actor?: { full_name: string } | null })[])
          .map(h => ({ ...h, actor_name: h.actor?.full_name ?? null, actor: undefined })),
      )
    }

    setLoading(false)
  }, [supabase, meetingId])

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

  const editable = !!meeting && canEditThisMeeting(meeting, profile?.id, caps)
  const canSetStatus = !!meeting && canSetThisMeetingStatus(meeting, profile?.id, caps)

  const itemsByOrder = useMemo(() => {
    const map = new Map<string, MeetingOrderItem[]>()
    for (const item of items) {
      const list = map.get(item.meeting_order_id) ?? []
      list.push(item)
      map.set(item.meeting_order_id, list)
    }
    for (const list of map.values()) list.sort((a, b) => a.sku.localeCompare(b.sku))
    return map
  }, [items])

  // One pass over the history for the whole screen, instead of one filter+sort
  // per SKU row per render.
  const previousUpdates = useMemo(() => previousUpdateByItem(history), [history])

  const filteredOrders = useMemo(() => {
    const q = orderSearch.trim().toLowerCase()
    if (!q) return orders
    return orders.filter(o =>
      o.order_number.toLowerCase().includes(q)
      || (o.customer_name ?? '').toLowerCase().includes(q),
    )
  }, [orders, orderSearch])

  // Derived during render rather than synced by an effect: the working pane is
  // never empty when there is something to work on, and an order removed from
  // the meeting falls back to the first one instead of leaving a blank pane
  // until a second render catches up.
  const selectedOrder = orders.find(o => o.id === selectedOrderId) ?? orders[0] ?? null
  const selectedItems = selectedOrder ? (itemsByOrder.get(selectedOrder.id) ?? []) : []

  const existingKeys = useMemo(
    () => items.map(item => {
      const order = orders.find(o => o.id === item.meeting_order_id)
      return { orderNumber: order?.order_number ?? '', sku: item.sku }
    }),
    [items, orders],
  )

  const afterWrite = useCallback(async (message: string) => {
    setModal({ kind: 'none' })
    await load()
    show(message)
  }, [load, show])

  // Draft → In Progress. Explicit rather than inferred from the first update:
  // a lead opening the screen to read last week's notes has not started this
  // week's meeting, and a status that moved on its own would make "In Progress"
  // mean nothing.
  const startMeeting = async () => {
    if (actionBusy) return
    setActionBusy(true)
    const { error } = await supabase.rpc('set_meeting_status', {
      p_meeting_id: meetingId,
      p_status: 'in_progress',
    })
    if (error) {
      logMeetingFailure('set-status', error)
      show(meetingErrorMessage('set-status', error), 'error')
      setActionBusy(false)
      return
    }
    await load()
    setActionBusy(false)
    show('Meeting started')
  }

  const markResolved = async (item: MeetingOrderItem) => {
    if (actionBusy) return
    setActionBusy(true)
    const { error } = await supabase.rpc('save_meeting_item_update', {
      p_item_id: item.id,
      p_latest_update: null,
      p_status: 'resolved',
      p_next_follow_up_date: null,
      p_issue: null,
      p_current_stage: null,
      p_responsible_department: null,
      p_clear_follow_up: true,
      p_clear_issue: false,
    })
    if (error) {
      logMeetingFailure('update-item', error)
      show(meetingErrorMessage('update-item', error), 'error')
      setActionBusy(false)
      return
    }
    await load()
    setActionBusy(false)
    show(`${item.sku} marked resolved`)
  }

  // "Save & next": advance to the SKU below the one just saved, without
  // returning to the table in between.
  const openNextItem = (current: MeetingOrderItem, order: MeetingOrder) => {
    const list = itemsByOrder.get(order.id) ?? []
    const index = list.findIndex(i => i.id === current.id)
    const next = index >= 0 ? list[index + 1] : undefined
    if (next) setModal({ kind: 'item-update', order, item: next, focus: 'update' })
    else setModal({ kind: 'none' })
  }

  if (authLoading || loading) return <LoadingScreen />

  if (notFound || !meeting) {
    return (
      <MeetingsLayout profile={profile} title="Meeting" onSignOut={signOut}>
        <div style={{
          background: colors.base, border: `1px solid ${colors.border}`,
          borderRadius: '10px', padding: '48px 24px', textAlign: 'center',
        }}>
          <AlertTriangle size={26} strokeWidth={1.5} color={colors.muted} />
          <p style={{ fontSize: '13px', fontWeight: 600, color: colors.secondary, marginTop: '10px' }}>
            This meeting is not available
          </p>
          <p style={{ fontSize: '12px', color: colors.muted, marginTop: '4px' }}>
            It may have been removed, or you were not part of it.
          </p>
          <button
            onClick={() => router.push('/meetings')}
            className="boe-btn boe-btn-ghost"
            style={{ marginTop: '14px', padding: '7px 16px', fontSize: '12.5px' }}
          >
            Back to Meetings
          </button>
        </div>
      </MeetingsLayout>
    )
  }

  const typeMeta = MEETING_TYPE_META[meeting.meeting_type]

  return (
    <MeetingsLayout
      profile={profile}
      title={meeting.title}
      subtitle={`${typeMeta.label} Review · ${formatMeetingDate(meeting.meeting_date)}${meeting.lead_name ? ` · Led by ${meeting.lead_name}` : ''}`}
      onSignOut={signOut}
      actions={
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
          {editable && caps.canImport && (
            <button
              onClick={() => setModal({ kind: 'import' })}
              className="boe-btn boe-btn-ghost"
              style={{ padding: '7px 12px', fontSize: '12.5px', display: 'flex', alignItems: 'center', gap: '5px' }}
            >
              <Upload size={13} strokeWidth={2} /> Import
            </button>
          )}
          {editable && (
            <button
              onClick={() => setModal({ kind: 'add-order' })}
              className="boe-btn boe-btn-ghost"
              style={{ padding: '7px 12px', fontSize: '12.5px', display: 'flex', alignItems: 'center', gap: '5px' }}
            >
              <Plus size={13} strokeWidth={2.2} /> Add Order
            </button>
          )}
          {canSetStatus && meeting.status === 'draft' && (
            <button
              onClick={startMeeting}
              disabled={actionBusy}
              className="boe-btn boe-btn-primary"
              style={{ padding: '7px 14px', fontSize: '12.5px', opacity: actionBusy ? 0.6 : 1 }}
            >
              Start Meeting
            </button>
          )}
          {canSetStatus && meeting.status !== 'completed' && (
            <button
              onClick={() => setModal({ kind: 'complete' })}
              className={`boe-btn ${meeting.status === 'draft' ? 'boe-btn-ghost' : 'boe-btn-primary'}`}
              style={{ padding: '7px 14px', fontSize: '12.5px' }}
            >
              Complete Meeting
            </button>
          )}
          {canSetStatus && meeting.status === 'completed' && (
            <button
              onClick={() => setModal({ kind: 'reopen' })}
              className="boe-btn boe-btn-ghost"
              style={{ padding: '7px 12px', fontSize: '12.5px', display: 'flex', alignItems: 'center', gap: '5px' }}
            >
              <RotateCcw size={13} strokeWidth={2} /> Reopen
            </button>
          )}
        </div>
      }
    >
      {/* Back + status strip. Back goes to the list, which restores its own
          filters from the URL — the reason they live there. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '10px',
      }}>
        <button
          onClick={() => router.push(meeting.status === 'completed' ? '/meetings/completed' : '/meetings')}
          style={{
            display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 8px 4px 4px',
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: '12.5px', fontWeight: 600, color: colors.secondary,
          }}
        >
          <ArrowLeft size={14} strokeWidth={2} /> All Meetings
        </button>
        <MeetingBadge meta={typeMeta} />
        <MeetingBadge meta={MEETING_STATUS_META[meeting.status]} />
        {attendees.length > 0 && (
          <span
            title={attendees.map(a => a.full_name).join(', ')}
            style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11.5px', color: colors.muted }}
          >
            <Users size={12} strokeWidth={1.9} />
            {attendees.length} attendee{attendees.length !== 1 ? 's' : ''}
          </span>
        )}
        {editable && (
          <button
            onClick={() => setModal({ kind: 'edit-meeting' })}
            style={{
              display: 'flex', alignItems: 'center', gap: '4px',
              background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px',
              fontSize: '11.5px', fontWeight: 600, color: colors.blue,
            }}
          >
            <Pencil size={11} strokeWidth={2.2} /> Edit details
          </button>
        )}
        {/* Lifecycle trail. A link in the status strip rather than a panel on
            the working screen: it is read once, when someone asks who closed
            the meeting — it must not compete with the SKU table. */}
        <button
          onClick={() => setModal({ kind: 'activity' })}
          style={{
            display: 'flex', alignItems: 'center', gap: '4px',
            background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px',
            fontSize: '11.5px', fontWeight: 600, color: colors.secondary,
          }}
        >
          <HistoryIcon size={11} strokeWidth={2.2} /> Meeting Activity
        </button>
      </div>

      {meeting.status === 'completed' && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '9px',
          padding: '9px 13px', borderRadius: '8px', marginBottom: '10px',
          background: '#F0FDF4', border: '1px solid #BBF7D0',
          fontSize: '12.5px', color: '#166534',
        }}>
          <CheckCircle2 size={14} strokeWidth={2} style={{ flexShrink: 0 }} />
          This meeting is completed and read-only. Follow-ups it scheduled are still live on the
          Follow-ups screens.
        </div>
      )}

      {meeting.note && (
        <div style={{
          padding: '9px 13px', borderRadius: '8px', marginBottom: '10px',
          background: colors.raised, border: `1px solid ${colors.border}`,
          fontSize: '12.5px', color: colors.secondary, whiteSpace: 'pre-wrap',
        }}>
          {meeting.note}
        </div>
      )}

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

      {orders.length === 0 ? (
        <EmptyReview editable={editable} canImport={caps.canImport} onAdd={() => setModal({ kind: 'add-order' })} onImport={() => setModal({ kind: 'import' })} />
      ) : (
        <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>

          {/* ── Order rail ── */}
          {(!isMobile || railOpen) && (
            <div style={{
              flex: isMobile ? '1 1 100%' : '0 0 264px',
              width: isMobile ? '100%' : '264px',
              background: colors.base, border: `1px solid ${colors.border}`,
              borderRadius: '10px', overflow: 'hidden',
              position: isMobile ? 'static' : 'sticky', top: '10px',
            }}>
              <div style={{ padding: '9px 10px', borderBottom: `1px solid ${colors.border}` }}>
                <div style={{ position: 'relative' }}>
                  <Search
                    size={13}
                    color={colors.muted}
                    style={{ position: 'absolute', left: '9px', top: '50%', transform: 'translateY(-50%)' }}
                  />
                  <input
                    className="boe-input"
                    aria-label="Find order number"
                    placeholder="Find order number…"
                    value={orderSearch}
                    onChange={e => setOrderSearch(e.target.value)}
                    style={{ paddingLeft: '28px', padding: '6px 10px 6px 28px', fontSize: '12px' }}
                  />
                </div>
              </div>
              <div style={{ maxHeight: isMobile ? 'none' : 'calc(100vh - 210px)', overflowY: 'auto' }}>
                {filteredOrders.length === 0 ? (
                  <div style={{ padding: '20px 12px', fontSize: '12px', color: colors.muted, textAlign: 'center' }}>
                    No order matches “{orderSearch}”.
                  </div>
                ) : filteredOrders.map(order => {
                  const orderItems = itemsByOrder.get(order.id) ?? []
                  const open = orderItems.filter(i => i.status !== 'resolved').length
                  const active = order.id === selectedOrder?.id
                  const posMeta = ORDER_POSITION_META[order.position]
                  return (
                    <button
                      key={order.id}
                      onClick={() => { setSelectedOrderId(order.id); if (isMobile) setRailOpen(false) }}
                      style={{
                        width: '100%', textAlign: 'left', display: 'block', cursor: 'pointer',
                        padding: '9px 12px', border: 'none',
                        borderLeft: `3px solid ${active ? posMeta.color : 'transparent'}`,
                        borderBottom: `1px solid ${colors.border}`,
                        background: active ? colors.raised : 'transparent',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' }}>
                        <span style={{ fontSize: '12.5px', fontWeight: 700, color: colors.primary }}>
                          {order.order_number}
                        </span>
                        <span style={{
                          fontSize: '10px', fontWeight: 700, padding: '1px 6px', borderRadius: '5px',
                          background: posMeta.bg, color: posMeta.color, whiteSpace: 'nowrap',
                        }}>
                          {posMeta.label}
                        </span>
                      </div>
                      {order.customer_name && (
                        <div style={{
                          fontSize: '11.5px', color: colors.muted, marginTop: '2px',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {order.customer_name}
                        </div>
                      )}
                      <div style={{ fontSize: '11px', color: colors.muted, marginTop: '3px' }}>
                        {orderItems.length} SKU{orderItems.length !== 1 ? 's' : ''}
                        {open > 0 && <span style={{ color: colors.amber, fontWeight: 600 }}> · {open} open</span>}
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* ── Working pane ── */}
          {(!isMobile || !railOpen) && selectedOrder && (
            <div style={{ flex: 1, minWidth: 0 }}>
              {isMobile && (
                <button
                  onClick={() => setRailOpen(true)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '8px',
                    background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px 2px 0',
                    fontSize: '12.5px', fontWeight: 600, color: colors.secondary,
                  }}
                >
                  <ChevronLeft size={14} strokeWidth={2} /> All orders ({orders.length})
                </button>
              )}

              <OrderPanel
                order={selectedOrder}
                items={selectedItems}
                previousUpdates={previousUpdates}
                tasks={tasks}
                editable={editable}
                isMobile={isMobile}
                onOrderUpdate={() => setModal({ kind: 'order-update', order: selectedOrder })}
                onOrderHistory={() => setModal({
                  kind: 'history',
                  title: `Order ${selectedOrder.order_number}`,
                  subtitle: 'Every update recorded against this order and its products',
                  entries: historyForOrder(history, selectedOrder.id),
                })}
                onRemoveOrder={() => setModal({ kind: 'remove-order', order: selectedOrder })}
                onAddItem={() => setModal({ kind: 'add-item', order: selectedOrder })}
                onUpdateItem={(item, focus) => setModal({ kind: 'item-update', order: selectedOrder, item, focus })}
                onCreateTask={canCreateTasks ? (item => setModal({ kind: 'create-task', order: selectedOrder, item })) : undefined}
                onOpenTask={taskId => router.push(`/tasks/${taskId}`)}
                onResolve={markResolved}
                onItemHistory={item => setModal({
                  kind: 'history',
                  title: item.sku,
                  subtitle: `${item.product_name} · Order ${selectedOrder.order_number}`,
                  entries: historyForItem(history, item.id),
                })}
              />
            </div>
          )}
        </div>
      )}

      {/* ── Modals ── */}
      {modal.kind === 'edit-meeting' && profile && (
        <MeetingFormModal
          supabase={supabase}
          profile={profile}
          meeting={meeting}
          initialAttendeeIds={attendees.map(a => a.user_id)}
          onClose={() => setModal({ kind: 'none' })}
          onSaved={() => afterWrite('Meeting updated')}
        />
      )}
      {modal.kind === 'add-order' && (
        <AddOrderModal
          supabase={supabase}
          meetingId={meeting.id}
          meetingType={meeting.meeting_type}
          onClose={() => setModal({ kind: 'none' })}
          onSaved={orderId => { setSelectedOrderId(orderId); afterWrite('Order added') }}
        />
      )}
      {modal.kind === 'order-update' && (
        <OrderUpdateModal
          supabase={supabase}
          order={modal.order}
          onClose={() => setModal({ kind: 'none' })}
          onSaved={() => afterWrite('Order update saved')}
        />
      )}
      {modal.kind === 'remove-order' && (
        <RemoveOrderModal
          supabase={supabase}
          order={modal.order}
          onClose={() => setModal({ kind: 'none' })}
          onRemoved={() => { setSelectedOrderId(null); afterWrite('Order removed') }}
        />
      )}
      {modal.kind === 'add-item' && (
        <AddItemModal
          supabase={supabase}
          order={modal.order}
          onClose={() => setModal({ kind: 'none' })}
          onSaved={() => afterWrite('Product added')}
        />
      )}
      {modal.kind === 'item-update' && (
        <ItemUpdateModal
          supabase={supabase}
          order={modal.order}
          item={modal.item}
          previousUpdate={previousUpdates.get(modal.item.id) ?? null}
          focusField={modal.focus}
          hasNext={(() => {
            const list = itemsByOrder.get(modal.order.id) ?? []
            return list.findIndex(i => i.id === modal.item.id) < list.length - 1
          })()}
          onClose={() => setModal({ kind: 'none' })}
          onSaved={() => afterWrite('Update saved')}
          onSavedNext={async () => {
            const currentItem = modal.item
            const currentOrder = modal.order
            await load()
            show('Update saved')
            openNextItem(currentItem, currentOrder)
          }}
        />
      )}
      {modal.kind === 'create-task' && profile && canCreateTasks && (
        <MeetingTaskModal
          supabase={supabase}
          profile={profile}
          meeting={meeting}
          order={modal.order}
          item={modal.item}
          onClose={() => setModal({ kind: 'none' })}
          onCreated={() => afterWrite('Task created and linked')}
        />
      )}
      {modal.kind === 'history' && (
        <MeetingHistoryModal
          title={modal.title}
          subtitle={modal.subtitle}
          entries={modal.entries}
          onClose={() => setModal({ kind: 'none' })}
        />
      )}
      {modal.kind === 'activity' && (
        <MeetingActivityModal
          entries={activity}
          onClose={() => setModal({ kind: 'none' })}
        />
      )}
      {modal.kind === 'import' && (
        <MeetingImportModal
          supabase={supabase}
          meetingId={meeting.id}
          existingKeys={existingKeys}
          onClose={() => setModal({ kind: 'none' })}
          onImported={summary => afterWrite(summary)}
        />
      )}
      {modal.kind === 'complete' && (
        <CompleteMeetingModal
          supabase={supabase}
          meetingId={meeting.id}
          orders={orders}
          items={items}
          onClose={() => setModal({ kind: 'none' })}
          onCompleted={() => afterWrite('Meeting completed')}
        />
      )}
      {modal.kind === 'reopen' && (
        <ReopenMeetingModal
          supabase={supabase}
          meetingId={meeting.id}
          onClose={() => setModal({ kind: 'none' })}
          onReopened={() => afterWrite('Meeting reopened')}
        />
      )}

      <Toast toast={toast} onDismiss={dismiss} />
    </MeetingsLayout>
  )
}

// ─── Order panel ──────────────────────────────────────────────────────────────

function OrderPanel({
  order, items, previousUpdates, tasks, editable, isMobile,
  onOrderUpdate, onOrderHistory, onRemoveOrder, onAddItem,
  onUpdateItem, onCreateTask, onOpenTask, onResolve, onItemHistory,
}: {
  order: MeetingOrder
  items: MeetingOrderItem[]
  /** itemId -> the update the current one replaced. Precomputed once. */
  previousUpdates: Map<string, string | null>
  tasks: Record<string, LinkedTask>
  editable: boolean
  isMobile: boolean
  onOrderUpdate: () => void
  onOrderHistory: () => void
  onRemoveOrder: () => void
  onAddItem: () => void
  onUpdateItem: (item: MeetingOrderItem, focus: 'update' | 'follow_up') => void
  /** Absent when the viewer lacks task_management:view — see canCreateTasks. */
  onCreateTask?: (item: MeetingOrderItem) => void
  onOpenTask: (taskId: string) => void
  onResolve: (item: MeetingOrderItem) => void
  onItemHistory: (item: MeetingOrderItem) => void
}) {
  const posMeta = ORDER_POSITION_META[order.position]

  return (
    <div style={{
      background: colors.base, border: `1px solid ${colors.border}`,
      borderRadius: '10px', overflow: 'hidden',
    }}>
      {/* Order header — position, overall update and next review together, which
          is the whole order-level answer in one glance. */}
      <div style={{ padding: '13px 15px', borderBottom: `1px solid ${colors.border}` }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '15px', fontWeight: 800, color: colors.primary, letterSpacing: '-0.01em' }}>
                {order.order_number}
              </span>
              <MeetingBadge meta={posMeta} />
              <MeetingBadge meta={MEETING_TYPE_META[order.order_type]} />
            </div>
            <div style={{ fontSize: '12px', color: colors.muted, marginTop: '3px' }}>
              {order.customer_name ?? 'No customer recorded'}
              {order.expected_dispatch_date && ` · Dispatch ${formatMeetingDate(order.expected_dispatch_date)}`}
              {order.next_review_date && ` · Next review ${formatMeetingDate(order.next_review_date)}`}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '5px', flexShrink: 0, flexWrap: 'wrap' }}>
            {editable && (
              <button
                onClick={onOrderUpdate}
                className="boe-btn boe-btn-ghost"
                style={{ padding: '6px 11px', fontSize: '12px' }}
              >
                Order Update
              </button>
            )}
            <IconAction label="Order history" onClick={onOrderHistory}><HistoryIcon size={14} strokeWidth={1.9} /></IconAction>
            {editable && (
              <IconAction label="Remove order from meeting" onClick={onRemoveOrder} danger>
                <Trash2 size={14} strokeWidth={1.9} />
              </IconAction>
            )}
          </div>
        </div>

        {order.latest_update && (
          <div style={{
            marginTop: '9px', padding: '8px 11px', borderRadius: '7px',
            background: colors.raised, borderLeft: `2px solid ${posMeta.color}`,
            fontSize: '12.5px', color: colors.primary, lineHeight: 1.45, whiteSpace: 'pre-wrap',
          }}>
            {order.latest_update}
          </div>
        )}
        {order.remarks && (
          <div style={{ marginTop: '6px', fontSize: '11.5px', color: colors.muted, whiteSpace: 'pre-wrap' }}>
            {order.remarks}
          </div>
        )}
      </div>

      {/* SKU lines */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 15px', borderBottom: `1px solid ${colors.border}`, gap: '8px',
      }}>
        <div style={{
          fontSize: '10px', fontWeight: 700, color: colors.muted,
          textTransform: 'uppercase', letterSpacing: '0.06em',
        }}>
          Products under review · {items.length}
        </div>
        {editable && (
          <button
            onClick={onAddItem}
            style={{
              display: 'flex', alignItems: 'center', gap: '4px',
              background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px',
              fontSize: '12px', fontWeight: 600, color: colors.blue,
            }}
          >
            <Plus size={12} strokeWidth={2.4} /> Add Product
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <div style={{ padding: '36px 20px', textAlign: 'center' }}>
          <ClipboardList size={24} strokeWidth={1.4} color={colors.muted} />
          <p style={{ fontSize: '12.5px', color: colors.secondary, marginTop: '8px', fontWeight: 600 }}>
            No products added to this order yet
          </p>
          <p style={{ fontSize: '11.5px', color: colors.muted, marginTop: '3px' }}>
            {editable
              ? 'Add them one at a time, or bring a whole review in from the spreadsheet.'
              : 'Nothing has been added to this order.'}
          </p>
        </div>
      ) : isMobile ? (
        <div style={{ padding: '10px' }}>
          {items.map(item => (
            <ItemCard
              key={item.id}
              item={item}
              previousUpdate={previousUpdates.get(item.id) ?? null}
              task={item.linked_task_id ? tasks[item.linked_task_id] : undefined}
              editable={editable}
              onUpdate={focus => onUpdateItem(item, focus)}
              onCreateTask={onCreateTask ? () => onCreateTask(item) : undefined}
              onOpenTask={onOpenTask}
              onResolve={() => onResolve(item)}
              onHistory={() => onItemHistory(item)}
            />
          ))}
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                {['Product', 'Stage / Owner', 'Update', 'Follow-up', 'Status', 'Task', ''].map(h => (
                  <th key={h} style={{
                    padding: '7px 12px', textAlign: 'left',
                    fontSize: '10px', fontWeight: 600, color: colors.muted,
                    textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <ItemRow
                  key={item.id}
                  item={item}
                  previousUpdate={previousUpdates.get(item.id) ?? null}
                  task={item.linked_task_id ? tasks[item.linked_task_id] : undefined}
                  editable={editable}
                  onUpdate={focus => onUpdateItem(item, focus)}
                  onCreateTask={onCreateTask ? () => onCreateTask(item) : undefined}
                  onOpenTask={onOpenTask}
                  onResolve={() => onResolve(item)}
                  onHistory={() => onItemHistory(item)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── One SKU row ──────────────────────────────────────────────────────────────

type ItemRowProps = {
  item: MeetingOrderItem
  previousUpdate: string | null
  task: LinkedTask | undefined
  editable: boolean
  onUpdate: (focus: 'update' | 'follow_up') => void
  /** Absent when the viewer lacks task_management:view. */
  onCreateTask?: () => void
  onOpenTask: (taskId: string) => void
  onResolve: () => void
  onHistory: () => void
}

function ItemRow(props: ItemRowProps) {
  const { item, previousUpdate, task } = props
  const statusMeta = ITEM_STATUS_META[item.status]
  const due = followUpDue(item.next_follow_up_date, item.status)

  return (
    <tr style={{ borderBottom: `1px solid ${colors.border}`, verticalAlign: 'top' }}>
      <td style={{ padding: '10px 12px', minWidth: '150px' }}>
        <div style={{ fontWeight: 700, color: colors.primary }}>{item.sku}</div>
        <div style={{ fontSize: '11.5px', color: colors.muted, marginTop: '1px' }}>
          {item.product_name}
          {item.quantity != null && ` · ${item.quantity}`}
        </div>
      </td>
      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
        <div style={{ color: colors.secondary }}>{item.current_stage ?? '—'}</div>
        <div style={{ fontSize: '11.5px', color: colors.muted, marginTop: '1px' }}>
          {departmentLabel(item.responsible_department)}
        </div>
      </td>
      <td style={{ padding: '10px 12px', minWidth: '230px', maxWidth: '360px' }}>
        <UpdateCell item={item} previousUpdate={previousUpdate} />
      </td>
      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
        <FollowUpCell date={item.next_follow_up_date} due={due} />
      </td>
      <td style={{ padding: '10px 12px' }}>
        <MeetingBadge meta={statusMeta} />
      </td>
      <td style={{ padding: '10px 12px', minWidth: '120px' }}>
        <TaskCell task={task} linked={!!item.linked_task_id} onOpenTask={props.onOpenTask} />
      </td>
      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', textAlign: 'right' }}>
        <RowActions {...props} />
      </td>
    </tr>
  )
}

function ItemCard(props: ItemRowProps) {
  const { item, previousUpdate, task } = props
  const due = followUpDue(item.next_follow_up_date, item.status)

  return (
    <div style={{
      border: `1px solid ${colors.border}`, borderRadius: '10px',
      padding: '11px 13px', marginBottom: '8px', background: colors.base,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>{item.sku}</div>
          <div style={{ fontSize: '11.5px', color: colors.muted, marginTop: '1px' }}>
            {item.product_name}
            {item.quantity != null && ` · ${item.quantity}`}
          </div>
        </div>
        <MeetingBadge meta={ITEM_STATUS_META[item.status]} />
      </div>

      <div style={{ marginTop: '8px' }}>
        <UpdateCell item={item} previousUpdate={previousUpdate} />
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
        marginTop: '8px', fontSize: '11.5px', color: colors.muted,
      }}>
        <span>{item.current_stage ?? 'No stage'}</span>
        <span>·</span>
        <span>{departmentLabel(item.responsible_department)}</span>
        <FollowUpCell date={item.next_follow_up_date} due={due} />
      </div>

      <div style={{ marginTop: '8px' }}>
        <TaskCell task={task} linked={!!item.linked_task_id} onOpenTask={props.onOpenTask} />
      </div>

      <div style={{ marginTop: '10px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        <RowActions {...props} wide />
      </div>
    </div>
  )
}

/** Latest update, what it replaced, and the blocker — read together. */
function UpdateCell({ item, previousUpdate }: { item: MeetingOrderItem; previousUpdate: string | null }) {
  return (
    <div>
      <div style={{
        color: item.latest_update ? colors.primary : colors.muted,
        lineHeight: 1.4, whiteSpace: 'pre-wrap',
      }}>
        {item.latest_update ?? 'No update recorded'}
      </div>
      {previousUpdate && (
        <div style={{ fontSize: '11px', color: colors.muted, marginTop: '3px', lineHeight: 1.4 }}>
          <span style={{ fontWeight: 600 }}>Previously: </span>{previousUpdate}
        </div>
      )}
      {item.issue && (
        <div style={{
          display: 'flex', gap: '5px', alignItems: 'flex-start',
          fontSize: '11.5px', color: '#92400E', marginTop: '5px', lineHeight: 1.4,
        }}>
          <AlertTriangle size={11} strokeWidth={2.2} style={{ flexShrink: 0, marginTop: '2px' }} />
          <span>{item.issue}</span>
        </div>
      )}
    </div>
  )
}

function FollowUpCell({
  date, due,
}: { date: string | null; due: ReturnType<typeof followUpDue> }) {
  if (!date || !due) {
    return <span style={{ fontSize: '11.5px', color: colors.muted }}>—</span>
  }
  const meta = FOLLOW_UP_DUE_META[due]
  const late = due === 'overdue' ? daysOverdue(date) : 0
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: '2px' }}>
      <span style={{ fontSize: '12px', color: due === 'upcoming' ? colors.secondary : meta.color, fontWeight: due === 'upcoming' ? 400 : 600 }}>
        {formatMeetingDate(date)}
      </span>
      {due !== 'upcoming' && (
        <span style={{ fontSize: '10px', fontWeight: 700, color: meta.color }}>
          {due === 'overdue' ? `${late} day${late === 1 ? '' : 's'} overdue` : 'Due today'}
        </span>
      )}
    </span>
  )
}

/**
 * The linked task, read live from Task Management.
 *
 * Status, assignee and due date are shown; nothing here is editable and no
 * acknowledgement, activity or completion is mirrored. Opening the task is the
 * one action, and it goes to the task's own page.
 */
function TaskCell({
  task, linked, onOpenTask,
}: { task: LinkedTask | undefined; linked: boolean; onOpenTask: (id: string) => void }) {
  if (!linked) return <span style={{ fontSize: '11.5px', color: colors.muted }}>—</span>

  if (!task) {
    // Linked, but the task row is not readable or has been removed. Saying so
    // is better than rendering an empty cell that looks like "no task".
    return <span style={{ fontSize: '11.5px', color: colors.muted }}>Task not available</span>
  }

  return (
    <button
      onClick={() => onOpenTask(task.id)}
      style={{
        display: 'inline-flex', flexDirection: 'column', gap: '2px', alignItems: 'flex-start',
        background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left',
      }}
    >
      <span className={`boe-badge boe-badge-${task.status}`} style={{ textTransform: 'capitalize' }}>
        {task.status}
      </span>
      <span style={{ fontSize: '11px', color: colors.secondary }}>
        {task.assignee_name ?? 'Unassigned'}
      </span>
      {task.due_date && (
        <span style={{ fontSize: '10.5px', color: colors.muted }}>
          Due {formatMeetingDate(task.due_date)}
        </span>
      )}
    </button>
  )
}

/**
 * Row actions.
 *
 * Update is the primary and is always a labelled button; the other three are
 * icon buttons with titles and accessible names, never inside a menu. A review
 * moves at the speed of these four controls, and one extra click to reveal them
 * would be paid on every line of every meeting.
 */
function RowActions({
  item, editable, onUpdate, onCreateTask, onResolve, onHistory, wide,
}: ItemRowProps & { wide?: boolean }) {
  return (
    <div style={{
      display: 'inline-flex', gap: '4px', alignItems: 'center',
      flexWrap: wide ? 'wrap' : 'nowrap',
    }}>
      {editable && (
        <button
          onClick={() => onUpdate('update')}
          className="boe-btn boe-btn-primary"
          style={{ padding: '5px 11px', fontSize: '12px' }}
        >
          Update
        </button>
      )}
      {editable && (
        <IconAction label="Set follow-up date" onClick={() => onUpdate('follow_up')}>
          <CalendarPlus size={14} strokeWidth={1.9} />
        </IconAction>
      )}
      {editable && !item.linked_task_id && onCreateTask && (
        <IconAction label="Create task from this product" onClick={onCreateTask}>
          <ClipboardList size={14} strokeWidth={1.9} />
        </IconAction>
      )}
      {editable && item.status !== 'resolved' && (
        <IconAction label="Mark resolved" onClick={onResolve} positive>
          <CheckCircle2 size={14} strokeWidth={1.9} />
        </IconAction>
      )}
      <IconAction label="Update history" onClick={onHistory}>
        <HistoryIcon size={14} strokeWidth={1.9} />
      </IconAction>
    </div>
  )
}

function IconAction({
  label, onClick, children, danger, positive,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
  danger?: boolean
  positive?: boolean
}) {
  const color = danger ? colors.red : positive ? '#2E8A58' : colors.secondary
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: 28, borderRadius: '7px', flexShrink: 0,
        border: `1px solid ${colors.border}`, background: 'transparent',
        color, cursor: 'pointer', transition: 'background 0.12s',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = colors.raised }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
    >
      {children}
    </button>
  )
}

function EmptyReview({
  editable, canImport, onAdd, onImport,
}: { editable: boolean; canImport: boolean; onAdd: () => void; onImport: () => void }) {
  return (
    <div style={{
      background: colors.base, border: `1px solid ${colors.border}`,
      borderRadius: '10px', padding: '48px 24px', textAlign: 'center',
    }}>
      <ClipboardList size={28} strokeWidth={1.4} color={colors.muted} />
      <p style={{ fontSize: '13px', fontWeight: 600, color: colors.secondary, marginTop: '10px' }}>
        No orders under review yet
      </p>
      <p style={{
        fontSize: '12px', color: colors.muted, marginTop: '4px',
        maxWidth: '420px', margin: '4px auto 0', lineHeight: 1.5,
      }}>
        {editable
          ? 'Add the orders being discussed one at a time, or bring the whole list in from the BOE spreadsheet template.'
          : 'Nothing has been added to this meeting.'}
      </p>
      {editable && (
        <div style={{ marginTop: '14px', display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' }}>
          <button onClick={onAdd} className="boe-btn boe-btn-primary" style={{ padding: '8px 18px', fontSize: '13px' }}>
            Add Order
          </button>
          {canImport && (
            <button onClick={onImport} className="boe-btn boe-btn-ghost" style={{ padding: '8px 18px', fontSize: '13px' }}>
              Import Spreadsheet
            </button>
          )}
        </div>
      )}
    </div>
  )
}
