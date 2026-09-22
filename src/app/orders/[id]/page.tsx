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
  OrderActivityList,
  OrderAttentionBar,
  OrderDetailSkeleton,
  OrderPaymentListDialog,
  OrderStatusPill,
  OrderSummaryPanel,
  ADD_PAYMENT_ACTION_LABEL,
  PAYMENT_SECTION_TITLE,
  PaymentSummaryFigures,
  SECTION_HEADER_STYLE,
  SectionSkeleton,
  SkeletonBlock,
  type MoreActionItem,
  type OrderActivityItem,
} from './OrderWorkspace'
import {
  orderPaymentList,
  paymentDetailFields,
  type OrderPaymentDetailFields,
  type OrderPaymentListKind,
} from '@/lib/orders/orderPaymentLists'
import {
  arrangeOrderActions,
  orderAttentionItems,
  orderRecordFacts,
  orderSummaryView,
  orderSummaryFields,
  type OrderHeaderActionKey,
  type WorkspaceTone,
} from '@/lib/orders/orderWorkspace'
import {
  ORDER_COMMERCIAL_TITLE,
  orderCommercialLines,
  orderStoredCommercialLines,
} from '@/lib/orders/orderCommercial'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import { RecordBackLink } from '@/components/layout/RecordBackLink'
import {
  mergeOrderPayments,
  type OrderAllocationRow,
} from '@/lib/orders/orderPayments'
import {
  buildOrderFinancePosition,
  withExactAmounts,
  type OrderFinancePaymentRow,
} from '@/lib/finance/orderFinancePosition'
import { formatMoney } from '@/lib/finance/piPaymentView'
import {
  deriveFinanceCapabilities,
  NO_FINANCE_CAPABILITIES,
  type FinanceCapabilities,
} from '@/lib/permissions/finance'
// piSubmissionHref is deliberately NOT imported: after conversion this page is
// the source of truth and offers no route back to the superseded draft. The PI
// relation, its files and its version history are all still here.
import { canRecordPaymentAgainstOrder } from '@/lib/finance/crossModuleLinks'
import { useViewAs } from '@/hooks/useViewAs'
import type { UserProfile } from '@/lib/types'
import { ChevronDown } from 'lucide-react'
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
import {
  OrderCommercialBreakdown,
  OrderPiNoSource,
  OrderPiProducts,
  OrderPiUnavailable,
} from './OrderPiSections'
import {
  OrderDesignFilesDialog,
  OrderDocumentsPanel,
  OrderDocumentsRow,
  OrderEvidenceDialog,
  OrderFabricFinishCard,
  PiHistoryModal,
} from './OrderStatusWorkspace'
import { OrderApprovalModal, type ApprovalSubmission } from './OrderApprovalModal'
import { mainPiCard, piVersionTimeline } from '@/lib/orders/orderMainPi'
import { countDesignImages, type DesignImageSummary } from '@/lib/orders/orderCurrentStatus'
import { clientPoDocument, designFilesDocument } from '@/lib/orders/orderDocumentsPanel'
import {
  APPROVAL_EVIDENCE_BUCKET,
  FABRIC_FINISH_VIEW_AS_NOTE,
  ORDER_APPROVAL_EVENT_SELECT,
  approvalStanding,
  canRecordApproval,
  describeApprovalFailure,
  evidenceObjectPath,
  type PersistedApprovalEvent,
} from '@/lib/orders/orderApprovals'
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
// THE CLIENT'S OWN NUMBER, resolved by the builder the PI card uses — bill-to
// then ship-to, and never order_submissions.contact_number, which is the
// SALESPERSON's number and would have a reader press "call the client" and
// reach BOE. See buildClientDetails for why that column is not consulted.
import { clientContactText } from '@/app/orders/drafts/[submissionId]/piDetailView'
// FINANCE’S OWN PAYMENT-ENTRY FORM, mounted here rather than reimplemented.
// One payment, its allocations and every gate belong to
// record_payment_with_allocations(); this page supplies a door and a seed.
import { RecordSplitPaymentModal } from '@/app/finance/received/RecordSplitPaymentModal'

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

/**
 * EVERYTHING THE PAGE HOLDS ABOUT THE APPROVED PI'S PICTURES.
 *
 * The four URL-bearing fields are what the product table and the image viewer
 * draw. `summary` is what Current Status reports, and it is a STATE rather than
 * a count: the read has not finished, the Order has no PI behind it, the read
 * failed, or it succeeded and here is the number. See DesignImageSummary.
 *
 * `summary.counts` IS COUNTED FROM THE STORED ROWS, not from the maps beside
 * it. Those hold the URLs that were actually signed, so a picture this reader's
 * storage policy refused is missing from them — and a count that shrank because
 * of who was looking would be a count of nothing.
 */
type PiImagesState = {
  representativeByRow: ReadonlyMap<number, string>
  customizationByRow: ReadonlyMap<number, readonly string[]>
  unresolved: number
  viewerItems: readonly PiViewerItem[]
  summary: DesignImageSummary
}

/**
 * NO PICTURES, IN A NAMED STATE — the whole of it, every field, every time.
 *
 * WHY A FACTORY AND NOT A SHARED CONSTANT: every path that abandons a PI load
 * must clear the maps, the viewer items, the unresolved tally AND the summary
 * together. Clearing four of the five is exactly the defect this replaces —
 * an Order with no PI of its own showing the last Order's photographs — and a
 * single call that returns all five makes a partial reset something you have to
 * write out on purpose rather than something you can forget.
 */
