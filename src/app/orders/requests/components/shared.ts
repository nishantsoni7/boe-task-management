'use client'

// ── Order Request shared model ────────────────────────────────────────────────
// Types, permission guards, status metadata, formatters and RPC error mappers
// shared by the Order Requests LIST (/orders/requests) and the dedicated Order
// Request DETAIL page (/orders/requests/[id]).
//
// Everything here was moved verbatim out of the list page when the detail
// experience became its own route. It is deliberately the ONE place each
// permission rule is stated, so the list and the detail page can never drift
// from each other — or from the server-side gate each rule mirrors.

import { useEffect } from 'react'
import { formatINR } from '@/lib/currency'
import { extOf, isExcelAttachmentName } from '@/lib/orderRequestAttachments'

// ── Types ─────────────────────────────────────────────────────────────────────

export type OrderRequest = {
  id: string
  request_number: string
  client_name: string
  requested_by: string | null
  requested_by_name?: string
  assigned_to: string | null
  assigned_to_name?: string
  confirm_date: string | null
  due_date: string | null
  total_value: number | null
  total_product_value: number | null
  lead_source: string | null
  notes: string | null
  status: string
  created_by: string | null
  created_by_name?: string
  clarification_note: string | null
  rejection_reason: string | null
  created_at: string
  // Present on the detail page (which reads one row by id) and absent from the
  // list query. Optional so both callers share one type without the list having
  // to pretend it loaded a column it does not use.
  updated_at?: string
  // Always null for every row the LIST loads — that query excludes
  // status = 'converted', and order_requests_converted_consistency (20260680)
  // makes the two equivalent. The detail page reads a row by id, so a converted
  // request genuinely can arrive there with this set. Kept on the type so the
  // permission guards below still state the full rule rather than relying on
  // that equivalence.
  converted_order_id: string | null
}

// The project's existing requester rule (order_requests_requester_select /
// _insert, and resubmit_order_request): the requester is created_by OR
// requested_by. assigned_to is deliberately NOT an owner — an assignee is a
// participant (see isRequestParticipant), never the requester, so this stays
// the gate for Resubmit / Reapply, which the two form RPCs still restrict to
// created_by OR requested_by server-side.
export function isPermittedRequester(r: OrderRequest, userId: string): boolean {
  return r.created_by === userId || r.requested_by === userId
}

// The wider participant rule (20260707): the requester, PLUS the person the
// request is assigned to. An admin can create a request on a salesperson's
// behalf, in which case created_by and requested_by are both the admin and
// assigned_to is the only thing tying the salesperson to it.
//
// Scoped to reading and to payment linkage only. It deliberately does NOT gate
// editing: public.order_requests has had no UPDATE policy for any role since
// 20260683/20260687 moved every mutation into a SECURITY DEFINER RPC.
export function isRequestParticipant(r: OrderRequest, userId: string): boolean {
  return isPermittedRequester(r, userId) || r.assigned_to === userId
}

// The statuses in which a request is still the requester's to work on: edit it,
// and add/link/unlink the payments they submitted. Exactly the set
// link_finance_payment_to_order_request accepts server-side (20260699).
// 'converted' is absent on purpose — a converted request is read-only for its
// requester, enforced by the order_requests_guard_converted trigger, not by
// this constant.
export const REQUESTER_OPEN_STATUSES = ['submitted', 'needs_clarification', 'rejected']

// The statuses edit_order_request (20260708) accepts. Deliberately a separate
// constant from REQUESTER_OPEN_STATUSES: the two lists coincide today but answer
// different questions — what may be EDITED versus what may receive payments —
// and each must stay pinned to its own RPC rather than drift together.
// 'converted' is absent, which is what makes a converted request read-only here.
export const EDITABLE_STATUSES = ['submitted', 'needs_clarification', 'rejected']

// May this viewer still change the request itself? Editing follows the
// ASSIGNMENT, not authorship: an admin may edit any unconverted request, and
// the person it is currently assigned to may edit theirs. created_by /
// requested_by grant nothing on their own — a self-created request stays
// editable because its creator is normally also its assignee, and a former
// assignee loses access the moment an admin reassigns.
//
// Status is checked for BOTH roles (not just the assignee) so the rule reads the
// same way the RPC enforces it, and a future status is excluded by default
// instead of silently becoming admin-editable.
//
// Mirrors, and never widens, edit_order_request. That RPC is the enforcement;
// this only decides whether to render the button.
export function canEditRequest(r: OrderRequest, userId: string, isAdmin: boolean): boolean {
  if (r.converted_order_id || !EDITABLE_STATUSES.includes(r.status)) return false
  return isAdmin || r.assigned_to === userId
}

