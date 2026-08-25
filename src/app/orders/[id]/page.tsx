'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { getEffectivePermissions } from '@/lib/permissions/resolver'
import {
  deriveOrdersCapabilities,
  NO_ORDERS_CAPABILITIES,
  type OrdersCapabilities,
} from '@/lib/permissions/orders'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import {
  mergeOrderPayments,
  type OrderAllocationRow,
} from '@/lib/orders/orderPayments'
import {
  buildOrderFinancePosition,
  progressWidth,
  withExactAmounts,
  type OrderFinancePaymentRow,
} from '@/lib/finance/orderFinancePosition'
import { formatMoney, formatPercent, piPaymentStatusLabel } from '@/lib/finance/piPaymentView'
import {
  deriveFinanceCapabilities,
  NO_FINANCE_CAPABILITIES,
  type FinanceCapabilities,
} from '@/lib/permissions/finance'
import { financePaymentHref, piSubmissionHref } from '@/lib/finance/crossModuleLinks'
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
import {
  ORDER_PI_HANDOFF_COLUMNS,
  ORDER_PI_WORKBOOK_URL_TTL_SECONDS,
  buildOrderPiHandoff,
  orderPiWorkbookPath,
  type OrderPiHandoff,
  type OrderPiRow,
} from '@/lib/orders/orderPiHandoff'
import {
  ORDER_FILES_BUCKET,
  PI_DRAFT_IMAGE_URL_TTL_SECONDS,
  PI_DRAFT_ITEM_COLUMNS,
  PI_DRAFT_ITEM_IMAGE_COLUMNS,
  persistedImageUrlMaps,
  persistedProducts,
  type PersistedItem,
  type PersistedItemImage,
  type PersistedProduct,
} from '@/lib/orders/draftsView'
import { buildImageViewerItems, viewerNav, type PiViewerItem } from '@/lib/pi/previewView'
import { PiCommercialSummary, PiImageViewer, type PiThumbnailProps } from '@/components/orders/piPreview'
import { PiClientDetailsModal } from '@/components/orders/piReviewModals'
// ONE payment-mode source for Order and Finance (20261013000000).
import { PAYMENT_MODE_LABEL, customerDisplayName } from '@/lib/finance/paymentEntry'
import {
  OrderDocumentsCard,
  OrderPiNoSource,
  OrderPiProducts,
  OrderPiSummaryCard,
  OrderPiUnavailable,
} from './OrderPiSections'
import {
  ORDER_DOCUMENT_COLUMNS,
  ORDER_DOCUMENT_URL_TTL_SECONDS,
  buildOrderDocumentsView,
  orderDocumentResponse,
  type OrderDocumentRow,
} from '@/lib/orders/orderDocuments'

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
  // The approved PI this Order was created from, written by
  // approve_order_submission() (20260915000000) and frozen once set
  // (20260916000000). Null for an Order created any other way. It is the ONLY
  // input to the handoff below: no PI, no handoff, and the screen is exactly
  // what it has always been.
  source_order_submission_id: string | null
  // The declared billing percentage, carried across at approval by
  // 20260923000000. Read here only so the handoff can tell a declared
  // percentage from an undeclared one without a second read of the PI.
  billing_percentage?: number | string | null
}

// The list this screen shows is the LEGACY linked payments plus anything the
// Order's own active allocations point at — see mergeOrderPayments. A PI's money
// arrives here through a MOVED allocation, never through a copied payment row.
//
// The row carries the EXACT `numeric` strings alongside the display numbers —
// see orderFinancePosition.ts. Every total on this screen is built from those,
// so the Order and the PI it was approved from cannot print different figures
// for the same money.
type LinkedPayment = OrderFinancePaymentRow

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

/**
 * THE COLOUR of a payment status. The WORDS come from piPaymentStatusLabel, the
 * same map the PI payment card reads, so one state cannot be called two things
 * on two screens.
 *
 * WHAT THIS CORRECTED. This screen had its own label map, and three of its five
 * entries disagreed with the PI's for the same stored value:
 *
 *   pending_approval    said "Pending". The product's word for that state is
 *                       AWAITING VERIFICATION — the business rule names it — and
 *                       "Pending" reads as though the money itself is pending
 *                       rather than Finance's look at it.
 *   approved_unlinked   said "Order No. Pending". On an ORDER's own screen that
 *                       is close to false: the money is attached to this Order,
 *                       by an allocation, which is precisely how PI conversion
 *                       moves it. Whether the payment row ALSO carries a legacy
 *                       order_id is Finance bookkeeping and says nothing to
 *                       somebody reading their Order.
 *   approved_linked     said "Received", which is the word the summary above now
 *                       uses for verified + awaiting together. Two meanings for
 *                       one word on one screen.
 *
 * Both approved statuses now read "Verified", exactly as they do on the PI.
 * The palette is this screen's own and is unchanged.
 */
const PAYMENT_STATUS_COLOR: Record<string, string> = {
  pending_approval:    '#92400E',
  approved_unlinked:   '#166534',
  approved_linked:     '#166534',
  needs_clarification: '#1E40AF',
  rejected:            '#991B1B',
}

/** The width below which the PI product table becomes a stack of cards. The
 *  same breakpoint both PI screens use, so a product line does not change shape
 *  at a different width depending on which screen shows it. */
const MOBILE_BREAKPOINT = 768

/** What the workbook control says when the download is refused. One sentence,
 *  no internals: a refusal is almost always a permission answer and saying so
 *  in detail would confirm what the reader is not entitled to. */
const WORKBOOK_UNAVAILABLE = 'That file is not available to you right now.'

/** What the documents card says when a request or a download is refused. One
 *  sentence, no internals: a refusal is almost always a permission answer, and
 *  elaborating would confirm what the reader is not entitled to. */
const DOCUMENTS_REFUSED = 'That could not be done just now.'

