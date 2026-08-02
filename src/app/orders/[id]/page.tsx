'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import { useViewAs } from '@/hooks/useViewAs'
import type { UserProfile } from '@/lib/types'
import { ArrowLeft, ChevronDown } from 'lucide-react'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import {
  AmendOrderModal,
  RequestOrderChangeModal,
  CancelOrderModal,
  ReviewChangeRequestModal,
} from './OrderAmendmentModals'
import {
  canAmendOrderDirectly,
  canRequestOrderChange,
  hasPendingChangeRequest,
  describeAmendment,
  CHANGE_REQUEST_TYPE_LABEL,
  CHANGE_REQUEST_STATUS_LABEL,
  type OrderChangeRequest,
  type AmendedActivityPayload,
} from '@/lib/orders/amendments'

// ── Types ─────────────────────────────────────────────────────────────────────

type Order = {
  id: string
  display_number: string
  client_name: string
  requested_by: string | null
  requested_by_name?: string
  assigned_to: string | null
  assigned_to_name?: string
  created_by: string | null
  created_by_name?: string
  confirm_date: string | null
  due_date: string | null
  total_value: number | null
  total_product_value: number | null
  lead_source: string | null
  status: string
  notes: string | null
  /** True only for records created during the testing phase (20260706000000). */
  is_test_data?: boolean
  created_at: string
  updated_at: string
  // Read-only provenance back to the Order Request this Order was created from
  // (20260701000000). Null for an Order with no originating request. Both are
  // immutable in the database once set, so they are never edited here.
  source_order_request_id: string | null
  source_request_number: string | null
}

type LinkedPayment = {
  id: string
  client_name: string
  amount: number
  payment_date: string
  payment_mode: string
  order_number: string | null
  status: string
}

type ActivityEntry = {
  id: string
  actor_name?: string
  event_type: string
  payload: Record<string, unknown>
  created_at: string
}

// ── Status transition graph ───────────────────────────────────────────────────

// 'requested' was retired in 20260702000000. Conversion IS the approval, so a
// Confirmed Order is born at 'running' and there is no pre-approval state to
// transition out of. `allowedTransitions` already falls back to [] for any
// status missing from the graph, so a historical row would offer no actions
// rather than throwing — but none can exist: the database CHECK now rejects
// the value and every stored row was migrated to 'running'.
type OrderStatus = 'running' | 'on_hold' | 'ready_for_dispatch' | 'dispatched' | 'cancelled'

const TRANSITION_GRAPH: Record<OrderStatus, OrderStatus[]> = {
  running:            ['on_hold',   'ready_for_dispatch', 'cancelled'],
  on_hold:            ['running',   'cancelled'],
  ready_for_dispatch: ['dispatched','cancelled'],
  dispatched:         [],
  cancelled:          [],
}