// May this viewer change the request's ATTACHMENTS (replace the Main PI, add or
// remove reference files)? Deliberately the SAME rule as editing the request
// itself — attachments are part of the record, not a separate permission — and
// stated as its own named function so the server-side RPC
// (edit_order_request_attachments, 20260712) has one rule to mirror.
//
// Creator/requester alone gains nothing here: exactly like canEditRequest, this
// follows the ASSIGNMENT. The RPC enforces the identical condition independently
// and is the actual gate; this only decides whether to render the controls.
export function canEditAttachments(r: OrderRequest, userId: string, isAdmin: boolean): boolean {
  return canEditRequest(r, userId, isAdmin)
}

// May this viewer answer an outstanding clarification and hand the request back
// for review?
//
// This is DELIBERATELY WIDER than isPermittedRequester, which is what the old
// Update-and-Resubmit button used. That rule is created_by OR requested_by, and
// it excluded the assignee — so when an admin raised a request on a
// salesperson's behalf (created_by and requested_by both the admin, assigned_to
// the salesperson), the one person who had to answer the question was the one
// person who could not. Both layers had the same hole: resubmit_order_request
// refused them too, so showing the button alone would only have moved the
// failure from a missing control to a 42501.
//
// The set is: admin, requester (either sense), or CURRENT assignee. Stated as
// four explicit conditions rather than composed from isRequestParticipant, so
// widening the participant rule for some other feature can never silently widen
// this one. An unrelated user is not included at any layer.
//
// Mirrors, and never widens, respond_to_clarification (20260714). That RPC is
// the enforcement; this only decides whether to render the action.
export function canRespondToClarification(r: OrderRequest, userId: string, isAdmin: boolean): boolean {
  if (r.converted_order_id || r.status !== 'needs_clarification') return false
  return isAdmin || isPermittedRequester(r, userId) || r.assigned_to === userId
}

// May this viewer attach or detach payments on this request? Stated separately
// because it maps to a different server-side gate (the two linkage RPCs) and
// must never drift from it — and since 20260707 that gate accepts the assignee
// too, which the edit rule above does not.
export function canManagePayments(r: OrderRequest, userId: string, isAdmin: boolean): boolean {
  if (r.converted_order_id || !REQUESTER_OPEN_STATUSES.includes(r.status)) return false
  return isAdmin || isRequestParticipant(r, userId)
}

// Escape-to-close for the handwritten form modals in this module. Their
// backdrops are intentionally inert (BOE form-modal dismissal rule — an outside
// click must never discard entered data), so Escape, the × and Cancel are the
// only dismissals. `canClose` mirrors each modal's own in-flight guard (e.g.
// !saving) so a mid-submit Escape can't abandon a save in progress; it is a
// dependency, so the listener always sees the current value rather than a stale
// closure. (The shared FinanceModalShell modals bring their own Escape via
// useModalScrollLockAndEscape — this is only for the local overlays.)
export function useEscapeToClose(onClose: () => void, canClose: boolean = true) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && canClose) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, canClose])
}

// A payment attached to this request via order_request_id. Non-admins see
// these through finance_payment_requests_order_request_owner_select (20260699),
// which exposes only payments already attached to a request they own.
export type LinkedPayment = {
  id: string
  request_number: string
  client_name: string
  amount: number
  payment_date: string
  payment_mode: string
  received_in: string
  proof_note: string | null
  sales_note: string | null
  status: string
  payment_against: string
  order_id: string | null
  order_number: string | null
  order_request_id: string | null
  order_request_number: string | null
  submitted_by: string
  submitted_by_name?: string
  created_at: string
}

// Structured result returned by edit_order_request() (20260708/20260709). The
// RPC returns a single jsonb OBJECT, so supabase-js hands it back as `data`
// directly — not an array, and not a PostgrestResponse row, so no .single() or
// .maybeSingle() is involved on this path.
export type EditRequestResult = {
  order_request_id:     string
  request_number:       string
  status:               string
  updated_at:           string
  assignee_changed:     boolean
  previous_assigned_to: string | null
  assigned_to:          string | null
  changed_fields:       string[]
}

// Structured result returned by respond_to_clarification() (20260714). Same
// single-jsonb-object convention as edit_order_request, so supabase-js hands it
// back as `data` directly — no .single()/.maybeSingle() on this path either.
export type ClarificationResponseResult = {
  order_request_id: string
  request_number:   string
  status:           string
  updated_at:       string
  changed_fields:   string[]
}

