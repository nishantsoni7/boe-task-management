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
import { colors } from '@/lib/tokens'
import { PiCard, PiCardHeader } from '@/components/orders/piPreview'
import {
  MoreActionsMenu,
  ORDER_SUMMARY_COMMERCIAL_TITLE,
  OrderActivityList,
  OrderAttentionBar,
  OrderCommercialTotals,
  OrderDetailSkeleton,
  OrderImportantDatesSection,
  OrderStatusPill,
  OrderSummary,
  PAYMENT_SECTION_TITLE,
  PaymentSummaryFigures,
  SECTION_HEADER_STYLE,
  SectionSkeleton,
  SkeletonBlock,
  type MoreActionItem,
  type OrderActivityItem,
} from './OrderWorkspace'
import {
  arrangeOrderActions,
  orderAttentionItems,
  orderImportantDates,
  orderSummaryFacts,
  type OrderHeaderActionKey,
  type WorkspaceTone,
} from '@/lib/orders/orderWorkspace'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import {
  mergeOrderPayments,
  type OrderAllocationRow,
} from '@/lib/orders/orderPayments'
import {
  buildOrderFinancePosition,
  withExactAmounts,
  type OrderFinancePaymentRow,
} from '@/lib/finance/orderFinancePosition'
import { formatMoney, piPaymentStatusLabel } from '@/lib/finance/piPaymentView'
import {
  deriveFinanceCapabilities,
  NO_FINANCE_CAPABILITIES,
  type FinanceCapabilities,
} from '@/lib/permissions/finance'
// piSubmissionHref is deliberately NOT imported: after conversion this page is
// the source of truth and offers no route back to the superseded draft. The PI
// relation, its files and its version history are all still here.
import { financePaymentHref } from '@/lib/finance/crossModuleLinks'
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
  ORDER_PI_UNAVAILABLE_BODY,
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
import { PiImageViewer, type PiThumbnailProps } from '@/components/orders/piPreview'
import { PiClientDetailsModal } from '@/components/orders/piReviewModals'
// ONE payment-mode source for Order and Finance (20261013000000).
import { PAYMENT_MODE_LABEL, customerDisplayName } from '@/lib/finance/paymentEntry'
import {
  OrderCommercialBreakdown,
  OrderDocumentsCard,
  OrderPiHistoryCard,
  OrderPiNoSource,
  OrderPiProducts,
} from './OrderPiSections'
import {
  ApproveRevisionModal,
  ProductionAlignmentModal,
  ProposeRevisionModal,
  RejectRevisionModal,
} from './OrderRevisionModals'
import {
  ORDER_PI_VERSION_COLUMNS,
  canDecidePiRevision,
  canProposePiRevision,
  describePiRevisionFailure,
  describePiVersionHistory,
  revisionWorkbookPath,
  versionActorIds,
  type PersistedPiVersion,
  type PiVersionView,
} from '@/lib/orders/orderPiVersions'
import { WORKBOOK_UPLOAD_MIME } from '@/lib/orders/saveDraftFlow'
import {
  canAlignProduction,
  describeAlignmentFailure,
  describeProductionAlignment,
} from '@/lib/orders/productionAlignment'
import {
  PI_ACTIVITY_COLUMNS,
  activityActorIds,
  type PersistedActivity,
} from '@/lib/orders/submissionActivity'
import { mergeOrderHistory } from '@/lib/orders/orderHistory'
import {
  formatOrderOperationalNumber,
  orderProductCodesByItemId,
  type OrderProductCodeRecord,
} from '@/lib/orders/orderProductCodes'
import { notifyOrderUpdate, notifyPiSubmission } from '@/lib/notify'
import type { OrderUpdateEvent } from '@/lib/orders/orderUpdateNotifications'
import {
  ORDER_UNREAD_TYPES,
  oldestUnreadAt,
  type UnreadUpdateRow,
} from '@/lib/orders/orderUnreadUpdates'
import { leadSourceLabel } from '@/lib/orders/orderConfirmation'
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
  // Production alignment (20261119000000). 'not_aligned' on every Order at
  // creation; moved only by set_order_production_alignment().
  production_alignment?: string | null
  production_aligned_by?: string | null
  production_aligned_by_name?: string
  production_aligned_at?: string | null
  production_alignment_note?: string | null
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

/** The same five states as the health card reads them: ordinary running states
 *  are blue, a hold is amber, dispatched is complete, cancelled is red. */
const STATUS_TONE: Record<string, WorkspaceTone> = {
  running:            'blue',
  on_hold:            'amber',
  ready_for_dispatch: 'blue',
  dispatched:         'green',
  cancelled:          'red',
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
  return <span className="order-activity-dot" style={{ background: c }} aria-hidden="true" />
}