function allowedTransitions(profile: UserProfile, currentStatus: string): OrderStatus[] {
  const graph = TRANSITION_GRAPH[currentStatus as OrderStatus] ?? []
  if (profile.role === 'admin') return graph
  // Operations team: running ↔ on_hold, running → ready_for_dispatch (no cancel, no dispatch)
  if (profile.team === 'operations') {
    return graph.filter(s => s === 'on_hold' || s === 'ready_for_dispatch' || s === 'running')
  }
  return []
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STATUS_META: Record<string, { label: string; bg: string; color: string; border: string }> = {
  running:            { label: 'Running',             bg: '#EFF6FF', color: '#1E40AF', border: '#BFDBFE' },
  on_hold:            { label: 'On Hold',             bg: '#FFF7ED', color: '#9A3412', border: '#FED7AA' },
  ready_for_dispatch: { label: 'Ready for Dispatch',  bg: '#F5F3FF', color: '#5B21B6', border: '#DDD6FE' },
  dispatched:         { label: 'Dispatched',          bg: '#F0FDF4', color: '#166534', border: '#BBF7D0' },
  cancelled:          { label: 'Cancelled',           bg: '#FEF2F2', color: '#991B1B', border: '#FECACA' },
}

const PAYMENT_STATUS_META: Record<string, { label: string; color: string }> = {
  pending_approval:    { label: 'Pending',             color: '#92400E' },
  approved_unlinked:   { label: 'Order No. Pending',   color: '#9A3412' },
  approved_linked:     { label: 'Received',            color: '#166534' },
  needs_clarification: { label: 'Needs Clarification', color: '#1E40AF' },
  rejected:            { label: 'Rejected',            color: '#991B1B' },
}

const LEAD_SOURCE_LABEL: Record<string, string> = {
  reference:       'Reference',
  repeat_customer: 'Repeat Customer',
  whatsapp:        'WhatsApp',
  instagram:       'Instagram',
  website:         'Website',
}

const PAYMENT_MODE_LABEL: Record<string, string> = {
  bank_transfer: 'Bank Transfer',
  cash:          'Cash',
  upi:           'UPI',
  cheque:        'Cheque',
  other:         'Other',
}

const EVENT_TYPE_LABEL: Record<string, string> = {
  created:          'Order created',
  status_changed:   'Status changed',
  payment_linked:   'Payment linked',
  payment_unlinked: 'Payment unlinked',
  note_added:       'Note added',
  // Written by convert_order_request_to_order(). Present in the log since
  // 20260681000000 but never labelled here, so it rendered as its raw
  // event_type; it is the Order-side record of where this Order came from.
  order_created_from_request: 'Order created from request',
  // Written by apply_order_amendment() (20260804000000).
  order_amended:    'Order amended',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtAmount(n: number | null) {
  if (n == null) return '—'
  return '₹' + n.toLocaleString('en-IN')
}

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function fmtDateTime(iso: string) {
  const d = new Date(iso)
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    + ', '
    + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { label: status, bg: '#F3F4F6', color: '#4B5563', border: '#E5E7EB' }
  return (
    <span style={{
      display: 'inline-block', padding: '3px 10px', borderRadius: '6px',
      background: meta.bg, color: meta.color, border: `1px solid ${meta.border}`,
      fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      {meta.label}
    </span>
  )
}

function MetaField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
      <span style={{ fontSize: '10px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </span>
      <span style={{ fontSize: '13px', color: colors.primary, lineHeight: 1.4 }}>
        {value ?? '—'}
      </span>
    </div>
  )
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: colors.base, border: `1px solid ${colors.border}`,
      borderRadius: '10px', overflow: 'hidden',
    }}>
      <div style={{
        padding: '12px 20px', borderBottom: `1px solid ${colors.border}`,
        fontSize: '12px', fontWeight: 700, color: colors.primary,
        textTransform: 'uppercase', letterSpacing: '0.04em',
      }}>
        {title}
      </div>
      <div style={{ padding: '16px 20px' }}>
        {children}
      </div>
    </div>
  )
}

function ActivityDot({ event_type }: { event_type: string }) {
  const colorMap: Record<string, string> = {
    created:          colors.green,
    status_changed:   colors.blue,
    payment_linked:   colors.green,
    payment_unlinked: colors.amber,
    note_added:       colors.muted,
    order_created_from_request: colors.green,
    order_amended:    colors.amber,
  }
  const c = colorMap[event_type] ?? colors.muted
  return <div style={{ width: 8, height: 8, borderRadius: '50%', background: c, flexShrink: 0, marginTop: 5 }} />
}

// An amendment is the one event whose detail is a LIST, not a sentence: it can
// move seven fields at once and every before/after pair matters. Rendering it
// as prose would either lose values or produce an unreadable run-on, so it gets
// its own branch below rather than being squeezed into activityDescription.
function amendmentLines(entry: ActivityEntry): string[] {
  if (entry.event_type !== 'order_amended') return []
  return describeAmendment(entry.payload as AmendedActivityPayload)
}

function activityDescription(entry: ActivityEntry): string {
  const { event_type, payload } = entry
  if (event_type === 'status_changed') {
    const from = STATUS_META[payload.from as string]?.label ?? payload.from
    const to   = STATUS_META[payload.to   as string]?.label ?? payload.to
    const base = `${from} → ${to}`
    // cancel_order_with_audit adds a reason and the money position. Both belong
    // next to the transition, not hidden behind a details link.
    const reason = typeof payload.reason === 'string' && payload.reason.trim() !== ''
      ? ` · ${payload.reason.trim()}`
      : ''
    const received = payload.to === 'cancelled' && payload.received_at_cancellation != null
      ? ` · ₹${Number(payload.received_at_cancellation).toLocaleString('en-IN')} received at cancellation`
      : ''
    return base + reason + received
  }
  if (event_type === 'order_amended') {
    const reason = (payload as AmendedActivityPayload).reason
    return typeof reason === 'string' ? reason : ''
  }
  if (event_type === 'payment_linked') {
    const amt = payload.amount ? '₹' + Number(payload.amount).toLocaleString('en-IN') : ''
    return amt ? `Payment of ${amt} linked` : 'Payment linked'
  }
  if (event_type === 'payment_unlinked') return 'Payment unlinked'
  if (event_type === 'note_added') return (payload.note as string) ?? ''
  if (event_type === 'order_created_from_request') {
    return payload.request_number ? `From ${payload.request_number}` : ''
  }
  return ''
}

// ── Status Dropdown ───────────────────────────────────────────────────────────
//
// Cancellation left this component in 20260804000000. It used to be a plain
// `update({ status: 'cancelled' })` behind a yes/no dialog, which recorded no
// reason and — the real problem — never told the person clicking it how much
// money was already sitting on the order. It now routes to CancelOrderModal,
// which reads the received total through a SECURITY DEFINER function and calls
// cancel_order(). Every OTHER transition is still a plain update: those are
// operational moves, and `status` is deliberately outside the amendment guard.

function StatusControl({
  order,
  profile,
  onStatusChanged,
  onRequestCancel,
}: {
  order: Order
  profile: UserProfile
  onStatusChanged: (newStatus: string) => void
  onRequestCancel: () => void
}) {
  const [open,           setOpen]           = useState(false)
  const [saving,         setSaving]         = useState(false)
  const supabase = useMemo(() => createClient(), [])

  const targets = allowedTransitions(profile, order.status)
  if (targets.length === 0) return null

  const doStatusChange = async (newStatus: OrderStatus) => {
    setSaving(true)
    const oldStatus = order.status

    const { error } = await supabase
      .from('orders')
      .update({ status: newStatus })
      .eq('id', order.id)

    if (!error) {
      const { data: { session } } = await supabase.auth.getSession()
      if (session) {
        await supabase.from('order_activity_log').insert({
          order_id:   order.id,
          actor_id:   session.user.id,
          event_type: 'status_changed',
          payload:    { from: oldStatus, to: newStatus },
        })
      }
      onStatusChanged(newStatus)
    }
    setSaving(false)
  }

  const handleSelect = (newStatus: OrderStatus) => {
    setOpen(false)
    // Cancelling is not a status change like the others: it needs a reason and
    // it needs the money position stated first. The page owns that dialog.
    if (newStatus === 'cancelled') { onRequestCancel(); return }
    doStatusChange(newStatus)
  }

  return (
    <>
      <div style={{ position: 'relative', display: 'inline-block' }}>
        <button
          onClick={() => setOpen(o => !o)}
          disabled={saving}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '6px',
            padding: '6px 12px', borderRadius: '7px', fontSize: '12px', fontWeight: 600,
            background: 'transparent', border: `1px solid ${colors.border}`,
            color: colors.secondary, cursor: saving ? 'not-allowed' : 'pointer',
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? 'Updating…' : 'Change Status'}
          <ChevronDown size={13} strokeWidth={2} />
        </button>

        {open && (
          <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 99 }} onClick={() => setOpen(false)} />
            <div style={{
              position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 100,
              background: colors.base, border: `1px solid ${colors.border}`,
              borderRadius: '8px', boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
              minWidth: '190px', overflow: 'hidden',
            }}>
              {targets.map((s, idx) => {
                const meta = STATUS_META[s]
                const isLast = idx === targets.length - 1
                return (
                  <button
                    key={s}
                    onClick={() => handleSelect(s)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '8px',
                      width: '100%', padding: '9px 14px', textAlign: 'left',
                      background: 'none', border: 'none', cursor: 'pointer',
                      fontSize: '13px', color: colors.primary,
                      borderBottom: isLast ? 'none' : `1px solid ${colors.border}`,
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = colors.raised }}
                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'none' }}
                  >
                    <span style={{
                      display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%',
                      background: meta.color, flexShrink: 0,
                    }} />
                    {meta.label}
                  </button>
                )
              })}
            </div>
          </>
        )}
      </div>
    </>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function OrderDetailPage() {
  const [pageLoading,   setPageLoading]   = useState(true)
  const [profile,       setProfile]       = useState<UserProfile | null>(null)
  const [order,         setOrder]         = useState<Order | null>(null)
  const [payments,      setPayments]      = useState<LinkedPayment[]>([])
  const [activity,      setActivity]      = useState<ActivityEntry[]>([])
  const [notFound,      setNotFound]      = useState(false)
  // Test Data Cleanup is a temporary, testing-phase-only affordance. Both halves
  // are required: the Order has to have been created during testing, AND cleanup
  // has to still be enabled. The RPC is admin-gated and simply errors for anyone
  // else, so a non-admin silently gets false — which is the right answer anyway.
  const [cleanupEnabled, setCleanupEnabled] = useState(false)
  // Amendment surface (20260804000000). `changeRequests` holds what RLS lets
  // this reader see: their own requests, or all of them for an admin.
  const [changeRequests, setChangeRequests] = useState<OrderChangeRequest[]>([])
  const [amendOpen,      setAmendOpen]      = useState(false)
  const [requestOpen,    setRequestOpen]    = useState(false)
  const [cancelOpen,     setCancelOpen]     = useState(false)
  const [reviewing,      setReviewing]      = useState<OrderChangeRequest | null>(null)

  const router     = useRouter()
  const params     = useParams()
  const id         = params.id as string
  const supabase   = useMemo(() => createClient(), [])
  const { viewAsUserId } = useViewAs()

  const loadOrder = async () => {
    const { data: o } = await supabase
      .from('orders')
      .select(`
        id, display_number, client_name,
        requested_by, assigned_to, created_by,
        confirm_date, due_date, total_value, total_product_value,
        lead_source, status, notes, created_at, updated_at,
        source_order_request_id, source_request_number, is_test_data,
        requested_by_user:users!requested_by(full_name),
        assigned_to_user:users!assigned_to(full_name),
        created_by_user:users!created_by(full_name)
      `)
      .eq('id', id)
      .single()

    if (!o) { setNotFound(true); return }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = o as any
    const mapped: Order = {
      ...raw,
      requested_by_name: raw.requested_by_user?.full_name ?? undefined,
      assigned_to_name:  raw.assigned_to_user?.full_name  ?? undefined,
      created_by_name:   raw.created_by_user?.full_name   ?? undefined,
      requested_by_user: undefined,
      assigned_to_user:  undefined,
      created_by_user:   undefined,
    }
    setOrder(mapped)

    const { data: pData } = await supabase
      .from('finance_payment_requests')
      .select('id, client_name, amount, payment_date, payment_mode, order_number, status')
      .eq('order_id', id)
      .order('payment_date', { ascending: false })
    setPayments((pData ?? []) as LinkedPayment[])

    const { data: aData } = await supabase
      .from('order_activity_log')
      .select(`id, event_type, payload, created_at, actor:users!actor_id(full_name)`)
      .eq('order_id', id)
      .order('created_at', { ascending: false })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mappedActivity: ActivityEntry[] = ((aData ?? []) as any[]).map(a => ({
      id:         a.id,
      event_type: a.event_type,
      payload:    a.payload ?? {},
      created_at: a.created_at,
      actor_name: a.actor?.full_name ?? undefined,
    }))
    setActivity(mappedActivity)

    // Change requests. Not filtered to 'pending' here: a reader needs to see
    // that their last request was rejected, not just that they have none open.
    const { data: cData } = await supabase
      .from('order_change_requests')
      .select(`
        id, order_id, order_number_snapshot, request_type, requested_by, reason,
        proposed_client_name, proposed_total_value, proposed_total_product_value,
        proposed_confirm_date, proposed_due_date, proposed_lead_source, proposed_notes,
        status, reviewed_by, reviewed_at, review_note, created_at,
        requester:users!requested_by(full_name)
      `)
      .eq('order_id', id)
      .order('created_at', { ascending: false })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setChangeRequests(((cData ?? []) as any[]).map(c => ({
      ...c,
      requested_by_name: c.requester?.full_name ?? undefined,
      requester: undefined,
    })) as OrderChangeRequest[])
  }

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const { data: me } = await supabase
        .from('users')
        .select(USER_PROFILE_COLUMNS)
        .eq('id', session.user.id)
        .single()

      setProfile(me as UserProfile)
      await loadOrder()

      if ((me as UserProfile | null)?.role === 'admin') {
        const { data: s } = await supabase.rpc('get_test_data_cleanup_settings')
        const settings = s as { enabled?: boolean; permanently_disabled?: boolean } | null
        setCleanupEnabled(!!settings?.enabled && !settings?.permanently_disabled)
      }

      setPageLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const canCleanUp = cleanupEnabled && !!order?.is_test_data

  // Which amendment door this reader gets. Both are re-decided by the database
  // (assert_order_amender / the INSERT policy); these only choose the button.
  // View As never lends authority, so an admin previewing someone else's view
  // does not keep the direct door — same rule the cleanup button already uses.
  const actingAsAdmin = profile?.role === 'admin' && !viewAsUserId
  const canAmend   = order ? canAmendOrderDirectly(actingAsAdmin ? profile : { role: 'member' }, order) : false
  const canRequest = order ? canRequestOrderChange(actingAsAdmin ? profile : { role: 'member' }, order) : false

  const myPendingEdit = !!(order && profile) &&
    hasPendingChangeRequest(changeRequests, order.id, profile.id, 'edit')
  const myPendingCancel = !!(order && profile) &&
    hasPendingChangeRequest(changeRequests, order.id, profile.id, 'cancel')

  const pendingRequests = changeRequests.filter(r => r.status === 'pending')

  const amendableOrder = order && {
    id: order.id,
    display_number: order.display_number,
    status: order.status,
    client_name: order.client_name,
    total_value: order.total_value,
    total_product_value: order.total_product_value,
    confirm_date: order.confirm_date,
    due_date: order.due_date,
    lead_source: order.lead_source,
    notes: order.notes,
  }

  const afterChange = () => {
    setAmendOpen(false); setRequestOpen(false); setCancelOpen(false); setReviewing(null)
    loadOrder()
  }

  if (pageLoading) return <LoadingScreen />

  if (notFound || !order) {
    return (
      <OrdersLayout profile={profile} title="Order Not Found" onSignOut={handleSignOut}>
        <div style={{ padding: '40px', textAlign: 'center', color: colors.muted, fontSize: '14px' }}>
          This order does not exist or you don&apos;t have access to it.
        </div>
      </OrdersLayout>
    )
  }

  const received = payments
    .filter(p => p.status === 'approved_linked')
    .reduce((sum, p) => sum + p.amount, 0)
  const pending    = (order.total_value ?? 0) - received
  const completion = order.total_value ? Math.round((received / order.total_value) * 100) : 0

  const isOverdue = order.due_date &&
    !['dispatched', 'cancelled'].includes(order.status) &&
    new Date(order.due_date) < new Date()

  return (
    <OrdersLayout
      profile={profile}
      title={`Order ${order.display_number}`}
      subtitle={order.client_name}
      onSignOut={handleSignOut}
      onRefresh={loadOrder}
    >
      {/* ── Back ── */}
      <button
        onClick={() => router.back()}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: '6px',
          marginBottom: '20px', padding: '6px 12px', borderRadius: '7px',
          background: 'transparent', border: `1px solid ${colors.border}`,
          color: colors.secondary, fontSize: '12px', cursor: 'pointer',
        }}
      >
        <ArrowLeft size={13} strokeWidth={2} /> Back
      </button>

      {/* ── Header ── */}
      <div style={{ marginBottom: '24px' }}>
        {/* Title row */}
        <div style={{
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          gap: '12px', flexWrap: 'wrap', marginBottom: '16px',
        }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '22px', fontWeight: 700, color: colors.primary, letterSpacing: '-0.02em' }}>
                {order.display_number}
              </span>
              <StatusBadge status={order.status} />
            </div>
            <div style={{ fontSize: '14px', color: colors.secondary, marginTop: '4px' }}>
              {order.client_name}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            {profile && (
              <StatusControl
                order={order}
                profile={profile}
                onRequestCancel={() => setCancelOpen(true)}
                onStatusChanged={newStatus => {
                  setOrder(o => o ? { ...o, status: newStatus } : o)
                  loadOrder()
                }}
              />
            )}

            {/* The amendment door. An admin gets Amend Order; everyone else who
                can see the Order gets Request a Change, disabled once they
                already have one open — the partial unique index would refuse a
                second, and saying so before the click beats a constraint
                violation after it. */}
            {canAmend && (
              <button
                onClick={() => setAmendOpen(true)}
                className="boe-btn boe-btn-ghost"
                style={{ padding: '6px 12px', fontSize: '12px', fontWeight: 600 }}
              >
                Amend Order
              </button>
            )}
            {canRequest && (
              <button
                onClick={() => setRequestOpen(true)}
                disabled={myPendingEdit}
                className="boe-btn boe-btn-ghost"
                style={{ padding: '6px 12px', fontSize: '12px', fontWeight: 600, opacity: myPendingEdit ? 0.55 : 1 }}
                title={myPendingEdit ? 'You already have a change request awaiting review' : undefined}
              >
                {myPendingEdit ? 'Change Requested' : 'Request a Change'}
              </button>
            )}
            {canRequest && (
              <button
                onClick={() => setCancelOpen(true)}
                disabled={myPendingCancel}
                className="boe-btn boe-btn-ghost"
                style={{ padding: '6px 12px', fontSize: '12px', fontWeight: 600, opacity: myPendingCancel ? 0.55 : 1 }}
                title={myPendingCancel ? 'You already have a cancellation request awaiting review' : undefined}
              >
                {myPendingCancel ? 'Cancellation Requested' : 'Request Cancellation'}
              </button>
            )}
            {/* A Confirmed Order has no destructive action. It is permanent
                business history, enforced by the database (20260705000000):
                public.orders carries no DELETE policy and orders_prevent_delete
                refuses every path, including the service role.

                While the system is in its testing phase, an Order that was
                created during testing offers a route to the separate cleanup
                flow instead. Deliberately not styled or worded as a delete: it
                navigates to a page that then requires a reason, a typed
                confirmation, and a chain where every record is verified test
                data. It disappears on its own once cleanup is permanently
                disabled, because canCleanUp then stays false. */}
            {profile?.role === 'admin' && !viewAsUserId && canCleanUp && (
              <button
                onClick={() => router.push(
                  `/admin/control-center/test-data-cleanup?type=order&id=${order.id}`
                )}
                style={{
                  padding: '6px 12px', borderRadius: '7px', fontSize: '12px', fontWeight: 600,
                  background: 'transparent', border: `1px solid ${colors.border}`,
                  color: colors.secondary, cursor: 'pointer',
                }}
                title="This Order was created during system testing"
              >
                Clean Up Test Transaction
              </button>
            )}
          </div>
        </div>

        {/* ── Summary strip ── */}
        <div style={{
          borderTop: `1px solid ${colors.border}`,
          borderBottom: `1px solid ${colors.border}`,
          padding: '16px 0',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
          gap: '16px 24px',
        }}>
          <MetaField label="Requested By" value={order.requested_by_name} />
          <MetaField label="Assignee"     value={order.assigned_to_name} />
          <MetaField
            label="Confirm Date"
            value={fmtDate(order.confirm_date)}
          />
          <MetaField
            label="Due Date"
            value={
              <span style={{ color: isOverdue ? colors.red : 'inherit', fontWeight: isOverdue ? 600 : 400 }}>
                {fmtDate(order.due_date)}
                {isOverdue && <span style={{ fontSize: '10px', marginLeft: '4px' }}>overdue</span>}
              </span>
            }
          />
          <MetaField
            label="Lead Source"
            value={order.lead_source ? LEAD_SOURCE_LABEL[order.lead_source] ?? order.lead_source : undefined}
          />
          <MetaField label="Total Product Value" value={fmtAmount(order.total_product_value)} />
          <MetaField label="Total Order Value"   value={fmtAmount(order.total_value)} />
          <MetaField label="Created"       value={fmtDate(order.created_at)} />
          <MetaField label="Last Updated"  value={fmtDate(order.updated_at)} />
          {/* Read-only provenance. Rendered only for an Order that actually came
              from a request, so Orders created by other paths don't show an
              empty field. Deliberately not a link: converted requests are being
              removed from the Order Requests module, so there is nowhere to
              navigate to. The internal request id rides along as a title
              attribute for support/audit lookups without adding UI noise. */}
          {order.source_request_number && (
            <MetaField
              label="Source Request"
              value={
                <span title={order.source_order_request_id ?? undefined}>
                  {order.source_request_number}
                </span>
              }
            />
          )}
        </div>

        {/* Notes (if any) */}
        {order.notes && (
          <div style={{
            marginTop: '14px', paddingBottom: '4px',
            fontSize: '13px', color: colors.secondary, lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
          }}>
            <span style={{ fontSize: '10px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '4px' }}>
              Notes
            </span>
            {order.notes}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

        {/* ── Payment summary ── */}
        <SectionCard title="Payment Summary">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '16px' }}>
            <div>
              <div style={{ fontSize: '10px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>Order Value</div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: colors.primary }}>{fmtAmount(order.total_value)}</div>
            </div>
            <div>
              <div style={{ fontSize: '10px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>Received</div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: colors.green }}>{fmtAmount(received)}</div>
            </div>
            <div>
              <div style={{ fontSize: '10px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>Pending</div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: pending > 0 ? colors.amber : colors.muted }}>
                {fmtAmount(pending > 0 ? pending : 0)}
              </div>
            </div>
            <div>
              <div style={{ fontSize: '10px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>Completion</div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: completion >= 100 ? colors.green : colors.primary }}>
                {order.total_value ? `${completion}%` : '—'}
              </div>
              {order.total_value && (
                <div style={{ marginTop: '6px', height: '4px', borderRadius: '2px', background: colors.float, overflow: 'hidden' }}>
                  <div style={{ height: '100%', borderRadius: '2px', width: `${Math.min(completion, 100)}%`, background: completion >= 100 ? colors.green : colors.blue, transition: 'width 0.3s' }} />
                </div>
              )}
            </div>
          </div>
        </SectionCard>

        {/* ── Linked payments ── */}
        <SectionCard title={`Linked Payments (${payments.length})`}>
          {payments.length === 0 ? (
            <div style={{ color: colors.muted, fontSize: '13px' }}>No payments linked to this order yet.</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                    {['Client', 'Amount', 'Date', 'Mode', 'Status'].map(h => (
                      <th key={h} style={{
                        padding: '6px 12px', textAlign: 'left',
                        fontSize: '10px', fontWeight: 600, color: colors.muted,
                        textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {payments.map(p => {
                    const pmeta = PAYMENT_STATUS_META[p.status] ?? { label: p.status, color: colors.muted }
                    return (
                      <tr key={p.id} style={{ borderBottom: `1px solid ${colors.border}` }}>
                        <td style={{ padding: '10px 12px', color: colors.primary }}>{p.client_name}</td>
                        <td style={{ padding: '10px 12px', fontWeight: 600, color: colors.primary, whiteSpace: 'nowrap' }}>
                          {fmtAmount(p.amount)}
                        </td>
                        <td style={{ padding: '10px 12px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                          {fmtDate(p.payment_date)}
                        </td>
                        <td style={{ padding: '10px 12px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                          {PAYMENT_MODE_LABEL[p.payment_mode] ?? p.payment_mode}
                        </td>
                        <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', fontWeight: 600, fontSize: '12px', color: pmeta.color }}>
                          {pmeta.label}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>

        {/* ── Change requests ──
            Rendered only when there is something to show, so an Order nobody
            has ever asked to change carries no empty card. An admin sees every
            request; everyone else sees their own — that split is RLS's, not
            this component's. */}
        {changeRequests.length > 0 && (
          <SectionCard title={`Change Requests (${pendingRequests.length} pending)`}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {changeRequests.map(r => (
                <div
                  key={r.id}
                  style={{
                    display: 'flex', gap: '12px', alignItems: 'flex-start', flexWrap: 'wrap',
                    padding: '10px 12px', borderRadius: '8px',
                    background: r.status === 'pending' ? colors.raised : 'transparent',
                    border: `1px solid ${colors.border}`,
                  }}
                >
                  <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                    <div style={{ fontSize: '12px', fontWeight: 700, color: colors.primary }}>
                      {CHANGE_REQUEST_TYPE_LABEL[r.request_type]}
                      <span style={{ fontWeight: 500, color: colors.muted }}>
                        {' · '}{CHANGE_REQUEST_STATUS_LABEL[r.status]}
                      </span>
                    </div>
                    <div style={{ fontSize: '12.5px', color: colors.secondary, marginTop: '3px', whiteSpace: 'pre-wrap' }}>
                      {r.reason}
                    </div>
                    <div style={{ fontSize: '11px', color: colors.muted, marginTop: '4px' }}>
                      {r.requested_by_name ? `${r.requested_by_name} · ` : ''}{fmtDateTime(r.created_at)}
                    </div>
                    {r.review_note && (
                      <div style={{ fontSize: '11.5px', color: colors.muted, marginTop: '4px', fontStyle: 'italic' }}>
                        Review note: {r.review_note}
                      </div>
                    )}
                  </div>
                  {actingAsAdmin && r.status === 'pending' && (
                    <button
                      onClick={() => setReviewing(r)}
                      className="boe-btn boe-btn-primary"
                      style={{ padding: '6px 14px', fontSize: '12px', flexShrink: 0 }}
                    >
                      Review
                    </button>
                  )}
                </div>
              ))}
            </div>
          </SectionCard>
        )}

        {/* ── Activity timeline ── */}
        <SectionCard title="Activity">
          {activity.length === 0 ? (
            <div style={{ color: colors.muted, fontSize: '13px' }}>No activity recorded yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {activity.map((entry, idx) => (
                <div key={entry.id} style={{ display: 'flex', gap: '12px', paddingBottom: idx < activity.length - 1 ? '16px' : '0' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0, width: 20 }}>
                    <ActivityDot event_type={entry.event_type} />
                    {idx < activity.length - 1 && (
                      <div style={{ flex: 1, width: 1, background: colors.border, marginTop: '4px' }} />
                    )}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '12px', fontWeight: 600, color: colors.primary }}>
                      {EVENT_TYPE_LABEL[entry.event_type] ?? entry.event_type}
                    </div>
                    {activityDescription(entry) && (
                      <div style={{ fontSize: '12px', color: colors.secondary, marginTop: '2px' }}>
                        {activityDescription(entry)}
                      </div>
                    )}
                    {amendmentLines(entry).length > 0 && (
                      <ul style={{
                        margin: '4px 0 0', paddingLeft: '16px',
                        fontSize: '12px', color: colors.secondary, lineHeight: 1.65,
                      }}>
                        {amendmentLines(entry).map(line => <li key={line}>{line}</li>)}
                      </ul>
                    )}
                    <div style={{ fontSize: '11px', color: colors.muted, marginTop: '3px' }}>
                      {entry.actor_name ? `${entry.actor_name} · ` : ''}{fmtDateTime(entry.created_at)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

      </div>

      {/* ── Amendment dialogs ──
          Only one is ever open: each is opened from a control that the others'
          conditions exclude, and every one closes through afterChange, which
          also re-reads the Order so the page and the database agree. */}
      {amendOpen && amendableOrder && (
        <AmendOrderModal
          order={amendableOrder}
          supabase={supabase}
          onClose={() => setAmendOpen(false)}
          onDone={afterChange}
        />
      )}
      {requestOpen && amendableOrder && (
        <RequestOrderChangeModal
          order={amendableOrder}
          supabase={supabase}
          onClose={() => setRequestOpen(false)}
          onDone={afterChange}
        />
      )}
      {cancelOpen && amendableOrder && (
        <CancelOrderModal
          order={amendableOrder}
          supabase={supabase}
          isAdmin={actingAsAdmin}
          onClose={() => setCancelOpen(false)}
          onDone={afterChange}
        />
      )}
      {reviewing && (
        <ReviewChangeRequestModal
          request={reviewing}
          supabase={supabase}
          onClose={() => setReviewing(null)}
          onDone={afterChange}
        />
      )}

    </OrdersLayout>
  )
}