// Structured result returned by convert_order_request_to_order().
export type ConvertResult = {
  order_request_id: string
  request_number: string
  order_id: string
  order_display_number: string
  converted_at: string
  linked_payment_count: number
  linked_payment_request_ids: string[]
}

// An approved Finance payment with no Order link yet — the only kind that may
// be linked during conversion. Identifying fields only: no proof attachments,
// no storage paths.
export type EligiblePayment = {
  id: string
  request_number: string
  client_name: string
  amount: number
  payment_date: string
  proof_note: string | null
  // Always 'approved_unlinked' for a row offered in the eligible list, but read
  // and carried for the payments ALREADY parked on the request — since 20260715
  // those can be pre-approval, and only the approved ones transfer.
  status: string
  submitted_by_name?: string
}

// A suspense payment eligible to be parked on THIS Order Request via
// link_finance_payment_to_order_request (20260698) — same eligibility
// Finance's own Link modal enforces: approved_unlinked, no order, no other
// request already holding it.
export type SuspensePayment = {
  id: string
  request_number: string
  client_name: string
  amount: number
  payment_date: string
  payment_mode: string
  received_in: string
  proof_note: string | null
  sales_note: string | null
}

// Returned by the list_eligible_order_assignees() RPC: active Sales-team
// members plus anyone explicitly authorised via the permission engine
// (orders.can_be_order_assignee), already deduplicated and grouped server-side.
export type AssigneeOption = { id: string; full_name: string; source: 'sales' | 'override' }

// One Main PI / reference file recorded against a request. Read with the
// viewer's own RLS (participant or admin); the storage path is only ever
// exchanged for a short-lived signed URL, never exposed as a public location.
export type RequestAttachmentRow = {
  id: string
  attachment_type: 'main_pi' | 'reference'
  file_name: string
  storage_path: string
  uploaded_size_bytes: number | null
}

// How an attachment can be shown INSIDE the app, decided from the filename
// alone. This is an allow-list, not a guess: a format that is not named here is
// downloaded rather than handed to the browser to render, so an unexpected file
// can never be executed or displayed as something it is not.
//
//   image — decoded by the browser from the signed URL
//   pdf   — rendered by the browser's own viewer in a sandboxed iframe
//   sheet — parsed in the browser and rendered as plain text cells in a table
//   text  — shown verbatim as text
//   none  — download only
export type PreviewKind = 'image' | 'pdf' | 'sheet' | 'text' | 'none'

export function previewKindOf(fileName: string): PreviewKind {
  const ext = extOf(fileName)
  if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return 'image'
  if (ext === 'pdf')                                return 'pdf'
  if (ext === 'xlsx' || ext === 'xls')              return 'sheet'
  if (ext === 'csv'  || ext === 'txt')              return 'text'
  return 'none'
}

// Whether THIS viewer may open THIS attachment in the shared preview modal.
//
// Two different questions folded into one answer:
//   1. can the app render it at all?  → previewKindOf
//   2. may this person trigger THAT renderer?
//
// Only the second question has a role in it, and only for ONE type. The shared
// preview component (@/components/ui/AttachmentPreviewModal, the same one Task
// Management uses) renders PDF, images and CSV entirely inside the browser, but
// renders Excel through Microsoft's Office Online viewer — which works by having
// Microsoft's servers fetch the file URL. Task attachments are in a PUBLIC
// bucket so that costs nothing there; Order Request attachments are private, so
// previewing a workbook discloses it off-site.
//
// The workbook preview is therefore limited to admins — the people who have to
// approve a request against its PI, and for whom the trade is worth making.
// Everyone else keeps the download, which never leaves BOE. Pure.
export function canPreviewAttachment(fileName: string, isAdmin: boolean): boolean {
  if (previewKindOf(fileName) === 'none') return false
  return isExcelAttachmentName(fileName) ? isAdmin : true
}

// ── Status + label metadata ───────────────────────────────────────────────────

export const STATUS_META: Record<string, { label: string; bg: string; color: string; border: string }> = {
  submitted:           { label: 'Submitted',           bg: '#FFFBEB', color: '#92400E', border: '#FDE68A' },
  needs_clarification: { label: 'Needs Clarification',  bg: '#FFF7ED', color: '#9A3412', border: '#FED7AA' },
  rejected:            { label: 'Rejected',             bg: '#FEF2F2', color: '#991B1B', border: '#FECACA' },
  // Only reachable on the detail page: the list query excludes converted rows,
  // but a converted request is still openable by id (and by an old deep link).
  converted:           { label: 'Converted',            bg: '#F0FDF4', color: '#166534', border: '#BBF7D0' },
}