/** The same marker for an event from the source PI's trail, by its tone. */
function HistoryDot({ tone }: { tone: 'neutral' | 'blue' | 'amber' | 'green' | 'red' }) {
  const c = tone === 'green' ? colors.green
    : tone === 'amber' ? colors.amber
    : tone === 'red' ? colors.red
    : tone === 'blue' ? colors.blue
    : colors.muted
  return <span className="order-activity-dot" style={{ background: c }} aria-hidden="true" />
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
          type="button"
          onClick={() => setOpen(o => !o)}
          onKeyDown={e => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false) } }}
          disabled={saving}
          aria-haspopup="menu"
          aria-expanded={open}
          className="boe-record-action"
        >
          {saving ? 'Updating…' : 'Change Status'}
          <ChevronDown size={13} strokeWidth={2} aria-hidden="true" />
        </button>

        {open && (
          <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 99 }} onClick={() => setOpen(false)} />
            <div role="menu" aria-label="Change status" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }} style={{
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
                    type="button"
                    role="menuitem"
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

  // ── What has landed ──
  //
  // The page draws as soon as the Order ROW is in hand; the anchored reads and
  // the PI handoff resolve into it section by section. These two say which
  // sections are still on their way, so a health line reads "Loading…" rather
  // than a false zero and a table draws its skeleton rather than "no lines".
  // Set once and never cleared: a refresh replaces data in place and must not
  // blank a screen somebody is reading.
  const [recordsReady, setRecordsReady] = useState(false)
  /**
   * WHERE THIS READER HAD GOT TO — the timestamp of their oldest unread update
   * on this Order, captured once on open, just before those rows are marked
   * read. Null when there was nothing new, which is the ordinary case and
   * draws no marks at all.
   */
  const [newSince, setNewSince] = useState<string | null>(null)
  const [handoffReady, setHandoffReady] = useState(false)
  const changeRequestsRef = useRef<HTMLDivElement | null>(null)
  // The startup gate's resolver, parked here by the startup path and released
  // by loadOrder once the Order row is in hand. See releaseShell below.
  const shellSignal = useRef<(() => void) | null>(null)

  // ── The PI's versions and its trail (20261119000000) ──
  //
  // Both read under the caller's own RLS beside the handoff: can_view_order
  // decides the versions, can_view_order_submission_via_order the trail. The
  // names are one batched users read for every actor either mentions.
  const [piVersions,   setPiVersions]   = useState<PersistedPiVersion[]>([])
  const [piActivity,   setPiActivity]   = useState<PersistedActivity[]>([])
  const [piNames,      setPiNames]      = useState<Map<string, string>>(new Map())
  const [revisionDialog, setRevisionDialog] = useState<
    | { kind: 'propose' }
    | { kind: 'approve'; version: PiVersionView }
    | { kind: 'reject'; version: PiVersionView }
    | null
  >(null)
  const [revisionBusy,  setRevisionBusy]  = useState(false)
  const [revisionError, setRevisionError] = useState<string | null>(null)
  const [versionOpening, setVersionOpening] = useState<string | null>(null)
  const [alignDialog,   setAlignDialog]   = useState<boolean | null>(null)
  const [alignBusy,     setAlignBusy]     = useState(false)
  const [alignError,    setAlignError]    = useState<string | null>(null)

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
      setPiVersions([])
      setPiActivity([])
      setHandoffReady(true)
      return
    }

    const [subRes, itemsRes, imagesRes, versionsRes, trailRes, codesRes] = await Promise.all([
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
      supabase
        .from('order_pi_versions')
        .select(ORDER_PI_VERSION_COLUMNS)
        .eq('order_id', order.id)
        .order('version_number', { ascending: false }),
      supabase
        .from('order_submission_activity')
        .select(PI_ACTIVITY_COLUMNS)
        .eq('submission_id', submissionId)
        .order('created_at', { ascending: false }),
      supabase
        .from('order_product_codes')
        .select('submission_item_id, boe_sequence, source_product_code, source_item_sequence')
        .eq('order_id', order.id),
    ])

    // THE HISTORY, whatever the handoff's own outcome: a viewer who may open
    // the Order may see which PI versions it has carried and what happened to
    // them, and an empty read is simply an empty list.
    const versionRows = (versionsRes.data ?? []) as unknown as PersistedPiVersion[]
    const trailRows = (trailRes.data ?? []) as unknown as PersistedActivity[]
    setPiVersions(versionRows)
    setPiActivity(trailRows)

    // ── THE PRODUCTS NO LONGER WAIT FOR A NAME THEY DO NOT USE ──
    //
    // Two reads depend on the group above, and NEITHER depends on the other:
    //
    //   the names   who uploaded and who decided each PI version, and who
    //               wrote each event on the source PI's trail. Both belong to
    //               sections BELOW the fold — PI History inside Order Records,
    //               and Activity at the foot of the page.
    //   the URLs    the signed links for the product photographs, which are in
    //               the table directly under the Order Summary.
    //
    // They used to run one after the other, names first, so the most prominent
    // section on the screen waited a whole round trip for an enrichment it
    // never reads. Issued together, the product table arrives one network trip
    // sooner on every Order that came from a PI.
    //
    // NOTHING ELSE MOVED. Both reads are the same reads, under the same RLS,
    // and both are still awaited before this function reports the handoff
    // ready — so no section draws from a half-loaded state.
    const actorIds = [...new Set([
      ...versionActorIds(versionRows),
      ...activityActorIds(trailRows),
    ])]
    const images = (imagesRes.data ?? []) as unknown as PersistedItemImage[]
    const paths = [...new Set(images.map(i => i.storage_path).filter(Boolean))]

    // THE BUCKET STAYS PRIVATE. Nothing here builds a public URL — there is none
    // to build. Each object is signed on demand through the caller's own
    // session, so the storage policies decide again, per object, whether this
    // person may see this picture. A refusal yields no URL and the table shows
    // its honest "No image" box rather than a broken one.
    const [peopleRes, signedRes] = await Promise.all([
      actorIds.length > 0
        ? supabase.from('users').select('id, full_name').in('id', actorIds)
        : Promise.resolve({ data: [] as { id: string; full_name: string | null }[] }),
      paths.length > 0
        ? supabase.storage.from(ORDER_FILES_BUCKET)
            .createSignedUrls(paths, PI_DRAFT_IMAGE_URL_TTL_SECONDS)
        : Promise.resolve({ data: [] as { path?: string | null; signedUrl?: string; error?: unknown }[] }),
    ])

    const names = new Map<string, string>()
    for (const person of (peopleRes.data ?? []) as { id: string; full_name: string | null }[]) {
      if (person?.id && person.full_name) names.set(person.id, person.full_name)
    }
    setPiNames(names)

    const signedByPath = new Map<string, string>()
    for (const entry of (signedRes.data ?? []) as { path?: string | null; signedUrl?: string; error?: unknown }[]) {
      if (entry?.path && entry.signedUrl && !entry.error) signedByPath.set(entry.path, entry.signedUrl)
    }

    const row = subRes.data as unknown as OrderPiRow | null
    if (subRes.error || !row) {
      setPiHandoff({ kind: 'unavailable' })
      setPiProducts([])
      setWbPath(null)
      setHandoffReady(true)
      return
    }

    const rawProducts = persistedProducts((itemsRes.data ?? []) as unknown as PersistedItem[])
    const codeByItemId = orderProductCodesByItemId(
      order.display_number,
      (codesRes.data ?? []) as unknown as OrderProductCodeRecord[],
    )
    const products = rawProducts.map(p => ({ ...p, orderProductCode: codeByItemId.get(p.id) ?? null }))

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
    setHandoffReady(true)
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

  /**
   * Releases the startup gate. The startup path parks a resolver in
   * `shellSignal` and waits on it; the full load below calls this the moment
   * the Order ROW is in hand, and the page draws while every other read is
   * still settling into it. A refresh finds no resolver parked and this is a
   * no-op.
   */
  const releaseShell = () => {
    shellSignal.current?.()
    shellSignal.current = null
  }

  /**
   * The Order's own row, as one query and one mapping — named once so the full
   * load and the narrow refreshes below cannot read or shape it differently.
   */
  const orderRowQuery = () =>
    supabase
      .from('orders')
      .select(`
        id, display_number, client_name,
        requested_by, assigned_to, created_by,
        confirm_date, due_date, total_value, total_product_value,
        lead_source, status, notes, created_at, updated_at,
        source_order_request_id, source_request_number, is_test_data,
        source_order_submission_id, billing_percentage,
        production_alignment, production_aligned_by, production_aligned_at, production_alignment_note,
        requested_by_user:users!requested_by(full_name),
        assigned_to_user:users!assigned_to(full_name),
        created_by_user:users!created_by(full_name),
        production_aligned_by_user:users!production_aligned_by(full_name)
      `)
      .eq('id', id)
      .single()

  /** The embeds flattened onto the row, said once for both callers. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapOrderRow = (raw: any): Order => ({
    ...raw,
    requested_by_name: raw.requested_by_user?.full_name ?? undefined,
    assigned_to_name:  raw.assigned_to_user?.full_name  ?? undefined,
    created_by_name:   raw.created_by_user?.full_name   ?? undefined,
    production_aligned_by_name: raw.production_aligned_by_user?.full_name ?? undefined,
    production_aligned_by_user: undefined,
    requested_by_user: undefined,
    assigned_to_user:  undefined,
    created_by_user:   undefined,
  })

  /**
   * WHAT A WRITE TO THE ORDER ROW ACTUALLY CHANGED, and nothing else.
   *
   * Production alignment moves four columns on `orders` and appends one
   * activity entry. It touches no payment, no allocation, no document, no
   * change request and no PI — so re-running the whole page load to see it
   * re-read fourteen things and re-signed every product photograph, on the
   * control this screen exists to prompt.
   *
   * Two reads instead, and the same two the trail and the row come from
   * everywhere else on this page.
   */
  const reloadOrderRow = async () => {
    const { data: o } = await orderRowQuery()
    if (o) setOrder(mapOrderRow(o))
    await reloadActivity()
  }

  /**
   * The Order's document register, as one query — named once so the full load
   * and the narrow refresh below cannot read or shape it differently.
   */
  const documentsQuery = () =>
    supabase
      .from('order_document_versions')
      .select(ORDER_DOCUMENT_COLUMNS)
      .eq('order_id', id)
      .order('version', { ascending: false })

  /**
   * WHAT ASKING FOR DOCUMENTS ACTUALLY CHANGED.
   *
   * The route writes one row in order_document_versions, and that table's own
   * trigger appends the matching activity entry. It touches no Order column,
   * no payment, no change request and no PI — so re-running the whole page
   * load to see a new version re-read fourteen things and re-signed every
   * product photograph.
   */
  const reloadDocuments = async () => {
    const { data } = await documentsQuery()
    setDocuments((data ?? []) as unknown as OrderDocumentRow[])
    await reloadActivity()
  }

  /** The full load. A refresh calls this and replaces data in place. */
  const loadOrder = async () => {
    const { data: o } = await orderRowQuery()

    if (!o) { setNotFound(true); releaseShell(); return }

    const mapped = mapOrderRow(o)
    setOrder(mapped)
    // THE SHELL CAN DRAW NOW. The identity, the status, the production state,
    // the dates and the owner are all on this one row.
    releaseShell()

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

      documentsQuery(),

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
    setRecordsReady(true)

    await handoff
  }

  /**
   * READ WHAT THIS PERSON HAS NOT SEEN ON THIS ORDER, THEN MARK IT SEEN.
   *
   * TWO STEPS, IN THIS ORDER, AND THE ORDER MATTERS. The read has to happen
   * before the mark, because the mark destroys the very information the
   * Activity trail needs: once the rows are read, nothing remembers where the
   * reader had got to.
   *
   * PER USER, END TO END. The read is scoped to the caller by the notifications
   * RLS policy; the mark is scoped to the caller by /api/notifications/mark-read,
   * which puts `user_id = caller` on every statement it issues. So one
   * recipient opening this Order cannot clear anybody else's badge — theirs is
   * a different row, and this touches only its own.
   *
   * NOTHING BLOCKS ON EITHER. A failed read means no "new since" marks; a
   * failed mark means the badge is still there next time. Both are worse than
   * working and far better than a page that will not open.
   */
  const markUpdatesSeen = async () => {
    // A PREVIEW SEES, IT DOES NOT READ-RECEIPT. Under View As the session is
    // still the administrator's, so marking anything read here would silently
    // clear the ADMINISTRATOR'S own unread updates for an Order they only
    // looked at through somebody else's eyes — and it would not touch the
    // employee's, which is the state they were trying to inspect. Neither is
    // wanted, so a preview does neither.
    if (viewAsUserId) return

    const { data, error } = await supabase
      .from('notifications')
      .select('entity_id, created_at')
      .eq('entity_id', id)
      .eq('is_read', false)
      .in('type', ORDER_UNREAD_TYPES)
    if (error) return

    const rows = (data ?? []) as UnreadUpdateRow[]
    if (rows.length === 0) return

    // The line the trail draws "New since your last visit" above. The OLDEST
    // unread, not the newest: taking the newest would hide every earlier
    // unseen entry behind the divider.
    setNewSince(oldestUnreadAt(rows))

    // ONE REQUEST FOR THE WHOLE ORDER, not one per row — including the rows
    // this browser never loaded. See the `entityId` selector in the route.
    await fetch('/api/notifications/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entityId: id }),
    }).catch(() => {})
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
      // ── THE SHELL FIRST ──
      //
      // loadOrder() still runs in full — the payments, the allocation totals,
      // the documents, the activity, the change requests, the PI handoff and
      // its signed URLs — but the page no longer waits for ALL of it before it
      // draws anything. It resolves `shell` the moment the Order row itself has
      // landed, and that is what this group waits on beside the profile and
      // the two permission resolves. Everything else settles section by
      // section into a page that is already on screen, each section drawing
      // its own skeleton until its read answers.
      //
      // Started here and NOT awaited as a whole: its own paths settle their
      // sections, and a rejection must not become an unhandled promise on a
      // page that is already drawn. `finally` releases the shell even if the
      // Order read itself threw, so the gate can never hang.
      const shell = new Promise<void>(resolve => { shellSignal.current = resolve })

      const [{ data: me }, ordersPerms, financePerms] = await Promise.all([
        supabase
          .from('users')
          .select(USER_PROFILE_COLUMNS)
          .eq('id', session.user.id)
          .single(),
        getEffectivePermissions(supabase, session.user.id, 'orders').catch(() => []),
        getEffectivePermissions(supabase, session.user.id, 'finance').catch(() => []),
        // loadOrder() starts HERE, beside the resolves, and runs to completion
        // on its own. The group settles on whichever comes first: the shell
        // (the Order row is in hand) or the whole load (it ended early — no
        // row, or a thrown read) — so the gate can never hang on a failure.
        Promise.race([shell, loadOrder().catch(() => {})]),
      ])

      setProfile(me as UserProfile)
      setOrdersCaps(deriveOrdersCapabilities(me?.role, ordersPerms))
      setFinanceCaps(deriveFinanceCapabilities(me?.role, financePerms))
      setPageLoading(false)

      // This one genuinely depends on the profile, and is asked only of an
      // admin — for whom it decides a single temporary, testing-phase control.
      // It used to sit BEFORE the loading gate cleared, so every admin paid one
      // more round trip before the Order drew; it now lands into the overflow
      // menu after the page is on screen.
      if ((me as UserProfile | null)?.role === 'admin') {
        const { data: s } = await supabase.rpc('get_test_data_cleanup_settings')
        const settings = s as { enabled?: boolean; permanently_disabled?: boolean } | null
        setCleanupEnabled(!!settings?.enabled && !settings?.permanently_disabled)
      }

      // ── OPENING THE ORDER IS WHAT "SEEN" MEANS ──
      //
      // NO POPUP AND NO CONFIRMATION. Product Orders → click → Order Detail,
      // and nothing stands between them. The reader's unread updates for this
      // Order are read once (so the Activity trail can point at what is new to
      // THEM), and then marked read for THEM ALONE — every other recipient's
      // rows are different rows and are untouched.
      //
      // Last in the sequence and never awaited by anything: the page is
      // already on screen, and a failed read or a failed mark leaves the
      // trail unmarked rather than the Order unopened.
      void markUpdatesSeen()
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

  // ── PI versions (20261119000000) ──

  /** Any version's file, signed on demand exactly as the current workbook is. */
  const openVersion = async (version: PiVersionView) => {
    if (!version.workbookPath || versionOpening) return
    setVersionOpening(version.id)
    setRevisionError(null)
    const { data, error } = await supabase
      .storage
      .from(ORDER_FILES_BUCKET)
      .createSignedUrl(version.workbookPath, ORDER_PI_WORKBOOK_URL_TTL_SECONDS, { download: true })
    setVersionOpening(null)
    if (error || !data?.signedUrl) { setRevisionError(WORKBOOK_UNAVAILABLE); return }
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
  }

  /**
   * Propose a revised PI: the file to private storage under the PI's own
   * original/ folder (the revision insert policy decides), then ONE RPC that
   * records the pending version. Nothing on the Order or the current PI moves.
   */
  const proposeRevision = async (file: File, reason: string) => {
    if (!order?.source_order_submission_id || revisionBusy) return
    setRevisionBusy(true)
    setRevisionError(null)
    try {
      const path = revisionWorkbookPath(order.source_order_submission_id, crypto.randomUUID())
      const { error: uploadError } = await supabase.storage
        .from(ORDER_FILES_BUCKET)
        .upload(path, file, { contentType: WORKBOOK_UPLOAD_MIME })
      if (uploadError) { setRevisionError(describePiRevisionFailure(uploadError, 'propose')); return }

      const { error } = await supabase.rpc('propose_order_pi_revision', {
        p_order_id: order.id,
        p_workbook_path: path,
        p_workbook_name: file.name,
        p_reason: reason,
      })
      if (error) { setRevisionError(describePiRevisionFailure(error, 'propose')); return }
      setRevisionDialog(null)
      void notifyPiSubmission({ event: 'pi_revision_proposed', submissionId: order.source_order_submission_id })
      await loadOrder()
    } finally {
      setRevisionBusy(false)
    }
  }

  /**
   * Approve a revision. THE ROUTE PARSES THE FILE: the browser hands up one id
   * and the server reads the bytes it holds, applies them and decides the
   * version rows in one transaction.
   */
  const approveRevision = async (version: PiVersionView) => {
    if (!order?.source_order_submission_id || revisionBusy) return
    setRevisionBusy(true)
    setRevisionError(null)
    try {
      const res = await fetch('/api/orders/pi-revisions/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionId: version.id }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string; message?: string } | null
        setRevisionError(describePiRevisionFailure(body?.error ?? body?.message ?? '', 'approve'))
        return
      }
      setRevisionDialog(null)
      void notifyPiSubmission({ event: 'pi_revision_approved', submissionId: order.source_order_submission_id })
      await loadOrder()
    } finally {
      setRevisionBusy(false)
    }
  }

  const rejectRevision = async (version: PiVersionView, reason: string) => {
    if (!order?.source_order_submission_id || revisionBusy) return
    setRevisionBusy(true)
    setRevisionError(null)
    try {
      const { error } = await supabase.rpc('reject_order_pi_revision', {
        p_version_id: version.id,
        p_reason: reason,
      })
      if (error) { setRevisionError(describePiRevisionFailure(error, 'reject')); return }
      setRevisionDialog(null)
      void notifyPiSubmission({ event: 'pi_revision_rejected', submissionId: order.source_order_submission_id })
      await loadOrder()
    } finally {
      setRevisionBusy(false)
    }
  }

  // ── Production alignment (20261119000000) ──
  const setAlignment = async (aligned: boolean, note: string | null) => {
    if (!order || alignBusy) return
    setAlignBusy(true)
    setAlignError(null)
    try {
      const { error } = await supabase.rpc('set_order_production_alignment', {
        p_order_id: order.id,
        p_aligned: aligned,
        p_note: note,
      })
      if (error) { setAlignError(describeAlignmentFailure(error)); return }
      setAlignDialog(null)
      // Production moved. The people on this Order plan against it, so they
      // hear about it — from the production_alignment_changed row the RPC just
      // wrote, never from anything this browser composes.
      void notifyOrderUpdate({ orderId: order.id, event: 'production' })
      // The RPC moved four columns on `orders` and appended one activity
      // entry. Nothing else on this page changed, so nothing else is re-read.
      await reloadOrderRow()
    } finally {
      setAlignBusy(false)
    }
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
    // success certainly did. The register and the trail, and nothing else.
    await reloadDocuments()
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

  /**
   * THE PI HISTORY AND WHO MAY MOVE IT (20261119000000).
   *
   * Proposing: the PI's owner or an admin holding orders.create — the same
   * people who could upload the PI in the first place. Deciding: an active
   * admin, matching the deployed rule for moving a submitted PI's figures. Both
   * are re-derived by the database; both are suppressed under View As.
   */
  const piHistory = useMemo(
    () => describePiVersionHistory(piVersions, piNames, iso => (iso ? fmtDateTime(iso) : '—')),
    [piVersions, piNames],
  )
  // THE PI'S OWNER, as this page can know it: approve_order_submission() writes
  // the PI's submitter into orders.requested_by. The RPC re-derives the full
  // rule (creator OR submitter OR admin) under a row lock; this only decides
  // whether the control is drawn.
  const mayProposeRevision = !!order && canProposePiRevision(
    { viewerId: viewAsUserId ? null : (profile?.id ?? null), isAdmin: actingAsAdmin, canCreate: ordersCaps.canCreateOrder && !viewAsUserId },
    {
      orderStatus: order.status,
      createdBy: null,
      submittedBy: order.requested_by,
      hasCurrentVersion: piHistory.current !== null,
      hasPendingRevision: piHistory.pending !== null,
    },
  )
  const mayDecideRevision = canDecidePiRevision({ isAdmin: actingAsAdmin })

  /** Production alignment, and whether this reader may move it. */
  const mayAlignProduction = canAlignProduction(ordersCaps, Boolean(viewAsUserId))
  const production = order ? describeProductionAlignment({
    alignment: order.production_alignment,
    alignedByName: order.production_aligned_by_name ?? null,
    alignedAt: order.production_aligned_at ? fmtDateTime(order.production_aligned_at) : null,
    note: order.production_alignment_note ?? null,
    orderStatus: order.status,
    canAlign: mayAlignProduction,
  }) : null

  /**
   * THE WHOLE CHRONOLOGY: the Order's own trail and the source PI's, merged.
   * The page keeps its own words for the Order events it already labelled;
   * everything else is named by the two shared modules.
   */
  // MERGED AND SORTED ONCE PER LOAD, not once per render. Opening the image
  // viewer, expanding the trail or opening a menu re-renders this component;
  // without these the whole chronology was rebuilt and re-sorted for a state
  // change that touched none of it. Each depends only on data a loader
  // replaces wholesale, so the memo can never hold a half-updated answer.
  const history = useMemo(
    () => mergeOrderHistory({
      orderRows: activity,
      orderLabel: eventType => EVENT_TYPE_LABEL[eventType] ?? null,
      orderDetail: row => activityDescription(row) || null,
      piRows: piActivity,
      namesById: piNames,
      formatWhen: iso => (iso ? fmtDateTime(iso) : '—'),
    }),
    [activity, piActivity, piNames],
  )
  const orderEntryById = useMemo(
    () => new Map(activity.map(entry => [entry.id, entry])),
    [activity],
  )

  /** ONE ANSWER about the documents, so the card, the buttons and the tests
   *  cannot disagree about whether there is anything to download. */
  const documentsView = useMemo(() => buildOrderDocumentsView(documents), [documents])

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

  /**
   * A dialog wrote something. Close everything, re-read, and — when the write
   * was one the people on this Order should hear about — announce it.
   *
   * THE EVENT IS THE CALLER'S, because only the caller knows which dialog it
   * was. `null` means nothing is announced: RequestOrderChangeModal RAISES a
   * request rather than changing the Order, so there is no change yet to tell
   * anybody about, and the decision on it comes back through this same handler
   * as an amendment or a cancellation.
   *
   * FIRE AND FORGET, AFTER THE FACT. The write has already committed; the route
   * finds the audit row it wrote and words the notification from that. If the
   * write was refused there is no audit row, so nothing is sent.
   */
  const afterChange = (event: OrderUpdateEvent | null = null) => {
    setAmendOpen(false); setRequestOpen(false); setCancelOpen(false); setReviewing(null)
    if (event && order) void notifyOrderUpdate({ orderId: order.id, event })
    loadOrder()
  }

  // ── THE SHELL, before the Order row has landed ──
  //
  // Not the 100vh spinner: the Orders sidebar and header are already up, and a
  // full-screen spinner inside them reads as "leaving the page". This is the
  // workspace in the shape of what is about to appear, so nothing jumps.
  if (pageLoading) {
    return (
      <OrdersLayout profile={profile} title="Confirmed Order" onSignOut={handleSignOut} showRefresh={false}>
        <OrderDetailSkeleton />
      </OrdersLayout>
    )
  }

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
  //
  // DELIBERATELY NOT MEMOISED. It sits after the early returns, where a hook
  // may not go, and hoisting it to memoise a few decimal additions would move
  // the one expression two Finance tests pin as proof that this screen adds no
  // money of its own. The guarantee is worth more than the microseconds.
  const finance = buildOrderFinancePosition(payments, order.total_value)

  const isOverdue = order.due_date &&
    !['dispatched', 'cancelled'].includes(order.status) &&
    new Date(order.due_date) < new Date()

  // The stored, permanent display_number keeps its four-digit, zero-padded
  // shape; what BOE shows and refers to drops the leading zeros (20261124000000).
  const operationalNumber = formatOrderOperationalNumber(order.display_number) ?? order.display_number

  // ── What this screen says, decided once ──
  //
  // Three readings of the same state, each by orderWorkspace.ts: the six facts
  // the Order Summary states, what needs attention, and which control is
  // primary. Nothing here is a new rule, and nothing here grants: the controls
  // it arranges are exactly the ones the capabilities above allow.
  const productionAligned = production?.value === 'aligned'
  const statusTone: WorkspaceTone = STATUS_TONE[order.status] ?? 'neutral'
  const salespersonName = order.assigned_to_name ?? null
  const leadSource = leadSourceLabel(order.lead_source)

  const summaryFacts = orderSummaryFacts({
    status: order.status,
    customerName: order.client_name,
    productionAligned,
    productionLabel: production?.label ?? '—',
    productionLine: production?.line ?? null,
    salespersonName,
    leadSource,
    raisedByName: order.requested_by_name ?? null,
    sourceRequestNumber: order.source_request_number,
  })

  // EVERY DATE, RANKED, ONCE. The two the business plans against and the two
  // the database recorded — the pair Record Information used to state on its
  // own, three sections lower.
  const importantDates = orderImportantDates({
    status: order.status,
    confirmDate: order.confirm_date ? fmtDate(order.confirm_date) : null,
    dueDate: order.due_date ? fmtDate(order.due_date) : null,
    isOverdue: !!isOverdue,
    createdAt: fmtDate(order.created_at),
    updatedAt: fmtDate(order.updated_at),
  })

  const attention = orderAttentionItems({
    status: order.status,
    productionAligned,
    hasSalesperson: !!order.assigned_to,
    hasDueDate: !!order.due_date,
    hasLeadSource: !!leadSource,
    isOverdue: !!isOverdue,
    // Money and documents are only known once their reads have landed; until
    // then they are not "fine", they are unknown, and the bar says nothing.
    awaitingVerificationCount: recordsReady ? finance.counts.awaiting : 0,
    pendingChangeRequests: pendingRequests.length,
    pendingPiRevision: piHistory.pending !== null,
    documentsFailed: recordsReady && !!documentsView.failure,
    documentsOutdated: recordsReady && documentsView.outdated,
  })

  // WHICH CONTROLS EXIST is decided above from the resolved capabilities; this
  // only decides where each one sits. The cleanup gate is the existing one,
  // unchanged: an active admin, not under View As, on a testing-phase Order
  // while cleanup is still enabled.
  const actions = arrangeOrderActions({
    alignAction: production?.action ? (productionAligned ? 'unalign' : 'align') : null,
    canAmend,
    canRequest,
    canReviewChangeRequests: actingAsAdmin && pendingRequests.length > 0,
    canCleanUp: profile?.role === 'admin' && !viewAsUserId && canCleanUp,
  })

  const actionLabel = (key: OrderHeaderActionKey): string => {
    switch (key) {
      case 'align':
      case 'unalign':             return production?.action ?? ''
      case 'amend':               return 'Amend Order'
      case 'request_change':      return myPendingEdit ? 'Change Requested' : 'Request a Change'
      case 'request_cancel':      return myPendingCancel ? 'Cancellation Requested' : 'Request Cancellation'
      case 'review_change_request':
        return pendingRequests.length === 1 ? 'Review change request' : `Review ${pendingRequests.length} change requests`
      case 'cleanup':             return 'Clean Up Test Transaction'
    }
  }

  const actionDisabled = (key: OrderHeaderActionKey): boolean =>
    (key === 'request_change' && myPendingEdit) || (key === 'request_cancel' && myPendingCancel)

  const actionTitle = (key: OrderHeaderActionKey): string | undefined => {
    if (key === 'request_change' && myPendingEdit) return 'You already have a change request awaiting review'
    if (key === 'request_cancel' && myPendingCancel) return 'You already have a cancellation request awaiting review'
    if (key === 'cleanup') return 'This Order was created during system testing'
    return undefined
  }

  const runAction = (key: OrderHeaderActionKey) => {
    switch (key) {
      // Production alignment: the Head of Manufacturing's door (20261119000000).
      // Drawn only for orders.align_production, never lent by View As; the RPC
      // decides again under a row lock.
      case 'align':               setAlignDialog(true); return
      case 'unalign':             setAlignDialog(false); return
      // The amendment door. An admin gets Amend Order; everyone else who can
      // see the Order gets Request a Change, disabled once they already have
      // one open — the partial unique index would refuse a second, and saying
      // so before the click beats a constraint violation after it.
      case 'amend':               setAmendOpen(true); return
      case 'request_change':      setRequestOpen(true); return
      case 'request_cancel':      setCancelOpen(true); return
      case 'review_change_request':
        if (pendingRequests.length === 1) setReviewing(pendingRequests[0])
        else changeRequestsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        return
      // A Confirmed Order has no destructive action. It is permanent business
      // history, enforced by the database (20260705000000): public.orders
      // carries no DELETE policy and orders_prevent_delete refuses every path,
      // including the service role. While the system is in its testing phase,
      // an Order created during testing offers a route to the separate cleanup
      // flow instead — a page that then requires a reason, a typed
      // confirmation, and a chain where every record is verified test data.
      case 'cleanup':
        router.push(`/admin/control-center/test-data-cleanup?type=order&id=${order.id}`)
        return
    }
  }

  const overflowItems: MoreActionItem<OrderHeaderActionKey>[] = actions.overflow.map(key => ({
    key,
    label: actionLabel(key),
    disabled: actionDisabled(key),
    title: actionTitle(key),
  }))

  // ── The approved PI's two cards ──
  //
  // Declared here, in this order, and RENDERED with the products first: what
  // BOE is manufacturing is the main content of this screen, and the PI band
  // that names the client, the dates and the pre-tax total follows it. The
  // door back to the PI belongs to the summary card and to nothing else.
  const piProductsCard = piHandoff.kind === 'ready' && (
    <OrderPiProducts
      products={piProducts}
      isMobile={isMobile}
      representativeThumbnail={representativeThumbnail}
      customizationThumbnails={customizationThumbnails}
      unresolvedImages={piImages.unresolved}
    />
  )

  return (
    <OrdersLayout
      profile={profile}
      title="Confirmed Order"
      onSignOut={handleSignOut}
      onRefresh={loadOrder}
    >
      <div className="order-detail-page">

        <button type="button" onClick={() => router.back()} className="order-back">
          <ArrowLeft size={13} strokeWidth={2} aria-hidden="true" /> Back
        </button>

        {/* ══ 1. THE COMMAND HEADER ══
            ORDER NUMBER AND STATUS, ON ONE LINE, FIRST — "ORDER BOE-147  IN
            PRODUCTION". Those two answer "which Order is this and where is
            it", which is what every reader arrives asking, and the status used
            to be the first of six equal facts in the band below. It is stated
            HERE now and nowhere else.

            Everything else is still exactly once, elsewhere: the customer, the
            salesperson, the lead source and production in the identity band
            below; every date in Important Dates under it. */}
        <header className="order-command-header">
          <div className="order-command-identity">
            <h1 className="order-command-title">Order {operationalNumber}</h1>
            <OrderStatusPill label={STATUS_META[order.status]?.label ?? order.status} tone={statusTone} />
          </div>

          <div className="order-command-actions">
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
                  // THE ONE EVENT EVERYBODY ON THIS ORDER WANTS. The route
                  // reads the status_changed row StatusControl just wrote and
                  // words "from X to Y by Z" from it — this browser supplies
                  // nothing but the word "status".
                  void notifyOrderUpdate({ orderId: order.id, event: 'status' })
                  // A transition writes the row above and one activity entry.
                  // Nothing else on this page moved, so nothing else is re-read.
                  reloadActivity()
                }}
                // The Order was not where this screen thought it was. Re-read
                // everything rather than guess which part is stale.
                onOutOfDate={() => { loadOrder() }}
              />
            )}
            {actions.secondary.map(key => (
              <button
                key={key}
                type="button"
                onClick={() => runAction(key)}
                disabled={actionDisabled(key)}
                title={actionTitle(key)}
                className="boe-record-action"
              >
                {actionLabel(key)}
              </button>
            ))}
            {actions.primary && (
              <button
                type="button"
                onClick={() => runAction(actions.primary as OrderHeaderActionKey)}
                className="boe-record-action boe-record-action--primary"
              >
                {actionLabel(actions.primary)}
              </button>
            )}
            <MoreActionsMenu items={overflowItems} onSelect={runAction} />
          </div>
        </header>

        {/* ══ 2. THE IDENTITY BAND ══
            Customer, salesperson, lead source, production — and, when the
            Order has them, who raised it and the request it came from. The
            last two came off Record Information rather than being deleted with
            it: both name something a person cares about, neither is database
            metadata. */}
        <OrderSummary facts={summaryFacts} />

        {/* ══ 3. IMPORTANT DATES ══
            EVERY DATE THIS ORDER HAS, IN ONE PLACE. Confirm and due lead;
            created and last-updated follow, muted. The audit pair used to sit
            alone in Record Information three sections lower, so answering
            "when" meant looking in two places. */}
        <OrderImportantDatesSection dates={importantDates} />

        {/* ══ 4. THE ATTENTION STRIP ══ hidden entirely when nothing needs it. */}
        <OrderAttentionBar items={attention} />

        {/* ── Notes ──
            OPERATIONAL CONTENT, and the one thing on Record Information that
            was never metadata: somebody typed it about this Order for somebody
            else to read. It keeps its own quiet block rather than following
            that section out. */}
        {order.notes && (
          <section className="order-notes" aria-label="Order notes">
            <div className="order-notes-head">Notes</div>
            <div className="order-notes-body">{order.notes}</div>
          </section>
        )}

        {/* ══ 4. PRODUCTS ══
            FULL CONTENT WIDTH and the most prominent operational section: nine
            columns need the whole width to show every permitted column without
            a horizontal scroll at ordinary desktop widths. */}
        {(piProductsCard || (!handoffReady && order.source_order_submission_id)) && (
          <div className="order-products">
            {!handoffReady && order.source_order_submission_id && (
              <SectionSkeleton rows={4} label="Loading products" />
            )}
            {piProductsCard}
          </div>
        )}

        {/* ══ THE LOWER WORKSPACE ══
            Everything that follows the product list: the record on the left,
            the money on the extreme right. The commercial column is the ONLY
            place on the page any of these figures appear. */}
        <div className="order-lower">
        <div className="order-lower-main">

        {/* ══ 5. PAYMENT ══
            THE ONLY PAYMENT SURFACE ON THE PAGE. The six figures and the
            per-payment records in one section, so nothing has to be clicked to
            reach a second copy of the same money. Every figure is
            buildOrderFinancePosition's and every word in the table is what it
            always was. */}
        <PiCard>
          <PiCardHeader
            title={PAYMENT_SECTION_TITLE}
            style={SECTION_HEADER_STYLE}
            right={recordsReady ? (
              <span style={{ fontSize: '12px', color: colors.muted, whiteSpace: 'nowrap' }}>
                {payments.length === 0
                  ? 'No payments recorded'
                  : `${payments.length} payment${payments.length === 1 ? '' : 's'}`}
              </span>
            ) : undefined}
          />
          <div style={{ padding: '12px 16px 14px' }}>
            <PaymentSummaryFigures finance={finance} loaded={recordsReady} />

            {/* ── The records ──
                THE COLUMN THAT DID NOT RECONCILE. "Amount" printed each
                payment's FULL ledger amount, while the summary counted only
                this Order's ALLOCATED share of it. The leading figure is this
                Order's share — the figure the summary is built from — and a
                split payment states its full amount underneath, so nothing is
                hidden and the two agree.

                STATUS WORDING MATCHES THE PI — see PAYMENT_STATUS_COLOR above
                for the three labels that disagreed and why each was wrong. */}
            {recordsReady && (
              <div className="order-pay-records">
                <div className="order-pay-records-head">Payment records</div>
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
                                    type="button"
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
              </div>
            )}
          </div>
        </PiCard>

        {/* ══ 6. ORDER RECORDS ══
            The documents, the source PI this Order was created from, and the
            PI's version history. The source PI is a REFERENCE and an action,
            not a summary: the client, the dates and the pre-tax total it used
            to restate are the Order's own facts and are stated above. */}
        {piHandoff.kind !== 'none' && (
          <PiCard>
            <PiCardHeader title="Order records" style={SECTION_HEADER_STYLE} />
            <div className="order-records-body">
              <OrderDocumentsCard
                embedded
                view={documentsView}
                canGenerate={mayGenerateDocuments}
                onGenerate={requestDocuments}
                generating={docBusy}
                onDownload={downloadDocument}
                downloading={docDownload}
                error={docError}
              />
              <div className="order-record-section">
                <div className="order-record-head">
                  <h3 className="order-record-title">Source PI</h3>
                </div>
                {piHandoff.kind === 'ready' ? (
                  <div className="order-source-pi">
                    <div style={{ minWidth: 0 }}>
                      <div className="order-doc-name">
                        {piHandoff.workbookName ?? 'The approved PI'}
                      </div>
                      <div className="order-doc-meta">The PI this Order was created from</div>
                    </div>
                    <div style={{ display: 'flex', gap: '6px', flexShrink: 0, flexWrap: 'wrap' }}>
                      {wbPath && (
                        <button
                          type="button"
                          onClick={downloadWorkbook}
                          disabled={wbBusy}
                          className="boe-btn boe-btn-ghost"
                          style={{ padding: '5px 11px', fontSize: '12px', fontWeight: 600 }}
                        >
                          {wbBusy ? 'Preparing…' : 'Download'}
                        </button>
                      )}
                      {/* NO "OPEN SOURCE PI" BUTTON.
                          Once the PI has converted, THIS page is the source of
                          truth: the products, the money, the documents and the
                          version history are all here, and a prominent door
                          back to the superseded draft invited operational
                          readers to work from it.

                          NOTHING UNDERNEATH IS TOUCHED. The relation
                          (orders.source_order_submission_id) is unchanged and
                          still frozen, the PI's own row and files are
                          untouched, the merged chronology below still
                          interleaves the PI's activity trail, PI History still
                          opens every version, and the RLS door
                          can_view_order_submission_via_order (20260924000000)
                          still stands — an administrator who needs the draft
                          reaches it from the PI Drafts module as before. */}
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: '12.5px', color: colors.secondary, lineHeight: 1.55 }}>
                    {ORDER_PI_UNAVAILABLE_BODY}
                  </div>
                )}
                {wbError && (
                  <div style={{ fontSize: '11.5px', color: colors.red, lineHeight: 1.45, marginTop: '6px' }}>
                    {wbError}
                  </div>
                )}
              </div>
              {/* THE PI HISTORY (20261119000000): the current PI, a pending
                  revision and everything before. */}
              <OrderPiHistoryCard
                embedded
                history={piHistory}
                canPropose={mayProposeRevision}
                canDecide={mayDecideRevision && piHistory.pending !== null}
                onPropose={() => { setRevisionError(null); setRevisionDialog({ kind: 'propose' }) }}
                onApprove={version => { setRevisionError(null); setRevisionDialog({ kind: 'approve', version }) }}
                onReject={version => { setRevisionError(null); setRevisionDialog({ kind: 'reject', version }) }}
                onOpen={openVersion}
                opening={versionOpening}
                busy={revisionBusy}
                error={revisionDialog === null ? revisionError : null}
              />
            </div>
          </PiCard>
        )}

        {/* EVERY ORDER SAYS SOMETHING ABOUT ITS PI. "This Order has no PI" and
            "the feature is not deployed" are indistinguishable from the
            outside, so the absence is stated rather than left silent. */}
        {piHandoff.kind === 'none' && <OrderPiNoSource />}

        {/* ── Change requests ──
            Rendered only when there is something to show. An admin sees every
            request; everyone else sees their own — that split is RLS's. */}
        {changeRequests.length > 0 && (
          <div ref={changeRequestsRef}>
            <PiCard>
              <PiCardHeader title={`Change requests (${pendingRequests.length} pending)`} style={SECTION_HEADER_STYLE} />
              <div style={{ padding: '10px 16px 12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
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
                        type="button"
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
            </PiCard>
          </div>
        )}

        {/* ══ RECORD INFORMATION IS GONE ══
            It held five things. Three were worth keeping and each moved to
            where it belongs rather than being deleted with the section:

              Requested By      → the identity band, as "Raised by"
              Created           → Important Dates, secondary
              Last Updated      → Important Dates, secondary
              Source Request    → the identity band, as "From request"
              Notes             → its own block under the attention strip

            The internal request UUID that used to ride along as a title
            attribute is NOT reproduced. Nothing an operational reader can do
            with it, and a database key is not a fact about the Order. */}

        {/* ══ 8. ACTIVITY ══ the complete trail, last: the current state is
            understood before the history that produced it. */}
        {!recordsReady ? (
          <SectionSkeleton rows={3} label="Loading activity" />
        ) : (
          /* ONE CHRONOLOGY, TWO TRAILS. The Order's own events and the source
             PI's, interleaved newest first. Every entry is worded HERE,
             exactly as before; the list only decides how many are on screen —
             the latest five until it is expanded. */
          <OrderActivityList items={history.map((entry): OrderActivityItem => {
            const orderEntry = entry.source === 'order'
              ? orderEntryById.get(entry.key.slice('order:'.length)) ?? null
              : null
            return {
              key: entry.key,
              label: entry.label,
              detail: entry.detail,
              lines: orderEntry ? amendmentLines(orderEntry) : [],
              actor: entry.actor,
              when: entry.createdAtIso ? fmtDateTime(entry.createdAtIso) : '—',
              dot: orderEntry ? <ActivityDot event_type={orderEntry.event_type} /> : <HistoryDot tone={entry.tone} />,
              fromPi: entry.source === 'pi',
              // NEW SINCE THIS READER'S LAST VISIT. `newSince` is the timestamp
              // of their oldest unread update, captured on open before those
              // rows were marked read, so everything at or after it is what
              // they have not seen. Null — the ordinary case — marks nothing.
              isNew: !!newSince && !!entry.createdAtIso && entry.createdAtIso >= newSince,
            }
          })} />
        )}

        </div>

        {/* ══ 9. COMMERCIAL ══
            THE EXTREME RIGHT, BELOW PRODUCTS, and the only place any of these
            figures appear. The two stored totals, then the breakdown: the
            stored figures through the shared rows builder. Nothing on this
            page recomputes a total — these are literally the same strings the
            approved PI screen prints, and which of them a reader may see is
            still decided where that decision already lives. */}
        <aside className="order-lower-aside" aria-label={ORDER_SUMMARY_COMMERCIAL_TITLE}>
          <div className="order-lower-aside-inner">
            <div className="order-commercial">
              <div className="order-summary-commercial-head">{ORDER_SUMMARY_COMMERCIAL_TITLE}</div>
              <OrderCommercialTotals
                productValue={fmtAmount(order.total_product_value)}
                orderValue={fmtAmount(order.total_value)}
              />
              {piHandoff.kind === 'ready' && (
                <OrderCommercialBreakdown rows={piHandoff.commercialRows} embedded />
              )}
              {!handoffReady && order.source_order_submission_id && (
                <div style={{ marginTop: '10px' }}><SkeletonBlock w="100%" h={92} /></div>
              )}
            </div>
          </div>
        </aside>

        </div>

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
          onDone={() => afterChange('amended')}
        />
      )}
      {requestOpen && amendableOrder && (
        <RequestOrderChangeModal
          order={amendableOrder}
          supabase={supabase}
          onClose={() => setRequestOpen(false)}
          /* Nothing to announce: this RAISES a change request, and the Order
             itself has not moved. The decision on it does announce. */
          onDone={() => afterChange(null)}
        />
      )}
      {cancelOpen && amendableOrder && (
        <CancelOrderModal
          order={amendableOrder}
          supabase={supabase}
          isAdmin={actingAsAdmin || mayManageOrders}
          onClose={() => setCancelOpen(false)}
          /* A cancellation IS a status change — cancel_order_with_audit writes
             status_changed, with the reason in its payload. */
          onDone={() => afterChange('status')}
        />
      )}
      {/* The client dialog the PI card's name opens: the contact number and both
          parties, spelled out. The same component the PI screen uses. */}
      {clientOpen && piHandoff.kind === 'ready' && (
        <PiClientDetailsModal client={piHandoff.client} onClose={() => setClientOpen(false)} />
      )}

      {/* ── PI revision and production alignment dialogs (20261119000000) ── */}
      {revisionDialog?.kind === 'propose' && (
        <ProposeRevisionModal
          orderNumber={order.display_number}
          nextVersion={(piVersions[0]?.version_number ?? 0) + 1}
          saving={revisionBusy}
          failure={revisionError}
          onClose={() => { if (!revisionBusy) setRevisionDialog(null) }}
          onConfirm={proposeRevision}
        />
      )}
      {revisionDialog?.kind === 'approve' && (
        <ApproveRevisionModal
          orderNumber={order.display_number}
          versionNumber={revisionDialog.version.versionNumber}
          saving={revisionBusy}
          failure={revisionError}
          onClose={() => { if (!revisionBusy) setRevisionDialog(null) }}
          onConfirm={() => approveRevision(revisionDialog.version)}
        />
      )}
      {revisionDialog?.kind === 'reject' && (
        <RejectRevisionModal
          orderNumber={order.display_number}
          versionNumber={revisionDialog.version.versionNumber}
          saving={revisionBusy}
          failure={revisionError}
          onClose={() => { if (!revisionBusy) setRevisionDialog(null) }}
          onConfirm={reason => rejectRevision(revisionDialog.version, reason)}
        />
      )}
      {alignDialog !== null && (
        <ProductionAlignmentModal
          orderNumber={order.display_number}
          aligning={alignDialog}
          saving={alignBusy}
          failure={alignError}
          onClose={() => { if (!alignBusy) setAlignDialog(null) }}
          onConfirm={note => setAlignment(alignDialog, note)}
        />
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
          /* An approved change request is applied as an amendment, and that is
             the audit row this finds. A rejection writes none, so the route
             finds nothing and sends nothing — which is right: the Order did
             not move. */
          onDone={() => afterChange('amended')}
        />
      )}

    </OrdersLayout>
  )
}