function noPiImages(summary: DesignImageSummary): PiImagesState {
  return {
    representativeByRow: new Map(),
    customizationByRow: new Map(),
    unresolved: 0,
    viewerItems: [],
    summary,
  }
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

/* THE PAYMENT STATUS PALETTE WENT WITH THE INLINE TABLE. The per-payment rows
   live in a dialog now and state a status only where it distinguishes anything
   — see OrderPaymentListDialog. The WORDS are unchanged and still come from
   piPaymentStatusLabel, the PI card's own map, so the two screens cannot call
   one status two things. */

/** The width below which the PI product table becomes a stack of cards. The
 *  same breakpoint both PI screens use, so a product line does not change shape
 *  at a different width depending on which screen shows it. */
const MOBILE_BREAKPOINT = 768

/** What the workbook control says when the download is refused. One sentence,
 *  no internals: a refusal is almost always a permission answer and saying so
 *  in detail would confirm what the reader is not entitled to. */
const WORKBOOK_UNAVAILABLE = 'That file is not available to you right now.'

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
  // Lazily, so the two empty Maps are built once rather than on every render.
  const [piImages,    setPiImages]    = useState<PiImagesState>(() => noPiImages({ kind: 'loading' }))
  const [clientOpen,  setClientOpen]  = useState(false)
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
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
  /** Which payment figure a reader opened, or null. One dialog at a time. */
  const [paymentList, setPaymentList] = useState<OrderPaymentListKind | null>(null)
  /** Which payment inside that list is showing its detail, or null for the list. */
  const [paymentDetailId, setPaymentDetailId] = useState<string | null>(null)
  /**
   * The rest of each payment's own row, keyed by payment id.
   *
   * SAME ROWS, MORE COLUMNS. finance_payment_requests is guarded row by row, so
   * a reader shown a payment at all was already entitled to every column of it;
   * widening the select adds no round trip and moves no gate.
   */
  const [paymentDetails, setPaymentDetails] = useState<ReadonlyMap<string, OrderPaymentDetailFields>>(new Map())
  /** The design-file dialog, and the one evidence picture a reader asked for. */
  const [designOpen, setDesignOpen] = useState(false)
  const [evidence, setEvidence] = useState<{ url: string | null; failure: string | null } | null>(null)
  /** Finance’s Record Payment form, open over this Order. */
  const [recordingPayment, setRecordingPayment] = useState(false)
  /** What it recorded, said once above the figures it just changed. */
  const [paymentNotice, setPaymentNotice] = useState<string | null>(null)
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
  const [historyOpen,   setHistoryOpen]   = useState(false)
  const [approvals,     setApprovals]     = useState<PersistedApprovalEvent[]>([])
  const [approvalOpen,  setApprovalOpen]  = useState(false)
  const [approvalBusy,  setApprovalBusy]  = useState(false)
  const [approvalError, setApprovalError] = useState<string | null>(null)
  const [proofBusy,     setProofBusy]     = useState<string | null>(null)
  const [piFileBusy,    setPiFileBusy]    = useState<string | null>(null)
  const [alignDialog,   setAlignDialog]   = useState<boolean | null>(null)
  const [alignBusy,     setAlignBusy]     = useState(false)
  const [alignError,    setAlignError]    = useState<string | null>(null)

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

    // ── NOTHING FROM THE LAST ORDER SURVIVES THE FIRST LINE OF THIS ONE ──
    //
    // Every field at once, before any decision and before any read: the signed
    // URLs, the viewer's items, the unresolved tally and the picture summary.
    // The page is a client component and this function runs again on a
    // navigation from one Order to another, so anything left standing here is
    // one Order's photographs and counts displayed under another's number.
    //
    // `loading` IS THE HONEST STATE AT THIS POINT, and the reason the summary
    // is a state and not a number. A count starting at zero would have the
    // Design Files card say "None recorded" — a claim that somebody read the
    // table and it was empty — during the round trip that is about to find out.
    //
    // UNCONDITIONAL, AND NOT "ONLY WHEN THE ORDER CHANGED". A reset that has to
    // decide whether it is needed is a reset that can decide wrong, and the
    // thing it would be deciding wrong about is whose photographs are on the
    // screen. The price is paid on an in-place refresh of the SAME Order: the
    // product pictures blank for the one round trip these reads take, then come
    // back. A refresh the reader asked for, showing that it is re-reading, is
    // worth more than a branch that can leave another Order's pictures up.
    setPiImages(noPiImages({ kind: 'loading' }))

    if (!submissionId) {
      setPiHandoff({ kind: 'none' })
      setPiProducts([])
      setPiVersions([])
      setPiActivity([])
      // No PI behind this Order, so there is nothing to count and nothing
      // failed. The card says which, rather than reporting an empty read that
      // never happened.
      setPiImages(noPiImages({ kind: 'no_source' }))
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
      // THE SAME ABSENCE THE HANDOFF REPORTS, said by the picture line too.
      // The images may well have read cleanly, but without the submission row
      // there are no product lines to hang them on — and a count printed
      // beside an unavailable PI would be a number nobody can check.
      setPiImages(noPiImages({ kind: 'unavailable' }))
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
      // A READ THAT ERRORED IS NOT AN ORDER WITH NO PICTURES. PostgREST
      // answers a refused or failed select with an error and an empty `data`,
      // so counting the rows without looking at `error` first would turn every
      // such failure into a confident "None recorded".
      summary: imagesRes.error
        ? { kind: 'unavailable' }
        : { kind: 'ready', counts: countDesignImages(images) },
    })
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
   * The Order's fabric and finish events, as one query — named once so the full
   * load and the narrow refresh below cannot read or shape it differently.
   *
   * NEWEST FIRST, and the whole log: the card folds it to the current state of
   * each kind and the history reads the rest. Two kinds, a handful of events
   * each; there is no page to keep.
   */
  /**
   * The embed arrives NESTED, as PostgREST returns it, and the view wants one
   * flat field. Flattened here rather than in the lib so the lib keeps taking
   * a plain row shape a test can build by hand.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapApprovalRows = (raw: any[] | null): PersistedApprovalEvent[] =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (raw ?? []).map((row: any) => ({
      ...row,
      actor_name: row.actor?.full_name ?? null,
    })) as PersistedApprovalEvent[]

  const approvalsQuery = () =>
    supabase
      .from('order_approval_events')
      .select(ORDER_APPROVAL_EVENT_SELECT)
      .eq('order_id', id)
      .order('created_at', { ascending: false })

  /**
   * WHAT RECORDING AN APPROVAL ACTUALLY CHANGED: one appended row. It touches
   * no Order column, no payment and no PI, so re-running the whole page load
   * would re-read fourteen things and re-sign every product photograph to show
   * one new status.
   */
  const reloadApprovals = async () => {
    const { data } = await approvalsQuery()
    setApprovals(mapApprovalRows(data))
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
      { data: apprData },
    ] = await Promise.all([
      supabase
        .from('finance_payment_requests')
        // THE REST OF THE ROW COMES WITH IT. Same query, same rows, same
        // row-level policy — the detail dialog is answered from what this read
        // already returns rather than from a second one.
        .select(
          'id, client_name, amount, payment_date, payment_mode, order_number, status, ' +
          'human_payment_id, request_number, received_in, proof_note, sales_note, admin_note, ' +
          'approved_at, approved_by, rejected_at, clarification_requested_at',
        )
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
                'id, client_name, amount, payment_date, payment_mode, order_number, status, ' +
                'human_payment_id, request_number, received_in, proof_note, sales_note, ' +
                'admin_note, approved_at, approved_by, rejected_at, clarification_requested_at)')
        .eq('order_id', id)
        .eq('status', 'active'),

      activityQuery(),

      approvalsQuery(),

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

    setApprovals(mapApprovalRows(apprData))

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

    // THE REST OF EACH ROW, KEYED BY PAYMENT ID. Both reads are consulted and
    // the allocation's embedded payment wins where a payment appears in both —
    // the same precedence mergeOrderPayments applies to the row itself, so the
    // detail and the figure can never come from different copies.
    const details = new Map<string, OrderPaymentDetailFields>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const row of (linkedRows ?? []) as any[]) {
      if (row?.id) details.set(row.id, paymentDetailFields(row))
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const row of (allocationRows ?? []) as any[]) {
      const payment = row?.payment
      if (payment?.id) details.set(payment.id, paymentDetailFields(payment))
    }
    setPaymentDetails(details)

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
      // the activity, the change requests, the PI handoff and
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

  /* THE SOURCE-PI WORKBOOK DOWNLOAD WENT WITH THE Order records SECTION that
     was the only place offering it. The PI in force — which for a converted
     Order IS that document — is downloaded from the Main PI card, through
     openVersionFile below: the same private bucket, the same short-lived signed
     URL minted through the reader's own session, and the same storage policies
     deciding again at the moment of the click. Nothing about the PI's row, its
     files or its access changed; one duplicate door closed.

     orderPiWorkbookPath and ORDER_FILES_BUCKET are unchanged and still used by
     the PI Drafts module, which still opens that original. */

  // ── PI versions (20261119000000) ──

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
   * OPEN OR SAVE ONE PI VERSION'S WORKBOOK.
   *
   * SIGNED ON THE PRESS, through the reader's own session, so the order-files
   * policy decides again at that moment and a key copied out of this page stops
   * working within the hour. The two differ only in the `download` flag the
   * signer is given: viewing hands the browser the file to open, saving asks
   * for it as an attachment. Neither builds a URL into the markup and neither
   * mints anything for a version nobody named.
   */
  const openVersionFile = async (version: PiVersionView, mode: 'view' | 'download') => {
    if (piFileBusy) return
    const path = version.workbookPath
    if (!path) { setRevisionError(WORKBOOK_UNAVAILABLE); return }
    setPiFileBusy(version.id)
    setRevisionError(null)
    const { data, error } = await supabase
      .storage
      .from(ORDER_FILES_BUCKET)
      .createSignedUrl(path, ORDER_PI_WORKBOOK_URL_TTL_SECONDS,
        mode === 'download' ? { download: true } : undefined)
    setPiFileBusy(null)
    if (error || !data?.signedUrl) { setRevisionError(WORKBOOK_UNAVAILABLE); return }
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
  }

  /**
   * OPEN ONE ERP SCREENSHOT.
   *
   * Signed on the press through the reader's own session, so the evidence
   * bucket's SELECT policy — which asks can_view_order — decides again at that
   * moment. No proof is signed at load, and a key never reaches the markup.
   */
  const viewEvidence = async (path: string) => {
    if (proofBusy) return
    setProofBusy(path)
    setApprovalError(null)
    // THE DIALOG OPENS FIRST, EMPTY, so the reader sees that their click landed
    // while the URL is being minted. It is mounted only from here, so no proof
    // on this page is signed until somebody names one.
    setEvidence({ url: null, failure: null })
    const { data, error } = await supabase
      .storage
      .from(APPROVAL_EVIDENCE_BUCKET)
      .createSignedUrl(path, ORDER_PI_WORKBOOK_URL_TTL_SECONDS)
    setProofBusy(null)
    if (error || !data?.signedUrl) {
      setEvidence({ url: null, failure: describeApprovalFailure(error) })
      return
    }
    setEvidence({ url: data.signedUrl, failure: null })
  }

  /**
   * RECORD ONE OR BOTH APPROVALS.
   *
   * THE ORDER OF OPERATIONS MATTERS. Each screenshot is uploaded to its own
   * unique key under this Order and this kind FIRST, because
   * record_order_approval_event() refuses a recorded path that names no object.
   * The RPC is then called once per changed kind; it re-derives the authority,
   * the evidence requirement and the path ownership under a row lock on the
   * Order, so nothing decided in this browser is trusted.
   *
   * A FAILURE IS NEVER DRESSED AS A SUCCESS. The dialog stays open with one
   * quiet line and the card is re-read either way, so what is on screen is what
   * the database actually holds.
   *
   * AND A FAILURE LEAVES NOTHING BEHIND. Because the upload must precede the
   * write, every refusal strands the file that was uploaded for it; each
   * iteration removes its own orphan before reporting. An event that DID record
   * keeps its screenshot — the bucket will not let that one be removed.
   */
  const recordApprovals = async (changes: ApprovalSubmission[]) => {
    if (!order || approvalBusy) return
    setApprovalBusy(true)
    setApprovalError(null)
    try {
      for (const change of changes) {
        let path: string | null = null

        // NOT APPROVED NEVER CARRIES A FILE. The dialog already sends none for
        // it, and the RPC now REFUSES a path here instead of discarding it — so
        // uploading one would be writing an object for a call that cannot
        // succeed. Stated again at the point of upload, because this is the
        // only line that creates an object.
        if (change.file && change.status !== 'not_approved') {
          path = evidenceObjectPath({
            orderId: order.id,
            kind: change.kind,
            objectId: crypto.randomUUID(),
            fileName: change.file.name,
          })
          const { error: uploadError } = await supabase.storage
            .from(APPROVAL_EVIDENCE_BUCKET)
            .upload(path, change.file, { contentType: change.file.type })
          if (uploadError) { setApprovalError(describeApprovalFailure(uploadError)); return }
        }

        const { error } = await supabase.rpc('record_order_approval_event', {
          p_order_id: order.id,
          p_approval_kind: change.kind,
          p_status: change.status,
          p_evidence_path: path,
        })
        if (error) {
          // THE ORPHAN THIS PRESS JUST MADE, AND NOTHING ELSE.
          //
          // The upload had to come first, so a refusal always leaves a file
          // behind that no event references. `path` is the key this iteration
          // generated a moment ago from a fresh uuid, so removing it cannot
          // reach anybody else's screenshot — and the bucket's DELETE policy
          // refuses any object an event has already claimed, so it cannot reach
          // a filed proof even if this code were wrong about which key it holds.
          //
          // The cleanup's own outcome is deliberately not surfaced: the refusal
          // above is what the person needs to read, and a failed tidy-up must
          // not replace it with a second, less useful message.
          if (path) {
            await supabase.storage.from(APPROVAL_EVIDENCE_BUCKET).remove([path])
          }
          setApprovalError(describeApprovalFailure(error))
          return
        }
      }
      setApprovalOpen(false)
    } finally {
      setApprovalBusy(false)
      // Either way: a refusal may still have moved something, and a success
      // certainly did. The event log alone — nothing else on the page changed.
      await reloadApprovals()
    }
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
  const leadSource = leadSourceLabel(order.lead_source)

  /**
   * WHEN THE PI BEHIND THIS ORDER WAS UPLOADED.
   *
   * order_pi_versions' APPROVED row, which is V1 for an Order that has never
   * been revised and the revision's own row once one has been approved — so it
   * follows the latest approved PI by construction and needs no rule here.
   *
   * IT IS NOT A SUBSTITUTE FOR ANYTHING. An Order whose versions have not been
   * read yet, or which never came from a PI, has no upload date, and the panel
   * says so rather than printing the Order's creation date in its place.
   */
  const piUploadedAt = piHistory.current?.uploadedAt ?? null

  /**
   * WHERE THE CLIENT IS — the approved PI's own `client_city`, resolved by the
   * shared client builder and labelled `Location` wherever this product shows
   * it. NEVER assembled out of the billing or shipping address: those name a
   * destination for an invoice or a truck, which is a different question.
   */
  const clientLocation = piHandoff.kind === 'ready' ? piHandoff.client.city : null

  const summaryFields = orderSummaryFields({
    clientName: order.client_name,
    location: clientLocation,
    confirmDate: order.confirm_date ? fmtDate(order.confirm_date) : null,
    uploadDate: piUploadedAt,
    dueDate: order.due_date ? fmtDate(order.due_date) : null,
    isOverdue: !!isOverdue,
    totalProductValue: order.total_product_value === null ? null : fmtAmount(order.total_product_value),
  })

  // ── THE ONE COMMERCIAL PRESENTATION ──
  //
  // The approved PI's own rows where there is a PI, and the Order's two stored
  // totals where there is not. Every amount is a string somebody else already
  // formatted; orderCommercial only roles and signs them. The net is the one
  // derived figure on the page and is a subtraction of the two stored columns.
  const commercialLines = piHandoff.kind === 'ready'
    ? orderCommercialLines(piHandoff.commercialRows)
    : orderStoredCommercialLines({
        productValue: fmtAmount(order.total_product_value),
        orderValue: fmtAmount(order.total_value),
      })

  /**
   * THE THREE THAT ARE NOT THE HEADLINE.
   *
   * The salesperson, the lead source and the production state, each from the
   * column and the helper it has always come from — orders.assigned_to's name,
   * leadSourceLabel over orders.lead_source, and describeProductionAlignment
   * over the four production columns. Not one of them is resolved differently
   * because it moved: this is the same input the identity band was handed.
   *
   * NOT IN THE SUMMARY PANEL, and NOT INVISIBLE EITHER. The attention strip
   * raises a gap in all three, and a reader told "Production not aligned" must
   * be able to find the field that says so.
   */
  /**
   * THE PI IN FORCE, AND THE WHOLE TRAIL BEHIND IT.
   *
   * Both read piHistory, which is describePiVersionHistory's answer over the
   * rows public.order_pi_versions returned under this reader's own RLS. The
   * card states the APPROVED version and the modal states every one; neither
   * re-derives which is current, so they cannot disagree.
   */
  const mainPi = mainPiCard(piHistory)
  const piTimeline = piVersionTimeline(piHistory)

  /**
   * WHAT THE ADVANCE COMES TO, and whether it reads Risky or Safe.
   *
   * `finance` is buildOrderFinancePosition's, unchanged, and its
   * verifiedPercent is already verified-and-allocated over the final Order
   * Value. Nothing here recomputes it — see orderAdvance.ts for why, and for
   * why this label is an indicator rather than the confirmation gate.
   */
  /* ADVANCE RECEIVED HAD A CARD HERE AND IT WAS A SECOND STATEMENT OF THE
     PAYMENT SECTION'S OWN FIGURES — the verified share of the Order value, over
     the Order value, both of which the section below the products states with
     the rest of the position. The card is gone; orderAdvance.ts, its
     classification rule and its tests are untouched and unreferenced by this
     screen, which is the honest state of a display that was removed rather than
     a rule that changed. */

  /** Where fabric and finish stand: the newest event of each kind. */
  const approvalView = approvalStanding({
    events: approvals,
    formatWhen: fmtDateTime,
    readOnlyNote: viewAsUserId ? FABRIC_FINISH_VIEW_AS_NOTE : undefined,
  })

  /**
   * THE TWO NEW CURRENT STATUS CARDS, from answers this page already had.
   *
   * `approvalView` is the very standing the Fabric & Finish card draws, and
   * `production` is describeProductionAlignment's — both reused rather than
   * re-derived, so the summary above the product list and the detail below it
   * cannot report different states of the same record. The image counts are
   * the stored rows of the approved PI, and the stage is the Order's own
   * status through the page's own label map.
   */
  /**
   * THE DESIGN-FILE SUBSECTION, in four states and no fifth (PR #195): loading
   * is not "none", a refused read is not "none", and an empty read says so in
   * its own words.
   *
   * IT NO LONGER RESTATES THE APPROVALS. Fabric and finish are drawn once, by
   * the card beside this box, with everything this summary had to leave out.
   */
  const designFiles = designFilesDocument(piImages.summary, piProducts.length)

  /**
   * THE CLIENT'S OWN PURCHASE ORDER.
   *
   * There is nowhere to keep one yet — see orderDocumentsPanel.ts for the audit
   * — so the slot states the absence and offers no control. Nothing is stored
   * as a mis-typed design file and no local state pretends otherwise.
   */
  const clientPo = clientPoDocument()
  /**
   * WHETHER TO DRAW THE UPDATE CONTROL.
   *
   * The assigned salesperson matched BY USER ID, an active admin or an active
   * manager, and never under View As. can_record_order_approval() asks exactly
   * the same question of public.users.role and orders.assigned_to when the RPC
   * lands, so hiding the button is a courtesy and the refusal is the database's.
   */
  const mayRecordApproval = canRecordApproval({
    viewerId: viewAsUserId ? null : (profile?.id ?? null),
    role: profile?.role ?? null,
    assignedTo: order.assigned_to,
    viewingAs: !!viewAsUserId,
  })

  /**
   * MAY THIS READER RECORD A PAYMENT AGAINST THIS ORDER?
   *
   * finance.allocate with Finance module entry — the same capability the
   * Received Payments page draws its own Record Payment button on and the same
   * one record_payment_with_allocations() requires — and not a cancelled Order,
   * which that RPC refuses outright. Both conditions are stated once, in
   * crossModuleLinks, so the two modules cannot answer differently.
   *
   * IT GRANTS NOTHING. The RPC re-derives the actor and the permission.
   */
  const mayRecordPayment = canRecordPaymentAgainstOrder({
    canAllocatePayment: financeCaps.canAllocatePayment,
    orderStatus: order.status,
  })

  const recordFacts = orderRecordFacts({
    status: order.status,
    salespersonName: order.assigned_to_name ?? null,
    leadSource,
    productionAligned,
    productionLabel: production?.label ?? '—',
    productionLine: production?.line ?? null,
  })

  /**
   * THE HEADER, AS THREE GROUPS — composed, not resolved.
   *
   * orderSummaryFields built the six above and orderRecordFacts built the
   * three; this only says which group each belongs to and hands the client
   * contact in beside them. Every value, label, tone and absent-wording is the
   * one those two builders already decided.
   *
   * THE THREE OPERATIONAL FACTS MOVED UP HERE FROM Record information, which
   * sat below the payment section and is gone. They are the same facts from the
   * same columns; only where they are drawn changed.
   */
  const summaryView = orderSummaryView({
    fields: summaryFields,
    facts: recordFacts,
    clientContact: piHandoff.kind === 'ready' ? clientContactText(piHandoff.client) : null,
    productionAligned,
  })

  const attention = orderAttentionItems({
    status: order.status,
    productionAligned,
    hasSalesperson: !!order.assigned_to,
    hasDueDate: !!order.due_date,
    hasLeadSource: !!leadSource,
    isOverdue: !!isOverdue,
    // Money is only known once its read has landed; until then it is not
    // "fine", it is unknown, and the bar says nothing.
    awaitingVerificationCount: recordsReady ? finance.counts.awaiting : 0,
    pendingChangeRequests: pendingRequests.length,
    pendingPiRevision: piHistory.pending !== null,
    // THE DOCUMENT STATES ARE NOT RAISED HERE ANY MORE. The Documents section
    // and the Generate control left this page, so a reader told that documents
    // had failed or were out of date would have nothing on this screen to do
    // about it. The rules still support both keys, and the register, its route
    // and its RLS are untouched — only this page stops asking.
    documentsFailed: false,
    documentsOutdated: false,
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
      /* NO SWITCH TO FINANCE FROM HERE. Everything a reader of this page could
         want Finance for — the verified position, what is awaiting, and every
         payment behind both figures — is stated on this page and opened in its
         own dialogs. The control exists on every other Orders screen. */
      showModuleSwitch={false}
      profile={profile}
      title="Confirmed Order"
      onSignOut={handleSignOut}
      onRefresh={loadOrder}
    >
      <div className="order-detail-page">

        {/* Back to the list this Order was opened from, with its filters —
            or to Confirmed Orders. Named, and never out of the app, which
            router.back() was whenever this was the tab's first page. */}
        <RecordBackLink fallbackHref="/orders/all" className="order-back" />

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

        {/* ══ 2. THE SUMMARY PANEL ══
            THREE GROUPS, ONE SURFACE, in the order a reader asks them: who the
            client is and what the order is worth; who owns the sale and
            whether production has been aligned; and the dates.

            IT ABSORBED Record information. The salesperson, the lead source
            and production used to sit in their own block BELOW the payment
            section, which meant a reader told "Production not aligned" by the
            attention strip had to scroll past the money to find the field that
            said so. They are in group 2 now, from the same columns and the
            same builder, and that block is gone.

            THE CLIENT'S CONTACT IS NEW TO THIS PAGE and to nothing else: it is
            the number the approved PI already carried and the PI card already
            printed, resolved by that card's own builder.

            THE ORIGINATING REQUEST NUMBER AND THE AUDIT TIMESTAMPS ARE STILL
            OFF THE PAGE, for the reason they left it: nobody plans against
            either.

            RAISED BY IS NOT DRAWN. A DISPLAY REMOVAL ONLY: orders.requested_by
            is still read, still carried on the row, still the column the PI
            revision rule reads to find the PI's owner, and the activity trail
            still names who did what. Nothing was dropped from a select and
            nothing was dropped from the database. */}
        <OrderSummaryPanel view={summaryView} />

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

        {/* ══ 3. DOCUMENTS, AND FABRIC & FINISH BESIDE THEM ══
            THE PAPERWORK IN ONE BOX. The PI this Order runs on, the design
            files behind its products and the client's own purchase order used
            to be two separate cards and nothing — three outlines, three
            headings and a column of white space under the shorter card, for one
            question a reader asks once.

            WHAT WENT WITH THE CARDS. The Design Files card summarised the
            fabric and finish approvals that the card beside it states in full,
            with their dates, their actors and their evidence. That summary is
            gone: the approvals have one home, and it is the card on the right.

            ADVANCE RECEIVED IS GONE TOO, and did not move: every figure it drew
            is in the Payment section below the products, which is the one place
            on this page money is stated. Its builder, orderAdvance.ts, and its
            tests are untouched — this removed a second display of one answer,
            not the answer.

            TWO THIRDS AND ONE THIRD, because that is the shape of the content:
            three subsections of prose against two statuses. Stacked in the same
            order below 900px. */}
        <OrderDocumentsRow>
          <OrderDocumentsPanel
            mainPi={mainPi}
            design={designFiles}
            clientPo={clientPo}
            onView={v => { void openVersionFile(v, 'view') }}
            onDownload={v => { void openVersionFile(v, 'download') }}
            onHistory={() => { setRevisionError(null); setHistoryOpen(true) }}
            onManageDesign={() => setDesignOpen(true)}
            viewing={piFileBusy !== null}
            downloading={piFileBusy !== null}
          />
          <OrderFabricFinishCard
            standing={approvalView}
            canUpdate={mayRecordApproval}
            onUpdate={() => { setApprovalError(null); setApprovalOpen(true) }}
            onViewEvidence={path => { void viewEvidence(path) }}
            busyEvidence={proofBusy}
          />
        </OrderDocumentsRow>

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
            THE ONLY PAYMENT SURFACE ON THE PAGE, and four lines long.

            IT USED TO BE THE TALLEST SECTION HERE. A headline, two metric
            blocks, a bar, a legend naming the bar's three shares, a grid of
            three more captioned figures — one of which was the order value the
            headline had just stated and another the sum of the two metrics —
            and, underneath all of it, a permanently open table of every payment
            with a paragraph explaining the table. The same rupees were on the
            screen up to three times.

            WHAT A READER ASKS, AND WHERE EACH ANSWER IS NOW: how much is
            verified (the headline, and the Verified button); how much is with
            Finance (the Awaiting verification button); how much remains (the
            Balance line); what share that is (the headline percentage). The
            per-payment rows are behind the two buttons, which is where somebody
            who wants them goes and where nobody else has to scroll past them.

            EVERY FIGURE IS STILL buildOrderFinancePosition'S. No amount, no
            percentage, no status rule and no allocation rule changed here. */}
        <PiCard>
          <PiCardHeader
            title={PAYMENT_SECTION_TITLE}
            style={SECTION_HEADER_STYLE}
            right={recordsReady ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                {/* ── Add payment ──
                    A DOOR INTO FINANCE’S OWN ENTRY FORM, and nothing else. It
                    opens record_payment_with_allocations’ one flow, seeded with
                    this Order, and this page contains no payment form, no
                    validation and no write of its own.

                    DRAWN ON THE SAME RULE FINANCE DRAWS ITS OWN Record Payment
                    button on — finance.allocate with module entry — plus the
                    Order not being cancelled, which the RPC refuses anyway. A
                    reader without it is offered no control at all, not a
                    disabled one: the RPC would refuse them and a dead button
                    only asks them to find that out.

                    UNCHANGED IN THIS PASS: the same gate, the same label, the
                    same modal, the same refresh. Only the payment COUNT that
                    used to sit beside it has gone — each figure now states its
                    own count on its own button. */}
                {mayRecordPayment && (
                  <button
                    type="button"
                    onClick={() => setRecordingPayment(true)}
                    className="boe-btn boe-btn-ghost"
                    style={{ padding: '4px 11px', fontSize: '12px', flexShrink: 0 }}
                  >
                    {ADD_PAYMENT_ACTION_LABEL}
                  </button>
                )}
              </div>
            ) : undefined}
          />
          <div style={{ padding: '11px 16px 13px' }}>
            {/* WHAT FINANCE JUST RECORDED, above the figures it changed. It
                names the payment and says plainly that verification has not
                happened — recording money is not the same as its having
                arrived, and this page must not let the two read alike. */}
            {paymentNotice && (
              <div className="order-pay-notice" role="status">
                <span>{paymentNotice}</span>
                <button
                  type="button"
                  onClick={() => setPaymentNotice(null)}
                  aria-label="Dismiss"
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: colors.muted, fontSize: '14px', lineHeight: 1, padding: 0,
                  }}
                >
                  ×
                </button>
              </div>
            )}
            <PaymentSummaryFigures
              finance={finance}
              loaded={recordsReady}
              onOpenList={setPaymentList}
            />
          </div>
        </PiCard>

        {/* ══ ORDER RECORDS WAS HERE, AND EVERY FACT IT HELD IS STILL ON THIS
            PAGE. It carried one thing: the source PI, named, with a Download.
            The PI in force — which for a converted Order IS that document —
            is the Main PI card in Current Status, with its own View, Download
            and View history, all signed through the reader's own session.

            NOTHING UNDERNEATH IT WAS TOUCHED. orders.source_order_submission_id
            is unchanged and still frozen, the PI's own row, its files and its
            version history are untouched, PI History still opens every version,
            the merged chronology below still interleaves the PI's activity
            trail, and the RLS door can_view_order_submission_via_order
            (20260924000000) still stands. */}

        {/* EVERY ORDER SAYS SOMETHING ABOUT ITS PI. "This Order has no PI" and
            "the feature is not deployed" are indistinguishable from the
            outside, so the absence is stated rather than left silent. */}
        {/* Not before the hand-off has answered: piHandoff starts as 'none', so an
            Order that DOES have a PI briefly claimed it had none, then the claim
            was replaced — a false statement and a layout jump on every visit. */}
        {piHandoff.kind === 'none' && (handoffReady || !order.source_order_submission_id) && <OrderPiNoSource />}

        {/* AND A PI THAT COULD NOT BE READ STILL SAYS SO. That sentence used to
            sit inside Order records, beside the source PI reference; the
            section is gone and the absence is not. It is the SAME shared
            wording, in the card written for it — one quiet statement, no
            figure, no retry that would not help, and no explanation of a
            refusal the reader is not entitled to. */}
        {piHandoff.kind === 'unavailable' && <OrderPiUnavailable />}

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

        {/* ══ 7. ACTIVITY ══ the complete trail, last: the current state is
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
            THE EXTREME RIGHT, BELOW PRODUCTS, and THE ONLY PLACE ANY OF THESE
            FIGURES APPEAR. A `Product value` / `Order value` totals block used
            to sit above the breakdown and restate its own first and last lines
            under different captions — the same rupees twice, four lines apart.
            Both figures are now the two ends of the one working that connects
            them, and this column has ONE heading rather than a column head and
            a section title saying nearly the same word.

            NOTHING ON THIS PAGE RECOMPUTES A TOTAL. Every amount below is
            literally the string the approved PI screen prints. */}
        <aside className="order-lower-aside" aria-label={ORDER_COMMERCIAL_TITLE}>
          <div className="order-lower-aside-inner">
            <div className="order-commercial">
              <OrderCommercialBreakdown lines={commercialLines} embedded />
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

      {/* ── The design files, over this page ──
          Mounted only while it is open, so a reader who never asks for the list
          fetches not one thumbnail. The pictures are the page's own, already
          resolved and already ordered; opening one hands it to the same
          full-size viewer the product table uses. */}
      {designOpen && (
        <OrderDesignFilesDialog
          items={piImages.viewerItems}
          onOpen={key => { setDesignOpen(false); openViewer(key) }}
          onClose={() => setDesignOpen(false)}
        />
      )}

      {/* ── One approval screenshot, over this page ──
          It used to be a new tab onto a signed URL. The URL is still signed on
          the press through the reader's own session, so the evidence bucket's
          policy decides at that moment exactly as before; only where the
          picture is shown changed. */}
      {evidence && (
        <OrderEvidenceDialog
          url={evidence.url}
          failure={evidence.failure}
          onClose={() => setEvidence(null)}
        />
      )}

      {/* ── The payments behind a figure ──
          OPENED FROM THE SUMMARY AND NOWHERE ELSE, and only ever one at a time:
          `paymentList` holds which figure was clicked, or null.

          THE ROWS ARE THE PAGE'S OWN, FILTERED AND NOTHING MORE. orderPaymentList
          splits withExactAmounts' rows by the same two status predicates the
          totals use, so a dialog can never show a payment the figure above it
          did not count. Every amount shown is exactAllocatedAmount — THIS
          Order's allocated share — which is the figure the summary is built
          from; a split payment states its full ledger amount underneath.

          THE FINANCE DOOR IS THE TABLE'S OWN GATE, unchanged: offered only to a
          reader who holds Finance module entry, and Finance still re-reads the
          row under that reader's own RLS. */}
      {paymentList && (
        <OrderPaymentListDialog
          kind={paymentList}
          rows={orderPaymentList(payments, paymentList, paymentDetails)}
          formatDate={fmtDate}
          formatDateTime={iso => (iso ? fmtDateTime(iso) : '—')}
          openId={paymentDetailId}
          onOpen={setPaymentDetailId}
          onBack={() => setPaymentDetailId(null)}
          onClose={() => { setPaymentList(null); setPaymentDetailId(null) }}
        />
      )}

      {/* ── The PI history, without leaving the Order ── */}
      {historyOpen && (
        <PiHistoryModal
          entries={piTimeline}
          onClose={() => setHistoryOpen(false)}
          onView={v => { void openVersionFile(v, 'view') }}
          onDownload={v => { void openVersionFile(v, 'download') }}
          busyId={piFileBusy}
          canPropose={mayProposeRevision}
          onPropose={() => { setRevisionError(null); setRevisionDialog({ kind: 'propose' }) }}
          canDecide={mayDecideRevision}
          onApprove={version => { setRevisionError(null); setRevisionDialog({ kind: 'approve', version }) }}
          onReject={version => { setRevisionError(null); setRevisionDialog({ kind: 'reject', version }) }}
          error={revisionDialog === null ? revisionError : null}
        />
      )}

      {/* ── Fabric and finish (20261227000000) ── */}
      {approvalOpen && (
        <OrderApprovalModal
          standing={approvalView}
          saving={approvalBusy}
          failure={approvalError}
          onClose={() => { if (!approvalBusy) setApprovalOpen(false) }}
          onConfirm={changes => { void recordApprovals(changes) }}
        />
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

      {/* ══ ADD PAYMENT ══
          FINANCE’S FORM, NOT A SECOND ONE. RecordSplitPaymentModal is the same
          component the Received Payments page opens, doing the same work in the
          same single transaction through record_payment_with_allocations() —
          which re-derives the actor, requires Finance module entry AND
          finance.allocate, re-validates every target, and writes the payment as
          pending_approval. Verification remains Finance’s separate decision.

          SEEDED WITH THIS ORDER, not restricted to it. The reader arrived from
          this Order, so row one names it; they may still change it, remove it
          or divide the payment across several records, because that is what the
          form is for.

          THE GATE IS DRAWN, NOT ENFORCED, HERE. mayRecordPayment decides whether
          the control exists; the RPC decides whether the write happens. */}
      {recordingPayment && mayRecordPayment && (
        <RecordSplitPaymentModal
          supabase={supabase}
          userId={profile?.id ?? null}
          initialTarget={{
            kind: 'order',
            id: order.id,
            reference: order.display_number ?? '—',
            clientName: order.client_name ?? '—',
          }}
          onClose={() => setRecordingPayment(false)}
          onRecorded={summary => {
            setRecordingPayment(false)
            setPaymentNotice(
              summary.allocationCount === 0
                ? `Payment ${summary.requestNumber} recorded. None of it is allocated yet — it is available to allocate in Finance.`
                : `Payment ${summary.requestNumber} recorded against ${summary.allocationCount} record${summary.allocationCount === 1 ? '' : 's'}. Finance verification is still pending.`)
            // THE PAGE’S OWN REFRESH, unchanged: a recorded payment moves the
            // payment reads, the allocation reads and the activity trail, and
            // loadOrder is what settles all of them in one commit.
            void loadOrder()
          }}
        />
      )}

    </OrdersLayout>
  )
}