export const LEAD_SOURCE_OPTIONS = [
  { value: 'reference',       label: 'Reference' },
  { value: 'repeat_customer', label: 'Repeat Customer' },
  { value: 'whatsapp',        label: 'WhatsApp' },
  { value: 'instagram',       label: 'Instagram' },
  { value: 'website',         label: 'Website' },
]

// Display labels for suspense-payment rows in the link panel. Mirror the
// Finance Received Payments page's maps exactly (finance/received/page.tsx) so
// the same stored value reads identically on both surfaces.
export const PAYMENT_MODE_LABEL: Record<string, string> = {
  bank_transfer: 'Bank Transfer',
  cash:          'Cash',
  upi:           'UPI',
  cheque:        'Cheque',
  other:         'Other',
}

export const RECEIVED_IN_LABEL: Record<string, string> = {
  company_account: 'HDFC',
  cash_in_hand:    'Paytm',
  savings_account: 'Canara',
  other:           'PNB',
}

// Payment-status badges for the Payments section. Colours are the Finance
// Received Payments page's, so a payment reads with the same visual weight on
// both surfaces.
//
// The two labels that DIFFER from Finance's do so deliberately. This panel is
// where an admin decides whether an Order Request has real money behind it, and
// the question they are answering is "is this approved or not" — so the badge
// has to answer it in words:
//   * 'Pending Approval' rather than Finance's terser 'Pending';
//   * 'Approved Advance' rather than 'Awaiting Order Confirmation', which said
//     what the payment is waiting FOR and never that it had been approved.
// A payment parked on a request stays approved_unlinked in the database either
// way — see paymentStatusMeta below.
export const PAYMENT_STATUS_META: Record<string, { label: string; bg: string; color: string; border: string }> = {
  pending_approval:    { label: 'Pending Approval',    bg: '#FFFBEB', color: '#92400E', border: '#FDE68A' },
  approved_unlinked:   { label: 'Order No. Pending',   bg: '#FFF7ED', color: '#92400E', border: '#FED7AA' },
  approved_linked:     { label: 'Received Payment',    bg: '#F0FDF4', color: '#166534', border: '#BBF7D0' },
  needs_clarification: { label: 'Needs Clarification', bg: '#EFF6FF', color: '#1E40AF', border: '#BFDBFE' },
  rejected:            { label: 'Rejected',            bg: '#FEF2F2', color: '#991B1B', border: '#FECACA' },
}

export function paymentStatusMeta(p: LinkedPayment) {
  if (p.status === 'approved_unlinked' && p.order_request_id) {
    return { label: 'Approved Advance', bg: '#F5F3FF', color: '#5B21B6', border: '#DDD6FE' }
  }
  return PAYMENT_STATUS_META[p.status] ?? { label: p.status, bg: '#F3F4F6', color: '#4B5563', border: '#E5E7EB' }
}

// ── Approved-versus-pending split ─────────────────────────────────────────────
// Since 20260715 a payment can be attached to a request from the moment it is
// SUBMITTED, so the payments panel now holds records in four different states
// and only one of them is money. This is the one place that split is computed:
// `approved` is confirmed advance, `undecided` is still awaiting a Finance
// decision, `rejected` is a decision that produced no money.
//
// The approved definition is deliberately identical to advanceFromPayments —
// parked on this request AND status 'approved_unlinked' — so the figure in the
// summary strip and the figure in the payments modal can never disagree.
//
// Nothing here treats a pending payment as received: `approvedTotal` sums the
// approved rows only, and `undecidedTotal` is reported separately so it can be
// LABELLED as pending rather than folded into an advance.
export type PaymentSplit = {
  approved:      LinkedPayment[]
  undecided:     LinkedPayment[]
  rejected:      LinkedPayment[]
  approvedTotal: number
  undecidedTotal: number
}

const UNDECIDED_PAYMENT_STATUSES = ['pending_approval', 'needs_clarification']

export function splitPayments(rows: LinkedPayment[]): PaymentSplit {
  const parked    = rows.filter(p => p.order_request_id != null)
  const approved  = parked.filter(p => p.status === 'approved_unlinked')
  const undecided = parked.filter(p => UNDECIDED_PAYMENT_STATUSES.includes(p.status))
  const rejected  = parked.filter(p => p.status === 'rejected')
  const sum = (list: LinkedPayment[]) =>
    list.reduce((total, p) => total + (Number.isFinite(p.amount) ? p.amount : 0), 0)
  return {
    approved,
    undecided,
    rejected,
    approvedTotal:  sum(approved),
    undecidedTotal: sum(undecided),
  }
}