const LEAD_SOURCE_LABEL: Record<string, string> = {
  reference:       'Reference',
  repeat_customer: 'Repeat Customer',
  whatsapp:        'WhatsApp',
  instagram:       'Instagram',
  website:         'Website',
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
  // Written by approve_order_submission() (20260915000000). Same reason as the
  // line above: present in the log but never labelled here, so it rendered as
  // its raw event_type — `order_created_from_pi_submission` — on the Activity
  // trail of every Order created by approving a PI.
  order_created_from_pi_submission: 'Order created from PI submission',
  // Written by apply_order_amendment() (20260816000000).
  order_amended:    'Order amended',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// ONE MONEY FORMATTER for Order Management and Finance — formatMoney, the same
// one the PI payment card and the Order's payment summary read.
//
// THE DEFECT THIS CLOSES. Three formatters were in use across the two modules
// and each rendered the same amount differently:
//
//   formatINR         maximumFractionDigits: 2 with NO minimum, so ₹1,000 and
//                     ₹1,000.5 and ₹1,000.55 — ragged decimals that do not line
//                     up in a tabular-nums column
//   toLocaleString    default maximumFractionDigits: 3, so a legacy amount with
//                     more precision than paise printed ₹1,000.555
//   formatMoney       always two decimal places
//
// So one Received Payments row could read "₹1,000.5" in its Amount column and
// "₹1,000.50" in the Allocation cell beside it — the same money, on the same
// line, twice. Money on a finance screen is stated to the paise or it is not
// reconcilable against a bank statement.
//
// formatMoney also accepts a STRING, which formatINR cannot: `numeric` crosses
// the wire as a string precisely so it is not rounded by JSON's double, and a
// formatter that only takes a number forces a lossy conversion at the boundary.
const fmtAmount = formatMoney

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

// The Payment Summary's label and figure, said once so six tiles cannot word or
// space themselves differently. `hint` carries the one thing a money figure on
// this card cannot say for itself — what it is measured against.
function FigureLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: '10px', fontWeight: 600, color: colors.muted,
      textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px',
    }}>
      {children}
    </div>
  )
}