// ── Conversion guard failures ─────────────────────────────────────────────────
// convert_order_request_to_order (20260715 §7) refuses two new ways, each with
// its own greppable prefix. Both are rules the admin can act on — one says
// "there is no confirmed advance behind this order", the other "you have not
// finished reviewing its payments" — so neither may collapse into the generic
// "could not convert" sentence.
//
// Returns null for anything else, so the caller falls through to its existing
// STALE_PAYMENTS / order-numbering / generic handling unchanged.

export const NO_APPROVED_PAYMENT_MESSAGE =
  'At least one approved payment must be linked before this Order Request can be approved.'

export function convertGuardErrorMessage(message: string | undefined | null): string | null {
  const m = message ?? ''
  if (m.includes('ORDER_REQUEST_NO_APPROVED_PAYMENT')) return NO_APPROVED_PAYMENT_MESSAGE
  if (m.includes('ORDER_REQUEST_PAYMENTS_UNDECIDED')) {
    return 'Some payments linked to this request are still awaiting a finance decision. Approve or reject each one before converting.'
  }
  return null
}

// ── Record header actions ─────────────────────────────────────────────────────
// One shared style for every action button on a record page, so contrast,
// hover, focus and disabled states are defined once in globals.css
// (.boe-record-action) rather than re-derived as inline CSS per button.
//
// Why it exists: .boe-page-body inherits the #F4F5F7 app background, and the
// previous inline treatment was `background: transparent` with a
// rgba(0,0,0,0.08) hairline — effectively invisible on that grey. The class puts
// secondary actions on a white raised surface with a real border.
export type HeaderActionVariant = 'secondary' | 'danger' | 'primary' | 'icon'

export function headerActionClass(variant: HeaderActionVariant = 'secondary'): string {
  return variant === 'secondary'
    ? 'boe-record-action'
    : `boe-record-action boe-record-action--${variant}`
}

// ── Formatters ────────────────────────────────────────────────────────────────

// Numeric columns can surface as strings depending on the driver; coerce
// defensively so a stored value never renders as "₹NaN". Genuine zero renders
// as ₹0; only null/undefined/empty/unparseable become "—".
export function fmtAmount(n: number | string | null | undefined) {
  if (n == null || n === '') return '—'
  const num = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(num)) return '—'
  return formatINR(num)
}

export function fmtDate(iso: string | null | undefined) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

// Timeline entries carry a time as well as a date — same shape the Order detail
// page and the Finance activity timeline already use.
export function fmtDateTime(iso: string) {
  const d = new Date(iso)
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    + ', '
    + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
}

// ── Advance-received derivation ───────────────────────────────────────────────
// A payment reaches a request through exactly one of two linkages, never both
// (finance_payment_requests_one_link_target, 20260698):
//   - before conversion, order_request_id points at the request itself;
//   - conversion moves the payment to order_id in the same statement, and the
//     request keeps converted_order_id pointing at that Order.
// Only the first case counts here: an open request is pre-conversion and the
// parked-payment aggregate is the whole picture. The post-conversion figure
// lives on the Order detail page, which owns the official Order value that
// anchors its percentage. Client-name matching is display-only guidance
// elsewhere in this module and is never a financial rule: a request with no
// linked payment reports "not linked", never a confirmed ₹0.
//
// The aggregate is read with the viewer's own RLS. Every request a non-admin
// can see is one they own or are assigned (order_requests_requester_select /
// its assignee counterpart), and
// finance_payment_requests_order_request_owner_select (20260699) exposes every
// payment attached to such a request — so the sums are complete for every row
// on screen, for admins and requesters alike. `restricted` is therefore not a
// role verdict: it means the payments query itself failed, and it renders as
// "—" rather than as a false ₹0.
//
// `request_linked` carries the parked total and count; a percentage is
// deliberately withheld, because until conversion there is no official Order
// value to use as a denominator.
export type RequestLinkAgg = { total: number; count: number }
export type AdvanceInfo =
  | { kind: 'not_linked' }
  | { kind: 'restricted' }
  | { kind: 'request_linked'; received: number; count: number }