function SummaryFigure({ label, value, color, hint }: {
  label: string
  value: string
  color?: string
  hint?: string
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <FigureLabel>{label}</FigureLabel>
      <div style={{
        fontSize: '18px', fontWeight: 700, color: color ?? colors.primary,
        fontVariantNumeric: 'tabular-nums', wordBreak: 'break-word',
      }}>
        {value}
      </div>
      {hint && (
        <div style={{ fontSize: '10px', color: colors.muted, marginTop: '2px', lineHeight: 1.4 }}>
          {hint}
        </div>
      )}
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
    // The same green: both are the Order-side record of an Order coming into
    // existence, and the provenance it came from is not a difference in kind.
    order_created_from_pi_submission: colors.green,
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
// Cancellation left this component in 20260816000000. It used to be a plain
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
  onOutOfDate,
  onRequestCancel,
}: {
  order: Order
  profile: UserProfile
  /** The row AS THE DATABASE STORED IT, never the value that was asked for. */
  onStatusChanged: (updated: { status: string; updated_at: string }) => void
  /** The Order moved underneath this screen: re-read everything. */
  onOutOfDate: () => void
  onRequestCancel: () => void
}) {
  const [open,           setOpen]           = useState(false)
  const [saving,         setSaving]         = useState(false)
  const supabase = useMemo(() => createClient(), [])

  const targets = allowedTransitions(profile, order.status)
  if (targets.length === 0) return null

  const doStatusChange = async (newStatus: OrderStatus) => {
    if (saving) return
    setSaving(true)
    const oldStatus = order.status

    // ── THE WRITE ANSWERS FOR ITSELF ──
    //
    // Two things this shape buys, neither of which a bare update gives:
    //
    // 1. COMPARE AND SWAP. `.eq('status', oldStatus)` means the row is only
    //    moved if it is still where this screen thinks it is. A second click
    //    that raced the first, or another person's transition landing in
    //    between, matches no row and changes nothing — instead of applying a
    //    move computed from a status that is no longer true.
    //
    // 2. THE STORED ROW COMES BACK. `set_updated_at` writes `updated_at` in a
    //    trigger, and the page displays it as "Last Updated". Applying the
    //    status we ASKED for and leaving the timestamp alone would put a stale
    //    time beside a fresh status, so the row is read back in the same
    //    request — no extra round trip — and the screen takes the database's
    //    values rather than its own assumption.
    const { data: updated, error } = await supabase
      .from('orders')
      .update({ status: newStatus })
      .eq('id', order.id)
      .eq('status', oldStatus)
      .select('status, updated_at')
      .maybeSingle()

    // No row came back: the transition did not happen. Either it was refused,
    // or the Order had already moved. The screen cannot know which from here,
    // and both are answered the same way — re-read, so what is on screen is
    // what the database holds, and let the person decide again from that.
    if (error || !updated) {
      setSaving(false)
      onOutOfDate()
      return
    }

    const { data: { session } } = await supabase.auth.getSession()
    if (session) {
      await supabase.from('order_activity_log').insert({
        order_id:   order.id,
        actor_id:   session.user.id,
        event_type: 'status_changed',
        payload:    { from: oldStatus, to: updated.status },
      })
    }
    onStatusChanged(updated as { status: string; updated_at: string })
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
  // Orders authority for the SIGNED-IN user. Starts empty so the amendment
  // controls cannot render before the resolver answers.
  const [ordersCaps,    setOrdersCaps]    = useState<OrdersCapabilities>(NO_ORDERS_CAPABILITIES)
  // Finance authority for the SIGNED-IN user, resolved ALONGSIDE the Orders one
  // in the same parallel group — so it costs no extra latency. It decides ONE
  // thing on this page: whether a payment row offers a link into its Finance
  // record. It grants nothing, reveals nothing, and no figure depends on it.
  const [financeCaps,   setFinanceCaps]   = useState<FinanceCapabilities>(NO_FINANCE_CAPABILITIES)
  const [order,         setOrder]         = useState<Order | null>(null)
  const [payments,      setPayments]      = useState<LinkedPayment[]>([])
  const [activity,      setActivity]      = useState<ActivityEntry[]>([])
  const [notFound,      setNotFound]      = useState(false)
  // Test Data Cleanup is a temporary, testing-phase-only affordance. Both halves
  // are required: the Order has to have been created during testing, AND cleanup
  // has to still be enabled. The RPC is admin-gated and simply errors for anyone
  // else, so a non-admin silently gets false — which is the right answer anyway.
  const [cleanupEnabled, setCleanupEnabled] = useState(false)
  // Amendment surface (20260816000000). `changeRequests` holds what RLS lets
  // this reader see: their own requests, or all of them for an admin.
  const [changeRequests, setChangeRequests] = useState<OrderChangeRequest[]>([])
  const [amendOpen,      setAmendOpen]      = useState(false)
  const [requestOpen,    setRequestOpen]    = useState(false)
  const [cancelOpen,     setCancelOpen]     = useState(false)
  const [reviewing,      setReviewing]      = useState<OrderChangeRequest | null>(null)

  // ── The approved PI this Order came from ──
  //
  // `none` until the Order has been read, which is the honest starting state:
  // an Order with no source PI never leaves it, and the screen is then exactly
  // what it has always been. See src/lib/orders/orderPiHandoff.ts.
  const [piHandoff,   setPiHandoff]   = useState<OrderPiHandoff>({ kind: 'none' })
  const [piProducts,  setPiProducts]  = useState<PersistedProduct[]>([])
  const [piImages,    setPiImages]    = useState<{
    representativeByRow: ReadonlyMap<number, string>
    customizationByRow: ReadonlyMap<number, readonly string[]>
    unresolved: number
    viewerItems: readonly PiViewerItem[]
  }>({ representativeByRow: new Map(), customizationByRow: new Map(), unresolved: 0, viewerItems: [] })
  const [clientOpen,  setClientOpen]  = useState(false)
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  const [wbBusy,      setWbBusy]      = useState(false)
  const [wbError,     setWbError]     = useState<string | null>(null)
  // The PI's private workbook key. Held in state and NEVER rendered: the screen
  // shows source_workbook_name, and this is only what gets handed to Supabase's
  // own signer at the moment of a click.
  const [wbPath,      setWbPath]      = useState<string | null>(null)
  const [isMobile,    setIsMobile]    = useState(false)

  // ── The generated documents ──
  //
  // The register, read under the caller's own RLS: can_view_order decides, so a
  // reader who may open the Order sees its document state and nobody else does.
  // claim_token is not among the columns and could not be selected if it were —
  // it is granted to no client role.
  const [documents,   setDocuments]   = useState<OrderDocumentRow[]>([])
  const [docBusy,     setDocBusy]     = useState(false)
  const [docDownload, setDocDownload] = useState<'xlsx' | 'pdf' | null>(null)
  const [docError,    setDocError]    = useState<string | null>(null)

  // Which thumbnail opened the viewer, so focus goes back to it on close, and
  // where those thumbnails live. Refs rather than state: neither is rendered.
  const viewerOpenedFrom = useRef<string | null>(null)
  const thumbnailRefs = useRef(new Map<string, HTMLButtonElement | null>())

  const router     = useRouter()
  const params     = useParams()
  const id         = params.id as string
  const supabase   = useMemo(() => createClient(), [])
  const { viewAsUserId } = useViewAs()

  /**
   * THE APPROVED PI BEHIND A CONFIRMED ORDER.
   *
   * READ UNDER THE CALLER'S OWN RLS, exactly like every other read on this page.
   * Migration 20260924000000 adds the door — can_view_order_submission_via_order,
   * which asks the ORDER's visibility, not the PI's review visibility — so a
   * viewer entitled to this Order gets the row and a viewer who is not gets
   * nothing. There is no branch here that decides who may see what, and there
   * must not be: a client-side visibility rule would be a second, weaker answer
   * to a question the database already answers.
   *
   * A MISSING ROW IS `unavailable`, NEVER AN ERROR AND NEVER ZERO. The Order
   * itself is perfectly readable; one card reports one absence.
   *
   * THREE READS, ISSUED TOGETHER, and only when the Order actually names a PI.
   * An Order with no source submission costs nothing at all here.
   */
  const loadPiHandoff = async (order: Order) => {
    const submissionId = order.source_order_submission_id
    if (!submissionId) {
      setPiHandoff({ kind: 'none' })
      setPiProducts([])
      setWbPath(null)
      return
    }

    const [subRes, itemsRes, imagesRes] = await Promise.all([
      supabase
        .from('order_submissions')
        .select(ORDER_PI_HANDOFF_COLUMNS)
        .eq('id', submissionId)
        .maybeSingle(),
      supabase
        .from('order_submission_items')
        .select(PI_DRAFT_ITEM_COLUMNS)
        .eq('submission_id', submissionId)
        .order('sort_order', { ascending: true }),
      supabase
        .from('order_submission_item_images')
        .select(PI_DRAFT_ITEM_IMAGE_COLUMNS)
        .eq('submission_id', submissionId)
        .order('position', { ascending: true }),
    ])

    const row = subRes.data as unknown as OrderPiRow | null
    if (subRes.error || !row) {
      setPiHandoff({ kind: 'unavailable' })
      setPiProducts([])
      setWbPath(null)
      return
    }

    const products = persistedProducts((itemsRes.data ?? []) as unknown as PersistedItem[])
    const images = (imagesRes.data ?? []) as unknown as PersistedItemImage[]

    // THE BUCKET STAYS PRIVATE. Nothing here builds a public URL — there is none
    // to build. Each object is signed on demand through the caller's own
    // session, so the storage policies decide again, per object, whether this
    // person may see this picture. A refusal yields no URL and the table shows
    // its honest "No image" box rather than a broken one.
    const signedByPath = new Map<string, string>()
    const paths = [...new Set(images.map(i => i.storage_path).filter(Boolean))]
    if (paths.length > 0) {
      const { data: signed } = await supabase
        .storage
        .from(ORDER_FILES_BUCKET)
        .createSignedUrls(paths, PI_DRAFT_IMAGE_URL_TTL_SECONDS)
      for (const entry of signed ?? []) {
        if (entry?.path && entry.signedUrl && !entry.error) signedByPath.set(entry.path, entry.signedUrl)
      }
    }

    const urls = persistedImageUrlMaps(products, images, signedByPath)

    setPiProducts(products)
    setPiImages({
      representativeByRow: urls.representativeByRow,
      customizationByRow: urls.customizationByRow,
      unresolved: urls.unresolved,
      // The same helper both PI screens use, so a picture is labelled and
      // ordered identically wherever it is opened.
      viewerItems: buildImageViewerItems(products, urls),
    })
    setWbPath(orderPiWorkbookPath(row))
    setPiHandoff(buildOrderPiHandoff(row, {
      totalProductValue: order.total_product_value,
      totalValue: order.total_value,
    }))
  }

  /**
   * The Order's own trail, as one query and one mapping — named once so the
   * full page load and the narrow refresh below cannot read or shape it
   * differently.
   */
  const activityQuery = () =>
    supabase
      .from('order_activity_log')
      .select(`id, event_type, payload, created_at, actor:users!actor_id(full_name)`)
      .eq('order_id', id)
      .order('created_at', { ascending: false })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapActivityRows = (rows: any): ActivityEntry[] =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((rows ?? []) as any[]).map(a => ({
      id:         a.id,
      event_type: a.event_type,
      payload:    a.payload ?? {},
      created_at: a.created_at,
      actor_name: a.actor?.full_name ?? undefined,
    }))

  /**
   * WHAT A STATUS CHANGE ACTUALLY CHANGED, and nothing else.
   *
   * A transition writes two things: `orders.status`, which the caller has
   * already applied to the row in hand, and one `order_activity_log` entry.
   * It touches no payment, no allocation, no document version, no change
   * request and no PI handoff — so re-running the whole page load to see it
   * spent ten round trips to learn one new row.
   *
   * Deliberately NOT used by the amendment, cancellation or change-request
   * paths: each of those can move commercial columns on the Order itself, and
   * a narrow refresh there would leave the screen stating figures the database
   * no longer holds. Those keep the full loadOrder(). The header's explicit
   * Refresh is also unchanged and still re-reads everything.
   */
  const reloadActivity = async () => {
    const { data } = await activityQuery()
    setActivity(mapActivityRows(data))
  }

  const loadOrder = async () => {
    const { data: o } = await supabase
      .from('orders')
      .select(`
        id, display_number, client_name,
        requested_by, assigned_to, created_by,
        confirm_date, due_date, total_value, total_product_value,
        lead_source, status, notes, created_at, updated_at,
        source_order_request_id, source_request_number, is_test_data,
        source_order_submission_id, billing_percentage,
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

    // The approved PI, started HERE rather than awaited later: it depends only
    // on the Order row just read, so it overlaps the four reads below instead
    // of queueing behind them. Awaited at the end so a refresh still settles in
    // one commit.
    const handoff = loadPiHandoff(mapped)

    // FOUR ANCHORED READS, every one scoped to this Order and every one
    // RLS-checked — issued TOGETHER because none of them depends on another's
    // answer. They used to run one after the next, so the slowest decided the
    // page and the other three waited for no reason.
    //
    //   the legacy link   payments carrying order_id — unchanged, so an Order
    //                     converted from an Order Request behaves exactly as it
    //                     always has
    //   the allocations   what a PI's money became when its allocation MOVED
    //                     onto this Order at approval; the payment row itself is
    //                     untouched and carries no order_id
    //   the activity      the Order's own trail
    //   change requests   not filtered to 'pending': a reader needs to see that
    //                     their last request was rejected, not just that they
    //                     have none open
    const [
      { data: pData },
      { data: allocData },
      { data: aData },
      { data: cData },
      { data: dData },
    ] = await Promise.all([
      supabase
        .from('finance_payment_requests')
        .select('id, client_name, amount, payment_date, payment_mode, order_number, status')
        .eq('order_id', id)
        .order('payment_date', { ascending: false }),

      supabase
        .from('finance_payment_allocations')
        // The embed names its FOREIGN KEY, not a column: PostgREST resolves an
        // embedded resource by relationship, and naming the constraint
        // (20260918000000 §1) is the form that cannot become ambiguous if this
        // table ever gains a second reference to the ledger.
        .select('id, allocated_amount, status, ' +
                'payment:finance_payment_requests!finance_payment_allocations_payment_fk(' +
                'id, client_name, amount, payment_date, payment_mode, order_number, status)')
        .eq('order_id', id)
        .eq('status', 'active'),

      activityQuery(),

      supabase
        .from('order_document_versions')
        .select(ORDER_DOCUMENT_COLUMNS)
        .eq('order_id', id)
        .order('version', { ascending: false }),

      supabase
        .from('order_change_requests')
        .select(`
          id, order_id, order_number_snapshot, request_type, requested_by, reason,
          proposed_client_name, proposed_total_value, proposed_total_product_value,
          proposed_confirm_date, proposed_due_date, proposed_lead_source, proposed_notes,
          baseline_client_name, baseline_total_value, baseline_total_product_value,
          baseline_confirm_date, baseline_due_date, baseline_lead_source, baseline_notes,
          status, reviewed_by, reviewed_at, review_note, created_at,
          requester:users!requested_by(full_name)
        `)
        .eq('order_id', id)
        .order('created_at', { ascending: false }),
    ])

    setDocuments((dData ?? []) as unknown as OrderDocumentRow[])

    // MERGE, THEN RE-READ THE MONEY EXACTLY.
    //
    // mergeOrderPayments does the joining, the de-duplication and the ordering
    // and keeps its two money fields as JS numbers, which is what the list has
    // always sorted and rendered with. withExactAmounts then re-reads the SAME
    // two source arrays for the `numeric` STRINGS PostgREST actually sent, and
    // it is those the totals are built from — so no total can inherit a
    // rounding the display introduced. Neither call queries anything.
    const linkedRows = (pData ?? []) as Parameters<typeof mergeOrderPayments>[0]
    // PostgREST returns an embedded to-one relation as an object; the generated
    // types cannot know the cardinality, so it is narrowed here once.
    const allocationRows = (allocData ?? []) as unknown as OrderAllocationRow[]

    const merged = mergeOrderPayments(linkedRows, allocationRows)

    // ── THE WHOLE-PAYMENT FACT ──
    //
    // The canonical attribution rule turns on whether a payment has active
    // allocations ELSEWHERE — which this screen cannot see for itself. Its two
    // reads are both anchored to this Order, and RLS would not show it an
    // allocation onto somebody else's Order in any case.
    //
    // Without this, a ₹10,00,000 payment carrying this Order's order_id but
    // allocated ₹4,00,000 to a DIFFERENT Order reads as ₹10,00,000 here and
    // ₹4,00,000 there: ₹14,00,000 of attribution for ₹10,00,000 of money.
    //
    // ONE BATCHED CALL for every payment on the screen, never one per row. The
    // function is SECURITY INVOKER, so the payment table's own RLS decides which
    // ids it answers for — a payment this reader could not already open simply
    // yields no row.
    //
    // THREE THINGS MEAN "UNKNOWN" HERE, AND ALL THREE ARE HANDLED THE SAME WAY:
    // a missing row (not readable), an explicit NULL (readable, but the reader
    // cannot see enough of the allocation table to vouch for a zero), and a
    // failed call (empty map). In every case the rule WITHHOLDS the direct-link
    // fallback rather than guessing, which under-states instead of over-stating.
    // A zero that the reader CAN vouch for arrives as 0, not NULL, and the
    // fallback then fires — that is worked example A, the ordinary case.
    const paymentIds = merged.map(p => p.id)
    const activeTotals = new Map<string, string | number | null>()
    if (paymentIds.length > 0) {
      const { data: totals } = await supabase
        .rpc('payment_active_allocation_totals', { p_payment_ids: paymentIds })
      for (const row of (totals ?? []) as { payment_request_id: string; active_total: string | number | null }[]) {
        activeTotals.set(row.payment_request_id, row.active_total)
      }
    }

    setPayments(withExactAmounts(merged, {
      linked: linkedRows, allocations: allocationRows, activeTotals,
    }))

    setActivity(mapActivityRows(aData))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setChangeRequests(((cData ?? []) as any[]).map(c => ({
      ...c,
      requested_by_name: c.requester?.full_name ?? undefined,
      requester: undefined,
    })) as OrderChangeRequest[])

    await handoff
  }

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      // ── THE PROFILE, THE PERMISSIONS AND THE ORDER, TOGETHER ──
      //
      // They ran one after the next, so this page waited for three latencies
      // before it drew anything — and none of the three needs another's answer.
      // Every row loadOrder reads is scoped by RLS, not by the capabilities
      // being resolved beside it.
      //
      // NOTHING ABOUT AUTHORITY CHANGED. ordersCaps still starts empty, is still
      // resolved by resolve_effective_permissions in the database, and is still
      // in hand before any amendment control can render: pageLoading is not
      // cleared until all three have landed.
      //
      // THE FINANCE RESOLVE JOINS THE SAME GROUP, and that is the whole reason
      // it is affordable: it is a fourth independent call in a set that already
      // waits for the slowest, so it adds no latency to a page that previously
      // made three. It decides only whether a payment row draws a link into its
      // Finance record — see crossModuleLinks.ts on why a link is a drawing
      // question and never an authorization one.
      const [{ data: me }, ordersPerms, financePerms] = await Promise.all([
        supabase
          .from('users')
          .select(USER_PROFILE_COLUMNS)
          .eq('id', session.user.id)
          .single(),
        getEffectivePermissions(supabase, session.user.id, 'orders').catch(() => []),
        getEffectivePermissions(supabase, session.user.id, 'finance').catch(() => []),
        loadOrder(),
      ])

      setProfile(me as UserProfile)
      setOrdersCaps(deriveOrdersCapabilities(me?.role, ordersPerms))
      setFinanceCaps(deriveFinanceCapabilities(me?.role, financePerms))

      // This one genuinely depends on the profile, and is asked only of an
      // admin — for whom it decides a single temporary, testing-phase control.
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

  // The product table lays out differently at phone width, exactly as it does
  // on both PI screens.
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  /**
   * The original uploaded workbook, downloaded through a SHORT-LIVED SIGNED URL.
   *
   * THE BUCKET IS PRIVATE AND STAYS PRIVATE. There is no public URL to build and
   * none is built. The URL is minted through the reader's OWN session, so the
   * order-files SELECT policies decide again, at the moment of the click, for
   * this exact object — a viewer whose Order access has been withdrawn since the
   * page loaded gets a refusal, not a stale link.
   *
   * THE PATH IS NEVER TAKEN FROM THE UI. It is the column the PI record itself
   * carries, re-checked by orderPiWorkbookPath against this submission's own
   * original/ prefix, so a malformed or foreign key never reaches the signer.
   *
   * A REFUSAL IS ONE QUIET LINE. It never throws the page and never explains
   * more than it should.
   */
  const downloadWorkbook = async () => {
    if (!wbPath || wbBusy) return
    setWbBusy(true)
    setWbError(null)
    const { data, error } = await supabase
      .storage
      .from(ORDER_FILES_BUCKET)
      .createSignedUrl(wbPath, ORDER_PI_WORKBOOK_URL_TTL_SECONDS, { download: true })
    setWbBusy(false)
    if (error || !data?.signedUrl) { setWbError(WORKBOOK_UNAVAILABLE); return }
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
  }

  /**
   * Ask for this Order's documents.
   *
   * THE BUTTON IS NOT THE SECURITY. The route calls
   * request_order_document_generation through the CALLER'S own session, and two
   * RLS policies re-derive both the management approval authority and sight of
   * this Order. Hiding the control is a courtesy to everybody who would only be
   * refused.
   *
   * A refusal is one quiet line, never a thrown page.
   */
  const requestDocuments = async () => {
    if (docBusy) return
    setDocBusy(true)
    setDocError(null)
    try {
      const response = await fetch(`/api/orders/${id}/documents`, { method: 'POST' })
      const body = await response.json().catch(() => null) as
        { code?: string; error?: string; message?: string } | null

      if (!response.ok && response.status !== 202) {
        // THE CODE DECIDES, NOT THE SERVER'S PROSE.
        //
        // This used to print `body.message` and fall back to one generic
        // sentence when it was absent. That fallback is how a deployment
        // missing its service-role key was reported to a reader as "that could
        // not be done just now" — a sentence that describes a refusal, sends
        // them to look at permissions, and is wrong about all of it.
        //
        // The code is resolved against a table THIS BUNDLE owns, so the text on
        // screen is text this repository reviewed. The server's own message is
        // never rendered; an unknown code degrades to the generic answer rather
        // than printing a token from the wire.
        setDocError(orderDocumentResponse(body?.code ?? body?.error).message)
      }
    } catch {
      setDocError(DOCUMENTS_REFUSED)
    }
    setDocBusy(false)
    // Re-read either way: a refusal may still have moved the register, and a
    // success certainly did.
    await loadOrder()
  }

  /**
   * Download one confirmed document.
   *
   * SIGNED ON THE CLICK, through the reader's own session, so the order-files
   * rule decides again at that moment — and that rule authorizes an object only
   * when a READY version names it, which is what keeps a failed attempt's
   * half-upload unreachable however well somebody knows its key.
   *
   * The PATH comes from the register, which is itself RLS-filtered. Nothing here
   * builds a key.
   */
  const downloadDocument = async (kind: 'xlsx' | 'pdf') => {
    if (docDownload) return
    const view = buildOrderDocumentsView(documents)
    const path = kind === 'xlsx' ? view.excelPath : view.pdfPath
    if (!path) { setDocError(DOCUMENTS_REFUSED); return }

    setDocDownload(kind)
    setDocError(null)
    const { data, error } = await supabase
      .storage
      .from(ORDER_FILES_BUCKET)
      .createSignedUrl(path, ORDER_DOCUMENT_URL_TTL_SECONDS, { download: true })
    setDocDownload(null)
    if (error || !data?.signedUrl) { setDocError(DOCUMENTS_REFUSED); return }
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
  }

  // ── The image viewer ──
  //
  // The same three moves both PI screens make: remember which thumbnail opened
  // it so focus can be given back, step by index, and close by clearing it.
  const viewerItem = viewerIndex !== null ? piImages.viewerItems[viewerIndex] ?? null : null
  const viewerNavState = viewerIndex !== null
    ? viewerNav(viewerIndex, piImages.viewerItems.length)
    : null

  const openViewer = (key: string) => {
    const index = piImages.viewerItems.findIndex(item => item.key === key)
    if (index < 0) return
    viewerOpenedFrom.current = key
    setViewerIndex(index)
  }

  const closeViewer = () => {
    setViewerIndex(null)
    const key = viewerOpenedFrom.current
    viewerOpenedFrom.current = null
    if (key !== null) thumbnailRefs.current.get(key)?.focus()
  }

  const stepViewer = (index: number | null) => {
    if (index === null) return
    setViewerIndex(index)
    viewerOpenedFrom.current = piImages.viewerItems[index]?.key ?? viewerOpenedFrom.current
  }

  const thumbnailFor = (key: string, url: string | undefined): PiThumbnailProps => ({
    url,
    label: piImages.viewerItems.find(item => item.key === key)?.label,
    onOpen: () => openViewer(key),
    buttonRef: (el: HTMLButtonElement | null) => { thumbnailRefs.current.set(key, el) },
  })

  const representativeThumbnail = (row: number) =>
    thumbnailFor(`representative-${row}`, piImages.representativeByRow.get(row))

  const customizationThumbnails = (row: number) =>
    (piImages.customizationByRow.get(row) ?? []).map((url, index) => {
      const key = `customization-${row}-${index}`
      return { key, props: thumbnailFor(key, url) }
    })

  const canCleanUp = cleanupEnabled && !!order?.is_test_data

  // Which amendment door this reader gets. Both are re-decided by the database
  // (assert_order_amender / the INSERT policy); these only choose the button.
  // View As never lends authority, so an admin previewing someone else's view
  // does not keep the direct door — same rule the cleanup button already uses.
  const actingAsAdmin = profile?.role === 'admin' && !viewAsUserId
  // orders.manage opens the same direct door. Resolved for the SIGNED-IN
  // user and suppressed under View As for exactly the reason above: viewing
  // as someone else must not lend them your authority.
  const mayManageOrders = ordersCaps.canManageOrders && !viewAsUserId
  const canAmend   = order ? canAmendOrderDirectly(actingAsAdmin ? profile : { role: 'member' }, order, mayManageOrders) : false
  const canRequest = order ? canRequestOrderChange(actingAsAdmin ? profile : { role: 'member' }, order, mayManageOrders) : false

  const myPendingEdit = !!(order && profile) &&
    hasPendingChangeRequest(changeRequests, order.id, profile.id, 'edit')
  const myPendingCancel = !!(order && profile) &&
    hasPendingChangeRequest(changeRequests, order.id, profile.id, 'cancel')

  const pendingRequests = changeRequests.filter(r => r.status === 'pending')

  /**
   * WHO SEES THE GENERATE CONTROL.
   *
   * orders.approve_order — the existing management approval authority, the same
   * protected action that decides whether a person may turn a PI into an Order.
   * deriveOrdersCapabilities short-circuits an active admin, so this page never
   * reads users.role to decide it.
   *
   * SUPPRESSED UNDER VIEW AS, for the reason every other authority on this page
   * is: viewing as somebody else must not lend them your authority.
   *
   * And it is not the enforcement. Two RLS policies re-derive both this and
   * sight of the Order when the request actually lands.
   */
  const mayGenerateDocuments = ordersCaps.canApproveOrderSubmission && !viewAsUserId

  /** ONE ANSWER about the documents, so the card, the buttons and the tests
   *  cannot disagree about whether there is anything to download. */
  const documentsView = buildOrderDocumentsView(documents)

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

  // THE ORDER'S FINANCE POSITION, computed in exact decimal from the `numeric`
  // strings the two anchored reads returned — see orderFinancePosition.ts.
  //
  // Every figure below used to be a float sum done here, and three of them were
  // wrong in ways a reader could see: verified money was labelled "Received" so
  // unverified money did not exist on this screen, the Amount column printed a
  // split payment's whole ledger amount beside a tile counting only this Order's
  // share, and the arithmetic itself could disagree with the same money summed
  // in `numeric` on the PI. Nothing on this screen adds money any more.
  const finance = buildOrderFinancePosition(payments, order.total_value)

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
                onStatusChanged={updated => {
                  // Both values are the DATABASE's, read back by the update
                  // itself — `updated_at` is written by a trigger and is shown
                  // as "Last Updated", so it cannot be assumed. Every other
                  // status-derived thing on this page (the badge, the allowed
                  // transitions, the amend and cancel controls) is computed
                  // from `order.status`, so all of them follow from this.
                  setOrder(o => o ? { ...o, ...updated } : o)
                  // A transition writes the row above and one activity entry.
                  // Nothing else on this page moved, so nothing else is re-read.
                  reloadActivity()
                }}
                // The Order was not where this screen thought it was. Re-read
                // everything rather than guess which part is stale.
                onOutOfDate={() => { loadOrder() }}
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

        {/* ── Payment summary ──

            SIX FIGURES, and the three money states are three of them.

            The card used to show four: Order Value, "Received", Pending and
            Completion — where "Received" was in fact VERIFIED money. A payment
            the client had genuinely made and Finance had not yet reached was
            therefore invisible here, and a salesperson chasing a client for
            money already sent had no way to see it on this screen.

            The three are now named separately and never stand in for each
            other. Verified is what Finance has confirmed and is the figure the
            business treats as paid; Awaiting is money recorded and not yet
            decided; Received is the two together — what has come in, whatever
            Finance has done about it yet. The BALANCE is measured against
            verified money alone, because unverified money does not reduce what
            is owed. */}
        <SectionCard title="Payment Summary">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '16px' }}>
            <SummaryFigure label="Order Value" value={formatMoney(finance.orderValue)} />
            <SummaryFigure
              label="Verified"
              value={formatMoney(finance.verified)}
              color={colors.green}
              hint="confirmed by Finance"
            />
            <SummaryFigure
              label="Awaiting Verification"
              value={formatMoney(finance.awaitingVerification)}
              color={finance.counts.awaiting > 0 ? colors.amber : colors.muted}
              hint={finance.counts.awaiting > 0
                ? `${finance.counts.awaiting} payment${finance.counts.awaiting === 1 ? '' : 's'} with Finance`
                : 'nothing with Finance'}
            />
            <SummaryFigure
              label="Received"
              value={formatMoney(finance.received)}
              hint="verified + awaiting"
            />
            <SummaryFigure
              label="Balance"
              value={formatMoney(finance.pendingBalance)}
              color={finance.pendingBalance && finance.pendingBalance !== '0.00' && !finance.fullyPaid
                ? colors.amber
                : colors.muted}
              hint="against verified"
            />
            <div>
              <FigureLabel>Verified %</FigureLabel>
              <div style={{ fontSize: '18px', fontWeight: 700, color: finance.fullyPaid ? colors.green : colors.primary, fontVariantNumeric: 'tabular-nums' }}>
                {formatPercent(finance.verifiedPercent)}
              </div>
              {/* A PIXEL QUANTITY and nothing else — clamped to 0–100, never
                  shown as a figure and never used in a decision. The figure
                  above it is the truth and is deliberately not capped, so an
                  overpaid Order reads over 100%. */}
              {finance.verifiedPercent !== null && (
                <div
                  role="presentation"
                  style={{ marginTop: '6px', height: '4px', borderRadius: '2px', background: colors.float, overflow: 'hidden' }}
                >
                  <div style={{
                    height: '100%', borderRadius: '2px',
                    width: `${progressWidth(finance.verifiedPercent)}%`,
                    background: finance.fullyPaid ? colors.green : colors.blue,
                    transition: 'width 0.3s',
                  }} />
                </div>
              )}
            </div>
          </div>

          {/* MONEY THAT IS ONLY PARTLY THIS ORDER'S.

              A payment may legitimately be split across targets, and every
              figure above counts only this Order's share. Said out loud, because
              a reader comparing the Balance here against a bank statement needs
              to know the difference is a split and not a missing payment.

              DELIBERATELY NOT CALLED "UNALLOCATED": the rest of that money may
              be on another Order, on a PI, or on nothing at all, and this screen
              reads only THIS Order's allocations. Finance answers that question,
              from the payment's own record — which is where the link goes. */}
          {finance.splitPayments.length > 0 && (
            <div style={{
              marginTop: '14px', paddingTop: '12px', borderTop: `1px solid ${colors.border}`,
              fontSize: '12px', color: colors.secondary, lineHeight: 1.5,
            }}>
              {finance.splitPayments.length === 1 ? 'One payment below is' : `${finance.splitPayments.length} payments below are`}
              {' '}allocated across more than one record. Once a payment is allocated, the
              allocations decide what each Order receives — so only this Order&apos;s allocated
              share is counted above, even where the payment also names this Order directly.
              The full amount of each is shown beneath its share, and the complete allocation
              history is in its Finance record.
            </div>
          )}
        </SectionCard>

        {/* ── Payments ──

            THE COLUMN THAT DID NOT RECONCILE. "Amount" printed each payment's
            FULL ledger amount, while the summary above counted only this
            Order's ALLOCATED share of it. For a payment split across two Orders
            those are different numbers, so a reader adding the column by eye got
            a total that did not match the tile. The leading figure is now this
            Order's share — the figure the summary is built from — and a split
            payment states its full amount underneath, so nothing is hidden and
            the two agree.

            STATUS WORDING NOW MATCHES THE PI — see PAYMENT_STATUS_COLOR above
            for the three labels that disagreed and why each was wrong here. The
            colours are this screen's existing ones, unchanged. */}
        <SectionCard title={`Payments (${payments.length})`}>
          {payments.length === 0 ? (
            <div style={{ color: colors.muted, fontSize: '13px', lineHeight: 1.6 }}>
              No payment has been recorded against this Order yet.
              {order.total_value != null && (
                <> The full order value of {formatMoney(finance.orderValue)} is outstanding.</>
              )}
            </div>
          ) : (
            <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', minWidth: '640px' }}>
                <caption style={{
                  captionSide: 'top', textAlign: 'left', fontSize: '11px',
                  color: colors.muted, paddingBottom: '8px', lineHeight: 1.5,
                }}>
                  Amounts are this Order&apos;s share. Where a payment has been
                  allocated, the allocation decides the share; where it has not,
                  a payment linked to this Order counts in full.
                </caption>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                    {['Client', 'This Order', 'Date', 'Mode', 'Status', ''].map((h, i) => (
                      <th key={h || `action-${i}`} scope="col" style={{
                        padding: '6px 12px',
                        textAlign: h === 'This Order' ? 'right' : 'left',
                        fontSize: '10px', fontWeight: 600, color: colors.muted,
                        textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {payments.map(p => {
                    // One vocabulary, from the PI card's own map. An
                    // unrecognised status says what it is rather than being
                    // relabelled as something friendlier that might be untrue.
                    const statusLabel = piPaymentStatusLabel(p.status)
                    const statusColor = PAYMENT_STATUS_COLOR[p.status] ?? colors.muted
                    return (
                      <tr key={p.id} style={{ borderBottom: `1px solid ${colors.border}` }}>
                        <td style={{ padding: '10px 12px', color: colors.primary, wordBreak: 'break-word', minWidth: '140px' }}>
                          {/* A payment with no customer says so, from the one
                              shared formatter. An em dash would read as
                              missing data rather than as a Suspense payment. */}
                          {customerDisplayName(p.client_name)}
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                          <div style={{ fontWeight: 600, color: colors.primary }}>
                            {formatMoney(p.exactAllocatedAmount)}
                          </div>
                          {/* Only when the two genuinely differ. Saying "of
                              ₹X" under every row would be noise on the ordinary
                              case, where the whole payment is this Order's. */}
                          {p.isPartialShare && (
                            <div style={{ fontSize: '10.5px', color: colors.muted, marginTop: '2px' }}>
                              allocated from {formatMoney(p.exactAmount)} received
                            </div>
                          )}
                        </td>
                        <td style={{ padding: '10px 12px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                          {fmtDate(p.payment_date)}
                        </td>
                        <td style={{ padding: '10px 12px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                          {PAYMENT_MODE_LABEL[p.payment_mode] ?? p.payment_mode ?? '—'}
                        </td>
                        <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', fontWeight: 600, fontSize: '12px', color: statusColor }}>
                          {statusLabel}
                        </td>
                        {/* THE FINANCE RECORD — a payment's proof, its verification
                            history and its complete allocation across every target
                            live in Finance, and this is the door to them. Offered
                            only to a reader who holds Finance module entry, so
                            nobody is shown a door that shuts in their face; the
                            Finance page still re-reads the row under that reader's
                            own RLS and refuses anything they may not open. */}
                        <td style={{ padding: '10px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {financeCaps.canAccessFinanceModule && (
                            <button
                              onClick={() => router.push(financePaymentHref(p.id))}
                              className="boe-btn boe-btn-ghost"
                              style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 500 }}
                              title={`Open this payment's full record in Finance`}
                            >
                              Finance record
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>

        {/* ── The approved PI this Order came from ──

            ADDITIVE, AND PLACED WITHOUT MOVING ANYTHING. Every Order-owned
            section above and below keeps its position: this is what the Order
            gains, not a rearrangement of what it had.

            NOTHING IS RENDERED FOR AN ORDER WITH NO PI. `none` is the state of
            an Order created from an Order Request or by any other path, and the
            screen is then exactly what it has always been — no empty card, and
            no panel explaining the absence of a thing that was never there.

            AND THERE IS NO SECOND PAYMENT SURFACE. The Order's own Payment
            Summary above states the verified position from the Order's
            allocations; a PI-side payment block here would answer the same
            question a second time, with a figure that stopped being the
            authority when the money moved onto the Order. */}
        {/* ── The confirmed documents ──
            Rendered for every Order that came from a PI, including one nobody
            has asked about yet: "no documents have been generated" is the
            answer to a question somebody opening this page is asking. An Order
            with no PI has no documents to generate and gets no card — it gets
            the one-line explanation below instead. */}
        {piHandoff.kind !== 'none' && (
          <OrderDocumentsCard
            view={documentsView}
            canGenerate={mayGenerateDocuments}
            onGenerate={requestDocuments}
            generating={docBusy}
            onDownload={downloadDocument}
            downloading={docDownload}
            error={docError}
          />
        )}

        {/* EVERY ORDER NOW SAYS SOMETHING ABOUT ITS PI, and that is a
            correction. This originally rendered nothing at all for an Order
            with no linked PI, reasoning that an absence needs no explanation.
            But "this Order has no PI" and "the feature is not deployed" are
            indistinguishable from the outside, and the first reader of this
            screen read the silence as the second. The panel is read-only and
            offers no action, because there is no action to offer. */}
        {piHandoff.kind === 'none' && <OrderPiNoSource />}

        {piHandoff.kind === 'unavailable' && <OrderPiUnavailable />}

        {piHandoff.kind === 'ready' && (
          <>
            <OrderPiSummaryCard
              client={piHandoff.client}
              onOpenClient={() => setClientOpen(true)}
              dates={piHandoff.dates}
              figures={piHandoff.figures}
              billing={piHandoff.billing}
              workbookName={wbPath ? piHandoff.workbookName : null}
              onDownloadWorkbook={downloadWorkbook}
              downloading={wbBusy}
              downloadError={wbError}
              // The way back to the PI this Order came from. The database has
              // had this door since 20260924000000 — can_view_order_submission_via_order
              // exists so that seeing the Order is a way onto its approved PI —
              // and nothing in the interface used it, so the trail ran one way
              // only. The PI screen still decides for itself under RLS.
              onOpenPi={() => router.push(piSubmissionHref(piHandoff.submissionId))}
            />

            <OrderPiProducts
              products={piProducts}
              isMobile={isMobile}
              representativeThumbnail={representativeThumbnail}
              customizationThumbnails={customizationThumbnails}
              unresolvedImages={piImages.unresolved}
            />

            {/* The stored figures, through the shared rows builder. Nothing on
                this page recomputes a total; these are literally the same
                strings the approved PI screen prints. */}
            <PiCommercialSummary
              rows={piHandoff.commercialRows}
              title="Commercial breakdown"
              variant="detail"
            />
          </>
        )}

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
          isAdmin={actingAsAdmin || mayManageOrders}
          onClose={() => setCancelOpen(false)}
          onDone={afterChange}
        />
      )}
      {/* The client dialog the PI card's name opens: the contact number and both
          parties, spelled out. The same component the PI screen uses. */}
      {clientOpen && piHandoff.kind === 'ready' && (
        <PiClientDetailsModal client={piHandoff.client} onClose={() => setClientOpen(false)} />
      )}

      {viewerItem && viewerNavState && (
        <PiImageViewer
          key={viewerItem.key}
          item={viewerItem}
          nav={viewerNavState}
          onClose={closeViewer}
          onPrev={() => stepViewer(viewerNavState.prevIndex)}
          onNext={() => stepViewer(viewerNavState.nextIndex)}
        />
      )}

      {reviewing && (
        <ReviewChangeRequestModal
          request={reviewing}
          order={amendableOrder ?? null}
          supabase={supabase}
          onClose={() => setReviewing(null)}
          onDone={afterChange}
        />
      )}

    </OrdersLayout>
  )
}