export function getAdvanceInfo(
  r: OrderRequest,
  linkedByRequest: Record<string, RequestLinkAgg> | null,
): AdvanceInfo {
  // A null map means the aggregate query failed, not that there are no
  // payments — report it as unavailable rather than as ₹0. With data, sum the
  // payments parked on this request; not_linked only when none.
  if (linkedByRequest == null) return { kind: 'restricted' }
  const agg = linkedByRequest[r.id]
  if (!agg || agg.count === 0) return { kind: 'not_linked' }
  return { kind: 'request_linked', received: agg.total, count: agg.count }
}

// The detail page holds the request's own payment rows rather than a batched
// map, so it derives the same figure from them. Deliberately the SAME
// definition the list aggregate uses — payments parked on this request and
// still in suspense (status 'approved_unlinked') — so one request reports an
// identical advance on both surfaces. A failed query is `restricted`, never ₹0.
export function advanceFromPayments(rows: LinkedPayment[] | null): AdvanceInfo {
  if (rows == null) return { kind: 'restricted' }
  const parked = rows.filter(p => p.order_request_id != null && p.status === 'approved_unlinked')
  if (parked.length === 0) return { kind: 'not_linked' }
  const total = parked.reduce((sum, p) => sum + (Number.isFinite(p.amount) ? p.amount : 0), 0)
  return { kind: 'request_linked', received: total, count: parked.length }
}

// There is no stable shared client ID between finance_payment_requests and
// order_requests (both carry only a free-text client_name) — this is
// deterministic normalized-text comparison only, used for sorting and the
// mismatch warning in the Convert modal. It is display guidance, never a hard
// filter: a mismatched payment stays fully selectable, and the RPC does not
// validate client match at all.
export function normalizeClientName(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
}

// ── Payment-link panel helpers ────────────────────────────────────────────────

export const SUSPENSE_PAGE_SIZE = 10

// Message shown when the payment itself is no longer a linkable suspense row.
// Named so the caller can also decide to drop it from the visible results.
export const PAYMENT_ALREADY_LINKED_MSG = 'This payment has already been linked.'

// Map a link RPC failure (link_finance_payment_to_order_request, 20260698) to a
// specific, honest line — never raw Postgres text, and NOT collapsing every
// error into "already linked". `stale` marks the payment-no-longer-eligible
// case so the caller removes it from the list; other failures leave it in
// place for a retry.
export function friendlyLinkError(message: string | undefined): { text: string; stale: boolean } {
  const m = (message ?? '').toLowerCase()

  // The payment is no longer suspense: linked/consumed/relinked elsewhere, its
  // status changed, or the payment row is gone.
  if (
    m.includes('already linked') ||
    m.includes('awaiting order linkage') ||
    (m.includes('payment request') && m.includes('not found'))
  ) {
    return { text: PAYMENT_ALREADY_LINKED_MSG, stale: true }
  }

  // The order request is no longer open for linking (converted or left the
  // active states, or the request row is gone).
  if (
    m.includes('already been converted') ||
    m.includes('active order request') ||
    (m.includes('order request') && m.includes('not found'))
  ) {
    return { text: 'This request is no longer open for linking. Refresh and try again.', stale: false }
  }

  // Origin gate — every suspense payment is new_order-origin, so this is
  // effectively unreachable from this UI, but mapped honestly rather than as
  // "already linked".
  if (m.includes('new-order request')) {
    return { text: 'This payment cannot be linked to an order request.', stale: false }
  }

  // Permission / auth. The controls already mirror the server-side rule, so
  // this is reachable only when the underlying rows changed mid-flight.
  if (m.includes('only an admin') || m.includes('only a payment you submitted')
      || m.includes('payment you submitted') || m.includes('authentication required')) {
    return { text: 'You do not have permission to link this payment.', stale: false }
  }

  return { text: 'Could not link this payment. Please refresh and try again.', stale: false }
}

// Builds the PostgREST .or() conditions for a suspense-payment search from a
// raw term. An empty array means "no usable token" — the caller must treat
// that as invalid input, never as an unfiltered query. Columns searched are
// exactly the four the placeholder advertises: payment reference/UTR
// (request_number, proof_note), payer (client_name), amount (numeric eq), and
// an exact ISO payment date. Commas/parentheses are stripped because they are
// .or() grammar; amount tolerates grouping/currency ("₹2,00,000").
export function buildSuspenseSearchConds(raw: string): string[] {
  const conds: string[] = []
  const textTerm = raw.replace(/[(),]/g, ' ').replace(/\s+/g, ' ').trim()
  if (textTerm) {
    for (const col of ['request_number', 'proof_note', 'client_name']) {
      conds.push(`${col}.ilike.%${textTerm}%`)
    }
  }
  const amountDigits = raw.replace(/[^\d.]/g, '')
  if (amountDigits !== '' && Number.isFinite(Number(amountDigits))) {
    conds.push(`amount.eq.${Number(amountDigits)}`)
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) conds.push(`payment_date.eq.${raw.trim()}`)
  return conds
}

// ── Request form shape (create / edit / resubmit / reapply) ───────────────────

export type RequestForm = {
  client_name: string
  assigned_to: string
  confirm_date: string
  due_date: string
  total_product_value: string
  total_value: string
  lead_source: string
  notes: string
}

export const EMPTY_FORM: RequestForm = {
  client_name: '',
  assigned_to: '',
  confirm_date: '',
  due_date: '',
  total_product_value: '',
  total_value: '',
  lead_source: '',
  notes: '',
}

// Non-negative, tolerating an empty string (the field is optional). Returns
// an error message, or null when the value is acceptable.
export function validateAmount(label: string, raw: string): string | null {
  if (raw === '') return null
  const n = parseFloat(raw)
  if (Number.isNaN(n) || n < 0) return `${label} must be a valid non-negative amount.`
  return null
}

// ── RPC failure reporting ─────────────────────────────────────────────────────

// Shape of a PostgREST/supabase-js error, narrowed to the fields worth acting on.
export type RpcErrorLike = {
  message?: string | null
  code?: string | null
  details?: string | null
  hint?: string | null
}

// Detailed, developer-facing record of a failed RPC. Kept out of the UI string
// on purpose — the user gets a sentence, the console gets the SQLSTATE, details
// and hint needed to diagnose it. Never logs the arguments, which carry client
// and commercial data.
export function logRpcFailure(rpc: string, err: RpcErrorLike): void {
  console.error(`[rpc:${rpc}] failed`, {
    rpc,
    code:    err.code    ?? null,
    message: err.message ?? null,
    details: err.details ?? null,
    hint:    err.hint    ?? null,
  })
}

// edit_order_request raises a distinct message per rule it enforces; each maps to
// a sentence the reader can act on, so the UI names the rule that refused rather
// than hiding every failure behind one string.
//
// This deliberately does NOT claim the request "may have already changed" unless
// a real concurrency condition was detected (40001/55P03). The previous generic
// fallback said exactly that for every failure, which sent readers hunting for a
// phantom conflict when the actual cause was a plain server-side error — the
// reason the 22P02 defect in 20260708 took so long to place.
//
// No raw SQL, constraint name, or internal identifier reaches the user.
export function editRequestErrorMessage(err: RpcErrorLike): string {
  const m    = (err.message ?? '').toLowerCase()
  const code = err.code ?? ''

  // No SQLSTATE and no message at all: the request never reached PostgREST.
  if (!code && !m) return 'Could not reach the server. Check your connection and try again.'

  // PostgREST could not resolve the function — app and database are out of step.
  if (code === 'PGRST202' || code === 'PGRST203') {
    return 'This page is out of date with the server. Reload and try again.'
  }

  // Rules this RPC states explicitly, most specific first.
  if (m.includes('only an admin may change the assignee')) return 'Only an admin can change the assignee of an order request.'
  if (m.includes('may edit this order request'))           return 'You no longer have permission to edit this request.'
  if (m.includes('has been converted'))                    return 'This request has been converted to an Order and can no longer be edited.'
  if (m.includes('cannot be edited'))                      return 'This request is no longer in an editable state. Refresh and try again.'
  if (m.includes('not found'))                             return 'This request no longer exists. Refresh the list.'
  if (m.includes('authentication required'))               return 'Your session has expired. Sign in again to continue.'
  // Already complete, user-facing sentences from the RPC itself.
  if (m.includes('assignee must be'))     return err.message as string
  if (m.includes('must not be negative')) return err.message as string
  if (m.includes('client name is required')) return 'Client name is required.'

  // Genuine permission refusal that did not match a message above.
  if (code === '42501') return 'You do not have permission to make this change.'

  // Real database validation failures: bad value, wrong type, missing/broken
  // reference, or a CHECK constraint. One message, because the user's action is
  // the same in every case — correct a field and retry.
  if (['23514', '23502', '23503', '22P02', '22007', '22003', '22001'].includes(code)) {
    return 'One of the values entered is not valid for this request. Check the fields and try again.'
  }

  // The only cases that genuinely mean "someone else touched this".
  if (code === '40001' || code === '55P03') {
    return 'Someone else is editing this request right now. Please try again in a moment.'
  }

  return 'Could not save this request. Please try again.'
}

// ── The clarification response ────────────────────────────────────────────────
// Required, and required to contain something. A resubmission that says nothing
// leaves the reviewer exactly where they started, which is why whitespace is
// rejected rather than trimmed to an empty string and quietly accepted.
//
// respond_to_clarification applies the identical rule (20260714 §5) and is the
// actual gate; this exists so the reader is told before a round trip, and so the
// rule is testable as a pure function. Both sides compare the TRIMMED value, so
// neither can accept what the other refuses.
export const CLARIFICATION_RESPONSE_REQUIRED =
  'Enter a response to the clarification before resubmitting.'

export function validateClarificationResponse(response: string): string | null {
  return response.trim() === '' ? CLARIFICATION_RESPONSE_REQUIRED : null
}

// The stale-status sentence. Named because the page shows it in two places (the
// inline error, and the banner after a failed save) and the two must not drift.
export const CLARIFICATION_STALE_MESSAGE =
  'This request is no longer awaiting clarification. Refresh the page to see its current status.'

// respond_to_clarification (20260714) failures, mapped to sentences that name
// WHICH rule refused. The distinction that matters most here is a STALE request
// — someone else already moved it — versus a permission refusal versus a bad
// field: three different problems with three different remedies, which a single
// "please try again" used to hide.
//
// Nothing about the row leaks: no SQLSTATE, no function name, no column name and
// no internal identifier reaches the reader.
export function clarificationResponseErrorMessage(err: RpcErrorLike): string {
  const m    = (err.message ?? '').toLowerCase()
  const code = err.code ?? ''

  if (!code && !m) return 'Could not reach the server. Check your connection and try again.'

  // App and database are out of step — this build calls an RPC the server does
  // not have yet, which is the expected failure if 20260714 has not been applied.
  if (code === 'PGRST202' || code === 'PGRST203'
      || m.includes('schema cache') || m.includes('could not find the function')) {
    return 'Responding to clarification is not available on this server yet. Ask an administrator to complete the setup.'
  }

  // The status gate. Deliberately first among the rule matches: it is the one
  // failure where retrying is pointless and reloading is the actual remedy.
  if (m.includes('no longer awaiting clarification')) return CLARIFICATION_STALE_MESSAGE
  if (m.includes('has been converted')) {
    return 'This request has been converted to an Order and can no longer be changed.'
  }

  if (m.includes('response to the clarification is required')) return CLARIFICATION_RESPONSE_REQUIRED
  if (m.includes('only an admin may change the assignee')) return 'Only an admin can change the assignee of an order request.'
  if (m.includes('permission to respond'))  return 'You do not have permission to respond to this clarification.'
  if (m.includes('not found'))              return 'This request no longer exists. Refresh the list.'
  if (m.includes('authentication required')) return 'Your session has expired. Sign in again to continue.'
  // Already complete, user-facing sentences from the RPC itself.
  if (m.includes('assignee must be'))     return err.message as string
  if (m.includes('must not be negative')) return err.message as string
  if (m.includes('client name is required')) return 'Client name is required.'

  if (code === '42501') return 'You do not have permission to respond to this clarification.'

  if (['23514', '23502', '23503', '22P02', '22007', '22003', '22001'].includes(code)) {
    return 'One of the values entered is not valid for this request. Check the fields and try again.'
  }

  // The only codes that genuinely mean "someone else touched this record".
  if (code === '40001' || code === '55P03') {
    return 'Someone else is changing this request right now. Please try again in a moment.'
  }

  return 'Could not submit your response. Please try again.'
}

// admin_delete_order_request raises stable, greppable code prefixes. Each one is
// a rule the reader can act on, so each gets a sentence rather than a shared
// "something went wrong" that hides which rule refused. An unrecognised message
// falls through unchanged — still more useful than a generic string.
export function deleteRequestErrorMessage(message: string): string {
  if (message.includes('ORDER_REQUEST_CONVERTED_PERMANENT')) {
    return 'This Order Request created a Confirmed Order and is retained as permanent source history. It cannot be deleted.'
  }
  if (message.includes('ORDER_REQUEST_HAS_PAYMENTS')) {
    return 'Payments were linked to this request while this dialog was open. Close and reopen it to see them before deleting.'
  }
  if (message.includes('ORDER_REQUEST_NOT_FOUND')) {
    return 'This Order Request no longer exists — it may have already been deleted.'
  }
  return message
}
